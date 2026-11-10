import { describe, expect, it } from "vitest";
import { CYCLE_STATES, eligibilitySourceLabel, isPeriod, moveNeedsReason, moveOptions, percentOf, periodLabel, previousPeriod } from "./cycle-view";

describe("cycle moves", () => {
  it("offers the next state, skips and retreats, never open or closed", () => {
    const o = moveOptions("calculation");
    expect(o.next).toBe("review");
    expect(o.skip).toEqual(["issue", "deliver", "completeness"]);
    expect(o.back).toEqual(["reading_window", "validation", "estimation"]);
    expect(o.canClose).toBe(false);
  });
  it("from the completeness check only close remains", () => {
    const o = moveOptions("completeness");
    expect(o.next).toBeNull();
    expect(o.canClose).toBe(true);
    expect(o.skip).toEqual([]);
  });
  it("a closed cycle offers nothing", () => {
    expect(moveOptions("closed")).toEqual({ next: null, skip: [], back: [], canClose: false });
  });
  it("only the next state needs no reason", () => {
    expect(moveNeedsReason("open", "reading_window")).toBe(false);
    expect(moveNeedsReason("open", "validation")).toBe(true);
    expect(moveNeedsReason("review", "validation")).toBe(true);
  });
  it("lists every state once", () => {
    expect(new Set(CYCLE_STATES).size).toBe(CYCLE_STATES.length);
  });
});

describe("periods", () => {
  it("checks the shape and finds the previous month across a year", () => {
    expect(isPeriod("2026-05")).toBe(true);
    expect(isPeriod("2026-13")).toBe(false);
    expect(previousPeriod("2026-01-15")).toBe("2025-12");
    expect(previousPeriod("2026-11-10")).toBe("2026-10");
  });
  it("labels a period in the organization's language", () => {
    expect(periodLabel("2026-03", "en")).toBe("March 2026");
    expect(periodLabel("bad", "en")).toBe("bad");
  });
  it("percent of nothing is complete", () => {
    expect(percentOf(0, 0)).toBe(100);
    expect(percentOf(1, 3)).toBe(33);
  });
  it("says where the accounts came from", () => {
    expect(eligibilitySourceLabel("accounts_fallback").label).toBe("Accounts fallback");
  });
});
