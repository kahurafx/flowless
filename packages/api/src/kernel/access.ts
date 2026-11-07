import { memberAreaScope, memberPermission, memberRouteScope } from "@flowless/db";
import { PERMISSIONS, type Permission } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { permittedProcedure, router, tenantProcedure } from "../trpc";
import { isForeignKeyViolation } from "./pg-errors";

const permission = z.enum(PERMISSIONS as [Permission, ...Permission[]]);
const grantInput = z.object({ userId: z.uuid(), permission });


/**
 * Roles and permissions (K-03). Role defaults live in `@flowless/shared-types`; this
 * router manages the extra permissions an administrator grants a member on top of them.
 */
export const accessRouter = router({
  /** The caller's role and everything they may do, for gating navigation and actions. */
  me: tenantProcedure.query(async ({ ctx }) => {
    const scope = await ctx.scope();
    return {
      role: ctx.role,
      permissions: [...ctx.permissions].sort(),
      scope:
        scope.kind === "all"
          ? { kind: "all" as const }
          : { kind: "limited" as const, areaIds: [...scope.areaIds], routeIds: [...scope.routeIds] },
    };
  }),

  /** Extra permissions granted to each member of the organization. */
  grants: permittedProcedure("access:manage").query(({ ctx }) =>
    ctx.tx
      .select({
        userId: memberPermission.userId,
        permission: memberPermission.permission,
        grantedBy: memberPermission.grantedBy,
        grantedAt: memberPermission.grantedAt,
      })
      .from(memberPermission)
      .orderBy(asc(memberPermission.userId), asc(memberPermission.permission)),
  ),

  /**
   * Grants one extra permission. The caller may only grant what they hold themselves, so
   * `access:manage` alone never escalates beyond its holder. Granting twice is a no-op.
   */
  grant: permittedProcedure("access:manage")
    .input(grantInput)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.permissions.has(input.permission)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "You can only grant permissions you hold" });
      }
      try {
        await ctx.tx
          .insert(memberPermission)
          .values({ ...input, organizationId: ctx.organizationId, grantedBy: ctx.session.user.id })
          .onConflictDoNothing();
      } catch (error) {
        if (isForeignKeyViolation(error)) throw new TRPCError({ code: "NOT_FOUND", message: "Member not found" });
        throw error;
      }
    }),

  /** Removes an extra permission. Role defaults are not affected. */
  revoke: permittedProcedure("access:manage")
    .input(grantInput)
    .mutation(async ({ ctx, input }) => {
      await ctx.tx
        .delete(memberPermission)
        .where(and(eq(memberPermission.userId, input.userId), eq(memberPermission.permission, input.permission)));
    }),

  /** Each member's scope restrictions as granted (not expanded). Members not listed are unrestricted. */
  scopes: permittedProcedure("access:manage").query(async ({ ctx }) => {
    const [areas, routes] = await Promise.all([
      ctx.tx.select().from(memberAreaScope),
      ctx.tx.select().from(memberRouteScope),
    ]);
    const byUser = new Map<string, { userId: string; areaIds: string[]; routeIds: string[] }>();
    const entry = (userId: string) => byUser.get(userId) ?? byUser.set(userId, { userId, areaIds: [], routeIds: [] }).get(userId)!;
    for (const a of areas) entry(a.userId).areaIds.push(a.areaId);
    for (const r of routes) entry(r.userId).routeIds.push(r.routeId);
    return [...byUser.values()];
  }),

  /**
   * Replaces a member's scope (K-03). Empty lists make them unrestricted. A caller who is
   * restricted themselves may only hand out areas and routes inside their own scope, and
   * can never make anyone unrestricted.
   */
  setScope: permittedProcedure("access:manage")
    .input(z.object({ userId: z.uuid(), areaIds: z.array(z.uuid()).max(500), routeIds: z.array(z.uuid()).max(500) }))
    .mutation(async ({ ctx, input }) => {
      const areaIds = [...new Set(input.areaIds)];
      const routeIds = [...new Set(input.routeIds)];
      const mine = await ctx.scope();
      if (mine.kind === "limited") {
        const outside = areaIds.some((id) => !mine.areaIds.has(id)) || routeIds.some((id) => !mine.routeIds.has(id));
        if (outside || (areaIds.length === 0 && routeIds.length === 0)) {
          throw new TRPCError({ code: "FORBIDDEN", message: "You can only give scope inside your own" });
        }
      }
      await ctx.tx.delete(memberAreaScope).where(eq(memberAreaScope.userId, input.userId));
      await ctx.tx.delete(memberRouteScope).where(eq(memberRouteScope.userId, input.userId));
      try {
        const base = { organizationId: ctx.organizationId, userId: input.userId };
        if (areaIds.length) await ctx.tx.insert(memberAreaScope).values(areaIds.map((areaId) => ({ ...base, areaId })));
        if (routeIds.length) await ctx.tx.insert(memberRouteScope).values(routeIds.map((routeId) => ({ ...base, routeId })));
      } catch (error) {
        if (isForeignKeyViolation(error)) throw new TRPCError({ code: "NOT_FOUND", message: "Member, area or route not found" });
        throw error;
      }
    }),
});
