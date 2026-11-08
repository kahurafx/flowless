import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, it } from "vitest";
import { randomUUID } from "node:crypto";
import { expectCode, setupTestEnv, type TestEnv } from "./test-support";

const A = { lat: -1.29, lng: 36.78 };
const B = { lat: -1.3, lng: 36.78 };

describe("soft delete", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setupTestEnv();
  });
  afterAll(async () => {
    await env.close();
  });

  const admin = () => env.admin();
  const node = (name = "Node", location = A) => admin().gis.nodes.create({ type: "junction", name, location });
  async function pipe() {
    const from = await node("From", A);
    const to = await node("To", B);
    const created = await admin().gis.pipes.create({ fromNodeId: from.id, toNodeId: to.id, path: [A, B], material: "pvc", diameterMm: 100 });
    return { from, to, pipe: created };
  }

  it("lists a deleted node apart from the live ones, with who and when", async () => {
    const n = await node("Going");
    await admin().gis.nodes.delete({ id: n.id, baseVersionId: n.versionId });
    assert.ok(!(await admin().gis.nodes.list()).some((x) => x.id === n.id));
    const found = (await admin().gis.nodes.deleted()).find((x) => x.id === n.id);
    assert.equal(found?.name, "Going");
    assert.equal(found?.deletedByUserId, env.users.admin);
    assert.ok(found?.deletedAt);
  });

  it("restores a node, and restoring twice changes nothing", async () => {
    const n = await node("Back");
    await admin().gis.nodes.delete({ id: n.id, baseVersionId: n.versionId });
    const restored = await admin().gis.nodes.restore({ id: n.id });
    assert.ok((await admin().gis.nodes.list()).some((x) => x.id === n.id));
    assert.ok(!(await admin().gis.nodes.deleted()).some((x) => x.id === n.id));
    assert.equal((await admin().gis.nodes.restore({ id: n.id }))?.versionId, restored?.versionId);
  });

  it("won't restore a pipe until both its end nodes are back", async () => {
    const { from, to, pipe: p } = await pipe();
    await admin().gis.pipes.delete({ id: p.id, baseVersionId: p.versionId });
    await admin().gis.nodes.delete({ id: from.id, baseVersionId: from.versionId });
    await expectCode(admin().gis.pipes.restore({ id: p.id }), "CONFLICT");
    assert.ok(!(await admin().gis.pipes.list()).some((x) => x.id === p.id), "the refused restore rolled back");
    await admin().gis.nodes.restore({ id: from.id });
    await admin().gis.pipes.restore({ id: p.id });
    assert.ok((await admin().gis.pipes.list()).some((x) => x.id === p.id));
    assert.ok(to.id);
  });

  it("won't restore a node into a deleted structure", async () => {
    const home = await admin().gis.structures.create({ type: "chamber", name: "Home", location: A });
    const n = await admin().gis.nodes.create({ type: "valve", name: "Housed", location: A, isOpen: true, structureId: home.id });
    await admin().gis.nodes.delete({ id: n.id, baseVersionId: n.versionId });
    await admin().gis.structures.delete({ id: home.id, baseVersionId: home.versionId });
    await expectCode(admin().gis.nodes.restore({ id: n.id }), "CONFLICT");
    await admin().gis.structures.restore({ id: home.id });
    await admin().gis.nodes.restore({ id: n.id });
  });

  it("only lets admins and engineers restore", async () => {
    const n = await node();
    await admin().gis.nodes.delete({ id: n.id, baseVersionId: n.versionId });
    await expectCode(env.tech().gis.nodes.restore({ id: n.id }), "FORBIDDEN");
    await expectCode(env.senior().gis.nodes.deleteImpact({ id: n.id }), "FORBIDDEN");
  });

  it("keeps other organizations out", async () => {
    const n = await node();
    await admin().gis.nodes.delete({ id: n.id, baseVersionId: n.versionId });
    const outsider = env.outsider();
    assert.ok(!(await outsider.gis.nodes.deleted()).some((x) => x.id === n.id));
    await expectCode(outsider.gis.nodes.restore({ id: n.id }), "NOT_FOUND");
  });

  it("explains why a node can't be deleted, naming what's connected", async () => {
    const { from, pipe: p } = await pipe();
    const impact = await admin().gis.nodes.deleteImpact({ id: from.id });
    assert.equal(impact.blockers.length, 1);
    assert.match(impact.connected[0] ?? "", /100 mm pvc pipe to To/);
    await admin().gis.pipes.delete({ id: p.id, baseVersionId: p.versionId });
    assert.deepEqual((await admin().gis.nodes.deleteImpact({ id: from.id })).blockers, []);
  });

  it("warns when deleting a pipe would strand its end nodes", async () => {
    const { pipe: p } = await pipe();
    const impact = await admin().gis.pipes.deleteImpact({ id: p.id });
    assert.deepEqual(impact.blockers, []);
    assert.match(impact.warnings[0] ?? "", /From and To|To and From/);
  });

  it("lists the open jobs on an asset, and drops them once they're closed", async () => {
    const n = await node();
    const job = await admin().workOrders.create({ title: "Look at it", kind: "inspection", assetId: n.id, assigneeId: env.users.tech });
    const impact = await admin().gis.nodes.deleteImpact({ id: n.id });
    assert.deepEqual(
      impact.openJobs.map((j) => j.code),
      [job.code],
    );
    await admin().workOrders.cancel({ id: job.id });
    assert.deepEqual((await admin().gis.nodes.deleteImpact({ id: n.id })).openJobs, []);
  });

  it("merges a branch edit made before the delete, after a restore", async () => {
    const n = await node("Original");
    const branch = `feature-${env.run}`;
    await admin().gis.nodes.update({ id: n.id, baseVersionId: n.versionId, branch, patch: { name: "Renamed" } });
    await admin().gis.nodes.delete({ id: n.id, baseVersionId: n.versionId });
    await admin().gis.nodes.restore({ id: n.id });
    const preview = await admin().gis.reconcile.preview({ branch });
    const posted = await admin().gis.reconcile.post({ branch, token: preview.token, resolutions: {} });
    assert.equal(posted.status, "posted");
    assert.equal((await admin().gis.nodes.byId({ id: n.id })).name, "Renamed");
  });

  it("leaves deleted assets out of the feeds and the condition trend", async () => {
    const n = await node("Reported");
    const when = new Date();
    await admin().gis.logs.recordCondition({ assetId: n.id, condition: "critical", recordedAt: when });
    const countCritical = async () => (await admin().gis.reports.conditionTrend()).at(-1)?.critical ?? 0;
    const before = await countCritical();
    assert.ok((await admin().gis.logs.conditionFeed({})).some((l) => l.assetId === n.id));
    assert.ok((await admin().gis.reports.recentFindings()).some((l) => l.assetId === n.id));

    const current = await admin().gis.nodes.byId({ id: n.id });
    await admin().gis.nodes.delete({ id: n.id, baseVersionId: current.versionId });
    assert.ok(!(await admin().gis.logs.conditionFeed({})).some((l) => l.assetId === n.id));
    assert.ok(!(await admin().gis.reports.recentFindings()).some((l) => l.assetId === n.id));
    assert.equal(await countCritical(), before - 1);
  });

  // Flowless: Majimap answered CONFLICT here from its shared registry. Work Orders asks GIS
  // only through the asset resolver, which leaves deleted assets out, so it is NOT_FOUND.
  it("refuses to add a deleted asset to a job", async () => {
    const n = await node();
    await admin().gis.nodes.delete({ id: n.id, baseVersionId: n.versionId });
    const job = await admin().workOrders.create({ title: "Survey", kind: "leak_survey", areaId: (await env.dmaArea()).id });
    await expectCode(admin().workOrders.addAsset({ eventId: randomUUID(), workOrderId: job.id, assetId: n.id }), "NOT_FOUND");
  });

  it("lets a route job finish when one of its assets was deleted", async () => {
    const a = await admin().gis.nodes.create({ type: "valve", name: "One", location: A, isOpen: true });
    const b = await admin().gis.nodes.create({ type: "valve", name: "Two", location: B, isOpen: true });
    const job = await admin().workOrders.create({
      title: "Exercise",
      kind: "valve_exercise",
      assetId: a.id,
      relatedAssetIds: [b.id],
      assigneeId: env.users.tech,
    });
    const log = await env.tech().gis.logs.recordValveState({ valveId: a.id, isOpen: false });
    await env.tech().workOrders.linkLog({ eventId: randomUUID(), workOrderId: job.id, logKind: "valve", logId: log.log.id });
    await admin().gis.nodes.delete({ id: b.id, baseVersionId: b.versionId });
    const done = await env.tech().workOrders.transition({ eventId: randomUUID(), workOrderId: job.id, action: { type: "submit", outcome: "done" } });
    assert.equal(done.outcome, "applied");
  });
});
