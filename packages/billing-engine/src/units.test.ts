import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { estimateUnits, monthCharge, newAccount, roundDiv, spanCharge, validateBill, assertWhole, periodIndex } from "./index";
import { P, Sim, TARIFFS } from "./test-fixtures";

describe("roundDiv", () => {
  it("rounds half away from zero, once", () => {
    expect(roundDiv(5n, 2n)).toBe(3n);
    expect(roundDiv(-5n, 2n)).toBe(-3n);
    expect(roundDiv(4n, 3n)).toBe(1n);
    expect(roundDiv(-4n, 3n)).toBe(-1n);
    expect(roundDiv(0n, 7n)).toBe(0n);
  });
  it("is within half a unit of the true quotient", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n }), fc.bigInt({ min: 1n, max: 1000n }), (n, d) => {
        const q = roundDiv(n, d);
        expect(2n * (n - q * d) <= d && 2n * (q * d - n) <= d).toBe(true);
      }),
    );
  });
  it("rejects a non-positive denominator", () => expect(() => roundDiv(1n, 0n)).toThrow(RangeError));
});

describe("tariff pricing", () => {
  const t = TARIFFS[0]!;
  it("prices the band edges", () => {
    expect(monthCharge(0, t)).toBe(0n);
    expect(monthCharge(6, t)).toBe(49500n);
    expect(monthCharge(7, t)).toBe(49500n + 9600n);
    expect(monthCharge(300, t)).toBe(monthCharge(100, t) + 200n * 17250n);
  });
  it("a one month span equals the month charge", () => {
    expect(spanCharge(20, P("2026-01"), P("2026-02"), TARIFFS, "by_period")!.amount).toBe(monthCharge(20, t));
  });
  it("by_period stretches the bands by the months in the span (60 units over 3 months = 3 x 20)", () => {
    expect(spanCharge(60, P("2026-01"), P("2026-04"), TARIFFS, "by_period")!.amount).toBe(3n * monthCharge(20, t));
  });
  it("by_period rounds once on the exact total, not per month", () => {
    // 1 unit over 3 months is 1/3 unit a month at 8250: 3 x 2750 exactly, no fractional-month drift
    expect(spanCharge(1, P("2026-01"), P("2026-04"), TARIFFS, "by_period")!.amount).toBe(8250n);
    expect(spanCharge(2, P("2026-01"), P("2026-04"), TARIFFS, "by_period")!.amount).toBe(16500n);
  });
  it("none prices all units as one month at the tariff at the end of the span", () => {
    expect(spanCharge(60, P("2026-01"), P("2026-04"), TARIFFS, "none")!.amount).toBe(monthCharge(60, t));
  });
  it("returns undefined when a tariff is missing", () => {
    expect(spanCharge(5, P("1999-01"), P("1999-03"), TARIFFS, "by_period")).toBeUndefined();
  });
  it("rejects an empty span and a bad period", () => {
    expect(() => spanCharge(1, 5, 5, TARIFFS, "by_period")).toThrow(RangeError);
    expect(() => periodIndex("2026-13")).toThrow(RangeError);
  });
  it("units must be whole numbers", () => {
    expect(() => assertWhole(1.5, "units")).toThrow(RangeError);
    const s = new Sim();
    expect(() => s.bill("2026-01", { dial: 1.5 })).toThrow(RangeError);
  });
});

describe("estimate", () => {
  it("is the median of the last N actual spans normalised to units a month (B-05, B-06)", () => {
    const s = new Sim();
    s.bill("2026-01", { dial: 0 });
    s.bill("2026-02", { dial: 10 });
    s.bill("2026-03", { dial: 40 }); // 30
    s.bill("2026-04", { dial: 50 }); // 10
    expect(estimateUnits(s.a, P("2026-05"))).toBe(10);
  });
  it("normalises a multi-month span to units a month", () => {
    const s = new Sim();
    s.bill("2026-01", { dial: 0 });
    s.bill("2026-04", { dial: 30 });
    expect(estimateUnits(s.a, P("2026-05"))).toBe(10);
  });
  it("skips corrected readings (B-06)", () => {
    const s = new Sim({ fallback: 99 });
    s.bill("2026-01", { dial: 0 });
    s.bill("2026-02", { dial: 10 });
    s.correct("2026-02");
    expect(estimateUnits(s.a, P("2026-03"))).toBe(99);
  });
  it("uses the fallback, then null, when there is no history", () => {
    expect(estimateUnits(newAccount({ policy: { fallback: 4 } }), 100)).toBe(4);
    expect(estimateUnits(newAccount(), 100)).toBeNull();
  });
});

describe("validators (B-08)", () => {
  const t = TARIFFS[0]!;
  const base = { period: "2026-02", estimate: false, units: 5, months: 1, tariff: t, ceiling: 300 };
  const usage = { code: "USAGE" as const, description: "", amount: 100n, serviceFrom: "2026-02", serviceTo: "2026-02", units: 5, tariffVersions: ["T1"] };
  const standing = { ...usage, code: "STANDING" as const, amount: 15000n, units: 0 };
  it("passes a clean bill", () => expect(validateBill({ ...base, lines: [usage, standing], total: 15100n })).toBeNull());
  it("consumption but no volumetric charge", () =>
    expect(validateBill({ ...base, lines: [{ ...usage, amount: 0n }, standing], total: 15000n })?.code).toBe("ZERO_CHARGE"));
  it("missing standing charge", () => expect(validateBill({ ...base, lines: [usage], total: 100n })?.code).toBe("NO_STANDING"));
  it("outlier versus the absolute ceiling", () =>
    expect(validateBill({ ...base, units: 301, lines: [usage, standing], total: 15100n })?.code).toBe("OUTLIER_HOLD"));
  it("lines not summing to the total", () =>
    expect(validateBill({ ...base, lines: [usage, standing], total: 1n })?.code).toBe("LINES_NOT_SUMMING"));
  it("an estimate skips the volumetric checks", () =>
    expect(validateBill({ ...base, estimate: true, units: 5000, lines: [usage, standing], total: 15100n })).toBeNull());
  it("holds an outlier reading in the engine and records the exception", () => {
    const s = new Sim();
    s.bill("2026-01", { dial: 0 });
    expect(s.held("2026-02", { dial: 301 })).toBe("OUTLIER_HOLD");
    expect(s.a.exceptions).toHaveLength(1);
    expect(s.a.docs).toHaveLength(0);
  });
  it("holds a duplicate period", () => {
    const s = new Sim();
    s.bill("2026-01", { dial: 0 });
    s.doc("2026-02", { dial: 5 });
    expect(s.held("2026-02", { dial: 6 })).toBe("DUPLICATE_PERIOD");
  });
});
