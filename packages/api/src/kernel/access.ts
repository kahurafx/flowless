import { memberPermission } from "@flowless/db";
import { PERMISSIONS, type Permission } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { permittedProcedure, router, tenantProcedure } from "../trpc";

const permission = z.enum(PERMISSIONS as [Permission, ...Permission[]]);
const grantInput = z.object({ userId: z.uuid(), permission });

/** Postgres foreign_key_violation: the user is not a member of this organization. */
const isForeignKeyViolation = (error: unknown) =>
  (error as { cause?: { code?: string } })?.cause?.code === "23503";

/**
 * Roles and permissions (K-03). Role defaults live in `@flowless/shared-types`; this
 * router manages the extra permissions an administrator grants a member on top of them.
 */
export const accessRouter = router({
  /** The caller's role and everything they may do, for gating navigation and actions. */
  me: tenantProcedure.query(({ ctx }) => ({
    role: ctx.role,
    permissions: [...ctx.permissions].sort(),
  })),

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
});
