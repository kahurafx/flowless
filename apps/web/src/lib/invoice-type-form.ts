import type { InvoiceAppliesTo, LateFeeBase, LateFeeFrequency, OverdueAction, PaymentTermsKind } from "@flowless/shared-types";
import { amountText, parseAmount } from "./money-input";

/*
 * Invoice type forms (T-08 to T-10) as pure mappers between what the API stores and the text
 * fields a person edits. `allowedOverdueActions` mirrors the Tariffs module's rule so the
 * form never offers what the API refuses (an application's invoice never disconnects); the
 * API validates again.
 */

/** The overdue actions an invoice type that bills `appliesTo` may use (T-09). */
export function allowedOverdueActions(appliesTo: InvoiceAppliesTo): readonly OverdueAction[] {
  return appliesTo === "application" ? ["none", "pause_application", "cancel_application"] : ["none", "disconnect"];
}

/** A percentage typed as "25" or "12.5" as basis points (2500, 1250), or null. At most two decimals. */
export function parsePercentBp(text: string): number | null {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  const bp = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0") || "0");
  return bp >= 1 && bp <= 10_000 ? bp : null;
}

/** Basis points as the percentage text a person reads (2500 is "25", 1250 is "12.5"). */
export function percentText(bp: number): string {
  const whole = Math.floor(bp / 100);
  const rest = bp % 100;
  return rest === 0 ? String(whole) : `${whole}.${String(rest).padStart(2, "0").replace(/0$/, "")}`;
}

const wholeNumber = (text: string, min: number, max: number): number | null => {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= min && n <= max ? n : null;
};

/* ---------- the invoice type ---------- */

export type Terms =
  | { kind: "full" }
  | { kind: "minimum_deposit"; percentBp?: number; amount?: bigint }
  | { kind: "installments"; count: number; intervalDays: number };

export interface InvoiceTypeView {
  name: string;
  appliesTo: InvoiceAppliesTo;
  numbering: { prefix: string; width: number; start: number };
  dueDays: number;
  terms: Terms;
  overdue: { action: OverdueAction; afterDays: number };
  active: boolean;
}

export interface InvoiceTypeForm {
  name: string;
  prefix: string;
  width: string;
  start: string;
  dueDays: string;
  termsKind: PaymentTermsKind;
  depositBasis: "percent" | "amount";
  depositPercent: string;
  depositAmount: string;
  installmentCount: string;
  installmentInterval: string;
  overdueAction: OverdueAction;
  overdueAfterDays: string;
  active: boolean;
}

export function formFromType(t: InvoiceTypeView, currency: string): InvoiceTypeForm {
  const deposit = t.terms.kind === "minimum_deposit" ? t.terms : null;
  const installments = t.terms.kind === "installments" ? t.terms : null;
  return {
    name: t.name,
    prefix: t.numbering.prefix,
    width: String(t.numbering.width),
    start: String(t.numbering.start),
    dueDays: String(t.dueDays),
    termsKind: t.terms.kind,
    depositBasis: deposit?.amount !== undefined ? "amount" : "percent",
    depositPercent: deposit?.percentBp !== undefined ? percentText(deposit.percentBp) : "",
    depositAmount: deposit?.amount !== undefined ? amountText(deposit.amount, currency) : "",
    installmentCount: String(installments?.count ?? 3),
    installmentInterval: String(installments?.intervalDays ?? 30),
    overdueAction: t.overdue.action,
    overdueAfterDays: String(t.overdue.afterDays),
    active: t.active,
  };
}

export type FormResult<T> = { ok: true; input: T } | { ok: false; problems: string[] };

export interface InvoiceTypeUpdate {
  name: string;
  numbering: { prefix: string; width: number; start: number };
  dueDays: number;
  terms: Terms;
  overdue: { action: OverdueAction; afterDays: number };
  active: boolean;
}

/** The update the API takes from the form, or every problem found. */
export function updateFromForm(form: InvoiceTypeForm, appliesTo: InvoiceAppliesTo, currency: string): FormResult<InvoiceTypeUpdate> {
  const problems: string[] = [];
  const name = form.name.trim();
  if (name === "") problems.push("Give the invoice type a name");
  if (!/^[A-Za-z0-9/_-]{0,12}$/.test(form.prefix.trim())) problems.push("The prefix is up to 12 letters, digits, dashes, slashes or underscores");
  const width = wholeNumber(form.width, 1, 12);
  if (width === null) problems.push("Digits in the number: 1 to 12");
  const start = wholeNumber(form.start, 1, 999_999_999_999);
  if (start === null) problems.push("The first number is a whole number from 1");
  const dueDays = wholeNumber(form.dueDays, 0, 365);
  if (dueDays === null) problems.push("Days to pay: 0 to 365");

  let terms: Terms = { kind: "full" };
  if (form.termsKind === "minimum_deposit") {
    if (form.depositBasis === "percent") {
      const bp = parsePercentBp(form.depositPercent);
      if (bp === null) problems.push("The minimum deposit is a percentage from 0.01 to 100");
      else terms = { kind: "minimum_deposit", percentBp: bp };
    } else {
      const amount = parseAmount(form.depositAmount, currency);
      if (amount === null) problems.push("The minimum deposit is an amount like 1500.00");
      else terms = { kind: "minimum_deposit", amount };
    }
  } else if (form.termsKind === "installments") {
    const count = wholeNumber(form.installmentCount, 2, 60);
    const interval = wholeNumber(form.installmentInterval, 1, 365);
    if (count === null) problems.push("Installments: 2 to 60");
    if (interval === null) problems.push("Days between installments: 1 to 365");
    if (count !== null && interval !== null) terms = { kind: "installments", count, intervalDays: interval };
  }

  const afterDays = wholeNumber(form.overdueAfterDays, 0, 365);
  if (afterDays === null) problems.push("Days after the due date: 0 to 365");
  if (!allowedOverdueActions(appliesTo).includes(form.overdueAction)) problems.push(`"${form.overdueAction}" does not fit an invoice for an ${appliesTo}`);

  if (problems.length || width === null || start === null || dueDays === null || afterDays === null) return { ok: false, problems };
  return {
    ok: true,
    input: { name, numbering: { prefix: form.prefix.trim(), width, start }, dueDays, terms, overdue: { action: form.overdueAction, afterDays }, active: form.active },
  };
}

/** What an invoice number looks like for a format (the next one would be `start`). */
export function numberSample(prefix: string, width: number, sequence: number): string {
  return `${prefix}${String(sequence).padStart(width, "0")}`;
}

/* ---------- the line template ---------- */

export interface LineDraft {
  chargeItemCode: string;
  quantity: string;
  /** Empty to use the amount in force when invoiced. */
  amountOverride: string;
  optional: boolean;
}

export interface LineView {
  code: string;
  quantity: number;
  amountOverride: bigint | null;
  optional: boolean;
}

export const linesToDrafts = (lines: readonly LineView[], currency: string): LineDraft[] =>
  lines.map((l) => ({ chargeItemCode: l.code, quantity: String(l.quantity), amountOverride: l.amountOverride === null ? "" : amountText(l.amountOverride, currency), optional: l.optional }));

export function linesFromDrafts(drafts: readonly LineDraft[], currency: string): FormResult<{ chargeItemCode: string; quantity: number; amountOverride: bigint | null; optional: boolean }[]> {
  const problems: string[] = [];
  const seen = new Set<string>();
  const lines = drafts.map((d, i) => {
    const n = i + 1;
    if (d.chargeItemCode === "") problems.push(`Line ${n}: choose a charge item`);
    if (seen.has(d.chargeItemCode)) problems.push(`"${d.chargeItemCode}" is on the template twice`);
    seen.add(d.chargeItemCode);
    const quantity = wholeNumber(d.quantity, 1, 1000);
    if (quantity === null) problems.push(`Line ${n}: quantity is 1 to 1000`);
    let amountOverride: bigint | null = null;
    if (d.amountOverride.trim() !== "") {
      amountOverride = parseAmount(d.amountOverride, currency, { allowZero: true });
      if (amountOverride === null) problems.push(`Line ${n}: the amount is like 1500.00, or leave it empty`);
    }
    return { chargeItemCode: d.chargeItemCode, quantity: quantity ?? 1, amountOverride, optional: d.optional };
  });
  if (drafts.length > 30) problems.push("A template has at most 30 lines");
  return problems.length ? { ok: false, problems } : { ok: true, input: lines };
}

/* ---------- the late-fee rule ---------- */

export interface LateFeeDraft {
  enabled: boolean;
  triggerDays: string;
  base: LateFeeBase;
  mode: "rate" | "flat";
  percent: string;
  flatAmount: string;
  /** Empty for no cap. */
  cap: string;
  frequency: LateFeeFrequency;
}

export interface LateFeeRuleView {
  triggerDays: number;
  base: LateFeeBase;
  rateBp: number | null;
  flatAmount: bigint | null;
  cap: bigint | null;
  frequency: LateFeeFrequency;
}

export const emptyLateFee: LateFeeDraft = { enabled: false, triggerDays: "7", base: "overdue_balance", mode: "rate", percent: "5", flatAmount: "", cap: "", frequency: "once" };

export function lateFeeDraft(rule: LateFeeRuleView | null, currency: string): LateFeeDraft {
  if (!rule) return emptyLateFee;
  return {
    enabled: true,
    triggerDays: String(rule.triggerDays),
    base: rule.base,
    mode: rule.flatAmount !== null ? "flat" : "rate",
    percent: rule.rateBp !== null ? percentText(rule.rateBp) : "5",
    flatAmount: rule.flatAmount !== null ? amountText(rule.flatAmount, currency) : "",
    cap: rule.cap !== null ? amountText(rule.cap, currency) : "",
    frequency: rule.frequency,
  };
}

/** `rule: null` means no rule (the switch is off); a rule is the API's shape. */
export function lateFeeFromDraft(draft: LateFeeDraft, currency: string): FormResult<{ rule: LateFeeRuleView | null }> {
  if (!draft.enabled) return { ok: true, input: { rule: null } };
  const problems: string[] = [];
  const triggerDays = wholeNumber(draft.triggerDays, 0, 365);
  if (triggerDays === null) problems.push("Days after the due date: 0 to 365");
  let rateBp: number | null = null;
  let flatAmount: bigint | null = null;
  if (draft.mode === "rate") {
    rateBp = parsePercentBp(draft.percent);
    if (rateBp === null) problems.push("The fee is a percentage from 0.01 to 100");
  } else {
    flatAmount = parseAmount(draft.flatAmount, currency);
    if (flatAmount === null) problems.push("The flat fee is an amount like 500.00");
  }
  let cap: bigint | null = null;
  if (draft.cap.trim() !== "") {
    cap = parseAmount(draft.cap, currency);
    if (cap === null) problems.push("The cap is an amount like 2000.00, or leave it empty");
  }
  if (problems.length || triggerDays === null) return { ok: false, problems };
  return { ok: true, input: { rule: { triggerDays, base: draft.base, rateBp, flatAmount, cap, frequency: draft.frequency } } };
}

export const lateFeeReasonLabel: Record<string, string> = {
  charged: "The fee is due now.",
  not_overdue: "The invoice is not overdue yet, so no fee.",
  before_trigger: "Overdue, but before the fee starts.",
  no_balance: "Nothing is outstanding, so no fee.",
  already_charged: "The fees already charged cover what the rule asks for.",
  capped: "The cap limits the fee.",
  manual_only: "This rule never charges by itself; the amount shown is what staff would apply.",
};
