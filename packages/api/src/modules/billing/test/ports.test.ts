import { withTenant } from "@flowless/db";
import { activationConfigSchema } from "@flowless/shared-types";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { systemEnv } from "../../../kernel/action-env";
import { addMember } from "../../../test-support";
import { activationSetting, applicationSetting, recordApplicationInvoiced, recordApplicationPaid } from "../../accounts";
import { balanceTransfer, registerPorts } from "..";
import { expectCode, setupBillingEnv, type BillingEnv } from "./test-support";

/*
 * P4-4: Billing's side of the Accounts and Tariffs ports (C-04, C-05, C-06, C-08, C-11, T-03),
 * on a private database. Org A has Accounts, Tariffs and Billing; org C has no Billing.
 */

let env: BillingEnv;
let zone: string;
let otherZone: string;
let feeItem: string;
beforeAll(async () => {
  env = await setupBillingEnv();
  const scheme = await env.admin.hierarchy.createArea({ level: "scheme", code: "S1", name: "Scheme" });
  zone = (await env.admin.hierarchy.createArea({ level: "zone", code: "Z1", name: "Zone 1", parentId: scheme.id })).id;
  otherZone = (await env.admin.hierarchy.createArea({ level: "zone", code: "Z2", name: "Zone 2", parentId: scheme.id })).id;
  const fee = await env.admin.tariffs.chargeItems.create({ code: "turn_off", name: "Turn-off fee", type: "fee", amount: 50_000n });
  await env.admin.tariffs.chargeItems.addAmountVersion({ chargeItemId: fee.id, amount: 50_000n, effectiveFrom: "2020-01-01" });
  feeItem = fee.id;
  await setActivation(env.admin, {
    gates: { payment_threshold: { enabled: false }, meter_installed: { enabled: false }, initial_reading: { enabled: false } },
  });
});
afterAll(() => env?.t.stop());

async function setActivation(caller: BillingEnv["admin"], patch: Record<string, unknown>) {
  const current = (await caller.config.list()).find((s) => s.key === activationSetting.key)!;
  await caller.config.set({ key: activationSetting.key, value: activationConfigSchema.parse(patch), expectedVersion: current.version });
}

/** An ACTIVE account of org A with one connected service point in `where`. */
async function active(where = zone, caller = env.admin) {
  const customer = await caller.accounts.customers.create({ type: "person", name: `Holder ${randomUUID().slice(0, 6)}` });
  const a = await caller.accounts.create({ customerId: customer.id });
  await caller.accounts.activate({ accountId: a.id, reason: "Test" });
  await caller.accounts.servicePoints.create({ accountId: a.id, address: "Plot 1", location: { lat: -1.2, lng: 36.9 }, zoneId: where, connectionStatus: "CONNECTED" });
  return a;
}

const bill = (accountId: string, over: Record<string, unknown> = {}) => env.admin.billing.invoices.issueUsage(env.usage(accountId, over) as never);
const TEN_UNITS_BILL = 102_900n;

// C-04: the status table decides what Billing may charge.
describe("chargesApplying replaces the billable stand-in (C-04)", () => {
  it("bills an active connected account and holds a dormant one as STATUS_BLOCKED", async () => {
    const a = await active();
    expect(await bill(a.id)).toMatchObject({ outcome: "issued" });
    const b = await active();
    await env.admin.accounts.makeDormant({ accountId: b.id, reason: "Away" });
    expect(await bill(b.id)).toMatchObject({ outcome: "held", code: "STATUS_BLOCKED" });
    expect(await env.admin.billing.documents.list({ accountId: b.id })).toEqual([]);
  });

  it("holds a NEW account (one-off charges only) and follows the organization's table", async () => {
    const customer = await env.admin.accounts.customers.create({ type: "person", name: "New Customer" });
    const fresh = await env.admin.accounts.create({ customerId: customer.id });
    expect(await bill(fresh.id)).toMatchObject({ outcome: "held", code: "STATUS_BLOCKED" });
  });

  it("charges no standing charge when the table does not apply recurring charges", async () => {
    const a = await active();
    await env.admin.accounts.disconnectService({ accountId: a.id, reason: "Non-payment" });
    // Default: ACTIVE and DISCONNECTED bills everything but usage, so a usage bill is held.
    expect(await bill(a.id)).toMatchObject({ outcome: "held", code: "STATUS_BLOCKED" });
  });
});

// C-11, B-12: the termination check and the final bill.
describe("termination check and final bill (C-11, B-12)", () => {
  const finalInput = (accountId: string, over: Record<string, unknown> = {}) => ({
    accountId,
    categoryId: env.categoryId,
    invoiceTypeId: env.invoiceTypeId,
    period: "2025-02",
    dial: 110,
    readings: [{ period: "2025-01", kind: "actual" as const, dial: 100 }],
    eventKey: `disconnect-${randomUUID()}`,
    turnOffFeeChargeItemId: feeItem,
    ...over,
  });

  it("refuses to terminate before the final bill, then on the balance, then lets a settled account go", async () => {
    const a = await active();
    await bill(a.id);
    await expectCode(env.admin.accounts.terminate({ accountId: a.id, reason: "Leaving" }), "PRECONDITION_FAILED", /final bill/);
    // Even an acknowledgement does not bypass a ledger that exists.
    await expectCode(env.admin.accounts.terminate({ accountId: a.id, reason: "Leaving", acknowledgeNoLedger: true }), "PRECONDITION_FAILED", /final bill/);

    const input = finalInput(a.id, { period: "2025-03", dial: 120, readings: [{ period: "2025-02", kind: "actual", dial: 110 }] });
    const first = await env.admin.billing.invoices.issueFinal(input as never);
    expect(first).toMatchObject({ outcome: "issued", replayed: false, document: { kind: "invoice", finalBill: true } });
    if (first.outcome !== "issued") throw new Error("expected a final bill");
    const fee = first.document.lines.find((l) => l.description === "Turn-off fee");
    expect(fee).toMatchObject({ lineType: "fee", amount: 50_000n, chargeType: "fee", chargeItemId: feeItem });
    expect(fee!.chargeItemAmountId).toBeTruthy();

    await expectCode(env.admin.accounts.terminate({ accountId: a.id, reason: "Leaving" }), "PRECONDITION_FAILED", /balance is not settled/);

    // A credit note clears the balance; then the account is settled.
    const owing = (await env.admin.billing.balance({ accountId: a.id })).balance;
    expect(owing).toBeGreaterThan(0n);
    const asked = await env.admin.billing.adjustments.request({ accountId: a.id, kind: "credit_note", amount: owing, reasonCode: "GOODWILL", note: "Settle" });
    await env.accountant().approvals.approve({ id: asked.approvalId });
    await env.admin.billing.creditNotes.issue({ approvalId: asked.approvalId, accountId: a.id, invoiceTypeId: env.invoiceTypeId, lines: [{ description: "Settlement", amount: owing }], note: "Settle" });
    const done = await env.admin.accounts.terminate({ accountId: a.id, reason: "Leaving" });
    expect(done.account).toMatchObject({ commercialStatus: "TERMINATED" });
    expect(done.command.payload).toMatchObject({ basis: "settled", finalBillIssued: true });
  });

  it("issues one final bill per event key and replays it", async () => {
    const a = await active();
    const input = finalInput(a.id);
    // The first reading of an account only sets the baseline, so bill after a baseline exists.
    const first = await env.admin.billing.invoices.issueFinal(input as never);
    const again = await env.admin.billing.invoices.issueFinal(input as never);
    expect(again).toMatchObject({ outcome: "issued", replayed: true, document: { id: first.outcome === "issued" ? first.document.id : "" } });
    expect(await env.admin.billing.documents.list({ accountId: a.id })).toHaveLength(1);
    await expectCode(env.admin.billing.invoices.issueFinal({ ...input, accountId: randomUUID() } as never), "CONFLICT");
    // A final bill goes through whatever the status table says.
    const dormant = await active();
    await env.admin.accounts.makeDormant({ accountId: dormant.id, reason: "Away" });
    expect(await env.admin.billing.invoices.issueFinal(finalInput(dormant.id) as never)).toMatchObject({ outcome: "issued" });
  });

  it("a voided final bill no longer counts, and a missing fee amount is refused", async () => {
    const a = await active();
    const first = await env.admin.billing.invoices.issueFinal(finalInput(a.id) as never);
    if (first.outcome !== "issued") throw new Error("expected a final bill");
    await env.admin.billing.documents.void({ idempotencyKey: env.key(), documentId: first.document.id, reason: "Wrong reading" });
    await expectCode(env.admin.accounts.terminate({ accountId: a.id, reason: "x" }), "PRECONDITION_FAILED", /final bill/);
    const bare = await env.admin.tariffs.chargeItems.create({ code: "no_amount", name: "No amount", type: "fee" });
    await expectCode(env.admin.billing.invoices.issueFinal(finalInput(a.id, { turnOffFeeChargeItemId: bare.id }) as never), "PRECONDITION_FAILED", /no amount/);
  });

  it("needs billing:run", async () => {
    await expectCode(env.cashier().billing.invoices.issueFinal(finalInput(randomUUID()) as never), "FORBIDDEN");
  });
});

// C-06: the payment gate reads paid against invoiced.
describe("payment_threshold gate source (C-06)", () => {
  it("is unmet with no invoice, then follows paid against invoiced by percent or fixed amount", async () => {
    await setActivation(env.admin, { gates: { payment_threshold: { enabled: true, required: true, basis: "percent", percent: 50 }, meter_installed: { enabled: false }, initial_reading: { enabled: false } } });
    const customer = await env.admin.accounts.customers.create({ type: "person", name: "Gate Customer" });
    const a = await env.admin.accounts.create({ customerId: customer.id });
    await env.admin.accounts.markPendingPayment({ accountId: a.id, reason: "Invoice out" });
    const gate = async () => (await env.admin.accounts.activation.status({ accountId: a.id })).gates.find((g) => g.key === "payment_threshold")!;
    expect(await gate()).toMatchObject({ state: "unmet", via: "source", detail: "No connection invoice has been issued" });

    // A one-off invoice via a debit note (payments arrive in Phase 6, so payment postings are written directly).
    const asked = await env.admin.billing.adjustments.request({ accountId: a.id, kind: "debit_note", amount: 10_000n, reasonCode: "OTHER", note: "Connection fee" });
    await env.accountant().approvals.approve({ id: asked.approvalId });
    await env.admin.billing.debitNotes.issue({ approvalId: asked.approvalId, accountId: a.id, invoiceTypeId: env.invoiceTypeId, lines: [{ description: "Connection fee", amount: 10_000n }], note: "Connection fee" });
    expect(await gate()).toMatchObject({ state: "unmet", via: "source" });

    await pay(a.id, 4_000n);
    expect(await gate()).toMatchObject({ state: "unmet" });
    await pay(a.id, 1_000n);
    expect(await gate()).toMatchObject({ state: "met", via: "source" });
    expect((await env.admin.accounts.activate({ accountId: a.id, reason: "Paid" })).account).toMatchObject({ commercialStatus: "ACTIVE" });
    await setActivation(env.admin, { gates: { payment_threshold: { enabled: false }, meter_installed: { enabled: false }, initial_reading: { enabled: false } } });
  });

  it("is not asked when Billing is unlicensed: the checklist decides", async () => {
    await setActivation(env.bare(), { gates: { meter_installed: { enabled: false }, initial_reading: { enabled: false } } });
    const customer = await env.bare().accounts.customers.create({ type: "person", name: "C Customer" });
    const a = await env.bare().accounts.create({ customerId: customer.id });
    const gate = (await env.bare().accounts.activation.status({ accountId: a.id })).gates.find((g) => g.key === "payment_threshold")!;
    expect(gate).toMatchObject({ state: "unmet", via: "checklist" });
  });
});

/** A payment posting as Payments will write it in Phase 6: receivable credit against cash clearing. */
async function pay(accountId: string, amount: bigint) {
  const id = randomUUID();
  await env.t.admin.execute(sql`with t as (
      insert into billing.ledger_transaction (id, organization_id, entry_type, currency, entry_count, effective_on, idempotency_key)
      values (${id}, ${env.orgA}, 'payment', 'KES', 2, current_date, ${`pay:${id}`}) returning id)
    insert into billing.ledger_entry (organization_id, transaction_id, line_no, currency, side, amount, ledger_account, account_id)
    select ${env.orgA}, t.id, v.line_no, 'KES', v.side, ${amount}, v.ledger_account, ${accountId}::uuid
      from t, (values (0, 'credit', 'receivable'), (1, 'debit', 'cash_clearing')) as v(line_no, side, ledger_account)`);
}

// C-08: succession moves the balance.
describe("balance transfer on succession (C-08)", () => {
  it("moves the balance by paired entries, keeps the ledger balanced and is idempotent", async () => {
    const old = await active();
    await bill(old.id);
    const done = await env.admin.accounts.succeed({ id: randomUUID(), accountId: old.id, basis: "change_of_name", newCustomer: { type: "person", name: "Njeri Waweru" }, reason: "Plot sold" });
    expect(done.command.payload).toMatchObject({ transfer: "done" });
    expect((await env.admin.billing.balance({ accountId: old.id })).balance).toBe(0n);
    expect((await env.admin.billing.balance({ accountId: done.successor.id })).balance).toBe(TEN_UNITS_BILL);
    const rows = await env.rows<{ entry_type: string; entry_count: number; source_ref: string }>(sql`select entry_type, entry_count, source_ref from billing.ledger_transaction where source_ref = ${done.command.id}`);
    expect(rows).toEqual([{ entry_type: "transfer", entry_count: 4, source_ref: done.command.id }]);
    const statement = await env.admin.billing.statement({ accountId: done.successor.id });
    expect(statement.items.map((i) => [i.entryType, i.amount])).toEqual([["transfer", TEN_UNITS_BILL]]);

    // A replay of the command and a direct second call post nothing more.
    expect(await env.admin.accounts.succeed({ id: done.command.id, accountId: old.id, basis: "change_of_name", newCustomer: { type: "person", name: "Njeri Waweru" }, reason: "Plot sold" })).toMatchObject({ replayed: true });
    await withTenant(env.t.app, env.orgA, (tx) => balanceTransfer(tx, env.orgA, { fromAccountId: old.id, toAccountId: done.successor.id, commandId: done.command.id }));
    expect(await env.rows(sql`select 1 from billing.ledger_transaction where source_ref = ${done.command.id}`)).toHaveLength(1);
    expect((await env.admin.billing.balance({ accountId: done.successor.id })).balance).toBe(TEN_UNITS_BILL);
  });

  it("moves a credit the other way and posts nothing for a zero balance", async () => {
    const old = await active();
    const asked = await env.admin.billing.adjustments.request({ accountId: old.id, kind: "credit_note", amount: 7_000n, reasonCode: "GOODWILL", note: "Credit" });
    await env.accountant().approvals.approve({ id: asked.approvalId });
    await env.admin.billing.creditNotes.issue({ approvalId: asked.approvalId, accountId: old.id, invoiceTypeId: env.invoiceTypeId, lines: [{ description: "Credit", amount: 7_000n }], note: "Credit" });
    const done = await env.admin.accounts.succeed({ accountId: old.id, basis: "change_of_name", newCustomer: { type: "person", name: "Credit Heir" }, reason: "Sold" });
    expect((await env.admin.billing.balance({ accountId: done.successor.id })).balance).toBe(-7_000n);
    const empty = await active();
    const none = await env.admin.accounts.succeed({ accountId: empty.id, basis: "change_of_name", newCustomer: { type: "person", name: "Nothing Owed" }, reason: "Sold" });
    expect(none.command.payload).toMatchObject({ transfer: "done" });
    expect(await env.rows(sql`select 1 from billing.ledger_transaction where source_ref = ${none.command.id}`)).toHaveLength(0);
  });

  it("is still pending_ledger, and termination still acknowledges, when Billing is unlicensed", async () => {
    const caller = env.bare();
    await setActivation(caller, { gates: { payment_threshold: { enabled: false }, meter_installed: { enabled: false }, initial_reading: { enabled: false } } });
    const customer = await caller.accounts.customers.create({ type: "person", name: "C Holder" });
    const a = await caller.accounts.create({ customerId: customer.id });
    await caller.accounts.activate({ accountId: a.id, reason: "Go" });
    const done = await caller.accounts.succeed({ accountId: a.id, basis: "change_of_name", newCustomer: { type: "person", name: "C Heir" }, reason: "Sold" });
    expect(done.command.payload).toMatchObject({ transfer: "pending_ledger" });
    await expectCode(caller.accounts.terminate({ accountId: done.successor.id, reason: "Gone" }), "PRECONDITION_FAILED", /no ledger/);
    const ended = await caller.accounts.terminate({ accountId: done.successor.id, reason: "Gone", acknowledgeNoLedger: true });
    expect(ended.command.payload).toMatchObject({ basis: "no_ledger" });
  });
});

// C-05: Billing tells an application its invoice and payment, as the system.
describe("application invoice and payment as the system (C-05)", () => {
  it("moves the stage with the references Billing gives and replays by id", async () => {
    const current = (await env.admin.config.list()).find((s) => s.key === applicationSetting.key)!;
    await env.admin.config.set({ key: applicationSetting.key, value: { survey: { required: false }, invoice: { required: true }, installation: { required: false } }, expectedVersion: current.version });
    const customer = await env.admin.accounts.customers.create({ type: "person", name: "Applicant" });
    const app = await env.admin.accounts.applications.create({ customerId: customer.id, address: "Plot 77" });
    await env.admin.accounts.applications.submitApplication({ applicationId: app.application.id });
    const eventId = randomUUID();
    const invoiced = await withTenant(env.t.app, env.orgA, (tx) => recordApplicationInvoiced(systemEnv(tx, env.orgA), { applicationId: app.application.id, invoiceRef: "INV-000123", id: eventId }));
    expect(invoiced.application).toMatchObject({ stage: "invoice", invoiceRef: "INV-000123" });
    const replay = await withTenant(env.t.app, env.orgA, (tx) => recordApplicationInvoiced(systemEnv(tx, env.orgA), { applicationId: app.application.id, invoiceRef: "INV-000123", id: eventId }));
    expect(replay.application.stage).toBe("invoice");
    const paid = await withTenant(env.t.app, env.orgA, (tx) => recordApplicationPaid(systemEnv(tx, env.orgA), { applicationId: app.application.id, paymentRef: "PAY-9" }));
    expect(paid.application).toMatchObject({ stage: "payment", paymentRef: "PAY-9" });
  });
});

// T-03, B-15: billed periods close for tariff changes.
describe("closed-period source (T-03)", () => {
  it("refuses a tariff change dated on or before the latest billed period", async () => {
    const a = await active();
    await bill(a.id, { period: "2025-06", readings: [{ period: "2025-05", kind: "actual", dial: 100 }] });
    // Changes after the billed month are fine; on or before its last day are refused.
    await expect(env.admin.tariffs.chargeItems.addAmountVersion({ chargeItemId: feeItem, amount: 60_000n, effectiveFrom: "2025-06-30" })).rejects.toThrow(/closed/i);
    await env.admin.tariffs.chargeItems.addAmountVersion({ chargeItemId: feeItem, amount: 60_000n, effectiveFrom: "2025-07-01" });
  });

  it("is per organization: another organization has nothing closed", async () => {
    const outsiderItem = await env.outsider().tariffs.chargeItems.create({ code: "x", name: "X", type: "fee", amount: 100n });
    await env.outsider().tariffs.chargeItems.addAmountVersion({ chargeItemId: outsiderItem.id, amount: 200n, effectiveFrom: "2025-01-01" });
  });
});

// K-03: billing reads follow the member's scope.
describe("scope on billing reads (K-03)", () => {
  it("shows a limited member only the accounts they can see", async () => {
    const limited = await addMember(env.t, env.orgA, "clerk");
    await env.admin.access.setScope({ userId: limited.userId, areaIds: [zone], routeIds: [] });
    const caller = env.as(limited);
    const inside = await active(zone);
    const outside = await active(otherZone);
    const a = await bill(inside.id);
    const b = await bill(outside.id);
    if (a.outcome !== "issued" || b.outcome !== "issued") throw new Error("expected invoices");

    expect((await caller.billing.balance({ accountId: inside.id })).balance).toBe(TEN_UNITS_BILL);
    await expectCode(caller.billing.balance({ accountId: outside.id }), "NOT_FOUND");
    await expectCode(caller.billing.statement({ accountId: outside.id }), "NOT_FOUND");
    await expectCode(caller.billing.documents.get({ id: b.document.id }), "NOT_FOUND");
    expect((await caller.billing.documents.get({ id: a.document.id })).id).toBe(a.document.id);
    await expectCode(caller.billing.documents.list({ accountId: outside.id }), "NOT_FOUND");
    const listed = await caller.billing.documents.list({ limit: 200 });
    expect(listed.every((d) => d.accountId === inside.id || d.accountId !== outside.id)).toBe(true);
    expect(listed.some((d) => d.id === b.document.id)).toBe(false);
    expect(listed.some((d) => d.id === a.document.id)).toBe(true);
    // An unrestricted member sees both.
    expect((await env.admin.billing.documents.list({ limit: 200 })).some((d) => d.id === b.document.id)).toBe(true);
  });

  it("refuses writes on an account outside the scope", async () => {
    const limited = await addMember(env.t, env.orgA, "manager");
    await env.admin.access.setScope({ userId: limited.userId, areaIds: [zone], routeIds: [] });
    const outside = await active(otherZone);
    await expectCode(env.as(limited).billing.invoices.issueUsage(env.usage(outside.id, { period: "2025-04" }) as never), "NOT_FOUND");
  });
});

describe("registration", () => {
  it("registerPorts can be called again (replace, not throw)", () => {
    registerPorts();
    registerPorts();
  });
});
