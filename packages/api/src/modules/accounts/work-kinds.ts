import { application, relocation } from "@flowless/db/schema/accounts";
import { SURVEY_FEASIBILITIES } from "@flowless/shared-types";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { defineApprovalConsumer } from "../../kernel/approval-store";
import { defineConsumer } from "../../kernel/events";
import { defineWorkKind, type AssetRef, type AssetResolver, type WorkKindDef, type WorkRegistry } from "../../kernel/work";
import { applySurveyDecision, askAs, recordSurvey } from "./applications";
import { systemEnv } from "./commands";
import { connectionSurveyCompleted, relocationWorkCompleted } from "./events";
import { applyRelocationJob } from "./relocations";
import { surveyApproval } from "./survey-approval";

/*
 * Accounts' field work (W-01, W-03). The kinds are registered on the work registry from this
 * module's `register(work)` (wired in `src/wiring.ts`) and are offered only to an
 * organization with Accounts AND Work Orders licensed (tier "full"); without Work Orders the
 * office records the survey itself and everything works the same (C-05). A job points at its
 * application or relocation as its primary asset: `workOrders.create({ kind, assetId })`
 * with the id, which the asset resolver below answers for (module `accounts`). Accounts
 * does not create jobs itself: the office raises them in Work Orders.
 */

/** What a completed connection survey records (the kind's capture form). */
export const connectionSurveyCapture = z.object({
  feasibility: z.enum(SURVEY_FEASIBILITIES),
  findings: z.string().trim().min(1, "Say what the survey found"),
  materials: z.string().trim().max(2000).default(""),
});

/** What a completed relocation job records: the final reading of the old point and the initial reading of the new one. */
export const relocationCapture = z.object({
  finalReading: z.string().trim().max(40).optional(),
  initialReading: z.string().trim().max(40).optional(),
  notes: z.string().trim().max(2000).default(""),
});

export const ACCOUNTS_WORK_KINDS: readonly WorkKindDef[] = [
  defineWorkKind({
    key: "connection_survey",
    module: "accounts",
    label: "Connection survey",
    target: "location",
    // Accounts' own approval (K-05) decides the survey; a job review on top is the organization's choice.
    review: "optional",
    tier: "full",
    gis: "none",
    capture: connectionSurveyCapture,
    evidence: { gps: true },
    completionEvent: connectionSurveyCompleted,
    slaHours: 168,
  }),
  defineWorkKind({
    key: "relocation",
    module: "accounts",
    label: "Relocation",
    target: "account",
    review: "optional",
    tier: "full",
    gis: "none",
    capture: relocationCapture,
    evidence: { gps: true },
    completionEvent: relocationWorkCompleted,
    slaHours: 168,
  }),
];

/** Answers for applications and relocations as the "assets" Accounts' jobs are about. */
export const accountsAssetResolver: AssetResolver = {
  module: "accounts",
  async resolve(tx, ids) {
    const found = new Map<string, AssetRef>();
    const [applications, relocations] = await Promise.all([
      tx.select().from(application).where(inArray(application.id, [...ids])),
      tx.select().from(relocation).where(inArray(relocation.id, [...ids])),
    ]);
    for (const a of applications) {
      found.set(a.id, {
        id: a.id,
        module: "accounts",
        type: "application",
        name: `Application: ${a.address}`,
        location: a.location ? { latitude: a.location.lat, longitude: a.location.lng } : null,
        state: "registered",
        possibleDuplicateOf: null,
      });
    }
    for (const r of relocations) {
      found.set(r.id, {
        id: r.id,
        module: "accounts",
        type: "relocation",
        name: `Relocation to ${r.toAddress}`,
        location: r.toLocation ? { latitude: r.toLocation.lat, longitude: r.toLocation.lng } : null,
        state: "registered",
        possibleDuplicateOf: null,
      });
    }
    return found;
  },
};

/** Plugs Accounts into the work registry (W-01): its kinds and the asset resolver. */
export function register(work: WorkRegistry) {
  for (const kind of ACCOUNTS_WORK_KINDS) work.registerWorkKind(kind);
  work.registerAssetResolver(accountsAssetResolver);
}

/* ---------- consumers ---------- */

/**
 * A completed connection survey job records the survey on its application (C-05), as the
 * system: it asks for the survey's approval as the person who did the job. Idempotent: a job
 * already recorded on the application is skipped. Not about an application that still takes
 * a survey (it ended, or the survey was recorded by hand) is ignored.
 */
export const recordSurveyFromJob = defineConsumer({
  name: "accounts.record_survey_from_job",
  module: "accounts",
  event: connectionSurveyCompleted,
  async handle(ctx, job) {
    if (job.assetModule !== "accounts" || !job.assetId) return;
    const env = systemEnv(ctx.tx, ctx.organizationId);
    const [app] = await ctx.tx.select().from(application).where(eq(application.id, job.assetId));
    if (!app) return; // the job is not about an application of this organization
    if (app.surveyWorkOrderId === job.workOrderId || app.stage !== "enquiry") return;
    const capture = connectionSurveyCapture.parse(job.capture);
    const requester = job.completedByUserId ?? job.approvedByUserId;
    await recordSurvey(env, null, {
      applicationId: app.id,
      result: { feasibility: capture.feasibility, findings: capture.findings, materialsNote: capture.materials },
      source: "work_order",
      workOrderId: job.workOrderId,
      ask: requester ? askAs(env, requester) : null,
    });
  },
});

/** A completed relocation job records its readings on the relocation. */
export const recordRelocationFromJob = defineConsumer({
  name: "accounts.record_relocation_from_job",
  module: "accounts",
  event: relocationWorkCompleted,
  async handle(ctx, job) {
    await applyRelocationJob(systemEnv(ctx.tx, ctx.organizationId), job);
  },
});

/** The survey approval's outcome moves the application on (or records the rejection). */
export const applySurveyOutcome = defineApprovalConsumer(surveyApproval, "accounts.apply_survey_decision", async (ctx, decided) => {
  await applySurveyDecision(systemEnv(ctx.tx, ctx.organizationId), decided);
});
