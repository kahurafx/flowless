import { withTenant } from "@flowless/db";
import { startTestDatabase, tenants, type TestDatabase } from "@flowless/db/testing";
import { sql, type SQL } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { reportPublishProblems } from "./report-guard";
import { reports } from "./report-registry";

let t: TestDatabase;
beforeAll(async () => {
  t = await startTestDatabase();
  // Two tables the app role can read but a report must not: no tenant column, and no RLS.
  await t.admin.execute(sql`create table kernel.zz_lookup (code text primary key)`);
  await t.admin.execute(sql`create table kernel.zz_open (organization_id uuid, note text)`);
  await t.admin.execute(sql`create view kernel.zz_lookup_view as select code from kernel.zz_lookup`);
  await t.admin.execute(sql`grant select on kernel.zz_lookup, kernel.zz_open, kernel.zz_lookup_view to flowless_app`);
});
afterAll(() => t?.stop());

const problems = (query: SQL) => withTenant(t.app, tenants.a.id, (tx) => reportPublishProblems(tx, query));

// X-04: a report touching a table without a tenant column fails to publish.
describe("report publish guard", () => {
  it("passes reports over tenant tables, with parameters, joins and subqueries", async () => {
    expect(
      await problems(sql`
        select a.code, count(r.id) as routes from kernel.area a
          left join kernel.route r on r.area_id = a.id
         where a.code <> ${"X"} and a.id not in (select area_id from kernel.member_area_scope)
         group by a.code`),
    ).toEqual([]);
  });

  it("refuses a table without a tenant column, also behind a view or in a subquery", async () => {
    expect(await problems(sql`select * from kernel.zz_lookup`)).toEqual(["kernel.zz_lookup has no tenant column (organization_id)"]);
    expect(await problems(sql`select * from kernel.zz_lookup_view`)).toEqual(["kernel.zz_lookup has no tenant column (organization_id)"]);
    expect(
      await problems(sql`select code from kernel.area where exists (select 1 from kernel.zz_lookup l where l.code = area.code)`),
    ).toEqual(["kernel.zz_lookup has no tenant column (organization_id)"]);
  });

  it("refuses a tenant column without row-level security", async () => {
    expect(await problems(sql`select note from kernel.zz_open`)).toEqual(["kernel.zz_open has no row-level security"]);
  });

  it("refuses system catalogs, the auth schema and functions that bypass RLS", async () => {
    expect(await problems(sql`select relname from pg_class`)).toEqual(["pg_catalog.pg_class has no tenant column (organization_id)"]);
    expect((await problems(sql`select email from auth.user`))[0]).toMatch(/cannot be planned as the app role: permission denied/);
    expect(await problems(sql`select * from kernel.claim_jobs(1, 1)`)).toContain("kernel.claim_jobs() bypasses row-level security");
    expect(await problems(sql`select count(*), (select checked from kernel.verify_audit_chain()) from kernel.area`)).toContain(
      "kernel.verify_audit_chain() bypasses row-level security",
    );
  });

  it("leaves the caller's transaction usable after a refusal", async () => {
    const after = await withTenant(t.app, tenants.a.id, async (tx) => {
      await reportPublishProblems(tx, sql`select email from auth.user`);
      return tx.execute(sql`select 1 as ok`);
    });
    expect(after[0]).toEqual({ ok: 1 });
  });

  it("holds for every report defined in code", async () => {
    for (const report of reports) {
      const params = report.params.parse(report.params instanceof z.ZodObject ? {} : undefined);
      expect({ report: report.key, problems: await problems(report.query(params)) }).toEqual({ report: report.key, problems: [] });
    }
  });
});
