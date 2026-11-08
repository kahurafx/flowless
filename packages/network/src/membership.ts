import { buildAdjacency, indexNodes, pickNodes } from "./graph";
import { isClosedValve, type TraceNode, type TracePipe } from "./types";

/**
 * Everything reachable from a controller node without passing through a
 * closed valve. A closed valve is a member of the subnetwork you can see it
 * from, but nothing beyond it is reachable through it. (A closed valve used
 * as the controller itself still spreads both ways — it's where you started.)
 *
 * Breadth-first with an index pointer rather than `queue.shift()`, which is
 * O(n) per call and made the whole trace quadratic on a large network.
 */
export function traceSubnetworkMembership<N extends TraceNode>(
  controllerId: string,
  nodes: readonly N[],
  pipes: readonly TracePipe[],
): N[] {
  const byId = indexNodes(nodes);
  const adjacency = buildAdjacency(pipes);

  const visited = new Set<string>([controllerId]);
  const queue: string[] = [controllerId];

  for (let head = 0; head < queue.length; head++) {
    const currentId = queue[head];
    if (currentId === undefined) continue;
    if (currentId !== controllerId && isClosedValve(byId.get(currentId))) continue;

    for (const neighborId of adjacency.get(currentId) ?? []) {
      if (visited.has(neighborId)) continue;
      visited.add(neighborId);
      queue.push(neighborId);
    }
  }

  return pickNodes(visited, byId);
}
