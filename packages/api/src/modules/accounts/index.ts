import type { KernelRegistrar } from "../../kernel/registrar";
import { recordWriteOffDecision as writeOffConsumer, writeOffApproval as writeOffKind } from "./approvals";
import { findingsReport, summaryReport } from "./data-quality-queries";
import { activationSetting as activation, applicationSetting as application, dataQualitySetting as dataQuality, membershipSetting as membership, numberingSetting as numbering, statusRulesSetting as statusRules } from "./settings";
import { surveyApproval as surveyKind } from "./survey-approval";
import { applySurveyOutcome as surveyConsumer, recordRelocationFromJob as relocationConsumer, recordSurveyFromJob as surveyJobConsumer } from "./work-kinds";

/*
 * The Accounts module's published interface (NF-30): what `root.ts`, the kernel registries
 * and the worker use. Other modules learn about customers, accounts and service points
 * through the events below; Tariffs resolves an account's opaque `category_id` through its
 * own interface, and Accounts never reads another module's tables. Later modules plug facts
 * into the lifecycle through the ports at the bottom (gate sources, the termination check).
 */
export { accountsRouter } from "./router";
export { activationSetting, applicationSetting, membershipSetting, numberingSetting, statusRulesSetting } from "./settings";
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
export { recheckActivation } from "./auto-activation";
export { sweepStaleAccounts } from "./stale";

// Data quality (C-12): the catalogue lives in shared-types; the setting, the reports, the Metering port and the exception sweep are here.
export { dataQualitySetting } from "./settings";
export { dataQualityConfigSchema, type DataQualityConfig } from "./data-quality-config";
export { findingsReport as dataQualityFindingsReport, summaryReport as dataQualitySummaryReport } from "./data-quality-queries";
export { sweepDataQuality, dataQualityKey } from "./data-quality-sweep";
export { registerDataQualitySource, type DataQualitySource } from "./sources";

// The state machine (C-03), pure: for UIs that show which commands apply.
export { planCommand, STATUS_COMMANDS, type AccountState, type StatusCommand } from "./lifecycle";

// Termination (C-11): Billing registers the ledger check in Phase 4; the write-off approval and its consumer.
export { registerTerminationCheck, type TerminationCheck } from "./sources";
export type { Position } from "./termination";
export { recordWriteOffDecision, writeOffApproval } from "./approvals";

// The application workflow (C-05): the pure stage machine, the survey approval and the Work Orders hand-off.
export { ADVANCE_ACTIONS, activeStages, applicationConfigSchema, isFinalStage, nextStage, planAdvance, planEnd, type AdvanceAction, type ApplicationConfig } from "./application-stages";
export { surveyApproval, SURVEY_APPROVAL_KIND } from "./survey-approval";
export { ACCOUNTS_WORK_KINDS, accountsAssetResolver, applySurveyOutcome, connectionSurveyCapture, recordRelocationFromJob, recordSurveyFromJob, register, relocationCapture } from "./work-kinds";

// Memberships (C-07): Billing reads the class to price a child's connection fee.
export { membershipFor, type MembershipView } from "./memberships";
export { membershipConfigSchema, type MembershipConfig } from "./membership";

// Succession and change of name (C-08, C-10): who held an account when (`holderAt`, for Billing's split), and the Ledger and Metering ports.
export { holderAt, holdersOf, type HolderPeriod } from "./holders";
export {
  registerBalanceTransfer,
  registerReadingHandover,
  type BalanceTransfer,
  type BalanceTransferRequest,
  type ReadingHandover,
  type ReadingHandoverRequest,
} from "./sources";

/** Adds Accounts' settings, approval kinds, consumers and reports to the kernel's registries; called in `wiring.ts`. */
export function registerKernel(kernel: KernelRegistrar) {
  kernel.setting(numbering);
  kernel.setting(statusRules);
  kernel.setting(activation);
  kernel.setting(application);
  kernel.setting(membership);
  kernel.setting(dataQuality);
  kernel.approval(writeOffKind);
  kernel.approval(surveyKind);
  kernel.consumer(writeOffConsumer);
  kernel.consumer(surveyConsumer);
  kernel.consumer(surveyJobConsumer);
  kernel.consumer(relocationConsumer);
  kernel.report(summaryReport);
  kernel.report(findingsReport);
}
