import { moduleProcedure } from "../../trpc";

/**
 * The Billing procedures (K-04, NF-03): the module's licence first, then `billing:*` (K-03).
 * - `read` (`billing:read`): balances, statements, documents.
 * - `issue` (`billing:run`): post a bill for an account and period. Billing runs (Phase 5)
 *   will call the same use cases as the system.
 * - `adjust` (`billing:adjust`): everything that corrects posted money: credit and debit
 *   notes (also behind a K-05 approval), voids and re-bills.
 */
export const billingProcedures = {
  read: moduleProcedure("billing", "billing:read"),
  issue: moduleProcedure("billing", "billing:read", "billing:run"),
  adjust: moduleProcedure("billing", "billing:read", "billing:adjust"),
};

export type BillingProcedures = typeof billingProcedures;
