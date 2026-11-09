import { outboxEvent, withTenant } from "@flowless/db";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { consumers } from "../../../wiring";
import { drainOutbox } from "../../../kernel/events";
import { recheckActivation, registerGateSource, registerTerminationCheck } from "..";
import { activationConfigSchema } from "../gates";
import { activationSetting } from "../settings";
import { setupAccountsEnv, type AccountsEnv } from "./test-support";

/*
 * Characterisation of what a status command writes, exactly: the command payload, the audit
 * entry's `after` and every event payload, for each kind that does extra work (activate,
 * reactivate, terminate) and for ones that do not. `lifecycle.test.ts` matches subsets;
 * these use toEqual so a change to the generic path cannot alter a byte unnoticed.
 */

let env: AccountsEnv;
beforeAll(async () => {
  env = await setupAccountsEnv();
});
afterAll(() => env?.t.stop());
afterEach(async () => {
  registerGateSource("payment_threshold", null);
  registerGateSource("meter_installed", null);
  registerGateSource("initial_reading", null);
  registerTerminationCheck(null);
  await setActivation({});
});

async function fresh() {
  const caller = env.clerk();
  const customer = await env.person(caller, `Customer ${randomUUID().slice(0, 6)}`);
  return caller.accounts.create({ customerId: customer.id });
}
async function setActivation(patch: Record<string, unknown>) {
  const current = (await env.admin.config.list()).find((s) => s.key === activationSetting.key)!;
  await env.admin.config.set({ key: activationSetting.key, value: activationConfigSchema.parse(patch), expectedVersion: current.version });
}
const noGates = { gates: { payment_threshold: { enabled: false }, meter_installed: { enabled: false }, initial_reading: { enabled: false } } };
const WAIVED_ALL = [
  { key: "payment_threshold", state: "waived", via: "disabled" },
  { key: "meter_installed", state: "waived", via: "disabled" },
  { key: "initial_reading", state: "waived", via: "disabled" },
];

/** The events one account has on the outbox, by type. */
async function events(accountId: string) {
  const rows = (await env.db.select().from(outboxEvent)).filter((e) => (e.payload as { accountId?: string }).accountId === accountId);
  const byType: Record<string, Record<string, unknown>[]> = {};
  for (const e of rows) (byType[e.type] ??= []).push(e.payload as Record<string, unknown>);
  return byType;
}
const auditOf = async (accountId: string, action: string) => (await env.audit(accountId)).find((e) => e.action === action)!;

type Done = { command: { id: string; reason: string; actorUserId: string | null; occurredAt: Date } };
/** The facts every lifecycle event carries. */
const facts = (a: { id: string; number: string }, done: Done) => ({
  accountId: a.id,
  number: a.number,
  commandId: done.command.id,
  reason: done.command.reason,
  actorUserId: done.command.actorUserId,
  occurredAt: done.command.occurredAt.toISOString(),
});

describe("activate", () => {
  it("by checklist: payload, audit and events", async () => {
    await setActivation(noGates);
    const a = await fresh();
    const done = await env.manager().accounts.activate({ accountId: a.id, reason: "Ready" });
    expect(done.command.payload).toEqual({ gates: WAIVED_ALL, mode: "checklist", via: "checklist" });
    const audit = await auditOf(a.id, "accounts.activate");
    expect(audit.before).toEqual({ commercialStatus: "NEW", serviceStatus: "DISCONNECTED", serviceStatusReason: expect.any(String) });
    expect(audit.after).toEqual({
      commercialStatus: "ACTIVE",
      serviceStatus: "CONNECTED",
      serviceStatusReason: null,
      commandId: done.command.id,
      gates: WAIVED_ALL,
      mode: "checklist",
      via: "checklist",
    });
    expect(audit.reason).toBe("Ready");
    const f = facts(a, done);
    const lifecycle = Object.fromEntries(Object.entries(await events(a.id)).filter(([type]) => type !== "accounts.account_opened"));
    expect(lifecycle).toEqual({
      "accounts.account_status_changed": [{ ...f, kind: "activate", from: "NEW", to: "ACTIVE" }],
      "accounts.service_status_changed": [{ ...f, kind: "activate", from: "DISCONNECTED", to: "CONNECTED", serviceReason: null }],
      "accounts.account_activated": [{ ...f, from: "NEW", via: "checklist", service: "CONNECTED" }],
    });
  });

  it("leaving the service disconnected still announces the activation, with the service it left", async () => {
    await setActivation(noGates);
    const a = await fresh();
    await env.manager().accounts.markPendingPayment({ accountId: a.id, reason: "Invoice out" });
    const done = await env.manager().accounts.activate({ accountId: a.id, reason: "Go", connect: false, serviceReason: "Customer will connect later" });
    expect(done.command.payload).toEqual({ gates: WAIVED_ALL, mode: "checklist", via: "checklist" });
    const all = await events(a.id);
    expect(all["accounts.account_status_changed"]!.map((p) => [p.kind, p.from, p.to])).toEqual([
      ["mark_pending_payment", "NEW", "PENDING_PAYMENT"],
      ["activate", "PENDING_PAYMENT", "ACTIVE"],
    ]);
    expect(all["accounts.service_status_changed"]).toBeUndefined();
    expect(all["accounts.account_activated"]).toEqual([{ ...facts(a, done), from: "PENDING_PAYMENT", via: "checklist", service: "DISCONNECTED" }]);
  });

  it("by override: records the unmet gates and announces via override", async () => {
    const a = await fresh();
    await env.manager().accounts.markPendingPayment({ accountId: a.id, reason: "Invoice out" });
    const done = await env.admin.accounts.activate({ accountId: a.id, reason: "Owner approved the exception", override: true });
    const unmet = ["payment_threshold", "meter_installed", "initial_reading"];
    const gates = unmet.map((key) => ({ key, state: "unmet", via: "checklist" }));
    expect(done.command.payload).toEqual({ gates, override: true, overriddenGates: unmet, mode: "checklist", via: "override" });
    expect((await auditOf(a.id, "accounts.activate")).after).toEqual({
      commercialStatus: "ACTIVE",
      serviceStatus: "CONNECTED",
      serviceStatusReason: null,
      commandId: done.command.id,
      gates,
      override: true,
      overriddenGates: unmet,
      mode: "checklist",
      via: "override",
    });
    expect((await events(a.id))["accounts.account_activated"]).toEqual([{ ...facts(a, done), from: "PENDING_PAYMENT", via: "override", service: "CONNECTED" }]);
  });

  it("an override with every gate met is not recorded as one", async () => {
    await setActivation(noGates);
    const a = await fresh();
    const done = await env.admin.accounts.activate({ accountId: a.id, reason: "Belt and braces", override: true });
    expect(done.command.payload).toEqual({ gates: WAIVED_ALL, mode: "checklist", via: "checklist" });
    expect((await events(a.id))["accounts.account_activated"]).toEqual([{ ...facts(a, done), from: "NEW", via: "checklist", service: "CONNECTED" }]);
  });

  it("refuses with the unmet gates named and writes nothing", async () => {
    const a = await fresh();
    await env.manager().accounts.markPendingPayment({ accountId: a.id, reason: "Invoice out" });
    await expect(env.manager().accounts.activate({ accountId: a.id, reason: "Go" })).rejects.toThrow(
      "The account is not ready to activate. Unmet: Payment threshold met; Meter installed and confirmed in inventory; Initial reading captured",
    );
    expect((await env.clerk().accounts.commands.list({ accountId: a.id })).map((c) => c.kind)).toEqual(["mark_pending_payment"]);
    expect((await events(a.id))["accounts.account_activated"]).toBeUndefined();
  });

  it("automatically: the system acts, via auto, mode auto", async () => {
    await setActivation({ mode: "auto", ...noGates });
    const a = await fresh();
    await expect(withTenant(env.t.app, env.orgA, (tx) => recheckActivation(tx, env.orgA, a.id))).resolves.toEqual({
      activated: true,
      reason: "All activation gates are met",
    });
    const [cmd] = await env.clerk().accounts.commands.list({ accountId: a.id });
    expect(cmd!.payload).toEqual({ gates: WAIVED_ALL, mode: "auto", via: "auto" });
    const f = { accountId: a.id, number: a.number, commandId: cmd!.id, reason: "All activation gates are met", actorUserId: null, occurredAt: cmd!.occurredAt.toISOString() };
    expect((await events(a.id))["accounts.account_activated"]).toEqual([{ ...f, from: "NEW", via: "auto", service: "CONNECTED" }]);
  });
});

describe("reactivate and the commands with no extra work", () => {
  it("write an empty payload; only reactivate announces an activation, via reactivation", async () => {
    await setActivation(noGates);
    const a = await fresh();
    await env.manager().accounts.activate({ accountId: a.id, reason: "Ready" });
    const dormant = await env.manager().accounts.makeDormant({ accountId: a.id, reason: "Vacant" });
    expect(dormant.command.payload).toEqual({});
    const back = await env.manager().accounts.reactivate({ accountId: a.id, reason: "Occupied" });
    expect(back.command.payload).toEqual({});
    expect((await auditOf(a.id, "accounts.reactivate")).after).toEqual({
      commercialStatus: "ACTIVE",
      serviceStatus: "CONNECTED",
      serviceStatusReason: null,
      commandId: back.command.id,
    });
    const off = await env.manager().accounts.disconnectService({ accountId: a.id, reason: "Non-payment" });
    expect(off.command.payload).toEqual({});
    const all = await events(a.id);
    expect(all["accounts.account_activated"]).toHaveLength(2);
    expect(all["accounts.account_activated"]).toContainEqual({ ...facts(a, back), from: "DORMANT", via: "reactivation", service: "CONNECTED" });
    expect(all["accounts.account_terminated"]).toBeUndefined();
    expect(all["accounts.service_status_changed"]).toContainEqual({
      ...facts(a, off),
      kind: "disconnect_service",
      from: "CONNECTED",
      to: "DISCONNECTED",
      serviceReason: "Non-payment",
    });
  });
});

describe("terminate", () => {
  async function active() {
    await setActivation(noGates);
    const a = await fresh();
    await env.manager().accounts.activate({ accountId: a.id, reason: "Ready" });
    return a;
  }
  const terminated = (a: { id: string; number: string }, done: Done, from: string, extra: Record<string, unknown>) => ({ ...facts(a, done), from, ...extra });

  it("with no ledger: acknowledgement recorded, balance null", async () => {
    const a = await active();
    const done = await env.manager().accounts.terminate({ accountId: a.id, reason: "Left", acknowledgeNoLedger: true });
    expect(done.command.payload).toEqual({ basis: "no_ledger", balance: null, finalBillIssued: null, acknowledgeNoLedger: true });
    expect((await auditOf(a.id, "accounts.terminate")).after).toEqual({
      commercialStatus: "TERMINATED",
      serviceStatus: "DISCONNECTED",
      serviceStatusReason: "Account terminated: Left",
      commandId: done.command.id,
      basis: "no_ledger",
      balance: null,
      finalBillIssued: null,
      acknowledgeNoLedger: true,
    });
    const all = await events(a.id);
    expect(all["accounts.account_terminated"]).toEqual([terminated(a, done, "ACTIVE", { basis: "no_ledger", balance: null, writeOffApprovalId: null })]);
    expect(all["accounts.account_status_changed"]).toContainEqual({ ...facts(a, done), kind: "terminate", from: "ACTIVE", to: "TERMINATED" });
    expect(all["accounts.service_status_changed"]).toContainEqual({
      ...facts(a, done),
      kind: "terminate",
      from: "CONNECTED",
      to: "DISCONNECTED",
      serviceReason: "Account terminated: Left",
    });
  });

  it("settled: the ledger's final bill and zero balance", async () => {
    registerTerminationCheck(async () => ({ finalBillIssued: true, balance: 0n }));
    const a = await active();
    const done = await env.manager().accounts.terminate({ accountId: a.id, reason: "Left" });
    expect(done.command.payload).toEqual({ basis: "settled", balance: "0", finalBillIssued: true });
    expect((await auditOf(a.id, "accounts.terminate")).after).toEqual({
      commercialStatus: "TERMINATED",
      serviceStatus: "DISCONNECTED",
      serviceStatusReason: "Account terminated: Left",
      commandId: done.command.id,
      basis: "settled",
      balance: "0",
      finalBillIssued: true,
    });
    expect((await events(a.id))["accounts.account_terminated"]).toEqual([terminated(a, done, "ACTIVE", { basis: "settled", balance: "0", writeOffApprovalId: null })]);
  });

  it("written off: the approval is cited in the payload and the event", async () => {
    registerTerminationCheck(async () => ({ finalBillIssued: true, balance: 250_000n }));
    const a = await active();
    const asked = await env.manager().accounts.requestWriteOff({ accountId: a.id, amount: 250_000n, reasonCode: "ABSCONDED", note: "Customer left no forwarding address" });
    await env.accountant().approvals.approve({ id: asked.approvalId, note: "Reviewed the file" });
    await drainOutbox(env.t.app, consumers);
    const done = await env.manager().accounts.terminate({ accountId: a.id, reason: "Absconded", approvalId: asked.approvalId });
    expect(done.command.payload).toEqual({ basis: "written_off", balance: "250000", finalBillIssued: true, writeOffApprovalId: asked.approvalId });
    expect((await auditOf(a.id, "accounts.terminate")).after).toEqual({
      commercialStatus: "TERMINATED",
      serviceStatus: "DISCONNECTED",
      serviceStatusReason: "Account terminated: Absconded",
      commandId: done.command.id,
      basis: "written_off",
      balance: "250000",
      finalBillIssued: true,
      writeOffApprovalId: asked.approvalId,
    });
    expect((await events(a.id))["accounts.account_terminated"]).toEqual([
      terminated(a, done, "ACTIVE", { basis: "written_off", balance: "250000", writeOffApprovalId: asked.approvalId }),
    ]);
  });

  it("terminates a NEW account, and the event says where from", async () => {
    const a = await fresh();
    const done = await env.manager().accounts.terminate({ accountId: a.id, reason: "Never connected", acknowledgeNoLedger: true });
    expect((await events(a.id))["accounts.account_terminated"]).toEqual([
      terminated(a, done, "NEW", { basis: "no_ledger", balance: null, writeOffApprovalId: null }),
    ]);
  });
});
