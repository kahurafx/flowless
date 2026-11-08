/**
 * Kinds of network node, as Majimap's shared-types `NodeTypeSchema` lists them.
 * Kept here until the GIS module (Phase 2) owns a node-type catalogue.
 */
export const NODE_TYPES = ["reservoir", "pumping_station", "valve", "junction", "meter", "hydrant"] as const;
export type NodeType = (typeof NODE_TYPES)[number];

/**
 * The least a trace needs to know about a node. `NetworkNode`, the API's
 * `NodeDto`, and whatever the mobile app caches locally all satisfy this
 * structurally, so the same algorithms run on all three with no conversion —
 * and every function hands back the caller's own node objects, not copies.
 */
export interface TraceNode {
  id: string;
  type: NodeType;
  /** Only meaningful for valves. `null` means unknown, which traces treat as operable (open). */
  isOpen: boolean | null;
}

export interface TracePipe {
  id: string;
  fromNodeId: string;
  toNodeId: string;
}

/** Reservoirs and pumping stations are where water enters the network. */
export function isSource(node: TraceNode | undefined): boolean {
  return node?.type === "reservoir" || node?.type === "pumping_station";
}

export function isClosedValve(node: TraceNode | undefined): boolean {
  return node?.type === "valve" && node.isOpen === false;
}
