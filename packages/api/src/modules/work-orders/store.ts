import type { Transaction } from "@flowless/db";
import {
  workOrder,
  workOrderAsset,
  workOrderCapture,
  workOrderChangeSet,
  workOrderCounter,
  workOrderEvent,
} from "@flowless/db/schema/work-orders";
import type { GeoPoint, ModuleKey, WorkLevel, WorkOrderEventOutcome, WorkOrderEventType, WorkOrderStatus } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import { and, asc, count, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { SettingDef } from "../../kernel/config-store";
import type { EventDef } from "../../kernel/events";
import { resolveByDedupeKey } from "../../kernel/exception-store";
import { photoCounts } from "../../kernel/file-subjects";
import type { Notify, NotifyResult } from "../../kernel/notification-store";
import { isUniqueViolation } from "../../kernel/pg-errors";
import type { WorkKindDef, WorkRegistry } from "../../kernel/work";
import type { AuditNote } from "../../trpc";
import { canActOn, canSeeJob, type Abilities, type Visibility } from "./access";
import { workOrderCompleted, workOrderStatusChanged, type WorkOrderCompleted } from "./events";
import { isClosed } from "./rules";
import { planAutoStart } from "./transitions";

/*
 * The job store, ported from Majimap's work-orders/store.ts. Everything runs in the
 * request's tenant transaction (`ctx.tx`, RLS), so no query filters by organization.
 */

export type OrderRow = typeof workOrder.$inferSelect;
type JobAssetRow = typeof workOrderAsset.$inferSelect;

/** The slice of the procedure context the store needs. */
export interface WoCtx {
  tx: Transaction;
  organizationId: string;
  session: { user: { id: string } };
  work: WorkRegistry;
  level: WorkLevel;
  licensed: readonly ModuleKey[];
  abilities: Abilities;
  visibility: Visibility;
  audit(note: AuditNote): Promise<void>;
  publish<T>(event: EventDef<T>, payload: T, options?: { id?: string }): Promise<unknown>;
  notify(input: Notify): Promise<NotifyResult>;
  config<T>(def: SettingDef<T>, at?: Date): Promise<T>;
}

/** How long a finished job stays in a technician's list. */
export const DONE_VISIBLE_DAYS = 14;
export const DEFAULT_DUE_DAYS = 7;
export const MAX_ASSETS_PER_JOB = 200;
export const OPEN_STATUSES = ["pending", "in_progress", "blocked", "submitted"] as const;
export const overdueKey = (workOrderId: string) => `work_order_overdue:${workOrderId}`;

/**
 * How far ahead of the server a device's clock may claim something happened. A time far
 * in the future would outrank everything real that follows it (Majimap's kernel/time.ts).
 */
const MAX_CLOCK_AHEAD_MS = 24 * 60 * 60 * 1000;
export function deviceTime(value: Date | undefined): Date {
  const when = value ?? new Date();
  if (when.getTime() > Date.now() + MAX_CLOCK_AHEAD_MS) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "That time is more than a day in the future: check the device's clock" });
  }
  return when;
}

/* ---------- reading ---------- */

const toGeo = (p: { lat: number; lng: number } | null): GeoPoint | null => (p ? { latitude: p.lat, longitude: p.lng } : null);

export function presentOrder(row: OrderRow, photos: number, assets: ReturnType<typeof presentAsset>[], branch: string | null, capture: unknown) {
  return {
    id: row.id,
    code: row.code,
    title: row.title,
    description: row.description,
    kind: row.kind,
    priority: row.priority,
    status: row.status,
    review: row.review,
    source: row.source,
    parentId: row.parentId,
    assetModule: row.assetModule,
    assetId: row.assetId,
    areaId: row.areaId,
    routeId: row.routeId,
    location: toGeo(row.location),
    locationNote: row.locationNote,
    assignedToUserId: row.assignedToUserId,
    crewId: row.crewId,
    dueAt: row.dueAt,
    /** Derived, never stored: open and past its due time. */
    overdue: !isClosed(row.status) && row.dueAt.getTime() <= Date.now(),
    createdAt: row.createdAt,
    createdByUserId: row.createdByUserId,
    startedAt: row.startedAt,
    photoCount: photos,
    branch,
    assets,
    capture,
    hold: row.status === "blocked" && row.holdReason ? { reason: row.holdReason, note: row.holdNote ?? "", at: row.heldAt ?? row.updatedAt } : null,
    submission:
      row.status === "submitted" && row.submittedAt && row.submittedByUserId && row.outcome
        ? { at: row.submittedAt, byUserId: row.submittedByUserId, outcome: row.outcome, note: row.completionNote ?? "" }
        : null,
    reviewed:
      row.reviewedAt && row.reviewedByUserId
        ? {
            at: row.reviewedAt,
            byUserId: row.reviewedByUserId,
            decision: row.status === "completed" ? ("approved" as const) : ("returned" as const),
            note: row.reviewNote ?? "",
          }
        : null,
    completion:
      row.status === "completed" && row.completedAt
        ? { at: row.completedAt, outcome: row.outcome, note: row.completionNote ?? "", photoCount: photos }
        : null,
  };
}
export type WorkOrderDto = ReturnType<typeof presentOrder>;

function presentAsset(a: JobAssetRow, ref: { name: string; type: string; state: "registered" | "proposed"; possibleDuplicateOf: string | null } | undefined) {
  return {
    module: a.module,
    assetId: a.assetId,
    role: a.role,
    status: a.status,
    doneAt: a.doneAt,
    name: ref?.name ?? null,
    type: ref?.type ?? null,
    state: ref?.state ?? ("unavailable" as const),
    possibleDuplicateOf: ref?.possibleDuplicateOf ?? null,
  };
}

/** The newest capture of each job: the one in force (derived when read, never flagged). */
async function capturesOf(tx: Transaction, ids: readonly string[]): Promise<Map<string, unknown>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .selectDistinctOn([workOrderCapture.workOrderId], { workOrderId: workOrderCapture.workOrderId, data: workOrderCapture.data })
    .from(workOrderCapture)
    .where(inArray(workOrderCapture.workOrderId, [...ids]))
    .orderBy(workOrderCapture.workOrderId, desc(workOrderCapture.capturedAt), desc(workOrderCapture.syncedAt));
  return new Map(rows.map((r) => [r.workOrderId, r.data]));
}

export async function captureOf(tx: Transaction, id: string): Promise<unknown> {
  return (await capturesOf(tx, [id])).get(id) ?? null;
}

/** Rows to DTOs in a fixed number of queries, however many jobs there are. */
export async function hydrate(ctx: WoCtx, rows: OrderRow[]): Promise<WorkOrderDto[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const jobAssets = await ctx.tx.select().from(workOrderAsset).where(inArray(workOrderAsset.workOrderId, ids)).orderBy(asc(workOrderAsset.addedAt));
  const changeSets = await ctx.tx
    .select({ workOrderId: workOrderChangeSet.workOrderId, branch: workOrderChangeSet.branch })
    .from(workOrderChangeSet)
    .where(inArray(workOrderChangeSet.workOrderId, ids));
  const photos = await photoCounts(ctx.tx, "work_order", ids);
  const captures = await capturesOf(ctx.tx, ids);
  const refs = await ctx.work.resolveAssets(ctx.tx, [...new Set(jobAssets.map((a) => a.assetId))], ctx.licensed);
  const branches = new Map(changeSets.map((c) => [c.workOrderId, c.branch]));

  return rows.map((row) =>
    presentOrder(
      row,
      photos.get(row.id) ?? 0,
      jobAssets
        .filter((a) => a.workOrderId === row.id)
        .sort((a, b) => Number(b.role === "primary") - Number(a.role === "primary"))
        .map((a) => presentAsset(a, refs.get(a.assetId))),
      branches.get(row.id) ?? null,
      captures.get(row.id) ?? null,
    ),
  );
}

const NOT_FOUND = () => new TRPCError({ code: "NOT_FOUND", message: "Work order not found" });

export async function loadOrder(tx: Transaction, id: string, lock = false): Promise<OrderRow> {
  const query = tx.select().from(workOrder).where(eq(workOrder.id, id)).limit(1);
  const [row] = lock ? await query.for("update") : await query;
  if (!row) throw NOT_FOUND();
  return row;
}

/** A job the caller may see; NOT_FOUND otherwise, so ids can't be probed. */
export async function loadVisible(ctx: WoCtx, id: string, lock = false): Promise<OrderRow> {
  const row = await loadOrder(ctx.tx, id, lock);
  if (!canSeeJob(ctx.visibility, row)) throw NOT_FOUND();
  return row;
}

export async function loadOne(ctx: WoCtx, id: string): Promise<WorkOrderDto> {
  const [dto] = await hydrate(ctx, [await loadOrder(ctx.tx, id)]);
  return dto!;
}

/** The SQL form of the visibility rule, for list queries. */
export function visibleCondition(v: Visibility): SQL | undefined {
  if (v.all && v.scope.kind === "all") return undefined;
  const parts: (SQL | undefined)[] = [eq(workOrder.assignedToUserId, v.userId)];
  if (v.crewIds.length) parts.push(inArray(workOrder.crewId, [...v.crewIds]));
  if (v.all && v.scope.kind === "limited") {
    if (v.scope.areaIds.size) parts.push(inArray(workOrder.areaId, [...v.scope.areaIds]));
    if (v.scope.routeIds.size) parts.push(inArray(workOrder.routeId, [...v.scope.routeIds]));
  }
  return or(...parts);
}

/* ---------- acting on a job ---------- */

/** NOT_FOUND rather than FORBIDDEN, so a technician can't probe which job ids exist. */
export function assertCanAct(ctx: WoCtx, order: OrderRow) {
  if (!canActOn(ctx.abilities, ctx.visibility, order)) throw NOT_FOUND();
}

/** What a device-driven mutation hands back. `replayed` is true when this was a retry of an event already handled. */
export interface Settled {
  order: WorkOrderDto;
  outcome: WorkOrderEventOutcome;
  reason: string | undefined;
  replayed: boolean;
}

/**
 * Locks the job, THEN looks for an earlier event with this id. Locking first matters: two
 * retries racing each other queue up on the job row, and the second one finds the first
 * one's event instead of colliding on the event's primary key.
 *
 * A retry is only honoured if it is genuinely the same event: same job, same person, same
 * kind of action. Anything else is someone reusing an id, and gets CONFLICT without being
 * told anything about the other event. A replay returns the ORIGINAL outcome and reason:
 * the device lost the response, so it needs to learn whether its action was applied. An id
 * used in another organization is invisible here (RLS); recording it fails on the primary
 * key, which `recordEvent` turns into the same CONFLICT.
 */
export async function lockAndReplay(
  ctx: WoCtx,
  a: { workOrderId: string; eventId: string; type: WorkOrderEventType },
): Promise<{ order: OrderRow; replay: Settled | null }> {
  const order = await loadOrder(ctx.tx, a.workOrderId, true);
  const [existing] = await ctx.tx.select().from(workOrderEvent).where(eq(workOrderEvent.id, a.eventId)).limit(1);
  if (!existing) return { order, replay: null };
  if (existing.workOrderId !== a.workOrderId || existing.actorUserId !== ctx.session.user.id || existing.type !== a.type) {
    throw new TRPCError({ code: "CONFLICT", message: "That id is already in use" });
  }
  return { order, replay: { order: await loadOne(ctx, order.id), outcome: existing.outcome, reason: existing.reason ?? undefined, replayed: true } };
}

export interface EventRecord {
  id: string;
  workOrderId: string;
  type: WorkOrderEventType;
  outcome: WorkOrderEventOutcome;
  reason?: string | undefined;
  payload: Record<string, unknown>;
  when: Date;
  position?: GeoPoint | undefined;
}

export async function recordEvent(ctx: WoCtx, e: EventRecord) {
  try {
    await ctx.tx.insert(workOrderEvent).values({
      id: e.id,
      organizationId: ctx.organizationId,
      workOrderId: e.workOrderId,
      type: e.type,
      outcome: e.outcome,
      reason: e.reason ?? null,
      payload: e.payload,
      actorUserId: ctx.session.user.id,
      latitude: e.position?.latitude ?? null,
      longitude: e.position?.longitude ?? null,
      occurredAt: e.when,
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new TRPCError({ code: "CONFLICT", message: "That id is already in use" });
    throw error;
  }
}

/**
 * The record of a change (K-06, K-09): an audit entry, and `work_order.status_changed` when
 * the status moved. Called for every applied change, in its transaction.
 */
export async function noteChange(ctx: WoCtx, before: OrderRow, afterStatus: WorkOrderStatus, cause: WorkOrderEventType | "cancel", detail: Record<string, unknown>) {
  await ctx.audit({
    action: `work_orders.${cause}`,
    subjectType: "work_order",
    subjectId: before.id,
    before: { status: before.status },
    after: { status: afterStatus, ...detail },
  });
  if (afterStatus !== before.status) {
    await ctx.publish(workOrderStatusChanged, {
      workOrderId: before.id,
      code: before.code,
      kind: before.kind,
      from: before.status,
      to: afterStatus,
      cause,
      actorUserId: ctx.session.user.id,
    });
  }
}

/** Record the event, note the change, and build the answer for a device-driven mutation. */
export async function settle(ctx: WoCtx, before: OrderRow, e: Omit<EventRecord, "workOrderId">): Promise<Settled> {
  await recordEvent(ctx, { ...e, workOrderId: before.id });
  const order = await loadOne(ctx, before.id);
  // A first touch can start the job even when the action itself changed nothing.
  if (e.outcome === "applied" || order.status !== before.status) await noteChange(ctx, before, order.status, e.type, e.payload);
  return { order, outcome: e.outcome, reason: e.reason, replayed: false };
}

export async function updateOrder(ctx: WoCtx, id: string, patch: Partial<typeof workOrder.$inferInsert>): Promise<OrderRow> {
  const [row] = await ctx.tx
    .update(workOrder)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(workOrder.id, id))
    .returning();
  return row!;
}

export async function nextCode(ctx: WoCtx): Promise<string> {
  // First insert hands out 1 and leaves 2; each later call bumps the counter and reads it back.
  const [row] = await ctx.tx
    .insert(workOrderCounter)
    .values({ organizationId: ctx.organizationId, nextNumber: 2 })
    .onConflictDoUpdate({ target: workOrderCounter.organizationId, set: { nextNumber: sql`${workOrderCounter.nextNumber} + 1` } })
    .returning({ next: workOrderCounter.nextNumber });
  return `WO-${1000 + (row!.next - 1)}`;
}

/** The branch holding this job's GIS edits, if one was opened. */
export async function branchOf(tx: Transaction, workOrderId: string): Promise<string | null> {
  const [row] = await tx
    .select({ branch: workOrderChangeSet.branch })
    .from(workOrderChangeSet)
    .where(eq(workOrderChangeSet.workOrderId, workOrderId))
    .limit(1);
  return row?.branch ?? null;
}

/**
 * Assets still without evidence on a route job (target "assets"): "done" needs this to be
 * zero. Any other kind of job is judged by the person finishing it.
 */
export async function openItemCount(ctx: WoCtx, order: OrderRow): Promise<number> {
  if (ctx.work.getWorkKind(order.kind)?.target !== "assets") return 0;
  const pending = await ctx.tx
    .select({ assetId: workOrderAsset.assetId })
    .from(workOrderAsset)
    .where(and(eq(workOrderAsset.workOrderId, order.id), eq(workOrderAsset.status, "pending")));
  // An asset deleted since the job was raised can never get evidence, so it can't keep the job open.
  const live = await ctx.work.resolveAssets(
    ctx.tx,
    pending.map((p) => p.assetId),
    ctx.licensed,
  );
  return pending.filter((p) => live.has(p.assetId)).length;
}

/**
 * Starts a pending job because its assignee just did something on it. Returns the job as
 * it now is, whether a start happened, and why not when it couldn't (nobody assigned).
 */
export async function autoStart(ctx: WoCtx, order: OrderRow, when: Date): Promise<{ order: OrderRow; started: boolean; reason?: string }> {
  const plan = planAutoStart(order, ctx.session.user.id, when);
  if (plan.kind === "rejected") return { order, started: false, reason: plan.reason };
  if (plan.kind === "unchanged") return { order, started: false };
  return { order: await updateOrder(ctx, order.id, plan.patch), started: true };
}

/** Adds an asset to a job (idempotent). False when it was already there. Enforces the per-job cap. */
export async function attachAsset(ctx: WoCtx, order: OrderRow, asset: { module: ModuleKey; id: string }, done: Date | null): Promise<boolean> {
  const [existing] = await ctx.tx.select({ n: count() }).from(workOrderAsset).where(eq(workOrderAsset.workOrderId, order.id));
  const [already] = await ctx.tx
    .select({ id: workOrderAsset.id })
    .from(workOrderAsset)
    .where(and(eq(workOrderAsset.workOrderId, order.id), eq(workOrderAsset.assetId, asset.id)))
    .limit(1);
  if (already) return false;
  if ((existing?.n ?? 0) >= MAX_ASSETS_PER_JOB) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `A job can have at most ${MAX_ASSETS_PER_JOB} assets` });
  }
  const role = (existing?.n ?? 0) === 0 && !order.assetId ? ("primary" as const) : ("related" as const);
  const added = await ctx.tx
    .insert(workOrderAsset)
    .values({
      organizationId: ctx.organizationId,
      workOrderId: order.id,
      module: asset.module,
      assetId: asset.id,
      role,
      addedByUserId: ctx.session.user.id,
      ...(done ? { status: "done" as const, doneAt: done } : {}),
    })
    .onConflictDoNothing()
    .returning({ id: workOrderAsset.id });
  return added.length > 0;
}

/** How many child jobs a job has, and how many of those are still open. */
export async function childCounts(tx: Transaction, order: OrderRow): Promise<{ total: number; open: number }> {
  const [row] = await tx
    .select({
      total: count(),
      open: sql<number>`count(*) filter (where ${workOrder.status} not in ('completed', 'cancelled'))::int`,
    })
    .from(workOrder)
    .where(eq(workOrder.parentId, order.id));
  return { total: row?.total ?? 0, open: row?.open ?? 0 };
}

/**
 * What finishing a job of this kind needs (W-02, W-03): its evidence (photos on the job,
 * a GPS fix on the finishing event) and valid completion data. Returns why not, or the
 * capture to keep. A capture not sent now falls back to the newest one on the job (a job
 * returned for rework keeps what was captured).
 */
export async function completionProblem(
  ctx: WoCtx,
  order: OrderRow,
  kind: WorkKindDef | undefined,
  input: { position?: GeoPoint | undefined; capture?: unknown },
): Promise<{ problem: string } | { problem: null; capture: { data: unknown; fresh: boolean } | null }> {
  const photosNeeded = kind?.evidence?.photos ?? 0;
  if (photosNeeded > 0) {
    const have = (await photoCounts(ctx.tx, "work_order", [order.id])).get(order.id) ?? 0;
    if (have < photosNeeded) {
      return { problem: `Add ${photosNeeded === 1 ? "a photo" : `${photosNeeded} photos`} before finishing this job (${have} so far)` };
    }
  }
  if (kind?.evidence?.gps && !input.position) return { problem: "This kind of job needs your position: turn on location and try again" };
  if (!kind?.capture) return { problem: null, capture: null };
  const fresh = input.capture !== undefined;
  const raw = fresh ? input.capture : await captureOf(ctx.tx, order.id);
  const parsed = kind.capture.safeParse(raw ?? undefined);
  if (!parsed.success) {
    return { problem: `The completion details are missing or incomplete: ${parsed.error.issues[0]?.message ?? "check them"}` };
  }
  return { problem: null, capture: { data: parsed.data, fresh } };
}

export async function saveCapture(ctx: WoCtx, order: OrderRow, id: string, data: unknown, when: Date) {
  await ctx.tx.insert(workOrderCapture).values({
    id,
    organizationId: ctx.organizationId,
    workOrderId: order.id,
    kind: order.kind,
    data: data ?? null,
    capturedByUserId: ctx.session.user.id,
    capturedAt: when,
  });
}

/**
 * A job finished (W-03): `work_order.completed` with its capture, the kind's own completion
 * event if it has one, and its SLA breach (if any) resolved.
 */
export async function announceCompletion(
  ctx: WoCtx,
  order: OrderRow,
  c: Pick<WorkOrderCompleted, "outcome" | "completedByUserId" | "approvedByUserId" | "finalized">,
) {
  const payload: WorkOrderCompleted = {
    workOrderId: order.id,
    code: order.code,
    kind: order.kind,
    assetModule: order.assetModule,
    assetId: order.assetId,
    areaId: order.areaId,
    routeId: order.routeId,
    capture: await captureOf(ctx.tx, order.id),
    ...c,
  };
  await ctx.publish(workOrderCompleted, payload);
  const own = ctx.work.getWorkKind(order.kind)?.completionEvent;
  if (own) await ctx.publish(own, payload);
  await resolveByDedupeKey(ctx.tx, overdueKey(order.id), "The job was completed");
}

/** A fresh id for server-side events. */
export const newId = () => randomUUID();
