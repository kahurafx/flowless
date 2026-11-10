import { describe, expect, it } from "vitest";
import { backBillLines, emptyBackBillRow } from "./case-view";

describe("back-billing lines", () => {
  it("turns typed money into minor units and totals exactly", () => {
    const result = backBillLines(
      [
        { description: "Bypass, March", amount: "1,250.50", serviceFrom: "2026-03-01", serviceTo: "2026-03-31" },
        { description: "Bypass, April", amount: "100", serviceFrom: "2026-04-01", serviceTo: "2026-04-30" },
      ],
      "KES",
    );
    expect(result).toEqual({
      ok: true,
      lines: [
        { description: "Bypass, March", amount: 125050n, serviceFrom: "2026-03-01", serviceTo: "2026-03-31" },
        { description: "Bypass, April", amount: 10000n, serviceFrom: "2026-04-01", serviceTo: "2026-04-30" },
      ],
      total: 135050n,
    });
  });
  it("names each problem by line", () => {
    const result = backBillLines([emptyBackBillRow, { description: "x", amount: "10", serviceFrom: "2026-05-02", serviceTo: "2026-05-01" }], "KES");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems).toContain("Line 1: say what it is for");
      expect(result.problems).toContain("Line 2: the service span ends before it starts");
    }
  });
  it("needs a line", () => {
    expect(backBillLines([], "KES")).toEqual({ ok: false, problems: ["Add at least one line"] });
  });
});
