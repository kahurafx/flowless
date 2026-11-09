import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { installmentAmounts, invoicePolicyProblems, formatInvoiceNumber, minimumDeposit } from "./invoice-policy";
import { lateFee, lateFeeRuleSchema, percentOf, type LateFeeRule } from "./late-fee";

const rule = (over: Partial<LateFeeRule> = {}): LateFeeRule => ({ triggerDays: 7, base: "overdue_balance", rateBp: 500, flatAmount: null, cap: null, frequency: "once", ...over });

// T-10: late-fee rules calculate from trigger, base, rate or flat amount, cap and frequency.
describe("lateFee", () => {
  it("charges nothing before the trigger, when not overdue, or with no balance", () => {
    expect(lateFee(rule(), 100_000n, 6, 0n)).toMatchObject({ amount: 0n, reason: "before_trigger" });
    expect(lateFee(rule({ triggerDays: 0 }), 100_000n, 0, 0n)).toMatchObject({ amount: 0n, reason: "not_overdue" });
    expect(lateFee(rule(), 0n, 30, 0n)).toMatchObject({ amount: 0n, reason: "no_balance" });
    expect(lateFee(rule(), -5_000n, 30, 0n)).toMatchObject({ amount: 0n, reason: "no_balance" });
  });

  it("charges a percentage of the balance, rounded once, half up", () => {
    expect(lateFee(rule(), 100_000n, 7, 0n)).toMatchObject({ amount: 5_000n, reason: "charged" });
    expect(lateFee(rule({ rateBp: 333 }), 1_000n, 10, 0n).amount).toBe(33n); // 33.3 -> 33
    expect(lateFee(rule({ rateBp: 350 }), 1_000n, 10, 0n).amount).toBe(35n);
    expect(percentOf(15n, 5000)).toBe(8n); // 7.5 -> 8
    expect(percentOf(14n, 5000)).toBe(7n);
  });

  it("charges a flat amount", () => {
    expect(lateFee(rule({ rateBp: null, flatAmount: 20_000n }), 1_000n, 10, 0n).amount).toBe(20_000n);
  });

  it("bases the percentage on the invoice total or the overdue balance, as the rule says", () => {
    const amounts = { overdueBalance: 40_000n, invoiceTotal: 100_000n };
    expect(lateFee(rule({ base: "overdue_balance" }), amounts, 10, 0n).amount).toBe(2_000n);
    expect(lateFee(rule({ base: "invoice_total" }), amounts, 10, 0n).amount).toBe(5_000n);
    // Nothing owed any more: the total alone does not earn a fee.
    expect(lateFee(rule({ base: "invoice_total" }), { overdueBalance: 0n, invoiceTotal: 100_000n }, 10, 0n)).toMatchObject({ amount: 0n, reason: "no_balance" });
  });

  it("charges a once-rule once", () => {
    expect(lateFee(rule(), 100_000n, 90, 0n).amount).toBe(5_000n);
    expect(lateFee(rule(), 100_000n, 90, 5_000n)).toMatchObject({ amount: 0n, reason: "already_charged" });
  });

  it("repeats a monthly rule every 30 days after the trigger, charging only what is not yet charged", () => {
    const monthly = rule({ frequency: "monthly" });
    expect(lateFee(monthly, 100_000n, 7, 0n)).toMatchObject({ amount: 5_000n, applications: 1 });
    expect(lateFee(monthly, 100_000n, 36, 0n)).toMatchObject({ amount: 5_000n, applications: 1 });
    expect(lateFee(monthly, 100_000n, 37, 0n)).toMatchObject({ amount: 10_000n, applications: 2 });
    expect(lateFee(monthly, 100_000n, 37, 5_000n)).toMatchObject({ amount: 5_000n, applications: 2 });
    expect(lateFee(monthly, 100_000n, 37, 10_000n)).toMatchObject({ amount: 0n, reason: "already_charged" });
    expect(lateFee(monthly, 100_000n, 127, 0n).applications).toBe(5);
  });

  it("stops at the cap", () => {
    const capped = rule({ frequency: "monthly", cap: 12_000n });
    expect(lateFee(capped, 100_000n, 37, 0n)).toMatchObject({ amount: 10_000n, reason: "charged" });
    expect(lateFee(capped, 100_000n, 67, 10_000n)).toMatchObject({ amount: 2_000n, reason: "capped" });
    expect(lateFee(capped, 100_000n, 200, 12_000n)).toMatchObject({ amount: 0n, reason: "capped" });
    expect(lateFee(rule({ cap: 3_000n }), 100_000n, 10, 0n)).toMatchObject({ amount: 3_000n, reason: "capped" });
  });

  it("never charges a manual-only rule by itself, but says what applying it would add", () => {
    const manual = rule({ frequency: "manual_only" });
    expect(lateFee(manual, 100_000n, 90, 0n)).toMatchObject({ amount: 0n, suggested: 5_000n, reason: "manual_only" });
    expect(lateFee(manual, 100_000n, 90, 2_000n)).toMatchObject({ amount: 0n, suggested: 3_000n });
    expect(lateFee(rule({ frequency: "manual_only", cap: 1_000n }), 100_000n, 90, 0n).suggested).toBe(1_000n);
    expect(lateFee(manual, 100_000n, 3, 0n).suggested).toBe(0n);
  });

  it("property: never negative, never over the cap, never charges twice for the same days", () => {
    const arbRule = fc
      .record({
        triggerDays: fc.integer({ min: 0, max: 60 }),
        base: fc.constantFrom("overdue_balance", "invoice_total" as const),
        rateBp: fc.option(fc.integer({ min: 1, max: 10_000 }), { nil: null }),
        flat: fc.bigInt({ min: 1n, max: 1_000_000n }),
        cap: fc.option(fc.bigInt({ min: 1n, max: 2_000_000n }), { nil: null }),
        frequency: fc.constantFrom("once", "monthly", "manual_only" as const),
      })
      .map((r): LateFeeRule => ({ triggerDays: r.triggerDays, base: r.base, rateBp: r.rateBp, flatAmount: r.rateBp === null ? r.flat : null, cap: r.cap, frequency: r.frequency }));
    fc.assert(
      fc.property(arbRule, fc.bigInt({ min: -1000n, max: 50_000_000n }), fc.integer({ min: 0, max: 800 }), fc.bigInt({ min: 0n, max: 3_000_000n }), (r, balance, days, charged) => {
        const first = lateFee(r, balance, days, charged);
        if (first.amount < 0n || first.suggested < 0n) return false;
        if (r.cap !== null && charged <= r.cap && charged + first.amount > r.cap) return false;
        if (r.frequency === "manual_only" && first.amount !== 0n) return false;
        // Having charged it, asking again for the same day asks for nothing more.
        return lateFee(r, balance, days, charged + first.amount).amount === 0n;
      }),
      { numRuns: 500 },
    );
  });

  it("property: waiting longer never lowers the total a rule asks for", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 400 }), fc.integer({ min: 0, max: 400 }), (a, b) => {
        const monthly = rule({ frequency: "monthly", cap: 40_000n });
        const [early, late] = a <= b ? [a, b] : [b, a];
        return lateFee(monthly, 100_000n, early, 0n).amount <= lateFee(monthly, 100_000n, late, 0n).amount;
      }),
      { numRuns: 200 },
    );
  });
});

describe("lateFeeRuleSchema", () => {
  it("needs a rate or a flat amount, not both and not neither", () => {
    expect(lateFeeRuleSchema.safeParse({ triggerDays: 7, base: "overdue_balance", frequency: "once" }).success).toBe(false);
    expect(lateFeeRuleSchema.safeParse({ triggerDays: 7, base: "overdue_balance", frequency: "once", rateBp: 500, flatAmount: 100n }).success).toBe(false);
    expect(lateFeeRuleSchema.safeParse({ triggerDays: 7, base: "overdue_balance", frequency: "once", rateBp: 500 })).toMatchObject({ success: true, data: { cap: null } });
    expect(lateFeeRuleSchema.safeParse({ triggerDays: 7, base: "overdue_balance", frequency: "once", rateBp: 0 }).success).toBe(false);
    expect(lateFeeRuleSchema.safeParse({ triggerDays: 7, base: "nope", frequency: "once", rateBp: 5 }).success).toBe(false);
  });
});

// T-08, T-09: invoice type rules.
describe("invoicePolicyProblems", () => {
  const full = { kind: "full" } as const;

  it("never lets an application's invoice disconnect (T-09)", () => {
    expect(invoicePolicyProblems({ appliesTo: "application", terms: full, overdue: { action: "disconnect", afterDays: 0 } })[0]).toMatch(/never disconnects/);
    for (const action of ["pause_application", "cancel_application", "none"] as const) {
      expect(invoicePolicyProblems({ appliesTo: "application", terms: full, overdue: { action, afterDays: 3 } })).toEqual([]);
    }
  });

  it("lets an account's invoice disconnect, but not pause an application", () => {
    expect(invoicePolicyProblems({ appliesTo: "account", terms: full, overdue: { action: "disconnect", afterDays: 30 } })).toEqual([]);
    expect(invoicePolicyProblems({ appliesTo: "account", terms: full, overdue: { action: "pause_application", afterDays: 0 } })).toHaveLength(1);
  });

  it("wants a minimum deposit to be a percentage or an amount", () => {
    const overdue = { action: "none", afterDays: 0 } as const;
    expect(invoicePolicyProblems({ appliesTo: "account", terms: { kind: "minimum_deposit" }, overdue })).toHaveLength(1);
    expect(invoicePolicyProblems({ appliesTo: "account", terms: { kind: "minimum_deposit", percentBp: 2500, amount: 5n }, overdue })).toHaveLength(1);
    expect(invoicePolicyProblems({ appliesTo: "account", terms: { kind: "minimum_deposit", percentBp: 2500 }, overdue })).toEqual([]);
  });
});

describe("invoice numbers and terms", () => {
  it("pads the sequence and never truncates it", () => {
    expect(formatInvoiceNumber({ prefix: "INV-", width: 6 }, 42)).toBe("INV-000042");
    expect(formatInvoiceNumber({ prefix: "", width: 3 }, 12345)).toBe("12345");
  });

  it("splits a total into installments that always add up", () => {
    expect(installmentAmounts(1_000n, 3)).toEqual([1_000n - 2n * 333n, 333n, 333n]);
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 12n }), fc.integer({ min: 2, max: 60 }), (total, count) => {
        const parts = installmentAmounts(total, count);
        return parts.length === count && parts.reduce((a, b) => a + b, 0n) === total && parts.every((p) => p >= 0n);
      }),
      { numRuns: 200 },
    );
  });

  it("works out the deposit due up front, never above the total", () => {
    expect(minimumDeposit(100_000n, { kind: "minimum_deposit", percentBp: 2500 })).toBe(25_000n);
    expect(minimumDeposit(100_000n, { kind: "minimum_deposit", amount: 30_000n })).toBe(30_000n);
    expect(minimumDeposit(10_000n, { kind: "minimum_deposit", amount: 30_000n })).toBe(10_000n);
  });
});
