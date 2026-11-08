import { job, withTenant, type Database, type Transaction } from "@flowless/db";
import type { ModuleKey } from "@flowless/shared-types";
import { and, eq, sql } from "drizzle-orm";
import type { z } from "zod";
import { loadEntitlements } from "./entitlement-store";
import { raiseException, resolveByDedupeKey } from "./exception-store";
import { notify } from "./notification-store";

/**
 * The job runner (NF-12, NF-24). Heavy work is enqueued from a procedure with
 * `ctx.enqueue(job, payload)` and run by `apps/worker`. A job's own writes go through
 * `ctx.withTenant`, one transaction per unit of work, so a long run (a billing cycle,
 * an import) commits as it goes and a retry resumes. Jobs must be safe to run again.
 */
export interface JobContext {
  db: Database;
  organizationId: string;
  jobId: string;
  /** 1 on the first run. */
  attempt: number;
  /** Runs `fn` in a transaction scoped to the job's organization (RLS). */
  withTenant<R>(fn: (tx: Transaction) => Promise<R>): Promise<R>;
  /** Extends the lease; call between units of work in jobs that run longer than the lease. */
  heartbeat(): Promise<void>;
}

export interface JobDef<T = unknown> {
  /** "<module>.<job>", unique. */
  readonly type: string;
  /** Not run while this module is unlicensed (finished as skipped, NF-31). */
  readonly module: ModuleKey | "kernel";
  readonly schema: z.ZodType<T>;
  readonly maxAttempts?: number;
  /** Plain-language name for the exception queue, e.g. "November billing run". */
  readonly label: string;
  run(ctx: JobContext, payload: T): Promise<unknown>;
}

export function defineJob<T>(def: JobDef<T>): JobDef<T> {
  return def;
}

export interface EnqueueOptions {
  /** Enqueueing the same key twice is a no-op; the first job's id is returned. */
  idempotencyKey?: string;
  runAt?: Date;
  createdByUserId?: string | null;
}

/** Queues a job in the caller's transaction, so it exists only if that commits. */
export async function enqueueJob<T>(
  tx: Transaction,
  organizationId: string,
  def: JobDef<T>,
  payload: T,
  options: EnqueueOptions = {},
): Promise<string> {
  const [created] = await tx
    .insert(job)
    .values({
      organizationId,
      type: def.type,
      payload: def.schema.parse(payload) as object,
      maxAttempts: def.maxAttempts ?? 5,
      idempotencyKey: options.idempotencyKey ?? null,
      runAt: options.runAt ?? new Date(),
      createdByUserId: options.createdByUserId ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: job.id });
  if (created) return created.id;
  const [existing] = await tx
    .select({ id: job.id })
    .from(job)
    .where(and(eq(job.type, def.type), eq(job.idempotencyKey, options.idempotencyKey!)));
  return existing!.id;
}

type ClaimedJob = {
  id: string;
  organization_id: string;
  type: string;
  payload: unknown;
  attempts: number;
  max_attempts: number;
  created_by_user_id: string | null;
};

export interface JobRunResult {
  claimed: number;
  done: number;
  skipped: number;
  retrying: number;
  failed: number;
}

/** Seconds before the next attempt: 30, 60, 120 … capped at an hour. */
const retryAfter = (attempts: number) => Math.min(30 * 2 ** (attempts - 1), 3600);

const message = (error: unknown) => {
  const cause = (error as { cause?: { message?: string } })?.cause?.message;
  return (cause ?? (error instanceof Error ? error.message : String(error))).slice(0, 1000);
};

/**
 * Claims due jobs and runs them. A job that throws is retried with backoff; after its
 * last attempt it fails and becomes a JOB_FAILURE exception owned by whoever queued it
 * (NF-24). A later successful run resolves that exception.
 */
export async function runJobs(
  db: Database,
  jobs: readonly JobDef[],
  { batch = 5, leaseSeconds = 900 }: { batch?: number; leaseSeconds?: number } = {},
): Promise<JobRunResult> {
  const claimed = await db.execute<ClaimedJob>(sql`select * from kernel.claim_jobs(${batch}, ${leaseSeconds})`);
  const result: JobRunResult = { claimed: claimed.length, done: 0, skipped: 0, retrying: 0, failed: 0 };

  for (const row of claimed) {
    const organizationId = row.organization_id;
    const inTenant = <R>(fn: (tx: Transaction) => Promise<R>) => withTenant(db, organizationId, fn);
    const def = jobs.find((j) => j.type === row.type);
    const finish = (set: Partial<typeof job.$inferInsert>) => inTenant((tx) => tx.update(job).set(set).where(eq(job.id, row.id)));

    try {
      if (!def) throw new Error(`No handler is registered for job type ${row.type}`);
      if (def.module !== "kernel" && !(await inTenant(loadEntitlements)).includes(def.module)) {
        await finish({ status: "done", finishedAt: new Date(), result: { skipped: `${def.module} is not licensed` } });
        result.skipped += 1;
        continue;
      }
      const output = await def.run(
        {
          db,
          organizationId,
          jobId: row.id,
          attempt: row.attempts,
          withTenant: inTenant,
          heartbeat: () =>
            finish({ runAt: new Date(Date.now() + leaseSeconds * 1000) }).then(() => undefined),
        },
        def.schema.parse(row.payload),
      );
      await inTenant(async (tx) => {
        await tx
          .update(job)
          .set({ status: "done", finishedAt: new Date(), lastError: null, result: (output ?? null) as object | null })
          .where(eq(job.id, row.id));
        await resolveByDedupeKey(tx, `job:${row.id}`, "Succeeded on retry");
      });
      result.done += 1;
    } catch (error) {
      const lastError = message(error);
      if (row.attempts >= row.max_attempts || !def) {
        await inTenant(async (tx) => {
          await tx.update(job).set({ status: "failed", finishedAt: new Date(), lastError }).where(eq(job.id, row.id));
          await raiseException(tx, organizationId, {
            type: "JOB_FAILURE",
            source: def?.module ?? "kernel",
            title: `${def?.label ?? row.type} failed`,
            detail: `Gave up after ${row.attempts} attempt${row.attempts === 1 ? "" : "s"}. ${lastError}`,
            subject: { kind: "job", ref: row.id },
            ownerUserId: row.created_by_user_id,
            dedupeKey: `job:${row.id}`,
          });
          if (row.created_by_user_id) {
            await notify(tx, organizationId, {
              to: { userId: row.created_by_user_id },
              topic: "jobs.failed",
              title: `${def?.label ?? row.type} failed`,
              body: "It is in the exception queue with what went wrong.",
              link: "/exceptions",
              dedupeKey: `job:${row.id}:${row.attempts}`,
            });
          }
        });
        result.failed += 1;
      } else {
        await finish({ status: "queued", lastError, runAt: new Date(Date.now() + retryAfter(row.attempts) * 1000) });
        result.retrying += 1;
      }
    }
  }
  return result;
}
