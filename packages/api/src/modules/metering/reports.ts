import { READING_OUTCOMES } from "@flowless/shared-types";
import { sql } from "drizzle-orm";
import { accountScope, dateFilter, defineAggregateReport, defineListReport, enumFilter, intFilter, uuidFilter } from "../../kernel/report-builder";
import { visibleAccountIds } from "../accounts";

/*
 * Metering's reports (X-01, X-03), derived from the append-only attempts and readings (no stored
 * counters). Each needs `readings:read`, a licence for Metering, and is confined to the accounts
 * the member may see (K-03): a visit or reading with no account (a service point not yet linked)
 * is visible only to unrestricted members.
 */

const PERMISSIONS = ["readings:read"] as const;
const scopeOn = (column: string) =>
  accountScope(sql.raw(column), async ({ tx, userId, scope }) => (scope.kind === "all" ? undefined : visibleAccountIds(tx, { userId, scope })));

/** The route a service point is on, from its newest eligibility snapshot row. */
const routeOf = (spColumn: string) => sql`left join lateral (
    select er.route_id
      from metering.eligibility_row er
      join metering.eligibility_snapshot es on es.organization_id = er.organization_id and es.id = er.snapshot_id
     where er.service_point_id = ${sql.raw(spColumn)}
     order by es.taken_at desc limit 1
  ) rt on true`;

export const readingsByOutcome = defineAggregateReport({
  key: "metering.readings_by_outcome",
  module: "metering",
  label: "Reading visits by outcome and route",
  permissions: PERMISSIONS,
  from: sql`metering.read_attempt a ${routeOf("a.service_point_id")}`,
  dimensions: [
    { key: "month", label: "Month", type: "text", expr: sql`to_char(a.attempted_at, 'YYYY-MM')` },
    { key: "outcome", label: "Outcome", type: "text", expr: sql`a.outcome` },
    { key: "routeId", label: "Route", type: "text", expr: sql`rt.route_id::text` },
    { key: "source", label: "Source", type: "text", expr: sql`a.source` },
  ],
  measures: [
    { key: "visits", label: "Visits", type: "integer", expr: sql`count(*)::int` },
    { key: "withReading", label: "With a reading", type: "integer", expr: sql`count(a.reading_id)::int` },
    { key: "servicePoints", label: "Service points", type: "integer", expr: sql`count(distinct a.service_point_id)::int` },
  ],
  defaultGroupBy: ["month", "outcome"],
  filters: [
    dateFilter("from", "From", (v) => sql`a.attempted_at >= ${v}::date`),
    dateFilter("to", "To", (v) => sql`a.attempted_at < (${v}::date + 1)`),
    enumFilter("outcome", "Outcome", READING_OUTCOMES, (v) => sql`a.outcome = ${v}`),
    uuidFilter("routeId", "Route", (v) => sql`rt.route_id = ${v}::uuid`),
  ],
  scope: scopeOn("a.account_id"),
});

/**
 * One row per service point with the two streaks the policies watch (M-09): visits since the
 * last actual reading without one, and trailing routine readings with no consumption (a
 * confirmed rollover is not considered here). Both are computed from the rows when asked.
 */
const streaksFrom = sql`(
  select sp.service_point_id, sp.account_id, rt.route_id,
         (select count(*)::int from metering.read_attempt a
           where a.service_point_id = sp.service_point_id and a.outcome <> 'read_ok'
             and a.attempted_at > coalesce(
               greatest(
                 (select max(x.attempted_at) from metering.read_attempt x where x.service_point_id = sp.service_point_id and x.outcome = 'read_ok'),
                 (select max(r.read_at) from metering.reading r
                    join lateral (select s.status from metering.reading_status s where s.organization_id = r.organization_id and s.reading_id = r.id order by s.seq desc limit 1) st on true
                   where r.service_point_id = sp.service_point_id and r.source <> 'estimate' and r.purpose = 'routine' and st.status = 'valid')),
               '-infinity'::timestamptz)) as misses,
         coalesce((select max(z.streak) from (
            select y.meter_id, count(*) filter (where y.units = 0 and y.purpose = 'routine' and y.read_at > coalesce(y.last_moved, '-infinity'::timestamptz))::int as streak
              from (
                select x.meter_id, x.read_at, x.units, x.purpose,
                       max(case when x.units is distinct from 0 then x.read_at end) over (partition by x.meter_id) as last_moved
                  from (
                    select r.meter_id, r.read_at, r.purpose, r.value - lag(r.value) over (partition by r.meter_id order by r.read_at) as units
                      from metering.reading r
                      join lateral (select s.status from metering.reading_status s where s.organization_id = r.organization_id and s.reading_id = r.id order by s.seq desc limit 1) st on true
                     where r.service_point_id = sp.service_point_id and r.source <> 'estimate' and st.status = 'valid'
                  ) x
              ) y group by y.meter_id) z), 0) as zero_streak
    from (
      select service_point_id, (array_agg(account_id order by recorded_at desc))[1] as account_id
        from (select service_point_id, account_id, recorded_at from metering.read_attempt union all select service_point_id, account_id, recorded_at from metering.reading) u
       group by service_point_id
    ) sp
    ${routeOf("sp.service_point_id")}
) s`;

export const readStreaks = defineListReport({
  key: "metering.read_streaks",
  module: "metering",
  label: "Missed-read and zero-consumption streaks",
  permissions: PERMISSIONS,
  from: streaksFrom,
  baseWhere: sql`(s.misses > 0 or s.zero_streak > 0)`,
  columns: [
    { key: "servicePointId", label: "Service point", type: "text", expr: sql`s.service_point_id::text` },
    { key: "accountId", label: "Account", type: "text", expr: sql`s.account_id::text` },
    { key: "routeId", label: "Route", type: "text", expr: sql`s.route_id::text` },
    { key: "misses", label: "Visits without a reading", type: "integer", expr: sql`s.misses` },
    { key: "zeroStreak", label: "Zero-consumption readings in a row", type: "integer", expr: sql`s.zero_streak` },
  ],
  filters: [
    intFilter("minMisses", "At least this many missed visits", (v) => sql`s.misses >= ${v}`),
    intFilter("minZeroStreak", "At least this many zero readings", (v) => sql`s.zero_streak >= ${v}`),
    uuidFilter("routeId", "Route", (v) => sql`s.route_id = ${v}::uuid`),
  ],
  orderBy: sql`s.misses desc, s.zero_streak desc, s.service_point_id`,
  scope: scopeOn("s.account_id"),
});

export const meteringReports = [readingsByOutcome, readStreaks];
