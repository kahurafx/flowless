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
