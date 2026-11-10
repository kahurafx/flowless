import type { Transaction } from "@flowless/db";
import { account, servicePoint } from "@flowless/db/schema/accounts";
import type { CommercialStatus, ServiceState } from "@flowless/shared-types";
import { and, eq, inArray } from "drizzle-orm";
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

/** Where a service point is and whose it is, for Metering (NF-30): ids only, never the rows. */
export interface ServicePointView {
  servicePointId: string;
  accountId: string;
  areaId: string | null;
  routeId: string | null;
  connectionStatus: string;
}

/** The service point's account and placement (most specific area); null when this organization has no such service point. */
export async function servicePointOf(tx: Transaction, servicePointId: string): Promise<ServicePointView | null> {
  const [row] = await tx
    .select({ id: servicePoint.id, accountId: servicePoint.accountId, dma: servicePoint.dmaId, zone: servicePoint.zoneId, scheme: servicePoint.schemeId, routeId: servicePoint.routeId, status: servicePoint.connectionStatus })
    .from(servicePoint)
    .where(eq(servicePoint.id, servicePointId));
  return row
    ? { servicePointId: row.id, accountId: row.accountId, areaId: row.dma ?? row.zone ?? row.scheme ?? null, routeId: row.routeId, connectionStatus: row.status }
    : null;
}

/** One live-or-not service point on a route with its account's state and whether consumption is billed there (M-08). */
export interface RouteServicePointFact {
  servicePointId: string;
  accountId: string;
  accountNumber: string;
  routeId: string;
  connectionStatus: string;
  commercialStatus: CommercialStatus;
  serviceStatus: ServiceState;
  /** C-04: does the organization bill consumption for an account in this state? */
  billsConsumption: boolean;
  /** Walking sequence on the route (S): Accounts holds none yet, so always null. */
  walkingSequence: number | null;
}

/** Every service point on a route, for Metering's eligibility snapshot (M-08); account number order. Accounts decides what bills (C-04), Metering never reads its tables. */
export async function routeServicePointFacts(tx: Transaction, routeId: string): Promise<RouteServicePointFact[]> {
  const rules = (await readSetting(tx, statusRulesSetting)).value;
  const rows = await tx
    .select({
      sp: servicePoint.id,
      accountId: account.id,
      number: account.number,
      connectionStatus: servicePoint.connectionStatus,
      commercial: account.commercialStatus,
      service: account.serviceStatus,
    })
    .from(servicePoint)
    .innerJoin(account, and(eq(account.organizationId, servicePoint.organizationId), eq(account.id, servicePoint.accountId)))
    .where(eq(servicePoint.routeId, routeId))
    .orderBy(account.number, servicePoint.id);
  return rows.map((r) => ({
    servicePointId: r.sp,
    accountId: r.accountId,
    accountNumber: r.number,
    routeId,
    connectionStatus: r.connectionStatus,
    commercialStatus: r.commercial,
    serviceStatus: r.service,
    billsConsumption: chargesApplying(rules, r.commercial, r.service).billsConsumption,
    walkingSequence: null,
  }));
}

/** Which account owns each service point, and whether the point is still in use (not decommissioned); unknown ids are left out. */
export async function servicePointOwners(tx: Transaction, ids: readonly string[]): Promise<{ servicePointId: string; accountId: string; live: boolean }[]> {
  if (!ids.length) return [];
  const rows = await tx.select({ id: servicePoint.id, accountId: servicePoint.accountId, status: servicePoint.connectionStatus }).from(servicePoint).where(inArray(servicePoint.id, [...ids]));
  return rows.map((r) => ({ servicePointId: r.id, accountId: r.accountId, live: r.status !== "DECOMMISSIONED" }));
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
