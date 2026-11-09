import { exception, outboxEvent, withTenant } from "@flowless/db";
import { account, accountCommand, activationCheck } from "@flowless/db/schema/accounts";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { consumers } from "../../../kernel/consumers";
import { setEntitlements } from "../../../kernel/entitlement-store";
import { drainOutbox } from "../../../kernel/events";
import { addMember } from "../../../test-support";
import { recheckActivation, registerGateSource, registerTerminationCheck, sweepStaleAccounts } from "..";
import { activationConfigSchema } from "../gates";
import { activationSetting, statusRulesSetting } from "../settings";
import { expectCode, setupAccountsEnv, type AccountsEnv } from "./test-support";

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

/** A new NEW/DISCONNECTED account opened by the clerk. */
async function fresh(caller = env.clerk()) {
  const customer = await env.person(caller, `Customer ${randomUUID().slice(0, 6)}`);
  return caller.accounts.create({ customerId: customer.id });
}

/** Writes tenant A's activation setting from the defaults plus `patch`. */
async function setActivation(patch: Record<string, unknown>) {
  const current = (await env.admin.config.list()).find((s) => s.key === activationSetting.key)!;
  const value = activationConfigSchema.parse(patch);
  await env.admin.config.set({ key: activationSetting.key, value, expectedVersion: current.version });
}
const noGates = { gates: { payment_threshold: { enabled: false }, meter_installed: { enabled: false }, initial_reading: { enabled: false } } };

const commandsOf = (accountId: string) => env.db.select().from(accountCommand).where(eq(accountCommand.accountId, accountId));
const eventsOf = async (accountId: string, type?: string) =>
  (await env.db.select().from(outboxEvent)).filter((e) => (e.payload as { accountId?: string }).accountId === accountId && (!type || e.type === type));
const actionsOf = async (accountId: string) => (await env.audit(accountId)).map((e) => e.action);

// C-03, C-06 (phase 3 done-when #1): enquiry to ACTIVE through configurable gates with Work Orders and Inventory off.
describe("enquiry to ACTIVE with Work Orders and Inventory off", () => {
  it("goes NEW > PENDING_PAYMENT > ACTIVE through the office checklist, and logs every step", async () => {
    // Only Accounts is licensed. The meter gate is switched off; the payment threshold and the initial reading stay on the checklist.
    await setActivation({ gates: { meter_installed: { enabled: false } }, officeChecklist: [{ key: "site_visit", label: "Site visit signed off" }] });
    const a = await fresh();
    expect(a).toMatchObject({ commercialStatus: "NEW", serviceStatus: "DISCONNECTED" });
    const manager = env.manager();

    // With a payment gate the account must be marked pending payment before it can activate.
    await expectCode(manager.accounts.activate({ accountId: a.id, reason: "Go" }), "PRECONDITION_FAILED");
    const pending = await manager.accounts.markPendingPayment({ accountId: a.id, reason: "New-connection invoice issued" });
    expect(pending.account).toMatchObject({ commercialStatus: "PENDING_PAYMENT", serviceStatus: "DISCONNECTED" });

    const before = await manager.accounts.activation.status({ accountId: a.id });
    expect(before).toMatchObject({ mode: "checklist", ready: false, open: true });
    expect(before.gates.map((g) => [g.key, g.state, g.via])).toEqual([
      ["payment_threshold", "unmet", "checklist"],
      ["meter_installed", "waived", "disabled"],
      ["initial_reading", "unmet", "checklist"],
      ["site_visit", "unmet", "checklist"],
    ]);
    const refused = manager.accounts.activate({ accountId: a.id, reason: "Gates met" });
    await expectCode(refused, "PRECONDITION_FAILED");
    await expect(refused).rejects.toThrow(/Payment threshold met.*Initial reading captured.*site visit/i);

    await manager.accounts.activation.tick({ accountId: a.id, gateKey: "payment_threshold", note: "Receipt MP12345" });
    await manager.accounts.activation.tick({ accountId: a.id, gateKey: "initial_reading" });
    const partial = await manager.accounts.activation.status({ accountId: a.id });
    expect(partial.unmet).toEqual(["site_visit"]);
    expect(partial.gates.find((g) => g.key === "payment_threshold")).toMatchObject({ ticked: true, tickedByUserId: env.users.manager, note: "Receipt MP12345" });
    await expectCode(manager.accounts.activate({ accountId: a.id, reason: "Gates met" }), "PRECONDITION_FAILED");
    await manager.accounts.activation.tick({ accountId: a.id, gateKey: "site_visit" });

    const done = await manager.accounts.activate({ id: randomUUID(), accountId: a.id, reason: "All gates met", reasonCode: "OFFICE" });
    expect(done.account).toMatchObject({ commercialStatus: "ACTIVE", serviceStatus: "CONNECTED", serviceStatusReason: null });
    expect(done.command).toMatchObject({ kind: "activate", fromCommercialStatus: "PENDING_PAYMENT", toCommercialStatus: "ACTIVE", fromServiceStatus: "DISCONNECTED", toServiceStatus: "CONNECTED" });
    expect(done.command.payload).toMatchObject({ via: "checklist", mode: "checklist" });
    expect(await env.clerk().accounts.get({ id: a.id })).toMatchObject({ commercialStatus: "ACTIVE", serviceStatus: "CONNECTED" });

    const log = await env.clerk().accounts.commands.list({ accountId: a.id });
    expect(log.map((c) => c.kind)).toEqual(["activate", "mark_pending_payment"]);
    expect(log[0]).toMatchObject({ actorUserId: env.users.manager, source: "api", reason: "All gates met", reasonCode: "OFFICE" });

    // The ticks are history, and the checklist only applies while the account is open.
    expect(await env.db.select().from(activationCheck).where(eq(activationCheck.accountId, a.id))).toHaveLength(3);
    await expectCode(manager.accounts.activation.tick({ accountId: a.id, gateKey: "site_visit" }), "PRECONDITION_FAILED");

    expect(await actionsOf(a.id)).toEqual(expect.arrayContaining(["accounts.mark_pending_payment", "accounts.activation_tick", "accounts.activate"]));
    const types = (await eventsOf(a.id)).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["accounts.account_status_changed", "accounts.service_status_changed", "accounts.account_activated"]));
  });

  it("activates straight from NEW when the organization has no payment gate, and with every gate off", async () => {
    await setActivation({ gates: { payment_threshold: { enabled: false } } });
    const a = await fresh();
    await env.manager().accounts.activation.tick({ accountId: a.id, gateKey: "meter_installed" });
    await env.manager().accounts.activation.tick({ accountId: a.id, gateKey: "initial_reading" });
    expect((await env.manager().accounts.activate({ accountId: a.id, reason: "Ready" })).account).toMatchObject({ commercialStatus: "ACTIVE", serviceStatus: "CONNECTED" });

    await setActivation(noGates);
    const b = await fresh();
    expect((await env.manager().accounts.activation.status({ accountId: b.id })).ready).toBe(true);
    expect((await env.manager().accounts.activate({ accountId: b.id, reason: "No gates" })).account.commercialStatus).toBe("ACTIVE");
  });

  it("can activate without connecting the service, with a reason", async () => {
    await setActivation(noGates);
    const a = await fresh();
    await expectCode(env.manager().accounts.activate({ accountId: a.id, reason: "Go", connect: false }), "PRECONDITION_FAILED");
    const done = await env.manager().accounts.activate({ accountId: a.id, reason: "Go", connect: false, serviceReason: "Customer will connect next month" });
    expect(done.account).toMatchObject({ commercialStatus: "ACTIVE", serviceStatus: "DISCONNECTED", serviceStatusReason: "Customer will connect next month" });
    expect((await eventsOf(a.id, "accounts.service_status_changed")).length).toBe(0);
    const back = await env.manager().accounts.reconnectService({ accountId: a.id, reason: "Customer is ready" });
    expect(back.account).toMatchObject({ serviceStatus: "CONNECTED", serviceStatusReason: null });
  });

  it("lets only a holder of settings:manage override unmet gates, and records the override", async () => {
    const a = await fresh();
    await env.manager().accounts.markPendingPayment({ accountId: a.id, reason: "Invoice out" });
    await expectCode(env.manager().accounts.activate({ accountId: a.id, reason: "Boss said so", override: true }), "FORBIDDEN");
    const done = await env.admin.accounts.activate({ accountId: a.id, reason: "Owner approved the exception", override: true });
    expect(done.account.commercialStatus).toBe("ACTIVE");
    expect(done.command.payload).toMatchObject({ override: true, via: "override", overriddenGates: ["payment_threshold", "meter_installed", "initial_reading"] });
    const entry = (await env.audit(a.id)).find((e) => e.action === "accounts.activate")!;
    expect(entry.after).toMatchObject({ override: true, overriddenGates: expect.arrayContaining(["meter_installed"]) });
    expect(entry.reason).toBe("Owner approved the exception");
    expect((await eventsOf(a.id, "accounts.account_activated"))[0]!.payload).toMatchObject({ via: "override" });
    // An override also lets a NEW account skip pending payment.
    const b = await fresh();
    expect((await env.admin.accounts.activate({ accountId: b.id, reason: "Urgent", override: true })).account.commercialStatus).toBe("ACTIVE");
  });
});

describe("activation checklist (C-06)", () => {
  it("is insert-only history: unticking adds a retraction row, repeating changes nothing", async () => {
    await setActivation({ officeChecklist: [{ key: "site_visit", label: "Site visit signed off" }] });
    const a = await fresh();
    const tick = () => env.manager().accounts.activation.tick({ accountId: a.id, gateKey: "site_visit" });
    const rows = () => env.db.select().from(activationCheck).where(eq(activationCheck.accountId, a.id)).orderBy(activationCheck.seq);
    await tick();
    await tick();
    expect(await rows()).toHaveLength(1);
    await env.manager().accounts.activation.untick({ accountId: a.id, gateKey: "site_visit", note: "Wrong plot" });
    await env.manager().accounts.activation.untick({ accountId: a.id, gateKey: "site_visit" });
    expect((await rows()).map((r) => r.action)).toEqual(["tick", "untick"]);
    const status = await env.manager().accounts.activation.status({ accountId: a.id });
    expect(status.gates.find((g) => g.key === "site_visit")).toMatchObject({ state: "unmet", ticked: false, tickedByUserId: null });
    await tick();
    expect((await rows()).map((r) => r.action)).toEqual(["tick", "untick", "tick"]);
    expect((await env.manager().accounts.activation.status({ accountId: a.id })).gates.find((g) => g.key === "site_visit")!.state).toBe("met");
    expect((await actionsOf(a.id)).filter((x) => x.startsWith("accounts.activation_"))).toHaveLength(3);
  });

  it("refuses unknown gates, gates not in use, and gates a module decides", async () => {
    await setActivation({ gates: { initial_reading: { enabled: false } } });
    const a = await fresh();
    await expectCode(env.manager().accounts.activation.tick({ accountId: a.id, gateKey: "nonsense" }), "BAD_REQUEST");
    await expectCode(env.manager().accounts.activation.tick({ accountId: a.id, gateKey: "initial_reading" }), "BAD_REQUEST");
    registerGateSource("meter_installed", async () => ({ met: false, detail: "Awaiting inventory" }));
    await expect(env.manager().accounts.activation.tick({ accountId: a.id, gateKey: "meter_installed" })).rejects.toThrow(/decided by the system.*Awaiting inventory/);
  });

  it("uses a registered source's answer, and ignores a source whose module is not licensed", async () => {
    await setActivation({ gates: { payment_threshold: { enabled: false } } });
    const a = await fresh();
    const calls: string[] = [];
    registerGateSource(
      "meter_installed",
      async (_tx, _org, id) => {
        calls.push(id);
        return { met: true, detail: "Meter M-1 installed and confirmed" };
      },
      { requires: ["work-orders", "inventory"] },
    );
    // Work Orders and Inventory are not licensed: the source is not even asked, so the checklist decides (NF-31).
    let status = await env.manager().accounts.activation.status({ accountId: a.id });
    expect(calls).toEqual([]);
    expect(status.gates.find((g) => g.key === "meter_installed")).toMatchObject({ state: "unmet", via: "checklist" });
    await env.manager().accounts.activation.tick({ accountId: a.id, gateKey: "meter_installed" });
    await env.manager().accounts.activation.tick({ accountId: a.id, gateKey: "initial_reading" });
    expect((await env.manager().accounts.activation.status({ accountId: a.id })).ready).toBe(true);

    // Licensed: the source speaks for the gate.
    await setEntitlements(env.t.app, env.orgA, ["accounts", "work-orders", "inventory"]);
    try {
      status = await env.manager().accounts.activation.status({ accountId: a.id });
      expect(calls).toEqual([a.id]);
      expect(status.gates.find((g) => g.key === "meter_installed")).toMatchObject({ state: "met", via: "source", detail: "Meter M-1 installed and confirmed" });
    } finally {
      await setEntitlements(env.t.app, env.orgA, ["accounts"]);
    }
  });
});

describe("automatic activation (C-06, mode auto)", () => {
  it("activates through recheckActivation exactly when the gates are met, and never overrides", async () => {
    await setActivation({ mode: "auto", gates: { payment_threshold: { enabled: false }, initial_reading: { enabled: false } } });
    let installed = false;
    registerGateSource("meter_installed", async () => ({ met: installed }));
    const a = await fresh();
    const run = () => withTenant(env.t.app, env.orgA, (tx) => recheckActivation(tx, env.orgA, a.id));

    await expect(run()).resolves.toMatchObject({ activated: false });
    expect((await env.clerk().accounts.get({ id: a.id })).commercialStatus).toBe("NEW");
    installed = true;
    await expect(run()).resolves.toEqual({ activated: true, reason: "All activation gates are met" });
    const after = await env.clerk().accounts.get({ id: a.id });
    expect(after).toMatchObject({ commercialStatus: "ACTIVE", serviceStatus: "CONNECTED" });
    const [cmd] = await commandsOf(a.id);
    expect(cmd).toMatchObject({ kind: "activate", actorUserId: null, source: "system", reason: "All activation gates are met" });
    expect(cmd!.payload).toMatchObject({ via: "auto" });
    expect(await actionsOf(a.id)).toContain("accounts.activate");
    expect((await env.audit(a.id)).find((e) => e.action === "accounts.activate")).toMatchObject({ source: "system", actorUserId: null });
    expect((await eventsOf(a.id, "accounts.account_activated"))[0]!.payload).toMatchObject({ via: "auto", actorUserId: null });
    // Already active: nothing more happens.
    await expect(run()).resolves.toMatchObject({ activated: false });
    expect(await commandsOf(a.id)).toHaveLength(1);
  });

  it("does nothing in checklist mode, and waits for pending payment when payment is a gate", async () => {
    await setActivation({ mode: "checklist", ...noGates });
    const a = await fresh();
    const run = (id: string) => withTenant(env.t.app, env.orgA, (tx) => recheckActivation(tx, env.orgA, id));
    await expect(run(a.id)).resolves.toMatchObject({ activated: false, reason: "Activation is by checklist" });

    await setActivation({ mode: "auto", gates: { meter_installed: { enabled: false }, initial_reading: { enabled: false } } });
    registerGateSource("payment_threshold", async () => ({ met: true }));
    await expect(run(a.id)).resolves.toMatchObject({ activated: false, reason: expect.stringMatching(/pending payment/) });
    await env.manager().accounts.markPendingPayment({ accountId: a.id, reason: "Invoice issued" });
    await expect(run(a.id)).resolves.toMatchObject({ activated: true });
    expect((await env.clerk().accounts.get({ id: a.id })).commercialStatus).toBe("ACTIVE");
  });

  it("does nothing for an organization that has not licensed Accounts or for an unknown account", async () => {
    await expect(withTenant(env.t.app, env.orgC, (tx) => recheckActivation(tx, env.orgC, randomUUID()))).resolves.toMatchObject({ activated: false });
    await expect(withTenant(env.t.app, env.orgA, (tx) => recheckActivation(tx, env.orgA, randomUUID()))).resolves.toMatchObject({ activated: false });
  });

  it("completes by itself when the last checklist tick arrives", async () => {
    await setActivation({ mode: "auto", gates: { payment_threshold: { enabled: false }, meter_installed: { enabled: false } } });
    const a = await fresh();
    const status = await env.manager().accounts.activation.tick({ accountId: a.id, gateKey: "initial_reading" });
    expect(status).toMatchObject({ activated: true, commercialStatus: "ACTIVE" });
    expect((await commandsOf(a.id))[0]).toMatchObject({ source: "system", actorUserId: null });
  });
});

describe("commands (C-03)", () => {
  async function active() {
    await setActivation(noGates);
    const a = await fresh();
    await env.manager().accounts.activate({ accountId: a.id, reason: "Ready" });
    return a;
  }

  it("moves ACTIVE <-> DORMANT and keeps the service status", async () => {
    const a = await active();
    const dormant = await env.manager().accounts.makeDormant({ accountId: a.id, reason: "Owner abroad", reasonCode: "ABROAD", note: "Back in March" });
    expect(dormant.account).toMatchObject({ commercialStatus: "DORMANT", serviceStatus: "CONNECTED" });
    expect(dormant.command).toMatchObject({ reasonCode: "ABROAD", note: "Back in March" });
    await expectCode(env.manager().accounts.makeDormant({ accountId: a.id, reason: "Again" }), "PRECONDITION_FAILED");
    const off = await env.manager().accounts.disconnectService({ accountId: a.id, reason: "Unpaid for 60 days" });
    expect(off.account).toMatchObject({ commercialStatus: "DORMANT", serviceStatus: "DISCONNECTED", serviceStatusReason: "Unpaid for 60 days" });
    await expectCode(env.manager().accounts.reconnectService({ accountId: a.id, reason: "Paid" }), "PRECONDITION_FAILED");
    const back = await env.manager().accounts.reactivate({ accountId: a.id, reason: "Owner is back" });
    expect(back.account).toMatchObject({ commercialStatus: "ACTIVE", serviceStatus: "DISCONNECTED" });
    expect((await env.manager().accounts.reconnectService({ accountId: a.id, reason: "Paid" })).account).toMatchObject({ serviceStatus: "CONNECTED", serviceStatusReason: null });
    expect((await env.clerk().accounts.commands.list({ accountId: a.id })).map((c) => c.kind)).toEqual([
      "reconnect_service",
      "reactivate",
      "disconnect_service",
      "make_dormant",
      "activate",
    ]);
  });

  it("needs a reason on every command, and refuses what the state machine does not allow", async () => {
    const a = await active();
    for (const run of [
      () => env.manager().accounts.markPendingPayment({ accountId: a.id, reason: "  " }),
      () => env.manager().accounts.makeDormant({ accountId: a.id, reason: "" }),
      () => env.manager().accounts.disconnectService({ accountId: a.id, reason: "   " }),
      () => env.manager().accounts.terminate({ accountId: a.id, reason: "", acknowledgeNoLedger: true }),
    ]) {
      await expectCode(run(), "BAD_REQUEST");
    }
    await expectCode(env.manager().accounts.markPendingPayment({ accountId: a.id, reason: "No" }), "PRECONDITION_FAILED");
    await expectCode(env.manager().accounts.activate({ accountId: a.id, reason: "Again" }), "PRECONDITION_FAILED");
    await expectCode(env.manager().accounts.reactivate({ accountId: a.id, reason: "Not dormant" }), "PRECONDITION_FAILED");
    await expectCode(env.manager().accounts.reconnectService({ accountId: a.id, reason: "Already on" }), "PRECONDITION_FAILED");
    // A NEW account cannot be disconnected (it is not connected) or made dormant.
    const n = await fresh();
    await expectCode(env.manager().accounts.disconnectService({ accountId: n.id, reason: "No" }), "PRECONDITION_FAILED");
    await expectCode(env.manager().accounts.makeDormant({ accountId: n.id, reason: "No" }), "PRECONDITION_FAILED");
    await expectCode(env.manager().accounts.reconnectService({ accountId: n.id, reason: "No" }), "PRECONDITION_FAILED");
    expect(await commandsOf(n.id)).toEqual([]);
  });

  it("answers NOT_FOUND for an unknown account and a blank command list for a fresh one", async () => {
    await expectCode(env.manager().accounts.makeDormant({ accountId: randomUUID(), reason: "x" }), "NOT_FOUND");
    await expectCode(env.manager().accounts.commands.list({ accountId: randomUUID() }), "NOT_FOUND");
    expect(await env.manager().accounts.commands.list({ accountId: (await fresh()).id })).toEqual([]);
  });

  it("is terminal once terminated: no command, tick or write-off request works again", async () => {
    const a = await active();
    const done = await env.manager().accounts.terminate({ accountId: a.id, reason: "Customer left", acknowledgeNoLedger: true });
    expect(done.account).toMatchObject({ commercialStatus: "TERMINATED", serviceStatus: "DISCONNECTED", serviceStatusReason: "Account terminated: Customer left" });
    for (const run of [
      () => env.manager().accounts.markPendingPayment({ accountId: a.id, reason: "x" }),
      () => env.manager().accounts.activate({ accountId: a.id, reason: "x", override: undefined }),
      () => env.admin.accounts.activate({ accountId: a.id, reason: "x", override: true }),
      () => env.manager().accounts.makeDormant({ accountId: a.id, reason: "x" }),
      () => env.manager().accounts.reactivate({ accountId: a.id, reason: "x" }),
      () => env.manager().accounts.terminate({ accountId: a.id, reason: "x", acknowledgeNoLedger: true }),
      () => env.manager().accounts.disconnectService({ accountId: a.id, reason: "x" }),
      () => env.manager().accounts.reconnectService({ accountId: a.id, reason: "x" }),
      () => env.manager().accounts.activation.tick({ accountId: a.id, gateKey: "payment_threshold" }),
    ]) {
      await expectCode(run(), "PRECONDITION_FAILED");
    }
    await expectCode(env.manager().accounts.requestWriteOff({ accountId: a.id, amount: 1n, reasonCode: "OTHER", note: "x" }), "PRECONDITION_FAILED");
    expect(await env.clerk().accounts.get({ id: a.id })).toMatchObject({ commercialStatus: "TERMINATED" });
    const [event] = await eventsOf(a.id, "accounts.account_terminated");
    expect(event!.payload).toMatchObject({ from: "ACTIVE", basis: "no_ledger", balance: null, writeOffApprovalId: null, commandId: done.command.id });
  });

  it("does not let anything but a command change the status columns (database guard)", async () => {
    const a = await active();
    await expect(env.db.update(account).set({ commercialStatus: "TERMINATED" }).where(eq(account.id, a.id))).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/logged command/) },
    });
    // Even a command row written by hand must describe exactly the change, from the state it is in.
    expect(await env.clerk().accounts.get({ id: a.id })).toMatchObject({ commercialStatus: "ACTIVE" });
  });

  it("audits every command with before, after and the reason", async () => {
    await setActivation(noGates);
    const a = await fresh();
    await env.manager().accounts.markPendingPayment({ accountId: a.id, reason: "Invoice out" });
    await env.manager().accounts.activate({ accountId: a.id, reason: "Paid" });
    await env.manager().accounts.disconnectService({ accountId: a.id, reason: "Non-payment" });
    await env.manager().accounts.reconnectService({ accountId: a.id, reason: "Paid up" });
    await env.manager().accounts.makeDormant({ accountId: a.id, reason: "Vacant" });
    await env.manager().accounts.reactivate({ accountId: a.id, reason: "Occupied" });
    await env.manager().accounts.terminate({ accountId: a.id, reason: "Demolished", acknowledgeNoLedger: true });
    const entries = (await env.audit(a.id)).filter((e) => e.action !== "accounts.account_create").reverse();
    expect(entries.map((e) => e.action)).toEqual([
      "accounts.mark_pending_payment",
      "accounts.activate",
      "accounts.disconnect_service",
      "accounts.reconnect_service",
      "accounts.make_dormant",
      "accounts.reactivate",
      "accounts.terminate",
    ]);
    expect(entries.map((e) => e.reason)).toEqual(["Invoice out", "Paid", "Non-payment", "Paid up", "Vacant", "Occupied", "Demolished"]);
    for (const e of entries) {
      expect(e).toMatchObject({ subjectType: "account", actorUserId: env.users.manager, source: "api" });
      expect(e.before).toBeTruthy();
      expect(e.after).toMatchObject({ commandId: expect.any(String) });
    }
    expect(entries[0]!.before).toMatchObject({ commercialStatus: "NEW" });
    expect(entries[0]!.after).toMatchObject({ commercialStatus: "PENDING_PAYMENT" });
    expect(await commandsOf(a.id)).toHaveLength(7);
  });

  it("publishes the lifecycle events with ids, from and to, reason and the command id", async () => {
    await setActivation(noGates);
    const a = await fresh();
    const act = await env.manager().accounts.activate({ accountId: a.id, reason: "Ready" });
    const dormant = await env.manager().accounts.makeDormant({ accountId: a.id, reason: "Vacant" });
    const status = (await eventsOf(a.id, "accounts.account_status_changed")).map((e) => e.payload);
    expect(status).toHaveLength(2);
    expect(status).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountId: a.id, number: a.number, commandId: act.command.id, from: "NEW", to: "ACTIVE", reason: "Ready", kind: "activate", actorUserId: env.users.manager }),
        expect.objectContaining({ commandId: dormant.command.id, from: "ACTIVE", to: "DORMANT", reason: "Vacant" }),
      ]),
    );
    const service = (await eventsOf(a.id, "accounts.service_status_changed")).map((e) => e.payload);
    expect(service).toEqual([expect.objectContaining({ from: "DISCONNECTED", to: "CONNECTED", serviceReason: null, commandId: act.command.id })]);
    expect((await eventsOf(a.id, "accounts.account_activated"))[0]).toMatchObject({ version: 1 });
  });
});

// C-03: client-minted command ids make retries safe.
describe("command ids (idempotency)", () => {
  it("returns the earlier result for the same id and request, and writes nothing twice", async () => {
    await setActivation(noGates);
    const a = await fresh();
    const id = randomUUID();
    const first = await env.manager().accounts.activate({ id, accountId: a.id, reason: "Ready" });
    expect(first.replayed).toBe(false);
    const again = await env.manager().accounts.activate({ id, accountId: a.id, reason: "Ready" });
    expect(again.replayed).toBe(true);
    expect(again.command).toEqual(first.command);
    expect(await commandsOf(a.id)).toHaveLength(1);
    expect(await eventsOf(a.id, "accounts.account_activated")).toHaveLength(1);
    expect((await env.audit(a.id)).filter((e) => e.action === "accounts.activate")).toHaveLength(1);
    // The replay is still true after the account has moved on.
    await env.manager().accounts.makeDormant({ accountId: a.id, reason: "Away" });
    expect((await env.manager().accounts.activate({ id, accountId: a.id, reason: "Ready" })).replayed).toBe(true);
  });

  it("is CONFLICT for the same id with a different request, account, kind or person", async () => {
    const a = await fresh();
    const b = await fresh();
    const id = randomUUID();
    await env.manager().accounts.markPendingPayment({ id, accountId: a.id, reason: "Invoice out" });
    await expectCode(env.manager().accounts.markPendingPayment({ id, accountId: a.id, reason: "A different reason" }), "CONFLICT");
    await expectCode(env.manager().accounts.markPendingPayment({ id, accountId: a.id, reason: "Invoice out", note: "extra" }), "CONFLICT");
    await expectCode(env.manager().accounts.markPendingPayment({ id, accountId: b.id, reason: "Invoice out" }), "CONFLICT");
    await expectCode(env.manager().accounts.makeDormant({ id, accountId: a.id, reason: "Invoice out" }), "CONFLICT");
    await expectCode(env.admin.accounts.markPendingPayment({ id, accountId: a.id, reason: "Invoice out" }), "CONFLICT");
    // Another organization's command id is simply taken.
    await expectCode(env.outsider().accounts.markPendingPayment({ id, accountId: randomUUID(), reason: "x" }), "NOT_FOUND");
    expect(await commandsOf(a.id)).toHaveLength(1);
    expect(await commandsOf(b.id)).toHaveLength(0);
  });

  it("applies one of two simultaneous commands with the same id", async () => {
    const a = await fresh();
    const id = randomUUID();
    const results = await Promise.allSettled([1, 2, 3].map(() => env.as(env.members.manager).accounts.markPendingPayment({ id, accountId: a.id, reason: "Invoice out" })));
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(results.filter((r) => (r as PromiseFulfilledResult<{ replayed: boolean }>).value.replayed)).toHaveLength(2);
    expect(await commandsOf(a.id)).toHaveLength(1);
  });

  it("lets only one of two different commands race for the same state", async () => {
    await setActivation(noGates);
    const a = await fresh();
    const results = await Promise.allSettled([
      env.as(env.members.manager).accounts.activate({ accountId: a.id, reason: "Ready" }),
      env.as(env.members.admin).accounts.terminate({ accountId: a.id, reason: "Cancelled", acknowledgeNoLedger: true }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    const log = await commandsOf(a.id);
    // Whichever way it went, each command was planned from the state the other left.
    expect(log.length).toBe(results.filter((r) => r.status === "fulfilled").length === 2 ? 2 : 1);
    if (log.length === 2) expect(log.map((c) => c.kind).sort()).toEqual(["activate", "terminate"]);
  });
});

// K-03: who may change status.
describe("permissions (accounts:change_status)", () => {
  it("lets a manager and an owner change status, and refuses the clerk, cashier, supervisor and accountant", async () => {
    await setActivation(noGates);
    const a = await fresh();
    const calls = (c: ReturnType<typeof env.clerk>) => [
      () => c.accounts.markPendingPayment({ accountId: a.id, reason: "x" }),
      () => c.accounts.activate({ accountId: a.id, reason: "x" }),
      () => c.accounts.makeDormant({ accountId: a.id, reason: "x" }),
      () => c.accounts.reactivate({ accountId: a.id, reason: "x" }),
      () => c.accounts.terminate({ accountId: a.id, reason: "x", acknowledgeNoLedger: true }),
      () => c.accounts.disconnectService({ accountId: a.id, reason: "x" }),
      () => c.accounts.reconnectService({ accountId: a.id, reason: "x" }),
      () => c.accounts.activation.activate({ accountId: a.id, reason: "x" }),
      () => c.accounts.activation.tick({ accountId: a.id, gateKey: "payment_threshold" }),
      () => c.accounts.activation.untick({ accountId: a.id, gateKey: "payment_threshold" }),
      () => c.accounts.requestWriteOff({ accountId: a.id, amount: 1n, reasonCode: "OTHER", note: "x" }),
    ];
    for (const caller of [env.clerk(), env.cashier(), env.supervisor(), env.accountant()]) {
      for (const run of calls(caller)) await expectCode(run(), "FORBIDDEN");
    }
    expect(await commandsOf(a.id)).toEqual([]);
    // Reads need only accounts:read.
    for (const caller of [env.clerk(), env.cashier(), env.supervisor(), env.accountant()]) {
      expect(await caller.accounts.commands.list({ accountId: a.id })).toEqual([]);
      expect((await caller.accounts.activation.status({ accountId: a.id })).accountId).toBe(a.id);
      expect((await caller.accounts.statusRules()).table).toHaveLength(10);
    }
    await expect(env.manager().accounts.activate({ accountId: a.id, reason: "Ready" })).resolves.toBeTruthy();
    await expect(env.admin.accounts.terminate({ accountId: a.id, reason: "Done", acknowledgeNoLedger: true })).resolves.toBeTruthy();
    // An extra grant extends a role.
    await env.admin.access.grant({ userId: env.users.clerk, permission: "accounts:change_status" });
    const b = await fresh();
    await expect(env.clerk().accounts.markPendingPayment({ accountId: b.id, reason: "Granted" })).resolves.toBeTruthy();
    await env.admin.access.revoke({ userId: env.users.clerk, permission: "accounts:change_status" });
  });

  it("answers NOT_FOUND to an organization without Accounts", async () => {
    await expectCode(env.bare().accounts.activate({ accountId: randomUUID(), reason: "x" }), "NOT_FOUND");
    await expectCode(env.bare().accounts.statusRules(), "NOT_FOUND");
    await expectCode(env.bare().accounts.activation.status({ accountId: randomUUID() }), "NOT_FOUND");
    await expectCode(env.bare().accounts.commands.list({ accountId: randomUUID() }), "NOT_FOUND");
  });

  it("does not let another organization see or change the account", async () => {
    const a = await fresh();
    await expectCode(env.outsider().accounts.markPendingPayment({ accountId: a.id, reason: "x" }), "NOT_FOUND");
    await expectCode(env.outsider().accounts.commands.list({ accountId: a.id }), "NOT_FOUND");
    await expectCode(env.outsider().accounts.activation.status({ accountId: a.id }), "NOT_FOUND");
  });

  it("applies scope restrictions: a hidden account is NOT_FOUND to every lifecycle procedure", async () => {
    await setActivation(noGates);
    const inZone = await fresh();
    await env.clerk().accounts.servicePoints.create({ accountId: inZone.id, address: "In zone", zoneId: env.areas.zone });
    const elsewhere = await fresh();
    await env.clerk().accounts.servicePoints.create({ accountId: elsewhere.id, address: "Other zone", zoneId: env.areas.otherZone });
    const limited = await addMember(env.t, env.orgA, "manager");
    await env.admin.access.setScope({ userId: limited.userId, areaIds: [env.areas.zone], routeIds: [] });
    const asLimited = env.as(limited);

    const hidden = elsewhere.id;
    for (const run of [
      () => asLimited.accounts.markPendingPayment({ accountId: hidden, reason: "x" }),
      () => asLimited.accounts.activate({ accountId: hidden, reason: "x" }),
      () => asLimited.accounts.makeDormant({ accountId: hidden, reason: "x" }),
      () => asLimited.accounts.reactivate({ accountId: hidden, reason: "x" }),
      () => asLimited.accounts.terminate({ accountId: hidden, reason: "x", acknowledgeNoLedger: true }),
      () => asLimited.accounts.disconnectService({ accountId: hidden, reason: "x" }),
      () => asLimited.accounts.reconnectService({ accountId: hidden, reason: "x" }),
      () => asLimited.accounts.commands.list({ accountId: hidden }),
      () => asLimited.accounts.activation.status({ accountId: hidden }),
      () => asLimited.accounts.activation.tick({ accountId: hidden, gateKey: "payment_threshold" }),
      () => asLimited.accounts.activation.untick({ accountId: hidden, gateKey: "payment_threshold" }),
      () => asLimited.accounts.activation.activate({ accountId: hidden, reason: "x" }),
      () => asLimited.accounts.requestWriteOff({ accountId: hidden, amount: 1n, reasonCode: "OTHER", note: "x" }),
    ]) {
      await expectCode(run(), "NOT_FOUND");
    }
    expect(await commandsOf(hidden)).toEqual([]);
    expect((await asLimited.accounts.activate({ accountId: inZone.id, reason: "In my zone" })).account.commercialStatus).toBe("ACTIVE");
  });
});

// C-04: status-by-charge rules as configuration.
describe("status rules (C-04)", () => {
  it("returns the default table with its version, and an edited one at the date it is in force", async () => {
    const before = await env.clerk().accounts.statusRules();
    expect(before).toMatchObject({ version: 0, effectiveFrom: null });
    expect(before.rules).toEqual(statusRulesSetting.default);
    expect(before.table.find((r) => r.commercial === "ACTIVE" && r.service === "CONNECTED")).toMatchObject({ billsConsumption: true });
    expect(before.table.find((r) => r.commercial === "DORMANT" && r.service === "CONNECTED")).toMatchObject({ billsConsumption: false, chargeTypes: [] });

    const edited = { ...before.rules, DORMANT: { ...before.rules.DORMANT, CONNECTED: { billsConsumption: false, chargeTypes: ["recurring" as const] } } };
    const future = new Date(Date.now() + 40 * 86_400_000);
    await env.admin.config.set({ key: statusRulesSetting.key, value: edited, expectedVersion: 0, effectiveFrom: future, reason: "Charge rent on dormant plots" });
    expect((await env.clerk().accounts.statusRules()).version).toBe(0);
    const later = await env.clerk().accounts.statusRules({ at: new Date(future.getTime() + 1000) });
    expect(later.version).toBe(1);
    expect(later.table.find((r) => r.commercial === "DORMANT" && r.service === "CONNECTED")).toMatchObject({ chargeTypes: ["recurring"] });
    // Only settings:manage edits it, and an inconsistent cell is refused.
    await expectCode(env.manager().config.set({ key: statusRulesSetting.key, value: edited, expectedVersion: 1 }), "FORBIDDEN");
    await expect(
      env.admin.config.set({ key: statusRulesSetting.key, value: { ...edited, NEW: { ...edited.NEW, CONNECTED: { billsConsumption: false, chargeTypes: ["usage"] } } }, expectedVersion: 1 }),
    ).rejects.toBeDefined();
  });
});

// C-11: termination needs a settled position, or an approved write-off.
describe("termination (C-11)", () => {
  async function activeAccount() {
    await setActivation(noGates);
    const a = await fresh();
    await env.manager().accounts.activate({ accountId: a.id, reason: "Ready" });
    return a;
  }

  it("with no ledger registered needs an explicit acknowledgement, recorded in the command", async () => {
    const a = await activeAccount();
    await expect(env.manager().accounts.terminate({ accountId: a.id, reason: "Left" })).rejects.toThrow(/no ledger/i);
    const done = await env.manager().accounts.terminate({ accountId: a.id, reason: "Left", acknowledgeNoLedger: true });
    expect(done.command.payload).toMatchObject({ basis: "no_ledger", acknowledgeNoLedger: true, balance: null });
    expect((await env.audit(a.id)).find((e) => e.action === "accounts.terminate")!.after).toMatchObject({ basis: "no_ledger" });
  });

  it("with a ledger needs the final bill and a zero balance", async () => {
    const position = { finalBillIssued: false, balance: 0n };
    registerTerminationCheck(async () => position);
    const a = await activeAccount();
    await expect(env.manager().accounts.terminate({ accountId: a.id, reason: "Left" })).rejects.toThrow(/final bill/);
    position.finalBillIssued = true;
    position.balance = 120_000n;
    await expect(env.manager().accounts.terminate({ accountId: a.id, reason: "Left" })).rejects.toThrow(/not settled/);
    // The acknowledgement does not stand in for a ledger that exists.
    await expect(env.manager().accounts.terminate({ accountId: a.id, reason: "Left", acknowledgeNoLedger: true })).rejects.toThrow(/not settled/);
    position.balance = 0n;
    const done = await env.manager().accounts.terminate({ accountId: a.id, reason: "Left" });
    expect(done.command.payload).toMatchObject({ basis: "settled", balance: "0", finalBillIssued: true });
    expect((await eventsOf(a.id, "accounts.account_terminated"))[0]!.payload).toMatchObject({ basis: "settled", balance: "0" });
  });

  it("treats a ledger with no answer yet as no ledger", async () => {
    registerTerminationCheck(async () => null);
    const a = await activeAccount();
    await expect(env.manager().accounts.terminate({ accountId: a.id, reason: "Left", acknowledgeNoLedger: true })).resolves.toBeTruthy();
  });

  it("asks a ledger check that requires Billing only while Billing is licensed (NF-31)", async () => {
    let asked = 0;
    registerTerminationCheck(
      async () => {
        asked += 1;
        return { finalBillIssued: false, balance: 0n };
      },
      { requires: ["billing"] },
    );
    const a = await activeAccount();
    try {
      // Without Billing the check is not asked: the organization terminates as if there were no ledger yet.
      await expect(env.manager().accounts.terminate({ accountId: a.id, reason: "Left" })).rejects.toThrow(/no ledger/i);
      expect(asked).toBe(0);

      // With Billing licensed the check is enforced.
      await setEntitlements(env.t.app, env.orgA, ["accounts", "tariffs", "billing"]);
      await expect(env.manager().accounts.terminate({ accountId: a.id, reason: "Left", acknowledgeNoLedger: true })).rejects.toThrow(/final bill/);
      expect(asked).toBe(1);
    } finally {
      await setEntitlements(env.t.app, env.orgA, ["accounts"]);
    }
    const done = await env.manager().accounts.terminate({ accountId: a.id, reason: "Left", acknowledgeNoLedger: true });
    expect(done.command.payload).toMatchObject({ basis: "no_ledger" });
  });

  it("terminates over a balance only with an approved write-off that covers it", async () => {
    const position = { finalBillIssued: true, balance: 250_000n };
    registerTerminationCheck(async () => position);
    const a = await activeAccount();
    const other = await activeAccount();
    const noApproval = env.manager().accounts.terminate({ accountId: a.id, reason: "Absconded" });
    await expect(noApproval).rejects.toThrow(/request a write-off/);

    // A request that does not cover the balance is refused at once; a reason must come from the list.
    await expectCode(env.manager().accounts.requestWriteOff({ accountId: a.id, amount: 100_000n, reasonCode: "ABSCONDED", note: "Partial" }), "BAD_REQUEST");
    await expectCode(env.manager().accounts.requestWriteOff({ accountId: a.id, amount: 250_000n, reasonCode: "MADE_UP", note: "x" }), "BAD_REQUEST");
    const asked = await env.manager().accounts.requestWriteOff({ accountId: a.id, amount: 250_000n, reasonCode: "ABSCONDED", note: "Customer left no forwarding address" });
    expect(asked.status).toBe("pending");
    expect(await actionsOf(a.id)).not.toContain("accounts.write_off_decided");
    await expectCode(env.manager().accounts.requestWriteOff({ accountId: a.id, amount: 250_000n, reasonCode: "ABSCONDED", note: "Again" }), "CONFLICT");
    expect((await env.admin.audit.list({ subjectId: asked.approvalId })).entries.map((e) => e.action)).toContain("approvals.request");

    // Pending is not enough.
    await expect(env.manager().accounts.terminate({ accountId: a.id, reason: "Absconded", approvalId: asked.approvalId })).rejects.toThrow(/pending/);
    // The requester cannot approve their own request; an accountant can.
    await expectCode(env.manager().approvals.approve({ id: asked.approvalId }), "FORBIDDEN");
    await env.accountant().approvals.approve({ id: asked.approvalId, note: "Reviewed the file" });

    // The approval is not another account's.
    await expect(env.manager().accounts.terminate({ accountId: other.id, reason: "x", approvalId: asked.approvalId })).rejects.toThrow(/not a write-off of this account/);
    await expect(env.manager().accounts.terminate({ accountId: a.id, reason: "x", approvalId: randomUUID() })).rejects.toThrow(/not found/);

    // The outcome is recorded on the account by the approval consumer.
    await drainOutbox(env.t.app, consumers);
    const decided = (await commandsOf(a.id)).find((c) => c.kind === "write_off_decided")!;
    expect(decided).toMatchObject({ id: asked.approvalId, actorUserId: null, source: "system", toCommercialStatus: "ACTIVE" });
    expect(decided.payload).toMatchObject({ outcome: "approved", amount: "250000" });
    await drainOutbox(env.t.app, consumers);
    expect((await commandsOf(a.id)).filter((c) => c.kind === "write_off_decided")).toHaveLength(1);
    expect(await actionsOf(a.id)).toContain("accounts.write_off_decided");
    expect((await env.clerk().accounts.commands.list({ accountId: a.id })).map((c) => c.kind)).toContain("write_off_decided");

    // The balance grew after the approval: it no longer covers it.
    position.balance = 300_000n;
    await expect(env.manager().accounts.terminate({ accountId: a.id, reason: "x", approvalId: asked.approvalId })).rejects.toThrow(/does not cover/);
    position.balance = 250_000n;
    const done = await env.manager().accounts.terminate({ accountId: a.id, reason: "Absconded", approvalId: asked.approvalId });
    expect(done.account.commercialStatus).toBe("TERMINATED");
    expect(done.command.payload).toMatchObject({ basis: "written_off", balance: "250000", writeOffApprovalId: asked.approvalId });
    expect((await eventsOf(a.id, "accounts.account_terminated"))[0]!.payload).toMatchObject({ basis: "written_off", writeOffApprovalId: asked.approvalId });
  });

  it("does not terminate on a rejected write-off, and records the rejection", async () => {
    registerTerminationCheck(async () => ({ finalBillIssued: true, balance: 90_000n }));
    const a = await activeAccount();
    const asked = await env.manager().accounts.requestWriteOff({ accountId: a.id, amount: 90_000n, reasonCode: "UNCOLLECTABLE", note: "Cannot trace" });
    await env.accountant().approvals.reject({ id: asked.approvalId, note: "Try collection first" });
    await drainOutbox(env.t.app, consumers);
    expect((await commandsOf(a.id)).find((c) => c.kind === "write_off_decided")!.payload).toMatchObject({ outcome: "rejected" });
    await expect(env.manager().accounts.terminate({ accountId: a.id, reason: "x", approvalId: asked.approvalId })).rejects.toThrow(/rejected/);
    // A fresh request can be made after a rejection.
    await expect(env.manager().accounts.requestWriteOff({ accountId: a.id, amount: 90_000n, reasonCode: "UNCOLLECTABLE", note: "Collection failed" })).resolves.toBeTruthy();
  });

  it("refuses a write-off where there is no balance or no ledger", async () => {
    const a = await activeAccount();
    registerTerminationCheck(async () => ({ finalBillIssued: true, balance: 0n }));
    await expectCode(env.manager().accounts.requestWriteOff({ accountId: a.id, amount: 1_000n, reasonCode: "OTHER", note: "x" }), "BAD_REQUEST");
    registerTerminationCheck(null);
    const request = await env.manager().accounts.requestWriteOff({ accountId: a.id, amount: 1_000n, reasonCode: "OTHER", note: "Ledger is coming" });
    await env.accountant().approvals.approve({ id: request.approvalId });
    await expect(env.manager().accounts.terminate({ accountId: a.id, reason: "x", approvalId: request.approvalId, acknowledgeNoLedger: true })).rejects.toThrow(/no ledger yet/);
  });
});

// C-06, X-02: stale accounts go to the exception queue.
describe("stale account sweep (C-06, X-02)", () => {
  const exceptionsFor = (accountNumber: string) => env.db.select().from(exception).where(and(eq(exception.subjectRef, accountNumber), eq(exception.source, "accounts")));
  const age = (accountId: string, days: number) =>
    env.db
      .update(account)
      .set({ openedAt: new Date(Date.now() - days * 86_400_000) })
      .where(eq(account.id, accountId));

  it("raises one exception per stale account, owned by who opened it, and resolves it when the account leaves the state", async () => {
    await setActivation({ staleAfterDays: 10, ...noGates });
    const stale = await fresh();
    await env.clerk().accounts.servicePoints.create({ accountId: stale.id, address: "Plot 9", zoneId: env.areas.zone, routeId: env.routes.route });
    const young = await fresh();
    await age(stale.id, 11);
    await age(young.id, 9);

    expect(await sweepStaleAccounts(env.t.app)).toBeGreaterThanOrEqual(1);
    const [raised] = await exceptionsFor(stale.number);
    expect(raised).toMatchObject({
      type: "STALE_ACTIVATION",
      source: "accounts",
      subjectKind: "account",
      status: "open",
      ownerUserId: env.users.clerk,
      areaId: env.areas.zone,
      routeId: env.routes.route,
      dedupeKey: `account_stale:${stale.id}`,
    });
    expect(raised!.title).toMatch(/Stuck in NEW/);
    expect(await exceptionsFor(young.number)).toEqual([]);

    // Sweeping again raises nothing new and does not count another occurrence.
    await sweepStaleAccounts(env.t.app);
    expect(await exceptionsFor(stale.number)).toHaveLength(1);
    expect((await exceptionsFor(stale.number))[0]!.occurrences).toBe(1);
    // Visible in the queue API to someone with exceptions:read.
    expect((await env.clerk().exceptions.list()).some((e) => e.subjectRef === stale.number)).toBe(true);

    // Activating resolves it.
    await env.manager().accounts.activate({ accountId: stale.id, reason: "Ready" });
    await sweepStaleAccounts(env.t.app);
    expect((await exceptionsFor(stale.number))[0]).toMatchObject({ status: "resolved" });
    expect((await exceptionsFor(stale.number))[0]!.resolutionNote).toMatch(/no longer stale/);
  });

  it("counts PENDING_PAYMENT from when the account entered it, raises again if it goes stale again, and follows the setting", async () => {
    await setActivation({ staleAfterDays: 5, ...noGates });
    const a = await fresh();
    await age(a.id, 30);
    await env.manager().accounts.markPendingPayment({ accountId: a.id, reason: "Invoice out" });
    // Long NEW, but only just pending payment: not stale yet.
    await sweepStaleAccounts(env.t.app);
    expect(await exceptionsFor(a.number)).toEqual([]);
    await env.db
      .update(accountCommand)
      .set({ occurredAt: new Date(Date.now() - 6 * 86_400_000) })
      .where(and(eq(accountCommand.accountId, a.id), eq(accountCommand.kind, "mark_pending_payment")));
    await sweepStaleAccounts(env.t.app);
    const [raised] = await exceptionsFor(a.number);
    expect(raised!.title).toMatch(/PENDING_PAYMENT/);
    // Raising the limit makes it no longer stale.
    await setActivation({ staleAfterDays: 60, ...noGates });
    await sweepStaleAccounts(env.t.app);
    expect((await exceptionsFor(a.number))[0]!.status).toBe("resolved");
    // Terminated accounts are out of it too.
    await setActivation({ staleAfterDays: 1, ...noGates });
    await sweepStaleAccounts(env.t.app);
    expect((await exceptionsFor(a.number)).filter((e) => e.status !== "resolved")).toHaveLength(1);
    await env.manager().accounts.terminate({ accountId: a.id, reason: "Abandoned", acknowledgeNoLedger: true });
    await sweepStaleAccounts(env.t.app);
    expect((await exceptionsFor(a.number)).filter((e) => e.status !== "resolved")).toEqual([]);
  });

  it("raises ACCOUNT_NOT_ACTIVE_WITH_METER only when the sources say a meter is installed and read, and resolves it on activation", async () => {
    await setActivation({ staleAfterDays: 365 });
    const a = await fresh();
    const b = await fresh();
    await sweepStaleAccounts(env.t.app);
    expect(await exceptionsFor(a.number)).toEqual([]);
    // Only one of the two sources: nothing is known.
    registerGateSource("meter_installed", async () => ({ met: true }));
    await sweepStaleAccounts(env.t.app);
    expect(await exceptionsFor(a.number)).toEqual([]);
    registerGateSource("initial_reading", async (_tx, _org, id) => ({ met: id === a.id }));
    await sweepStaleAccounts(env.t.app);
    expect((await exceptionsFor(a.number)).map((e) => e.type)).toEqual(["ACCOUNT_NOT_ACTIVE_WITH_METER"]);
    expect(await exceptionsFor(b.number)).toEqual([]);
    await sweepStaleAccounts(env.t.app);
    expect(await exceptionsFor(a.number)).toHaveLength(1);

    await setActivation(noGates);
    await env.manager().accounts.activate({ accountId: a.id, reason: "Finally" });
    await sweepStaleAccounts(env.t.app);
    expect((await exceptionsFor(a.number))[0]).toMatchObject({ status: "resolved" });
  });

  it("leaves an organization that has not licensed Accounts alone", async () => {
    await setEntitlements(env.t.app, env.orgC, ["accounts"]);
    const customer = await env.bare().accounts.customers.create({ type: "person", name: "Unlicensed Una" });
    const una = await env.bare().accounts.create({ customerId: customer.id });
    await env.bare().accounts.activation.status({ accountId: una.id });
    await env.db.update(account).set({ openedAt: new Date(Date.now() - 400 * 86_400_000) }).where(eq(account.id, una.id));
    await setEntitlements(env.t.app, env.orgC, []);
    await sweepStaleAccounts(env.t.app);
    expect(await env.db.select().from(exception).where(eq(exception.organizationId, env.orgC))).toEqual([]);
    // Licensed again, the same account is raised (the default is 14 days).
    await setEntitlements(env.t.app, env.orgC, ["accounts"]);
    await sweepStaleAccounts(env.t.app);
    expect((await env.db.select().from(exception).where(inArray(exception.subjectRef, [una.number]))).length).toBe(1);
    await setEntitlements(env.t.app, env.orgC, []);
  });
});
