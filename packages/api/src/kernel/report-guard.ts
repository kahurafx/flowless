import type { Transaction } from "@flowless/db";
import type { ModuleKey, Permission, Scope } from "@flowless/shared-types";
import { sql, type SQL } from "drizzle-orm";
import type { z } from "zod";

/**
 * A report (X-01): a parameterized query over tenant-scoped tables or read models, owned
 * by a module. It runs inside the caller's `withTenant`, so RLS applies, and it may only be
 * published if `reportPublishProblems` finds nothing (X-04).
 */
export type ReportColumnType = "text" | "integer" | "money" | "date" | "timestamp" | "percent";

/** One output column. Dimensions group or describe a row; measures are aggregates (X-01). */
export interface ReportColumn {
  key: string;
  label: string;
  type: ReportColumnType;
  role: "dimension" | "measure";
}

/** A filter the report accepts as a parameter, described for a form. */
export interface ReportFilter {
  key: string;
  label: string;
  type: "text" | "date" | "enum" | "uuid" | "integer";
  options?: readonly string[];
}

/**
 * What makes a report publishable through the reporting engine (X-01, X-03): who may run it,
 * what it returns, how many rows, and how the member's scope (K-03) reaches its query. A report
 * without `meta` is internal (its module calls it) and is not offered by `reports.*`.
 */
export interface ReportMeta {
  /** Needed on top of `reports:read` (run) or `reports:export` (export). */
  permissions: readonly Permission[];
  columns: readonly ReportColumn[];
  filters: readonly ReportFilter[];
  /** Rows a run returns; one more is read to say "truncated". */
  rowCap: number;
  /** Rows an export may hold. */
  exportRowCap: number;
  /** The column keys a run with these parameters returns (a grouped report returns the dimensions and measures chosen); all when absent. */
  select?: (params: Record<string, unknown>) => readonly string[];
  /**
   * Scope (K-03): the parameters the engine sets from the caller, whatever the caller sent
   * (for example the account ids a limited member may see).
   */
  scope?: (ctx: { tx: Transaction; userId: string; scope: Scope }) => Promise<Record<string, unknown>>;
}

export interface ReportDef<P = unknown> {
  meta?: ReportMeta;
  /** "<module>.<report>", unique. */
  readonly key: string;
  readonly module: ModuleKey | "kernel";
  readonly label: string;
  readonly params: z.ZodType<P>;
  query(params: P): SQL;
}

export function defineReport<P>(def: ReportDef<P>): ReportDef<P> {
  return def;
}

interface PlanNode {
  "Node Type"?: string;
  "Relation Name"?: string;
  "Function Name"?: string;
  Schema?: string;
  Plans?: PlanNode[];
  [field: string]: unknown;
}

function walk(node: PlanNode, visit: (n: PlanNode) => void) {
  visit(node);
  for (const child of node.Plans ?? []) walk(child, visit);
}

/** Every string in a plan node's own fields (outputs, filters, conditions). */
function expressions(node: PlanNode): string[] {
  return Object.entries(node).flatMap(([field, value]) => {
    if (field === "Plans") return [];
    if (typeof value === "string") return [value];
    if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
    return [];
  });
}

/**
 * Why a report query may not be published, or nothing (X-04). Postgres plans the query
 * (EXPLAIN, nothing runs) as the app role in the caller's tenant, and every relation the
 * plan reads must have an `organization_id` column and row-level security; the query may
 * not call functions that bypass RLS (SECURITY DEFINER). Views are expanded by the planner,
 * so a view over an unsafe table is caught too. The report's own claims are not trusted.
 */
export async function reportPublishProblems(tx: Transaction, query: SQL): Promise<string[]> {
  let plan: PlanNode;
  try {
    // A savepoint: a failed EXPLAIN must not abort the caller's transaction.
    const rows = await tx.transaction((sp) => sp.execute<{ "QUERY PLAN": { Plan: PlanNode }[] }>(sql`explain (verbose, format json) ${query}`));
    plan = rows[0]!["QUERY PLAN"][0]!.Plan;
  } catch (error) {
    const cause = (error as { cause?: { message?: string } }).cause?.message ?? (error instanceof Error ? error.message : String(error));
    return [`The query cannot be planned as the app role: ${cause}`];
  }

  const relations = new Map<string, { schema: string; name: string }>();
  const functions = new Set<string>();
  const texts: string[] = [];
  walk(plan, (node) => {
    if (node["Relation Name"]) {
      const schema = node.Schema ?? "public";
      relations.set(`${schema}.${node["Relation Name"]}`, { schema, name: node["Relation Name"] });
    }
    if (node["Function Name"]) functions.add(`${node.Schema ?? "public"}.${node["Function Name"]}`);
    texts.push(...expressions(node));
  });

  const problems: string[] = [];
  for (const { schema, name } of relations.values()) {
    const [info] = await tx.execute<{ rls: boolean; tenant: boolean }>(sql`
      select c.relrowsecurity as rls,
             exists (select 1 from pg_attribute a
                      where a.attrelid = c.oid and a.attname = 'organization_id' and not a.attisdropped) as tenant
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = ${schema} and c.relname = ${name}`);
    if (!info) problems.push(`${schema}.${name} is not a table the report may read`);
    else if (!info.tenant) problems.push(`${schema}.${name} has no tenant column (organization_id)`);
    else if (!info.rls) problems.push(`${schema}.${name} has no row-level security`);
  }

  const definers = await tx.execute<{ schema: string; name: string }>(sql`
    select n.nspname as schema, p.proname as name
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where p.prosecdef and n.nspname not in ('pg_catalog', 'information_schema')`);
  for (const { schema, name } of definers) {
    const called = functions.has(`${schema}.${name}`) || texts.some((t) => new RegExp(`\\b${name}\\(`).test(t));
    if (called) problems.push(`${schema}.${name}() bypasses row-level security`);
  }
  return problems;
}
