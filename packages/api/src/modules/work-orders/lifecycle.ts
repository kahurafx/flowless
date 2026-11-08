import { crew, workOrder, workOrderAsset } from "@flowless/db/schema/work-orders";
import { WORK_ORDER_OUTCOMES, WORK_PRIORITIES, type WorkOrderEventOutcome } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { resolveByDedupeKey } from "../../kernel/exception-store";
import { isForeignKeyViolation, isUniqueViolation, violatedConstraint } from "../../kernel/pg-errors";
import { workOrderAssigned, workOrderCreated } from "./events";
import { effectivePolicy, kindPolicySetting } from "./policy";
import { need, type workOrderProcedures } from "./procedures";
import { isClosed, planCreate } from "./rules";
import {
  announceCompletion,
  assertCanAct,
  branchOf,
  childCounts,
  completionProblem,
  DEFAULT_DUE_DAYS,
  deviceTime,
  loadOne,
  loadVisible,
  lockAndReplay,
  newId,
  nextCode,
  noteChange,
  OPEN_STATUSES,
  openItemCount,
  overdueKey,
  recordEvent,
  saveCapture,
  settle,
  updateOrder,
  type OrderRow,
  type Settled,
  type WoCtx,
} from "./store";
import { planTransition, type Action } from "./transitions";

export const Position = z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) });
const Note = z.string().trim().max(2000).default("");
const Outcome = z.enum(WORK_ORDER_OUTCOMES);

const ActionInput = z.discriminatedUnion("type", [
  z.object({ type: z.literal("resume") }),
  z.object({ type: z.literal("hold"), reason: z.string().trim().min(1).max(100), note: Note }),
  /** `capture` is the kind's completion data (W-03), checked against its schema. */
  z.object({ type: z.literal("complete"), outcome: Outcome, note: Note, capture: z.unknown().optional() }),
  z.object({ type: z.literal("submit"), outcome: Outcome, note: Note, capture: z.unknown().optional() }),
]);

/** Inputs every device-driven action shares: a client-minted event id, when, and where. */
const deviceEvent = { eventId: z.uuid(), workOrderId: z.uuid(), occurredAt: z.date().optional(), position: Position.optional() };

/** A reference the database refused: which one, in words. */
function referenceProblem(error: unknown): never {
  if (isForeignKeyViolation(error)) {
    const constraint = violatedConstraint(error);
    const message =
      constraint === "work_order_assignee_fk"
        ? "That person can't be assigned work in this organization"
        : constraint === "work_order_crew_fk"
          ? "Crew not found"
          : "Area or route not found";
    throw new TRPCError({ code: "BAD_REQUEST", message });
  }
  throw error;
}

async function assertCrew(ctx: WoCtx, crewId: string | null | undefined) {
  if (!crewId) return;
  if (ctx.level !== "full") throw new TRPCError({ code: "BAD_REQUEST", message: "Crews need the Work Orders module" });
  const [row] = await ctx.tx.select({ archivedAt: crew.archivedAt }).from(crew).where(eq(crew.id, crewId));
  if (!row || row.archivedAt) throw new TRPCError({ code: "BAD_REQUEST", message: "Crew not found" });
}

/** Tells a member a job is now theirs (K-07). Not when they gave it to themselves. */
async function notifyAssignee(ctx: WoCtx, order: Pick<OrderRow, "id" | "code" | "title">, userId: string | null, eventId: string) {
  if (!userId || userId === ctx.session.user.id) return;
  await ctx.notify({
    to: { userId },
    topic: "work_orders.assigned",
    title: `${order.code} is assigned to you`,
    body: order.title,
    link: `/work-orders/${order.id}`,
    dedupeKey: `work_order_assigned:${eventId}`,
  });
}

const outcomeOf = (kind: "apply" | "unchanged" | "rejected"): WorkOrderEventOutcome =>
  kind === "apply" ? "applied" : kind === "unchanged" ? "unchanged" : "rejected";

export function lifecycleProcedures(p: ReturnType<typeof workOrderProcedures>) {
  return {
    /**
     * Raise a job. Members with `work_orders:assign` raise any job for anyone; a member who
     * only executes raises one for something they found, assigned to themselves and always
     * reviewed (see `planCreate`). Supplying `id` makes it offline-safe: a retry returns the
     * same job; the human-friendly code is handed out here, at sync.
     */
    create: p.acting
      .input(
        z.object({
          id: z.uuid().optional(),
          title: z.string().trim().min(1).max(200),
          description: z.string().trim().max(4000).default(""),
          kind: z.string().regex(/^[a-z][a-z0-9_]*$/, "Unknown kind of job"),
          priority: z.enum(WORK_PRIORITIES).optional(),
          source: z.string().trim().min(1).max(100).default("Office"),
          dueAt: z.date().optional(),
          /** The primary asset, any module's (resolved through the kernel work ports). */
          assetId: z.uuid().nullable().default(null),
          relatedAssetIds: z.array(z.uuid()).max(100).default([]),
          parentId: z.uuid().nullable().default(null),
          areaId: z.uuid().nullable().default(null),
          routeId: z.uuid().nullable().default(null),
          location: Position.nullable().default(null),
          locationNote: z.string().trim().max(300).nullable().default(null),
          assigneeId: z.uuid().nullable().default(null),
          crewId: z.uuid().nullable().default(null),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const kind = ctx.work.getWorkKind(input.kind);
        if (!kind || !ctx.work.availableKinds(ctx.licensed, ctx.level).some((k) => k.key === kind.key)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "That kind of job isn't available for this organization" });
        }
        const policy = effectivePolicy(kind, await ctx.config(kindPolicySetting));
        const priority = input.priority ?? (ctx.abilities.assign ? (kind.defaultPriority ?? "normal") : "normal");
        const plan = planCreate({
          abilities: ctx.abilities,
          userId: ctx.session.user.id,
          level: ctx.level,
          kind: { ...kind, review: policy.review },
          priority,
          assigneeId: input.assigneeId,
        });
        if (!plan.ok) throw new TRPCError({ code: plan.code, message: plan.reason });
        if (kind.target === "location" && !input.location) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "This kind of job needs a position on the map" });
        }
        if (kind.target === "area" && !input.areaId) throw new TRPCError({ code: "BAD_REQUEST", message: "This kind of job needs an area" });

        const id = input.id ?? newId();
        if (input.id) {
          // A retry racing the original waits here, then finds the row instead of colliding on its key.
          await ctx.tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`work_order_create:${id}`}, 0))`);
          const [existing] = await ctx.tx.select().from(workOrder).where(eq(workOrder.id, id)).limit(1);
          if (existing) {
            if (existing.createdByUserId !== ctx.session.user.id) throw new TRPCError({ code: "CONFLICT", message: "That id is already in use" });
            return loadOne(ctx, existing.id);
          }
        }

        const scope = ctx.visibility.scope;
        if (scope.kind === "limited" && ((input.areaId && !scope.areaIds.has(input.areaId)) || (input.routeId && !scope.routeIds.has(input.routeId)))) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Area or route not found" });
        }
        await assertCrew(ctx, input.crewId);

        const wanted = [...new Set([...(input.assetId ? [input.assetId] : []), ...input.relatedAssetIds])];
        const refs = await ctx.work.resolveAssets(ctx.tx, wanted, ctx.licensed);
        for (const assetId of wanted) {
          if (!refs.has(assetId)) throw new TRPCError({ code: "BAD_REQUEST", message: "That asset doesn't exist in this organization" });
        }

        if (input.parentId) {
          const parent = await loadVisible(ctx, input.parentId);
          if (parent.parentId) throw new TRPCError({ code: "BAD_REQUEST", message: "Jobs can only nest one level deep" });
          if (isClosed(parent.status)) throw new TRPCError({ code: "CONFLICT", message: `The parent job is ${parent.status}` });
        }

        const now = new Date();
        const dueAt =
          input.dueAt ??
          new Date(now.getTime() + (ctx.level === "full" && policy.slaHours ? policy.slaHours * 3_600_000 : DEFAULT_DUE_DAYS * 86_400_000));
        const primary = input.assetId ? refs.get(input.assetId)! : null;
        let row: OrderRow;
        try {
          const [inserted] = await ctx.tx
            .insert(workOrder)
            .values({
              id,
              organizationId: ctx.organizationId,
              code: await nextCode(ctx),
              title: input.title,
              description: input.description,
              kind: kind.key,
              priority,
              review: plan.review,
              source: plan.selfRaised ? "Field report" : input.source,
              parentId: input.parentId,
              assetModule: primary?.module ?? null,
              assetId: primary?.id ?? null,
              areaId: input.areaId,
              routeId: input.routeId,
              location: input.location ? { lat: input.location.latitude, lng: input.location.longitude } : null,
              locationNote: input.locationNote,
              assignedToUserId: plan.assigneeId,
              crewId: input.crewId,
              dueAt,
              createdByUserId: ctx.session.user.id,
            })
            .returning();
          row = inserted!;
        } catch (error) {
          if (isUniqueViolation(error)) throw new TRPCError({ code: "CONFLICT", message: "That id is already in use" });
          referenceProblem(error);
        }
        if (wanted.length > 0) {
          await ctx.tx.insert(workOrderAsset).values(
            wanted.map((assetId) => ({
              organizationId: ctx.organizationId,
              workOrderId: id,
              module: refs.get(assetId)!.module,
              assetId,
              role: assetId === input.assetId ? ("primary" as const) : ("related" as const),
              addedByUserId: ctx.session.user.id,
            })),
          );
        }
        const eventId = newId();
        const payload = { kind: kind.key, assigneeId: plan.assigneeId, crewId: input.crewId, selfRaised: plan.selfRaised, parentId: input.parentId };
        await recordEvent(ctx, { id: eventId, workOrderId: id, type: "create", outcome: "applied", payload, when: now });
        await ctx.audit({ action: "work_orders.create", subjectType: "work_order", subjectId: id, after: { code: row.code, title: row.title, ...payload } });
        await ctx.publish(workOrderCreated, {
          workOrderId: id,
          code: row.code,
          kind: kind.key,
          priority,
          assetModule: row.assetModule,
          assetId: row.assetId,
          areaId: row.areaId,
          routeId: row.routeId,
          parentId: row.parentId,
          assigneeId: plan.assigneeId,
          selfRaised: plan.selfRaised,
        });
        await notifyAssignee(ctx, row, plan.assigneeId, eventId);
        return loadOne(ctx, id);
      }),

    /**
     * Give a job to a member (and, with the Work Orders module, a crew). Locked and
     * status-guarded: without the lock, a technician's `complete` landing between the read
     * and the write would be silently overwritten.
     */
    assign: p.base
      .input(z.object({ id: z.uuid(), assigneeId: z.uuid().nullable(), crewId: z.uuid().nullable().optional() }))
      .mutation(async ({ ctx, input }) => {
        need(ctx.abilities.assign, "work_orders:assign");
        const order = await loadVisible(ctx, input.id, true);
        if (isClosed(order.status)) throw new TRPCError({ code: "CONFLICT", message: `A ${order.status} job can't be reassigned` });
        if (order.status === "submitted") {
          throw new TRPCError({ code: "CONFLICT", message: "A job awaiting review can't be reassigned: approve or return it first" });
        }
        const crewId = input.crewId === undefined ? order.crewId : input.crewId;
        if (crewId !== order.crewId) await assertCrew(ctx, crewId);
        if (input.assigneeId === order.assignedToUserId && crewId === order.crewId) return loadOne(ctx, order.id);
        try {
          await ctx.tx
            .update(workOrder)
            .set({ assignedToUserId: input.assigneeId, crewId, updatedAt: new Date() })
            .where(and(eq(workOrder.id, order.id), inArray(workOrder.status, ["pending", "in_progress", "blocked"])));
        } catch (error) {
          referenceProblem(error);
        }
        const eventId = newId();
        const payload = { from: order.assignedToUserId, to: input.assigneeId, crewFrom: order.crewId, crewTo: crewId };
        await recordEvent(ctx, { id: eventId, workOrderId: order.id, type: "assign", outcome: "applied", payload, when: new Date() });
        await noteChange(ctx, order, order.status, "assign", payload);
        await ctx.publish(workOrderAssigned, { workOrderId: order.id, from: order.assignedToUserId, to: input.assigneeId, crewId });
        if (input.assigneeId !== order.assignedToUserId) await notifyAssignee(ctx, order, input.assigneeId, eventId);
        return loadOne(ctx, order.id);
      }),

    /**
     * Reschedule (W-02, Work Orders module): a new due time or priority. A job moved into
     * the future is no longer overdue, so its SLA breach is resolved and may be raised again.
     */
    schedule: p.full
      .input(z.object({ id: z.uuid(), dueAt: z.date().optional(), priority: z.enum(WORK_PRIORITIES).optional() }))
      .mutation(async ({ ctx, input }) => {
        need(ctx.abilities.assign, "work_orders:assign");
        const order = await loadVisible(ctx, input.id, true);
        if (isClosed(order.status)) throw new TRPCError({ code: "CONFLICT", message: `A ${order.status} job can't be rescheduled` });
        const dueAt = input.dueAt ?? order.dueAt;
        const priority = input.priority ?? order.priority;
        if (dueAt.getTime() === order.dueAt.getTime() && priority === order.priority) return loadOne(ctx, order.id);
        const cleared = order.overdueAt !== null && dueAt.getTime() > Date.now();
        await updateOrder(ctx, order.id, { dueAt, priority, ...(cleared ? { overdueAt: null } : {}) });
        if (cleared) await resolveByDedupeKey(ctx.tx, overdueKey(order.id), "The job was rescheduled");
        await ctx.audit({
          action: "work_orders.schedule",
          subjectType: "work_order",
          subjectId: order.id,
          before: { dueAt: order.dueAt, priority: order.priority },
          after: { dueAt, priority },
        });
        return loadOne(ctx, order.id);
      }),

    /**
     * Cancel a job. A job with open children is NOT cancelled quietly: the answer is CONFLICT
     * naming how many. With `cascade: true`, the children that haven't started are cancelled
     * with it (each gets its own event). A child that has started is never cancelled for you.
     * Locked parent-first, so two cancels can't deadlock.
     */
    cancel: p.base.input(z.object({ id: z.uuid(), cascade: z.boolean().default(false) })).mutation(async ({ ctx, input }) => {
      need(ctx.abilities.cancel, "work_orders:cancel");
      const order = await loadVisible(ctx, input.id, true);
      if (order.status === "completed") throw new TRPCError({ code: "CONFLICT", message: "A completed job can't be cancelled" });
      if (order.status !== "cancelled") {
        const children = await ctx.tx
          .select()
          .from(workOrder)
          .where(and(eq(workOrder.parentId, order.id), inArray(workOrder.status, [...OPEN_STATUSES])))
          .for("update");
        const started = children.filter((c) => c.status !== "pending");
        const unstarted = children.filter((c) => c.status === "pending");
        if (started.length > 0) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `${started.length} child ${started.length === 1 ? "job has" : "jobs have"} already started: cancel or finish ${started.length === 1 ? "it" : "them"} first`,
          });
        }
        if (unstarted.length > 0 && !input.cascade) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `${unstarted.length} child ${unstarted.length === 1 ? "job is" : "jobs are"} still open: cancel ${unstarted.length === 1 ? "it" : "them"} too by choosing to cancel the child jobs`,
          });
        }
        const now = new Date();
        const close = async (job: OrderRow, payload: Record<string, unknown>) => {
          await updateOrder(ctx, job.id, { status: "cancelled" });
          await recordEvent(ctx, { id: newId(), workOrderId: job.id, type: "cancel", outcome: "applied", payload, when: now });
          await noteChange(ctx, job, "cancelled", "cancel", payload);
          await resolveByDedupeKey(ctx.tx, overdueKey(job.id), "The job was cancelled");
          const event = { organizationId: ctx.organizationId, workOrderId: job.id, kind: job.kind, actorUserId: ctx.session.user.id, branch: await branchOf(ctx.tx, job.id) };
          await ctx.work.runEffects("onCancel", ctx.tx, event, ctx.licensed);
        };
        for (const child of unstarted) await close(child, { from: "pending", cascadedFrom: order.id });
        await close(order, { from: order.status, cascadedChildren: unstarted.map((c) => c.id) });
      }
      return loadOne(ctx, order.id);
    }),

    /**
     * Resume, hold, complete or submit. There is no "start": a pending job is started by
     * whatever is done on it first, including being put on hold or finished. Finishing checks
     * the kind's evidence and capture (W-02, W-03); a refusal is recorded like any other.
     * Safe to retry: a repeated event id returns the first result without acting again.
     */
    transition: p.acting.input(z.object({ ...deviceEvent, action: ActionInput })).mutation(async ({ ctx, input }): Promise<Settled> => {
      const when = deviceTime(input.occurredAt);
      const { action } = input;
      const { order, replay } = await lockAndReplay(ctx, { workOrderId: input.workOrderId, eventId: input.eventId, type: action.type });
      if (replay) return replay;
      assertCanAct(ctx, order);

      const finishing = action.type === "complete" || action.type === "submit";
      const kids = finishing ? await childCounts(ctx.tx, order) : { total: 0, open: 0 };
      const facts = { openItems: finishing ? await openItemCount(ctx, order) : 0, childCount: kids.total, actorIsManager: ctx.abilities.assign };
      const { capture: captureInput, ...rest } = action as Action & { capture?: unknown };
      const plan = planTransition(order, rest as Action, ctx.session.user.id, when, facts);
      let outcome = outcomeOf(plan.kind);
      let reason = plan.kind === "rejected" ? plan.reason : undefined;

      if (plan.kind === "apply" && finishing) {
        const kind = ctx.work.getWorkKind(order.kind);
        const check = await completionProblem(ctx, order, kind, { position: input.position, capture: captureInput });
        if (check.problem !== null) {
          outcome = "rejected";
          reason = check.problem;
        } else {
          await updateOrder(ctx, order.id, plan.patch);
          if (check.capture?.fresh) await saveCapture(ctx, order, input.eventId, check.capture.data, when);
          const event = { organizationId: ctx.organizationId, workOrderId: order.id, kind: order.kind, actorUserId: ctx.session.user.id, branch: await branchOf(ctx.tx, order.id) };
          if (action.type === "complete") {
            await announceCompletion(ctx, order, { outcome: action.outcome, completedByUserId: ctx.session.user.id, approvedByUserId: null, finalized: false });
          } else {
            await ctx.work.runEffects("onSubmit", ctx.tx, event, ctx.licensed);
          }
        }
      } else if (plan.kind === "apply") {
        await updateOrder(ctx, order.id, plan.patch);
      }
      return settle(ctx, order, { id: input.eventId, type: action.type, outcome, reason, payload: rest, when, position: input.position });
    }),

    /**
     * Approve or return a submitted job: `work_orders:review`, and never the person who
     * submitted it. Approving completes the job; it does NOT post any GIS data.
     */
    review: p.base
      .input(
        z
          .object({ ...deviceEvent, decision: z.enum(["approve", "return"]), note: Note })
          .refine((v) => v.decision === "approve" || v.note.length > 0, { message: "Say what needs fixing", path: ["note"] }),
      )
      .mutation(async ({ ctx, input }): Promise<Settled> => {
        need(ctx.abilities.review, "work_orders:review");
        const when = deviceTime(input.occurredAt);
        const action: Action = { type: input.decision, note: input.note };
        const { order, replay } = await lockAndReplay(ctx, { workOrderId: input.workOrderId, eventId: input.eventId, type: input.decision });
        if (replay) return replay;
        await loadVisible(ctx, order.id);

        const plan = planTransition(order, action, ctx.session.user.id, when);
        if (plan.kind === "apply") {
          await updateOrder(ctx, order.id, plan.patch);
          if (input.decision === "approve") {
            await announceCompletion(ctx, order, {
              outcome: order.outcome,
              completedByUserId: order.submittedByUserId,
              approvedByUserId: ctx.session.user.id,
              finalized: false,
            });
            const event = { organizationId: ctx.organizationId, workOrderId: order.id, kind: order.kind, actorUserId: ctx.session.user.id, branch: await branchOf(ctx.tx, order.id) };
            await ctx.work.runEffects("onApprove", ctx.tx, event, ctx.licensed);
          }
        }
        return settle(ctx, order, {
          id: input.eventId,
          type: input.decision,
          outcome: outcomeOf(plan.kind),
          reason: plan.kind === "rejected" ? plan.reason : undefined,
          payload: action,
          when,
          position: input.position,
        });
      }),

    /**
     * Close a parent job (`work_orders:review`, a supervisor), from any open state. Children
     * still open do NOT block it: how many were open is recorded on the event and published.
     */
    finalize: p.base
      .input(z.object({ ...deviceEvent, outcome: Outcome.default("done"), note: Note }))
      .mutation(async ({ ctx, input }): Promise<Settled> => {
        need(ctx.abilities.review, "work_orders:review");
        const when = deviceTime(input.occurredAt);
        const action: Action = { type: "finalize", outcome: input.outcome, note: input.note };
        const { order, replay } = await lockAndReplay(ctx, { workOrderId: input.workOrderId, eventId: input.eventId, type: "finalize" });
        if (replay) return replay;
        await loadVisible(ctx, order.id);

        const kids = await childCounts(ctx.tx, order);
        const plan = planTransition(order, action, ctx.session.user.id, when, { openItems: 0, childCount: kids.total, actorIsManager: true });
        if (plan.kind === "apply") {
          await updateOrder(ctx, order.id, plan.patch);
          await announceCompletion(ctx, order, { outcome: input.outcome, completedByUserId: ctx.session.user.id, approvedByUserId: null, finalized: true });
        }
        return settle(ctx, order, {
          id: input.eventId,
          type: "finalize",
          outcome: outcomeOf(plan.kind),
          reason: plan.kind === "rejected" ? plan.reason : undefined,
          payload: { ...action, childrenTotal: kids.total, childrenOpen: kids.open },
          when,
          position: input.position,
        });
      }),
  };
}
