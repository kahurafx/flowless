import { describe, expect, it } from "vitest";
import { areaParentProblem, scopeCovers, type Scope } from "./hierarchy";

// K-02: configurable levels; K-03: scope restrictions.
describe("hierarchy", () => {
  it("lets each level sit under any higher level", () => {
    expect(areaParentProblem("scheme", null)).toBeNull();
    expect(areaParentProblem("zone", "scheme")).toBeNull();
    expect(areaParentProblem("dma", "zone")).toBeNull(); // no sub-zones in this organization
    expect(areaParentProblem("dma", "sub_zone")).toBeNull();
  });

  it("rejects missing, equal or lower parents", () => {
    expect(areaParentProblem("scheme", "zone")).toMatch(/no parent/);
    expect(areaParentProblem("zone", null)).toMatch(/needs a parent/);
    expect(areaParentProblem("zone", "zone")).toMatch(/higher level/);
    expect(areaParentProblem("zone", "dma")).toMatch(/higher level/);
  });

  it("scopes cover a record by area or by route", () => {
    const limited: Scope = { kind: "limited", areaIds: new Set(["z1"]), routeIds: new Set(["r9"]) };
    expect(scopeCovers({ kind: "all" }, {})).toBe(true);
    expect(scopeCovers(limited, { areaId: "z1" })).toBe(true);
    expect(scopeCovers(limited, { areaId: "z2", routeId: "r9" })).toBe(true);
    expect(scopeCovers(limited, { areaId: "z2", routeId: "r1" })).toBe(false);
    expect(scopeCovers(limited, {})).toBe(false);
  });
});
