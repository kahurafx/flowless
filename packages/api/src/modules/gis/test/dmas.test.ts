import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, it } from "vitest";
import { personalBranch } from "@flowless/shared-types";
import { expectCode, setupTestEnv, type TestEnv } from "./test-support";

// Ported from Majimap's gis/test/dmas.test.ts. Flowless: a DMA is a kernel area (level
// "dma"), so `id` is the area's id and the name is the area's; GIS versions only the map
// data (boundary, colour, tier, inlet meter, boundary valves). Name edits became colour edits.

const P = (lat: number, lng: number) => ({ lat, lng });
/** A 0.01° square, left open: the server closes it. */
const RING = [P(-1.29, 36.78), P(-1.29, 36.79), P(-1.3, 36.79), P(-1.3, 36.78)];

describe("gis.dmas", () => {
  let env: TestEnv;
  let tierA: string;
  let tierB: string;

  beforeAll(async () => {
    env = await setupTestEnv();
    tierA = (await env.admin().gis.tiers.create({ name: "DMA tier", order: 1 })).id;
    tierB = (await env.outsider().gis.tiers.create({ name: "DMA tier", order: 1 })).id;
  });
  afterAll(async () => {
    await env.close();
  });

  const admin = () => env.admin();
  const tech = () => env.tech();
  const shortId = () => Math.random().toString(36).slice(2, 7);

  type NodeInput = Parameters<ReturnType<TestEnv["admin"]>["gis"]["nodes"]["create"]>[0];
  const newMeter = (overrides: Partial<NodeInput> = {}) =>
    admin().gis.nodes.create({ type: "meter", name: `Meter ${shortId()}`, location: P(-1.295, 36.785), ...overrides });
  const newValve = (overrides: Partial<NodeInput> = {}) =>
    admin().gis.nodes.create({ type: "valve", name: `Valve ${shortId()}`, location: P(-1.29, 36.785), isOpen: true, ...overrides });
  const newJunction = () => admin().gis.nodes.create({ type: "junction", name: `Junction ${shortId()}`, location: P(-1.29, 36.78) });

  type DmaInput = Parameters<ReturnType<TestEnv["admin"]>["gis"]["dmas"]["create"]>[0];
  /** Draws map data on a new kernel DMA area named `name`; creates its own inlet meter unless you pass one. */
  async function newDma({ name, ...overrides }: Partial<DmaInput> & { name?: string } = {}) {
    const inletMeterId = overrides.inletMeterId ?? (await newMeter()).id;
    const areaId = overrides.areaId ?? (await env.dmaArea(name ?? `DMA ${shortId()}`)).id;
    return admin().gis.dmas.create({
      areaId,
      color: "#3B82F6",
      tierId: tierA,
      inletMeterId,
      boundaryValveIds: [],
      ring: RING,
      ...overrides,
    });
  }

  describe("access control", () => {
    it("rejects callers who aren't signed in", async () => {
      await expectCode(env.anonymous().gis.dmas.list(), "UNAUTHORIZED");
    });

    it("lets a viewer read but not write", async () => {
      const meter = await newMeter();
      await env.viewer().gis.dmas.list();
      const area = await env.dmaArea();
      await expectCode(env.viewer().gis.dmas.create({ areaId: area.id, color: "#112233", tierId: tierA, inletMeterId: meter.id, ring: RING }), "FORBIDDEN");
    });

    it("lets a technician create and edit on their own branch but not delete, and not on main (gap fix)", async () => {
      const meter = await newMeter();
      const area = await env.dmaArea("Tech DMA");
      const branch = personalBranch(env.users.tech);
      await expectCode(tech().gis.dmas.create({ areaId: area.id, color: "#112233", tierId: tierA, inletMeterId: meter.id, ring: RING }), "FORBIDDEN");
      const dma = await tech().gis.dmas.create({ areaId: area.id, branch, color: "#112233", tierId: tierA, inletMeterId: meter.id, ring: RING });
      assert.equal(dma.name, "Tech DMA");
      await expectCode(tech().gis.dmas.delete({ id: dma.id, baseVersionId: dma.versionId, branch }), "FORBIDDEN");
      const recoloured = await tech().gis.dmas.update({ id: dma.id, baseVersionId: dma.versionId, branch, patch: { color: "#445566" } });
      assert.equal(recoloured.color, "#445566");
    });
  });

  describe("creating and reading", () => {
    it("round-trips in the shape the frontends already use, with the valves sorted and the ring closed", async () => {
      const v1 = await newValve();
      const v2 = await newValve();
      const dma = await newDma({ boundaryValveIds: [v2.id, v1.id] });

      assert.deepEqual(dma.boundaryValveIds, [v1.id, v2.id].sort());
      assert.equal(dma.ring.length, 5, "four corners, closed by the server");
      assert.deepEqual(dma.ring.slice(0, 4), RING);
      assert.deepEqual(dma.ring[0], dma.ring[4]);
      assert.equal(dma.branch, "main");

      assert.deepEqual(await admin().gis.dmas.byId({ id: dma.id }), dma);
      assert.ok((await admin().gis.dmas.list()).some((d) => d.id === dma.id));
    });

    it("collapses a repeated valve id instead of failing on it", async () => {
      const v = await newValve();
      const dma = await newDma({ boundaryValveIds: [v.id, v.id] });
      assert.deepEqual(dma.boundaryValveIds, [v.id]);
    });

    it("is the kernel's DMA: its id is the area's, and so is its name", async () => {
      const area = await env.dmaArea("Kernel DMA");
      const dma = await newDma({ areaId: area.id });
      assert.equal(dma.id, area.id);
      assert.equal(dma.name, "Kernel DMA");
      await admin().hierarchy.updateArea({ id: area.id, name: "Renamed in the hierarchy" });
      assert.equal((await admin().gis.dmas.byId({ id: dma.id })).name, "Renamed in the hierarchy");
    });

    it("only draws on a live area of level DMA in this organization", async () => {
      const scheme = await admin().hierarchy.createArea({ level: "scheme", code: `Z${shortId()}`, name: "Not a DMA" });
      await expectCode(newDma({ areaId: scheme.id }), "BAD_REQUEST");
      await expectCode(newDma({ areaId: env.id() }), "NOT_FOUND");
      const archived = await env.dmaArea();
      await admin().hierarchy.archiveArea({ id: archived.id });
      await expectCode(newDma({ areaId: archived.id }), "PRECONDITION_FAILED");
    });

    it("refuses a second drawing of an area that already has map data", async () => {
      const dma = await newDma();
      await expectCode(newDma({ areaId: dma.id, branch: "redraw" }), "CONFLICT");
    });

    it("treats a retried create with the same id as a no-op, not a duplicate", async () => {
      const meter = await newMeter();
      const valve = await newValve();
      const clientId = (await env.dmaArea()).id;
      const first = await newDma({ areaId: clientId, inletMeterId: meter.id, boundaryValveIds: [valve.id] });
      const retry = await newDma({ areaId: clientId, inletMeterId: meter.id, boundaryValveIds: [valve.id] });
      assert.equal(retry.versionId, first.versionId);
      assert.deepEqual(retry.boundaryValveIds, [valve.id]);
      assert.equal((await admin().gis.dmas.history({ id: clientId })).length, 1);
    });
  });

  describe("rejecting bad DMAs", () => {
    it("needs a tier that exists", async () => {
      await expectCode(newDma({ tierId: env.id() }), "BAD_REQUEST");
    });

    it("won't use another organization's tier", async () => {
      await expectCode(newDma({ tierId: tierB }), "BAD_REQUEST");
    });

    it("needs the inlet to be a meter", async () => {
      const junction = await newJunction();
      await expectCode(newDma({ inletMeterId: junction.id }), "BAD_REQUEST");
    });

    it("needs the inlet to exist", async () => {
      await expectCode(newDma({ inletMeterId: env.id() }), "BAD_REQUEST");
    });

    it("needs every boundary valve to be a valve", async () => {
      const junction = await newJunction();
      await expectCode(newDma({ boundaryValveIds: [junction.id] }), "BAD_REQUEST");
    });

    it("needs every boundary valve to exist", async () => {
      await expectCode(newDma({ boundaryValveIds: [env.id()] }), "BAD_REQUEST");
    });

    it("won't use another organization's valve", async () => {
      const theirs = await env.outsider().gis.nodes.create({ type: "valve", name: "Theirs", location: P(0, 0), isOpen: true });
      await expectCode(newDma({ boundaryValveIds: [theirs.id] }), "BAD_REQUEST");
    });

    it("needs a boundary that encloses some area", async () => {
      const line = [P(-1.29, 36.78), P(-1.3, 36.78), P(-1.31, 36.78)];
      await expectCode(newDma({ ring: line }), "BAD_REQUEST");
    });

    it("needs at least three corners", async () => {
      await expectCode(newDma({ ring: [P(-1.29, 36.78), P(-1.3, 36.78)] }), "BAD_REQUEST");
    });

    it("needs a real hex colour", async () => {
      await expectCode(newDma({ color: "blue" }), "BAD_REQUEST");
    });
  });

  describe("versioned edits and their valve sets", () => {
    it("gives each version its own valve set, and keeps the old one as history", async () => {
      const [a, b, c] = await Promise.all([newValve(), newValve(), newValve()]);
      const dma = await newDma({ boundaryValveIds: [a.id, b.id] });
      const edited = await admin().gis.dmas.update({
        id: dma.id,
        baseVersionId: dma.versionId,
        patch: { boundaryValveIds: [b.id, c.id] },
      });
      assert.deepEqual(edited.boundaryValveIds, [b.id, c.id].sort());

      const history = await admin().gis.dmas.history({ id: dma.id });
      assert.equal(history.length, 2);
      assert.deepEqual(history[0]?.boundaryValveIds, [b.id, c.id].sort());
      assert.deepEqual(history[1]?.boundaryValveIds, [a.id, b.id].sort(), "the old version still has the set it had");
      assert.equal(history[0]?.isHead, true);
      assert.equal(history[1]?.isHead, false);
    });

    it("carries the valves over when an edit doesn't mention them", async () => {
      const v = await newValve();
      const dma = await newDma({ boundaryValveIds: [v.id] });
      const renamed = await admin().gis.dmas.update({ id: dma.id, baseVersionId: dma.versionId, patch: { color: "#010101" } });
      assert.deepEqual(renamed.boundaryValveIds, [v.id]);
      assert.deepEqual((await admin().gis.dmas.byId({ id: dma.id })).boundaryValveIds, [v.id]);
    });

    it("can empty the valve set", async () => {
      const v = await newValve();
      const dma = await newDma({ boundaryValveIds: [v.id] });
      const cleared = await admin().gis.dmas.update({ id: dma.id, baseVersionId: dma.versionId, patch: { boundaryValveIds: [] } });
      assert.deepEqual(cleared.boundaryValveIds, []);
    });

    it("changes the map data on main as a new version", async () => {
      const dma = await newDma();
      const after = await admin().gis.dmas.update({ id: dma.id, baseVersionId: dma.versionId, patch: { color: "#ABCDEF" } });
      assert.equal(after.color, "#ABCDEF");
      assert.notEqual(after.versionId, dma.versionId);
    });

    it("rolls the whole edit back if it would point at something invalid", async () => {
      const dma = await newDma();
      const junction = await newJunction();
      await expectCode(admin().gis.dmas.update({ id: dma.id, baseVersionId: dma.versionId, patch: { inletMeterId: junction.id } }), "BAD_REQUEST");
      assert.equal((await admin().gis.dmas.byId({ id: dma.id })).versionId, dma.versionId, "still the original version");
      assert.equal((await admin().gis.dmas.history({ id: dma.id })).length, 1);
    });

    it("rejects an edit based on a stale version", async () => {
      const dma = await newDma();
      await admin().gis.dmas.update({ id: dma.id, baseVersionId: dma.versionId, patch: { color: "#000001" } });
      await expectCode(admin().gis.dmas.update({ id: dma.id, baseVersionId: dma.versionId, patch: { color: "#000002" } }), "CONFLICT");
    });

    it("hides a deleted DMA, whose tombstone has no valves, and refuses further edits", async () => {
      const v = await newValve();
      const dma = await newDma({ boundaryValveIds: [v.id] });
      await admin().gis.dmas.delete({ id: dma.id, baseVersionId: dma.versionId });
      assert.ok(!(await admin().gis.dmas.list()).some((d) => d.id === dma.id));
      await expectCode(admin().gis.dmas.byId({ id: dma.id }), "NOT_FOUND");

      const history = await admin().gis.dmas.history({ id: dma.id });
      assert.equal(history.length, 2);
      assert.equal(history[0]?.isDeleted, true);
      assert.deepEqual(history[0]?.boundaryValveIds, []);
      await expectCode(admin().gis.dmas.update({ id: dma.id, baseVersionId: history[0]!.versionId, patch: { color: "#000003" } }), "NOT_FOUND");
    });
  });

  describe("branches", () => {
    it("keeps a branch's valve change off main", async () => {
      const [a, b] = await Promise.all([newValve(), newValve()]);
      const dma = await newDma({ boundaryValveIds: [a.id] });
      await admin().gis.dmas.update({
        id: dma.id,
        baseVersionId: dma.versionId,
        branch: "reshape",
        patch: { boundaryValveIds: [a.id, b.id], color: "#123123" },
      });

      const onMain = await admin().gis.dmas.byId({ id: dma.id });
      assert.deepEqual(onMain.boundaryValveIds, [a.id]);
      assert.equal(onMain.color, dma.color);
      const onBranch = await admin().gis.dmas.byId({ id: dma.id, branch: "reshape" });
      assert.deepEqual(onBranch.boundaryValveIds, [a.id, b.id].sort());

      const view = await admin().gis.dmas.list({ branch: "reshape" });
      assert.equal(view.filter((d) => d.id === dma.id).length, 1);
    });

    it("keeps a DMA created on a branch off main, and lets it use main's nodes", async () => {
      const meter = await newMeter();
      const valve = await newValve();
      const dma = await newDma({ branch: "planning", inletMeterId: meter.id, boundaryValveIds: [valve.id] });
      assert.ok((await admin().gis.dmas.list({ branch: "planning" })).some((d) => d.id === dma.id));
      assert.ok(!(await admin().gis.dmas.list()).some((d) => d.id === dma.id));
      await expectCode(admin().gis.dmas.byId({ id: dma.id }), "NOT_FOUND");
    });

    it("won't let main use a node that only exists on a branch", async () => {
      const draftMeter = await newMeter({ branch: "draft-meters" });
      await expectCode(newDma({ inletMeterId: draftMeter.id }), "BAD_REQUEST");
      const onBranch = await newDma({ branch: "draft-meters", inletMeterId: draftMeter.id });
      assert.equal(onBranch.branch, "draft-meters");
    });
  });

  describe("concurrency", () => {
    it("lets exactly one of two racing edits win, leaving no stray valve rows", async () => {
      const [a, b] = await Promise.all([newValve(), newValve()]);
      const dma = await newDma();
      const results = await Promise.allSettled([
        admin().gis.dmas.update({ id: dma.id, baseVersionId: dma.versionId, patch: { boundaryValveIds: [a.id] } }),
        env.engineer().gis.dmas.update({ id: dma.id, baseVersionId: dma.versionId, patch: { boundaryValveIds: [b.id] } }),
      ]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      const lost = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      assert.equal((lost?.reason as { code?: string } | undefined)?.code, "CONFLICT");

      const history = await admin().gis.dmas.history({ id: dma.id });
      assert.equal(history.length, 2, "the original and the winner; the loser left nothing behind");
      const head = (await admin().gis.dmas.byId({ id: dma.id })).boundaryValveIds;
      assert.ok(head.length === 1 && (head[0] === a.id || head[0] === b.id));
    });
  });

  describe("deleting a node a DMA depends on", () => {
    it("is refused for the inlet meter and for a boundary valve", async () => {
      const meter = await newMeter();
      const valve = await newValve();
      await newDma({ inletMeterId: meter.id, boundaryValveIds: [valve.id] });

      await expectCode(admin().gis.nodes.delete({ id: meter.id, baseVersionId: meter.versionId }), "CONFLICT");
      await expectCode(admin().gis.nodes.delete({ id: valve.id, baseVersionId: valve.versionId }), "CONFLICT");
    });

    it("is allowed once the DMA is deleted", async () => {
      const meter = await newMeter();
      const dma = await newDma({ inletMeterId: meter.id });
      await admin().gis.dmas.delete({ id: dma.id, baseVersionId: dma.versionId });
      await admin().gis.nodes.delete({ id: meter.id, baseVersionId: meter.versionId });
      await expectCode(admin().gis.nodes.byId({ id: meter.id }), "NOT_FOUND");
    });

    it("is allowed once the valve has been taken off the DMA", async () => {
      const valve = await newValve();
      const dma = await newDma({ boundaryValveIds: [valve.id] });
      await admin().gis.dmas.update({ id: dma.id, baseVersionId: dma.versionId, patch: { boundaryValveIds: [] } });
      await admin().gis.nodes.delete({ id: valve.id, baseVersionId: valve.versionId });
      await expectCode(admin().gis.nodes.byId({ id: valve.id }), "NOT_FOUND");
    });

    it("judges by what the caller's branch sees, not by main alone", async () => {
      const meter = await newMeter();
      const dma = await newDma({ inletMeterId: meter.id });

      // On a branch the DMA is gone, so its meter can go too...
      await admin().gis.dmas.delete({ id: dma.id, baseVersionId: dma.versionId, branch: "unlink" });
      await admin().gis.nodes.delete({ id: meter.id, baseVersionId: meter.versionId, branch: "unlink" });

      // ...but on main the DMA still uses it.
      await expectCode(admin().gis.nodes.delete({ id: meter.id, baseVersionId: meter.versionId }), "CONFLICT");
    });
  });

  describe("tenant isolation", () => {
    it("never shows another organization's DMAs", async () => {
      const mine = await newDma();
      assert.ok(!(await env.outsider().gis.dmas.list()).some((d) => d.id === mine.id));
      await expectCode(env.outsider().gis.dmas.byId({ id: mine.id }), "NOT_FOUND");
      await expectCode(env.outsider().gis.dmas.history({ id: mine.id }), "NOT_FOUND");
    });

    // Flowless: claiming another organization's DMA is NOT_FOUND (it isn't their area), not CONFLICT.
    it("won't let another organization edit, delete or claim a DMA's id", async () => {
      const mine = await newDma();
      const outsider = env.outsider();
      await expectCode(outsider.gis.dmas.update({ id: mine.id, baseVersionId: mine.versionId, patch: { color: "#999999" } }), "NOT_FOUND");
      await expectCode(outsider.gis.dmas.delete({ id: mine.id, baseVersionId: mine.versionId }), "NOT_FOUND");

      const theirMeter = await outsider.gis.nodes.create({ type: "meter", name: "Their meter", location: P(0, 0) });
      await expectCode(
        outsider.gis.dmas.create({ areaId: mine.id, color: "#112233", tierId: tierB, inletMeterId: theirMeter.id, ring: RING }),
        "NOT_FOUND",
      );
      assert.equal((await admin().gis.dmas.byId({ id: mine.id })).name, mine.name);
    });
  });
});
