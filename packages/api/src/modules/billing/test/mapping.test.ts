import { billReading, newAccount } from "@flowless/billing-engine";
import { describe, expect, it } from "vitest";
import { counterAccount, decodeTariffKey, engineDocsFrom, engineTariffs, linesFromEngineDoc, monthEnd, spanOf, sumLines, tariffKey, type PricedMonth } from "../mapping";

const month = (period: string, over: Partial<PricedMonth> = {}): PricedMonth => ({
  period,
  tariffVersionId: "tv1",
  bands: [{ to: 6, rate: 8250n }, { to: null, rate: 9600n }],
  standing: 15_000n,
  standingChargeItemId: "item1",
  standingAmountId: "amt1",
  meterRentAmountId: null,
  ...over,
});

describe("mapping engine results to rows", () => {
  it("round-trips the version key the engine carries", () => {
    expect(decodeTariffKey(tariffKey(month("2025-01")))).toEqual({ tariffVersionId: "tv1", standingAmountId: "amt1", meterRentAmountId: null, standingChargeItemId: "item1" });
  });

  it("starts a new engine tariff only when something cited changes", () => {
    const list = engineTariffs([month("2025-01"), month("2025-02"), month("2025-03", { standingAmountId: "amt2", standing: 16_000n })]);
    expect(list.map((t) => t.from)).toEqual(["2025-01", "2025-03"]);
  });

  it("cites the tariff version on usage and true-up lines and the charge amount on standing lines (T-04)", () => {
    const tariffs = engineTariffs([month("2025-02"), month("2025-03"), month("2025-04")]);
    const account = {
      ...newAccount(),
      readings: [{ id: 1, period: "2025-01", kind: "actual" as const, dial: 100, voided: false, flags: [] }],
    };
    const first = billReading(account, tariffs, "2025-02", { units: 10 });
    const b = first.outcome.kind === "billed" ? first.outcome.doc : null;
    expect(b).not.toBeNull();
    const second = billReading(first.account, tariffs, "2025-04", { dial: 130 });
    const doc = second.outcome.kind === "billed" ? second.outcome.doc : null;
    const lines = linesFromEngineDoc(doc!);
    expect(lines.map((l) => l.lineType)).toEqual(["consumption", "true_up", "standing", "standing"]);
    for (const l of lines) {
      if (l.lineType === "standing") expect([l.chargeItemAmountId, l.chargeItemId]).toEqual(["amt1", "item1"]);
      else expect(l.tariffVersionId).toBe("tv1");
    }
    expect(sumLines(lines)).toBe(doc!.total);
  });

  it("rebuilds engine documents from stored rows, skipping reversals and manual notes", () => {
    const code = (c: string) => ({ code: c, units: 0, tariffVersions: [] });
    const docs = engineDocsFrom(
      [
        { id: "a", kind: "invoice", periodTo: "2025-02-28", total: 100n, reversed: true, lines: [{ amount: 100n, serviceFrom: "2025-02-01", serviceTo: "2025-02-28", calculation: code("STANDING") }] },
        { id: "b", kind: "debit_note", periodTo: null, total: 5n, reversed: false, lines: [{ amount: 5n, serviceFrom: null, serviceTo: null, calculation: { code: null } }] },
        { id: "c", kind: "reversal", periodTo: "2025-02-28", total: -100n, reversed: false, lines: [] },
      ],
      new Set(),
    );
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ period: "2025-02", voided: true, type: "invoice" });
  });

  it("small helpers", () => {
    expect(monthEnd("2024-02")).toBe("2024-02-29");
    expect(spanOf([{ serviceFrom: "2025-02-01", serviceTo: "2025-02-28" }, { serviceFrom: "2025-01-01", serviceTo: "2025-01-31" }])).toEqual({ periodFrom: "2025-01-01", periodTo: "2025-02-28" });
    expect(counterAccount("deposit")).toBe("deposit_liability");
    expect(counterAccount("consumption")).toBe("revenue");
  });
});
