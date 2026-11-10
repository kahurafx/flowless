import { describe, expect, it } from "vitest";
import { canConfirmRollover, flagMarks, instantFromLocal, needsReview, parseDial, statusMoves, unitsText } from "./metering-view";

describe("meter status moves", () => {
  it("never offers installed or replaced, which install, remove and replace do", () => {
    expect(statusMoves("in_stock")).toEqual(["issued", "tested", "disposed"]);
    expect(statusMoves("tested")).toEqual(["in_stock", "issued", "disposed"]);
  });
  it("offers nothing for an installed meter and nothing after disposal", () => {
    expect(statusMoves("installed")).toEqual([]);
    expect(statusMoves("disposed")).toEqual([]);
  });
});

describe("reading flags", () => {
  it("words each flag and marks blocking ones", () => {
    const marks = flagMarks(["BELOW_LAST", "ZERO_CONSUMPTION", "MYSTERY"]);
    expect(marks[0]).toMatchObject({ blocking: true, label: "Below the last actual reading" });
    expect(marks[1]).toMatchObject({ blocking: false });
    expect(marks[2]).toMatchObject({ blocking: true, label: "MYSTERY" });
  });
  it("waits for review while valid and not cleared", () => {
    expect(needsReview({ status: "valid", cleared: false })).toBe(true);
    expect(needsReview({ status: "valid", cleared: true })).toBe(false);
    expect(needsReview({ status: "voided", cleared: false })).toBe(false);
  });
  it("offers the rollover confirmation only for a candidate", () => {
    expect(canConfirmRollover({ flags: ["ROLLOVER_CANDIDATE"], rolloverConfirmed: false })).toBe(true);
    expect(canConfirmRollover({ flags: ["ROLLOVER_CANDIDATE"], rolloverConfirmed: true })).toBe(false);
    expect(canConfirmRollover({ flags: ["BELOW_LAST"], rolloverConfirmed: false })).toBe(false);
  });
  it("says what the units are", () => {
    expect(unitsText({ units: 12, previousValue: 100, flags: [] })).toBe("12");
    expect(unitsText({ units: null, previousValue: null, flags: [] })).toBe("First reading");
    expect(unitsText({ units: null, previousValue: 900, flags: ["ROLLOVER_CANDIDATE"] })).toBe("Needs rollover confirmation");
    expect(unitsText({ units: null, previousValue: 900, flags: ["BELOW_LAST"] })).toBe("Below the previous reading");
  });
});

describe("form values", () => {
  it("parses a dial as whole digits within the meter's digits", () => {
    expect(parseDial("01482", 5)).toEqual({ ok: true, value: 1482 });
    expect(parseDial("123456", 5).ok).toBe(false);
    expect(parseDial("12.5").ok).toBe(false);
    expect(parseDial("-3").ok).toBe(false);
    expect(parseDial("").ok).toBe(false);
  });
  it("turns a local date-time into an instant", () => {
    expect(instantFromLocal("")).toBeNull();
    expect(instantFromLocal("nonsense")).toBeNull();
    expect(instantFromLocal("2026-05-04T09:30")).toBeInstanceOf(Date);
  });
});
