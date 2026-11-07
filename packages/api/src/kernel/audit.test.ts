import { startTestDatabase, tenants, type TestDatabase } from "@flowless/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCaller } from "../root";
import { addMember, callerFor, sessionOf, type Member } from "../test-support";
import { createCallerFactory, router, tenantProcedure } from "../trpc";
import { setEntitlements } from "./entitlement-store";

let t: TestDatabase;
let owner: Member;
beforeAll(async () => {
  t = await startTestDatabase();
  owner = await addMember(t, tenants.a.id, "owner");
});
afterAll(() => t?.stop());

const as = (m: Member) => callerFor(t, m);
const entriesFor = async (subjectId: string) => (await as(owner).audit.list({ subjectId })).entries;

// K-06: immutable audit log; NF-07: complete and tamper-evident.
describe("audit log", () => {
  it("records who changed a member's permissions, from where, and what changed", async () => {
    const clerk = await addMember(t, tenants.a.id, "clerk");
    const mobileOwner = createCaller({ db: t.app, session: sessionOf(owner), source: "mobile" });
    await mobileOwner.access.grant({ userId: clerk.userId, permission: "billing:approve" });
    await mobileOwner.access.grant({ userId: clerk.userId, permission: "billing:approve" }); // no change, no entry
    await as(owner).access.revoke({ userId: clerk.userId, permission: "billing:approve" });

    const [revoked, granted, ...rest] = await entriesFor(clerk.userId);
    expect(rest).toEqual([]);
    expect(granted).toMatchObject({
      action: "access.grant",
      actorUserId: owner.userId,
      actorLabel: "owner",
      source: "mobile",
      subjectType: "member",
      after: { permission: "billing:approve" },
    });
    expect(revoked).toMatchObject({ action: "access.revoke", source: "api", before: { permission: "billing:approve" } });
  });

  it("records scope changes with before and after", async () => {
    const zone = await as(owner).hierarchy.createArea({ level: "scheme", code: "AUD1", name: "Audit scheme" });
    const reader = await addMember(t, tenants.a.id, "technician");
    await as(owner).access.setScope({ userId: reader.userId, areaIds: [zone.id], routeIds: [] });
    await as(owner).access.setScope({ userId: reader.userId, areaIds: [], routeIds: [] });
    const [cleared] = await entriesFor(reader.userId);
    expect(cleared).toMatchObject({ before: { areaIds: [zone.id], routeIds: [] }, after: { areaIds: [], routeIds: [] } });

    const [created] = await entriesFor(zone.id);
    expect(created).toMatchObject({ action: "hierarchy.create_area", after: { code: "AUD1", level: "scheme" } });
  });

  it("writes nothing for a change that fails or rolls back", async () => {
    const before = (await as(owner).audit.list()).entries[0]?.index;
    await expect(
      as(owner).hierarchy.createArea({ level: "zone", code: "NOPE", name: "No parent" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const failing = router({
      noteThenFail: tenantProcedure.mutation(async ({ ctx }) => {
        await ctx.audit({ action: "test.never" });
        throw new Error("boom");
      }),
    });
    await expect(createCallerFactory(failing)({ db: t.app, session: sessionOf(owner) }).noteThenFail()).rejects.toThrow("boom");
    expect((await as(owner).audit.list()).entries[0]?.index).toBe(before);
  });

  it("records licence changes as Flowless system actions", async () => {
    await setEntitlements(t.app, tenants.a.id, ["gis"], { label: "Onboarding", reason: "Pilot plan" });
    const [entry] = (await as(owner).audit.list({ actionPrefix: "entitlements." })).entries;
    expect(entry).toMatchObject({ source: "system", actorUserId: null, actorLabel: "Onboarding", reason: "Pilot plan", after: ["gis"] });
  });

  it("needs audit:read, which managers have and clerks do not", async () => {
    const clerk = await addMember(t, tenants.a.id, "clerk");
    const manager = await addMember(t, tenants.a.id, "manager");
    await expect(as(clerk).audit.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(as(manager).audit.list()).resolves.toBeTruthy();
  });

  it("pages newest first and never shows another tenant's entries (NF-01)", async () => {
    const page = await as(owner).audit.list({ limit: 2 });
    expect(page.entries).toHaveLength(2);
    expect(page.entries[0]!.index).toBeGreaterThan(page.entries[1]!.index);
    const next = await as(owner).audit.list({ limit: 2, before: page.next! });
    expect(next.entries[0]!.index).toBeLessThan(page.entries[1]!.index);

    const ownerB = await addMember(t, tenants.b.id, "owner");
    const seenByB = await as(ownerB).audit.list({ limit: 200 });
    expect(seenByB.entries.some((e) => e.actorUserId === owner.userId)).toBe(false);
  });

  it("verifies the organization's chain", async () => {
    const { checked, firstBroken } = await as(owner).audit.verify();
    expect(checked).toBeGreaterThan(0n);
    expect(firstBroken).toBeNull();
  });
});
