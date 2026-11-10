import { describe, expect, it } from "vitest";
import { cellText, headerOf, toCsv } from "./report-export";
import type { ReportColumn } from "./report-guard";

const col = (key: string, type: ReportColumn["type"]): ReportColumn => ({ key, label: key.toUpperCase(), type, role: "dimension" });

describe("report files (X-03)", () => {
  it("writes money as exact major units from bigint, beyond float precision", () => {
    expect(cellText(col("m", "money"), 9_007_199_254_740_993n, "KES")).toBe("90071992547409.93");
    expect(cellText(col("m", "money"), -5n, "KES")).toBe("-0.05");
    expect(headerOf(col("m", "money"), "KES")).toBe("M (KES)");
  });

  it("defuses text a spreadsheet would run as a formula, leaving numbers and money alone", () => {
    expect(cellText(col("t", "text"), '=HYPERLINK("x")', "KES")).toBe('\t=HYPERLINK("x")');
    expect(cellText(col("t", "text"), "@SUM(A1)", "KES")).toBe("\t@SUM(A1)");
    expect(cellText(col("n", "integer"), -3, "KES")).toBe("-3");
    expect(cellText(col("m", "money"), -300n, "KES")).toBe("-3.00");
  });

  it("quotes commas, quotes and line breaks, starts with a BOM and ends rows with CRLF", () => {
    const csv = toCsv([col("a", "text"), col("b", "integer")], [{ a: 'He said "hi", twice\nok', b: 2 }, { a: null, b: null }], "KES");
    expect(csv).toBe('﻿A,B\r\n"He said ""hi"", twice\nok",2\r\n,\r\n');
  });
});
