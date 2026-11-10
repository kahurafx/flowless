import { periodIndex } from "./period";
import type { Account } from "./types";

/**
 * Units to estimate for period index `p` (B-05, B-06): the median of the last `avgN` actual spans,
 * each normalised to units a month. Flagged (baseline_gap, corrected, disputed) and voided readings are
 * skipped. Without usable history: the policy fallback, or null (the caller holds the bill, I-6).
 * Units are consumption, not money, so the arithmetic here is plain numbers.
 */
export function estimateUnits(a: Account, p: number): number | null {
  const perMonth = a.readings
    .filter(
      (r) =>
        r.kind === "actual" && !r.voided && r.units != null && r.months != null && r.flags.length === 0 && periodIndex(r.period) < p,
    )
    .sort((x, y) => periodIndex(y.period) - periodIndex(x.period))
    .slice(0, a.policy.avgN)
    .map((r) => (r.units as number) / (r.months as number));
  if (!perMonth.length) return a.policy.fallback;
  perMonth.sort((x, y) => x - y);
  const m = perMonth.length >> 1;
  return Math.round(perMonth.length % 2 ? (perMonth[m] as number) : ((perMonth[m - 1] as number) + (perMonth[m] as number)) / 2);
}
