import type { Permission } from "@flowless/shared-types";
import { describe, expect, it } from "vitest";
import { currentHref, navFor } from "./nav";

const hrefs = (modules: Parameters<typeof navFor>[0], permissions: Permission[]) => navFor(modules, permissions).map((i) => i.href);

describe("navigation for Work Orders and GIS (W-01, K-04)", () => {
  it("shows Work orders at level basic (GIS alone) and full, never with neither module", () => {
    const perms: Permission[] = ["work_orders:execute"];
    expect(hrefs(["gis"], perms)).toContain("/work-orders");
    expect(hrefs(["work-orders"], perms)).toContain("/work-orders");
    expect(hrefs(["accounts"], perms)).not.toContain("/work-orders");
  });

  it("needs some work-order permission", () => {
    expect(hrefs(["work-orders", "gis"], ["accounts:read"])).not.toContain("/work-orders");
    expect(hrefs(["work-orders"], ["work_orders:read"])).toContain("/work-orders");
  });

  it("shows crews only with the Work Orders module, reviews only to reviewers", () => {
    const perms: Permission[] = ["work_orders:read", "work_orders:review"];
    expect(hrefs(["gis"], perms)).not.toContain("/work-orders/crews");
    expect(hrefs(["work-orders"], perms)).toContain("/work-orders/crews");
    expect(hrefs(["work-orders"], perms)).toContain("/work-orders/reviews");
    expect(hrefs(["work-orders"], ["work_orders:execute"])).not.toContain("/work-orders/reviews");
  });

  it("gates the map by the GIS licence and gis:read, and pending changes by gis:post", () => {
    expect(hrefs(["gis"], ["gis:read"])).toContain("/map");
    expect(hrefs(["gis"], ["gis:read"])).not.toContain("/map/reconcile");
    expect(hrefs(["gis"], ["gis:read", "gis:post"])).toContain("/map/reconcile");
    expect(hrefs(["work-orders"], ["gis:read", "gis:post"])).not.toContain("/map");
  });

  it("marks only the most specific item as current", () => {
    const items = navFor(["work-orders", "gis"], ["work_orders:review", "gis:read", "gis:post"]);
    expect(currentHref("/work-orders/reviews", items)).toBe("/work-orders/reviews");
    expect(currentHref("/work-orders/abc", items)).toBe("/work-orders");
    expect(currentHref("/map/reconcile/wo-1", items)).toBe("/map/reconcile");
    expect(currentHref("/map", items)).toBe("/map");
  });
});
