import { describe, expect, it } from "vitest";
import { planAutoStart, planTransition, type Action, type OrderState } from "../transitions";

// Ported from Majimap's work-orders/test/transitions.test.ts (W-01).
const when = new Date("2026-10-30T08:00:00Z");
const order = (status: OrderState["status"], overrides: Partial<OrderState> = {}): OrderState => ({
  status,
  startedAt: status === "pending" ? null : new Date("2026-10-29T08:00:00Z"),
  assignedToUserId: "tech",
  review: "none",
  submittedByUserId: null,
  ...overrides,
});
const done: Action = { type: "complete", outcome: "done", note: "" };
const submitDone: Action = { type: "submit", outcome: "done", note: "all good" };

describe("starting and holding", () => {
  it("starts a pending job when its assignee does something on it, recording when it began", () => {
    expect(planAutoStart(order("pending"), "tech", when)).toEqual({ kind: "apply", patch: { status: "in_progress", startedAt: when } });
  });

  it("leaves a pending job pending when a supervisor prepares it", () => {
    expect(planAutoStart(order("pending"), "supervisor", when)).toEqual({ kind: "unchanged" });
  });

  it("won't start a job nobody has been given: working on it is not how a job is claimed", () => {
    expect(planAutoStart(order("pending", { assignedToUserId: null }), "tech", when)).toEqual({ kind: "rejected", reason: "Assign the job before working on it" });
    expect(planTransition(order("pending", { assignedToUserId: null }), done, "tech", when).kind).toBe("rejected");
  });

  it("does nothing to a job that has already started", () => {
    for (const status of ["in_progress", "blocked", "submitted", "completed"] as const) {
      expect(planAutoStart(order(status), "tech", when), status).toEqual({ kind: "unchanged" });
    }
  });

  it("resuming from hold clears the hold and keeps the original start time", () => {
    const plan = planTransition(order("blocked"), { type: "resume" }, "tech", when);
    expect(plan.kind).toBe("apply");
    if (plan.kind !== "apply") return;
    expect(plan.patch.status).toBe("in_progress");
    expect(plan.patch.holdReason).toBeNull();
    expect("startedAt" in plan.patch).toBe(false);
  });

  it("can hold a job that hasn't started, which starts the clock on it", () => {
    const fromPending = planTransition(order("pending"), { type: "hold", reason: "No access", note: "" }, "tech", when);
    expect(fromPending).toMatchObject({ kind: "apply", patch: { status: "blocked", startedAt: when } });
    const fromProgress = planTransition(order("in_progress"), { type: "hold", reason: "No access", note: "" }, "tech", when);
    expect(fromProgress.kind === "apply" && "startedAt" in fromProgress.patch).toBe(false);
  });

  it("leaves a job awaiting review alone until it's approved or returned", () => {
    const waiting = order("submitted", { review: "required", submittedByUserId: "tech" });
    for (const action of [{ type: "resume" }, { type: "hold", reason: "x", note: "" }, done] as Action[]) {
      expect(planTransition(waiting, action, "tech", when).kind, action.type).toBe("rejected");
    }
  });
});

describe("completing a job that needs no review", () => {
  it("completes a job in progress", () => {
    const plan = planTransition(order("in_progress"), { type: "complete", outcome: "done", note: "Fixed" }, "tech", when);
    expect(plan).toMatchObject({ kind: "apply", patch: { status: "completed", completedAt: when, outcome: "done" } });
  });

  it("finishes a job straight from pending or on hold, and treats completing twice as no change", () => {
    expect(planTransition(order("pending"), done, "tech", when)).toMatchObject({ kind: "apply", patch: { startedAt: when } });
    expect(planTransition(order("blocked"), done, "tech", when)).toMatchObject({ kind: "apply", patch: { holdReason: null } });
    expect(planTransition(order("completed"), done, "tech", when)).toEqual({ kind: "unchanged" });
  });

  it("rejects everything on a cancelled job, with a reason", () => {
    expect(planTransition(order("cancelled"), { type: "resume" }, "tech", when)).toEqual({ kind: "rejected", reason: "This job was cancelled" });
  });

  it("won't let a job that needs review be completed without it", () => {
    expect(planTransition(order("in_progress", { review: "required" }), done, "tech", when)).toEqual({
      kind: "rejected",
      reason: "This job needs review: submit it for approval",
    });
  });

  it("lets a job whose review is optional go either way", () => {
    const optional = order("in_progress", { review: "optional" });
    expect(planTransition(optional, done, "tech", when).kind).toBe("apply");
    expect(planTransition(optional, submitDone, "tech", when).kind).toBe("apply");
  });
});

describe("open items", () => {
  it("won't call a route job done while assets are still open, but accepts partial and no fault", () => {
    const job = order("in_progress");
    const plan = planTransition(job, done, "tech", when, { openItems: 2 });
    expect(plan.kind === "rejected" && plan.reason).toMatch(/^2 assets still to do/);
    expect(planTransition(job, { type: "complete", outcome: "partial", note: "" }, "tech", when, { openItems: 2 }).kind).toBe("apply");
    expect(planTransition(job, { type: "complete", outcome: "no_fault", note: "" }, "tech", when, { openItems: 2 }).kind).toBe("apply");
  });

  it("uses the singular for one item left", () => {
    const plan = planTransition(order("in_progress"), done, "tech", when, { openItems: 1 });
    expect(plan.kind === "rejected" && plan.reason).toMatch(/^1 asset still to do: finish it/);
  });
});

describe("submitting", () => {
  const required = order("in_progress", { review: "required" });

  it("hands the work to a reviewer, recording who and what, and clearing any earlier review", () => {
    const plan = planTransition(required, submitDone, "tech", when);
    expect(plan).toEqual({
      kind: "apply",
      patch: expect.objectContaining({
        status: "submitted",
        submittedAt: when,
        submittedByUserId: "tech",
        outcome: "done",
        completionNote: "all good",
        reviewedAt: null,
        reviewedByUserId: null,
        reviewNote: null,
      }),
    });
  });

  it("submits straight from pending, refuses one that needs no review, and treats a second submit as no change", () => {
    expect(planTransition(order("pending", { review: "required" }), submitDone, "tech", when).kind).toBe("apply");
    expect(planTransition(order("in_progress", { review: "none" }), submitDone, "tech", when)).toEqual({
      kind: "rejected",
      reason: "This job doesn't need review: complete it",
    });
    expect(planTransition(order("submitted", { review: "required" }), submitDone, "tech", when)).toEqual({ kind: "unchanged" });
  });

  it("applies the open-items rule", () => {
    expect(planTransition(required, submitDone, "tech", when, { openItems: 1 }).kind).toBe("rejected");
  });
});

describe("reviewing", () => {
  const submitted = order("submitted", { review: "required", submittedByUserId: "tech" });

  it("approves a submitted job by completing it, recording the reviewer", () => {
    expect(planTransition(submitted, { type: "approve", note: "Looks right" }, "boss", when)).toMatchObject({
      kind: "apply",
      patch: { status: "completed", completedAt: when, reviewedByUserId: "boss", reviewNote: "Looks right" },
    });
  });

  it("stores no note rather than an empty one", () => {
    expect(planTransition(submitted, { type: "approve", note: "" }, "boss", when)).toMatchObject({ patch: { reviewNote: null } });
  });

  it("refuses a reviewer approving or returning their own submission", () => {
    for (const action of [{ type: "approve", note: "" }, { type: "return", note: "Redo" }] as Action[]) {
      expect(planTransition(submitted, action, "tech", when)).toEqual({ kind: "rejected", reason: "You can't review your own submission" });
    }
  });

  it("returns a job to in progress with the reviewer's note, clearing the submission", () => {
    expect(planTransition(submitted, { type: "return", note: "Photo is missing" }, "boss", when)).toMatchObject({
      kind: "apply",
      patch: { status: "in_progress", reviewNote: "Photo is missing", submittedAt: null, submittedByUserId: null, outcome: null },
    });
  });

  it("only reviews what has been submitted, and approving twice is no change", () => {
    expect(planTransition(order("in_progress", { review: "required" }), { type: "approve", note: "" }, "boss", when).kind).toBe("rejected");
    expect(planTransition(order("in_progress", { review: "required" }), { type: "return", note: "x" }, "boss", when).kind).toBe("rejected");
    expect(planTransition(order("completed"), { type: "approve", note: "" }, "boss", when)).toEqual({ kind: "unchanged" });
  });
});

describe("parent jobs", () => {
  const manager = { openItems: 0, childCount: 2, actorIsManager: true };
  const technician = { openItems: 0, childCount: 2, actorIsManager: false };
  const finalize: Action = { type: "finalize", outcome: "done", note: "" };

  it("stops a technician completing or submitting a job that has children", () => {
    const reason = "This job has child jobs: a supervisor finalizes it";
    expect(planTransition(order("in_progress"), done, "tech", when, technician)).toEqual({ kind: "rejected", reason });
    expect(planTransition(order("in_progress", { review: "required" }), submitDone, "tech", when, technician)).toEqual({ kind: "rejected", reason });
  });

  it("lets a manager finalize a parent that is still pending, on hold or in progress", () => {
    for (const status of ["pending", "in_progress", "blocked"] as const) {
      expect(planTransition(order(status), finalize, "boss", when, manager), status).toMatchObject({ kind: "apply", patch: { status: "completed" } });
    }
  });

  it("refuses finalize for a technician, for a job with no children, and for a submitted job", () => {
    expect(planTransition(order("pending"), finalize, "tech", when, technician).kind).toBe("rejected");
    expect(planTransition(order("pending"), finalize, "boss", when, { ...manager, childCount: 0 }).kind).toBe("rejected");
    expect(planTransition(order("submitted", { review: "required" }), finalize, "boss", when, manager).kind).toBe("rejected");
  });

  it("treats finalizing twice as no change", () => {
    expect(planTransition(order("completed"), finalize, "boss", when, manager)).toEqual({ kind: "unchanged" });
  });
});
