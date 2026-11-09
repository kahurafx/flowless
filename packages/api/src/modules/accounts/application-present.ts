import type { LatLng, Transaction } from "@flowless/db";
import { application, applicationEvent, customer } from "@flowless/db/schema/accounts";
import { and, asc, eq } from "drizzle-orm";
import { readSetting } from "../../kernel/config-store";
import { applicationVisible, type Placement, type Viewer } from "./access";
import type { ApplicationConfig } from "./application-stages";
import { notFound } from "../../kernel/errors";
import { applicationSetting } from "./settings";

/*
 * Reading an application (C-05): its row, its step log, the DTOs and the small lookups the
 * use cases share. Nothing here changes data; the steps are in `application-steps.ts`,
 * `application-create.ts`, `application-survey.ts` and `application-convert.ts`.
 */

export type ApplicationRow = typeof application.$inferSelect;
/**
 * A row of the application's step log (table `application_event`). Most kinds move the stage
 * (`stage_changed`, `created`); `survey_recorded` and `survey_decided` rows record a step
 * that leaves the stage as it was (from = to).
 */
export type ApplicationStepRow = typeof applicationEvent.$inferSelect;

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

export function toStepDto(e: ApplicationStepRow) {
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

/** The application's step log, oldest first. */
export async function stepsOf(tx: Transaction, applicationId: string): Promise<ApplicationStepRow[]> {
  return tx.select().from(applicationEvent).where(eq(applicationEvent.applicationId, applicationId)).orderBy(asc(applicationEvent.occurredAt), asc(applicationEvent.id));
}

export async function customerName(tx: Transaction, id: string): Promise<string | null> {
  const [row] = await tx.select({ name: customer.name }).from(customer).where(eq(customer.id, id));
  return row?.name ?? null;
}

/** The application with its customer's name, for the caller. */
export async function presentApplication(tx: Transaction, row: ApplicationRow): Promise<ApplicationDto> {
  return toApplicationDto(row, await customerName(tx, row.customerId));
}

export const placeOf = (a: Pick<ApplicationRow, "schemeId" | "zoneId" | "dmaId" | "routeId">): Placement => ({
  schemeId: a.schemeId,
  zoneId: a.zoneId,
  dmaId: a.dmaId,
  routeId: a.routeId,
});

export const configOf = async (tx: Transaction): Promise<ApplicationConfig> => (await readSetting(tx, applicationSetting)).value;

export interface ApplicationResult {
  application: ApplicationDto;
  /** True when this id had already been used by the same request: nothing was done again. */
  replayed: boolean;
}
