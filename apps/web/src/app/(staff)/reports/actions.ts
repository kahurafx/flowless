"use server";

import { runAction } from "@/data/run-action";

/*
 * Running and exporting a report (X-01, X-03). Neither refreshes the page: the result goes
 * straight to the viewer. The API checks `reports:read` / `reports:export` plus the report's own
 * permissions, applies the member's scope from the session and audits every export with its
 * parameters (K-06).
 */

export async function runReportAction(input: { key: string; params: Record<string, unknown> }) {
  return runAction((api) => api.reports.run({ key: input.key, params: input.params }), { refresh: false });
}

export async function exportReportAction(input: { key: string; params: Record<string, unknown>; format: "csv" | "xlsx" }) {
  return runAction((api) => api.reports.export({ key: input.key, params: input.params, format: input.format }), { refresh: false });
}
