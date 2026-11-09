import { account, servicePoint } from "@flowless/db/schema/accounts";
import type { SuccessionBasis } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Viewer } from "./access";
import { earlierChange, fingerprintOfChange, logChange, reload } from "./account-changes";
import { runCommand, toCommandDto, type CommandEnv } from "./commands";
import { createCustomer, type NewCustomer } from "./customers";
import { accountSucceeded } from "./events";
import { localToday } from "./holders";
import { openAccount } from "./open-account";
import { findAccount, findCustomer, presentAccounts } from "./service";
import { handOverReadings, transferBalance } from "./sources";

/*
 * Succession (C-08): the account is replaced by a SUCCESSOR with its own number and the old
 * one goes DORMANT with a pointer to it. The reasons are a child becoming a full member
 * (`full_membership`: the successor has no parent), a change of name where the customer
 * wants a new number (`change_of_name`, the successor has the new customer; a change that
 * keeps the number is C-10, `change_name`) and a relocation with a new number
 * (`relocation_new_number`). The model, in one transaction:
 *   - the successor is opened in the state the old account was in (service carries on without
 *     a gap), with the old account as `predecessor_account_id`; the old account's
 *     `successor_account_id` points back (both set once, one successor per account);
 *   - the old account goes DORMANT through the F3a `make_dormant` command (when it was ACTIVE);
 *   - the old account's service points move to the successor (`servicePoints: "leave"` keeps
 *     them for the office to place);
 *   - the balance moves by paired transfer entries and the final reading becomes the opening
 *     one through the ports in `sources.ts`; with none registered the command records
 *     `transfer: "pending_ledger"` and `readingHandover: "pending_metering"` for Phase 4 and 5
 *     to reconcile;
 *   - a `succeed` row is written in both accounts' command logs (the old one's has the
 *     payload; client-minted id, so a retry returns the same successor).
 */

export interface SucceedRequest {
  /** The `succeed` command's id on the old account; client-minted. */
  id?: string | undefined;
  accountId: string;
  basis: SuccessionBasis;
  /** The successor's customer: default the same one. */
  customerId?: string | undefined;
  /** A new customer created with the successor (a change of name). */
  newCustomer?: NewCustomer | undefined;
  /** The successor's category: default the old account's. */
  categoryId?: string | null | undefined;
  /** What happens to the service points: move to the successor (default) or stay for the office to place. */
  servicePoints?: "move" | "leave" | undefined;
  reason: string;
}

export async function succeedAccount(env: CommandEnv, viewer: Viewer, req: SucceedRequest) {
  const { tx, organizationId } = env;
  const userId = env.actor.userId!;
  const old = await findAccount(tx, viewer, { id: req.accountId }, true);
  const fingerprint = fingerprintOfChange({ kind: "succeed", ...req });
  const earlier = await earlierChange(env, req.id, { accountId: old.id, kind: "succeed", fingerprint });
  if (earlier) {
    const payload = earlier.payload as { successorAccountId: string };
    const [successor] = await tx.select().from(account).where(eq(account.id, payload.successorAccountId));
    return { command: toCommandDto(earlier), predecessor: (await presentAccounts(tx, [old]))[0]!, successor: (await presentAccounts(tx, [successor!]))[0]!, replayed: true };
  }

  if (old.commercialStatus !== "ACTIVE" && old.commercialStatus !== "DORMANT") {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Only an active or dormant account has a successor; this one is ${old.commercialStatus.toLowerCase().replace("_", " ")}` });
  }
  if (old.successorAccountId) throw new TRPCError({ code: "CONFLICT", message: "This account already has a successor" });
  if (req.basis === "full_membership" && !old.parentAccountId) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Only a child account becomes a full member" });
  }
  if (req.customerId && req.newCustomer) throw new TRPCError({ code: "BAD_REQUEST", message: "Name an existing customer or give new customer details, not both" });

  const customerId = req.newCustomer
    ? (await createCustomer({ tx, organizationId, userId, audit: env.audit, publish: env.publish }, req.newCustomer)).id
    : req.customerId
      ? (await findCustomer(tx, viewer, req.customerId)).id
      : old.customerId;
  if (req.basis === "change_of_name" && customerId === old.customerId) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "A change of name needs a different customer: name one or give new customer details" });
  }

  const keepsParent = req.basis !== "full_membership" && old.parentAccountId !== null;
  const successor = await openAccount({ tx, organizationId, userId, audit: env.audit, publish: env.publish }, viewer, {
    customerId,
    ...(keepsParent ? { parentAccountId: old.parentAccountId!, numbering: "own" as const, membershipClass: old.membershipClass } : {}),
    categoryId: req.categoryId === undefined ? old.categoryId : req.categoryId,
    carry: { commercialStatus: old.commercialStatus, serviceStatus: old.serviceStatus, serviceStatusReason: old.serviceStatusReason },
    predecessorAccountId: old.id,
  });

  // The successor's own log shows where its state came from.
  const arrival = await logChange(env, successor, {
    kind: "succeed",
    reason: req.reason,
    payload: { role: "successor", predecessorAccountId: old.id, predecessorNumber: old.number, basis: req.basis },
    fingerprint: fingerprintOfChange({ kind: "succeed", role: "successor", predecessorAccountId: old.id }),
  });
  await env.tx.update(account).set({ statusCommandId: arrival.id }).where(eq(account.id, successor.id));

  // The old account goes DORMANT through the lifecycle command (not when it already is).
  let dormantCommandId: string | null = null;
  if (old.commercialStatus === "ACTIVE") {
    const dormant = await runCommand(env, viewer, { kind: "make_dormant", accountId: old.id, reason: `Succeeded by account ${successor.number}: ${req.reason.trim()}` });
    dormantCommandId = dormant.command.id;
  }

  const moved = req.servicePoints === "leave" ? [] : await tx.select().from(servicePoint).where(eq(servicePoint.accountId, old.id));
  for (const point of moved) {
    await tx.update(servicePoint).set({ accountId: successor.id, updatedAt: new Date() }).where(eq(servicePoint.id, point.id));
    await env.audit({
      action: "accounts.service_point_update",
      subjectType: "service_point",
      subjectId: point.id,
      before: { accountId: old.id },
      after: { accountId: successor.id, reason: "succession" },
      reason: req.reason.trim(),
    });
  }

  const commandId = req.id ?? randomUUID();
  const transfer = await transferBalance(tx, organizationId, { fromAccountId: old.id, toAccountId: successor.id, commandId });
  const handover = await handOverReadings(tx, organizationId, {
    reason: "succession",
    fromAccountId: old.id,
    toAccountId: successor.id,
    servicePointIds: moved.map((p) => p.id),
    effectiveDate: await localToday(tx),
    commandId,
  });

  const payload = {
    role: "predecessor",
    basis: req.basis,
    successorAccountId: successor.id,
    successorNumber: successor.number,
    previousCustomerId: old.customerId,
    customerId,
    servicePointIds: moved.map((p) => p.id),
    dormantCommandId,
    transfer,
    readingHandover: handover.state,
    closingReadingRef: handover.closingReadingRef,
  };
  const command = await logChange(env, await reload(env, old.id), { id: commandId, kind: "succeed", reason: req.reason, payload, fingerprint });
  await tx.update(account).set({ successorAccountId: successor.id }).where(eq(account.id, old.id));
  await env.audit({
    action: "accounts.succeed",
    subjectType: "account",
    subjectId: old.id,
    before: { commercialStatus: old.commercialStatus, successorAccountId: null },
    after: { ...payload, commandId: command.id },
    reason: req.reason.trim(),
  });
  await env.publish(accountSucceeded, {
    commandId: command.id,
    basis: req.basis,
    predecessorAccountId: old.id,
    predecessorNumber: old.number,
    successorAccountId: successor.id,
    successorNumber: successor.number,
    previousCustomerId: old.customerId,
    customerId,
    servicePointIds: moved.map((p) => p.id),
    transfer,
    readingHandover: handover.state,
    actorUserId: userId,
    occurredAt: command.occurredAt.toISOString(),
  });

  const [predecessorNow] = await tx.select().from(account).where(eq(account.id, old.id));
  const [successorNow] = await tx.select().from(account).where(eq(account.id, successor.id));
  return {
    command: toCommandDto(command),
    predecessor: (await presentAccounts(tx, [predecessorNow!]))[0]!,
    successor: (await presentAccounts(tx, [successorNow!]))[0]!,
    replayed: false,
  };
}
