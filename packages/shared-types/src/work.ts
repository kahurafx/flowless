import type { ModuleKey } from "./modules";

/**
 * How much of the work-order lifecycle an organization has (W-01, adopted from Majimap):
 * `full` with the Work Orders module (crews, scheduling, SLA, every module's kinds);
 * `basic` when only a module that brings its own kinds is licensed (GIS field work);
 * `none` otherwise, when field work falls back to office actions (NF-31).
 */
export type WorkLevel = "none" | "basic" | "full";

/** Modules whose basic kinds work without the Work Orders module. */
export const WORK_PROVIDER_MODULES: readonly ModuleKey[] = ["gis"];

export function workLevel(entitlements: readonly ModuleKey[]): WorkLevel {
  if (entitlements.includes("work-orders")) return "full";
  return WORK_PROVIDER_MODULES.some((m) => entitlements.includes(m)) ? "basic" : "none";
}

/** A point on the ground, WGS 84 (W-02). */
export interface GeoPoint {
  latitude: number;
  longitude: number;
}
