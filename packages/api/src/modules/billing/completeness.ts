import type { CycleOutcomeKind } from "@flowless/db/schema/billing";

/*
 * B-04 completeness, pure: every account the cycle expected has a terminal outcome, with a
 * reason where one is required (exception and excluded) and, for an exception, the link to
 * the kernel exception. `completenessRows` in `cycles.ts` supplies the rows; the database
 * function `billing.cycle_unexplained` refuses the close event with the same rule.
 */

export interface CompletenessRow {
  accountId: string;
  /** Null: no outcome yet. */
  outcome: CycleOutcomeKind | null;
  reason: string | null;
  exceptionId: string | null;
}

export interface Completeness {
  complete: boolean;
  expected: number;
  explained: number;
  unexplained: number;
  byOutcome: Record<CycleOutcomeKind, number>;
  /** Up to `exampleLimit` unexplained accounts with why. */
  examples: { accountId: string; problem: string }[];
}

export function problemOf(row: CompletenessRow): string | null {
  if (row.outcome === null) return "no outcome";
  if ((row.outcome === "exception" || row.outcome === "excluded") && !(row.reason ?? "").trim()) return `${row.outcome} without a reason`;
  if (row.outcome === "exception" && !row.exceptionId) return "exception not linked to the exceptions queue";
  return null;
}

export function completenessOf(rows: readonly CompletenessRow[], exampleLimit = 10): Completeness {
  const byOutcome: Record<CycleOutcomeKind, number> = { billed: 0, billed_estimate: 0, exception: 0, excluded: 0 };
  const examples: Completeness["examples"] = [];
  let unexplained = 0;
  for (const row of rows) {
    const problem = problemOf(row);
    if (row.outcome) byOutcome[row.outcome] += 1;
    if (problem) {
      unexplained += 1;
      if (examples.length < exampleLimit) examples.push({ accountId: row.accountId, problem });
    }
  }
  return { complete: unexplained === 0, expected: rows.length, explained: rows.length - unexplained, unexplained, byOutcome, examples };
}

/** The message a refused close carries (counts and a few examples). */
export function incompleteMessage(c: Completeness): string {
  const shown = c.examples.map((e) => `${e.accountId} (${e.problem})`).join("; ");
  return `Cannot close: ${c.unexplained} of ${c.expected} expected accounts are unexplained (${c.explained} explained). First: ${shown}`;
}
