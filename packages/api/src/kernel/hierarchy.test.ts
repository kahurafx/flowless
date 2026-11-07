import { memberAreaScope } from "@flowless/db";
import { startTestDatabase, tenants, type TestDatabase } from "@flowless/db/testing";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCallerFactory, router, tenantProcedure } from "../trpc";
import { addMember, callerFor, sessionOf, type Member } from "../test-support";

let t: TestDatabase;
let owner: Member;
beforeAll(async () => {
  t = await startTestDatabase();
  owner = await addMember(t, tenants.a.id, "owner");
});
afterAll(() => t?.stop());

const as = (m: Member) => callerFor(t, m);
let n = 0;
const uniqueCode = (prefix: string) => `${prefix}${++n}`;

/** scheme → zone → (sub-zone) → DMA, plus a route group and route in the zone. */
async function tree() {
  const api = as(owner).hierarchy;
  const scheme = await api.createArea({ level: "scheme", code: uniqueCode("S"), name: "Ruiru scheme" });
  const zone = await api.createArea({ level: "zone", code: uniqueCode("Z"), name: "Kahawa West", parentId: scheme.id });
  const subZone = await api.createArea({ level: "sub_zone", code: uniqueCode("SZ"), name: "Kahawa Phase 2", parentId: zone.id });
  const dma = await api.createArea({ level: "dma", code: uniqueCode("D"), name: "DMA 4", parentId: subZone.id });
  const group = await api.createRoute({ code: uniqueCode("G"), name: "North readers", areaId: zone.id });
  const routeA = await api.createRoute({ code: uniqueCode("R"), name: "R-07", parentId: group.id });
  return { scheme, zone, subZone, dma, group, routeA };
}

// K-02: organization hierarchy and routes.
describe("hierarchy", () => {
  it("builds a tree and allows skipping levels the organization does not use", async () => {
    const { zone } = await tree();
    const dmaUnderZone = await as(owner).hierarchy.createArea({ level: "dma", code: uniqueCode("D"), name: "DMA 9", parentId: zone.id });
    expect(dmaUnderZone.parentId).toBe(zone.id);
  });

  it("rejects a parent at the same or a lower level, and a missing parent", async () => {
    const { zone, dma } = await tree();
    const api = as(owner).hierarchy;
    await expect(api.createArea({ level: "zone", code: uniqueCode("Z"), name: "x", parentId: zone.id })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(api.createArea({ level: "sub_zone", code: uniqueCode("SZ"), name: "x", parentId: dma.id })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(api.createArea({ level: "zone", code: uniqueCode("Z"), name: "x" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("never lets an area or route sit under itself", async () => {
    const { scheme, zone, group, routeA } = await tree();
    const other = await as(owner).hierarchy.createArea({ level: "scheme", code: uniqueCode("S"), name: "Other" });
    await as(owner).hierarchy.updateArea({ id: zone.id, parentId: other.id }); // a valid move
    await expect(as(owner).hierarchy.updateArea({ id: scheme.id, parentId: zone.id })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(as(owner).hierarchy.updateRoute({ id: group.id, parentId: routeA.id })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("keeps codes unique per level within an organization, not across organizations", async () => {
    const code = uniqueCode("SAME");
    await as(owner).hierarchy.createArea({ level: "scheme", code, name: "One" });
    await expect(as(owner).hierarchy.createArea({ level: "scheme", code, name: "Two" })).rejects.toMatchObject({ code: "CONFLICT" });
    await as(owner).hierarchy.createArea({ level: "zone", code, name: "Zone with the scheme's code", parentId: (await tree()).scheme.id });

    const ownerB = await addMember(t, tenants.b.id, "owner");
    await expect(as(ownerB).hierarchy.createArea({ level: "scheme", code, name: "B's own" })).resolves.toBeTruthy();
  });

  it("cannot use another organization's area as a parent (NF-01)", async () => {
    const ownerB = await addMember(t, tenants.b.id, "owner");
    const { scheme } = await tree();
    await expect(
      as(ownerB).hierarchy.createArea({ level: "zone", code: uniqueCode("Z"), name: "x", parentId: scheme.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await as(ownerB).hierarchy.areas()).some((a) => a.id === scheme.id)).toBe(false);
  });

  it("archives only leaves, hides them by default, and restores top-down", async () => {
    const { scheme, zone, subZone, dma, group, routeA } = await tree();
    const api = as(owner).hierarchy;
    await expect(api.archiveArea({ id: subZone.id })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await api.archiveArea({ id: dma.id });
    await api.archiveArea({ id: subZone.id });
    await expect(api.archiveArea({ id: zone.id })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" }); // route group points at it
    await api.archiveRoute({ id: routeA.id });
    await api.archiveRoute({ id: group.id });
    await api.archiveArea({ id: zone.id });

    expect((await api.areas()).map((a) => a.id)).not.toContain(zone.id);
    expect((await api.areas({ includeArchived: true })).map((a) => a.id)).toContain(zone.id);
    await expect(api.restoreArea({ id: dma.id })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await api.restoreArea({ id: zone.id });
    await expect(api.createArea({ level: "dma", code: uniqueCode("D"), name: "x", parentId: subZone.id })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect(scheme.parentId).toBeNull();
  });

  it("everyone reads the hierarchy; only settings:manage changes it", async () => {
    const technician = await addMember(t, tenants.a.id, "technician");
    await expect(as(technician).hierarchy.areas()).resolves.toBeInstanceOf(Array);
    await expect(
      as(technician).hierarchy.createArea({ level: "scheme", code: uniqueCode("S"), name: "x" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

// K-03: optional per-scope restrictions by scheme, zone or route.
describe("scope restrictions", () => {
  const scopeProbe = router({ scope: tenantProcedure.query(({ ctx }) => ctx.scope()) });
  const scopeOf = (m: Member) => createCallerFactory(scopeProbe)({ db: t.app, session: sessionOf(m) }).scope();

  it("members are unrestricted until given a scope", async () => {
    const clerk = await addMember(t, tenants.a.id, "clerk");
    expect(await scopeOf(clerk)).toEqual({ kind: "all" });
  });

  it("an area scope covers everything below it; a route scope covers its sub-routes", async () => {
    const { scheme, zone, subZone, dma, group, routeA } = await tree();
    const reader = await addMember(t, tenants.a.id, "technician");
    await as(owner).access.setScope({ userId: reader.userId, areaIds: [zone.id], routeIds: [group.id] });

    const scope = await scopeOf(reader);
    expect(scope.kind).toBe("limited");
    if (scope.kind !== "limited") return;
    expect([...scope.areaIds].sort()).toEqual([zone.id, subZone.id, dma.id].sort());
    expect(scope.areaIds.has(scheme.id)).toBe(false);
    expect([...scope.routeIds].sort()).toEqual([group.id, routeA.id].sort());

    const me = await as(reader).access.me();
    expect(me.scope).toMatchObject({ kind: "limited" });
    expect(await as(owner).access.scopes()).toContainEqual({ userId: reader.userId, areaIds: [zone.id], routeIds: [group.id] });
  });

  it("empty lists make a member unrestricted again", async () => {
    const { zone } = await tree();
    const clerk = await addMember(t, tenants.a.id, "clerk");
    await as(owner).access.setScope({ userId: clerk.userId, areaIds: [zone.id], routeIds: [] });
    await as(owner).access.setScope({ userId: clerk.userId, areaIds: [], routeIds: [] });
    expect(await scopeOf(clerk)).toEqual({ kind: "all" });
  });

  it("a restricted manager can only give scope inside their own, and never unrestricted", async () => {
    const { scheme, zone, dma } = await tree();
    const supervisor = await addMember(t, tenants.a.id, "supervisor");
    const technician = await addMember(t, tenants.a.id, "technician");
    await as(owner).access.grant({ userId: supervisor.userId, permission: "access:manage" });
    await as(owner).access.setScope({ userId: supervisor.userId, areaIds: [zone.id], routeIds: [] });

    await as(supervisor).access.setScope({ userId: technician.userId, areaIds: [dma.id], routeIds: [] });
    await expect(
      as(supervisor).access.setScope({ userId: technician.userId, areaIds: [scheme.id], routeIds: [] }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      as(supervisor).access.setScope({ userId: technician.userId, areaIds: [], routeIds: [] }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("cannot scope a member to another organization's area", async () => {
    const { zone } = await tree();
    const ownerB = await addMember(t, tenants.b.id, "owner");
    const clerkB = await addMember(t, tenants.b.id, "clerk");
    await expect(
      as(ownerB).access.setScope({ userId: clerkB.userId, areaIds: [zone.id], routeIds: [] }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("scope rows go when the member leaves", async () => {
    const { zone } = await tree();
    const collector = await addMember(t, tenants.a.id, "collector");
    await as(owner).access.setScope({ userId: collector.userId, areaIds: [zone.id], routeIds: [] });
    await t.auth.execute(sql`delete from auth.member where user_id = ${collector.userId}`);
    expect(await t.admin.select().from(memberAreaScope).where(eq(memberAreaScope.userId, collector.userId))).toEqual([]);
  });
});
