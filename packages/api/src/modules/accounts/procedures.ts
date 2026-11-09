import { moduleProcedure } from "../../trpc";

/**
 * The Accounts procedures (K-04, NF-03): the module's licence first, then the catalogue's
 * `accounts:*` permissions (K-03). `ctx.viewer` is who is asking and which part of the
 * organization they cover (scope restrictions, K-03); every read of customers, accounts and
 * service points applies it (`access.ts`).
 * - `read` (`accounts:read`): customers, accounts, service points, searches, previews.
 * - `create` (`accounts:create`): new customers, accounts and service points.
 * - `update` (`accounts:update`): changes to customers, their contacts and service points.
 * `accounts:change_status` belongs to the account lifecycle (Phase 3 F3).
 */
function withViewer<T extends ReturnType<typeof moduleProcedure>>(procedure: T) {
  return procedure.use(async ({ ctx, next }) => next({ ctx: { viewer: { userId: ctx.session.user.id, scope: await ctx.scope() } } }));
}

export const accountsProcedures = {
  read: withViewer(moduleProcedure("accounts", "accounts:read")),
  create: withViewer(moduleProcedure("accounts", "accounts:read", "accounts:create")),
  update: withViewer(moduleProcedure("accounts", "accounts:read", "accounts:update")),
};

export type AccountsProcedures = typeof accountsProcedures;
