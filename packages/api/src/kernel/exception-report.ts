import { EXCEPTION_STATUSES } from "@flowless/shared-types";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { defineAggregateReport, enumFilter, inIds, textFilter } from "./report-builder";

/**
 * Exceptions by type, status, owner and age (X-01, X-02): the queue as a report, from the
 * kernel table (age is derived from `raised_at`, never stored). Limited members see the
 * exceptions placed in their areas and routes, the same rule as the queue (K-03).
 */
const ageOf = sql`extract(epoch from (coalesce(e.resolved_at, now()) - e.raised_at)) / 86400`;

export const exceptionsReport = defineAggregateReport({
  key: "kernel.exceptions",
  module: "kernel",
  label: "Exceptions by type, age and owner",
  permissions: ["exceptions:read"],
  from: sql`kernel.exception e`,
  dimensions: [
    { key: "type", label: "Type", type: "text", expr: sql`e.type` },
    { key: "source", label: "Raised by", type: "text", expr: sql`e.source` },
    { key: "status", label: "Status", type: "text", expr: sql`e.status` },
    { key: "ownerUserId", label: "Owner", type: "text", expr: sql`e.owner_user_id::text` },
    { key: "age", label: "Age", type: "text", expr: sql`case when ${ageOf} < 1 then 'under 1 day' when ${ageOf} < 7 then '1-7 days' when ${ageOf} < 30 then '7-30 days' else '30+ days' end` },
    { key: "routeId", label: "Route", type: "text", expr: sql`e.route_id::text` },
    { key: "areaId", label: "Area", type: "text", expr: sql`e.area_id::text` },
  ],
  measures: [
    { key: "exceptions", label: "Exceptions", type: "integer", expr: sql`count(*)::int` },
    { key: "oldestDays", label: "Oldest (days)", type: "integer", expr: sql`coalesce(floor(max(${ageOf})), 0)::int` },
  ],
  defaultGroupBy: ["type", "status"],
  filters: [
    enumFilter("state", "State", ["active", ...EXCEPTION_STATUSES] as const, (v) => (v === "active" ? sql`e.status <> 'resolved'` : sql`e.status = ${v}`)),
    textFilter("type", "Type", (v) => sql`e.type = ${v}`),
    textFilter("source", "Raised by", (v) => sql`e.source = ${v}`),
  ],
  scope: {
    shape: { restricted: z.boolean().default(false), areaIds: z.array(z.uuid()).default([]), routeIds: z.array(z.uuid()).default([]) },
    resolve: async ({ scope }) =>
      scope.kind === "all" ? { restricted: false, areaIds: [], routeIds: [] } : { restricted: true, areaIds: [...scope.areaIds], routeIds: [...scope.routeIds] },
    where: (p) => {
      if (!p.restricted) return undefined;
      const areas = (p.areaIds as string[]).length ? inIds(sql`e.area_id`, p.areaIds as string[]) : sql`false`;
      const routes = (p.routeIds as string[]).length ? inIds(sql`e.route_id`, p.routeIds as string[]) : sql`false`;
      return sql`${areas} or ${routes}`;
    },
  },
});
