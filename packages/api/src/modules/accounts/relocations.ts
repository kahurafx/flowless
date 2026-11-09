import type { LatLng, Transaction } from "@flowless/db";
import { account, relocation, relocationEvent, servicePoint } from "@flowless/db/schema/accounts";
import type { RelocationEventKind, RelocationStatus, SurveyFeasibility } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import { and, asc, eq } from "drizzle-orm";
import { readSetting } from "../../kernel/config-store";
import { loadEntitlements } from "../../kernel/entitlement-store";
import { isUniqueViolation } from "../../kernel/pg-errors";
import { chargeItemByCode } from "../tariffs";
import { relocationVisible, type Placement, type Viewer } from "./access";
import { earlierChange, fingerprintOfChange, logChange, reload } from "./account-changes";
import type { CommandEnv } from "./commands";
import { fingerprintOfRequest, toCommandDto } from "./commands";
import { servicePointRelocated, type JobCompleted } from "./events";
import { localToday } from "./holders";
import { createServicePoint } from "./service-points";
import { assertPlacementInScope, findAccount, findServicePoint, notFound, toServicePointDto, validatePlacement } from "./service";
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

async function logEvent(
  env: CommandEnv,
  relocationId: string,
  e: { id?: string | undefined; kind: RelocationEventKind; from: RelocationStatus | null; to: RelocationStatus; reason: string; payload?: Record<string, unknown>; fingerprint?: string | undefined },
) {
  try {
    const [row] = await env.tx
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
      .returning();
    return row!;
  } catch (error) {
    if (isUniqueViolation(error)) throw new TRPCError({ code: "CONFLICT", message: "That id is already in use" });
    throw error;
  }
}

/** The event this id belongs to, or null if unused; CONFLICT when it was a different request. */
async function earlierEvent(env: CommandEnv, id: string | undefined, expected: { relocationId: string; kind: RelocationEventKind; fingerprint: string }) {
  if (!id) return null;
  const [earlier] = await env.tx.select().from(relocationEvent).where(eq(relocationEvent.id, id));
  if (!earlier) return null;
  if (
    earlier.relocationId !== expected.relocationId ||
    earlier.kind !== expected.kind ||
    earlier.actorUserId !== env.actor.userId ||
    earlier.fingerprint !== expected.fingerprint
  ) {
    throw new TRPCError({ code: "CONFLICT", message: "That id was already used for a different request" });
  }
  return earlier;
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

export async function requestRelocation(env: CommandEnv, viewer: Viewer, input: NewRelocation): Promise<{ relocation: RelocationDto; replayed: boolean }> {
  const { tx, organizationId } = env;
  const userId = env.actor.userId!;
  if (input.id) {
    const [existing] = await tx.select().from(relocation).where(eq(relocation.id, input.id));
    if (existing) {
      if (existing.requestedByUserId !== userId) throw new TRPCError({ code: "CONFLICT", message: "That id is already in use" });
      return { relocation: toRelocationDto(existing), replayed: true };
    }
  }
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
  const [row] = await tx
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
    .returning()
    .catch((error: unknown) => {
      if (isUniqueViolation(error)) throw new TRPCError({ code: "CONFLICT", message: "This service point already has a relocation under way, or that id is in use" });
      throw error;
    });
  await logEvent(env, row!.id, { kind: "requested", from: null, to: "requested", reason: input.reason, payload: { feeItemCodes: codes } });
  await env.audit({
    action: "accounts.relocation_request",
    subjectType: "relocation",
    subjectId: row!.id,
    after: { accountId: acct.id, number: acct.number, fromServicePointId: from.id, toAddress: row!.toAddress, feeItemCodes: codes, ...place },
    reason: input.reason.trim(),
  });
  return { relocation: toRelocationDto(row!), replayed: false };
}

/* ---------- survey and work ---------- */

export async function recordRelocationSurvey(
  env: CommandEnv,
  viewer: Viewer,
  req: { id?: string | undefined; relocationId: string; feasibility: SurveyFeasibility; findings: string },
) {
  const { tx } = env;
  const before = await findRelocation(tx, viewer, req.relocationId);
  await findAccount(tx, viewer, { id: before.accountId }, true);
  const row0 = await findRelocation(tx, viewer, req.relocationId, true);
  const fingerprint = fingerprintOfRequest({ kind: "survey_recorded", ...req });
  const earlier = await earlierEvent(env, req.id, { relocationId: row0.id, kind: "survey_recorded", fingerprint });
  if (earlier) return { relocation: toRelocationDto(row0), replayed: true };
  if (!isOpen(row0.status)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `This relocation is ${row0.status}` });
  const to: RelocationStatus = req.feasibility === "feasible" ? "surveyed" : "requested";
  await logEvent(env, row0.id, {
    id: req.id,
    kind: "survey_recorded",
    from: row0.status,
    to,
    reason: `Survey recorded: ${req.feasibility.replace("_", " ")}`,
    payload: { feasibility: req.feasibility, findings: req.findings },
    fingerprint,
  });
  const [row] = await tx
    .update(relocation)
    .set({ surveyFeasibility: req.feasibility, surveyFindings: req.findings.trim(), status: to, updatedAt: new Date() })
    .where(eq(relocation.id, row0.id))
    .returning();
  await env.audit({
    action: "accounts.relocation_survey",
    subjectType: "relocation",
    subjectId: row0.id,
    before: { status: row0.status },
    after: { status: to, feasibility: req.feasibility },
    reason: req.findings.trim(),
  });
  return { relocation: toRelocationDto(row!), replayed: false };
}

/** Records the readings and the job on an open relocation without changing its status: from the office, or from a completed `relocation` job. */
export async function recordRelocationWork(
  env: CommandEnv,
  viewer: Viewer | null,
  req: { id?: string | undefined; relocationId: string; finalReading?: string | undefined; initialReading?: string | undefined; workOrderId?: string | undefined },
) {
  const { tx } = env;
  const first = await findRelocation(tx, viewer, req.relocationId);
  await findAccountLocked(env, viewer, first.accountId);
  const row0 = await findRelocation(tx, viewer, req.relocationId, true);
  const fingerprint = fingerprintOfRequest({ kind: "work_recorded", ...req });
  const earlier = await earlierEvent(env, req.id, { relocationId: row0.id, kind: "work_recorded", fingerprint });
  if (earlier) return { relocation: toRelocationDto(row0), replayed: true };
  if (!isOpen(row0.status)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `This relocation is ${row0.status}` });
  const [row] = await tx
    .update(relocation)
    .set({
      finalReading: req.finalReading?.trim() || row0.finalReading,
      initialReading: req.initialReading?.trim() || row0.initialReading,
      workOrderId: req.workOrderId ?? row0.workOrderId,
      updatedAt: new Date(),
    })
    .where(eq(relocation.id, row0.id))
    .returning();
  await logEvent(env, row0.id, {
    id: req.id,
    kind: "work_recorded",
    from: row0.status,
    to: row0.status,
    reason: req.workOrderId ? "Relocation job completed" : "Readings recorded",
    payload: { finalReading: req.finalReading ?? null, initialReading: req.initialReading ?? null, workOrderId: req.workOrderId ?? null },
    fingerprint,
  });
  await env.audit({
    action: "accounts.relocation_work",
    subjectType: "relocation",
    subjectId: row0.id,
    after: { finalReading: row!.finalReading, initialReading: row!.initialReading, workOrderId: row!.workOrderId },
  });
  return { relocation: toRelocationDto(row!), replayed: false };
}

async function findAccountLocked(env: CommandEnv, viewer: Viewer | null, accountId: string) {
  if (viewer) return findAccount(env.tx, viewer, { id: accountId }, true);
  const [row] = await env.tx.select().from(account).where(eq(account.id, accountId)).for("update");
  return row!;
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
  const { tx, organizationId } = env;
  const userId = env.actor.userId!;
  const first = await findRelocation(tx, viewer, req.relocationId);
  const acct = await findAccount(tx, viewer, { id: first.accountId }, true);
  const before = await findRelocation(tx, viewer, req.relocationId, true);
  const fingerprint = fingerprintOfChange({ kind: "relocate", relocationId: req.relocationId, reason: req.reason, finalReading: req.finalReading, initialReading: req.initialReading });
  const earlier = await earlierChange(env, req.id, { accountId: acct.id, kind: "relocate", fingerprint });
  if (earlier) {
    const done = before.newServicePointId ? await tx.select().from(servicePoint).where(eq(servicePoint.id, before.newServicePointId)) : [];
    return { relocation: toRelocationDto(before), servicePoint: done[0] ? toServicePointDto(done[0]) : null, command: toCommandDto(earlier), replayed: true };
  }
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
  return { relocation: toRelocationDto(done!), servicePoint: fresh, command: toCommandDto(command), replayed: false };
}

export async function cancelRelocation(env: CommandEnv, viewer: Viewer, req: { id?: string | undefined; relocationId: string; reason: string }) {
  const { tx } = env;
  const first = await findRelocation(tx, viewer, req.relocationId);
  await findAccount(tx, viewer, { id: first.accountId }, true);
  const before = await findRelocation(tx, viewer, req.relocationId, true);
  const fingerprint = fingerprintOfRequest({ kind: "cancelled", ...req });
  const earlier = await earlierEvent(env, req.id, { relocationId: before.id, kind: "cancelled", fingerprint });
  if (earlier) return { relocation: toRelocationDto(before), replayed: true };
  if (!isOpen(before.status)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `This relocation is ${before.status}` });
  await logEvent(env, before.id, { id: req.id, kind: "cancelled", from: before.status, to: "cancelled", reason: req.reason, fingerprint });
  const [row] = await tx.update(relocation).set({ status: "cancelled", updatedAt: new Date() }).where(eq(relocation.id, before.id)).returning();
  await env.audit({ action: "accounts.relocation_cancel", subjectType: "relocation", subjectId: before.id, before: { status: before.status }, after: { status: "cancelled" }, reason: req.reason.trim() });
  return { relocation: toRelocationDto(row!), replayed: false };
}
