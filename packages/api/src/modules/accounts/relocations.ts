import type { LatLng } from "@flowless/db";
import { relocation, servicePoint } from "@flowless/db/schema/accounts";
import type { RelocationStatus, SurveyFeasibility } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { readSetting } from "../../kernel/config-store";
import { loadEntitlements } from "../../kernel/entitlement-store";
import { tidy } from "../../kernel/text";
import { chargeItemByCode } from "../tariffs";
import type { Placement, Viewer } from "./access";
import { logChange, reload } from "./account-changes";
import type { ActionEnv, UserActionEnv } from "../../kernel/action-env";
import { commandLog, fingerprintOfRequest, toCommandDto } from "./command-log";
import { servicePointRelocated, type JobCompleted } from "./events";
import { localToday } from "./holders";
import { claimingId } from "./idempotent";
import { isOpen, placeOf, toRelocationDto, type RelocationDto, type RelocationRow } from "./relocation-present";
import { assertOpen, lockedRelocation, openRelocationStep, relocationCreation, relocationLog } from "./relocation-steps";
import { createServicePoint } from "./service-points";
import { assertPlacementInScope, validatePlacement } from "./placement";
import { findAccount, findServicePoint, toServicePointDto, type AccountRow } from "./service";
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

export function requestRelocation(env: UserActionEnv, viewer: Viewer, input: NewRelocation): Promise<{ relocation: RelocationDto; replayed: boolean }> {
  return relocationCreation.once(env, input.id, undefined, {
    replay: (existing) => ({ relocation: toRelocationDto(existing) }),
    run: () => applyRequest(env, viewer, input),
  });
}

async function applyRequest(env: UserActionEnv, viewer: Viewer, input: NewRelocation) {
  const { tx, organizationId } = env;
  const userId = env.actor.userId;
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
          toAddress: tidy(input.to.address),
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
  await relocationLog.append(env, row!.id, { kind: "requested", fromStatus: null, toStatus: "requested", reason: input.reason, payload: { feeItemCodes: codes } });
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
  env: ActionEnv,
  viewer: Viewer,
  req: { id?: string | undefined; relocationId: string; feasibility: SurveyFeasibility; findings: string },
) {
  const fingerprint = fingerprintOfRequest({ kind: "survey_recorded", ...req });
  return openRelocationStep(env, viewer, req, {
    kind: "survey_recorded",
    fingerprint,
    plan: (before) => {
      const to: RelocationStatus = req.feasibility === "feasible" ? "surveyed" : "requested";
      return {
        to,
        reason: `Survey recorded: ${req.feasibility.replace("_", " ")}`,
        payload: { feasibility: req.feasibility, findings: req.findings },
        set: { surveyFeasibility: req.feasibility, surveyFindings: req.findings.trim() },
        audit: () => ({
          action: "accounts.relocation_survey",
          subjectType: "relocation",
          subjectId: before.id,
          before: { status: before.status },
          after: { status: to, feasibility: req.feasibility },
          reason: req.findings.trim(),
        }),
      };
    },
  });
}

/** What the office typed, trimmed, or what the relocation already holds when nothing (or only blanks) was typed. */
const typedOr = <T>(typed: string | undefined, kept: T) => typed?.trim() || kept;

/** Records the readings and the job on an open relocation without changing its status: from the office, or from a completed `relocation` job. */
export function recordRelocationWork(
  env: ActionEnv,
  viewer: Viewer | null,
  req: { id?: string | undefined; relocationId: string; finalReading?: string | undefined; initialReading?: string | undefined; workOrderId?: string | undefined },
) {
  const fingerprint = fingerprintOfRequest({ kind: "work_recorded", ...req });
  return openRelocationStep(env, viewer, req, {
    kind: "work_recorded",
    fingerprint,
    plan: (before) => ({
      to: before.status,
      reason: req.workOrderId ? "Relocation job completed" : "Readings recorded",
      payload: { finalReading: req.finalReading ?? null, initialReading: req.initialReading ?? null, workOrderId: req.workOrderId ?? null },
      set: {
        finalReading: typedOr(req.finalReading, before.finalReading),
        initialReading: typedOr(req.initialReading, before.initialReading),
        workOrderId: req.workOrderId ?? before.workOrderId,
      },
      audit: (row) => ({
        action: "accounts.relocation_work",
        subjectType: "relocation",
        subjectId: before.id,
        after: { finalReading: row.finalReading, initialReading: row.initialReading, workOrderId: row.workOrderId },
      }),
    }),
  });
}

/**
 * The consumer's work for a completed `relocation` job (W-03): the job's capture carries the
 * readings. A job that is not about an open relocation of this organization is ignored; the
 * job id makes a second delivery do nothing.
 */
export async function applyRelocationJob(env: ActionEnv, job: JobCompleted): Promise<void> {
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
  env: UserActionEnv,
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
  env: UserActionEnv,
  viewer: Viewer,
  before: RelocationRow,
  acct: AccountRow,
  req: { id?: string | undefined; reason?: string | undefined; finalReading?: string | undefined; initialReading?: string | undefined },
  fingerprint: string,
) {
  const { tx } = env;
  const userId = env.actor.userId;
  assertOpen(before);
  if (acct.commercialStatus === "TERMINATED") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This account is terminated" });
  const config = (await readSetting(tx, applicationSetting)).value;
  if (config.relocation.surveyRequired && (before.status !== "surveyed" || before.surveyFeasibility !== "feasible")) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Record a feasible survey before completing the relocation" });
  }
  const [oldPoint] = await tx.select().from(servicePoint).where(eq(servicePoint.id, before.fromServicePointId)).for("update");
  if (!oldPoint || oldPoint.connectionStatus === "DECOMMISSIONED") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The old service point is already decommissioned" });

  const finalReading = typedOr(req.finalReading, before.finalReading);
  const initialReading = typedOr(req.initialReading, before.initialReading);
  const reason = typedOr(req.reason, before.reason);

  // The new service point, with the zone, DMA and route of the new place; it takes over the old one's connection state.
  const fresh = await createServicePoint(env, viewer, {
    accountId: acct.id,
    address: before.toAddress,
    location: before.toLocation,
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

  await relocationLog.append(env, before.id, {
    kind: "completed",
    fromStatus: before.status,
    toStatus: "completed",
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
    feeItemCodes: before.feeItemCodes,
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
    from: { schemeId: oldPoint.schemeId, zoneId: oldPoint.zoneId, dmaId: oldPoint.dmaId, routeId: oldPoint.routeId, location: oldPoint.location },
    to: { ...placeOf(before), location: fresh.location },
    feeItemCodes: before.feeItemCodes,
    finalReading,
    initialReading,
    actorUserId: userId,
    occurredAt: command.occurredAt.toISOString(),
  });
  return { relocation: toRelocationDto(done!), servicePoint: fresh, command: toCommandDto(command) };
}

export function cancelRelocation(env: ActionEnv, viewer: Viewer, req: { id?: string | undefined; relocationId: string; reason: string }) {
  const fingerprint = fingerprintOfRequest({ kind: "cancelled", ...req });
  return openRelocationStep(env, viewer, req, {
    kind: "cancelled",
    fingerprint,
    plan: (before) => ({
      to: "cancelled",
      reason: req.reason,
      set: {},
      audit: () => ({ action: "accounts.relocation_cancel", subjectType: "relocation", subjectId: before.id, before: { status: before.status }, after: { status: "cancelled" }, reason: req.reason.trim() }),
    }),
  });
}
