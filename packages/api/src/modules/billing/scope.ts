import type { Transaction } from "@flowless/db";
import { TRPCError } from "@trpc/server";
import { accountVisibleTo, visibleAccountIds, type Viewer } from "../accounts";
import { documentById } from "./post";

/*
 * Scope restrictions (K-03) on Billing: a member limited to areas or routes sees the ledger
 * of the accounts Accounts says they can see. Billing cannot read placement, so it asks
 * Accounts' published reads. An unrestricted member costs nothing extra.
 */

export type { Viewer };

/** NOT_FOUND unless the viewer may see the account. */
export async function assertAccountVisible(tx: Transaction, viewer: Viewer, accountId: string): Promise<void> {
  if (!(await accountVisibleTo(tx, viewer, accountId))) throw new TRPCError({ code: "NOT_FOUND", message: "Account not found" });
}

/** NOT_FOUND unless the viewer may see the document's account. Returns the account id. */
export async function assertDocumentVisible(tx: Transaction, viewer: Viewer, documentId: string): Promise<string> {
  const doc = await documentById(tx, documentId);
  await assertAccountVisible(tx, viewer, doc.accountId);
  return doc.accountId;
}

/** The account ids a list may show: undefined for an unrestricted viewer (no filter). */
export async function listableAccounts(tx: Transaction, viewer: Viewer): Promise<string[] | undefined> {
  return viewer.scope.kind === "all" ? undefined : visibleAccountIds(tx, viewer);
}
