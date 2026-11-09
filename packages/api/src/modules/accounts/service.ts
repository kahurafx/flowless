import type { LatLng, Transaction } from "@flowless/db";
import { account, customer, servicePoint } from "@flowless/db/schema/accounts";
import { and, asc, eq, inArray } from "drizzle-orm";
import { notFound } from "../../kernel/errors";
import { accountVisible, customerVisible, servicePointInScope, type Viewer } from "./access";
import { contactsOf, usableEmail, usablePhone, type ContactRow } from "./contact-values";

/*
 * The rows of customers, accounts and service points as the rest of the module reads them:
 * the row types, the finders that apply the viewer's scope (and lock a row when asked), and
 * the DTO mappers and presenters. Everything that changes them lives with its use case
 * (`customers.ts`, `contacts.ts`, `accounts.ts`, `service-points.ts`, `commands.ts`, ...).
 */

export type CustomerRow = typeof customer.$inferSelect;
export type AccountRow = typeof account.$inferSelect;
export type ServicePointRow = typeof servicePoint.$inferSelect;

/* ---------- customers ---------- */

export async function findCustomer(tx: Transaction, viewer: Viewer, id: string, lock = false): Promise<CustomerRow> {
  const query = tx
    .select()
    .from(customer)
    .where(and(eq(customer.id, id), customerVisible(viewer)));
  const [row] = await (lock ? query.for("update") : query);
  if (!row) throw notFound("Customer");
  return row;
}

export function toCustomerDto(c: CustomerRow, contacts: readonly ContactRow[]) {
  return {
    id: c.id,
    type: c.type,
    name: c.name,
    nationalId: c.nationalId,
    registrationNumber: c.registrationNumber,
    language: c.language,
    notes: c.notes,
    phone: usablePhone(contacts),
    email: usableEmail(contacts),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}
export type CustomerDto = ReturnType<typeof toCustomerDto>;

export async function presentCustomers(tx: Transaction, rows: readonly CustomerRow[]): Promise<CustomerDto[]> {
  const contacts = await contactsOf(
    tx,
    rows.map((r) => r.id),
  );
  return rows.map((r) =>
    toCustomerDto(
      r,
      contacts.filter((c) => c.customerId === r.id),
    ),
  );
}

/* ---------- accounts ---------- */

export async function findAccount(tx: Transaction, viewer: Viewer, by: { id: string } | { number: string }, lock = false): Promise<AccountRow> {
  const where = "id" in by ? eq(account.id, by.id) : eq(account.number, by.number.trim().toUpperCase());
  const query = tx
    .select()
    .from(account)
    .where(and(where, accountVisible(viewer)));
  const [row] = await (lock ? query.for("update") : query);
  if (!row) throw notFound("Account");
  return row;
}

/** The account under a row lock; the system (no viewer) sees every account of its organization. */
export async function lockAccount(tx: Transaction, viewer: Viewer | null, accountId: string): Promise<AccountRow> {
  if (viewer) return findAccount(tx, viewer, { id: accountId }, true);
  const [row] = await tx.select().from(account).where(eq(account.id, accountId)).for("update");
  if (!row) throw notFound("Account");
  return row;
}

/** Where an account sits for queues and approvals that scoped members see: its oldest service point's lowest area and route. */
export async function firstPlacement(tx: Transaction, accountId: string): Promise<{ areaId: string | null; routeId: string | null }> {
  const [point] = await tx
    .select({ schemeId: servicePoint.schemeId, zoneId: servicePoint.zoneId, dmaId: servicePoint.dmaId, routeId: servicePoint.routeId })
    .from(servicePoint)
    .where(eq(servicePoint.accountId, accountId))
    .orderBy(asc(servicePoint.createdAt), asc(servicePoint.id))
    .limit(1);
  return { areaId: point ? (point.dmaId ?? point.zoneId ?? point.schemeId) : null, routeId: point?.routeId ?? null };
}

export function toAccountDto(a: AccountRow, customerInfo: { name: string; type: CustomerRow["type"] }, phone: string | null) {
  return {
    id: a.id,
    number: a.number,
    customerId: a.customerId,
    customerName: customerInfo.name,
    customerType: customerInfo.type,
    /** The customer's usable phone (254 format); null when they have none or only placeholders. */
    phone,
    parentAccountId: a.parentAccountId,
    suffixIndex: a.suffixIndex,
    /** Tariffs' category (opaque here). */
    categoryId: a.categoryId,
    /** A child's membership class (C-07), a key of `accounts.membership`. */
    membershipClass: a.membershipClass,
    /** The account this one succeeded, and the one that succeeded it (C-08). */
    predecessorAccountId: a.predecessorAccountId,
    successorAccountId: a.successorAccountId,
    commercialStatus: a.commercialStatus,
    serviceStatus: a.serviceStatus,
    serviceStatusReason: a.serviceStatusReason,
    openedAt: a.openedAt,
  };
}
export type AccountDto = ReturnType<typeof toAccountDto>;

export async function presentAccounts(tx: Transaction, rows: readonly AccountRow[]): Promise<AccountDto[]> {
  if (rows.length === 0) return [];
  const customerIds = [...new Set(rows.map((r) => r.customerId))];
  const [customers, contacts] = await Promise.all([
    tx
      .select({ id: customer.id, name: customer.name, type: customer.type })
      .from(customer)
      .where(inArray(customer.id, customerIds)),
    contactsOf(tx, customerIds),
  ]);
  const byId = new Map(customers.map((c) => [c.id, c]));
  return rows.map((r) =>
    toAccountDto(
      r,
      byId.get(r.customerId) ?? { name: "", type: "person" },
      usablePhone(contacts.filter((c) => c.customerId === r.customerId)),
    ),
  );
}

/** One account as the caller sees it (`presentAccounts` for a single row). */
export async function presentAccount(tx: Transaction, row: AccountRow): Promise<AccountDto> {
  return (await presentAccounts(tx, [row]))[0]!;
}

/* ---------- service points ---------- */


export function toServicePointDto(s: ServicePointRow) {
  return {
    id: s.id,
    accountId: s.accountId,
    address: s.address,
    location: s.location as LatLng | null,
    schemeId: s.schemeId,
    zoneId: s.zoneId,
    dmaId: s.dmaId,
    routeId: s.routeId,
    connectionStatus: s.connectionStatus,
    /** GIS's service connection, by id only. */
    gisConnectionId: s.gisConnectionId,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}
export type ServicePointDto = ReturnType<typeof toServicePointDto>;

export async function findServicePoint(tx: Transaction, viewer: Viewer, id: string): Promise<ServicePointRow> {
  const [row] = await tx
    .select()
    .from(servicePoint)
    .where(and(eq(servicePoint.id, id), servicePointInScope(viewer.scope)));
  if (!row) throw notFound("Service point");
  return row;
}
