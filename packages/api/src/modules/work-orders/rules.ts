import type { ReviewPolicy, WorkLevel, WorkOrderStatus, WorkPriority } from "@flowless/shared-types";
import type { WorkKindDef } from "../../kernel/work";
import type { Abilities } from "./access";

/*
 * Who may do what when a job is raised or changed, ported from Majimap's rules.ts with
 * permissions in place of roles. Pure, so the whole matrix is tested without a database.
 * (What a member may SEE is in access.ts.)
 */

export interface CreateRequest {
  abilities: Abilities;
  userId: string;
  level: WorkLevel;
  /** The kind, with the organization's review policy already applied. */
  kind: Pick<WorkKindDef, "tier" | "review" | "selfRaise">;
  priority: WorkPriority;
  assigneeId: string | null;
}

export type CreatePlan =
  | { ok: true; assigneeId: string | null; review: ReviewPolicy; selfRaised: boolean }
  | { ok: false; code: "FORBIDDEN" | "BAD_REQUEST"; reason: string };

/**
 * Members with `work_orders:assign` raise any job for anyone, with the kind's review
 * policy. A member who only executes can raise a self-raise kind (a leak, a new or wrong
 * asset) for something they found: assigned to themselves, normal priority, and ALWAYS
 * reviewed, since nobody else has looked at it yet.
 */
export function planCreate(req: CreateRequest): CreatePlan {
  if (req.level === "none") return { ok: false, code: "FORBIDDEN", reason: "Work orders aren't available for this organization" };
  if (req.kind.tier === "full" && req.level !== "full") {
    return { ok: false, code: "BAD_REQUEST", reason: "That kind of job needs the Work orders module" };
  }
  if (req.abilities.assign) {
    return { ok: true, assigneeId: req.assigneeId, review: req.kind.review, selfRaised: false };
  }
  if (!req.abilities.execute) {
    return { ok: false, code: "FORBIDDEN", reason: "You can't raise jobs" };
  }
  if (!req.kind.selfRaise) {
    return { ok: false, code: "FORBIDDEN", reason: "Ask a supervisor to raise this kind of job" };
  }
  if (req.assigneeId !== null && req.assigneeId !== req.userId) {
    return { ok: false, code: "FORBIDDEN", reason: "You can only raise a job for yourself" };
  }
  if (req.priority !== "normal") {
    return { ok: false, code: "FORBIDDEN", reason: "A job you raise yourself has normal priority: ask a supervisor to escalate it" };
  }
  return { ok: true, assigneeId: req.userId, review: "required", selfRaised: true };
}

/**
 * Anyone working a job adds assets to it (the valve they find on site): before it has
 * started (which starts it, for the assignee), while it's in progress, or while it's on
 * hold. Nobody changes a job that is waiting for review or finished.
 */
export function canAddAsset(status: WorkOrderStatus): boolean {
  return status === "pending" || status === "in_progress" || status === "blocked";
}

/** Why a job can't take more assets right now. */
export function frozenReason(status: WorkOrderStatus): string {
  if (status === "completed" || status === "cancelled") return `This job is ${status}`;
  return "This job is awaiting review";
}

export const isClosed = (status: WorkOrderStatus) => status === "completed" || status === "cancelled";
