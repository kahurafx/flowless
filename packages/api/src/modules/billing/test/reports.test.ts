import ExcelJS from "exceljs";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectCode, setupBillingEnv, type BillingEnv } from "./test-support";

let env: BillingEnv;
const a1 = randomUUID();
const a2 = randomUUID();
const a3 = randomUUID();
const a4 = randomUUID();
const route = randomUUID();
let doc1 = "";
let doc2 = "";

beforeAll(async () => {
  env = await setupBillingEnv();
  const issue = async (account: string, over: Record<string, unknown> = {}) => {
    const r = await env.admin.billing.invoices.issueUsage(env.usage(account, over) as never);
    if (r.outcome !== "issued") throw new Error(r.outcome);
    return r.document;
  };
  doc1 = (await issue(a1)).id; // 10 units: 102,900
  doc2 = (await issue(a2, { reading: { dial: 150 } })).id; // 50 units
  const voided = await issue(a3);
  await env.admin.billing.documents.void({ idempotencyKey: env.key("void"), documentId: voided.id, reason: "test" });
  await issue(a4);

  // A cycle on a route: a1 billed, a2 billed on estimate, a3 in exception, a4 without an outcome, a fifth account not expected.
  const cycle = randomUUID();
  const org = env.orgA;
  await env.t.admin.execute(sql`insert into billing.cycle (id, organization_id, period, cycle_date, route_id) values (${cycle}, ${org}, '2026-10', '2026-10-31', ${route})`);
  await env.t.admin.execute(sql`insert into billing.cycle_event (organization_id, cycle_id, seq, from_state, to_state, kind) values (${org}, ${cycle}, 1, null, 'open', 'open')`);
  for (const [account, expected] of [[a1, true], [a2, true], [a3, true], [a4, true], [randomUUID(), false]] as const) {
    await env.t.admin.execute(sql`insert into billing.cycle_account (organization_id, cycle_id, account_id, expected, reason) values (${org}, ${cycle}, ${account}, ${expected}, ${expected ? "eligible" : "no_meter"})`);
  }
  await env.t.admin.execute(sql`insert into billing.cycle_outcome (organization_id, cycle_id, account_id, outcome, document_id, amount) values (${org}, ${cycle}, ${a1}, 'billed', ${doc1}, 102900)`);
  await env.t.admin.execute(sql`insert into billing.cycle_outcome (organization_id, cycle_id, account_id, outcome, document_id, amount) values (${org}, ${cycle}, ${a2}, 'billed_estimate', ${doc2}, 1)`);
  const exc = randomUUID();
  await env.t.admin.execute(sql`insert into kernel.exception (id, organization_id, type, source, title, subject_kind, subject_ref) values (${exc}, ${org}, 'UNBILLED_ACCOUNT', 'billing', 'Held', 'account', ${a3})`);
  await env.t.admin.execute(sql`insert into billing.cycle_outcome (organization_id, cycle_id, account_id, outcome, reason, exception_id) values (${org}, ${cycle}, ${a3}, 'exception', 'held', ${exc})`);
  // A revenue case, resolved, and one still open.
  const open = randomUUID();
  const done = randomUUID();
  await env.t.admin.execute(sql`insert into billing.revenue_case (id, organization_id, case_id, event, kind, account_id, title, detail) values (${open}, ${org}, ${open}, 'opened', 'illegal_consumption', ${a1}, 'Bypass', ''), (${done}, ${org}, ${done}, 'opened', 'unbilled_account', ${a2}, 'No bill', '')`);
  await env.t.admin.execute(sql`insert into billing.revenue_case (organization_id, case_id, event, kind, account_id, detail, decision) values (${org}, ${done}, 'resolved', 'unbilled_account', ${a2}, 'ok', 'no_action')`);
});
afterAll(() => env?.t.stop());

const run = (key: string, params: Record<string, unknown> = {}) => env.admin.reports.run({ key, params });
const rowsOf = async (key: string, params: Record<string, unknown> = {}) => (await run(key, params)).rows;

describe("reports.list and permissions", () => {
  it("lists the reports the member may run, with their metadata", async () => {
    const list = await env.admin.reports.list();
    const keys = list.map((r) => r.key);
    expect(keys).toEqual(expect.arrayContaining(["billing.register", "billing.receivables_aging", "billing.cycle_completeness", "billing.unbilled_accounts", "billing.estimates_share", "billing.revenue_cases", "billing.corrections", "kernel.exceptions"]));
    const register = list.find((r) => r.key === "billing.register")!;
    expect(register.columns.map((c) => [c.key, c.role])).toContainEqual(["total", "measure"]);
    expect(register.filters.map((f) => f.key)).toEqual(expect.arrayContaining(["from", "to", "kind"]));
    expect(register.rowCap).toBeGreaterThan(0);
    // Metering is not licensed in this environment: its reports are not offered.
    expect(keys.filter((k) => k.startsWith("metering."))).toEqual([]);
  });

  it("refuses a member without the report's permission, and hides the report from them", async () => {
    await expectCode(env.cashier().reports.run({ key: "billing.register", params: {} }), "FORBIDDEN", /billing:read/);
    expect((await env.cashier().reports.list()).map((r) => r.key)).not.toContain("billing.register");
    // reports:export is its own permission.
    await expectCode(env.clerk().reports.export({ key: "billing.register", format: "csv" }), "FORBIDDEN");
    expect((await env.clerk().reports.run({ key: "billing.register", params: {} })).rows.length).toBeGreaterThan(0);
  });

  it("answers NOT_FOUND for a report of an unlicensed module, an unknown one and an internal one", async () => {
    await expectCode(env.bare().reports.run({ key: "billing.register", params: {} }), "NOT_FOUND");
    expect((await env.bare().reports.list()).map((r) => r.key)).not.toContain("billing.register");
    await expectCode(env.admin.reports.run({ key: "metering.read_streaks", params: {} }), "NOT_FOUND");
    await expectCode(env.admin.reports.run({ key: "nope", params: {} }), "NOT_FOUND");
    await expectCode(env.admin.reports.run({ key: "accounts.data_quality_summary", params: {} }), "NOT_FOUND");
  });

  it("refuses parameters the report does not define", async () => {
    await expectCode(run("billing.register", { kind: "mystery" }), "BAD_REQUEST");
    await expectCode(run("billing.register", { groupBy: ["; drop table"] }), "BAD_REQUEST");
  });
});

describe("billing reports (X-01)", () => {
  it("billing.register counts and sums documents by month, type and status, with bigint totals", async () => {
    const rows = await rowsOf("billing.register");
    const by = (kind: string, status: string) => rows.find((r) => r.kind === kind && r.status === status);
    expect(by("invoice", "live")).toMatchObject({ documents: 3, total: 102_900n + 528_900n + 102_900n });
    expect(by("invoice", "reversed")).toMatchObject({ documents: 1, total: 102_900n });
    expect(by("reversal", "reversal")).toMatchObject({ documents: 1, total: -102_900n });
    const only = await rowsOf("billing.register", { groupBy: ["kind"], measures: ["documents"], kind: "invoice" });
    expect(only).toEqual([{ kind: "invoice", documents: 4 }]);
    expect(await rowsOf("billing.register", { groupBy: [], measures: ["documents"], to: "2000-01-01" })).toEqual([{ documents: 0 }]);
  });

  it("billing.receivables_aging buckets what is owed by the age of the charges and leaves out settled accounts", async () => {
    const now = await rowsOf("billing.receivables_aging");
    expect(now).toEqual([{ bucket: "0-30", outstanding: 102_900n + 528_900n + 102_900n, accounts: 3 }]);
    const later = new Date(Date.now() + 45 * 86_400_000).toISOString().slice(0, 10);
    expect((await rowsOf("billing.receivables_aging", { asOf: later }))[0]).toMatchObject({ bucket: "31-60", accounts: 3 });
    const perAccount = await rowsOf("billing.receivables_aging", { groupBy: ["accountId"] });
    expect(perAccount.map((r) => r.accountId).sort()).toEqual([a1, a2, a4].sort());
  });

  it("billing.cycle_completeness counts outcomes per cycle and flags the unexplained", async () => {
    const [row] = await rowsOf("billing.cycle_completeness", { period: "2026-10" });
    expect(row).toMatchObject({ period: "2026-10", routeId: route, accounts: 5, expected: 4, billed: 1, billedEstimate: 1, exception: 1, excluded: 0, unexplained: 1 });
  });

  it("billing.unbilled_accounts lists expected accounts without a bill", async () => {
    const rows = await rowsOf("billing.unbilled_accounts", { routeId: route });
    expect(rows.map((r) => [r.accountId, r.status])).toEqual(expect.arrayContaining([[a3, "exception"], [a4, "no_outcome"]]));
    expect(rows).toHaveLength(2);
    expect(await rowsOf("billing.unbilled_accounts", { routeId: route, status: "no_outcome" })).toHaveLength(1);
  });

  it("billing.estimates_share gives the share of bills on estimate per route", async () => {
    expect(await rowsOf("billing.estimates_share", { routeId: route })).toEqual([{ period: "2026-10", routeId: route, bills: 2, estimated: 1, sharePercent: "50.0" }]);
  });

  it("billing.revenue_cases is the case register with derived status", async () => {
    const rows = await rowsOf("billing.revenue_cases");
    expect(rows.map((r) => [r.title, r.status, r.decision]).sort()).toEqual([["Bypass", "open", null], ["No bill", "resolved", "no_action"]]);
    expect(await rowsOf("billing.revenue_cases", { status: "open" })).toHaveLength(1);
  });

  it("billing.corrections lists correction and back-billing documents", async () => {
    expect(await rowsOf("billing.corrections")).toEqual([]);
  });

  it("kernel.exceptions groups the queue by type and status with ages", async () => {
    const rows = await rowsOf("kernel.exceptions", { groupBy: ["type", "age"], state: "active" });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => typeof r.exceptions === "number")).toBe(true);
  });

  it("ignores scope parameters sent by the caller (the engine sets them from the session)", async () => {
    const rows = await rowsOf("billing.register", { visibleAccountIds: [randomUUID()] });
    expect(rows.length).toBeGreaterThan(0);
  });

  it("confines a member limited to a route to the accounts they may see (K-03)", async () => {
    const limitedRoute = await env.admin.hierarchy.createRoute({ code: "RX", name: "Route X" });
    await env.admin.access.setScope({ userId: env.members.clerk.userId, areaIds: [], routeIds: [limitedRoute.id] });
    // None of this test's opaque accounts sit on that route, so the clerk sees none of them.
    expect((await env.clerk().reports.run({ key: "billing.register", params: { groupBy: [], measures: ["documents"] } })).rows).toEqual([{ documents: 0 }]);
    for (const key of ["billing.receivables_aging", "billing.unbilled_accounts", "billing.revenue_cases", "billing.corrections"]) {
      expect((await env.clerk().reports.run({ key, params: {} })).rows).toEqual([]);
    }
    expect((await env.clerk().reports.run({ key: "billing.cycle_completeness", params: { groupBy: [], measures: ["accounts"] } })).rows).toEqual([{ accounts: 0 }]);
  });
});

describe("reports.export (X-03)", () => {
  it("exports CSV with money in major units, tenant-scoped and audited", async () => {
    const file = await env.admin.reports.export({ key: "billing.register", format: "csv", params: { groupBy: ["kind"], kind: "invoice", measures: ["documents", "total"] } });
    expect(file).toMatchObject({ encoding: "utf8", contentType: expect.stringContaining("text/csv"), rows: 1, truncated: false });
    expect(file.filename).toMatch(/^billing\.register-\d{4}-\d{2}-\d{2}\.csv$/);
    const lines = file.content.replace("﻿", "").trim().split("\r\n");
    expect(lines[0]).toBe("Type,Documents,Total (KES)");
    expect(lines[1]).toBe("invoice,4,"+ ((102_900 * 3 + 528_900) / 100).toFixed(2));
    const [audit] = await env.rows<{ action: string; organization_id: string; after: { rows: number; format: string } }>(
      sql`select action, organization_id, after from kernel.audit_log where action = 'reports.export' order by occurred_at desc limit 1`,
    );
    expect(audit).toMatchObject({ action: "reports.export", organization_id: env.orgA, after: { rows: 1, format: "csv" } });
  });

  it("exports Excel that opens and holds the same rows", async () => {
    const file = await env.admin.reports.export({ key: "billing.cycle_completeness", format: "xlsx", params: {} });
    expect(file.encoding).toBe("base64");
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(Buffer.from(file.content, "base64") as never);
    const sheet = book.worksheets[0]!;
    expect(sheet.getRow(1).values).toEqual(expect.arrayContaining(["Period", "Unexplained"]));
    expect(sheet.rowCount).toBe(2);
  });

  it("another tenant's export holds none of A's rows", async () => {
    const file = await env.outsider().reports.export({ key: "billing.register", format: "csv", params: {} });
    expect(file.rows).toBe(0);
  });
});
