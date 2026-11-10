import { describe, expect, it } from "vitest";
import { analyseReadings, type RunReading } from "./run-input";

let n = 0;
const r = (date: string, value: number, over: Partial<RunReading> = {}): RunReading => ({
  id: `r${++n}`,
  meterId: "m1",
  value,
  readAt: new Date(`${date}T08:00:00Z`),
  purpose: "routine",
  kind: "actual",
  status: "valid",
  cleared: true,
  rolloverConfirmed: false,
  replacesReadingId: null,
  dialDigits: 4,
  ...over,
});
const TZ = "Africa/Nairobi";

describe("analyseReadings", () => {
  it("derives history spans and the current reading", () => {
    const { history, current } = analyseReadings([r("2024-12-01", 100, { purpose: "initial" }), r("2024-12-31", 105), r("2025-01-31", 115), r("2025-02-27", 130)], "2025-02", TZ);
    expect(history).toEqual([
      { period: "2024-12", kind: "actual", dial: 105, flags: [] },
      { period: "2025-01", kind: "actual", dial: 115, units: 10, months: 1, flags: [] },
    ]);
    expect(current).toEqual({ state: "ready", dial: 130, rollover: false });
  });

  it("says none, pending or ready by the period's newest routine reading", () => {
    expect(analyseReadings([r("2025-01-31", 115)], "2025-02", TZ).current).toEqual({ state: "none" });
    const flagged = r("2025-02-20", 50, { cleared: false });
    expect(analyseReadings([r("2025-01-31", 115), flagged], "2025-02", TZ).current).toEqual({ state: "pending", readingId: flagged.id });
  });

  it("ignores voided readings and estimates", () => {
    const { history } = analyseReadings([r("2025-01-31", 115, { status: "voided" }), r("2025-01-20", 110, { kind: "estimate" })], "2025-02", TZ);
    expect(history).toEqual([]);
  });

  it("counts a confirmed wrap in history units", () => {
    const { history } = analyseReadings([r("2025-01-31", 9990), r("2025-02-28", 10, { rolloverConfirmed: true })], "2025-03", TZ);
    expect(history[1]).toMatchObject({ units: 20, months: 1 });
  });

  it("declares a meter change from the old final and the new initial reading, and refuses without them", () => {
    const old = [r("2025-01-31", 115), r("2025-02-10", 125, { purpose: "final" })];
    const fresh = [r("2025-02-10", 3, { meterId: "m2", purpose: "initial" }), r("2025-02-27", 8, { meterId: "m2" })];
    expect(analyseReadings([...old, ...fresh], "2025-02", TZ).current).toEqual({ state: "ready", dial: 8, rollover: false, meterChange: { oldFinal: 125, newInitial: 3 } });
    expect(analyseReadings([old[0]!, fresh[1]!], "2025-02", TZ).current).toMatchObject({ state: "unresolved" });
  });

  it("adds both spans for history across a meter change", () => {
    const rows = [r("2025-01-31", 115), r("2025-02-10", 125, { purpose: "final" }), r("2025-02-10", 3, { meterId: "m2", purpose: "initial" }), r("2025-02-27", 8, { meterId: "m2" })];
    expect(analyseReadings(rows, "2025-03", TZ).history[1]).toMatchObject({ dial: 8, units: 15, months: 1 });
  });
});
