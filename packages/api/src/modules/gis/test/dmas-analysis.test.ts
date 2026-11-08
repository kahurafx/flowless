import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, it } from "vitest";
import { expectCode, setupTestEnv, type TestEnv } from "./test-support";
import { buildChain, setValve, sortedIds } from "./test-network";

const P = (lat: number, lng: number) => ({ lat, lng });

/**
 * R ── M ── A ── V ── B, running south from latitude -1.290 in steps of 0.001°:
 * a reservoir feeding a meter (the DMA's inlet), then a junction, a boundary
 * valve, and a junction beyond it.
 */
const CHAIN = ["reservoir", "meter", "junction", "valve", "junction"] as const;

/**
 * Covers latitudes -1.2905 to -1.2935 and 0.001° either side of the chain's
 * meridian: the meter, the first junction and the valve, but not the reservoir
 * or the far junction.
 */
const ringAround = (lng: number) => [P(-1.2905, lng - 0.001), P(-1.2905, lng + 0.001), P(-1.2935, lng + 0.001), P(-1.2935, lng - 0.001)];

describe("gis.dmas.analysis", () => {
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

  // Each test gets its own meridian (about a kilometre apart), so nodes left behind by
  // earlier tests never fall inside this one's boundary.
  let nextLng = 36.7;
  const takeLng = () => (nextLng += 0.01);

  async function setup(valveOpen: boolean) {
    const lng = takeLng();
    const { nodes } = await buildChain(env, CHAIN, { lng });
    const [reservoir, meter, junction, valve, far] = nodes as [
      (typeof nodes)[number],
      (typeof nodes)[number],
      (typeof nodes)[number],
      (typeof nodes)[number],
      (typeof nodes)[number],
    ];
    const currentValve = valveOpen ? valve : await setValve(env, valve, false);
    const dma = await admin().gis.dmas.create({
      areaId: (await env.dmaArea(`DMA ${Math.random().toString(36).slice(2, 7)}`)).id,
      color: "#3B82F6",
      tierId: tier,
      inletMeterId: meter.id,
      boundaryValveIds: [valve.id],
      ring: ringAround(lng),
    });
    return { reservoir, meter, junction, valve: currentValve, far, dma, lng };
  }

  it("calls a DMA sealed when what's connected matches what's drawn and the boundary valve is shut", async () => {
    const { meter, junction, valve, dma } = await setup(false);
    const result = await admin().gis.dmas.analysis({ id: dma.id });
    assert.deepEqual(result.tracedNodeIds, sortedIds([meter, junction, valve]));
    assert.deepEqual(result.outsideBoundary, []);
    assert.deepEqual(result.insideNotTraced, []);
    assert.deepEqual(result.openBoundaryValveIds, []);
    assert.equal(result.sealed, true);
  });

  it("reports what escapes the polygon when the boundary valve is open", async () => {
    const { meter, junction, valve, far, dma } = await setup(true);
    const result = await admin().gis.dmas.analysis({ id: dma.id });
    assert.deepEqual(result.tracedNodeIds, sortedIds([meter, junction, valve, far]));
    assert.deepEqual(result.outsideBoundary, [far.id]);
    assert.deepEqual(result.openBoundaryValveIds, [valve.id]);
    assert.equal(result.sealed, false);
  });

  it("traces what the inlet feeds, not the supply network behind it", async () => {
    const { reservoir, dma } = await setup(false);
    const result = await admin().gis.dmas.analysis({ id: dma.id });
    assert.ok(!result.tracedNodeIds.includes(reservoir.id), "the reservoir is upstream of the inlet");
    assert.ok(!result.outsideBoundary.includes(reservoir.id));
  });

  it("notices a node drawn inside the boundary that the inlet doesn't feed", async () => {
    const { dma, lng } = await setup(false);
    const stray = await admin().gis.nodes.create({ type: "junction", name: "Stray", location: P(-1.2925, lng) });
    const result = await admin().gis.dmas.analysis({ id: dma.id });
    assert.deepEqual(result.insideNotTraced, [stray.id]);
    assert.equal(result.sealed, true, "an unconnected node inside doesn't leak anything");
  });

  it("treats a valve of unknown state as not sealing anything", async () => {
    const lng = takeLng();
    const { nodes } = await buildChain(env, CHAIN, { lng });
    const valve = nodes[3]!;
    const unknown = await admin().gis.nodes.update({ id: valve.id, baseVersionId: valve.versionId, patch: { isOpen: null } });
    const dma = await admin().gis.dmas.create({
      areaId: (await env.dmaArea("Unknown valve")).id,
      color: "#112233",
      tierId: tier,
      inletMeterId: nodes[1]!.id,
      boundaryValveIds: [unknown.id],
      ring: ringAround(lng),
    });
    const result = await admin().gis.dmas.analysis({ id: dma.id });
    assert.deepEqual(result.openBoundaryValveIds, [unknown.id]);
    assert.equal(result.sealed, false);
  });

  it("judges a branch by its own valve states, leaving main alone", async () => {
    const { valve, dma } = await setup(true);
    await setValve(env, valve, false, "seal-it");
    assert.equal((await admin().gis.dmas.analysis({ id: dma.id, branch: "seal-it" })).sealed, true);
    assert.equal((await admin().gis.dmas.analysis({ id: dma.id })).sealed, false);
  });

  it("reports a DMA that doesn't exist, and lets a viewer read", async () => {
    const { dma } = await setup(false);
    await expectCode(admin().gis.dmas.analysis({ id: env.id() }), "NOT_FOUND");
    await env.viewer().gis.dmas.analysis({ id: dma.id });
  });

  it("never analyses another organization's DMA", async () => {
    const { dma } = await setup(false);
    await expectCode(env.outsider().gis.dmas.analysis({ id: dma.id }), "NOT_FOUND");
  });
});
