import { describe, expect, it } from "vitest";
import { POLICY_KEYS, POLICY_SPECS, outcomesFromForm, outcomesToForm, schedulesFromForm, schedulesToForm, summarizePolicy, valueFromForm, valueToForm } from "./policy-settings";

// The defaults the API registers (packages/api/src/modules/billing and metering settings).
const DEFAULTS: Record<string, unknown> = {
  [POLICY_KEYS.billingPolicy]: { tierScaling: "by_period", estimateAverageOf: 3, estimateFallbackUnits: null, outlierCeilingUnitsPerMonth: 300, meterDigits: 4, estimateMethod: "median", estimateTrim: 0.2, estimateFixedMinimum: null, noneAction: "hold", outlierFactor: 3, usageInvoiceTypeCode: "usage" },
  [POLICY_KEYS.billingCycle]: { trigger: "batch", frequency: "monthly" },
  [POLICY_KEYS.billingReview]: { bulkApproveBelow: "1000000", individualAbove: "5000000", sampleRate: 0.05, sampleMinimum: 3 },
  [POLICY_KEYS.billingCorrections]: { graceWindow: { basis: "invoice_due_date", days: 30 }, largeDeviation: { percent: 50, amount: "0" }, creditTemplate: "c {amount}", debitTemplate: "d {amount}" },
  [POLICY_KEYS.revenueProtection]: { backBillMaxMonths: 12, backBillRequiresApproval: true },
  [POLICY_KEYS.meteringValidation]: { highFactor: 3, lowFactor: 0, historyIntervals: 3, maxUnitsPerDay: null, rolloverMaxFraction: 0.5 },
  [POLICY_KEYS.meteringMisses]: { revisitAfter: 2, selfReadPromptAfter: 2, escalateAfter: 4, maxConsecutiveEstimates: null },
  [POLICY_KEYS.meteringZero]: { streakAfter: 3 },
};

describe("policy settings forms", () => {
  for (const [key, value] of Object.entries(DEFAULTS)) {
    it(`${key} round-trips its default`, () => {
      const spec = POLICY_SPECS[key]!;
      const result = valueFromForm(spec, valueToForm(spec, value, "KES"), "KES");
      expect(result).toEqual({ ok: true, value });
    });
  }

  it("shows minor units as money and stores digits", () => {
    const spec = POLICY_SPECS[POLICY_KEYS.billingReview]!;
    const form = valueToForm(spec, DEFAULTS[POLICY_KEYS.billingReview], "KES");
    expect(form.bulkApproveBelow).toBe("10000.00");
    const edited = valueFromForm(spec, { ...form, bulkApproveBelow: "2,500.50" }, "KES");
    expect(edited).toEqual({ ok: true, value: expect.objectContaining({ bulkApproveBelow: "250050" }) });
  });

  it("refuses an individual threshold under the bulk one", () => {
    const spec = POLICY_SPECS[POLICY_KEYS.billingReview]!;
    const form = { ...valueToForm(spec, DEFAULTS[POLICY_KEYS.billingReview], "KES"), individualAbove: "1.00" };
    expect(valueFromForm(spec, form, "KES").ok).toBe(false);
  });

  it("finds out-of-range and missing values", () => {
    const spec = POLICY_SPECS[POLICY_KEYS.meteringMisses]!;
    const form = { ...valueToForm(spec, DEFAULTS[POLICY_KEYS.meteringMisses], "KES"), revisitAfter: "99", escalateAfter: "" };
    const result = valueFromForm(spec, form, "KES");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problems).toHaveLength(2);
  });

  it("keeps a nullable field null when emptied and stores a number when filled", () => {
    const spec = POLICY_SPECS[POLICY_KEYS.meteringValidation]!;
    const form = { ...valueToForm(spec, DEFAULTS[POLICY_KEYS.meteringValidation], "KES"), maxUnitsPerDay: "12.5" };
    expect(valueFromForm(spec, form, "KES")).toMatchObject({ ok: true, value: { maxUnitsPerDay: 12.5 } });
  });

  it("outcome mapping stores only overrides", () => {
    const form = outcomesToForm({ meter_faulty: "estimate" });
    expect(form.meter_faulty).toBe("estimate");
    expect(form.read_ok).toBe("");
    expect(outcomesFromForm(form)).toEqual({ ok: true, value: { meter_faulty: "estimate" } });
    expect(outcomesFromForm(outcomesToForm({}))).toEqual({ ok: true, value: {} });
  });

  it("bulk schedules check the DMA, days and date, one schedule per DMA", () => {
    const rows = schedulesToForm({ schedules: [{ dmaId: "a", everyDays: 30, startDate: "2026-01-01" }] });
    expect(schedulesFromForm(rows)).toEqual({ ok: true, value: { schedules: [{ dmaId: "a", everyDays: 30, startDate: "2026-01-01" }] } });
    expect(schedulesFromForm([...rows, { dmaId: "a", everyDays: "0", startDate: "" }]).ok).toBe(false);
  });

  it("summarises a version in a line", () => {
    expect(summarizePolicy(POLICY_KEYS.billingCycle, DEFAULTS[POLICY_KEYS.billingCycle])).toContain("trigger: Batch");
    expect(summarizePolicy(POLICY_KEYS.meteringOutcomes, { meter_faulty: "estimate" })).toBe("1 outcome changed from the default");
  });
});
