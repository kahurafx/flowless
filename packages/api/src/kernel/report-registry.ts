import type { ReportDef } from "./report-guard";

/**
 * Every report defined in code (X-01). A module adds its own from its `registerKernel`
 * (called in `src/wiring.ts`) with `registerReport`. CI checks each one with
 * `reportPublishProblems` (X-04) and runs it in the isolation canary (NF-02). Live: read it
 * only after wiring.
 */
export const reports: readonly ReportDef[] = [];

const list = reports as ReportDef[];

export function registerReport<P>(def: ReportDef<P>): void {
  if (list.some((r) => r.key === def.key)) throw new Error(`Report "${def.key}" is registered twice`);
  list.push(def as ReportDef);
}
