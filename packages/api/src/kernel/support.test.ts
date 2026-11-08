import { auditLog, supportGrant, withTenant } from "@flowless/db";
import { startTestDatabase, tenants, type TestDatabase } from "@flowless/db/testing";
import { SUPPORT_PERMISSIONS } from "@flowless/shared-types";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCaller } from "../root";
import { addMember, callerFor, type Member } from "../test-support";
import { supportSession } from "./support";

let t: TestDatabase;
let owner: Member;
const engineer = { id: randomUUID(), email: "Amina@Flowless.example", name: "Amina" };
beforeAll(async () => {
  t = await startTestDatabase();
  owner = await addMember(t, tenants.a.id, "owner");
});
afterAll(() => t?.stop());

const asSupport = (grantId: string, organizationId: string = tenants.a.id, who = engineer) =>
  createCaller({ db: t.app, session: supportSession({ organizationId, grantId, engineer: who }), source: "web" });
const grant = (hours = 4) =>
  callerFor(t, owner).support.grant({ engineerEmail: engineer.email, reason: "Ticket 4411: bills look doubled", hours });

// K-12: support access is time-boxed, justified and audited.
describe("support access", () => {
  it("lets the named engineer read, records every call, and refuses every change", async () => {
    const { id } = await grant();
    const support = asSupport(id);
    expect(await support.hierarchy.areas()).toEqual([]);
    const me = await support.access.me();
    expect(me.role).toBe("support");
    expect([...me.permissions].sort()).toEqual([...SUPPORT_PERMISSIONS].sort());
    await expect(support.hierarchy.createArea({ level: "scheme", code: "SUP", name: "Nope" })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Support access is read-only",
    });
    await expect(support.support.list()).rejects.toMatchObject({ code: "FORBIDDEN" });

    const trail = await t.admin
      .select({ action: auditLog.action, source: auditLog.source, actor: auditLog.actorLabel, after: auditLog.after })
      .from(auditLog)
      .where(and(eq(auditLog.subjectType, "support_grant"), eq(auditLog.subjectId, id)))
      .orderBy(auditLog.chainIndex);
    expect(trail).toEqual([
      expect.objectContaining({ action: "support.grant", source: "api", actor: "owner" }),
      { action: "support.read", source: "support", actor: "Flowless support: amina@flowless.example", after: { path: "hierarchy.areas" } },
      { action: "support.read", source: "support", actor: "Flowless support: amina@flowless.example", after: { path: "access.me" } },
      expect.objectContaining({ action: "support.refused", after: { path: "hierarchy.createArea", code: "FORBIDDEN" }, source: "support" }),
      expect.objectContaining({ action: "support.refused", after: { path: "support.list", code: "FORBIDDEN" }, source: "support" }),
    ]);
  });

  it("ends at expiry or revocation, and works for no one else", async () => {
    const { id } = await grant();
    await expect(asSupport(id, tenants.a.id, { ...engineer, email: "someone@flowless.example" }).hierarchy.areas()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(asSupport(id, tenants.b.id).hierarchy.areas()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(asSupport(randomUUID()).hierarchy.areas()).rejects.toMatchObject({ code: "FORBIDDEN" });

    await callerFor(t, owner).support.revoke({ id });
    await expect(asSupport(id).hierarchy.areas()).rejects.toMatchObject({ code: "FORBIDDEN", message: "Support access has ended" });
    const [refused] = await t.admin
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "support.refused"), eq(auditLog.subjectId, id), eq(auditLog.reason, "Support access has ended")));
    expect(refused).toMatchObject({ organizationId: tenants.a.id });
    await expect(callerFor(t, owner).support.revoke({ id })).rejects.toMatchObject({ code: "NOT_FOUND" });

    const other = await grant(1);
    await t.admin.update(supportGrant).set({ expiresAt: new Date(Date.now() - 1000), startsAt: new Date(Date.now() - 3_600_000) }).where(eq(supportGrant.id, other.id));
    await expect(asSupport(other.id).hierarchy.areas()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await callerFor(t, owner).support.list()).map((g) => g.status)).toEqual(expect.arrayContaining(["revoked", "expired"]));
  });

  it("needs access:manage, a reason and at most 72 hours; grants are never deleted", async () => {
    const clerk = await addMember(t, tenants.a.id, "clerk");
    await expect(callerFor(t, clerk).support.grant({ engineerEmail: engineer.email, reason: "Ticket 4411 doubled", hours: 1 })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(grant(73)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(callerFor(t, owner).support.grant({ engineerEmail: engineer.email, reason: "pls", hours: 1 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(withTenant(t.app, tenants.a.id, (tx) => tx.delete(supportGrant))).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/permission denied/) },
    });
  });
});
