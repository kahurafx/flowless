import { account, customer, customerContact, servicePoint } from "@flowless/db/schema/accounts";
import { DATA_QUALITY_RULE_KEYS, dataQualityRule, type DataQualityRuleKey } from "@flowless/shared-types";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { defineReport } from "../../kernel/report-guard";
import { accountVisible, type Viewer } from "./access";

/*
 * The data-quality rules as SQL (C-12, X-01, X-04). Each rule is an indexed predicate over one
 * account row (`accounts.account`, every join and subquery is keyed by organization and
 * customer or account, and RLS applies); the summary is ONE pass over the accounts with a
 * `count(*) filter` per rule, never a query per account. What SQL cannot know is handed in as
 * `facts`, gathered once per request by `data-quality-facts.ts`: the account ids another
 * module's source reported, the service-point placements the kernel hierarchy says are
 * confused, and the category ids that are unknown or deactivated. The two queries are
 * reports (`defineReport`, registered in `kernel/report-registry.ts`), so the X-04 guard plans
 * them and the isolation canary runs them. A report cannot know who is asking, so the member's
 * scope arrives as a parameter and becomes the same `accountVisible` filter the lists use.
 */

const placementKey = z.object({ s: z.uuid().nullable(), z: z.uuid().nullable(), d: z.uuid().nullable(), r: z.uuid().nullable() });

export const factsSchema = z.object({
  /** Account ids a rule's source reported (the meter rule), by rule key. */
  sourceIds: z.record(z.string(), z.array(z.uuid())).default({}),
  /** (scheme, zone, DMA, route) placements `zone_equals_route` flags. */
  misplaced: z.array(placementKey).default([]),
  /** Category ids on accounts that are unknown or deactivated (only with Tariffs licensed). */
  badCategoryIds: z.array(z.uuid()).default([]),
});
export type Facts = z.infer<typeof factsSchema>;
export const NO_FACTS: Facts = { sourceIds: {}, misplaced: [], badCategoryIds: [] };

export const scopeSchema = z
  .object({ userId: z.uuid(), areaIds: z.array(z.uuid()), routeIds: z.array(z.uuid()) })
  .nullable()
  .default(null);
export type ScopeParam = z.infer<typeof scopeSchema>;

/** The viewer the report parameters describe: unrestricted without a scope. */
export function viewerOf(scope: ScopeParam): Viewer {
  return scope
    ? { userId: scope.userId, scope: { kind: "limited", areaIds: new Set(scope.areaIds), routeIds: new Set(scope.routeIds) } }
    : { userId: "00000000-0000-0000-0000-000000000000", scope: { kind: "all" } };
}

export function scopeOf(viewer: Viewer): ScopeParam {
  return viewer.scope.kind === "all" ? null : { userId: viewer.userId, areaIds: [...viewer.scope.areaIds], routeIds: [...viewer.scope.routeIds] };
}

export const idsOf = (ids: readonly string[]) => sql`(select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::uuid)`;
const live = sql`${servicePoint.connectionStatus} <> 'DECOMMISSIONED'`;
const ownService = (extra?: SQL) =>
  sql`exists (select 1 from ${servicePoint} where ${servicePoint.organizationId} = ${account.organizationId} and ${servicePoint.accountId} = ${account.id} and ${live}${extra ? sql` and ${extra}` : sql``})`;

/** A live service point of the account that sits in one of the flagged placements. */
const misplacedPoint = (misplaced: Facts["misplaced"]) =>
  sql`exists (select 1 from jsonb_to_recordset(${JSON.stringify(misplaced)}::jsonb) as m(s uuid, z uuid, d uuid, r uuid)
               where m.r = ${servicePoint.routeId} and m.s is not distinct from ${servicePoint.schemeId}
                 and m.z is not distinct from ${servicePoint.zoneId} and m.d is not distinct from ${servicePoint.dmaId})`;

/** The service-point condition of `zone_equals_route`, also used to pick the offending point to show. */
export const misplacedCondition = (facts: Facts) => (facts.misplaced.length ? misplacedPoint(facts.misplaced) : sql`false`);

const duplicateCustomer = sql`(
  exists (select 1 from accounts.customer c1 join accounts.customer c2
            on c2.organization_id = c1.organization_id and c2.id <> c1.id and c2.national_id = c1.national_id
          where c1.organization_id = ${account.organizationId} and c1.id = ${account.customerId} and c1.national_id is not null)
  or exists (select 1 from accounts.customer c1 join accounts.customer c2
            on c2.organization_id = c1.organization_id and c2.id <> c1.id and c2.registration_number = c1.registration_number
          where c1.organization_id = ${account.organizationId} and c1.id = ${account.customerId} and c1.registration_number is not null)
  or exists (select 1 from accounts.customer_contact k1 join accounts.customer_contact k2
            on k2.organization_id = k1.organization_id and k2.channel = 'phone' and k2.normalized = k1.normalized and k2.customer_id <> k1.customer_id
          where k1.organization_id = ${account.organizationId} and k1.customer_id = ${account.customerId} and k1.channel = 'phone' and k1.normalized is not null)
)`;

/** The rule's own condition on an account row, ignoring which statuses it applies to. */
function condition(rule: DataQualityRuleKey, facts: Facts): SQL {
  switch (rule) {
    case "account_no_phone":
      return sql`not exists (select 1 from ${customerContact} where ${customerContact.organizationId} = ${account.organizationId} and ${customerContact.customerId} = ${account.customerId} and ${customerContact.channel} = 'phone' and not ${customerContact.isPlaceholder} and ${customerContact.normalized} is not null)`;
    case "account_no_service_point":
      return sql`not ${ownService()}`;
    case "account_no_coordinates":
      return sql`not ${ownService(sql`${servicePoint.location} is not null`)}`;
    case "active_metered_no_meter": {
      const ids = facts.sourceIds[rule] ?? [];
      return ids.length ? sql`${account.id} in ${idsOf(ids)}` : sql`false`;
    }
    case "zone_equals_route":
      return ownService(misplacedCondition(facts));
    case "duplicate_customers":
      return duplicateCustomer;
    case "account_category_missing":
      return facts.badCategoryIds.length
        ? sql`(${account.categoryId} is null or ${account.categoryId} in ${idsOf(facts.badCategoryIds)})`
        : sql`${account.categoryId} is null`;
  }
}

/** True for an account the rule flags: in a status it applies to, and the condition holds. */
export function ruleExpr(rule: DataQualityRuleKey, facts: Facts): SQL {
  const statuses = dataQualityRule(rule).appliesTo.map((s) => sql`${s}`);
  return sql`(${account.commercialStatus} in (${sql.join(statuses, sql`, `)}) and ${condition(rule, facts)})`;
}

const examinedAccounts = sql`${account.commercialStatus} <> 'TERMINATED'`;

const RuleKeys = z.enum(DATA_QUALITY_RULE_KEYS);

/**
 * How many accounts each rule flags, how many were examined (every account that is not
 * terminated, within the member's scope) and how many have at least one finding among the
 * rules asked for. One row; `counts` is a json object by rule key.
 */
export const summaryReport = defineReport({
  key: "accounts.data_quality_summary",
  module: "accounts",
  label: "Data quality: findings per rule",
  params: z.object({ rules: z.array(RuleKeys).default([...DATA_QUALITY_RULE_KEYS]), facts: factsSchema.prefault({}), scope: scopeSchema }),
  query: ({ rules, facts, scope }) => {
    const counts = rules.map((rule) => sql`${rule}::text, count(*) filter (where ${ruleExpr(rule, facts)})::int`);
    const any = rules.length ? sql.join(rules.map((rule) => ruleExpr(rule, facts)), sql` or `) : sql`false`;
    return sql`
      select count(*)::int as examined,
             count(*) filter (where ${any})::int as flagged,
             ${counts.length ? sql`jsonb_build_object(${sql.join(counts, sql`, `)})` : sql`'{}'::jsonb`} as counts
        from ${account}
       where ${examinedAccounts} and ${accountVisible(viewerOf(scope)) ?? sql`true`}`;
  },
});

/**
 * The accounts one rule flags, in account-number order, `limit` at a time after the number
 * `after`, with the customer and the account's first live service point (for `zone_equals_route`,
 * its first offending one) so the caller can name the area and route.
 */
export const findingsReport = defineReport({
  key: "accounts.data_quality_findings",
  module: "accounts",
  label: "Data quality: accounts a rule flags",
  params: z.object({
    rule: RuleKeys.default("account_no_phone"),
    after: z.string().max(60).nullable().default(null),
    limit: z.number().int().min(1).max(500).default(50),
    /** Accounts to leave out (the sweep passes the ones already in the exception queue). */
    exclude: z.array(z.uuid()).default([]),
    facts: factsSchema.prefault({}),
    scope: scopeSchema,
  }),
  query: ({ rule, after, limit, exclude, facts, scope }) => sql`
    select ${account.id} as id, ${account.number} as number, ${account.commercialStatus} as "commercialStatus", ${account.createdByUserId} as "createdByUserId",
           ${customer.id} as "customerId", ${customer.name} as "customerName",
           sp.scheme_id as "schemeId", sp.zone_id as "zoneId", sp.dma_id as "dmaId", sp.route_id as "routeId"
      from ${account}
      join ${customer} on ${customer.organizationId} = ${account.organizationId} and ${customer.id} = ${account.customerId}
      left join lateral (
        select p.scheme_id, p.zone_id, p.dma_id, p.route_id
          from ${servicePoint} p
         where p.organization_id = ${account.organizationId} and p.account_id = ${account.id} and p.connection_status <> 'DECOMMISSIONED'
           ${rule === "zone_equals_route" ? sql`and exists (select 1 from jsonb_to_recordset(${JSON.stringify(facts.misplaced)}::jsonb) as m(s uuid, z uuid, d uuid, r uuid)
                where m.r = p.route_id and m.s is not distinct from p.scheme_id and m.z is not distinct from p.zone_id and m.d is not distinct from p.dma_id)` : sql``}
         order by p.created_at, p.id limit 1
      ) sp on true
     where ${ruleExpr(rule, facts)}
       and ${accountVisible(viewerOf(scope)) ?? sql`true`}
       ${exclude.length ? sql`and ${account.id} not in ${idsOf(exclude)}` : sql``}
       ${after ? sql`and ${account.number} > ${after}` : sql``}
     order by ${account.number}
     limit ${limit}`,
});
