import type { NodeType } from "@flowless/shared-types";
import type { TestEnv } from "./test-support";

/**
 * A straight chain of real nodes joined by real pipes, built through the API,
 * running south along one meridian (each node 0.001° — about 111 m — below the
 * last). Valves start open. `nodes[i]` and `pipes[i - 1]` are the node and the
 * pipe that arrives at it, so `pipes[0]` joins `nodes[0]` and `nodes[1]`.
 *
 * Tests share one organization, so a test that cares WHERE things are (a
 * polygon test, say) must pass its own `lng` — otherwise every chain sits at
 * the same coordinates and one test's nodes turn up inside another's boundary.
 */
export async function buildChain(env: TestEnv, types: readonly NodeType[], options: { lng?: number } = {}) {
  const lng = options.lng ?? 36.78;
  const admin = env.admin();
  type CreatedNode = Awaited<ReturnType<typeof admin.gis.nodes.create>>;
  type CreatedPipe = Awaited<ReturnType<typeof admin.gis.pipes.create>>;
  const nodes: CreatedNode[] = [];
  const pipes: CreatedPipe[] = [];

  for (const [i, type] of types.entries()) {
    nodes.push(
      await admin.gis.nodes.create({
        type,
        name: `${type} ${i}`,
        location: { lat: -1.29 - i * 0.001, lng },
        isOpen: type === "valve" ? true : null,
      }),
    );
  }
  for (let i = 1; i < nodes.length; i++) {
    const from = nodes[i - 1]!;
    const to = nodes[i]!;
    pipes.push(
      await admin.gis.pipes.create({
        fromNodeId: from.id,
        toNodeId: to.id,
        path: [from.location, to.location],
        diameterMm: 200,
      }),
    );
  }
  return { nodes, pipes };
}

/** Open or close a valve — on main, or only on a branch. */
export async function setValve(env: TestEnv, valve: { id: string; versionId: string }, isOpen: boolean, branch?: string) {
  return env.admin().gis.nodes.update({
    id: valve.id,
    baseVersionId: valve.versionId,
    ...(branch ? { branch } : {}),
    patch: { isOpen },
  });
}

/** Sorted ids, for comparing traces without caring about visit order. */
export const sortedIds = (items: readonly { id: string }[]) => items.map((item) => item.id).sort();
