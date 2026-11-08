import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, it } from "vitest";
import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { asset, node } from "@flowless/db/schema/gis";
import { personalBranch } from "@flowless/shared-types";
import { expectCode, setupTestEnv, type TestEnv } from "./test-support";

// Ported from Majimap's gis/test/nodes.test.ts. Flowless differences: tenancy by RLS (an
// unlicensed organization is NOT_FOUND), ids are uuids, dates are Dates, the shared asset
// registry is gone (gis.asset is identity only), and writing to main needs gis:post, so a
// technician edits on a branch.

describe("gis.nodes", () => {
  let env: TestEnv;
  let vaultA: string;
  let vaultB: string;

  const admin = () => env.admin();
  const tech = () => env.tech();
  const id = () => randomUUID();

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

  const conditionEvents = (assetId: string) => env.events("gis.condition_changed", "assetId", assetId);

  beforeAll(async () => {
    env = await setupTestEnv();
    vaultA = (await env.admin().gis.structures.create({ type: "vault", name: "Vault", location: { lat: -1.29, lng: 36.78 } })).id;
    vaultB = (await env.outsider().gis.structures.create({ type: "vault", name: "Vault", location: { lat: -1.29, lng: 36.78 } })).id;
  });

  afterAll(() => env?.close());

  describe("access control", () => {
    it("rejects callers who aren't signed in", async () => {
      await expectCode(env.anonymous().gis.nodes.list(), "UNAUTHORIZED");
    });

    it("rejects callers with no active organization", async () => {
      const { createCaller } = await import("../../../root");
      const { sessionOf } = await import("../../../test-support");
      await expectCode(createCaller({ db: env.t.app, session: sessionOf(env.members.admin, null) }).gis.nodes.list(), "FORBIDDEN");
    });

    it("answers NOT_FOUND to organizations not licensed for GIS (K-04)", async () => {
      await expectCode(env.bare().gis.nodes.list(), "NOT_FOUND");
    });

    it("rejects members who hold no GIS permission", async () => {
      const { addMember } = await import("../../../test-support");
      await expectCode(env.as(await addMember(env.t, env.orgA, "member")).gis.nodes.list(), "FORBIDDEN");
    });

    it("lets a viewer read but not write", async () => {
      const viewer = env.viewer();
      await viewer.gis.nodes.list();
      await expectCode(viewer.gis.nodes.create({ type: "junction", name: "Nope", location: { lat: 0, lng: 0 } }), "FORBIDDEN");
    });

    it("lets a technician edit on their own branch but not delete, and not change main (gap fix)", async () => {
      const node = await newValve();
      await expectCode(tech().gis.nodes.delete({ id: node.id, baseVersionId: node.versionId }), "FORBIDDEN");
      await expectCode(tech().gis.nodes.update({ id: node.id, baseVersionId: node.versionId, patch: { name: "Renamed by tech" } }), "FORBIDDEN");
      const branch = personalBranch(env.users.tech);
      const updated = await tech().gis.nodes.update({ id: node.id, baseVersionId: node.versionId, branch, patch: { name: "Renamed by tech" } });
      assert.equal(updated.name, "Renamed by tech");
      assert.equal((await admin().gis.nodes.byId({ id: node.id })).name, node.name, "main is untouched");
    });
  });

  describe("creating and reading", () => {
    it("round-trips geometry and dates, and matches the shape the frontends already use", async () => {
      const node = await newValve({ installedAt: new Date("2024-01-15T10:00:00.000Z") });
      assert.deepEqual(node.location, { lat: -1.288, lng: 36.782 });
      assert.deepEqual(node.installedAt, new Date("2024-01-15T10:00:00.000Z"));
      assert.equal(node.lastInspectedAt, null);
      assert.equal(node.branch, "main");

      const fetched = await admin().gis.nodes.byId({ id: node.id });
      assert.deepEqual(fetched, node);
      assert.ok((await admin().gis.nodes.list()).some((n) => n.id === node.id));
    });

    it("only lets valves carry an open/closed state", async () => {
      await expectCode(newValve({ type: "hydrant", isOpen: true }), "BAD_REQUEST");
      const hydrant = await newValve({ type: "hydrant", isOpen: null });
      await expectCode(admin().gis.nodes.update({ id: hydrant.id, baseVersionId: hydrant.versionId, patch: { isOpen: false } }), "BAD_REQUEST");
    });

    it("treats a retried create with the same id as a no-op, not a duplicate", async () => {
      const clientId = id();
      const first = await newValve({ id: clientId });
      const retry = await newValve({ id: clientId });
      assert.equal(retry.versionId, first.versionId);
      const history = await admin().gis.nodes.history({ id: clientId });
      assert.equal(history.length, 1);
    });
  });

  describe("versioned edits on main", () => {
    it("supersedes the old version instead of overwriting it", async () => {
      const v1 = await newValve({ name: "Original" });
      const v2 = await admin().gis.nodes.update({ id: v1.id, baseVersionId: v1.versionId, patch: { name: "Edited" } });
      assert.notEqual(v2.versionId, v1.versionId);

      const history = await admin().gis.nodes.history({ id: v1.id });
      assert.equal(history.length, 2);
      assert.deepEqual(
        history.map((h) => [h.name, h.isHead]),
        [
          ["Edited", true],
          ["Original", false],
        ],
      );
      assert.equal(history[0]?.supersedesVersionId, v1.versionId);

      const [identity] = await env.db.select().from(asset).where(eq(asset.id, v1.id));
      assert.equal(identity?.kind, "node", "one identity behind every version");
    });

    it("rejects an edit based on a stale version", async () => {
      const v1 = await newValve();
      await admin().gis.nodes.update({ id: v1.id, baseVersionId: v1.versionId, patch: { name: "First" } });
      await expectCode(admin().gis.nodes.update({ id: v1.id, baseVersionId: v1.versionId, patch: { name: "Second, stale" } }), "CONFLICT");
    });

    it("emits a domain event when condition changes on main, and only then", async () => {
      const v1 = await newValve({ condition: "good" });
      const v2 = await admin().gis.nodes.update({ id: v1.id, baseVersionId: v1.versionId, patch: { name: "Just a rename" } });
      assert.equal((await conditionEvents(v1.id)).length, 0);

      const v3 = await admin().gis.nodes.update({ id: v1.id, baseVersionId: v2.versionId, patch: { condition: "critical" } });
      const events = await conditionEvents(v1.id);
      assert.equal(events.length, 1);
      assert.deepEqual(events[0]?.payload, { assetId: v1.id, from: "good", to: "critical", changedByUserId: env.users.admin });

      await admin().gis.nodes.update({ id: v1.id, baseVersionId: v3.versionId, patch: { condition: "critical", name: "Same condition again" } });
      assert.equal((await conditionEvents(v1.id)).length, 1, "no change in condition, no event");
    });

    it("hides a deleted node and refuses further edits", async () => {
      const node = await newValve();
      await admin().gis.nodes.delete({ id: node.id, baseVersionId: node.versionId });
      assert.ok(!(await admin().gis.nodes.list()).some((n) => n.id === node.id));
      await expectCode(admin().gis.nodes.byId({ id: node.id }), "NOT_FOUND");
      const history = await admin().gis.nodes.history({ id: node.id });
      assert.equal(history.length, 2, "deleting adds a tombstone version, it doesn't erase history");
      await expectCode(admin().gis.nodes.update({ id: node.id, baseVersionId: history[0]!.versionId, patch: { name: "Zombie" } }), "NOT_FOUND");
    });
  });

  describe("branches", () => {
    it("keeps a branch edit off main until it's reconciled", async () => {
      const onMain = await newValve({ name: "On main", condition: "good" });
      const onBranch = await admin().gis.nodes.update({
        id: onMain.id,
        baseVersionId: onMain.versionId,
        branch: "visit",
        patch: { name: "Edited on branch", condition: "poor" },
      });
      assert.equal(onBranch.branch, "visit");

      const mainView = await admin().gis.nodes.byId({ id: onMain.id });
      assert.equal(mainView.name, "On main");
      assert.equal(mainView.versionId, onMain.versionId);

      const branchView = await admin().gis.nodes.byId({ id: onMain.id, branch: "visit" });
      assert.equal(branchView.name, "Edited on branch");

      const [mainHead] = await env.db.select().from(node).where(eq(node.versionId, onMain.versionId));
      assert.equal(mainHead?.isHead, true, "main's head row is untouched by the branch edit");

      assert.equal((await conditionEvents(onMain.id)).length, 0, "an unreconciled edit isn't a fact other modules should react to");
    });

    it("shows main's entities through the branch overlay, with the branch's own on top", async () => {
      const a = await newValve({ name: "Overlay A" });
      const b = await newValve({ name: "Overlay B" });
      await admin().gis.nodes.update({ id: a.id, baseVersionId: a.versionId, branch: "overlay", patch: { name: "A (branch)" } });

      const view = await admin().gis.nodes.list({ branch: "overlay" });
      assert.equal(view.find((n) => n.id === a.id)?.name, "A (branch)");
      assert.equal(view.find((n) => n.id === b.id)?.name, "Overlay B", "untouched entities fall through to main");
      assert.equal(view.filter((n) => n.id === a.id).length, 1, "no duplicate for an edited entity");
    });

    it("prefers the branch's version no matter which row was written last", async () => {
      const v1 = await newValve({ name: "Order base" });
      await admin().gis.nodes.update({ id: v1.id, baseVersionId: v1.versionId, branch: "overlay-order", patch: { name: "Order (branch)" } });
      // main moves on AFTER the branch edit, so main's head is the more recently written row —
      // an implementation that merely takes "the last row" would show main's version here
      await admin().gis.nodes.update({ id: v1.id, baseVersionId: v1.versionId, patch: { condition: "fair" } });

      const view = await admin().gis.nodes.list({ branch: "overlay-order" });
      assert.equal(view.find((n) => n.id === v1.id)?.name, "Order (branch)");
      assert.equal((await admin().gis.nodes.byId({ id: v1.id, branch: "overlay-order" })).name, "Order (branch)");
    });

    it("builds a branch's first edit from the version the client edited, not main's newer one", async () => {
      const v1 = await newValve({ name: "Base", condition: "good" });
      // main moves on while the (offline) client is still looking at v1
      await admin().gis.nodes.update({ id: v1.id, baseVersionId: v1.versionId, patch: { condition: "fair" } });
      const branchRow = await admin().gis.nodes.update({
        id: v1.id,
        baseVersionId: v1.versionId,
        branch: "stale-client",
        patch: { name: "Client's change" },
      });
      assert.equal(branchRow.name, "Client's change");
      assert.equal(branchRow.condition, "good", "branch = base + only the client's own change");
      const history = await admin().gis.nodes.history({ id: v1.id });
      assert.equal(history.find((h) => h.branch === "stale-client")?.supersedesVersionId, v1.versionId);
    });

    it("treats a second edit on the same branch as stale if it isn't based on the branch's head", async () => {
      const v1 = await newValve();
      const b1 = await admin().gis.nodes.update({ id: v1.id, baseVersionId: v1.versionId, branch: "twice", patch: { name: "One" } });
      await expectCode(admin().gis.nodes.update({ id: v1.id, baseVersionId: v1.versionId, branch: "twice", patch: { name: "Two, stale" } }), "CONFLICT");
      const b2 = await admin().gis.nodes.update({ id: v1.id, baseVersionId: b1.versionId, branch: "twice", patch: { name: "Two" } });
      assert.equal(b2.name, "Two");
    });

    it("lets a branch hide a node without deleting it from main", async () => {
      const node = await newValve();
      await admin().gis.nodes.delete({ id: node.id, baseVersionId: node.versionId, branch: "cleanup" });
      assert.ok(!(await admin().gis.nodes.list({ branch: "cleanup" })).some((n) => n.id === node.id));
      assert.ok((await admin().gis.nodes.list()).some((n) => n.id === node.id));
    });

    it("refuses a first branch edit based on a version from another branch", async () => {
      const v1 = await newValve();
      const onA = await admin().gis.nodes.update({ id: v1.id, baseVersionId: v1.versionId, branch: "base-a", patch: { name: "A" } });
      await expectCode(admin().gis.nodes.update({ id: v1.id, baseVersionId: onA.versionId, branch: "base-b", patch: { name: "B" } }), "NOT_FOUND");
    });
  });

  describe("concurrency", () => {
    it("lets edits to different nodes proceed in parallel", async () => {
      const [a, b, c, d] = await Promise.all([newValve(), newValve(), newValve(), newValve()]);
      const results = await Promise.all(
        [a, b, c, d].map((n) => admin().gis.nodes.update({ id: n.id, baseVersionId: n.versionId, patch: { name: `Parallel ${n.id}` } })),
      );
      assert.equal(results.length, 4);
    });

    it("lets exactly one of two racing edits to the same node win", async () => {
      const node = await newValve();
      const results = await Promise.allSettled([
        admin().gis.nodes.update({ id: node.id, baseVersionId: node.versionId, patch: { name: "Racer 1" } }),
        env.engineer().gis.nodes.update({ id: node.id, baseVersionId: node.versionId, patch: { name: "Racer 2" } }),
      ]);
      const won = results.filter((r) => r.status === "fulfilled");
      const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      assert.equal(won.length, 1);
      assert.equal(lost.length, 1);
      assert.ok(lost[0]!.reason instanceof TRPCError && lost[0]!.reason.code === "CONFLICT");

      const history = await admin().gis.nodes.history({ id: node.id });
      assert.equal(history.filter((h) => h.isHead && h.branch === "main").length, 1, "exactly one head survives");
    });

    it("lets exactly one of two racing first-edits on a branch win", async () => {
      const node = await newValve();
      const results = await Promise.allSettled([
        admin().gis.nodes.update({ id: node.id, baseVersionId: node.versionId, branch: "race", patch: { name: "R1" } }),
        env.engineer().gis.nodes.update({ id: node.id, baseVersionId: node.versionId, branch: "race", patch: { name: "R2" } }),
      ]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      const lost = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      assert.ok(lost?.reason instanceof TRPCError && lost.reason.code === "CONFLICT");
    });
  });

  describe("structures", () => {
    it("accepts an allowed pairing and rejects a disallowed one", async () => {
      const housed = await newValve({ structureId: vaultA });
      assert.equal(housed.structureId, vaultA);
      await expectCode(newValve({ type: "hydrant", isOpen: null, structureId: vaultA }), "BAD_REQUEST");
    });

    it("refuses a structure that belongs to another organization", async () => {
      await expectCode(newValve({ structureId: vaultB }), "BAD_REQUEST");
    });

    it("is backed by a database trigger that holds even if the API is bypassed", async () => {
      const hydrantId = id();
      await env.db.insert(asset).values({ id: hydrantId, organizationId: env.orgA, kind: "node", createdByUserId: env.users.admin });
      await assert.rejects(
        env.db.insert(node).values({
          id: hydrantId,
          organizationId: env.orgA,
          createdByUserId: env.users.admin,
          type: "hydrant",
          name: "H",
          location: { lat: 0, lng: 0 },
          structureId: vaultA,
        }),
        (err: unknown) => JSON.stringify(err, Object.getOwnPropertyNames(err)).includes("may not be housed"),
      );

      const valveId = id();
      await env.db.insert(asset).values({ id: valveId, organizationId: env.orgA, kind: "node", createdByUserId: env.users.admin });
      await assert.rejects(
        env.db.insert(node).values({
          id: valveId,
          organizationId: env.orgA,
          createdByUserId: env.users.admin,
          type: "valve",
          name: "V",
          location: { lat: 0, lng: 0 },
          structureId: vaultB,
        }),
        (err: unknown) => JSON.stringify(err, Object.getOwnPropertyNames(err)).includes("existing structure in this organization"),
      );
    });
  });

  describe("tenant isolation", () => {
    it("never shows one organization's nodes to another", async () => {
      const mine = await newValve();
      const outsider = env.outsider();
      assert.ok(!(await outsider.gis.nodes.list()).some((n) => n.id === mine.id));
      await expectCode(outsider.gis.nodes.byId({ id: mine.id }), "NOT_FOUND");
      await expectCode(outsider.gis.nodes.history({ id: mine.id }), "NOT_FOUND");
    });

    it("won't let another organization edit, delete or claim a node's id", async () => {
      const mine = await newValve();
      const outsider = env.outsider();
      await expectCode(outsider.gis.nodes.update({ id: mine.id, baseVersionId: mine.versionId, patch: { name: "Hijacked" } }), "NOT_FOUND");
      await expectCode(outsider.gis.nodes.delete({ id: mine.id, baseVersionId: mine.versionId }), "NOT_FOUND");
      await expectCode(outsider.gis.nodes.create({ id: mine.id, type: "junction", name: "Squatter", location: { lat: 0, lng: 0 } }), "CONFLICT");
      assert.equal((await admin().gis.nodes.byId({ id: mine.id })).name, mine.name);
    });
  });
});
