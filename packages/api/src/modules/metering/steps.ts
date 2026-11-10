import type { Transaction } from "@flowless/db";
import { meter, meterEvent, type MeterEventKind } from "@flowless/db/schema/metering";
import type { MeterStatus } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { ActionEnv } from "../../kernel/action-env";
import { isUniqueViolation } from "../../kernel/pg-errors";

/*
 * The one idempotent-step mechanism of Metering: a client-mintable id plus a fingerprint of
 * the request. The same id with the same request (and actor) replays the earlier result,
 * anything else under that id is CONFLICT. Used by meter events and, with the reading's own
 * columns, by readings.
 */

export const ID_REUSED = "That id was already used for a different request";

/** A stable hash of a request, ignoring the client id and undefined fields. */
export function fingerprintOf(request: Record<string, unknown>): string {
  const clean = Object.fromEntries(Object.entries(request).filter(([k, v]) => k !== "id" && v !== undefined).sort(([a], [b]) => a.localeCompare(b)));
  return createHash("sha256").update(JSON.stringify(clean, (_, v) => (typeof v === "bigint" ? v.toString() : v instanceof Date ? v.toISOString() : v))).digest("hex");
}

export type MeterEventRow = typeof meterEvent.$inferSelect;
export type MeterRow = typeof meter.$inferSelect;

/** Locks the meter row for the rest of the transaction; NOT_FOUND when this organization has no such meter. */
export async function lockMeter(tx: Transaction, meterId: string): Promise<MeterRow> {
  const [row] = await tx.select().from(meter).where(eq(meter.id, meterId)).for("update");
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Meter not found" });
  return row;
}

/** The earlier step under `id`, if it is the same request: replay. Throws CONFLICT when the id is taken by another request. */
export async function earlierStep(env: ActionEnv, id: string | undefined, expected: { meterId?: string; kind: MeterEventKind; fingerprint: string }): Promise<MeterEventRow | null> {
  if (!id) return null;
  const [earlier] = await env.tx.select().from(meterEvent).where(eq(meterEvent.id, id));
  if (!earlier) return null;
  const same =
    (expected.meterId === undefined || earlier.meterId === expected.meterId) &&
    earlier.kind === expected.kind &&
    earlier.actorUserId === env.actor.userId &&
    earlier.fingerprint === expected.fingerprint;
  if (!same) throw new TRPCError({ code: "CONFLICT", message: ID_REUSED });
  return earlier;
}

export interface StepInput {
  id?: string | undefined;
  meterId: string;
  kind: MeterEventKind;
  from: MeterStatus | null;
  to: MeterStatus;
  reason: string;
  payload?: Record<string, unknown>;
  fingerprint: string;
}

/** Appends the step to the meter's log. */
export async function appendStep(env: ActionEnv, step: StepInput): Promise<MeterEventRow> {
  try {
    const [row] = await env.tx
      .insert(meterEvent)
      .values({
        ...(step.id ? { id: step.id } : {}),
        organizationId: env.organizationId,
        meterId: step.meterId,
        kind: step.kind,
        fromStatus: step.from,
        toStatus: step.to,
        reason: step.reason.trim(),
        actorUserId: env.actor.userId,
        source: env.source,
        payload: step.payload ?? {},
        fingerprint: step.fingerprint,
      })
      .returning();
    return row!;
  } catch (error) {
    if (isUniqueViolation(error)) throw new TRPCError({ code: "CONFLICT", message: "That id is already in use" });
    throw error;
  }
}

/** Moves the meter to a new status, with the event that describes the move (the trigger insists). */
export async function moveMeter(env: ActionEnv, current: MeterRow, step: StepInput): Promise<{ meter: MeterRow; event: MeterEventRow }> {
  const event = await appendStep(env, { ...step, from: current.status });
  const [updated] = await env.tx
    .update(meter)
    .set({ status: step.to, statusEventId: event.id })
    .where(and(eq(meter.id, current.id)))
    .returning();
  return { meter: updated!, event };
}
