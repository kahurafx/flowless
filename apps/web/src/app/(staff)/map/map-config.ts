import { NODE_TYPES, type AssetCondition, type NodeType } from "@flowless/shared-types";
import type { StyleSpecification } from "maplibre-gl";

/*
 * Map constants. MapLibre paints with literal colours (no CSS variables), so these are hex
 * values chosen to read on both the light and the dimmed basemap and to stay distinguishable
 * for common colour-vision differences (condition also changes line style in the legend).
 */

export const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors';

/** OpenStreetMap's raster tiles: free, no key. Fine for staff use; a production tile source is a deployment choice. */
export const BASEMAP: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      maxzoom: 19,
      attribution: OSM_ATTRIBUTION,
    },
  },
  layers: [{ id: "basemap", type: "raster", source: "osm" }],
};

/** The basemap in dark mode: dimmed and desaturated instead of a second tile set. */
export const BASEMAP_PAINT = {
  light: { "raster-brightness-max": 1, "raster-saturation": -0.15, "raster-contrast": 0 },
  dark: { "raster-brightness-max": 0.42, "raster-saturation": -0.7, "raster-contrast": 0.15 },
} as const;

export const CONDITION_HEX: Record<AssetCondition, string> = {
  good: "#16a34a",
  fair: "#eab308",
  poor: "#f97316",
  critical: "#dc2626",
  unknown: "#64748b",
};

export const NODE_RADIUS: Record<NodeType, number> = { reservoir: 9, pumping_station: 8, valve: 6, junction: 4, meter: 6, hydrant: 6 };
export const TRACE_HEX = { upstream: "#d946ef", downstream: "#06b6d4" } as const;
export const TRACE_ORIGIN = "#facc15";
export const WARNING_HEX = "#ef4444";
export const CONNECTION_HEX = { normal: "#0d9488", affected: "#ef4444" } as const;
export const STRUCTURE_HEX = "#7c3aed";
export const DRAFT_HEX = "#0ea5e9";
export const SELECTED_HEX = "#facc15";
export const NODE_STROKE = "#ffffff";
export const DMA_PALETTE = ["#3b82f6", "#a855f7", "#f59e0b", "#ec4899", "#10b981", "#64748b"] as const;

export const NODE_TYPE_LABEL: Record<NodeType, string> = {
  reservoir: "Reservoirs",
  pumping_station: "Pumping stations",
  valve: "Valves",
  junction: "Junctions",
  meter: "Meters",
  hydrant: "Hydrants",
};
export const NODE_TYPE_SINGULAR: Record<NodeType, string> = {
  reservoir: "Reservoir",
  pumping_station: "Pumping station",
  valve: "Valve",
  junction: "Junction",
  meter: "Meter",
  hydrant: "Hydrant",
};
export { NODE_TYPES };

export const conditionLabel: Record<AssetCondition, string> = { good: "Good", fair: "Fair", poor: "Poor", critical: "Critical", unknown: "Unknown" };
export const materialLabel: Record<string, string> = {
  pvc: "PVC",
  ductile_iron: "Ductile iron",
  hdpe: "HDPE",
  steel: "Steel",
  concrete: "Concrete",
  unknown: "Unknown",
};

export type TraceMode = "upstream" | "downstream" | "isolation";
export type Tool = "select" | "add-node" | "draw-pipe" | "move-node" | "draw-dma";
