import { describe, expect, it } from "vitest";
import { dmaMembership } from "./dma";
import { tracePipeIds } from "./graph";
import { node, pipe, valve } from "./test-fixtures";

/** R ── M ── A ── V ── B, in a line along lng 0..4. The DMA's polygon covers lng 0.5..2.5, so M and A. */
const at = (lng: number) => ({ location: { lat: 0, lng } });
const nodes = (valveOpen: boolean | null) => [
  { ...node("R", "reservoir"), ...at(0) },
  { ...node("M", "meter"), ...at(1) },
  { ...node("A", "junction"), ...at(2) },
  { ...valve("V", valveOpen), ...at(3) },
  { ...node("B", "junction"), ...at(4) },
  { ...node("X", "junction"), location: { lat: 0.5, lng: 2 } },
];
const pipes = [pipe("p1", "R", "M"), pipe("p2", "M", "A"), pipe("p3", "A", "V"), pipe("p4", "V", "B")];
const dma = {
  inletMeterId: "M",
  boundaryValveIds: ["V"],
  ring: [{ lat: -1, lng: 0.5 }, { lat: -1, lng: 2.5 }, { lat: 1, lng: 2.5 }, { lat: 1, lng: 0.5 }],
};

describe("dmaMembership", () => {
  it("traces downstream only, so the supply side stays out", () => {
    const m = dmaMembership(dma, nodes(false), pipes);
    expect(!m.tracedIds.includes("R")).toBeTruthy();
    expect(m.tracedIds).toStrictEqual(["A", "M", "V"]);
  });

  it("reports what escapes through an open boundary valve", () => {
    const m = dmaMembership(dma, nodes(true), pipes);
    expect(m.outsideBoundary).toStrictEqual(["B", "V"]);
    expect(m.openBoundaryValveIds).toStrictEqual(["V"]);
    expect(m.sealed).toBe(false);
  });

  it("counts a valve in an unknown state as open", () => {
    expect(dmaMembership(dma, nodes(null), pipes).openBoundaryValveIds).toStrictEqual(["V"]);
  });

  it("shows members whether traced or only inside the polygon", () => {
    const m = dmaMembership(dma, nodes(false), pipes);
    expect(m.insideNotTraced).toStrictEqual(["X"]);
    expect(m.memberIds).toStrictEqual(["A", "M", "V", "X"]);
  });
});

describe("tracePipeIds", () => {
  it("keeps pipes with both ends in the set", () => {
    expect(tracePipeIds(["M", "A", "V"], pipes)).toStrictEqual(["p2", "p3"]);
  });
  it("returns nothing for an empty set", () => {
    expect(tracePipeIds([], pipes)).toStrictEqual([]);
  });
});
