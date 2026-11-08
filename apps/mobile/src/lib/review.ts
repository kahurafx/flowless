import { CONDITION_LABEL, formatCoords, formatDate, titleCase } from "./format";
import type { BranchPreview, BranchRow } from "./types";

/**
 * The review screens' model of a branch under review (G-03, reconcile). `reconcile.branches` lists
 * them and `reconcile.preview` plans each one entity by entity; `fromPreview` nests each entity's
 * plan the way the screens read it.
 */
export type Origin = BranchPreview["origin"] & object;

export const ORIGIN_LABEL: Record<string, string> = {
  pending: "Not started",
  in_progress: "In progress",
  blocked: "On hold",
  submitted: "Awaiting approval",
  completed: "Approved",
  cancelled: "Cancelled",
};

export const EXISTENCE_FIELD = "__existence__";

export type EntityType = BranchPreview["entities"][number]["entityType"];
export type MergeMode = "create" | "fast-forward" | "merge" | "delete" | "restore";
export type SkipReason = "created-and-deleted-on-branch" | "no-change" | "kept-main";
export type FieldChange = { field: string; from?: unknown; to?: unknown };
export type FieldConflict = { field: string; base?: unknown; branch?: unknown; main?: unknown };

export type Plan =
  | { kind: "write"; mode: MergeMode; changes: FieldChange[] }
  | { kind: "skip"; reason: SkipReason }
  | { kind: "conflict"; conflicts: FieldConflict[] };

export type ReviewEntity = {
  id: string;
  entityType: EntityType;
  name: string;
  plan: Plan;
  /** A new node of a type that must have a photo before it can go live (NODE_PHOTO_RULE). */
  needsPhoto?: boolean;
};

export type ReviewBranch = {
  branch: string;
  authorIds: string[];
  firstEditAt: Date;
  lastEditAt: Date;
  token: string;
  entities: ReviewEntity[];
  origin: Origin | null;
};

/** entity id, then field, then which side wins. */
export type Resolutions = Record<string, Record<string, "branch" | "main">>;

/** A branch whose job hasn't been approved yet. Posting it needs `override` (reconcile.post does the same). */
export const awaitingApproval = (b: Pick<ReviewBranch, "origin">) => !!b.origin && b.origin.status !== "completed";

export function fromPreview(row: BranchRow, preview: BranchPreview): ReviewBranch {
  return {
    branch: row.branch,
    authorIds: row.authorIds,
    firstEditAt: row.firstEditAt,
    lastEditAt: row.lastEditAt,
    token: preview.token,
    origin: preview.origin ?? row.origin ?? null,
    entities: preview.entities.map((e) => ({
      id: e.id,
      entityType: e.entityType,
      name: e.name,
      needsPhoto: e.needsPhoto,
      plan:
        e.kind === "write"
          ? { kind: "write", mode: e.detail as MergeMode, changes: e.changes as FieldChange[] }
          : e.kind === "skip"
            ? { kind: "skip", reason: e.detail as SkipReason }
            : { kind: "conflict", conflicts: e.conflicts as FieldConflict[] },
    })),
  };
}

/* ---------- display helpers ---------- */

const FIELD_LABEL: Record<string, string> = {
  name: "Name",
  location: "Location",
  condition: "Condition",
  isOpen: "Valve state",
  structureId: "Housed in",
  installedAt: "Installed",
  lastInspectedAt: "Last inspected",
  path: "Route",
  material: "Material",
  diameterMm: "Diameter",
  connectionNumber: "Connection number",
  pipeId: "Serving pipe",
  servicePointId: "Service point",
  color: "Colour",
  tierId: "Tier",
  inletMeterId: "Inlet meter",
  boundary: "Boundary",
  boundaryValveIds: "Boundary valves",
  [EXISTENCE_FIELD]: "Whether it exists",
};
export const fieldLabel = (f: string) => FIELD_LABEL[f] ?? titleCase(f);

export function formatValue(field: string, v: unknown): string {
  if (v === null || v === undefined || v === "") return "None";
  if (field === "condition") return CONDITION_LABEL[v as keyof typeof CONDITION_LABEL] ?? String(v);
  if (field === "isOpen") return v === true ? "Open" : v === false ? "Closed" : "Unknown";
  if (field === "diameterMm") return `${v} mm`;
  if (field === "material") return v === "pvc" || v === "hdpe" ? String(v).toUpperCase() : titleCase(String(v));
  if (field === "installedAt" || field === "lastInspectedAt") return formatDate(v as string);
  if (field === "location" && typeof v === "object") return formatCoords(v as { lat: number; lng: number });
  if (Array.isArray(v)) return `${v.length} ${field === "path" || field === "boundary" ? "points" : v.length === 1 ? "item" : "items"}`;
  return String(v);
}

export const MODE_LABEL: Record<MergeMode, string> = {
  create: "New",
  "fast-forward": "Updated",
  merge: "Updated, merged with newer edits",
  delete: "Deleted",
  restore: "Restored",
};

export const SKIP_LABEL: Record<SkipReason, string> = {
  "created-and-deleted-on-branch": "Added and removed again",
  "no-change": "Already matches the live network",
  "kept-main": "Live network version kept",
};

export const conflictsOf = (e: ReviewEntity): FieldConflict[] => (e.plan.kind === "conflict" ? e.plan.conflicts : []);

export function summarize(b: Pick<ReviewBranch, "entities">) {
  const conflicts = b.entities.filter((e) => e.plan.kind === "conflict").length;
  const ready = b.entities.filter((e) => e.plan.kind === "write").length;
  const unchanged = b.entities.filter((e) => e.plan.kind === "skip").length;
  return { conflicts, ready, unchanged, total: b.entities.length };
}

export function formatRange(first: Date | string, last: Date | string): string {
  const a = new Date(first);
  const b = new Date(last);
  const time = (d: Date) => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const sameDay = (x: Date, y: Date) => x.toDateString() === y.toDateString();
  const day = sameDay(b, new Date()) ? "Today" : b.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return sameDay(a, b) ? `${day}, ${time(a)} to ${time(b)}` : `${a.toLocaleDateString(undefined, { day: "numeric", month: "short" })} to ${day}`;
}
