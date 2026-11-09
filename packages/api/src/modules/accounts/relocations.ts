import type { LatLng, Transaction } from "@flowless/db";
import { relocation, relocationEvent, servicePoint } from "@flowless/db/schema/accounts";
import type { RelocationEventKind, RelocationStatus, SurveyFeasibility } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import { and, asc, eq } from "drizzle-orm";
import { readSetting } from "../../kernel/config-store";
import { loadEntitlements } from "../../kernel/entitlement-store";
import { chargeItemByCode } from "../tariffs";
import { relocationVisible, type Placement, type Viewer } from "./access";
import { logChange, reload } from "./account-changes";
import { commandLog, fingerprintOfRequest, lockAccount, toCommandDto, type CommandEnv } from "./commands";
import { servicePointRelocated, type JobCompleted } from "./events";
import { localToday } from "./holders";
import { claimingId, createdStep, loggedStep } from "./idempotent";
import { createServicePoint } from "./service-points";
import { assertPlacementInScope, findAccount, findServicePoint, notFound, toServicePointDto, validatePlacement, type AccountRow } from "./service";
import { applicationSetting } from "./settings";

/*
 * Relocation on the same account (C-09): the customer moves the connection and keeps the
 * account number and status. Request, survey (when the organization requires one,
 * `accounts.application.relocation.surveyRequired`), optional transfer of fees (charge item
 * codes, recorded and not invoiced: Billing reads the `accounts.service_point_relocated`
 * event), then completion: the new service point is created from the new place, the old one
 * is DECOMMISSIONED, and the zone, DMA and route are those of the new place. Re-deriving the
 * tariff from the new place is Tariffs' and Billing's reaction to the event. The final reading
 * of the old point and the initial reading of the new one are recorded as opaque text (from
 * the office or the `relocation` job's capture) until Metering exists. The status of the
 * relocation moves only with a `relocation_event` (trigger), and completion is a `relocate`
 * row in the account's command log, so it is idempotent by its client-minted id.
 */

export type RelocationRow = typeof relocation.$inferSelect;
export type RelocationEventRow = typeof relocationEvent.$inferSelect;

export function toRelocationDto(r: RelocationRow) {
  return {
    id: r.id,
    accountId: r.accountId,
    fromServicePointId: r.fromServicePointId,
    newServicePointId: r.newServicePointId,
    to: {
      address: r.toAddress,
      location: r.toLocation as LatLng | null,
      schemeId: r.toSchemeId,
      zoneId: r.toZoneId,
      dmaId: r.toDmaId,
      routeId: r.toRouteId,
    },
    status: r.status,
    reason: r.reason,
    feeItemCodes: r.feeItemCodes as string[],
    survey: r.surveyFeasibility ? { feasibility: r.surveyFeasibility, findings: r.surveyFindings ?? "" } : null,
    finalReading: r.finalReading,
    initialReading: r.initialReading,
    workOrderId: r.workOrderId,
    requestedByUserId: r.requestedByUserId,
    requestedAt: r.requestedAt,
    completedAt: r.completedAt,
    updatedAt: r.updatedAt,
  };
}
export type RelocationDto = ReturnType<typeof toRelocationDto>;

export function toRelocationEventDto(e: RelocationEventRow) {
  return {
    id: e.id,
    relocationId: e.relocationId,
    kind: e.kind,
    fromStatus: e.fromStatus,
    toStatus: e.toStatus,
    actorUserId: e.actorUserId,
    source: e.source,
    reason: e.reason,
    payload: e.payload as Record<string, unknown>,
    occurredAt: e.occurredAt,
  };
}

export async function findRelocation(tx: Transaction, viewer: Viewer | null, id: string, lock = false): Promise<RelocationRow> {
  const query = tx
    .select()
    .from(relocation)
    .where(and(eq(relocation.id, id), viewer ? relocationVisible(viewer) : undefined));
  const [row] = await (lock ? query.for("update") : query);
  if (!row) throw notFound("Relocation");
  return row;
}

export const relocationEventsOf = (tx: Transaction, relocationId: string) =>
  tx.select().from(relocationEvent).where(eq(relocationEvent.relocationId, relocationId)).orderBy(asc(relocationEvent.occurredAt), asc(relocationEvent.id));

const isOpen = (status: RelocationStatus) => status === "requested" || status === "surveyed";

/** The relocation step log's idempotency (replay for the same relocation, kind, actor and request). */
const relocationLog = loggedStep<RelocationEventRow>({
  find: async (tx, id) => (await tx.select().from(relocationEvent).where(eq(relocationEvent.id, id)))[0],
  parentOf: (e) => e.relocationId,
});

/** The idempotency of `request`: a repeat of the creator's own id replays. */
const relocationCreation = createdStep<RelocationRow>({
  find: async (tx, id) => (await tx.select().from(relocation).where(eq(relocation.id, id)))[0],
  creatorOf: (r) => r.requestedByUserId,
});

/** One row of the relocation's step log. Not every kind moves the status: `work_recorded` rows (and a `survey_recorded` that leaves the status where it was) have from = to. */
async function logEvent(
  env: CommandEnv,
  relocationId: string,
  e: { id?: string | undefined; kind: RelocationEventKind; from: RelocationStatus | null; to: RelocationStatus; reason: string; payload?: Record<string, unknown>; fingerprint?: string | undefined },
) {
  const [row] = await claimingId(() =>
    env.tx
      .insert(relocationEvent)
      .values({
        ...(e.id ? { id: e.id } : {}),
        organizationId: env.organizationId,
        relocationId,
        kind: e.kind,
        fromStatus: e.from,
        toStatus: e.to,
        actorUserId: env.actor.userId,
        source: env.source,
        reason: e.reason.trim(),
        payload: e.payload ?? {},
        fingerprint: e.fingerprint ?? null,
      })
      .returning(),
  );
  return row!;
}

/**
 * Locks the relocation's account, then the relocation, in that order (the order every use
 * case takes, so two of them on one relocation take turns). A hidden relocation or account
 * is NOT_FOUND; the system (`viewer` null) sees everything.
 */
async function lockedRelocation(env: CommandEnv, viewer: Viewer | null, relocationId: string): Promise<{ row: RelocationRow; account: AccountRow }> {
  const unlocked = await findRelocation(env.tx, viewer, relocationId);
  const owner = await lockAccount(env.tx, viewer, unlocked.accountId);
  return { row: await findRelocation(env.tx, viewer, relocationId, true), account: owner };
}

/**
 * A step on an open relocation that is logged in `relocation_event` and replays by its id:
 * lock, replay a repeat, refuse a closed relocation, then `apply` changes and audits it.
 */
async function openRelocationStep(
  env: CommandEnv,
  viewer: Viewer | null,
  req: { id?: string | undefined; relocationId: string },
  step: { kind: RelocationEventKind; fingerprint: string; apply(row: RelocationRow): Promise<RelocationRow> },
) {
  const { row } = await lockedRelocation(env, viewer, req.relocationId);
  return relocationLog.once(
    env,
    req.id,
    { parentId: row.id, kind: step.kind, fingerprint: step.fingerprint },
    {
      replay: () => ({ relocation: toRelocationDto(row) }),
      run: async () => {
        if (!isOpen(row.status)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `This relocation is ${row.status}` });
        return { relocation: toRelocationDto(await step.apply(row)) };
      },
    },
  );
}

const placeOf = (r: RelocationRow): Placement => ({ schemeId: r.toSchemeId, zoneId: r.toZoneId, dmaId: r.toDmaId, routeId: r.toRouteId });

/* ---------- request ---------- */

export interface NewRelocation {
  /** Client-minted: a retry returns the same relocation. */
  id?: string | undefined;
  accountId: string;
  fromServicePointId: string;
  to: { address: string; location?: LatLng | undefined; schemeId?: string | undefined; zoneId?: string | undefined; dmaId?: string | undefined; routeId?: string | undefined };
  reason: string;
  /** Charge item codes whose fees move with the customer (recorded, not invoiced). */
  feeItemCodes?: string[] | undefined;
}

export function requestRelocation(env: CommandEnv, viewer: Viewer, input: NewRelocation): Promise<{ relocation: RelocationDto; replayed: boolean }> {
  return relocationCreation.once(env, input.id, undefined, {
    replay: (existing) => ({ relocation: toRelocationDto(existing) }),
    run: () => applyRequest(env, viewer, input),
  });
}

async function applyRequest(env: CommandEnv, viewer: Viewer, input: NewRelocation) {
  const { tx, organizationId } = env;
  const userId = env.actor.userId!;
  const acct = await findAccount(tx, viewer, { id: input.accountId }, true);
  if (acct.commercialStatus === "TERMINATED") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This account is terminated" });
  const from = await findServicePoint(tx, viewer, input.fromServicePointId);
  if (from.accountId !== acct.id) throw new TRPCError({ code: "BAD_REQUEST", message: "That service point is not this account's" });
  if (from.connectionStatus === "DECOMMISSIONED") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "That service point is already decommissioned" });
  const place: Placement = { schemeId: input.to.schemeId ?? null, zoneId: input.to.zoneId ?? null, dmaId: input.to.dmaId ?? null, routeId: input.to.routeId ?? null };
  await validatePlacement(tx, place, new Set(["schemeId", "zoneId", "dmaId", "routeId"]));
  assertPlacementInScope(viewer, place);

  const codes = [...new Set((input.feeItemCodes ?? []).map((c) => c.trim()).filter(Boolean))];
  if (codes.length && (await loadEntitlements(tx)).includes("tariffs")) {
    const today = await localToday(tx);
    for (const code of codes) {
      if (!(await chargeItemByCode(tx, organizationId, code, today))) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `No charge item with the code ${code}` });
      }
    }
  }
  const [row] = await claimingId(
    () =>
      tx
        .insert(relocation)
        .values({
          ...(input.id ? { id: input.id } : {}),
          organizationId,
          accountId: acct.id,
          fromServicePointId: from.id,
          toAddress: input.to.address.trim().replace(/\s+/g, " "),
          toLocation: input.to.location ?? null,
          toSchemeId: place.schemeId,
          toZoneId: place.zoneId,
          toDmaId: place.dmaId,
          toRouteId: place.routeId,
          reason: input.reason.trim(),
          feeItemCodes: codes,
          requestedByUserId: userId,
        })
        .returning(),
    "This service point already has a relocation under way, or that id is in use",
  );
  await logEvent(env, row!.id, { kind: "requested", from: null, to: "requested", reason: input.reason, payload: { feeItemCodes: codes } });
  await env.audit({
    action: "accounts.relocation_request",
    subjectType: "relocation",
    subjectId: row!.id,
    after: { accountId: acct.id, number: acct.number, fromServicePointId: from.id, toAddress: row!.toAddress, feeItemCodes: codes, ...place },
    reason: input.reason.trim(),
  });
  return { relocation: toRelocationDto(row!) };
}

/* ---------- survey and work ---------- */

export function recordRelocationSurvey(
  env: CommandEnv,
  viewer: Viewer,
  req: { id?: string | undefined; relocationId: string; feasibility: SurveyFeasibility; findings: string },
) {
  const fingerprint = fingerprintOfRequest({ kind: "survey_recorded", ...req });
  return openRelocationStep(env, viewer, req, {
    kind: "survey_recorded",
    fingerprint,
    async apply(before) {
      const to: RelocationStatus = req.feasibility === "feasible" ? "surveyed" : "requested";
      await logEvent(env, before.id, {
        id: req.id,
        kind: "survey_recorded",
        from: before.status,
        to,
        reason: `Survey recorded: ${req.feasibility.replace("_", " ")}`,
        payload: { feasibility: req.feasibility, findings: req.findings },
        fingerprint,
      });
      const [row] = await env.tx
        .update(relocation)
        .set({ surveyFeasibility: req.feasibility, surveyFindings: req.findings.trim(), status: to, updatedAt: new Date() })
        .where(eq(relocation.id, before.id))
        .returning();
      await env.audit({
        action: "accounts.relocation_survey",
        subjectType: "relocation",
        subjectId: before.id,
        before: { status: before.status },
        after: { status: to, feasibility: req.feasibility },
        reason: req.findings.trim(),
      });
      return row!;
    },
  });
}

/** Records the readings and the job on an open relocation without changing its status: from the office, or from a completed `relocation` job. */
export function recordRelocationWork(
  env: CommandEnv,
  viewer: Viewer | null,
  req: { id?: string | undefined; relocationId: string; finalReading?: string | undefined; initialReading?: string | undefined; workOrderId?: string | undefined },
) {
  const fingerprint = fingerprintOfRequest({ kind: "work_recorded", ...req });
  return openRelocationStep(env, viewer, req, {
    kind: "work_recorded",
    fingerprint,
    async apply(before) {
      const [row] = await env.tx
        .update(relocation)
        .set({
          finalReading: req.finalReading?.trim() || before.finalReading,
          initialReading: req.initialReading?.trim() || before.initialReading,
          workOrderId: req.workOrderId ?? before.workOrderId,
          updatedAt: new Date(),
        })
        .where(eq(relocation.id, before.id))
        .returning();
      await logEvent(env, before.id, {
        id: req.id,
        kind: "work_recorded",
        from: before.status,
        to: before.status,
        reason: req.workOrderId ? "Relocation job completed" : "Readings recorded",
        payload: { finalReading: req.finalReading ?? null, initialReading: req.initialReading ?? null, workOrderId: req.workOrderId ?? null },
        fingerprint,
      });
      await env.audit({
        action: "accounts.relocation_work",
        subjectType: "relocation",
        subjectId: before.id,
        after: { finalReading: row!.finalReading, initialReading: row!.initialReading, workOrderId: row!.workOrderId },
      });
      return row!;
    },
  });
}

/**
 * The consumer's work for a completed `relocation` job (W-03): the job's capture carries the
 * readings. A job that is not about an open relocation of this organization is ignored; the
 * job id makes a second delivery do nothing.
 */
export async function applyRelocationJob(env: CommandEnv, job: JobCompleted): Promise<void> {
  if (job.assetModule !== "accounts" || !job.assetId) return;
  const [row] = await env.tx.select().from(relocation).where(eq(relocation.id, job.assetId));
  if (!row || !isOpen(row.status) || row.workOrderId === job.workOrderId) return;
  const capture = (job.capture ?? {}) as { finalReading?: string; initialReading?: string };
  await recordRelocationWork(env, null, {
    relocationId: row.id,
    workOrderId: job.workOrderId,
    ...(capture.finalReading ? { finalReading: capture.finalReading } : {}),
    ...(capture.initialReading ? { initialReading: capture.initialReading } : {}),
  });
}

/* ---------- complete and cancel ---------- */

export async function completeRelocation(
  env: CommandEnv,
  viewer: Viewer,
  req: { id?: string | undefined; relocationId: string; reason?: string | undefined; finalReading?: string | undefined; initialReading?: string | undefined },
) {
  const { row: before, account: acct } = await lockedRelocation(env, viewer, req.relocationId);
  const fingerprint = fingerprintOfRequest({ kind: "relocate", relocationId: req.relocationId, reason: req.reason, finalReading: req.finalReading, initialReading: req.initialReading });
  return commandLog.once(
    env,
    req.id,
    { parentId: acct.id, kind: "relocate", fingerprint },
    {
      replay: async (earlier) => {
        const done = before.newServicePointId ? await env.tx.select().from(servicePoint).where(eq(servicePoint.id, before.newServicePointId)) : [];
        return { relocation: toRelocationDto(before), servicePoint: done[0] ? toServicePointDto(done[0]) : null, command: toCommandDto(earlier) };
      },
      run: () => applyCompletion(env, viewer, before, acct, req, fingerprint),
    },
  );
}

async function applyCompletion(
  env: CommandEnv,
  viewer: Viewer,
  before: RelocationRow,
  acct: AccountRow,
  req: { id?: string | undefined; reason?: string | undefined; finalReading?: string | undefined; initialReading?: string | undefined },
  fingerprint: string,
) {
  const { tx, organizationId } = env;
  const userId = env.actor.userId!;
  if (!isOpen(before.status)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `This relocation is ${before.status}` });
  if (acct.commercialStatus === "TERMINATED") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This account is terminated" });
  const config = (await readSetting(tx, applicationSetting)).value;
  if (config.relocation.surveyRequired && (before.status !== "surveyed" || before.surveyFeasibility !== "feasible")) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Record a feasible survey before completing the relocation" });
  }
  const [oldPoint] = await tx.select().from(servicePoint).where(eq(servicePoint.id, before.fromServicePointId)).for("update");
  if (!oldPoint || oldPoint.connectionStatus === "DECOMMISSIONED") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The old service point is already decommissioned" });

  const finalReading = req.finalReading?.trim() || before.finalReading;
  const initialReading = req.initialReading?.trim() || before.initialReading;
  const reason = req.reason?.trim() || before.reason;

  // The new service point, with the zone, DMA and route of the new place; it takes over the old one's connection state.
  const userEnv = { tx, organizationId, userId, audit: env.audit, publish: env.publish };
  const fresh = await createServicePoint(userEnv, viewer, {
    accountId: acct.id,
    address: before.toAddress,
    location: before.toLocation as LatLng | null,
    ...placeOf(before),
    connectionStatus: oldPoint.connectionStatus,
  });
  const [closed] = await tx
    .update(servicePoint)
    .set({ connectionStatus: "DECOMMISSIONED", updatedAt: new Date() })
    .where(eq(servicePoint.id, oldPoint.id))
    .returning();
  await env.audit({
    action: "accounts.service_point_update",
    subjectType: "service_point",
    subjectId: oldPoint.id,
    before: { connectionStatus: oldPoint.connectionStatus },
    after: { connectionStatus: closed!.connectionStatus, relocationId: before.id },
    reason,
  });

  await logEvent(env, before.id, {
    kind: "completed",
    from: before.status,
    to: "completed",
    reason,
    payload: { newServicePointId: fresh.id, finalReading, initialReading },
  });
  const [done] = await tx
    .update(relocation)
    .set({ status: "completed", newServicePointId: fresh.id, finalReading, initialReading, completedAt: new Date(), updatedAt: new Date() })
    .where(eq(relocation.id, before.id))
    .returning();

  const payload = {
    relocationId: before.id,
    fromServicePointId: oldPoint.id,
    toServicePointId: fresh.id,
    finalReading,
    initialReading,
    feeItemCodes: before.feeItemCodes as string[],
  };
  const command = await logChange(env, await reload(env, acct.id), { id: req.id, kind: "relocate", reason, payload, fingerprint });
  await env.audit({ action: "accounts.relocate", subjectType: "account", subjectId: acct.id, after: { ...payload, commandId: command.id }, reason });
  await env.publish(servicePointRelocated, {
    relocationId: before.id,
    commandId: command.id,
    accountId: acct.id,
    number: acct.number,
    fromServicePointId: oldPoint.id,
    toServicePointId: fresh.id,
    from: { schemeId: oldPoint.schemeId, zoneId: oldPoint.zoneId, dmaId: oldPoint.dmaId, routeId: oldPoint.routeId, location: oldPoint.location as LatLng | null },
    to: { ...placeOf(before), location: fresh.location },
    feeItemCodes: before.feeItemCodes as string[],
    finalReading,
    initialReading,
    actorUserId: userId,
    occurredAt: command.occurredAt.toISOString(),
  });
  return { relocation: toRelocationDto(done!), servicePoint: fresh, command: toCommandDto(command) };
}

export function cancelRelocation(env: CommandEnv, viewer: Viewer, req: { id?: string | undefined; relocationId: string; reason: string }) {
  const fingerprint = fingerprintOfRequest({ kind: "cancelled", ...req });
  return openRelocationStep(env, viewer, req, {
    kind: "cancelled",
    fingerprint,
    async apply(before) {
      await logEvent(env, before.id, { id: req.id, kind: "cancelled", from: before.status, to: "cancelled", reason: req.reason, fingerprint });
      const [row] = await env.tx.update(relocation).set({ status: "cancelled", updatedAt: new Date() }).where(eq(relocation.id, before.id)).returning();
      await env.audit({ action: "accounts.relocation_cancel", subjectType: "relocation", subjectId: before.id, before: { status: before.status }, after: { status: "cancelled" }, reason: req.reason.trim() });
      return row!;
    },
  });
}
