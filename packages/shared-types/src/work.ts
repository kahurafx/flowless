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

/** Job priority (W-02), lowest first. */
export const WORK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type WorkPriority = (typeof WORK_PRIORITIES)[number];

/** The one lifecycle every kind of job shares (W-01), adopted from Majimap. */
export const WORK_ORDER_STATUSES = ["pending", "in_progress", "blocked", "submitted", "completed", "cancelled"] as const;
export type WorkOrderStatus = (typeof WORK_ORDER_STATUSES)[number];

export const WORK_ORDER_OUTCOMES = ["done", "partial", "no_fault"] as const;
export type WorkOrderOutcome = (typeof WORK_ORDER_OUTCOMES)[number];

/** Whether finishing a job needs a second person's approval. */
export const REVIEW_POLICIES = ["none", "optional", "required"] as const;
export type ReviewPolicy = (typeof REVIEW_POLICIES)[number];

/** Everything that can happen to a job, as recorded in its history (Majimap's list plus comment and capture). */
export const WORK_ORDER_EVENT_TYPES = [
  "create",
  "assign",
  "cancel",
  "resume",
  "hold",
  "complete",
  "submit",
  "approve",
  "return",
  "finalize",
  "log_link",
  "add_asset",
  "change_set",
  "comment",
  "capture",
] as const;
export type WorkOrderEventType = (typeof WORK_ORDER_EVENT_TYPES)[number];

/** What became of an action: offline devices replay, so repeats and stale actions are recorded too. */
export const WORK_ORDER_EVENT_OUTCOMES = ["applied", "unchanged", "replayed", "rejected", "stale"] as const;
export type WorkOrderEventOutcome = (typeof WORK_ORDER_EVENT_OUTCOMES)[number];
