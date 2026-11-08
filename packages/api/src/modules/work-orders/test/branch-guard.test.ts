import { effectivePermissions, type Permission, type WorkOrderStatus } from "@flowless/shared-types";
import { describe, expect, it } from "vitest";
import { decideBranchWrite } from "../link/branch-guard";

// Ported from Majimap's work-orders/test/branch-guard.test.ts, with permissions for roles.
const job = (status: WorkOrderStatus, assignedToUserId: string | null = "tech") => ({ status, assignedToUserId });
const tech = { userId: "tech", permissions: effectivePermissions("technician", []) };
const boss = (role: "owner" | "supervisor" | "gis_engineer") => ({ userId: "boss", permissions: effectivePermissions(role, []) as ReadonlySet<Permission> });

describe("decideBranchWrite", () => {
  it("lets the assignee write while the job is in progress", () => {
    expect(decideBranchWrite(job("in_progress"), tech)).toEqual({ allowed: true });
  });

  it("turns away a technician who isn't the assignee, however the job is going", () => {
    expect(decideBranchWrite(job("in_progress"), { ...tech, userId: "tech2" }).allowed).toBe(false);
    expect(decideBranchWrite(job("in_progress", null), tech).allowed).toBe(false);
  });

  it("keeps the assignee off the branch unless the job is actively being worked", () => {
    for (const status of ["pending", "blocked", "submitted"] as const) expect(decideBranchWrite(job(status), tech).allowed, status).toBe(false);
  });

  it("lets managers fix things at any point before the job is finished", () => {
    for (const role of ["owner", "supervisor", "gis_engineer"] as const) {
      for (const status of ["pending", "in_progress", "blocked", "submitted"] as const) {
        expect(decideBranchWrite(job(status), boss(role)).allowed, `${role} ${status}`).toBe(true);
      }
    }
  });

  it("closes the branch once the job is completed or cancelled, for everyone", () => {
    for (const status of ["completed", "cancelled"] as const) {
      expect(decideBranchWrite(job(status), tech).allowed, status).toBe(false);
      expect(decideBranchWrite(job(status), boss("owner")).allowed, status).toBe(false);
    }
  });
});
