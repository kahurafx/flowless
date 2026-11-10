import { sum } from "./money";
import type { Period } from "./period";
import type { TariffVersion } from "./tariff";
import type { BillException, Line } from "./types";

export interface ValidationInput {
  period: Period;
  lines: readonly Line[];
  total: bigint;
  /** True for an estimate: volumetric checks do not apply. */
  estimate: boolean;
  /** Units consumed over the span (actual bills). */
  units: number;
  months: number;
  tariff: TariffVersion;
  ceiling: number;
}

/** B-08 bill validators. Returns the first failure, which the caller holds as an exception, or null. */
export function validateBill(v: ValidationInput): BillException | null {
  const fail = (code: BillException["code"], message: string): BillException => ({ code, message, period: v.period });
  if (!v.estimate && v.units > 0 && !v.lines.some((l) => l.code === "USAGE" && l.amount > 0n)) {
    return fail("ZERO_CHARGE", "Consumption but no usage charge; held");
  }
  if (!v.estimate && v.units / v.months > v.ceiling) {
    return fail("OUTLIER_HOLD", `${Math.round(v.units / v.months)} units a month exceeds the ceiling; held for approval`);
  }
  if (v.tariff.standing > 0n && !v.lines.some((l) => l.code === "STANDING")) {
    return fail("NO_STANDING", "Standing charge missing; held");
  }
  if (sum(v.lines, (l) => l.amount) !== v.total) {
    return fail("LINES_NOT_SUMMING", "Lines do not sum to the total; held");
  }
  return null;
}

export interface FlagInput {
  period: Period;
  lines: readonly Line[];
  estimate: boolean;
  /** Units consumed over the span (actual bills). */
  units: number;
  months: number;
  /** Units a month of the usable history, newest first (B-06). */
  history: readonly number[];
  /** Flag above this multiple of the history median; 0 or less turns the check off. */
  outlierFactor: number;
}

/**
 * B-08 findings that flag a bill without holding it, consistent with the zero-consumption "bill and flag"
 * rule (M-10, B-10): zero consumption, a standing-only bill, and an outlier against the account's history.
 * The absolute ceiling is a hold and lives in `validateBill`.
 */
export function flagBill(v: FlagInput): BillException[] {
  const flag = (code: BillException["code"], message: string): BillException => ({ code, message, period: v.period });
  const flags: BillException[] = [];
  const usage = v.lines.some((l) => (l.code === "USAGE" || l.code === "USAGE_EST") && l.amount !== 0n);
  if (!v.estimate && v.units === 0) flags.push(flag("ZERO_CONSUMPTION", "Zero consumption over the span; billed and flagged"));
  if (!usage && v.lines.length > 0 && v.lines.every((l) => l.code === "STANDING" || l.code === "TURN_OFF" || l.amount === 0n)) {
    flags.push(flag("STANDING_ONLY", "Standing charge only, no usage charged; billed and flagged"));
  }
  if (!v.estimate && v.outlierFactor > 0 && v.history.length >= 2) {
    const s = [...v.history].sort((x, y) => x - y);
    const m = s.length >> 1;
    const med = s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
    const perMonth = v.units / v.months;
    if (med > 0 && perMonth > med * v.outlierFactor) {
      flags.push(flag("OUTLIER_HISTORY", `${Math.round(perMonth)} units a month against a usual ${Math.round(med)}; billed and flagged`));
    }
  }
  return flags;
}
