import { describe, expect, it } from "vitest";
import { buildReportParams, emptyReportForm, exportBytes, formatCell, isAggregate, type ReportDescription } from "./report-view";

const aggregate: ReportDescription = {
  key: "billing.register",
  label: "Billing register",
  module: "billing",
  columns: [
    { key: "month", label: "Month", type: "text", role: "dimension" },
    { key: "type", label: "Type", type: "text", role: "dimension" },
    { key: "documents", label: "Documents", type: "integer", role: "measure" },
    { key: "total", label: "Total", type: "money", role: "measure" },
  ],
  filters: [
    { key: "from", label: "From", type: "date" },
    { key: "limit", label: "Limit", type: "integer" },
    { key: "status", label: "Status", type: "enum", options: ["live", "reversed"] },
  ],
};
const list: ReportDescription = { ...aggregate, columns: aggregate.columns.map((c) => ({ ...c, role: "dimension" as const })) };

describe("report parameters", () => {
  it("tells a grouped report from a list", () => {
    expect(isAggregate(aggregate)).toBe(true);
    expect(isAggregate(list)).toBe(false);
  });
  it("sends only filled filters, integers as numbers, and the chosen grouping", () => {
    const form = { ...emptyReportForm(aggregate), filters: { from: "2026-01-01", limit: "25", status: " " }, groupBy: ["month"] };
    expect(buildReportParams(aggregate, form)).toEqual({ ok: true, params: { from: "2026-01-01", limit: 25, groupBy: ["month"], measures: ["documents", "total"] } });
  });
  it("leaves grouping to the report's default when none is chosen", () => {
    const result = buildReportParams(aggregate, emptyReportForm(aggregate));
    expect(result.ok && "groupBy" in result.params).toBe(false);
  });
  it("sends nothing but filters for a list report", () => {
    expect(buildReportParams(list, { filters: { from: "2026-02-02" }, groupBy: ["month"], measures: [] })).toEqual({ ok: true, params: { from: "2026-02-02" } });
  });
  it("refuses a bad date, a fraction and no measures", () => {
    const result = buildReportParams(aggregate, { filters: { from: "yesterday", limit: "2.5" }, groupBy: [], measures: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems).toHaveLength(3);
  });
});

describe("report values", () => {
  it("formats money from minor units without a float, counts and empty values", () => {
    expect(formatCell(123456n, { type: "money" }, "KES", "en-KE", "UTC")).toContain("1,234.56");
    expect(formatCell(9007199254740993n, { type: "money" }, "KES", "en-KE", "UTC")).toContain("90,071,992,547,409.93");
    expect(formatCell(1234, { type: "integer" }, "KES", "en", "UTC")).toBe("1,234");
    expect(formatCell(null, { type: "text" }, "KES", "en", "UTC")).toBe("");
    expect(formatCell("12.5", { type: "percent" }, "KES", "en", "UTC")).toBe("12.5%");
  });
  it("decodes a CSV and an Excel export", () => {
    expect(Array.from(exportBytes({ encoding: "utf8", content: "a,b" }))).toEqual([97, 44, 98]);
    expect(Array.from(exportBytes({ encoding: "base64", content: btoa("AB") }))).toEqual([65, 66]);
  });
});
