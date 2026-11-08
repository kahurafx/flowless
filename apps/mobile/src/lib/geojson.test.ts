import { describe, expect, it } from "vitest";
import { boundsOf, dmasGeoJSON } from "./geojson";
import type { Dma } from "./types";

describe("geojson", () => {
  it("widens the bounds of a single point so it has an area to fit", () => {
    const [w, s, e, n] = boundsOf([{ lat: -1.29, lng: 36.78 }])!;
    expect(e - w).toBeGreaterThanOrEqual(0.001);
    expect(n - s).toBeGreaterThanOrEqual(0.001);
    expect(boundsOf([])).toBeNull();
  });

  it("closes a DMA ring", () => {
    const ring = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 1 },
      { lat: 1, lng: 1 },
    ];
    const [feature] = dmasGeoJSON([{ id: "d", name: "D", color: "#fff", ring } as Dma]).features;
    const coords = (feature!.geometry as { coordinates: number[][][] }).coordinates[0]!;
    expect(coords[0]).toEqual(coords[coords.length - 1]);
    expect(coords).toHaveLength(4);
  });
});
