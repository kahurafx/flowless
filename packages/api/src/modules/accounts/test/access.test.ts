import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember } from "../../../test-support";
import { placementInScope } from "../access";
import { expectCode, setupAccountsEnv, type AccountsEnv } from "./test-support";

let env: AccountsEnv;
beforeAll(async () => {
  env = await setupAccountsEnv();
});
afterAll(() => env?.t.stop());

const sampleCustomer = (caller = env.clerk()) => env.person(caller, `Sample ${randomUUID().slice(0, 6)}`);

// K-03, K-04, NF-01: who may do what, which tenant, which licence.
describe("permissions", () => {
  it("lets read-only roles read and refuses every write (cashier, supervisor)", async () => {
    const c = await sampleCustomer();
    const a = await env.clerk().accounts.create({ customerId: c.id });
    const sp = await env.clerk().accounts.servicePoints.create({ accountId: a.id, address: "Plot 1" });
    for (const caller of [env.cashier(), env.supervisor()]) {
      expect((await caller.accounts.customers.get({ id: c.id })).id).toBe(c.id);
      expect((await caller.accounts.get({ id: a.id })).id).toBe(a.id);
      expect((await caller.accounts.servicePoints.get({ id: sp.id })).id).toBe(sp.id);
      expect(await caller.accounts.customers.search({ q: "Sample" })).toBeTruthy();
      expect((await caller.accounts.nextNumberPreview()).next).toBeTruthy();
      await expectCode(caller.accounts.customers.create({ type: "person", name: "No" }), "FORBIDDEN");
      await expectCode(caller.accounts.customers.update({ id: c.id, patch: { name: "No" } }), "FORBIDDEN");
      await expectCode(caller.accounts.contacts.add({ customerId: c.id, channel: "email", value: "no@no.test" }), "FORBIDDEN");
      await expectCode(caller.accounts.contacts.update({ id: randomUUID(), patch: { kind: "work" } }), "FORBIDDEN");
      await expectCode(caller.accounts.contacts.remove({ id: randomUUID() }), "FORBIDDEN");
      await expectCode(caller.accounts.create({ customerId: c.id }), "FORBIDDEN");
      await expectCode(caller.accounts.servicePoints.create({ accountId: a.id, address: "No" }), "FORBIDDEN");
      await expectCode(caller.accounts.servicePoints.update({ id: sp.id, patch: { address: "No" } }), "FORBIDDEN");
    }
  });

  it("lets a clerk create and update, and an extra grant extend a read-only role", async () => {
    const c = await sampleCustomer();
    await expect(env.clerk().accounts.customers.update({ id: c.id, patch: { notes: "ok" } })).resolves.toMatchObject({ notes: "ok" });
    await env.admin.access.grant({ userId: env.users.cashier, permission: "accounts:create" });
    await expect(env.cashier().accounts.customers.create({ type: "person", name: "Granted" })).resolves.toBeTruthy();
    await expectCode(env.cashier().accounts.customers.update({ id: c.id, patch: { notes: "no" } }), "FORBIDDEN");
  });

  it("refuses a member whose role has no accounts permission", async () => {
    const nobody = await addMember(env.t, env.orgA, "nobody");
    await expectCode(env.as(nobody).accounts.customers.list(), "FORBIDDEN");
    await expectCode(env.as(nobody).accounts.nextNumberPreview(), "FORBIDDEN");
  });

  it("answers NOT_FOUND to an organization that is not licensed for accounts", async () => {
    await expectCode(env.bare().accounts.customers.list(), "NOT_FOUND");
    await expectCode(env.bare().accounts.create({ customerId: randomUUID() }), "NOT_FOUND");
    await expectCode(env.bare().accounts.servicePoints.list(), "NOT_FOUND");
    await expectCode(env.bare().accounts.contacts.remove({ id: randomUUID() }), "NOT_FOUND");
  });
});

describe("tenant isolation (NF-01)", () => {
  it("keeps tenants' customers, accounts, numbers and service points apart", async () => {
    const mine = await sampleCustomer();
    const a = await env.clerk().accounts.create({ customerId: mine.id });
    const sp = await env.clerk().accounts.servicePoints.create({ accountId: a.id, address: "A's plot" });
    const theirs = await env.outsider().accounts.customers.create({ type: "person", name: "Outsider", contacts: [{ channel: "phone", value: "0766 000 111" }] });
    const theirAccount = await env.outsider().accounts.create({ customerId: theirs.id });

    await expectCode(env.outsider().accounts.customers.get({ id: mine.id }), "NOT_FOUND");
    await expectCode(env.outsider().accounts.get({ id: a.id }), "NOT_FOUND");
    await expectCode(env.outsider().accounts.get({ number: a.number }), "NOT_FOUND");
    await expectCode(env.outsider().accounts.servicePoints.get({ id: sp.id }), "NOT_FOUND");
    await expectCode(env.outsider().accounts.create({ customerId: mine.id }), "NOT_FOUND");
    await expectCode(env.outsider().accounts.create({ customerId: theirs.id, parentAccountId: a.id }), "NOT_FOUND");
    await expectCode(env.outsider().accounts.servicePoints.create({ accountId: a.id, address: "Hijack" }), "NOT_FOUND");
    await expectCode(env.outsider().accounts.servicePoints.update({ id: sp.id, patch: { address: "Hijack" } }), "NOT_FOUND");
    await expectCode(env.outsider().accounts.customers.update({ id: mine.id, patch: { name: "Hijack" } }), "NOT_FOUND");
    expect((await env.outsider().accounts.customers.list({ limit: 200 })).map((c) => c.id)).toEqual([theirs.id]);
    expect((await env.outsider().accounts.list({ limit: 200 })).map((x) => x.id)).toEqual([theirAccount.id]);
    // The same phone in two tenants is not a duplicate across them.
    await env.person(env.clerk(), "Same phone", { contacts: [{ channel: "phone", value: "0766000111" }] });
    expect((await env.outsider().accounts.customers.duplicates({ phone: "0766 000 111" })).map((m) => m.customer.id)).toEqual([theirs.id]);
    // Each tenant has its own counter: B's first number is the format's start.
    expect(theirAccount.number).toMatch(/^1001\d$/);
    expect((await env.outsider().accounts.search({ q: "Sample" }))).toEqual([]);
  });
});

describe("scope restrictions (K-03)", () => {
  /** An unrestricted clerk's records, in the zone, in the other zone and in the other scheme. */
  async function seed() {
    const make = async (name: string, place: Record<string, string>) => {
      const customer = await env.person(env.clerk(), name, { contacts: [{ channel: "phone", value: `07${Math.floor(10_000_000 + Math.random() * 89_999_999)}` }] });
      const account = await env.clerk().accounts.create({ customerId: customer.id });
      const point = await env.clerk().accounts.servicePoints.create({ accountId: account.id, address: `${name} plot`, ...place });
      return { customer, account, point };
    };
    return {
      inZone: await make("Scoped In Zone", { zoneId: env.areas.zone, dmaId: env.areas.dma }),
      onRoute: await make("Scoped On Route", { routeId: env.routes.route }),
      otherZone: await make("Scoped Other Zone", { zoneId: env.areas.otherZone }),
      otherScheme: await make("Scoped Other Scheme", { schemeId: env.areas.otherScheme, routeId: env.routes.otherRoute }),
    };
  }

  it("limits a member to the accounts, customers and service points in their areas and routes", async () => {
    const data = await seed();
    const limited = await addMember(env.t, env.orgA, "clerk");
    await env.admin.access.setScope({ userId: limited.userId, areaIds: [env.areas.zone], routeIds: [] });
    const asLimited = env.as(limited);

    const visibleAccounts = (await asLimited.accounts.list({ limit: 200 })).map((a) => a.id);
    expect(visibleAccounts).toContain(data.inZone.account.id);
    for (const hidden of [data.otherZone, data.otherScheme, data.onRoute]) expect(visibleAccounts).not.toContain(hidden.account.id);

    await expect(asLimited.accounts.get({ id: data.inZone.account.id })).resolves.toBeTruthy();
    for (const hidden of [data.otherZone, data.otherScheme, data.onRoute]) {
      await expectCode(asLimited.accounts.get({ id: hidden.account.id }), "NOT_FOUND");
      await expectCode(asLimited.accounts.get({ number: hidden.account.number }), "NOT_FOUND");
      await expectCode(asLimited.accounts.servicePoints.get({ id: hidden.point.id }), "NOT_FOUND");
      await expectCode(asLimited.accounts.customers.get({ id: hidden.customer.id }), "NOT_FOUND");
      await expectCode(asLimited.accounts.servicePoints.update({ id: hidden.point.id, patch: { address: "No" } }), "NOT_FOUND");
      await expectCode(asLimited.accounts.customers.update({ id: hidden.customer.id, patch: { notes: "No" } }), "NOT_FOUND");
      await expectCode(asLimited.accounts.contacts.add({ customerId: hidden.customer.id, channel: "email", value: "no@no.test" }), "NOT_FOUND");
      await expectCode(asLimited.accounts.create({ customerId: hidden.customer.id }), "NOT_FOUND");
      await expectCode(asLimited.accounts.servicePoints.create({ accountId: hidden.account.id, address: "No", zoneId: env.areas.zone }), "NOT_FOUND");
    }
    expect((await asLimited.accounts.servicePoints.list({ limit: 200 })).map((s) => s.id)).toEqual([data.inZone.point.id]);
    expect((await asLimited.accounts.customers.list({ limit: 200 })).map((c) => c.id)).toContain(data.inZone.customer.id);
    expect((await asLimited.accounts.customers.list({ limit: 200 })).map((c) => c.id)).not.toContain(data.otherZone.customer.id);
    expect(await asLimited.accounts.search({ q: "Scoped Other" })).toEqual([]);
    expect((await asLimited.accounts.search({ q: "Scoped In" })).map((a) => a.id)).toEqual([data.inZone.account.id]);
    expect(await asLimited.accounts.customers.search({ q: "Scoped Other" })).toEqual([]);
    // Duplicate checks do not reveal what the member cannot see.
    const hiddenPhone = (await env.admin.accounts.customers.get({ id: data.otherZone.customer.id })).phone!;
    expect(await asLimited.accounts.customers.duplicates({ phone: hiddenPhone })).toEqual([]);
    expect((await env.clerk().accounts.customers.duplicates({ phone: hiddenPhone })).map((m) => m.customer.id)).toEqual([data.otherZone.customer.id]);
    // Filtering by an area outside the scope finds nothing for them.
    expect(await asLimited.accounts.list({ areaId: env.areas.otherZone })).toEqual([]);
  });

  it("covers a route by its id, and everything below an area", async () => {
    const data = await seed();
    const onRouteOnly = await addMember(env.t, env.orgA, "clerk");
    await env.admin.access.setScope({ userId: onRouteOnly.userId, areaIds: [], routeIds: [env.routes.route] });
    const asRoute = env.as(onRouteOnly);
    const onRoute = (await asRoute.accounts.list({ limit: 200 })).map((a) => a.id);
    expect(onRoute).toContain(data.onRoute.account.id);
    for (const hidden of [data.inZone, data.otherZone, data.otherScheme]) expect(onRoute).not.toContain(hidden.account.id);

    const onScheme = await addMember(env.t, env.orgA, "clerk");
    await env.admin.access.setScope({ userId: onScheme.userId, areaIds: [env.areas.scheme], routeIds: [] });
    const ids = (await env.as(onScheme).accounts.list({ limit: 200 })).map((a) => a.id);
    expect(ids).toEqual(expect.arrayContaining([data.inZone.account.id, data.otherZone.account.id]));
    expect(ids).not.toContain(data.otherScheme.account.id);
  });

  it("lets a limited member finish what they started, and place service points only inside their scope", async () => {
    const limited = await addMember(env.t, env.orgA, "clerk");
    await env.admin.access.setScope({ userId: limited.userId, areaIds: [env.areas.zone], routeIds: [] });
    const asLimited = env.as(limited);
    const customer = await asLimited.accounts.customers.create({ type: "person", name: "Enquiry Ahmed" });
    // No account yet: visible to its creator only.
    await expect(asLimited.accounts.customers.get({ id: customer.id })).resolves.toBeTruthy();
    const account = await asLimited.accounts.create({ customerId: customer.id });
    await expect(asLimited.accounts.get({ id: account.id })).resolves.toBeTruthy();
    // The admin sees it too, and the limited member cannot place it elsewhere.
    await expect(env.admin.accounts.get({ id: account.id })).resolves.toBeTruthy();
    await expectCode(asLimited.accounts.servicePoints.create({ accountId: account.id, address: "No place" }), "FORBIDDEN");
    await expectCode(asLimited.accounts.servicePoints.create({ accountId: account.id, address: "Elsewhere", zoneId: env.areas.otherZone }), "FORBIDDEN");
    await expectCode(asLimited.accounts.servicePoints.create({ accountId: account.id, address: "Other route", routeId: env.routes.otherRoute }), "FORBIDDEN");
    const placed = await asLimited.accounts.servicePoints.create({ accountId: account.id, address: "In scope", dmaId: env.areas.dma });
    await expectCode(asLimited.accounts.servicePoints.update({ id: placed.id, patch: { dmaId: null, zoneId: env.areas.otherZone } }), "FORBIDDEN");
    await expect(asLimited.accounts.servicePoints.update({ id: placed.id, patch: { address: "Renamed in scope" } })).resolves.toBeTruthy();
    await expect(asLimited.accounts.servicePoints.update({ id: placed.id, patch: { routeId: env.routes.route } })).resolves.toBeTruthy();
  });

  it("the pure rule agrees: any of scheme, zone, DMA or route in scope", () => {
    const scope = { kind: "limited", areaIds: new Set(["z1"]), routeIds: new Set(["r1"]) } as const;
    const none = { schemeId: null, zoneId: null, dmaId: null, routeId: null };
    expect(placementInScope({ kind: "all" }, none)).toBe(true);
    expect(placementInScope(scope, none)).toBe(false);
    expect(placementInScope(scope, { ...none, zoneId: "z1" })).toBe(true);
    expect(placementInScope(scope, { ...none, dmaId: "z1" })).toBe(true);
    expect(placementInScope(scope, { ...none, schemeId: "z2", routeId: "r1" })).toBe(true);
    expect(placementInScope(scope, { ...none, schemeId: "z2", routeId: "r2" })).toBe(false);
  });
});
