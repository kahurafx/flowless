import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, it } from "vitest";
import { asset } from "@flowless/db/schema/gis";
import { personalBranch } from "@flowless/shared-types";
import { eq } from "drizzle-orm";
import { expectCode, setupTestEnv, type TestEnv } from "./test-support";

describe("gis.structures", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setupTestEnv();
  });
  afterAll(async () => {
    await env.close();
  });

  const admin = () => env.admin();
  const tech = () => env.tech();

  type CreateInput = Parameters<ReturnType<TestEnv["admin"]>["gis"]["structures"]["create"]>[0];
  const newStructure = (overrides: Partial<CreateInput> = {}) =>
    admin().gis.structures.create({
      type: "vault",
      name: `Vault ${Math.random().toString(36).slice(2, 7)}`,
      location: { lat: -1.29, lng: 36.78 },
      condition: "good",
      ...overrides,
    });

  type NodeCreateInput = Parameters<ReturnType<TestEnv["admin"]>["gis"]["nodes"]["create"]>[0];
  const newValveIn = (structureId: string, overrides: Partial<NodeCreateInput> = {}) =>
    admin().gis.nodes.create({
      type: "valve",
      name: `Valve ${Math.random().toString(36).slice(2, 7)}`,
      location: { lat: -1.29, lng: 36.78 },
      isOpen: true,
      structureId,
      ...overrides,
    });

  const conditionEvents = (assetId: string) =>
    env.events("gis.condition_changed", "assetId", assetId);

  describe("access control", () => {
    it("rejects callers who aren't signed in", async () => {
      await expectCode(env.anonymous().gis.structures.list(), "UNAUTHORIZED");
    });

    it("lets a viewer read but not write", async () => {
      await env.viewer().gis.structures.list();
      await expectCode(env.viewer().gis.structures.create({ type: "vault", name: "Nope", location: { lat: 0, lng: 0 } }), "FORBIDDEN");
    });

    it("lets a technician create and edit on their own branch but not delete, and not on main (gap fix)", async () => {
      const branch = personalBranch(env.users.tech);
      await expectCode(tech().gis.structures.create({ type: "chamber", name: "On main", location: { lat: -1.29, lng: 36.78 } }), "FORBIDDEN");
      const created = await tech().gis.structures.create({
        branch,
        type: "chamber",
        name: "Tech's chamber",
        location: { lat: -1.29, lng: 36.78 },
      });
      await expectCode(tech().gis.structures.delete({ id: created.id, baseVersionId: created.versionId, branch }), "FORBIDDEN");
      const renamed = await tech().gis.structures.update({
        id: created.id,
        baseVersionId: created.versionId,
        branch,
        patch: { name: "Renamed by tech" },
      });
      assert.equal(renamed.name, "Renamed by tech");
    });
  });

  describe("creating and reading", () => {
    it("round-trips geometry and dates in the shape the frontends already use", async () => {
      const created = await newStructure({ installedAt: new Date("2023-05-01T08:30:00.000Z"), name: "Roundtrip vault" });
      assert.deepEqual(created.location, { lat: -1.29, lng: 36.78 });
      assert.deepEqual(created.installedAt, new Date("2023-05-01T08:30:00.000Z"));
      assert.equal(created.lastInspectedAt, null);
      assert.equal(created.branch, "main");

      assert.deepEqual(await admin().gis.structures.byId({ id: created.id }), created);
      assert.ok((await admin().gis.structures.list()).some((s) => s.id === created.id));
    });

    it("filters the list by type", async () => {
      const kiosk = await newStructure({ type: "kiosk" });
      const vault = await newStructure({ type: "vault" });
      const kiosks = await admin().gis.structures.list({ types: ["kiosk"] });
      assert.ok(kiosks.some((s) => s.id === kiosk.id));
      assert.ok(!kiosks.some((s) => s.id === vault.id));
    });

    it("treats a retried create with the same id as a no-op, not a duplicate", async () => {
      const clientId = env.id();
      const first = await newStructure({ id: clientId });
      const retry = await newStructure({ id: clientId });
      assert.equal(retry.versionId, first.versionId);
      assert.equal((await admin().gis.structures.history({ id: clientId })).length, 1);
    });

    it("rejects an empty name and an impossible location", async () => {
      await expectCode(newStructure({ name: "   " }), "BAD_REQUEST");
      await expectCode(newStructure({ location: { lat: 123, lng: 0 } }), "BAD_REQUEST");
    });
  });

  describe("versioned edits", () => {
    it("supersedes the old version and records history, on one asset identity", async () => {
      const v1 = await newStructure({ name: "Original vault" });
      const v2 = await admin().gis.structures.update({
        id: v1.id,
        baseVersionId: v1.versionId,
        patch: { name: "Edited vault" },
      });
      assert.notEqual(v2.versionId, v1.versionId);

      const history = await admin().gis.structures.history({ id: v1.id });
      assert.deepEqual(
        history.map((h) => [h.name, h.isHead]),
        [
          ["Edited vault", true],
          ["Original vault", false],
        ],
      );
      assert.equal(history[0]?.supersedesVersionId, v1.versionId);

      const [identity] = await env.db.select().from(asset).where(eq(asset.id, v1.id));
      assert.equal(identity?.kind, "structure");
    });

    it("rejects an edit based on a stale version", async () => {
      const v1 = await newStructure();
      await admin().gis.structures.update({ id: v1.id, baseVersionId: v1.versionId, patch: { name: "First" } });
      await expectCode(admin().gis.structures.update({ id: v1.id, baseVersionId: v1.versionId, patch: { name: "Stale" } }), "CONFLICT");
    });

    it("doesn't let a structure's type change", async () => {
      const vault = await newStructure({ type: "vault" });
      const renamed = await admin().gis.structures.update({
        id: vault.id,
        baseVersionId: vault.versionId,
        patch: { name: "Still a vault", type: "kiosk" } as never,
      });
      assert.equal(renamed.type, "vault", "a stray type in the patch is ignored");
      await expectCode(
        admin().gis.structures.update({
          id: vault.id,
          baseVersionId: renamed.versionId,
          patch: { type: "kiosk" } as never,
        }),
        "BAD_REQUEST",
      );
    });

    it("emits a condition event when condition changes on main, and only then", async () => {
      const v1 = await newStructure({ condition: "good" });
      const v2 = await admin().gis.structures.update({
        id: v1.id,
        baseVersionId: v1.versionId,
        patch: { name: "Just a rename" },
      });
      assert.equal((await conditionEvents(v1.id)).length, 0);

      await admin().gis.structures.update({ id: v1.id, baseVersionId: v2.versionId, patch: { condition: "poor" } });
      const events = await conditionEvents(v1.id);
      assert.equal(events.length, 1);
      assert.deepEqual(events[0]?.payload, {
        assetId: v1.id,
        from: "good",
        to: "poor",
        changedByUserId: env.users.admin,
      });
    });

    it("hides a deleted structure and refuses further edits", async () => {
      const s = await newStructure();
      await admin().gis.structures.delete({ id: s.id, baseVersionId: s.versionId });
      assert.ok(!(await admin().gis.structures.list()).some((x) => x.id === s.id));
      await expectCode(admin().gis.structures.byId({ id: s.id }), "NOT_FOUND");
      const history = await admin().gis.structures.history({ id: s.id });
      assert.equal(history.length, 2, "deleting adds a tombstone version, it doesn't erase history");
      await expectCode(admin().gis.structures.update({ id: s.id, baseVersionId: history[0]!.versionId, patch: { name: "Zombie" } }), "NOT_FOUND");
    });
  });

  describe("branches", () => {
    it("keeps a branch edit off main, and off the shared registry and event stream", async () => {
      const onMain = await newStructure({ name: "On main", condition: "good" });
      const onBranch = await admin().gis.structures.update({
        id: onMain.id,
        baseVersionId: onMain.versionId,
        branch: "survey",
        patch: { name: "Edited on branch", condition: "critical" },
      });
      assert.equal(onBranch.branch, "survey");

      assert.equal((await admin().gis.structures.byId({ id: onMain.id })).name, "On main");
      assert.equal((await admin().gis.structures.byId({ id: onMain.id, branch: "survey" })).name, "Edited on branch");

      assert.equal((await conditionEvents(onMain.id)).length, 0);
    });

    it("shows the branch's own version over main's in the list, once", async () => {
      const a = await newStructure({ name: "Overlay A" });
      const b = await newStructure({ name: "Overlay B" });
      await admin().gis.structures.update({
        id: a.id,
        baseVersionId: a.versionId,
        branch: "overlay-s",
        patch: { name: "A (branch)" },
      });
      // main moves on after the branch edit, so main's head is the more recently written row
      await admin().gis.structures.update({ id: a.id, baseVersionId: a.versionId, patch: { condition: "fair" } });

      const view = await admin().gis.structures.list({ branch: "overlay-s" });
      assert.equal(view.filter((s) => s.id === a.id).length, 1);
      assert.equal(view.find((s) => s.id === a.id)?.name, "A (branch)");
      assert.equal(view.find((s) => s.id === b.id)?.name, "Overlay B");
    });

    it("lets a branch hide a structure without deleting it from main", async () => {
      const s = await newStructure();
      await admin().gis.structures.delete({ id: s.id, baseVersionId: s.versionId, branch: "hide-s" });
      assert.ok(!(await admin().gis.structures.list({ branch: "hide-s" })).some((x) => x.id === s.id));
      assert.ok((await admin().gis.structures.list()).some((x) => x.id === s.id));
    });
  });

  describe("concurrency", () => {
    it("lets exactly one of two racing edits win", async () => {
      const s = await newStructure();
      const results = await Promise.allSettled([
        admin().gis.structures.update({ id: s.id, baseVersionId: s.versionId, patch: { name: "Racer 1" } }),
        env.engineer().gis.structures.update({ id: s.id, baseVersionId: s.versionId, patch: { name: "Racer 2" } }),
      ]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      const lost = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      assert.equal((lost?.reason as { code?: string } | undefined)?.code, "CONFLICT");

      const history = await admin().gis.structures.history({ id: s.id });
      assert.equal(history.filter((h) => h.isHead && h.branch === "main").length, 1, "exactly one head survives");
    });
  });

  describe("deleting a structure that houses assets", () => {
    it("is refused while a node is housed in it, and allowed once that's gone", async () => {
      const vault = await newStructure({ name: "Occupied vault" });
      const valve = await newValveIn(vault.id);

      await expectCode(admin().gis.structures.delete({ id: vault.id, baseVersionId: vault.versionId }), "CONFLICT");
      assert.equal((await admin().gis.structures.byId({ id: vault.id })).id, vault.id, "still there");

      await admin().gis.nodes.delete({ id: valve.id, baseVersionId: valve.versionId });
      await admin().gis.structures.delete({ id: vault.id, baseVersionId: vault.versionId });
      await expectCode(admin().gis.structures.byId({ id: vault.id }), "NOT_FOUND");
    });

    it("judges by what the caller's branch sees, not by main alone", async () => {
      const vault = await newStructure({ name: "Tidy-up vault" });
      const valve = await newValveIn(vault.id);

      // On a branch the valve has been removed, so the vault can go there...
      await admin().gis.nodes.delete({ id: valve.id, baseVersionId: valve.versionId, branch: "tidy" });
      await admin().gis.structures.delete({ id: vault.id, baseVersionId: vault.versionId, branch: "tidy" });

      // ...but on main the valve is still housed in it.
      await expectCode(admin().gis.structures.delete({ id: vault.id, baseVersionId: vault.versionId }), "CONFLICT");
    });
  });

  describe("tenant isolation", () => {
    it("never shows another organization's structures", async () => {
      const mine = await newStructure();
      assert.ok(!(await env.outsider().gis.structures.list()).some((s) => s.id === mine.id));
      await expectCode(env.outsider().gis.structures.byId({ id: mine.id }), "NOT_FOUND");
      await expectCode(env.outsider().gis.structures.history({ id: mine.id }), "NOT_FOUND");
    });

    it("won't let another organization edit, delete or claim a structure's id", async () => {
      const mine = await newStructure();
      const outsider = env.outsider();
      await expectCode(outsider.gis.structures.update({ id: mine.id, baseVersionId: mine.versionId, patch: { name: "Hijacked" } }), "NOT_FOUND");
      await expectCode(outsider.gis.structures.delete({ id: mine.id, baseVersionId: mine.versionId }), "NOT_FOUND");
      await expectCode(outsider.gis.structures.create({ id: mine.id, type: "vault", name: "Squatter", location: { lat: 0, lng: 0 } }), "CONFLICT");
      assert.equal((await admin().gis.structures.byId({ id: mine.id })).name, mine.name);
    });
  });
});
