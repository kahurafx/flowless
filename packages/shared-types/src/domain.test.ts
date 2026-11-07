import { describe, expect, it } from "vitest";
import { normalizePhone } from "./accounts";
import { exceptionAge } from "./exceptions";
import { money } from "./money";
import { buildStatement, type StatementLine } from "./statement";

const line = (id: string, day: number, amountMinor: bigint, type: StatementLine["type"] = "invoice"): StatementLine => ({
  id,
  postedAt: new Date(Date.UTC(2026, 9, day)),
  type,
  reference: id,
  description: id,
  amount: money(amountMinor, "KES"),
});

// B-17, I-2: the running balance is derived from the lines, in posting order.
describe("buildStatement", () => {
  it("derives the running balance in posting order", () => {
    const rows = buildStatement("KES", 0n, [line("pay", 5, -64500n, "payment"), line("inv", 1, 64500n)]);
    expect(rows.map((r) => [r.id, r.runningBalance.amountMinor])).toEqual([
      ["inv", 64500n],
      ["pay", 0n],
    ]);
  });

  it("starts from the opening balance", () => {
    const [row] = buildStatement("KES", 10000n, [line("inv", 1, 34000n)]);
    expect(row?.runningBalance.amountMinor).toBe(44000n);
  });

  it("rejects a line in another currency", () => {
    expect(() => buildStatement("KES", 0n, [{ ...line("x", 1, 1n), amount: money(1n, "USD") }])).toThrow(/USD/);
  });
});

describe("exceptionAge", () => {
  const raised = new Date("2026-11-01T08:00:00Z");
  it.each([
    ["2026-11-01T20:00:00Z", 0, "fresh"],
    ["2026-11-03T08:00:00Z", 2, "ageing"],
    ["2026-11-08T08:00:00Z", 7, "overdue"],
  ] as const)("at %s is %i days, %s", (now, days, bucket) => {
    expect(exceptionAge(raised, new Date(now))).toEqual({ days, bucket });
  });
});

// C-01: placeholder phones count as no phone.
describe("normalizePhone", () => {
  it.each([
    ["25400000000", null],
    ["+254000000000", null],
    ["", null],
    [null, null],
    ["0712 345 678", "0712345678"],
    ["+254712345678", "+254712345678"],
  ])("%s → %s", (raw, expected) => {
    expect(normalizePhone(raw)).toBe(expected);
  });
});
