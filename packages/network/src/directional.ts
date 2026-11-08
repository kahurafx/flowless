import { buildAdjacency, indexNodes, pickNodes, type Adjacency } from "./graph";
import { isClosedValve, isSource, type TraceNode, type TracePipe } from "./types";

/** Hop count from the nearest source to every node that can reach one. Nodes with no path to any source are absent. */
export function distancesFromSources(nodes: readonly TraceNode[], adjacency: Adjacency): Map<string, number> {
  const distances = new Map<string, number>();
  const queue: string[] = [];
  for (const node of nodes) {
    if (isSource(node)) {
      distances.set(node.id, 0);
      queue.push(node.id);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head];
    if (current === undefined) continue;
    const distance = distances.get(current) ?? 0;
    for (const neighbor of adjacency.get(current) ?? []) {
      if (distances.has(neighbor)) continue;
      distances.set(neighbor, distance + 1);
      queue.push(neighbor);
    }
  }
  return distances;
}

/**
 * Upstream/downstream from a node, approximated by hop distance from the
 * nearest source rather than true flow direction — there's no hydraulic
 * simulation yet to derive real direction from. "Upstream" only ever steps
 * strictly closer to a source; "downstream" steps anywhere that isn't, so in
 * a looped network it can move sideways across equal-distance nodes and may
 * disagree with reality near pressure-balanced points. A node with no path
 * to any source has no known direction: upstream from it is just itself, and
 * downstream is everything connected to it. Replace with the solver's flow
 * directions once they exist; the signature shouldn't need to change.
 *
 * Closed valves are included but not traced through (unless you start there).
 */
export function traceDirectional<N extends TraceNode>(
  startNodeId: string,
  direction: "upstream" | "downstream",
  nodes: readonly N[],
  pipes: readonly TracePipe[],
): N[] {
  const byId = indexNodes(nodes);
  const adjacency = buildAdjacency(pipes);
  const distances = distancesFromSources(nodes, adjacency);

  const visited = new Set<string>([startNodeId]);
  const queue: string[] = [startNodeId];

  for (let head = 0; head < queue.length; head++) {
    const currentId = queue[head];
    if (currentId === undefined) continue;
    if (currentId !== startNodeId && isClosedValve(byId.get(currentId))) continue;

    const currentDistance = distances.get(currentId) ?? 0;
    for (const neighborId of adjacency.get(currentId) ?? []) {
      if (visited.has(neighborId)) continue;
      const movesTowardSource = (distances.get(neighborId) ?? 0) < currentDistance;
      if (direction === "upstream" ? movesTowardSource : !movesTowardSource) {
        visited.add(neighborId);
        queue.push(neighborId);
      }
    }
  }

  return pickNodes(visited, byId);
}
