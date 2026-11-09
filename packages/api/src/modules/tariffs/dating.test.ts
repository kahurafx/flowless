import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { addDays, daysBetween, fromIsoDate, nextPeriodStart, nextPeriodStartIso, planEffectiveDate, todayIn, versionInForce, versionSpans, type Dated } from "./dating";

const v = (effectiveFrom: string, versionNo: number): Dated & { name: string } => ({ effectiveFrom, versionNo, name: `v${versionNo}` });

// T-01, T-03: version i is in force from its start until the next version's start.
describe("versionInForce", () => {
  const versions = [v("2026-01-01", 1), v("2026-07-01", 2), v("2026-10-01", 3)];

  it("picks the latest version that has started, and none before the first", () => {
    expect(versionInForce(versions, "2025-12-31")).toBeNull();
    expect(versionInForce(versions, "2026-01-01")?.versionNo).toBe(1);
    expect(versionInForce(versions, "2026-06-30")?.versionNo).toBe(1);
    expect(versionInForce(versions, "2026-07-01")?.versionNo).toBe(2);
    expect(versionInForce(versions, "2026-09-30")?.versionNo).toBe(2);
    expect(versionInForce(versions, "2026-10-01")?.versionNo).toBe(3);
    expect(versionInForce(versions, "2099-01-01")?.versionNo).toBe(3);
  });

  it("does not depend on the order versions are given in", () => {
    expect(versionInForce([...versions].reverse(), "2026-08-15")?.versionNo).toBe(2);
  });

  it("takes a Date as its UTC calendar day", () => {
    expect(versionInForce(versions, new Date("2026-10-01T00:00:00Z"))?.versionNo).toBe(3);
    expect(versionInForce(versions, new Date("2026-09-30T23:59:59Z"))?.versionNo).toBe(2);
  });

  it("lets a later version replace one that shares its date", () => {
    const replaced = [v("2026-01-01", 1), v("2026-07-01", 2), v("2026-07-01", 3)];
    expect(versionInForce(replaced, "2026-07-01")?.versionNo).toBe(3);
    expect(versionInForce(replaced, "2026-06-30")?.versionNo).toBe(1);
    expect(versionSpans(replaced).map((s) => [s.version.versionNo, s.from, s.until])).toEqual([
      [1, "2026-01-01", "2026-07-01"],
      [2, "2026-07-01", "2026-07-01"],
      [3, "2026-07-01", null],
    ]);
  });
});

describe("versionSpans (versions never overlap)", () => {
  it("ends each version where the next begins", () => {
    expect(versionSpans([v("2026-07-01", 2), v("2026-01-01", 1)]).map((s) => [s.version.versionNo, s.from, s.until])).toEqual([
      [1, "2026-01-01", "2026-07-01"],
      [2, "2026-07-01", null],
    ]);
  });

  it("property: spans are ordered and disjoint, and exactly one covers each day from the first start", () => {
    const dates = fc.array(fc.integer({ min: 0, max: 400 }), { minLength: 1, maxLength: 8 });
    fc.assert(
      fc.property(dates, fc.integer({ min: -30, max: 500 }), (offsets, probe) => {
        const versions = offsets.map((o, i) => v(addDays("2026-01-01", o), i + 1));
        const spans = versionSpans(versions);
        // Ordered: each span ends where the next begins, so none overlaps.
        for (let i = 0; i + 1 < spans.length; i++) if (spans[i]!.until !== spans[i + 1]!.from) return false;
        const day = addDays("2026-01-01", probe);
        const covering = spans.filter((s) => s.from <= day && (s.until === null || day < s.until));
        const inForce = versionInForce(versions, day);
        const first = spans[0]!.from;
        if (day < first) return covering.length === 0 && inForce === null;
        return covering.length === 1 && covering[0]!.version === inForce;
      }),
      { numRuns: 300 },
    );
  });
});

// T-03: the default effective date is the next billing period start.
describe("nextPeriodStart", () => {
  it("is the first of next month by default", () => {
    expect(nextPeriodStartIso("2026-11-09", { periodStartDay: 1 })).toBe("2026-12-01");
    expect(nextPeriodStartIso("2026-11-30", { periodStartDay: 1 })).toBe("2026-12-01");
    expect(nextPeriodStartIso("2026-12-15", { periodStartDay: 1 })).toBe("2027-01-01");
  });

  it("is strictly after the day itself, even on a period start", () => {
    expect(nextPeriodStartIso("2026-11-01", { periodStartDay: 1 })).toBe("2026-12-01");
    expect(nextPeriodStartIso("2026-11-15", { periodStartDay: 15 })).toBe("2026-12-15");
  });

  it("honours another start day", () => {
    expect(nextPeriodStartIso("2026-11-09", { periodStartDay: 15 })).toBe("2026-11-15");
    expect(nextPeriodStartIso("2026-11-16", { periodStartDay: 15 })).toBe("2026-12-15");
    expect(nextPeriodStartIso("2026-02-28", { periodStartDay: 28 })).toBe("2026-03-28");
  });

  it("takes and returns Dates at UTC midnight", () => {
    expect(nextPeriodStart(new Date("2026-11-09T14:30:00Z"), { periodStartDay: 1 })).toEqual(new Date("2026-12-01T00:00:00Z"));
  });

  it("property: always a start day, after the input, within 31 days", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 3000 }), fc.integer({ min: 1, max: 28 }), (offset, periodStartDay) => {
        const from = addDays("2024-01-01", offset);
        const next = nextPeriodStartIso(from, { periodStartDay });
        return next > from && daysBetween(from, next) <= 31 && Number(next.slice(8, 10)) === periodStartDay;
      }),
      { numRuns: 300 },
    );
  });
});

describe("date helpers", () => {
  it("counts days and adds them across month ends", () => {
    expect(addDays("2026-02-27", 2)).toBe("2026-03-01");
    expect(daysBetween("2026-01-01", "2026-03-01")).toBe(59);
    expect(fromIsoDate("2026-11-09").toISOString()).toBe("2026-11-09T00:00:00.000Z");
  });

  it("finds today's date in the organization's time zone", () => {
    const instant = new Date("2026-11-09T22:30:00Z");
    expect(todayIn("Africa/Nairobi", instant)).toBe("2026-11-10");
    expect(todayIn("UTC", instant)).toBe("2026-11-09");
  });
});

describe("planEffectiveDate", () => {
  const base = { today: "2026-11-09", policy: { periodStartDay: 1 }, closedThrough: null, existing: [] as string[] };

  it("defaults to the next period start, and to today for a first version", () => {
    expect(planEffectiveDate(base)).toEqual({ ok: true, effectiveFrom: "2026-12-01", defaulted: true });
    expect(planEffectiveDate({ ...base, first: true })).toEqual({ ok: true, effectiveFrom: "2026-11-09", defaulted: true });
  });

  it("takes a requested date, including one in the past that is not closed", () => {
    expect(planEffectiveDate({ ...base, requested: "2026-10-01" })).toEqual({ ok: true, effectiveFrom: "2026-10-01", defaulted: false });
  });

  it("blocks dates on or before the last closed period, not the day after", () => {
    const closed = { ...base, closedThrough: "2026-10-31" };
    expect(planEffectiveDate({ ...closed, requested: "2026-10-31" })).toMatchObject({ ok: false, reason: "closed_period" });
    expect(planEffectiveDate({ ...closed, requested: "2026-09-01" })).toMatchObject({ ok: false, reason: "closed_period" });
    expect(planEffectiveDate({ ...closed, requested: "2026-11-01" })).toMatchObject({ ok: true });
    // The default can itself be closed when a source says so.
    expect(planEffectiveDate({ ...closed, closedThrough: "2026-12-31" })).toMatchObject({ ok: false, reason: "closed_period" });
  });

  it("refuses a date that already has a version once it has arrived, and lets a future one be replaced", () => {
    expect(planEffectiveDate({ ...base, requested: "2026-10-01", existing: ["2026-10-01"] })).toMatchObject({ ok: false, reason: "already_in_force" });
    expect(planEffectiveDate({ ...base, requested: "2026-11-09", existing: ["2026-11-09"] })).toMatchObject({ ok: false, reason: "already_in_force" });
    expect(planEffectiveDate({ ...base, requested: "2026-12-01", existing: ["2026-12-01"] })).toMatchObject({ ok: true });
  });
});
