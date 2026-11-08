import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, it } from "vitest";
import { personalBranch } from "@flowless/shared-types";
import { pathLengthMetres } from "../geo";
import { expectCode, setupTestEnv, type TestEnv } from "./test-support";

const A = { lat: -1.29, lng: 36.78 };
const B = { lat: -1.3, lng: 36.78 }; // 0.01° of latitude south of A: about 1,112 m

describe("gis.pipes", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setupTestEnv();
  });
  afterAll(async () => {
    await env.close();
  });

  const admin = () => env.admin();
  const tech = () => env.tech();
  const shortId = () => Math.random().toString(36).slice(2, 7);

  type NodeCreateInput = Parameters<ReturnType<TestEnv["admin"]>["gis"]["nodes"]["create"]>[0];
  const newNode = (overrides: Partial<NodeCreateInput> = {}) =>
    admin().gis.nodes.create({ type: "junction", name: `Junction ${shortId()}`, location: A, ...overrides });

  type PipeCreateInput = Parameters<ReturnType<TestEnv["admin"]>["gis"]["pipes"]["create"]>[0];
  /** Creates its own end nodes unless you pass them. */
  async function newPipe(overrides: Partial<PipeCreateInput> = {}) {
    const fromNodeId = overrides.fromNodeId ?? (await newNode({ location: A })).id;
    const toNodeId = overrides.toNodeId ?? (await newNode({ location: B })).id;
    return admin().gis.pipes.create({
      fromNodeId,
      toNodeId,
      path: [A, B],
      diameterMm: 300,
      material: "ductile_iron",
      condition: "good",
      ...overrides,
    });
  }

  const conditionEvents = (assetId: string) => env.events("gis.condition_changed", "assetId", assetId);

  describe("access control", () => {
    it("rejects callers who aren't signed in", async () => {
      await expectCode(env.anonymous().gis.pipes.list(), "UNAUTHORIZED");
    });

    it("lets a viewer read but not write", async () => {
      const a = await newNode();
      const b = await newNode({ location: B });
      await env.viewer().gis.pipes.list();
      await expectCode(env.viewer().gis.pipes.create({ fromNodeId: a.id, toNodeId: b.id, path: [A, B], diameterMm: 100 }), "FORBIDDEN");
    });

    it("lets a technician create and edit on their own branch but not delete, and not on main (gap fix)", async () => {
      const a = await newNode();
      const b = await newNode({ location: B });
      const branch = personalBranch(env.users.tech);
      await expectCode(tech().gis.pipes.create({ fromNodeId: a.id, toNodeId: b.id, path: [A, B], diameterMm: 150 }), "FORBIDDEN");
      const pipe = await tech().gis.pipes.create({ branch, fromNodeId: a.id, toNodeId: b.id, path: [A, B], diameterMm: 150 });
      await expectCode(tech().gis.pipes.delete({ id: pipe.id, baseVersionId: pipe.versionId, branch }), "FORBIDDEN");
      const edited = await tech().gis.pipes.update({
        id: pipe.id,
        baseVersionId: pipe.versionId,
        branch,
        patch: { diameterMm: 200 },
      });
      assert.equal(edited.diameterMm, 200);
    });
  });

  describe("creating and reading", () => {
    it("round-trips geometry in the shape the frontends already use", async () => {
      const a = await newNode({ location: A });
      const b = await newNode({ location: B });
      const pipe = await newPipe({ fromNodeId: a.id, toNodeId: b.id });

      assert.equal(pipe.fromNodeId, a.id);
      assert.equal(pipe.toNodeId, b.id);
      assert.deepEqual(pipe.path, [A, B]);
      assert.equal(pipe.material, "ductile_iron");
      assert.equal(pipe.branch, "main");

      assert.deepEqual(await admin().gis.pipes.byId({ id: pipe.id }), pipe);
      assert.ok((await admin().gis.pipes.list()).some((p) => p.id === pipe.id));
    });

    it("computes the length from the path", async () => {
      const pipe = await newPipe();
      assert.ok(Math.abs(pipe.lengthM - pathLengthMetres([A, B])) < 0.01, `got ${pipe.lengthM}`);
      assert.ok(Math.abs(pipe.lengthM - 1112) < 2, `got ${pipe.lengthM}`);
    });

    it("ignores a length supplied by the client", async () => {
      const a = await newNode({ location: A });
      const b = await newNode({ location: B });
      const pipe = await admin().gis.pipes.create({
        fromNodeId: a.id,
        toNodeId: b.id,
        path: [A, B],
        diameterMm: 300,
        lengthM: 1,
      } as never);
      assert.ok(Math.abs(pipe.lengthM - 1112) < 2, `got ${pipe.lengthM}`);
    });

    it("treats a retried create with the same id as a no-op, not a duplicate", async () => {
      const a = await newNode({ location: A });
      const b = await newNode({ location: B });
      const clientId = env.id();
      const first = await newPipe({ id: clientId, fromNodeId: a.id, toNodeId: b.id });
      const retry = await newPipe({ id: clientId, fromNodeId: a.id, toNodeId: b.id });
      assert.equal(retry.versionId, first.versionId);
      assert.equal((await admin().gis.pipes.history({ id: clientId })).length, 1);
    });
  });

  describe("rejecting bad pipes", () => {
    it("needs two different end nodes", async () => {
      const a = await newNode();
      await expectCode(newPipe({ fromNodeId: a.id, toNodeId: a.id }), "BAD_REQUEST");
    });

    it("needs both ends to exist", async () => {
      const a = await newNode();
      await expectCode(newPipe({ fromNodeId: a.id, toNodeId: env.id() }), "BAD_REQUEST");
    });

    it("won't connect to another organization's node", async () => {
      const mine = await newNode();
      const theirs = await env.outsider().gis.nodes.create({ type: "junction", name: "Theirs", location: B });
      await expectCode(newPipe({ fromNodeId: mine.id, toNodeId: theirs.id }), "BAD_REQUEST");
    });

    it("won't connect to a deleted node", async () => {
      const live = await newNode();
      const gone = await newNode({ location: B });
      await admin().gis.nodes.delete({ id: gone.id, baseVersionId: gone.versionId });
      await expectCode(newPipe({ fromNodeId: live.id, toNodeId: gone.id }), "BAD_REQUEST");
    });

    it("needs a path with some length", async () => {
      await expectCode(newPipe({ path: [A, A] }), "BAD_REQUEST");
    });

    it("needs at least two points on the path", async () => {
      await expectCode(newPipe({ path: [A] }), "BAD_REQUEST");
    });

    it("needs a positive diameter", async () => {
      await expectCode(newPipe({ diameterMm: 0 }), "BAD_REQUEST");
      await expectCode(newPipe({ diameterMm: -50 }), "BAD_REQUEST");
    });
  });

  describe("versioned edits", () => {
    it("re-routing recomputes the length and supersedes the old version", async () => {
      const pipe = await newPipe();
      const longer = { lat: -1.31, lng: 36.78 };
      const edited = await admin().gis.pipes.update({
        id: pipe.id,
        baseVersionId: pipe.versionId,
        patch: { path: [A, longer] },
      });
      assert.ok(Math.abs(edited.lengthM - 2224) < 3, `got ${edited.lengthM}`);
      assert.deepEqual(edited.path, [A, longer]);

      const history = await admin().gis.pipes.history({ id: pipe.id });
      assert.equal(history.length, 2);
      assert.equal(history[0]?.isHead, true);
      assert.equal(history[1]?.isHead, false);
      assert.equal(history[0]?.supersedesVersionId, pipe.versionId);
    });

    it("changes material, diameter and condition without touching the path", async () => {
      const pipe = await newPipe();
      const edited = await admin().gis.pipes.update({
        id: pipe.id,
        baseVersionId: pipe.versionId,
        patch: { material: "hdpe", diameterMm: 450, condition: "fair" },
      });
      assert.deepEqual([edited.material, edited.diameterMm, edited.condition], ["hdpe", 450, "fair"]);
      assert.deepEqual(edited.path, pipe.path);
      assert.equal(edited.lengthM, pipe.lengthM);
    });

    it("refuses a re-route with no length", async () => {
      const pipe = await newPipe();
      await expectCode(admin().gis.pipes.update({ id: pipe.id, baseVersionId: pipe.versionId, patch: { path: [B, B] } }), "BAD_REQUEST");
    });

    it("rejects an edit based on a stale version", async () => {
      const pipe = await newPipe();
      await admin().gis.pipes.update({ id: pipe.id, baseVersionId: pipe.versionId, patch: { diameterMm: 250 } });
      await expectCode(admin().gis.pipes.update({ id: pipe.id, baseVersionId: pipe.versionId, patch: { diameterMm: 350 } }), "CONFLICT");
    });

    it("doesn't let the end nodes change", async () => {
      const pipe = await newPipe();
      const other = await newNode();
      await expectCode(
        admin().gis.pipes.update({
          id: pipe.id,
          baseVersionId: pipe.versionId,
          patch: { fromNodeId: other.id } as never,
        }),
        "BAD_REQUEST",
      );
    });

    it("emits a condition event when condition changes on main, and only then", async () => {
      const pipe = await newPipe({ condition: "good" });
      const renamed = await admin().gis.pipes.update({
        id: pipe.id,
        baseVersionId: pipe.versionId,
        patch: { diameterMm: 320 },
      });
      assert.equal((await conditionEvents(pipe.id)).length, 0);

      await admin().gis.pipes.update({ id: pipe.id, baseVersionId: renamed.versionId, patch: { condition: "critical" } });
      const events = await conditionEvents(pipe.id);
      assert.equal(events.length, 1);
      assert.deepEqual(events[0]?.payload, {
        assetId: pipe.id,
        from: "good",
        to: "critical",
        changedByUserId: env.users.admin,
      });
    });

    it("hides a deleted pipe and refuses further edits", async () => {
      const pipe = await newPipe();
      await admin().gis.pipes.delete({ id: pipe.id, baseVersionId: pipe.versionId });
      assert.ok(!(await admin().gis.pipes.list()).some((p) => p.id === pipe.id));
      await expectCode(admin().gis.pipes.byId({ id: pipe.id }), "NOT_FOUND");
      const history = await admin().gis.pipes.history({ id: pipe.id });
      assert.equal(history.length, 2, "deleting adds a tombstone version, it doesn't erase history");
      await expectCode(admin().gis.pipes.update({ id: pipe.id, baseVersionId: history[0]!.versionId, patch: { diameterMm: 99 } }), "NOT_FOUND");
    });
  });

  describe("branches", () => {
    it("lets a pipe on a branch connect nodes that exist on main, and keeps it off main", async () => {
      const a = await newNode({ location: A });
      const b = await newNode({ location: B });
      const pipe = await newPipe({ branch: "extension", fromNodeId: a.id, toNodeId: b.id });

      assert.equal(pipe.branch, "extension");
      assert.ok((await admin().gis.pipes.list({ branch: "extension" })).some((p) => p.id === pipe.id));
      assert.ok(!(await admin().gis.pipes.list()).some((p) => p.id === pipe.id));
      await expectCode(admin().gis.pipes.byId({ id: pipe.id }), "NOT_FOUND");
    });

    it("only lets main connect to nodes that exist on main", async () => {
      const onMain = await newNode({ location: A });
      const draftOnly = await newNode({ location: B, branch: "draft-network" });

      await expectCode(newPipe({ fromNodeId: onMain.id, toNodeId: draftOnly.id }), "BAD_REQUEST");
      const onBranch = await newPipe({ branch: "draft-network", fromNodeId: onMain.id, toNodeId: draftOnly.id });
      assert.equal(onBranch.branch, "draft-network");
    });

    it("keeps a branch edit off main", async () => {
      const pipe = await newPipe();
      const longer = { lat: -1.32, lng: 36.78 };
      await admin().gis.pipes.update({
        id: pipe.id,
        baseVersionId: pipe.versionId,
        branch: "reroute",
        patch: { path: [A, longer], condition: "critical" },
      });
      const onMain = await admin().gis.pipes.byId({ id: pipe.id });
      assert.equal(onMain.versionId, pipe.versionId);
      assert.equal(onMain.lengthM, pipe.lengthM);
      assert.ok((await admin().gis.pipes.byId({ id: pipe.id, branch: "reroute" })).lengthM > pipe.lengthM);
      assert.equal((await conditionEvents(pipe.id)).length, 0, "an unreconciled edit isn't a fact other modules react to");
    });

    it("lets a branch hide a pipe without deleting it from main", async () => {
      const pipe = await newPipe();
      await admin().gis.pipes.delete({ id: pipe.id, baseVersionId: pipe.versionId, branch: "hide-pipe" });
      assert.ok(!(await admin().gis.pipes.list({ branch: "hide-pipe" })).some((p) => p.id === pipe.id));
      assert.ok((await admin().gis.pipes.list()).some((p) => p.id === pipe.id));
    });
  });

  describe("deleting a node that pipes end on", () => {
    it("is refused while a pipe is connected, and allowed once it's gone", async () => {
      const a = await newNode({ location: A });
      const b = await newNode({ location: B });
      const pipe = await newPipe({ fromNodeId: a.id, toNodeId: b.id });

      await expectCode(admin().gis.nodes.delete({ id: a.id, baseVersionId: a.versionId }), "CONFLICT");
      await expectCode(admin().gis.nodes.delete({ id: b.id, baseVersionId: b.versionId }), "CONFLICT");

      await admin().gis.pipes.delete({ id: pipe.id, baseVersionId: pipe.versionId });
      await admin().gis.nodes.delete({ id: a.id, baseVersionId: a.versionId });
      await expectCode(admin().gis.nodes.byId({ id: a.id }), "NOT_FOUND");
    });

    it("judges by what the caller's branch sees, not by main alone", async () => {
      const a = await newNode({ location: A });
      const b = await newNode({ location: B });
      const pipe = await newPipe({ fromNodeId: a.id, toNodeId: b.id });

      // On a branch the pipe has been removed, so the node can go there...
      await admin().gis.pipes.delete({ id: pipe.id, baseVersionId: pipe.versionId, branch: "unplug" });
      await admin().gis.nodes.delete({ id: a.id, baseVersionId: a.versionId, branch: "unplug" });

      // ...but on main the pipe still ends on it.
      await expectCode(admin().gis.nodes.delete({ id: a.id, baseVersionId: a.versionId }), "CONFLICT");
    });
  });

  describe("concurrency", () => {
    it("lets exactly one of two racing edits win", async () => {
      const pipe = await newPipe();
      const results = await Promise.allSettled([
        admin().gis.pipes.update({ id: pipe.id, baseVersionId: pipe.versionId, patch: { diameterMm: 111 } }),
        env.engineer().gis.pipes.update({ id: pipe.id, baseVersionId: pipe.versionId, patch: { diameterMm: 222 } }),
      ]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      const lost = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      assert.equal((lost?.reason as { code?: string } | undefined)?.code, "CONFLICT");

      const history = await admin().gis.pipes.history({ id: pipe.id });
      assert.equal(history.filter((h) => h.isHead && h.branch === "main").length, 1, "exactly one head survives");
    });
  });

  describe("tenant isolation", () => {
    it("never shows another organization's pipes", async () => {
      const mine = await newPipe();
      assert.ok(!(await env.outsider().gis.pipes.list()).some((p) => p.id === mine.id));
      await expectCode(env.outsider().gis.pipes.byId({ id: mine.id }), "NOT_FOUND");
      await expectCode(env.outsider().gis.pipes.history({ id: mine.id }), "NOT_FOUND");
    });

    it("won't let another organization edit, delete or claim a pipe's id", async () => {
      const mine = await newPipe();
      const outsider = env.outsider();
      await expectCode(outsider.gis.pipes.update({ id: mine.id, baseVersionId: mine.versionId, patch: { diameterMm: 1 } }), "NOT_FOUND");
      await expectCode(outsider.gis.pipes.delete({ id: mine.id, baseVersionId: mine.versionId }), "NOT_FOUND");

      const a = await outsider.gis.nodes.create({ type: "junction", name: "A", location: A });
      const b = await outsider.gis.nodes.create({ type: "junction", name: "B", location: B });
      await expectCode(outsider.gis.pipes.create({ id: mine.id, fromNodeId: a.id, toNodeId: b.id, path: [A, B], diameterMm: 100 }), "CONFLICT");
      assert.equal((await admin().gis.pipes.byId({ id: mine.id })).diameterMm, mine.diameterMm);
    });
  });
});
