import { describe, expect, it } from "vitest";
import { canMoveMeter, consumptionBetween, isBlockingFlag, METER_STATUSES, METER_TRANSITIONS, READING_FLAGS, type MeterStatus } from "./metering";
import { DEFAULT_ROLES } from "./permissions";

describe("meter lifecycle (M-01)", () => {
  it("names every status once and only moves to known statuses", () => {
    expect(Object.keys(METER_TRANSITIONS).sort()).toEqual([...METER_STATUSES].sort());
    for (const targets of Object.values(METER_TRANSITIONS)) for (const to of targets) expect(METER_STATUSES).toContain(to);
  });

  it("is never reflexive, and disposed is final", () => {
    for (const s of METER_STATUSES) expect(canMoveMeter(s, s)).toBe(false);
    expect(METER_TRANSITIONS.disposed).toEqual([]);
    expect(canMoveMeter("procured", "installed")).toBe(false);
    expect(canMoveMeter("in_stock", "issued")).toBe(true);
  });

  it("can reach disposed from every status that is not disposed", () => {
    for (const s of METER_STATUSES.filter((x) => x !== "disposed")) {
      const seen = new Set<MeterStatus>([s]);
      const queue: MeterStatus[] = [s];
      while (queue.length) {
        for (const n of METER_TRANSITIONS[queue.shift()!]) {
          if (seen.has(n)) continue;
          seen.add(n);
          queue.push(n);
        }
      }
      expect(seen.has("disposed")).toBe(true);
    }
  });
});

describe("reading flags (M-05)", () => {
  it("treats unknown flags as blocking and only the two advisory ones as not", () => {
    expect(isBlockingFlag("SOMETHING_NEW")).toBe(true);
    expect(Object.entries(READING_FLAGS).filter(([, f]) => !f.blocking).map(([k]) => k).sort()).toEqual(["CLOSED_PERIOD", "ZERO_CONSUMPTION"]);
  });

  it("counts a wrap of the dial", () => {
    expect(consumptionBetween(99_950, 20, 5, true)).toBe(70);
    expect(consumptionBetween(100, 130, 5, false)).toBe(30);
  });
});

describe("metering permissions", () => {
  it("lets technicians capture but not approve, and supervisors approve and manage meters", () => {
    expect(DEFAULT_ROLES.technician).toContain("readings:capture");
    expect(DEFAULT_ROLES.technician).not.toContain("readings:approve");
    expect(DEFAULT_ROLES.technician).not.toContain("meters:manage");
    expect(DEFAULT_ROLES.supervisor).toContain("readings:approve");
    expect(DEFAULT_ROLES.supervisor).toContain("meters:manage");
    expect(DEFAULT_ROLES.cashier).not.toContain("meters:read");
  });
});
