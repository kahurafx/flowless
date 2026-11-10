import type { KernelRegistrar } from "../../kernel/registrar";
import { readingFileSubject } from "./files";
import { meteringBulkSetting, meteringMissesSetting, meteringOutcomesSetting, meteringZeroSetting } from "./policy-settings";
import { closeAndOpenOnRelocation, registerPorts } from "./ports";
import { meteringValidationSetting } from "./settings";

/*
 * The Metering module's published interface (NF-30): what `root.ts` and the kernel registries
 * use, and what other modules may call. Others read readings only through the functions
 * below, with their own transaction, never from the `metering` schema.
 */
export { meteringRouter } from "./router";
export { meteringValidationSchema, meteringValidationSetting, type MeteringValidation } from "./settings";
export { meterInstalled, meterRemoved, meterReplaced, meterStatusChanged, readingRecorded, readingStatusChanged } from "./events";

// Derived reads for Billing and Phase 5 jobs (M-02, M-03): baseline, previous reading and units are computed, never stored.
export { latestActualReading, readingById, readingsFor, type ReadingsFor, type ReadingView } from "./reads";
// Billing's disconnection (B-12): the installed meter and the final reading.
export { currentMeterOf, recordFinalReading } from "./final-reading";

// Pure rules, for tests and for clients that want to explain a flag.
export { blocks, expectedPerDay, validateReading, type ValidationInput, type ValidationResult } from "./validate";

// Outcomes and dispositions (M-06), visits and the derived miss counters (M-09), the eligibility snapshot (M-08), bulk schedules (M-12), handovers.
export { attemptsFor, dispositionFor, outcomeMapping, type AttemptView } from "./outcomes";
export { consecutiveEstimates, consecutiveMisses } from "./policy";
export { eligibilityOf, readingTasks, snapshotById, snapshotFor, takeSnapshot, type ReadingTask, type SnapshotRow, type SnapshotView } from "./eligibility";
export { bulkSchedule, type BulkDue } from "./bulk";
export { listHandovers, type HandoverView } from "./handover";
export { activeMeteredNoMeter, closeAndOpenOnRelocation, initialReadingSource, registerPorts } from "./ports";
export { meteringBulkSchema, meteringMissesSchema, meteringOutcomesSchema, meteringZeroSchema } from "./policy-settings";
export { eligibilitySnapshotTaken, estimateCapReached, missThresholdReached, readingAttempted, readingHandoverOpened, selfReadPromptDue, zeroConsumptionStreak } from "./events-policy";

/** Adds Metering's setting and file subject to the kernel's registries; called in `wiring.ts`. */
export function registerKernel(kernel: KernelRegistrar) {
  kernel.setting(meteringValidationSetting);
  kernel.setting(meteringOutcomesSetting);
  kernel.setting(meteringMissesSetting);
  kernel.setting(meteringZeroSetting);
  kernel.setting(meteringBulkSetting);
  kernel.fileSubject(readingFileSubject);
  kernel.consumer(closeAndOpenOnRelocation);
  registerPorts();
}
