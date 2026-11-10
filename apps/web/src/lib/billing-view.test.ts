import { formatMoney } from "@flowless/shared-types";
import { describe, expect, it } from "vitest";
import { asMoney, balanceSummary, billingErrorMessage, citedVersionIds, formatDay, marksFor, newestFirst, rebillBill, reversedIds, servicePeriod, statementRowsFor, STATEMENT_TYPE_MARK, type RebillForm } from "./billing-view";

describe("money display", () => {
  it("formats bigint minor units exactly, beyond float precision", () => {
    expect(formatMoney(asMoney(123456789012345678n, "KES"), "en-KE")).toContain("1,234,567,890,123,456.78");
    expect(formatMoney(asMoney(-5000n, "KES"), "en-KE")).toContain("50.00");
  });
  it("summarises a balance", () => {
    expect(balanceSummary(1n)).toEqual({ label: "Owing", owing: true });
    expect(balanceSummary(-1n).label).toBe("In credit");
    expect(balanceSummary(0n).label).toBe("Nothing owing");
  });
});

describe("dates", () => {
  it("does not shift a calendar date across time zones", () => {
    expect(formatDay("2026-03-01", "en-GB")).toBe("1 Mar 2026");
  });
  it("shows a service period, one date, or a dash", () => {
    expect(servicePeriod("2026-03-01", "2026-03-31", "en-GB")).toBe("1 Mar 2026 to 31 Mar 2026");
    expect(servicePeriod("2026-03-01", "2026-03-01", "en-GB")).toBe("1 Mar 2026");
    expect(servicePeriod(null, null, "en-GB")).toBe("—");
  });
});

describe("statement marks", () => {
  it("marks credit notes and reversals, and reversed invoices", () => {
    expect(marksFor({ documentKind: "credit_note", reversed: false }).map((m) => m.label)).toEqual(["Credit note"]);
    expect(marksFor({ entryType: "reversal", documentKind: "reversal", reversed: false }).map((m) => m.label)).toEqual(["Reversal"]);
    expect(marksFor({ documentKind: "invoice", reversed: true, finalBill: true }).map((m) => m.label)).toEqual(["Invoice", "Final bill", "Reversed"]);
    expect(marksFor({ entryType: "payment", documentKind: null, reversed: false }).map((m) => m.label)).toEqual(["Payment"]);
  });
  it("finds reversed documents and orders newest first without mutating", () => {
    expect(reversedIds([{ reversesDocumentId: "a" }, { reversesDocumentId: null }])).toEqual(new Set(["a"]));
    const rows = [1, 2, 3];
    expect(newestFirst(rows)).toEqual([3, 2, 1]);
    expect(rows).toEqual([1, 2, 3]);
  });
  it("cites tariff versions from the column and the calculation", () => {
    expect(citedVersionIds({ tariffVersionId: "v1", calculation: { tariffVersionIds: ["v1", "v2"] } })).toEqual(["v1", "v2"]);
    expect(citedVersionIds({ tariffVersionId: null, calculation: null })).toEqual([]);
  });
});

describe("error messages", () => {
  it("explains CONFLICT, NOT_FOUND and PRECONDITION_FAILED", () => {
    expect(billingErrorMessage("CONFLICT", "Already voided")).toContain("reload");
    expect(billingErrorMessage("NOT_FOUND", "x")).toContain("not found");
    expect(billingErrorMessage("PRECONDITION_FAILED", "Live notes exist")).toBe("Not possible: Live notes exist");
    expect(billingErrorMessage("BAD_REQUEST", "Say why")).toBe("Say why");
  });
});

describe("re-bill input", () => {
  const base: RebillForm = { accountId: "a", categoryId: "c", invoiceTypeId: "t", periodTo: "2026-03-31", mode: "units", value: "12", baselinePeriod: "", baselineDial: "" };
  it("builds a units bill for the invoice's month", () => {
    expect(rebillBill(base)).toMatchObject({ ok: true, bill: { period: "2026-03", reading: { units: 12 }, readings: [] } });
  });
  it("builds an estimate with no reading", () => {
    expect(rebillBill({ ...base, mode: "estimate", value: "" })).toMatchObject({ ok: true, bill: { reading: {} } });
  });
  it("a dial reading needs its earlier actual", () => {
    expect(rebillBill({ ...base, mode: "dial" }).ok).toBe(false);
    expect(rebillBill({ ...base, mode: "dial", baselinePeriod: "2026-02", baselineDial: "100", value: "112" })).toMatchObject({
      ok: true,
      bill: { reading: { dial: 112 }, readings: [{ period: "2026-02", kind: "actual", dial: 100 }] },
    });
  });
  it("refuses a missing category, period or non-whole value", () => {
    expect(rebillBill({ ...base, categoryId: null }).ok).toBe(false);
    expect(rebillBill({ ...base, periodTo: null }).ok).toBe(false);
    expect(rebillBill({ ...base, value: "1.5" }).ok).toBe(false);
  });
});

describe("statement views (B-17)", () => {
  const rows = [
    { key: "a", amount: 100n, linkedTo: null },
    { key: "b", amount: -100n, linkedTo: "a" },
    { key: "c", amount: 80n, linkedTo: null },
  ];
  it("shows the office everything and the customer only unsettled rows", () => {
    expect(statementRowsFor(rows, "office")).toHaveLength(3);
    expect(statementRowsFor(rows, "customer").map((r) => r.key)).toEqual(["c"]);
  });
  it("has a mark for every line type", () => {
    expect(Object.keys(STATEMENT_TYPE_MARK).sort()).toEqual(["adjustment", "correction", "credit_note", "debit_note", "invoice", "payment", "reversal", "transfer"]);
  });
});
