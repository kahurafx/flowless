import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, it } from "vitest";
import { setupTestEnv, type TestEnv } from "./test-support";

const P = (lat: number, lng: number) => ({ lat, lng });
const RING = [P(-1.29, 36.78), P(-1.29, 36.79), P(-1.3, 36.79), P(-1.3, 36.78)];

describe("gis.reconcile with DMAs", () => {
  let env: TestEnv;
  let tier: string;

  beforeAll(async () => {
    env = await setupTestEnv();
    tier = (await env.admin().gis.tiers.create({ name: "DMA tier", order: 1 })).id;
  });
  afterAll(async () => {
    await env.close();
  });

  const admin = () => env.admin();
  const shortId = () => Math.random().toString(36).slice(2, 7);

  type NodeInput = Parameters<ReturnType<TestEnv["admin"]>["gis"]["nodes"]["create"]>[0];
  const newMeter = (overrides: Partial<NodeInput> = {}) =>
    admin().gis.nodes.create({ type: "meter", name: `Meter ${shortId()}`, location: P(-1.295, 36.785), ...overrides });
  const newValve = (overrides: Partial<NodeInput> = {}) =>
    admin().gis.nodes.create({ type: "valve", name: `Valve ${shortId()}`, location: P(-1.29, 36.785), isOpen: true, ...overrides });

  type DmaInput = Parameters<ReturnType<TestEnv["admin"]>["gis"]["dmas"]["create"]>[0];
  /** Map data on a new kernel DMA area (Flowless: the DMA is the kernel's, GIS draws it). */
  async function newDma(overrides: Partial<DmaInput> = {}) {
    const inletMeterId = overrides.inletMeterId ?? (await newMeter()).id;
    return admin().gis.dmas.create({
      areaId: (await env.dmaArea(`DMA ${shortId()}`)).id,
      color: "#3B82F6",
      tierId: tier,
      inletMeterId,
      boundaryValveIds: [],
      ring: RING,
      ...overrides,
    });
  }

  async function postBranch(branch: string, resolutions?: Record<string, Record<string, "branch" | "main">>) {
    const preview = await admin().gis.reconcile.preview({ branch });
    return admin().gis.reconcile.post({ branch, token: preview.token, ...(resolutions ? { resolutions } : {}) });
  }

  const editValves = (dma: { id: string; versionId: string }, branch: string | undefined, boundaryValveIds: string[], extra: { color?: string } = {}) =>
    admin().gis.dmas.update({
      id: dma.id,
      baseVersionId: dma.versionId,
      ...(branch ? { branch } : {}),
      patch: { boundaryValveIds, ...extra },
    });

  const openBranches = async () => (await admin().gis.reconcile.branches()).map((b) => b.branch);

  it("fast-forwards an edit, giving the new main version its own valve set", async () => {
    const [a, b] = await Promise.all([newValve(), newValve()]);
    const dma = await newDma({ boundaryValveIds: [a.id] });
    await editValves(dma, "d-ff", [a.id, b.id], { color: "#112233" });

    const preview = await admin().gis.reconcile.preview({ branch: "d-ff" });
    assert.equal(preview.entities[0]?.entityType, "dma");
    assert.equal(preview.entities[0]?.detail, "fast-forward");
    assert.deepEqual(preview.entities[0]?.changedFields, ["color", "boundaryValveIds"]);

    const result = await admin().gis.reconcile.post({ branch: "d-ff", token: preview.token });
    assert.ok(result.status === "posted", JSON.stringify(result));

    const onMain = await admin().gis.dmas.byId({ id: dma.id });
    assert.equal(onMain.color, "#112233");
    assert.deepEqual(onMain.boundaryValveIds, [a.id, b.id].sort());

    const history = await admin().gis.dmas.history({ id: dma.id });
    assert.deepEqual(history.find((h) => h.versionId === dma.versionId)?.boundaryValveIds, [a.id], "the version it replaced keeps its own set");
    assert.ok(!(await openBranches()).includes("d-ff"));
  });

  it("keeps valves added on both sides", async () => {
    const [a, b, c] = await Promise.all([newValve(), newValve(), newValve()]);
    const dma = await newDma({ boundaryValveIds: [a.id] });
    await editValves(dma, "d-both", [a.id, b.id]);
    await editValves(dma, undefined, [a.id, c.id]);

    const preview = await admin().gis.reconcile.preview({ branch: "d-both" });
    assert.equal(preview.entities[0]?.detail, "merge");
    assert.equal(preview.summary.conflicts, 0);

    const result = await admin().gis.reconcile.post({ branch: "d-both", token: preview.token });
    assert.ok(result.status === "posted");
    assert.deepEqual((await admin().gis.dmas.byId({ id: dma.id })).boundaryValveIds, [a.id, b.id, c.id].sort());
  });

  it("applies the branch's removal on top of what main added", async () => {
    const [a, b, c] = await Promise.all([newValve(), newValve(), newValve()]);
    const dma = await newDma({ boundaryValveIds: [a.id, b.id] });
    await editValves(dma, "d-remove", [a.id]);
    await editValves(dma, undefined, [a.id, b.id, c.id]);

    const result = await postBranch("d-remove");
    assert.ok(result.status === "posted");
    assert.deepEqual((await admin().gis.dmas.byId({ id: dma.id })).boundaryValveIds, [a.id, c.id].sort());
  });

  it("asks only about a clashing colour, never about the valve set", async () => {
    const [a, b, c] = await Promise.all([newValve(), newValve(), newValve()]);
    const dma = await newDma({ color: "#000000", boundaryValveIds: [a.id] });
    await editValves(dma, "d-clash", [a.id, b.id], { color: "#111111" });
    await editValves(dma, undefined, [a.id, c.id], { color: "#222222" });

    const preview = await admin().gis.reconcile.preview({ branch: "d-clash" });
    assert.equal(preview.entities[0]?.kind, "conflict");
    assert.deepEqual(
      preview.entities[0]?.conflicts.map((c) => c.field),
      ["color"],
    );

    const result = await admin().gis.reconcile.post({
      branch: "d-clash",
      token: preview.token,
      resolutions: { [dma.id]: { color: "branch" } },
    });
    assert.ok(result.status === "posted");
    const onMain = await admin().gis.dmas.byId({ id: dma.id });
    assert.equal(onMain.color, "#111111");
    assert.deepEqual(onMain.boundaryValveIds, [a.id, b.id, c.id].sort());
  });

  it("creates a DMA together with the meter and valve it uses", async () => {
    const meter = await newMeter({ branch: "newdma" });
    const valve = await newValve({ branch: "newdma" });
    const dma = await newDma({ branch: "newdma", inletMeterId: meter.id, boundaryValveIds: [valve.id] });
    // A new meter can't go live without a photo (NODE_PHOTO_RULE).
    const before = await admin().gis.reconcile.preview({ branch: "newdma" });
    assert.equal(before.summary.needPhoto, 1, "the preview says the meter still needs its photo");
    const refused = await admin().gis.reconcile.post({ branch: "newdma", token: before.token });
    assert.ok(refused.status === "invalid" && refused.violations.some((v) => v.code === "node-photo-missing" && v.entityId === meter.id));
    await env.photo(env.members.admin, meter.id);

    const preview = await admin().gis.reconcile.preview({ branch: "newdma" });
    assert.deepEqual(preview.entities.map((e) => e.entityType).sort(), ["dma", "node", "node"]);

    const result = await admin().gis.reconcile.post({ branch: "newdma", token: preview.token });
    assert.ok(result.status === "posted", JSON.stringify(result));
    assert.equal(result.summary.created, 3);

    const onMain = await admin().gis.dmas.byId({ id: dma.id });
    assert.equal(onMain.inletMeterId, meter.id);
    assert.deepEqual(onMain.boundaryValveIds, [valve.id]);
  });

  it("discards a DMA edit along with any others", async () => {
    const v = await newValve();
    const dma = await newDma();
    await editValves(dma, "d-scrap", [v.id]);
    assert.deepEqual(await admin().gis.reconcile.discard({ branch: "d-scrap" }), { discarded: 1 });
    assert.deepEqual((await admin().gis.dmas.byId({ id: dma.id })).boundaryValveIds, []);
  });

  describe("keeping main consistent", () => {
    it("rejects a new DMA whose valve main has since deleted", async () => {
      const meter = await newMeter();
      const valve = await newValve();
      const dma = await newDma({ branch: "dma-new", inletMeterId: meter.id, boundaryValveIds: [valve.id] });
      // Main doesn't see the branch's DMA, so it's free to delete the valve.
      await admin().gis.nodes.delete({ id: valve.id, baseVersionId: valve.versionId });

      const result = await postBranch("dma-new");
      assert.ok(result.status === "invalid");
      assert.ok(
        result.violations.some((v) => v.code === "dma-valve-missing" && v.entityId === dma.id && v.relatedId === valve.id),
        JSON.stringify(result.violations),
      );
      assert.ok(!(await admin().gis.dmas.list()).some((d) => d.id === dma.id), "the DMA did not reach main");
      assert.ok((await openBranches()).includes("dma-new"));
    });

    it("rejects deleting a valve that main has since put on a DMA", async () => {
      const valve = await newValve();
      await admin().gis.nodes.delete({ id: valve.id, baseVersionId: valve.versionId, branch: "drop-valve" });
      const dma = await newDma({ boundaryValveIds: [valve.id] });

      const result = await postBranch("drop-valve");
      assert.ok(result.status === "invalid");
      assert.ok(
        result.violations.some((v) => v.code === "dma-valve-missing" && v.entityId === dma.id && v.relatedId === valve.id),
        JSON.stringify(result.violations),
      );
      assert.equal((await admin().gis.nodes.byId({ id: valve.id })).id, valve.id, "the valve is still on main");
    });

    it("rejects deleting a meter that main has since made a DMA's inlet", async () => {
      const meter = await newMeter();
      await admin().gis.nodes.delete({ id: meter.id, baseVersionId: meter.versionId, branch: "drop-inlet" });
      const dma = await newDma({ inletMeterId: meter.id });

      const result = await postBranch("drop-inlet");
      assert.ok(result.status === "invalid");
      assert.ok(
        result.violations.some((v) => v.code === "dma-inlet-missing" && v.entityId === dma.id && v.relatedId === meter.id),
        JSON.stringify(result.violations),
      );
      assert.equal((await admin().gis.nodes.byId({ id: meter.id })).id, meter.id, "the meter is still on main");
    });
  });
});
