/*
 * Tariffs and the charge catalog (T-01 to T-03, T-07 to T-10). The `tariffs` schema's check
 * constraints are built from these lists, so a new value needs a migration.
 */

/** Tariff types (T-01): how consumption, or a flat amount, is priced. */
export const TARIFF_TYPES = ["increasing_block", "decreasing_block", "uniform", "flat_rate"] as const;
export type TariffType = (typeof TARIFF_TYPES)[number];

/** What a flat-rate tariff's amount depends on (T-01): the property, the pipe size, the number of taps, or nothing. */
export const FLAT_BASES = ["property", "pipe_size", "taps", "none"] as const;
export type FlatBasis = (typeof FLAT_BASES)[number];

/** Charge catalog item types (T-07). */
export const CHARGE_TYPES = ["usage", "recurring", "fee", "penalty", "deposit", "material", "labour", "transfer", "adjustment"] as const;
export type ChargeType = (typeof CHARGE_TYPES)[number];

/** How often a recurring item (standing charge, meter rent) is charged (T-07). Monthly is the default. */
export const CHARGE_RECURRENCES = ["monthly", "quarterly", "annually"] as const;
export type ChargeRecurrence = (typeof CHARGE_RECURRENCES)[number];

/**
 * How the sub-ledger treats an item's money (T-07, requirements section 5): revenue, a
 * liability that is not revenue until applied (deposits), or neither (transfers between
 * accounts, C-08).
 */
export const REVENUE_KINDS = ["revenue", "liability", "non_revenue"] as const;
export type RevenueKind = (typeof REVENUE_KINDS)[number];

/** Derived from the type, never chosen: a deposit is a liability and a transfer is excluded from revenue. */
export function revenueKindOf(type: ChargeType): RevenueKind {
  return type === "deposit" ? "liability" : type === "transfer" ? "non_revenue" : "revenue";
}

/** What an invoice type bills (T-08): a connection application, or an existing account. */
export const INVOICE_APPLIES_TO = ["application", "account"] as const;
export type InvoiceAppliesTo = (typeof INVOICE_APPLIES_TO)[number];

/** Payment terms per invoice type (T-09). */
export const PAYMENT_TERMS_KINDS = ["full", "minimum_deposit", "installments"] as const;
export type PaymentTermsKind = (typeof PAYMENT_TERMS_KINDS)[number];

/**
 * What an unpaid invoice of a type leads to once overdue (T-09). An application's invoice
 * pauses or cancels the application and never disconnects; an account's invoice may disconnect.
 */
export const OVERDUE_ACTIONS = ["disconnect", "pause_application", "cancel_application", "none"] as const;
export type OverdueAction = (typeof OVERDUE_ACTIONS)[number];

/** What a late fee is a percentage of (T-10). */
export const LATE_FEE_BASES = ["overdue_balance", "invoice_total"] as const;
export type LateFeeBase = (typeof LATE_FEE_BASES)[number];

/** How often a late fee applies (T-10). `manual_only` is never applied by itself. */
export const LATE_FEE_FREQUENCIES = ["once", "monthly", "manual_only"] as const;
export type LateFeeFrequency = (typeof LATE_FEE_FREQUENCIES)[number];

/** Categories every new organization starts with (T-02); they can be renamed, deactivated and added to. */
export const DEFAULT_CATEGORIES = [
  { code: "domestic", name: "Domestic" },
  { code: "institution", name: "Institution" },
  { code: "kiosk", name: "Kiosk" },
  { code: "commercial", name: "Commercial" },
  { code: "reseller", name: "Reseller" },
  { code: "farming", name: "Farming" },
] as const;
