import { APPLICATION_STAGES, TERMINAL_APPLICATION_STAGES, type ApplicationStage, type Permission, type SurveyApprovalState } from "@flowless/shared-types";

/*
 * The application workflow as the detail page draws it (C-05). The stage machine is the
 * API's (`application-stages.ts`); this only turns "the stages this organization uses" and
 * "where the application is" into a line of steps and the next action offered.
 */

export type StepState = "done" | "current" | "upcoming" | "skipped" | "stopped";
export interface StageStep {
  stage: ApplicationStage;
  state: StepState;
}

/** Milestones from enquiry to converted; rejected and cancelled are ends, not steps. */
export const MILESTONES: readonly ApplicationStage[] = APPLICATION_STAGES.filter((s) => s !== "rejected" && s !== "cancelled");

const isFinal = (stage: ApplicationStage) => (TERMINAL_APPLICATION_STAGES as readonly ApplicationStage[]).includes(stage);

/**
 * The line of steps. A stage the organization waives is `skipped`. `reachedBeforeEnd` is the
 * stage a rejected or cancelled application had reached, so the line shows where it stopped
 * (that step is `stopped`); a converted application has every used step `done`.
 */
export function stageLine(stage: ApplicationStage, active: readonly ApplicationStage[], reachedBeforeEnd: ApplicationStage | null = null): StageStep[] {
  const ended = stage === "rejected" || stage === "cancelled";
  const at = ended ? (reachedBeforeEnd ?? "enquiry") : stage;
  const position = MILESTONES.indexOf(at);
  return MILESTONES.map((s, i) => {
    if (!active.includes(s)) return { stage: s, state: "skipped" };
    if (stage === "converted") return { stage: s, state: "done" };
    if (i < position) return { stage: s, state: "done" };
    if (i === position) return { stage: s, state: ended ? "stopped" : "current" };
    return { stage: s, state: "upcoming" };
  });
}

/** The stage that follows `stage` among the used ones, or null at the end or from a final stage. */
export function nextUsedStage(stage: ApplicationStage, active: readonly ApplicationStage[]): ApplicationStage | null {
  if (isFinal(stage)) return null;
  const at = active.indexOf(stage);
  return at < 0 ? null : (active[at + 1] ?? null);
}

export type AdvanceKind = "submit" | "invoiced" | "paid" | "installation" | "ready" | "convert";

const ADVANCE_FOR: Partial<Record<ApplicationStage, AdvanceKind>> = {
  application: "submit",
  invoice: "invoiced",
  payment: "paid",
  installation: "installation",
  ready: "ready",
  converted: "convert",
};

export interface ApplicationView {
  stage: ApplicationStage;
  surveyApprovalState: SurveyApprovalState | null;
  surveyFeasibility: "feasible" | "not_feasible" | null;
}

export interface ApplicationOffers {
  /** The next step, when it is a button (the survey is its own form). */
  advance: AdvanceKind | null;
  /** The survey form is offered: an enquiry, survey used, none awaiting approval. */
  recordSurvey: boolean;
  /** Reject or cancel: any application that has not ended. */
  end: boolean;
  /** Why the next step cannot be taken yet, in words. */
  waiting: string | null;
}

/** What the page offers, from the stage, the survey's state and the member's permissions. */
export function offersFor(app: ApplicationView, active: readonly ApplicationStage[], permissions: readonly Permission[]): ApplicationOffers {
  const none: ApplicationOffers = { advance: null, recordSurvey: false, end: false, waiting: null };
  if (isFinal(app.stage)) return none;
  const canUpdate = permissions.includes("accounts:update");
  const next = nextUsedStage(app.stage, active);
  const surveying = app.stage === "enquiry" && active.includes("survey");

  let advance: AdvanceKind | null = null;
  if (!surveying && next) {
    const kind = ADVANCE_FOR[next] ?? null;
    // Converting opens the account, which needs accounts:create; every other step accounts:update.
    advance = kind === "convert" ? (permissions.includes("accounts:create") ? kind : null) : canUpdate ? kind : null;
  }
  const waiting =
    surveying && app.surveyApprovalState === "pending"
      ? "The survey is waiting for approval."
      : surveying && app.surveyFeasibility === "not_feasible"
        ? "The survey found the connection not feasible. Record a new survey, or reject the application."
        : surveying && app.surveyApprovalState === "rejected"
          ? "The survey was not approved. Record a new survey."
          : null;
  return {
    advance,
    recordSurvey: canUpdate && surveying && app.surveyApprovalState !== "pending",
    end: canUpdate,
    waiting,
  };
}

/** The stage an ended application had reached, from its step log (the last move into rejected or cancelled). */
export function stageBeforeEnd(events: readonly { toStage: ApplicationStage; fromStage: ApplicationStage; kind: string }[]): ApplicationStage | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === "stage_changed" && (e.toStage === "rejected" || e.toStage === "cancelled")) return e.fromStage;
  }
  return null;
}
