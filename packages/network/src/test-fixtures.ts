import type { NodeType } from "./types";
import type { TraceNode, TracePipe } from "./types";

export const node = (id: string, type: NodeType, isOpen: boolean | null = null): TraceNode => ({ id, type, isOpen });
export const valve = (id: string, isOpen: boolean | null = true): TraceNode => node(id, "valve", isOpen);
export const pipe = (id: string, from: string, to: string): TracePipe => ({ id, fromNodeId: from, toNodeId: to });

/** Sorted ids — traces return nodes in visit order, which tests shouldn't depend on. */
export const ids = (nodes: readonly { id: string }[]) => nodes.map((n) => n.id).sort();

/**
 *   R ── A ── V ── B ── C
 * reservoir, junction, valve, junction, meter. Pipes p1..p4 left to right.
 */
export function line(valveIsOpen: boolean | null = true) {
  return {
    nodes: [node("R", "reservoir"), node("A", "junction"), valve("V", valveIsOpen), node("B", "junction"), node("C", "meter")],
    pipes: [pipe("p1", "R", "A"), pipe("p2", "A", "V"), pipe("p3", "V", "B"), pipe("p4", "B", "C")],
  };
}

/**
 *   R ── V1 ── A ── V2 ── B ── C
 * Two valves in series. Pipes q1..q5 left to right.
 */
export function twoValves(v1IsOpen: boolean | null = true, v2IsOpen: boolean | null = true) {
  return {
    nodes: [
      node("R", "reservoir"),
      valve("V1", v1IsOpen),
      node("A", "junction"),
      valve("V2", v2IsOpen),
      node("B", "junction"),
      node("C", "meter"),
    ],
    pipes: [pipe("q1", "R", "V1"), pipe("q2", "V1", "A"), pipe("q3", "A", "V2"), pipe("q4", "V2", "B"), pipe("q5", "B", "C")],
  };
}

/**
 *   R feeds A; A–B, B–C, C–A form a loop.
 * Hop distance from R: R=0, A=1, B=2, C=2.
 */
export function ring() {
  return {
    nodes: [node("R", "reservoir"), node("A", "junction"), node("B", "junction"), node("C", "junction")],
    pipes: [pipe("r1", "R", "A"), pipe("r2", "A", "B"), pipe("r3", "B", "C"), pipe("r4", "C", "A")],
  };
}
