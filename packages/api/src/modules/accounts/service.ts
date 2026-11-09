import type { LatLng, Transaction } from "@flowless/db";
import { account, accountCounter, customer, customerContact, servicePoint } from "@flowless/db/schema/accounts";
import { callingCodeOf, parsePhone, type ContactChannel } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { areasById, routesById } from "../../kernel/areas";
import { readSetting } from "../../kernel/config-store";
import { regionalSetting } from "../../kernel/regional";
import { accountVisible, customerVisible, placementInScope, servicePointInScope, type Placement, type Viewer } from "./access";
import { childAccountNumber, formatAccountNumber, suffixLetters, type NumberingFormat } from "./numbering";

/*
 * Accounts' use cases: the only code that touches this module's tables. Routers validate
 * input and call in here with the caller's transaction (RLS-scoped) and viewer (scope).
 */

export type CustomerRow = typeof customer.$inferSelect;
export type ContactRow = typeof customerContact.$inferSelect;
export type AccountRow = typeof account.$inferSelect;
export type ServicePointRow = typeof servicePoint.$inferSelect;

export const notFound = (what: string) => new TRPCError({ code: "NOT_FOUND", message: `${what} not found` });

/* ---------- text and identifiers ---------- */

/** A name or address as people type it: trimmed, inner runs of spaces collapsed. */
export const tidy = (text: string) => text.trim().replace(/\s+/g, " ");

/** National ids and registration numbers are compared without spaces, dots or dashes, in upper case. */
export function normalizeIdNumber(raw: string | null | undefined): string | null {
  const id = (raw ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return id === "" ? null : id;
}

/** `%` and `_` typed by a person are not wildcards. */
export const likeEscape = (text: string) => text.replace(/[\\%_]/g, "\\$&");

const emailSchema = z.email();

/** The organization's calling code, from the language and region it has configured (NF-33). */
export async function callingCodeFor(tx: Transaction): Promise<string> {
  return callingCodeOf((await readSetting(tx, regionalSetting)).value.locale);
}

export interface ContactFields {
  value: string;
  normalized: string | null;
  isPlaceholder: boolean;
}

/**
 * What to store for a contact (C-01). A placeholder phone (25400000000, 0777777777 ...) is
 * kept as typed, flagged, and counts as no phone; anything else that is not a phone or an
 * email is refused.
 */
export function contactFields(channel: ContactChannel, rawValue: string, callingCode: string): ContactFields {
  const value = rawValue.trim();
  if (channel === "email") {
    const parsed = emailSchema.safeParse(value);
    if (!parsed.success) throw new TRPCError({ code: "BAD_REQUEST", message: "That is not a valid email address" });
    return { value, normalized: value.toLowerCase(), isPlaceholder: false };
  }
  const phone = parsePhone(value, callingCode);
  if (phone.kind === "invalid") throw new TRPCError({ code: "BAD_REQUEST", message: phone.reason });
  if (phone.kind === "placeholder") return { value, normalized: null, isPlaceholder: true };
  return { value, normalized: phone.digits, isPlaceholder: false };
}

/* ---------- customers and contacts ---------- */

export async function findCustomer(tx: Transaction, viewer: Viewer, id: string, lock = false): Promise<CustomerRow> {
  const query = tx
    .select()
    .from(customer)
    .where(and(eq(customer.id, id), customerVisible(viewer)));
  const [row] = await (lock ? query.for("update") : query);
  if (!row) throw notFound("Customer");
  return row;
}

export async function contactsOf(tx: Transaction, customerIds: readonly string[]): Promise<ContactRow[]> {
  if (customerIds.length === 0) return [];
  return tx
    .select()
    .from(customerContact)
    .where(inArray(customerContact.customerId, [...customerIds]))
    .orderBy(asc(customerContact.createdAt), asc(customerContact.id));
}

/** The number to reach a customer on: the primary phone, else the oldest real one. Never a placeholder. */
export function usablePhone(contacts: readonly ContactRow[]): string | null {
  const phones = contacts.filter((c) => c.channel === "phone" && c.normalized !== null);
  return (phones.find((c) => c.isPrimary) ?? phones[0])?.normalized ?? null;
}

export function usableEmail(contacts: readonly ContactRow[]): string | null {
  const emails = contacts.filter((c) => c.channel === "email" && c.normalized !== null);
  return (emails.find((c) => c.isPrimary) ?? emails[0])?.normalized ?? null;
}

export function toContactDto(c: ContactRow) {
  return {
    id: c.id,
    customerId: c.customerId,
    channel: c.channel,
    kind: c.kind,
    value: c.value,
    /** 254-format digits for a phone, lower-case address for an email; null for a placeholder. */
    normalized: c.normalized,
    isPlaceholder: c.isPlaceholder,
    isPrimary: c.isPrimary,
    createdAt: c.createdAt,
  };
}
export type ContactDto = ReturnType<typeof toContactDto>;

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

/** Adds a contact. The first real one of a channel becomes primary; choosing another primary demotes the old one. */
export async function insertContact(
  tx: Transaction,
  args: {
    organizationId: string;
    userId: string;
    customerId: string;
    channel: ContactChannel;
    kind: ContactRow["kind"];
    fields: ContactFields;
    isPrimary: boolean;
  },
): Promise<ContactRow> {
  const { fields } = args;
  if (args.isPrimary && fields.isPlaceholder) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "A placeholder number cannot be the primary phone" });
  }
  let primary = false;
  if (!fields.isPlaceholder) {
    const existing = await tx
      .select({ id: customerContact.id, isPrimary: customerContact.isPrimary })
      .from(customerContact)
      .where(and(eq(customerContact.customerId, args.customerId), eq(customerContact.channel, args.channel), sql`${customerContact.normalized} is not null`));
    primary = args.isPrimary || !existing.some((c) => c.isPrimary);
    if (primary && existing.some((c) => c.isPrimary)) {
      await tx
        .update(customerContact)
        .set({ isPrimary: false, updatedAt: new Date() })
        .where(and(eq(customerContact.customerId, args.customerId), eq(customerContact.channel, args.channel), eq(customerContact.isPrimary, true)));
    }
  }
  const [row] = await tx
    .insert(customerContact)
    .values({
      organizationId: args.organizationId,
      customerId: args.customerId,
      channel: args.channel,
      kind: args.kind,
      value: fields.value,
      normalized: fields.normalized,
      isPlaceholder: fields.isPlaceholder,
      isPrimary: primary,
      // Contacts of one request keep the order they were given in (a transaction's now() is one instant).
      createdAt: sql`clock_timestamp()`,
      createdByUserId: args.userId,
    })
    .returning();
  return row!;
}

/** After the primary contact of a channel is removed or becomes a placeholder, the oldest real one takes over. */
export async function promoteNextPrimary(tx: Transaction, customerId: string, channel: ContactChannel): Promise<void> {
  const rows = await tx
    .select({ id: customerContact.id, isPrimary: customerContact.isPrimary })
    .from(customerContact)
    .where(and(eq(customerContact.customerId, customerId), eq(customerContact.channel, channel), sql`${customerContact.normalized} is not null`))
    .orderBy(asc(customerContact.createdAt), asc(customerContact.id));
  if (rows.length === 0 || rows.some((r) => r.isPrimary)) return;
  await tx.update(customerContact).set({ isPrimary: true, updatedAt: new Date() }).where(eq(customerContact.id, rows[0]!.id));
}

export type DuplicateMatch = "phone" | "national_id" | "registration_number";

/**
 * Customers that may be the same person or company (C-01): the same normalised phone, the
 * same national id or the same registration number. A warning for the clerk, never a block.
 * Only customers the viewer may see are returned.
 */
export async function findDuplicates(
  tx: Transaction,
  viewer: Viewer,
  query: { phones: readonly string[]; nationalId: string | null; registrationNumber: string | null; excludeCustomerId?: string },
) {
  const matches = new Map<string, Set<DuplicateMatch>>();
  const note = (id: string, how: DuplicateMatch) => {
    if (id === query.excludeCustomerId) return;
    matches.set(id, (matches.get(id) ?? new Set()).add(how));
  };
  const visible = customerVisible(viewer);
  if (query.nationalId) {
    const rows = await tx
      .select({ id: customer.id })
      .from(customer)
      .where(and(eq(customer.nationalId, query.nationalId), visible));
    for (const r of rows) note(r.id, "national_id");
  }
  if (query.registrationNumber) {
    const rows = await tx
      .select({ id: customer.id })
      .from(customer)
      .where(and(eq(customer.registrationNumber, query.registrationNumber), visible));
    for (const r of rows) note(r.id, "registration_number");
  }
  if (query.phones.length) {
    const rows = await tx
      .selectDistinct({ id: customer.id })
      .from(customerContact)
      .innerJoin(customer, and(eq(customer.organizationId, customerContact.organizationId), eq(customer.id, customerContact.customerId)))
      .where(and(eq(customerContact.channel, "phone"), inArray(customerContact.normalized, [...query.phones]), visible));
    for (const r of rows) note(r.id, "phone");
  }
  if (matches.size === 0) return [];
  const rows = await tx
    .select()
    .from(customer)
    .where(inArray(customer.id, [...matches.keys()]))
    .orderBy(asc(customer.name), asc(customer.id))
    .limit(50);
  const dtos = await presentCustomers(tx, rows);
  return dtos.map((c) => ({ customer: c, matchedOn: [...matches.get(c.id)!].sort() }));
}

/* ---------- account numbers (C-02) ---------- */

const MAX_SKIPS = 200;

/**
 * Takes the next value of a counter. One statement: the row is created or updated, and its
 * lock is held until the transaction ends, so two creates at once take turns and never see
 * the same value (never MAX+1). A rolled-back create gives its value back.
 */
async function takeFromCounter(tx: Transaction, organizationId: string, scope: string, start: number): Promise<number> {
  const rows = await tx.execute<{ allocated: string }>(sql`
    insert into accounts.account_counter as c (organization_id, scope, next_value)
    values (${organizationId}, ${scope}, ${start + 1})
    on conflict (organization_id, scope) do update set next_value = greatest(c.next_value, ${start}::bigint) + 1
    returning next_value - 1 as allocated`);
  return Number(rows[0]!.allocated);
}

const numberTaken = async (tx: Transaction, number: string) =>
  (await tx.select({ id: account.id }).from(account).where(eq(account.number, number)).limit(1)).length > 0;

/**
 * The next free account number of the organization. Sequences that have no valid check
 * digit (mod 11, one in eleven) or whose number is already used (the format changed) are
 * skipped, so a gap in the sequence is possible and harmless.
 */
export async function issueAccountNumber(tx: Transaction, organizationId: string, format: NumberingFormat): Promise<string> {
  for (let i = 0; i < MAX_SKIPS; i++) {
    const sequence = await takeFromCounter(tx, organizationId, "main", format.start);
    const number = formatAccountNumber(sequence, format);
    if (number !== null && !(await numberTaken(tx, number))) return number;
  }
  throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "No free account number found: check the numbering format" });
}

/** A child's number under `parent`: the parent's number plus the next letters, counted per parent. */
export async function issueChildNumber(tx: Transaction, organizationId: string, parent: { id: string; number: string }): Promise<{ number: string; suffixIndex: number }> {
  for (let i = 0; i < MAX_SKIPS; i++) {
    const suffixIndex = await takeFromCounter(tx, organizationId, `child:${parent.id}`, 1);
    const number = childAccountNumber(parent.number, suffixIndex);
    if (!(await numberTaken(tx, number))) return { number, suffixIndex };
  }
  throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "No free child number found" });
}

/** What the next number would be, without taking it (another create may take it first). */
export async function previewNextNumber(tx: Transaction, format: NumberingFormat, parent?: { id: string; number: string }): Promise<string> {
  const scope = parent ? `child:${parent.id}` : "main";
  const start = parent ? 1 : format.start;
  const [counter] = await tx.select({ next: accountCounter.nextValue }).from(accountCounter).where(eq(accountCounter.scope, scope));
  for (let sequence = Math.max(counter?.next ?? start, start), i = 0; i < MAX_SKIPS; sequence++, i++) {
    const number = parent ? `${parent.number}${suffixLetters(sequence)}` : formatAccountNumber(sequence, format);
    if (number !== null && !(await numberTaken(tx, number))) return number;
  }
  throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "No free account number found: check the numbering format" });
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

export type PlacementInput = { [K in keyof Placement]?: string | null };

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

const AREA_LEVELS_FOR = {
  schemeId: ["scheme"],
  zoneId: ["zone", "sub_zone"],
  dmaId: ["dma"],
} as const;

const AREA_LABEL = { schemeId: "scheme", zoneId: "zone", dmaId: "DMA" } as const;

/** The areas above `areaId`, nearest first (at most four levels exist). */
async function ancestorsOf(tx: Transaction, areaId: string): Promise<Set<string>> {
  const out = new Set<string>();
  let current = (await areasById(tx, [areaId])).get(areaId);
  for (let depth = 0; current?.parentId && depth < 5; depth++) {
    out.add(current.parentId);
    current = (await areasById(tx, [current.parentId])).get(current.parentId);
  }
  return out;
}

/**
 * Checks a service point's place against the kernel hierarchy (K-02), through the kernel's
 * published reads: each area exists here and has the right level, the route exists, and the
 * areas sit on one branch (the DMA under the zone, the zone under the scheme). Only values
 * in `changed` are checked for being archived, so an old point stays editable when its area
 * is archived later.
 */
export async function validatePlacement(tx: Transaction, place: Placement, changed: ReadonlySet<keyof Placement>): Promise<void> {
  const areaKeys = ["schemeId", "zoneId", "dmaId"] as const;
  const areas = await areasById(
    tx,
    areaKeys.flatMap((k) => (place[k] ? [place[k]] : [])),
  );
  for (const key of areaKeys) {
    const id = place[key];
    if (!id) continue;
    const found = areas.get(id);
    if (!found) throw new TRPCError({ code: "NOT_FOUND", message: `The ${AREA_LABEL[key]} was not found` });
    if (!(AREA_LEVELS_FOR[key] as readonly string[]).includes(found.level)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `${found.name} is a ${found.level.replace("_", " ")}, not a ${AREA_LABEL[key]}` });
    }
    if (found.archivedAt && changed.has(key)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `${found.name} is archived` });
  }
  if (place.dmaId && place.zoneId && !(await ancestorsOf(tx, place.dmaId)).has(place.zoneId)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "That DMA is not in that zone" });
  }
  if (place.schemeId) {
    const below = place.dmaId ?? place.zoneId;
    if (below && !(await ancestorsOf(tx, below)).has(place.schemeId)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `That ${place.dmaId ? "DMA" : "zone"} is not in that scheme` });
    }
  }
  if (place.routeId) {
    const found = (await routesById(tx, [place.routeId])).get(place.routeId);
    if (!found) throw new TRPCError({ code: "NOT_FOUND", message: "The route was not found" });
    if (found.archivedAt && changed.has("routeId")) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `${found.name} is archived` });
  }
}

/** A limited member only places service points inside their own scope. */
export function assertPlacementInScope(viewer: Viewer, place: Placement): void {
  if (placementInScope(viewer.scope, place)) return;
  const empty = !place.schemeId && !place.zoneId && !place.dmaId && !place.routeId;
  throw new TRPCError({
    code: "FORBIDDEN",
    message: empty ? "Choose an area or route inside your scope" : "That area or route is outside your scope",
  });
}
