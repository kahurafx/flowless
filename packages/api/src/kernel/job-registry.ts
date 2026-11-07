import type { JobDef } from "./jobs";

/**
 * Every background job, kernel and modules (NF-12). `apps/worker` runs these. A module
 * adds its jobs from its own folder; an unlicensed module's jobs finish as skipped.
 */
export const jobs: readonly JobDef[] = [];

const types = new Set<string>();
for (const j of jobs) {
  if (types.has(j.type)) throw new Error(`Job "${j.type}" is registered twice`);
  types.add(j.type);
}
