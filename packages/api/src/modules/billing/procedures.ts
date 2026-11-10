import { moduleProcedure } from "../../trpc";

/**
 * The Billing procedures (K-04, NF-03): the module's licence first, then `billing:*` (K-03).
 * Each adds `ctx.viewer` (who is asking and which part of the network they may see, K-03):
 * Billing checks it against Accounts' published reads (`scope.ts`).
 * - `read` (`billing:read`): balances, statements, documents.
 * - `issue` (`billing:run`): post a bill for an account and period, or its final bill. Billing runs
 *   (Phase 5) will call the same use cases as the system.
 * - `adjust` (`billing:adjust`): everything that corrects posted money: credit and debit
 *   notes (also behind a K-05 approval), voids and re-bills.
 */
function withViewer<T extends ReturnType<typeof moduleProcedure>>(procedure: T) {
  return procedure.use(async ({ ctx, next }) => next({ ctx: { viewer: { userId: ctx.session.user.id, scope: await ctx.scope() } } }));
}

export const billingProcedures = {
  read: withViewer(moduleProcedure("billing", "billing:read")),
  issue: withViewer(moduleProcedure("billing", "billing:read", "billing:run")),
  adjust: withViewer(moduleProcedure("billing", "billing:read", "billing:adjust")),
};

export type BillingProcedures = typeof billingProcedures;
