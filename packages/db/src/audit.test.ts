import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordAudit } from "./audit";
import { auditLog } from "./schema/kernel";
import { withTenant } from "./tenant";
import { startTestDatabase, tenants, type TestDatabase } from "./testing";

let t: TestDatabase;
beforeAll(async () => {
  t = await startTestDatabase();
});
afterAll(() => t?.stop());

const pgError = (message: RegExp) => ({ cause: { message: expect.stringMatching(message) } });
const entry = (organizationId: string, action: string) => ({ organizationId, source: "system" as const, action });

const verify = (organizationId: string) =>
  withTenant(t.app, organizationId, async (tx) => {
    const [row] = await tx.execute<{ checked: string; first_broken: string | null }>(sql`select * from kernel.verify_audit_chain()`);
    return { checked: Number(row!.checked), firstBroken: row!.first_broken === null ? null : Number(row!.first_broken) };
  });

// K-06 audit log, NF-07 tamper-evident.
describe("audit log", () => {
  it("chains each organization's entries from 1 and stamps the time in the database", async () => {
    const backdated = new Date("2001-01-01T00:00:00Z");
    await withTenant(t.app, tenants.a.id, async (tx) => {
      await tx.insert(auditLog).values({ ...entry(tenants.a.id, "test.one"), occurredAt: backdated });
      await recordAudit(tx, entry(tenants.a.id, "test.two"));
    });
    await withTenant(t.app, tenants.b.id, (tx) => recordAudit(tx, entry(tenants.b.id, "test.b")));

    const rows = await t.admin.select().from(auditLog).where(eq(auditLog.organizationId, tenants.a.id)).orderBy(auditLog.chainIndex);
    expect(rows.map((r) => r.chainIndex)).toEqual([1n, 2n]);
    expect(rows[0]!.occurredAt.getTime()).toBeGreaterThan(backdated.getTime());
    expect(rows[1]!.prevHash).toEqual(rows[0]!.hash);
    const [b] = await t.admin.select().from(auditLog).where(eq(auditLog.organizationId, tenants.b.id));
    expect(b!.chainIndex).toBe(1n);
    expect(await verify(tenants.a.id)).toEqual({ checked: 2, firstBroken: null });
  });

  it("is append-only for the app role", async () => {
    await withTenant(t.app, tenants.a.id, (tx) => recordAudit(tx, entry(tenants.a.id, "test.keep")));
    await expect(
      withTenant(t.app, tenants.a.id, (tx) => tx.update(auditLog).set({ action: "test.changed" })),
    ).rejects.toMatchObject(pgError(/permission denied/));
    await expect(withTenant(t.app, tenants.a.id, (tx) => tx.delete(auditLog))).rejects.toMatchObject(pgError(/permission denied/));
  });

  it("only shows a tenant its own entries (NF-01)", async () => {
    const seen = await withTenant(t.app, tenants.b.id, (tx) => tx.select({ org: auditLog.organizationId }).from(auditLog));
    expect(seen.every((r) => r.org === tenants.b.id)).toBe(true);
  });

  it("lets the auth role insert but not read", async () => {
    await recordAudit(t.auth, entry(tenants.a.id, "auth.test"));
    await expect(t.auth.select().from(auditLog)).rejects.toMatchObject(pgError(/permission denied/));
  });

  it("detects an edited or removed entry", async () => {
    const tenant = tenants.b.id;
    await withTenant(t.app, tenant, async (tx) => {
      for (const action of ["test.x", "test.y", "test.z"]) await recordAudit(tx, entry(tenant, action));
    });
    expect((await verify(tenant)).firstBroken).toBeNull();

    // Someone with direct database access rewrites history.
    await t.admin.execute(sql`update kernel.audit_log set reason = 'nothing to see' where organization_id = ${tenant} and action = 'test.y'`);
    const edited = await verify(tenant);
    expect(edited.firstBroken).not.toBeNull();

    await t.admin.execute(sql`update kernel.audit_log set reason = null where organization_id = ${tenant} and action = 'test.y'`);
    expect((await verify(tenant)).firstBroken).toBeNull();
    await t.admin.execute(sql`delete from kernel.audit_log where organization_id = ${tenant} and action = 'test.y'`);
    expect((await verify(tenant)).firstBroken).not.toBeNull();
  });
});
