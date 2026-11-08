import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, it } from "vitest";
import { pathLengthMetres } from "../geo";
import { expectCode, setupTestEnv, type TestEnv } from "./test-support";

// All on one meridian, so distances are easy to reason about: each 0.01° of latitude is about 1,112 m.
const A = { lat: -1.29, lng: 36.78 };
const B = { lat: -1.3, lng: 36.78 };
const C = { lat: -1.31, lng: 36.78 }; // ≈ 2,224 m from A
const D = { lat: -1.32, lng: 36.78 }; // ≈ 3,336 m from A

describe("gis.reconcile across structures and pipes", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setupTestEnv();
  });
  afterAll(async () => {
    await env.close();
  });

  const admin = () => env.admin();
  const shortId = () => Math.random().toString(36).slice(2, 7);

  type NodeInput = Parameters<ReturnType<TestEnv["admin"]>["gis"]["nodes"]["create"]>[0];
  const newNode = (overrides: Partial<NodeInput> = {}) =>
    admin().gis.nodes.create({ type: "junction", name: `Junction ${shortId()}`, location: A, ...overrides });

  type StructureInput = Parameters<ReturnType<TestEnv["admin"]>["gis"]["structures"]["create"]>[0];
  const newStructure = (overrides: Partial<StructureInput> = {}) =>
    admin().gis.structures.create({ type: "vault", name: `Vault ${shortId()}`, location: A, ...overrides });

  type PipeInput = Parameters<ReturnType<TestEnv["admin"]>["gis"]["pipes"]["create"]>[0];
  async function newPipe(overrides: Partial<PipeInput> = {}) {
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

  async function postBranch(branch: string, resolutions?: Record<string, Record<string, "branch" | "main">>) {
    const preview = await admin().gis.reconcile.preview({ branch });
    return admin().gis.reconcile.post({ branch, token: preview.token, ...(resolutions ? { resolutions } : {}) });
  }

  const openBranches = async () => (await admin().gis.reconcile.branches()).map((b) => b.branch);

  const conditionEvents = (assetId: string) => env.events("gis.condition_changed", "assetId", assetId);

  describe("structures", () => {
    it("fast-forwards an edit and emits the condition event", async () => {
      const s = await newStructure({ name: "Vault base", condition: "good" });
      await admin().gis.structures.update({
        id: s.id,
        baseVersionId: s.versionId,
        branch: "s-ff",
        patch: { name: "Vault edited", condition: "poor" },
      });

      const preview = await admin().gis.reconcile.preview({ branch: "s-ff" });
      assert.equal(preview.entities.length, 1);
      assert.equal(preview.entities[0]?.entityType, "structure");
      assert.equal(preview.entities[0]?.detail, "fast-forward");

      const result = await admin().gis.reconcile.post({ branch: "s-ff", token: preview.token });
      assert.ok(result.status === "posted");
      assert.equal(result.summary.fastForwarded, 1);

      assert.equal((await admin().gis.structures.byId({ id: s.id })).name, "Vault edited");

      const events = await conditionEvents(s.id);
      assert.equal(events.length, 1);
      assert.deepEqual(events[0]?.payload, {
        assetId: s.id,
        from: "good",
        to: "poor",
        changedByUserId: env.users.admin,
        reconciledFromBranch: "s-ff",
      });
      assert.ok(!(await openBranches()).includes("s-ff"));
    });
  });

  describe("pipes", () => {
    it("fast-forwards a re-route and recomputes the length from the path", async () => {
      const pipe = await newPipe();
      await admin().gis.pipes.update({
        id: pipe.id,
        baseVersionId: pipe.versionId,
        branch: "p-ff",
        patch: { path: [A, C] },
      });

      const result = await postBranch("p-ff");
      assert.ok(result.status === "posted");

      const onMain = await admin().gis.pipes.byId({ id: pipe.id });
      assert.deepEqual(onMain.path, [A, C]);
      assert.ok(Math.abs(onMain.lengthM - pathLengthMetres([A, C])) < 0.01, `got ${onMain.lengthM}`);
      assert.ok(Math.abs(onMain.lengthM - 2224) < 3, `got ${onMain.lengthM}`);
    });

    it("merges a re-route with a concurrent change to something else", async () => {
      const pipe = await newPipe({ material: "pvc" });
      await admin().gis.pipes.update({ id: pipe.id, baseVersionId: pipe.versionId, branch: "p-merge", patch: { path: [A, C] } });
      await admin().gis.pipes.update({ id: pipe.id, baseVersionId: pipe.versionId, patch: { material: "hdpe" } });

      const preview = await admin().gis.reconcile.preview({ branch: "p-merge" });
      assert.equal(preview.entities[0]?.detail, "merge");
      assert.deepEqual(preview.entities[0]?.changedFields, ["path"]);

      const result = await admin().gis.reconcile.post({ branch: "p-merge", token: preview.token });
      assert.ok(result.status === "posted");
      const onMain = await admin().gis.pipes.byId({ id: pipe.id });
      assert.equal(onMain.material, "hdpe", "main's concurrent change is kept");
      assert.deepEqual(onMain.path, [A, C]);
      assert.ok(Math.abs(onMain.lengthM - 2224) < 3, `got ${onMain.lengthM}`);
    });

    it("reports a conflicting re-route as one conflict on the path, not two", async () => {
      const pipe = await newPipe();
      await admin().gis.pipes.update({ id: pipe.id, baseVersionId: pipe.versionId, branch: "p-clash", patch: { path: [A, C] } });
      await admin().gis.pipes.update({ id: pipe.id, baseVersionId: pipe.versionId, patch: { path: [A, D] } });

      const preview = await admin().gis.reconcile.preview({ branch: "p-clash" });
      assert.equal(preview.entities[0]?.kind, "conflict");
      assert.deepEqual(
        preview.entities[0]?.conflicts.map((c) => c.field),
        ["path"],
        "the length follows the path; it isn't a separate decision",
      );

      const result = await admin().gis.reconcile.post({
        branch: "p-clash",
        token: preview.token,
        resolutions: { [pipe.id]: { path: "branch" } },
      });
      assert.ok(result.status === "posted");
      const onMain = await admin().gis.pipes.byId({ id: pipe.id });
      assert.deepEqual(onMain.path, [A, C]);
      assert.ok(Math.abs(onMain.lengthM - pathLengthMetres([A, C])) < 0.01, "the length matches the chosen path");
    });

    it("keeps main's path and length together when main wins the conflict", async () => {
      const pipe = await newPipe();
      await admin().gis.pipes.update({ id: pipe.id, baseVersionId: pipe.versionId, branch: "p-yield", patch: { path: [A, C] } });
      await admin().gis.pipes.update({ id: pipe.id, baseVersionId: pipe.versionId, patch: { path: [A, D] } });

      const result = await postBranch("p-yield", { [pipe.id]: { path: "main" } });
      assert.ok(result.status === "posted");
      assert.equal(result.summary.skipped, 1);
      const onMain = await admin().gis.pipes.byId({ id: pipe.id });
      assert.deepEqual(onMain.path, [A, D]);
      assert.ok(Math.abs(onMain.lengthM - pathLengthMetres([A, D])) < 0.01, `got ${onMain.lengthM}`);
    });

    it("deletes a pipe from main when the branch deleted it, freeing its nodes to be deleted", async () => {
      const a = await newNode({ location: A });
      const b = await newNode({ location: B });
      const pipe = await newPipe({ fromNodeId: a.id, toNodeId: b.id });
      await admin().gis.pipes.delete({ id: pipe.id, baseVersionId: pipe.versionId, branch: "p-del" });

      const result = await postBranch("p-del");
      assert.ok(result.status === "posted");
      assert.equal(result.summary.deleted, 1);
      assert.ok(!(await admin().gis.pipes.list()).some((p) => p.id === pipe.id));

      await admin().gis.nodes.delete({ id: a.id, baseVersionId: a.versionId });
    });
  });

  describe("a branch that touches several kinds at once", () => {
    it("creates a structure, a node housed in it, and a pipe to an existing node — in dependency order", async () => {
      const existing = await newNode({ location: B });
      const vault = await newStructure({ branch: "newbuild", name: "New vault" });
      const valve = await newNode({
        branch: "newbuild",
        type: "valve",
        isOpen: true,
        structureId: vault.id,
        name: "New valve",
        location: A,
      });
      const pipe = await newPipe({ branch: "newbuild", fromNodeId: valve.id, toNodeId: existing.id });

      const preview = await admin().gis.reconcile.preview({ branch: "newbuild" });
      assert.deepEqual(preview.entities.map((e) => e.entityType).sort(), ["node", "pipe", "structure"]);
      assert.ok(preview.entities.every((e) => e.detail === "create"));

      const result = await admin().gis.reconcile.post({ branch: "newbuild", token: preview.token });
      assert.ok(result.status === "posted", JSON.stringify(result));
      assert.equal(result.summary.created, 3);

      assert.equal((await admin().gis.structures.byId({ id: vault.id })).name, "New vault");
      assert.equal((await admin().gis.nodes.byId({ id: valve.id })).structureId, vault.id);
      assert.equal((await admin().gis.pipes.byId({ id: pipe.id })).toNodeId, existing.id);
    });

    it("lists the branch once, counting every kind of change", async () => {
      const s = await newStructure();
      const pipe = await newPipe();
      await admin().gis.structures.update({ id: s.id, baseVersionId: s.versionId, branch: "multi", patch: { name: "Multi S" } });
      await admin().gis.pipes.update({ id: pipe.id, baseVersionId: pipe.versionId, branch: "multi", patch: { diameterMm: 999 } });

      const listed = (await admin().gis.reconcile.branches()).filter((b) => b.branch === "multi");
      assert.equal(listed.length, 1);
      assert.equal(listed[0]?.changes, 2);
    });

    it("is all-or-nothing: a conflicted pipe blocks an unrelated clean structure edit", async () => {
      const s = await newStructure({ name: "Clean base" });
      const pipe = await newPipe();
      await admin().gis.structures.update({ id: s.id, baseVersionId: s.versionId, branch: "mixed", patch: { name: "Clean edit" } });
      await admin().gis.pipes.update({ id: pipe.id, baseVersionId: pipe.versionId, branch: "mixed", patch: { path: [A, C] } });
      await admin().gis.pipes.update({ id: pipe.id, baseVersionId: pipe.versionId, patch: { path: [A, D] } });

      const result = await postBranch("mixed");
      assert.ok(result.status === "conflicts");
      assert.equal(result.conflicts.length, 1);
      assert.equal(result.conflicts[0]?.entityType, "pipe");
      assert.equal((await admin().gis.structures.byId({ id: s.id })).name, "Clean base");
    });

    it("refuses an approval made before the branch gained another change", async () => {
      const s = await newStructure();
      const pipe = await newPipe();
      await admin().gis.structures.update({ id: s.id, baseVersionId: s.versionId, branch: "late", patch: { name: "Reviewed" } });
      const preview = await admin().gis.reconcile.preview({ branch: "late" });

      await admin().gis.pipes.update({ id: pipe.id, baseVersionId: pipe.versionId, branch: "late", patch: { diameterMm: 77 } });
      await expectCode(admin().gis.reconcile.post({ branch: "late", token: preview.token }), "CONFLICT");
      assert.equal((await admin().gis.structures.byId({ id: s.id })).name, s.name, "nothing was posted");
    });

    it("discards every kind of change at once", async () => {
      const s = await newStructure({ name: "Keep me" });
      const pipe = await newPipe();
      await admin().gis.structures.update({ id: s.id, baseVersionId: s.versionId, branch: "scrap", patch: { name: "Scrap" } });
      await admin().gis.pipes.update({ id: pipe.id, baseVersionId: pipe.versionId, branch: "scrap", patch: { diameterMm: 11 } });

      assert.deepEqual(await admin().gis.reconcile.discard({ branch: "scrap" }), { discarded: 2 });
      assert.equal((await admin().gis.structures.byId({ id: s.id })).name, "Keep me");
      assert.equal((await admin().gis.pipes.byId({ id: pipe.id })).diameterMm, 300);
      assert.ok(!(await openBranches()).includes("scrap"));
    });
  });

  describe("keeping main consistent", () => {
    it("rejects deleting a node that main has since connected a pipe to", async () => {
      const a = await newNode({ location: A });
      const n = await newNode({ location: B });
      // On the branch the node has no pipes, so deleting it there is fine...
      await admin().gis.nodes.delete({ id: n.id, baseVersionId: n.versionId, branch: "lose-node" });
      // ...but meanwhile main connects a pipe to it.
      const pipe = await newPipe({ fromNodeId: a.id, toNodeId: n.id });

      const result = await postBranch("lose-node");
      assert.ok(result.status === "invalid");
      assert.ok(
        result.violations.some((v) => v.code === "pipe-endpoint-missing" && v.entityId === pipe.id && v.relatedId === n.id),
        JSON.stringify(result.violations),
      );

      // Nothing was applied, and the branch is still there to fix.
      assert.equal((await admin().gis.nodes.byId({ id: n.id })).id, n.id);
      assert.equal((await admin().gis.pipes.byId({ id: pipe.id })).id, pipe.id);
      assert.ok((await openBranches()).includes("lose-node"));
    });

    it("rejects a new pipe whose end node main has since deleted", async () => {
      const m1 = await newNode({ location: A });
      const m2 = await newNode({ location: B });
      const pipe = await newPipe({ branch: "extend", fromNodeId: m1.id, toNodeId: m2.id });
      // Main doesn't see the branch's pipe, so it's free to delete the node.
      await admin().gis.nodes.delete({ id: m2.id, baseVersionId: m2.versionId });

      const result = await postBranch("extend");
      assert.ok(result.status === "invalid");
      assert.ok(
        result.violations.some((v) => v.code === "pipe-endpoint-missing" && v.entityId === pipe.id && v.relatedId === m2.id),
        JSON.stringify(result.violations),
      );
      assert.ok(!(await admin().gis.pipes.list()).some((p) => p.id === pipe.id), "the pipe did not reach main");
      assert.ok((await openBranches()).includes("extend"));
    });

    it("rejects deleting a structure that main has since housed a node in", async () => {
      const vault = await newStructure({ name: "Doomed vault" });
      await admin().gis.structures.delete({ id: vault.id, baseVersionId: vault.versionId, branch: "drop-vault" });
      const valve = await newNode({ type: "valve", isOpen: true, structureId: vault.id, name: "Late valve" });

      const result = await postBranch("drop-vault");
      assert.ok(result.status === "invalid");
      assert.ok(
        result.violations.some((v) => v.code === "node-structure-missing" && v.entityId === valve.id && v.relatedId === vault.id),
        JSON.stringify(result.violations),
      );
      assert.equal((await admin().gis.structures.byId({ id: vault.id })).id, vault.id, "the vault is still on main");
      assert.ok((await openBranches()).includes("drop-vault"));
    });

    it("reports every problem, not just the first", async () => {
      const [m1, m2, m3, m4] = await Promise.all([newNode({ location: A }), newNode({ location: B }), newNode({ location: A }), newNode({ location: B })]);
      const p1 = await newPipe({ branch: "two-bad", fromNodeId: m1.id, toNodeId: m2.id });
      const p2 = await newPipe({ branch: "two-bad", fromNodeId: m3.id, toNodeId: m4.id });
      await admin().gis.nodes.delete({ id: m2.id, baseVersionId: m2.versionId });
      await admin().gis.nodes.delete({ id: m4.id, baseVersionId: m4.versionId });

      const result = await postBranch("two-bad");
      assert.ok(result.status === "invalid");
      assert.deepEqual(result.violations.map((v) => v.entityId).sort(), [p1.id, p2.id].sort());
    });
  });
});
