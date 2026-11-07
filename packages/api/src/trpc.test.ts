import { memberPermission, organizationSettings } from "@flowless/db";
import { startTestDatabase, tenants, type TestDatabase } from "@flowless/db/testing";
import { DEFAULT_ROLES } from "@flowless/shared-types";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCaller } from "./root";
import { addMember as addMemberTo, callerFor as callerAs, sessionOf, type Member } from "./test-support";
import { createCallerFactory, permittedProcedure, router, tenantProcedure } from "./trpc";

let t: TestDatabase;
beforeAll(async () => {
  t = await startTestDatabase();
});
afterAll(() => t?.stop());

const addMember = (organizationId: string, role: string) => addMemberTo(t, organizationId, role);
const callerFor = (m: Member) => callerAs(t, m);

describe("tenant procedures", () => {
  it("health answers without a session", async () => {
    const caller = createCaller({ db: t.app, session: null });
    expect(await caller.health()).toEqual({ status: "ok" });
  });

  it("reject callers without a session", async () => {
    const caller = createCaller({ db: t.app, session: null });
    await expect(caller.organization.settings()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("reject a session without an active organization", async () => {
    const m = await addMember(tenants.a.id, "member");
    const caller = createCaller({ db: t.app, session: sessionOf(m, null) });
    await expect(caller.organization.settings()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("reject a session whose member was removed (K-03)", async () => {
    const m = await addMember(tenants.a.id, "member");
    const caller = createCaller({ db: t.app, session: { ...sessionOf(m), member: null } });
    await expect(caller.organization.settings()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("reject a session whose active organization is not the membership's", async () => {
    const m = await addMember(tenants.a.id, "member");
    const caller = createCaller({ db: t.app, session: sessionOf(m, tenants.b.id) });
    await expect(caller.organization.settings()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("organization.settings returns only the caller's tenant (K-01)", async () => {
    for (const tenant of [tenants.a, tenants.b]) {
      const caller = callerFor(await addMember(tenant.id, "member"));
      expect(await caller.organization.settings()).toMatchObject({ organizationId: tenant.id });
    }
  });

  it("a failing tenant procedure rolls back its writes", async () => {
    const failing = router({
      changeThenFail: tenantProcedure.mutation(async ({ ctx }) => {
        await ctx.tx.update(organizationSettings).set({ currency: "USD" });
        throw new Error("boom");
      }),
    });
    const m = await addMember(tenants.a.id, "admin");
    const caller = createCallerFactory(failing)({ db: t.app, session: sessionOf(m) });

    await expect(caller.changeThenFail()).rejects.toThrow("boom");
    const [a] = await t.admin
      .select()
      .from(organizationSettings)
      .where(eq(organizationSettings.organizationId, tenants.a.id));
    expect(a?.currency).toBe("KES");
  });
});

// K-03: default roles with permission arrays, plus extra permissions per member.
describe("roles and permissions", () => {
  const approvals = router({ approve: permittedProcedure("billing:approve").mutation(() => "approved") });
  const approverFor = (m: Member) => createCallerFactory(approvals)({ db: t.app, session: sessionOf(m) });

  it("a member holds their role's default permissions", async () => {
    const clerk = await addMember(tenants.a.id, "clerk");
    const me = await callerFor(clerk).access.me();
    expect(me).toEqual({ role: "clerk", permissions: [...DEFAULT_ROLES.clerk].sort(), scope: { kind: "all" } });
  });

  it("an administrator can grant a permission beyond the member's role", async () => {
    const admin = await addMember(tenants.a.id, "admin");
    const clerk = await addMember(tenants.a.id, "clerk");
    await expect(approverFor(clerk).approve()).rejects.toMatchObject({ code: "FORBIDDEN" });

    await callerFor(admin).access.grant({ userId: clerk.userId, permission: "billing:approve" });
    await callerFor(admin).access.grant({ userId: clerk.userId, permission: "billing:approve" }); // no-op

    expect(await approverFor(clerk).approve()).toBe("approved");
    expect((await callerFor(clerk).access.me()).permissions).toContain("billing:approve");
    expect(await callerFor(admin).access.grants()).toEqual([
      expect.objectContaining({ userId: clerk.userId, permission: "billing:approve", grantedBy: admin.userId }),
    ]);
  });

  it("revoking removes the extra permission but not the role's defaults", async () => {
    const admin = await addMember(tenants.a.id, "admin");
    const cashier = await addMember(tenants.a.id, "cashier");
    await callerFor(admin).access.grant({ userId: cashier.userId, permission: "payments:reverse" });
    await callerFor(admin).access.grant({ userId: cashier.userId, permission: "payments:receipt" });
    await callerFor(admin).access.revoke({ userId: cashier.userId, permission: "payments:reverse" });
    await callerFor(admin).access.revoke({ userId: cashier.userId, permission: "payments:receipt" });

    const { permissions } = await callerFor(cashier).access.me();
    expect(permissions).not.toContain("payments:reverse");
    expect(permissions).toContain("payments:receipt");
  });

  it("only members with access:manage can grant", async () => {
    const clerk = await addMember(tenants.a.id, "clerk");
    const other = await addMember(tenants.a.id, "clerk");
    await expect(
      callerFor(clerk).access.grant({ userId: other.userId, permission: "accounts:read" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("a delegated access manager can only grant permissions they hold", async () => {
    const admin = await addMember(tenants.a.id, "admin");
    const supervisor = await addMember(tenants.a.id, "supervisor");
    const technician = await addMember(tenants.a.id, "technician");
    await callerFor(admin).access.grant({ userId: supervisor.userId, permission: "access:manage" });

    await callerFor(supervisor).access.grant({ userId: technician.userId, permission: "readings:approve" });
    await expect(
      callerFor(supervisor).access.grant({ userId: technician.userId, permission: "billing:approve" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: "You can only grant permissions you hold" });
  });

  it("cannot grant to someone outside the organization", async () => {
    const admin = await addMember(tenants.a.id, "admin");
    const outsider = await addMember(tenants.b.id, "clerk");
    await expect(
      callerFor(admin).access.grant({ userId: outsider.userId, permission: "billing:read" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("grants never cross tenants (NF-01)", async () => {
    const adminA = await addMember(tenants.a.id, "admin");
    const clerkA = await addMember(tenants.a.id, "clerk");
    await callerFor(adminA).access.grant({ userId: clerkA.userId, permission: "billing:run" });

    const adminB = await addMember(tenants.b.id, "admin");
    const grantsB = await callerFor(adminB).access.grants();
    expect(grantsB.some((g) => g.userId === clerkA.userId)).toBe(false);
  });

  it("a member's grants are deleted when they leave the organization", async () => {
    const admin = await addMember(tenants.a.id, "admin");
    const collector = await addMember(tenants.a.id, "collector");
    await callerFor(admin).access.grant({ userId: collector.userId, permission: "collections:approve_rebate" });

    // As Better Auth does when a member is removed, through the auth role.
    await t.auth.execute(sql`delete from auth.member where user_id = ${collector.userId}`);

    const left = await t.admin.select().from(memberPermission).where(eq(memberPermission.userId, collector.userId));
    expect(left).toEqual([]);
  });
});
