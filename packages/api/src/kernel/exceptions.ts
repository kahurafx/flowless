import { exception, job, outboxEvent, type Transaction } from "@flowless/db";
import { EXCEPTION_TYPES, type Scope } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { permittedProcedure, router } from "../trpc";
import { isForeignKeyViolation, isUniqueViolation } from "./pg-errors";

const columns = {
  id: exception.id,
  type: exception.type,
  source: exception.source,
  title: exception.title,
  detail: exception.detail,
  subjectKind: exception.subjectKind,
  subjectRef: exception.subjectRef,
  areaId: exception.areaId,
  routeId: exception.routeId,
  ownerUserId: exception.ownerUserId,
  status: exception.status,
  occurrences: exception.occurrences,
  raisedAt: exception.raisedAt,
  lastSeenAt: exception.lastSeenAt,
  resolvedAt: exception.resolvedAt,
  resolutionNote: exception.resolutionNote,
};

const RETRYABLE = new Set(["JOB_FAILURE", "EVENT_FAILURE"]);

/** Limited members see exceptions placed in their areas or routes (K-03); unplaced ones are organization-wide. */
function inScope(scope: Scope): SQL | undefined {
  if (scope.kind === "all") return undefined;
  const areas = [...scope.areaIds];
  const routes = [...scope.routeIds];
  return or(
    areas.length ? inArray(exception.areaId, areas) : undefined,
    routes.length ? inArray(exception.routeId, routes) : undefined,
  ) ?? sql`false`;
}

async function findVisible(tx: Transaction, scope: Scope, id: string) {
  const [row] = await tx.select(columns).from(exception).where(and(eq(exception.id, id), inScope(scope)));
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Exception not found" });
  return row;
}

const byId = z.object({ id: z.uuid() });

/**
 * The exception queue (X-02, NF-24). Reading needs `exceptions:read`, acting
 * `exceptions:resolve`. Scope restrictions apply (K-03). Every action is audited (K-06).
 */
export const exceptionsRouter = router({
  list: permittedProcedure("exceptions:read")
    .input(
      z
        .object({
          view: z.enum(["active", "resolved"]).default("active"),
          type: z.enum(EXCEPTION_TYPES).optional(),
          ownerUserId: z.uuid().nullable().optional(),
          limit: z.number().int().min(1).max(500).default(200),
        })
        .default({ view: "active", limit: 200 }),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.tx
        .select(columns)
        .from(exception)
        .where(
          and(
            input.view === "active" ? ne(exception.status, "resolved") : eq(exception.status, "resolved"),
            input.type ? eq(exception.type, input.type) : undefined,
            input.ownerUserId === null ? isNull(exception.ownerUserId) : input.ownerUserId ? eq(exception.ownerUserId, input.ownerUserId) : undefined,
            inScope(await ctx.scope()),
          ),
        )
        // Oldest first: the queue is worked from the top (NF-40).
        .orderBy(input.view === "active" ? asc(exception.raisedAt) : desc(exception.resolvedAt))
        .limit(input.limit);
      return rows.map((r) => ({ ...r, retryable: RETRYABLE.has(r.type) && r.status !== "resolved" }));
    }),

  /** Hands an exception to a member (or back to the team queue with null). */
  assign: permittedProcedure("exceptions:resolve")
    .input(z.object({ id: z.uuid(), ownerUserId: z.uuid().nullable() }))
    .mutation(async ({ ctx, input }) => {
      const before = await findVisible(ctx.tx, await ctx.scope(), input.id);
      try {
        await ctx.tx.update(exception).set({ ownerUserId: input.ownerUserId }).where(eq(exception.id, input.id));
      } catch (error) {
        if (isForeignKeyViolation(error)) throw new TRPCError({ code: "NOT_FOUND", message: "Member not found" });
        throw error;
      }
      await ctx.audit({
        action: "exceptions.assign",
        subjectType: "exception",
        subjectId: input.id,
        before: { owner: before.ownerUserId },
        after: { owner: input.ownerUserId },
      });
    }),

  /** Takes an exception and marks it in progress. */
  start: permittedProcedure("exceptions:resolve")
    .input(byId)
    .mutation(async ({ ctx, input }) => {
      const before = await findVisible(ctx.tx, await ctx.scope(), input.id);
      if (before.status === "resolved") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This exception is resolved" });
      await ctx.tx
        .update(exception)
        .set({ status: "in_progress", ownerUserId: before.ownerUserId ?? ctx.session.user.id })
        .where(eq(exception.id, input.id));
      await ctx.audit({ action: "exceptions.start", subjectType: "exception", subjectId: input.id, before: { status: before.status } });
    }),

  resolve: permittedProcedure("exceptions:resolve")
    .input(z.object({ id: z.uuid(), note: z.string().trim().min(1, "Say what was done").max(2000) }))
    .mutation(async ({ ctx, input }) => {
      const before = await findVisible(ctx.tx, await ctx.scope(), input.id);
      if (before.status === "resolved") return;
      await ctx.tx
        .update(exception)
        .set({ status: "resolved", resolvedAt: new Date(), resolvedByUserId: ctx.session.user.id, resolutionNote: input.note })
        .where(eq(exception.id, input.id));
      await ctx.audit({ action: "exceptions.resolve", subjectType: "exception", subjectId: input.id, reason: input.note });
    }),

  /** Reopens a resolved exception, unless the same problem is already open again. */
  reopen: permittedProcedure("exceptions:resolve")
    .input(byId)
    .mutation(async ({ ctx, input }) => {
      const before = await findVisible(ctx.tx, await ctx.scope(), input.id);
      if (before.status !== "resolved") return;
      try {
        await ctx.tx
          .update(exception)
          .set({ status: "open", resolvedAt: null, resolvedByUserId: null, resolutionNote: null })
          .where(eq(exception.id, input.id));
      } catch (error) {
        if (isUniqueViolation(error)) throw new TRPCError({ code: "CONFLICT", message: "The same problem is already open in the queue" });
        throw error;
      }
      await ctx.audit({ action: "exceptions.reopen", subjectType: "exception", subjectId: input.id });
    }),

  /**
   * Retries the failed event or job behind an exception. It stays in progress and
   * resolves itself when the retry succeeds; failing again counts an occurrence.
   */
  retry: permittedProcedure("exceptions:resolve")
    .input(byId)
    .mutation(async ({ ctx, input }) => {
      const row = await findVisible(ctx.tx, await ctx.scope(), input.id);
      if (!RETRYABLE.has(row.type) || row.status === "resolved") {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only open background failures can be retried" });
      }
      const requeued =
        row.subjectKind === "job"
          ? await ctx.tx
              .update(job)
              .set({ status: "queued", attempts: 0, runAt: new Date(), lastError: null, finishedAt: null })
              .where(and(eq(job.id, row.subjectRef), eq(job.status, "failed")))
              .returning({ id: job.id })
          : await ctx.tx
              .update(outboxEvent)
              .set({ status: "pending", attempts: 0, availableAt: new Date() })
              .where(and(eq(outboxEvent.id, row.subjectRef), eq(outboxEvent.status, "failed")))
              .returning({ id: outboxEvent.id });
      if (!requeued.length) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "It is not in a failed state any more" });
      await ctx.tx
        .update(exception)
        .set({ status: "in_progress", ownerUserId: row.ownerUserId ?? ctx.session.user.id })
        .where(eq(exception.id, input.id));
      await ctx.audit({ action: "exceptions.retry", subjectType: "exception", subjectId: input.id, after: { [row.subjectKind]: row.subjectRef } });
    }),
});
