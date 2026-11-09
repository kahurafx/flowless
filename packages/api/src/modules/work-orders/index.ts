import type { KernelRegistrar } from "../../kernel/registrar";
import type { WorkRegistry } from "../../kernel/work";
import { workOrderFileSubject as jobFiles } from "./files";
import { kindPolicySetting as kindPolicy } from "./policy";
import { WORK_ORDER_KINDS } from "./kinds";
import { workOrderAssetWork } from "./link/asset-work";
import { workOrderBranchGuard } from "./link/branch-guard";
import { workOrderBranchAnnotator } from "./link/branch-label";

/*
 * The Work Orders module's published interface (NF-30): what the kernel registries,
 * `wiring.ts`, `root.ts` and the worker use. Other modules reach jobs only through the
 * kernel work ports and the events below.
 */

/** Plugs Work Orders into the kernel's work ports: its kinds, and the "wo-" branch adapters. */
export function register(work: WorkRegistry) {
  for (const kind of WORK_ORDER_KINDS) work.registerWorkKind(kind);
  work.registerBranchGuard(workOrderBranchGuard);
  work.registerBranchAnnotator(workOrderBranchAnnotator);
  work.registerAssetWork(workOrderAssetWork);
}

export { createWorkOrdersRouter } from "./router";
export { workOrderFileSubject } from "./files";
export { kindPolicySetting } from "./policy";
export { sweepOverdueWorkOrders } from "./sla";
export { WORK_ORDER_KINDS } from "./kinds";
export { WORK_ORDER_BRANCH_PREFIX } from "./link/branch-guard";
export { workOrderAssigned, workOrderCompleted, workOrderCreated, workOrderStatusChanged, type WorkOrderCompleted } from "./events";

/** Adds Work Orders' setting and file subject to the kernel's registries; called in `wiring.ts`. */
export function registerKernel(kernel: KernelRegistrar) {
  kernel.setting(kindPolicy);
  kernel.fileSubject(jobFiles);
}
