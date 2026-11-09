import { DATA_QUALITY_RULE_KEYS } from "@flowless/shared-types";
import { describe, expect, it } from "vitest";
import { dataQualityConfigSchema, effectiveRules } from "./data-quality-config";
import { nameKey, placementKeyOf, placementProblem, type AreaFact, type RouteFact } from "./data-quality-placement";

const area = (id: string, name: string, parentId: string | null = null): [string, AreaFact] => [id, { id, name, parentId }];
const route = (id: string, name: string, areaId: string | null = null): [string, RouteFact] => [id, { id, name, areaId }];

const areas = new Map([
  area("scheme", "Kahawa West"),
  area("zone1", "Zone 1", "scheme"),
  area("zone2", "Zone 2", "scheme"),
  area("dma1", "DMA 1", "zone1"),
  area("other", "Ruiru"),
]);
const routes = new Map([
  route("r-none", "Route A"),
  route("r-zone1", "Route B", "zone1"),
  route("r-scheme", "Route C", "scheme"),
  route("r-dma1", "Route D", "dma1"),
  route("r-other", "Route E", "other"),
  route("r-zone2", "Route F", "zone2"),
  route("r-same", "ZONE 1", "zone1"),
  route("r-same2", "zone-1!", null),
]);
const at = (r: string | null, z: string | null = "zone1", s: string | null = "scheme", d: string | null = null) => ({ s, z, d, r });

// C-12: zone_equals_route, interpreted as route and zone data in the wrong field.
describe("placementProblem", () => {
  it("is fine when the route has no area, or its area is the zone, above it or below it", () => {
    for (const r of ["r-none", "r-zone1", "r-scheme"]) expect(placementProblem(at(r), areas, routes)).toBeNull();
    expect(placementProblem(at("r-dma1"), areas, routes)).toBeNull();
    expect(placementProblem(at("r-dma1", "zone1", "scheme", "dma1"), areas, routes)).toBeNull();
  });

  it("flags a route grouped under an unrelated area", () => {
    expect(placementProblem(at("r-other"), areas, routes)).toMatch(/Route E.*Ruiru/);
    expect(placementProblem(at("r-zone2"), areas, routes)).toMatch(/Route F.*Zone 2/);
  });

  it("flags a route with the same name as its zone, scheme or DMA, ignoring case and punctuation", () => {
    expect(placementProblem(at("r-same"), areas, routes)).toMatch(/same name as the area "Zone 1"/);
    expect(placementProblem(at("r-same2"), areas, routes)).toMatch(/same name/);
    const same = new Map([route("r-dma", "dma 1", null)]);
    expect(placementProblem(at("r-dma", null, null, "dma1"), areas, same)).toMatch(/DMA 1/);
  });

  it("says nothing without a route, an unknown route, or no area to compare to", () => {
    expect(placementProblem(at(null), areas, routes)).toBeNull();
    expect(placementProblem(at("missing"), areas, routes)).toBeNull();
    expect(placementProblem(at("r-other", null, null, null), areas, routes)).toBeNull();
  });

  it("builds stable keys and comparable names", () => {
    expect(placementKeyOf(at("r"))).toBe("scheme|zone1||r");
    expect(nameKey("  Zone-1 / Éast ")).toBe("zone1éast");
  });
});

describe("accounts.data_quality setting", () => {
  it("reads an empty value and fills the defaults (every rule on, nothing raised)", () => {
    const config = dataQualityConfigSchema.parse({});
    expect(config).toEqual({ rules: {} });
    const rules = effectiveRules(config);
    expect(rules.map((r) => r.key)).toEqual([...DATA_QUALITY_RULE_KEYS]);
    expect(rules.every((r) => r.enabled && !r.raiseExceptions)).toBe(true);
  });

  it("applies overrides, tolerates unknown rules and fields, and refuses a bad severity", () => {
    const config = dataQualityConfigSchema.parse({ rules: { account_no_phone: { enabled: false, severity: "critical", raiseExceptions: true, future: 1 }, gone: { enabled: true } } });
    const phone = effectiveRules(config).find((r) => r.key === "account_no_phone")!;
    expect(phone).toMatchObject({ enabled: false, severity: "critical", raiseExceptions: true });
    expect(dataQualityConfigSchema.safeParse({ rules: { account_no_phone: { severity: "urgent" } } }).success).toBe(false);
  });
});
