import type { KernelRegistrar } from "../../kernel/registrar";
import { adjustmentApproval as adjustmentKind } from "./approvals";
import { registerPorts } from "./ports";
import { billingPolicySetting as policy } from "./settings";

/*
 * The Billing module's published interface (NF-30): what `root.ts` and the kernel registries
 * use, and what other modules may call. `registerKernel` also registers Billing's side of the
 * Accounts and Tariffs ports (`ports.ts`). Billing reads other modules only through their
 * `index.ts`, and publishes its facts as events.
 */
export { billingRouter } from "./router";
export { adjustmentApproval, ADJUSTMENT_APPROVAL_KIND } from "./approvals";
export { billingPolicySchema, billingPolicySetting, type BillingPolicy } from "./settings";
export { billHeld, documentIssued, documentReversed } from "./events";

// Derived reads for other modules (Collections, Payments, the portal): always from ledger entries, with the caller's transaction.
export { accountBalance, accountStatement } from "./reads";

// The ports Billing fills (P4-4), for tests that reset and restore them.
export { balanceTransfer, closedPeriodSource, connectionPosition, paymentThresholdSource, registerPorts, terminationCheck } from "./ports";

/** Adds Billing's setting and approval kind to the kernel's registries; called in `wiring.ts`. */
export function registerKernel(kernel: KernelRegistrar) {
  kernel.setting(policy);
  kernel.approval(adjustmentKind);
  // Accounts' termination check, payment gate and balance transfer (each `requires: ["billing"]`) and Tariffs' closed-period source.
  registerPorts();
}
