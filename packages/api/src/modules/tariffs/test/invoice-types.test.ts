import { withTenant } from "@flowless/db";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allocateInvoiceNumber } from "../index";
import { expectCode, setupTariffsEnv, type TariffsEnv } from "./test-support";

let env: TariffsEnv;
beforeAll(async () => {
  env = await setupTariffsEnv();
  for (const [code, type] of [
    ["application_fee", "fee"],
    ["connection_fee", "fee"],
    ["meter", "material"],
    ["materials", "material"],
    ["labour", "labour"],
    ["deposit", "deposit"],
  ] as const) {
    await env.admin.tariffs.chargeItems.create({ code, name: code, type });
  }
});
afterAll(() => env?.t.stop());

let n = 0;
const code = () => `type_${++n}`;
const make = (over: Record<string, unknown> = {}) => env.admin.tariffs.invoiceTypes.create({ code: code(), name: "Invoice type", appliesTo: "account", ...over } as never);
const allocate = (org: string, typeId: string) => withTenant(env.pool.db, org, (tx) => allocateInvoiceNumber(tx, org, typeId));

// T-08: an invoice type has numbering, terms and a typed line template.
describe("invoice types (T-08)", () => {
  it("creates a type with defaults: payable in full, 14 days, no overdue action", async () => {
    const type = await make();
    expect(type).toMatchObject({
      appliesTo: "account",
      numbering: { prefix: "", width: 6, start: 1 },
      dueDays: 14,
      terms: { kind: "full" },
      overdue: { action: "none", afterDays: 0 },
      lines: [],
      lateFeeRule: null,
      active: true,
    });
    expect((await env.clerk().tariffs.invoiceTypes.get({ id: type.id })).nextNumber).toBe("000001");
  });

  it("carries a new-connection template of charge items by code, in order, configurable", async () => {
    const lines = ["application_fee", "connection_fee", "meter", "materials", "labour", "deposit"].map((chargeItemCode) => ({ chargeItemCode }));
    const type = await make({ appliesTo: "application", overdue: { action: "pause_application", afterDays: 7 }, lines });
    expect(type.lines.map((l) => [l.position, l.code, l.quantity, l.optional, l.amountOverride])).toEqual([
      [0, "application_fee", 1, false, null],
      [1, "connection_fee", 1, false, null],
      [2, "meter", 1, false, null],
      [3, "materials", 1, false, null],
      [4, "labour", 1, false, null],
      [5, "deposit", 1, false, null],
    ]);
    const changed = await env.admin.tariffs.invoiceTypes.setLines({
      id: type.id,
      lines: [{ chargeItemCode: "connection_fee", quantity: 2, amountOverride: 250_000n }, { chargeItemCode: "deposit", optional: true }],
    });
    expect(changed.lines.map((l) => [l.code, l.quantity, l.amountOverride, l.optional])).toEqual([["connection_fee", 2, 250_000n, false], ["deposit", 1, null, true]]);
    const audit = (await env.audit(type.id)).find((e) => e.action === "tariffs.invoice_type_lines_set")!;
    expect((audit.before as unknown[]).length).toBe(6);
    expect((audit.after as { amountOverride: string | null }[])[0]!.amountOverride).toBe("250000");
    expect((await env.events(env.orgA, "tariffs.invoice_type_changed")).filter((e) => e.invoiceTypeId === type.id).map((e) => e.change)).toEqual(["created", "lines_set"]);
  });

  it("refuses a template line for a missing or inactive item, or one used twice", async () => {
    const type = await make();
    await expectCode(env.admin.tariffs.invoiceTypes.setLines({ id: type.id, lines: [{ chargeItemCode: "no_such_item" }] }), "BAD_REQUEST", /no charge item/);
    await expectCode(env.admin.tariffs.invoiceTypes.setLines({ id: type.id, lines: [{ chargeItemCode: "meter" }, { chargeItemCode: "meter" }] }), "BAD_REQUEST", /once/);
    const item = await env.admin.tariffs.chargeItems.create({ code: "retired", name: "Retired", type: "fee" });
    await env.admin.tariffs.chargeItems.deactivate({ id: item.id });
    await expectCode(env.admin.tariffs.invoiceTypes.setLines({ id: type.id, lines: [{ chargeItemCode: "retired" }] }), "BAD_REQUEST", /not active/);
    // Failed calls leave the template as it was.
    await env.admin.tariffs.invoiceTypes.setLines({ id: type.id, lines: [{ chargeItemCode: "meter" }] });
    await expectCode(env.admin.tariffs.invoiceTypes.setLines({ id: type.id, lines: [{ chargeItemCode: "labour" }, { chargeItemCode: "no_such_item" }] }), "BAD_REQUEST");
    expect((await env.admin.tariffs.invoiceTypes.get({ id: type.id })).lines.map((l) => l.code)).toEqual(["meter"]);
  });

  it("keeps codes unique per organization", async () => {
    const c = code();
    await make({ code: c });
    await expectCode(make({ code: c }), "CONFLICT", /already exists/);
    await expect(env.outsider().tariffs.invoiceTypes.create({ code: c, name: "Theirs", appliesTo: "account" })).resolves.toBeTruthy();
  });
});

// T-09: payment terms and the overdue policy per invoice type.
describe("payment terms and overdue policy (T-09)", () => {
  it("stores each kind of terms with its own parameters", async () => {
    expect((await make({ terms: { kind: "minimum_deposit", percentBp: 3000 } })).terms).toEqual({ kind: "minimum_deposit", percentBp: 3000 });
    expect((await make({ terms: { kind: "minimum_deposit", amount: 500_000n } })).terms).toEqual({ kind: "minimum_deposit", amount: 500_000n });
    expect((await make({ terms: { kind: "installments", count: 4, intervalDays: 30 } })).terms).toEqual({ kind: "installments", count: 4, intervalDays: 30 });
  });

  it("rejects incomplete terms", async () => {
    await expectCode(make({ terms: { kind: "minimum_deposit" } }), "BAD_REQUEST", /percentage or a fixed amount/);
    await expectCode(make({ terms: { kind: "minimum_deposit", percentBp: 3000, amount: 5n } }), "BAD_REQUEST", /not both/);
    await expectCode(make({ terms: { kind: "installments", count: 1, intervalDays: 30 } }), "BAD_REQUEST");
    await expectCode(make({ terms: { kind: "installments", count: 3 } }), "BAD_REQUEST");
    await expectCode(make({ terms: { kind: "minimum_deposit", percentBp: 10_001 } }), "BAD_REQUEST");
  });

  it("changes terms by update and clears the parameters of the old kind", async () => {
    const type = await make({ terms: { kind: "installments", count: 3, intervalDays: 30 } });
    const updated = await env.admin.tariffs.invoiceTypes.update({ id: type.id, terms: { kind: "minimum_deposit", percentBp: 5000 }, dueDays: 30, name: "Renamed" });
    expect(updated).toMatchObject({ terms: { kind: "minimum_deposit", percentBp: 5000 }, dueDays: 30, name: "Renamed" });
    expect((await env.admin.tariffs.invoiceTypes.update({ id: type.id, terms: { kind: "full" } })).terms).toEqual({ kind: "full" });
    const audit = await env.audit(type.id);
    expect(audit.filter((e) => e.action === "tariffs.invoice_type_update")).toHaveLength(2);
  });

  it("never lets an application's invoice trigger disconnection, and keeps pause or cancel for applications", async () => {
    await expectCode(make({ appliesTo: "application", overdue: { action: "disconnect", afterDays: 0 } }), "BAD_REQUEST", /never disconnects/);
    for (const action of ["pause_application", "cancel_application", "none"] as const) {
      expect((await make({ appliesTo: "application", overdue: { action, afterDays: 5 } })).overdue).toEqual({ action, afterDays: 5 });
    }
    expect((await make({ appliesTo: "account", overdue: { action: "disconnect", afterDays: 30 } })).overdue).toEqual({ action: "disconnect", afterDays: 30 });
    await expectCode(make({ appliesTo: "account", overdue: { action: "cancel_application", afterDays: 0 } }), "BAD_REQUEST");
    // The same rule holds when an existing type is updated.
    const app = await make({ appliesTo: "application" });
    await expectCode(env.admin.tariffs.invoiceTypes.update({ id: app.id, overdue: { action: "disconnect", afterDays: 1 } }), "BAD_REQUEST", /never disconnects/);
    expect((await env.admin.tariffs.invoiceTypes.get({ id: app.id })).overdue.action).toBe("none");
  });
});

// T-10: late-fee rules and their simulation.
describe("late-fee rules (T-10)", () => {
  const rule = { triggerDays: 7, base: "overdue_balance" as const, rateBp: 500, frequency: "monthly" as const, cap: 20_000n };

  it("sets, replaces and removes a rule, audited", async () => {
    const type = await make();
    const set = await env.admin.tariffs.invoiceTypes.setLateFeeRule({ id: type.id, rule });
    expect(set.lateFeeRule).toEqual({ ...rule, flatAmount: null });
    const flat = await env.admin.tariffs.invoiceTypes.setLateFeeRule({ id: type.id, rule: { triggerDays: 0, base: "invoice_total", flatAmount: 10_000n, frequency: "once" } });
    expect(flat.lateFeeRule).toEqual({ triggerDays: 0, base: "invoice_total", rateBp: null, flatAmount: 10_000n, cap: null, frequency: "once" });
    expect((await env.admin.tariffs.invoiceTypes.setLateFeeRule({ id: type.id, rule: null })).lateFeeRule).toBeNull();
    expect((await env.audit(type.id)).filter((e) => e.action === "tariffs.invoice_type_late_fee_rule_set")).toHaveLength(3);
  });

  it("rejects a rule with both or neither of a rate and a flat amount", async () => {
    const type = await make();
    await expectCode(env.admin.tariffs.invoiceTypes.setLateFeeRule({ id: type.id, rule: { ...rule, flatAmount: 5n } }), "BAD_REQUEST");
    await expectCode(env.admin.tariffs.invoiceTypes.setLateFeeRule({ id: type.id, rule: { triggerDays: 7, base: "overdue_balance", frequency: "once" } as never }), "BAD_REQUEST");
  });

  it("creates a type with its rule in one call", async () => {
    const type = await make({ lateFeeRule: rule });
    expect(type.lateFeeRule).toMatchObject({ rateBp: 500, cap: 20_000n });
  });

  it("simulates a type's saved rule, a draft rule, and a manual-only rule", async () => {
    const type = await make({ lateFeeRule: rule });
    const saved = await env.clerk().tariffs.simulateLateFee({ invoiceTypeId: type.id, balance: 100_000n, daysOverdue: 40, alreadyCharged: 0n });
    expect(saved).toMatchObject({ amount: 10_000n, applications: 2, reason: "charged" });
    const capped = await env.clerk().tariffs.simulateLateFee({ invoiceTypeId: type.id, balance: 100_000n, daysOverdue: 200, alreadyCharged: 15_000n });
    expect(capped).toMatchObject({ amount: 5_000n, reason: "capped" });
    const draft = await env.clerk().tariffs.simulateLateFee({ rule: { ...rule, frequency: "manual_only", cap: null }, balance: 100_000n, daysOverdue: 40 });
    expect(draft).toMatchObject({ amount: 0n, suggested: 5_000n, reason: "manual_only" });
    const total = await env.clerk().tariffs.simulateLateFee({ rule: { ...rule, base: "invoice_total", frequency: "once", cap: null }, balance: 20_000n, invoiceTotal: 100_000n, daysOverdue: 10 });
    expect(total.amount).toBe(5_000n);
    await expectCode(env.clerk().tariffs.simulateLateFee({ balance: 1n, daysOverdue: 1 } as never), "BAD_REQUEST");
    await expectCode(env.clerk().tariffs.simulateLateFee({ invoiceTypeId: (await make()).id, balance: 1n, daysOverdue: 1 }), "BAD_REQUEST", /no late-fee rule/);
  });

  it("writes nothing when simulating", async () => {
    const type = await make({ lateFeeRule: rule });
    const before = (await env.audit(type.id)).length;
    await env.admin.tariffs.simulateLateFee({ invoiceTypeId: type.id, balance: 1_000n, daysOverdue: 30 });
    expect((await env.audit(type.id)).length).toBe(before);
  });
});

// T-08: invoice numbers come from a concurrency-safe counter per type.
describe("allocateInvoiceNumber (T-08)", () => {
  it("numbers from the type's start with its prefix and width, one after another", async () => {
    const type = await make({ numbering: { prefix: "INV-", width: 6, start: 100 } });
    expect((await allocate(env.orgA, type.id)).number).toBe("INV-000100");
    expect(await allocate(env.orgA, type.id)).toMatchObject({ number: "INV-000101", sequence: 101 });
    expect((await env.admin.tariffs.invoiceTypes.get({ id: type.id })).nextNumber).toBe("INV-000102");
  });

  it("gives parallel allocations distinct, consecutive numbers (a locked counter, never MAX+1)", async () => {
    const type = await make({ numbering: { prefix: "P-", width: 4, start: 1 } });
    const numbers = await Promise.all(Array.from({ length: 24 }, () => allocate(env.orgA, type.id)));
    expect(new Set(numbers.map((x) => x.number)).size).toBe(24);
    expect(numbers.map((x) => x.sequence).sort((a, b) => a - b)).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
  });

  it("gives a rolled-back allocation its number back", async () => {
    const type = await make({ numbering: { prefix: "R-", width: 3, start: 1 } });
    await expect(
      withTenant(env.pool.db, env.orgA, async (tx) => {
        await allocateInvoiceNumber(tx, env.orgA, type.id);
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect((await allocate(env.orgA, type.id)).number).toBe("R-001");
  });

  it("skips ahead when the start is raised and never goes back when it is lowered", async () => {
    const type = await make({ numbering: { prefix: "S-", width: 3, start: 1 } });
    await allocate(env.orgA, type.id);
    await env.admin.tariffs.invoiceTypes.update({ id: type.id, numbering: { start: 500 } });
    expect((await allocate(env.orgA, type.id)).number).toBe("S-500");
    await env.admin.tariffs.invoiceTypes.update({ id: type.id, numbering: { start: 1 } });
    expect((await allocate(env.orgA, type.id)).number).toBe("S-501");
  });

  it("refuses another organization's type and an inactive one", async () => {
    const mine = await make();
    await expect(allocate(env.orgB, mine.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(allocate(env.orgA, randomUUID())).rejects.toMatchObject({ code: "NOT_FOUND" });
    await env.admin.tariffs.invoiceTypes.update({ id: mine.id, active: false });
    await expect(allocate(env.orgA, mine.id)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("keeps counters separate per type and per organization", async () => {
    const a = await make({ numbering: { prefix: "A-", width: 2, start: 1 } });
    const b = await make({ numbering: { prefix: "B-", width: 2, start: 1 } });
    const theirs = await env.outsider().tariffs.invoiceTypes.create({ code: code(), name: "Theirs", appliesTo: "account", numbering: { prefix: "A-", width: 2, start: 1 } });
    expect((await allocate(env.orgA, a.id)).number).toBe("A-01");
    expect((await allocate(env.orgA, b.id)).number).toBe("B-01");
    expect((await allocate(env.orgB, theirs.id)).number).toBe("A-01");
    expect((await allocate(env.orgA, a.id)).number).toBe("A-02");
  });
});

describe("invoice type permissions and tenancy", () => {
  it("lets a clerk read and simulate, but not change", async () => {
    const type = await make({ lateFeeRule: { triggerDays: 1, base: "overdue_balance", rateBp: 100, frequency: "once" } });
    await expect(env.clerk().tariffs.invoiceTypes.list()).resolves.toBeTruthy();
    await expect(env.clerk().tariffs.invoiceTypes.get({ code: type.code })).resolves.toMatchObject({ id: type.id });
    await expectCode(env.clerk().tariffs.invoiceTypes.create({ code: code(), name: "No", appliesTo: "account" }), "FORBIDDEN");
    await expectCode(env.clerk().tariffs.invoiceTypes.update({ id: type.id, name: "No" }), "FORBIDDEN");
    await expectCode(env.clerk().tariffs.invoiceTypes.setLines({ id: type.id, lines: [] }), "FORBIDDEN");
    await expectCode(env.clerk().tariffs.invoiceTypes.setLateFeeRule({ id: type.id, rule: null }), "FORBIDDEN");
    await expectCode(env.cashier().tariffs.invoiceTypes.list(), "FORBIDDEN");
    await expectCode(env.cashier().tariffs.simulateLateFee({ rule: { triggerDays: 1, base: "overdue_balance", rateBp: 100, frequency: "once" }, balance: 1n, daysOverdue: 5 }), "FORBIDDEN");
  });

  it("does not show or change another organization's types", async () => {
    const mine = await make();
    expect((await env.outsider().tariffs.invoiceTypes.list()).map((t) => t.id)).not.toContain(mine.id);
    await expectCode(env.outsider().tariffs.invoiceTypes.get({ id: mine.id }), "NOT_FOUND");
    await expectCode(env.outsider().tariffs.invoiceTypes.update({ id: mine.id, name: "x" }), "NOT_FOUND");
    await expectCode(env.outsider().tariffs.invoiceTypes.setLines({ id: mine.id, lines: [] }), "NOT_FOUND");
    await expectCode(env.outsider().tariffs.invoiceTypes.setLateFeeRule({ id: mine.id, rule: null }), "NOT_FOUND");
    await expectCode(env.bare().tariffs.invoiceTypes.list(), "NOT_FOUND", /not licensed/);
  });
});
