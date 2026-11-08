import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, it } from "vitest";
import { expectCode, setupTestEnv, type TestEnv } from "./test-support";

const P = (lat: number, lng: number) => ({ lat, lng });
const RING = [P(-1.29, 36.78), P(-1.29, 36.79), P(-1.3, 36.79), P(-1.3, 36.78)];

describe("gis.tiers", () => {
  let env: TestEnv;
  // Order is unique within an organization, so every test takes its own numbers.
  let nextOrder = 10;
  const takeOrder = (count = 1) => {
    const first = nextOrder;
    nextOrder += count;
    return first;
  };

  beforeAll(async () => {
    env = await setupTestEnv();
  });
  afterAll(async () => {
    await env.close();
  });

  const admin = () => env.admin();
  const newTier = (name = `Tier ${Math.random().toString(36).slice(2, 7)}`, order = takeOrder()) => admin().gis.tiers.create({ name, order });

  describe("access control", () => {
    it("rejects callers who aren't signed in", async () => {
      await expectCode(env.anonymous().gis.tiers.list(), "UNAUTHORIZED");
    });

    it("lets anyone with a GIS role read tiers", async () => {
      await env.viewer().gis.tiers.list();
      await env.tech().gis.tiers.list();
    });

    it("lets only admins and engineers change them", async () => {
      const tier = await newTier();
      for (const caller of [env.viewer(), env.tech()]) {
        await expectCode(caller.gis.tiers.create({ name: "Nope", order: takeOrder() }), "FORBIDDEN");
        await expectCode(caller.gis.tiers.update({ id: tier.id, patch: { name: "Nope" } }), "FORBIDDEN");
        await expectCode(caller.gis.tiers.delete({ id: tier.id }), "FORBIDDEN");
      }
    });
  });

  describe("creating and listing", () => {
    it("round-trips in the shape the frontends already use", async () => {
      const tier = await newTier("Round trip", takeOrder());
      assert.equal(tier.name, "Round trip");
      assert.ok((await admin().gis.tiers.list()).some((t) => t.id === tier.id));
    });

    it("lists the top of the hierarchy first, whatever order they were created in", async () => {
      const base = takeOrder(3);
      const suffix = env.run;
      await newTier(`c-${suffix}`, base + 2);
      await newTier(`a-${suffix}`, base);
      await newTier(`b-${suffix}`, base + 1);

      const ours = (await admin().gis.tiers.list()).filter((t) => t.name.endsWith(`-${suffix}`));
      assert.deepEqual(
        ours.map((t) => t.name.slice(0, 1)),
        ["a", "b", "c"],
      );
    });

    it("rejects an order another tier already uses", async () => {
      const first = await newTier("First", takeOrder());
      await expectCode(newTier("Second", first.order), "CONFLICT");
    });

    it("rejects an empty name and an order that isn't a whole number from 1 to 100", async () => {
      await expectCode(newTier("   ", takeOrder()), "BAD_REQUEST");
      await expectCode(newTier("Zero", 0), "BAD_REQUEST");
      await expectCode(newTier("Half", 1.5), "BAD_REQUEST");
      await expectCode(newTier("Huge", 101), "BAD_REQUEST");
    });
  });

  describe("updating", () => {
    it("renames and re-orders", async () => {
      const tier = await newTier();
      const newOrder = takeOrder();
      const updated = await admin().gis.tiers.update({ id: tier.id, patch: { name: "Renamed", order: newOrder } });
      assert.deepEqual([updated.name, updated.order], ["Renamed", newOrder]);
    });

    it("lets a tier keep its own order while changing something else", async () => {
      const tier = await newTier();
      const updated = await admin().gis.tiers.update({ id: tier.id, patch: { name: "Same order", order: tier.order } });
      assert.equal(updated.order, tier.order);
    });

    it("refuses an order another tier already uses", async () => {
      const a = await newTier();
      const b = await newTier();
      await expectCode(admin().gis.tiers.update({ id: b.id, patch: { order: a.order } }), "CONFLICT");
    });

    it("reports a tier that doesn't exist", async () => {
      await expectCode(admin().gis.tiers.update({ id: env.id(), patch: { name: "X" } }), "NOT_FOUND");
    });
  });

  describe("deleting", () => {
    it("removes a tier nothing uses", async () => {
      const tier = await newTier();
      await admin().gis.tiers.delete({ id: tier.id });
      assert.ok(!(await admin().gis.tiers.list()).some((t) => t.id === tier.id));
      await expectCode(admin().gis.tiers.delete({ id: tier.id }), "NOT_FOUND");
    });

    it("is refused while a subnetwork uses the tier, and allowed once it's gone", async () => {
      const tier = await newTier();
      const reservoir = await admin().gis.nodes.create({ type: "reservoir", name: "R", location: P(-1.29, 36.78) });
      const subnetwork = await admin().gis.subnetworks.create({ name: "Uses tier", tierId: tier.id, controllerNodeId: reservoir.id });

      await expectCode(admin().gis.tiers.delete({ id: tier.id }), "CONFLICT");
      await admin().gis.subnetworks.delete({ id: subnetwork.id });
      await admin().gis.tiers.delete({ id: tier.id });
    });

    it("is refused while a DMA uses the tier — and stays refused after the DMA is deleted, because history refers to it", async () => {
      const tier = await newTier();
      const meter = await admin().gis.nodes.create({ type: "meter", name: "M", location: P(-1.295, 36.785) });
      const dma = await admin().gis.dmas.create({
        areaId: (await env.dmaArea("Uses tier")).id,
        color: "#3B82F6",
        tierId: tier.id,
        inletMeterId: meter.id,
        ring: RING,
      });

      await expectCode(admin().gis.tiers.delete({ id: tier.id }), "CONFLICT");
      await admin().gis.dmas.delete({ id: dma.id, baseVersionId: dma.versionId });
      await expectCode(admin().gis.tiers.delete({ id: tier.id }), "CONFLICT");
      assert.ok(
        (await admin().gis.tiers.list()).some((t) => t.id === tier.id),
        "the tier is still there",
      );
    });
  });

  describe("tenant isolation", () => {
    it("never shows another organization's tiers", async () => {
      const mine = await newTier();
      assert.ok(!(await env.outsider().gis.tiers.list()).some((t) => t.id === mine.id));
    });

    it("won't let another organization edit or delete a tier", async () => {
      const mine = await newTier("Mine");
      await expectCode(env.outsider().gis.tiers.update({ id: mine.id, patch: { name: "Hijacked" } }), "NOT_FOUND");
      await expectCode(env.outsider().gis.tiers.delete({ id: mine.id }), "NOT_FOUND");
      const listed = (await admin().gis.tiers.list()).find((t) => t.id === mine.id);
      assert.equal(listed?.name, "Mine");
    });

    it("lets two organizations use the same order", async () => {
      const order = takeOrder();
      await newTier("Mine", order);
      const theirs = await env.outsider().gis.tiers.create({ name: "Theirs", order });
      assert.equal(theirs.order, order);
    });
  });
});
