import type { Transaction } from "@flowless/db";
import type { ModuleKey } from "@flowless/shared-types";
import { sql, type SQL } from "drizzle-orm";
import type { z } from "zod";

/**
 * A report (X-01): a parameterized query over tenant-scoped tables or read models, owned
 * by a module. It runs inside the caller's `withTenant`, so RLS applies, and it may only be
 * published if `reportPublishProblems` finds nothing (X-04).
 */
export interface ReportDef<P = unknown> {
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
