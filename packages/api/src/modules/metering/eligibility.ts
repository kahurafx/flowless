import type { Transaction } from "@flowless/db";
import { eligibilityRow, eligibilitySnapshot, installation } from "@flowless/db/schema/metering";
import type { EligibilityReason } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { UserActionEnv } from "../../kernel/action-env";
import { routesById } from "../../kernel/areas";
import { isUniqueViolation } from "../../kernel/pg-errors";
import { routeServicePointFacts, type RouteServicePointFact } from "../accounts";
import { eligibilitySnapshotTaken } from "./events-policy";
import { attemptsFor, type AttemptView } from "./outcomes";

/*
 * The eligibility snapshot (M-08): for one route and cycle date, which service points are on
 * the round and why the others are not, fixed at the time it is taken. Reading tasks and
 * billing both derive from it, so they cannot disagree. Facts come from Accounts' published
 * `routeServicePointFacts` (status, C-04 rules) and Metering's own installations. Rows are
 * insert-only; a snapshot is never changed, and asking again for the same route and date
 * returns the one already taken. The walking sequence (S) is null until Accounts holds one.
 */

export const takeSnapshotInputSchema = z.object({ routeId: z.uuid(), cycleDate: z.iso.date() });

/** The decision for one service point; pure. */
export function eligibilityOf(fact: Pick<RouteServicePointFact, "connectionStatus" | "billsConsumption">, hasMeter: boolean): { eligible: boolean; reason: EligibilityReason } {
  if (fact.connectionStatus === "DECOMMISSIONED" || fact.connectionStatus === "PLANNED") return { eligible: false, reason: "service_point_not_live" };
  if (!fact.billsConsumption) return { eligible: false, reason: "consumption_not_billed" };
  if (!hasMeter) return { eligible: false, reason: "no_meter" };
  return { eligible: true, reason: "eligible" };
}

export interface SnapshotRow {
  accountId: string;
  accountNumber?: string;
  servicePointId: string;
  routeId: string;
  meterId: string | null;
  walkingSequence: number | null;
  eligible: boolean;
  reason: EligibilityReason;
}
export interface SnapshotView {
  id: string;
  routeId: string;
  cycleDate: string;
  takenAt: Date;
  takenByUserId: string | null;
  rows: SnapshotRow[];
}

type SnapshotHead = typeof eligibilitySnapshot.$inferSelect;

async function present(tx: Transaction, head: SnapshotHead): Promise<SnapshotView> {
  const rows = await tx
    .select()
    .from(eligibilityRow)
    .where(eq(eligibilityRow.snapshotId, head.id))
    .orderBy(asc(sql`${eligibilityRow.walkingSequence} nulls last`), asc(eligibilityRow.servicePointId));
  return {
    id: head.id,
    routeId: head.routeId,
    cycleDate: head.cycleDate,
    takenAt: head.takenAt,
    takenByUserId: head.takenByUserId,
    rows: rows.map((r) => ({ accountId: r.accountId, servicePointId: r.servicePointId, routeId: r.routeId, meterId: r.meterId, walkingSequence: r.walkingSequence, eligible: r.eligible, reason: r.reason })),
  };
}

/** Takes (or returns) the snapshot for a route and cycle date (M-08). Idempotent; the first one stands. */
export async function takeSnapshot(env: UserActionEnv, input: z.infer<typeof takeSnapshotInputSchema>): Promise<{ snapshot: SnapshotView; replayed: boolean }> {
  const [existing] = await env.tx.select().from(eligibilitySnapshot).where(and(eq(eligibilitySnapshot.routeId, input.routeId), eq(eligibilitySnapshot.cycleDate, input.cycleDate)));
  if (existing) return { snapshot: await present(env.tx, existing), replayed: true };
  if (!(await routesById(env.tx, [input.routeId])).has(input.routeId)) throw new TRPCError({ code: "NOT_FOUND", message: "Route not found" });

  let head: SnapshotHead;
  try {
    [head] = (await env.tx.insert(eligibilitySnapshot).values({ organizationId: env.organizationId, routeId: input.routeId, cycleDate: input.cycleDate, takenByUserId: env.actor.userId, source: env.source }).returning()) as [SnapshotHead];
  } catch (error) {
    if (isUniqueViolation(error)) {
      const [raced] = await env.tx.select().from(eligibilitySnapshot).where(and(eq(eligibilitySnapshot.routeId, input.routeId), eq(eligibilitySnapshot.cycleDate, input.cycleDate)));
      if (raced) return { snapshot: await present(env.tx, raced), replayed: true };
    }
    throw error;
  }
  const facts = await routeServicePointFacts(env.tx, input.routeId);
  const open = facts.length
    ? await env.tx
        .select({ servicePointId: installation.servicePointId, meterId: installation.meterId })
        .from(installation)
        .where(and(sql`${installation.removedAt} is null`, sql`${installation.servicePointId} in (${sql.join(facts.map((f) => sql`${f.servicePointId}`), sql`, `)})`))
    : [];
  const meterAt = new Map(open.map((o) => [o.servicePointId, o.meterId]));
  const values = facts.map((f) => {
    const meterId = meterAt.get(f.servicePointId) ?? null;
    return { organizationId: env.organizationId, snapshotId: head.id, accountId: f.accountId, servicePointId: f.servicePointId, routeId: input.routeId, meterId, walkingSequence: f.walkingSequence, ...eligibilityOf(f, meterId !== null) };
  });
  if (values.length) await env.tx.insert(eligibilityRow).values(values);
  const eligible = values.filter((v) => v.eligible).length;
  await env.audit({ action: "metering.snapshot_take", subjectType: "eligibility_snapshot", subjectId: head.id, after: { routeId: input.routeId, cycleDate: input.cycleDate, rows: values.length, eligible } });
  await env.publish(eligibilitySnapshotTaken, { snapshotId: head.id, routeId: input.routeId, cycleDate: input.cycleDate, rows: values.length, eligible });
  return { snapshot: await present(env.tx, head), replayed: false };
}

export const snapshotsInputSchema = z.object({ routeId: z.uuid().optional(), limit: z.number().int().min(1).max(100).default(20) });

export async function listSnapshots(tx: Transaction, input: z.infer<typeof snapshotsInputSchema>) {
  const rows = await tx
    .select()
    .from(eligibilitySnapshot)
    .where(input.routeId ? eq(eligibilitySnapshot.routeId, input.routeId) : undefined)
    .orderBy(desc(eligibilitySnapshot.cycleDate), desc(eligibilitySnapshot.takenAt))
    .limit(input.limit);
  return rows.map((h) => ({ id: h.id, routeId: h.routeId, cycleDate: h.cycleDate, takenAt: h.takenAt, takenByUserId: h.takenByUserId }));
}

/** The snapshot for a route and cycle date, or null. Published for Billing's runs (P5-3). */
export async function snapshotFor(tx: Transaction, routeId: string, cycleDate: string): Promise<SnapshotView | null> {
  const [head] = await tx.select().from(eligibilitySnapshot).where(and(eq(eligibilitySnapshot.routeId, routeId), eq(eligibilitySnapshot.cycleDate, cycleDate)));
  return head ? present(tx, head) : null;
}

export async function snapshotById(tx: Transaction, snapshotId: string): Promise<SnapshotView | null> {
  const [head] = await tx.select().from(eligibilitySnapshot).where(eq(eligibilitySnapshot.id, snapshotId));
  return head ? present(tx, head) : null;
}

export type TaskState = "to_read" | "read" | "missed";
export interface ReadingTask extends SnapshotRow {
  state: TaskState;
  /** The latest visit of this cycle, if any (its outcome and disposition). */
  lastAttempt: AttemptView | null;
}

/**
 * The reading tasks of a snapshot (M-08): its eligible rows with where each stands this
 * cycle, from the visits that name the cycle date. Derived on every call, so a task is never
 * out of step with the snapshot or the attempts.
 */
export async function readingTasks(tx: Transaction, snapshot: SnapshotView, visible?: ReadonlySet<string>): Promise<ReadingTask[]> {
  const attempts = await attemptsFor(tx, { cycleDate: snapshot.cycleDate, limit: 100000 });
  const latest = new Map<string, AttemptView>();
  for (const a of attempts) if (!latest.has(a.servicePointId)) latest.set(a.servicePointId, a);
  return snapshot.rows
    .filter((r) => r.eligible && (!visible || visible.has(r.accountId)))
    .map((r) => {
      const lastAttempt = latest.get(r.servicePointId) ?? null;
      return { ...r, lastAttempt, state: !lastAttempt ? "to_read" : lastAttempt.outcome === "read_ok" ? "read" : "missed" };
    });
}
