import { describe, expect, it } from "vitest";
import { DEFAULT_ROLES, effectivePermissions, isPermission, parseRoles, PERMISSIONS } from "./permissions";

// K-03: default roles with permission arrays, plus per-member extra grants.
describe("permissions", () => {
  it("every role default is in the catalogue", () => {
    for (const permissions of Object.values(DEFAULT_ROLES)) {
      for (const p of permissions) expect(isPermission(p)).toBe(true);
    }
  });

  it("owners and admins hold every permission", () => {
    expect(effectivePermissions("owner").size).toBe(PERMISSIONS.length);
    expect(effectivePermissions("admin").size).toBe(PERMISSIONS.length);
  });

  it("an extra grant adds to the role's defaults", () => {
    const clerk = effectivePermissions("clerk");
    expect(clerk.has("billing:approve")).toBe(false);
    const flexibleClerk = effectivePermissions("clerk", ["billing:approve"]);
    expect(flexibleClerk.has("billing:approve")).toBe(true);
    expect(flexibleClerk.size).toBe(clerk.size + 1);
  });

  it("combines comma-separated roles and ignores unknown roles and permissions", () => {
    expect(parseRoles("cashier, collector,ghost")).toEqual(["cashier", "collector"]);
    const both = effectivePermissions("cashier,collector", ["retired:permission"]);
    expect(both.has("payments:receipt")).toBe(true);
    expect(both.has("collections:manage")).toBe(true);
    expect([...both].every(isPermission)).toBe(true);
    expect(effectivePermissions("ghost").size).toBe(0);
  });

  // W-01, G-01: GIS and work-order permissions for the roles that do field and network work.
  it("the GIS engineer keeps the network and reviews its jobs, without settings or billing", () => {
    const gis = effectivePermissions("gis_engineer");
    for (const p of ["gis:read", "gis:edit", "gis:delete", "gis:post", "gis:configure"] as const) expect(gis.has(p)).toBe(true);
    for (const p of ["work_orders:read", "work_orders:assign", "work_orders:review", "work_orders:execute"] as const) expect(gis.has(p)).toBe(true);
    expect(gis.has("work_orders:cancel")).toBe(false);
    expect(gis.has("settings:manage")).toBe(false);
    expect(gis.has("billing:run")).toBe(false);
    expect([...gis].sort()).toEqual([...DEFAULT_ROLES.gis_engineer].sort());
  });

  it("supervisors review and cancel jobs; technicians edit GIS but never post it", () => {
    const supervisor = effectivePermissions("supervisor");
    expect((["work_orders:review", "work_orders:cancel", "gis:read"] as const).every((p) => supervisor.has(p))).toBe(true);
    expect(supervisor.has("gis:edit")).toBe(false);
    const technician = effectivePermissions("technician");
    expect(technician.has("gis:read") && technician.has("gis:edit")).toBe(true);
    expect(technician.has("gis:post")).toBe(false);
    expect(technician.has("work_orders:review")).toBe(false);
  });

  it("managers pick up the new GIS and work-order permissions", () => {
    const manager = effectivePermissions("manager");
    expect(manager.has("gis:configure") && manager.has("work_orders:cancel")).toBe(true);
  });
});
