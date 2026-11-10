import { describe, expect, it } from "vitest";
import { DEFAULT_READING_VALIDATION, expectedDialRange, parseDialValue, splitFlags, validateReadingEntry, type ReadingEntryInput } from "./reading-entry";

const DAY = 86_400_000;
const at = (d: number) => new Date(Date.UTC(2026, 0, d, 8));
const base: ReadingEntryInput = {
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
const run = (over: Partial<ReadingEntryInput>) => validateReadingEntry({ ...base, ...over });
/** One earlier interval ending at `previous`: 1 unit a day. */
const history = [{ value: 70, readAt: new Date(at(1).getTime() - 30 * DAY) }];

describe("validateReadingEntry (M-05, M-07 mirror)", () => {
  it("passes a normal reading and derives units", () => {
    expect(run({})).toEqual({ flags: [], units: 20, rollover: false });
  });
  it("flags zero except on boundary readings", () => {
    expect(run({ value: 0 }).flags).toContain("ZERO");
    expect(run({ value: 0, purpose: "initial", previous: null }).flags).toEqual([]);
  });
  it("separates a wrap from a real drop, and honours a confirmation only when plausible", () => {
    const previous = { value: 99_950, readAt: at(1) };
    expect(run({ value: 20, previous })).toMatchObject({ flags: ["ROLLOVER_CANDIDATE"], units: null });
    expect(run({ value: 20, previous, rolloverConfirmed: true })).toEqual({ flags: [], units: 70, rollover: true });
    expect(run({ value: 100, previous: { value: 40_000, readAt: at(1) } }).flags).toEqual(["BELOW_LAST"]);
    expect(run({ value: 100, previous: { value: 40_000, readAt: at(1) }, rolloverConfirmed: true }).flags).toEqual(["BELOW_LAST"]);
  });
  it("flags a jump far above the meter's own use, and an advisory zero consumption", () => {
    expect(run({ value: 500, history }).flags).toEqual(["ABOVE_RANGE"]);
    expect(run({ value: 100 }).flags).toEqual(["ZERO_CONSUMPTION"]);
  });
  it("applies the absolute ceiling and the low factor", () => {
    expect(validateReadingEntry({ ...base, value: 1000 }, { ...DEFAULT_READING_VALIDATION, maxUnitsPerDay: 10 }).flags).toEqual(["ABOVE_RANGE"]);
    expect(validateReadingEntry({ ...base, value: 101, history }, { ...DEFAULT_READING_VALIDATION, lowFactor: 0.5 }).flags).toEqual(["BELOW_RANGE"]);
  });
  it("flags same-day duplicates, back-dated entries and the closed period", () => {
    expect(run({ sameDayDuplicate: true }).flags).toEqual(["SAME_DAY_DUPLICATE"]);
    expect(run({ next: { value: 110, readAt: at(40) } }).flags).toEqual(["OUT_OF_SEQUENCE"]);
    expect(run({ inClosedPeriod: true }).flags).toEqual(["CLOSED_PERIOD"]);
  });
});

describe("expectedDialRange", () => {
  it("is null with no previous reading and open-ended with no history", () => {
    expect(expectedDialRange(null, [], at(31))).toBeNull();
    expect(expectedDialRange({ value: 100, readAt: at(1) }, [], at(31))).toEqual({ min: 100, max: null, perDay: null });
  });
  it("derives the ceiling from the meter's own daily use, matching where ABOVE_RANGE starts", () => {
    const r = expectedDialRange({ value: 100, readAt: at(1) }, history, at(31));
    expect(r).toMatchObject({ min: 100, perDay: 1, max: 190 });
    expect(validateReadingEntry({ ...base, value: 190, history }).flags).not.toContain("ABOVE_RANGE");
    expect(validateReadingEntry({ ...base, value: 191, history }).flags).toContain("ABOVE_RANGE");
  });
});

describe("parseDialValue and splitFlags", () => {
  it("accepts digits within the dial width", () => {
    expect(parseDialValue("00123", 5)).toEqual({ ok: true, value: 123 });
    expect(parseDialValue("", 5).ok).toBe(false);
    expect(parseDialValue("12.5", 5).ok).toBe(false);
    expect(parseDialValue("123456", 5).ok).toBe(false);
  });
  it("splits blocking from advisory", () => {
    expect(splitFlags(["ZERO", "ZERO_CONSUMPTION", "CLOSED_PERIOD"])).toEqual({ blocking: ["ZERO"], advisory: ["ZERO_CONSUMPTION", "CLOSED_PERIOD"] });
  });
});
