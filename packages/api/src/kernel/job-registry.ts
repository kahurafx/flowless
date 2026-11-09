import type { JobDef } from "./jobs";

/**
 * Every background job, kernel and modules (NF-12). `apps/worker` runs these. A module adds
 * its jobs from its `registerKernel` (called in `src/wiring.ts`) with `registerJob`; an
 * unlicensed module's jobs finish as skipped. Live: read it only after wiring.
 */
export const jobs: readonly JobDef[] = [];

const list = jobs as JobDef[];

export function registerJob<T>(job: JobDef<T>): void {
  if (list.some((j) => j.type === job.type)) throw new Error(`Job "${job.type}" is registered twice`);
  list.push(job as JobDef);
}
