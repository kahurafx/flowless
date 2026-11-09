import type { Transaction } from "@flowless/db";
import {
  category,
  categoryAssignment,
  chargeItem,
  chargeItemAmount,
  invoiceType,
  invoiceTypeCounter,
  invoiceTypeLine,
  lateFeeRule,
  tariff,
  tariffVersion,
  tariffVersionLine,
} from "@flowless/db/schema/tariffs";
import { formatInvoiceNumber, planEffectiveDate, revenueKindOf, todayIn, versionInForce, versionSpans, type IsoDate, type LateFeeRule, type OverduePolicy, type Terms, type TariffContent } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { AuditNote } from "../../trpc";
import { readSetting } from "../../kernel/config-store";
import { notFound } from "../../kernel/errors";
import type { EventDef } from "../../kernel/events";
import { regionalSetting } from "../../kernel/regional";
import { closedThrough } from "./closed-period";
import { fromLineRows } from "./content";
import { tariffPolicySetting } from "./settings";

/*
 * Tariffs' shared use cases: the only code, with the procedure files beside it, that touches
 * this module's tables. Routers validate input and call in here with the caller's
 * transaction (RLS-scoped).
 */

export type TariffRow = typeof tariff.$inferSelect;
export type CategoryRow = typeof category.$inferSelect;
export type ChargeItemRow = typeof chargeItem.$inferSelect;
export type InvoiceTypeRow = typeof invoiceType.$inferSelect;

/** What a write needs from the procedure context. The tRPC context satisfies it. */
export interface WriteContext {
  tx: Transaction;
  organizationId: string;
  session: { user: { id: string } };
  audit(note: AuditNote): Promise<void>;
  publish<T>(event: EventDef<T>, payload: T): Promise<unknown>;
}

/* ---------- effective dates (T-03) ---------- */

/** The organization's calendar date today, in its configured time zone. */
export async function organizationToday(tx: Transaction): Promise<IsoDate> {
  return todayIn((await readSetting(tx, regionalSetting)).value.timeZone);
}

/**
 * The effective date for a new version of something dated: the requested one, else the next
 * billing period start (today for the first version). Refuses a date inside a closed period
 * (through the port) or one that already has a version and has arrived.
 */
export async function chooseEffectiveDate(
  tx: Transaction,
  organizationId: string,
  input: { requested?: IsoDate | undefined; existing: readonly IsoDate[]; first?: boolean },
): Promise<IsoDate> {
  const policy = (await readSetting(tx, tariffPolicySetting)).value;
  const closed = await closedThrough(tx, organizationId);
  const plan = planEffectiveDate({
    requested: input.requested,
    today: await organizationToday(tx),
    policy,
    closedThrough: closed ? closed.toISOString().slice(0, 10) : null,
    existing: input.existing,
    first: input.first,
  });
  if (!plan.ok) throw new TRPCError({ code: plan.reason === "closed_period" ? "BAD_REQUEST" : "CONFLICT", message: plan.message });
  return plan.effectiveFrom;
}

/* ---------- tariffs ---------- */

export async function findTariff(tx: Transaction, id: string, lock = false): Promise<TariffRow> {
  const query = tx.select().from(tariff).where(eq(tariff.id, id));
  const [row] = await (lock ? query.for("update") : query);
  if (!row) throw notFound("Tariff");
  return row;
}

export function toTariffDto(t: TariffRow) {
  return { id: t.id, name: t.name, type: t.type, flatBasis: t.flatBasis, active: t.active, createdAt: t.createdAt, updatedAt: t.updatedAt };
}
export type TariffDto = ReturnType<typeof toTariffDto>;

export interface TariffVersionDto {
  id: string;
  tariffId: string;
  versionNo: number;
  effectiveFrom: IsoDate;
  /** First day it no longer applies (the next version's start); null while it is the latest. A replaced version has from = until. */
  until: IsoDate | null;
  note: string | null;
  createdAt: Date;
  createdByUserId: string;
  content: TariffContent;
}

/** A tariff's versions with their content, oldest first. */
export async function tariffVersions(tx: Transaction, t: Pick<TariffRow, "id" | "type">): Promise<TariffVersionDto[]> {
  const versions = await tx.select().from(tariffVersion).where(eq(tariffVersion.tariffId, t.id)).orderBy(asc(tariffVersion.effectiveFrom), asc(tariffVersion.versionNo));
  if (versions.length === 0) return [];
  const lines = await tx
    .select()
    .from(tariffVersionLine)
    .where(
      inArray(
        tariffVersionLine.versionId,
        versions.map((v) => v.id),
      ),
    );
  const spans = new Map(versionSpans(versions).map((s) => [s.version.id, s.until]));
  return versions.map((v) => ({
    id: v.id,
    tariffId: v.tariffId,
    versionNo: v.versionNo,
    effectiveFrom: v.effectiveFrom,
    until: spans.get(v.id) ?? null,
    note: v.note,
    createdAt: v.createdAt,
    createdByUserId: v.createdByUserId,
    content: fromLineRows(
      t.type,
      lines.filter((l) => l.versionId === v.id),
    ),
  }));
}

/** The version of a tariff in force on a date (published read for Billing), with its content; null before the first starts. */
export async function tariffVersionInForce(tx: Transaction, organizationId: string, tariffId: string, on: Date | IsoDate): Promise<TariffVersionDto | null> {
  const [t] = await tx
    .select()
    .from(tariff)
    .where(and(eq(tariff.organizationId, organizationId), eq(tariff.id, tariffId)));
  if (!t) return null;
  return versionInForce(await tariffVersions(tx, t), on);
}

/* ---------- categories (T-02) ---------- */

export function toCategoryDto(c: CategoryRow) {
  return { id: c.id, code: c.code, name: c.name, active: c.active, createdAt: c.createdAt, updatedAt: c.updatedAt };
}

export type AssignmentRow = typeof categoryAssignment.$inferSelect;

export function toAssignmentDto(a: AssignmentRow) {
  return {
    id: a.id,
    categoryId: a.categoryId,
    versionNo: a.versionNo,
    effectiveFrom: a.effectiveFrom,
    tariffId: a.tariffId,
    standingChargeItemId: a.standingChargeItemId,
    meterRentItemId: a.meterRentItemId,
    discountItemId: a.discountItemId,
    reason: a.reason,
    createdAt: a.createdAt,
    createdByUserId: a.createdByUserId,
  };
}
export type AssignmentDto = ReturnType<typeof toAssignmentDto>;

export async function findCategory(tx: Transaction, id: string, lock = false): Promise<CategoryRow> {
  const query = tx.select().from(category).where(eq(category.id, id));
  const [row] = await (lock ? query.for("update") : query);
  if (!row) throw notFound("Category");
  return row;
}

export async function assignmentsOf(tx: Transaction, categoryIds: readonly string[]): Promise<AssignmentRow[]> {
  if (categoryIds.length === 0) return [];
  return tx
    .select()
    .from(categoryAssignment)
    .where(inArray(categoryAssignment.categoryId, [...categoryIds]))
    .orderBy(asc(categoryAssignment.effectiveFrom), asc(categoryAssignment.versionNo));
}

/**
 * What a category is priced with on a date (published read for Billing): its tariff,
 * standing charge, meter rent and discount. Null when no assignment has started by then.
 */
export async function categoryPricing(tx: Transaction, organizationId: string, categoryId: string, on: Date | IsoDate): Promise<AssignmentDto | null> {
  const rows = await tx
    .select()
    .from(categoryAssignment)
    .where(and(eq(categoryAssignment.organizationId, organizationId), eq(categoryAssignment.categoryId, categoryId)));
  const current = versionInForce(rows, on);
  return current ? toAssignmentDto(current) : null;
}

/**
 * Whether a category exists in the organization (published read for Accounts and others
 * that hold the opaque `category_id`); with `activeOnly`, only if it can still be chosen.
 */
export async function categoryExists(tx: Transaction, organizationId: string, id: string, options: { activeOnly?: boolean } = {}): Promise<boolean> {
  const [row] = await tx
    .select({ active: category.active })
    .from(category)
    .where(and(eq(category.organizationId, organizationId), eq(category.id, id)));
  return row !== undefined && (!options.activeOnly || row.active);
}

/** Categories by id, for showing a name next to an account's `category_id`. Unknown ids are left out. */
export async function categoriesById(tx: Transaction, organizationId: string, ids: readonly string[]): Promise<Map<string, { id: string; code: string; name: string; active: boolean }>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ id: category.id, code: category.code, name: category.name, active: category.active })
    .from(category)
    .where(and(eq(category.organizationId, organizationId), inArray(category.id, [...ids])));
  return new Map(rows.map((r) => [r.id, r]));
}

/* ---------- charge catalog (T-07) ---------- */

export type AmountRow = typeof chargeItemAmount.$inferSelect;

export function toAmountDto(a: AmountRow, until: IsoDate | null) {
  return { id: a.id, chargeItemId: a.chargeItemId, versionNo: a.versionNo, effectiveFrom: a.effectiveFrom, until, amount: a.amount, reason: a.reason, createdAt: a.createdAt, createdByUserId: a.createdByUserId };
}
export type AmountDto = ReturnType<typeof toAmountDto>;

export async function findChargeItem(tx: Transaction, by: { id: string } | { code: string }, lock = false): Promise<ChargeItemRow> {
  const query = tx
    .select()
    .from(chargeItem)
    .where("id" in by ? eq(chargeItem.id, by.id) : eq(chargeItem.code, by.code));
  const [row] = await (lock ? query.for("update") : query);
  if (!row) throw notFound("Charge item");
  return row;
}

export async function amountsOf(tx: Transaction, itemIds: readonly string[]): Promise<AmountRow[]> {
  if (itemIds.length === 0) return [];
  return tx
    .select()
    .from(chargeItemAmount)
    .where(inArray(chargeItemAmount.chargeItemId, [...itemIds]))
    .orderBy(asc(chargeItemAmount.effectiveFrom), asc(chargeItemAmount.versionNo));
}

export function toChargeItemDto(c: ChargeItemRow, amounts: readonly AmountRow[], today: IsoDate) {
  const spans = new Map(versionSpans(amounts).map((s) => [s.version.id, s.until]));
  const current = versionInForce(amounts, today);
  return {
    id: c.id,
    code: c.code,
    name: c.name,
    type: c.type,
    /** Derived from the type: a deposit is a liability, not revenue (T-07). */
    revenueKind: revenueKindOf(c.type),
    recurrence: c.recurrence,
    inventoryItemRef: c.inventoryItemRef,
    active: c.active,
    /** The amount in force today, or null for a rate-driven item or one not priced yet. */
    amount: current ? toAmountDto(current, spans.get(current.id) ?? null) : null,
    /** Amounts that start after today. */
    upcoming: amounts.filter((a) => a.effectiveFrom > today && a.id !== current?.id).map((a) => toAmountDto(a, spans.get(a.id) ?? null)),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}
export type ChargeItemDto = ReturnType<typeof toChargeItemDto>;

/** A charge item by code with its amount in force on a date (published read for Billing). Null when the code is unknown. */
export async function chargeItemByCode(tx: Transaction, organizationId: string, code: string, on: Date | IsoDate): Promise<{ item: ChargeItemRow; amount: AmountDto | null } | null> {
  const [item] = await tx
    .select()
    .from(chargeItem)
    .where(and(eq(chargeItem.organizationId, organizationId), eq(chargeItem.code, code)));
  if (!item) return null;
  const current = versionInForce(await amountsOf(tx, [item.id]), on);
  return { item, amount: current ? toAmountDto(current, null) : null };
}

/* ---------- invoice types (T-08 to T-10) ---------- */

export function termsOf(row: InvoiceTypeRow): Terms {
  if (row.termsKind === "minimum_deposit") {
    return { kind: "minimum_deposit", ...(row.minDepositBp !== null ? { percentBp: row.minDepositBp } : {}), ...(row.minDepositAmount !== null ? { amount: row.minDepositAmount } : {}) };
  }
  if (row.termsKind === "installments") return { kind: "installments", count: row.installmentCount!, intervalDays: row.installmentIntervalDays! };
  return { kind: "full" };
}

export function overdueOf(row: InvoiceTypeRow): OverduePolicy {
  return { action: row.overdueAction, afterDays: row.overdueAfterDays };
}

export function lateFeeRuleOf(row: typeof lateFeeRule.$inferSelect): LateFeeRule {
  return { triggerDays: row.triggerDays, base: row.base, rateBp: row.rateBp, flatAmount: row.flatAmount, cap: row.cap, frequency: row.frequency };
}

export async function findInvoiceType(tx: Transaction, by: { id: string } | { code: string }, lock = false): Promise<InvoiceTypeRow> {
  const query = tx
    .select()
    .from(invoiceType)
    .where("id" in by ? eq(invoiceType.id, by.id) : eq(invoiceType.code, by.code));
  const [row] = await (lock ? query.for("update") : query);
  if (!row) throw notFound("Invoice type");
  return row;
}

export async function presentInvoiceTypes(tx: Transaction, rows: readonly InvoiceTypeRow[]) {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const lines = await tx
    .select({
      invoiceTypeId: invoiceTypeLine.invoiceTypeId,
      position: invoiceTypeLine.position,
      chargeItemId: invoiceTypeLine.chargeItemId,
      code: chargeItem.code,
      name: chargeItem.name,
      quantity: invoiceTypeLine.quantity,
      amountOverride: invoiceTypeLine.amountOverride,
      optional: invoiceTypeLine.optional,
    })
    .from(invoiceTypeLine)
    .innerJoin(chargeItem, and(eq(chargeItem.organizationId, invoiceTypeLine.organizationId), eq(chargeItem.id, invoiceTypeLine.chargeItemId)))
    .where(inArray(invoiceTypeLine.invoiceTypeId, ids))
    .orderBy(asc(invoiceTypeLine.position));
  const rules = await tx.select().from(lateFeeRule).where(inArray(lateFeeRule.invoiceTypeId, ids));
  return rows.map((r) => {
    const rule = rules.find((x) => x.invoiceTypeId === r.id);
    return {
      id: r.id,
      code: r.code,
      name: r.name,
      appliesTo: r.appliesTo,
      numbering: { prefix: r.numberPrefix, width: r.numberWidth, start: r.numberStart },
      dueDays: r.dueDays,
      terms: termsOf(r),
      overdue: overdueOf(r),
      active: r.active,
      lines: lines.filter((l) => l.invoiceTypeId === r.id).map((l) => ({ position: l.position, chargeItemId: l.chargeItemId, code: l.code, name: l.name, quantity: l.quantity, amountOverride: l.amountOverride, optional: l.optional })),
      lateFeeRule: rule ? lateFeeRuleOf(rule) : null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  });
}
export type InvoiceTypeDto = Awaited<ReturnType<typeof presentInvoiceTypes>>[number];

/**
 * Takes the next invoice number of an invoice type (T-08), for Billing. One statement: the
 * counter row is created or advanced, and its lock is held until the transaction ends, so
 * concurrent callers take turns and never get the same number (never MAX+1). A rolled-back
 * transaction gives its number back. Raising the type's `start` skips ahead; numbers never
 * go back.
 */
export async function allocateInvoiceNumber(tx: Transaction, organizationId: string, invoiceTypeId: string): Promise<{ number: string; sequence: number; invoiceTypeId: string }> {
  const [type] = await tx
    .select()
    .from(invoiceType)
    .where(and(eq(invoiceType.organizationId, organizationId), eq(invoiceType.id, invoiceTypeId)));
  if (!type) throw notFound("Invoice type");
  if (!type.active) throw new TRPCError({ code: "BAD_REQUEST", message: `Invoice type ${type.code} is not active` });
  const rows = await tx.execute<{ allocated: string }>(sql`
    insert into tariffs.invoice_type_counter as c (organization_id, invoice_type_id, next_value)
    values (${organizationId}, ${invoiceTypeId}, ${type.numberStart + 1})
    on conflict (organization_id, invoice_type_id) do update set next_value = greatest(c.next_value, ${type.numberStart}::bigint) + 1
    returning next_value - 1 as allocated`);
  const sequence = Number(rows[0]!.allocated);
  return { number: formatInvoiceNumber({ prefix: type.numberPrefix, width: type.numberWidth }, sequence), sequence, invoiceTypeId };
}

/** What the next number would be, without taking it (another caller may take it first). */
export async function previewInvoiceNumber(tx: Transaction, type: InvoiceTypeRow): Promise<string> {
  const [counter] = await tx.select({ next: invoiceTypeCounter.nextValue }).from(invoiceTypeCounter).where(eq(invoiceTypeCounter.invoiceTypeId, type.id));
  return formatInvoiceNumber({ prefix: type.numberPrefix, width: type.numberWidth }, Math.max(counter?.next ?? type.numberStart, type.numberStart));
}
