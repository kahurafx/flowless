import type { Transaction } from "@flowless/db";
import { account } from "@flowless/db/schema/accounts";
import type { CommercialStatus, ServiceState } from "@flowless/shared-types";
import { and, eq } from "drizzle-orm";
import type { ActionEnv } from "../../kernel/action-env";
import { readSetting } from "../../kernel/config-store";
import { accountVisible, type Viewer } from "./access";
import { advanceApplication } from "./application-steps";
import { chargesApplying, type ChargesApplying } from "./status-rules";
import { statusRulesSetting } from "./settings";

/*
 * Accounts' published reads and system steps for Billing (NF-30): Billing never reads the
 * `accounts` schema, it asks here. All run in the caller's tenant transaction.
 */

export interface AccountStatusView {
  accountId: string;
  number: string;
  customerId: string;
  commercialStatus: CommercialStatus;
  serviceStatus: ServiceState;
}

/** Who the account is and what state it is in; null when this organization has no such account. */
export async function accountStatusOf(tx: Transaction, accountId: string): Promise<AccountStatusView | null> {
  const [row] = await tx
    .select({ id: account.id, number: account.number, customerId: account.customerId, commercialStatus: account.commercialStatus, serviceStatus: account.serviceStatus })
    .from(account)
    .where(eq(account.id, accountId));
  return row ? { accountId: row.id, number: row.number, customerId: row.customerId, commercialStatus: row.commercialStatus, serviceStatus: row.serviceStatus } : null;
}

/**
 * Which charges apply to the account in its present status (C-04), by the organization's
 * `accounts.status_rules`. Null when the account is unknown to Accounts.
 */
export async function chargesApplyingTo(tx: Transaction, accountId: string): Promise<(ChargesApplying & AccountStatusView) | null> {
  const status = await accountStatusOf(tx, accountId);
  if (!status) return null;
  const rules = (await readSetting(tx, statusRulesSetting)).value;
  return { ...status, ...chargesApplying(rules, status.commercialStatus, status.serviceStatus) };
}

/** Can the viewer see this account (K-03)? An account that does not exist is not visible to a limited viewer. */
export async function accountVisibleTo(tx: Transaction, viewer: Viewer, accountId: string): Promise<boolean> {
  if (viewer.scope.kind === "all") return true;
  const rows = await tx.select({ id: account.id }).from(account).where(and(eq(account.id, accountId), accountVisible(viewer)));
  return rows.length > 0;
}

/** Every account id the (limited) viewer can see, for filtering lists in another module. */
export async function visibleAccountIds(tx: Transaction, viewer: Viewer): Promise<string[]> {
  const rows = await tx.select({ id: account.id }).from(account).where(accountVisible(viewer));
  return rows.map((r) => r.id);
}

/*
 * Billing tells an application its new-connection invoice is out or paid (C-05): the same
 * stage moves the office makes by hand, made as the system. The reference is opaque.
 */
export function recordApplicationInvoiced(env: ActionEnv, req: { applicationId: string; invoiceRef: string; id?: string | undefined; reason?: string }) {
  return advanceApplication(env, null, { id: req.id, applicationId: req.applicationId, action: "markInvoiced", reason: req.reason ?? "New-connection invoice issued", invoiceRef: req.invoiceRef });
}
export function recordApplicationPaid(env: ActionEnv, req: { applicationId: string; paymentRef: string; id?: string | undefined; reason?: string }) {
  return advanceApplication(env, null, { id: req.id, applicationId: req.applicationId, action: "markPaid", reason: req.reason ?? "New-connection invoice paid", paymentRef: req.paymentRef });
}
