import { formatMoney, money } from "@flowless/shared-types";

/*
 * Report viewer helpers (X-01, X-03). Pure. The API describes each report (columns with a role,
 * filters) and validates every parameter; these only build the parameters from a form and show
 * the typed values. Money arrives as bigint minor units and is formatted, never converted to a float.
 */

export interface ReportColumnView {
  key: string;
  label: string;
  type: "text" | "integer" | "money" | "date" | "timestamp" | "percent";
  role: "dimension" | "measure";
}
export interface ReportFilterView {
  key: string;
  label: string;
  type: "text" | "date" | "enum" | "uuid" | "integer";
  options?: readonly string[] | undefined;
}
export interface ReportDescription {
  key: string;
  label: string;
  module: string;
  columns: readonly ReportColumnView[];
  filters: readonly ReportFilterView[];
}

/** A grouped report has measures: the caller picks what to group by and which measures to compute. */
export const isAggregate = (report: Pick<ReportDescription, "columns">) => report.columns.some((c) => c.role === "measure");
export const dimensionsOf = (report: Pick<ReportDescription, "columns">) => report.columns.filter((c) => c.role === "dimension");
export const measuresOf = (report: Pick<ReportDescription, "columns">) => report.columns.filter((c) => c.role === "measure");

export interface ReportForm {
  filters: Record<string, string>;
  groupBy: string[];
  measures: string[];
}

/** The form's initial state: no filters, every dimension off (the report's own default grouping applies until one is chosen) and every measure on. */
export function emptyReportForm(report: Pick<ReportDescription, "columns">): ReportForm {
  return { filters: {}, groupBy: [], measures: measuresOf(report).map((m) => m.key) };
}

export type ReportParams = { ok: true; params: Record<string, unknown> } | { ok: false; problems: string[] };

/** The parameters to send: filled filters (integers as numbers), the chosen grouping and measures. */
export function buildReportParams(report: ReportDescription, form: ReportForm): ReportParams {
  const problems: string[] = [];
  const params: Record<string, unknown> = {};
  for (const f of report.filters) {
    const text = (form.filters[f.key] ?? "").trim();
    if (!text) continue;
    if (f.type === "integer") {
      const n = Number(text);
      if (!Number.isInteger(n)) problems.push(`${f.label}: a whole number`);
      else params[f.key] = n;
    } else if (f.type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(text)) problems.push(`${f.label}: choose a date`);
    else if (f.type === "uuid" && !/^[0-9a-f-]{36}$/i.test(text)) problems.push(`${f.label}: paste the id`);
    else params[f.key] = text;
  }
  if (isAggregate(report)) {
    if (form.groupBy.length > 0) params.groupBy = form.groupBy;
    if (form.measures.length === 0) problems.push("Choose at least one measure");
    else params.measures = form.measures;
  }
  return problems.length ? { ok: false, problems } : { ok: true, params };
}

export function formatCell(value: unknown, column: Pick<ReportColumnView, "type">, currency: string, locale: string, timeZone: string): string {
  if (value === null || value === undefined) return "";
  switch (column.type) {
    case "money":
      return typeof value === "bigint" ? formatMoney(money(value, currency), locale) : String(value);
    case "integer":
      return typeof value === "number" ? new Intl.NumberFormat(locale).format(value) : String(value);
    case "timestamp":
      return value instanceof Date ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone }).format(value) : String(value);
    case "percent":
      return `${String(value)}%`;
    default:
      return String(value);
  }
}

/** Numbers and money are right-aligned. */
export const isNumeric = (column: Pick<ReportColumnView, "type">) => column.type === "money" || column.type === "integer" || column.type === "percent";

/** The bytes of an export: CSV arrives as text, Excel as base64. */
export function exportBytes(file: { encoding: "utf8" | "base64"; content: string }): Uint8Array<ArrayBuffer> {
  if (file.encoding === "utf8") return new TextEncoder().encode(file.content);
  const binary = atob(file.content);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
