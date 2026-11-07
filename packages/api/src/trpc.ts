import { initTRPC, TRPCError } from "@trpc/server";
import type { Caller } from "@flowless/auth";
import { memberPermission, withTenant, type Database } from "@flowless/db";
import { effectivePermissions, type Permission } from "@flowless/shared-types";
import { eq } from "drizzle-orm";
import superjson from "superjson";

/**
 * Who is calling: the parts of the Better Auth caller the API relies on. Derived from
 * `Caller` so there is one model of the caller; `connectAuth().getCaller` returns it.
 * `member` is the caller's one membership, read fresh for every request.
 */
export interface Session {
  user: Pick<Caller["user"], "id" | "name" | "email">;
  session: Pick<Caller["session"], "id" | "activeOrganizationId">;
  member: Caller["member"];
}

export interface Context {
  db: Database;
  session: Session | null;
}

// superjson carries bigint (money in minor units, B-18) and Date across the wire.
const t = initTRPC.context<Context>().create({ transformer: superjson });

export const router = t.router;
export const createCallerFactory = t.createCallerFactory;
export const publicProcedure = t.procedure;

/**
 * Runs the whole procedure inside `withTenant`, exposing the tenant-scoped
 * transaction as `ctx.tx` (K-01) and what the caller may do as `ctx.permissions`
 * (role defaults plus extra grants, K-03). The tenant is the caller's membership, and it
 * must match the session's active organization, so a removed member loses access at once.
 * In tRPC v11 `next()` reports failure as `{ ok: false }` instead of throwing, so
 * re-throw to roll the transaction back.
 */
export const tenantProcedure = t.procedure.use(({ ctx, next }) => {
  const { session } = ctx;
  if (!session) throw new TRPCError({ code: "UNAUTHORIZED" });
  const organizationId = session.session.activeOrganizationId;
  const member = session.member;
  if (!organizationId || member?.organizationId !== organizationId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "No active organization" });
  }

  return withTenant(ctx.db, organizationId, async (tx) => {
    const grants = await tx
      .select({ permission: memberPermission.permission })
      .from(memberPermission)
      .where(eq(memberPermission.userId, session.user.id));
    const permissions = effectivePermissions(
      member.role,
      grants.map((g) => g.permission),
    );
    const result = await next({ ctx: { session, organizationId, role: member.role, permissions, tx } });
    if (!result.ok) throw result.error;
    return result;
  });
});

/** A tenant procedure the caller may run only with every listed permission (K-03). */
export function permittedProcedure(...required: [Permission, ...Permission[]]) {
  return tenantProcedure.use(({ ctx, next }) => {
    const missing = required.filter((p) => !ctx.permissions.has(p));
    if (missing.length) throw new TRPCError({ code: "FORBIDDEN", message: `Missing permission: ${missing.join(", ")}` });
    return next();
  });
}

/**
 * The message of an error the caller can act on (FORBIDDEN, NOT_FOUND, …), or null for
 * internal errors, whose details must not reach the user. For apps calling in-process.
 */
export function clientErrorMessage(error: unknown): string | null {
  return error instanceof TRPCError && error.code !== "INTERNAL_SERVER_ERROR" ? error.message : null;
}
