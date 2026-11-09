import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDatabase, tenants, type TestDatabase } from "./testing";

let t: TestDatabase;
beforeAll(async () => {
  t = await startTestDatabase();
});
afterAll(() => t?.stop());

// C-12: the data-quality sweep's cross-tenant finder returns organization ids only, and only licensed ones that opted in.
describe("accounts.data_quality_organizations", () => {
  const find = (after: string | null = null) =>
    t.app.execute<{ organization_id: string }>(sql`select * from accounts.data_quality_organizations(${after}::uuid, 100)`).then((r) => r.map((x) => x.organization_id));

  it("returns an organization only when Accounts is licensed and it set the setting or has an open exception", async () => {
    await t.admin.execute(sql`insert into kernel.config_version (organization_id, key, version, value) values (${tenants.a.id}, 'accounts.data_quality', 1, '{"rules":{}}')`);
    // Not licensed yet.
    expect(await find()).not.toContain(tenants.a.id);
    await t.admin.execute(sql`insert into kernel.organization_module (organization_id, module) values (${tenants.a.id}, 'accounts') on conflict do nothing`);
    expect(await find()).toContain(tenants.a.id);
    // B is licensed but never opted in and has nothing open.
    await t.admin.execute(sql`insert into kernel.organization_module (organization_id, module) values (${tenants.b.id}, 'accounts') on conflict do nothing`);
    expect(await find()).not.toContain(tenants.b.id);
    await t.admin.execute(sql`
      insert into kernel.exception (organization_id, type, source, title, subject_kind, subject_ref, dedupe_key)
      values (${tenants.b.id}, 'DATA_QUALITY', 'accounts', 'x', 'account', '1', 'dq:account_no_phone:x')`);
    expect(await find()).toContain(tenants.b.id);
    await t.admin.execute(sql`update kernel.exception set status = 'resolved' where organization_id = ${tenants.b.id}`);
    expect(await find()).not.toContain(tenants.b.id);
    // Keyset: nothing after the last id.
    expect(await find(tenants.b.id)).not.toContain(tenants.a.id);
    // Unlicensing hides it again.
    await t.admin.execute(sql`delete from kernel.organization_module where organization_id = ${tenants.a.id} and module = 'accounts'`);
    expect(await find()).not.toContain(tenants.a.id);
  });
});
