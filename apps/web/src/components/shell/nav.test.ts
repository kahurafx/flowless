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

  it("shows the Accounts group only with the module and accounts:read", () => {
    const group = ["/accounts", "/accounts/customers", "/accounts/applications", "/accounts/data-quality"];
    expect(hrefs(["accounts"], ["accounts:read"])).toEqual(expect.arrayContaining(group));
    expect(hrefs(["accounts"], ["exceptions:read"])).not.toContain("/accounts");
    for (const href of group) expect(hrefs(["work-orders"], ["accounts:read"])).not.toContain(href);
  });

  it("shows Approvals to every member, whatever is licensed", () => {
    expect(hrefs([], [])).toContain("/approvals");
  });

  it("marks the Accounts group's most specific item as current", () => {
    const items = navFor(["accounts"], ["accounts:read"]);
    expect(currentHref("/accounts/1008-4", items)).toBe("/accounts");
    expect(currentHref("/accounts/new", items)).toBe("/accounts");
    expect(currentHref("/accounts/customers/abc", items)).toBe("/accounts/customers");
    expect(currentHref("/accounts/applications/abc", items)).toBe("/accounts/applications");
  });

  it("marks only the most specific item as current", () => {
    const items = navFor(["work-orders", "gis"], ["work_orders:review", "gis:read", "gis:post"]);
    expect(currentHref("/work-orders/reviews", items)).toBe("/work-orders/reviews");
    expect(currentHref("/work-orders/abc", items)).toBe("/work-orders");
    expect(currentHref("/map/reconcile/wo-1", items)).toBe("/map/reconcile");
    expect(currentHref("/map", items)).toBe("/map");
  });
});

describe("navigation for Tariffs and the Accounts settings (F5b)", () => {
  const tariffs = ["/tariffs", "/tariffs/categories", "/tariffs/charges", "/tariffs/invoice-types"];

  it("shows the Tariffs group only with the module and tariffs:read", () => {
    expect(hrefs(["tariffs"], ["tariffs:read"])).toEqual(expect.arrayContaining(tariffs));
    for (const href of tariffs) {
      expect(hrefs(["accounts"], ["tariffs:read"])).not.toContain(href);
      expect(hrefs(["tariffs"], ["accounts:read"])).not.toContain(href);
    }
  });

  it("shows Data quality with Accounts and accounts:read, whatever else is licensed", () => {
    expect(hrefs(["accounts"], ["accounts:read"])).toContain("/accounts/data-quality");
    expect(hrefs(["tariffs"], ["accounts:read"])).not.toContain("/accounts/data-quality");
    expect(hrefs(["accounts"], ["tariffs:read"])).not.toContain("/accounts/data-quality");
  });

  it("shows Accounts settings to settings:manage with Accounts licensed", () => {
    expect(hrefs(["accounts"], ["settings:manage"])).toContain("/settings/accounts");
    expect(hrefs(["accounts"], ["accounts:read"])).not.toContain("/settings/accounts");
    expect(hrefs(["tariffs"], ["settings:manage"])).not.toContain("/settings/accounts");
  });

  it("marks the most specific Tariffs item as current", () => {
    const items = navFor(["tariffs", "accounts"], ["tariffs:read", "accounts:read"]);
    expect(currentHref("/tariffs/abc", items)).toBe("/tariffs");
    expect(currentHref("/tariffs/new", items)).toBe("/tariffs");
    expect(currentHref("/tariffs/categories", items)).toBe("/tariffs/categories");
    expect(currentHref("/tariffs/invoice-types/abc", items)).toBe("/tariffs/invoice-types");
    expect(currentHref("/accounts/data-quality", items)).toBe("/accounts/data-quality");
  });
  it("shows the Billing group only with Billing licensed and billing:read", () => {
    const group = ["/billing/cycles", "/billing/cases"];
    expect(hrefs(["billing"], ["billing:read"])).toEqual(expect.arrayContaining(group));
    for (const href of group) {
      expect(hrefs(["billing"], ["accounts:read"])).not.toContain(href);
      expect(hrefs(["accounts"], ["billing:read"])).not.toContain(href);
    }
  });

  it("shows the Metering group by licence and permission, and its settings to settings:manage", () => {
    expect(hrefs(["metering"], ["meters:read"])).toContain("/metering/meters");
    expect(hrefs(["metering"], ["meters:read"])).not.toContain("/metering/readings");
    expect(hrefs(["metering"], ["readings:read"])).toEqual(expect.arrayContaining(["/metering/readings", "/metering/visits", "/metering/rounds", "/metering/handovers"]));
    expect(hrefs(["billing"], ["meters:read", "readings:read"])).not.toContain("/metering/meters");
    expect(hrefs(["metering"], ["settings:manage"])).toContain("/settings/metering");
    expect(hrefs(["metering"], ["settings:manage"])).not.toContain("/settings/billing");
    expect(hrefs(["billing"], ["settings:manage"])).toContain("/settings/billing");
    expect(hrefs(["billing"], [])).not.toContain("/settings/billing");
  });

  it("shows Reports to reports:read whatever is licensed", () => {
    expect(hrefs([], ["reports:read"])).toContain("/reports");
    expect(hrefs(["billing"], ["billing:read"])).not.toContain("/reports");
  });
});
