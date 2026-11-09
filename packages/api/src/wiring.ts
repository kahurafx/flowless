import { kernelRegistrar } from "./kernel/registrar";
import { WorkRegistry } from "./kernel/work";
import { register as registerAccounts, registerKernel as registerAccountsKernel } from "./modules/accounts";
import { register as registerGis, registerKernel as registerGisKernel } from "./modules/gis";
import { registerKernel as registerTariffsKernel } from "./modules/tariffs";
import { register as registerWorkOrders, registerKernel as registerWorkOrdersKernel } from "./modules/work-orders";

/**
 * The composition root: where modules plug into the kernel, so the kernel imports no module
 * and modules never import each other (NF-30). Each module exports `register(work)` (its
 * adapters on the Work Registry's ports, when it has any) and `registerKernel(kernel)` (its
 * consumers, settings, approval kinds, reports, file subjects and jobs for the kernel's
 * registries) from its `index.ts`; both are called here when the module ships. Order matters
 * where a registry is ordered: consumers run in this order, and settings are listed in it.
 *
 * Every entry point (`index.ts`, `root.ts`) imports this file, which runs once on first
 * import. Read the registries (`consumers`, `reports`, ...) from here or from the package
 * index, never from the kernel registry files directly, so they are always fully wired.
 */
export const work = new WorkRegistry();

registerWorkOrders(work);
registerGis(work);
registerAccounts(work);

registerWorkOrdersKernel(kernelRegistrar);
registerGisKernel(kernelRegistrar);
registerTariffsKernel(kernelRegistrar);
registerAccountsKernel(kernelRegistrar);

export { approvals } from "./kernel/approval-registry";
export { settings } from "./kernel/config-registry";
export { consumers } from "./kernel/consumers";
export { fileSubjects } from "./kernel/file-subject-registry";
export { jobs } from "./kernel/job-registry";
export { reports } from "./kernel/report-registry";
