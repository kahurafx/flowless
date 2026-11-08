import { WorkRegistry } from "./kernel/work";

/**
 * The composition root: where modules plug their adapters into the kernel's ports, so they
 * never import each other (NF-30). Each module exports a `register(work)` from its
 * `index.ts` and is called here when it ships (Work Orders and GIS in Phase 2).
 */
export const work = new WorkRegistry();
