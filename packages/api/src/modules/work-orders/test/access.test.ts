import { effectivePermissions, ROLES, workLevel, type Permission, type Scope } from "@flowless/shared-types";
import { describe, expect, it } from "vitest";
import { abilitiesOf, actsOnJobs, canActOn, canSeeJob, seesJobs, visibilityFor, type JobPlace } from "../access";

// Ported from Majimap's work-orders/test/access.test.ts: roles became permissions (K-03),
// and scope restrictions and crews were added.
const all: Scope = { kind: "all" };
const zoneA: Scope = { kind: "limited", areaIds: new Set(["zone-a"]), routeIds: new Set(["route-a"]) };
const can = (...permissions: Permission[]) => abilitiesOf(new Set(permissions));
const job = (over: Partial<JobPlace> = {}): JobPlace => ({ assignedToUserId: "u2", crewId: null, areaId: null, routeId: null, ...over });

describe("work level (Majimap's resolveLevel)", () => {
  it("is none without a module that provides work, basic with GIS alone, full with Work Orders", () => {
    expect(workLevel([])).toBe("none");
    expect(workLevel(["billing", "inventory"])).toBe("none");
    expect(workLevel(["gis"])).toBe("basic");
    expect(workLevel(["work-orders"])).toBe("full");
    expect(workLevel(["gis", "work-orders"])).toBe("full");
  });
});

describe("who sees jobs", () => {
  it("lets readers and managers see every job, and a member who only executes see their own", () => {
    for (const role of ["owner", "supervisor", "gis_engineer"] as const) {
      expect(visibilityFor(abilitiesOf(effectivePermissions(role, [])), "u1", [], all).all, role).toBe(true);
    }
    // Technicians execute without work_orders:read: their own jobs only (Majimap's field technician).
    expect(visibilityFor(abilitiesOf(effectivePermissions("technician", [])), "u1", [], all).all).toBe(false);
    const executor = visibilityFor(can("work_orders:execute"), "u1", [], all);
    expect(executor.all).toBe(false);
    expect(canSeeJob(executor, job({ assignedToUserId: "u1" }))).toBe(true);
    expect(canSeeJob(executor, job())).toBe(false);
    expect(canSeeJob(executor, job({ assignedToUserId: null })), "an unassigned job is the managers' pool").toBe(false);
  });

  it("turns away members with no work-order permission (Majimap's viewer)", () => {
    expect(seesJobs(abilitiesOf(effectivePermissions("cashier", [])))).toBe(false);
    expect(seesJobs(can("work_orders:read"))).toBe(true);
  });

  it("has an answer for every default role", () => {
    for (const role of ROLES) expect(typeof seesJobs(abilitiesOf(effectivePermissions(role, [])))).toBe("boolean");
  });

  it("shows a crew's jobs to its members", () => {
    const executor = visibilityFor(can("work_orders:execute"), "u1", ["crew-1"], all);
    expect(canSeeJob(executor, job({ crewId: "crew-1" }))).toBe(true);
    expect(canSeeJob(executor, job({ crewId: "crew-2" }))).toBe(false);
  });

  it("limits a scoped reader to jobs placed in their areas or routes, but always shows their own", () => {
    const scoped = visibilityFor(can("work_orders:read"), "u1", [], zoneA);
    expect(canSeeJob(scoped, job({ areaId: "zone-a" }))).toBe(true);
    expect(canSeeJob(scoped, job({ routeId: "route-a" }))).toBe(true);
    expect(canSeeJob(scoped, job({ areaId: "zone-b" }))).toBe(false);
    expect(canSeeJob(scoped, job()), "unplaced jobs are for unrestricted members").toBe(false);
    expect(canSeeJob(scoped, job({ assignedToUserId: "u1", areaId: "zone-b" }))).toBe(true);
  });
});

describe("who acts on jobs", () => {
  it("lets a manager act on any job they see, and anyone else only on their own or their crew's", () => {
    const manager = can("work_orders:assign");
    expect(canActOn(manager, visibilityFor(manager, "boss", [], all), job())).toBe(true);
    const tech = can("work_orders:read", "work_orders:execute");
    const v = visibilityFor(tech, "u1", ["crew-1"], all);
    expect(canActOn(tech, v, job({ assignedToUserId: "u1" }))).toBe(true);
    expect(canActOn(tech, v, job({ crewId: "crew-1" }))).toBe(true);
    expect(canActOn(tech, v, job()), "seeing a job is not working it").toBe(false);
    expect(canActOn(can("work_orders:read"), visibilityFor(can("work_orders:read"), "u1", [], all), job({ assignedToUserId: "u1" }))).toBe(false);
  });

  it("maps Majimap's act roles to execute or assign", () => {
    expect(actsOnJobs(can("work_orders:execute"))).toBe(true);
    expect(actsOnJobs(can("work_orders:assign"))).toBe(true);
    expect(actsOnJobs(can("work_orders:read", "work_orders:review"))).toBe(false);
  });
});
