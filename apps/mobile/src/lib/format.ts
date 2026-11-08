import type { AssetCondition, NodeType } from "@flowless/shared-types";
import type { LatLng } from "./types";

/** Dates reach the app as `Date`s from the API and from disk; tolerate ISO strings too. */
export type When = Date | string | null | undefined;
const ms = (value: NonNullable<When>) => (value instanceof Date ? value.getTime() : new Date(value).getTime());

export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export const titleCase = (s: string) => cap(s.replace(/_/g, " "));

export function timeAgo(value: When, nowMs = Date.now()): string {
  if (!value) return "Never";
  const minutes = Math.round((nowMs - ms(value)) / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} d ago`;
  if (days < 365) return `${Math.round(days / 30)} mo ago`;
  return `${Math.floor(days / 365)} y ago`;
}

export function formatDate(value: When): string {
  if (!value) return "Not recorded";
  return new Date(ms(value)).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export const formatCoords = (p: LatLng) => `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;

/** Flat-earth distance in metres: plenty for ranking what is nearby. */
export function approxMetres(a: LatLng, b: LatLng): number {
  const dLat = (b.lat - a.lat) * 111_320;
  const dLng = (b.lng - a.lng) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

export const formatDistance = (m: number) => (m < 1000 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${(m / 1000).toFixed(1)} km`);

/** Inspections older than this are flagged as overdue. */
export const INSPECTION_INTERVAL_DAYS = 180;
export type InspectionState = "never" | "overdue" | "ok";
export function inspectionState(value: When, nowMs = Date.now()): InspectionState {
  if (!value) return "never";
  return (nowMs - ms(value)) / 86_400_000 > INSPECTION_INTERVAL_DAYS ? "overdue" : "ok";
}

/** Sortable millisecond value for a date, 0 for none. */
export const sortKey = (value: When) => (value ? ms(value) : 0);

export const initialsOf = (name: string) =>
  name
    .split(/[\s.]+/)
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase())
    .slice(0, 2)
    .join("");

export const NODE_TYPE_LABEL: Record<NodeType, string> = {
  reservoir: "Reservoir",
  pumping_station: "Pumping station",
  valve: "Valve",
  junction: "Junction",
  meter: "Meter",
  hydrant: "Hydrant",
};

export const NODE_TYPE_PLURAL: Record<NodeType, string> = {
  reservoir: "Reservoirs",
  pumping_station: "Pumps",
  valve: "Valves",
  junction: "Junctions",
  meter: "Meters",
  hydrant: "Hydrants",
};

export const CONDITION_LABEL: Record<AssetCondition, string> = { good: "Good", fair: "Fair", poor: "Poor", critical: "Critical", unknown: "Unknown" };
export const CONDITION_HINT: Record<AssetCondition, string> = {
  good: "Working normally",
  fair: "Minor wear, no action yet",
  poor: "Needs repair soon",
  critical: "Failed or unsafe",
  unknown: "Couldn't assess it",
};

/** Canonical condition colours, as on the web map. */
export const CONDITION_HEX: Record<AssetCondition, string> = {
  good: "#3f7a53",
  fair: "#c99a3a",
  poor: "#bb6a35",
  critical: "#a3453b",
  unknown: "#8b93a1",
};

export const JUNCTION_TYPE_LABEL = { tee: "Tee", cross: "Cross", elbow: "Elbow", wye: "Wye", reducer: "Reducer" } as const;
export const JUNCTION_TYPE_HINT = {
  tee: "Three ways: one branch off the main",
  cross: "Four ways: two pipes crossing",
  elbow: "A bend in the line",
  wye: "A branch leaving at an angle",
  reducer: "Steps the pipe down in size",
} as const;

/** Common nominal sizes for quick picking. Anything else can be typed. */
export const PIPE_SIZES_MM = [50, 63, 75, 100, 150, 200, 250, 300, 400, 500];

export function describeJunction(j: { type: keyof typeof JUNCTION_TYPE_LABEL; mainSizeMm: number; branchSizeMm: number | null }): string {
  const sizes = j.branchSizeMm ? `${j.mainSizeMm} × ${j.branchSizeMm} mm` : `${j.mainSizeMm} mm`;
  return `${JUNCTION_TYPE_LABEL[j.type]} ${sizes} · ${j.branchSizeMm ? "reduced" : "equal"}`;
}
