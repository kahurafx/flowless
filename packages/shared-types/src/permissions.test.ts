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
});
