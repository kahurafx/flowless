import type { KernelRegistrar } from "../../kernel/registrar";
import { adjustmentApproval as adjustmentKind, correctionApproval as correctionKind } from "./approvals";
import { correctionSettings } from "./correction-policy";
import { correctionNeededOnRecorded, correctionNeededOnStatus } from "./correction-needed";
import { revenueProtectionSetting } from "./cases";
import { billAccountJob, billOnReading } from "./bill-job";
import { registerPorts } from "./ports";
import { billingReports } from "./reports";
import { billingCycleSetting, billingReviewSetting } from "./cycle-settings";
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
export { billingCycleSchema, billingCycleSetting, billingReviewSchema, billingReviewSetting } from "./cycle-settings";
export { cycleClosed, cycleOpened, cycleOutcomeRecorded, cycleStateChanged } from "./cycle-events";
export { billAccount } from "./bill-account";
export { billAccountJob, billOnReading } from "./bill-job";
export { enqueueCycleJobs } from "./cycle-enqueue";
export { analyseReadings, type RunReading } from "./run-input";
export { completenessOf, type Completeness } from "./completeness";
export { nextState, planClose, planMove } from "./cycle-machine";
export { reviewBucket, sampleSelection } from "./cycle-review";
// B-15: the period a closed cycle locks, for a module that must refuse or flag a posting into it.
export { assertPeriodOpen, lockingCycle, monthsCovered } from "./period-lock";
// B-12, B-14, B-19: disconnection, corrections and revenue-protection cases.
export { disconnect, reconnect, derivedId } from "./disconnections";
export { correctionPath, correctionSettings, graceEnd, isLargeDeviation, renderTemplate } from "./correction-policy";
export { proposeCorrection, postCorrection } from "./corrections";
export { openCase, revenueProtectionSetting } from "./cases";
export { correctionApproval, CORRECTION_APPROVAL_KIND } from "./approvals";
// X-01: the registered reports, for tests.
export { billingReports } from "./reports";
export { billHeld, documentIssued, documentReversed } from "./events";

// Derived reads for other modules (Collections, Payments, the portal): always from ledger entries, with the caller's transaction.
export { accountBalance, accountStatement } from "./reads";

// The ports Billing fills (P4-4), for tests that reset and restore them.
export { balanceTransfer, closedPeriodSource, connectionPosition, paymentThresholdSource, registerPorts, terminationCheck } from "./ports";

/** Adds Billing's setting and approval kind to the kernel's registries; called in `wiring.ts`. */
export function registerKernel(kernel: KernelRegistrar) {
  kernel.setting(policy);
  kernel.setting(billingCycleSetting);
  kernel.setting(billingReviewSetting);
  kernel.setting(correctionSettings);
  kernel.setting(revenueProtectionSetting);
  kernel.approval(adjustmentKind);
  kernel.approval(correctionKind);
  kernel.consumer(correctionNeededOnRecorded);
  kernel.consumer(correctionNeededOnStatus);
  kernel.job(billAccountJob);
  kernel.consumer(billOnReading);
  for (const report of billingReports) kernel.report(report);
  // Accounts' termination check, payment gate and balance transfer (each `requires: ["billing"]`) and Tariffs' closed-period source.
  registerPorts();
}
