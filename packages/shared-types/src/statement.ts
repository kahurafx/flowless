import { money, type CurrencyCode, type Money } from "./money";

/** Typed statement lines (B-17). */
export type StatementLineType = "invoice" | "payment" | "adjustment" | "credit_note" | "transfer";

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
