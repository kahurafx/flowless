import { initTRPC, TRPCError } from "@trpc/server";
import { withTenant, type Database } from "@flowless/db";
import superjson from "superjson";

/**
 * Who is calling. From Phase 1 (K-03) this comes from Better Auth via `packages/auth`:
 * `organizationId` is the session's `activeOrganizationId`, whose membership Better Auth
 * has already checked. A session without an active organization gets no tenant access.
 */
export interface Session {
  userId: string;
  organizationId: string;
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

  return withTenant(ctx.db, session.organizationId, async (tx) => {
    const result = await next({ ctx: { session, tx } });
    if (!result.ok) throw result.error;
    return result;
  });
});
