import type { Transaction } from "@flowless/db";
import { account, customer, customerContact } from "@flowless/db/schema/accounts";
import { cleanPercent, type DataQualityRuleKey, type DataQualitySeverity, type EffectiveDataQualityRule } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import { and, asc, inArray, sql } from "drizzle-orm";
import { areasById, routesById } from "../../kernel/areas";
import { readSetting } from "../../kernel/config-store";
import { accountVisible, customerVisible, type Viewer } from "./access";
import { effectiveRules } from "./data-quality-config";
import { gatherFacts } from "./data-quality-facts";
import { placementKeyOf } from "./data-quality-placement";
import { findingsReport, scopeOf, summaryReport } from "./data-quality-queries";
import { hasUsableDataQualitySource } from "./sources";
import { dataQualitySetting } from "./settings";

/*
 * The data-quality use cases (C-12): the catalogue with this organization's settings, the
 * summary, the findings of one rule and the duplicate-customer groups. Everything is read in
 * the caller's tenant and, for a limited member, inside their scope (the same visibility the
 * account lists apply). The sweep that raises exceptions is `data-quality-sweep.ts`.
 */

/** `enabled` is the setting; `no_source` means another module has to speak for the rule and none does yet. */
export type RuleState = "enabled" | "disabled" | "no_source";

export async function loadRules(tx: Transaction): Promise<EffectiveDataQualityRule[]> {
  return effectiveRules((await readSetting(tx, dataQualitySetting)).value);
}

export async function ruleList(tx: Transaction) {
  const rules = await loadRules(tx);
  return Promise.all(
    rules.map(async (rule) => {
      const hasSource = rule.source ? await hasUsableDataQualitySource(tx, rule.key) : true;
      const state: RuleState = !rule.enabled ? "disabled" : hasSource ? "enabled" : "no_source";
      return { ...rule, hasSource, state };
    }),
  );
}

export interface RuleCount {
  key: DataQualityRuleKey;
  label: string;
  severity: DataQualitySeverity;
  state: RuleState;
  /** Accounts the rule flags; null while the rule is off or has no source. */
  count: number | null;
}

/** Counts per rule, the accounts examined and how many are clean. One pass over the accounts. */
export async function summary(tx: Transaction, organizationId: string, viewer: Viewer) {
  const rules = await ruleList(tx);
  const running = rules.filter((r) => r.state === "enabled");
  const gathered = await gatherFacts(tx, organizationId, running.map((r) => r.key));
  const active = running.filter((r) => !gathered.unavailable.has(r.key));
  const [row] = await tx.execute<{ examined: number; flagged: number; counts: Record<string, number> }>(
    summaryReport.query(summaryReport.params.parse({ rules: active.map((r) => r.key), facts: gathered.facts, scope: scopeOf(viewer) })),
  );
  const examined = row?.examined ?? 0;
  const flagged = row?.flagged ?? 0;
  const perRule: RuleCount[] = rules.map((r) => ({
    key: r.key,
    label: r.label,
    severity: r.severity,
    state: r.state,
    count: r.state === "enabled" ? (row?.counts[r.key] ?? 0) : null,
  }));
  return {
    examined,
    flagged,
    clean: examined - flagged,
    cleanPercent: cleanPercent(examined, flagged),
    rules: perRule,
    /** False when Tariffs is unlicensed: the category rule then only looks for a missing category. */
    categoriesChecked: gathered.categoriesChecked,
  };
}

export interface Finding {
  accountId: string;
  number: string;
  commercialStatus: string;
  customerId: string;
  customerName: string;
  areaId: string | null;
  areaLabel: string | null;
  routeId: string | null;
  routeLabel: string | null;
  why: string;
}

type FindingRow = {
  id: string;
  number: string;
  commercialStatus: string;
  createdByUserId: string;
  customerId: string;
  customerName: string;
  schemeId: string | null;
  zoneId: string | null;
  dmaId: string | null;
  routeId: string | null;
};

/** A page of the accounts one rule flags. The rule must be enabled and, if another module decides it, have a source. */
export async function findings(tx: Transaction, organizationId: string, viewer: Viewer, input: { rule: DataQualityRuleKey; after?: string | undefined; limit: number }) {
  const rule = (await ruleList(tx)).find((r) => r.key === input.rule)!;
  if (rule.state === "disabled") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `The rule "${rule.label}" is switched off` });
  if (rule.state === "no_source") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `The rule "${rule.label}" has no data source yet` });
  const gathered = await gatherFacts(tx, organizationId, [rule.key]);
  const rows = await tx.execute<FindingRow>(
    findingsReport.query(findingsReport.params.parse({ rule: rule.key, after: input.after ?? null, limit: input.limit, facts: gathered.facts, scope: scopeOf(viewer) })),
  );
  const areas = await areasById(tx, rows.flatMap((r) => [r.dmaId, r.zoneId, r.schemeId]).filter((id): id is string => !!id));
  const routes = await routesById(tx, rows.flatMap((r) => (r.routeId ? [r.routeId] : [])));
  const items: Finding[] = rows.map((r) => {
    const areaId = r.dmaId ?? r.zoneId ?? r.schemeId;
    const problem = rule.key === "zone_equals_route" ? gathered.problems.get(placementKeyOf({ s: r.schemeId, z: r.zoneId, d: r.dmaId, r: r.routeId })) : undefined;
    return {
      accountId: r.id,
      number: r.number,
      commercialStatus: r.commercialStatus,
      customerId: r.customerId,
      customerName: r.customerName,
      areaId,
      areaLabel: areaId ? (areas.get(areaId)?.name ?? null) : null,
      routeId: r.routeId,
      routeLabel: r.routeId ? (routes.get(r.routeId)?.name ?? null) : null,
      why: problem ?? rule.finding,
    };
  });
  return {
    rule: { key: rule.key, label: rule.label, severity: rule.severity },
    items,
    nextCursor: items.length === input.limit ? items[items.length - 1]!.number : null,
  };
}

export interface DuplicateGroup {
  matchedOn: "national_id" | "registration_number" | "phone";
  key: string;
  customers: { id: string; name: string; type: string; accounts: { id: string; number: string; commercialStatus: string }[] }[];
}

/**
 * Customers the viewer can see who share a normalised phone, national id or registration
 * number, grouped by what they share (a customer can be in several groups). Keyset-paged by
 * `(matchedOn, key)`; at most `limit` groups.
 */
export async function customerDuplicates(tx: Transaction, viewer: Viewer, input: { after?: { matchedOn: string; key: string } | undefined; limit: number }) {
  const visible = customerVisible(viewer) ?? sql`true`;
  const groups = await tx.execute<{ kind: DuplicateGroup["matchedOn"]; key: string; ids: string[] }>(sql`
    select kind, key, array_agg(distinct id) as ids
      from (
        select 'national_id' as kind, ${customer.nationalId} as key, ${customer.id} as id from ${customer} where ${customer.nationalId} is not null and ${visible}
        union all
        select 'registration_number', ${customer.registrationNumber}, ${customer.id} from ${customer} where ${customer.registrationNumber} is not null and ${visible}
        union all
        select 'phone', ${customerContact.normalized}, ${customer.id}
          from ${customerContact} join ${customer} on ${customer.organizationId} = ${customerContact.organizationId} and ${customer.id} = ${customerContact.customerId}
         where ${customerContact.channel} = 'phone' and ${customerContact.normalized} is not null and ${visible}
      ) k
     group by kind, key
    having count(distinct id) > 1 ${input.after ? sql`and (kind, key) > (${input.after.matchedOn}, ${input.after.key})` : sql``}
     order by kind, key
     limit ${input.limit}`);
  const ids = [...new Set(groups.flatMap((g) => g.ids))];
  const customers = ids.length
    ? await tx.select({ id: customer.id, name: customer.name, type: customer.type }).from(customer).where(inArray(customer.id, ids)).orderBy(asc(customer.name), asc(customer.id))
    : [];
  const accounts = ids.length
    ? await tx
        .select({ id: account.id, number: account.number, customerId: account.customerId, commercialStatus: account.commercialStatus })
        .from(account)
        .where(and(inArray(account.customerId, ids), accountVisible(viewer)))
        .orderBy(asc(account.number))
    : [];
  const byCustomer = new Map(customers.map((c) => [c.id, { ...c, accounts: accounts.filter((a) => a.customerId === c.id).map(({ id, number, commercialStatus }) => ({ id, number, commercialStatus })) }]));
  const items: DuplicateGroup[] = groups.map((g) => ({
    matchedOn: g.kind,
    key: g.key,
    customers: g.ids.flatMap((id) => (byCustomer.has(id) ? [byCustomer.get(id)!] : [])).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
  }));
  const last = groups[groups.length - 1];
  return { items, nextCursor: groups.length === input.limit && last ? { matchedOn: last.kind, key: last.key } : null };
}
