import { moduleProcedure } from "../../trpc";

/**
 * The Metering procedures (K-04, NF-03): the module's licence first, then the permission (K-03).
 * Readings carry `ctx.viewer` so reads and writes check the account's visibility through
 * Accounts' published reads (K-03).
 * - `meters` (`meters:read`) and `register` (`meters:manage`): the register, installations, replacement.
 * - `read` (`readings:read`), `capture` (`readings:capture`), `approve` (`readings:approve`).
 */
function withViewer<T extends ReturnType<typeof moduleProcedure>>(procedure: T) {
  return procedure.use(async ({ ctx, next }) => next({ ctx: { viewer: { userId: ctx.session.user.id, scope: await ctx.scope() } } }));
}

export const meteringProcedures = {
  meters: withViewer(moduleProcedure("metering", "meters:read")),
  register: withViewer(moduleProcedure("metering", "meters:read", "meters:manage")),
  read: withViewer(moduleProcedure("metering", "readings:read")),
  capture: withViewer(moduleProcedure("metering", "readings:read", "readings:capture")),
  approve: withViewer(moduleProcedure("metering", "readings:read", "readings:approve")),
};
