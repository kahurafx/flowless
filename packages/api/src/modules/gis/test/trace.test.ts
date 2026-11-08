import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, it } from "vitest";
import { expectCode, setupTestEnv, type TestEnv } from "./test-support";
import { buildChain, setValve, sortedIds } from "./test-network";

/** R ── A ── V ── B ── C, with pipes p1..p4 left to right. */
const LINE = ["reservoir", "junction", "valve", "junction", "meter"] as const;
/** R ── V1 ── A ── V2 ── B ── C, with pipes q1..q5 left to right. */
const TWO_VALVES = ["reservoir", "valve", "junction", "valve", "junction", "meter"] as const;

describe("gis.trace", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setupTestEnv();
  });
  afterAll(async () => {
    await env.close();
  });

  const admin = () => env.admin();

  describe("directional", () => {
    it("goes downstream, away from the source", async () => {
      const { nodes } = await buildChain(env, LINE);
      const [, a, v, b, c] = nodes;
      const result = await admin().gis.trace.directional({ startNodeId: a!.id, direction: "downstream" });
      assert.deepEqual(sortedIds(result.nodes), sortedIds([a!, v!, b!, c!]));
    });

    it("goes upstream, toward the source", async () => {
      const { nodes } = await buildChain(env, LINE);
      const [r, a, v, b] = nodes;
      const result = await admin().gis.trace.directional({ startNodeId: b!.id, direction: "upstream" });
      assert.deepEqual(sortedIds(result.nodes), sortedIds([r!, a!, v!, b!]));
    });

    it("describes what it found", async () => {
      const { nodes } = await buildChain(env, LINE);
      const result = await admin().gis.trace.directional({ startNodeId: nodes[1]!.id, direction: "upstream" });
      const reservoir = result.nodes.find((n) => n.id === nodes[0]!.id);
      assert.deepEqual(reservoir, { id: nodes[0]!.id, name: nodes[0]!.name, type: "reservoir" });
    });

    it("includes a closed valve but stops there", async () => {
      const { nodes } = await buildChain(env, LINE);
      const [, a, v, , c] = nodes;
      await setValve(env, v!, false);

      const down = await admin().gis.trace.directional({ startNodeId: a!.id, direction: "downstream" });
      assert.deepEqual(sortedIds(down.nodes), sortedIds([a!, v!]));

      const up = await admin().gis.trace.directional({ startNodeId: c!.id, direction: "upstream" });
      assert.deepEqual(sortedIds(up.nodes), sortedIds([nodes[3]!, c!, v!]));
    });

    it("sees a branch's valve change without disturbing main", async () => {
      const { nodes } = await buildChain(env, LINE);
      const [, a, v] = nodes;
      await setValve(env, v!, false, "trace-branch");

      const onBranch = await admin().gis.trace.directional({ startNodeId: a!.id, direction: "downstream", branch: "trace-branch" });
      const onMain = await admin().gis.trace.directional({ startNodeId: a!.id, direction: "downstream" });
      assert.equal(onBranch.nodes.length, 2);
      assert.equal(onMain.nodes.length, 4);
    });

    it("reports a start node that doesn't exist", async () => {
      await expectCode(admin().gis.trace.directional({ startNodeId: env.id(), direction: "downstream" }), "NOT_FOUND");
    });
  });

  describe("isolation", () => {
    it("closes the open valve beside the break and reports what's cut off", async () => {
      const { nodes, pipes } = await buildChain(env, LINE);
      const [, , v, b, c] = nodes;
      const result = await admin().gis.trace.isolation({ failedPipeId: pipes[2]!.id }); // V–B
      assert.deepEqual(sortedIds(result.valvesToClose), sortedIds([v!]));
      assert.deepEqual(sortedIds(result.affectedNodes), sortedIds([b!, c!]));
      assert.deepEqual(result.alreadyClosed, []);
      assert.deepEqual(result.unisolatedSources, []);
    });

    it("lists a valve that's already closed as a boundary, not as something to close", async () => {
      const { nodes, pipes } = await buildChain(env, LINE);
      await setValve(env, nodes[2]!, false);
      const result = await admin().gis.trace.isolation({ failedPipeId: pipes[2]!.id });
      assert.deepEqual(result.valvesToClose, []);
      assert.deepEqual(sortedIds(result.alreadyClosed), sortedIds([nodes[2]!]));
    });

    it("flags a break that's still connected to a supply source", async () => {
      const { nodes, pipes } = await buildChain(env, LINE);
      const result = await admin().gis.trace.isolation({ failedPipeId: pipes[1]!.id }); // A–V
      assert.deepEqual(sortedIds(result.unisolatedSources), sortedIds([nodes[0]!]));
      assert.deepEqual(sortedIds(result.valvesToClose), sortedIds([nodes[2]!]));
      assert.deepEqual(sortedIds(result.affectedNodes), sortedIds([nodes[0]!, nodes[1]!]));
    });

    it("routes around a valve that won't operate", async () => {
      const { nodes, pipes } = await buildChain(env, TWO_VALVES);
      const [, v1, a, v2, b, c] = nodes;

      const plain = await admin().gis.trace.isolation({ failedPipeId: pipes[1]!.id }); // V1–A
      assert.deepEqual(sortedIds(plain.valvesToClose), sortedIds([v1!, v2!]));
      assert.deepEqual(sortedIds(plain.affectedNodes), sortedIds([a!]));

      const skipping = await admin().gis.trace.isolation({ failedPipeId: pipes[1]!.id, skipValveIds: [v2!.id] });
      assert.deepEqual(sortedIds(skipping.valvesToClose), sortedIds([v1!]));
      assert.deepEqual(sortedIds(skipping.affectedNodes), sortedIds([a!, v2!, b!, c!]));
    });

    it("sees a branch's valve change without disturbing main", async () => {
      const { nodes, pipes } = await buildChain(env, LINE);
      await setValve(env, nodes[2]!, false, "isolate-branch");

      const onBranch = await admin().gis.trace.isolation({ failedPipeId: pipes[2]!.id, branch: "isolate-branch" });
      const onMain = await admin().gis.trace.isolation({ failedPipeId: pipes[2]!.id });
      assert.equal(onBranch.valvesToClose.length, 0);
      assert.equal(onMain.valvesToClose.length, 1);
    });

    it("reports a pipe that doesn't exist", async () => {
      await expectCode(admin().gis.trace.isolation({ failedPipeId: env.id() }), "NOT_FOUND");
    });
  });

  describe("access", () => {
    it("lets a viewer trace, and turns away callers who aren't signed in", async () => {
      const { nodes, pipes } = await buildChain(env, LINE);
      await env.viewer().gis.trace.directional({ startNodeId: nodes[1]!.id, direction: "downstream" });
      await env.viewer().gis.trace.isolation({ failedPipeId: pipes[0]!.id });
      await expectCode(env.anonymous().gis.trace.directional({ startNodeId: nodes[1]!.id, direction: "downstream" }), "UNAUTHORIZED");
    });

    it("never traces through another organization's network", async () => {
      const { nodes, pipes } = await buildChain(env, LINE);
      const outsider = env.outsider();
      await expectCode(outsider.gis.trace.directional({ startNodeId: nodes[1]!.id, direction: "downstream" }), "NOT_FOUND");
      await expectCode(outsider.gis.trace.isolation({ failedPipeId: pipes[0]!.id }), "NOT_FOUND");
    });
  });
});
