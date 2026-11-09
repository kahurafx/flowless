import { INVOICE_APPLIES_TO, OVERDUE_ACTIONS, type InvoiceAppliesTo, type OverdueAction } from "./tariffs";
import { z } from "zod";

/*
 * Invoice type rules (T-08 to T-10), pure: payment terms, the overdue policy and invoice
 * numbers. The database repeats the shape and overdue checks as constraints.
 */

const money = z.bigint().min(1n).max(10n ** 12n);

/** Payment terms (T-09): the whole amount, a minimum deposit before the rest, or installments. */
export const termsSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("full") }),
  z.object({
    kind: z.literal("minimum_deposit"),
    /** The deposit as a share of the total, in basis points (2500 is 25%)... */
    percentBp: z.number().int().min(1).max(10_000).optional(),
    /** ...or as a fixed amount in minor units; give one, not both. */
    amount: money.optional(),
  }),
  z.object({
    kind: z.literal("installments"),
    count: z.number().int().min(2).max(60),
    intervalDays: z.number().int().min(1).max(365),
  }),
]);
export type Terms = z.infer<typeof termsSchema>;

export const overdueSchema = z.object({
  action: z.enum(OVERDUE_ACTIONS),
  /** Days after the due date before the action applies. */
  afterDays: z.number().int().min(0).max(365).default(0),
});
export type OverduePolicy = z.infer<typeof overdueSchema>;

/** The overdue actions an invoice type that bills `appliesTo` may use (T-09). */
export function allowedOverdueActions(appliesTo: InvoiceAppliesTo): readonly OverdueAction[] {
  return appliesTo === "application" ? ["none", "pause_application", "cancel_application"] : ["none", "disconnect"];
}

/** Why these terms and overdue policy do not fit an invoice type, or an empty list. */
export function invoicePolicyProblems(input: { appliesTo: InvoiceAppliesTo; terms: Terms; overdue: OverduePolicy }): string[] {
  const problems: string[] = [];
  if (input.terms.kind === "minimum_deposit" && (input.terms.percentBp === undefined) === (input.terms.amount === undefined)) {
    problems.push("A minimum deposit is either a percentage or a fixed amount, not both and not neither");
  }
  if (!allowedOverdueActions(input.appliesTo).includes(input.overdue.action)) {
    problems.push(
      input.appliesTo === "application" && input.overdue.action === "disconnect"
        ? "An unpaid application invoice pauses or cancels the application; it never disconnects (T-09)"
        : `"${input.overdue.action}" does not fit an invoice for an ${input.appliesTo}`,
    );
  }
  return problems;
}

export const appliesToSchema = z.enum(INVOICE_APPLIES_TO);

export interface NumberFormat {
  prefix: string;
  width: number;
}

/** "INV-" and sequence 42 at width 6 make "INV-000042"; a longer sequence is never truncated. */
export const formatInvoiceNumber = (format: NumberFormat, sequence: number): string => `${format.prefix}${String(sequence).padStart(format.width, "0")}`;

/** The installment amounts of a total: equal parts, the remainder added to the first (so they always sum). */
export function installmentAmounts(total: bigint, count: number): bigint[] {
  const parts = BigInt(count);
  const each = total / parts;
  const rest = total - each * parts;
  return Array.from({ length: count }, (_, i) => (i === 0 ? each + rest : each));
}

/** The deposit due up front under minimum-deposit terms, never more than the total. */
export function minimumDeposit(total: bigint, terms: Extract<Terms, { kind: "minimum_deposit" }>): bigint {
  const wanted = terms.amount ?? (terms.percentBp !== undefined ? (total * BigInt(terms.percentBp) + 5000n) / 10_000n : 0n);
  return wanted > total ? total : wanted;
}
