import { describe, expect, it } from "vitest";
// The API's pure Tariffs files, imported by path only to check that the form mirrors agree with them.
import { planEffectiveDate } from "../../../../packages/api/src/modules/tariffs/dating";
import { validateTariffContent } from "../../../../packages/api/src/modules/tariffs/content";
import { allowedOverdueActions as apiAllowed } from "../../../../packages/api/src/modules/tariffs/invoice-policy";
import { previewEffectiveDate, plainDate, ordinal } from "./effective-date";
import { formFromType, lateFeeDraft, lateFeeText, overdueText, termsText, lateFeeFromDraft, linesFromDrafts, parsePercentBp, percentText, updateFromForm, allowedOverdueActions, type InvoiceTypeView } from "./invoice-type-form";
import { amountText, parseAmount } from "./money-input";
import { addBand, chargeForUnits, draftFromContent, emptyDraft, parseDraft, removeBand, type ContentDraft } from "./tariff-content";
import {
  KEEP,
  assignmentChanged,
  assignmentInput,
  assignmentOutcome,
  bandRows,
  contentTable,
  inForceOn,
  keepAll,
  versionStatus,
  versionTimeline,
} from "./tariff-view";

const KES = "KES";

describe("money typed in forms", () => {
  it("parses to minor units without floats", () => {
    expect(parseAmount("82.50", KES)).toBe(8250n);
    expect(parseAmount("1,250", KES)).toBe(125000n);
    expect(parseAmount("0.5", KES)).toBe(50n);
    expect(parseAmount("0.1", KES)).toBe(10n);
  });
  it("refuses signs, too many decimals, words and (unless allowed) zero", () => {
    for (const bad of ["", "-5", "1.234", "abc", "1e3", "1.2.3"]) expect(parseAmount(bad, KES)).toBeNull();
    expect(parseAmount("0", KES)).toBeNull();
    expect(parseAmount("0.00", KES, { allowZero: true })).toBe(0n);
  });
  it("honours the currency's decimals", () => {
    expect(parseAmount("1500", "JPY")).toBe(1500n);
    expect(parseAmount("1500.5", "JPY")).toBeNull();
  });
  it("shows minor units as the text an input holds", () => {
    expect(amountText(8250n, KES)).toBe("82.50");
    expect(parseAmount(amountText(123456789012n, KES), KES)).toBe(123456789012n);
  });
});

describe("tariff content drafts (T-01)", () => {
  const increasing = { type: "increasing_block", flatBasis: "none" } as const;

  it("builds bands that meet exactly from each band's end", () => {
    const draft: ContentDraft = { type: "increasing_block", bands: [{ to: "6", rate: "50" }, { to: "20", rate: "82.50" }, { to: "", rate: "120" }] };
    const checked = parseDraft(draft, increasing, KES);
    expect(checked).toEqual({
      ok: true,
      content: {
        type: "increasing_block",
        bands: [
          { from: 0, to: 6, rate: 5000n },
          { from: 6, to: 20, rate: 8250n },
          { from: 20, to: null, rate: 12000n },
        ],
      },
    });
  });

  it("reports every problem a person can fix", () => {
    const check = (bands: { to: string; rate: string }[]) => parseDraft({ type: "increasing_block", bands }, increasing, KES);
    expect(check([{ to: "", rate: "50" }, { to: "", rate: "60" }])).toMatchObject({ ok: false, problems: [expect.stringContaining("open-ended but is not the last")] });
    expect(check([{ to: "6", rate: "50" }, { to: "6", rate: "60" }])).toMatchObject({ ok: false, problems: expect.arrayContaining([expect.stringContaining("must end after it starts")]) });
    expect(check([{ to: "6", rate: "80" }, { to: "", rate: "60" }])).toMatchObject({ ok: false, problems: [expect.stringContaining("must not fall")] });
    expect(check([{ to: "6", rate: "x" }, { to: "", rate: "60" }])).toMatchObject({ ok: false, problems: [expect.stringContaining("Band 1 rate")] });
    expect(check([{ to: "6.5", rate: "50" }, { to: "", rate: "60" }])).toMatchObject({ ok: false, problems: [expect.stringContaining("whole number of units")] });
    expect(check([{ to: "6", rate: "50" }])).toMatchObject({ ok: false, problems: [expect.stringContaining("must be open-ended")] });
  });

  it("checks a decreasing tariff the other way round", () => {
    const decreasing = { type: "decreasing_block", flatBasis: "none" } as const;
    const ok = parseDraft({ type: "decreasing_block", bands: [{ to: "10", rate: "90" }, { to: "", rate: "60" }] }, decreasing, KES);
    expect(ok.ok).toBe(true);
    const bad = parseDraft({ type: "decreasing_block", bands: [{ to: "10", rate: "60" }, { to: "", rate: "90" }] }, decreasing, KES);
    expect(bad).toMatchObject({ ok: false, problems: [expect.stringContaining("must not rise")] });
  });

  it("parses uniform and flat-rate content", () => {
    expect(parseDraft({ type: "uniform", rate: "75" }, { type: "uniform", flatBasis: "none" }, KES)).toEqual({ ok: true, content: { type: "uniform", rate: 7500n } });
    expect(parseDraft({ type: "uniform", rate: "" }, { type: "uniform", flatBasis: "none" }, KES).ok).toBe(false);
    const flat = (basis: "none" | "taps" | "property", amounts: { key: string; amount: string }[]) => parseDraft({ type: "flat_rate", amounts }, { type: "flat_rate", flatBasis: basis }, KES);
    expect(flat("none", [{ key: "", amount: "500" }])).toEqual({ ok: true, content: { type: "flat_rate", amounts: [{ key: null, amount: 50000n }] } });
    expect(flat("taps", [{ key: "1", amount: "300" }, { key: "2", amount: "500" }]).ok).toBe(true);
    expect(flat("taps", [{ key: "one", amount: "300" }])).toMatchObject({ ok: false, problems: [expect.stringContaining("not a number of taps")] });
    expect(flat("property", [{ key: "House", amount: "300" }, { key: "house", amount: "400" }])).toMatchObject({ ok: false, problems: [expect.stringContaining("appears twice")] });
    expect(flat("property", [{ key: "", amount: "300" }])).toMatchObject({ ok: false });
  });

  it("refuses content of another type", () => {
    expect(parseDraft({ type: "uniform", rate: "1" }, increasing, KES).ok).toBe(false);
  });

  it("round-trips stored content through a draft", () => {
    const content = { type: "increasing_block", bands: [{ from: 0, to: 6, rate: 5000n }, { from: 6, to: null, rate: 8250n }] } as const;
    const draft = draftFromContent({ type: content.type, bands: content.bands.map((b) => ({ ...b })) }, KES);
    expect(draft).toEqual({ type: "increasing_block", bands: [{ to: "6", rate: "50.00" }, { to: "", rate: "82.50" }] });
    expect(parseDraft(draft, increasing, KES)).toMatchObject({ ok: true, content: { bands: content.bands } });
  });

  it("adds and removes bands keeping the last one open", () => {
    const two = [{ to: "10", rate: "50" }, { to: "", rate: "60" }];
    expect(addBand(two)).toEqual([{ to: "10", rate: "50" }, { to: "20", rate: "60" }, { to: "", rate: "60" }]);
    expect(addBand([{ to: "", rate: "50" }])).toEqual([{ to: "10", rate: "50" }, { to: "", rate: "50" }]);
    expect(removeBand(addBand(two), 1)).toEqual([{ to: "10", rate: "50" }, { to: "", rate: "60" }]);
    expect(removeBand([{ to: "", rate: "1" }], 0)).toHaveLength(1);
    expect(emptyDraft(increasing)).toMatchObject({ type: "increasing_block" });
  });

  it("prices a reading across bands exactly", () => {
    const bands = [{ from: 0, to: 6, rate: 5000n }, { from: 6, to: 20, rate: 8250n }, { from: 20, to: null, rate: 12000n }];
    expect(chargeForUnits(bands, 0)).toBe(0n);
    expect(chargeForUnits(bands, 6)).toBe(30000n);
    expect(chargeForUnits(bands, 8)).toBe(30000n + 2n * 8250n);
    expect(chargeForUnits(bands, 25)).toBe(30000n + 14n * 8250n + 5n * 12000n);
  });
});

describe("the form mirrors agree with the API's rules", () => {
  const cases: { shape: { type: "increasing_block" | "decreasing_block" | "uniform" | "flat_rate"; flatBasis: "none" | "taps" | "property" }; draft: ContentDraft }[] = [
    { shape: { type: "increasing_block", flatBasis: "none" }, draft: { type: "increasing_block", bands: [{ to: "6", rate: "50" }, { to: "20", rate: "82.5" }, { to: "", rate: "120" }] } },
    { shape: { type: "increasing_block", flatBasis: "none" }, draft: { type: "increasing_block", bands: [{ to: "6", rate: "90" }, { to: "", rate: "80" }] } },
    { shape: { type: "decreasing_block", flatBasis: "none" }, draft: { type: "decreasing_block", bands: [{ to: "6", rate: "50" }, { to: "", rate: "80" }] } },
    { shape: { type: "decreasing_block", flatBasis: "none" }, draft: { type: "decreasing_block", bands: [{ to: "6", rate: "80" }, { to: "", rate: "50" }] } },
    { shape: { type: "increasing_block", flatBasis: "none" }, draft: { type: "increasing_block", bands: [{ to: "", rate: "50" }] } },
    { shape: { type: "increasing_block", flatBasis: "none" }, draft: { type: "increasing_block", bands: [{ to: "6", rate: "50" }] } },
    { shape: { type: "flat_rate", flatBasis: "taps" }, draft: { type: "flat_rate", amounts: [{ key: "1", amount: "300" }, { key: "2", amount: "500" }] } },
    { shape: { type: "flat_rate", flatBasis: "taps" }, draft: { type: "flat_rate", amounts: [{ key: "x", amount: "300" }, { key: "x", amount: "500" }] } },
    { shape: { type: "flat_rate", flatBasis: "none" }, draft: { type: "flat_rate", amounts: [{ key: "", amount: "300" }] } },
    { shape: { type: "flat_rate", flatBasis: "property" }, draft: { type: "flat_rate", amounts: [{ key: "", amount: "300" }] } },
    { shape: { type: "uniform", flatBasis: "none" }, draft: { type: "uniform", rate: "75" } },
  ];
  /** The content the draft means, built without the form mirror, as the API receives it. */
  function structural(shape: { type: string; flatBasis: string }, draft: ContentDraft) {
    const money = (text: string) => parseAmount(text, KES, { allowZero: true })!;
    if (draft.type === "uniform") return { type: "uniform", rate: money(draft.rate) };
    if (draft.type === "flat_rate") return { type: "flat_rate", amounts: draft.amounts.map((a) => ({ key: shape.flatBasis === "none" || a.key === "" ? null : a.key, amount: money(a.amount) })) };
    let from = 0;
    return {
      type: draft.type,
      bands: draft.bands.map((b) => {
        const to = b.to === "" ? null : Number(b.to);
        const band = { from, to, rate: money(b.rate) };
        from = to ?? from;
        return band;
      }),
    };
  }

  it.each(cases.map((c, i) => [i, c] as const))("case %i: same verdict and same problems as validateTariffContent", (_i, { shape, draft }) => {
    const mine = parseDraft(draft, shape, KES);
    const api = validateTariffContent(shape, structural(shape, draft));
    expect(mine.ok).toBe(api.ok);
    if (!mine.ok && !api.ok) expect(mine.problems).toEqual(api.problems);
  });

  it("previews effective dates the way planEffectiveDate decides", () => {
    const next = { today: "2027-01-15", effectiveFrom: "2027-02-01", periodStartDay: 1, closedThrough: "2026-12-31" };
    const policy = { periodStartDay: 1 };
    for (const typed of ["", "2027-02-01", "2027-01-15", "2027-01-10", "2026-12-31", "2026-11-30", "2027-03-01"]) {
      for (const existing of [[], ["2027-02-01"], ["2027-01-15"], ["2027-01-10"]]) {
        for (const first of [false, true]) {
          const plan = planEffectiveDate({ ...(typed ? { requested: typed } : {}), today: next.today, policy, closedThrough: next.closedThrough, existing, first });
          const preview = previewEffectiveDate({ typed, next, existing, first });
          expect(preview.kind === "refused").toBe(!plan.ok);
          if (plan.ok) expect(preview).toMatchObject({ date: plan.effectiveFrom });
          if (!plan.ok && preview.kind === "refused") expect(preview.reason).toBe(plan.reason);
        }
      }
    }
  });

  it("offers the overdue actions the API allows", () => {
    for (const appliesTo of ["application", "account"] as const) expect([...allowedOverdueActions(appliesTo)].sort()).toEqual([...apiAllowed(appliesTo)].sort());
    expect(allowedOverdueActions("application")).not.toContain("disconnect");
  });
});

describe("effective date preview (T-03)", () => {
  const next = { today: "2027-01-15", effectiveFrom: "2027-02-01", periodStartDay: 1, closedThrough: "2026-12-31" };
  it("says when the default takes effect", () => {
    expect(previewEffectiveDate({ typed: "", next, existing: [] }).message).toBe("Takes effect on 1 Feb 2027, the next billing period start (the 1st of the month).");
    expect(previewEffectiveDate({ typed: "", next, existing: [], first: true }).message).toBe("Takes effect today, 15 Jan 2027.");
  });
  it("refuses a closed period and an arrived version's date plainly", () => {
    expect(previewEffectiveDate({ typed: "2026-12-01", next, existing: [] })).toMatchObject({ kind: "refused", reason: "closed_period", message: expect.stringContaining("closed through 31 Dec 2026") });
    expect(previewEffectiveDate({ typed: "2027-01-10", next, existing: ["2027-01-10"] })).toMatchObject({ kind: "refused", reason: "already_in_force" });
  });
  it("says a still-ahead version on that date is replaced", () => {
    expect(previewEffectiveDate({ typed: "2027-03-01", next, existing: ["2027-03-01"] })).toMatchObject({ kind: "replaces" });
  });
  it("formats dates and ordinals", () => {
    expect(plainDate("2027-02-01")).toBe("1 Feb 2027");
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 28].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "28th"]);
  });
});

describe("version timeline (T-01, T-03)", () => {
  const versions = [
    { versionNo: 1, effectiveFrom: "2026-01-01", until: "2026-07-01" },
    { versionNo: 2, effectiveFrom: "2026-07-01", until: "2027-02-01" },
    { versionNo: 3, effectiveFrom: "2027-02-01", until: "2027-03-01" },
    { versionNo: 4, effectiveFrom: "2027-03-01", until: null },
  ];
  it("tells in force, scheduled and superseded apart", () => {
    const today = "2027-01-15";
    expect(versions.map((v) => versionStatus(v, today))).toEqual(["past", "in_force", "scheduled", "scheduled"]);
  });
  it("calls a version that covers no days replaced", () => {
    expect(versionStatus({ effectiveFrom: "2027-03-01", until: "2027-03-01" }, "2027-01-15")).toBe("replaced");
  });
  it("lists newest first and finds the version in force and the next scheduled", () => {
    const t = versionTimeline(versions, "2027-01-15");
    expect(t.entries.map((e) => e.version.versionNo)).toEqual([4, 3, 2, 1]);
    expect(t.inForce?.version.versionNo).toBe(2);
    expect(t.next?.version.versionNo).toBe(3);
  });
  it("has no version in force before the first starts", () => {
    const t = versionTimeline([{ versionNo: 1, effectiveFrom: "2027-02-01", until: null }], "2027-01-15");
    expect(t.inForce).toBeNull();
    expect(t.next?.version.versionNo).toBe(1);
  });
  it("picks the version in force on a date, the higher number winning a shared date", () => {
    const shared = [{ versionNo: 1, effectiveFrom: "2026-01-01" }, { versionNo: 2, effectiveFrom: "2026-06-01" }, { versionNo: 3, effectiveFrom: "2026-06-01" }];
    expect(inForceOn(shared, "2026-06-01")?.versionNo).toBe(3);
    expect(inForceOn(shared, "2026-05-31")?.versionNo).toBe(1);
    expect(inForceOn(shared, "2025-12-31")).toBeNull();
  });
});

describe("content tables", () => {
  it("names bands by the units they cover", () => {
    const rows = bandRows([{ from: 0, to: 6, rate: 5000n }, { from: 6, to: 7, rate: 6000n }, { from: 7, to: null, rate: 7000n }]);
    expect(rows.map((r) => r.range)).toEqual(["Units 1 to 6", "Unit 7", "Units 8 and over"]);
  });
  it("makes a table for each kind of content", () => {
    expect(contentTable({ type: "uniform", rate: 7500n }, "none")).toEqual({ kind: "uniform", rate: 7500n });
    expect(contentTable({ type: "flat_rate", amounts: [{ key: null, amount: 100n }] }, "none")).toEqual({ kind: "flat", rows: [{ key: "Every account", amount: 100n }] });
    expect(contentTable({ type: "increasing_block", bands: [{ from: 0, to: null, rate: 1n }] }, "none").kind).toBe("bands");
  });
});

describe("category assignment (T-02)", () => {
  const current = { tariffId: "t1", standingChargeItemId: "s1", meterRentItemId: null, discountItemId: null };
  it("sends only what changes: keep is left out, none is null", () => {
    expect(assignmentInput(keepAll)).toEqual({});
    expect(assignmentInput({ ...keepAll, tariffId: "t2", discountItemId: "" })).toEqual({ tariffId: "t2", discountItemId: null });
  });
  it("sees whether anything would change", () => {
    expect(assignmentChanged(keepAll, current)).toBe(false);
    expect(assignmentChanged({ ...keepAll, tariffId: "t1" }, current)).toBe(false);
    expect(assignmentChanged({ ...keepAll, tariffId: "t2" }, current)).toBe(true);
    expect(assignmentChanged({ ...keepAll, standingChargeItemId: "" }, current)).toBe(true);
    expect(assignmentChanged({ ...keepAll, meterRentItemId: "" }, current)).toBe(false);
  });
  it("describes the carry-over for each of the four", () => {
    const names: Record<string, string> = { t1: "Domestic", t2: "Commercial", s1: "Standing" };
    const out = assignmentOutcome({ ...keepAll, tariffId: "t2", standingChargeItemId: "" }, current, (_k, id) => names[id] ?? id);
    expect(out.map((o) => [o.key, o.kind, o.after])).toEqual([
      ["tariffId", "changed", "Commercial"],
      ["standingChargeItemId", "cleared", "none"],
      ["meterRentItemId", "kept", "none"],
      ["discountItemId", "kept", "none"],
    ]);
    expect(KEEP).toBe("__keep");
  });
});

describe("invoice type forms (T-08 to T-10)", () => {
  const view: InvoiceTypeView = {
    name: "New connection",
    appliesTo: "application",
    numbering: { prefix: "NC-", width: 6, start: 1 },
    dueDays: 14,
    terms: { kind: "minimum_deposit", percentBp: 2500 },
    overdue: { action: "pause_application", afterDays: 7 },
    active: true,
  };
  it("round-trips a type through its form", () => {
    const form = formFromType(view, KES);
    expect(form).toMatchObject({ termsKind: "minimum_deposit", depositBasis: "percent", depositPercent: "25", overdueAction: "pause_application" });
    const back = updateFromForm(form, "application", KES);
    expect(back).toEqual({ ok: true, input: { name: "New connection", numbering: view.numbering, dueDays: 14, terms: view.terms, overdue: view.overdue, active: true } });
  });
  it("reads a fixed deposit and installments as minor units and counts", () => {
    const form = formFromType({ ...view, terms: { kind: "minimum_deposit", amount: 150000n } }, KES);
    expect(form.depositAmount).toBe("1500.00");
    expect(updateFromForm(form, "application", KES)).toMatchObject({ ok: true, input: { terms: { kind: "minimum_deposit", amount: 150000n } } });
    const inst = { ...formFromType(view, KES), termsKind: "installments" as const, installmentCount: "3", installmentInterval: "30" };
    expect(updateFromForm(inst, "application", KES)).toMatchObject({ ok: true, input: { terms: { kind: "installments", count: 3, intervalDays: 30 } } });
  });
  it("never lets an application's invoice disconnect", () => {
    const form = { ...formFromType(view, KES), overdueAction: "disconnect" as const };
    expect(updateFromForm(form, "application", KES)).toMatchObject({ ok: false });
    expect(updateFromForm(form, "account", KES)).toMatchObject({ ok: true });
  });
  it("lists what is wrong", () => {
    const form = { ...formFromType(view, KES), name: " ", width: "0", dueDays: "x", depositPercent: "150" };
    const result = updateFromForm(form, "application", KES);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems).toHaveLength(4);
  });
  it("converts percentages to basis points and back", () => {
    expect(parsePercentBp("25")).toBe(2500);
    expect(parsePercentBp("12.5")).toBe(1250);
    expect(parsePercentBp("0")).toBeNull();
    expect(parsePercentBp("100.01")).toBeNull();
    expect([2500, 1250, 1, 10].map(percentText)).toEqual(["25", "12.5", "0.01", "0.1"]);
  });
  it("maps template lines and refuses a repeated item", () => {
    const ok = linesFromDrafts([{ chargeItemCode: "connection_fee", quantity: "1", amountOverride: "", optional: false }, { chargeItemCode: "deposit", quantity: "2", amountOverride: "500", optional: true }], KES);
    expect(ok).toEqual({
      ok: true,
      input: [
        { chargeItemCode: "connection_fee", quantity: 1, amountOverride: null, optional: false },
        { chargeItemCode: "deposit", quantity: 2, amountOverride: 50000n, optional: true },
      ],
    });
    expect(linesFromDrafts([{ chargeItemCode: "a", quantity: "1", amountOverride: "", optional: false }, { chargeItemCode: "a", quantity: "1", amountOverride: "", optional: false }], KES).ok).toBe(false);
    expect(linesFromDrafts([{ chargeItemCode: "", quantity: "0", amountOverride: "", optional: false }], KES).ok).toBe(false);
  });
  it("maps a late-fee rule, or none when switched off", () => {
    expect(lateFeeFromDraft(lateFeeDraft(null, KES), KES)).toEqual({ ok: true, input: { rule: null } });
    const rule = { triggerDays: 14, base: "invoice_total" as const, rateBp: 500, flatAmount: null, cap: 200000n, frequency: "monthly" as const };
    const draft = lateFeeDraft(rule, KES);
    expect(draft).toMatchObject({ enabled: true, mode: "rate", percent: "5", cap: "2000.00" });
    expect(lateFeeFromDraft(draft, KES)).toEqual({ ok: true, input: { rule } });
    const flat = lateFeeFromDraft({ ...draft, mode: "flat", flatAmount: "500" }, KES);
    expect(flat).toMatchObject({ ok: true, input: { rule: { rateBp: null, flatAmount: 50000n } } });
    expect(lateFeeFromDraft({ ...draft, mode: "flat", flatAmount: "" }, KES).ok).toBe(false);
  });
});

describe("invoice type descriptions", () => {
  it("describes terms, overdue policy and late fee in a line", () => {
    expect(termsText({ kind: "full" }, KES)).toBe("Paid in full");
    expect(termsText({ kind: "minimum_deposit", percentBp: 2500 }, KES)).toBe("Deposit of 25% first");
    expect(termsText({ kind: "minimum_deposit", amount: 150000n }, KES)).toBe("Deposit of KES 1500.00 first");
    expect(termsText({ kind: "installments", count: 3, intervalDays: 30 }, KES)).toBe("3 installments, 30 days apart");
    expect(overdueText({ action: "none", afterDays: 0 })).toBe("Nothing happens");
    expect(overdueText({ action: "pause_application", afterDays: 1 })).toBe("Pause the application 1 day after it");
    expect(overdueText({ action: "disconnect", afterDays: 0 })).toBe("Disconnect on the due date");
    expect(lateFeeText(null, KES)).toBe("No late fee");
    expect(lateFeeText({ triggerDays: 7, base: "overdue_balance", rateBp: 500, flatAmount: null, cap: null, frequency: "monthly" }, KES)).toBe("5% of the overdue balance every 30 days, from 7 days overdue");
  });
});
