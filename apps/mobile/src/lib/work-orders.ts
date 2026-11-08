import type { WorkOrderOutcome, WorkOrderStatus } from "@flowless/shared-types";
import { approxMetres, sortKey, titleCase } from "./format";
import type { AppNode, JobAsset, LatLng, WorkKind, WorkOrder } from "./types";

/* ---------- labels ---------- */

const KIND_SHORT: Record<string, string> = {
  leak: "Leak",
  leak_survey: "Leak survey",
  valve_replacement: "Valve replacement",
  valve_exercise: "Valve exercising",
  flushing: "Flushing",
  inspection: "Inspection",
  prv_adjustment: "PRV adjustment",
  facility_service: "Facility service",
  asset_capture: "New asset",
  connection_capture: "New connection",
  asset_update: "Fix a record",
  repair: "Repair",
  inspection_general: "Inspection",
  survey: "Survey",
};
/** Kinds are strings (a module can add one without an app update), so an unknown one still gets a label. */
export const kindShort = (key: string) => KIND_SHORT[key] ?? titleCase(key);

export const kindInfo = (kinds: readonly WorkKind[], key: string) => kinds.find((k) => k.key === key);

export const OUTCOME_LABEL: Record<WorkOrderOutcome, string> = { done: "Job done", partial: "Partly done", no_fault: "No fault found" };
export const HOLD_REASONS = ["Can't get access", "Parts or tools needed", "Needs an engineer", "Safety concern", "Other"];

export type Tone = "neutral" | "info" | "ok" | "warn" | "danger";
export const STATUS_PILL: Record<WorkOrderStatus, { label: string; tone: Tone }> = {
  pending: { label: "Not started", tone: "neutral" },
  in_progress: { label: "In progress", tone: "info" },
  blocked: { label: "On hold", tone: "warn" },
  submitted: { label: "Awaiting approval", tone: "info" },
  completed: { label: "Completed", tone: "ok" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

/* ---------- job helpers ---------- */

export const isOpenOrder = (o: Pick<WorkOrder, "status">) => o.status !== "completed" && o.status !== "cancelled";
export const isActive = (o: Pick<WorkOrder, "status">) => o.status === "pending" || o.status === "in_progress" || o.status === "blocked";

/** Everything a person might remember a job by. A blank search matches all. */
export function matchesOrder(o: WorkOrder, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || [o.title, o.code, kindShort(o.kind), o.locationNote, o.description, ...o.assets.map((a) => a.name)].some((t) => t?.toLowerCase().includes(q));
}

export const jobProgress = (o: Pick<WorkOrder, "assets">) => ({ done: o.assets.filter((a) => a.status === "done").length, total: o.assets.length });

export type OutcomeOption = { outcome: WorkOrderOutcome; disabled?: boolean; hint?: string };

/**
 * What the person can claim when finishing. A route job (valve exercising, target "assets") can only
 * be "done" once every asset is; "partly done" is always open to it. Other jobs are done or found to
 * have no fault.
 */
export function finishOutcomes(order: Pick<WorkOrder, "assets">, info: Pick<WorkKind, "target"> | undefined): OutcomeOption[] {
  if (info?.target === "assets") {
    const { done, total } = jobProgress(order);
    const open = total - done;
    return [{ outcome: "done", disabled: open > 0, hint: open > 0 ? `${open} asset${open === 1 ? "" : "s"} still to do` : undefined }, { outcome: "partial" }];
  }
  return [{ outcome: "done" }, { outcome: "no_fault" }];
}

/** Which log an asset on a job is finished with. Null means this kind of job has no one-tap record for it. */
export function assetAction(kindKey: string, assetType: string | null): "inspect" | "valve" | null {
  if (assetType === "valve" && (kindKey === "valve_exercise" || kindKey === "valve_replacement")) return "valve";
  if (kindKey === "inspection" || kindKey === "facility_service" || kindKey === "prv_adjustment" || kindKey === "inspection_general") return "inspect";
  return null;
}

/** Whether this kind of job puts its network work on the job's branch `wo-<code>` (logs, edits and creates). */
export const usesJobBranch = (info: Pick<WorkKind, "gis"> | undefined) => !!info && info.gis !== "none";

export type { JobAsset };

/* ---------- completion data (W-03) ---------- */

export type CaptureField = { key: string; label: string; required: boolean; multiline?: boolean; placeholder?: string };

/**
 * The completion data a kind collects. The API lists only that a kind has a capture (`hasCapture`),
 * not its shape, so the forms the app knows are here. The server checks the values against the
 * kind's schema either way.
 */
export const CAPTURE_FIELDS: Record<string, CaptureField[]> = {
  repair: [
    { key: "workDone", label: "What was done", required: true, multiline: true, placeholder: "The repair, in a sentence or two" },
    { key: "materials", label: "Materials used", required: false, multiline: true, placeholder: "Fittings, lengths of pipe…" },
  ],
  survey: [{ key: "summary", label: "What the survey found", required: true, multiline: true }],
};

export function captureProblem(kind: Pick<WorkKind, "key" | "hasCapture"> | undefined, values: Record<string, string>): string | null {
  if (!kind?.hasCapture) return null;
  const fields = CAPTURE_FIELDS[kind.key];
  if (!fields) return "This kind of job collects details the app can't take yet. Finish it on the web.";
  const missing = fields.find((f) => f.required && !values[f.key]?.trim());
  return missing ? `Fill in: ${missing.label.toLowerCase()}` : null;
}

export function captureValue(kind: Pick<WorkKind, "key" | "hasCapture"> | undefined, values: Record<string, string>): Record<string, string> | undefined {
  const fields = kind?.hasCapture ? CAPTURE_FIELDS[kind.key] : undefined;
  return fields ? Object.fromEntries(fields.map((f) => [f.key, (values[f.key] ?? "").trim()])) : undefined;
}

/* ---------- ranking ---------- */

export const toLatLng = (p: { latitude: number; longitude: number }): LatLng => ({ lat: p.latitude, lng: p.longitude });
export const toGeoPoint = (p: LatLng) => ({ latitude: p.lat, longitude: p.lng });

export type RankedOrder = { order: WorkOrder; location: LatLng | null; distanceM: number | null };

/**
 * A job you've started comes first. Then priority. Within a priority, jobs we can place come first,
 * nearest to the technician; jobs with no position follow, soonest due first. Without a GPS fix
 * everything falls back to due date.
 */
export function rankOrders(orders: readonly WorkOrder[], nodes: readonly Pick<AppNode, "id" | "location">[], here: LatLng | null): RankedOrder[] {
  const rank = { urgent: 0, high: 1, normal: 2, low: 3 } as const;
  const withPlace = orders.map((order) => {
    const location = order.location ? toLatLng(order.location) : (nodes.find((n) => n.id === order.assetId)?.location ?? null);
    return { order, location, distanceM: here && location ? approxMetres(here, location) : null };
  });
  return withPlace.sort(
    (a, b) =>
      Number(b.order.status === "in_progress") - Number(a.order.status === "in_progress") ||
      rank[a.order.priority] - rank[b.order.priority] ||
      Number(a.distanceM === null) - Number(b.distanceM === null) ||
      (a.distanceM !== null && b.distanceM !== null ? a.distanceM - b.distanceM : sortKey(a.order.dueAt) - sortKey(b.order.dueAt)),
  );
}

export function dueLabel(due: Date | string, nowMs = Date.now()): { text: string; overdue: boolean } {
  const hours = Math.round((new Date(due).getTime() - nowMs) / 3_600_000);
  if (hours < 0) return { text: "Overdue", overdue: true };
  if (hours < 24) return { text: `Due in ${Math.max(hours, 1)} h`, overdue: false };
  return { text: `Due in ${Math.round(hours / 24)} d`, overdue: false };
}
