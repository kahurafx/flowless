import { withTenant, type Database, type Transaction } from "@flowless/db";
import { account } from "@flowless/db/schema/accounts";
import { isDataQualityRuleKey, type DataQualityRuleKey } from "@flowless/shared-types";
import { sql } from "drizzle-orm";
import { openDedupeKeys, raiseException, resolveByDedupeKey } from "../../kernel/exception-store";
import { loadRules } from "./data-quality";
import { gatherFacts } from "./data-quality-facts";
import { placementKeyOf } from "./data-quality-placement";
import { findingsReport, idsOf, ruleExpr } from "./data-quality-queries";

/*
 * The data-quality exception sweep (C-12, X-02), run by `apps/worker` about once an hour.
 * For every rule an organization has switched on AND told to raise exceptions
 * (`accounts.data_quality`, `raiseExceptions`), one DATA_QUALITY exception per account and
 * rule, dedupe key `dq:<rule>:<accountId>`, owned by whoever opened the account like the
 * stale-account exceptions (F3a) and placed by the account's first (for the zone and route
 * rule, first offending) service point, so scoped members see it.
 *  - Only findings not already in the queue are raised, so an open exception is not bumped
 *    every pass (raising again would count another occurrence).
 *  - At most `limit` are raised per organization per run, in account-number order, so one run
 *    never floods the queue; the rest follow on later runs.
 *  - An open exception whose finding has cleared (the data was fixed, the account ended), or
 *    whose rule is no longer raising, is resolved by itself. A rule that cannot be evaluated
 *    now (its source is missing or unlicensed) is left alone: nothing is known.
 * Organizations come from the cross-tenant finder `accounts.data_quality_organizations`
 * (licensed for Accounts, and having set the data-quality setting or still holding an open
 * exception), so unlicensed ones are never touched. Returns how many were raised.
 */

const PREFIX = "dq:";
export const dataQualityKey = (rule: DataQualityRuleKey, accountId: string) => `${PREFIX}${rule}:${accountId}`;

function parseKey(key: string): { rule: DataQualityRuleKey; accountId: string } | null {
  const [, rule, accountId] = key.split(":");
  return rule && accountId && isDataQualityRuleKey(rule) ? { rule, accountId } : null;
}

export async function sweepDataQuality(db: Database, { limit = 100, batch = 50 }: { limit?: number; batch?: number } = {}): Promise<number> {
  let raised = 0;
  let after: string | null = null;
  for (;;) {
    const orgs: { organization_id: string }[] = await db.execute(sql`select * from accounts.data_quality_organizations(${after}::uuid, ${batch})`);
    for (const { organization_id: organizationId } of orgs) {
      raised += await withTenant(db, organizationId, (tx) => sweepOrganization(tx, organizationId, Math.min(Math.max(limit, 0), 500)));
    }
    if (orgs.length < batch) return raised;
    after = orgs[orgs.length - 1]!.organization_id;
  }
}

async function sweepOrganization(tx: Transaction, organizationId: string, limit: number): Promise<number> {
  const rules = await loadRules(tx);
  const raising = rules.filter((r) => r.enabled && r.raiseExceptions);
  const gathered = await gatherFacts(tx, organizationId, raising.map((r) => r.key));

  const openByRule = new Map<DataQualityRuleKey, string[]>();
  for (const key of await openDedupeKeys(tx, PREFIX)) {
    const parsed = parseKey(key);
    if (!parsed) continue;
    if (!raising.some((r) => r.key === parsed.rule)) {
      await resolveByDedupeKey(tx, key, "The rule is switched off or no longer raises exceptions");
      continue;
    }
    openByRule.set(parsed.rule, [...(openByRule.get(parsed.rule) ?? []), parsed.accountId]);
  }

  let raised = 0;
  for (const rule of raising) {
    if (gathered.unavailable.has(rule.key)) continue;
    const open = openByRule.get(rule.key) ?? [];

    // Resolve the ones that no longer fail the rule (or whose account has ended).
    if (open.length) {
      const stillFailing = new Set(
        (await tx.execute<{ id: string }>(sql`select ${account.id} as id from ${account} where ${ruleExpr(rule.key, gathered.facts)} and ${account.id} in ${idsOf(open)}`)).map((r) => r.id),
      );
      for (const id of open) {
        if (!stillFailing.has(id)) await resolveByDedupeKey(tx, dataQualityKey(rule.key, id), "The data-quality finding has cleared");
      }
    }

    // Raise the new ones, as many as this run has room for.
    const room = limit - raised;
    if (room <= 0) continue;
    const rows = await tx.execute<{
      id: string;
      number: string;
      createdByUserId: string;
      schemeId: string | null;
      zoneId: string | null;
      dmaId: string | null;
      routeId: string | null;
    }>(findingsReport.query(findingsReport.params.parse({ rule: rule.key, limit: room, exclude: open, facts: gathered.facts, scope: null })));
    for (const r of rows) {
      const why = rule.key === "zone_equals_route" ? gathered.problems.get(placementKeyOf({ s: r.schemeId, z: r.zoneId, d: r.dmaId, r: r.routeId })) : undefined;
      await raiseException(tx, organizationId, {
        type: "DATA_QUALITY",
        source: "accounts",
        title: `${rule.label}: account ${r.number}`,
        detail: `${rule.severity.toUpperCase()}: ${why ?? rule.finding} Fix the record and this resolves itself.`,
        subject: { kind: "account", ref: r.number },
        areaId: r.dmaId ?? r.zoneId ?? r.schemeId,
        routeId: r.routeId,
        ownerUserId: r.createdByUserId,
        dedupeKey: dataQualityKey(rule.key, r.id),
      });
      raised += 1;
    }
  }
  return raised;
}
