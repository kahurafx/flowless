import { account } from "@flowless/db/schema/accounts";
import { TRPCError } from "@trpc/server";
import { readSetting } from "../../kernel/config-store";
import { isUniqueViolation } from "../../kernel/pg-errors";
import type { Viewer } from "./access";
import type { UserActionEnv } from "../../kernel/action-env";
import { accountOpened } from "./events";
import { insertHolder, localToday } from "./holders";
import { assertMembershipClass } from "./memberships";
import { findAccount, findCustomer, issueAccountNumber, issueChildNumber, type AccountRow } from "./service";
import { numberingSetting } from "./settings";

/** The reason a new account starts DISCONNECTED: service begins at activation (C-05, Phase 3 F3). */
export const NEW_ACCOUNT_SERVICE_REASON = "New account: service starts when it is activated";

export interface OpenAccount {
  customerId: string;
  parentAccountId?: string | undefined;
  numbering?: "suffix" | "own" | undefined;
  /** Tariffs' category (T-02), opaque here. */
  categoryId?: string | null | undefined;
  /** A key of `accounts.membership`; the account must be a child. */
  membershipClass?: string | null | undefined;
  /**
   * Succession only (C-08): the account starts in the state of the one it succeeds instead of
   * NEW, so service carries on without a gap. The caller writes the command row that explains it.
   */
  carry?: { commercialStatus: AccountRow["commercialStatus"]; serviceStatus: AccountRow["serviceStatus"]; serviceStatusReason: string | null } | undefined;
  predecessorAccountId?: string | undefined;
  commandId?: string | undefined;
}

/**
 * Opens an account for a customer with the next number of the organization's format (C-02),
 * starting NEW and DISCONNECTED (C-03), and records its first holder (C-10). With a parent it
 * is a child: `numbering: "suffix"` (the default for a top-level parent) takes the parent's
 * number plus the next letter ("1008B"); `"own"` takes a number of its own ("1009") and only
 * records the link. Used by `accounts.create`, converting an application and succession.
 */
export async function openAccount(env: UserActionEnv, viewer: Viewer, input: OpenAccount): Promise<AccountRow> {
  const { tx, organizationId } = env;
  await findCustomer(tx, viewer, input.customerId);
  const parent = input.parentAccountId ? await findAccount(tx, viewer, { id: input.parentAccountId }) : null;
  if (!parent && input.numbering) throw new TRPCError({ code: "BAD_REQUEST", message: "Numbering applies to a child account: name its parent" });
  if (input.membershipClass) await assertMembershipClass(tx, input.membershipClass, parent !== null);
  const mode = input.numbering ?? (parent && parent.parentAccountId === null ? "suffix" : "own");
  if (parent && mode === "suffix" && parent.parentAccountId !== null) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Letters extend a top-level account's number; this parent is itself a child, so give the new account its own number" });
  }
  const format = (await readSetting(tx, numberingSetting)).value;
  const issued =
    parent && mode === "suffix"
      ? await issueChildNumber(tx, organizationId, parent)
      : { number: await issueAccountNumber(tx, organizationId, format), suffixIndex: null };
  const state = input.carry ?? { commercialStatus: "NEW" as const, serviceStatus: "DISCONNECTED" as const, serviceStatusReason: NEW_ACCOUNT_SERVICE_REASON };
  const [row] = await tx
    .insert(account)
    .values({
      organizationId,
      number: issued.number,
      customerId: input.customerId,
      parentAccountId: parent?.id ?? null,
      suffixIndex: issued.suffixIndex,
      categoryId: input.categoryId ?? null,
      membershipClass: input.membershipClass ?? null,
      predecessorAccountId: input.predecessorAccountId ?? null,
      commercialStatus: state.commercialStatus,
      serviceStatus: state.serviceStatus,
      serviceStatusReason: state.serviceStatusReason,
      createdByUserId: env.actor.userId,
    })
    .returning()
    .catch((error: unknown) => {
      if (isUniqueViolation(error)) throw new TRPCError({ code: "CONFLICT", message: "That account number is already used" });
      throw error;
    });
  await insertHolder(tx, {
    organizationId,
    accountId: row!.id,
    customerId: row!.customerId,
    validFrom: await localToday(tx, row!.openedAt),
    userId: env.actor.userId,
    commandId: input.commandId ?? null,
    reason: input.predecessorAccountId ? "Holder of the successor account" : "Account opened",
  });
  await env.audit({
    action: "accounts.account_create",
    subjectType: "account",
    subjectId: row!.id,
    after: {
      number: row!.number,
      customerId: row!.customerId,
      parentAccountId: row!.parentAccountId,
      categoryId: row!.categoryId,
      membershipClass: row!.membershipClass,
      commercialStatus: row!.commercialStatus,
      serviceStatus: row!.serviceStatus,
      predecessorAccountId: row!.predecessorAccountId,
    },
  });
  await env.publish(accountOpened, {
    accountId: row!.id,
    number: row!.number,
    customerId: row!.customerId,
    parentAccountId: row!.parentAccountId,
    categoryId: row!.categoryId,
    openedAt: row!.openedAt.toISOString(),
    openedByUserId: env.actor.userId,
  });
  return row!;
}
