import { eq, sql } from "drizzle-orm";
import { migrateDatabase } from "./migrate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { organizationSettings } from "./schema";
import { organization } from "./schema/auth";
import { withTenant } from "./tenant";
import { startTestDatabase, tenants, type TestDatabase } from "./testing";

/** Drizzle wraps driver errors; the Postgres error is the `cause`. */
const pgError = (pattern: RegExp) => ({ cause: { message: expect.stringMatching(pattern) } });

let t: TestDatabase;
beforeAll(async () => {
  t = await startTestDatabase();
});
afterAll(() => t?.stop());

// K-01, NF-01: tenant isolation is enforced by Postgres, not by application code.
describe("row-level security", () => {
  it("fails closed: without a tenant the app role sees no rows", async () => {
    expect(await t.app.select().from(organizationSettings)).toEqual([]);
  });

  it("a tenant sees only its own rows", async () => {
    const rows = await withTenant(t.app, tenants.a.id, (tx) => tx.select().from(organizationSettings));
    expect(rows.map((r) => r.organizationId)).toEqual([tenants.a.id]);
  });

  it("a tenant cannot change another tenant's rows", async () => {
    const updated = await withTenant(t.app, tenants.a.id, (tx) =>
      tx
        .update(organizationSettings)
        .set({ currency: "USD" })
        .where(eq(organizationSettings.organizationId, tenants.b.id))
        .returning(),
    );
    expect(updated).toEqual([]);
    const [b] = await t.admin
      .select()
      .from(organizationSettings)
      .where(eq(organizationSettings.organizationId, tenants.b.id));
    expect(b?.currency).toBe("KES");
  });

  it("a tenant cannot write rows for another tenant", async () => {
    // Assert on the RLS error itself, so a primary-key conflict cannot pass this test.
    await expect(
      withTenant(t.app, tenants.a.id, (tx) =>
        tx
          .insert(organizationSettings)
          .values({ organizationId: tenants.b.id, currency: "USD" }),
      ),
    ).rejects.toMatchObject(pgError(/row-level security/));
  });

  it("the tenant setting does not leak past the transaction", async () => {
    await withTenant(t.app, tenants.a.id, (tx) => tx.select().from(organizationSettings));
    // Same pooled connection (max: 1), outside the transaction: nothing is visible.
    expect(await t.app.select().from(organizationSettings)).toEqual([]);
  });
});

// Better Auth's tables are global by nature (sign-in precedes any tenant), so they are
// isolated by role instead: each runtime role reaches only its own side.
describe("role separation", () => {
  it("the app role cannot read the auth schema", async () => {
    await expect(t.app.select().from(organization)).rejects.toMatchObject(pgError(/permission denied/));
  });

  it("the auth role cannot read module schemas", async () => {
    await expect(t.auth.select().from(organizationSettings)).rejects.toMatchObject(pgError(/permission denied/));
  });

  it("the auth role can read the auth schema", async () => {
    const rows = await t.auth.select({ id: organization.id }).from(organization);
    expect(rows.map((r) => r.id).sort()).toEqual([tenants.a.id, tenants.b.id]);
  });
});

describe("runtime roles", () => {
  const isMember = async (login: string, group: string) => {
    const rows = await t.admin.execute<{ member: boolean }>(
      sql`select pg_has_role(${login}, ${group}, 'member') as member`,
    );
    return rows[0]?.member;
  };

  it("each login role belongs to its group role", async () => {
    expect(await isMember("flowless_api", "flowless_app")).toBe(true);
    expect(await isMember("flowless_auth_api", "flowless_auth")).toBe(true);
  });

  it("a login role that already exists outside its group is added to it", async () => {
    await t.admin.execute(sql`create role stray_api login password 'stray_api'`);
    await migrateDatabase(t.adminUrl, { app: t.urlFor("stray_api"), auth: t.urlFor("flowless_auth_api") });
    expect(await isMember("stray_api", "flowless_app")).toBe(true);
  });
});
