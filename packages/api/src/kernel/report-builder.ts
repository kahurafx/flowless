import type { ModuleKey, Permission } from "@flowless/shared-types";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { defineReport, type ReportColumnType, type ReportDef, type ReportFilter, type ReportMeta } from "./report-guard";

/*
 * Metadata-driven report definitions (X-01). A report is data: the tables it reads (`from`),
 * its dimensions and measures as SQL expressions, and its filters; the builder turns that into a
 * parameter schema (which dimensions to group by, which measures, the filters) and one SELECT.
 * Everything the caller can choose is a key from the lists below, never SQL, and filter values
 * are bound parameters. The scope the member is limited to arrives as injected parameters
 * (`scope.shape`) that `meta.scope` sets from the session, and `scope.where` turns into a predicate.
 * Reports are planned by the X-04 guard in CI and run by the isolation canary.
 */

export const DEFAULT_ROW_CAP = 1000;
export const DEFAULT_EXPORT_ROW_CAP = 50_000;

interface Column {
  key: string;
  label: string;
  type: ReportColumnType;
  /** The SQL expression. Money must be an integer expression; the builder casts it to text for exact transport. */
  expr: SQL;
}

export interface FilterDef<V = unknown> extends Omit<ReportFilter, "key"> {
  key: string;
  schema: z.ZodType<V>;
  /** The predicate for a value that was given. */
  apply(value: V): SQL;
}

interface ScopeDef {
  /** Parameters set by the engine from the caller (zod shape, all with defaults). */
  shape: z.ZodRawShape;
  resolve: NonNullable<ReportMeta["scope"]>;
  /** The predicate that confines rows to the parameters above; undefined means no restriction. */
  where(params: Record<string, unknown>): SQL | undefined;
}

interface Common {
  key: string;
  module: ModuleKey | "kernel";
  label: string;
  permissions: readonly Permission[];
  /** FROM clause body (tables, joins, laterals), with RLS-protected tables only; a function when the parameters shape it (an as-of date). */
  from: SQL | ((params: Record<string, unknown>) => SQL);
  /** Always-on predicate (for example "only receivable entries"). */
  baseWhere?: SQL;
  filters?: readonly FilterDef[];
  scope?: ScopeDef;
  rowCap?: number;
  exportRowCap?: number;
}

const castOut = (c: Column): SQL => {
  const alias = sql.raw(`"${c.key}"`);
  return c.type === "money" ? sql`(${c.expr})::text as ${alias}` : sql`${c.expr} as ${alias}`;
};

function paramsOf(common: Common, extra: z.ZodRawShape) {
  const filters: Record<string, z.ZodType> = {};
  for (const f of common.filters ?? []) filters[f.key] = f.schema.optional();
  return z.object({ ...extra, ...filters, ...(common.scope?.shape ?? {}) });
}

function metaOf(common: Common, columns: ReportMeta["columns"], select?: ReportMeta["select"]): ReportMeta {
  return {
    ...(select ? { select } : {}),
    permissions: common.permissions,
    columns,
    filters: (common.filters ?? []).map(({ key, label, type, options }) => ({ key, label, type, ...(options ? { options } : {}) })),
    rowCap: common.rowCap ?? DEFAULT_ROW_CAP,
    exportRowCap: common.exportRowCap ?? DEFAULT_EXPORT_ROW_CAP,
    ...(common.scope ? { scope: common.scope.resolve } : {}),
  };
}

const fromOf = (common: Common, params: Record<string, unknown>) => (typeof common.from === "function" ? common.from(params) : common.from);

function whereOf(common: Common, params: Record<string, unknown>): SQL {
  const parts: SQL[] = [];
  if (common.baseWhere) parts.push(common.baseWhere);
  for (const f of common.filters ?? []) {
    const value = params[f.key];
    if (value !== undefined && value !== null) parts.push(f.apply(value));
  }
  const scoped = common.scope?.where(params);
  if (scoped) parts.push(scoped);
  return parts.length ? sql`where ${sql.join(parts.map((p) => sql`(${p})`), sql` and `)}` : sql``;
}

/**
 * A grouped report: pick dimensions to group by and measures to compute. `defaultGroupBy`
 * applies when the caller names none, so a run with no parameters returns a useful table.
 */
export function defineAggregateReport(def: Common & { dimensions: readonly Column[]; measures: readonly Column[]; defaultGroupBy: readonly string[] }): ReportDef {
  const dimKeys = def.dimensions.map((d) => d.key) as [string, ...string[]];
  const measureKeys = def.measures.map((m) => m.key) as [string, ...string[]];
  const params = paramsOf(def, {
    groupBy: z.array(z.enum(dimKeys)).max(dimKeys.length).default([...def.defaultGroupBy]),
    measures: z.array(z.enum(measureKeys)).min(1).default([...measureKeys]),
  });
  const columns: ReportMeta["columns"] = [
    ...def.dimensions.map((c) => ({ key: c.key, label: c.label, type: c.type, role: "dimension" as const })),
    ...def.measures.map((c) => ({ key: c.key, label: c.label, type: c.type, role: "measure" as const })),
  ];
  return defineReport({
    key: def.key,
    module: def.module,
    label: def.label,
    params: params as z.ZodType<Record<string, unknown>>,
    meta: metaOf(def, columns, (p) => {
      const groupBy = p.groupBy as string[];
      return [...def.dimensions.filter((d) => groupBy.includes(d.key)), ...def.measures.filter((m) => (p.measures as string[]).includes(m.key))].map((c) => c.key);
    }),
    query: (p) => {
      const groupBy = [...new Set(p.groupBy as string[])];
      const dims = def.dimensions.filter((d) => groupBy.includes(d.key));
      const measures = def.measures.filter((m) => (p.measures as string[]).includes(m.key));
      const select = [...dims, ...measures].map(castOut);
      const ordinals = dims.map((_, i) => sql.raw(String(i + 1)));
      return sql`select ${sql.join(select, sql`, `)} from ${fromOf(def, p)} ${whereOf(def, p)}
        ${dims.length ? sql`group by ${sql.join(ordinals, sql`, `)} order by ${sql.join(ordinals, sql`, `)}` : sql``}`;
    },
  });
}

/** An ungrouped report: one row per thing, with the columns chosen by the definition. */
export function defineListReport(def: Common & { columns: readonly Column[]; orderBy: SQL }): ReportDef {
  const params = paramsOf(def, {});
  return defineReport({
    key: def.key,
    module: def.module,
    label: def.label,
    params: params as z.ZodType<Record<string, unknown>>,
    meta: metaOf(
      def,
      def.columns.map((c) => ({ key: c.key, label: c.label, type: c.type, role: "dimension" as const })),
    ),
    query: (p) => sql`select ${sql.join(def.columns.map(castOut), sql`, `)} from ${fromOf(def, p)} ${whereOf(def, p)} order by ${def.orderBy}`,
  });
}

/* ---------- filter helpers ---------- */

export const dateFilter = (key: string, label: string, apply: (v: string) => SQL): FilterDef<string> => ({ key, label, type: "date", schema: z.iso.date(), apply });
export const uuidFilter = (key: string, label: string, apply: (v: string) => SQL): FilterDef<string> => ({ key, label, type: "uuid", schema: z.uuid(), apply });
export const textFilter = (key: string, label: string, apply: (v: string) => SQL): FilterDef<string> => ({ key, label, type: "text", schema: z.string().trim().min(1).max(100), apply });
export const intFilter = (key: string, label: string, apply: (v: number) => SQL): FilterDef<number> => ({ key, label, type: "integer", schema: z.number().int().min(0).max(1_000_000), apply });
export function enumFilter<const V extends readonly [string, ...string[]]>(key: string, label: string, options: V, apply: (v: V[number]) => SQL): FilterDef<V[number]> {
  return { key, label, type: "enum", options, schema: z.enum(options), apply };
}

/** `column in (the ids)` as ONE bound parameter (a JSON array), however many ids there are. */
export const inIds = (column: SQL, ids: readonly string[]): SQL => sql`${column} in (select value::uuid from jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))`;

/** The scope definition most billing and metering reports use: the account ids the member may see (null: all). */
export const accountScope = (column: SQL, resolveIds: (ctx: Parameters<NonNullable<ReportMeta["scope"]>>[0]) => Promise<string[] | undefined>): ScopeDef => ({
  shape: { visibleAccountIds: z.array(z.uuid()).nullable().default(null) },
  resolve: async (ctx) => ({ visibleAccountIds: (await resolveIds(ctx)) ?? null }),
  where: (p) => (p.visibleAccountIds ? inIds(column, p.visibleAccountIds as string[]) : undefined),
});
