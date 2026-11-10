import { money, type Money } from "@flowless/shared-types";

/*
 * Pure helpers for the account statement and document screens (Phase 4 P4-5: B-11, B-17, T-04, K-05).
 * Money stays a bigint in minor units from the API to `formatMoney`; nothing here makes a float.
 */

export type DocumentKind = "invoice" | "credit_note" | "debit_note" | "reversal";

export const documentKindLabel: Record<DocumentKind, string> = {
  invoice: "Invoice",
  credit_note: "Credit note",
  debit_note: "Debit note",
  reversal: "Reversal",
};

const ENTRY_LABEL: Record<string, string> = {
  charge: "Charge",
  payment: "Payment",
  adjustment: "Adjustment",
  credit: "Credit",
  deposit: "Deposit",
  write_off: "Write-off",
  transfer: "Transfer",
  reversal: "Reversal",
};

export const entryTypeLabel = (type: string): string => ENTRY_LABEL[type] ?? type;

export const lineTypeLabel: Record<string, string> = {
  consumption: "Consumption",
  true_up: "True-up",
  standing: "Standing charge",
  charge: "Charge",
  fee: "Fee",
  penalty: "Penalty",
  deposit: "Deposit",
  adjustment: "Adjustment",
  transfer: "Transfer",
};

export type Tone = "success" | "warning" | "info" | "destructive" | "secondary" | "outline";
export interface Mark {
  label: string;
  tone: Tone;
}

/**
 * The badges of a statement row or document: what it is, and whether it was reversed. A credit
 * note and a reversal are always marked; a reversed document says so (corrections are
 * reversals, never edits, I-2).
 */
export function marksFor(input: { entryType?: string | null; documentKind: string | null; reversed: boolean; finalBill?: boolean }): Mark[] {
  const marks: Mark[] = [];
  if (input.documentKind === "reversal" || input.entryType === "reversal") marks.push({ label: "Reversal", tone: "destructive" });
  else if (input.documentKind === "credit_note") marks.push({ label: "Credit note", tone: "success" });
  else if (input.documentKind === "debit_note") marks.push({ label: "Debit note", tone: "warning" });
  else if (input.documentKind === "invoice") marks.push({ label: "Invoice", tone: "outline" });
  else if (input.entryType) marks.push({ label: entryTypeLabel(input.entryType), tone: "secondary" });
  if (input.finalBill) marks.push({ label: "Final bill", tone: "info" });
  if (input.reversed) marks.push({ label: "Reversed", tone: "destructive" });
  return marks;
}

/** Ids of documents some reversal document reverses. */
export function reversedIds(documents: readonly { reversesDocumentId: string | null }[]): Set<string> {
  return new Set(documents.flatMap((d) => (d.reversesDocumentId ? [d.reversesDocumentId] : [])));
}

/** What the receivable balance means: positive is owed (debit), negative is credit held for the customer. */
export function balanceSummary(amountMinor: bigint): { label: string; owing: boolean } {
  if (amountMinor > 0n) return { label: "Owing", owing: true };
  if (amountMinor < 0n) return { label: "In credit", owing: false };
  return { label: "Nothing owing", owing: false };
}

export const asMoney = (amountMinor: bigint, currency: string): Money => money(amountMinor, currency);

/** A calendar date ("2026-03-31") in the locale, without moving it across time zones. */
export function formatDay(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));
}

/** "1 Mar 2026 to 31 Mar 2026", one date when the ends match, a dash when unknown. */
export function servicePeriod(from: string | null, to: string | null, locale: string): string {
  if (!from && !to) return "—";
  if (from && to && from !== to) return `${formatDay(from, locale)} to ${formatDay(to, locale)}`;
  return formatDay((from ?? to)!, locale);
}

/** Newest first for display; the running total on each row was computed over the whole history. */
export const newestFirst = <T>(rows: readonly T[]): T[] => [...rows].reverse();

/** Tariff versions cited by a line (T-04): the column, plus the calculation's list when a span crosses versions. */
export function citedVersionIds(line: { tariffVersionId: string | null; calculation: unknown }): string[] {
  const ids = new Set<string>();
  if (line.tariffVersionId) ids.add(line.tariffVersionId);
  const calc = line.calculation;
  if (calc && typeof calc === "object" && "tariffVersionIds" in calc && Array.isArray(calc.tariffVersionIds)) {
    for (const id of calc.tariffVersionIds) if (typeof id === "string") ids.add(id);
  }
  return [...ids];
}

/* ---------- actions ---------- */

/** The reasons the adjustment approval offers (`modules/billing/approvals.ts`); the API checks the code. */
export const ADJUSTMENT_REASONS = [
  { code: "BILLING_ERROR", label: "Billing error" },
  { code: "METER_FAULT", label: "Faulty meter" },
  { code: "LEAK_ALLOWANCE", label: "Leak allowance" },
  { code: "DISPUTE_SETTLED", label: "Dispute settled" },
  { code: "GOODWILL", label: "Goodwill" },
  { code: "OTHER", label: "Other (explain in the note)" },
] as const;

export const NOTE_KIND_LABEL = { credit_note: "Credit note", debit_note: "Debit note" } as const;

/** The refusal said plainly. The procedure decides; this only explains (CONFLICT, NOT_FOUND, PRECONDITION_FAILED). */
export function billingErrorMessage(code: string | undefined, message: string): string {
  switch (code) {
    case "CONFLICT":
      return `${message}. Someone may have done this already: reload the page to see where things stand.`;
    case "NOT_FOUND":
      return "That document or account was not found, or it is outside the areas you can see.";
    case "PRECONDITION_FAILED":
      return `Not possible: ${message}`;
    default:
      return message;
  }
}

export interface RebillForm {
  accountId: string;
  categoryId: string | null;
  invoiceTypeId: string;
  /** The invoice's period end ("2026-03-31"); the replacement is for the same month. */
  periodTo: string | null;
  mode: "estimate" | "units" | "dial";
  value: string;
  baselinePeriod: string;
  baselineDial: string;
}

export interface RebillBill {
  accountId: string;
  categoryId: string;
  invoiceTypeId: string;
  period: string;
  reading: { dial?: number; units?: number };
  readings: { period: string; kind: "actual"; dial: number; flags: never[] }[];
}

const WHOLE = /^\d{1,9}$/;

/** The corrected bill for a re-bill, as the usage procedure takes it (the caller supplies the reading history until Metering, Phase 5). */
export function rebillBill(form: RebillForm): { ok: true; bill: RebillBill } | { ok: false; message: string } {
  if (!form.categoryId) return { ok: false, message: "This account has no category, so it cannot be priced" };
  if (!form.periodTo) return { ok: false, message: "This document has no service period to re-bill" };
  const base = { accountId: form.accountId, categoryId: form.categoryId, invoiceTypeId: form.invoiceTypeId, period: form.periodTo.slice(0, 7) };
  if (form.mode === "estimate") return { ok: true, bill: { ...base, reading: {}, readings: [] } };
  const value = form.value.trim();
  if (!WHOLE.test(value)) return { ok: false, message: form.mode === "units" ? "Enter the units as a whole number" : "Enter the dial reading as a whole number" };
  if (form.mode === "units") return { ok: true, bill: { ...base, reading: { units: Number(value) }, readings: [] } };
  const period = form.baselinePeriod.trim();
  const dial = form.baselineDial.trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period) || !WHOLE.test(dial)) {
    return { ok: false, message: "A dial reading needs the earlier actual reading: its month (YYYY-MM) and dial" };
  }
  return { ok: true, bill: { ...base, reading: { dial: Number(value) }, readings: [{ period, kind: "actual", dial: Number(dial), flags: [] }] } };
}
