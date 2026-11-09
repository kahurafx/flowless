import { account, application, applicationEvent, customer, servicePoint } from "@flowless/db/schema/accounts";
import type { ApplicationEventKind, ApplicationStage, SurveyFeasibility } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import { and, asc, eq } from "drizzle-orm";
import type { LatLng, Transaction } from "@flowless/db";
import { requestApproval as requestKernelApproval, type ApprovalDecided, type RequestApproval } from "../../kernel/approval-store";
import { readSetting } from "../../kernel/config-store";
import { loadEntitlements } from "../../kernel/entitlement-store";
import { isUniqueViolation } from "../../kernel/pg-errors";
import { categoryExists } from "../tariffs";
import { applicationVisible, type Placement, type Viewer } from "./access";
import {
  canRecordSurvey,
  planAdvance,
  planEnd,
  type AdvanceAction,
  type ApplicationConfig,
} from "./application-stages";
import { fingerprintOfRequest, procedureEnv, runCommand, systemEnv, type CommandEnv } from "./commands";
import { createCustomer, type NewCustomer } from "./customers";
import { applicationConverted, applicationStageChanged } from "./events";
import { assertMembershipClass } from "./memberships";
import { openAccount } from "./open-account";
import { createServicePoint } from "./service-points";
import { assertPlacementInScope, findAccount, findCustomer, notFound, presentAccounts, toServicePointDto, validatePlacement } from "./service";
import { applicationSetting } from "./settings";
import { surveyApproval } from "./survey-approval";

/*
 * The application workflow's use cases (C-05): the only code that changes an application.
 * The pure `application-stages.ts` decides whether a move is allowed; here it is run under
 * the application's row lock, recorded as a row of the append-only `application_event`
 * (client-mintable id: a retry returns the earlier result, a different request under the
 * same id is CONFLICT), applied, audited and published, in the caller's transaction. A
 * database trigger refuses a stage change that has no event.
 *
 * Billing and Payments do not exist yet: `markInvoiced` and `markPaid` take opaque
 * references (an invoice number, a receipt number, a uuid) that the office types. Phase 4
 * (invoice issued for the application) and Phase 6 (payment allocated) replace them with
 * events that consume `accounts.application_stage_changed` and call these same use cases as
 * the system.
 */

export type ApplicationRow = typeof application.$inferSelect;
export type ApplicationEventRow = typeof applicationEvent.$inferSelect;

export function toApplicationDto(a: ApplicationRow, customerName: string | null = null) {
  return {
    id: a.id,
    customerId: a.customerId,
    customerName,
    /** Tariffs' category (opaque here). */
    requestedCategoryId: a.requestedCategoryId,
    parentAccountId: a.parentAccountId,
    membershipClass: a.membershipClass,
    address: a.address,
    location: a.location as LatLng | null,
    schemeId: a.schemeId,
    zoneId: a.zoneId,
    dmaId: a.dmaId,
    routeId: a.routeId,
    notes: a.notes,
    stage: a.stage,
    survey: a.surveyFeasibility
      ? {
          feasibility: a.surveyFeasibility,
          findings: a.surveyFindings ?? "",
          materialsNote: a.surveyMaterials ?? "",
          recordedAt: a.surveyRecordedAt,
          recordedByUserId: a.surveyRecordedByUserId,
          source: a.surveySource,
          workOrderId: a.surveyWorkOrderId,
          approvalId: a.surveyApprovalId,
          approvalState: a.surveyApprovalState,
        }
      : null,
    invoiceRef: a.invoiceRef,
    paymentRef: a.paymentRef,
    accountId: a.accountId,
    servicePointId: a.servicePointId,
    createdAt: a.createdAt,
    createdByUserId: a.createdByUserId,
    updatedAt: a.updatedAt,
  };
}
export type ApplicationDto = ReturnType<typeof toApplicationDto>;

export function toEventDto(e: ApplicationEventRow) {
  return {
    id: e.id,
    applicationId: e.applicationId,
    kind: e.kind,
    fromStage: e.fromStage,
    toStage: e.toStage,
    actorUserId: e.actorUserId,
    source: e.source,
    reason: e.reason,
    payload: e.payload as Record<string, unknown>,
    occurredAt: e.occurredAt,
  };
}

/** The application the viewer can see (null viewer: the system), optionally locked for the change that follows. */
export async function findApplication(tx: Transaction, viewer: Viewer | null, id: string, lock = false): Promise<ApplicationRow> {
  const query = tx
    .select()
    .from(application)
    .where(and(eq(application.id, id), viewer ? applicationVisible(viewer) : undefined));
  const [row] = await (lock ? query.for("update") : query);
  if (!row) throw notFound("Application");
  return row;
}

export async function eventsOf(tx: Transaction, applicationId: string): Promise<ApplicationEventRow[]> {
  return tx.select().from(applicationEvent).where(eq(applicationEvent.applicationId, applicationId)).orderBy(asc(applicationEvent.occurredAt), asc(applicationEvent.id));
}

async function customerName(tx: Transaction, id: string): Promise<string | null> {
  const [row] = await tx.select({ name: customer.name }).from(customer).where(eq(customer.id, id));
  return row?.name ?? null;
}

/** The application with its customer's name, for the caller. */
export async function presentApplication(tx: Transaction, row: ApplicationRow): Promise<ApplicationDto> {
  return toApplicationDto(row, await customerName(tx, row.customerId));
}

/** Who does the work: a person for the things that need one (creating customers and accounts). */
function userOf(env: CommandEnv): string {
  if (!env.actor.userId) throw new TRPCError({ code: "FORBIDDEN", message: "This step needs a person" });
  return env.actor.userId;
}

const placeOf = (a: Pick<ApplicationRow, "schemeId" | "zoneId" | "dmaId" | "routeId">): Placement => ({
  schemeId: a.schemeId,
  zoneId: a.zoneId,
  dmaId: a.dmaId,
  routeId: a.routeId,
});

/* ---------- the event log ---------- */

interface NewEvent {
  id?: string | undefined;
  kind: ApplicationEventKind;
  from: ApplicationStage | null;
  to: ApplicationStage;
  reason: string;
  payload?: Record<string, unknown>;
  fingerprint?: string | undefined;
}

async function logEvent(env: CommandEnv, applicationId: string, e: NewEvent): Promise<ApplicationEventRow> {
  try {
    const [row] = await env.tx
      .insert(applicationEvent)
      .values({
        ...(e.id ? { id: e.id } : {}),
        organizationId: env.organizationId,
        applicationId,
        kind: e.kind,
        fromStage: e.from,
        toStage: e.to,
        actorUserId: env.actor.userId,
        source: env.source,
        reason: e.reason.trim(),
        payload: e.payload ?? {},
        fingerprint: e.fingerprint ?? null,
      })
      .returning();
    return row!;
  } catch (error) {
    if (isUniqueViolation(error)) throw new TRPCError({ code: "CONFLICT", message: "That id is already in use" });
    throw error;
  }
}

/** The earlier event this id belongs to, or null if unused; CONFLICT when it was a different request. */
async function earlierEvent(
  env: CommandEnv,
  id: string | undefined,
  expected: { applicationId: string; kind: ApplicationEventKind; fingerprint: string },
): Promise<ApplicationEventRow | null> {
  if (!id) return null;
  const [earlier] = await env.tx.select().from(applicationEvent).where(eq(applicationEvent.id, id));
  if (!earlier) return null;
  if (
    earlier.applicationId !== expected.applicationId ||
    earlier.kind !== expected.kind ||
    earlier.actorUserId !== env.actor.userId ||
    earlier.fingerprint !== expected.fingerprint
  ) {
    throw new TRPCError({ code: "CONFLICT", message: "That id was already used for a different request" });
  }
  return earlier;
}

/** Records a stage move: the event, the new stage (plus any columns that move with it), the audit entry and the stage event. */
async function moveStage(
  env: CommandEnv,
  before: ApplicationRow,
  move: {
    id?: string | undefined;
    to: ApplicationStage;
    reason: string;
    payload?: Record<string, unknown>;
    fingerprint?: string | undefined;
    set?: Partial<typeof application.$inferInsert>;
    action: string;
  },
): Promise<{ row: ApplicationRow; event: ApplicationEventRow }> {
  const event = await logEvent(env, before.id, {
    id: move.id,
    kind: "stage_changed",
    from: before.stage,
    to: move.to,
    reason: move.reason,
    ...(move.payload ? { payload: move.payload } : {}),
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
  await env.publish(applicationStageChanged, {
    applicationId: before.id,
    eventId: event.id,
    customerId: before.customerId,
    from: before.stage,
    to: move.to,
    reason: event.reason,
    actorUserId: event.actorUserId,
    occurredAt: event.occurredAt.toISOString(),
  });
  return { row: row!, event };
}

export interface ApplicationResult {
  application: ApplicationDto;
  /** True when this id had already been used by the same request: nothing was done again. */
  replayed: boolean;
}

const configOf = async (tx: Transaction): Promise<ApplicationConfig> => (await readSetting(tx, applicationSetting)).value;

/* ---------- creating ---------- */

export interface NewApplication {
  /** Client-minted: a retry returns the same application. */
  id?: string | undefined;
  customerId?: string | undefined;
  /** A customer created together with the application, when there is no existing one. */
  newCustomer?: NewCustomer | undefined;
  requestedCategoryId?: string | undefined;
  parentAccountId?: string | undefined;
  membershipClass?: string | undefined;
  address: string;
  location?: LatLng | undefined;
  schemeId?: string | undefined;
  zoneId?: string | undefined;
  dmaId?: string | undefined;
  routeId?: string | undefined;
  notes?: string | undefined;
}

/** Logs an enquiry (C-05): the application starts at `enquiry`. */
export async function createApplication(env: CommandEnv, viewer: Viewer, input: NewApplication): Promise<ApplicationResult> {
  const { tx, organizationId } = env;
  const userId = userOf(env);
  if (input.id) {
    const [existing] = await tx.select().from(application).where(eq(application.id, input.id));
    if (existing) {
      if (existing.createdByUserId !== userId) throw new TRPCError({ code: "CONFLICT", message: "That id is already in use" });
      return { application: await presentApplication(tx, existing), replayed: true };
    }
  }
  if ((input.customerId === undefined) === (input.newCustomer === undefined)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Name the customer: an existing one or new customer details" });
  }
  const place: Placement = { schemeId: input.schemeId ?? null, zoneId: input.zoneId ?? null, dmaId: input.dmaId ?? null, routeId: input.routeId ?? null };
  await validatePlacement(tx, place, new Set(["schemeId", "zoneId", "dmaId", "routeId"]));
  // An enquiry may start with no area or route yet (the creator keeps seeing it); one that names a place must be inside the scope.
  if (Object.values(place).some((id) => id !== null)) assertPlacementInScope(viewer, place);
  if (input.requestedCategoryId && (await loadEntitlements(tx)).includes("tariffs")) {
    // Tariffs' published read, only while Tariffs is licensed: without it the category stays an opaque id.
    if (!(await categoryExists(tx, organizationId, input.requestedCategoryId, { activeOnly: true }))) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "That category does not exist or is not active" });
    }
  }
  const parent = input.parentAccountId ? await findAccount(tx, viewer, { id: input.parentAccountId }) : null;
  if (input.membershipClass) await assertMembershipClass(tx, input.membershipClass, parent !== null);
  else if (input.parentAccountId && !parent) throw notFound("Account");

  const customerId = input.customerId
    ? (await findCustomer(tx, viewer, input.customerId)).id
    : (await createCustomer({ tx, organizationId, userId, audit: env.audit, publish: env.publish }, input.newCustomer!)).id;

  const [row] = await tx
    .insert(application)
    .values({
      ...(input.id ? { id: input.id } : {}),
      organizationId,
      customerId,
      requestedCategoryId: input.requestedCategoryId ?? null,
      parentAccountId: parent?.id ?? null,
      membershipClass: input.membershipClass ?? null,
      address: input.address.trim().replace(/\s+/g, " "),
      location: input.location ?? null,
      ...place,
      notes: input.notes ?? null,
      stage: "enquiry",
      createdByUserId: userId,
    })
    .returning()
    .catch((error: unknown) => {
      if (isUniqueViolation(error)) throw new TRPCError({ code: "CONFLICT", message: "That id is already in use" });
      throw error;
    });
  const event = await logEvent(env, row!.id, { kind: "created", from: null, to: "enquiry", reason: "Enquiry logged" });
  await env.audit({
    action: "accounts.application_create",
    subjectType: "application",
    subjectId: row!.id,
    after: { customerId, address: row!.address, requestedCategoryId: row!.requestedCategoryId, parentAccountId: row!.parentAccountId, ...place },
  });
  await env.publish(applicationStageChanged, {
    applicationId: row!.id,
    eventId: event.id,
    customerId,
    from: null,
    to: "enquiry",
    reason: event.reason,
    actorUserId: userId,
    occurredAt: event.occurredAt.toISOString(),
  });
  return { application: await presentApplication(tx, row!), replayed: false };
}

/* ---------- the survey ---------- */

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

/**
 * Records a survey result (C-05) by the office or from a completed survey job. A feasible
 * result asks for approval (K-05, policy `approvals.accounts.connection_survey`); once
 * approved the application moves to `survey`, at once when the policy has no level. A result
 * that is not feasible is recorded and asks for nothing: the office rejects the application
 * or records a new survey. Only an enquiry takes a survey, and not while one is awaiting approval.
 */
export async function recordSurvey(
  env: CommandEnv,
  viewer: Viewer | null,
  req: {
    id?: string | undefined;
    applicationId: string;
    result: SurveyResult;
    source: "office" | "work_order";
    workOrderId?: string | undefined;
    ask: AskApproval | null;
  },
): Promise<ApplicationResult & { approval: { id: string; status: string } | null }> {
  const { tx } = env;
  const before = await findApplication(tx, viewer, req.applicationId, true);
  const fingerprint = fingerprintOfRequest({ kind: "survey_recorded", applicationId: req.applicationId, ...req.result, source: req.source, workOrderId: req.workOrderId });
  const earlier = await earlierEvent(env, req.id, { applicationId: before.id, kind: "survey_recorded", fingerprint });
  if (earlier) {
    return {
      application: await presentApplication(tx, before),
      replayed: true,
      approval: before.surveyApprovalId ? { id: before.surveyApprovalId, status: before.surveyApprovalState ?? "pending" } : null,
    };
  }
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
  await logEvent(env, before.id, {
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
      const next = planAdvance(row!.stage, "recordSurvey", config);
      if (next.ok) {
        ({ row } = await moveStage(env, row!, { to: next.to, reason: "Survey approved (no approval level applies)", payload: { approvalId: asked.id }, action: "application_survey_approved" }));
      }
    }
  }
  return { application: await presentApplication(tx, row!), replayed: false, approval };
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
      await logEvent(env, before.id, { kind: "survey_decided", from: before.stage, to: before.stage, reason: "Survey approved after the application ended", payload: { approvalId: decided.requestId, outcome: "approved" } });
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
  await logEvent(env, before.id, {
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

/* ---------- the other stages ---------- */

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
export async function advanceApplication(env: CommandEnv, viewer: Viewer | null, req: AdvanceRequest): Promise<ApplicationResult> {
  const { tx } = env;
  const before = await findApplication(tx, viewer, req.applicationId, true);
  const fingerprint = fingerprintOfRequest({ kind: "stage_changed", action: req.action, applicationId: req.applicationId, reason: req.reason, invoiceRef: req.invoiceRef, paymentRef: req.paymentRef });
  const earlier = await earlierEvent(env, req.id, { applicationId: before.id, kind: "stage_changed", fingerprint });
  if (earlier) return { application: await presentApplication(tx, before), replayed: true };

  const plan = planAdvance(before.stage, req.action, await configOf(tx));
  if (!plan.ok) throw new TRPCError({ code: "PRECONDITION_FAILED", message: plan.problem });
  if (req.action === "markInvoiced" && !req.invoiceRef) throw new TRPCError({ code: "BAD_REQUEST", message: "Give the invoice reference" });
  if (req.action === "markPaid" && !req.paymentRef) throw new TRPCError({ code: "BAD_REQUEST", message: "Give the payment reference" });

  const { row } = await moveStage(env, before, {
    id: req.id,
    to: plan.to,
    reason: req.reason,
    payload: { ...(req.invoiceRef ? { invoiceRef: req.invoiceRef } : {}), ...(req.paymentRef ? { paymentRef: req.paymentRef } : {}) },
    fingerprint,
    set: { ...(req.invoiceRef ? { invoiceRef: req.invoiceRef } : {}), ...(req.paymentRef ? { paymentRef: req.paymentRef } : {}) },
    action: ACTION_AUDIT[req.action],
  });
  return { application: await presentApplication(tx, row), replayed: false };
}

/** Rejects or cancels an application from any stage that is not final. */
export async function endApplication(
  env: CommandEnv,
  viewer: Viewer | null,
  req: { id?: string | undefined; applicationId: string; to: "rejected" | "cancelled"; reason: string },
): Promise<ApplicationResult> {
  const { tx } = env;
  const before = await findApplication(tx, viewer, req.applicationId, true);
  const fingerprint = fingerprintOfRequest({ kind: "stage_changed", action: req.to, applicationId: req.applicationId, reason: req.reason });
  const earlier = await earlierEvent(env, req.id, { applicationId: before.id, kind: "stage_changed", fingerprint });
  if (earlier) return { application: await presentApplication(tx, before), replayed: true };
  const plan = planEnd(before.stage, req.to);
  if (!plan.ok) throw new TRPCError({ code: "PRECONDITION_FAILED", message: plan.problem });
  const { row } = await moveStage(env, before, { id: req.id, to: plan.to, reason: req.reason, fingerprint, action: `application_${req.to}` });
  return { application: await presentApplication(tx, row), replayed: false };
}

/* ---------- converting ---------- */

/**
 * Converts a ready application into an account (C-05): opens the account with the next
 * number (a child under `parentAccountId`, with its membership class), creates the service
 * point from the requested place, and, when the organization uses the new-connection
 * invoice, moves the account NEW to PENDING_PAYMENT with the F3a command. Activation is
 * F3a's gates, not decided here. The application keeps the account's id.
 */
export async function convertApplication(
  env: CommandEnv,
  viewer: Viewer,
  req: { id?: string | undefined; applicationId: string; reason: string },
) {
  const { tx, organizationId } = env;
  const userId = userOf(env);
  const before = await findApplication(tx, viewer, req.applicationId, true);
  const fingerprint = fingerprintOfRequest({ kind: "stage_changed", action: "convert", applicationId: req.applicationId, reason: req.reason });
  const earlier = await earlierEvent(env, req.id, { applicationId: before.id, kind: "stage_changed", fingerprint });
  if (earlier && before.accountId && before.servicePointId) return { application: await presentApplication(tx, before), replayed: true, ...(await createdBy(tx, before.accountId!, before.servicePointId!)) };

  const config = await configOf(tx);
  const plan = planAdvance(before.stage, "convert", config);
  if (!plan.ok) throw new TRPCError({ code: "PRECONDITION_FAILED", message: plan.problem });

  const userEnv = { tx, organizationId, userId, audit: env.audit, publish: env.publish };
  const row = await openAccount(userEnv, viewer, {
    customerId: before.customerId,
    parentAccountId: before.parentAccountId ?? undefined,
    categoryId: before.requestedCategoryId,
    membershipClass: before.membershipClass,
  });
  const point = await createServicePoint(userEnv, viewer, {
    accountId: row.id,
    address: before.address,
    location: before.location as LatLng | null,
    ...placeOf(before),
    connectionStatus: "PLANNED",
  });
  const moved = await moveStage(env, before, {
    id: req.id,
    to: "converted",
    reason: req.reason,
    payload: { accountId: row.id, accountNumber: row.number, servicePointId: point.id },
    fingerprint,
    set: { accountId: row.id, servicePointId: point.id },
    action: "application_convert",
  });
  if (config.invoice.required) {
    // The new-connection invoice is out: payment is awaited (F3a command, logged and audited as any status change).
    await runCommand(env, viewer, {
      kind: "mark_pending_payment",
      accountId: row.id,
      reason: `New-connection invoice for application ${before.id.slice(0, 8)}`,
    });
  }
  await env.publish(applicationConverted, {
    applicationId: before.id,
    accountId: row.id,
    accountNumber: row.number,
    servicePointId: point.id,
    customerId: before.customerId,
    categoryId: before.requestedCategoryId,
    parentAccountId: before.parentAccountId,
    membershipClass: before.membershipClass,
    convertedByUserId: userId,
    occurredAt: moved.event.occurredAt.toISOString(),
  });
  return { application: await presentApplication(tx, moved.row), replayed: false, ...(await createdBy(tx, row.id, point.id)) };
}

/** The account and service point a converted application made, as the caller sees them. */
async function createdBy(tx: Transaction, accountId: string, servicePointId: string) {
  const [acc] = await tx.select().from(account).where(eq(account.id, accountId));
  const [sp] = await tx.select().from(servicePoint).where(eq(servicePoint.id, servicePointId));
  if (!acc || !sp) return {};
  return { account: (await presentAccounts(tx, [acc]))[0]!, servicePoint: toServicePointDto(sp) };
}

/** The env for a procedure's context (re-exported so routers import one place). */
export { procedureEnv, systemEnv };
