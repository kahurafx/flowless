import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, it } from "vitest";
import { expectCode, setupTestEnv, type TestEnv } from "./test-support";
import { buildChain, setValve, sortedIds } from "./test-network";

const P = (lat: number, lng: number) => ({ lat, lng });
const LINE = ["reservoir", "junction", "valve", "junction", "meter"] as const;

describe("gis.subnetworks", () => {
  let env: TestEnv;
  let tier: string;
  let otherTier: string;
  let theirTier: string;

  beforeAll(async () => {
    env = await setupTestEnv();
    tier = (await env.admin().gis.tiers.create({ name: "Subnetwork tier", order: 1 })).id;
    otherTier = (await env.admin().gis.tiers.create({ name: "Other tier", order: 2 })).id;
    theirTier = (await env.outsider().gis.tiers.create({ name: "Their tier", order: 1 })).id;
  });
  afterAll(async () => {
    await env.close();
  });

  const admin = () => env.admin();
  const shortId = () => Math.random().toString(36).slice(2, 7);

  type NodeInput = Parameters<ReturnType<TestEnv["admin"]>["gis"]["nodes"]["create"]>[0];
  const newNode = (type: NodeInput["type"], overrides: Partial<NodeInput> = {}) =>
    admin().gis.nodes.create({
      type,
      name: `${type} ${shortId()}`,
      location: P(-1.29, 36.78),
      isOpen: type === "valve" ? true : null,
      ...overrides,
    });

  type SubnetworkInput = Parameters<ReturnType<TestEnv["admin"]>["gis"]["subnetworks"]["create"]>[0];
  const newSubnetwork = (controllerNodeId: string, overrides: Partial<SubnetworkInput> = {}) =>
    admin().gis.subnetworks.create({ name: `Sub ${shortId()}`, tierId: tier, controllerNodeId, ...overrides });

  describe("access control", () => {
    it("rejects callers who aren't signed in", async () => {
      await expectCode(env.anonymous().gis.subnetworks.list(), "UNAUTHORIZED");
    });

    it("lets anyone with a GIS role read, and only admins and engineers change", async () => {
      const reservoir = await newNode("reservoir");
      const sub = await newSubnetwork(reservoir.id);
      for (const caller of [env.viewer(), env.tech()]) {
        await caller.gis.subnetworks.list();
        await caller.gis.subnetworks.byId({ id: sub.id });
        await expectCode(caller.gis.subnetworks.create({ name: "Nope", tierId: tier, controllerNodeId: reservoir.id }), "FORBIDDEN");
        await expectCode(caller.gis.subnetworks.update({ id: sub.id, patch: { name: "Nope" } }), "FORBIDDEN");
        await expectCode(caller.gis.subnetworks.delete({ id: sub.id }), "FORBIDDEN");
        await expectCode(caller.gis.subnetworks.validate({ id: sub.id }), "FORBIDDEN");
      }
    });
  });

  describe("creating and reading", () => {
    it("round-trips in the shape the frontends already use, unvalidated", async () => {
      const reservoir = await newNode("reservoir");
      const sub = await newSubnetwork(reservoir.id, { name: "Round trip" });
      assert.equal(sub.lastValidatedAt, null);
      assert.deepEqual(await admin().gis.subnetworks.byId({ id: sub.id }), sub);
      assert.ok((await admin().gis.subnetworks.list()).some((s) => s.id === sub.id));
    });

    it("accepts anything that supplies or shuts off water as a controller", async () => {
      for (const type of ["reservoir", "pumping_station", "valve", "meter"] as const) {
        const node = await newNode(type);
        const sub = await newSubnetwork(node.id);
        assert.equal(sub.controllerNodeId, node.id, type);
      }
    });

    it("refuses a junction or a hydrant as a controller", async () => {
      for (const type of ["junction", "hydrant"] as const) {
        const node = await newNode(type);
        await expectCode(newSubnetwork(node.id), "BAD_REQUEST");
      }
    });

    it("needs a controller that exists on main", async () => {
      await expectCode(newSubnetwork(env.id()), "BAD_REQUEST");
      const draft = await newNode("reservoir", { branch: "draft-controller" });
      await expectCode(newSubnetwork(draft.id), "BAD_REQUEST");
    });

    it("won't use another organization's node", async () => {
      const theirs = await env.outsider().gis.nodes.create({ type: "reservoir", name: "Theirs", location: P(0, 0) });
      await expectCode(newSubnetwork(theirs.id), "BAD_REQUEST");
    });

    it("needs a tier in this organization", async () => {
      const reservoir = await newNode("reservoir");
      await expectCode(newSubnetwork(reservoir.id, { tierId: env.id() }), "BAD_REQUEST");
      await expectCode(newSubnetwork(reservoir.id, { tierId: theirTier }), "BAD_REQUEST");
    });

    it("needs a name", async () => {
      const reservoir = await newNode("reservoir");
      await expectCode(newSubnetwork(reservoir.id, { name: "   " }), "BAD_REQUEST");
    });
  });

  describe("updating", () => {
    it("clears the validation when it's re-pointed, but not when it's merely renamed", async () => {
      const [a, b] = await Promise.all([newNode("reservoir"), newNode("reservoir")]);
      const sub = await newSubnetwork(a.id);

      const validated = await admin().gis.subnetworks.validate({ id: sub.id });
      assert.ok(validated.subnetwork.lastValidatedAt);

      const renamed = await admin().gis.subnetworks.update({ id: sub.id, patch: { name: "Renamed" } });
      assert.equal(renamed.name, "Renamed");
      assert.ok(renamed.lastValidatedAt, "a rename doesn't change what it contains");

      const sameController = await admin().gis.subnetworks.update({ id: sub.id, patch: { controllerNodeId: a.id } });
      assert.ok(sameController.lastValidatedAt, "naming the same controller isn't a change");

      const moved = await admin().gis.subnetworks.update({ id: sub.id, patch: { controllerNodeId: b.id } });
      assert.equal(moved.lastValidatedAt, null);

      await admin().gis.subnetworks.validate({ id: sub.id });
      const retiered = await admin().gis.subnetworks.update({ id: sub.id, patch: { tierId: otherTier } });
      assert.equal(retiered.lastValidatedAt, null);
      assert.equal(retiered.tierId, otherTier);
    });

    it("applies the same rules to a new controller as to a first one", async () => {
      const reservoir = await newNode("reservoir");
      const junction = await newNode("junction");
      const sub = await newSubnetwork(reservoir.id);
      await expectCode(admin().gis.subnetworks.update({ id: sub.id, patch: { controllerNodeId: junction.id } }), "BAD_REQUEST");
      await expectCode(admin().gis.subnetworks.update({ id: sub.id, patch: { tierId: theirTier } }), "BAD_REQUEST");
    });

    it("reports a subnetwork that doesn't exist", async () => {
      await expectCode(admin().gis.subnetworks.update({ id: env.id(), patch: { name: "X" } }), "NOT_FOUND");
    });
  });

  describe("members", () => {
    it("is everything connected to the controller when every valve is open", async () => {
      const { nodes } = await buildChain(env, LINE);
      const sub = await newSubnetwork(nodes[0]!.id);
      const result = await admin().gis.subnetworks.members({ id: sub.id });
      assert.deepEqual(sortedIds(result.members), sortedIds(nodes));
      assert.equal(result.subnetwork.id, sub.id);
      const reservoir = result.members.find((m) => m.id === nodes[0]!.id);
      assert.equal(reservoir?.type, "reservoir");
      assert.equal(reservoir?.name, nodes[0]!.name);
    });

    it("stops at a closed valve, which is itself a member", async () => {
      const { nodes } = await buildChain(env, LINE);
      await setValve(env, nodes[2]!, false);
      const sub = await newSubnetwork(nodes[0]!.id);
      const result = await admin().gis.subnetworks.members({ id: sub.id });
      assert.deepEqual(sortedIds(result.members), sortedIds([nodes[0]!, nodes[1]!, nodes[2]!]));
    });

    it("sees a branch's valve change without disturbing main", async () => {
      const { nodes } = await buildChain(env, LINE);
      const sub = await newSubnetwork(nodes[0]!.id);
      await setValve(env, nodes[2]!, false, "close-valve");

      const onBranch = await admin().gis.subnetworks.members({ id: sub.id, branch: "close-valve" });
      const onMain = await admin().gis.subnetworks.members({ id: sub.id });
      assert.equal(onBranch.members.length, 3);
      assert.equal(onMain.members.length, 5);
    });
  });

  describe("validating", () => {
    it("stamps the subnetwork and reports how many nodes it holds", async () => {
      const { nodes } = await buildChain(env, LINE);
      const sub = await newSubnetwork(nodes[0]!.id);
      const result = await admin().gis.subnetworks.validate({ id: sub.id });
      assert.equal(result.memberCount, 5);
      assert.deepEqual(result.overlaps, []);
      assert.ok(result.subnetwork.lastValidatedAt && !Number.isNaN(result.subnetwork.lastValidatedAt.getTime()));
      assert.deepEqual((await admin().gis.subnetworks.byId({ id: sub.id })).lastValidatedAt, result.subnetwork.lastValidatedAt);
    });

    it("reports other subnetworks in the same tier that share nodes, without refusing", async () => {
      const { nodes } = await buildChain(env, LINE);
      await setValve(env, nodes[2]!, false);
      const fromReservoir = await newSubnetwork(nodes[0]!.id);
      const fromMeter = await newSubnetwork(nodes[4]!.id);
      const elsewhere = await newSubnetwork(nodes[4]!.id, { tierId: otherTier });

      const result = await admin().gis.subnetworks.validate({ id: fromReservoir.id });
      assert.equal(result.memberCount, 3);
      assert.deepEqual(result.overlaps, [{ subnetworkId: fromMeter.id, name: fromMeter.name, sharedNodes: 1 }]);
      assert.ok(!result.overlaps.some((o) => o.subnetworkId === elsewhere.id), "a different tier isn't compared");
      assert.ok(result.subnetwork.lastValidatedAt, "an overlap is reported, not a reason to refuse");
    });

    it("reports a subnetwork that doesn't exist", async () => {
      await expectCode(admin().gis.subnetworks.validate({ id: env.id() }), "NOT_FOUND");
    });
  });

  describe("protecting controllers", () => {
    it("refuses to delete a node that controls a subnetwork, on main or on a branch", async () => {
      const lone = await newNode("reservoir");
      const sub = await newSubnetwork(lone.id);

      await expectCode(admin().gis.nodes.delete({ id: lone.id, baseVersionId: lone.versionId }), "CONFLICT");
      await expectCode(admin().gis.nodes.delete({ id: lone.id, baseVersionId: lone.versionId, branch: "ctrl-branch" }), "CONFLICT");

      await admin().gis.subnetworks.delete({ id: sub.id });
      await admin().gis.nodes.delete({ id: lone.id, baseVersionId: lone.versionId });
    });

    it("refuses to post a branch that deletes a node main has since made a controller", async () => {
      const node = await newNode("reservoir");
      await admin().gis.nodes.delete({ id: node.id, baseVersionId: node.versionId, branch: "lose-controller" });
      const sub = await newSubnetwork(node.id);

      const preview = await admin().gis.reconcile.preview({ branch: "lose-controller" });
      const result = await admin().gis.reconcile.post({ branch: "lose-controller", token: preview.token });
      assert.ok(result.status === "invalid");
      assert.ok(
        result.violations.some((v) => v.code === "subnetwork-controller-missing" && v.entityId === sub.id && v.relatedId === node.id),
        JSON.stringify(result.violations),
      );
      assert.equal((await admin().gis.nodes.byId({ id: node.id })).id, node.id, "the node is still on main");
    });
  });

  describe("deleting", () => {
    it("removes the subnetwork", async () => {
      const reservoir = await newNode("reservoir");
      const sub = await newSubnetwork(reservoir.id);
      await admin().gis.subnetworks.delete({ id: sub.id });
      assert.ok(!(await admin().gis.subnetworks.list()).some((s) => s.id === sub.id));
      await expectCode(admin().gis.subnetworks.byId({ id: sub.id }), "NOT_FOUND");
      await expectCode(admin().gis.subnetworks.delete({ id: sub.id }), "NOT_FOUND");
    });
  });

  describe("tenant isolation", () => {
    it("never shows another organization's subnetworks", async () => {
      const reservoir = await newNode("reservoir");
      const mine = await newSubnetwork(reservoir.id);
      const outsider = env.outsider();
      assert.ok(!(await outsider.gis.subnetworks.list()).some((s) => s.id === mine.id));
      await expectCode(outsider.gis.subnetworks.byId({ id: mine.id }), "NOT_FOUND");
      await expectCode(outsider.gis.subnetworks.members({ id: mine.id }), "NOT_FOUND");
      await expectCode(outsider.gis.subnetworks.validate({ id: mine.id }), "NOT_FOUND");
      await expectCode(outsider.gis.subnetworks.update({ id: mine.id, patch: { name: "Hijacked" } }), "NOT_FOUND");
      await expectCode(outsider.gis.subnetworks.delete({ id: mine.id }), "NOT_FOUND");
      assert.equal((await admin().gis.subnetworks.byId({ id: mine.id })).name, mine.name);
    });
  });
});
