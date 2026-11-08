import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, it } from "vitest";
import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { createDatabase } from "@flowless/db";
import { asset } from "@flowless/db/schema/gis";
import { eq, sql } from "drizzle-orm";
import { expectCode, setupTestEnv, type TestEnv } from "./test-support";

// Ported from Majimap's gis/test/post.test.ts (reconcile). Flowless: the identity registry
// no longer mirrors labels, condition events are on the kernel outbox, and posting and
// discarding are audited.

describe("gis.reconcile", () => {
  let env: TestEnv;
  const admin = () => env.admin();
  const tech = () => env.tech();

  async function newValve(overrides: Partial<Parameters<ReturnType<typeof admin>["gis"]["nodes"]["create"]>[0]> = {}) {
    return admin().gis.nodes.create({
      type: "valve",
      name: `Valve ${randomUUID().slice(0, 5)}`,
      location: { lat: -1.288, lng: 36.782 },
      condition: "good",
      isOpen: true,
      ...overrides,
    });
  }

  type Valve = Awaited<ReturnType<typeof newValve>>;

  const editOn = (node: Pick<Valve, "id" | "versionId">, branch: string, patch: Parameters<ReturnType<typeof admin>["gis"]["nodes"]["update"]>[0]["patch"]) =>
    admin().gis.nodes.update({ id: node.id, baseVersionId: node.versionId, branch, patch });

  async function postBranch(branch: string, resolutions?: Record<string, Record<string, "branch" | "main">>) {
    const preview = await admin().gis.reconcile.preview({ branch });
    return admin().gis.reconcile.post({ branch, token: preview.token, ...(resolutions ? { resolutions } : {}) });
  }

  const conditionEvents = (assetId: string) => env.events("gis.condition_changed", "assetId", assetId);

  async function openBranchNames() {
    return (await admin().gis.reconcile.branches()).map((b) => b.branch);
  }

  beforeAll(async () => {
    env = await setupTestEnv();
  });
  afterAll(() => env?.close());

  describe("fast-forward", () => {
    it("lands the branch's change on main and retires the branch", async () => {
      const v1 = await newValve({ name: "FF base", condition: "good" });
      const branchRow = await editOn(v1, "ff", { name: "FF edited", condition: "poor" });

      const preview = await admin().gis.reconcile.preview({ branch: "ff" });
      assert.equal(preview.entities.length, 1);
      assert.equal(preview.entities[0]?.kind, "write");
      assert.equal(preview.entities[0]?.detail, "fast-forward");
      assert.deepEqual([...(preview.entities[0]?.changedFields ?? [])].sort(), ["condition", "name"]);
      assert.equal((await admin().gis.nodes.byId({ id: v1.id })).name, "FF base", "preview writes nothing");

      const result = await admin().gis.reconcile.post({ branch: "ff", token: preview.token });
      assert.ok(result.status === "posted");
      assert.equal(result.summary.fastForwarded, 1);

      const onMain = await admin().gis.nodes.byId({ id: v1.id });
      assert.equal(onMain.name, "FF edited");
      assert.equal(onMain.condition, "poor");
      assert.notEqual(onMain.versionId, v1.versionId);
      assert.notEqual(onMain.versionId, branchRow.versionId, "main gets its own new version");

      const history = await admin().gis.nodes.history({ id: v1.id });
      assert.equal(history.filter((h) => h.branch === "main" && h.isHead).length, 1, "exactly one main head");
      assert.equal(history.find((h) => h.versionId === v1.versionId)?.isHead, false, "the old main head was superseded");
      assert.equal(history.filter((h) => h.branch === "ff" && h.isHead).length, 0, "the branch no longer has a head");

      assert.equal((await admin().gis.nodes.byId({ id: v1.id, branch: "ff" })).versionId, onMain.versionId, "the branch view now shows main");
      assert.ok(!(await openBranchNames()).includes("ff"));

      const audit = await env.db.execute(sql`select action from kernel.audit_log where subject_type = 'gis_branch' and subject_id = 'ff'`);
      assert.deepEqual(audit.map((r) => r.action), ["gis.post"], "posting is audited");

      const events = await conditionEvents(v1.id);
      assert.equal(events.length, 1);
      assert.deepEqual(events[0]?.payload, {
        assetId: v1.id,
        from: "good",
        to: "poor",
        changedByUserId: env.users.admin,
        reconciledFromBranch: "ff",
      });
    });

    it("builds on every version in a branch's chain, not just the last", async () => {
      const v1 = await newValve({ name: "Chain base", condition: "good" });
      const b1 = await editOn(v1, "chain", { name: "Chain one" });
      await admin().gis.nodes.update({ id: v1.id, baseVersionId: b1.versionId, branch: "chain", patch: { condition: "fair" } });

      const preview = await admin().gis.reconcile.preview({ branch: "chain" });
      assert.equal(preview.entities[0]?.detail, "fast-forward", "main hasn't moved since the fork the chain started from");
      await admin().gis.reconcile.post({ branch: "chain", token: preview.token });

      const onMain = await admin().gis.nodes.byId({ id: v1.id });
      assert.equal(onMain.name, "Chain one");
      assert.equal(onMain.condition, "fair");
    });
  });

  describe("merging", () => {
    it("combines edits to different fields, keeping main's concurrent change", async () => {
      const v1 = await newValve({ name: "Merge base", condition: "good" });
      await editOn(v1, "merge", { name: "Merged name" });
      await admin().gis.nodes.update({ id: v1.id, baseVersionId: v1.versionId, patch: { condition: "fair" } });
      assert.equal((await conditionEvents(v1.id)).length, 1, "main's own edit emitted its event when it happened");

      const preview = await admin().gis.reconcile.preview({ branch: "merge" });
      assert.equal(preview.entities[0]?.detail, "merge");
      assert.deepEqual(preview.entities[0]?.changedFields, ["name"]);

      const result = await admin().gis.reconcile.post({ branch: "merge", token: preview.token });
      assert.ok(result.status === "posted");
      assert.equal(result.summary.merged, 1);

      const onMain = await admin().gis.nodes.byId({ id: v1.id });
      assert.equal(onMain.name, "Merged name");
      assert.equal(onMain.condition, "fair");
      assert.equal((await conditionEvents(v1.id)).length, 1, "no second event for a change main already had");
    });

    it("treats the same edit on both sides as agreement, not a conflict", async () => {
      const v1 = await newValve({ condition: "good" });
      await editOn(v1, "agree", { condition: "critical", name: "Agreed rename" });
      await admin().gis.nodes.update({ id: v1.id, baseVersionId: v1.versionId, patch: { condition: "critical" } });

      const preview = await admin().gis.reconcile.preview({ branch: "agree" });
      assert.equal(preview.summary.conflicts, 0);
      await admin().gis.reconcile.post({ branch: "agree", token: preview.token });
      const onMain = await admin().gis.nodes.byId({ id: v1.id });
      assert.equal(onMain.name, "Agreed rename");
      assert.equal(onMain.condition, "critical");
    });
  });

  describe("conflicts", () => {
    it("refuses to post until a conflict is resolved, then applies the choice", async () => {
      const v1 = await newValve({ name: "Conflict base" });
      await editOn(v1, "clash", { name: "Mine" });
      await admin().gis.nodes.update({ id: v1.id, baseVersionId: v1.versionId, patch: { name: "Theirs" } });

      const preview = await admin().gis.reconcile.preview({ branch: "clash" });
      assert.equal(preview.entities[0]?.kind, "conflict");
      assert.deepEqual(preview.entities[0]?.conflicts, [{ field: "name", base: "Conflict base", branch: "Mine", main: "Theirs" }]);

      const refused = await admin().gis.reconcile.post({ branch: "clash", token: preview.token });
      assert.ok(refused.status === "conflicts");
      assert.equal(refused.conflicts[0]?.id, v1.id);
      assert.equal((await admin().gis.nodes.byId({ id: v1.id })).name, "Theirs", "nothing was written");
      assert.ok((await openBranchNames()).includes("clash"), "the branch is still open");

      const resolved = await admin().gis.reconcile.post({
        branch: "clash",
        token: preview.token,
        resolutions: { [v1.id]: { name: "branch" } },
      });
      assert.ok(resolved.status === "posted");
      assert.equal((await admin().gis.nodes.byId({ id: v1.id })).name, "Mine");
    });

    it("lets main win a conflict, retiring the branch without changing main", async () => {
      const v1 = await newValve({ name: "Keep base" });
      await editOn(v1, "yield", { name: "Branch loses" });
      const mainEdit = await admin().gis.nodes.update({ id: v1.id, baseVersionId: v1.versionId, patch: { name: "Main wins" } });

      const result = await postBranch("yield", { [v1.id]: { name: "main" } });
      assert.ok(result.status === "posted");
      assert.equal(result.summary.skipped, 1);
      assert.equal((await admin().gis.nodes.byId({ id: v1.id })).versionId, mainEdit.versionId, "main untouched");
      assert.ok(!(await openBranchNames()).includes("yield"));
    });

    it("is all-or-nothing: one unresolved conflict blocks the clean changes too", async () => {
      const clean = await newValve({ name: "Clean base" });
      const clash = await newValve({ name: "Clash base" });
      await editOn(clean, "atomic", { name: "Clean edit" });
      await editOn(clash, "atomic", { name: "Clash mine" });
      await admin().gis.nodes.update({ id: clash.id, baseVersionId: clash.versionId, patch: { name: "Clash theirs" } });

      const result = await postBranch("atomic");
      assert.ok(result.status === "conflicts");
      assert.equal(result.conflicts.length, 1);
      assert.equal((await admin().gis.nodes.byId({ id: clean.id })).name, "Clean base", "the clean change did not slip through");
      assert.ok((await openBranchNames()).includes("atomic"));
    });
  });

  describe("creation and deletion", () => {
    it("creates an entity on main that only existed on the branch", async () => {
      const created = await newValve({ name: "Born on a branch", branch: "born" });
      assert.ok(!(await admin().gis.nodes.list()).some((n) => n.id === created.id));
      await expectCode(admin().gis.nodes.byId({ id: created.id }), "NOT_FOUND");

      const preview = await admin().gis.reconcile.preview({ branch: "born" });
      assert.equal(preview.entities[0]?.detail, "create");
      const result = await admin().gis.reconcile.post({ branch: "born", token: preview.token });
      assert.ok(result.status === "posted");
      assert.equal(result.summary.created, 1);

      const onMain = await admin().gis.nodes.byId({ id: created.id });
      assert.equal(onMain.name, "Born on a branch");
      assert.equal(onMain.branch, "main");
      const [identity] = await env.db.select().from(asset).where(eq(asset.id, created.id));
      assert.equal(identity?.kind, "node");
    });

    it("ignores something created and deleted without ever reaching main", async () => {
      const ghost = await newValve({ branch: "ghost" });
      await admin().gis.nodes.delete({ id: ghost.id, baseVersionId: ghost.versionId, branch: "ghost" });
      const result = await postBranch("ghost");
      assert.ok(result.status === "posted");
      assert.equal(result.summary.skipped, 1);
      await expectCode(admin().gis.nodes.byId({ id: ghost.id }), "NOT_FOUND");
    });

    it("deletes from main when the branch deleted something main hasn't touched", async () => {
      const node = await newValve();
      await admin().gis.nodes.delete({ id: node.id, baseVersionId: node.versionId, branch: "remove" });
      const result = await postBranch("remove");
      assert.ok(result.status === "posted");
      assert.equal(result.summary.deleted, 1);
      assert.ok(!(await admin().gis.nodes.list()).some((n) => n.id === node.id));
      const history = await admin().gis.nodes.history({ id: node.id });
      assert.ok(
        history.some((h) => h.branch === "main" && h.isDeleted && h.isHead),
        "deletion is a tombstone on main",
      );
    });

    it("asks before deleting something main edited, and respects either answer", async () => {
      const kept = await newValve({ name: "Edited on main" });
      const removed = await newValve({ name: "Edited on main too" });
      await admin().gis.nodes.delete({ id: kept.id, baseVersionId: kept.versionId, branch: "delete-vs-edit" });
      await admin().gis.nodes.delete({ id: removed.id, baseVersionId: removed.versionId, branch: "delete-vs-edit" });
      await admin().gis.nodes.update({ id: kept.id, baseVersionId: kept.versionId, patch: { name: "Still wanted" } });
      await admin().gis.nodes.update({ id: removed.id, baseVersionId: removed.versionId, patch: { name: "Edited anyway" } });

      const preview = await admin().gis.reconcile.preview({ branch: "delete-vs-edit" });
      assert.equal(preview.summary.conflicts, 2);
      assert.ok(preview.entities.every((e) => e.conflicts[0]?.field === "__existence__"));

      const result = await admin().gis.reconcile.post({
        branch: "delete-vs-edit",
        token: preview.token,
        resolutions: { [kept.id]: { __existence__: "main" }, [removed.id]: { __existence__: "branch" } },
      });
      assert.ok(result.status === "posted");
      assert.equal((await admin().gis.nodes.byId({ id: kept.id })).name, "Still wanted");
      await expectCode(admin().gis.nodes.byId({ id: removed.id }), "NOT_FOUND");
    });
  });

  describe("safety", () => {
    it("refuses to approve a branch that changed after it was reviewed", async () => {
      const a = await newValve();
      const b = await newValve();
      await editOn(a, "moving", { name: "First change" });
      const preview = await admin().gis.reconcile.preview({ branch: "moving" });
      await editOn(b, "moving", { name: "Sneaked in after review" });

      await expectCode(admin().gis.reconcile.post({ branch: "moving", token: preview.token }), "CONFLICT");
      assert.equal((await admin().gis.nodes.byId({ id: a.id })).name, a.name, "nothing was posted");
    });

    it("lets exactly one of two simultaneous posts of the same branch succeed", async () => {
      const node = await newValve({ name: "Race base" });
      await editOn(node, "double", { name: "Posted once" });
      const preview = await admin().gis.reconcile.preview({ branch: "double" });

      const results = await Promise.allSettled([
        admin().gis.reconcile.post({ branch: "double", token: preview.token }),
        admin().gis.reconcile.post({ branch: "double", token: preview.token }),
      ]);
      const posted = results.filter((r) => r.status === "fulfilled" && r.value.status === "posted");
      assert.equal(posted.length, 1);
      const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      assert.ok(failed?.reason instanceof TRPCError && ["CONFLICT", "NOT_FOUND"].includes(failed.reason.code));

      const history = await admin().gis.nodes.history({ id: node.id });
      assert.equal(history.filter((h) => h.branch === "main").length, 2, "main gained exactly one version");
    });

    it("refuses to overwrite a main edit that commits while a reconcile is in flight", async () => {
      const node = await newValve({ name: "Mid-flight base" });
      await editOn(node, "midflight", { name: "Branch edit" });
      const preview = await admin().gis.reconcile.preview({ branch: "midflight" });

      // Another session takes main's head row and holds it uncommitted...
      const other = createDatabase(env.t.adminUrl, { max: 1 });
      let commitIssued = false;
      let settledBeforeCommit = false;
      let release!: () => void;
      let locked!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const lockTaken = new Promise<void>((resolve) => (locked = resolve));
      const holding = other.db.transaction(async (tx) => {
        await tx.execute(sql`update gis.node set is_head = false where version_id = ${node.versionId}`);
        locked();
        await held;
      });
      try {
        await lockTaken;

        // ...so the reconcile reads main as it was, then blocks trying to supersede it.
        // The handler is attached immediately: if the promise rejected unobserved, even
        // briefly, the runner would count it as a failure regardless of what the test asserts.
        const posting = admin()
          .gis.reconcile.post({ branch: "midflight", token: preview.token })
          .then(
            (value) => {
              settledBeforeCommit ||= !commitIssued;
              return { ok: true as const, value };
            },
            (error: unknown) => {
              settledBeforeCommit ||= !commitIssued;
              return { ok: false as const, error };
            },
          );

        await new Promise((resolve) => setTimeout(resolve, 400));
        commitIssued = true;
        release();
        await holding;

        const outcome = await posting;
        assert.ok(!settledBeforeCommit, "the reconcile should have been waiting on the row lock, not failed early");
        assert.ok(!outcome.ok, "the reconcile must not succeed over a concurrent main edit");
        assert.ok(outcome.error instanceof TRPCError && outcome.error.code === "CONFLICT", String(outcome.error));
      } finally {
        release();
        await other.close();
      }
      assert.ok((await openBranchNames()).includes("midflight"), "the failed reconcile rolled back, leaving the branch open");
    });

    it("rejects reconciling main onto itself", async () => {
      await expectCode(admin().gis.reconcile.preview({ branch: "main" }), "BAD_REQUEST");
    });

    it("reports an empty or unknown branch as not found", async () => {
      await expectCode(admin().gis.reconcile.preview({ branch: "never-existed" }), "NOT_FOUND");
    });
  });

  describe("discarding", () => {
    it("abandons a branch without touching main", async () => {
      const node = await newValve({ name: "Discard base" });
      await editOn(node, "abandon", { name: "Never mind" });
      assert.deepEqual(await admin().gis.reconcile.discard({ branch: "abandon" }), { discarded: 1 });

      assert.equal((await admin().gis.nodes.byId({ id: node.id })).name, "Discard base");
      assert.equal((await admin().gis.nodes.byId({ id: node.id, branch: "abandon" })).name, "Discard base", "the overlay falls through to main");
      assert.ok(!(await openBranchNames()).includes("abandon"));
      await expectCode(admin().gis.reconcile.discard({ branch: "abandon" }), "NOT_FOUND");

      const history = await admin().gis.nodes.history({ id: node.id });
      assert.ok(
        history.some((h) => h.branch === "abandon"),
        "the abandoned work is still in the audit trail",
      );
    });
  });

  describe("listing and access", () => {
    it("lists open branches with who edited them, and never another organization's", async () => {
      const node = await newValve();
      await editOn(node, "listed", { name: "Listed edit" });
      await tech().gis.nodes.update({
        id: node.id,
        baseVersionId: (await admin().gis.nodes.byId({ id: node.id, branch: "listed" })).versionId,
        branch: "listed",
        patch: { condition: "fair" },
      });

      const listed = (await admin().gis.reconcile.branches()).find((b) => b.branch === "listed");
      assert.ok(listed);
      assert.equal(listed.changes, 1, "one entity changed, however many versions it took");
      assert.deepEqual([...listed.authorIds].sort(), [env.users.admin, env.users.tech].sort());
      assert.ok(listed.firstEditAt && listed.lastEditAt);

      const outsider = env.outsider();
      assert.ok(!(await outsider.gis.reconcile.branches()).some((b) => b.branch === "listed"));
      await expectCode(outsider.gis.reconcile.preview({ branch: "listed" }), "NOT_FOUND");
      await expectCode(outsider.gis.reconcile.discard({ branch: "listed" }), "NOT_FOUND");
    });

    it("doesn't let a reused branch name inherit the authors of an earlier, already-posted round", async () => {
      const node = await newValve({ name: "Reuse base" });
      await editOn(node, "reused", { name: "Round one (admin)" });
      await postBranch("reused");

      const current = await admin().gis.nodes.byId({ id: node.id });
      await tech().gis.nodes.update({ id: node.id, baseVersionId: current.versionId, branch: "reused", patch: { condition: "fair" } });

      const listed = (await admin().gis.reconcile.branches()).find((b) => b.branch === "reused");
      assert.ok(listed);
      assert.deepEqual(listed.authorIds, [env.users.tech], "only this round's author");
      assert.equal(listed.changes, 1);
    });

    it("lets anyone who reads GIS review a branch, but only gis:post merges or discards it", async () => {
      const node = await newValve();
      await editOn(node, "gated", { name: "Gated edit" });
      const preview = await tech().gis.reconcile.preview({ branch: "gated" });
      await expectCode(tech().gis.reconcile.post({ branch: "gated", token: preview.token }), "FORBIDDEN");
      await expectCode(tech().gis.reconcile.discard({ branch: "gated" }), "FORBIDDEN");
      // Flowless: reviewing is reading (gis:read), so a supervisor approving a job can see its changes.
      assert.equal((await env.viewer().gis.reconcile.preview({ branch: "gated" })).token, preview.token);
      await expectCode(env.viewer().gis.reconcile.post({ branch: "gated", token: preview.token }), "FORBIDDEN");
      await expectCode(env.senior().gis.reconcile.post({ branch: "gated", token: preview.token }), "FORBIDDEN");
      assert.equal((await env.engineer().gis.reconcile.post({ branch: "gated", token: preview.token })).status, "posted");
    });
  });
});

