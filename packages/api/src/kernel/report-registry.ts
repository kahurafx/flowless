import { conditionTrendReport, recentFindingsReport } from "../modules/gis";
import type { ReportDef } from "./report-guard";

/**
 * Every report defined in code (X-01). A module adds its own when it ships. CI checks each
 * one with `reportPublishProblems` (X-04) and runs it in the isolation canary (NF-02).
 */
export const reports: readonly ReportDef[] = [recentFindingsReport as ReportDef, conditionTrendReport as ReportDef];
