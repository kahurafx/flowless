import { z } from "zod";
import { defineSetting } from "../../kernel/config-store";

/*
 * Who may post a correction and what it needs (B-14), and its plain-language text (B-13).
 * Pure: no I/O, table tested. Configuration per organization (`billing.corrections`).
 */

export const correctionSettingsSchema = z.object({
  /** Approval-free corrections by a clerk-level user are allowed until the grace window ends. */
  graceWindow: z
    .object({
      /** `invoice_due_date` (default): the original invoice's due date. `days_after_issue`: its issue date plus `days`. */
      basis: z.enum(["invoice_due_date", "days_after_issue"]).default("invoice_due_date"),
      /** Also the fallback when the invoice has no due date. */
      days: z.number().int().min(0).max(730).default(30),
    })
    .default({ basis: "invoice_due_date", days: 30 }),
  /** A correction this large needs evidence (a file or a note). 0 turns a limit off. */
  largeDeviation: z
    .object({
      /** Percent of the original invoice's total. */
      percent: z.number().min(0).max(10000).default(50),
      /** Minor units, as digits. */
      amount: z.string().regex(/^\d+$/, "Amounts are whole minor units").default("0"),
    })
    .default({ percent: 50, amount: "0" }),
  /** B-13: customer-facing text. Placeholders: {original_number} {period} {amount} {direction} {from} {to} {units}. */
  creditTemplate: z.string().trim().min(1).max(500).default("Correction to your bill {original_number} for {period}: after a reading was corrected, {amount} is credited for {from} to {to}."),
  debitTemplate: z.string().trim().min(1).max(500).default("Correction to your bill {original_number} for {period}: after a reading was corrected, {amount} is added for {from} to {to}."),
});
export type CorrectionSettings = z.infer<typeof correctionSettingsSchema>;

export const correctionSettings = defineSetting({
  key: "billing.corrections",
  module: "billing",
  label: "Billing corrections",
  description: "Grace window for approval-free corrections, when evidence is needed, and the customer-facing wording (B-13, B-14).",
  schema: correctionSettingsSchema,
  default: correctionSettingsSchema.parse({}),
});

const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** The last day of the grace window for an invoice; null when there is no original document. */
export function graceEnd(original: { issuedOn: string; dueOn: string | null } | null, grace: CorrectionSettings["graceWindow"]): string | null {
  if (!original) return null;
  if (grace.basis === "invoice_due_date" && original.dueOn) return original.dueOn;
  return addDays(original.issuedOn, grace.days);
}

const abs = (n: bigint) => (n < 0n ? -n : n);

export interface PathInput {
  /** Today in the organization's time zone, YYYY-MM-DD. */
  today: string;
  graceEnd: string | null;
  /** The correction's signed total. */
  total: bigint;
  /** The original invoice's signed total, null when none. */
  originalTotal: bigint | null;
  largeDeviation: CorrectionSettings["largeDeviation"];
  /** A file id or a note was given. */
  evidence: boolean;
}

export interface PathDecision {
  /** `clerk`: billing:run posts it. `approval`: needs an approved K-05 request (billing:approve). */
  route: "clerk" | "approval";
  withinGrace: boolean;
  large: boolean;
  needsEvidence: boolean;
  /** Why the route is what it is, for the screen. */
  reasons: string[];
}

/** Is the correction large against the original invoice (percent) or in itself (amount)? */
export function isLargeDeviation(total: bigint, originalTotal: bigint | null, limit: CorrectionSettings["largeDeviation"]): boolean {
  const size = abs(total);
  if (size === 0n) return false;
  const amountLimit = BigInt(limit.amount);
  if (amountLimit > 0n && size >= amountLimit) return true;
  if (limit.percent <= 0) return false;
  if (originalTotal === null || originalTotal === 0n) return true;
  // size / |original| > percent / 100, in integers (percent in hundredths).
  return size * 10_000n > abs(originalTotal) * BigInt(Math.round(limit.percent * 100));
}

export function correctionPath(i: PathInput): PathDecision {
  const withinGrace = i.graceEnd !== null && i.today <= i.graceEnd;
  const large = isLargeDeviation(i.total, i.originalTotal, i.largeDeviation);
  const reasons: string[] = [];
  reasons.push(withinGrace ? `Within the grace window (until ${i.graceEnd})` : i.graceEnd ? `The grace window ended on ${i.graceEnd}` : "There is no original invoice, so no grace window applies");
  if (large) reasons.push("A large deviation: evidence is required");
  return { route: withinGrace ? "clerk" : "approval", withinGrace, large, needsEvidence: large && !i.evidence, reasons };
}

/** Fills `{name}` placeholders; an unknown one is left as written. */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([a-z_]+)\}/g, (whole, key: string) => vars[key] ?? whole);
}

/** 123456n, "KES" -> "KES 1,234.56" (two minor digits, as the platform stores money). */
export function formatMinor(amount: bigint, currency: string): string {
  const a = abs(amount);
  const whole = (a / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${currency} ${whole}.${(a % 100n).toString().padStart(2, "0")}`;
}
