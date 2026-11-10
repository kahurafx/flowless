import { describe, expect, it } from "vitest";
import { meteringValidationSchema } from "./settings";
import { blocks, expectedPerDay, validateReading, type ValidationInput } from "./validate";

const config = meteringValidationSchema.parse({});
const at = (d: number) => new Date(Date.UTC(2026, 0, d, 8));
const base: ValidationInput = {
  value: 120,
  readAt: at(31),
  dialDigits: 5,
  purpose: "routine",
  rolloverConfirmed: false,
  previous: { value: 100, readAt: at(1) },
  next: null,
  history: [],
  sameDayDuplicate: false,
  inClosedPeriod: false,
};
const run = (over: Partial<ValidationInput>, cfg = config) => validateReading({ ...base, ...over }, cfg);

describe("validateReading (M-05, M-07)", () => {
  it("passes a normal reading and derives units", () => {
    expect(run({})).toEqual({ flags: [], units: 20, rollover: false });
  });

  it("accepts a first reading with no previous", () => {
    expect(run({ previous: null })).toEqual({ flags: [], units: null, rollover: false });
  });

  it("flags zero except on a meter's boundary readings", () => {
    expect(run({ value: 0 }).flags).toContain("ZERO");
    expect(run({ value: 0, purpose: "initial", previous: null }).flags).toEqual([]);
    expect(run({ value: 0, purpose: "final", previous: { value: 0, readAt: at(1) } }).flags).toEqual([]);
  });

  it("separates a drop that could be a wrap from one that cannot", () => {
    expect(run({ value: 20, previous: { value: 99_950, readAt: at(1) } })).toMatchObject({ flags: ["ROLLOVER_CANDIDATE"], units: null });
    expect(run({ value: 100, previous: { value: 40_000, readAt: at(1) } }).flags).toEqual(["BELOW_LAST"]);
  });

  it("counts a confirmed wrap and refuses an impossible confirmation", () => {
    expect(run({ value: 20, previous: { value: 99_950, readAt: at(1) }, rolloverConfirmed: true })).toEqual({ flags: [], units: 70, rollover: true });
    expect(run({ value: 100, previous: { value: 40_000, readAt: at(1) }, rolloverConfirmed: true }).flags).toEqual(["BELOW_LAST"]);
    // A confirmation on a reading that did not drop changes nothing.
    expect(run({ rolloverConfirmed: true })).toEqual({ flags: [], units: 20, rollover: false });
  });

  it("flags a same-day duplicate and a value above a later reading", () => {
    expect(run({ sameDayDuplicate: true }).flags).toEqual(["SAME_DAY_DUPLICATE"]);
    expect(run({ next: { value: 110, readAt: at(40) } }).flags).toEqual(["OUT_OF_SEQUENCE"]);
    expect(run({ next: { value: 130, readAt: at(40) } }).flags).toEqual([]);
  });

  it("uses the meter's own history for the expected range", () => {
    const history = [
      { value: 90, readAt: at(-9) },
      { value: 80, readAt: at(-19) },
    ];
    // 10 units every 10 days: one a day.
    expect(expectedPerDay({ value: 100, readAt: at(1) }, history, 3)).toBeCloseTo(1);
    expect(run({ value: 220, history }).flags).toEqual(["ABOVE_RANGE"]);
    expect(run({ value: 130, history }).flags).toEqual([]);
    expect(run({ value: 101, history }, { ...config, lowFactor: 0.5 }).flags).toEqual(["BELOW_RANGE"]);
    expect(expectedPerDay({ value: 100, readAt: at(1) }, [], 3)).toBeNull();
  });

  it("applies the absolute ceiling with no history", () => {
    expect(run({ value: 160 }, { ...config, maxUnitsPerDay: 1 }).flags).toEqual(["ABOVE_RANGE"]);
  });

  it("marks zero consumption as advisory and a closed period as advisory", () => {
    const zero = run({ value: 100 });
    expect(zero.flags).toEqual(["ZERO_CONSUMPTION"]);
    expect(blocks(zero.flags)).toBe(false);
    expect(blocks(run({ inClosedPeriod: true }).flags)).toBe(false);
    expect(blocks(["ZERO", "CLOSED_PERIOD"])).toBe(true);
    expect(blocks(["UNKNOWN_FLAG"])).toBe(true);
  });
});
