"use server";

import { clientErrorMessage } from "@flowless/api";
import type { WorkOrderOutcome, WorkPriority } from "@flowless/shared-types";
import { refresh } from "next/cache";
import { getApi } from "@/data/session";

type Api = Awaited<ReturnType<typeof getApi>>["api"];
export type Result<T = null> = { error: string; data?: undefined } | { error: null; data: T };

/** One change as the signed-in member; the procedures check licence, permission, scope and visibility. */
async function run<T>(change: (api: Api) => Promise<T>, options: { refresh?: boolean } = {}): Promise<Result<T>> {
  const { api } = await getApi();
  let data: T;
  try {
    data = await change(api);
  } catch (error) {
    const message = clientErrorMessage(error);
    if (message) return { error: message };
    throw error;
  }
  if (options.refresh !== false) refresh();
  return { error: null, data };
}

export interface Position {
  latitude: number;
  longitude: number;
}

export async function createJob(input: {
  id: string;
  title: string;
  description: string;
  kind: string;
  priority?: WorkPriority;
  dueAt?: string;
  assetId: string | null;
  relatedAssetIds: string[];
  areaId: string | null;
  routeId: string | null;
  location: Position | null;
  locationNote: string | null;
  assigneeId: string | null;
  crewId: string | null;
}) {
  const { dueAt, ...rest } = input;
  return run(async (api) => (await api.workOrders.create({ ...rest, ...(dueAt ? { dueAt: new Date(dueAt) } : {}) })).id);
}

export const assignJob = async (id: string, assigneeId: string | null, crewId: string | null | undefined) =>
  run((api) => api.workOrders.assign({ id, assigneeId, crewId }));

export const scheduleJob = async (id: string, dueAt: string, priority: WorkPriority) =>
  run((api) => api.workOrders.schedule({ id, dueAt: new Date(dueAt), priority }));

export const cancelJob = async (id: string, cascade: boolean) => run((api) => api.workOrders.cancel({ id, cascade }));

/** The device-event actions answer `applied`, `unchanged`, `rejected`...: a refusal is information, not an error. */
export interface Settlement {
  outcome: string;
  reason: string | undefined;
}
const settlement = ({ outcome, reason }: Settlement): Settlement => ({ outcome, reason });

export async function transitionJob(input: {
  eventId: string;
  workOrderId: string;
  position?: Position;
  action:
    | { type: "resume" }
    | { type: "hold"; reason: string; note: string }
    | { type: "complete" | "submit"; outcome: WorkOrderOutcome; note: string; capture?: unknown };
}) {
  return run(async (api) => settlement(await api.workOrders.transition(input)));
}

export async function reviewJob(input: { eventId: string; workOrderId: string; decision: "approve" | "return"; note: string }) {
  return run(async (api) => settlement(await api.workOrders.review(input)));
}

export async function finalizeJob(input: { eventId: string; workOrderId: string; outcome: WorkOrderOutcome; note: string }) {
  return run(async (api) => settlement(await api.workOrders.finalize(input)));
}

export async function commentOnJob(input: { id: string; workOrderId: string; body: string; position?: Position }) {
  return run((api) => api.workOrders.comment(input).then(() => null));
}

/** The job's GIS edit branch (`wo-<code>`), created on first ask. Navigation to the map is the client's. */
export async function openJobBranch(workOrderId: string, position?: Position) {
  return run((api) => api.workOrders.changeSet({ workOrderId, position }));
}

/* ---------- photos and documents (K-08): announce, PUT from the browser, confirm ---------- */

export async function announceFile(input: {
  id: string;
  workOrderId: string;
  fileName: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp" | "image/heic" | "application/pdf";
  sizeBytes: number;
  position?: Position;
  capturedAt?: string;
}) {
  const { workOrderId, position, capturedAt, ...rest } = input;
  return run(
    (api) =>
      api.files.announce({
        ...rest,
        subjectKind: "work_order",
        subjectId: workOrderId,
        ...(position ? position : {}),
        ...(capturedAt ? { capturedAt: new Date(capturedAt) } : {}),
      }),
    { refresh: false },
  );
}

export const confirmFile = async (id: string) => run((api) => api.files.confirm({ id }));
export const removeFile = async (id: string) => run((api) => api.files.remove({ id }));

/* ---------- crews (level full) ---------- */

export const createCrew = async (name: string) => run((api) => api.workOrders.crews.create({ name }));
export const renameCrew = async (id: string, name: string) => run((api) => api.workOrders.crews.rename({ id, name }));
export const archiveCrew = async (id: string) => run((api) => api.workOrders.crews.archive({ id }));
export const addCrewMember = async (crewId: string, userId: string) => run((api) => api.workOrders.crews.addMember({ crewId, userId }));
export const removeCrewMember = async (crewId: string, userId: string) => run((api) => api.workOrders.crews.removeMember({ crewId, userId }));
