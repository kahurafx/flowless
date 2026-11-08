import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, it } from "vitest";
import { randomUUID } from "node:crypto";
import { expectCode, setupTestEnv, type TestEnv } from "./test-support";

// Ported from Majimap's gis/test/connections.test.ts. Flowless: GIS holds no customers.
// A connection carries the Accounts service point by id (optional), and a connection going
// live publishes `gis.connection_posted` for Accounts. Majimap's customer capture, status
// and name-truncation cases have no GIS counterpart and are replaced by the event cases.

const A = { lat: -1.29, lng: 36.78 };
const B = { lat: -1.3, lng: 36.78 };

describe("service connections", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setupTestEnv();
  });
  afterAll(async () => {
    await env.close();
  });

  const admin = () => env.admin();
  const tech = () => env.tech();
  const number = () => `C-${randomUUID().slice(0, 8)}`;
  const posted = (connectionId: string) => env.events("gis.connection_posted", "connectionId", connectionId);

  async function pipe() {
    const from = await admin().gis.nodes.create({ type: "reservoir", name: "From", location: A });
    const to = await admin().gis.nodes.create({ type: "junction", name: "To", location: B });
    return admin().gis.pipes.create({ fromNodeId: from.id, toNodeId: to.id, path: [A, B], material: "pvc", diameterMm: 100 });
  }
  /** A technician's connection-capture job (Majimap's customer_capture) with its branch. */
  async function capture() {
    const job = await admin().workOrders.create({ title: "New connection", kind: "connection_capture", location: { latitude: A.lat, longitude: A.lng }, assigneeId: env.users.tech });
    const { branch } = await tech().workOrders.changeSet({ workOrderId: job.id });
    return { job, branch };
  }
  const post = async (branch: string) => {
    const preview = await admin().gis.reconcile.preview({ branch });
    return admin().gis.reconcile.post({ branch, token: preview.token, resolutions: {}, override: true });
  };

  it("goes from capture through review to a live connection, announced to Accounts", async () => {
    const p = await pipe();
    const { branch } = await capture();
    const servicePointId = randomUUID();
    const connection = await tech().gis.connections.create({ branch, connectionNumber: number(), location: A, servicePointId, pipeId: p.id });

    assert.equal((await posted(connection.id)).length, 0, "a capture isn't real until it's posted");
    assert.ok(!(await admin().gis.connections.list()).some((c) => c.id === connection.id), "not live until posted");
    assert.equal((await post(branch))?.status, "posted");
    assert.ok((await admin().gis.connections.list()).some((c) => c.id === connection.id));
    const [event] = await posted(connection.id);
    assert.deepEqual(event?.payload, {
      connectionId: connection.id,
      connectionNumber: connection.connectionNumber,
      location: A,
      servicePointId,
      pipeId: p.id,
      branch,
      postedByUserId: env.users.admin,
    });
  });

  it("announces nothing when the capture is thrown away", async () => {
    const { branch } = await capture();
    const connection = await tech().gis.connections.create({ branch, connectionNumber: number(), location: A });
    await admin().gis.reconcile.discard({ branch });
    assert.equal((await posted(connection.id)).length, 0);
  });

  it("announces a connection created straight on main by someone who may post", async () => {
    const connection = await admin().gis.connections.create({ connectionNumber: number(), location: B });
    assert.equal((await posted(connection.id))[0]?.payload && (await posted(connection.id)).length, 1);
    assert.equal(connection.servicePointId, null, "Accounts links the service point later");
  });

  it("replays a retried create", async () => {
    const { branch } = await capture();
    const id = randomUUID();
    const connectionNumber = number();
    const first = await tech().gis.connections.create({ id, branch, connectionNumber, location: A });
    const again = await tech().gis.connections.create({ id, branch, connectionNumber, location: A });
    assert.equal(again.versionId, first.versionId);
  });

  it("refuses a number already live, straight away and when posting", async () => {
    const taken = number();
    await admin().gis.connections.create({ connectionNumber: taken, location: A });
    await expectCode(admin().gis.connections.create({ connectionNumber: taken, location: B }), "CONFLICT");

    const { branch } = await capture();
    await tech().gis.connections.create({ branch, connectionNumber: taken, location: B });
    const preview = await admin().gis.reconcile.preview({ branch });
    await expectCode(admin().gis.reconcile.post({ branch, token: preview.token, resolutions: {}, override: true }), "CONFLICT");
  });

  it("frees a number when its connection is deleted", async () => {
    const reused = number();
    const old = await admin().gis.connections.create({ connectionNumber: reused, location: A });
    await admin().gis.connections.delete({ id: old.id, baseVersionId: old.versionId });
    await admin().gis.connections.create({ connectionNumber: reused, location: B });
    await expectCode(admin().gis.connections.restore({ id: old.id }), "CONFLICT");
  });

  describe("pipe links", () => {
    it("refuses a pipe that doesn't exist", async () => {
      await expectCode(admin().gis.connections.create({ connectionNumber: number(), location: A, pipeId: randomUUID() }), "BAD_REQUEST");
    });

    it("won't delete a pipe that serves someone, until they're relinked", async () => {
      const p = await pipe();
      const connection = await admin().gis.connections.create({ connectionNumber: number(), location: A, pipeId: p.id });

      const impact = await admin().gis.pipes.deleteImpact({ id: p.id });
      assert.equal(impact.blockers.length, 1);
      assert.equal(impact.connected[0], `Connection ${connection.connectionNumber}`);
      await expectCode(admin().gis.pipes.delete({ id: p.id, baseVersionId: p.versionId }), "CONFLICT");

      await admin().gis.connections.update({ id: connection.id, baseVersionId: connection.versionId, patch: { pipeId: null } });
      await admin().gis.pipes.delete({ id: p.id, baseVersionId: p.versionId });
    });

    it("reports a post that would strand a connection or link to a deleted pipe", async () => {
      const p = await pipe();
      const branch = `pipe-del-${env.run}`;
      await admin().gis.pipes.delete({ id: p.id, baseVersionId: p.versionId, branch });
      await admin().gis.connections.create({ connectionNumber: number(), location: A, pipeId: p.id });
      const result = await post(branch);
      assert.equal(result?.status, "invalid");
      assert.ok(result?.status === "invalid" && result.violations.some((v) => v.code === "connection-pipe-missing"));
    });

    it("refuses to restore a connection whose pipe is gone", async () => {
      const p = await pipe();
      const connection = await admin().gis.connections.create({ connectionNumber: number(), location: A, pipeId: p.id });
      await admin().gis.connections.delete({ id: connection.id, baseVersionId: connection.versionId });
      await admin().gis.pipes.delete({ id: p.id, baseVersionId: p.versionId });
      await expectCode(admin().gis.connections.restore({ id: connection.id }), "CONFLICT");
    });
  });

  it("says which connections a break affects, from the server's trace", async () => {
    const p = await pipe();
    const connection = await admin().gis.connections.create({ connectionNumber: number(), location: A, pipeId: p.id });
    const asTech = await tech().gis.trace.isolation({ failedPipeId: p.id });
    const hit = asTech.connections.onSection.find((c) => c.id === connection.id);
    assert.equal(hit?.connectionNumber, connection.connectionNumber);
  });

  it("isn't something a log can be recorded against", async () => {
    const connection = await admin().gis.connections.create({ connectionNumber: number(), location: A });
    await expectCode(admin().gis.logs.recordCondition({ assetId: connection.id, condition: "poor", recordedAt: new Date() }), "BAD_REQUEST");
  });

  it("stays out of other organizations", async () => {
    const mine = await admin().gis.connections.create({ connectionNumber: number(), location: A });
    const outsider = env.outsider();
    assert.ok(!(await outsider.gis.connections.list()).some((c) => c.id === mine.id));
    await expectCode(outsider.gis.connections.byId({ id: mine.id }), "NOT_FOUND");
    await expectCode(outsider.gis.connections.create({ id: mine.id, connectionNumber: number(), location: A }), "CONFLICT");
  });
});
