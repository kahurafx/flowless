import { describe, expect, it } from "vitest";
import { deltaDirection, parseAccountNumbers, percentChange, selectionProblem } from "./simulation-view";

describe("simulation selection", () => {
  it("splits account numbers on commas, spaces and lines, once each", () => {
    expect(parseAccountNumbers("KW-1, KW-2\nKW-1  KW-3;")).toEqual(["KW-1", "KW-2", "KW-3"]);
    expect(parseAccountNumbers("  ")).toEqual([]);
  });
  it("needs a route, a category or account numbers", () => {
    expect(selectionProblem({ routeId: "", categoryId: "", accountNumbers: "" })).not.toBeNull();
    expect(selectionProblem({ routeId: "r", categoryId: "", accountNumbers: "" })).toBeNull();
    expect(selectionProblem({ routeId: "", categoryId: "", accountNumbers: "KW-1" })).toBeNull();
  });
});

describe("simulation deltas", () => {
  it("gives the direction", () => {
    expect(deltaDirection(5n)).toBe("up");
    expect(deltaDirection(-5n)).toBe("down");
    expect(deltaDirection(0n)).toBe("same");
  });
  it("computes percent change in integers", () => {
    expect(percentChange(10000n, 11250n)).toBe("+12.5%");
    expect(percentChange(10000n, 9000n)).toBe("-10.0%");
    expect(percentChange(10000n, 10000n)).toBe("0.0%");
    expect(percentChange(0n, 100n)).toBeNull();
  });
});
