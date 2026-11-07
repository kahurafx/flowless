import { consumerReceipt, outboxEvent, withTenant, type Database, type Transaction } from "@flowless/db";
import type { ModuleKey } from "@flowless/shared-types";
import { and, asc, eq, gte, sql } from "drizzle-orm";
import type { z } from "zod";
import { loadEntitlements } from "./entitlement-store";
import { raiseException, resolveByDedupeKey } from "./exception-store";

/**
 * Event bus (K-09). Modules define events in their `events.ts` and publish them with
 * `ctx.publish(event, payload)` inside the transaction of the change. Consumers are
 * registered in `kernel/consumers.ts` and run by `apps/worker`, each event delivered to
 * each consumer at most once (receipts), inside the event's tenant.
 */
export interface EventDef<T> {
  readonly type: string;
  readonly version: number;
  readonly schema: z.ZodType<T>;
}

export function defineEvent<T>(type: string, schema: z.ZodType<T>, version = 1): EventDef<T> {
  if (!/^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_]*)+$/.test(type)) throw new Error(`Event type "${type}" must look like "<area>.<event>"`);
  return { type, version, schema };
}

export interface ConsumerContext {
  /** The event's tenant transaction: RLS-scoped, shared with the receipt. */
  tx: Transaction;
  organizationId: string;
  eventId: string;
  /**
   * True when the event is being replayed (rebuilding state after a fix). Consumers with
   * effects outside the database, such as sending SMS, must skip them on replay.
   */
  replay: boolean;
}

export interface Consumer<T = unknown> {
  /** Stable, unique: receipts are keyed by it. "<module>.<what it does>". */
  readonly name: string;
  /** Skipped (no receipt) while this module is unlicensed (NF-31). "kernel" always runs. */
  readonly module: ModuleKey | "kernel";
  readonly event: EventDef<T>;
  handle(ctx: ConsumerContext, payload: T): Promise<void>;
}

export function defineConsumer<T>(consumer: Consumer<T>): Consumer<T> {
  return consumer;
}

type ClaimedEvent = {
  id: string;
  organization_id: string;
  type: string;
  version: number;
  payload: unknown;
  attempts: number;
};

export interface DispatchOptions {
  batch?: number;
  /** How long a claimed event stays invisible to other workers. */
  leaseSeconds?: number;
  /** After this many attempts the event is marked failed (NF-24). */
  maxAttempts?: number;
}

export interface DispatchResult {
  claimed: number;
  done: number;
  retrying: number;
  failed: number;
}

/** Seconds before the next attempt: 5, 10, 20 … capped at an hour. */
export const backoffSeconds = (attempts: number) => Math.min(5 * 2 ** (attempts - 1), 3600);

/** The underlying Postgres message when Drizzle wrapped one ("Failed query: …" says little). */
const message = (error: unknown) => {
  const cause = (error as { cause?: { message?: string } })?.cause?.message;
  return (cause ?? (error instanceof Error ? error.message : String(error))).slice(0, 500);
};

/** Runs one consumer for one event in the event's tenant. Returns false when skipped. */
async function deliver(
  db: Database,
  consumer: Consumer,
  event: { id: string; organizationId: string; version: number; payload: unknown },
  replay: boolean,
): Promise<boolean> {
  return withTenant(db, event.organizationId, async (tx) => {
    if (consumer.module !== "kernel" && !(await loadEntitlements(tx)).includes(consumer.module)) return false;
    if (!replay) {
      const fresh = await tx
        .insert(consumerReceipt)
        .values({ organizationId: event.organizationId, consumer: consumer.name, eventId: event.id })
        .onConflictDoNothing()
        .returning({ eventId: consumerReceipt.eventId });
      if (fresh.length === 0) return false; // processed by an earlier attempt
    }
    if (event.version !== consumer.event.version) {
      throw new Error(`Unsupported version ${event.version} of ${consumer.event.type} (consumer knows ${consumer.event.version})`);
    }
    const payload = consumer.event.schema.parse(event.payload);
    await consumer.handle({ tx, organizationId: event.organizationId, eventId: event.id, replay }, payload);
    return true;
  });
}

/**
 * Claims due events and delivers each to its consumers (K-09). Consumers are isolated: one
 * failing never blocks the others, and on retry only the ones without a receipt run
 * again. An event whose consumers keep failing is marked `failed` after `maxAttempts`.
 */
export async function dispatchOutbox(
  db: Database,
  consumers: readonly Consumer[],
  { batch = 50, leaseSeconds = 60, maxAttempts = 8 }: DispatchOptions = {},
): Promise<DispatchResult> {
  const claimed = await db.execute<ClaimedEvent>(sql`select * from kernel.claim_outbox(${batch}, ${leaseSeconds})`);
  const result: DispatchResult = { claimed: claimed.length, done: 0, retrying: 0, failed: 0 };

  for (const row of claimed) {
    const event = { id: row.id, organizationId: row.organization_id, version: row.version, payload: row.payload };
    const errors: string[] = [];
    for (const consumer of consumers) {
      if (consumer.event.type !== row.type) continue;
      try {
        await deliver(db, consumer, event, false);
      } catch (error) {
        errors.push(`${consumer.name}: ${message(error)}`);
      }
    }

    const outcome =
      errors.length === 0
        ? { status: "done" as const, completedAt: new Date(), lastError: null }
        : row.attempts >= maxAttempts
          ? { status: "failed" as const, lastError: errors.join("; ") }
          : {
              status: "pending" as const,
              lastError: errors.join("; "),
              availableAt: new Date(Date.now() + backoffSeconds(row.attempts) * 1000),
            };
    await withTenant(db, event.organizationId, async (tx) => {
      await tx.update(outboxEvent).set(outcome).where(eq(outboxEvent.id, row.id));
      // Zero silent failures (NF-24): a failed event is in the queue until a retry succeeds.
      if (outcome.status === "failed") {
        await raiseException(tx, event.organizationId, {
          type: "EVENT_FAILURE",
          source: "kernel",
          title: `Event not delivered: ${row.type}`,
          detail: `Gave up after ${row.attempts} attempts. ${outcome.lastError}`,
          subject: { kind: "event", ref: row.id },
          dedupeKey: `event:${row.id}`,
        });
      } else if (outcome.status === "done") {
        await resolveByDedupeKey(tx, `event:${row.id}`, "Delivered on retry");
      }
    });
    result[outcome.status === "done" ? "done" : outcome.status === "failed" ? "failed" : "retrying"] += 1;
  }
  return result;
}

/** Dispatches until nothing is due. For tests, seeds and scripts; the worker polls instead. */
export async function drainOutbox(db: Database, consumers: readonly Consumer[], options?: DispatchOptions) {
  const total: DispatchResult = { claimed: 0, done: 0, retrying: 0, failed: 0 };
  for (;;) {
    const r = await dispatchOutbox(db, consumers, options);
    for (const k of Object.keys(total) as (keyof DispatchResult)[]) total[k] += r[k];
    if (r.claimed === 0 || r.done + r.failed === 0) return total;
  }
}

/**
 * Re-delivers one organization's processed events of the consumer's type, oldest first,
 * with `replay: true` (K-09). Used after fixing a consumer or to build a new read model
 * from history. Receipts are not consulted, so the consumer must be idempotent.
 */
export async function replayEvents(
  db: Database,
  consumer: Consumer,
  { organizationId, since }: { organizationId: string; since?: Date },
): Promise<number> {
  const events = await withTenant(db, organizationId, (tx) =>
    tx
      .select({ id: outboxEvent.id, version: outboxEvent.version, payload: outboxEvent.payload })
      .from(outboxEvent)
      .where(
        and(
          eq(outboxEvent.type, consumer.event.type),
          eq(outboxEvent.status, "done"),
          since ? gte(outboxEvent.occurredAt, since) : undefined,
        ),
      )
      .orderBy(asc(outboxEvent.occurredAt), asc(outboxEvent.id)),
  );
  let replayed = 0;
  for (const e of events) if (await deliver(db, consumer, { ...e, organizationId }, true)) replayed += 1;
  return replayed;
}
