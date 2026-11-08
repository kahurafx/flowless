import { workOrderAsset, workOrderChangeSet, workOrderComment, workOrderLogLink } from "@flowless/db/schema/work-orders";
import type { WorkOrderEventOutcome } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { isUniqueViolation } from "../../kernel/pg-errors";
import { Position } from "./lifecycle";
import type { workOrderProcedures } from "./procedures";
import { canAddAsset, frozenReason, isClosed } from "./rules";
import {
  assertCanAct,
  attachAsset,
  autoStart,
  branchOf,
  deviceTime,
  loadVisible,
  lockAndReplay,
  newId,
  noteChange,
  recordEvent,
  settle,
  type Settled,
} from "./store";

const deviceEvent = { eventId: z.uuid(), workOrderId: z.uuid(), occurredAt: z.date().optional(), position: Position.optional() };

export function contentProcedures(p: ReturnType<typeof workOrderProcedures>) {
  return {
    /**
     * Add an asset to the job: the valve a technician finds on site, registered or proposed.
     * Allowed before the job has started (the assignee adding one starts it), while it's in
     * progress, or on hold. NOT_FOUND means "not on the server yet: retry". Adding one that's
     * already on the job changes nothing.
     */
    addAsset: p.acting.input(z.object({ ...deviceEvent, assetId: z.uuid() })).mutation(async ({ ctx, input }): Promise<Settled> => {
      const when = deviceTime(input.occurredAt);
      const locked = await lockAndReplay(ctx, { workOrderId: input.workOrderId, eventId: input.eventId, type: "add_asset" });
      if (locked.replay) return locked.replay;
      const before = locked.order;
      assertCanAct(ctx, before);

      let outcome: WorkOrderEventOutcome = "applied";
      let reason: string | undefined;
      let startedJob = false;
      if (!canAddAsset(before.status)) {
        outcome = "rejected";
        reason = frozenReason(before.status);
      } else {
        const ref = (await ctx.work.resolveAssets(ctx.tx, [input.assetId], ctx.licensed)).get(input.assetId);
        if (!ref) throw new TRPCError({ code: "NOT_FOUND", message: "That asset hasn't reached the server yet" });
        if (!(await attachAsset(ctx, before, { module: ref.module, id: ref.id }, null))) outcome = "unchanged";
        startedJob = (await autoStart(ctx, before, when)).started;
      }
      return settle(ctx, before, {
        id: input.eventId,
        type: "add_asset",
        outcome,
        reason,
        payload: { assetId: input.assetId, startedJob },
        when,
        position: input.position,
      });
    }),

    /**
     * The branch for this job's GIS edits, "wo-1042" for WO-1042. Created the first time
     * it's asked for and the same one every time after. Only the assignee or a manager.
     * Asking for it on a pending job is the assignee starting work, so it starts the job.
     * GIS never learns about work orders: to it this is just a branch name.
     */
    changeSet: p.acting
      .input(z.object({ workOrderId: z.uuid(), occurredAt: z.date().optional(), position: Position.optional() }))
      .mutation(async ({ ctx, input }) => {
        const when = deviceTime(input.occurredAt);
        const before = await loadVisible(ctx, input.workOrderId, true);
        assertCanAct(ctx, before);
        const existing = await branchOf(ctx.tx, before.id);
        if (existing) return { workOrderId: before.id, branch: existing };
        if (before.status !== "pending" && before.status !== "in_progress") {
          throw new TRPCError({
            code: "CONFLICT",
            message: before.status === "blocked" ? "This job is on hold: resume it before editing the network for it" : frozenReason(before.status),
          });
        }
        // "WO-1042" -> "wo-1042": already inside the reserved "wo-" namespace the branch guard watches.
        const branch = before.code.toLowerCase();
        await ctx.tx.insert(workOrderChangeSet).values({ organizationId: ctx.organizationId, workOrderId: before.id, branch, createdByUserId: ctx.session.user.id });
        const start = await autoStart(ctx, before, when);
        const payload = { branch, startedJob: start.started };
        await recordEvent(ctx, { id: newId(), workOrderId: before.id, type: "change_set", outcome: "applied", payload, when, position: input.position });
        await noteChange(ctx, before, start.order.status, "change_set", payload);
        return { workOrderId: before.id, branch };
      }),

    /**
     * "This inspection or valve log was part of that job." Called AFTER the log itself has
     * synced (NOT_FOUND means it hasn't arrived yet: retry). The log's asset is added to the
     * job if it isn't on it yet; a pending job is started by its assignee's first linked log;
     * a job in progress marks that asset done; a job on hold or awaiting review keeps the link
     * but changes nothing else. A log belongs to one job at most.
     */
    linkLog: p.acting
      .input(z.object({ ...deviceEvent, logKind: z.enum(["condition", "valve"]), logId: z.uuid() }))
      .mutation(async ({ ctx, input }): Promise<Settled> => {
        const when = deviceTime(input.occurredAt);
        const locked = await lockAndReplay(ctx, { workOrderId: input.workOrderId, eventId: input.eventId, type: "log_link" });
        if (locked.replay) return locked.replay;
        const before = locked.order;
        let order = before;
        assertCanAct(ctx, order);

        const evidence = await ctx.work.findEvidence(ctx.tx, input.logKind, input.logId, ctx.licensed);
        if (!evidence) throw new TRPCError({ code: "NOT_FOUND", message: "That record hasn't reached the server yet" });
        if (evidence.recordedByUserId !== ctx.session.user.id && !ctx.abilities.assign) {
          throw new TRPCError({ code: "FORBIDDEN", message: "You can only link your own logs" });
        }
        const [elsewhere] = await ctx.tx
          .select({ id: workOrderLogLink.id })
          .from(workOrderLogLink)
          .where(and(eq(workOrderLogLink.logKind, input.logKind), eq(workOrderLogLink.logId, input.logId), ne(workOrderLogLink.workOrderId, order.id)))
          .limit(1);
        if (elsewhere) throw new TRPCError({ code: "CONFLICT", message: "That log is already linked to another job" });

        const linked = await ctx.tx
          .insert(workOrderLogLink)
          .values({ organizationId: ctx.organizationId, workOrderId: order.id, logKind: input.logKind, logId: input.logId })
          .onConflictDoNothing()
          .returning({ id: workOrderLogLink.id });

        let outcome: WorkOrderEventOutcome = linked.length === 0 ? "unchanged" : "applied";
        let reason: string | undefined;
        let startedJob = false;
        let addedAsset = false;
        if (isClosed(order.status)) {
          // Kept as history; a finished job doesn't change.
          if (linked.length > 0) {
            outcome = "stale";
            reason = `This job is ${order.status}`;
          }
        } else if (linked.length > 0) {
          if (order.status === "pending") {
            const start = await autoStart(ctx, order, when);
            order = start.order;
            startedJob = start.started;
            if (start.reason) reason = `${start.reason}: the log was linked, but the job wasn't started`;
          }
          if (order.status === "pending" || order.status === "in_progress") {
            const done = order.status === "in_progress" ? when : null;
            const ref = (await ctx.work.resolveAssets(ctx.tx, [evidence.assetId], ctx.licensed)).get(evidence.assetId);
            if (ref) addedAsset = await attachAsset(ctx, order, { module: ref.module, id: ref.id }, done);
            if (!addedAsset && done) {
              await ctx.tx
                .update(workOrderAsset)
                .set({ status: "done", doneAt: done })
                .where(and(eq(workOrderAsset.workOrderId, order.id), eq(workOrderAsset.assetId, evidence.assetId), eq(workOrderAsset.status, "pending")));
            }
          } else if (order.status === "blocked") {
            reason = "The job is on hold: the log was linked, but nothing else changed";
          } else if (order.status === "submitted") {
            reason = "The job is awaiting review: the log was linked, but nothing else changed";
          }
        }
        return settle(ctx, before, {
          id: input.eventId,
          type: "log_link",
          outcome,
          reason,
          payload: { logKind: input.logKind, logId: input.logId, startedJob, addedAsset },
          when,
          position: input.position,
        });
      }),

    /**
     * A comment on a job, by anyone who can see it. Append-only; the id comes from the
     * device, so a retried sync adds it once. A correction is another comment.
     */
    comment: p.base
      .input(z.object({ id: z.uuid(), workOrderId: z.uuid(), body: z.string().trim().min(1).max(4000), occurredAt: z.date().optional(), position: Position.optional() }))
      .mutation(async ({ ctx, input }) => {
        const when = deviceTime(input.occurredAt);
        const order = await loadVisible(ctx, input.workOrderId, true);
        const [existing] = await ctx.tx.select().from(workOrderComment).where(eq(workOrderComment.id, input.id));
        if (existing) {
          if (existing.workOrderId !== order.id || existing.authorUserId !== ctx.session.user.id) {
            throw new TRPCError({ code: "CONFLICT", message: "That id is already in use" });
          }
          return { comment: existing, replayed: true };
        }
        let comment: typeof workOrderComment.$inferSelect;
        try {
          [comment] = (await ctx.tx
            .insert(workOrderComment)
            .values({ id: input.id, organizationId: ctx.organizationId, workOrderId: order.id, authorUserId: ctx.session.user.id, body: input.body, createdAt: when })
            .returning()) as [typeof workOrderComment.$inferSelect];
        } catch (error) {
          if (isUniqueViolation(error)) throw new TRPCError({ code: "CONFLICT", message: "That id is already in use" });
          throw error;
        }
        await recordEvent(ctx, { id: newId(), workOrderId: order.id, type: "comment", outcome: "applied", payload: { commentId: input.id }, when, position: input.position });
        await ctx.audit({ action: "work_orders.comment", subjectType: "work_order", subjectId: order.id, after: { commentId: input.id, body: input.body } });
        return { comment, replayed: false };
      }),
  };
}
