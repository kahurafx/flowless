import { money, type CurrencyCode, type Money } from "./money";

/** Typed statement lines (B-17). */
export const STATEMENT_LINE_TYPES = ["invoice", "payment", "adjustment", "credit_note", "debit_note", "transfer", "reversal", "correction"] as const;
export type StatementLineType = (typeof STATEMENT_LINE_TYPES)[number];

/**
 * The type of one statement row (B-17) from the ledger transaction's entry type and, when it
 * posted a document, the document's kind. A credit or debit note that corrects a bill after the
 * fact (B-13, B-14) is a `correction`. Payments, transfers and reversals come from the entry type;
 * write-offs, credits and the rest of the entry types without a document read as `adjustment`.
 */
export function statementLineType(input: { entryType: string; documentKind: string | null; correction?: boolean }): StatementLineType {
  if (input.entryType === "reversal" || input.documentKind === "reversal") return "reversal";
  if (input.documentKind === "credit_note" || input.documentKind === "debit_note") {
    return input.correction ? "correction" : input.documentKind;
  }
  if (input.documentKind === "invoice") return "invoice";
  if (input.entryType === "payment") return "payment";
  if (input.entryType === "transfer") return "transfer";
  if (input.entryType === "charge" || input.entryType === "deposit") return "invoice";
  return "adjustment";
}

/** What a statement row needs to be paired with the row it offsets (B-17). */
export interface PairableRow {
  /** The row's own key: its document id, or its transaction id when it has no document. */
  key: string;
  /** Signed amount: debit positive. */
  amount: bigint;
  /** The key of the row this one offsets (a reversal's original, a note's cited invoice), if any. */
  linkedTo: string | null;
}

export interface PairMark {
  /** The original row's key; shared by the original and everything that offsets it. */
  pairId: string;
  role: "original" | "offset";
  /** The pair nets to zero, so a customer view may collapse it. */
  settled: boolean;
}

/**
 * Linked pairs of a statement (B-17): an original row and the rows that offset it (its
 * reversal, a credit note) form a pair, marked so the office view can show all. A pair is
 * `settled` when the group nets to zero (a voided invoice and its reversal, an invoice and a
 * full credit note); only settled pairs are collapsed for the customer. A partial credit
 * note does not net to zero, so both rows stay. A re-bill's replacement is its own row and
 * stays visible.
 */
export function pairMarks(rows: readonly PairableRow[]): Map<string, PairMark> {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const groups = new Map<string, PairableRow[]>();
  for (const r of rows) {
    if (!r.linkedTo || r.linkedTo === r.key || !byKey.has(r.linkedTo)) continue;
    const list = groups.get(r.linkedTo) ?? [];
    list.push(r);
    groups.set(r.linkedTo, list);
  }
  const marks = new Map<string, PairMark>();
  for (const [original, offsets] of groups) {
    const net = byKey.get(original)!.amount + offsets.reduce((s, r) => s + r.amount, 0n);
    const settled = net === 0n;
    marks.set(original, { pairId: original, role: "original", settled });
    for (const o of offsets) marks.set(o.key, { pairId: original, role: "offset", settled });
  }
  return marks;
}

/**
 * The customer's view of a statement (B-17): rows of settled pairs are collapsed away, the rest
 * stay in order. The running balance on the remaining rows is unchanged, because a settled
 * pair nets to zero. The office view is simply all the rows.
 */
export function collapsePairs<T extends PairableRow>(rows: readonly T[]): T[] {
  const marks = pairMarks(rows);
  return rows.filter((r) => !marks.get(r.key)?.settled);
}

export interface StatementLine {
  id: string;
  postedAt: Date;
  type: StatementLineType;
  /** Document number: invoice, receipt, credit note. */
  reference: string;
  description: string;
  /** Signed: positive is a debit (the customer owes more), negative a credit. */
  amount: Money;
  /** The other half of a linked pair (re-bill void + replacement, transfer), if any. */
  linkedLineId?: string;
}

export interface StatementRow extends StatementLine {
  /** Derived from the lines above it, never stored (B-17, I-2). */
  runningBalance: Money;
}

/** Orders lines by posting time and derives the running balance. */
export function buildStatement(
  currency: CurrencyCode,
  opening: bigint,
  lines: readonly StatementLine[],
): StatementRow[] {
  let balance = opening;
  return [...lines]
    .sort((a, b) => a.postedAt.getTime() - b.postedAt.getTime())
    .map((line) => {
      if (line.amount.currency !== currency) {
        throw new Error(`Statement in ${currency} cannot hold a ${line.amount.currency} line`);
      }
      balance += line.amount.amountMinor;
      return { ...line, runningBalance: money(balance, currency) };
    });
}
