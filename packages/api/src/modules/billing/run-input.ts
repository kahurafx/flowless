import { periodIndex } from "@flowless/billing-engine";
import { todayIn } from "@flowless/shared-types";

/*
 * Pure: turns Metering's readings of a service point into what the engine needs for one period
 * (B-05, B-06, M-07). No I/O. Billing's job passes the published `ReadingView`s in; only the
 * fields used here are required, so tests build plain objects.
 */

export interface RunReading {
  id: string;
  meterId: string;
  value: number;
  readAt: Date;
  recordedAt?: Date;
  purpose: "routine" | "initial" | "final";
  kind: "actual" | "estimate";
  status: string;
  cleared: boolean;
  rolloverConfirmed: boolean;
  replacesReadingId: string | null;
  dialDigits: number;
}

export interface HistoryFact {
  period: string;
  kind: "actual";
  dial: number;
  units?: number;
  months?: number;
  flags: ("corrected")[];
}

export type CurrentReading =
  | { state: "none" }
  /** A reading exists but is flagged or not yet approved (M-05): the exception queue owns it. */
  | { state: "pending"; readingId: string }
  /** The meter changed but the old meter's final or the new meter's initial reading is missing (M-07). */
  | { state: "unresolved"; reason: string }
  | { state: "ready"; dial: number; rollover: boolean; meterChange?: { oldFinal: number; newInitial: number } };

export const periodOfInstant = (at: Date, timeZone: string): string => todayIn(timeZone, at).slice(0, 7);

const order = (a: RunReading, b: RunReading) => a.readAt.getTime() - b.readAt.getTime() || (a.recordedAt?.getTime() ?? 0) - (b.recordedAt?.getTime() ?? 0);

/** Units between two readings of one meter, counting a confirmed wrap; null when the drop is unexplained. */
function span(prev: RunReading, next: RunReading): number | null {
  if (next.value >= prev.value) return next.value - prev.value;
  return next.rolloverConfirmed ? next.value + 10 ** next.dialDigits - prev.value : null;
}

export function analyseReadings(all: readonly RunReading[], period: string, timeZone: string): { history: HistoryFact[]; current: CurrentReading } {
  const valid = all.filter((r) => r.status === "valid" && r.kind === "actual").sort(order);
  const routine = valid.filter((r) => r.purpose === "routine");
  const p = periodIndex(period);
  const periodOf = (r: RunReading) => periodOfInstant(r.readAt, timeZone);

  // History: cleared routine readings before the period, the latest of each month.
  const byPeriod = new Map<string, RunReading>();
  for (const r of routine) if (r.cleared && periodIndex(periodOf(r)) < p) byPeriod.set(periodOf(r), r);
  const kept = [...byPeriod.values()].sort(order);
  const finalOf = (meterId: string) => [...valid].reverse().find((r) => r.meterId === meterId && r.purpose === "final");
  const initialOf = (meterId: string) => valid.find((r) => r.meterId === meterId && r.purpose === "initial");

  const history: HistoryFact[] = kept.map((r, i) => {
    const base: HistoryFact = { period: periodOf(r), kind: "actual", dial: r.value, flags: r.replacesReadingId ? ["corrected"] : [] };
    const prev = kept[i - 1];
    if (!prev) return base;
    let units: number | null;
    if (prev.meterId === r.meterId) units = span(prev, r);
    else {
      const fin = finalOf(prev.meterId);
      const ini = initialOf(r.meterId);
      units = fin && ini && fin.value >= prev.value && r.value >= ini.value ? fin.value - prev.value + (r.value - ini.value) : null;
    }
    if (units === null) return base;
    return { ...base, units, months: Math.max(1, periodIndex(base.period) - periodIndex(periodOf(prev))) };
  });

  const inPeriod = routine.filter((r) => periodOf(r) === period);
  const last = inPeriod[inPeriod.length - 1];
  if (!last) return { history, current: { state: "none" } };
  if (!last.cleared) return { history, current: { state: "pending", readingId: last.id } };

  const baseline = kept[kept.length - 1];
  if (baseline && baseline.meterId !== last.meterId) {
    const fin = finalOf(baseline.meterId);
    const ini = initialOf(last.meterId);
    if (!fin || !ini) return { history, current: { state: "unresolved", reason: "The meter was changed but the old meter's final reading or the new meter's initial reading is missing" } };
    return { history, current: { state: "ready", dial: last.value, rollover: last.rolloverConfirmed, meterChange: { oldFinal: fin.value, newInitial: ini.value } } };
  }
  return { history, current: { state: "ready", dial: last.value, rollover: last.rolloverConfirmed } };
}
