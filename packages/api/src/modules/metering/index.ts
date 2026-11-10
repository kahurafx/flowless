import type { KernelRegistrar } from "../../kernel/registrar";
import { readingFileSubject } from "./files";
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
export { latestActualReading, readingsFor, type ReadingsFor, type ReadingView } from "./reads";

// Pure rules, for tests and for clients that want to explain a flag.
export { blocks, expectedPerDay, validateReading, type ValidationInput, type ValidationResult } from "./validate";

/** Adds Metering's setting and file subject to the kernel's registries; called in `wiring.ts`. */
export function registerKernel(kernel: KernelRegistrar) {
  kernel.setting(meteringValidationSetting);
  kernel.fileSubject(readingFileSubject);
}
