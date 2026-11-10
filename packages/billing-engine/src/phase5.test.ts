import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_OUTCOME_MAPPING,
  READING_OUTCOMES,
  billReading,
  dispositionFor,
  estimateUnits,
  finalBill,
  flagBill,
  liveDocs,
  newAccount,
  reconnect,
  type Policy,
  type Reading,
  type ReadingFlag,
  type Result,
} from "./index";
import { P, Sim, TARIFFS } from "./test-fixtures";

/** A Sim with actual readings 5, 6, 10, 20, 100 units over 2026-02..06 (dial 0 at 2026-01). */
const history = (policy: Partial<Policy>): Sim => {
  const s = new Sim({ avgN: 5, ...policy });
  s.bill("2026-01", { dial: 0 });
  [5, 11, 21, 41, 141].forEach((dial, i) => s.doc(`2026-0${i + 2}`, { dial }));
  return s;
};

describe("B-05 estimation methods", () => {
  const next = P("2026-07");
  it("median is the default", () => expect(estimateUnits(history({}).a, next)).toBe(10));
  it("trimmed mean drops the extremes from each end", () => {
    expect(estimateUnits(history({ method: "trimmed_mean", trim: 0.2 }).a, next)).toBe(12);
  });
  it("trimmed mean keeps at least one value", () => {
    expect(estimateUnits(history({ method: "trimmed_mean", trim: 0.9 }).a, next)).toBe(10);
  });
  it("last actual is the newest usable span", () => expect(estimateUnits(history({ method: "last_actual" }).a, next)).toBe(100));
  it("fixed minimum is the configured units, whatever the history", () => {
    expect(estimateUnits(history({ method: "fixed_minimum", fixedMinimum: 7 }).a, next)).toBe(7);
  });
  it("none never estimates", () => expect(estimateUnits(history({ method: "none" }).a, next)).toBeNull());
  it("same month last year uses the span that ended that month, as units a month", () => {
    const s = new Sim({ method: "same_month_last_year", avgN: 3 });
    s.bill("2025-07", { dial: 0 });
    s.doc("2025-08", { dial: 3 });
    s.doc("2025-09", { dial: 43 });
    s.doc("2026-07", { dial: 143 }); // 100 units over 10 months
    expect(estimateUnits(s.a, P("2026-08"))).toBe(3);
    expect(estimateUnits({ ...s.a, policy: { ...s.a.policy, method: "median" } }, P("2026-08"))).toBe(10);
  });
  it("same month last year falls back to the median when that month has no span", () => {
    expect(estimateUnits(history({ method: "same_month_last_year" }).a, next)).toBe(10);
  });
  it("no usable history: the configured baseline for every estimating method", () => {
    for (const method of ["median", "trimmed_mean", "last_actual", "same_month_last_year"] as const) {
      const s = new Sim({ method, fallback: 9 });
      s.bill("2026-01", { dial: 0 });
      expect(estimateUnits(s.a, P("2026-02"))).toBe(9);
      expect(s.doc("2026-02").lines.find((l) => l.code === "USAGE_EST")?.units).toBe(9);
    }
  });
  it("no history and no baseline still holds (I-6)", () => {
    const s = new Sim({ method: "last_actual" });
    s.bill("2026-01", { dial: 0 });
    expect(s.held("2026-02")).toBe("NO_HISTORY");
  });
  it("an explicit estimate still wins under any method, even none", () => {
    const s = history({ method: "none" });
    expect(s.doc("2026-07", { units: 4 }).lines.find((l) => l.code === "USAGE_EST")?.units).toBe(4);
  });
});

describe("B-05 method none", () => {
  it("hold: held, flagged by an exception", () => {
    const s = history({ method: "none", noneAction: "hold" });
    expect(s.held("2026-07")).toBe("NO_ESTIMATE");
    expect(s.a.exceptions.at(-1)?.code).toBe("NO_ESTIMATE");
  });
  it("hold is the default action", () => expect(history({ method: "none" }).held("2026-07")).toBe("NO_ESTIMATE"));
  it("standing only: bills the standing charge, no usage, always flagged", () => {
    const s = history({ method: "none", noneAction: "standing_only" });
    const r = s.bill("2026-07");
    if (r.outcome.kind !== "billed") throw new Error(r.outcome.kind);
    expect(r.outcome.doc.lines.map((l) => l.code)).toEqual(["STANDING"]);
    expect(r.outcome.flags?.map((f) => f.code)).toContain("NO_ESTIMATE");
  });
  it("standing only does not poison the history", () => {
    const s = history({ method: "none", noneAction: "standing_only" });
    s.doc("2026-07");
    expect(estimateUnits({ ...s.a, policy: { ...s.a.policy, method: "median" } }, P("2026-08"))).toBe(10);
  });
  it("skip: nothing billed, no reading stored, account flagged; the next actual bills the whole span", () => {
    const s = history({ method: "none", noneAction: "skip" });
    const docs = s.a.docs.length;
    const readings = s.a.readings.length;
    const r = s.bill("2026-07");
    expect(r.outcome.kind).toBe("skipped");
    expect(s.a.docs).toHaveLength(docs);
    expect(s.a.readings).toHaveLength(readings);
    expect(s.a.exceptions.at(-1)?.code).toBe("NO_ESTIMATE");
    const d = s.doc("2026-08", { dial: 161 });
    expect(d.lines.filter((l) => l.code === "STANDING")).toHaveLength(2);
  });
});

describe("B-06 usable history", () => {
  const flagged = (flag: ReadingFlag): Sim => {
    const s = history({});
    // flag the 100-unit span (2026-06) and the 20-unit span (2026-05)
    s.a = {
      ...s.a,
      readings: s.a.readings.map((r): Reading => (r.period === "2026-06" || r.period === "2026-05" ? { ...r, flags: [flag] } : r)),
    };
    return s;
  };
  for (const flag of ["baseline_gap", "corrected", "disputed"] as const) {
    it(`excludes ${flag} spans`, () => expect(estimateUnits(flagged(flag).a, P("2026-07"))).toBe(6)); // median of 5, 6, 10
  }
  it("excludes voided readings and estimates", () => {
    const s = history({});
    const d = s.doc("2026-07", { units: 500 });
    expect(d).toBeDefined();
    expect(estimateUnits(s.a, P("2026-08"))).toBe(10);
    s.void(s.a.docs.find((x) => x.period === "2026-06")!.id);
    expect(estimateUnits(s.a, P("2026-08"))).toBe(8); // median of 5, 6, 10, 20
  });
  it("normalises a multi-month span to units a month", () => {
    const s = new Sim({ avgN: 3 });
    s.bill("2026-01", { dial: 0 });
    s.doc("2026-04", { dial: 90 }); // 90 units over 3 months
    expect(estimateUnits(s.a, P("2026-05"))).toBe(30);
  });
  it("correctPeriod marks the reading corrected, so it leaves the history", () => {
    const s = history({});
    s.a = { ...s.a, readings: s.a.readings.map((r) => (r.period === "2026-02" ? { ...r, dial: 6 } : r)) };
    s.correct("2026-02");
    expect(s.a.readings.find((r) => r.period === "2026-02")?.flags).toContain("corrected");
  });
});

describe("M-07 meter change", () => {
  it("consumption is old span plus new span, the swap counted once", () => {
    const s = new Sim();
    s.bill("2026-01", { dial: 100 });
    const d = s.doc("2026-02", { dial: 7, meterChange: { oldFinal: 130, newInitial: 2 } });
    expect(s.a.readings.at(-1)).toMatchObject({ units: 35, dial: 7, carry: 128 });
    expect(d.lines.find((l) => l.code === "USAGE")?.units).toBe(35);
    expect(s.doc("2026-03", { dial: 17 }).lines.find((l) => l.code === "USAGE")?.units).toBe(10);
  });
  it("a new meter reading lower than the old dial is not negative consumption", () => {
    const s = new Sim();
    s.bill("2026-01", { dial: 5000 });
    expect(s.doc("2026-02", { dial: 3, meterChange: { oldFinal: 5010, newInitial: 0 } }).lines[0]?.units).toBe(13);
  });
  it("rollover on the old meter wraps only the old span", () => {
    const s = new Sim();
    s.bill("2026-01", { dial: 9990 });
    s.doc("2026-02", { dial: 5, meterChange: { oldFinal: 4, newInitial: 0 }, rollover: true });
    expect(s.a.readings.at(-1)?.units).toBe(14 + 5);
  });
  it("holds an old final below the last actual unless rollover is confirmed", () => {
    const s = new Sim();
    s.bill("2026-01", { dial: 100 });
    expect(s.held("2026-02", { dial: 5, meterChange: { oldFinal: 90, newInitial: 0 } })).toBe("NEGATIVE_OR_ROLLOVER");
  });
  it("holds a new dial below the new meter's initial reading", () => {
    const s = new Sim();
    s.bill("2026-01", { dial: 100 });
    expect(s.held("2026-02", { dial: 1, meterChange: { oldFinal: 110, newInitial: 5 } })).toBe("METER_CHANGE_INVALID");
  });
  it("holds a meter change with no new reading", () => {
    const s = new Sim();
    s.bill("2026-01", { dial: 100 });
    expect(s.held("2026-02", { meterChange: { oldFinal: 110, newInitial: 0 } })).toBe("METER_CHANGE_INVALID");
  });
  it("a correction re-prices a meter-change reading with its carry", () => {
    const s = new Sim();
    s.bill("2026-01", { dial: 100 });
    s.doc("2026-02", { dial: 7, meterChange: { oldFinal: 130, newInitial: 2 } });
    expect(s.correct("2026-02").outcome.kind).toBe("none");
  });
  it("property: units = old span + new span, never negative, and the next span starts at the new dial", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5000 }),
        fc.integer({ min: 0, max: 2000 }),
        fc.integer({ min: 0, max: 500 }),
        fc.integer({ min: 0, max: 500 }),
        fc.integer({ min: 0, max: 500 }),
        (last, oldRun, newInitial, newRun, later) => {
          const s = new Sim({ ceiling: 1_000_000 });
          s.bill("2026-01", { dial: last });
          s.bill("2026-02", { dial: newInitial + newRun, meterChange: { oldFinal: last + oldRun, newInitial } });
          s.bill("2026-03", { dial: newInitial + newRun + later });
          const units = s.a.readings.filter((r) => r.units != null).map((r) => r.units as number);
          expect(units.every((u) => u >= 0)).toBe(true);
          expect(units).toEqual([oldRun + newRun, later]);
          expect(liveDocs(s.a).every((d) => d.total >= 0n)).toBe(true);
        },
      ),
    );
  });
});

describe("M-06 outcome to disposition", () => {
  it("lists about eight outcome groups", () => expect(READING_OUTCOMES).toHaveLength(8));
  it("the default maps every outcome", () => {
    for (const o of READING_OUTCOMES) expect(DEFAULT_OUTCOME_MAPPING[o]).toBeDefined();
    expect(dispositionFor("read_ok")).toBe("bill_actual");
    expect(dispositionFor("meter_inaccessible")).toBe("estimate");
    expect(dispositionFor("customer_refused")).toBe("hold");
  });
  it("the organization's mapping wins, the default fills the rest", () => {
    const m = { meter_inaccessible: "skip", dog_or_hazard: "standing_only" } as const;
    expect(dispositionFor("meter_inaccessible", m)).toBe("skip");
    expect(dispositionFor("dog_or_hazard", m)).toBe("standing_only");
    expect(dispositionFor("read_ok", m)).toBe("bill_actual");
  });
  const base = (): Sim => history({});
  it("bill actual bills the dial", () => {
    const s = base();
    const d = s.doc("2026-07", { dial: 151, outcome: "read_ok" });
    expect(d.lines.find((l) => l.code === "USAGE")?.units).toBe(10);
  });
  it("bill actual without a dial is held", () => expect(base().held("2026-07", { outcome: "read_ok" })).toBe("NO_READING"));
  it("estimate ignores any dial and uses the policy estimate", () => {
    const s = base();
    const d = s.doc("2026-07", { dial: 999, outcome: "locked_premises" });
    expect(d.lines.find((l) => l.code === "USAGE_EST")?.units).toBe(10);
    expect(s.a.readings.at(-1)?.kind).toBe("estimate");
  });
  it("hold raises OUTCOME_HOLD", () => expect(base().held("2026-07", { outcome: "no_meter_found" })).toBe("OUTCOME_HOLD"));
  it("hold and skip do not double up on a billed period", () => {
    expect(base().held("2026-06", { outcome: "no_meter_found" })).toBe("DUPLICATE_PERIOD");
    expect(base().held("2026-06", { disposition: "skip" })).toBe("DUPLICATE_PERIOD");
  });
  it("standing only bills the standing charge alone and flags it", () => {
    const s = base();
    const r = s.bill("2026-07", { outcome: "dog_or_hazard", outcomeMapping: { dog_or_hazard: "standing_only" } });
    if (r.outcome.kind !== "billed") throw new Error(r.outcome.kind);
    expect(r.outcome.doc.lines.map((l) => l.code)).toEqual(["STANDING"]);
    expect(r.outcome.flags?.map((f) => f.code)).toContain("STANDING_ONLY");
  });
  it("skip bills nothing and flags the account", () => {
    const s = base();
    const docs = s.a.docs.length;
    expect(s.bill("2026-07", { outcome: "customer_refused", outcomeMapping: { customer_refused: "skip" } }).outcome.kind).toBe("skipped");
    expect(s.a.docs).toHaveLength(docs);
    expect(s.a.exceptions.at(-1)?.code).toBe("OUTCOME_HOLD");
  });
  it("an explicit disposition beats the outcome", () => {
    expect(base().bill("2026-07", { outcome: "read_ok", disposition: "skip" }).outcome.kind).toBe("skipped");
  });
});

describe("B-08 flags (bill and flag, never block)", () => {
  const flags = (r: Result): string[] => (r.outcome.kind === "billed" ? (r.outcome.flags ?? []).map((f) => f.code) : ["not billed"]);
  it("zero consumption bills with standing and flags (M-10)", () => {
    const s = history({});
    const r = s.bill("2026-07", { dial: 141 });
    expect(r.outcome.kind).toBe("billed");
    expect(flags(r)).toEqual(expect.arrayContaining(["ZERO_CONSUMPTION", "STANDING_ONLY"]));
  });
  it("an ordinary bill carries no flags", () => expect(flags(history({}).bill("2026-07", { dial: 151 }))).toEqual([]));
  it("an outlier against the history is flagged below the absolute ceiling", () => {
    const s = new Sim({ ceiling: 1000 });
    s.bill("2026-01", { dial: 0 });
    [10, 20, 30].forEach((dial, i) => s.doc(`2026-0${i + 2}`, { dial }));
    const r = s.bill("2026-05", { dial: 130 }); // 100 against a usual 10
    expect(flags(r)).toEqual(["OUTLIER_HISTORY"]);
  });
  it("the history outlier check can be turned off and needs two spans", () => {
    const s = new Sim({ ceiling: 1000, outlierFactor: 0 });
    s.bill("2026-01", { dial: 0 });
    s.doc("2026-02", { dial: 10 });
    s.doc("2026-03", { dial: 20 });
    expect(flags(s.bill("2026-04", { dial: 220 }))).toEqual([]);
    const t = new Sim({ ceiling: 1000 });
    t.bill("2026-01", { dial: 0 });
    t.doc("2026-02", { dial: 10 });
    expect(flags(t.bill("2026-03", { dial: 210 }))).toEqual([]);
  });
  it("the absolute ceiling still holds", () => {
    const s = new Sim({ ceiling: 50 });
    s.bill("2026-01", { dial: 0 });
    expect(s.held("2026-02", { dial: 60 })).toBe("OUTLIER_HOLD");
  });
  it("flagBill is pure over its input", () => {
    const f = flagBill({ period: "2026-02", lines: [], estimate: false, units: 0, months: 1, history: [], outlierFactor: 3 });
    expect(f.map((x) => x.code)).toEqual(["ZERO_CONSUMPTION"]);
  });
});

describe("B-12 reconnection from the final reading", () => {
  const disconnected = (): Sim => {
    const s = new Sim();
    s.bill("2026-01", { dial: 0 });
    s.doc("2026-02", { dial: 10 });
    s.disconnect("2026-03", 25, "d1");
    return s;
  };
  it("the same dial reconnects with no new reading", () => {
    const s = disconnected();
    const readings = s.a.readings.length;
    const r = reconnect(s.a, "2026-03", { dial: 25, key: "r1" });
    expect(r.outcome.kind).toBe("reconnected");
    expect(r.account.status).toBe("ACTIVE");
    expect(r.account.readings).toHaveLength(readings);
  });
  it("a moved dial raises SUSPECTED_ILLEGAL_CONSUMPTION and still reconnects", () => {
    const s = disconnected();
    const r = reconnect(s.a, "2026-05", { dial: 40, key: "r1" });
    expect(r.outcome).toMatchObject({ kind: "suspected_illegal_consumption", movedBy: 15 });
    expect(r.account.status).toBe("ACTIVE");
    expect(r.account.exceptions.at(-1)?.code).toBe("SUSPECTED_ILLEGAL_CONSUMPTION");
  });
  it("a lower dial is suspicious too", () => {
    expect(reconnect(disconnected().a, "2026-04", { dial: 3, key: "r1" }).outcome.kind).toBe("suspected_illegal_consumption");
  });
  it("same month: disconnect and reconnect never yield two different readings", () => {
    const s = disconnected();
    for (const dial of [25, 31]) {
      const r = reconnect(s.a, "2026-03", { dial, key: "r1" });
      const inMonth = r.account.readings.filter((x) => x.period === "2026-03" && !x.voided);
      expect(inMonth).toHaveLength(1);
      expect(inMonth[0]?.dial).toBe(25);
    }
  });
  it("billing after a suspected reconnection still starts from the final reading", () => {
    const s = disconnected();
    s.a = reconnect(s.a, "2026-04", { dial: 40, key: "r1" }).account;
    expect(s.doc("2026-05", { dial: 45 }).lines.find((l) => l.code === "USAGE")?.units).toBe(20);
  });
  it("a repeat of the event does nothing", () => {
    const s = disconnected();
    const once = reconnect(s.a, "2026-03", { dial: 25, key: "r1" }).account;
    expect(reconnect(once, "2026-03", { dial: 25, key: "r1" }).outcome.kind).toBe("duplicate");
  });
  it("an account that is not disconnected is held", () => {
    const s = new Sim();
    s.bill("2026-01", { dial: 0 });
    expect(reconnect(s.a, "2026-02", { dial: 0, key: "r1" }).outcome).toMatchObject({ kind: "held" });
  });
  it("a voided final bill leaves nothing to reconnect from", () => {
    const s = disconnected();
    const final = s.a.docs.find((d) => d.final)!;
    s.void(final.id);
    expect(reconnect(s.a, "2026-03", { dial: 25, key: "r1" }).outcome).toMatchObject({ kind: "held" });
  });
  it("final bill is unchanged for callers that use the old API", () => {
    const a = newAccount();
    expect(finalBill(a, TARIFFS, "2026-03", { dial: 5, fee: 0n, key: "k" }).outcome.kind).toBe("baseline");
    expect(billReading(a, TARIFFS, "2026-01", { dial: 0 }).outcome.kind).toBe("baseline");
  });
});
