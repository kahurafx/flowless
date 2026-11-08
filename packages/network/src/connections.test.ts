import { describe, expect, it } from "vitest";
import { nearestPipe } from "./geo";
import { affectedConnections } from "./isolation";
import { node, pipe, valve } from "./test-fixtures";

/**
 * R ── A ── V1 ── B ── V2 ── C ── D
 * A pipe break between V1 and V2 shuts B's section. C and D sit beyond V2, with no other way to the reservoir.
 */
const nodes = (v1: boolean | null = true, v2: boolean | null = true) => [
  node("R", "reservoir"),
  node("A", "junction"),
  valve("V1", v1),
  node("B", "junction"),
  valve("V2", v2),
  node("C", "junction"),
  node("D", "junction"),
];
const pipes = [pipe("p1", "R", "A"), pipe("p2", "A", "V1"), pipe("p3", "V1", "B"), pipe("p4", "B", "V2"), pipe("p5", "V2", "C"), pipe("p6", "C", "D")];
const on = (id: string, pipeId: string | null) => ({ id, pipeId });
const ids = (list: { id: string }[]) => list.map((c) => c.id).sort();

describe("affectedConnections", () => {
  it("separates the shut section from what's cut off beyond it", () => {
    const r = affectedConnections("p3", nodes(), pipes, [on("upstream", "p1"), on("section", "p4"), on("beyond", "p6")]);
    expect(ids(r.onSection)).toStrictEqual(["section"]);
    expect(ids(r.alsoLosingSupply)).toStrictEqual(["beyond"]);
    expect(r.supplyKnown).toBe(true);
  });

  it("keeps supply for whoever still has another way round", () => {
    const looped = [...pipes, pipe("loop", "A", "C")];
    const r = affectedConnections("p3", nodes(), looped, [on("beyond", "p6")]);
    expect(r.alsoLosingSupply).toStrictEqual([]);
  });

  it("widens both groups when a valve won't turn", () => {
    const connections = [on("a", "p2"), on("section", "p4"), on("beyond", "p6")];
    const normal = affectedConnections("p3", nodes(), pipes, connections);
    expect(!ids(normal.onSection).includes("beyond")).toBeTruthy();
    const skipped = affectedConnections("p3", nodes(), pipes, connections, ["V2"]);
    expect(ids(skipped.onSection), "with V2 stuck open, the shut section runs on past it").toStrictEqual(["beyond", "section"]);
  });

  it("doesn't blame the break for someone already behind a closed valve", () => {
    const r = affectedConnections("p3", nodes(true, false), pipes, [on("alreadyDry", "p6")]);
    expect(r.alsoLosingSupply).toStrictEqual([]);
  });

  it("says so when there's no source to judge from, rather than guessing", () => {
    const noSource = nodes().filter((n) => n.type !== "reservoir");
    const r = affectedConnections("p3", noSource, pipes.slice(1), [on("section", "p4"), on("beyond", "p6")]);
    expect(r.supplyKnown).toBe(false);
    expect(ids(r.onSection)).toStrictEqual(["section"]);
    expect(r.alsoLosingSupply).toStrictEqual([]);
  });

  it("counts connections it can't judge instead of leaving them out silently", () => {
    const r = affectedConnections("p3", nodes(), pipes, [on("nolink", null), on("gone", "deleted-pipe"), on("section", "p4")]);
    expect(r.unlinkedCount).toBe(2);
    expect(ids(r.onSection)).toStrictEqual(["section"]);
  });

  it("finds nothing for a pipe that doesn't exist, but still counts the unlinked", () => {
    const r = affectedConnections("nope", nodes(), pipes, [on("a", "p1"), on("nolink", null)]);
    expect(r.onSection).toStrictEqual([]);
    expect(r.unlinkedCount).toBe(1);
  });
});

describe("nearestPipe", () => {
  const west = { id: "west", path: [{ lat: 0, lng: 0 }, { lat: 0.01, lng: 0 }] };
  const east = { id: "east", path: [{ lat: 0, lng: 0.001 }, { lat: 0.01, lng: 0.001 }] };

  it("measures to the line, not just its ends", () => {
    const hit = nearestPipe({ lat: 0.005, lng: 0.0001 }, [west, east]);
    expect(hit?.pipeId).toBe("west");
    expect(hit && hit.distanceM > 10 && hit.distanceM < 12, `about 11 m, got ${hit?.distanceM}`).toBeTruthy();
  });

  it("suggests nothing when every pipe is too far", () => {
    expect(nearestPipe({ lat: 0.005, lng: 0.01 }, [west, east])).toBe(null);
  });

  it("copes with no pipes and with a zero-length segment", () => {
    expect(nearestPipe({ lat: 0, lng: 0 }, [])).toBe(null);
    const dot = { id: "dot", path: [{ lat: 0, lng: 0 }, { lat: 0, lng: 0 }] };
    expect(nearestPipe({ lat: 0, lng: 0 }, [dot])?.pipeId).toBe("dot");
  });
});
