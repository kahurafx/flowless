import { initTRPC, TRPCError } from "@trpc/server";
import type { AuthSession } from "@flowless/auth";
import { withTenant, type Database } from "@flowless/db";
import superjson from "superjson";

/**
 * Who is calling: the parts of the Better Auth session the API relies on. Derived from
 * `AuthSession` so there is one model of the caller; a full Better Auth session fits it.
 * `activeOrganizationId` is a membership Better Auth has already checked.
 */
export interface Session {
  user: Pick<AuthSession["user"], "id" | "name" | "email">;
  session: Pick<AuthSession["session"], "id" | "activeOrganizationId">;
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
 * transaction as `ctx.tx` (K-01). In tRPC v11 `next()` reports failure as
 * `{ ok: false }` instead of throwing, so re-throw to roll the transaction back.
 */
export const tenantProcedure = t.procedure.use(({ ctx, next }) => {
  const { session } = ctx;
  if (!session) throw new TRPCError({ code: "UNAUTHORIZED" });
  const organizationId = session.session.activeOrganizationId;
  if (!organizationId) throw new TRPCError({ code: "FORBIDDEN", message: "No active organization" });

  return withTenant(ctx.db, organizationId, async (tx) => {
    const result = await next({ ctx: { session, organizationId, tx } });
    if (!result.ok) throw result.error;
    return result;
  });
});
