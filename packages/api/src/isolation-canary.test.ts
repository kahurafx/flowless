import { approvalRequest, enqueueEvent, file, job, withTenant } from "@flowless/db";
import { startTestDatabase, tenants, type TestDatabase } from "@flowless/db/testing";
import { DATA_QUALITY_RULE_KEYS, MODULE_KEYS } from "@flowless/shared-types";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import superjson from "superjson";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setEntitlements } from "./kernel/entitlement-store";
import { raiseException } from "./kernel/exception-store";
import { notify } from "./kernel/notification-store";
import { reportPublishProblems } from "./kernel/report-guard";
import { reports } from "./wiring";
import { allocateInvoiceNumber } from "./modules/tariffs";
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
  /** A job raised, crewed, commented on and submitted through the Work Orders API. */
  workOrder: string;
  crew: string;
  comment: string;
  /** Tenant B's GIS network, built through the GIS API (Phase 2 W3). */
  gis: GisCanary;
  /** Tenant B's customer, account, child account and service point, built through the Accounts API (Phase 3 F1). */
  accounts: AccountsCanary;
  /** Tenant B's category, tariff, charge items and invoice type, built through the Tariffs API (Phase 3 F2). */
  tariffs: TariffsCanary;
}

interface TariffsCanary {
  category: string;
  assignment: string;
  tariff: string;
  tariffVersion: string;
  chargeItem: string;
  chargeCode: string;
  recurringItem: string;
  invoiceType: string;
  invoiceTypeCode: string;
}

interface AccountsCanary {
  customer: string;
  contact: string;
  account: string;
  accountNumber: string;
  child: string;
  servicePoint: string;
  /** A status command on B's account, the checklist tick beside it, and a write-off request (Phase 3 F3a). */
  command: string;
  writeOff: string;
  /** An application with a survey awaiting approval, a relocation under way, and a succession (Phase 3 F3b). */
  application: string;
  surveyApproval: string;
  relocation: string;
  predecessor: string;
  successor: string;
  succeedCommand: string;
}

interface GisCanary {
  valve: { id: string; versionId: string };
  meter: string;
  pipe: { id: string; versionId: string };
  structure: { id: string; versionId: string };
  connection: { id: string; versionId: string };
  dma: { id: string; versionId: string };
  tier: string;
  subnetwork: string;
  conditionLog: string;
  valveLog: string;
  /** An open branch with an edit of B's on it. */
  branch: string;
  /** A GIS job on B's pipe, with the condition log linked to it. */
  leakJob: string;
}

const MARK = "CANARY-B";
/** Where tenant A's own GIS calls draw things. */
const A_HERE = { lat: -1.29, lng: 36.8 };
const A_THERE = { lat: -1.3, lng: 36.8 };
const A_RING = [
  { lat: -1.28, lng: 36.79 },
  { lat: -1.28, lng: 36.81 },
  { lat: -1.3, lng: 36.81 },
];
let t: TestDatabase;
let ownerA: Member;
let ownerB: Member;
let b: Canary;
/** Every identifier in tenant B's rows, and B's organization id. */
let bIdentifiers: Set<string>;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** Schemas holding tenant tables: the kernel and every module schema. */
const TENANT_SCHEMAS = ["kernel", "gis", "work_orders", "accounts", "tariffs"];

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
  const team = await asB.workOrders.crews.create({ name: `${MARK} crew` });
  await asB.workOrders.crews.addMember({ crewId: team.id, userId: clerkB.userId });

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
  const survey = await asB.workOrders.create({
    title: `${MARK} survey`,
    kind: "survey",
    areaId: dmaArea.id,
    routeId: route.id,
    assigneeId: clerkB.userId,
    crewId: team.id,
    location: { latitude: -6.7924, longitude: 39.2083 },
  });
  const comment = randomUUID();
  await asB.workOrders.comment({ id: comment, workOrderId: survey.id, body: `${MARK} comment` });
  await asB.workOrders.changeSet({ workOrderId: survey.id });
  await asB.workOrders.transition({
    eventId: randomUUID(),
    workOrderId: survey.id,
    action: { type: "submit", outcome: "done", note: MARK, capture: { summary: `${MARK} findings` } },
    position: { latitude: -6.7924, longitude: 39.2083 },
  });
  const gis = await seedNetwork(asB, { dmaAreaId: dmaArea.id, routeId: route.id, userId: clerkB.userId, crewId: team.id });
  const accounts = await seedAccounts(asB, { schemeId: scheme.id, zoneId: zone.id, dmaId: dmaArea.id, routeId: route.id, connectionId: gis.connection.id });
  const tariffs = await seedTariffs(asB);
  const [notification] = await asB.notifications.list();
  return {
    scheme: scheme.id,
    route: route.id,
    member: clerkB.userId,
    grant: grant.id,
    notification: notification!.id,
    workOrder: survey.id,
    crew: team.id,
    comment,
    gis,
    accounts,
    tariffs,
    ...seeded,
  };
}

/**
 * Tenant B's Accounts records, through the Accounts API: a customer with a phone and an email,
 * an account and a child of it (which also fill the counter), and a service point placed in
 * B's hierarchy and linked to B's GIS connection.
 */
async function seedAccounts(
  asB: ReturnType<typeof callerFor>,
  at: { schemeId: string; zoneId: string; dmaId: string; routeId: string; connectionId: string },
): Promise<AccountsCanary> {
  const customer = await asB.accounts.customers.create({
    type: "person",
    name: `${MARK} customer`,
    nationalId: "CANARYID1",
    contacts: [
      { channel: "phone", value: "0733 999 888" },
      { channel: "email", value: "canary-b@example.test" },
    ],
  });
  const account = await asB.accounts.create({ customerId: customer.id });
  const child = await asB.accounts.create({ customerId: customer.id, parentAccountId: account.id });
  const servicePoint = await asB.accounts.servicePoints.create({
    accountId: account.id,
    address: `${MARK} plot`,
    location: { lat: -6.7924, lng: 39.2083 },
    schemeId: at.schemeId,
    zoneId: at.zoneId,
    dmaId: at.dmaId,
    routeId: at.routeId,
    gisConnectionId: at.connectionId,
  });
  // The lifecycle (F3a): a command with its client-minted id, a checklist tick, and a write-off request.
  const command = randomUUID();
  await asB.accounts.markPendingPayment({ id: command, accountId: account.id, reason: `${MARK} invoice issued`, note: `${MARK} note` });
  await asB.accounts.activation.tick({ accountId: account.id, gateKey: "payment_threshold", note: `${MARK} receipt` });
  const writeOff = await asB.accounts.requestWriteOff({ accountId: child.id, amount: 55_000n, reasonCode: "OTHER", note: `${MARK} write-off` });
  // Applications, relocation and succession (F3b): an application with a survey waiting for approval, a relocation under way, and an account succeeded.
  const place = { schemeId: at.schemeId, zoneId: at.zoneId, dmaId: at.dmaId, routeId: at.routeId };
  const applied = await asB.accounts.applications.create({
    newCustomer: { type: "person", name: `${MARK} applicant`, contacts: [{ channel: "phone", value: "0711 000 999" }] },
    address: `${MARK} application plot`,
    location: { lat: -6.79, lng: 39.21 },
    ...place,
  });
  const survey = await asB.accounts.applications.recordSurvey({ applicationId: applied.application.id, feasibility: "feasible", findings: `${MARK} findings` });
  const moving = await asB.accounts.relocations.request({
    accountId: account.id,
    fromServicePointId: servicePoint.id,
    to: { address: `${MARK} new plot`, ...place },
    reason: `${MARK} relocation`,
  });
  const older = await asB.accounts.create({ customerId: customer.id });
  await asB.accounts.activate({ accountId: older.id, reason: `${MARK} activated`, override: true });
  const succeeded = await asB.accounts.succeed({ id: randomUUID(), accountId: older.id, basis: "relocation_new_number", reason: `${MARK} succession` });
  return {
    application: applied.application.id,
    surveyApproval: survey.approval!.id,
    relocation: moving.relocation.id,
    predecessor: older.id,
    successor: succeeded.successor.id,
    succeedCommand: succeeded.command.id,
    customer: customer.id,
    contact: customer.contacts[0]!.id,
    account: account.id,
    accountNumber: account.number,
    child: child.id,
    servicePoint: servicePoint.id,
    command,
    writeOff: writeOff.approvalId,
  };
}

/**
 * Tenant B's Tariffs records, through the Tariffs API: a category assigned a tariff (two
 * versions, one ahead), a recurring and a fee charge item with amounts, and an invoice type
 * with a line template, a late-fee rule and a number taken from its counter.
 */
async function seedTariffs(asB: ReturnType<typeof callerFor>): Promise<TariffsCanary> {
  const tariff = await asB.tariffs.create({
    name: `${MARK} tariff`,
    type: "increasing_block",
    content: { type: "increasing_block", bands: [{ from: 0, to: 6, rate: 8250n }, { from: 6, to: null, rate: 9600n }] },
  });
  await asB.tariffs.addVersion({ tariffId: tariff.id, content: { type: "increasing_block", bands: [{ from: 0, to: null, rate: 9900n }] }, effectiveFrom: "2099-01-01" });
  const recurring = await asB.tariffs.chargeItems.create({ code: "canary_standing", name: `${MARK} standing charge`, type: "recurring", amount: 15_000n });
  const fee = await asB.tariffs.chargeItems.create({ code: "canary_fee", name: `${MARK} fee`, type: "fee", amount: 250_000n });
  await asB.tariffs.chargeItems.addAmountVersion({ chargeItemId: fee.id, amount: 300_000n, effectiveFrom: "2099-01-01" });
  const category = await asB.tariffs.categories.create({ code: "canary_category", name: `${MARK} category` });
  const assignment = await asB.tariffs.categories.assignTariff({ categoryId: category.id, tariffId: tariff.id, standingChargeItemId: recurring.id });
  const invoiceType = await asB.tariffs.invoiceTypes.create({
    code: "canary_invoice",
    name: `${MARK} invoice type`,
    appliesTo: "application",
    numbering: { prefix: "CB-", width: 5, start: 1 },
    overdue: { action: "pause_application", afterDays: 3 },
    lines: [{ chargeItemCode: "canary_fee" }],
    lateFeeRule: { triggerDays: 7, base: "overdue_balance", rateBp: 500, frequency: "monthly", cap: 100_000n },
  });
  await withTenant(t.app, tenants.b.id, (tx) => allocateInvoiceNumber(tx, tenants.b.id, invoiceType.id));
  return {
    category: category.id,
    assignment: assignment.id,
    tariff: tariff.id,
    tariffVersion: tariff.firstVersion.id,
    chargeItem: fee.id,
    chargeCode: fee.code,
    recurringItem: recurring.id,
    invoiceType: invoiceType.id,
    invoiceTypeCode: invoiceType.code,
  };
}

/**
 * Tenant B's GIS network, through the GIS API: tier, structure, a housed valve, an inlet
 * meter, a pipe, a service connection, DMA map data with a boundary valve, a subnetwork,
 * condition and valve logs, an open branch, and a GIS job with its asset and linked log.
 * The first GIS write seeds B's structure-attachment rules.
 */
async function seedNetwork(asB: ReturnType<typeof callerFor>, at: { dmaAreaId: string; routeId: string; userId: string; crewId: string }): Promise<GisCanary> {
  const here = { lat: -6.7924, lng: 39.2083 };
  const inlet = { lat: -6.7925, lng: 39.2084 };
  const tier = await asB.gis.tiers.create({ name: `${MARK} tier`, order: 1 });
  const chamber = await asB.gis.structures.create({ type: "chamber", name: `${MARK} chamber`, location: here });
  const valve = await asB.gis.nodes.create({ type: "valve", name: `${MARK} valve`, location: here, structureId: chamber.id, isOpen: true });
  const meter = await asB.gis.nodes.create({ type: "meter", name: `${MARK} inlet meter`, location: inlet });
  const main = await asB.gis.pipes.create({ fromNodeId: meter.id, toNodeId: valve.id, path: [inlet, here], diameterMm: 110 });
  const connection = await asB.gis.connections.create({ connectionNumber: `${MARK}-SC1`, location: here, pipeId: main.id, servicePointId: randomUUID() });
  const dma = await asB.gis.dmas.create({
    areaId: at.dmaAreaId,
    color: "#3B82F6",
    tierId: tier.id,
    inletMeterId: meter.id,
    boundaryValveIds: [valve.id],
    ring: [
      { lat: -6.79, lng: 39.2 },
      { lat: -6.79, lng: 39.21 },
      { lat: -6.8, lng: 39.21 },
    ],
  });
  const subnetwork = await asB.gis.subnetworks.create({ name: `${MARK} subnetwork`, tierId: tier.id, controllerNodeId: meter.id });
  const leakLog = await asB.gis.logs.recordCondition({ assetId: main.id, condition: "poor", note: `${MARK} leak` });
  const valveLog = await asB.gis.logs.recordValveState({ valveId: valve.id, isOpen: false, note: MARK });
  const branch = "canary-b-branch";
  await asB.gis.nodes.update({ id: meter.id, baseVersionId: meter.versionId, branch, patch: { name: `${MARK} meter on a branch` } });

  const leak = await asB.workOrders.create({
    title: `${MARK} leak repair`,
    kind: "leak",
    assetId: main.id,
    areaId: at.dmaAreaId,
    routeId: at.routeId,
    location: { latitude: here.lat, longitude: here.lng },
    assigneeId: at.userId,
    crewId: at.crewId,
  });
  await asB.workOrders.linkLog({ eventId: randomUUID(), workOrderId: leak.id, logKind: "condition", logId: leakLog.log.id });
  const current = await asB.gis.nodes.byId({ id: valve.id });
  return {
    valve: { id: valve.id, versionId: current.versionId },
    meter: meter.id,
    pipe: { id: main.id, versionId: (await asB.gis.pipes.byId({ id: main.id })).versionId },
    structure: { id: chamber.id, versionId: chamber.versionId },
    connection: { id: connection.id, versionId: connection.versionId },
    dma: { id: dma.id, versionId: dma.versionId },
    tier: tier.id,
    subnetwork: subnetwork.id,
    conditionLog: leakLog.log.id,
    valveLog: valveLog.log.id,
    branch,
    leakJob: leak.id,
  };
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
    { id: randomUUID(), subjectKind: "work_order", subjectId: b.workOrder, fileName: "x.jpg", mimeType: "image/jpeg", sizeBytes: 10 },
    { id: randomUUID(), subjectKind: "gis_asset", subjectId: b.gis.valve.id, fileName: "x.jpg", mimeType: "image/jpeg", sizeBytes: 10 },
  ],
  "files.confirm": (b) => [{ id: b.file }],
  "files.list": (b) => [
    { subjectKind: "dispute", subjectId: `${MARK}-1` },
    { subjectKind: "work_order", subjectId: b.workOrder },
    { subjectKind: "gis_asset", subjectId: b.gis.valve.id },
  ],
  "files.remove": (b) => [{ id: b.file }],
  "notifications.list": () => [undefined],
  "notifications.unreadCount": () => [undefined],
  "notifications.markRead": (b) => [{ ids: [b.notification] }, {}],
  "support.list": () => [undefined],
  "support.grant": () => [{ engineerEmail: "canary@flowless.example", reason: "Tenant A's own ticket", hours: 1 }],
  "support.revoke": (b) => [{ id: b.grant }],
  "workOrders.kinds": () => [undefined],
  "workOrders.mine": () => [undefined],
  "workOrders.list": (b) => [undefined, { parentId: b.workOrder }, { crewId: b.crew }, { assigneeId: b.member }, { statuses: ["submitted"] }],
  "workOrders.byId": (b) => [{ id: b.workOrder }, { id: b.gis.leakJob }],
  "workOrders.history": (b) => [{ workOrderId: b.workOrder }],
  "workOrders.comments": (b) => [{ workOrderId: b.workOrder }],
  "workOrders.create": (b) => [
    { title: "A's inspection", kind: "inspection_general" },
    { title: "Under B's job", kind: "inspection_general", parentId: b.workOrder },
    { title: "In B's area", kind: "inspection_general", areaId: b.scheme, routeId: b.route },
    { title: "B's crew", kind: "inspection_general", crewId: b.crew },
    { title: "For B's clerk", kind: "inspection_general", assigneeId: b.member },
    { id: b.workOrder, title: "B's id", kind: "inspection_general" },
  ],
  "workOrders.assign": (b) => [{ id: b.workOrder, assigneeId: null }],
  "workOrders.schedule": (b) => [{ id: b.workOrder, dueAt: new Date(Date.now() + 3_600_000), priority: "urgent" }],
  "workOrders.cancel": (b) => [{ id: b.workOrder, cascade: true }],
  "workOrders.transition": (b) => [{ eventId: randomUUID(), workOrderId: b.workOrder, action: { type: "hold", reason: "A was here" } }],
  "workOrders.review": (b) => [{ eventId: randomUUID(), workOrderId: b.workOrder, decision: "approve" }],
  "workOrders.finalize": (b) => [{ eventId: randomUUID(), workOrderId: b.workOrder }],
  "workOrders.addAsset": (b) => [{ eventId: randomUUID(), workOrderId: b.workOrder, assetId: randomUUID() }],
  "workOrders.changeSet": (b) => [{ workOrderId: b.workOrder }],
  "workOrders.linkLog": (b) => [
    { eventId: randomUUID(), workOrderId: b.workOrder, logKind: "condition", logId: randomUUID() },
    { eventId: randomUUID(), workOrderId: b.gis.leakJob, logKind: "condition", logId: b.gis.conditionLog },
  ],
  "workOrders.comment": (b) => [
    { id: randomUUID(), workOrderId: b.workOrder, body: "A's note" },
    { id: b.comment, workOrderId: b.workOrder, body: "A's note" },
  ],
  "workOrders.crews.list": () => [undefined, { includeArchived: true }],
  "workOrders.crews.create": () => [{ name: "A's crew" }],
  "workOrders.crews.rename": (b) => [{ id: b.crew, name: "Renamed by A" }],
  "workOrders.crews.archive": (b) => [{ id: b.crew }],
  "workOrders.crews.addMember": (b) => [{ crewId: b.crew, userId: b.member }],
  "workOrders.crews.removeMember": (b) => [{ crewId: b.crew, userId: b.member }],
  // GIS (Phase 2 W3): A's own calls, and calls aimed at B's assets, branch, logs, DMA, tier and subnetwork.
  "gis.nodes.list": (b) => [undefined, { branch: b.gis.branch }, { types: ["valve"] }],
  "gis.nodes.page": (b) => [{}, { branch: b.gis.branch, cursor: b.gis.valve.id }],
  "gis.nodes.byId": (b) => [{ id: b.gis.valve.id }, { id: b.gis.meter, branch: b.gis.branch }],
  "gis.nodes.history": (b) => [{ id: b.gis.valve.id }],
  "gis.nodes.create": (b) => [
    { type: "junction", name: "A's junction", location: A_HERE },
    { id: b.gis.valve.id, type: "junction", name: "B's id", location: A_HERE },
    { type: "valve", name: "In B's chamber", location: A_HERE, isOpen: true, structureId: b.gis.structure.id },
    { type: "junction", name: "On B's branch", location: A_HERE, branch: b.gis.branch },
  ],
  "gis.nodes.update": (b) => [
    { id: b.gis.valve.id, baseVersionId: b.gis.valve.versionId, patch: { name: "Renamed by A" } },
    { id: b.gis.valve.id, baseVersionId: b.gis.valve.versionId, branch: "a-branch", patch: { name: "Renamed by A" } },
  ],
  "gis.nodes.delete": (b) => [{ id: b.gis.valve.id, baseVersionId: b.gis.valve.versionId }],
  "gis.nodes.deleted": () => [undefined],
  "gis.nodes.deleteImpact": (b) => [{ id: b.gis.valve.id }],
  "gis.nodes.restore": (b) => [{ id: b.gis.valve.id }],
  "gis.structures.list": (b) => [undefined, { branch: b.gis.branch }],
  "gis.structures.page": () => [{}],
  "gis.structures.byId": (b) => [{ id: b.gis.structure.id }],
  "gis.structures.history": (b) => [{ id: b.gis.structure.id }],
  "gis.structures.create": (b) => [
    { type: "vault", name: "A's vault", location: A_HERE },
    { id: b.gis.structure.id, type: "vault", name: "B's id", location: A_HERE },
  ],
  "gis.structures.update": (b) => [{ id: b.gis.structure.id, baseVersionId: b.gis.structure.versionId, patch: { name: "Renamed by A" } }],
  "gis.structures.delete": (b) => [{ id: b.gis.structure.id, baseVersionId: b.gis.structure.versionId }],
  "gis.structures.deleted": () => [undefined],
  "gis.structures.deleteImpact": (b) => [{ id: b.gis.structure.id }],
  "gis.structures.restore": (b) => [{ id: b.gis.structure.id }],
  "gis.pipes.list": (b) => [undefined, { branch: b.gis.branch }],
  "gis.pipes.page": () => [{}],
  "gis.pipes.byId": (b) => [{ id: b.gis.pipe.id }],
  "gis.pipes.history": (b) => [{ id: b.gis.pipe.id }],
  "gis.pipes.create": (b) => [{ fromNodeId: b.gis.meter, toNodeId: b.gis.valve.id, path: [A_HERE, A_THERE], diameterMm: 100 }],
  "gis.pipes.update": (b) => [{ id: b.gis.pipe.id, baseVersionId: b.gis.pipe.versionId, patch: { diameterMm: 1 } }],
  "gis.pipes.delete": (b) => [{ id: b.gis.pipe.id, baseVersionId: b.gis.pipe.versionId }],
  "gis.pipes.deleted": () => [undefined],
  "gis.pipes.deleteImpact": (b) => [{ id: b.gis.pipe.id }],
  "gis.pipes.restore": (b) => [{ id: b.gis.pipe.id }],
  "gis.connections.list": (b) => [undefined, { branch: b.gis.branch }],
  "gis.connections.byId": (b) => [{ id: b.gis.connection.id }],
  "gis.connections.create": (b) => [
    { connectionNumber: "A-SC1", location: A_HERE },
    { connectionNumber: "A-SC2", location: A_HERE, pipeId: b.gis.pipe.id },
    { id: b.gis.connection.id, connectionNumber: "A-SC3", location: A_HERE },
  ],
  "gis.connections.update": (b) => [{ id: b.gis.connection.id, baseVersionId: b.gis.connection.versionId, patch: { connectionNumber: "A-X" } }],
  "gis.connections.delete": (b) => [{ id: b.gis.connection.id, baseVersionId: b.gis.connection.versionId }],
  "gis.connections.deleted": () => [undefined],
  "gis.connections.deleteImpact": (b) => [{ id: b.gis.connection.id }],
  "gis.connections.restore": (b) => [{ id: b.gis.connection.id }],
  "gis.dmas.list": (b) => [undefined, { branch: b.gis.branch }],
  "gis.dmas.byId": (b) => [{ id: b.gis.dma.id }],
  "gis.dmas.history": (b) => [{ id: b.gis.dma.id }],
  "gis.dmas.analysis": (b) => [{ id: b.gis.dma.id }],
  "gis.dmas.create": (b) => [
    { areaId: b.gis.dma.id, color: "#112233", tierId: b.gis.tier, inletMeterId: b.gis.meter, ring: A_RING },
    { areaId: b.scheme, color: "#112233", tierId: b.gis.tier, inletMeterId: b.gis.meter, ring: A_RING },
  ],
  "gis.dmas.update": (b) => [{ id: b.gis.dma.id, baseVersionId: b.gis.dma.versionId, patch: { color: "#000000" } }],
  "gis.dmas.delete": (b) => [{ id: b.gis.dma.id, baseVersionId: b.gis.dma.versionId }],
  "gis.tiers.list": () => [undefined],
  "gis.tiers.create": () => [{ name: "A's tier", order: 1 }],
  "gis.tiers.update": (b) => [{ id: b.gis.tier, patch: { name: "Renamed by A" } }],
  "gis.tiers.delete": (b) => [{ id: b.gis.tier }],
  "gis.subnetworks.list": () => [undefined],
  "gis.subnetworks.byId": (b) => [{ id: b.gis.subnetwork }],
  "gis.subnetworks.create": (b) => [{ name: "On B's", tierId: b.gis.tier, controllerNodeId: b.gis.meter }],
  "gis.subnetworks.update": (b) => [{ id: b.gis.subnetwork, patch: { name: "Renamed by A" } }],
  "gis.subnetworks.delete": (b) => [{ id: b.gis.subnetwork }],
  "gis.subnetworks.members": (b) => [{ id: b.gis.subnetwork }],
  "gis.subnetworks.validate": (b) => [{ id: b.gis.subnetwork }],
  "gis.attachmentRules.list": () => [undefined],
  "gis.attachmentRules.set": () => [{ nodeType: "hydrant", structureTypes: ["kiosk"] }],
  "gis.trace.directional": (b) => [{ startNodeId: b.gis.meter, direction: "downstream" }],
  "gis.trace.isolation": (b) => [{ failedPipeId: b.gis.pipe.id }],
  "gis.logs.recordCondition": (b) => [
    { assetId: b.gis.pipe.id, condition: "critical" },
    { id: b.gis.conditionLog, assetId: b.gis.pipe.id, condition: "critical" },
  ],
  "gis.logs.recordValveState": (b) => [
    { valveId: b.gis.valve.id, isOpen: true },
    { id: b.gis.valveLog, valveId: b.gis.valve.id, isOpen: true },
  ],
  "gis.logs.conditionHistory": (b) => [{ assetId: b.gis.pipe.id }],
  "gis.logs.valveHistory": (b) => [{ valveId: b.gis.valve.id }],
  "gis.logs.conditionFeed": () => [undefined, { conditions: ["poor"] }],
  "gis.logs.valveFeed": () => [undefined],
  "gis.reconcile.branches": () => [undefined],
  "gis.reconcile.preview": (b) => [{ branch: b.gis.branch }],
  "gis.reconcile.post": (b) => [{ branch: b.gis.branch, token: "canary", override: true }],
  "gis.reconcile.discard": (b) => [{ branch: b.gis.branch }],
  "gis.reports.summary": () => [undefined],
  "gis.reports.conditionTrend": () => [undefined],
  "gis.reports.recentFindings": () => [undefined],
  "gis.reports.alerts": () => [undefined],
  // Accounts (Phase 3 F1): A's own calls, and calls aimed at B's customer, contact, accounts and service point.
  "accounts.create": (b) => [
    { customerId: b.accounts.customer },
    { customerId: b.accounts.customer, parentAccountId: b.accounts.account },
    { customerId: b.accounts.customer, parentAccountId: b.accounts.account, numbering: "own" },
  ],
  "accounts.get": (b) => [{ id: b.accounts.account }, { number: b.accounts.accountNumber }, { id: b.accounts.child }],
  "accounts.list": (b) => [
    undefined,
    { customerId: b.accounts.customer },
    { parentAccountId: b.accounts.account },
    { areaId: b.scheme },
    { routeId: b.route },
    { after: b.accounts.accountNumber },
  ],
  "accounts.search": (b) => [{ q: "customer" }, { q: b.accounts.accountNumber }, { q: "0733 999 888" }, { q: "canary-b@example.test" }],
  "accounts.nextNumberPreview": (b) => [undefined, { parentAccountId: b.accounts.account }],
  "accounts.customers.create": () => [
    { type: "person", name: "A's customer", nationalId: "CANARYID1", contacts: [{ channel: "phone", value: "0733 999 888" }] },
  ],
  "accounts.customers.update": (b) => [{ id: b.accounts.customer, patch: { name: "Renamed by A" } }],
  "accounts.customers.get": (b) => [{ id: b.accounts.customer }],
  "accounts.customers.list": (b) => [undefined, { after: b.accounts.customer }, { type: "person" }],
  "accounts.customers.search": () => [{ q: "customer" }, { q: "0733 999 888" }, { q: "canary-b@example.test" }, { q: "CANARYID1" }],
  "accounts.customers.duplicates": (b) => [{ customerId: b.accounts.customer }, { phone: "0733 999 888" }, { nationalId: "CANARYID1" }],
  "accounts.contacts.add": (b) => [{ customerId: b.accounts.customer, channel: "email", value: "a@a.test" }],
  "accounts.contacts.update": (b) => [{ id: b.accounts.contact, patch: { kind: "work" } }],
  "accounts.contacts.remove": (b) => [{ id: b.accounts.contact }],
  "accounts.servicePoints.create": (b) => [
    { accountId: b.accounts.account, address: "A at B's" },
    { accountId: b.accounts.account, address: "A at B's", schemeId: b.scheme, routeId: b.route, gisConnectionId: b.gis.connection.id },
  ],
  "accounts.servicePoints.update": (b) => [
    { id: b.accounts.servicePoint, patch: { address: "Renamed by A" } },
    { id: b.accounts.servicePoint, patch: { schemeId: b.scheme, routeId: b.route } },
  ],
  "accounts.servicePoints.get": (b) => [{ id: b.accounts.servicePoint }],
  "accounts.servicePoints.list": (b) => [undefined, { accountId: b.accounts.account }, { areaId: b.scheme }, { routeId: b.route }, { after: b.accounts.servicePoint }],
  // Tariffs (Phase 3 F2): A's own calls, and calls aimed at B's category, tariff, charge items and invoice type.
  // The account lifecycle (Phase 3 F3a): every command aimed at B's account, B's command id, B's write-off request.
  "accounts.markPendingPayment": (b) => [
    { accountId: b.accounts.account, reason: "A tries" },
    { id: b.accounts.command, accountId: b.accounts.account, reason: "A replays B's id" },
  ],
  "accounts.activate": (b) => [
    { accountId: b.accounts.account, reason: "A tries", override: true },
    { id: b.accounts.command, accountId: b.accounts.account, reason: "A replays B's id", connect: false, serviceReason: "x" },
  ],
  "accounts.makeDormant": (b) => [{ accountId: b.accounts.account, reason: "A tries" }],
  "accounts.reactivate": (b) => [{ accountId: b.accounts.account, reason: "A tries" }],
  "accounts.terminate": (b) => [
    { accountId: b.accounts.account, reason: "A tries", acknowledgeNoLedger: true },
    { accountId: b.accounts.child, reason: "A tries", approvalId: b.accounts.writeOff },
  ],
  "accounts.disconnectService": (b) => [{ accountId: b.accounts.account, reason: "A tries" }],
  "accounts.reconnectService": (b) => [{ accountId: b.accounts.account, reason: "A tries" }],
  "accounts.requestWriteOff": (b) => [{ accountId: b.accounts.account, amount: 1n, reasonCode: "OTHER", note: "A tries" }],
  "accounts.commands.list": (b) => [{ accountId: b.accounts.account }, { accountId: b.accounts.account, before: new Date() }],
  "accounts.statusRules": () => [undefined, { at: new Date(Date.now() + 86_400_000) }],
  "accounts.activation.status": (b) => [{ accountId: b.accounts.account }],
  "accounts.activation.tick": (b) => [{ accountId: b.accounts.account, gateKey: "payment_threshold", note: "A tries" }],
  "accounts.activation.untick": (b) => [{ accountId: b.accounts.account, gateKey: "payment_threshold" }],
  "accounts.activation.activate": (b) => [{ accountId: b.accounts.account, reason: "A tries", override: true }],
  // Applications, memberships, succession, relocation and change of name (Phase 3 F3b): aimed at B's ids.
  "accounts.applications.create": (b) => [
    { customerId: b.accounts.customer, address: "A at B's", schemeId: b.scheme, routeId: b.route },
    { id: b.accounts.application, newCustomer: { type: "person", name: "A applicant", contacts: [] }, address: "A replays B's id" },
    { newCustomer: { type: "person", name: "A applicant", contacts: [] }, address: "A at B's parent", parentAccountId: b.accounts.account, membershipClass: "member" },
  ],
  "accounts.applications.get": (b) => [{ id: b.accounts.application }],
  "accounts.applications.list": (b) => [undefined, { customerId: b.accounts.customer }, { after: b.accounts.application }, { stage: "enquiry" }],
  "accounts.applications.stages": () => [undefined],
  "accounts.applications.recordSurvey": (b) => [
    { applicationId: b.accounts.application, feasibility: "feasible", findings: "A tries" },
    { id: b.accounts.surveyApproval, applicationId: b.accounts.application, feasibility: "not_feasible", findings: "A replays" },
  ],
  "accounts.applications.submitApplication": (b) => [{ applicationId: b.accounts.application }],
  "accounts.applications.markInvoiced": (b) => [{ applicationId: b.accounts.application, invoiceRef: "A tries" }],
  "accounts.applications.markPaid": (b) => [{ applicationId: b.accounts.application, paymentRef: "A tries" }],
  "accounts.applications.startInstallation": (b) => [{ applicationId: b.accounts.application }],
  "accounts.applications.markReady": (b) => [{ applicationId: b.accounts.application }],
  "accounts.applications.convert": (b) => [{ applicationId: b.accounts.application }],
  "accounts.applications.reject": (b) => [{ applicationId: b.accounts.application, reason: "A tries" }],
  "accounts.applications.cancel": (b) => [{ applicationId: b.accounts.application, reason: "A tries" }],
  "accounts.memberships.classes": () => [undefined],
  "accounts.memberships.get": (b) => [{ accountId: b.accounts.child }],
  "accounts.memberships.setClass": (b) => [
    { accountId: b.accounts.child, membershipClass: "member" },
    { accountId: b.accounts.child, membershipClass: null },
  ],
  "accounts.succeed": (b) => [
    { accountId: b.accounts.account, basis: "relocation_new_number", reason: "A tries" },
    { accountId: b.accounts.child, basis: "full_membership", customerId: b.accounts.customer, reason: "A tries" },
    { id: b.accounts.succeedCommand, accountId: b.accounts.predecessor, basis: "relocation_new_number", reason: "A replays B's id" },
  ],
  "accounts.changeName": (b) => [
    { accountId: b.accounts.account, customerId: b.accounts.customer, effectiveDate: "2025-01-01", reason: "A tries" },
    { id: b.accounts.succeedCommand, accountId: b.accounts.successor, newCustomer: { type: "person", name: "A", contacts: [] }, effectiveDate: "2025-01-01", reason: "A replays B's id" },
  ],
  "accounts.holders.list": (b) => [{ accountId: b.accounts.account }, { accountId: b.accounts.successor }],
  "accounts.holders.at": (b) => [{ accountId: b.accounts.account, date: "2025-01-01" }],
  "accounts.relocations.request": (b) => [
    { accountId: b.accounts.account, fromServicePointId: b.accounts.servicePoint, to: { address: "A at B's" }, reason: "A tries" },
    { id: b.accounts.relocation, accountId: b.accounts.account, fromServicePointId: b.accounts.servicePoint, to: { address: "A replays", schemeId: b.scheme }, reason: "A tries", feeItemCodes: ["x"] },
  ],
  "accounts.relocations.recordSurvey": (b) => [{ relocationId: b.accounts.relocation, feasibility: "feasible", findings: "A tries" }],
  "accounts.relocations.recordWork": (b) => [{ relocationId: b.accounts.relocation, finalReading: "1", initialReading: "2" }],
  "accounts.relocations.complete": (b) => [{ relocationId: b.accounts.relocation, finalReading: "1" }],
  "accounts.relocations.cancel": (b) => [{ relocationId: b.accounts.relocation, reason: "A tries" }],
  "accounts.relocations.get": (b) => [{ id: b.accounts.relocation }],
  "accounts.relocations.list": (b) => [undefined, { accountId: b.accounts.account }, { after: b.accounts.relocation }, { status: "requested" }],
  "accounts.dataQuality.rules": () => [undefined],
  "accounts.dataQuality.summary": () => [undefined],
  "accounts.dataQuality.findings": (b) => [
    ...DATA_QUALITY_RULE_KEYS.map((rule) => ({ rule, limit: 200 })),
    { rule: "account_no_phone", after: b.accounts.accountNumber },
    { rule: "zone_equals_route", after: b.accounts.accountNumber, limit: 1 },
  ],
  "accounts.dataQuality.customerDuplicates": (b) => [undefined, { limit: 100 }, { after: { matchedOn: "phone", key: b.accounts.accountNumber } }],
  "tariffs.list": () => [undefined, { active: true }, { type: "increasing_block" }],
  "tariffs.get": (b) => [{ id: b.tariffs.tariff }],
  "tariffs.create": () => [
    { name: "A tariff", type: "uniform", content: { type: "uniform", rate: 9500n } },
    { name: "A flat tariff", type: "flat_rate", flatBasis: "pipe_size", content: { type: "flat_rate", amounts: [{ key: "15mm", amount: 5_000n }] } },
  ],
  "tariffs.update": (b) => [{ id: b.tariffs.tariff, name: "Renamed by A", active: false }],
  "tariffs.addVersion": (b) => [{ tariffId: b.tariffs.tariff, content: { type: "increasing_block", bands: [{ from: 0, to: null, rate: 1n }] } }],
  "tariffs.versions": (b) => [{ tariffId: b.tariffs.tariff }],
  "tariffs.inForce": (b) => [{ tariffId: b.tariffs.tariff }, { tariffId: b.tariffs.tariff, date: "2099-06-01" }],
  "tariffs.nextEffectiveDate": () => [undefined],
  "tariffs.simulateLateFee": (b) => [
    { invoiceTypeId: b.tariffs.invoiceType, balance: 100_000n, daysOverdue: 40 },
    { rule: { triggerDays: 1, base: "overdue_balance", rateBp: 100, frequency: "once" }, balance: 100_000n, daysOverdue: 40 },
  ],
  "tariffs.categories.list": () => [undefined, { includeInactive: true }],
  "tariffs.categories.get": (b) => [{ id: b.tariffs.category }],
  "tariffs.categories.create": () => [{ code: "a_category", name: "A category" }],
  "tariffs.categories.update": (b) => [{ id: b.tariffs.category, name: "Renamed by A" }],
  "tariffs.categories.deactivate": (b) => [{ id: b.tariffs.category }],
  "tariffs.categories.reactivate": (b) => [{ id: b.tariffs.category }],
  "tariffs.categories.assignTariff": (b) => [
    { categoryId: b.tariffs.category, tariffId: b.tariffs.tariff },
    { categoryId: b.tariffs.category, standingChargeItemId: b.tariffs.recurringItem, meterRentItemId: null },
  ],
  "tariffs.chargeItems.list": () => [undefined, { type: "fee" }, { active: false }],
  "tariffs.chargeItems.get": (b) => [{ id: b.tariffs.chargeItem }, { code: b.tariffs.chargeCode }],
  "tariffs.chargeItems.create": () => [{ code: "a_fee", name: "A fee", type: "fee", amount: 1_000n }],
  "tariffs.chargeItems.update": (b) => [{ id: b.tariffs.chargeItem, name: "Renamed by A" }],
  "tariffs.chargeItems.addAmountVersion": (b) => [{ chargeItemId: b.tariffs.chargeItem, amount: 1n }],
  "tariffs.chargeItems.deactivate": (b) => [{ id: b.tariffs.chargeItem }],
  "tariffs.chargeItems.reactivate": (b) => [{ id: b.tariffs.chargeItem }],
  "tariffs.invoiceTypes.list": () => [undefined, { appliesTo: "application" }],
  "tariffs.invoiceTypes.get": (b) => [{ id: b.tariffs.invoiceType }, { code: b.tariffs.invoiceTypeCode }],
  "tariffs.invoiceTypes.create": (b) => [
    { code: "a_invoice", name: "A invoice type", appliesTo: "account" },
    { code: "a_invoice_2", name: "A invoice type 2", appliesTo: "account", lines: [{ chargeItemCode: b.tariffs.chargeCode }] },
  ],
  "tariffs.invoiceTypes.update": (b) => [{ id: b.tariffs.invoiceType, name: "Renamed by A", dueDays: 1 }],
  "tariffs.invoiceTypes.setLines": (b) => [{ id: b.tariffs.invoiceType, lines: [] }],
  "tariffs.invoiceTypes.setLateFeeRule": (b) => [{ id: b.tariffs.invoiceType, rule: null }],
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
  const sent = JSON.stringify(input ?? null, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
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
    // Every gis, work_orders, accounts (including the command log and the checklist) and tariffs table is covered ("the canary covers every table").
    expect(Object.keys(await snapshotB()).filter((table) => !table.startsWith("kernel.")).length).toBe(45);
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
    for (const path of [
      "hierarchy.areas",
      "exceptions.list",
      "notifications.list",
      "support.list",
      "audit.list",
      "workOrders.list",
      "workOrders.crews.list",
      "gis.nodes.list",
      "gis.dmas.list",
      "gis.logs.conditionFeed",
      "accounts.list",
      "accounts.customers.list",
      "accounts.servicePoints.list",
      "accounts.applications.list",
      "accounts.relocations.list",
      "tariffs.list",
      "tariffs.categories.list",
      "tariffs.chargeItems.list",
      "tariffs.invoiceTypes.list",
    ]) {
      for (const id of leaks(JSON.stringify(superjson.serialize(await callPath(caller, path, undefined)).json), null)) seen.add(id);
    }
    // The data-quality findings are tenant data too: as B they do name B's own account and customer.
    for (const rule of DATA_QUALITY_RULE_KEYS.filter((r) => r !== "active_metered_no_meter")) {
      for (const id of leaks(JSON.stringify(superjson.serialize(await callPath(caller, "accounts.dataQuality.findings", { rule, limit: 200 })).json), null)) seen.add(id);
    }
    expect(seen).toContain(MARK);
    expect(seen).toContain(b.accounts.customer);
    expect([b.scheme, b.exception, b.notification, b.grant, b.workOrder, b.crew, b.gis.valve.id, b.gis.dma.id, b.gis.conditionLog, b.accounts.customer, b.accounts.account, b.accounts.child, b.accounts.servicePoint, b.accounts.application, b.accounts.relocation, b.tariffs.tariff, b.tariffs.category, b.tariffs.chargeItem, b.tariffs.invoiceType].filter((id) => !seen.has(id))).toEqual([]);
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
