import { auditLog, exception, outboxEvent } from "@flowless/db";
import { workOrderCapture } from "@flowless/db/schema/work-orders";
import { startTestDatabase, tenants, type TestDatabase } from "@flowless/db/testing";
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { setEntitlements } from "../../../kernel/entitlement-store";
import { defineEvent, type EventDef } from "../../../kernel/events";
import { defineWorkKind } from "../../../kernel/work";
import { addMember, callerFor, type Member } from "../../../test-support";
import { workOrderCompletedSchema } from "../events";
import { sweepOverdueWorkOrders } from "../sla";
import { createHarness, expectCode, somewhere, type Harness } from "./harness";

// What Flowless adds to Majimap's work orders (W-01 to W-03): permission-based visibility
// and scope (K-03), levels by licence (K-04, NF-31), crews, captures and evidence, GPS,
// comments, SLA breaches in the exception queue (X-02), configuration per organization
// (K-10), the outbox (K-09), audit (K-06) and notifications (K-07).

let t: TestDatabase;
let h: Harness;
let owner: Member;
let supervisor: Member;
let tech: Member;
let executor: Member;
let ownerB: Member;
let techB: Member;

const meterInstalled = defineEvent("test.meter_installed", workOrderCompletedSchema);

beforeAll(async () => {
  t = await startTestDatabase();
  h = createHarness(t);
  h.work.registerWorkKind(
    defineWorkKind({
      key: "test_meter_install",
      module: "work-orders",
      label: "Meter installation",
      target: "asset",
      review: "none",
      tier: "full",
      gis: "none",
      capture: z.object({ serial: z.string().min(1) }),
      completionEvent: meterInstalled as EventDef<unknown>,
    }),
  );
  await setEntitlements(t.app, tenants.a.id, ["gis", "work-orders"]);
  owner = await addMember(t, tenants.a.id, "owner");
  supervisor = await addMember(t, tenants.a.id, "supervisor");
  tech = await addMember(t, tenants.a.id, "technician");
  executor = await addMember(t, tenants.a.id, "member");
  await callerFor(t, owner).access.grant({ userId: executor.userId, permission: "work_orders:execute" });
  ownerB = await addMember(t, tenants.b.id, "owner");
  techB = await addMember(t, tenants.b.id, "technician");
});
afterAll(() => t?.stop());

const wo = (m: Member) => h.as(m).workOrders;
const newJob = (over: Partial<Parameters<ReturnType<typeof wo>["create"]>[0]> = {}, m: Member = owner) =>
  wo(m).create({ title: `Job ${randomUUID().slice(0, 5)}`, kind: "inspection_general", assigneeId: tech.userId, ...over });
const outbox = (type: string, workOrderId: string) =>
  t.admin.select().from(outboxEvent).where(and(eq(outboxEvent.type, type), sql`${outboxEvent.payload}->>'workOrderId' = ${workOrderId}`));

describe("who sees which jobs", () => {
  it("shows a member who only executes the jobs given to them, and nothing else", async () => {
    const mine = await newJob({ assigneeId: executor.userId });
    const other = await newJob();
    const listed = (await wo(executor).list()).map((j) => j.id);
    expect(listed).toContain(mine.id);
    expect(listed).not.toContain(other.id);
    expect((await wo(executor).mine()).map((j) => j.id)).toEqual([mine.id]);
    await expectCode(wo(executor).byId({ id: other.id }), "NOT_FOUND");
    await expectCode(wo(executor).history({ workOrderId: other.id }), "NOT_FOUND");
    expect((await wo(tech).list()).map((j) => j.id), "work_orders:read sees everything").toEqual(expect.arrayContaining([mine.id, other.id]));
  });

  it("turns away a member with no work-order permission", async () => {
    const cashier = await addMember(t, tenants.a.id, "cashier");
    await expectCode(wo(cashier).list(), "FORBIDDEN");
  });

  it("limits a scoped supervisor to jobs in their areas, and to raising jobs there", async () => {
    const hierarchy = callerFor(t, owner).hierarchy;
    const north = await hierarchy.createArea({ level: "scheme", code: `N${randomUUID().slice(0, 4)}`, name: "North" });
    const south = await hierarchy.createArea({ level: "scheme", code: `S${randomUUID().slice(0, 4)}`, name: "South" });
    const scoped = await addMember(t, tenants.a.id, "supervisor");
    await callerFor(t, owner).access.setScope({ userId: scoped.userId, areaIds: [north.id], routeIds: [] });

    const inNorth = await newJob({ areaId: north.id });
    const inSouth = await newJob({ areaId: south.id });
    const unplaced = await newJob();
    const listed = (await wo(scoped).list()).map((j) => j.id);
    expect(listed).toContain(inNorth.id);
    expect(listed).not.toContain(inSouth.id);
    expect(listed, "unplaced jobs are for unrestricted members").not.toContain(unplaced.id);
    await expectCode(wo(scoped).byId({ id: inSouth.id }), "NOT_FOUND");
    await expectCode(wo(scoped).cancel({ id: inSouth.id }), "NOT_FOUND");
    await expectCode(newJob({ areaId: south.id }, scoped), "BAD_REQUEST");
    expect((await newJob({ areaId: north.id }, scoped)).areaId).toBe(north.id);
  });
});

describe("crews", () => {
  it("are managed with work_orders:assign, and their members see and work the crew's jobs", async () => {
    await expectCode(wo(tech).crews.create({ name: "Night shift" }), "FORBIDDEN");
    const crew = await wo(supervisor).crews.create({ name: "Night shift" });
    await expectCode(wo(supervisor).crews.create({ name: "Night shift" }), "CONFLICT");
    await wo(supervisor).crews.addMember({ crewId: crew.id, userId: executor.userId });
    await expectCode(wo(supervisor).crews.addMember({ crewId: crew.id, userId: ownerB.userId }), "NOT_FOUND");
    expect((await wo(tech).crews.list()).find((c) => c.id === crew.id)?.memberUserIds).toEqual([executor.userId]);

    const job = await newJob({ crewId: crew.id });
    expect(job.crewId).toBe(crew.id);
    expect((await wo(executor).list()).map((j) => j.id)).toContain(job.id);
    expect((await wo(executor).mine()).map((j) => j.id)).toContain(job.id);
    const held = await wo(executor).transition({ eventId: randomUUID(), workOrderId: job.id, action: { type: "hold", reason: "No ladder" } });
    expect(held.order.status).toBe("blocked");

    await wo(supervisor).crews.removeMember({ crewId: crew.id, userId: executor.userId });
    await expectCode(wo(executor).byId({ id: job.id }), "NOT_FOUND");

    await wo(supervisor).crews.rename({ id: crew.id, name: "Night crew" });
    await wo(supervisor).crews.archive({ id: crew.id });
    expect((await wo(tech).crews.list()).map((c) => c.id)).not.toContain(crew.id);
    expect((await wo(tech).crews.list({ includeArchived: true })).find((c) => c.id === crew.id)?.name).toBe("Night crew");
    await expectCode(newJob({ crewId: crew.id }), "BAD_REQUEST");
    const audited = await t.admin.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.subjectId, crew.id));
    expect(audited.map((a) => a.action)).toEqual(
      expect.arrayContaining(["work_orders.crew_create", "work_orders.crew_add_member", "work_orders.crew_remove_member", "work_orders.crew_archive"]),
    );
  });
});

describe("finishing a job: evidence and capture", () => {
  it("needs the kind's photos, a GPS fix and valid completion data, and keeps the capture", async () => {
    const job = await newJob({ kind: "repair" });
    const complete = (extra: Record<string, unknown> = {}, position?: { latitude: number; longitude: number }) =>
      wo(tech).transition({ eventId: randomUUID(), workOrderId: job.id, action: { type: "complete", outcome: "done", ...extra }, position });

    const noPhoto = await complete({ capture: { workDone: "Fixed" } }, somewhere());
    expect([noPhoto.outcome, noPhoto.reason]).toEqual(["rejected", "Add a photo before finishing this job (0 so far)"]);
    await h.photo(tech, job.id);
    expect((await complete({ capture: { workDone: "Fixed" } })).reason).toMatch(/needs your position/);
    expect((await complete({}, somewhere())).reason).toMatch(/completion details are missing/);
    expect((await complete({ capture: { workDone: "" } }, somewhere())).reason).toMatch(/Say what was done/);

    const at = somewhere();
    const done = await complete({ capture: { workDone: "Replaced the gasket" } }, at);
    expect([done.outcome, done.order.status]).toEqual(["applied", "completed"]);
    expect(done.order.capture).toEqual({ workDone: "Replaced the gasket", materials: "" });
    expect(await t.admin.select().from(workOrderCapture).where(eq(workOrderCapture.workOrderId, job.id))).toHaveLength(1);

    const history = await wo(tech).history({ workOrderId: job.id });
    expect(history.filter((e) => e.type === "complete").map((e) => e.outcome)).toEqual(["rejected", "rejected", "rejected", "rejected", "applied"]);
    expect(history.at(-1)?.position).toEqual(at);

    const [completed] = await outbox("work_order.completed", job.id);
    expect(completed?.payload).toMatchObject({ code: job.code, kind: "repair", outcome: "done", capture: { workDone: "Replaced the gasket" } });
  });

  it("keeps the capture of a submission through a return, and publishes the kind's own completion event", async () => {
    const area = await callerFor(t, owner).hierarchy.createArea({ level: "scheme", code: `V${randomUUID().slice(0, 4)}`, name: "Survey area" });
    const survey = await newJob({ kind: "survey", areaId: area.id });
    const submit = (capture?: unknown) =>
      wo(tech).transition({ eventId: randomUUID(), workOrderId: survey.id, action: { type: "submit", outcome: "done", capture } });
    expect((await submit()).outcome).toBe("rejected");
    expect((await submit({ summary: "Three leaks found" })).order.status).toBe("submitted");
    await wo(supervisor).review({ eventId: randomUUID(), workOrderId: survey.id, decision: "return", note: "Add the street names" });
    expect((await submit()).outcome, "the earlier capture is still in force").toBe("applied");
    const approved = await wo(supervisor).review({ eventId: randomUUID(), workOrderId: survey.id, decision: "approve" });
    expect(approved.order.capture).toEqual({ summary: "Three leaks found" });
    const [completed] = await outbox("work_order.completed", survey.id);
    expect(completed?.payload).toMatchObject({ approvedByUserId: supervisor.userId, completedByUserId: tech.userId, capture: { summary: "Three leaks found" } });

    const install = await newJob({ kind: "test_meter_install" });
    await wo(tech).transition({ eventId: randomUUID(), workOrderId: install.id, action: { type: "complete", outcome: "done", capture: { serial: "M-1" } } });
    const [own] = await outbox("test.meter_installed", install.id);
    expect(own?.payload).toMatchObject({ kind: "test_meter_install", capture: { serial: "M-1" } });
  });
});

describe("events, audit and notifications", () => {
  it("publishes created, status_changed and completed, audits every change and tells the assignee", async () => {
    const job = await newJob({ assigneeId: null });
    expect(await outbox("work_order.created", job.id)).toHaveLength(1);
    await wo(supervisor).assign({ id: job.id, assigneeId: tech.userId });
    expect(await outbox("work_order.assigned", job.id)).toHaveLength(1);
    const inbox = await callerFor(t, tech).notifications.list();
    expect(inbox.find((n) => n.link === `/work-orders/${job.id}`)?.title).toBe(`${job.code} is assigned to you`);

    await wo(tech).transition({ eventId: randomUUID(), workOrderId: job.id, action: { type: "hold", reason: "Rain" } });
    await wo(tech).transition({ eventId: randomUUID(), workOrderId: job.id, action: { type: "complete", outcome: "done" } });
    const changes = await outbox("work_order.status_changed", job.id);
    expect(changes.map((c) => [(c.payload as { from: string }).from, (c.payload as { to: string }).to])).toEqual([
      ["pending", "blocked"],
      ["blocked", "completed"],
    ]);
    expect(await outbox("work_order.completed", job.id)).toHaveLength(1);
    const audited = await t.admin.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.subjectId, job.id));
    expect(audited.map((a) => a.action)).toEqual(["work_orders.create", "work_orders.assign", "work_orders.hold", "work_orders.complete"]);
  });

  it("keeps comments append-only and offline-safe, for those who can see the job", async () => {
    const job = await newJob();
    const id = randomUUID();
    const first = await wo(tech).comment({ id, workOrderId: job.id, body: "Meter box is flooded", position: somewhere() });
    const retry = await wo(tech).comment({ id, workOrderId: job.id, body: "Meter box is flooded" });
    expect([first.replayed, retry.replayed]).toEqual([false, true]);
    await expectCode(wo(owner).comment({ id, workOrderId: job.id, body: "Not mine" }), "CONFLICT");
    await expectCode(wo(executor).comment({ id: randomUUID(), workOrderId: job.id, body: "Hi" }), "NOT_FOUND");
    expect((await wo(owner).comments({ workOrderId: job.id })).map((c) => c.body)).toEqual(["Meter box is flooded"]);
    expect((await wo(owner).history({ workOrderId: job.id })).map((e) => e.type)).toEqual(["create", "comment"]);
  });
});

describe("review policy and SLA from the configuration store", () => {
  it("lets an organization require review and shorten the SLA for a kind", async () => {
    const config = callerFor(t, owner).config;
    const before = await newJob();
    expect(before.review).toBe("none");
    await config.set({ key: "work-orders.kind_policy", value: { inspection_general: { review: "required", slaHours: 2 } }, expectedVersion: 0 });

    const kinds = await wo(owner).kinds();
    expect(kinds.find((k) => k.key === "inspection_general")).toMatchObject({ review: "required", slaHours: 2 });
    const after = await newJob();
    expect(after.review).toBe("required");
    expect(Math.abs(after.dueAt.getTime() - (Date.now() + 2 * 3_600_000))).toBeLessThan(60_000);
    expect((await wo(tech).transition({ eventId: randomUUID(), workOrderId: after.id, action: { type: "complete", outcome: "done" } })).reason).toMatch(/needs review/);
    expect((await wo(owner).byId({ id: before.id })).review, "a job keeps the policy it was raised with").toBe("none");
    await config.set({ key: "work-orders.kind_policy", value: {}, expectedVersion: 1 });
  });
});

describe("SLA breaches", () => {
  it("raises one exception per overdue job, owned by the assignee, and resolves it when the job closes", async () => {
    const job = await newJob({ dueAt: new Date(Date.now() - 60_000) });
    expect(job.overdue).toBe(true);
    expect(await sweepOverdueWorkOrders(t.app)).toBeGreaterThanOrEqual(1);
    expect(await sweepOverdueWorkOrders(t.app), "raised once").toBe(0);
    const open = await t.admin.select().from(exception).where(eq(exception.subjectRef, job.id));
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ type: "WORK_ORDER_OVERDUE", source: "work-orders", status: "open", ownerUserId: tech.userId, subjectKind: "work_order" });
    expect((await callerFor(t, owner).exceptions.list()).some((e) => e.subjectRef === job.id)).toBe(true);

    await wo(tech).transition({ eventId: randomUUID(), workOrderId: job.id, action: { type: "complete", outcome: "done" } });
    const [closed] = await t.admin.select().from(exception).where(eq(exception.subjectRef, job.id));
    expect(closed?.status).toBe("resolved");
  });

  it("clears a breach when the job is rescheduled into the future, and raises it again if it lapses", async () => {
    const job = await newJob({ dueAt: new Date(Date.now() - 60_000) });
    await sweepOverdueWorkOrders(t.app);
    await expectCode(wo(tech).schedule({ id: job.id, dueAt: new Date(Date.now() + 86_400_000) }), "FORBIDDEN");
    const moved = await wo(supervisor).schedule({ id: job.id, dueAt: new Date(Date.now() + 86_400_000), priority: "urgent" });
    expect([moved.overdue, moved.priority]).toEqual([false, "urgent"]);
    expect((await t.admin.select().from(exception).where(eq(exception.subjectRef, job.id)))[0]?.status).toBe("resolved");

    await wo(supervisor).schedule({ id: job.id, dueAt: new Date(Date.now() - 1000) });
    expect(await sweepOverdueWorkOrders(t.app)).toBe(1);
    expect((await t.admin.select().from(exception).where(and(eq(exception.subjectRef, job.id), eq(exception.status, "open"))))).toHaveLength(1);
  });

  it("resolves the breach of a cancelled job", async () => {
    const job = await newJob({ dueAt: new Date(Date.now() - 60_000) });
    await sweepOverdueWorkOrders(t.app);
    await wo(owner).cancel({ id: job.id });
    expect((await t.admin.select().from(exception).where(eq(exception.subjectRef, job.id)))[0]?.status).toBe("resolved");
  });
});

describe("levels by licence", () => {
  it("answers NOT_FOUND with neither Work Orders nor GIS", async () => {
    await setEntitlements(t.app, tenants.b.id, ["accounts"]);
    await expectCode(wo(ownerB).kinds(), "NOT_FOUND");
    await expectCode(wo(ownerB).list(), "NOT_FOUND");
    await expectCode(wo(ownerB).crews.list(), "NOT_FOUND");
  });

  it("gives GIS alone the basic level: GIS kinds only, no crews, scheduling or SLA", async () => {
    await setEntitlements(t.app, tenants.b.id, ["gis"]);
    const kinds = (await wo(ownerB).kinds()).map((k) => k.key);
    expect(kinds).toContain("leak");
    expect(kinds).not.toContain("repair");
    expect((await wo(ownerB).kinds()).every((k) => k.slaHours === null)).toBe(true);
    await expectCode(wo(ownerB).create({ title: "Repair", kind: "repair" }), "BAD_REQUEST");
    await expectCode(wo(ownerB).crews.list(), "NOT_FOUND");
    await expectCode(wo(ownerB).crews.create({ name: "B crew" }), "NOT_FOUND");

    const leak = await wo(ownerB).create({ title: "Leak", kind: "leak", assigneeId: techB.userId, dueAt: new Date(Date.now() - 60_000) });
    await expectCode(wo(ownerB).schedule({ id: leak.id, priority: "high" }), "NOT_FOUND");
    expect(await sweepOverdueWorkOrders(t.app), "no SLA without the Work Orders module").toBe(0);
    const photo = await h.photo(techB, leak.id);
    expect(photo.status, "job files work at level basic").toBe("uploaded");
    const done = await wo(techB).transition({ eventId: randomUUID(), workOrderId: leak.id, action: { type: "complete", outcome: "done" } });
    expect(done.order.status).toBe("completed");
  });

  it("gives Work Orders the full level: every licensed module's kinds, crews and SLA", async () => {
    await setEntitlements(t.app, tenants.b.id, ["work-orders"]);
    const kinds = (await wo(ownerB).kinds()).map((k) => k.key);
    expect(kinds).toEqual(expect.arrayContaining(["repair", "survey", "inspection_general"]));
    expect(kinds, "GIS kinds need GIS").not.toContain("leak");
    expect(await wo(ownerB).crews.list()).toEqual([]);
  });
});
