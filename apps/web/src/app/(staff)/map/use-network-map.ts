"use client";

import {
  Map as MapLibreMap,
  NavigationControl,
  ScaleControl,
  setWorkerUrl,
  type DataDrivenPropertyValueSpecification,
  type ExpressionSpecification,
  type FilterSpecification,
  type GeoJSONSource,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState, type RefObject } from "react";
import type { NodeType } from "@flowless/shared-types";
import {
  boundsOf,
  connectionsGeoJSON,
  dmasGeoJSON,
  draftFillGeoJSON,
  draftLineGeoJSON,
  draftPointsGeoJSON,
  EMPTY,
  nodesGeoJSON,
  pipesGeoJSON,
  structuresGeoJSON,
  traceGeoJSON,
  type Collection,
  type LatLng,
  type TraceView,
} from "./geojson";
import {
  BASEMAP,
  BASEMAP_PAINT,
  CONDITION_HEX,
  CONNECTION_HEX,
  DRAFT_HEX,
  NODE_RADIUS,
  NODE_STROKE,
  NODE_TYPES,
  SELECTED_HEX,
  STRUCTURE_HEX,
  TRACE_ORIGIN,
  WARNING_HEX,
} from "./map-config";
import type { ConnectionDto, DmaDto, NodeDto, PipeDto, StructureDto } from "@/data/gis";

// The worker ships as a file next to the page (next.config.ts copies it to /public/maplibre), because
// bundling it breaks under Turbopack.
setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");

export type FeatureKind = "node" | "pipe" | "structure" | "connection" | "dma";
export interface MapClick {
  feature: { kind: FeatureKind; id: string } | null;
  point: LatLng;
}

/** The layers a click can land on, nearest the viewer first. */
const CLICK_LAYERS: [string, FeatureKind][] = [
  ["nodes-circle", "node"],
  ["structures-circle", "structure"],
  ["connections-circle", "connection"],
  ["pipes-line", "pipe"],
  ["dmas-fill", "dma"],
];

export interface MapState {
  dark: boolean;
  nodes: readonly NodeDto[];
  pipes: readonly PipeDto[];
  structures: readonly StructureDto[];
  connections: readonly ConnectionDto[];
  dmas: readonly DmaDto[];
  visibleTypes: ReadonlySet<NodeType>;
  showStructures: boolean;
  showConnections: boolean;
  /** One DMA shown on its own: the nodes and pipes that belong to it. Null shows everything. */
  isolated: { dmaId: string; nodeIds: readonly string[]; pipeIds: readonly string[] } | null;
  selectedDmaId: string | null;
  trace: TraceView | null;
  /** Nodes to emphasise (a trace or a DMA's members) and nodes to flag (valves to close, strays). */
  emphasis: { ids: readonly string[]; warningIds: readonly string[] } | null;
  affectedConnectionIds: readonly string[];
  selected: { kind: FeatureKind; id: string } | null;
  drawing: { kind: "pipe" | "dma"; points: readonly LatLng[] } | null;
  crosshair: boolean;
  /** Changes when the view should move to `fit` (a trace result, a DMA, a branch). */
  fit: { key: string; points: readonly LatLng[]; maxZoom?: number } | null;
}

const conditionColor = ["match", ["get", "condition"], ...Object.entries(CONDITION_HEX).flatMap(([k, v]) => (k === "unknown" ? [] : [k, v])), CONDITION_HEX.unknown] as unknown as DataDrivenPropertyValueSpecification<string>;
const radius = (extra: number, fallback: number) =>
  ["match", ["get", "type"], ...NODE_TYPES.flatMap((t) => [t, NODE_RADIUS[t] + extra]), fallback] as unknown as DataDrivenPropertyValueSpecification<number>;

function addSources(map: MapLibreMap) {
  for (const id of ["dmas", "draft-fill", "draft-line", "draft-points", "pipes", "trace", "structures", "connections", "nodes", "selected"]) {
    map.addSource(id, { type: "geojson", data: EMPTY });
  }
}

function addLayers(map: MapLibreMap) {
  addSources(map);
  map.addLayer({ id: "dmas-fill", type: "fill", source: "dmas", paint: { "fill-color": ["get", "color"], "fill-opacity": 0.08 } });
  map.addLayer({ id: "dmas-line", type: "line", source: "dmas", paint: { "line-color": ["get", "color"], "line-width": 1 } });
  map.addLayer({ id: "draft-fill", type: "fill", source: "draft-fill", paint: { "fill-color": DRAFT_HEX, "fill-opacity": 0.15 } });
  map.addLayer({ id: "selected-line", type: "line", source: "selected", filter: ["==", ["geometry-type"], "LineString"], layout: { "line-cap": "round" }, paint: { "line-color": SELECTED_HEX, "line-width": 9, "line-opacity": 0.8 } });
  map.addLayer({
    id: "pipes-line",
    type: "line",
    source: "pipes",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-width": ["interpolate", ["linear"], ["get", "diameterMm"], 100, 2.5, 400, 5.5], "line-color": conditionColor },
  });
  map.addLayer({
    id: "trace-pipes",
    type: "line",
    source: "trace",
    filter: ["==", ["geometry-type"], "LineString"],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": ["get", "color"], "line-width": ["interpolate", ["linear"], ["get", "diameterMm"], 100, 4.5, 400, 8] },
  });
  map.addLayer({ id: "draft-line", type: "line", source: "draft-line", paint: { "line-color": DRAFT_HEX, "line-width": 2.5, "line-dasharray": [2, 1] } });
  map.addLayer({
    id: "structures-circle",
    type: "circle",
    source: "structures",
    paint: { "circle-radius": 6, "circle-color": "#ffffff", "circle-stroke-color": STRUCTURE_HEX, "circle-stroke-width": 2.5 },
  });
  map.addLayer({
    id: "connections-circle",
    type: "circle",
    source: "connections",
    layout: { visibility: "none" },
    paint: { "circle-radius": 3.5, "circle-color": CONNECTION_HEX.normal, "circle-stroke-color": NODE_STROKE, "circle-stroke-width": 1 },
  });
  map.addLayer({
    id: "nodes-circle",
    type: "circle",
    source: "nodes",
    paint: { "circle-radius": radius(0, 5), "circle-color": conditionColor, "circle-stroke-width": 1.5, "circle-stroke-color": NODE_STROKE, "circle-opacity": 1 },
  });
  map.addLayer({
    id: "trace-nodes",
    type: "circle",
    source: "trace",
    filter: ["==", ["geometry-type"], "Point"],
    paint: {
      "circle-radius": radius(1, 6),
      "circle-color": ["get", "color"],
      "circle-stroke-color": ["case", ["boolean", ["get", "origin"], false], TRACE_ORIGIN, NODE_STROKE],
      "circle-stroke-width": ["case", ["boolean", ["get", "origin"], false], 3.5, 1.5],
    },
  });
  map.addLayer({ id: "selected-point", type: "circle", source: "selected", filter: ["==", ["geometry-type"], "Point"], paint: { "circle-radius": 13, "circle-color": SELECTED_HEX, "circle-opacity": 0.25, "circle-stroke-color": SELECTED_HEX, "circle-stroke-width": 2.5 } });
  map.addLayer({ id: "draft-points", type: "circle", source: "draft-points", paint: { "circle-radius": 5, "circle-color": DRAFT_HEX, "circle-stroke-color": NODE_STROKE, "circle-stroke-width": 2 } });
}

const setData = (map: MapLibreMap, id: string, data: Collection) => (map.getSource(id) as GeoJSONSource | undefined)?.setData(data as unknown as Parameters<GeoJSONSource["setData"]>[0]);

function nodeFilter(types: ReadonlySet<NodeType>, isolatedIds: readonly string[] | null): FilterSpecification {
  const byType: ExpressionSpecification = types.size
    ? ["in", ["get", "type"], ["literal", [...types]]]
    : ["==", ["get", "type"], "__none__"];
  return isolatedIds ? ["all", byType, ["in", ["get", "id"], ["literal", [...isolatedIds]]]] : byType;
}

const SELECTED_NONE = "__none__";

/**
 * Owns the MapLibre instance for the network map: creates it once, adds the layers, and pushes the
 * state into sources, filters and paint properties. It decides nothing: every click is reported to
 * `onClick` with what was under it, and the component above decides what the tool in use does.
 */
export function useNetworkMap(container: RefObject<HTMLDivElement | null>, state: MapState, onClick: (click: MapClick) => void, center: LatLng) {
  const mapRef = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);
  // The latest handler, so the map's one click listener never goes stale.
  const clickRef = useRef(onClick);
  const stateRef = useRef(state);
  useEffect(() => {
    clickRef.current = onClick;
    stateRef.current = state;
  });

  useEffect(() => {
    if (!container.current || mapRef.current) return;
    const map = new MapLibreMap({
      container: container.current,
      style: BASEMAP,
      center: [center.lng, center.lat],
      zoom: 15,
      attributionControl: { compact: true },
      // Rotation is not useful on a network map and makes touch panning harder.
      dragRotate: false,
      touchPitch: false,
    });
    map.touchZoomRotate.disableRotation();
    map.addControl(new NavigationControl({ showCompass: false }), "top-right");
    map.addControl(new ScaleControl({ unit: "metric" }), "bottom-left");
    mapRef.current = map;

    map.on("load", () => {
      addLayers(map);
      setReady(true);
    });
    map.on("click", (e) => {
      // A fingertip is wider than a mouse pointer.
      const slop = window.matchMedia("(pointer: coarse)").matches ? 14 : 7;
      const box: [[number, number], [number, number]] = [
        [e.point.x - slop, e.point.y - slop],
        [e.point.x + slop, e.point.y + slop],
      ];
      let feature: MapClick["feature"] = null;
      for (const [layer, kind] of CLICK_LAYERS) {
        if (!map.getLayer(layer) || map.getLayoutProperty(layer, "visibility") === "none") continue;
        const hit = map.queryRenderedFeatures(box, { layers: [layer] })[0];
        const id = hit?.properties?.id as string | undefined;
        if (id) {
          feature = { kind, id };
          break;
        }
      }
      clickRef.current({ feature, point: { lat: e.lngLat.lat, lng: e.lngLat.lng } });
    });
    return () => {
      map.remove();
      mapRef.current = null;
      setReady(false);
    };
    // The map is created once; `center` is only its starting point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [container]);

  const { dark, nodes, pipes, structures, connections, dmas } = state;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const paint = BASEMAP_PAINT[dark ? "dark" : "light"];
    for (const [k, v] of Object.entries(paint)) map.setPaintProperty("basemap", k as "raster-opacity", v);
  }, [dark, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    setData(map, "nodes", nodesGeoJSON(nodes));
    setData(map, "pipes", pipesGeoJSON(pipes));
    setData(map, "structures", structuresGeoJSON(structures));
    setData(map, "connections", connectionsGeoJSON(connections));
    setData(map, "dmas", dmasGeoJSON(dmas));
  }, [nodes, pipes, structures, connections, dmas, ready]);

  const { visibleTypes, isolated, showStructures, showConnections, selectedDmaId } = state;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    map.setFilter("nodes-circle", nodeFilter(visibleTypes, isolated?.nodeIds ?? null));
    map.setFilter("pipes-line", isolated ? ["in", ["get", "id"], ["literal", [...isolated.pipeIds]]] : null);
    const dmaFilter: FilterSpecification | null = isolated ? ["==", ["get", "id"], isolated.dmaId] : null;
    map.setFilter("dmas-fill", dmaFilter);
    map.setFilter("dmas-line", dmaFilter);
    map.setLayoutProperty("structures-circle", "visibility", showStructures ? "visible" : "none");
    map.setLayoutProperty("connections-circle", "visibility", showConnections ? "visible" : "none");
    const sel = selectedDmaId ?? SELECTED_NONE;
    map.setPaintProperty("dmas-fill", "fill-opacity", ["case", ["==", ["get", "id"], sel], 0.22, 0.08]);
    map.setPaintProperty("dmas-line", "line-width", ["case", ["==", ["get", "id"], sel], 3, 1.2]);
  }, [visibleTypes, isolated, showStructures, showConnections, selectedDmaId, ready]);

  const { trace, emphasis, affectedConnectionIds } = state;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    setData(map, "trace", traceGeoJSON(trace, pipes));
    const ids = emphasis?.ids ?? [];
    const warn = emphasis?.warningIds ?? [];
    const opacity: DataDrivenPropertyValueSpecification<number> = ids.length ? ["case", ["in", ["get", "id"], ["literal", [...ids]]], 1, 0.2] : 1;
    map.setPaintProperty("nodes-circle", "circle-opacity", opacity);
    map.setPaintProperty("nodes-circle", "circle-stroke-opacity", opacity);
    map.setPaintProperty("pipes-line", "line-opacity", trace ? 0.3 : 1);
    map.setPaintProperty("nodes-circle", "circle-stroke-color", warn.length ? ["case", ["in", ["get", "id"], ["literal", [...warn]]], WARNING_HEX, NODE_STROKE] : NODE_STROKE);
    map.setPaintProperty("nodes-circle", "circle-stroke-width", warn.length ? ["case", ["in", ["get", "id"], ["literal", [...warn]]], 3.5, 1.5] : 1.5);
    const hit: ExpressionSpecification = ["in", ["get", "id"], ["literal", [...affectedConnectionIds]]];
    map.setPaintProperty("connections-circle", "circle-color", affectedConnectionIds.length ? ["case", hit, CONNECTION_HEX.affected, CONNECTION_HEX.normal] : CONNECTION_HEX.normal);
    map.setPaintProperty("connections-circle", "circle-radius", affectedConnectionIds.length ? ["case", hit, 6, 3.5] : 3.5);
  }, [trace, emphasis, affectedConnectionIds, pipes, ready]);

  const { selected, drawing, crosshair, fit } = state;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const found =
      selected?.kind === "node"
        ? nodesGeoJSON(nodes.filter((n) => n.id === selected.id))
        : selected?.kind === "pipe"
          ? pipesGeoJSON(pipes.filter((p) => p.id === selected.id))
          : selected?.kind === "structure"
            ? structuresGeoJSON(structures.filter((s) => s.id === selected.id))
            : selected?.kind === "connection"
              ? connectionsGeoJSON(connections.filter((c) => c.id === selected.id))
              : EMPTY;
    setData(map, "selected", found);
  }, [selected, nodes, pipes, structures, connections, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const points = drawing?.points ?? [];
    setData(map, "draft-points", draftPointsGeoJSON(points));
    setData(map, "draft-line", draftLineGeoJSON(drawing?.kind === "dma" && points.length >= 3 ? [...points, points[0]!] : points));
    setData(map, "draft-fill", drawing?.kind === "dma" ? draftFillGeoJSON(points) : EMPTY);
  }, [drawing, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (map) map.getCanvas().style.cursor = crosshair ? "crosshair" : "";
  }, [crosshair, ready]);

  const fitKey = fit?.key;
  useEffect(() => {
    const map = mapRef.current;
    const target = stateRef.current.fit;
    if (!map || !ready || !target) return;
    const bounds = boundsOf(target.points);
    if (!bounds) return;
    // One or two points would otherwise zoom past any basemap detail.
    map.fitBounds(bounds, { padding: { top: 72, bottom: 72, left: 48, right: 48 }, duration: 600, maxZoom: target.maxZoom ?? 17 });
  }, [fitKey, ready]);

  return { mapRef, ready };
}
