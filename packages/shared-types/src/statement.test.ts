import { describe, expect, it } from "vitest";
import { collapsePairs, pairMarks, statementLineType, type PairableRow } from "./statement";

const row = (key: string, amount: bigint, linkedTo: string | null = null): PairableRow => ({ key, amount, linkedTo });

describe("statementLineType (B-17)", () => {
  it.each([
    [{ entryType: "charge", documentKind: "invoice" }, "invoice"],
    [{ entryType: "charge", documentKind: "credit_note" }, "credit_note"],
    [{ entryType: "adjustment", documentKind: "debit_note" }, "debit_note"],
    [{ entryType: "charge", documentKind: "credit_note", correction: true }, "correction"],
    [{ entryType: "adjustment", documentKind: "debit_note", correction: true }, "correction"],
    [{ entryType: "reversal", documentKind: "reversal" }, "reversal"],
    [{ entryType: "reversal", documentKind: null }, "reversal"],
    [{ entryType: "payment", documentKind: null }, "payment"],
    [{ entryType: "transfer", documentKind: null }, "transfer"],
    [{ entryType: "write_off", documentKind: null }, "adjustment"],
    [{ entryType: "credit", documentKind: null }, "adjustment"],
    [{ entryType: "deposit", documentKind: null }, "invoice"],
  ] as const)("%j is %s", (input, expected) => {
    expect(statementLineType(input)).toBe(expected);
  });
});

describe("collapsePairs (B-17)", () => {
  it("collapses an invoice with its reversal and keeps the replacement", () => {
    const rows = [row("inv", 1000n), row("rev", -1000n, "inv"), row("new", 900n), row("pay", -900n)];
    expect(collapsePairs(rows).map((r) => r.key)).toEqual(["new", "pay"]);
    expect(pairMarks(rows).get("rev")).toEqual({ pairId: "inv", role: "offset", settled: true });
    expect(pairMarks(rows).get("inv")).toEqual({ pairId: "inv", role: "original", settled: true });
  });

  it("collapses an invoice with a full credit note but not with a partial one", () => {
    expect(collapsePairs([row("inv", 500n), row("cn", -500n, "inv")])).toEqual([]);
    const partial = [row("inv", 500n), row("cn", -200n, "inv")];
    expect(collapsePairs(partial)).toEqual(partial);
    expect(pairMarks(partial).get("cn")?.settled).toBe(false);
  });

  it("collapses one original with several offsets only when all together net to zero", () => {
    expect(collapsePairs([row("inv", 500n), row("a", -200n, "inv"), row("b", -300n, "inv")])).toEqual([]);
  });

  it("ignores links to rows outside the window and self links, and never changes the sum of what remains", () => {
    const rows = [row("rev", -1000n, "gone"), row("x", 5n, "x"), row("inv", 70n), row("rv", -70n, "inv")];
    const kept = collapsePairs(rows);
    expect(kept.map((r) => r.key)).toEqual(["rev", "x"]);
    expect(kept.reduce((s, r) => s + r.amount, 0n)).toBe(rows.reduce((s, r) => s + r.amount, 0n));
  });
});
