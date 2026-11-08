import type { ReviewPolicy, WorkOrderOutcome, WorkOrderStatus } from "@flowless/shared-types";

/*
 * The job state machine (W-01), ported verbatim from Majimap's work-orders/transitions.ts.
 * No database in it, so every case is tested directly.
 */

export type Action =
  | { type: "resume" }
  | { type: "hold"; reason: string; note: string }
  /** Finish a job that needs no review. */
  | { type: "complete"; outcome: WorkOrderOutcome; note: string }
  /** Hand finished work to a reviewer. */
  | { type: "submit"; outcome: WorkOrderOutcome; note: string }
  | { type: "approve"; note: string }
  | { type: "return"; note: string }
  | { type: "finalize"; outcome: WorkOrderOutcome; note: string };

export interface OrderState {
  status: WorkOrderStatus;
  startedAt: Date | null;
  assignedToUserId: string | null;
  review: ReviewPolicy;
  submittedByUserId: string | null;
}

/** What the state machine can't know by itself: how much of the job is still open. */
export interface Facts {
  /** Assets still without evidence on a route job. Always 0 for any other kind. */
  openItems: number;
  childCount?: number;
  actorIsManager?: boolean;
}

export type OrderPatch = Partial<{
  status: WorkOrderStatus;
  startedAt: Date;
  holdReason: string | null;
  holdNote: string | null;
  heldAt: Date | null;
  submittedAt: Date | null;
  submittedByUserId: string | null;
  reviewedAt: Date | null;
  reviewedByUserId: string | null;
  reviewNote: string | null;
  completedAt: Date;
  outcome: WorkOrderOutcome | null;
  completionNote: string | null;
}>;

export type TransitionPlan = { kind: "apply"; patch: OrderPatch } | { kind: "unchanged" } | { kind: "rejected"; reason: string };

const CLEAR_HOLD = { holdReason: null, holdNote: null, heldAt: null } as const;
const AWAITING = "This job is awaiting review";
const COMPLETED = "This job is already completed";
const PARENT_RULE = "This job has child jobs: a supervisor finalizes it";

const reject = (reason: string): TransitionPlan => ({ kind: "rejected", reason });

function openItemsReason(count: number): string {
  return `${count} ${count === 1 ? "asset" : "assets"} still to do: finish ${count === 1 ? "it" : "them"} before marking the job done, or choose partial`;
}

/** Nobody taps Start: the first thing done on a job starts it. A job has to be assigned before anything can be done on it. */
const NEEDS_ASSIGNEE = "Assign the job before working on it";

/** Stamped on the first action that moves a job out of pending. */
const startStamp = (order: OrderState, when: Date) => (order.startedAt ? {} : { startedAt: when });

/**
 * Starts a pending job because someone did something on it (recorded a log, added an asset, opened its branch).
 * Only the assignee's own action starts a job: a supervisor preparing it leaves it pending.
 */
export function planAutoStart(order: OrderState, actorUserId: string, when: Date): TransitionPlan {
  if (order.status !== "pending") return { kind: "unchanged" };
  if (!order.assignedToUserId) return reject(NEEDS_ASSIGNEE);
  if (order.assignedToUserId !== actorUserId) return { kind: "unchanged" };
  return { kind: "apply", patch: { status: "in_progress", startedAt: when } };
}

/**
 * The state machine for a job. It follows the field app: nobody taps Start, and finishing
 * or pausing a job that hasn't started yet is fine.
 *
 *   pending|in_progress|blocked ─complete→ completed      (jobs that need no review)
 *   pending|in_progress|blocked ─submit→ submitted ─approve→ completed
 *                                              └──return→ in_progress
 *   pending|in_progress ─hold→ blocked ─resume→ in_progress
 *   (any first log or added asset by the assignee: pending → in_progress, see planAutoStart)
 *
 * Anything a device can't know about (the job was completed, cancelled or reassigned while
 * it was offline) comes back `rejected` with a reason, not as an error: the person needs to
 * see it, and the attempt is kept in the event log. Doing something twice is `unchanged`.
 *
 * A job has to be assigned before anyone works it. "Done" on a route job needs every asset
 * done; "partial" and "no_fault" are how a job is closed with work left open. A reviewer
 * can't review their own submission.
 */
export function planTransition(order: OrderState, action: Action, userId: string, when: Date, facts: Facts = { openItems: 0 }): TransitionPlan {
  if (order.status === "cancelled") return reject("This job was cancelled");

  switch (action.type) {
    case "resume": {
      if (order.status === "in_progress") return { kind: "unchanged" };
      if (order.status === "completed") return reject(COMPLETED);
      if (order.status === "submitted") return reject(AWAITING);
      if (order.status === "pending") return { kind: "unchanged" };
      return { kind: "apply", patch: { status: "in_progress", ...startStamp(order, when), ...CLEAR_HOLD } };
    }
    case "hold": {
      if (order.status === "blocked") return { kind: "unchanged" };
      if (order.status === "completed") return reject(COMPLETED);
      if (order.status === "submitted") return reject(AWAITING);
      if (!order.assignedToUserId) return reject(NEEDS_ASSIGNEE);
      return {
        kind: "apply",
        patch: { status: "blocked", ...startStamp(order, when), holdReason: action.reason, holdNote: action.note, heldAt: when },
      };
    }
    case "complete": {
      if (order.status === "completed") return { kind: "unchanged" };
      if (order.status === "submitted") return reject(`${AWAITING}: approve or return it`);
      if (!order.assignedToUserId) return reject(NEEDS_ASSIGNEE);
      if ((facts.childCount ?? 0) > 0 && !facts.actorIsManager) return reject(PARENT_RULE);
      if (order.review === "required") return reject("This job needs review: submit it for approval");
      if (action.outcome === "done" && facts.openItems > 0) return reject(openItemsReason(facts.openItems));
      return {
        kind: "apply",
        patch: {
          status: "completed",
          ...startStamp(order, when),
          completedAt: when,
          outcome: action.outcome,
          completionNote: action.note,
          ...CLEAR_HOLD,
        },
      };
    }
    case "submit": {
      if (order.status === "submitted") return { kind: "unchanged" };
      if (order.status === "completed") return reject(COMPLETED);
      if (!order.assignedToUserId) return reject(NEEDS_ASSIGNEE);
      if ((facts.childCount ?? 0) > 0 && !facts.actorIsManager) return reject(PARENT_RULE);
      if (order.review === "none") return reject("This job doesn't need review: complete it");
      if (action.outcome === "done" && facts.openItems > 0) return reject(openItemsReason(facts.openItems));
      return {
        kind: "apply",
        patch: {
          status: "submitted",
          ...startStamp(order, when),
          submittedAt: when,
          submittedByUserId: userId,
          outcome: action.outcome,
          completionNote: action.note,
          // A new submission starts a fresh review.
          reviewedAt: null,
          reviewedByUserId: null,
          reviewNote: null,
          ...CLEAR_HOLD,
        },
      };
    }
    case "approve": {
      if (order.status === "completed") return { kind: "unchanged" };
      if (order.status !== "submitted") return reject("Only a submitted job can be approved");
      if (order.submittedByUserId === userId) return reject("You can't review your own submission");
      return {
        kind: "apply",
        patch: {
          status: "completed",
          completedAt: when,
          reviewedAt: when,
          reviewedByUserId: userId,
          reviewNote: action.note === "" ? null : action.note,
        },
      };
    }
    case "return": {
      if (order.status !== "submitted") return reject("Only a submitted job can be returned");
      if (order.submittedByUserId === userId) return reject("You can't review your own submission");
      return {
        kind: "apply",
        patch: {
          status: "in_progress",
          reviewedAt: when,
          reviewedByUserId: userId,
          reviewNote: action.note,
          submittedAt: null,
          submittedByUserId: null,
          outcome: null,
          completionNote: null,
        },
      };
    }
    case "finalize": {
      if (order.status === "completed") return { kind: "unchanged" };
      if (order.status === "submitted") return reject(`${AWAITING}: approve or return it`);
      if (!facts.actorIsManager) return reject("Only a supervisor can finalize a job");
      if ((facts.childCount ?? 0) === 0) return reject("Only a job with child jobs is finalized this way");
      // pending, in progress or on hold. The parent's own assets don't gate it: the children are the work.
      return {
        kind: "apply",
        patch: { status: "completed", completedAt: when, outcome: action.outcome, completionNote: action.note, ...CLEAR_HOLD },
      };
    }
  }
}
