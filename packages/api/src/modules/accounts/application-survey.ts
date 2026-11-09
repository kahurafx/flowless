import { application } from "@flowless/db/schema/accounts";
import type { SurveyFeasibility } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { requestApproval as requestKernelApproval, type ApprovalDecided, type RequestApproval } from "../../kernel/approval-store";
import type { Viewer } from "./access";
import { canRecordSurvey, planAdvance } from "./application-stages";
import { configOf, customerName, findApplication, presentApplication, type ApplicationDto, type ApplicationRow } from "./application-present";
import { applicationLog, logStep, moveStage } from "./application-steps";
import { fingerprintOfRequest, type CommandEnv } from "./commands";
import { surveyApproval } from "./survey-approval";

/*
 * The connection survey and its approval (C-05, K-05). A survey result is recorded by the
 * office or from a completed survey job; a feasible one asks for approval, and the outcome
 * (immediately, or later through the approval consumer) moves the application from
 * `enquiry` to `survey`. `survey_recorded` and `survey_decided` rows in the step log leave
 * the stage where it was.
 */

export interface SurveyResult {
  feasibility: SurveyFeasibility;
  findings: string;
  materialsNote?: string | undefined;
}

/** Asks for the survey's approval as whoever is acting; the procedure path audits through `ctx.requestApproval`, the system path here. */
export type AskApproval = (input: Omit<RequestApproval, "requestedByUserId">) => Promise<{ id: string; status: "pending" | "approved" | "rejected" | "cancelled" }>;

/** For the system recording a survey (a completed job): asks as `requesterUserId`, audited. */
export function askAs(env: CommandEnv, requesterUserId: string): AskApproval {
  return async (input) => {
    const request = await requestKernelApproval(env.tx, env.organizationId, surveyApproval, { ...input, requestedByUserId: requesterUserId });
    await env.audit({
      action: "approvals.request",
      subjectType: "approval",
      subjectId: request.id,
      after: { kind: surveyApproval.key, subject: input.subjectRef, status: request.status, amount: null },
      reason: input.note || null,
    });
    return request;
  };
}

interface SurveyRequest {
  id?: string | undefined;
  applicationId: string;
  result: SurveyResult;
  source: "office" | "work_order";
  workOrderId?: string | undefined;
  ask: AskApproval | null;
}

interface SurveyOutcome {
  application: ApplicationDto;
  approval: { id: string; status: string } | null;
}

/**
 * Records a survey result (C-05) by the office or from a completed survey job. A feasible
 * result asks for approval (K-05, policy `approvals.accounts.connection_survey`); once
 * approved the application moves to `survey`, at once when the policy has no level. A result
 * that is not feasible is recorded and asks for nothing: the office rejects the application
 * or records a new survey. Only an enquiry takes a survey, and not while one is awaiting approval.
 */
export async function recordSurvey(env: CommandEnv, viewer: Viewer | null, req: SurveyRequest) {
  const before = await findApplication(env.tx, viewer, req.applicationId, true);
  const fingerprint = fingerprintOfRequest({ kind: "survey_recorded", applicationId: req.applicationId, ...req.result, source: req.source, workOrderId: req.workOrderId });
  return applicationLog.once<SurveyOutcome>(
    env,
    req.id,
    { parentId: before.id, kind: "survey_recorded", fingerprint },
    {
      replay: async () => ({
        application: await presentApplication(env.tx, before),
        approval: before.surveyApprovalId ? { id: before.surveyApprovalId, status: before.surveyApprovalState ?? "pending" } : null,
      }),
      run: () => applySurvey(env, before, req, fingerprint),
    },
  );
}

async function applySurvey(env: CommandEnv, before: ApplicationRow, req: SurveyRequest, fingerprint: string): Promise<SurveyOutcome> {
  const { tx } = env;
  const config = await configOf(tx);
  const allowed = canRecordSurvey(before.stage, before.surveyApprovalState, config);
  if (!allowed.ok) throw new TRPCError({ code: "PRECONDITION_FAILED", message: allowed.problem });

  const feasible = req.result.feasibility === "feasible";
  const [recorded] = await tx
    .update(application)
    .set({
      surveyFeasibility: req.result.feasibility,
      surveyFindings: req.result.findings.trim(),
      surveyMaterials: req.result.materialsNote?.trim() || null,
      surveyRecordedAt: new Date(),
      surveyRecordedByUserId: env.actor.userId,
      surveySource: req.source,
      surveyWorkOrderId: req.workOrderId ?? null,
      surveyApprovalId: null,
      surveyApprovalState: null,
      updatedAt: new Date(),
    })
    .where(eq(application.id, before.id))
    .returning();
  await logStep(env, before.id, {
    id: req.id,
    kind: "survey_recorded",
    from: before.stage,
    to: before.stage,
    reason: `Survey recorded: ${req.result.feasibility.replace("_", " ")}`,
    payload: { ...req.result, source: req.source, workOrderId: req.workOrderId ?? null },
    fingerprint,
  });
  await env.audit({
    action: "accounts.application_survey",
    subjectType: "application",
    subjectId: before.id,
    after: { feasibility: req.result.feasibility, source: req.source, workOrderId: req.workOrderId ?? null },
    reason: req.result.findings.trim(),
  });

  let row = recorded!;
  let approval: { id: string; status: string } | null = null;
  if (feasible && req.ask) {
    const name = (await customerName(tx, before.customerId)) ?? "customer";
    const asked = await req.ask({
      subjectRef: before.id,
      title: `Connection survey: ${name}, ${before.address}`,
      note: req.result.findings.trim(),
      payload: { applicationId: before.id },
      areaId: before.dmaId ?? before.zoneId ?? before.schemeId,
      routeId: before.routeId,
    });
    approval = { id: asked.id, status: asked.status };
    const approved = asked.status === "approved";
    row = (
      await tx
        .update(application)
        .set({ surveyApprovalId: asked.id, surveyApprovalState: approved ? "approved" : "pending", updatedAt: new Date() })
        .where(eq(application.id, before.id))
        .returning()
    )[0]!;
    if (approved) {
      // No level applies in the policy: approved at once.
      const next = planAdvance(row.stage, "recordSurvey", config);
      if (next.ok) {
        ({ row } = await moveStage(env, row, { to: next.to, reason: "Survey approved (no approval level applies)", payload: { approvalId: asked.id }, action: "application_survey_approved" }));
      }
    }
  }
  return { application: await presentApplication(tx, row), approval };
}

/**
 * The approval consumer's work: applies the outcome of a survey approval. An approval that
 * is not the application's current one (a survey recorded again since) is ignored; the
 * pending check makes a second delivery do nothing.
 */
export async function applySurveyDecision(env: CommandEnv, decided: ApprovalDecided): Promise<void> {
  const { tx } = env;
  const [found] = await tx.select({ id: application.id }).from(application).where(eq(application.id, decided.subjectRef));
  if (!found) return;
  const before = await findApplication(tx, null, found.id, true);
  if (before.surveyApprovalId !== decided.requestId || before.surveyApprovalState !== "pending") return;
  if (decided.outcome === "approved") {
    const config = await configOf(tx);
    const next = planAdvance(before.stage, "recordSurvey", config);
    if (!next.ok) {
      // Ended meanwhile (rejected or cancelled): note the outcome, change nothing else.
      await tx.update(application).set({ surveyApprovalState: "approved", updatedAt: new Date() }).where(eq(application.id, before.id));
      await logStep(env, before.id, { kind: "survey_decided", from: before.stage, to: before.stage, reason: "Survey approved after the application ended", payload: { approvalId: decided.requestId, outcome: "approved" } });
      return;
    }
    await moveStage(env, before, {
      to: next.to,
      reason: "Survey approved",
      payload: { approvalId: decided.requestId },
      set: { surveyApprovalState: "approved" },
      action: "application_survey_approved",
    });
    return;
  }
  await tx.update(application).set({ surveyApprovalState: "rejected", updatedAt: new Date() }).where(eq(application.id, before.id));
  await logStep(env, before.id, {
    kind: "survey_decided",
    from: before.stage,
    to: before.stage,
    reason: `Survey ${decided.outcome}: record a new survey`,
    payload: { approvalId: decided.requestId, outcome: decided.outcome },
  });
  await env.audit({
    action: "accounts.application_survey_rejected",
    subjectType: "application",
    subjectId: before.id,
    after: { approvalId: decided.requestId, outcome: decided.outcome },
    reason: `Survey ${decided.outcome}`,
  });
}
