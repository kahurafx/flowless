import { organizationSettings } from "@flowless/db";
import { startTestDatabase, tenants, type TestDatabase } from "@flowless/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCaller } from "./root";
import { createCallerFactory, router, tenantProcedure, type Session } from "./trpc";

const sessionFor = (activeOrganizationId: string | null): Session => ({
  user: { id: "test-user", name: "Test User", email: "test@example.test" },
  session: { id: "test-session", activeOrganizationId },
});

describe("api", () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await startTestDatabase();
  });
  afterAll(() => t?.stop());

  it("health answers without a session", async () => {
    const caller = createCaller({ db: t.app, session: null });
    expect(await caller.health()).toEqual({ status: "ok" });
  });

  it("tenant procedures reject callers without a session", async () => {
    const caller = createCaller({ db: t.app, session: null });
    await expect(caller.organization.settings()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("tenant procedures reject a session without an active organization", async () => {
    const caller = createCaller({ db: t.app, session: sessionFor(null) });
    await expect(caller.organization.settings()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("organization.settings returns only the caller's tenant (K-01)", async () => {
    for (const tenant of [tenants.a, tenants.b]) {
      const caller = createCaller({ db: t.app, session: sessionFor(tenant.id) });
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
    const caller = createCallerFactory(failing)({ db: t.app, session: sessionFor(tenants.a.id) });

    await expect(caller.changeThenFail()).rejects.toThrow("boom");
    const [a] = await t.admin
      .select()
      .from(organizationSettings)
      .where(eq(organizationSettings.organizationId, tenants.a.id));
    expect(a?.currency).toBe("KES");
  });
});
