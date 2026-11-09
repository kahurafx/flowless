import { outboxEvent } from "@flowless/db";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectCode, setupAccountsEnv, type AccountsEnv } from "./test-support";

let env: AccountsEnv;
let accountId: string;
beforeAll(async () => {
  env = await setupAccountsEnv();
  accountId = (await env.clerk().accounts.create({ customerId: (await env.person(env.clerk(), "Point Owner")).id })).id;
});
afterAll(() => env?.t.stop());

const GPS = { lat: -1.1855, lng: 36.9304 };

// Glossary: a service point is the physical connection (GPS, scheme, zone, DMA, route).
describe("service points", () => {
  it("creates a service point with GPS, the kernel hierarchy and route, a status and a GIS link; audits and publishes", async () => {
    const gisConnectionId = randomUUID();
    const sp = await env.clerk().accounts.servicePoints.create({
      accountId,
      address: "  Plot 12,   Kamiti Road ",
      location: GPS,
      schemeId: env.areas.scheme,
      zoneId: env.areas.zone,
      dmaId: env.areas.dma,
      routeId: env.routes.route,
      gisConnectionId,
    });
    expect(sp).toMatchObject({
      accountId,
      address: "Plot 12, Kamiti Road",
      location: GPS,
      schemeId: env.areas.scheme,
      zoneId: env.areas.zone,
      dmaId: env.areas.dma,
      routeId: env.routes.route,
      connectionStatus: "PLANNED",
      gisConnectionId,
    });
    expect(await env.clerk().accounts.servicePoints.get({ id: sp.id })).toEqual(sp);
    expect((await env.audit(sp.id)).map((e) => e.action)).toEqual(["accounts.service_point_create"]);
    const [event] = (await env.db.select().from(outboxEvent).where(eq(outboxEvent.type, "accounts.service_point_created"))).filter((e) => (e.payload as { servicePointId: string }).servicePointId === sp.id);
    expect(event).toMatchObject({ version: 1, payload: { accountId, dmaId: env.areas.dma, routeId: env.routes.route, location: GPS, gisConnectionId, connectionStatus: "PLANNED" } });
    expect((await env.clerk().accounts.get({ id: accountId })).servicePoints.map((s) => s.id)).toContain(sp.id);
  });

  it("needs only an address; the place and the GPS point are optional", async () => {
    const sp = await env.clerk().accounts.servicePoints.create({ accountId, address: "Somewhere" });
    expect(sp).toMatchObject({ location: null, schemeId: null, zoneId: null, dmaId: null, routeId: null, gisConnectionId: null });
    await expectCode(env.clerk().accounts.servicePoints.create({ accountId, address: "   " }), "BAD_REQUEST");
    await expectCode(env.clerk().accounts.servicePoints.create({ accountId, address: "x", location: { lat: 91, lng: 0 } }), "BAD_REQUEST");
    await expectCode(env.clerk().accounts.servicePoints.create({ accountId: randomUUID(), address: "x" }), "NOT_FOUND");
  });

  it("checks every place against the kernel hierarchy through its published reads", async () => {
    const create = (extra: Record<string, string>) => env.clerk().accounts.servicePoints.create({ accountId, address: "Checked", ...extra });
    // Unknown, other tenant's, wrong level.
    await expectCode(create({ schemeId: randomUUID() }), "NOT_FOUND");
    const theirs = await env.outsider().hierarchy.createArea({ level: "scheme", code: "B1", name: "B scheme" });
    await expectCode(create({ schemeId: theirs.id }), "NOT_FOUND");
    const theirRoute = await env.outsider().hierarchy.createRoute({ code: "B-R", name: "B route" });
    await expectCode(create({ routeId: theirRoute.id }), "NOT_FOUND");
    await expectCode(create({ routeId: randomUUID() }), "NOT_FOUND");
    await expectCode(create({ schemeId: env.areas.zone }), "BAD_REQUEST");
    await expectCode(create({ zoneId: env.areas.dma }), "BAD_REQUEST");
    await expectCode(create({ dmaId: env.areas.zone }), "BAD_REQUEST");
    // Off the branch: the DMA is not in the other zone, the zone is not in the other scheme.
    await expectCode(create({ zoneId: env.areas.otherZone, dmaId: env.areas.dma }), "BAD_REQUEST");
    await expectCode(create({ schemeId: env.areas.otherScheme, zoneId: env.areas.zone }), "BAD_REQUEST");
    await expectCode(create({ schemeId: env.areas.otherScheme, dmaId: env.areas.dma }), "BAD_REQUEST");
    // A DMA straight under its scheme's zone, or alone, is fine.
    await expect(create({ dmaId: env.areas.dma })).resolves.toMatchObject({ dmaId: env.areas.dma, schemeId: null });
    await expect(create({ schemeId: env.areas.scheme, dmaId: env.areas.dma })).resolves.toBeTruthy();
  });

  it("refuses an archived area or route for new use but leaves an existing point editable", async () => {
    const zone = await env.admin.hierarchy.createArea({ level: "zone", code: "ARCH-Z", name: "Soon archived", parentId: env.areas.scheme });
    const route = await env.admin.hierarchy.createRoute({ code: "ARCH-R", name: "Soon archived route" });
    const sp = await env.clerk().accounts.servicePoints.create({ accountId, address: "Before archive", zoneId: zone.id, routeId: route.id });
    await env.admin.hierarchy.archiveArea({ id: zone.id });
    await env.admin.hierarchy.archiveRoute({ id: route.id });
    await expectCode(env.clerk().accounts.servicePoints.create({ accountId, address: "x", zoneId: zone.id }), "PRECONDITION_FAILED");
    await expectCode(env.clerk().accounts.servicePoints.create({ accountId, address: "x", routeId: route.id }), "PRECONDITION_FAILED");
    await env.clerk().accounts.servicePoints.update({ id: sp.id, patch: { routeId: env.routes.route } });
    await expectCode(env.clerk().accounts.servicePoints.update({ id: sp.id, patch: { routeId: route.id } }), "PRECONDITION_FAILED");
    await expect(env.clerk().accounts.servicePoints.update({ id: sp.id, patch: { address: "After archive" } })).resolves.toMatchObject({ address: "After archive", zoneId: zone.id });
  });

  it("updates a service point, null clears, audits before and after, and writes nothing for no change", async () => {
    const sp = await env.clerk().accounts.servicePoints.create({ accountId, address: "To change", location: GPS, routeId: env.routes.route });
    const changed = await env.clerk().accounts.servicePoints.update({
      id: sp.id,
      patch: { address: "Changed", location: null, connectionStatus: "CONNECTED", routeId: env.routes.otherRoute, gisConnectionId: randomUUID() },
    });
    expect(changed).toMatchObject({ address: "Changed", location: null, connectionStatus: "CONNECTED", routeId: env.routes.otherRoute });
    const updates = async () => (await env.audit(sp.id)).filter((e) => e.action === "accounts.service_point_update");
    expect(await updates()).toHaveLength(1);
    expect((await updates())[0]).toMatchObject({ before: { address: "To change", location: GPS, connectionStatus: "PLANNED" }, after: { address: "Changed", location: null, connectionStatus: "CONNECTED" } });
    await env.clerk().accounts.servicePoints.update({ id: sp.id, patch: { address: "Changed", connectionStatus: "CONNECTED" } });
    expect(await updates()).toHaveLength(1);
    await expectCode(env.clerk().accounts.servicePoints.update({ id: sp.id, patch: {} }), "BAD_REQUEST");
    await expectCode(env.clerk().accounts.servicePoints.update({ id: sp.id, patch: { schemeId: env.areas.zone } }), "BAD_REQUEST");
    await expectCode(env.clerk().accounts.servicePoints.update({ id: sp.id, patch: { connectionStatus: "BROKEN" as never } }), "BAD_REQUEST");
    await expectCode(env.clerk().accounts.servicePoints.update({ id: randomUUID(), patch: { address: "x" } }), "NOT_FOUND");
  });

  it("lists by account, area (and everything below it), route and status, with a cursor", async () => {
    const owner = (await env.clerk().accounts.create({ customerId: (await env.person(env.clerk(), "Lister")).id })).id;
    const make = (address: string, extra: Record<string, unknown> = {}) => env.clerk().accounts.servicePoints.create({ accountId: owner, address, ...extra });
    const a = await make("One", { dmaId: env.areas.dma, routeId: env.routes.route });
    const b = await make("Two", { zoneId: env.areas.otherZone, connectionStatus: "CONNECTED" });
    const c = await make("Three", { schemeId: env.areas.otherScheme, routeId: env.routes.otherRoute });
    const ids = async (q: Record<string, unknown>) => (await env.clerk().accounts.servicePoints.list({ accountId: owner, ...q } as never)).map((s) => s.address);
    expect(await ids({})).toEqual(["One", "Two", "Three"]);
    // The scheme contains the DMA's point (it has only a DMA), through the hierarchy.
    expect(await ids({ areaId: env.areas.scheme })).toEqual(["One", "Two"]);
    expect(await ids({ areaId: env.areas.zone })).toEqual(["One"]);
    expect(await ids({ areaId: env.areas.otherScheme })).toEqual(["Three"]);
    expect(await ids({ routeId: env.routes.route })).toEqual(["One"]);
    expect(await ids({ connectionStatus: "CONNECTED" })).toEqual(["Two"]);
    expect(await ids({ limit: 2 })).toEqual(["One", "Two"]);
    expect(await ids({ limit: 2, after: b.id })).toEqual(["Three"]);
    expect([a.id, c.id]).not.toContain(b.id);
  });
});
