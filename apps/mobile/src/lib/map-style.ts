import { NODE_TYPES } from "@flowless/shared-types";
import { CONDITION_HEX } from "./format";

/** The map's look, as on the web map: condition colours, node sizes by type, a CARTO basemap. */
export const LIGHT_STYLE = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";
export const DARK_STYLE = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";
export const NODE_RADIUS = { reservoir: 9, pumping_station: 8, valve: 6, junction: 4, meter: 6, hydrant: 6 } as const;
export const SUBNETWORK_PALETTE = ["#3B82F6", "#A855F7", "#F59E0B", "#EC4899", "#10B981", "#64748B"] as const;
export const SUBNETWORK_FALLBACK = "#94a3b8";
/** A failed pipe, or a DMA's leaking boundary. */
export const WARNING_RED = "#ef4444";
/** A directional trace's result, one colour per direction. */
export const TRACE_HEX = { upstream: "#d946ef", downstream: "#06b6d4" } as const;
export const CONNECTION_HEX = { normal: "#0d9488", affected: "#ef4444" } as const;
/** The ring round the node a trace started from. */
export const TRACE_ORIGIN = "#facc15";
export const NODE_STROKE = "#ffffff";
/** Selection halo: the web's primary blue. */
export const SELECTION_FILL = "#3B82F6";
export const SELECTION_STROKE = "#1E40AF";

type Expr = unknown[];

export const conditionColorExpr: Expr = [
  "match",
  ["get", "condition"],
  "good",
  CONDITION_HEX.good,
  "fair",
  CONDITION_HEX.fair,
  "poor",
  CONDITION_HEX.poor,
  "critical",
  CONDITION_HEX.critical,
  CONDITION_HEX.unknown,
];

export function subnetworkColorExpr(colorById: Record<string, string>): Expr | string {
  const entries = Object.entries(colorById);
  return entries.length ? ["match", ["get", "id"], ...entries.flatMap(([id, color]) => [id, color]), SUBNETWORK_FALLBACK] : SUBNETWORK_FALLBACK;
}

/** The web sizes were set for a mouse. On a phone they grow with zoom so they stay tappable and legible. */
const zoomScaled = (value: unknown): Expr => ["interpolate", ["linear"], ["zoom"], 12, ["*", 0.6, value], 18, ["*", 1.7, value]];

export const nodeRadiusExpr: Expr = zoomScaled(["match", ["get", "type"], ...NODE_TYPES.flatMap((t) => [t, NODE_RADIUS[t]]), 5]);
export const pipeWidthExpr: Expr = zoomScaled(["interpolate", ["linear"], ["get", "diameterMm"], 100, 2, 400, 5]);
export const haloRadiusExpr: Expr = zoomScaled(15);
export const valveDotRadiusExpr: Expr = zoomScaled(2.4);
