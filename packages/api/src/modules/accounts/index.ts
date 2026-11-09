/*
 * The Accounts module's published interface (NF-30): what `root.ts`, the kernel registries
 * and the worker use. Other modules learn about customers, accounts and service points
 * through the events below; Tariffs resolves an account's opaque `category_id` through its
 * own interface, and Accounts never reads another module's tables. Later modules plug facts
 * into the lifecycle through the ports at the bottom (gate sources, the termination check).
 */
export { accountsRouter } from "./router";
export { activationSetting, numberingSetting, statusRulesSetting } from "./settings";
export {
  accountActivated,
  accountOpened,
  accountStatusChanged,
  accountTerminated,
  customerCreated,
  servicePointCreated,
  serviceStatusChanged,
} from "./events";
export {
  checkDigitOf,
  childAccountNumber,
  formatAccountNumber,
  hasValidCheckDigit,
  isValidAccountNumber,
  numberingFormatSchema,
  parseAccountNumber,
  type NumberingFormat,
} from "./numbering";

// Charges by status (C-04): Billing asks what applies to an account in its status.
export { chargeTypeApplies, chargesApplying, statusRuleTable, DEFAULT_STATUS_RULES, type ChargesApplying, type StatusRules } from "./status-rules";

// Activation (C-06): the pure rules, the registry for other modules' facts, and the auto-mode recheck.
export { evaluateGates, gateList, hasPaymentGate, type ActivationConfig, type GateEvaluation, type GateFact, type GateResult } from "./gates";
export { registerGateSource, type GateSource } from "./sources";
export { recheckActivation } from "./commands";
export { sweepStaleAccounts } from "./stale";

// The state machine (C-03), pure: for UIs that show which commands apply.
export { planCommand, STATUS_COMMANDS, type AccountState, type StatusCommand } from "./lifecycle";

// Termination (C-11): Billing registers the ledger check in Phase 4; the write-off approval and its consumer.
export { registerTerminationCheck, type TerminationCheck } from "./sources";
export type { Position } from "./termination";
export { recordWriteOffDecision, writeOffApproval } from "./approvals";
