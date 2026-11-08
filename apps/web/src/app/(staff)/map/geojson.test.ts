import { describe, expect, it } from "vitest";
import type { DmaDto, NodeDto, PipeDto } from "@/data/gis";
import { boundsOf, closeRing, dmasGeoJSON, draftFillGeoJSON, draftLineGeoJSON, EMPTY, pipesGeoJSON, traceGeoJSON } from "./geojson";

const node = (id: string, lat: number, lng: number): NodeDto =>
  ({ id, name: id, type: "junction", condition: "good", isOpen: null, location: { lat, lng } }) as NodeDto;
const pipe = (id: string, from: NodeDto, to: NodeDto): PipeDto =>
  ({ id, fromNodeId: from.id, toNodeId: to.id, path: [from.location, to.location], diameterMm: 100, material: "pvc", condition: "good", lengthM: 10 }) as PipeDto;

describe("map GeoJSON builders", () => {
  it("writes longitude first, as GeoJSON does", () => {
    const a = node("a", -1.2, 36.9);
    const b = node("b", -1.3, 36.95);
    const [feature] = pipesGeoJSON([pipe("p", a, b)]).features;
    expect(feature?.geometry).toEqual({ type: "LineString", coordinates: [[36.9, -1.2], [36.95, -1.3]] });
  });

  it("closes a polygon ring once, whether or not it arrives closed", () => {
    const open = [{ lat: 0, lng: 0 }, { lat: 0, lng: 1 }, { lat: 1, lng: 1 }];
    expect(closeRing(open)).toHaveLength(4);
    expect(closeRing(closeRing(open))).toHaveLength(4);
  });

  it("draws a DMA only when its boundary has three corners", () => {
    const dma = (ring: DmaDto["ring"]) => ({ id: "d", name: "D", color: "#3b82f6", ring }) as DmaDto;
    expect(dmasGeoJSON([dma([{ lat: 0, lng: 0 }, { lat: 0, lng: 1 }])]).features).toHaveLength(0);
    expect(dmasGeoJSON([dma([{ lat: 0, lng: 0 }, { lat: 0, lng: 1 }, { lat: 1, lng: 1 }])]).features).toHaveLength(1);
  });

  it("shows a draft as a line from two points and a fill from three", () => {
    const pts = [{ lat: 0, lng: 0 }, { lat: 0, lng: 1 }, { lat: 1, lng: 1 }];
    expect(draftLineGeoJSON(pts.slice(0, 1)).features).toHaveLength(0);
    expect(draftLineGeoJSON(pts.slice(0, 2)).features).toHaveLength(1);
    expect(draftFillGeoJSON(pts.slice(0, 2)).features).toHaveLength(0);
    expect(draftFillGeoJSON(pts).features).toHaveLength(1);
  });

  it("highlights a directional trace's pipes and marks where it started", () => {
    const a = node("a", 0, 0);
    const b = node("b", 0, 1);
    const c = node("c", 5, 5);
    const view = { mode: "downstream" as const, nodes: [a, b], startNodeId: "a" };
    const trace = traceGeoJSON(view, [pipe("ab", a, b), pipe("bc", b, c)]);
    const lines = trace.features.filter((f) => f.geometry.type === "LineString");
    expect(lines.map((f) => f.properties.id)).toEqual(["ab"]);
    expect(trace.features.filter((f) => f.properties.origin === true).map((f) => f.properties.id)).toEqual(["a"]);
    expect(traceGeoJSON(null, [])).toBe(EMPTY);
  });

  it("marks the failed pipe in an isolation trace", () => {
    const a = node("a", 0, 0);
    const b = node("b", 0, 1);
    const trace = traceGeoJSON({ mode: "isolation", nodes: [a, b], failedPipeId: "ab" }, [pipe("ab", a, b)]);
    expect(trace.features.find((f) => f.properties.id === "ab" && f.geometry.type === "LineString")?.properties.color).toBe("#ef4444");
  });

  it("frames points, and nothing", () => {
    expect(boundsOf([{ lat: 1, lng: 2 }, { lat: -1, lng: 5 }])).toEqual([[2, -1], [5, 1]]);
    expect(boundsOf([])).toBeNull();
  });
});
