import { organizationSettings, type Transaction } from "@flowless/db";
import { currencyExponent, money, toDecimalString, type ModuleKey, type Permission, type Scope } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import type { ReportColumn, ReportDef, ReportMeta } from "./report-guard";
import { reports } from "./report-registry";

/*
 * Running a registered report for a caller (X-01, X-03): licence, permission, parameters,
 * scope, row cap, typed values. Used by `reports.run` and `reports.export`; the report's own
 * SQL runs inside the caller's `withTenant`, so RLS confines it to the tenant.
 */

export type ReportValue = string | number | bigint | Date | null;
export type ReportRow = Record<string, ReportValue>;

export interface Caller {
  tx: Transaction;
  userId: string;
  scope: Scope;
  permissions: ReadonlySet<string>;
  licensed: readonly ModuleKey[];
}

export const published = (): ReportDef[] => reports.filter((r) => r.meta);

/** The report, or NOT_FOUND when it is unknown, internal, or its module is not licensed (NF-03). */
export function reportFor(key: string, caller: Pick<Caller, "licensed">): ReportDef & { meta: ReportMeta } {
  const def = reports.find((r) => r.key === key);
  if (!def?.meta || (def.module !== "kernel" && !caller.licensed.includes(def.module))) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Report not found" });
  }
  return def as ReportDef & { meta: ReportMeta };
}

export function missingPermissions(meta: ReportMeta, permissions: ReadonlySet<string>, extra: Permission): Permission[] {
  return [extra, ...meta.permissions].filter((p) => !permissions.has(p));
}

/** What a caller may run, described for a picker. */
export function describeReport(def: ReportDef & { meta: ReportMeta }) {
  return {
    key: def.key,
    module: def.module,
    label: def.label,
    columns: def.meta.columns,
    filters: def.meta.filters,
    rowCap: def.meta.rowCap,
    exportRowCap: def.meta.exportRowCap,
    permissions: def.meta.permissions,
  };
}

function convert(column: ReportColumn, value: unknown): ReportValue {
  if (value === null || value === undefined) return null;
  switch (column.type) {
    case "integer":
      return Number(value);
    case "money":
      return BigInt(value as string | number | bigint);
    case "timestamp":
      return value instanceof Date ? value : new Date(value as string);
    case "date":
      return value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
    default:
      return String(value);
  }
}

export async function runReport(caller: Caller, def: ReportDef & { meta: ReportMeta }, input: unknown, limit: number) {
  const parsed = def.params.safeParse(input ?? {});
  if (!parsed.success) {
    throw new TRPCError({ code: "BAD_REQUEST", message: parsed.error.issues.map((i) => `${i.path.join(".") || "parameters"}: ${i.message}`).join("; ") });
  }
  // The scope is the caller's, whatever they sent.
  const injected = def.meta.scope ? await def.meta.scope({ tx: caller.tx, userId: caller.userId, scope: caller.scope }) : {};
  const params = { ...(parsed.data as Record<string, unknown>), ...injected };
  const rows = await caller.tx.execute<Record<string, unknown>>(sql`select * from (${def.query(params)}) as report_rows limit ${limit + 1}`);
  const truncated = rows.length > limit;
  // Only the columns this run selects (a grouped report returns the chosen dimensions and measures).
  const keys = def.meta.select?.(params);
  const columns = keys ? def.meta.columns.filter((c) => keys.includes(c.key)) : def.meta.columns;
  const out: ReportRow[] = rows.slice(0, limit).map((r) => Object.fromEntries(columns.map((c) => [c.key, convert(c, r[c.key])])));
  return { key: def.key, label: def.label, columns, rows: out, truncated, rowCap: limit, params: parsed.data as Record<string, unknown> };
}

/** The organization's currency, for money columns in files. */
export async function organizationCurrencyOf(tx: Transaction): Promise<string> {
  const [row] = await tx.select({ currency: organizationSettings.currency }).from(organizationSettings);
  return row?.currency ?? "KES";
}

/** A money value as a decimal string in major units (no float). */
export const decimalOf = (amountMinor: bigint, currency: string) => toDecimalString(money(amountMinor, currency));
export { currencyExponent };
