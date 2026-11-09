import type { Transaction } from "@flowless/db";
import { category, chargeItem, invoiceType, invoiceTypeLine } from "@flowless/db/schema/tariffs";
import { DEFAULT_CATEGORIES, type ChargeRecurrence, type ChargeType, type InvoiceAppliesTo, type OverdueAction } from "@flowless/shared-types";
import { inArray } from "drizzle-orm";

/*
 * What every organization starts with (T-02, T-07, T-08). These are ordinary rows the
 * organization then owns: renamed, deactivated, priced, added to. Nothing here has an amount;
 * prices are the organization's (amount versions, tariffs).
 */

export interface DefaultChargeItem {
  code: string;
  name: string;
  type: ChargeType;
  recurrence?: ChargeRecurrence;
}

/** The starting charge catalog (T-07). */
export const DEFAULT_CHARGE_ITEMS: readonly DefaultChargeItem[] = [
  { code: "water_usage", name: "Water usage", type: "usage" },
  { code: "standing_charge", name: "Standing charge", type: "recurring", recurrence: "monthly" },
  { code: "meter_rent", name: "Meter rent", type: "recurring", recurrence: "monthly" },
  { code: "application_fee", name: "New-connection application fee", type: "fee" },
  { code: "connection_fee", name: "Connection fee", type: "fee" },
  { code: "meter", name: "Meter", type: "material" },
  { code: "materials", name: "Materials", type: "material" },
  { code: "labour", name: "Labour", type: "labour" },
  { code: "deposit", name: "Deposit", type: "deposit" },
  { code: "late_fee", name: "Late fee", type: "penalty" },
  { code: "reconnection_fee", name: "Reconnection fee", type: "fee" },
];

export interface DefaultInvoiceType {
  code: string;
  name: string;
  appliesTo: InvoiceAppliesTo;
  numberPrefix: string;
  dueDays: number;
  overdueAction: OverdueAction;
  overdueAfterDays: number;
  /** Charge item codes of the line template, in order. */
  lines: readonly string[];
}

/**
 * The starting invoice types (T-08, T-09): all payable in full. A new-connection invoice
 * pauses the application when unpaid and carries the usual lines; the others do not
 * disconnect until the organization says so.
 */
export const DEFAULT_INVOICE_TYPES: readonly DefaultInvoiceType[] = [
  {
    code: "new_connection",
    name: "New connection",
    appliesTo: "application",
    numberPrefix: "NC-",
    dueDays: 14,
    overdueAction: "pause_application",
    overdueAfterDays: 7,
    lines: ["application_fee", "connection_fee", "meter", "materials", "labour", "deposit"],
  },
  { code: "usage", name: "Monthly usage", appliesTo: "account", numberPrefix: "INV-", dueDays: 14, overdueAction: "none", overdueAfterDays: 0, lines: [] },
  { code: "penalty", name: "Penalty", appliesTo: "account", numberPrefix: "PEN-", dueDays: 14, overdueAction: "none", overdueAfterDays: 0, lines: [] },
  { code: "adjustment", name: "Adjustment", appliesTo: "account", numberPrefix: "ADJ-", dueDays: 0, overdueAction: "none", overdueAfterDays: 0, lines: [] },
  { code: "deposit", name: "Deposit", appliesTo: "account", numberPrefix: "DEP-", dueDays: 14, overdueAction: "none", overdueAfterDays: 0, lines: ["deposit"] },
];

/**
 * Adds the default categories, charge items and invoice types (with the new-connection
 * line template) that an organization does not have yet, keyed by code. Idempotent and safe
 * to race: a second run, a replayed event or a parallel one inserts nothing, and what the
 * organization has renamed, deactivated or repriced is left alone (codes never change and
 * nothing is deleted, so "has the code" means "was seeded").
 */
export async function ensureDefaults(tx: Transaction, organizationId: string): Promise<{ categories: number; chargeItems: number; invoiceTypes: number }> {
  const categories = await tx
    .insert(category)
    .values(DEFAULT_CATEGORIES.map((c) => ({ organizationId, code: c.code, name: c.name })))
    .onConflictDoNothing({ target: [category.organizationId, category.code] })
    .returning({ id: category.id });

  const items = await tx
    .insert(chargeItem)
    .values(DEFAULT_CHARGE_ITEMS.map((i) => ({ organizationId, code: i.code, name: i.name, type: i.type, recurrence: i.recurrence ?? null })))
    .onConflictDoNothing({ target: [chargeItem.organizationId, chargeItem.code] })
    .returning({ id: chargeItem.id });

  const itemIds = new Map(
    (await tx.select({ id: chargeItem.id, code: chargeItem.code }).from(chargeItem).where(inArray(chargeItem.code, DEFAULT_CHARGE_ITEMS.map((i) => i.code)))).map((r) => [r.code, r.id]),
  );

  let invoiceTypes = 0;
  for (const type of DEFAULT_INVOICE_TYPES) {
    const [row] = await tx
      .insert(invoiceType)
      .values({
        organizationId,
        code: type.code,
        name: type.name,
        appliesTo: type.appliesTo,
        numberPrefix: type.numberPrefix,
        dueDays: type.dueDays,
        overdueAction: type.overdueAction,
        overdueAfterDays: type.overdueAfterDays,
      })
      .onConflictDoNothing({ target: [invoiceType.organizationId, invoiceType.code] })
      .returning({ id: invoiceType.id });
    if (!row) continue;
    invoiceTypes += 1;
    if (type.lines.length) {
      await tx.insert(invoiceTypeLine).values(type.lines.map((code, position) => ({ organizationId, invoiceTypeId: row.id, position, chargeItemId: itemIds.get(code)! })));
    }
  }
  return { categories: categories.length, chargeItems: items.length, invoiceTypes };
}
