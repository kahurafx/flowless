import { APPLICATION_STAGES, TERMINAL_APPLICATION_STAGES, applicationConfigSchema, type ApplicationConfig, type ApplicationStage } from "@flowless/shared-types";

// The schema is shared with the web form (`@flowless/shared-types`); the module keeps exporting it.
export { applicationConfigSchema, type ApplicationConfig };

/*
 * The application stage machine (C-05), pure: no I/O, no clock. An application is a path of
 * milestones, each reached by one action:
 *
 *   enquiry -> survey -> application -> invoice -> payment -> installation -> ready -> converted
 *              recordSurvey submitApplication markInvoiced markPaid startInstallation markReady convert
 *
 * `survey`, `invoice` with `payment`, and `installation` are used or waived by the
 * organization's `accounts.application` setting (K-10); nothing else is ever skipped, and a
 * waived stage is skipped exactly (the next action goes from the stage before it). `rejected`
 * and `cancelled` can be reached from any stage that is not final, and the three final
 * stages (converted, rejected, cancelled) never change. `use-cases` in `applications.ts` run
 * this under a row lock and write the event that records the move.
 */

export const DEFAULT_APPLICATION_CONFIG: ApplicationConfig = applicationConfigSchema.parse({});

/** The action that reaches each milestone. */
export const ADVANCE_ACTIONS = {
  recordSurvey: "survey",
  submitApplication: "application",
  markInvoiced: "invoice",
  markPaid: "payment",
  startInstallation: "installation",
  markReady: "ready",
  convert: "converted",
} as const satisfies Record<string, ApplicationStage>;
export type AdvanceAction = keyof typeof ADVANCE_ACTIONS;

const FINAL = new Set<ApplicationStage>(TERMINAL_APPLICATION_STAGES);
export const isFinalStage = (stage: ApplicationStage) => FINAL.has(stage);

/** The milestones this organization uses, in order, from `enquiry` to `converted`. */
export function activeStages(config: ApplicationConfig): ApplicationStage[] {
  return APPLICATION_STAGES.filter((stage) => {
    switch (stage) {
      case "survey":
        return config.survey.required;
      case "invoice":
      case "payment":
        return config.invoice.required;
      case "installation":
        return config.installation.required;
      case "rejected":
      case "cancelled":
        return false;
      default:
        return true;
    }
  });
}

/** The stage that follows `stage` for this organization, or null at the end or from a final stage. */
export function nextStage(stage: ApplicationStage, config: ApplicationConfig): ApplicationStage | null {
  const path = activeStages(config);
  const at = path.indexOf(stage);
  return at < 0 ? null : (path[at + 1] ?? null);
}

export type Advance = { ok: true; to: ApplicationStage } | { ok: false; problem: string };

const LABEL: Record<AdvanceAction, string> = {
  recordSurvey: "Recording the survey",
  submitApplication: "Submitting the application",
  markInvoiced: "Marking the application invoiced",
  markPaid: "Marking the application paid",
  startInstallation: "Starting installation",
  markReady: "Marking the connection ready",
  convert: "Converting to an account",
};

const WAIVED_BY: Partial<Record<AdvanceAction, string>> = {
  recordSurvey: "This organization does not require a survey",
  markInvoiced: "This organization does not require a new-connection invoice",
  markPaid: "This organization does not require a new-connection invoice",
  startInstallation: "This organization does not require installation",
};

/**
 * Where `action` takes an application now at `stage`, or why it cannot. No stage is skipped
 * except a waived one; final stages are final.
 */
export function planAdvance(stage: ApplicationStage, action: AdvanceAction, config: ApplicationConfig): Advance {
  if (isFinalStage(stage)) return { ok: false, problem: `This application is ${stage} and can no longer change` };
  const target = ADVANCE_ACTIONS[action];
  if (!activeStages(config).includes(target)) return { ok: false, problem: WAIVED_BY[action] ?? `${LABEL[action]} is not used` };
  if (nextStage(stage, config) !== target) {
    const next = nextStage(stage, config);
    return { ok: false, problem: `${LABEL[action]} is not possible at the ${stage} stage${next ? ` (next: ${next})` : ""}` };
  }
  return { ok: true, to: target };
}

/** Rejecting or cancelling ends the application from any stage that is not final. */
export function planEnd(stage: ApplicationStage, to: "rejected" | "cancelled"): Advance {
  if (isFinalStage(stage)) return { ok: false, problem: `This application is ${stage} and can no longer change` };
  return { ok: true, to };
}

/** May a survey result be recorded now? Only while the application is an enquiry and the survey is used. */
export function canRecordSurvey(stage: ApplicationStage, approval: "pending" | "approved" | "rejected" | null, config: ApplicationConfig): Advance {
  const planned = planAdvance(stage, "recordSurvey", config);
  if (!planned.ok) return planned;
  if (approval === "pending") return { ok: false, problem: "The survey is waiting for approval" };
  return planned;
}
