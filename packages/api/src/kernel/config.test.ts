import { auditLog, configVersion, withTenant } from "@flowless/db";
import { startTestDatabase, tenants, type TestDatabase } from "@flowless/db/testing";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { addMember, callerFor, sessionOf, type Member } from "../test-support";
import { createCallerFactory, router, tenantProcedure } from "../trpc";
import { createConfigRouter } from "./config";
import { defineSetting, readSetting, type SettingDef } from "./config-store";
import { setEntitlements } from "./entitlement-store";
import { regionalSetting } from "./regional";

const BILLING = ["accounts", "tariffs", "metering", "billing"];
let t: TestDatabase;
let owner: Member;
let ownerB: Member;
let clerk: Member;
beforeAll(async () => {
  t = await startTestDatabase();
  owner = await addMember(t, tenants.a.id, "owner");
  ownerB = await addMember(t, tenants.b.id, "owner");
  clerk = await addMember(t, tenants.a.id, "clerk");
  await setEntitlements(t.app, tenants.a.id, BILLING);
  await setEntitlements(t.app, tenants.b.id, BILLING);
});
afterAll(() => t?.stop());
beforeEach(() => t.admin.delete(configVersion));

const estimation = defineSetting({
  key: "billing.test_estimation",
  module: "billing",
  label: "Estimation policy",
  description: "How a missing reading is estimated.",
  schema: z.object({ method: z.enum(["average", "last_actual", "none"]), months: z.number().int().min(1).default(3) }),
  default: { method: "average", months: 3 },
});

// The registry plus a module setting, and a procedure that reads through ctx.config.
const testRouter = router({
  config: createConfigRouter([regionalSetting as SettingDef, estimation as SettingDef]),
  read: tenantProcedure.query(({ ctx }) => ctx.config(estimation)),
});
const as = (m: Member) => createCallerFactory(testRouter)({ db: t.app, session: sessionOf(m) });
const setting = async (m: Member, key: string) => (await as(m).config.list()).find((s) => s.key === key);
const inFuture = (days: number) => new Date(Date.now() + days * 86_400_000);

// K-10: organization-level configuration; NF-32: behavior is configuration.
describe("configuration store", () => {
  it("serves the default until set, then the newest version, and audits the change", async () => {
    expect(await as(owner).read()).toEqual({ method: "average", months: 3 });
    expect(await setting(owner, estimation.key)).toMatchObject({ version: 0, isDefault: true });

    await as(owner).config.set({ key: estimation.key, value: { method: "last_actual" }, expectedVersion: 0, reason: "Council policy" });
    expect(await as(owner).read()).toEqual({ method: "last_actual", months: 3 });
    await as(owner).config.set({ key: estimation.key, value: { method: "none", months: 1 }, expectedVersion: 1 });
    expect(await setting(owner, estimation.key)).toMatchObject({ version: 2, isDefault: false, value: { method: "none" } });

    const history = await as(owner).config.history({ key: estimation.key });
    expect(history.map((v) => [v.version, v.reason, v.createdByUserId])).toEqual([
      [2, null, owner.userId],
      [1, "Council policy", owner.userId],
    ]);
    const [entry] = await t.admin
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "config.set"), eq(auditLog.subjectId, estimation.key)))
      .orderBy(auditLog.chainIndex)
      .limit(1);
    expect(entry).toMatchObject({
      actorUserId: owner.userId,
      reason: "Council policy",
      before: { version: 0, value: { method: "average", months: 3 } },
      after: { version: 1, value: { method: "last_actual", months: 3 } },
    });
  });

  it("writes nothing when the value is unchanged", async () => {
    await as(owner).config.set({ key: estimation.key, value: { method: "none" }, expectedVersion: 0 });
    expect(await as(owner).config.set({ key: estimation.key, value: { months: 3, method: "none" }, expectedVersion: 1 })).toEqual({
      version: 1,
      changed: false,
    });
    expect(await as(owner).config.history({ key: estimation.key })).toHaveLength(1);
  });

  it("refuses a change made against a version that is no longer the newest", async () => {
    await as(owner).config.set({ key: estimation.key, value: { method: "none" }, expectedVersion: 0 });
    await expect(as(owner).config.set({ key: estimation.key, value: { method: "average" }, expectedVersion: 0 })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("schedules a change for a future date and never back-dates one", async () => {
    const from = inFuture(10);
    await as(owner).config.set({ key: estimation.key, value: { method: "none" }, expectedVersion: 0, effectiveFrom: from });
    expect(await as(owner).read()).toEqual({ method: "average", months: 3 });
    expect(await setting(owner, estimation.key)).toMatchObject({ version: 0, latestVersion: 1, scheduled: [{ version: 1, effectiveFrom: from }] });
    const later = await withTenant(t.app, tenants.a.id, (tx) => readSetting(tx, estimation, inFuture(11)));
    expect(later).toMatchObject({ version: 1, value: { method: "none" } });

    await expect(
      as(owner).config.set({ key: estimation.key, value: { method: "none" }, expectedVersion: 1, effectiveFrom: inFuture(-1) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "A change cannot take effect in the past" });
  });

  it("validates values against the setting's schema", async () => {
    await expect(
      as(owner).config.set({ key: regionalSetting.key, value: { timeZone: "Africa/Atlantis", locale: "en-KE" }, expectedVersion: 0 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Unknown time zone" });
    await as(owner).config.set({ key: regionalSetting.key, value: { timeZone: "Africa/Kampala", locale: "sw-KE" }, expectedVersion: 0 });
    expect(await callerFor(t, owner).organization.settings()).toMatchObject({ currency: "KES", timeZone: "Africa/Kampala", locale: "sw-KE" });
  });

  it("needs settings:manage and hides settings of unlicensed modules (K-04)", async () => {
    await expect(as(clerk).config.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await setEntitlements(t.app, tenants.a.id, []);
    try {
      expect((await as(owner).config.list()).map((s) => s.key)).toEqual([regionalSetting.key]);
      await expect(as(owner).config.set({ key: estimation.key, value: { method: "none" }, expectedVersion: 0 })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await expect(as(owner).config.set({ key: "kernel.nope", value: 1, expectedVersion: 0 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally {
      await setEntitlements(t.app, tenants.a.id, BILLING);
    }
  });

  it("keeps each tenant's values apart and versions append-only (NF-01)", async () => {
    await as(owner).config.set({ key: estimation.key, value: { method: "none" }, expectedVersion: 0 });
    expect(await as(ownerB).read()).toEqual({ method: "average", months: 3 });
    expect(await withTenant(t.app, tenants.b.id, (tx) => tx.select().from(configVersion))).toEqual([]);

    await expect(withTenant(t.app, tenants.a.id, (tx) => tx.update(configVersion).set({ reason: "rewritten" }))).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/permission denied/) },
    });
    await expect(withTenant(t.app, tenants.a.id, (tx) => tx.delete(configVersion))).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/permission denied/) },
    });
  });
});
