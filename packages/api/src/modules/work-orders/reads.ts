import { workOrder, workOrderAsset, workOrderComment, workOrderEvent } from "@flowless/db/schema/work-orders";
import { WORK_ORDER_STATUSES } from "@flowless/shared-types";
import { and, asc, eq, gte, inArray, isNull, ne, or } from "drizzle-orm";
import { z } from "zod";
import { effectivePolicy, kindPolicySetting } from "./policy";
import type { workOrderProcedures } from "./procedures";
import { DONE_VISIBLE_DAYS, hydrate, loadOne, loadVisible, visibleCondition } from "./store";

export function readProcedures(p: ReturnType<typeof workOrderProcedures>) {
  return {
    /** The kinds of job this organization can raise, with its review and SLA policy, so a client can build its "new job" form. */
    kinds: p.base.query(async ({ ctx }) => {
      const policies = await ctx.config(kindPolicySetting);
      return ctx.work.availableKinds(ctx.licensed, ctx.level).map((k) => {
        const policy = effectivePolicy(k, policies);
        return {
          key: k.key,
          module: k.module,
          label: k.label,
          target: k.target,
          review: policy.review,
          slaHours: ctx.level === "full" ? policy.slaHours : null,
          tier: k.tier,
          gis: k.gis,
          evidence: { photos: k.evidence?.photos ?? 0, gps: k.evidence?.gps ?? false },
          hasCapture: k.capture !== undefined,
          /** The capture form as JSON Schema (input side), so a client can draw it; null when the kind has none. */
          captureSchema: k.capture ? (z.toJSONSchema(k.capture, { io: "input", unrepresentable: "any" }) as Record<string, unknown>) : null,
          /** The capture form as JSON Schema (input side), so a client can draw it; null when the kind has none. */
          captureSchema: k.capture ? (z.toJSONSchema(k.capture, { io: "input", unrepresentable: "any" }) as Record<string, unknown>) : null,
          defaultPriority: k.defaultPriority ?? "normal",
          canRaise: ctx.abilities.assign || (ctx.abilities.execute && k.selfRaise === true),
        };
      });
    }),

    /** My jobs: assigned to me or my crews, plus what was finished recently. Unassigned jobs are a managers' pool (see `list`). */
    mine: p.base.query(async ({ ctx }) => {
      const since = new Date(Date.now() - DONE_VISIBLE_DAYS * 86_400_000);
      const crewIds = ctx.visibility.crewIds;
      const rows = await ctx.tx
        .select()
        .from(workOrder)
        .where(
          and(
            ne(workOrder.status, "cancelled"),
            or(eq(workOrder.assignedToUserId, ctx.session.user.id), crewIds.length ? inArray(workOrder.crewId, [...crewIds]) : undefined),
            or(ne(workOrder.status, "completed"), gte(workOrder.completedAt, since)),
          ),
        )
        .orderBy(asc(workOrder.dueAt))
        .limit(200);
      return hydrate(ctx, rows);
    }),

    /** Members with `work_orders:read` see every job in their scope; others only theirs, whatever filters they pass. */
    list: p.base
      .input(
        z
          .object({
            statuses: z.array(z.enum(WORK_ORDER_STATUSES)).min(1).optional(),
            assigneeId: z.uuid().optional(),
            crewId: z.uuid().optional(),
            /** The pool nobody has picked up. */
            unassigned: z.boolean().optional(),
            /** Every job that has this asset as its primary or a related one. */
            assetId: z.uuid().optional(),
            /** The children of one job. */
            parentId: z.uuid().optional(),
            limit: z.number().int().min(1).max(200).default(100),
          })
          .optional(),
      )
      .query(async ({ ctx, input }) => {
        const rows = await ctx.tx
          .select()
          .from(workOrder)
          .where(
            and(
              visibleCondition(ctx.visibility),
              input?.statuses ? inArray(workOrder.status, input.statuses) : undefined,
              input?.assigneeId ? eq(workOrder.assignedToUserId, input.assigneeId) : undefined,
              input?.crewId ? eq(workOrder.crewId, input.crewId) : undefined,
              input?.unassigned ? isNull(workOrder.assignedToUserId) : undefined,
              input?.parentId ? eq(workOrder.parentId, input.parentId) : undefined,
              input?.assetId
                ? inArray(workOrder.id, ctx.tx.select({ id: workOrderAsset.workOrderId }).from(workOrderAsset).where(eq(workOrderAsset.assetId, input.assetId)))
                : undefined,
            ),
          )
          .orderBy(asc(workOrder.dueAt))
          .limit(input?.limit ?? 100);
        return hydrate(ctx, rows);
      }),

    byId: p.base.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
      const order = await loadVisible(ctx, input.id);
      return loadOne(ctx, order.id);
    }),

    /** A job's history, oldest first: every action, including refused and stale ones, with where it happened. */
    history: p.base.input(z.object({ workOrderId: z.uuid() })).query(async ({ ctx, input }) => {
      const order = await loadVisible(ctx, input.workOrderId);
      const rows = await ctx.tx.select().from(workOrderEvent).where(eq(workOrderEvent.workOrderId, order.id)).orderBy(asc(workOrderEvent.occurredAt), asc(workOrderEvent.syncedAt));
      return rows.map((e) => ({
        id: e.id,
        type: e.type,
        outcome: e.outcome,
        reason: e.reason,
        payload: e.payload,
        actorUserId: e.actorUserId,
        position: e.latitude !== null && e.longitude !== null ? { latitude: e.latitude, longitude: e.longitude } : null,
        occurredAt: e.occurredAt,
        syncedAt: e.syncedAt,
      }));
    }),

    comments: p.base.input(z.object({ workOrderId: z.uuid() })).query(async ({ ctx, input }) => {
      const order = await loadVisible(ctx, input.workOrderId);
      return ctx.tx.select().from(workOrderComment).where(eq(workOrderComment.workOrderId, order.id)).orderBy(asc(workOrderComment.createdAt));
    }),
  };
}
