import type { Minor } from "./money";
import { roundDiv } from "./money";
import { periodIndex, type Period } from "./period";

/** One band of a monthly block tariff. `upTo: null` is the open top band. `rate` is minor units per unit. */
export interface Band {
  upTo: number | null;
  rate: Minor;
}

/** A tariff version (T-01, T-04): in force from `from` (a period) until the next version starts. */
export interface TariffVersion {
  id: string;
  from: Period;
  standing: Minor;
  bands: readonly Band[];
}

/** T-05: `by_period` multiplies the monthly bands by the months in the span; `none` is the legacy single month. */
export type TierScaling = "by_period" | "none";

export function tariffAt(tariffs: readonly TariffVersion[], period: Period | number): TariffVersion | undefined {
  const i = typeof period === "number" ? period : periodIndex(period);
  let found: TariffVersion | undefined;
  let foundAt = -Infinity;
  for (const t of tariffs) {
    const f = periodIndex(t.from);
    if (f <= i && f >= foundAt) {
      found = t;
      foundAt = f;
    }
  }
  return found;
}

/**
 * Exact numerator of the block charge for `units` over `months` months, to be divided by `months`:
 * the bands are stretched by `months` instead of dividing the units, so nothing is rounded here.
 */
function bandNumerator(units: number, months: number, bands: readonly Band[]): bigint {
  const u = BigInt(units);
  const n = BigInt(months);
  let prev = 0n;
  let s = 0n;
  for (const b of bands) {
    const up = b.upTo === null ? null : BigInt(b.upTo) * n;
    const top = up === null || u < up ? u : up;
    const k = top - prev;
    if (k > 0n) s += k * b.rate;
    if (up === null || u <= up) break;
    prev = up;
  }
  return s;
}

/** Charge of `units` in one month: exact, a one month span has denominator 1. */
export function monthCharge(units: number, tariff: TariffVersion): Minor {
  return bandNumerator(units, 1, tariff.bands);
}

/**
 * Charge for a span of `to - from` months (periods `from+1 .. to`), rounded once.
 * by_period: each sub-period priced on its own tariff version with the units spread evenly;
 * none: the legacy rule, the whole of `units` as one month at the tariff in force at `to`.
 * Returns undefined when a needed tariff version is missing.
 */
export function spanCharge(
  units: number,
  from: number,
  to: number,
  tariffs: readonly TariffVersion[],
  scaling: TierScaling,
): { amount: Minor; versions: string[] } | undefined {
  const n = to - from;
  if (n < 1) throw new RangeError("spanCharge: the span must cover at least one month");
  if (scaling === "none") {
    const t = tariffAt(tariffs, to);
    return t && { amount: monthCharge(units, t), versions: [t.id] };
  }
  let num = 0n;
  const versions: string[] = [];
  for (let i = from + 1; i <= to; i++) {
    const t = tariffAt(tariffs, i);
    if (!t) return undefined;
    num += bandNumerator(units, n, t.bands);
    if (!versions.includes(t.id)) versions.push(t.id);
  }
  return { amount: roundDiv(num, BigInt(n)), versions };
}
