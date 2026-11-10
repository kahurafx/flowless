import { periodFromIndex, periodIndex } from "./period";
import type { Account, Reading } from "./types";

/**
 * Usable actual spans before period index `p`, newest first (B-06): flagged (baseline_gap, corrected,
 * disputed), voided and estimate readings are skipped. Each span is normalised to units a month.
 */
export function usableSpans(a: Account, p: number): { reading: Reading; perMonth: number }[] {
  return a.readings
    .filter(
      (r) =>
        r.kind === "actual" &&
        !r.voided &&
        r.units != null &&
        r.months != null &&
        r.months > 0 &&
        r.flags.length === 0 &&
        periodIndex(r.period) < p,
    )
    .sort((x, y) => periodIndex(y.period) - periodIndex(x.period))
    .map((r) => ({ reading: r, perMonth: (r.units as number) / (r.months as number) }));
}

/** Units a month of the last `avgN` usable spans, newest first (the B-08 outlier check uses it too). */
export function usageHistory(a: Account, p: number): number[] {
  return usableSpans(a, p)
    .slice(0, a.policy.avgN)
    .map((s) => s.perMonth);
}

const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

/** Mean after dropping a `trim` fraction from each end; at least one value is kept. */
const trimmedMean = (xs: readonly number[], trim: number): number => {
  const s = [...xs].sort((x, y) => x - y);
  const k = Math.min(Math.floor(s.length * trim), (s.length - 1) >> 1);
  const kept = s.slice(k, s.length - k);
  return kept.reduce((t, x) => t + x, 0) / kept.length;
};

/**
 * Units to estimate for period index `p` (B-05, B-06), by the policy method: median or trimmed mean of the
 * last `avgN` usable spans, the same month last year, the last actual, or a fixed minimum. Every span is
 * units a month. Without usable history: the policy baseline (`fallback`), or null (the caller holds the
 * bill, I-6). Method `none` never estimates: the engine applies `noneAction` instead and this returns null.
 * Units are consumption, not money, so the arithmetic here is plain numbers.
 */
export function estimateUnits(a: Account, p: number): number | null {
  const { method = "median", trim = 0.2, fixedMinimum = null } = a.policy;
  if (method === "none") return null;
  if (method === "fixed_minimum") return fixedMinimum ?? a.policy.fallback;
  const spans = usableSpans(a, p);
  if (!spans.length) return a.policy.fallback;
  const recent = spans.slice(0, a.policy.avgN).map((s) => s.perMonth);
  switch (method) {
    case "trimmed_mean":
      return Math.round(trimmedMean(recent, trim));
    case "last_actual":
      return Math.round((spans[0] as { perMonth: number }).perMonth);
    case "same_month_last_year": {
      const target = periodFromIndex(p - 12);
      const hit = spans.find((s) => s.reading.period === target);
      // No span ends in that month last year: fall back to the median, never to nothing.
      return Math.round(hit ? hit.perMonth : median(recent));
    }
    default:
      return Math.round(median(recent));
  }
}
