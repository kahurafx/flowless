import { registerApproval } from "./approval-registry";
import { registerSetting } from "./config-registry";
import { registerConsumer } from "./consumers";
import { registerFileSubject } from "./file-subject-registry";
import { registerJob } from "./job-registry";
import { registerReport } from "./report-registry";

/**
 * What a module may add to the kernel's registries (K-05, K-08, K-09, K-10, X-01, NF-12).
 * Each module exports `registerKernel(kernel: KernelRegistrar)` from its `index.ts` and
 * `src/wiring.ts` calls it, so the kernel never imports a module. Registering the same
 * name, key or type twice throws.
 */
export interface KernelRegistrar {
  consumer: typeof registerConsumer;
  setting: typeof registerSetting;
  approval: typeof registerApproval;
  report: typeof registerReport;
  fileSubject: typeof registerFileSubject;
  job: typeof registerJob;
}

export const kernelRegistrar: KernelRegistrar = {
  consumer: registerConsumer,
  setting: registerSetting,
  approval: registerApproval,
  report: registerReport,
  fileSubject: registerFileSubject,
  job: registerJob,
};
