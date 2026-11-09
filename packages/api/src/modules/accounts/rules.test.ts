import { CHARGE_TYPES, COMMERCIAL_STATUSES, SERVICE_STATES } from "@flowless/shared-types";
import { describe, expect, it } from "vitest";
import { activationConfigSchema, evaluateGates, hasPaymentGate, type ActivationConfig } from "./gates";
import { activationSetting, statusRulesSetting } from "./settings";
import { chargesApplying, chargeTypeApplies, statusRuleCellSchema, statusRulesSchema, statusRuleTable } from "./status-rules";
import { settleTermination, WRITE_OFF_KIND, type Position, type WriteOff } from "./termination";

const config = (patch: Record<string, unknown> = {}): ActivationConfig => activationConfigSchema.parse({ ...patch });

// C-06: activation gates.
describe("evaluateGates (C-06)", () => {
  it("defaults to checklist mode, three required gates and 14 stale days", () => {
    const c = config();
    expect(c).toMatchObject({ mode: "checklist", staleAfterDays: 14, officeChecklist: [] });
    expect(c.gates.payment_threshold).toMatchObject({ enabled: true, required: true, basis: "percent", percent: 100 });
    expect(hasPaymentGate(c)).toBe(true);
    expect(activationSetting.default).toEqual(c);
  });

  it("with no sources, a gate is met only by its checklist tick", () => {
    const none = evaluateGates(config(), {}, {});
    expect(none.ready).toBe(false);
    expect(none.unmet).toEqual(["payment_threshold", "meter_installed", "initial_reading"]);
    expect(none.gates.every((g) => g.via === "checklist" && g.state === "unmet")).toBe(true);
    const some = evaluateGates(config(), { payment_threshold: null }, { payment_threshold: true, meter_installed: true });
    expect(some.unmet).toEqual(["initial_reading"]);
    expect(evaluateGates(config(), {}, { payment_threshold: true, meter_installed: true, initial_reading: true }).ready).toBe(true);
  });

  it("takes a source's answer over a tick", () => {
    const e = evaluateGates(config(), { meter_installed: { met: false, detail: "Awaiting inventory confirmation" } }, { meter_installed: true });
    expect(e.gates.find((g) => g.key === "meter_installed")).toMatchObject({ state: "unmet", via: "source", detail: "Awaiting inventory confirmation" });
    const met = evaluateGates(config(), { meter_installed: { met: true } }, {});
    expect(met.gates.find((g) => g.key === "meter_installed")).toMatchObject({ state: "met", via: "source" });
  });

  it("waives a disabled gate and does not hold back for one that is not required", () => {
    const c = config({ gates: { meter_installed: { enabled: false }, initial_reading: { required: false } } });
    const e = evaluateGates(c, {}, { payment_threshold: true });
    expect(e.gates.find((g) => g.key === "meter_installed")).toMatchObject({ state: "waived", via: "disabled", required: false });
    expect(e.gates.find((g) => g.key === "initial_reading")).toMatchObject({ state: "unmet", required: false });
    expect(e.ready).toBe(true);
    expect(e.unmet).toEqual([]);
  });

  it("ignores a source for a disabled gate", () => {
    const c = config({ gates: { meter_installed: { enabled: false } } });
    expect(evaluateGates(c, { meter_installed: { met: false } }, {}).gates.find((g) => g.key === "meter_installed")?.state).toBe("waived");
  });

  it("adds the office's own checklist items, met by their tick alone", () => {
    const c = config({ officeChecklist: [{ key: "site_visit", label: "Site visit signed off" }, { key: "id_copy", label: "ID copy filed", required: false }] });
    const open = evaluateGates(c, { site_visit: { met: true } }, { payment_threshold: true, meter_installed: true, initial_reading: true });
    expect(open.unmet).toEqual(["site_visit"]);
    expect(open.gates.find((g) => g.key === "site_visit")).toMatchObject({ kind: "office", via: "checklist", state: "unmet" });
    expect(evaluateGates(c, {}, { payment_threshold: true, meter_installed: true, initial_reading: true, site_visit: true }).ready).toBe(true);
  });

  it("is ready when every gate is disabled", () => {
    const c = config({ gates: { payment_threshold: { enabled: false }, meter_installed: { enabled: false }, initial_reading: { enabled: false } } });
    expect(evaluateGates(c, {}, {}).ready).toBe(true);
    expect(hasPaymentGate(c)).toBe(false);
  });

  it("refuses an office item that reuses a built-in key or another item's key", () => {
    expect(activationConfigSchema.safeParse({ officeChecklist: [{ key: "meter_installed", label: "x" }] }).success).toBe(false);
    expect(activationConfigSchema.safeParse({ officeChecklist: [{ key: "a1", label: "x" }, { key: "a1", label: "y" }] }).success).toBe(false);
    expect(activationConfigSchema.safeParse({ officeChecklist: [{ key: "Bad Key", label: "x" }] }).success).toBe(false);
  });

  it("reads a stored value from an earlier version that lacks later fields", () => {
    expect(activationConfigSchema.parse({ mode: "auto" })).toMatchObject({ mode: "auto", staleAfterDays: 14 });
    expect(activationConfigSchema.parse({ gates: { initial_reading: { enabled: false } } }).gates.initial_reading).toEqual({ enabled: false, required: true });
  });
});

// C-04: charges by status.
describe("chargesApplying (C-04)", () => {
  const rules = statusRulesSetting.default;

  it("bills everything for ACTIVE and CONNECTED", () => {
    expect(chargesApplying(rules, "ACTIVE", "CONNECTED")).toEqual({ billsConsumption: true, chargeTypes: CHARGE_TYPES });
  });

  it("bills standing charges and rent but not usage for ACTIVE and DISCONNECTED", () => {
    const r = chargesApplying(rules, "ACTIVE", "DISCONNECTED");
    expect(r.billsConsumption).toBe(false);
    expect(r.chargeTypes).toContain("recurring");
    expect(r.chargeTypes).not.toContain("usage");
  });

  it("bills nothing for a dormant account", () => {
    for (const service of SERVICE_STATES) expect(chargesApplying(rules, "DORMANT", service)).toEqual({ billsConsumption: false, chargeTypes: [] });
  });

  it("bills nothing recurring or metered for NEW and PENDING_PAYMENT, only one-off connection charges", () => {
    for (const status of ["NEW", "PENDING_PAYMENT"] as const) {
      const r = chargesApplying(rules, status, "DISCONNECTED");
      expect(r.billsConsumption).toBe(false);
      expect(r.chargeTypes).toEqual(expect.arrayContaining(["fee", "deposit", "material", "labour"]));
      expect(r.chargeTypes).not.toContain("recurring");
      expect(r.chargeTypes).not.toContain("usage");
    }
  });

  it("bills only fee, penalty and adjustment once terminated", () => {
    expect(chargesApplying(rules, "TERMINATED", "DISCONNECTED").chargeTypes).toEqual(["fee", "penalty", "adjustment"]);
    expect(chargeTypeApplies(rules, "TERMINATED", "DISCONNECTED", "usage")).toBe(false);
  });

  it("answers for every combination, and the table lists them all", () => {
    expect(statusRuleTable(rules)).toHaveLength(COMMERCIAL_STATUSES.length * SERVICE_STATES.length);
    for (const c of COMMERCIAL_STATUSES) for (const s of SERVICE_STATES) expect(chargesApplying(rules, c, s).billsConsumption).toBe(chargesApplying(rules, c, s).chargeTypes.includes("usage"));
  });

  it("is configuration: an organization turns charges on for dormant accounts", () => {
    const custom = statusRulesSchema.parse({ DORMANT: { CONNECTED: { billsConsumption: false, chargeTypes: ["recurring"] } } });
    expect(chargesApplying(custom, "DORMANT", "CONNECTED").chargeTypes).toEqual(["recurring"]);
    // The rest keeps its defaults (fields added later still read, NF-32).
    expect(chargesApplying(custom, "ACTIVE", "CONNECTED").billsConsumption).toBe(true);
    expect(chargesApplying(custom, "DORMANT", "DISCONNECTED").chargeTypes).toEqual([]);
  });

  it("refuses a cell that lists usage without billing consumption, or the other way round", () => {
    expect(statusRuleCellSchema.safeParse({ billsConsumption: false, chargeTypes: ["usage"] }).success).toBe(false);
    expect(statusRuleCellSchema.safeParse({ billsConsumption: true, chargeTypes: ["recurring"] }).success).toBe(false);
    expect(statusRuleCellSchema.safeParse({ billsConsumption: true, chargeTypes: ["usage", "usage"] }).success).toBe(false);
    expect(statusRuleCellSchema.safeParse({ billsConsumption: true, chargeTypes: ["usage"] }).success).toBe(true);
  });
});

// C-11: termination needs a settled position.
describe("settleTermination (C-11)", () => {
  const accountId = "00000000-0000-4000-8000-000000000001";
  const settled: Position = { finalBillIssued: true, balance: 0n };
  const owing: Position = { finalBillIssued: true, balance: 50_000n };
  const approved = (amount: bigint | null, patch: Partial<WriteOff> = {}): WriteOff => ({ kind: WRITE_OFF_KIND, subjectRef: accountId, status: "approved", amount, ...patch });
  const ask = (position: Position | null, over: Partial<Parameters<typeof settleTermination>[0]> = {}) =>
    settleTermination({ accountId, position, acknowledgeNoLedger: false, writeOff: null, writeOffCited: false, ...over });

  it("accepts a final bill and a zero balance", () => {
    expect(ask(settled)).toEqual({ ok: true, basis: "settled", balance: 0n });
  });

  it("refuses without a final bill, even at zero", () => {
    expect(ask({ finalBillIssued: false, balance: 0n })).toMatchObject({ ok: false });
    expect(ask({ finalBillIssued: false, balance: 100n }, { writeOff: approved(100n), writeOffCited: true })).toMatchObject({ ok: false });
  });

  it("refuses a balance owing unless an approved write-off of this account covers it", () => {
    expect(ask(owing)).toMatchObject({ ok: false });
    expect(ask(owing, { writeOffCited: true, writeOff: approved(50_000n) })).toEqual({ ok: true, basis: "written_off", balance: 50_000n });
    expect(ask(owing, { writeOffCited: true, writeOff: approved(60_000n) })).toMatchObject({ ok: true, basis: "written_off" });
    expect(ask(owing, { writeOffCited: true, writeOff: approved(49_999n) })).toMatchObject({ ok: false });
    expect(ask(owing, { writeOffCited: true, writeOff: approved(null) })).toMatchObject({ ok: false });
    expect(ask(owing, { writeOffCited: true, writeOff: approved(50_000n, { status: "pending" }) })).toMatchObject({ ok: false });
    expect(ask(owing, { writeOffCited: true, writeOff: approved(50_000n, { status: "rejected" }) })).toMatchObject({ ok: false });
    expect(ask(owing, { writeOffCited: true, writeOff: approved(50_000n, { subjectRef: "other" }) })).toMatchObject({ ok: false });
    expect(ask(owing, { writeOffCited: true, writeOff: approved(50_000n, { kind: "payments.rebate" }) })).toMatchObject({ ok: false });
    expect(ask(owing, { writeOffCited: true, writeOff: null })).toMatchObject({ ok: false });
  });

  it("does not write off a credit balance", () => {
    expect(ask({ finalBillIssued: true, balance: -100n }, { writeOffCited: true, writeOff: approved(100n) })).toMatchObject({ ok: false });
  });

  it("with no ledger needs an explicit acknowledgement, and nothing to write off", () => {
    expect(ask(null)).toMatchObject({ ok: false });
    expect(ask(null, { acknowledgeNoLedger: true })).toEqual({ ok: true, basis: "no_ledger", balance: null });
    expect(ask(null, { acknowledgeNoLedger: true, writeOffCited: true, writeOff: approved(1n) })).toMatchObject({ ok: false });
  });
});
