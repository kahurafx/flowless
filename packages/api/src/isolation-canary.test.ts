import { approvalRequest, enqueueEvent, file, job, withTenant } from "@flowless/db";
import { startTestDatabase, tenants, type TestDatabase } from "@flowless/db/testing";
import { MODULE_KEYS } from "@flowless/shared-types";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import superjson from "superjson";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setEntitlements } from "./kernel/entitlement-store";
import { raiseException } from "./kernel/exception-store";
import { notify } from "./kernel/notification-store";
import { reportPublishProblems } from "./kernel/report-guard";
import { reports } from "./kernel/report-registry";
import { addMember, callerFor, callPath, procedures, type Member } from "./test-support";

/** Tenant B's records that A's calls aim at, to prove they never reach them. */
interface Canary {
  scheme: string;
  route: string;
  member: string;
  exception: string;
  approval: string;
  file: string;
  notification: string;
  grant: string;
}

const MARK = "CANARY-B";
let t: TestDatabase;
let ownerA: Member;
let ownerB: Member;
let b: Canary;
/** Every identifier in tenant B's rows, and B's organization id. */
let bIdentifiers: Set<string>;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

async function tenantTables(): Promise<string[]> {
  const rows = await t.admin.execute<{ table_name: string }>(sql`
    select table_name from information_schema.columns
     where table_schema = 'kernel' and column_name = 'organization_id' order by table_name`);
  return rows.map((r) => r.table_name);
}

/** Every row of tenant B, as text, table by table: what A must never change or see. */
async function snapshotB(): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const table of await tenantTables()) {
    const rows = await t.admin.execute<{ row: string }>(
      sql`select row_to_json(x)::text as row from ${sql.identifier("kernel")}.${sql.identifier(table)} x where organization_id = ${tenants.b.id}`,
    );
    out[table] = rows.map((r) => r.row).sort();
  }
  return out;
}

async function seedB(): Promise<Canary> {
  const asB = callerFor(t, ownerB);
  const clerkB = await addMember(t, tenants.b.id, "clerk");
  const scheme = await asB.hierarchy.createArea({ level: "scheme", code: "CNB", name: `${MARK} scheme` });
  const zone = await asB.hierarchy.createArea({ level: "zone", code: "CNBZ", name: `${MARK} zone`, parentId: scheme.id });
  const route = await asB.hierarchy.createRoute({ code: "CNB-1", name: `${MARK} route`, areaId: zone.id });
  await asB.access.grant({ userId: clerkB.userId, permission: "settings:manage" });
  await asB.access.setScope({ userId: clerkB.userId, areaIds: [scheme.id], routeIds: [route.id] });
  await asB.config.set({ key: "kernel.regional", value: { timeZone: "Africa/Dar_es_Salaam", locale: "sw-TZ" }, expectedVersion: 0, reason: MARK });
  const grant = await asB.support.grant({ engineerEmail: "canary@flowless.example", reason: `${MARK} support ticket`, hours: 2 });

  const seeded = await withTenant(t.app, tenants.b.id, async (tx) => {
    const exception = await raiseException(tx, tenants.b.id, {
      type: "JOB_FAILURE",
      source: "kernel",
      title: `${MARK} failed job`,
      subject: { kind: "job", ref: randomUUID() },
      areaId: zone.id,
      ownerUserId: clerkB.userId,
    });
    await notify(tx, tenants.b.id, { to: { userId: ownerB.userId }, topic: "test.canary", title: `${MARK} notification` });
    const [approval] = await tx
      .insert(approvalRequest)
      .values({
        organizationId: tenants.b.id,
        kind: "kernel.canary",
        subjectRef: `${MARK}-1`,
        title: `${MARK} rebate`,
        policy: { levels: [{ label: "Anyone", permission: "accounts:read" }], slaHours: 24, escalateTo: null },
        requestedByUserId: clerkB.userId,
        dueAt: new Date(Date.now() + 86_400_000),
      })
      .returning({ id: approvalRequest.id });
    const fileId = randomUUID();
    await tx.insert(file).values({
      id: fileId,
      organizationId: tenants.b.id,
      subjectKind: "dispute",
      subjectId: `${MARK}-1`,
      fileName: `${MARK}.jpg`,
      storageKey: `${tenants.b.id}/dispute/${MARK}-1/${fileId}/x.jpg`,
      mimeType: "image/jpeg",
      sizeBytes: 10,
      status: "uploaded",
      uploadedByUserId: clerkB.userId,
    });
    await enqueueEvent(tx, { organizationId: tenants.b.id, type: "test.canary", payload: { mark: MARK } });
    await tx.insert(job).values({ organizationId: tenants.b.id, type: "kernel.canary", payload: { mark: MARK }, status: "failed" });
    return { exception: exception.id, approval: approval!.id, file: fileId };
  });
  const [notification] = await asB.notifications.list();
  return { scheme: scheme.id, route: route.id, member: clerkB.userId, grant: grant.id, notification: notification!.id, ...seeded };
}

/**
 * How tenant A calls each endpoint: its normal calls, and calls aimed at B's records.
 * Every procedure must be listed, so a new endpoint cannot skip the canary.
 */
const CALLS: Record<string, (b: Canary) => unknown[]> = {
  health: () => [undefined],
  "organization.settings": () => [undefined],
  "config.list": () => [undefined],
  "config.history": () => [{ key: "kernel.regional" }],
  "config.set": () => [{ key: "kernel.regional", value: { timeZone: "Africa/Nairobi", locale: "en-KE" }, expectedVersion: 99 }],
  "access.me": () => [undefined],
  "access.grants": () => [undefined],
  "access.grant": (b) => [{ userId: b.member, permission: "accounts:read" }],
  "access.revoke": (b) => [{ userId: b.member, permission: "settings:manage" }],
  "access.scopes": () => [undefined],
  "access.setScope": (b) => [{ userId: b.member, areaIds: [], routeIds: [] }],
  "hierarchy.areas": () => [undefined, { includeArchived: true }],
  "hierarchy.createArea": (b) => [{ level: "zone", code: "AZ", name: "Under B", parentId: b.scheme }],
  "hierarchy.updateArea": (b) => [{ id: b.scheme, name: "Renamed by A" }],
  "hierarchy.archiveArea": (b) => [{ id: b.scheme }],
  "hierarchy.restoreArea": (b) => [{ id: b.scheme }],
  "hierarchy.routes": () => [undefined, { includeArchived: true }],
  "hierarchy.createRoute": (b) => [{ code: "AR", name: "Under B", parentId: b.route }, { code: "AR2", name: "In B", areaId: b.scheme }],
  "hierarchy.updateRoute": (b) => [{ id: b.route, name: "Renamed by A" }],
  "hierarchy.archiveRoute": (b) => [{ id: b.route }],
  "hierarchy.restoreRoute": (b) => [{ id: b.route }],
  "entitlements.list": () => [undefined],
  "audit.list": () => [undefined, { limit: 500 }],
  "audit.verify": () => [undefined],
  "exceptions.list": () => [undefined, { view: "resolved" }],
  "exceptions.assign": (b) => [{ id: b.exception, ownerUserId: null }],
  "exceptions.start": (b) => [{ id: b.exception }],
  "exceptions.resolve": (b) => [{ id: b.exception, note: "Resolved by A" }],
  "exceptions.reopen": (b) => [{ id: b.exception }],
  "exceptions.retry": (b) => [{ id: b.exception }],
  "approvals.list": () => [undefined, { view: "open" }, { view: "closed" }],
  "approvals.get": (b) => [{ id: b.approval }],
  "approvals.approve": (b) => [{ id: b.approval }],
  "approvals.reject": (b) => [{ id: b.approval, note: "Rejected by A" }],
  "approvals.cancel": (b) => [{ id: b.approval }],
  "files.announce": (b) => [
    { id: b.file, subjectKind: "dispute", subjectId: `${MARK}-1`, fileName: "x.jpg", mimeType: "image/jpeg", sizeBytes: 10 },
  ],
  "files.confirm": (b) => [{ id: b.file }],
  "files.list": () => [{ subjectKind: "dispute", subjectId: `${MARK}-1` }],
  "files.remove": (b) => [{ id: b.file }],
  "notifications.list": () => [undefined],
  "notifications.unreadCount": () => [undefined],
  "notifications.markRead": (b) => [{ ids: [b.notification] }, {}],
  "support.list": () => [undefined],
  "support.grant": () => [{ engineerEmail: "canary@flowless.example", reason: "Tenant A's own ticket", hours: 1 }],
  "support.revoke": (b) => [{ id: b.grant }],
};

beforeAll(async () => {
  t = await startTestDatabase();
  ownerA = await addMember(t, tenants.a.id, "owner");
  ownerB = await addMember(t, tenants.b.id, "owner");
  await setEntitlements(t.app, tenants.a.id, [...MODULE_KEYS]);
  await setEntitlements(t.app, tenants.b.id, [...MODULE_KEYS]);
  b = await seedB();

  bIdentifiers = new Set([tenants.b.id]);
  for (const rows of Object.values(await snapshotB())) for (const row of rows) for (const id of row.match(UUID) ?? []) bIdentifiers.add(id);
  const bMembers = await t.admin.execute<{ user_id: string }>(sql`select user_id from auth.member where organization_id = ${tenants.b.id}`);
  for (const m of bMembers) bIdentifiers.add(m.user_id);
  // Identifiers A legitimately shares with B are not canaries.
  bIdentifiers.delete(tenants.a.id);
});
afterAll(() => t?.stop());

/** B identifiers in `text` that the caller did not send itself. */
function leaks(text: string, input: unknown): string[] {
  const sent = JSON.stringify(input ?? null);
  const found = [...new Set(text.match(UUID) ?? [])].filter((id) => bIdentifiers.has(id) && !sent.includes(id));
  if (text.includes(MARK) && !sent.includes(MARK)) found.push(MARK);
  return found;
}

// NF-02: with two tenants seeded, every endpoint run as tenant A returns zero tenant B identifiers.
describe("isolation canary", () => {
  it("covers every endpoint", () => {
    expect(procedures().map((p) => p.path).sort()).toEqual(Object.keys(CALLS).sort());
  });

  it("seeded tenant B in every tenant table it can", async () => {
    const empty = Object.entries(await snapshotB()).filter(([, rows]) => rows.length === 0).map(([table]) => table);
    // Tables only the worker or Flowless fill, or that B's seed has no reason to touch.
    expect(empty.filter((table) => !["approval_decision", "consumer_receipt"].includes(table))).toEqual([]);
  });

  it("returns no tenant B identifier from any endpoint, and changes nothing of B's", async () => {
    const before = await snapshotB();
    const caller = callerFor(t, ownerA);
    const found: string[] = [];
    for (const { path } of procedures()) {
      for (const input of CALLS[path]!(b)) {
        let text: string;
        try {
          text = JSON.stringify(superjson.serialize(await callPath(caller, path, input)).json ?? null);
        } catch (error) {
          text = error instanceof Error ? `${error.message} ${JSON.stringify((error as { cause?: unknown }).cause ?? null)}` : String(error);
        }
        for (const id of leaks(text, input)) found.push(`${path}(${JSON.stringify(input)}) leaked ${id}`);
      }
    }
    expect(found).toEqual([]);
    expect(await snapshotB()).toEqual(before);
  });

  it("would notice a leak: the same calls made as tenant B do return B's identifiers", async () => {
    const caller = callerFor(t, ownerB);
    const seen = new Set<string>();
    for (const path of ["hierarchy.areas", "exceptions.list", "notifications.list", "support.list", "audit.list"]) {
      for (const id of leaks(JSON.stringify(superjson.serialize(await callPath(caller, path, undefined)).json), null)) seen.add(id);
    }
    expect(seen).toContain(MARK);
    expect([b.scheme, b.exception, b.notification, b.grant].filter((id) => !seen.has(id))).toEqual([]);
    expect(bIdentifiers.size).toBeGreaterThan(10);
  });

  it("returns nothing of tenant B from any report", async () => {
    for (const report of reports) {
      const rows = await withTenant(t.app, tenants.a.id, async (tx) => {
        expect(await reportPublishProblems(tx, report.query(report.params.parse({})))).toEqual([]);
        return tx.execute(report.query(report.params.parse({})));
      });
      expect(leaks(JSON.stringify(rows), null)).toEqual([]);
    }
  });
});
