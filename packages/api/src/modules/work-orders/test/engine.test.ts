import { startTestDatabase, tenants, type TestDatabase } from "@flowless/db/testing";
import { effectivePermissions } from "@flowless/shared-types";
import { withTenant } from "@flowless/db";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setEntitlements } from "../../../kernel/entitlement-store";
import { addMember, callerFor, type Member } from "../../../test-support";
import { createHarness, expectCode, somewhere, type Caller, type Harness } from "./harness";

// Ported from Majimap's work-orders/test/engine.test.ts, work-orders.test.ts and the parts of
// change-sets.test.ts that need no GIS engine (posting and reconcile move with GIS, W3).
// GIS is stood in for by the harness: its kinds, assets and logs.

let t: TestDatabase;
let h: Harness;
let owner: Member;
let supervisor: Member;
let tech: Member;
let tech2: Member;
/** Only work_orders:execute: sees just the jobs given to them (Majimap's field technician). */
let executor: Member;
let outsider: Member;

beforeAll(async () => {
  t = await startTestDatabase();
  h = createHarness(t);
  await setEntitlements(t.app, tenants.a.id, ["gis", "work-orders"]);
  await setEntitlements(t.app, tenants.b.id, ["gis", "work-orders"]);
  owner = await addMember(t, tenants.a.id, "owner");
  supervisor = await addMember(t, tenants.a.id, "supervisor");
  tech = await addMember(t, tenants.a.id, "technician");
  tech2 = await addMember(t, tenants.a.id, "technician");
  executor = await addMember(t, tenants.a.id, "member");
  await callerFor(t, owner).access.grant({ userId: executor.userId, permission: "work_orders:execute" });
  outsider = await addMember(t, tenants.b.id, "owner");
});
afterAll(() => t?.stop());

type CreateInput = Parameters<Caller["workOrders"]["create"]>[0];
type ActionInput = Parameters<Caller["workOrders"]["transition"]>[0]["action"];

const as = (m: Member) => h.as(m).workOrders;
const newJob = (overrides: Partial<CreateInput> = {}, m: Member = owner) =>
  as(m).create({ title: `Job ${randomUUID().slice(0, 5)}`, kind: "inspection", assigneeId: tech.userId, ...overrides });
const valve = () => h.asset(tenants.a.id);
const act = (m: Member, job: { id: string }, action: ActionInput, eventId = randomUUID()) => as(m).transition({ eventId, workOrderId: job.id, action });
const review = (m: Member, job: { id: string }, decision: "approve" | "return", note = "") =>
  as(m).review({ eventId: randomUUID(), workOrderId: job.id, decision, note });

describe("raising jobs", () => {
  it("lets a technician raise a job for themselves, offline-safe, always with review", async () => {
    const id = randomUUID();
    const job = await newJob({ id, kind: "leak", assigneeId: null, location: somewhere() }, tech);
    expect(job.assignedToUserId).toBe(tech.userId);
    expect(job.review, "a leak's review is optional, but a self-raised job always gets it").toBe("required");
    expect(job.source).toBe("Field report");

    const retry = await newJob({ id, kind: "leak", assigneeId: null }, tech);
    expect(retry.code, "a retry is the same job, not a second one").toBe(job.code);
    await expectCode(newJob({ id, kind: "leak", assigneeId: null }, tech2), "CONFLICT");
  });

  it("refuses an id another organization already used, without saying so", async () => {
    const theirs = await as(outsider).create({ title: "Theirs", kind: "inspection" });
    await expectCode(newJob({ id: theirs.id }), "CONFLICT");
  });

  it("keeps a technician from escalating, from raising work for someone else, and from raising a supervisor's kind", async () => {
    await expectCode(newJob({ kind: "leak", priority: "urgent", assigneeId: null }, tech), "FORBIDDEN");
    await expectCode(newJob({ kind: "leak", assigneeId: tech2.userId }, tech), "FORBIDDEN");
    await expectCode(newJob({ kind: "flushing", assigneeId: null }, tech), "FORBIDDEN");
  });

  it("needs a position for a job that is about a place, not an asset", async () => {
    await expectCode(newJob({ kind: "asset_capture", assigneeId: null }, tech), "BAD_REQUEST");
    expect((await newJob({ kind: "asset_capture", assigneeId: null, location: somewhere() }, tech)).kind).toBe("asset_capture");
  });

  it("offers only registered kinds, and refuses a key that isn't one", async () => {
    await expectCode(newJob({ kind: "meter_install" }), "BAD_REQUEST");
    await expectCode(newJob({ kind: "Not Snake" }), "BAD_REQUEST");
  });

  it("rejects assets that don't exist or belong to another organization", async () => {
    await expectCode(newJob({ assetId: randomUUID() }), "BAD_REQUEST");
    await expectCode(newJob({ assetId: h.asset(tenants.b.id) }), "BAD_REQUEST");
  });

  it("only assigns members of the organization", async () => {
    await expectCode(newJob({ assigneeId: outsider.userId }), "BAD_REQUEST");
    const job = await newJob({ assigneeId: null });
    await expectCode(as(owner).assign({ id: job.id, assigneeId: outsider.userId }), "BAD_REQUEST");
    expect((await as(owner).assign({ id: job.id, assigneeId: tech.userId })).assignedToUserId).toBe(tech.userId);
  });

  it("nests one level: a survey can have repair jobs, a repair job can't have children, and only a visible parent can be used", async () => {
    const survey = await newJob({ kind: "leak_survey", areaId: null, location: somewhere() }).catch(() => null);
    expect(survey, "an area kind needs an area").toBeNull();
    const area = await callerFor(t, owner).hierarchy.createArea({ level: "scheme", code: `S${randomUUID().slice(0, 4)}`, name: "Scheme" });
    const parent = await newJob({ kind: "leak_survey", areaId: area.id });
    const repair = await newJob({ kind: "leak", parentId: parent.id });
    expect(repair.parentId).toBe(parent.id);
    await expectCode(newJob({ kind: "leak", parentId: repair.id }), "BAD_REQUEST");
    expect((await as(owner).list({ parentId: parent.id })).map((j) => j.id)).toContain(repair.id);

    await expectCode(newJob({ kind: "leak", assigneeId: null, parentId: parent.id }, executor), "NOT_FOUND");
    expect((await newJob({ kind: "leak", assigneeId: null, parentId: parent.id }, tech)).parentId).toBe(parent.id);
  });

  it("leaves a parent pending while its children are worked, and only a supervisor finalizes it, open children or not", async () => {
    const area = await callerFor(t, owner).hierarchy.createArea({ level: "scheme", code: `S${randomUUID().slice(0, 4)}`, name: "Scheme" });
    const parent = await newJob({ kind: "leak_survey", areaId: area.id, assigneeId: tech.userId });
    const repair = await newJob({ kind: "leak", parentId: parent.id });
    expect((await as(owner).byId({ id: parent.id })).status).toBe("pending");

    const refused = await act(tech, parent, { type: "submit", outcome: "partial" });
    expect(refused.outcome).toBe("rejected");
    expect(refused.reason).toMatch(/supervisor finalizes/);

    await expectCode(as(tech).finalize({ eventId: randomUUID(), workOrderId: parent.id }), "FORBIDDEN");
    const result = await as(supervisor).finalize({ eventId: randomUUID(), workOrderId: parent.id, note: "Repairs continue under their own jobs" });
    expect(result.order.status).toBe("completed");
    expect((await as(owner).byId({ id: repair.id })).status, "the child is untouched").toBe("pending");

    const lone = await newJob({ kind: "leak" });
    expect((await as(owner).finalize({ eventId: randomUUID(), workOrderId: lone.id })).outcome).toBe("rejected");
  });
});

describe("review", () => {
  it("takes a reviewed job from in progress to submitted, back for fixes, and on to completed", async () => {
    const job = await newJob({ kind: "valve_replacement" });
    expect(job.status).toBe("pending");
    expect((await act(tech, job, { type: "complete", outcome: "done" })).reason).toMatch(/needs review/);

    // Nobody taps Start: submitting a pending job is fine.
    const submitted = await act(tech, job, { type: "submit", outcome: "done", note: "All checked" });
    expect(submitted.order.status).toBe("submitted");
    expect(submitted.order.submission?.byUserId).toBe(tech.userId);

    await expectCode(review(tech, job, "approve"), "FORBIDDEN");
    await expectCode(review(owner, job, "return"), "BAD_REQUEST");

    const returned = await review(owner, job, "return", "Photo is missing");
    expect(returned.order.status).toBe("in_progress");
    expect(returned.order.reviewed).toMatchObject({ decision: "returned", note: "Photo is missing" });

    await act(tech, job, { type: "submit", outcome: "done" });
    const approved = await review(owner, job, "approve");
    expect(approved.order.status).toBe("completed");
    expect(approved.order.reviewed?.decision).toBe("approved");
    expect(approved.order.completion?.outcome).toBe("done");
  });

  it("won't let anyone review their own submission, but lets another manager", async () => {
    const job = await newJob({ assigneeId: tech2.userId });
    await act(supervisor, job, { type: "submit", outcome: "partial" });
    const own = await review(supervisor, job, "approve");
    expect(own.outcome).toBe("rejected");
    expect(own.reason).toMatch(/own submission/);
    expect((await as(owner).byId({ id: job.id })).status).toBe("submitted");
    expect((await review(owner, job, "approve")).order.status).toBe("completed");
  });

  it("locks a submitted job: no reassigning, holding or adding assets, while cancelling stays possible", async () => {
    const job = await newJob();
    const v = valve();
    await act(tech, job, { type: "submit", outcome: "partial" });
    await expectCode(as(owner).assign({ id: job.id, assigneeId: tech2.userId }), "CONFLICT");
    expect((await act(tech, job, { type: "hold", reason: "Rain" })).outcome).toBe("rejected");
    expect((await as(tech).addAsset({ eventId: randomUUID(), workOrderId: job.id, assetId: v })).outcome).toBe("rejected");
    expect((await as(owner).cancel({ id: job.id })).status).toBe("cancelled");
  });

  it("replays a review with the original result", async () => {
    const job = await newJob();
    await act(tech, job, { type: "submit", outcome: "partial" });
    const input = { eventId: randomUUID(), workOrderId: job.id, decision: "approve" as const };
    const first = await as(owner).review(input);
    const retry = await as(owner).review(input);
    expect([first.replayed, retry.replayed, retry.outcome]).toEqual([false, true, "applied"]);
  });
});

describe("assets on a job", () => {
  it("shows each asset as its module describes it: registered or proposed, and a possible duplicate", async () => {
    const registered = valve();
    const beside = h.asset(tenants.a.id, { state: "proposed", possibleDuplicateOf: registered });
    const job = await newJob();
    await as(tech).addAsset({ eventId: randomUUID(), workOrderId: job.id, assetId: registered });
    const result = await as(tech).addAsset({ eventId: randomUUID(), workOrderId: job.id, assetId: beside });
    const byId = new Map(result.order.assets.map((a) => [a.assetId, a]));
    expect([byId.get(registered)?.state, byId.get(registered)?.possibleDuplicateOf]).toEqual(["registered", null]);
    expect([byId.get(beside)?.state, byId.get(beside)?.possibleDuplicateOf]).toEqual(["proposed", registered]);
    expect(byId.get(registered)?.module).toBe("gis");
  });

  it("treats adding the same asset twice as no change, and refuses assets from elsewhere", async () => {
    const v = valve();
    const job = await newJob();
    const add = (assetId: string) => as(tech).addAsset({ eventId: randomUUID(), workOrderId: job.id, assetId });
    expect((await add(v)).outcome).toBe("applied");
    expect((await add(v)).outcome).toBe("unchanged");
    await expectCode(add(h.asset(tenants.b.id)), "NOT_FOUND");
    await expectCode(add(randomUUID()), "NOT_FOUND");
  });

  it("starts a pending job when its technician adds an asset, but not when a supervisor prepares it", async () => {
    const job = await newJob();
    const prepared = await as(owner).addAsset({ eventId: randomUUID(), workOrderId: job.id, assetId: valve() });
    expect(prepared.order.status, "a supervisor preparing the job doesn't start it").toBe("pending");
    const found = await as(tech).addAsset({ eventId: randomUUID(), workOrderId: job.id, assetId: valve() });
    expect(found.outcome).toBe("applied");
    expect(found.order.status, "the first thing the technician does starts the job").toBe("in_progress");
    expect(found.order.assets).toHaveLength(2);
  });

  it("lets a technician add assets to a job on hold, without un-holding it", async () => {
    const job = await newJob();
    await act(tech, job, { type: "hold", reason: "No access" });
    const added = await as(tech).addAsset({ eventId: randomUUID(), workOrderId: job.id, assetId: valve() });
    expect([added.outcome, added.order.status]).toEqual(["applied", "blocked"]);
  });

  it("lets a leak job record the valves closed to isolate it, even though the job is on a pipe", async () => {
    const pipe = h.asset(tenants.a.id, { type: "pipe" });
    const [b, stray] = [valve(), valve()];
    const job = await newJob({ kind: "leak", assetId: pipe, relatedAssetIds: [b] });

    // A supervisor's log is linked but doesn't start the technician's job.
    const result = await as(owner).linkLog({ eventId: randomUUID(), workOrderId: job.id, logKind: "valve", logId: h.log(owner, b) });
    expect([result.outcome, result.order.status]).toEqual(["applied", "pending"]);

    // The technician's own log for a valve that isn't on the job yet adds it, starts the job and ticks it off.
    const linked = await as(tech).linkLog({ eventId: randomUUID(), workOrderId: job.id, logKind: "valve", logId: h.log(tech, stray) });
    expect(linked.order.status).toBe("in_progress");
    const added = linked.order.assets.find((a) => a.assetId === stray);
    expect([added?.role, added?.status]).toEqual(["related", "done"]);
  });

  it("finds every job an asset is part of, primary or related", async () => {
    const [a, b] = [valve(), valve()];
    const job = await newJob({ kind: "leak", assetId: a, relatedAssetIds: [b] });
    expect((await as(owner).list({ assetId: b })).map((j) => j.id)).toContain(job.id);
    expect(job.assets.map((x) => x.role)).toEqual(["primary", "related"]);
    expect([job.assetModule, job.assetId]).toEqual(["gis", a]);
  });
});

describe("route jobs", () => {
  it("tracks each valve and only lets the job be called done once every valve has been visited", async () => {
    const [v1, v2, v3] = [valve(), valve(), valve()];
    const job = await newJob({ kind: "valve_exercise", assetId: v1, relatedAssetIds: [v2, v3] });
    const visit = (v: string) => as(tech).linkLog({ eventId: randomUUID(), workOrderId: job.id, logKind: "valve", logId: h.log(tech, v) });
    await visit(v1);
    const two = await visit(v2);
    expect(two.order.assets.filter((a) => a.status === "done")).toHaveLength(2);

    const early = await act(tech, job, { type: "complete", outcome: "done" });
    expect(early.outcome).toBe("rejected");
    expect(early.reason).toMatch(/1 asset still to do/);

    await visit(v3);
    expect((await act(tech, job, { type: "complete", outcome: "done" })).order.status, "its review is optional").toBe("completed");
  });
});

describe("a job's branch", () => {
  it("is the job's code, starts a pending job for its technician, and is only for the assignee or a manager", async () => {
    const job = await newJob();
    const first = await as(tech).changeSet({ workOrderId: job.id });
    expect((await as(owner).byId({ id: job.id })).status).toBe("in_progress");
    expect(first.branch).toBe(job.code.toLowerCase());
    expect(first.branch).toMatch(/^wo-\d+$/);
    expect((await as(tech).changeSet({ workOrderId: job.id })).branch).toBe(first.branch);
    expect((await as(owner).byId({ id: job.id })).branch).toBe(first.branch);

    await expectCode(as(tech2).changeSet({ workOrderId: job.id }), "NOT_FOUND");
    expect((await as(supervisor).changeSet({ workOrderId: job.id })).branch).toBe(first.branch);
  });

  it("isn't opened for a job on hold or finished", async () => {
    const held = await newJob();
    await act(tech, held, { type: "hold", reason: "No access" });
    await expectCode(as(tech).changeSet({ workOrderId: held.id }), "CONFLICT");
    const done = await newJob({ kind: "flushing" });
    await act(tech, done, { type: "complete", outcome: "done" });
    await expectCode(as(tech).changeSet({ workOrderId: done.id }), "CONFLICT");
  });

  it("guards writes to it through the kernel: assignee and managers while open, nobody once closed", async () => {
    const job = await newJob();
    const { branch } = await as(tech).changeSet({ workOrderId: job.id });
    const check = (m: Member, name = branch) =>
      withTenant(t.app, m.organizationId, (tx) =>
        h.work.checkBranchWrite(tx, { organizationId: m.organizationId, userId: m.userId, permissions: effectivePermissions(m.role, []), branch: name }),
      );
    expect(await check(tech)).toEqual({ allowed: true });
    expect(await check(supervisor)).toEqual({ allowed: true });
    expect((await check(tech2)).allowed).toBe(false);
    expect((await check(owner, "wo-99999999")).allowed, "a work-order-looking branch no job owns").toBe(false);
    expect((await check(owner, branch.toUpperCase())).allowed, "whatever the letter case").toBe(false);
    expect((await check(outsider)).allowed, "another organization's job").toBe(false);
    expect((await check(tech, `field-visit-${randomUUID()}`)).allowed, "ordinary branches are untouched").toBe(true);

    const labels = await withTenant(t.app, tenants.a.id, (tx) => h.work.annotateBranches(tx, [branch, "plain-branch"]));
    expect(labels.get(branch)).toMatchObject({ kind: "work_order", ref: job.code, status: "in_progress" });
    expect(labels.has("plain-branch")).toBe(false);

    await as(owner).cancel({ id: job.id });
    expect((await check(tech)).allowed).toBe(false);
    expect((await check(owner)).allowed).toBe(false);
  });
});

describe("retried events", () => {
  it("returns the original result and says it was a replay", async () => {
    const job = await newJob();
    const id = randomUUID();
    const first = await act(tech, job, { type: "hold", reason: "No access" }, id);
    const retry = await act(tech, job, { type: "hold", reason: "No access" }, id);
    expect([first.replayed, first.outcome]).toEqual([false, "applied"]);
    expect([retry.replayed, retry.outcome, retry.order.status], "the retry learns what actually happened").toEqual([true, "applied", "blocked"]);
  });

  it("remembers a rejection, so a device that lost the response still learns it was refused", async () => {
    const job = await newJob({ kind: "valve_replacement" });
    const id = randomUUID();
    const first = await act(tech, job, { type: "complete", outcome: "done" }, id);
    expect(first.outcome).toBe("rejected");
    const retry = await act(tech, job, { type: "complete", outcome: "done" }, id);
    expect([retry.replayed, retry.outcome, retry.reason]).toEqual([true, "rejected", first.reason]);
  });

  it("refuses an event id reused by someone else, for another job, for another action, or by another organization", async () => {
    const [one, two] = await Promise.all([newJob(), newJob()]);
    const id = randomUUID();
    await act(tech, one, { type: "hold", reason: "No access" }, id);
    await expectCode(act(owner, one, { type: "hold", reason: "No access" }, id), "CONFLICT");
    await expectCode(act(tech, two, { type: "hold", reason: "No access" }, id), "CONFLICT");
    await expectCode(act(tech, one, { type: "resume" }, id), "CONFLICT");
    const theirs = await as(outsider).create({ title: "Theirs", kind: "inspection", assigneeId: outsider.userId });
    await expectCode(act(outsider, theirs, { type: "hold", reason: "No access" }, id), "CONFLICT");
  });

  it("lets two simultaneous retries through without a primary-key error", async () => {
    const job = await newJob();
    const id = randomUUID();
    const results = await Promise.all([act(tech, job, { type: "hold", reason: "Rain" }, id), act(tech, job, { type: "hold", reason: "Rain" }, id)]);
    expect(results.map((r) => r.outcome)).toEqual(["applied", "applied"]);
    expect(results.filter((r) => r.replayed)).toHaveLength(1);
  });

  it("refuses a time far in the future: the device's clock is wrong", async () => {
    const job = await newJob();
    await expectCode(
      as(tech).transition({ eventId: randomUUID(), workOrderId: job.id, action: { type: "resume" }, occurredAt: new Date(Date.now() + 3 * 86_400_000) }),
      "BAD_REQUEST",
    );
  });
});

describe("cancel and assign", () => {
  it("won't cancel or reassign a completed job", async () => {
    const job = await newJob();
    expect((await act(tech, job, { type: "complete", outcome: "done" })).order.status).toBe("completed");
    await expectCode(as(owner).cancel({ id: job.id }), "CONFLICT");
    await expectCode(as(owner).assign({ id: job.id, assigneeId: null }), "CONFLICT");
  });

  it("lets a simultaneous cancel and complete end in one consistent state", async () => {
    const job = await newJob();
    const [done, cancelled] = await Promise.allSettled([act(tech, job, { type: "complete", outcome: "done" }), as(owner).cancel({ id: job.id })]);
    const final = await as(owner).byId({ id: job.id });
    if (final.status === "completed") {
      expect(cancelled.status, "the cancel must not overwrite the completion").toBe("rejected");
    } else {
      expect(final.status).toBe("cancelled");
      expect(done.status === "fulfilled" && done.value.outcome, "the completion is recorded as refused").toBe("rejected");
    }
  });

  it("needs work_orders:assign to assign and work_orders:cancel to cancel", async () => {
    const job = await newJob();
    await expectCode(as(tech).assign({ id: job.id, assigneeId: tech2.userId }), "FORBIDDEN");
    await expectCode(as(tech).cancel({ id: job.id }), "FORBIDDEN");
  });
});

describe("linking logs", () => {
  const link = (job: { id: string }, logId: string, m: Member = owner) =>
    as(m).linkLog({ eventId: randomUUID(), workOrderId: job.id, logKind: "condition", logId });

  it("starts a pending job when its technician's inspection is linked, and marks the asset done", async () => {
    const v = valve();
    const job = await newJob({ assetId: v });
    const result = await link(job, h.log(tech, v, "condition"), tech);
    expect([result.outcome, result.order.status]).toEqual(["applied", "in_progress"]);
    expect(result.order.assets.find((a) => a.assetId === v)?.status).toBe("done");
  });

  it("links evidence to a held job without resuming it or marking anything done", async () => {
    const v = valve();
    const job = await newJob({ assetId: v });
    await act(tech, job, { type: "hold", reason: "Waiting for a key" });
    const result = await link(job, h.log(owner, v, "condition"));
    expect(result.order.status, "still on hold").toBe("blocked");
    expect(result.order.assets.find((a) => a.assetId === v)?.status).toBe("pending");
    expect(result.reason).toMatch(/on hold/);
  });

  it("keeps a log from being claimed by two jobs, and a technician from linking someone else's", async () => {
    const v = valve();
    const [one, two] = await Promise.all([newJob({ assetId: v }), newJob({ assetId: v })]);
    const log = h.log(owner, v, "condition");
    await link(one, log);
    await expectCode(link(two, log), "CONFLICT");
    await expectCode(link(two, h.log(owner, v, "condition"), tech), "FORBIDDEN");
    await expectCode(link(two, randomUUID()), "NOT_FOUND");
  });
});

describe("cancelling a parent", () => {
  const parentWithChild = async () => {
    const area = await callerFor(t, owner).hierarchy.createArea({ level: "scheme", code: `S${randomUUID().slice(0, 4)}`, name: "Scheme" });
    const parent = await newJob({ kind: "leak_survey", areaId: area.id });
    const child = await newJob({ kind: "leak", parentId: parent.id });
    return { parent, child };
  };

  it("refuses while a child is open, and says how many", async () => {
    const { parent, child } = await parentWithChild();
    await expectCode(as(owner).cancel({ id: parent.id }), "CONFLICT");
    expect((await as(owner).byId({ id: parent.id })).status).toBe("pending");
    expect((await as(owner).byId({ id: child.id })).status).toBe("pending");
  });

  it("cancels unstarted children along with it when asked", async () => {
    const { parent, child } = await parentWithChild();
    expect((await as(owner).cancel({ id: parent.id, cascade: true })).status).toBe("cancelled");
    expect((await as(owner).byId({ id: child.id })).status).toBe("cancelled");
  });

  it("never cancels a child that has started, even when asked to cascade", async () => {
    const { parent, child } = await parentWithChild();
    await act(tech, child, { type: "hold", reason: "Waiting for parts" });
    await expectCode(as(owner).cancel({ id: parent.id, cascade: true }), "CONFLICT");
    expect((await as(owner).byId({ id: child.id })).status).toBe("blocked");
    expect((await as(owner).byId({ id: parent.id })).status).toBe("pending");
  });

  it("still cancels a job with no children", async () => {
    expect((await as(owner).cancel({ id: (await newJob({ kind: "leak" })).id })).status).toBe("cancelled");
  });
});

describe("files on a job", () => {
  it("accepts no changes on a cancelled job", async () => {
    const job = await newJob();
    await as(owner).cancel({ id: job.id });
    await expectCode(h.announce(tech, job.id), "CONFLICT");
  });

  it("lets a technician add but not remove evidence once the job is finished", async () => {
    const job = await newJob({ kind: "flushing" });
    const photo = await h.photo(tech, job.id);
    await act(tech, job, { type: "complete", outcome: "done" });
    expect((await h.announce(tech, job.id)).file.status, "a late upload from an offline device still lands").toBe("pending");
    await expectCode(h.as(tech).files.remove({ id: photo.id }), "FORBIDDEN");
    await h.as(owner).files.remove({ id: photo.id });
  });

  it("keeps a job's files to those who can see it", async () => {
    const job = await newJob({ assigneeId: tech.userId });
    await h.photo(tech, job.id);
    expect(await h.as(tech2).files.list({ subjectKind: "work_order", subjectId: job.id })).toHaveLength(1);
    await expectCode(h.as(executor).files.list({ subjectKind: "work_order", subjectId: job.id }), "NOT_FOUND");
    await expectCode(h.announce(tech2, job.id), "FORBIDDEN");
    await expectCode(h.as(outsider).files.list({ subjectKind: "work_order", subjectId: job.id }), "NOT_FOUND");
    expect((await as(owner).byId({ id: job.id })).photoCount).toBe(1);
  });
});
