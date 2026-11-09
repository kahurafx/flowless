import type { Transaction } from "@flowless/db";
import { account } from "@flowless/db/schema/accounts";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { systemEnv } from "../../kernel/action-env";
import { readSetting } from "../../kernel/config-store";
import { loadEntitlements } from "../../kernel/entitlement-store";
import { runCommand } from "./commands";
import { hasPaymentGate } from "./gates";
import { activationSetting } from "./settings";

/**
 * Activates the account by itself when it is ready (C-06, mode `auto`). Other modules'
 * consumers call it, inside their event's tenant transaction, when a fact a gate depends on
 * changes (a payment confirmed, a meter installed, a reading captured). It activates only an
 * account that is NEW or PENDING_PAYMENT with every required gate met, never overrides, and
 * does nothing in checklist mode, when Accounts is unlicensed, or when the account is not
 * (yet) ready. A NEW account in an organization that takes payment first waits for
 * PENDING_PAYMENT.
 */
export async function recheckActivation(
  tx: Transaction,
  organizationId: string,
  accountId: string,
): Promise<{ activated: boolean; reason: string }> {
  if (!(await loadEntitlements(tx)).includes("accounts")) return { activated: false, reason: "Accounts is not licensed" };
  const config = (await readSetting(tx, activationSetting)).value;
  if (config.mode !== "auto") return { activated: false, reason: "Activation is by checklist" };
  const [row] = await tx.select().from(account).where(eq(account.id, accountId));
  if (!row) return { activated: false, reason: "No such account" };
  if (row.commercialStatus !== "NEW" && row.commercialStatus !== "PENDING_PAYMENT") {
    return { activated: false, reason: `The account is ${row.commercialStatus.toLowerCase().replace("_", " ")}` };
  }
  if (row.commercialStatus === "NEW" && hasPaymentGate(config)) return { activated: false, reason: "Waiting for the account to be marked pending payment" };
  try {
    await runCommand(systemEnv(tx, organizationId), null, { accountId, kind: "activate", reason: "All activation gates are met" });
    return { activated: true, reason: "All activation gates are met" };
  } catch (error) {
    // Not ready: runCommand refuses before it writes anything, so the caller's transaction is intact.
    if (error instanceof TRPCError && error.code === "PRECONDITION_FAILED") return { activated: false, reason: error.message };
    throw error;
  }
}
