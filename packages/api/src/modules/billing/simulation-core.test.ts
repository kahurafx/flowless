import { periodIndex, type TariffVersion } from "@flowless/billing-engine";
import { describe, expect, it } from "vitest";
import { simulate, type SimSpan } from "./simulation-core";

const bands = (rows: [number | null, bigint][]) => rows.map(([upTo, rate]) => ({ upTo, rate }));
const CUR: TariffVersion = { id: "cur", from: "2020-01", standing: 0n, bands: bands([[10, 100n], [null, 200n]]) };
const span = (accountId: string, units: number, months = 1, categoryId: string | null = "c1"): SimSpan => ({
  accountId,
  categoryId,
  lineKey: `${accountId}:${units}`,
  from: periodIndex("2025-03") - 1,
  to: periodIndex("2025-03") - 1 + months,
  units,
  billed: 0n,
});

describe("tariff simulation (T-06)", () => {
  const run = (spans: SimSpan[], draft: [number | null, bigint][], scaling: "by_period" | "none" = "by_period") =>
    simulate({ spans, current: new Map([["c1", [CUR]]]), draftBands: bands(draft), scaling });

  it("prices one month under both tariffs and returns the delta, in bigint minor units", () => {
    // 15 units: current 10*100 + 5*200 = 2000; uniform 150: 2250.
    const r = run([span("a", 15)], [[null, 150n]]);
    expect(r.accounts[0]).toMatchObject({ current: 2000n, draft: 2250n, delta: 250n, units: 15 });
    expect(r.totals).toMatchObject({ accounts: 1, affected: 1, spans: 1, current: 2000n, draft: 2250n, delta: 250n });
  });

  it("counts only accounts whose price moves, and ranks the top movers by absolute change", () => {
    const r = run([span("a", 5), span("b", 15), span("c", 40), span("d", 0)], [[null, 100n]]);
    // a: same (500); b: 2000 -> 1500 (-500); c: 10*100+30*200=7000 -> 4000 (-3000); d: 0.
    expect(r.totals).toMatchObject({ accounts: 4, affected: 2, delta: -3500n });
    expect(r.topMovers.map((m) => [m.accountId, m.delta])).toEqual([["c", -3000n], ["b", -500n]]);
  });

  it("scales bands by the months in a span and rounds once (by_period), or treats it as one month (none)", () => {
    // 30 units over 3 months = 10 a month: current 10*100 = 1000 a month, 3000 over the span.
    const by = run([span("a", 30, 3)], [[null, 90n]]);
    expect(by.accounts[0]).toMatchObject({ current: 3000n, draft: 2700n });
    // none: all 30 units as one month: 10*100 + 20*200 = 5000.
    const none = run([span("a", 30, 3)], [[null, 90n]], "none");
    expect(none.accounts[0]).toMatchObject({ current: 5000n, draft: 2700n });
  });

  it("skips spans with no category or no tariff in force, in both columns, and lists them", () => {
    const r = simulate({ spans: [span("a", 15, 1, null), span("b", 15, 1, "unknown")], current: new Map([["c1", [CUR]]]), draftBands: bands([[null, 1n]]), scaling: "by_period" });
    expect(r.totals).toMatchObject({ accounts: 0, spans: 0, skippedSpans: 2, delta: 0n });
    expect(r.accounts.map((a) => a.skipped[0]?.reason)).toEqual(["no_category", "no_tariff_in_force"]);
  });

  it("is exact beyond float precision and sums spans per account", () => {
    const big = 9_007_199_254_740_993n; // 2^53 + 1
    const r = simulate({ spans: [span("a", 3), span("a", 4)], current: new Map([["c1", [CUR]]]), draftBands: bands([[null, big]]), scaling: "by_period" });
    expect(r.accounts[0]!.draft).toBe(7n * big);
    expect(r.accounts[0]!.current).toBe(700n);
    expect(r.accounts[0]!.spans).toHaveLength(2);
  });

  it("an empty selection gives zero totals", () => {
    expect(run([], [[null, 1n]]).totals).toMatchObject({ accounts: 0, affected: 0, delta: 0n });
  });
});
