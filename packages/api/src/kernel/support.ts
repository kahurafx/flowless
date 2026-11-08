import { supportGrant } from "@flowless/db";
import { SUPPORT_MAX_HOURS, SUPPORT_PERMISSIONS } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { permittedProcedure, router, type Session } from "../trpc";

const statusOf = (g: { revokedAt: Date | null; expiresAt: Date }, now: number) =>
  g.revokedAt ? ("revoked" as const) : g.expiresAt.getTime() <= now ? ("expired" as const) : ("active" as const);

/**
 * Support access (K-12) from the organization's side: its administrators (`access:manage`)
 * let a named Flowless engineer read its data for a reason and a few hours, and revoke it.
 * What the engineer looked at is in the audit log as `support.read`.
 */
export const supportRouter = router({
  list: permittedProcedure("access:manage").query(async ({ ctx }) => {
    const rows = await ctx.tx.select().from(supportGrant).orderBy(desc(supportGrant.startsAt)).limit(100);
    const now = Date.now();
    return rows.map((g) => ({
      id: g.id,
      engineerEmail: g.engineerEmail,
      reason: g.reason,
      startsAt: g.startsAt,
      expiresAt: g.expiresAt,
      grantedByUserId: g.grantedByUserId,
      revokedAt: g.revokedAt,
      revokedByUserId: g.revokedByUserId,
      status: statusOf(g, now),
    }));
  }),

  grant: permittedProcedure("access:manage")
    .input(
      z.object({
        engineerEmail: z.email().transform((e) => e.toLowerCase()),
        reason: z.string().trim().min(10, "Say what support needs to look at").max(500),
        hours: z.number().int().min(1).max(SUPPORT_MAX_HOURS),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Read-only, and never more than the administrator can see themselves.
      const permissions = SUPPORT_PERMISSIONS.filter((p) => ctx.permissions.has(p));
      const startsAt = new Date();
      const [grant] = await ctx.tx
        .insert(supportGrant)
        .values({
          organizationId: ctx.organizationId,
          engineerEmail: input.engineerEmail,
          reason: input.reason,
          permissions,
          startsAt,
          expiresAt: new Date(startsAt.getTime() + input.hours * 3_600_000),
          grantedByUserId: ctx.session.user.id,
        })
        .returning();
      await ctx.audit({
        action: "support.grant",
        subjectType: "support_grant",
        subjectId: grant!.id,
        after: { engineer: input.engineerEmail, hours: input.hours, permissions },
        reason: input.reason,
      });
      return { id: grant!.id, expiresAt: grant!.expiresAt };
    }),

  revoke: permittedProcedure("access:manage")
    .input(z.object({ id: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [revoked] = await ctx.tx
        .update(supportGrant)
        .set({ revokedAt: new Date(), revokedByUserId: ctx.session.user.id })
        .where(and(eq(supportGrant.id, input.id), isNull(supportGrant.revokedAt)))
        .returning({ engineer: supportGrant.engineerEmail });
      if (!revoked) throw new TRPCError({ code: "NOT_FOUND", message: "No such support access, or already revoked" });
      await ctx.audit({ action: "support.revoke", subjectType: "support_grant", subjectId: input.id, before: { engineer: revoked.engineer } });
    }),
});

/**
 * The session a Flowless support engineer calls the API with, for Flowless's own support
 * tooling (server-side only; how engineers sign in there is outside the tenant app). The
 * grant is checked on every call, so revoking or expiry takes effect at once.
 */
export function supportSession(input: {
  organizationId: string;
  grantId: string;
  engineer: { id: string; email: string; name: string };
}): Session {
  return {
    user: { id: input.engineer.id, email: input.engineer.email.toLowerCase(), name: input.engineer.name },
    session: { id: `support-${input.grantId}`, activeOrganizationId: input.organizationId },
    member: null,
    support: { grantId: input.grantId },
  };
}

