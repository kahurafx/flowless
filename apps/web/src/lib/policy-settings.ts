import { DISPOSITIONS, READING_OUTCOMES, type Disposition, type ReadingOutcome } from "@flowless/shared-types";
import { amountText, parseAmount } from "./money-input";
import type { FormResult } from "./account-settings";

/*
 * The Billing and Metering configuration settings (K-10, NF-32) as data-driven forms. Each
 * setting is a list of fields; `valueToForm` turns the stored value into text and `valueFromForm`
 * builds the value to store, with the problems the form can find itself. The API validates
 * again with the setting's own schema, so these only keep a bad value from being sent.
 * Amounts in minor units are typed as money and stored as digit strings (never floats).
 */

export const POLICY_KEYS = {
  billingPolicy: "billing.policy",
  billingCycle: "billing.cycle",
  billingReview: "billing.review",
  billingCorrections: "billing.corrections",
  revenueProtection: "billing.revenue_protection",
  meteringValidation: "metering.validation",
  meteringOutcomes: "metering.outcomes",
  meteringMisses: "metering.misses",
  meteringZero: "metering.zero_consumption",
  meteringBulk: "metering.bulk_schedules",
} as const;
export const POLICY_KEY_LIST: readonly string[] = Object.values(POLICY_KEYS);
export const BILLING_KEYS = [POLICY_KEYS.billingPolicy, POLICY_KEYS.billingCycle, POLICY_KEYS.billingReview, POLICY_KEYS.billingCorrections, POLICY_KEYS.revenueProtection] as const;
export const METERING_KEYS = [POLICY_KEYS.meteringValidation, POLICY_KEYS.meteringOutcomes, POLICY_KEYS.meteringMisses, POLICY_KEYS.meteringZero, POLICY_KEYS.meteringBulk] as const;

type Kind = "int" | "number" | "text" | "textarea" | "select" | "bool" | "money";

export interface FieldSpec {
  /** Dotted path into the stored value ("graceWindow.days"). */
  path: string;
  label: string;
  hint?: string;
  kind: Kind;
  min?: number;
  max?: number;
  /** Empty means null. */
  nullable?: boolean;
  options?: readonly { value: string; label: string }[];
}

export interface PolicySpec {
  key: string;
  title: string;
  description: string;
  fields: readonly FieldSpec[];
}

const opts = (pairs: Record<string, string>) => Object.entries(pairs).map(([value, label]) => ({ value, label }));

export const DISPOSITION_LABELS: Record<Disposition, string> = {
  bill_actual: "Bill the actual reading",
  estimate: "Estimate",
  hold: "Hold the bill",
  standing_only: "Standing charges only",
  skip: "Skip the period",
};

export const OUTCOME_FIELD_LABELS: Record<ReadingOutcome, string> = {
  read_ok: "Read normally",
  meter_inaccessible: "Meter inaccessible",
  meter_faulty: "Meter faulty",
  no_meter_found: "No meter found",
  locked_premises: "Premises locked",
  dog_or_hazard: "Dog or hazard",
  customer_refused: "Customer refused",
  illegal_connection_suspected: "Illegal connection suspected",
};

export const POLICY_SPECS: Record<string, PolicySpec> = {
  [POLICY_KEYS.billingPolicy]: {
    key: POLICY_KEYS.billingPolicy,
    title: "Billing policy",
    description: "How consumption is priced and how an unread account is estimated (B-05, B-08, T-05).",
    fields: [
      { path: "tierScaling", label: "Tier bands over a long span", kind: "select", options: opts({ by_period: "Stretch the bands by the months the span covers", none: "Price as a single month" }) },
      { path: "usageInvoiceTypeCode", label: "Usage invoice type code", kind: "text", hint: "The Tariffs invoice type that cycle runs post usage bills under." },
      { path: "estimateMethod", label: "Estimate method", kind: "select", options: opts({ median: "Median of recent actual spans", trimmed_mean: "Trimmed mean", same_month_last_year: "Same month last year", last_actual: "Last actual span", fixed_minimum: "Fixed minimum", none: "Never estimate" }) },
      { path: "estimateAverageOf", label: "Spans an estimate uses", kind: "int", min: 1, max: 12 },
      { path: "estimateTrim", label: "Fraction dropped from each end (trimmed mean)", kind: "number", min: 0, max: 0.49, hint: "0.2 drops a fifth from each end." },
      { path: "estimateFixedMinimum", label: "Fixed minimum units a month", kind: "int", min: 0, max: 1_000_000, nullable: true, hint: "Empty: the fallback below applies." },
      { path: "estimateFallbackUnits", label: "Units when there is no history", kind: "int", min: 0, max: 1_000_000, nullable: true, hint: "Empty holds the bill (no history)." },
      { path: "noneAction", label: "When estimates are off", kind: "select", options: opts({ hold: "Hold the bill", standing_only: "Bill the standing charge only", skip: "Skip the period" }), hint: "The account is always flagged." },
      { path: "outlierCeilingUnitsPerMonth", label: "Hold a bill above this many units a month", kind: "int", min: 1, max: 1_000_000 },
      { path: "outlierFactor", label: "Flag a bill above this multiple of usual use", kind: "number", min: 0, max: 100, hint: "0 turns the check off." },
      { path: "meterDigits", label: "Dial digits (for rollover)", kind: "int", min: 3, max: 10 },
    ],
  },
  [POLICY_KEYS.billingCycle]: {
    key: POLICY_KEYS.billingCycle,
    title: "Billing cycle",
    description: "When bills are made and how often a route is billed (B-01). Read when a cycle is opened.",
    fields: [
      { path: "trigger", label: "Trigger", kind: "select", options: opts({ batch: "Batch: bill the route together", on_reading: "On each reading: bill as it clears" }) },
      { path: "frequency", label: "Frequency", kind: "select", options: opts({ monthly: "Monthly", bimonthly: "Every two months", quarterly: "Every three months" }) },
    ],
  },
  [POLICY_KEYS.billingReview]: {
    key: POLICY_KEYS.billingReview,
    title: "Bill review",
    description: "Review by exception (B-16): which bills may be approved in bulk, how many are spot-checked and when only an approver decides.",
    fields: [
      { path: "bulkApproveBelow", label: "Bulk-approve clean bills up to", kind: "money" },
      { path: "individualAbove", label: "Only an approver decides above", kind: "money", hint: "Cannot be below the bulk threshold." },
      { path: "sampleRate", label: "Share of clean bills spot-checked", kind: "number", min: 0, max: 1, hint: "0.05 is one in twenty." },
      { path: "sampleMinimum", label: "At least this many spot-checked", kind: "int", min: 0, max: 1000 },
    ],
  },
  [POLICY_KEYS.billingCorrections]: {
    key: POLICY_KEYS.billingCorrections,
    title: "Billing corrections",
    description: "Who may post a correction without approval, when evidence is needed and the wording the customer sees (B-13, B-14).",
    fields: [
      { path: "graceWindow.basis", label: "Grace window runs to", kind: "select", options: opts({ invoice_due_date: "The original invoice's due date", days_after_issue: "A number of days after issue" }) },
      { path: "graceWindow.days", label: "Days after issue (and the fallback with no due date)", kind: "int", min: 0, max: 730 },
      { path: "largeDeviation.percent", label: "Evidence needed above this percent of the original", kind: "number", min: 0, max: 10000, hint: "0 turns the limit off." },
      { path: "largeDeviation.amount", label: "Evidence needed above this amount", kind: "money", hint: "0 turns the limit off." },
      { path: "creditTemplate", label: "Credit wording", kind: "textarea", hint: "Placeholders: {original_number} {period} {amount} {direction} {from} {to} {units}" },
      { path: "debitTemplate", label: "Debit wording", kind: "textarea" },
    ],
  },
  [POLICY_KEYS.revenueProtection]: {
    key: POLICY_KEYS.revenueProtection,
    title: "Revenue protection",
    description: "How far back a back-billing may reach and whether it needs approval (B-19).",
    fields: [
      { path: "backBillMaxMonths", label: "Back-billing reaches back at most (months)", kind: "int", min: 0, max: 120 },
      { path: "backBillRequiresApproval", label: "Back-billing needs an approved request", kind: "bool" },
    ],
  },
  [POLICY_KEYS.meteringValidation]: {
    key: POLICY_KEYS.meteringValidation,
    title: "Reading validation",
    description: "The expected-range, rollover and ceiling checks applied when a reading is recorded (M-05, M-07).",
    fields: [
      { path: "highFactor", label: "Flag consumption above this multiple of expected", kind: "number", min: 1, max: 1000 },
      { path: "lowFactor", label: "Flag consumption below this fraction of expected", kind: "number", min: 0, max: 1, hint: "0 switches the low check off." },
      { path: "historyIntervals", label: "Earlier intervals that make the expected use", kind: "int", min: 1, max: 12 },
      { path: "maxUnitsPerDay", label: "Hard ceiling in units a day", kind: "number", min: 0, nullable: true, hint: "Empty for none." },
      { path: "rolloverMaxFraction", label: "Rollover candidate when wrapped use is under this share of the dial", kind: "number", min: 0.01, max: 1 },
    ],
  },
  [POLICY_KEYS.meteringMisses]: {
    key: POLICY_KEYS.meteringMisses,
    title: "Missed readings",
    description: "How many visits in a row without a reading ask for a revisit, a customer self-read prompt and an escalation (M-09). 0 switches an action off.",
    fields: [
      { path: "revisitAfter", label: "Revisit after", kind: "int", min: 0, max: 24 },
      { path: "selfReadPromptAfter", label: "Self-read prompt after", kind: "int", min: 0, max: 24 },
      { path: "escalateAfter", label: "Escalate after", kind: "int", min: 0, max: 24 },
      { path: "maxConsecutiveEstimates", label: "Alert after this many estimates in a row", kind: "int", min: 1, max: 60, nullable: true, hint: "Empty for no cap." },
    ],
  },
  [POLICY_KEYS.meteringZero]: {
    key: POLICY_KEYS.meteringZero,
    title: "Zero consumption",
    description: "Zero consumption is billed and flagged; this many zero readings in a row open a meter check (M-10).",
    fields: [{ path: "streakAfter", label: "Open a meter check after", kind: "int", min: 0, max: 24, hint: "0 switches it off." }],
  },
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function getPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((at, part) => (isObject(at) ? at[part] : undefined), value);
}

function setPath(target: Record<string, unknown>, path: string, value: unknown) {
  const parts = path.split(".");
  let at = target;
  for (const part of parts.slice(0, -1)) {
    const next = at[part];
    if (isObject(next)) at = next;
    else {
      const made: Record<string, unknown> = {};
      at[part] = made;
      at = made;
    }
  }
  at[parts[parts.length - 1]!] = value;
}

/** The text each field of a setting starts with. */
export function valueToForm(spec: PolicySpec, value: unknown, currency: string): Record<string, string> {
  return Object.fromEntries(
    spec.fields.map((f) => {
      const v = getPath(value, f.path);
      if (v === null || v === undefined) return [f.path, ""];
      if (f.kind === "bool") return [f.path, v === true ? "true" : "false"];
      if (f.kind === "money") return [f.path, typeof v === "string" && /^\d+$/.test(v) ? amountText(BigInt(v), currency) : ""];
      return [f.path, String(v)];
    }),
  );
}

/** The value to store from the form's text, or what is wrong. `base` carries stored fields the form does not edit. */
export function valueFromForm(spec: PolicySpec, form: Record<string, string>, currency: string, base: unknown = {}): FormResult<unknown> {
  const problems: string[] = [];
  const out: Record<string, unknown> = structuredClone(isObject(base) ? base : {});
  for (const f of spec.fields) {
    const text = (form[f.path] ?? "").trim();
    if (f.kind === "bool") {
      setPath(out, f.path, text === "true");
      continue;
    }
    if (text === "") {
      if (f.nullable) setPath(out, f.path, null);
      else problems.push(`${f.label} is required`);
      continue;
    }
    switch (f.kind) {
      case "int":
      case "number": {
        const n = Number(text);
        if (!Number.isFinite(n) || (f.kind === "int" && !Number.isInteger(n)) || (f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) {
          problems.push(`${f.label}: ${f.kind === "int" ? "a whole number" : "a number"}${f.min !== undefined && f.max !== undefined ? ` from ${f.min} to ${f.max}` : f.min !== undefined ? ` of at least ${f.min}` : ""}`);
        } else setPath(out, f.path, n);
        break;
      }
      case "money": {
        const minor = parseAmount(text, currency, { allowZero: true });
        if (minor === null) problems.push(`${f.label}: enter an amount like 1250.00`);
        else setPath(out, f.path, minor.toString());
        break;
      }
      case "select":
        if (!f.options?.some((o) => o.value === text)) problems.push(`${f.label}: choose one of the options`);
        else setPath(out, f.path, text);
        break;
      default:
        setPath(out, f.path, text);
    }
  }
  const review = spec.key === POLICY_KEYS.billingReview;
  if (review && problems.length === 0) {
    const bulk = BigInt(String(getPath(out, "bulkApproveBelow")));
    const individual = BigInt(String(getPath(out, "individualAbove")));
    if (individual < bulk) problems.push("The individual-approval threshold cannot be below the bulk threshold");
  }
  return problems.length ? { ok: false, problems } : { ok: true, value: out };
}

/* ---------- outcome mapping (M-06) ---------- */

export type OutcomeForm = Record<ReadingOutcome, Disposition | "">;

export function outcomesToForm(value: unknown): OutcomeForm {
  const v = isObject(value) ? value : {};
  return Object.fromEntries(READING_OUTCOMES.map((o) => [o, DISPOSITIONS.find((d) => d === v[o]) ?? ""])) as OutcomeForm;
}

/** Only the overrides are stored: an outcome left on "engine default" is left out. */
export function outcomesFromForm(form: OutcomeForm): FormResult<Partial<Record<ReadingOutcome, Disposition>>> {
  const value: Partial<Record<ReadingOutcome, Disposition>> = {};
  for (const o of READING_OUTCOMES) if (form[o]) value[o] = form[o];
  return { ok: true, value };
}

/* ---------- bulk meter schedules (M-12) ---------- */

export interface ScheduleRow {
  dmaId: string;
  everyDays: string;
  startDate: string;
}
export const emptySchedule: ScheduleRow = { dmaId: "", everyDays: "30", startDate: "" };

export function schedulesToForm(value: unknown): ScheduleRow[] {
  const list = isObject(value) && Array.isArray(value.schedules) ? value.schedules : [];
  return list.flatMap((s) => (isObject(s) ? [{ dmaId: String(s.dmaId ?? ""), everyDays: String(s.everyDays ?? ""), startDate: String(s.startDate ?? "") }] : []));
}

export function schedulesFromForm(rows: readonly ScheduleRow[]): FormResult<{ schedules: { dmaId: string; everyDays: number; startDate: string }[] }> {
  const problems: string[] = [];
  const seen = new Set<string>();
  const schedules = rows.map((r, i) => {
    const n = Number(r.everyDays);
    if (!r.dmaId) problems.push(`Schedule ${i + 1}: choose a DMA`);
    else if (seen.has(r.dmaId)) problems.push(`Schedule ${i + 1}: that DMA already has a schedule`);
    seen.add(r.dmaId);
    if (!Number.isInteger(n) || n < 1 || n > 366) problems.push(`Schedule ${i + 1}: days between readings, 1 to 366`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.startDate)) problems.push(`Schedule ${i + 1}: choose a start date`);
    return { dmaId: r.dmaId, everyDays: n, startDate: r.startDate };
  });
  return problems.length ? { ok: false, problems } : { ok: true, value: { schedules } };
}

/** A short line for the version history. */
export function summarizePolicy(key: string, value: unknown): string {
  if (key === POLICY_KEYS.meteringOutcomes) {
    const n = outcomesToForm(value);
    const changed = READING_OUTCOMES.filter((o) => n[o]);
    return changed.length ? `${changed.length} outcome${changed.length === 1 ? "" : "s"} changed from the default` : "Engine defaults";
  }
  if (key === POLICY_KEYS.meteringBulk) {
    const n = schedulesToForm(value).length;
    return n ? `${n} DMA schedule${n === 1 ? "" : "s"}` : "No schedules";
  }
  const spec = POLICY_SPECS[key];
  if (!spec) return "";
  const parts = spec.fields
    .filter((f) => f.kind !== "textarea")
    .slice(0, 3)
    .map((f) => {
      const v = getPath(value, f.path);
      const shown = v === null || v === undefined ? "none" : f.kind === "select" ? (f.options?.find((o) => o.value === v)?.label ?? String(v)) : String(v);
      return `${f.label.toLowerCase()}: ${shown}`;
    });
  return parts.join("; ");
}
