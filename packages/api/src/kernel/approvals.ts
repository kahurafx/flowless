import { approvalDecision, approvalRequest, type Transaction } from "@flowless/db";
import type { Permission, Scope } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { router, tenantProcedure } from "../trpc";
import { approvals as registered } from "./approval-registry";
import { cancel, decide, decideProblem, type ApprovalDef, type PolicySnapshot } from "./approval-store";

type Row = typeof approvalRequest.$inferSelect;

/** Limited members see requests placed in their areas or routes (K-03), and their own. */
function inScope(scope: Scope, userId: string): SQL | undefined {
  if (scope.kind === "all") return undefined;
  const areas = [...scope.areaIds];
  const routes = [...scope.routeIds];
  return or(
    eq(approvalRequest.requestedByUserId, userId),
    areas.length ? inArray(approvalRequest.areaId, areas) : undefined,
    routes.length ? inArray(approvalRequest.routeId, routes) : undefined,
  );
}

/** Requests the member made, decided, or holds a permission to decide at some level. */
function involved(userId: string, permissions: ReadonlySet<Permission>): SQL {
  const held = [...permissions].join(",");
  return or(
    eq(approvalRequest.requestedByUserId, userId),
    sql`exists (select 1 from jsonb_array_elements(${approvalRequest.policy}->'levels') as l
                 where l->>'permission' = any(string_to_array(${held}, ',')))`,
    sql`${approvalRequest.policy}->>'escalateTo' = any(string_to_array(${held}, ','))`,
    sql`exists (select 1 from kernel.approval_decision as d
                 where d.request_id = ${approvalRequest.id} and d.by_user_id = ${userId})`,
  )!;
}

/**
 * Approvals (K-05) as members see them: the requests they are involved in, within their
 * scope. Who may decide is the policy snapshot's current level permission (or its
 * escalation permission once overdue); nobody decides their own request or two levels of
 * one. Every decision is audited (K-06). Modules ask with `ctx.requestApproval`.
 */
export function createApprovalsRouter(defs: readonly ApprovalDef[]) {
  const kindOf = (key: string) => defs.find((d) => d.key === key);

  async function present(tx: Transaction, rows: Row[], actor: { userId: string; permissions: ReadonlySet<Permission> }) {
    const ids = rows.map((r) => r.id);
    const approvals = ids.length
      ? await tx
          .select({ requestId: approvalDecision.requestId, by: approvalDecision.byUserId })
          .from(approvalDecision)
          .where(and(inArray(approvalDecision.requestId, ids), eq(approvalDecision.decision, "approve")))
      : [];
    const now = Date.now();
    return rows.map((r) => {
      const policy = r.policy as PolicySnapshot;
      const def = kindOf(r.kind);
      const problem = decideProblem(
        r,
        actor,
        approvals.filter((a) => a.requestId === r.id).map((a) => a.by),
      );
      return {
        id: r.id,
        kind: r.kind,
        kindLabel: def?.label ?? r.kind,
        module: def?.module ?? null,
        subjectRef: r.subjectRef,
        title: r.title,
        amount: r.amount,
        reasonCode: r.reasonCode,
        reasonLabel: def?.reasonCodes.find((c) => c.code === r.reasonCode)?.label ?? r.reasonCode,
        note: r.note,
        status: r.status,
        levels: policy.levels.map((l) => l.label),
        level: r.level,
        waitingFor: r.status === "pending" ? (policy.levels[r.level]?.label ?? null) : null,
        dueAt: r.dueAt,
        overdue: r.status === "pending" && !!r.dueAt && r.dueAt.getTime() <= now,
        escalated: !!r.escalatedAt,
        areaId: r.areaId,
        routeId: r.routeId,
        requestedByUserId: r.requestedByUserId,
        requestedAt: r.requestedAt,
        decidedAt: r.decidedAt,
        canDecide: problem === null,
        canCancel: r.status === "pending" && (r.requestedByUserId === actor.userId || actor.permissions.has("settings:manage")),
      };
    });
  }

  async function find(ctx: { tx: Transaction; scope: () => Promise<Scope>; session: { user: { id: string } }; permissions: ReadonlySet<Permission> }, id: string) {
    const [row] = await ctx.tx
      .select()
      .from(approvalRequest)
      .where(and(eq(approvalRequest.id, id), involved(ctx.session.user.id, ctx.permissions), inScope(await ctx.scope(), ctx.session.user.id)));
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Approval not found" });
    return row;
  }

  const actorOf = (ctx: { session: { user: { id: string } }; permissions: ReadonlySet<Permission> }) => ({
    userId: ctx.session.user.id,
    permissions: ctx.permissions,
  });

  return router({
    list: tenantProcedure
      .input(
        z
          .object({ view: z.enum(["to_decide", "open", "closed"]).default("to_decide"), limit: z.number().int().min(1).max(500).default(200) })
          .default({ view: "to_decide", limit: 200 }),
      )
      .query(async ({ ctx, input }) => {
        const rows = await ctx.tx
          .select()
          .from(approvalRequest)
          .where(
            and(
              input.view === "closed" ? ne(approvalRequest.status, "pending") : eq(approvalRequest.status, "pending"),
              involved(ctx.session.user.id, ctx.permissions),
              inScope(await ctx.scope(), ctx.session.user.id),
            ),
          )
          // Oldest first while waiting; newest decisions first once closed.
          .orderBy(input.view === "closed" ? desc(approvalRequest.decidedAt) : asc(approvalRequest.requestedAt))
          .limit(input.limit);
        const presented = await present(ctx.tx, rows, actorOf(ctx));
        return input.view === "to_decide" ? presented.filter((r) => r.canDecide) : presented;
      }),

    get: tenantProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
      const row = await find(ctx, input.id);
      const [request] = await present(ctx.tx, [row], actorOf(ctx));
      const decisions = await ctx.tx
        .select({
          level: approvalDecision.level,
          decision: approvalDecision.decision,
          byUserId: approvalDecision.byUserId,
          note: approvalDecision.note,
          decidedAt: approvalDecision.decidedAt,
        })
        .from(approvalDecision)
        .where(eq(approvalDecision.requestId, row.id))
        .orderBy(asc(approvalDecision.decidedAt));
      return { ...request!, decisions };
    }),

    approve: tenantProcedure
      .input(z.object({ id: z.uuid(), note: z.string().trim().max(2000).optional() }))
      .mutation(async ({ ctx, input }) => {
        const row = await find(ctx, input.id);
        const result = await decide(ctx.tx, row, actorOf(ctx), "approve", input.note || null);
        await ctx.audit({
          action: "approvals.approve",
          subjectType: "approval",
          subjectId: row.id,
          before: { status: row.status, level: row.level },
          after: result,
          reason: input.note || null,
        });
        return result;
      }),

    reject: tenantProcedure
      .input(z.object({ id: z.uuid(), note: z.string().trim().min(1, "Say why").max(2000) }))
      .mutation(async ({ ctx, input }) => {
        const row = await find(ctx, input.id);
        const result = await decide(ctx.tx, row, actorOf(ctx), "reject", input.note);
        await ctx.audit({
          action: "approvals.reject",
          subjectType: "approval",
          subjectId: row.id,
          before: { status: row.status, level: row.level },
          after: result,
          reason: input.note,
        });
        return result;
      }),

    /** The requester withdraws a pending request; an administrator may too. */
    cancel: tenantProcedure
      .input(z.object({ id: z.uuid(), note: z.string().trim().max(2000).optional() }))
      .mutation(async ({ ctx, input }) => {
        const row = await find(ctx, input.id);
        if (row.requestedByUserId !== ctx.session.user.id && !ctx.permissions.has("settings:manage")) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Only the requester can withdraw this" });
        }
        await cancel(ctx.tx, row, ctx.session.user.id, input.note || null);
        await ctx.audit({ action: "approvals.cancel", subjectType: "approval", subjectId: row.id, reason: input.note || null });
      }),
  });
}

export const approvalsRouter = createApprovalsRouter(registered);
