import { describe, expect, it } from "vitest";
import { lastActual, monthCharge, periodFromIndex, totalConsumption } from "./index";
import { P, Sim, TARIFFS } from "./test-fixtures";

// Requirements section 6 scenarios S-1 to S-10 and the tests of docs/billing-engine.html (numbered as there).
describe("scenarios", () => {
  it("S-1 / html 1: 6 units estimated = 645.00 (matches legacy)", () => {
    const s = new Sim();
    s.bill("2026-01", { dial: 10 });
    expect(s.doc("2026-02", { units: 6 }).total).toBe(64500n);
  });

  it("S-2 / html 2: 2 units at the 2026-10 tariff = 340.00 (matches legacy)", () => {
    const s = new Sim();
    s.bill("2026-09", { dial: 10 });
    expect(s.doc("2026-10", { dial: 12 }).total).toBe(34000n);
  });

  it("S-3 / html 3: 20 units in one month = 1,839.00 consumption", () => {
    expect(monthCharge(20, TARIFFS[0]!)).toBe(183900n);
  });

  it("S-4 / html 4: Sep 20, est 4, actual 22, actual 23: 480.00, credit note -15.00, 232.50", () => {
    const s = new Sim();
    s.bill("2026-01", { dial: 20 });
    expect(s.doc("2026-02", { units: 4 }).total).toBe(48000n);
    const n = s.doc("2026-03", { dial: 22 });
    expect(n.total).toBe(-1500n);
    expect(n.type).toBe("credit_note");
    expect(s.doc("2026-04", { dial: 23 }).total).toBe(23250n);
    expect(s.balance).toBe(69750n);
    // 3 x 150.00 standing + 3 units x 82.50
    expect(s.balance).toBe(3n * 15000n + 3n * 8250n);
  });

  it("S-4: the credit note lines are 165 - 330 + 150 and the words true-up only appear with that line", () => {
    const s = new Sim();
    s.bill("2026-01", { dial: 20 });
    s.doc("2026-02", { units: 4 });
    const n = s.doc("2026-03", { dial: 22 });
    expect(n.lines.map((l) => [l.code, l.amount])).toEqual([
      ["USAGE", 16500n],
      ["TRUEUP", -33000n],
      ["STANDING", 15000n],
    ]);
    const clean = new Sim();
    clean.bill("2026-01", { dial: 20 });
    expect(clean.doc("2026-02", { dial: 22 }).lines.some((l) => l.code === "TRUEUP")).toBe(false);
  });

  function fiveA(scaling: "by_period" | "none") {
    const a = new Sim({ scaling });
    a.bill("2026-01", { dial: 0 });
    a.bill("2026-02", { units: 10 });
    a.bill("2026-03", { units: 10 });
    a.bill("2026-04", { dial: 60 });
    return a;
  }

  it("S-5 / html 5a: scaled bands: estimated path costs the same as reading monthly (5,517.00)", () => {
    const b = new Sim();
    b.bill("2026-01", { dial: 0 });
    ["2026-02", "2026-03", "2026-04"].forEach((p, i) => b.bill(p, { dial: 20 * (i + 1) }));
    expect(totalConsumption(fiveA("by_period").a)).toBe(551700n);
    expect(totalConsumption(b.a)).toBe(551700n);
  });

  it("S-5 / html 5b: legacy mode (tier_scaling none) reproduces 5,797.00 = 2 x 879 + 4,039", () => {
    expect(totalConsumption(fiveA("none").a)).toBe(579700n);
    expect(2n * 87900n + 403900n).toBe(579700n);
  });

  it("S-6 / html 6: wrong dial corrected: void Oct, rebill 25, correct Nov (net 1,387.50)", () => {
    const s = new Sim();
    s.bill("2026-01", { dial: 20 });
    const d = s.doc("2026-02", { dial: 30 });
    s.bill("2026-03", { dial: 36 });
    s.void(d.id);
    expect(s.doc("2026-02", { dial: 25 }).lines[0]!.units).toBe(5);
    const c = s.correct("2026-03");
    expect(c.outcome.kind === "billed" && c.outcome.doc.total).toBe(48000n);
    expect(totalConsumption(s.a)).toBe(138750n);
    expect(s.correct("2026-03").outcome.kind).toBe("none");
  });

  it("S-7 / html 7: rollover 9990 to 0015 needs confirmation, then bills 25 units", () => {
    const s = new Sim();
    s.bill("2026-01", { dial: 9990 });
    expect(s.held("2026-02", { dial: 15 })).toBe("NEGATIVE_OR_ROLLOVER");
    expect(s.doc("2026-02", { dial: 15, rollover: true }).lines[0]!.amount).toBe(238900n);
  });

  it("S-8 / html 8: an estimate with no actual reading is held (NO_BASELINE), not billed", () => {
    const s = new Sim();
    expect(s.held("2026-01", { units: 5 })).toBe("NO_BASELINE");
    expect(s.a.docs).toHaveLength(0);
  });

  it("S-8: baseline lost at import (prev 6, curr 707) is held NO_BASELINE; no bill", () => {
    const s = new Sim();
    expect(s.held("2026-01", { dial: 707, claimedPrevious: 6 })).toBe("NO_BASELINE");
    expect(s.a.docs).toHaveLength(0);
    expect(s.a.exceptions.map((e) => e.code)).toEqual(["NO_BASELINE"]);
  });

  it("html 8b: an estimate with a baseline but no history is held (NO_HISTORY), never a silent zero", () => {
    const s = new Sim();
    s.bill("2026-01", { dial: 50 });
    expect(s.held("2026-02")).toBe("NO_HISTORY");
  });

  it("html 8c: the first actual reading is a baseline: no bill, no 689-unit surprise", () => {
    const s = new Sim();
    expect(s.bill("2026-01", { dial: 707 }).outcome.kind).toBe("baseline");
    expect(s.a.docs).toHaveLength(0);
  });

  it("S-9 / html 9: disconnect bills final units, month standing charge and fee; later bills blocked", () => {
    const s = new Sim();
    s.bill("2026-01", { dial: 100 });
    s.bill("2026-02", { dial: 110 });
    const r = s.disconnect("2026-03", 112, "D1");
    expect(r.outcome.kind === "billed" && r.outcome.doc.total).toBe(131500n);
    expect(s.a.status).toBe("DISCONNECTED");
    expect(s.held("2026-04", { dial: 115 })).toBe("STATUS_BLOCKED");
  });

  it("S-9: unbilled dial movement since the last bill is in the closing bill", () => {
    const s = new Sim();
    s.bill("2026-01", { dial: 100 });
    const r = s.disconnect("2026-04", 106, "D2");
    const d = r.outcome.kind === "billed" ? r.outcome.doc : undefined;
    // 6 units over 3 months, standing for Feb, Mar and Apr, plus the fee
    expect(d?.lines.filter((l) => l.code === "STANDING")).toHaveLength(3);
    expect(d?.lines.some((l) => l.code === "TURN_OFF")).toBe(true);
    expect(d?.lines.find((l) => l.code === "USAGE")?.units).toBe(6);
  });

  it("S-10 / html 10: a duplicate disconnection event posts no second fee", () => {
    const s = new Sim();
    s.bill("2026-01", { dial: 100 });
    s.disconnect("2026-02", 101, "D1");
    const n = s.a.docs.length;
    expect(s.disconnect("2026-02", 101, "D1").outcome.kind).toBe("duplicate");
    expect(s.a.docs).toHaveLength(n);
    expect(s.a.docs.flatMap((d) => d.lines).filter((l) => l.code === "TURN_OFF")).toHaveLength(1);
  });

  it("html 11: a reading below the last actual after an estimate is rejected", () => {
    const s = new Sim();
    s.bill("2026-01", { dial: 20 });
    s.bill("2026-02", { units: 4 });
    expect(s.held("2026-03", { dial: 19 })).toBe("NEGATIVE_OR_ROLLOVER");
  });

  it("html 12: voiding an invoice restores the prior state", () => {
    const s = new Sim();
    s.bill("2026-01", { dial: 20 });
    const d = s.doc("2026-02", { units: 5 });
    s.void(d.id);
    expect(s.balance).toBe(0n);
    expect(lastActual(s.a, P("2026-12"))?.dial).toBe(20);
    expect(s.doc("2026-02", { units: 5 }).total).toBe(d.total);
  });

  it("html 13: a tariff change inside a span prices each month at its own tariff (655.00 incl. missed standing)", () => {
    const s = new Sim();
    s.bill("2026-08", { dial: 0 });
    const d = s.doc("2026-10", { dial: 4 });
    expect(d.total).toBe(65500n);
    expect(d.lines.find((l) => l.code === "USAGE")?.tariffVersions).toEqual(["T1", "T2"]);
  });

  it("T-04: every priced line carries the tariff version used", () => {
    const s = new Sim();
    s.bill("2026-09", { dial: 10 });
    const d = s.doc("2026-10", { dial: 12 });
    expect(d.lines.map((l) => l.tariffVersions)).toEqual([["T2"], ["T2"]]);
  });

  it("lines carry service_from and service_to (B-14)", () => {
    const s = new Sim();
    s.bill("2026-01", { dial: 0 });
    const d = s.doc("2026-04", { dial: 30 });
    const u = d.lines.find((l) => l.code === "USAGE")!;
    expect([u.serviceFrom, u.serviceTo]).toEqual(["2026-02", "2026-04"]);
    expect(periodFromIndex(P("2026-02"))).toBe("2026-02");
  });

  it("final bill: a missing tariff holds the bill rather than billing zero", () => {
    const s = new Sim({}, [{ ...TARIFFS[0]!, from: "2027-01" }]);
    expect(s.held("2026-01", { dial: 5 })).toBe("MISSING_TARIFF");
  });
});
