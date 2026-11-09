import type { LatLng, Transaction } from "@flowless/db";
import { relocation, relocationEvent } from "@flowless/db/schema/accounts";
import type { RelocationStatus } from "@flowless/shared-types";
import { and, asc, eq } from "drizzle-orm";
import { relocationVisible, type Placement, type Viewer } from "./access";
import { notFound } from "../../kernel/errors";

/*
 * Reading a relocation (C-09): its row, its step log and the DTOs. Nothing here changes data;
 * the steps are in `relocation-steps.ts` and `relocations.ts`.
 */

export type RelocationRow = typeof relocation.$inferSelect;
/**
 * A row of the relocation's step log (table `relocation_event`). `requested`, `completed` and
 * `cancelled` rows move the status; `work_recorded` rows (and a `survey_recorded` that leaves
 * the status where it was) have from = to.
 */
export type RelocationStepRow = typeof relocationEvent.$inferSelect;

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

export function toRelocationStepDto(e: RelocationStepRow) {
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

export const relocationStepsOf = (tx: Transaction, relocationId: string) =>
  tx.select().from(relocationEvent).where(eq(relocationEvent.relocationId, relocationId)).orderBy(asc(relocationEvent.occurredAt), asc(relocationEvent.id));

export const isOpen = (status: RelocationStatus) => status === "requested" || status === "surveyed";

export const placeOf = (r: RelocationRow): Placement => ({ schemeId: r.toSchemeId, zoneId: r.toZoneId, dmaId: r.toDmaId, routeId: r.toRouteId });
