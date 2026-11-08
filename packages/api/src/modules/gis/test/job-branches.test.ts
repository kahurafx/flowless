import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { personalBranch } from "@flowless/shared-types";
import { afterAll, beforeAll, describe, it } from "vitest";
import { expectCode, setupTestEnv, type TestEnv } from "./test-support";

// The GIS-dependent parts of Majimap's work-orders/test/change-sets.test.ts (a job's branch,
// end to end), on the real GIS module, plus the W3 gap fixes and the Phase 2 API-level
// "done when" checks: a cancelled job's branch cannot be posted, a technician cannot write
// to main. Cancelling parents and job files were ported with Work Orders in W2.

describe("a job's branch, end to end", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setupTestEnv();
  });
  afterAll(() => env?.close());

  type Caller = ReturnType<TestEnv["admin"]>;
  const admin = () => env.admin();
  const tech = () => env.tech();
  const somewhere = () => ({ lat: -1.7, lng: 38 + Math.random() * 0.4 });
  const geo = (p: { lat: number; lng: number }) => ({ latitude: p.lat, longitude: p.lng });

  /** A job assigned to the technician, with its branch. Opening the branch is the technician starting the job. */
  async function startedJob(kind = "asset_capture") {
    const job = await admin().workOrders.create({ title: `Capture ${randomUUID().slice(0, 5)}`, kind, location: geo(somewhere()), assigneeId: env.users.tech });
    const { branch } = await tech().workOrders.changeSet({ workOrderId: job.id });
    return { job, branch };
  }
  const valveOn = (caller: Caller, branch: string) =>
    caller.gis.nodes.create({ type: "valve", name: `Found ${randomUUID().slice(0, 5)}`, location: somewhere(), isOpen: true, branch });

  describe("who may write to it", () => {
    it("takes the branch from the server: a phone's guessed code for a job it raised is refused", async () => {
      const job = await tech().workOrders.create({ id: randomUUID(), title: "Found one", kind: "asset_capture", location: geo(somewhere()) });
      await expectCode(valveOn(tech(), "wo-1100"), "FORBIDDEN");
      const { branch } = await tech().workOrders.changeSet({ workOrderId: job.id });
      assert.equal(branch, job.code.toLowerCase());
      assert.equal((await valveOn(tech(), branch)).branch, branch);
    });

    it("won't post a cancelled job's changes, even with override: they can only be discarded", async () => {
      const { job, branch } = await startedJob();
      await valveOn(tech(), branch);
      const preview = await admin().gis.reconcile.preview({ branch });
      await admin().workOrders.cancel({ id: job.id });
      await expectCode(admin().gis.reconcile.post({ branch, token: preview.token, resolutions: {}, override: true }), "CONFLICT");
      assert.equal((await env.events("gis.branch_cancelled", "branch", branch)).length, 1, "engineers are told the branch is dead");
      assert.ok((await admin().gis.reconcile.discard({ branch })).discarded > 0);
    });

    it("lets the assignee and managers write while the job is in progress, and nobody else", async () => {
      const { branch } = await startedJob();
      const mine = await valveOn(tech(), branch);
      assert.equal(mine.branch, branch);
      await valveOn(env.senior(), branch);

      await expectCode(valveOn(env.tech2(), branch), "FORBIDDEN");
      await expectCode(env.tech2().gis.nodes.update({ id: mine.id, baseVersionId: mine.versionId, branch, patch: { name: "Hijack" } }), "FORBIDDEN");
      await expectCode(env.tech2().gis.nodes.delete({ id: mine.id, baseVersionId: mine.versionId, branch }), "FORBIDDEN");
      assert.deepEqual(await admin().gis.nodes.delete({ id: mine.id, baseVersionId: mine.versionId, branch }), { ok: true });
    });

    it("refuses a work-order-looking branch no job owns, whatever the letter case", async () => {
      const { branch } = await startedJob();
      await expectCode(valveOn(admin(), "wo-99999999"), "FORBIDDEN");
      await expectCode(valveOn(admin(), branch.toUpperCase()), "FORBIDDEN");
    });

    it("keeps a branch on someone else's work order out of reach, even for a member who knows its name", async () => {
      const { branch } = await startedJob();
      const theirs = await env.outsider().gis.nodes.create({ type: "valve", name: "Theirs", location: somewhere(), isOpen: true });
      await expectCode(env.outsider().gis.nodes.update({ id: theirs.id, baseVersionId: theirs.versionId, branch, patch: { name: "x" } }), "FORBIDDEN");
    });

    it("leaves ordinary branches as they were", async () => {
      const node = await valveOn(tech(), `visit-${env.run}`);
      assert.equal(node.branch, `visit-${env.run}`);
    });

    it("closes the branch to everyone once the job is cancelled", async () => {
      const { job, branch } = await startedJob();
      await admin().workOrders.cancel({ id: job.id });
      await expectCode(valveOn(tech(), branch), "FORBIDDEN");
      await expectCode(valveOn(admin(), branch), "FORBIDDEN");
    });

    it("lets a retried create through even after the branch has closed", async () => {
      const { job, branch } = await startedJob();
      const id = randomUUID();
      const first = await tech().gis.nodes.create({ id, type: "valve", name: "Offline", location: somewhere(), isOpen: true, branch });
      await admin().workOrders.cancel({ id: job.id });
      const retry = await tech().gis.nodes.create({ id, type: "valve", name: "Offline", location: somewhere(), isOpen: true, branch });
      assert.equal(retry.versionId, first.versionId);
    });
  });

  describe("gap fixes (W3)", () => {
    it("keeps a technician off main: no edit, create, delete or valve change lands there", async () => {
      const valve = await admin().gis.nodes.create({ type: "valve", name: "Main valve", location: somewhere(), isOpen: true });
      await expectCode(tech().gis.nodes.create({ type: "junction", name: "On main", location: somewhere() }), "FORBIDDEN");
      await expectCode(tech().gis.nodes.update({ id: valve.id, baseVersionId: valve.versionId, patch: { name: "x" } }), "FORBIDDEN");
      const op = await tech().gis.logs.recordValveState({ valveId: valve.id, isOpen: false });
      assert.equal(op.outcome, "stale", "the operation is a fact and is kept; the valve on main is not changed");
      assert.equal((await admin().gis.nodes.byId({ id: valve.id })).isOpen, true);
      // gis:post is what main needs: the engineer has it.
      assert.equal((await env.engineer().gis.nodes.update({ id: valve.id, baseVersionId: valve.versionId, patch: { name: "Engineer" } })).name, "Engineer");
    });

    it("refuses the unguarded field-* branches Majimap used for personal edits", async () => {
      await expectCode(valveOn(tech(), `field-${env.run}`), "FORBIDDEN");
      await expectCode(valveOn(admin(), "Field-visit"), "FORBIDDEN");
    });

    it("guards a personal branch fld-<user>: its owner and gis:post holders write, others don't", async () => {
      const mine = personalBranch(env.users.tech);
      const node = await valveOn(tech(), mine);
      await expectCode(valveOn(env.tech2(), mine), "FORBIDDEN");
      await expectCode(env.tech2().gis.nodes.update({ id: node.id, baseVersionId: node.versionId, branch: mine, patch: { name: "x" } }), "FORBIDDEN");
      await expectCode(valveOn(tech(), `fld-${randomUUID()}`), "FORBIDDEN");
      const tidied = await env.engineer().gis.nodes.update({ id: node.id, baseVersionId: node.versionId, branch: mine, patch: { name: "Tidied" } });
      assert.equal(tidied.name, "Tidied");
      // Posting it needs gis:post: the owner can't.
      const preview = await tech().gis.reconcile.preview({ branch: mine });
      await expectCode(tech().gis.reconcile.post({ branch: mine, token: preview.token }), "FORBIDDEN");
      const posted = await env.engineer().gis.reconcile.post({ branch: mine, token: preview.token });
      assert.equal(posted.status, "posted", "a personal branch belongs to no job, so no approval is waited for");
      assert.equal((await admin().gis.nodes.byId({ id: node.id })).name, "Tidied");
    });

    it("links a job's log only when it was recorded on the job's branch, so its edit is reviewed with the job", async () => {
      const valve = await admin().gis.nodes.create({ type: "valve", name: "To exercise", location: somewhere(), isOpen: true });
      const job = await admin().workOrders.create({ title: "Exercise", kind: "valve_exercise", assetId: valve.id, assigneeId: env.users.tech });
      const { branch } = await tech().workOrders.changeSet({ workOrderId: job.id });

      const onMain = await tech().gis.logs.recordValveState({ valveId: valve.id, isOpen: false });
      await expectCode(tech().workOrders.linkLog({ eventId: randomUUID(), workOrderId: job.id, logKind: "valve", logId: onMain.log.id }), "CONFLICT");

      const onBranch = await tech().gis.logs.recordValveState({ valveId: valve.id, branch, isOpen: false, changedAt: new Date(Date.now() + 1000) });
      assert.equal(onBranch.outcome, "applied");
      const linked = await tech().workOrders.linkLog({ eventId: randomUUID(), workOrderId: job.id, logKind: "valve", logId: onBranch.log.id });
      assert.equal(linked.outcome, "applied");
      assert.equal(linked.order.assets[0]?.status, "done");
      assert.equal((await admin().gis.nodes.byId({ id: valve.id })).isOpen, true, "main waits for the job's branch to be posted");
      assert.equal((await admin().gis.nodes.byId({ id: valve.id, branch })).isOpen, false);
    });

    it("takes a log on main for a job that has no branch", async () => {
      const node = await admin().gis.nodes.create({ type: "junction", name: "Looked at", location: somewhere() });
      const job = await admin().workOrders.create({ title: "Look", kind: "inspection", assetId: node.id, assigneeId: env.users.engineer });
      const log = await env.engineer().gis.logs.recordCondition({ assetId: node.id, condition: "fair" });
      assert.equal(log.outcome, "applied");
      const linked = await env.engineer().workOrders.linkLog({ eventId: randomUUID(), workOrderId: job.id, logKind: "condition", logId: log.log.id });
      assert.equal(linked.outcome, "applied");
    });
  });

  describe("logs recorded on a branch", () => {
    it("are kept when the branch has closed, but leave the asset alone", async () => {
      const valve = await admin().gis.nodes.create({ type: "valve", name: "Main valve", location: somewhere(), isOpen: true });
      const { job, branch } = await startedJob();

      const open = await tech().gis.logs.recordValveState({ valveId: valve.id, branch, isOpen: false });
      assert.equal(open.outcome, "applied");
      assert.equal((await admin().gis.nodes.byId({ id: valve.id })).isOpen, true, "main is untouched: it's a proposal");

      await admin().workOrders.cancel({ id: job.id });
      const late = await tech().gis.logs.recordValveState({ valveId: valve.id, branch, isOpen: true, changedAt: new Date(Date.now() + 1000) });
      assert.equal(late.outcome, "stale", "kept as history, asset left alone");
      assert.ok((await tech().gis.logs.valveHistory({ valveId: valve.id })).some((l) => l.id === late.log.id));
    });
  });

  describe("from capture to main", () => {
    it("takes a valve found on site from the technician's branch, through approval, onto main", async () => {
      const { job, branch } = await startedJob();
      const found = await valveOn(tech(), branch);
      const added = await tech().workOrders.addAsset({ eventId: randomUUID(), workOrderId: job.id, assetId: found.id });
      assert.equal(added.order.assets[0]?.state, "proposed");

      const submitted = await tech().workOrders.transition({ eventId: randomUUID(), workOrderId: job.id, action: { type: "submit", outcome: "done" } });
      assert.equal(submitted.outcome, "applied");
      assert.equal((await env.events("gis.branch_submitted", "branch", branch)).length, 1);

      // The engineer's list says where the branch came from, and that the work isn't approved yet.
      const waiting = (await admin().gis.reconcile.branches()).find((b) => b.branch === branch);
      assert.equal(waiting?.origin?.ref, job.code);
      assert.equal(waiting?.origin?.status, "submitted");

      // Posting it before approval needs an explicit override, and writes nothing without one.
      const early = await admin().gis.reconcile.preview({ branch });
      const refused = await admin().gis.reconcile.post({ branch, token: early.token });
      assert.equal(refused.status, "not_approved");
      await expectCode(admin().gis.nodes.byId({ id: found.id }), "NOT_FOUND");

      await admin().workOrders.review({ eventId: randomUUID(), workOrderId: job.id, decision: "approve" });
      const approved = (await admin().gis.reconcile.branches()).find((b) => b.branch === branch);
      assert.equal(approved?.origin?.status, "completed");
      assert.equal((await env.events("gis.branch_ready_for_reconcile", "branch", branch)).length, 1);

      // Approving didn't post anything: the node is still only a proposal.
      await expectCode(admin().gis.nodes.byId({ id: found.id }), "NOT_FOUND");

      const preview = await admin().gis.reconcile.preview({ branch });
      assert.equal(preview.origin?.ref, job.code);
      const posted = await admin().gis.reconcile.post({ branch, token: preview.token });
      assert.ok(posted.status === "posted");

      assert.equal((await admin().gis.nodes.byId({ id: found.id })).branch, "main");
      const after = await admin().workOrders.byId({ id: job.id });
      assert.equal(after.assets[0]?.state, "registered", "the asset's state follows reconcile with no extra step");
    });

    it("posts an unapproved job's branch only with an explicit override", async () => {
      const { job, branch } = await startedJob();
      const found = await valveOn(tech(), branch);
      const preview = await admin().gis.reconcile.preview({ branch });
      assert.equal((await admin().gis.reconcile.post({ branch, token: preview.token })).status, "not_approved");
      await expectCode(env.senior().gis.reconcile.post({ branch, token: preview.token, override: true }), "FORBIDDEN");
      assert.equal((await admin().gis.reconcile.post({ branch, token: preview.token, override: true })).status, "posted");
      assert.equal((await admin().gis.nodes.byId({ id: found.id })).branch, "main");
      assert.equal((await admin().workOrders.byId({ id: job.id })).status, "in_progress", "posting never moves the job");
    });

    it("doesn't label branches that aren't a job's", async () => {
      const branch = `plain-${env.run}`;
      await valveOn(admin(), branch);
      const listed = (await admin().gis.reconcile.branches()).find((b) => b.branch === branch);
      assert.equal(listed?.origin, null);
    });
  });

  describe("asset capture, end to end (Phase 2 done-when, API level)", () => {
    it("raises a capture job, the assignee captures a meter with a photo, a supervisor approves, an engineer posts, the meter is live", async () => {
      // Raised in the office, given to the technician.
      const job = await admin().workOrders.create({ title: "New bulk meter", kind: "asset_capture", location: geo(somewhere()), assigneeId: env.users.tech });
      // In the field: open the job's branch (starts the job), capture the meter on it, photograph it.
      const { branch } = await tech().workOrders.changeSet({ workOrderId: job.id });
      const meter = await tech().gis.nodes.create({ id: randomUUID(), type: "meter", name: "Bulk meter", location: somewhere(), branch });
      await tech().workOrders.addAsset({ eventId: randomUUID(), workOrderId: job.id, assetId: meter.id });
      const photo = await env.photo(env.members.tech, meter.id);
      assert.equal(photo.status, "uploaded");
      const submitted = await tech().workOrders.transition({ eventId: randomUUID(), workOrderId: job.id, action: { type: "submit", outcome: "done" } });
      assert.equal(submitted.outcome, "applied");

      // The supervisor approves the work; that never posts data.
      const reviewed = await env.senior().workOrders.review({ eventId: randomUUID(), workOrderId: job.id, decision: "approve" });
      assert.equal(reviewed.order.status, "completed");
      await expectCode(admin().gis.nodes.byId({ id: meter.id }), "NOT_FOUND");

      // The GIS engineer reviews the branch and posts it; the meter is live on main.
      const preview = await env.engineer().gis.reconcile.preview({ branch });
      assert.deepEqual(
        preview.entities.map((e) => [e.entityType, e.detail, e.needsPhoto]),
        [["node", "create", false]],
      );
      const posted = await env.engineer().gis.reconcile.post({ branch, token: preview.token });
      assert.ok(posted.status === "posted", JSON.stringify(posted));
      const live = await env.viewer().gis.nodes.byId({ id: meter.id });
      assert.equal(live.branch, "main");
      assert.equal(live.name, "Bulk meter");
      assert.ok((await env.viewer().gis.nodes.list({ types: ["meter"] })).some((n) => n.id === meter.id));
      assert.equal((await admin().workOrders.byId({ id: job.id })).assets[0]?.state, "registered");
    });

    it("won't post a captured meter without its photo", async () => {
      const { branch } = await startedJob();
      const meter = await tech().gis.nodes.create({ type: "meter", name: "No photo", location: somewhere(), branch });
      const preview = await admin().gis.reconcile.preview({ branch });
      assert.equal(preview.summary.needPhoto, 1);
      const result = await admin().gis.reconcile.post({ branch, token: preview.token, override: true });
      assert.ok(result.status === "invalid" && result.violations.some((v) => v.code === "node-photo-missing" && v.entityId === meter.id));
    });
  });
});
