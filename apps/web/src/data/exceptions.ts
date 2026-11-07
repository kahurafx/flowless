import { exceptionAge, type AgeBucket, type ExceptionItem, type ExceptionType } from "@flowless/shared-types";
import { connection } from "next/server";
import { exceptions } from "@/mocks/exceptions";
import { getSession } from "./session";

// UI track seam: becomes `caller.kernel.exceptions.list()` in Phase 1 (A7).

export interface ExceptionRow extends ExceptionItem {
  ageDays: number;
  ageBucket: AgeBucket;
}

const DAY_MS = 86_400_000;

/** Open and in-progress exceptions for the active organization, oldest first. */
export async function listExceptions(): Promise<{ asOf: Date; rows: ExceptionRow[] }> {
  // Age depends on "now": render it per request, never in a prerender or runtime prefetch
  // (cookies alone do not make a subtree request-time under partial prefetching).
  const [{ organization }] = await Promise.all([getSession(), connection()]);
  const asOf = new Date();
  const rows = exceptions
    .filter((e) => e.organizationId === organization.id && e.status !== "resolved")
    .map(({ organizationId: _org, raisedDaysAgo, ...e }) => {
      const raisedAt = new Date(asOf.getTime() - raisedDaysAgo * DAY_MS - 3_600_000);
      const age = exceptionAge(raisedAt, asOf);
      return { ...e, raisedAt, ageDays: age.days, ageBucket: age.bucket };
    })
    .sort((a, b) => a.raisedAt.getTime() - b.raisedAt.getTime());
  return { asOf, rows };
}

/** Counts per queue for the dashboard. */
export async function exceptionCounts(): Promise<{
  byType: Partial<Record<ExceptionType, number>>;
  byBucket: Record<AgeBucket, number>;
  unowned: number;
  total: number;
}> {
  const { rows } = await listExceptions();
  const byType: Partial<Record<ExceptionType, number>> = {};
  const byBucket: Record<AgeBucket, number> = { fresh: 0, ageing: 0, overdue: 0 };
  for (const row of rows) {
    byType[row.type] = (byType[row.type] ?? 0) + 1;
    byBucket[row.ageBucket] += 1;
  }
  return { byType, byBucket, unowned: rows.filter((r) => !r.owner).length, total: rows.length };
}
