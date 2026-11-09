import { DATA_QUALITY_RULES, isDataQualityRuleKey, type DataQualityRuleKey } from "@flowless/shared-types";
import { cleanHeadline, defaultRule, ruleSourceLabel, ruleTiles } from "@/lib/data-quality-view";
import { requireAccounts } from "./accounts";
import { getApi } from "./session";

export const FINDINGS_PAGE = 50;
export const DUPLICATES_PAGE = 25;

/**
 * The data-quality dashboard (C-12): the summary and rule states, the findings of one rule
 * (the one asked for, else the most serious with findings) and the first duplicate-customer
 * groups. Everything comes from the `accounts.dataQuality` procedures, which apply the
 * member's scope; a rule that is off or has no source is never asked for findings.
 */
export async function getDataQualityPage(ruleParam: string | undefined) {
  const session = await requireAccounts();
  const { api } = await getApi();
  const [summary, rules, duplicates] = await Promise.all([
    api.accounts.dataQuality.summary(),
    api.accounts.dataQuality.rules(),
    api.accounts.dataQuality.customerDuplicates({ limit: DUPLICATES_PAGE }),
  ]);

  const tiles = ruleTiles(summary.rules, (key) => ruleSourceLabel(DATA_QUALITY_RULES.find((r) => r.key === key)?.source ?? null));
  const asked: DataQualityRuleKey | null = ruleParam && isDataQualityRuleKey(ruleParam) ? ruleParam : null;
  const chosen = asked && tiles.find((t) => t.key === asked)?.browsable ? asked : defaultRule(tiles);
  const findings = chosen ? await api.accounts.dataQuality.findings({ rule: chosen, limit: FINDINGS_PAGE }) : null;

  const can = (permission: Parameters<typeof session.access.permissions.includes>[0]) => session.access.permissions.includes(permission);
  return {
    headline: cleanHeadline(summary),
    categoriesChecked: summary.categoriesChecked,
    tiles: tiles.map((tile) => {
      const rule = rules.find((r) => r.key === tile.key);
      return { ...tile, description: rule?.description ?? "", raiseExceptions: Boolean(rule?.raiseExceptions && rule.enabled) };
    }),
    chosen,
    findings,
    duplicates,
    canConfigure: can("settings:manage"),
    canSeeExceptions: can("exceptions:read"),
    locale: session.organization.settings.locale,
  };
}

export type DataQualityPage = Awaited<ReturnType<typeof getDataQualityPage>>;
export type FindingRow = NonNullable<DataQualityPage["findings"]>["items"][number];
export type DuplicateGroup = DataQualityPage["duplicates"]["items"][number];
