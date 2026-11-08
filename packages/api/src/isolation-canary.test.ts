import {
  approvalRequest,
  asset,
  conditionLog,
  crew,
  crewMember,
  dma,
  dmaBoundaryValve,
  enqueueEvent,
  file,
  job,
  node,
  pipe,
  serviceConnection,
  structure,
  structureAttachmentRule,
  subnetwork,
  tier,
  valveStateLog,
  withTenant,
  workOrder,
  workOrderAsset,
  workOrderCapture,
  workOrderChangeSet,
  workOrderComment,
  workOrderCounter,
  workOrderEvent,
  workOrderLogLink,
  type Transaction,
} from "@flowless/db";
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

/** Schemas holding tenant tables: the kernel and every module schema. */
const TENANT_SCHEMAS = ["kernel", "gis", "work_orders"];

async function tenantTables(): Promise<{ schema: string; table: string }[]> {
  const rows = await t.admin.execute<{ table_schema: string; table_name: string }>(sql`
    select table_schema, table_name from information_schema.columns
     where table_schema in (${sql.join(TENANT_SCHEMAS.map((s) => sql`${s}`), sql`, `)}) and column_name = 'organization_id'
     order by table_schema, table_name`);
  return rows.map((r) => ({ schema: r.table_schema, table: r.table_name }));
}

/** Every row of tenant B, as text, table by table: what A must never change or see. */
async function snapshotB(): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const { schema, table } of await tenantTables()) {
    const rows = await t.admin.execute<{ row: string }>(
      sql`select row_to_json(x)::text as row from ${sql.identifier(schema)}.${sql.identifier(table)} x where organization_id = ${tenants.b.id}`,
    );
    out[`${schema}.${table}`] = rows.map((r) => r.row).sort();
  }
  return out;
}

async function seedB(): Promise<Canary> {
  const asB = callerFor(t, ownerB);
  const clerkB = await addMember(t, tenants.b.id, "clerk");
  const scheme = await asB.hierarchy.createArea({ level: "scheme", code: "CNB", name: `${MARK} scheme` });
  const zone = await asB.hierarchy.createArea({ level: "zone", code: "CNBZ", name: `${MARK} zone`, parentId: scheme.id });
  const route = await asB.hierarchy.createRoute({ code: "CNB-1", name: `${MARK} route`, areaId: zone.id });
  const dmaArea = await asB.hierarchy.createArea({ level: "dma", code: "CNBD", name: `${MARK} DMA`, parentId: zone.id });
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
    await seedNetworkAndJobs(tx, { dmaAreaId: dmaArea.id, routeId: route.id, userId: clerkB.userId });
    return { exception: exception.id, approval: approval!.id, file: fileId };
  });
  const [notification] = await asB.notifications.list();
  return { scheme: scheme.id, route: route.id, member: clerkB.userId, grant: grant.id, notification: notification!.id, ...seeded };
}

/**
 * Tenant B's GIS network and jobs, one row or more in every gis and work_orders table,
 * written directly until the GIS and Work Orders APIs exist (Phase 2 W2, W3); then seed
 * them through those APIs like the kernel rows above.
 */
async function seedNetworkAndJobs(tx: Transaction, at: { dmaAreaId: string; routeId: string; userId: string }) {
  const organizationId = tenants.b.id;
  const by = { organizationId, createdByUserId: at.userId };
  const newAsset = async (kind: "node" | "pipe" | "structure" | "service_connection") =>
    (await tx.insert(asset).values({ ...by, kind }).returning({ id: asset.id }))[0]!.id;
  const here = { lat: -6.7924, lng: 39.2083 };
  const inlet = { lat: -6.7925, lng: 39.2084 };

  await tx.insert(structureAttachmentRule).values({ organizationId, nodeType: "valve", structureType: "chamber" });
  const chamber = await newAsset("structure");
  await tx.insert(structure).values({ ...by, id: chamber, type: "chamber", name: `${MARK} chamber`, location: here });
  const valve = await newAsset("node");
  const meter = await newAsset("node");
  await tx.insert(node).values([
    { ...by, id: valve, type: "valve", name: `${MARK} valve`, location: here, structureId: chamber, isOpen: true },
    { ...by, id: meter, type: "meter", name: `${MARK} inlet meter`, location: inlet },
  ]);
  const main = await newAsset("pipe");
  await tx.insert(pipe).values({ ...by, id: main, fromNodeId: meter, toNodeId: valve, path: [inlet, here], diameterMm: 110, lengthM: 15 });
  const connection = await newAsset("service_connection");
  await tx
    .insert(serviceConnection)
    .values({ ...by, id: connection, connectionNumber: `${MARK}-SC1`, location: here, pipeId: main, servicePointId: randomUUID() });
  const [band] = await tx.insert(tier).values({ organizationId, name: `${MARK} tier`, order: 1 }).returning({ id: tier.id });
  const [dmaVersion] = await tx
    .insert(dma)
    .values({
      ...by,
      areaId: at.dmaAreaId,
      color: "#3B82F6",
      tierId: band!.id,
      inletMeterId: meter,
      boundary: [
        { lat: -6.79, lng: 39.2 },
        { lat: -6.79, lng: 39.21 },
        { lat: -6.8, lng: 39.21 },
      ],
    })
    .returning({ versionId: dma.versionId });
  await tx.insert(dmaBoundaryValve).values({ organizationId, dmaVersionId: dmaVersion!.versionId, valveId: valve });
  await tx.insert(subnetwork).values({ organizationId, name: `${MARK} subnetwork`, tierId: band!.id, controllerNodeId: meter });
  const [leakLog] = await tx
    .insert(conditionLog)
    .values({ organizationId, assetId: main, condition: "poor", note: `${MARK} leak`, recordedAt: new Date(), recordedByUserId: at.userId })
    .returning({ id: conditionLog.id });
  await tx.insert(valveStateLog).values({ organizationId, valveId: valve, isOpen: false, note: MARK, changedAt: new Date(), changedByUserId: at.userId });

  const [team] = await tx.insert(crew).values({ organizationId, name: `${MARK} crew` }).returning({ id: crew.id });
  await tx.insert(crewMember).values({ organizationId, crewId: team!.id, userId: at.userId });
  await tx.insert(workOrderCounter).values({ organizationId, nextNumber: 2 });
  const [job] = await tx
    .insert(workOrder)
    .values({
      ...by,
      code: "WO-1",
      title: `${MARK} leak repair`,
      kind: "leak",
      assetModule: "gis",
      assetId: main,
      areaId: at.dmaAreaId,
      routeId: at.routeId,
      location: here,
      assignedToUserId: at.userId,
      crewId: team!.id,
      dueAt: new Date(Date.now() + 86_400_000),
    })
    .returning({ id: workOrder.id });
  const workOrderId = job!.id;
  await tx.insert(workOrderAsset).values({ organizationId, workOrderId, module: "gis", assetId: main, role: "primary", addedByUserId: at.userId });
  await tx.insert(workOrderChangeSet).values({ ...by, workOrderId, branch: "wo-WO-1" });
  await tx.insert(workOrderEvent).values({
    id: randomUUID(),
    organizationId,
    workOrderId,
    type: "create",
    outcome: "applied",
    payload: { mark: MARK },
    actorUserId: at.userId,
    latitude: here.lat,
    longitude: here.lng,
    occurredAt: new Date(),
  });
  await tx.insert(workOrderLogLink).values({ organizationId, workOrderId, logKind: "condition", logId: leakLog!.id });
  await tx
    .insert(workOrderComment)
    .values({ id: randomUUID(), organizationId, workOrderId, authorUserId: at.userId, body: `${MARK} comment`, createdAt: new Date() });
  await tx.insert(workOrderCapture).values({
    id: randomUUID(),
    organizationId,
    workOrderId,
    kind: "leak",
    data: { mark: MARK },
    capturedByUserId: at.userId,
    capturedAt: new Date(),
  });
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
    expect(empty.filter((table) => !["kernel.approval_decision", "kernel.consumer_receipt"].includes(table))).toEqual([]);
    // Every gis and work_orders table is covered (Phase 2: "the canary covers every table").
    expect(Object.keys(await snapshotB()).filter((table) => !table.startsWith("kernel.")).length).toBe(22);
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
