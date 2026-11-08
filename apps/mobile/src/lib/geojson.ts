import type { AppNode, Connection, Dma, LatLng, Pipe } from "./types";

export const nodesGeoJSON = (nodes: readonly AppNode[]) => ({
  type: "FeatureCollection" as const,
  features: nodes.map((n) => ({
    type: "Feature" as const,
    geometry: { type: "Point" as const, coordinates: [n.location.lng, n.location.lat] },
    properties: { id: n.id, name: n.name, type: n.type, condition: n.condition, isOpen: n.isOpen },
  })),
});

export const pipesGeoJSON = (pipes: readonly Pipe[]) => ({
  type: "FeatureCollection" as const,
  features: pipes.map((p) => ({
    type: "Feature" as const,
    geometry: { type: "LineString" as const, coordinates: p.path.map((pt) => [pt.lng, pt.lat]) },
    properties: { id: p.id, material: p.material, diameterMm: p.diameterMm, condition: p.condition, lengthM: p.lengthM },
  })),
});

export const connectionsGeoJSON = (connections: readonly Pick<Connection, "id" | "connectionNumber" | "location">[]) => ({
  type: "FeatureCollection" as const,
  features: connections.map((c) => ({
    type: "Feature" as const,
    geometry: { type: "Point" as const, coordinates: [c.location.lng, c.location.lat] },
    properties: { id: c.id, connectionNumber: c.connectionNumber },
  })),
});

export const dmasGeoJSON = (dmas: readonly Dma[]) => ({
  type: "FeatureCollection" as const,
  features: dmas.map((d) => {
    const ring = d.ring.map((p) => [p.lng, p.lat]);
    const first = ring[0];
    const last = ring[ring.length - 1];
    const closed = first && last && first[0] === last[0] && first[1] === last[1] ? ring : first ? [...ring, first] : ring;
    return { type: "Feature" as const, geometry: { type: "Polygon" as const, coordinates: [closed] }, properties: { id: d.id, name: d.name, color: d.color } };
  }),
});

/** The selected node, or nothing. Drives the halo under the node layer. */
export const selectionGeoJSON = (node: AppNode | null) => ({
  type: "FeatureCollection" as const,
  features: node ? [{ type: "Feature" as const, geometry: { type: "Point" as const, coordinates: [node.location.lng, node.location.lat] }, properties: { id: node.id } }] : [],
});

/** [west, south, east, north], widened a little so a single point still has an area to fit. */
export function boundsOf(points: readonly LatLng[]): [number, number, number, number] | null {
  if (points.length === 0) return null;
  const lngs = points.map((p) => p.lng);
  const lats = points.map((p) => p.lat);
  let [w, s, e, n] = [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)];
  if (e - w < 0.001) {
    w -= 0.0005;
    e += 0.0005;
  }
  if (n - s < 0.001) {
    s -= 0.0005;
    n += 0.0005;
  }
  return [w, s, e, n];
}
