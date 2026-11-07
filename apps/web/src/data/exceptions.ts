import { exceptionAge, type AgeBucket, type ExceptionItem, type ExceptionType } from "@flowless/shared-types";
import { connection } from "next/server";
import { exceptions as demoExceptions } from "@/mocks/exceptions";
import { getAuth } from "@/server/auth";
import { getApi, requirePermission } from "./session";

export interface ExceptionRow extends ExceptionItem {
  ageDays: number;
  ageBucket: AgeBucket;
}

const DAY_MS = 86_400_000;

/**
 * Open and in-progress exceptions, oldest first (X-02, NF-24): the kernel's real queue,
 * plus demo rows for module queues that have not shipped yet (marked `demo`).
 * Also the members who can own one, and whether the viewer may act on them.
 */
export async function listExceptions(): Promise<{
  asOf: Date;
  rows: ExceptionRow[];
  members: { id: string; name: string }[];
  canAct: boolean;
}> {
  // Age depends on "now": render it per request, never in a prerender or runtime prefetch
  // (cookies alone do not make a subtree request-time under partial prefetching).
  const [{ organization, access }] = await Promise.all([requirePermission("exceptions:read"), connection()]);
  const { api, headers } = await getApi();
  const [real, { members }] = await Promise.all([
    api.exceptions.list(),
    getAuth().api.listMembers({ headers, query: { organizationId: organization.id, limit: 500 } }),
  ]);
  const names = new Map(members.map((m) => [m.userId, m.user.name]));
  const asOf = new Date();
  const withAge = <T extends { raisedAt: Date }>(row: T) => {
    const age = exceptionAge(row.raisedAt, asOf);
    return { ...row, ageDays: age.days, ageBucket: age.bucket };
  };

  const rows: ExceptionRow[] = [
    ...real.map((e) =>
      withAge({
        id: e.id,
        type: e.type as ExceptionType,
        source: e.source as ExceptionItem["source"],
        title: e.title,
        detail: e.detail,
        subject: { kind: e.subjectKind as ExceptionItem["subject"]["kind"], ref: e.subjectRef },
        owner: e.ownerUserId ? { id: e.ownerUserId, name: names.get(e.ownerUserId) ?? "Former member" } : null,
        raisedAt: e.raisedAt,
        status: e.status,
        occurrences: e.occurrences,
        retryable: e.retryable,
      }),
    ),
    ...demoExceptions
      .filter((e) => e.org === organization.code && e.status !== "resolved")
      .map(({ org: _org, raisedDaysAgo, ...e }) =>
        withAge({ ...e, raisedAt: new Date(asOf.getTime() - raisedDaysAgo * DAY_MS - 3_600_000), occurrences: 1, retryable: false, demo: true }),
      ),
  ].sort((a, b) => a.raisedAt.getTime() - b.raisedAt.getTime());

  return {
    asOf,
    rows,
    members: members.map((m) => ({ id: m.userId, name: m.user.name })).sort((a, b) => a.name.localeCompare(b.name)),
    canAct: access.permissions.includes("exceptions:resolve"),
  };
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
