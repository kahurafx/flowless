import {
  ACTIVATION_GATE_KEYS,
  CHARGE_TYPES,
  COMMERCIAL_STATUSES,
  DATA_QUALITY_RULES,
  DATA_QUALITY_SEVERITIES,
  SERVICE_STATES,
  effectiveDataQualityRules,
  isPermission,
  type ActivationMode,
  type ChargeType,
  type CheckDigitScheme,
  type CommercialStatus,
  type DataQualityRuleKey,
  type DataQualitySeverity,
  type Permission,
  type ServiceState,
} from "@flowless/shared-types";
import { amountText, minorFromDigits, parseAmount } from "./money-input";

/*
 * The Accounts configuration settings (K-10, C-02, C-04 to C-07, C-12) and the two approval
 * policies of the Accounts module as forms: each setting's stored value mapped to the fields
 * a person edits and back. Pure, so the mappers are tested without a browser. The stored
 * shapes mirror the zod schemas in `packages/api/src/modules/accounts` (the web may not import
 * them into the browser); the API validates every save again and its refusal is shown as is.
 */

export const SETTING_KEYS = {
  numbering: "accounts.numbering",
  statusRules: "accounts.status_rules",
  activation: "accounts.activation",
  application: "accounts.application",
  membership: "accounts.membership",
  dataQuality: "accounts.data_quality",
  surveyApproval: "approvals.accounts.connection_survey",
  writeOffApproval: "approvals.accounts.write_off",
} as const;

export type FormResult<T> = { ok: true; value: T } | { ok: false; problems: string[] };
const ok = <T>(value: T): FormResult<T> => ({ ok: true, value });
const fail = <T>(...problems: string[]): FormResult<T> => ({ ok: false, problems });

const whole = (text: string, min: number, max: number): number | null => {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= min && n <= max ? n : null;
};

/** A stable key from a label: "Site visit signed off" becomes "site_visit_signed_off". */
export function keyFromLabel(label: string, maxLength: number): string {
  const key = label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, maxLength)
    .replace(/_+$/g, "");
  return /^[a-z]/.test(key) ? key : key === "" ? "" : `x_${key}`.slice(0, maxLength);
}

/* ---------- a future effective date ---------- */

/**
 * The instant a scheduled change starts: midnight at the start of `date` in the
 * organization's time zone. Blank means "now". A date that is not after today is refused
 * (the store refuses the past; "today" is "now", so leave it blank).
 */
export function effectiveFromOf(dateText: string, today: string, timeZone: string): FormResult<Date | null> {
  const text = dateText.trim();
  if (text === "") return ok(null);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return fail("Enter the date as day, month and year");
  if (text <= today) return fail("A scheduled change starts after today. Leave the date empty to apply it now.");
  return ok(startOfDayIn(text, timeZone));
}

/** Midnight at the start of a calendar date in an IANA time zone, as an instant. */
export function startOfDayIn(date: string, timeZone: string): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const wanted = Date.UTC(y, m - 1, d);
  const offsetAt = (instant: number) => {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(new Date(instant));
    const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
    return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - Math.floor(instant / 1000) * 1000;
  };
  // Two passes settle on the right offset even across a daylight-saving change.
  let instant = wanted - offsetAt(wanted);
  instant = wanted - offsetAt(instant);
  return new Date(instant);
}

/* ---------- accounts.numbering (C-02) ---------- */

export interface NumberingValue {
  prefix: string;
  width: number;
  start: number;
  checkDigit: CheckDigitScheme;
  separator: "" | "-" | "/" | ".";
  childSuffix: "letters";
}
export interface NumberingForm {
  prefix: string;
  width: string;
  start: string;
  checkDigit: CheckDigitScheme;
  separator: NumberingValue["separator"];
}

export const checkDigitLabel: Record<CheckDigitScheme, string> = {
  none: "No check digit",
  luhn: "Luhn (catches a mistyped digit)",
  mod11: "Mod 11 (also catches swapped digits)",
};
export const separatorLabel: Record<NumberingValue["separator"], string> = { "": "None", "-": "Dash (-)", "/": "Slash (/)", ".": "Dot (.)" };

export const numberingToForm = (v: NumberingValue): NumberingForm => ({ prefix: v.prefix, width: String(v.width), start: String(v.start), checkDigit: v.checkDigit, separator: v.separator });

export function numberingFromForm(form: NumberingForm, current: NumberingValue): FormResult<NumberingValue> {
  const problems: string[] = [];
  const prefix = form.prefix.trim().toUpperCase();
  if (!/^[A-Z0-9]{0,8}$/.test(prefix)) problems.push("The prefix is up to 8 capital letters or digits");
  const width = whole(form.width, 1, 12);
  if (width === null) problems.push("Digits in the number: 1 to 12");
  const start = whole(form.start, 1, 2_000_000_000);
  if (start === null) problems.push("The first number is a whole number from 1");
  if (problems.length || width === null || start === null) return { ok: false, problems };
  return ok({ ...current, prefix, width, start, checkDigit: form.checkDigit, separator: form.separator });
}

/* ---------- accounts.status_rules (C-04) ---------- */

export interface StatusRuleCell {
  billsConsumption: boolean;
  chargeTypes: ChargeType[];
}
export type StatusRulesValue = Record<CommercialStatus, Record<ServiceState, StatusRuleCell>>;
/** Usage is not a choice of its own: it is billed exactly when consumption is. */
export type StatusRulesForm = Record<CommercialStatus, Record<ServiceState, { billsConsumption: boolean; chargeTypes: ChargeType[] }>>;

/** The charge types a cell can switch on besides usage. */
export const OTHER_CHARGE_TYPES = CHARGE_TYPES.filter((t) => t !== "usage");

export function statusRulesToForm(value: StatusRulesValue): StatusRulesForm {
  const form = {} as StatusRulesForm;
  for (const status of COMMERCIAL_STATUSES) {
    form[status] = {} as StatusRulesForm[CommercialStatus];
    for (const service of SERVICE_STATES) {
      const cell = value[status][service];
      form[status][service] = { billsConsumption: cell.billsConsumption, chargeTypes: CHARGE_TYPES.filter((t) => t !== "usage" && cell.chargeTypes.includes(t)) };
    }
  }
  return form;
}

export function statusRulesFromForm(form: StatusRulesForm): StatusRulesValue {
  const value = {} as StatusRulesValue;
  for (const status of COMMERCIAL_STATUSES) {
    value[status] = {} as StatusRulesValue[CommercialStatus];
    for (const service of SERVICE_STATES) {
      const cell = form[status][service];
      value[status][service] = { billsConsumption: cell.billsConsumption, chargeTypes: CHARGE_TYPES.filter((t) => (t === "usage" ? cell.billsConsumption : cell.chargeTypes.includes(t))) };
    }
  }
  return value;
}

/** Switches one charge type in one cell. */
export function toggleChargeType(form: StatusRulesForm, status: CommercialStatus, service: ServiceState, type: ChargeType, on: boolean): StatusRulesForm {
  const cell = form[status][service];
  const chargeTypes = on ? CHARGE_TYPES.filter((t) => t !== "usage" && (t === type || cell.chargeTypes.includes(t))) : cell.chargeTypes.filter((t) => t !== type);
  return { ...form, [status]: { ...form[status], [service]: { ...cell, chargeTypes } } };
}

export function toggleConsumption(form: StatusRulesForm, status: CommercialStatus, service: ServiceState, on: boolean): StatusRulesForm {
  return { ...form, [status]: { ...form[status], [service]: { ...form[status][service], billsConsumption: on } } };
}

/* ---------- accounts.activation (C-06) ---------- */

export interface ActivationValue {
  mode: ActivationMode;
  staleAfterDays: number;
  gates: {
    payment_threshold: { enabled: boolean; required: boolean; basis: "percent" | "fixed"; percent: number; fixedAmount: string };
    meter_installed: { enabled: boolean; required: boolean };
    initial_reading: { enabled: boolean; required: boolean };
  };
  officeChecklist: { key: string; label: string; enabled: boolean; required: boolean }[];
}

export interface ActivationForm {
  mode: ActivationMode;
  staleAfterDays: string;
  gates: {
    payment_threshold: { enabled: boolean; required: boolean; basis: "percent" | "fixed"; percent: string; fixedAmount: string };
    meter_installed: { enabled: boolean; required: boolean };
    initial_reading: { enabled: boolean; required: boolean };
  };
  /** `key` is "" for an item added in this form: it is made from the label on save. */
  officeChecklist: { key: string; label: string; enabled: boolean; required: boolean }[];
}

export const gateLabel: Record<(typeof ACTIVATION_GATE_KEYS)[number], string> = {
  payment_threshold: "Payment threshold met",
  meter_installed: "Meter installed and confirmed in inventory",
  initial_reading: "Initial reading captured",
};

export function activationToForm(v: ActivationValue, currency: string): ActivationForm {
  const fixed = minorFromDigits(v.gates.payment_threshold.fixedAmount) ?? 0n;
  return {
    mode: v.mode,
    staleAfterDays: String(v.staleAfterDays),
    gates: {
      payment_threshold: { ...v.gates.payment_threshold, percent: String(v.gates.payment_threshold.percent), fixedAmount: amountText(fixed, currency) },
      meter_installed: { ...v.gates.meter_installed },
      initial_reading: { ...v.gates.initial_reading },
    },
    officeChecklist: v.officeChecklist.map((i) => ({ ...i })),
  };
}

export function activationFromForm(form: ActivationForm, currency: string): FormResult<ActivationValue> {
  const problems: string[] = [];
  const stale = whole(form.staleAfterDays, 1, 365);
  if (stale === null) problems.push("Days before an account is raised as stale: 1 to 365");
  const pay = form.gates.payment_threshold;
  const percent = whole(pay.percent, 1, 100);
  if (pay.enabled && pay.basis === "percent" && percent === null) problems.push("The payment threshold is a whole percentage from 1 to 100");
  const fixed = parseAmount(pay.fixedAmount, currency, { allowZero: true });
  if (pay.enabled && pay.basis === "fixed" && fixed === null) problems.push("The payment threshold is an amount like 1500.00");

  const taken = new Set<string>(ACTIVATION_GATE_KEYS);
  const items = form.officeChecklist.map((item, i) => {
    const label = item.label.trim();
    if (label === "") problems.push(`Checklist item ${i + 1} needs a label`);
    const key = item.key !== "" ? item.key : keyFromLabel(label, 40);
    if (label !== "" && !/^[a-z][a-z0-9_]{1,39}$/.test(key)) problems.push(`"${label}" cannot be turned into a key; use letters and digits`);
    if (taken.has(key)) problems.push(`Two checklist items would share the key "${key}"; rename one`);
    taken.add(key);
    return { key, label, enabled: item.enabled, required: item.required };
  });
  if (items.length > 20) problems.push("A checklist has at most 20 items");
  if (problems.length || stale === null) return { ok: false, problems };
  return ok({
    mode: form.mode,
    staleAfterDays: stale,
    gates: {
      payment_threshold: { enabled: pay.enabled, required: pay.required, basis: pay.basis, percent: percent ?? 100, fixedAmount: String(fixed ?? 0n) },
      meter_installed: { ...form.gates.meter_installed },
      initial_reading: { ...form.gates.initial_reading },
    },
    officeChecklist: items,
  });
}

/* ---------- accounts.application (C-05, C-09) ---------- */

export interface ApplicationValue {
  survey: { required: boolean };
  invoice: { required: boolean };
  installation: { required: boolean };
  relocation: { surveyRequired: boolean };
}
/** Each stage is "used" (the value's `required`); an unused stage is waived and skipped. */
export interface ApplicationForm {
  survey: boolean;
  invoice: boolean;
  installation: boolean;
  relocationSurvey: boolean;
}

export const applicationToForm = (v: ApplicationValue): ApplicationForm => ({
  survey: v.survey.required,
  invoice: v.invoice.required,
  installation: v.installation.required,
  relocationSurvey: v.relocation.surveyRequired,
});

export const applicationFromForm = (f: ApplicationForm): ApplicationValue => ({
  survey: { required: f.survey },
  invoice: { required: f.invoice },
  installation: { required: f.installation },
  relocation: { surveyRequired: f.relocationSurvey },
});

/* ---------- accounts.membership (C-07) ---------- */

export interface MembershipValue {
  classes: { key: string; label: string; connectionFeeChargeItemCode?: string | undefined }[];
}
export interface MembershipForm {
  /** `key` is "" for a class added in this form. */
  classes: { key: string; label: string; chargeItemCode: string }[];
}

export const membershipToForm = (v: MembershipValue): MembershipForm => ({ classes: v.classes.map((c) => ({ key: c.key, label: c.label, chargeItemCode: c.connectionFeeChargeItemCode ?? "" })) });

export function membershipFromForm(form: MembershipForm): FormResult<MembershipValue> {
  const problems: string[] = [];
  const seen = new Set<string>();
  const classes = form.classes.map((c, i) => {
    const label = c.label.trim();
    if (label === "") problems.push(`Class ${i + 1} needs a label`);
    const key = c.key !== "" ? c.key : keyFromLabel(label, 30);
    if (label !== "" && !/^[a-z][a-z0-9_]{1,29}$/.test(key)) problems.push(`"${label}" cannot be turned into a key; use letters and digits`);
    if (seen.has(key)) problems.push(`Two classes would share the key "${key}"; rename one`);
    seen.add(key);
    const code = c.chargeItemCode.trim();
    return { key, label, ...(code ? { connectionFeeChargeItemCode: code } : {}) };
  });
  if (classes.length > 30) problems.push("At most 30 classes");
  return problems.length ? { ok: false, problems } : ok({ classes });
}

/* ---------- accounts.data_quality (C-12) ---------- */

export interface DataQualityValue {
  rules: Record<string, { enabled?: boolean | undefined; severity?: DataQualitySeverity | undefined; raiseExceptions?: boolean | undefined } | undefined>;
}
export type DataQualityForm = Record<DataQualityRuleKey, { enabled: boolean; severity: DataQualitySeverity; raiseExceptions: boolean }>;

export const severityLabel: Record<DataQualitySeverity, string> = { info: "Info", warning: "Warning", critical: "Critical" };
export const SEVERITIES = DATA_QUALITY_SEVERITIES;

export function dataQualityToForm(v: DataQualityValue): DataQualityForm {
  const form = {} as DataQualityForm;
  for (const rule of effectiveDataQualityRules(v.rules)) form[rule.key] = { enabled: rule.enabled, severity: rule.severity, raiseExceptions: rule.raiseExceptions };
  return form;
}

/** Writes every catalogue rule explicitly and keeps keys the catalogue no longer knows, as the store does. */
export function dataQualityFromForm(form: DataQualityForm, current: DataQualityValue): DataQualityValue {
  const rules: DataQualityValue["rules"] = { ...current.rules };
  for (const rule of DATA_QUALITY_RULES) rules[rule.key] = { enabled: form[rule.key].enabled, severity: form[rule.key].severity, raiseExceptions: form[rule.key].raiseExceptions };
  return { rules };
}

/* ---------- approvals.<kind> (K-05) ---------- */

export interface ApprovalPolicyValue {
  levels: { label: string; permission: Permission; minAmount?: string | undefined }[];
  slaHours: number;
  escalateTo?: Permission | undefined;
  reasonCodes?: { code: string; label: string }[] | undefined;
}
export interface ApprovalPolicyForm {
  levels: { label: string; permission: string; minAmount: string }[];
  slaHours: string;
  escalateTo: string;
}

export const MAX_APPROVAL_LEVELS = 5;

export function approvalPolicyToForm(v: ApprovalPolicyValue, currency: string): ApprovalPolicyForm {
  return {
    levels: v.levels.map((l) => ({ label: l.label, permission: l.permission, minAmount: l.minAmount ? amountText(minorFromDigits(l.minAmount) ?? 0n, currency) : "" })),
    slaHours: String(v.slaHours),
    escalateTo: v.escalateTo ?? "",
  };
}

/** The policy to store; reason codes the page does not edit are kept as they were. */
export function approvalPolicyFromForm(form: ApprovalPolicyForm, current: ApprovalPolicyValue, currency: string): FormResult<ApprovalPolicyValue> {
  const problems: string[] = [];
  if (form.levels.length > MAX_APPROVAL_LEVELS) problems.push(`At most ${MAX_APPROVAL_LEVELS} levels`);
  const levels = form.levels.map((l, i) => {
    const n = i + 1;
    const label = l.label.trim();
    if (label === "" || label.length > 80) problems.push(`Level ${n} needs a name of up to 80 characters`);
    if (!isPermission(l.permission)) problems.push(`Level ${n}: choose who decides`);
    let minAmount: string | undefined;
    if (l.minAmount.trim() !== "") {
      const minor = parseAmount(l.minAmount, currency, { allowZero: true });
      if (minor === null) problems.push(`Level ${n}: the minimum amount is like 5000.00, or leave it empty`);
      else if (minor > 0n) minAmount = String(minor);
    }
    return { label, permission: l.permission as Permission, ...(minAmount ? { minAmount } : {}) };
  });
  const sla = whole(form.slaHours, 1, 720);
  if (sla === null) problems.push("Hours before a waiting request is escalated: 1 to 720");
  if (form.escalateTo !== "" && !isPermission(form.escalateTo)) problems.push("Choose who may decide an overdue request, or nobody");
  if (problems.length || sla === null) return { ok: false, problems };
  return ok({
    levels,
    slaHours: sla,
    ...(form.escalateTo !== "" ? { escalateTo: form.escalateTo as Permission } : {}),
    ...(current.reasonCodes ? { reasonCodes: current.reasonCodes } : {}),
  });
}

/* ---------- one-line summaries for the version history ---------- */

/** What a stored version says, in a line, so the history shows what changed without opening each. */
export function summarize(key: string, value: unknown): string {
  const v = value as Record<string, unknown>;
  switch (key) {
    case SETTING_KEYS.numbering: {
      const n = value as NumberingValue;
      return `${n.prefix || "no prefix"}, ${n.width} digits from ${n.start}, ${checkDigitLabel[n.checkDigit].split(" (")[0]!.toLowerCase()}`;
    }
    case SETTING_KEYS.statusRules: {
      const rules = value as StatusRulesValue;
      const billing = COMMERCIAL_STATUSES.filter((s) => SERVICE_STATES.some((x) => rules[s][x].billsConsumption));
      return billing.length ? `Consumption billed while ${billing.map((s) => s.toLowerCase().replace("_", " ")).join(", ")}` : "Consumption never billed";
    }
    case SETTING_KEYS.activation: {
      const a = value as ActivationValue;
      return `${a.mode === "auto" ? "Automatic" : "Office checklist"}, stale after ${a.staleAfterDays} days, ${a.officeChecklist.length} office item${a.officeChecklist.length === 1 ? "" : "s"}`;
    }
    case SETTING_KEYS.application: {
      const a = value as ApplicationValue;
      const waived = [!a.survey.required && "survey", !a.invoice.required && "invoice and payment", !a.installation.required && "installation"].filter(Boolean);
      return waived.length ? `Waived: ${waived.join(", ")}` : "Every stage used";
    }
    case SETTING_KEYS.membership: {
      const m = value as MembershipValue;
      return `${m.classes.length} class${m.classes.length === 1 ? "" : "es"}`;
    }
    case SETTING_KEYS.dataQuality: {
      const form = dataQualityToForm(value as DataQualityValue);
      const off = DATA_QUALITY_RULES.filter((r) => !form[r.key].enabled).length;
      const raising = DATA_QUALITY_RULES.filter((r) => form[r.key].enabled && form[r.key].raiseExceptions).length;
      return `${DATA_QUALITY_RULES.length - off} rule${DATA_QUALITY_RULES.length - off === 1 ? "" : "s"} on, ${raising} raising exceptions`;
    }
    case SETTING_KEYS.surveyApproval:
    case SETTING_KEYS.writeOffApproval: {
      const levels = (v.levels as unknown[]) ?? [];
      return levels.length === 0 ? "No approval needed" : `${levels.length} level${levels.length === 1 ? "" : "s"}, escalate after ${String(v.slaHours)} hours`;
    }
    default:
      return "";
  }
}
