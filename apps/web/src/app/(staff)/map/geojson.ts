import { tracePipeIds } from "@flowless/network";
import type { ConnectionDto, DmaDto, NodeDto, PipeDto, StructureDto } from "@/data/gis";
import { TRACE_HEX, WARNING_HEX, type TraceMode } from "./map-config";

/*
 * Pure builders from the API's network to GeoJSON, one per map source. Kept free of MapLibre
 * so they can be tested and so the map component only moves data into sources.
 */

export interface LatLng {
  lat: number;
  lng: number;
}
type Position = [number, number];
interface Feature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: Position } | { type: "LineString"; coordinates: Position[] } | { type: "Polygon"; coordinates: Position[][] };
  properties: Record<string, unknown>;
}
export interface Collection {
  type: "FeatureCollection";
  features: Feature[];
}

export const EMPTY: Collection = { type: "FeatureCollection", features: [] };
const collection = (features: Feature[]): Collection => ({ type: "FeatureCollection", features });
const lngLat = (p: LatLng): Position => [p.lng, p.lat];
const point = (p: LatLng, properties: Record<string, unknown>): Feature => ({ type: "Feature", geometry: { type: "Point", coordinates: lngLat(p) }, properties });
const line = (path: readonly LatLng[], properties: Record<string, unknown>): Feature => ({ type: "Feature", geometry: { type: "LineString", coordinates: path.map(lngLat) }, properties });

export const nodesGeoJSON = (nodes: readonly NodeDto[]): Collection =>
  collection(nodes.map((n) => point(n.location, { id: n.id, name: n.name, type: n.type, condition: n.condition, isOpen: n.isOpen })));

export const pipesGeoJSON = (pipes: readonly PipeDto[]): Collection =>
  collection(pipes.map((p) => line(p.path, { id: p.id, material: p.material, diameterMm: p.diameterMm, condition: p.condition, lengthM: p.lengthM })));

export const structuresGeoJSON = (structures: readonly StructureDto[]): Collection =>
  collection(structures.map((s) => point(s.location, { id: s.id, name: s.name, type: s.type, condition: s.condition })));

export const connectionsGeoJSON = (connections: readonly ConnectionDto[]): Collection =>
  collection(connections.map((c) => point(c.location, { id: c.id, connectionNumber: c.connectionNumber })));

/** A polygon ring must be closed. */
export function closeRing(ring: readonly LatLng[]): LatLng[] {
  const first = ring[0];
  const last = ring[ring.length - 1];
  return first && last && (first.lat !== last.lat || first.lng !== last.lng) ? [...ring, first] : [...ring];
}

export const dmasGeoJSON = (dmas: readonly DmaDto[]): Collection =>
  collection(
    dmas
      .filter((d) => d.ring.length >= 3)
      .map((d) => ({ type: "Feature", geometry: { type: "Polygon", coordinates: [closeRing(d.ring).map(lngLat)] }, properties: { id: d.id, name: d.name, color: d.color } })),
  );

/** The shape being drawn: a line from two points, a fill from three. */
export const draftLineGeoJSON = (points: readonly LatLng[]): Collection => collection(points.length >= 2 ? [line(points, {})] : []);
export const draftFillGeoJSON = (points: readonly LatLng[]): Collection =>
  collection(points.length >= 3 ? [{ type: "Feature", geometry: { type: "Polygon", coordinates: [closeRing(points).map(lngLat)] }, properties: {} }] : []);
export const draftPointsGeoJSON = (points: readonly LatLng[]): Collection => collection(points.map((p, i) => point(p, { index: i })));

export interface TraceView {
  mode: TraceMode;
  /** Nodes the trace reached (directional: upstream or downstream of the start; isolation: those that lose supply). */
  nodes: readonly NodeDto[];
  startNodeId?: string;
  failedPipeId?: string;
}

/** A trace's result as its own layer, over the network, so clearing it leaves the network's colours alone. */
export function traceGeoJSON(view: TraceView | null, pipes: readonly PipeDto[]): Collection {
  if (!view) return EMPTY;
  if (view.mode === "isolation") {
    const reached = new Set(tracePipeIds(view.nodes.map((n) => n.id), pipes));
    if (view.failedPipeId) reached.add(view.failedPipeId);
    return collection([
      ...pipes.filter((p) => reached.has(p.id)).map((p) => line(p.path, { id: p.id, color: p.id === view.failedPipeId ? WARNING_HEX : "#f59e0b", diameterMm: p.diameterMm })),
      ...view.nodes.map((n) => point(n.location, { id: n.id, type: n.type, color: "#f59e0b", origin: false })),
    ]);
  }
  const color = TRACE_HEX[view.mode];
  const ids = new Set(tracePipeIds(view.nodes.map((n) => n.id), pipes));
  return collection([
    ...pipes.filter((p) => ids.has(p.id)).map((p) => line(p.path, { id: p.id, color, diameterMm: p.diameterMm })),
    ...view.nodes.map((n) => point(n.location, { id: n.id, type: n.type, color, origin: n.id === view.startNodeId })),
  ]);
}

/** Bounds of some points as [[west, south], [east, north]], or null when there are none. */
export function boundsOf(points: readonly LatLng[]): [[number, number], [number, number]] | null {
  if (points.length === 0) return null;
  const lngs = points.map((p) => p.lng);
  const lats = points.map((p) => p.lat);
  return [
    [Math.min(...lngs), Math.min(...lats)],
    [Math.max(...lngs), Math.max(...lats)],
  ];
}
