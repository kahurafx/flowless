import { sum } from "./money";
import { periodIndex } from "./period";
import { CONSUMPTION_CODES, type Account, type Doc, type Line, type Policy, type Reading } from "./types";

export function newAccount(o: { status?: string; digits?: number; policy?: Partial<Policy> } = {}): Account {
  return {
    status: o.status ?? "ACTIVE",
    digits: o.digits ?? 4,
    policy: { scaling: "by_period", avgN: 3, fallback: null, ceiling: 300, ...o.policy },
    readings: [],
    docs: [],
    exceptions: [],
    keys: [],
    seq: 0,
  };
}

/** Documents that count: not voided, not a reversal, not a payment. */
export function liveDocs(a: Account): Doc[] {
  return a.docs.filter((d) => !d.voided && d.type !== "reversal" && d.type !== "payment");
}

/** I-2: the balance is always derived from the documents, never stored. */
export function balance(a: Account): bigint {
  return sum(a.docs, (d) => d.total);
}

/** Consumption lines (usage, estimates, true-up, corrections) of live documents for periods lo < p <= hi. */
export function billedConsumption(a: Account, lo: number, hi: number): Line[] {
  return liveDocs(a)
    .filter((d) => periodIndex(d.period) > lo && periodIndex(d.period) <= hi)
    .flatMap((d) => d.lines)
    .filter((l) => CONSUMPTION_CODES.includes(l.code));
}

/** All consumption charged on live documents. */
export function totalConsumption(a: Account): bigint {
  return sum(
    liveDocs(a).flatMap((d) => d.lines).filter((l) => CONSUMPTION_CODES.includes(l.code)),
    (l) => l.amount,
  );
}

/** The latest trusted actual reading before period index `p` (I-5: an estimate is never a baseline). */
export function lastActual(a: Account, p: number): Reading | undefined {
  let best: Reading | undefined;
  for (const r of a.readings) {
    if (r.kind !== "actual" || r.voided || periodIndex(r.period) >= p) continue;
    if (!best || periodIndex(r.period) > periodIndex(best.period)) best = r;
  }
  return best;
}
