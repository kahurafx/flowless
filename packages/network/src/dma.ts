import { traceDirectional } from "./directional";
import { pointInRing, type LatLng } from "./geo";
import type { TraceNode, TracePipe } from "./types";

export type DmaForMembership = {
  inletMeterId: string;
  /** The DMA's polygon. May be open or closed. */
  ring: readonly LatLng[];
  boundaryValveIds: readonly string[];
};

export type DmaMembership = {
  /** Fed from the inlet meter, following the network downstream. */
  tracedIds: string[];
  /** Inside the polygon. */
  insideIds: string[];
  /** Traced or inside: everything that belongs on screen when the DMA is shown on its own. */
  memberIds: string[];
  /** Traced but outside the polygon. The usual cause is a boundary valve that's open. */
  outsideBoundary: string[];
  /** Inside the polygon but not fed from the inlet. */
  insideNotTraced: string[];
  /** Boundary valves that aren't closed. An unknown state counts as open: nobody has confirmed it shut. */
  openBoundaryValveIds: string[];
  sealed: boolean;
};

/**
 * What a DMA actually contains, compared with what it was drawn to contain. It traces downstream only, because a DMA
 * is what its meter feeds: tracing both ways would pull the whole upstream supply network into every DMA. One function
 * so the server, the DMA page and the map can't count differently. All id lists are sorted.
 */
export function dmaMembership<N extends TraceNode & { location: LatLng }>(
  dma: DmaForMembership,
  nodes: readonly N[],
  pipes: readonly TracePipe[],
): DmaMembership {
  const byId = new Map(nodes.map((n): [string, N] => [n.id, n]));
  const traced = new Set(traceDirectional(dma.inletMeterId, "downstream", nodes, pipes).map((n) => n.id));
  const inside = new Set(nodes.filter((n) => pointInRing(n.location, dma.ring)).map((n) => n.id));
  const outsideBoundary = [...traced].filter((id) => !inside.has(id)).sort();
  const openBoundaryValveIds = dma.boundaryValveIds.filter((id) => byId.get(id)?.isOpen !== false).sort();
  return {
    tracedIds: [...traced].sort(),
    insideIds: [...inside].sort(),
    memberIds: [...new Set([...traced, ...inside])].sort(),
    outsideBoundary,
    insideNotTraced: [...inside].filter((id) => !traced.has(id)).sort(),
    openBoundaryValveIds,
    sealed: outsideBoundary.length === 0 && openBoundaryValveIds.length === 0,
  };
}
