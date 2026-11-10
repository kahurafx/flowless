import { describe, expect, it } from "vitest";
import { completenessOf, incompleteMessage, type CompletenessRow } from "./completeness";
import { reviewBucket, sampleSelection } from "./cycle-review";
import { lastDayOf, monthsCovered } from "./period-lock";

const T = { bulkApproveBelow: 1_000_000n, individualAbove: 5_000_000n };

describe("completeness (B-04)", () => {
  const row = (accountId: string, over: Partial<CompletenessRow> = {}): CompletenessRow => ({ accountId, outcome: "billed", reason: null, exceptionId: null, ...over });

  it("is complete when every expected account has a terminal outcome with its reason", () => {
    const c = completenessOf([row("a"), row("b", { outcome: "billed_estimate" }), row("c", { outcome: "excluded", reason: "meter removed" }), row("d", { outcome: "exception", reason: "no reading", exceptionId: "x" })]);
    expect(c).toMatchObject({ complete: true, expected: 4, explained: 4, unexplained: 0, byOutcome: { billed: 1, billed_estimate: 1, excluded: 1, exception: 1 } });
  });

  it("counts accounts with no outcome, no reason or no exception link, and lists examples", () => {
    const rows = [row("a"), row("b", { outcome: null }), row("c", { outcome: "excluded" }), row("d", { outcome: "exception", reason: "r" })];
    const c = completenessOf(rows, 2);
    expect(c).toMatchObject({ complete: false, expected: 4, explained: 1, unexplained: 3 });
    expect(c.examples).toEqual([
      { accountId: "b", problem: "no outcome" },
      { accountId: "c", problem: "excluded without a reason" },
    ]);
    expect(incompleteMessage(c)).toMatch(/3 of 4 expected accounts are unexplained/);
  });

  it("an empty expected set is complete", () => {
    expect(completenessOf([]).complete).toBe(true);
  });
});

describe("review (B-16)", () => {
  it("buckets bills by flag and amount, in either sign; non-bills are not reviewed", () => {
    expect(reviewBucket({ outcome: "billed", amount: 500_000n, flagged: false }, T)).toBe("clean");
    expect(reviewBucket({ outcome: "billed_estimate", amount: 1_000_000n, flagged: false }, T)).toBe("clean");
    expect(reviewBucket({ outcome: "billed", amount: 500_000n, flagged: true }, T)).toBe("attention");
    expect(reviewBucket({ outcome: "billed", amount: 1_000_001n, flagged: false }, T)).toBe("attention");
    expect(reviewBucket({ outcome: "billed", amount: -5_000_001n, flagged: false }, T)).toBe("high");
    expect(reviewBucket({ outcome: "exception", amount: null, flagged: false }, T)).toBeNull();
  });

  it("samples deterministically, at least the minimum and at most all", () => {
    const ids = Array.from({ length: 100 }, (_, i) => `acc-${i}`);
    const a = sampleSelection(ids, { rate: 0.05, minimum: 3, seed: "cycle-1" });
    expect(a).toHaveLength(5);
    expect(sampleSelection(ids, { rate: 0.05, minimum: 3, seed: "cycle-1" })).toEqual(a);
    expect(sampleSelection([...ids].reverse(), { rate: 0.05, minimum: 3, seed: "cycle-1" }).sort()).toEqual([...a].sort());
    expect(sampleSelection(ids, { rate: 0.05, minimum: 3, seed: "cycle-2" })).not.toEqual(a);
    expect(sampleSelection(ids.slice(0, 10), { rate: 0.05, minimum: 3, seed: "s" })).toHaveLength(3);
    expect(sampleSelection(["x", "y"], { rate: 0.05, minimum: 3, seed: "s" })).toHaveLength(2);
    expect(sampleSelection([], { rate: 1, minimum: 3, seed: "s" })).toEqual([]);
    expect(new Set(sampleSelection(ids, { rate: 1, minimum: 0, seed: "s" })).size).toBe(100);
  });
});

describe("period lock helpers (B-15)", () => {
  it("covers the months of the frequency, across a year end", () => {
    expect(monthsCovered("2026-10", "monthly")).toEqual(["2026-10"]);
    expect(monthsCovered("2026-10", "quarterly")).toEqual(["2026-08", "2026-09", "2026-10"]);
    expect(monthsCovered("2026-01", "bimonthly")).toEqual(["2025-12", "2026-01"]);
    expect(lastDayOf("2024-02")).toBe("2024-02-29");
    expect(lastDayOf("2026-12")).toBe("2026-12-31");
  });
});
