import type { Transaction } from "@flowless/db";
import { dataQualityRule, type DataQualityRuleKey } from "@flowless/shared-types";
import { sql } from "drizzle-orm";
import { areasById, routesById } from "../../kernel/areas";
import { loadEntitlements } from "../../kernel/entitlement-store";
import { categoriesById } from "../tariffs";
import { placementKeyOf, placementProblem, type AreaFact, type PlacementKey, type RouteFact } from "./data-quality-placement";
import { NO_FACTS, type Facts } from "./data-quality-queries";
import { dataQualitySourceIds } from "./sources";

/*
 * What the data-quality SQL cannot know by itself (C-12), gathered once per request for the
 * rules that are switched on, never per account:
 *  - `active_metered_no_meter`: the registered source's account ids (Metering, later); with no
 *    usable source the rule is `unavailable` and skipped;
 *  - `zone_equals_route`: the distinct (scheme, zone, DMA, route) placements of live service
 *    points, judged with the kernel's published reads (`routesById`, `areasById`), so the
 *    cost is the number of distinct placements, not of accounts;
 *  - `account_category_missing`: the distinct category ids on accounts, looked up through
 *    Tariffs' published `categoriesById` only when Tariffs is licensed (otherwise only a null
 *    category is a finding).
 */

export interface GatheredFacts {
  facts: Facts;
  /** Rules that could not be evaluated because their source is missing or unlicensed. */
  unavailable: Set<DataQualityRuleKey>;
  /** Why each flagged placement looks wrong, by `placementKeyOf`. */
  problems: Map<string, string>;
  /** Did the category check include Tariffs' view (unknown and deactivated), or only null? */
  categoriesChecked: boolean;
}

/** Areas by id with every area above them, through the published read. */
async function areaClosure(tx: Transaction, ids: readonly string[]): Promise<Map<string, AreaFact>> {
  const known = new Map<string, AreaFact>();
  let wanted = [...new Set(ids)];
  for (let depth = 0; wanted.length && depth < 8; depth++) {
    const found = await areasById(tx, wanted);
    const next = new Set<string>();
    for (const a of found.values()) {
      known.set(a.id, { id: a.id, name: a.name, parentId: a.parentId });
      if (a.parentId && !known.has(a.parentId)) next.add(a.parentId);
    }
    wanted = [...next].filter((id) => !known.has(id));
  }
  return known;
}

async function misplacedPlacements(tx: Transaction): Promise<{ misplaced: PlacementKey[]; problems: Map<string, string> }> {
  const rows = await tx.execute<{ s: string | null; z: string | null; d: string | null; r: string | null }>(sql`
    select distinct scheme_id as s, zone_id as z, dma_id as d, route_id as r
      from accounts.service_point where route_id is not null and connection_status <> 'DECOMMISSIONED'`);
  if (rows.length === 0) return { misplaced: [], problems: new Map() };
  const routes = new Map<string, RouteFact>();
  for (const r of (await routesById(tx, rows.map((k) => k.r!))).values()) routes.set(r.id, { id: r.id, name: r.name, areaId: r.areaId });
  const areaIds = rows.flatMap((k) => [k.s, k.z, k.d]).concat([...routes.values()].map((r) => r.areaId)).filter((id): id is string => !!id);
  const areas = await areaClosure(tx, areaIds);
  const misplaced: PlacementKey[] = [];
  const problems = new Map<string, string>();
  for (const key of rows) {
    const problem = placementProblem(key, areas, routes);
    if (!problem) continue;
    misplaced.push({ s: key.s, z: key.z, d: key.d, r: key.r });
    problems.set(placementKeyOf(key), problem);
  }
  return { misplaced, problems };
}

async function badCategories(tx: Transaction, organizationId: string): Promise<{ ids: string[]; checked: boolean }> {
  if (!(await loadEntitlements(tx)).includes("tariffs")) return { ids: [], checked: false };
  const used = await tx.execute<{ id: string }>(sql`select distinct category_id as id from accounts.account where category_id is not null`);
  if (used.length === 0) return { ids: [], checked: true };
  const known = await categoriesById(tx, organizationId, used.map((r) => r.id));
  return { ids: used.map((r) => r.id).filter((id) => !known.get(id)?.active), checked: true };
}

/** Facts for the rules in `rules` only. */
export async function gatherFacts(tx: Transaction, organizationId: string, rules: readonly DataQualityRuleKey[]): Promise<GatheredFacts> {
  const facts: Facts = { sourceIds: {}, misplaced: [], badCategoryIds: [] };
  const unavailable = new Set<DataQualityRuleKey>();
  let problems = new Map<string, string>();
  let categoriesChecked = false;
  for (const rule of rules) {
    if (dataQualityRule(rule).source) {
      const ids = await dataQualitySourceIds(tx, organizationId, rule);
      if (ids === null) unavailable.add(rule);
      else facts.sourceIds[rule] = ids;
    } else if (rule === "zone_equals_route") {
      const found = await misplacedPlacements(tx);
      facts.misplaced = found.misplaced;
      problems = found.problems;
    } else if (rule === "account_category_missing") {
      const found = await badCategories(tx, organizationId);
      facts.badCategoryIds = found.ids;
      categoriesChecked = found.checked;
    }
  }
  return { facts, unavailable, problems, categoriesChecked };
}

export { NO_FACTS };
