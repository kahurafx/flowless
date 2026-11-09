import { account, servicePoint } from "@flowless/db/schema/accounts";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Viewer } from "./access";
import { logChange, reload } from "./account-changes";
import type { UserActionEnv } from "../../kernel/action-env";
import { commandLog, fingerprintOfRequest, toCommandDto } from "./command-log";
import { createCustomer, type NewCustomer } from "./customers";
import { holderChanged } from "./events";
import { currentHolder, holdersOf, insertHolder, localToday } from "./holders";
import { findAccount, findCustomer, presentAccount, type AccountRow } from "./service";
import { handOverReadings } from "./sources";

/*
 * Change of name (C-10): the account keeps its number and the holder changes from an
 * effective date. The change is recorded in the insert-only holder history
 * (`account_holder`: the new holder from `valid_from`, until a later row), so a bill for a
 * past period still resolves to the holder then (`holderAt`, which Billing splits at). The
 * account's `customer_id` is the current holder and the database lets it change only to the
 * customer of the newest holder row. The effective date is today or earlier and after the
 * current holder's start (a later date is entered when it arrives: nothing here is scheduled).
 *
 * The previous holder's closing reading is taken by Metering (Phase 5) through the reading
 * handover port. With none registered the command's payload says `closing_reading_pending:
 * true`, unless the office supplies a reference for a reading taken by hand.
 */

export interface ChangeNameRequest {
  /** The `change_name` command's id; client-minted. */
  id?: string | undefined;
  accountId: string;
  customerId?: string | undefined;
  /** A new customer created with the change. */
  newCustomer?: NewCustomer | undefined;
  /** YYYY-MM-DD, in the organization's time zone. */
  effectiveDate: string;
  /** The previous holder's closing reading, when the office has taken it (opaque until Metering). */
  closingReadingRef?: string | undefined;
  reason: string;
}

export async function changeName(env: UserActionEnv, viewer: Viewer, req: ChangeNameRequest) {
  const acct = await findAccount(env.tx, viewer, { id: req.accountId }, true);
  const fingerprint = fingerprintOfRequest({ kind: "change_name", ...req });
  return commandLog.once(
    env,
    req.id,
    { parentId: acct.id, kind: "change_name", fingerprint },
    {
      replay: async (earlier) => ({ command: toCommandDto(earlier), account: await presentAccount(env.tx, acct) }),
      run: () => applyChangeName(env, viewer, acct, req, fingerprint),
    },
  );
}

async function applyChangeName(env: UserActionEnv, viewer: Viewer, acct: AccountRow, req: ChangeNameRequest, fingerprint: string) {
  const { tx, organizationId } = env;
  const userId = env.actor.userId;
  if (acct.commercialStatus === "TERMINATED") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This account is terminated" });
  if ((req.customerId === undefined) === (req.newCustomer === undefined)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Name the new holder: an existing customer or new customer details" });
  }
  const today = await localToday(tx);
  if (req.effectiveDate > today) throw new TRPCError({ code: "BAD_REQUEST", message: "The effective date cannot be in the future: record the change on the day" });
  const current = await currentHolder(tx, acct.id);
  if (current && req.effectiveDate <= current.validFrom) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: `The effective date must be after ${current.validFrom}, when the current holder took over` });
  }
  const toCustomerId = req.newCustomer
    ? (await createCustomer(env, req.newCustomer)).id
    : (await findCustomer(tx, viewer, req.customerId!)).id;
  if (toCustomerId === acct.customerId) throw new TRPCError({ code: "BAD_REQUEST", message: "That customer already holds the account" });

  const commandId = req.id ?? randomUUID();
  const points = await tx.select({ id: servicePoint.id }).from(servicePoint).where(eq(servicePoint.accountId, acct.id));
  const handover = await handOverReadings(tx, organizationId, {
    reason: "change_name",
    fromAccountId: acct.id,
    toAccountId: acct.id,
    servicePointIds: points.map((p) => p.id),
    effectiveDate: req.effectiveDate,
    commandId,
  });
  const closingReadingRef = req.closingReadingRef?.trim() || handover.closingReadingRef;
  const pending = handover.state === "pending_metering" && !closingReadingRef;
  const payload = {
    fromCustomerId: acct.customerId,
    toCustomerId,
    effectiveDate: req.effectiveDate,
    closingReadingRef: closingReadingRef ?? null,
    closing_reading_pending: pending,
  };
  const command = await logChange(env, acct, { id: commandId, kind: "change_name", reason: req.reason, payload, fingerprint });
  await insertHolder(tx, {
    organizationId,
    accountId: acct.id,
    customerId: toCustomerId,
    validFrom: req.effectiveDate,
    userId,
    commandId: command.id,
    previousClosingReadingRef: closingReadingRef ?? null,
    reason: req.reason.trim(),
  });
  await tx.update(account).set({ customerId: toCustomerId }).where(eq(account.id, acct.id));
  await env.audit({
    action: "accounts.change_name",
    subjectType: "account",
    subjectId: acct.id,
    before: { customerId: acct.customerId },
    after: { ...payload, commandId: command.id },
    reason: req.reason.trim(),
  });
  await env.publish(holderChanged, {
    commandId: command.id,
    accountId: acct.id,
    number: acct.number,
    fromCustomerId: acct.customerId,
    toCustomerId,
    effectiveDate: req.effectiveDate,
    closingReadingRef: closingReadingRef ?? null,
    closingReadingPending: pending,
    actorUserId: userId,
    occurredAt: command.occurredAt.toISOString(),
  });
  return { command: toCommandDto(command), account: await presentAccount(tx, await reload(env, acct.id)) };
}

/** The account's holders over time, oldest first. */
export const holderHistory = holdersOf;
