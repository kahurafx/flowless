import type { KernelRegistrar } from "../../kernel/registrar";
import { adjustmentApproval as adjustmentKind } from "./approvals";
import { billingPolicySetting as policy } from "./settings";

/*
 * The Billing module's published interface (NF-30): what `root.ts` and the kernel registries
 * use, and what other modules may call. Accounts' and Tariffs' ports (termination check,
 * gate source, `chargesApplying`, the closed period) are wired in a later step (P4-4); this
 * file will gain their registration then. Billing reads other modules only through their
 * `index.ts`, and publishes its facts as events.
 */
export { billingRouter } from "./router";
export { adjustmentApproval, ADJUSTMENT_APPROVAL_KIND } from "./approvals";
export { billingPolicySchema, billingPolicySetting, type BillingPolicy } from "./settings";
export { billHeld, documentIssued, documentReversed } from "./events";

// Derived reads for other modules (Collections, Payments, the portal): always from ledger entries, with the caller's transaction.
export { accountBalance, accountStatement } from "./reads";

/** Adds Billing's setting and approval kind to the kernel's registries; called in `wiring.ts`. */
export function registerKernel(kernel: KernelRegistrar) {
  kernel.setting(policy);
  kernel.approval(adjustmentKind);
}
