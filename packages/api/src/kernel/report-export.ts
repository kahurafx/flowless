import ExcelJS from "exceljs";
import type { ReportColumn } from "./report-guard";
import { decimalOf, type ReportRow, type ReportValue } from "./report-run";

/*
 * Report files (X-03). CSV is UTF-8 with a byte-order mark so Excel opens it correctly; text
 * cells that a spreadsheet would read as a formula are prefixed with an apostrophe-free guard
 * (a leading tab), so a customer name cannot run code on the finance clerk's machine. Excel
 * files hold real numbers: money as major units with the currency's decimals computed from the
 * bigint (never a float for the string form), counts as numbers, dates as text.
 */

export type ExportFormat = "csv" | "xlsx";
export const EXPORT_TYPES: Record<ExportFormat, string> = {
  csv: "text/csv; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

const BOM = String.fromCharCode(0xfeff);
const FORMULA = /^[=+\-@\t\r]/;

/** A cell's text: money in major units, timestamps ISO, formulas defused. */
export function cellText(column: ReportColumn, value: ReportValue, currency: string): string {
  if (value === null) return "";
  if (column.type === "money" && typeof value === "bigint") return decimalOf(value, currency);
  if (value instanceof Date) return value.toISOString();
  const text = String(value);
  return column.type === "text" && FORMULA.test(text) ? `\t${text}` : text;
}

const csvField = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s);

export function headerOf(column: ReportColumn, currency: string): string {
  return column.type === "money" ? `${column.label} (${currency})` : column.label;
}

export function toCsv(columns: readonly ReportColumn[], rows: readonly ReportRow[], currency: string): string {
  const lines = [columns.map((c) => csvField(headerOf(c, currency))).join(",")];
  for (const row of rows) lines.push(columns.map((c) => csvField(cellText(c, row[c.key] ?? null, currency))).join(","));
  return `${BOM}${lines.join("\r\n")}\r\n`;
}

export async function toXlsx(title: string, columns: readonly ReportColumn[], rows: readonly ReportRow[], currency: string): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet(title.replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Report");
  sheet.columns = columns.map((c) => ({ header: headerOf(c, currency), key: c.key, width: Math.max(12, Math.min(40, c.label.length + 4)) }));
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  for (const row of rows) {
    sheet.addRow(
      Object.fromEntries(
        columns.map((c) => {
          const v = row[c.key] ?? null;
          // Counts are numbers; money is a number only when it fits a double exactly, else exact text.
          if (c.type === "integer" && typeof v === "number") return [c.key, v];
          if (c.type === "money" && typeof v === "bigint") {
            return [c.key, Math.abs(Number(v)) <= Number.MAX_SAFE_INTEGER ? Number(decimalOf(v, currency)) : decimalOf(v, currency)];
          }
          return [c.key, cellText(c, v, currency)];
        }),
      ),
    );
  }
  columns.forEach((c, i) => {
    if (c.type === "money") sheet.getColumn(i + 1).numFmt = "#,##0.00";
  });
  return Buffer.from(await book.xlsx.writeBuffer());
}
