import type { Transaction } from "@flowless/db";
import { account } from "@flowless/db/schema/accounts";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { readSetting } from "../../kernel/config-store";
import { router } from "../../trpc";
import { membershipClassChanged } from "./events";
import { findClass } from "./membership";
import type { AccountsProcedures } from "./procedures";
import { findAccount, notFound } from "./service";
import { membershipSetting } from "./settings";

/*
 * Membership classes of child accounts (C-07). The classes are configuration
 * (`accounts.membership`); the account holds only the key. `membershipFor` is the published
 * read Billing prices a child's connection fee with.
 */

/** Refuses a class that is not configured, or a class on an account that is not a child. */
export async function assertMembershipClass(tx: Transaction, key: string, hasParent: boolean): Promise<void> {
  if (!hasParent) throw new TRPCError({ code: "BAD_REQUEST", message: "A membership class belongs to a child account: name its parent" });
  const config = (await readSetting(tx, membershipSetting)).value;
  if (!findClass(config, key)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `"${key}" is not a membership class of this organization` });
  }
}

export interface MembershipView {
  accountId: string;
  number: string;
  parentAccountId: string | null;
  /** The key stored on the account, or null for a stand-alone account or a child with no class. */
  membershipClass: string | null;
  /** The class's label; null when there is no class or it has been removed from the setting. */
  label: string | null;
  /** The charge catalog item (by code) that prices this member's connection fee; null when the class names none. */
  connectionFeeChargeItemCode: string | null;
  /** False when the account's class is no longer in the setting (the key is kept; Billing should fall back). */
  configured: boolean;
}

/**
 * The membership of an account: its parent, class and the catalog item code for its
 * connection fee. Published for Billing (Phase 4); `tx` is a tenant transaction, so only
 * this organization's accounts are found.
 */
export async function membershipFor(tx: Transaction, accountId: string): Promise<MembershipView | null> {
  const [row] = await tx
    .select({ id: account.id, number: account.number, parentAccountId: account.parentAccountId, membershipClass: account.membershipClass })
    .from(account)
    .where(eq(account.id, accountId));
  if (!row) return null;
  const found = row.membershipClass ? findClass((await readSetting(tx, membershipSetting)).value, row.membershipClass) : undefined;
  return {
    accountId: row.id,
    number: row.number,
    parentAccountId: row.parentAccountId,
    membershipClass: row.membershipClass,
    label: found?.label ?? null,
    connectionFeeChargeItemCode: found?.connectionFeeChargeItemCode ?? null,
    configured: row.membershipClass === null || found !== undefined,
  };
}

/** `memberships.*`: the configured classes, a child's membership, and setting its class. */
export function membershipsRouter(p: AccountsProcedures) {
  return router({
    /** The classes the organization has configured. */
    classes: p.read.query(async ({ ctx }) => (await readSetting(ctx.tx, membershipSetting)).value.classes),

    /** The membership of an account the caller can see. */
    get: p.read.input(z.object({ accountId: z.uuid() })).query(async ({ ctx, input }) => {
      const row = await findAccount(ctx.tx, ctx.viewer, { id: input.accountId });
      const view = await membershipFor(ctx.tx, row.id);
      if (!view) throw notFound("Account");
      return view;
    }),

    /**
     * Sets or clears (null) the class of a child account. Audited; nothing is written when it
     * is unchanged. Needs `accounts:update`: it decides which connection fee the child pays.
     */
    setClass: p.update
      .input(z.object({ accountId: z.uuid(), membershipClass: z.string().trim().min(1).max(30).nullable() }))
      .mutation(async ({ ctx, input }) => {
        const row = await findAccount(ctx.tx, ctx.viewer, { id: input.accountId }, true);
        if (row.commercialStatus === "TERMINATED") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This account is terminated" });
        if (input.membershipClass !== null) await assertMembershipClass(ctx.tx, input.membershipClass, row.parentAccountId !== null);
        else if (row.parentAccountId === null) throw new TRPCError({ code: "BAD_REQUEST", message: "Only a child account has a membership class" });
        if (row.membershipClass === input.membershipClass) return (await membershipFor(ctx.tx, row.id))!;
        await ctx.tx.update(account).set({ membershipClass: input.membershipClass }).where(eq(account.id, row.id));
        const view = (await membershipFor(ctx.tx, row.id))!;
        await ctx.audit({
          action: "accounts.membership_class_set",
          subjectType: "account",
          subjectId: row.id,
          before: { membershipClass: row.membershipClass },
          after: { membershipClass: input.membershipClass, connectionFeeChargeItemCode: view.connectionFeeChargeItemCode },
        });
        await ctx.publish(membershipClassChanged, {
          accountId: row.id,
          number: row.number,
          parentAccountId: row.parentAccountId!,
          from: row.membershipClass,
          to: input.membershipClass,
          connectionFeeChargeItemCode: view.connectionFeeChargeItemCode,
          actorUserId: ctx.viewer.userId,
          occurredAt: new Date().toISOString(),
        });
        return view;
      }),
  });
}
