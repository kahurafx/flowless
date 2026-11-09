import { application, applicationEvent } from "@flowless/db/schema/accounts";
import type { ApplicationStage } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import type { Viewer } from "./access";
import { planAdvance, planEnd, type AdvanceAction } from "./application-stages";
import { configOf, findApplication, presentApplication, type ApplicationResult, type ApplicationRow, type ApplicationStepRow } from "./application-present";
import type { ActionEnv } from "../../kernel/action-env";
import { fingerprintOfRequest } from "./command-log";
import { applicationStageChanged } from "./events";
import { defineStepLog } from "./idempotent";

/*
 * The application's step log (table `application_event`) and the stage moves written to it
 * (C-05). Every step is a row of the append-only log with a client-mintable id (the same id
 * and request replays, anything else is CONFLICT: `applicationLog`, `idempotent.ts`); a
 * database trigger refuses a stage change that has no row. Rows of kind `stage_changed` and
 * `created` move the stage, while `survey_recorded` and `survey_decided` rows record a step
 * that leaves it where it was.
 */

/** The application step log: append a step, replay a repeat (the same id for the same application, kind, actor and request). */
export const applicationLog = defineStepLog(applicationEvent, "applicationId");

/** Publishes `accounts.application_stage_changed` for a step row. */
export function publishStageChanged(env: ActionEnv, app: Pick<ApplicationRow, "id" | "customerId">, step: ApplicationStepRow, from: ApplicationStage | null, to: ApplicationStage) {
  return env.publish(applicationStageChanged, {
    applicationId: app.id,
    eventId: step.id,
    customerId: app.customerId,
    from,
    to,
    reason: step.reason,
    actorUserId: step.actorUserId,
    occurredAt: step.occurredAt.toISOString(),
  });
}

export interface StageMove {
  id?: string | undefined;
  to: ApplicationStage;
  reason: string;
  payload?: Record<string, unknown>;
  fingerprint?: string | undefined;
  set?: Partial<typeof application.$inferInsert>;
  action: string;
}

/** Records a stage move: the step row, the new stage (plus any columns that move with it), the audit entry and the stage event. */
export async function moveStage(env: ActionEnv, before: ApplicationRow, move: StageMove): Promise<{ row: ApplicationRow; event: ApplicationStepRow }> {
  const event = await applicationLog.append(env, before.id, {
    id: move.id,
    kind: "stage_changed",
    fromStage: before.stage,
    toStage: move.to,
    reason: move.reason,
    payload: move.payload,
    fingerprint: move.fingerprint,
  });
  const [row] = await env.tx
    .update(application)
    .set({ ...move.set, stage: move.to, updatedAt: new Date() })
    .where(eq(application.id, before.id))
    .returning();
  await env.audit({
    action: `accounts.${move.action}`,
    subjectType: "application",
    subjectId: before.id,
    before: { stage: before.stage },
    after: { stage: move.to, eventId: event.id, ...(move.payload ?? {}) },
    reason: move.reason.trim(),
  });
  await publishStageChanged(env, before, event, before.stage, move.to);
  return { row: row!, event };
}

/** The stage a decided step moves to; the id, reason and fingerprint come from the request. */
type Decision = Pick<StageMove, "to" | "payload" | "set" | "action">;

/**
 * A plain stage move (one `stage_changed` row): lock the application, replay a repeat of the
 * same request, otherwise `decide` the move (it throws when the move is not allowed) and write it.
 */
async function stageStep(
  env: ActionEnv,
  viewer: Viewer | null,
  req: { id?: string | undefined; applicationId: string; reason: string },
  fingerprint: string,
  decide: (before: ApplicationRow) => Promise<Decision>,
): Promise<ApplicationResult> {
  const before = await findApplication(env.tx, viewer, req.applicationId, true);
  return applicationLog.once(
    env,
    req.id,
    { parentId: before.id, kind: "stage_changed", fingerprint },
    {
      replay: async () => ({ application: await presentApplication(env.tx, before) }),
      run: async () => {
        const decision = await decide(before);
        const { row } = await moveStage(env, before, { id: req.id, reason: req.reason, fingerprint, ...decision });
        return { application: await presentApplication(env.tx, row) };
      },
    },
  );
}

export interface AdvanceRequest {
  id?: string | undefined;
  applicationId: string;
  action: Exclude<AdvanceAction, "recordSurvey" | "convert">;
  reason: string;
  /** markInvoiced: the new-connection invoice's reference (opaque until Billing). */
  invoiceRef?: string | undefined;
  /** markPaid: the payment's reference (opaque until Payments). */
  paymentRef?: string | undefined;
}

const ACTION_AUDIT: Record<AdvanceRequest["action"], string> = {
  submitApplication: "application_submit",
  markInvoiced: "application_invoiced",
  markPaid: "application_paid",
  startInstallation: "application_installation",
  markReady: "application_ready",
};

/** submitApplication, markInvoiced, markPaid, startInstallation and markReady: each moves the application one stage on. */
export function advanceApplication(env: ActionEnv, viewer: Viewer | null, req: AdvanceRequest): Promise<ApplicationResult> {
  const fingerprint = fingerprintOfRequest({ kind: "stage_changed", action: req.action, applicationId: req.applicationId, reason: req.reason, invoiceRef: req.invoiceRef, paymentRef: req.paymentRef });
  return stageStep(env, viewer, req, fingerprint, async (before) => {
    const plan = planAdvance(before.stage, req.action, await configOf(env.tx));
    if (!plan.ok) throw new TRPCError({ code: "PRECONDITION_FAILED", message: plan.problem });
    if (req.action === "markInvoiced" && !req.invoiceRef) throw new TRPCError({ code: "BAD_REQUEST", message: "Give the invoice reference" });
    if (req.action === "markPaid" && !req.paymentRef) throw new TRPCError({ code: "BAD_REQUEST", message: "Give the payment reference" });
    const refs = { ...(req.invoiceRef ? { invoiceRef: req.invoiceRef } : {}), ...(req.paymentRef ? { paymentRef: req.paymentRef } : {}) };
    return { to: plan.to, payload: refs, set: refs, action: ACTION_AUDIT[req.action] };
  });
}

/** Rejects or cancels an application from any stage that is not final. */
export function endApplication(
  env: ActionEnv,
  viewer: Viewer | null,
  req: { id?: string | undefined; applicationId: string; to: "rejected" | "cancelled"; reason: string },
): Promise<ApplicationResult> {
  const fingerprint = fingerprintOfRequest({ kind: "stage_changed", action: req.to, applicationId: req.applicationId, reason: req.reason });
  return stageStep(env, viewer, req, fingerprint, async (before) => {
    const plan = planEnd(before.stage, req.to);
    if (!plan.ok) throw new TRPCError({ code: "PRECONDITION_FAILED", message: plan.problem });
    return { to: plan.to, action: `application_${req.to}` };
  });
}
