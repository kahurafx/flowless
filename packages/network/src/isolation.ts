import { buildAdjacency, indexNodes, pickNodes } from "./graph";
import { isClosedValve, isSource, type TraceNode, type TracePipe } from "./types";

export type IsolationTraceResult<N extends TraceNode = TraceNode> = {
  /** Everything that loses supply: the failed pipe's own ends, plus whatever they reach before a valve. */
  affectedNodes: N[];
  /** Open valves bounding the affected area — what an operator has to close. */
  valvesToClose: N[];
  /** Valves bounding the area that are already closed; they isolate it with no action needed. */
  alreadyClosed: N[];
  /**
   * Supply sources (reservoirs, pumping stations) connected to the break with
   * no valve in between. If this isn't empty the break can't be isolated from
   * supply by closing valves — the source itself would have to be shut.
   */
  unisolatedSources: N[];
};

/**
 * From a failed pipe, flood outward both ways, stopping at the first valve on
 * each path. Open valves are what to close; closed ones already isolate.
 *
 * `skipValveIds` is "that valve won't operate — route around it": a skipped
 * open valve is traced straight through, so the trace continues to the next
 * valve beyond it. A closed valve stops the trace regardless of being skipped,
 * since it isn't relying on being operated.
 *
 * This is only the section being shut. Who else loses supply once it's shut is
 * `affectedConnections`, which asks what can still reach a source.
 */
export function traceIsolation<N extends TraceNode>(
  failedPipeId: string,
  nodes: readonly N[],
  pipes: readonly TracePipe[],
  skipValveIds: readonly string[] = [],
): IsolationTraceResult<N> {
  const pipe = pipes.find((p) => p.id === failedPipeId);
  if (!pipe) return { affectedNodes: [], valvesToClose: [], alreadyClosed: [], unisolatedSources: [] };

  const byId = indexNodes(nodes);
  const adjacency = buildAdjacency(pipes);
  const skipped = new Set(skipValveIds);

  const visited = new Set<string>([pipe.fromNodeId, pipe.toNodeId]);
  const valvesToClose = new Set<string>();
  const alreadyClosed = new Set<string>();
  const queue: string[] = [...visited];

  for (let head = 0; head < queue.length; head++) {
    const currentId = queue[head];
    if (currentId === undefined) continue;
    const current = byId.get(currentId);

    if (current?.type === "valve") {
      if (isClosedValve(current)) {
        alreadyClosed.add(currentId);
        continue;
      }
      if (!skipped.has(currentId)) {
        valvesToClose.add(currentId);
        continue;
      }
    }

    for (const neighborId of adjacency.get(currentId) ?? []) {
      if (visited.has(neighborId)) continue;
      visited.add(neighborId);
      queue.push(neighborId);
    }
  }

  const inside = [...visited].filter((id) => !valvesToClose.has(id) && !alreadyClosed.has(id));
  return {
    affectedNodes: pickNodes(inside, byId),
    valvesToClose: pickNodes(valvesToClose, byId),
    alreadyClosed: pickNodes(alreadyClosed, byId),
    unisolatedSources: pickNodes(
      inside.filter((id) => isSource(byId.get(id))),
      byId,
    ),
  };
}

export interface TraceConnection {
  id: string;
  /** The pipe serving it. Null means nobody has linked it, so a break can't be judged for it. */
  pipeId: string | null;
}

export type AffectedConnections<C extends TraceConnection> = {
  /** On the section being shut: the water is off where they are. */
  onSection: C[];
  /** Elsewhere, but with no path left to a source once the valves close. */
  alsoLosingSupply: C[];
  /** False when the data has no reservoirs or pumping stations, so `alsoLosingSupply` can't be worked out and is empty. */
  supplyKnown: boolean;
  /** Connections with no pipe (or a pipe that isn't in this view). They might be affected; nobody can say. */
  unlinkedCount: number;
};

/** Nodes water can reach from any source: through open valves, along these pipes, starting outside `excluded`. */
function nodesWithSupply(nodes: readonly TraceNode[], pipes: readonly TracePipe[], blocked: ReadonlySet<string>, excluded: ReadonlySet<string>): Set<string> {
  const adjacency = buildAdjacency(pipes);
  const byId = indexNodes(nodes);
  const fed = new Set<string>();
  const queue = nodes.filter((n) => isSource(n) && !excluded.has(n.id)).map((n) => n.id);
  for (const id of queue) fed.add(id);
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head];
    if (current === undefined) continue;
    for (const neighbor of adjacency.get(current) ?? []) {
      if (fed.has(neighbor) || blocked.has(neighbor) || isClosedValve(byId.get(neighbor))) continue;
      fed.add(neighbor);
      queue.push(neighbor);
    }
  }
  return fed;
}

/**
 * Who a break on this pipe affects. This asks "is there still a path to a source?", not "is the pressure adequate?",
 * so someone left on a long way round may still get low pressure: `alsoLosingSupply` is a minimum. It relies on recorded
 * valve states, and an unknown state counts as open, as everywhere else. Someone already cut off before the break
 * isn't counted, because the break isn't why they have no water.
 */
export function affectedConnections<C extends TraceConnection>(
  failedPipeId: string,
  nodes: readonly TraceNode[],
  pipes: readonly TracePipe[],
  connections: readonly C[],
  skipValveIds: readonly string[] = [],
): AffectedConnections<C> {
  const isolation = traceIsolation(failedPipeId, nodes, pipes, skipValveIds);
  const inside = new Set(isolation.affectedNodes.map((n) => n.id));
  const known = new Set(pipes.map((p) => p.id));

  const shutPipes = new Set(pipes.filter((p) => p.id === failedPipeId || inside.has(p.fromNodeId) || inside.has(p.toNodeId)).map((p) => p.id));
  const valvesToClose = new Set(isolation.valvesToClose.map((n) => n.id));
  const remaining = pipes.filter((p) => !shutPipes.has(p.id));

  const supplyKnown = nodes.some(isSource);
  const fedBefore = nodesWithSupply(nodes, pipes, new Set(), new Set());
  const fedAfter = nodesWithSupply(nodes, remaining, valvesToClose, inside);
  const hasSupply = (fed: ReadonlySet<string>, pipe: TracePipe) => fed.has(pipe.fromNodeId) || fed.has(pipe.toNodeId);
  const pipeById = new Map(pipes.map((p) => [p.id, p]));

  const onSection: C[] = [];
  const alsoLosingSupply: C[] = [];
  let unlinkedCount = 0;
  for (const connection of connections) {
    if (!connection.pipeId || !known.has(connection.pipeId)) {
      unlinkedCount++;
    } else if (shutPipes.has(connection.pipeId)) {
      onSection.push(connection);
    } else if (supplyKnown) {
      const pipe = pipeById.get(connection.pipeId)!;
      if (hasSupply(fedBefore, pipe) && !hasSupply(fedAfter, pipe)) alsoLosingSupply.push(connection);
    }
  }
  return { onSection, alsoLosingSupply, supplyKnown, unlinkedCount };
}
