import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  balance,
  billedConsumption,
  billReading,
  lastActual,
  liveDocs,
  newAccount,
  periodFromIndex,
  spanCharge,
  sum,
  totalConsumption,
} from "./index";
import { ALL, P, Sim, TARIFFS } from "./test-fixtures";

describe("invariants", () => {
  it("I-1: after any actual, unit charges billed since the previous actual equal charge(span)", () => {
    const s = new Sim();
    s.bill("2026-01", { dial: 0 });
    s.bill("2026-02", { units: 7 });
    s.bill("2026-03", { units: 3 });
    s.bill("2026-05", { dial: 50 });
    const expected = spanCharge(50, P("2026-01"), P("2026-05"), TARIFFS, "by_period")!.amount;
    expect(sum(billedConsumption(s.a, P("2026-01"), P("2026-05")), (l) => l.amount)).toBe(expected);
  });

  it("I-2: the balance is the sum of debits minus credits, derived from the documents", () => {
    const s = new Sim();
    s.bill("2026-01", { dial: 0 });
    s.bill("2026-02", { dial: 10 });
    const b0 = s.balance;
    s.pay(50000n);
    expect(s.balance).toBe(b0 - 50000n);
    expect(balance(s.a)).toBe(sum(s.a.docs, (d) => d.total));
    expect("balance" in s.a).toBe(false);
  });

  it("I-3: voiding any reading or invoice restores the exact prior state", () => {
    const s = new Sim();
    s.bill("2026-01", { dial: 20 });
    s.doc("2026-02", { dial: 24 });
    const before = { balance: s.balance, base: lastActual(s.a, P("2027-01")), live: liveDocs(s.a).length };
    const d = s.doc("2026-03", { dial: 30 });
    s.void(d.id);
    expect(s.balance).toBe(before.balance);
    expect(lastActual(s.a, P("2027-01"))).toEqual(before.base);
    expect(liveDocs(s.a)).toHaveLength(before.live);
    // append-only: the voided document and its reversal are still there
    expect(s.a.docs.find((x) => x.id === d.id)?.voided).toBe(true);
    expect(s.a.docs.at(-1)?.type).toBe("reversal");
  });

  it("I-3: voiding the same document twice does nothing the second time", () => {
    const s = new Sim();
    s.bill("2026-01", { dial: 20 });
    const d = s.doc("2026-02", { dial: 24 });
    s.void(d.id);
    expect(s.void(d.id).outcome.kind).toBe("not_found");
  });

  it("I-4: every document's lines sum to its total", () => {
    const s = new Sim();
    s.bill("2026-01", { dial: 0 });
    const d = s.doc("2026-02", { dial: 10 });
    s.void(d.id);
    s.bill("2026-02", { dial: 12 });
    s.correct("2026-02");
    s.disconnect("2026-03", 14, "K");
    for (const sim of ALL) {
      for (const doc of sim.a.docs) {
        if (doc.type === "payment") continue;
        expect(sum(doc.lines, (l) => l.amount), `doc ${doc.id}`).toBe(doc.total);
      }
    }
  });

  it("I-5: an estimate never becomes a baseline", () => {
    const s = new Sim();
    s.bill("2026-01", { dial: 20 });
    s.bill("2026-02", { units: 5 });
    expect(lastActual(s.a, P("2026-03"))?.period).toBe("2026-01");
  });

  it("I-5: an actual below the last actual is rejected unless rollover is declared", () => {
    const s = new Sim();
    s.bill("2026-01", { dial: 9990 });
    expect(s.held("2026-02", { dial: 15 })).toBe("NEGATIVE_OR_ROLLOVER");
    expect(s.a.docs).toHaveLength(0);
    expect(s.doc("2026-02", { dial: 15, rollover: true }).lines[0]!.units).toBe(25);
  });

  it("I-6: a first estimate with no history raises an exception rather than billing zero", () => {
    const s = new Sim();
    s.bill("2026-01", { dial: 20 });
    expect(s.held("2026-02")).toBe("NO_HISTORY");
    expect(s.a.docs).toHaveLength(0);
    expect(s.a.exceptions.at(-1)?.code).toBe("NO_HISTORY");
  });

  it("I-6: a configured fallback is used, and an estimate is never zero by accident", () => {
    const s = new Sim({ fallback: 8 });
    s.bill("2026-01", { dial: 20 });
    expect(s.doc("2026-02").lines[0]!.units).toBe(8);
  });

  it("I-7: the html's example, 5 and 10 unit estimates before an actual, same total", () => {
    const a = new Sim();
    a.bill("2026-01", { dial: 0 });
    a.bill("2026-02", { units: 5 });
    a.bill("2026-03", { units: 10 });
    a.bill("2026-04", { dial: 40 });
    const b = new Sim();
    b.bill("2026-01", { dial: 0 });
    b.bill("2026-04", { dial: 40 });
    expect(totalConsumption(a.a)).toBe(totalConsumption(b.a));
  });

  it("I-7 (property, 500 runs): a span's total does not depend on the estimate path, across a tariff change", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 5 }),
        fc.integer({ min: 0, max: 120 }),
        fc.array(fc.integer({ min: 0, max: 60 }), { minLength: 4, maxLength: 4 }),
        fc.integer({ min: P("2026-06"), max: P("2026-11") }),
        (months, total, estimates, start) => {
          const s = new Sim();
          s.bill(periodFromIndex(start), { dial: 0 });
          for (let i = 1; i < months; i++) s.doc(periodFromIndex(start + i), { units: estimates[i - 1]! });
          s.doc(periodFromIndex(start + months), { dial: total });
          const expected = spanCharge(total, start, start + months, TARIFFS, "by_period")!.amount;
          expect(totalConsumption(s.a)).toBe(expected);
          // and it equals the path with no estimates at all
          const direct = new Sim();
          direct.bill(periodFromIndex(start), { dial: 0 });
          direct.doc(periodFromIndex(start + months), { dial: total });
          expect(totalConsumption(s.a)).toBe(totalConsumption(direct.a));
        },
      ),
      { numRuns: 500 },
    );
  });

  it("I-8: disconnected, dormant and terminated accounts produce no bills except the final one", () => {
    for (const status of ["DISCONNECTED", "DORMANT", "TERMINATED"]) {
      const a = newAccount({ status });
      const r = billReading(a, TARIFFS, "2026-02", { dial: 10 });
      expect(r.outcome.kind, status).toBe("held");
      expect(r.account.docs).toHaveLength(0);
    }
    const s = new Sim();
    s.bill("2026-01", { dial: 0 });
    s.disconnect("2026-02", 5, "F");
    expect(s.a.docs.filter((d) => d.final)).toHaveLength(1);
    expect(s.held("2026-03", { dial: 6 })).toBe("STATUS_BLOCKED");
    expect(s.held("2026-03")).toBe("STATUS_BLOCKED");
  });

  it("a final bill is allowed from an account that is not ACTIVE", () => {
    const s = new Sim({}, TARIFFS, "ACTIVE");
    s.bill("2026-01", { dial: 0 });
    s.a = { ...s.a, status: "DORMANT" };
    expect(s.disconnect("2026-02", 5, "F").outcome.kind).toBe("billed");
  });

  it("NF-22: the engine never mutates the account it is given", () => {
    const a = newAccount();
    const frozen = JSON.stringify(a, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
    billReading(a, TARIFFS, "2026-01", { dial: 5 });
    expect(JSON.stringify(a, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v))).toBe(frozen);
  });
});
