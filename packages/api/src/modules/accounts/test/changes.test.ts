import { outboxEvent, withTenant } from "@flowless/db";
import { account, accountCommand, accountHolder, relocation, servicePoint } from "@flowless/db/schema/accounts";
import { randomUUID } from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { consumers } from "../../../kernel/consumers";
import { setEntitlements } from "../../../kernel/entitlement-store";
import { drainOutbox } from "../../../kernel/events";
import { addMember } from "../../../test-support";
import { holderAt, holdersOf, membershipFor, registerBalanceTransfer, registerReadingHandover, type BalanceTransferRequest, type ReadingHandoverRequest } from "..";
import { activationConfigSchema } from "../gates";
import { activationSetting } from "../settings";
import { expectCode, setupAccountsEnv, type AccountsEnv } from "./test-support";

let env: AccountsEnv;
beforeAll(async () => {
  env = await setupAccountsEnv();
  await setSetting(activationSetting.key, activationConfigSchema.parse({ gates: { payment_threshold: { enabled: false }, meter_installed: { enabled: false }, initial_reading: { enabled: false } } }));
});
afterAll(() => env?.t.stop());
afterEach(async () => {
  registerBalanceTransfer(null);
  registerReadingHandover(null);
  await setSetting("accounts.application", {});
  await setSetting("accounts.membership", { classes: [] });
  await setEntitlements(env.t.app, env.orgA, ["accounts"]);
});

async function setSetting(key: string, value: unknown) {
  const current = (await env.admin.config.list()).find((s) => s.key === key)!;
  await env.admin.config.set({ key, value, expectedVersion: current.version });
}

const inTenant = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(env.t.app, env.orgA, fn);
const events = async (type: string, key: string, value: string) =>
  (await env.db.select().from(outboxEvent)).filter((e) => e.type === type && (e.payload as Record<string, unknown>)[key] === value);
const commandsOf = (accountId: string) => env.db.select().from(accountCommand).where(eq(accountCommand.accountId, accountId));
const accountRow = async (id: string) => (await env.db.select().from(account).where(eq(account.id, id)))[0]!;

/** An ACTIVE, CONNECTED account with one service point, opened a year ago. */
async function activeAccount(opts: { parentAccountId?: string; points?: number } = {}) {
  const customer = await env.person(env.clerk(), `Holder ${randomUUID().slice(0, 6)}`);
  const a = await env.clerk().accounts.create({ customerId: customer.id, ...(opts.parentAccountId ? { parentAccountId: opts.parentAccountId } : {}) });
  await env.manager().accounts.activate({ accountId: a.id, reason: "Test" });
  const points = [];
  for (let i = 0; i < (opts.points ?? 1); i++) {
    points.push(
      await env.clerk().accounts.servicePoints.create({
        accountId: a.id,
        address: `Plot ${i + 1}`,
        location: { lat: -1.2, lng: 36.9 },
        schemeId: env.areas.scheme,
        zoneId: env.areas.zone,
        dmaId: env.areas.dma,
        routeId: env.routes.route,
        connectionStatus: "CONNECTED",
      }),
    );
  }
  await env.db.update(accountHolder).set({ validFrom: "2020-01-01" }).where(eq(accountHolder.accountId, a.id));
  return { account: a, customer, points };
}

// C-07: membership classes are configuration; the account holds the key.
describe("memberships (C-07)", () => {
  const classes = { classes: [{ key: "member", label: "Member", connectionFeeChargeItemCode: "connection_member" }, { key: "associate", label: "Associate" }] };

  it("sets and clears a configured class on a child account, audited, and Billing reads it with membershipFor", async () => {
    await setSetting("accounts.membership", classes);
    const parent = await activeAccount();
    const child = await env.clerk().accounts.create({ customerId: parent.customer.id, parentAccountId: parent.account.id });
    expect((await env.clerk().accounts.memberships.classes()).map((c) => c.key)).toEqual(["member", "associate"]);

    await expectCode(env.clerk().accounts.memberships.setClass({ accountId: parent.account.id, membershipClass: "member" }), "BAD_REQUEST");
    await expectCode(env.clerk().accounts.memberships.setClass({ accountId: child.id, membershipClass: "gold" }), "BAD_REQUEST");
    await expectCode(env.cashier().accounts.memberships.setClass({ accountId: child.id, membershipClass: "member" }), "FORBIDDEN");
    await expectCode(env.outsider().accounts.memberships.setClass({ accountId: child.id, membershipClass: "member" }), "NOT_FOUND");

    const view = await env.clerk().accounts.memberships.setClass({ accountId: child.id, membershipClass: "member" });
    expect(view).toMatchObject({ membershipClass: "member", label: "Member", connectionFeeChargeItemCode: "connection_member", parentAccountId: parent.account.id, configured: true });
    expect(await inTenant((tx) => membershipFor(tx, child.id))).toEqual(view);
    expect((await env.clerk().accounts.get({ id: child.id })).membershipClass).toBe("member");
    // Nothing is written when it does not change.
    await env.clerk().accounts.memberships.setClass({ accountId: child.id, membershipClass: "member" });
    expect((await env.audit(child.id)).filter((e) => e.action === "accounts.membership_class_set")).toHaveLength(1);
    expect(await events("accounts.membership_class_changed", "accountId", child.id)).toHaveLength(1);

    // A class later removed from the setting keeps its key, flagged for Billing to fall back.
    await setSetting("accounts.membership", { classes: [{ key: "associate", label: "Associate" }] });
    expect(await inTenant((tx) => membershipFor(tx, child.id))).toMatchObject({ membershipClass: "member", label: null, connectionFeeChargeItemCode: null, configured: false });

    const cleared = await env.clerk().accounts.memberships.setClass({ accountId: child.id, membershipClass: null });
    expect(cleared).toMatchObject({ membershipClass: null, configured: true });
    await expectCode(env.clerk().accounts.memberships.setClass({ accountId: parent.account.id, membershipClass: null }), "BAD_REQUEST");
    expect(await inTenant((tx) => membershipFor(tx, randomUUID()))).toBeNull();
  });

  it("refuses a class on an account with no parent at the database too", async () => {
    const a = await activeAccount();
    await expect(env.db.update(account).set({ membershipClass: "member" }).where(eq(account.id, a.account.id))).rejects.toThrow();
  });

  it("opens a child account with its class", async () => {
    await setSetting("accounts.membership", classes);
    const parent = await activeAccount();
    const child = await env.clerk().accounts.create({ customerId: parent.customer.id, parentAccountId: parent.account.id, membershipClass: "associate" });
    expect(child.membershipClass).toBe("associate");
    await expectCode(env.clerk().accounts.create({ customerId: parent.customer.id, membershipClass: "associate" }), "BAD_REQUEST");
  });
});

// C-08: a successor account, a DORMANT predecessor with a pointer, and ports for what does not exist yet.
describe("succession (C-08)", () => {
  it("creates the successor, makes the old account DORMANT with a pointer and records what is still pending", async () => {
    const old = await activeAccount({ points: 2 });
    const manager = env.manager();
    const id = randomUUID();
    const done = await manager.accounts.succeed({
      id,
      accountId: old.account.id,
      basis: "change_of_name",
      newCustomer: { type: "person", name: "Njeri Waweru", contacts: [{ channel: "phone", value: "0733 111 222" }] },
      reason: "Plot sold to Njeri Waweru",
    });
    expect(done.replayed).toBe(false);
    expect(done.predecessor).toMatchObject({ id: old.account.id, commercialStatus: "DORMANT", successorAccountId: done.successor.id });
    expect(done.successor).toMatchObject({
      predecessorAccountId: old.account.id,
      commercialStatus: "ACTIVE",
      serviceStatus: "CONNECTED",
      parentAccountId: null,
      customerName: "Njeri Waweru",
    });
    expect(done.successor.number).not.toBe(old.account.number);
    expect(done.command).toMatchObject({ id, kind: "succeed", toCommercialStatus: "DORMANT" });
    expect(done.command.payload).toMatchObject({
      basis: "change_of_name",
      successorAccountId: done.successor.id,
      transfer: "pending_ledger",
      readingHandover: "pending_metering",
      previousCustomerId: old.customer.id,
    });

    // The service points moved, audited.
    const points = await env.db.select().from(servicePoint).where(eq(servicePoint.accountId, done.successor.id));
    expect(points.map((p) => p.id).sort()).toEqual(old.points.map((p) => p.id).sort());
    expect((await env.db.select().from(servicePoint).where(eq(servicePoint.accountId, old.account.id)))).toHaveLength(0);
    expect((await env.audit(old.points[0]!.id)).map((e) => e.action)).toContain("accounts.service_point_update");

    // Both logs tell it: the old account's make_dormant and succeed, the successor's arrival.
    expect((await commandsOf(old.account.id)).map((c) => c.kind).sort()).toEqual(["activate", "make_dormant", "succeed"]);
    expect((await commandsOf(done.successor.id)).map((c) => c.kind)).toEqual(["succeed"]);
    expect((await env.audit(old.account.id)).map((e) => e.action)).toEqual(expect.arrayContaining(["accounts.succeed", "accounts.make_dormant"]));
    expect(await events("accounts.account_succeeded", "predecessorAccountId", old.account.id)).toHaveLength(1);
    expect((await events("accounts.account_succeeded", "predecessorAccountId", old.account.id))[0]!.payload).toMatchObject({
      transfer: "pending_ledger",
      readingHandover: "pending_metering",
      basis: "change_of_name",
    });
    // The successor has its own holder history.
    expect((await inTenant((tx) => holdersOf(tx, done.successor.id))).map((h) => h.customerId)).toEqual([done.successor.customerId]);

    // A retry returns the same successor; another succession of the same account is refused.
    const again = await manager.accounts.succeed({ id, accountId: old.account.id, basis: "change_of_name", newCustomer: { type: "person", name: "Njeri Waweru", contacts: [{ channel: "phone", value: "0733 111 222" }] }, reason: "Plot sold to Njeri Waweru" });
    expect([again.replayed, again.successor.id]).toEqual([true, done.successor.id]);
    await expectCode(manager.accounts.succeed({ id, accountId: old.account.id, basis: "relocation_new_number", reason: "Different" }), "CONFLICT");
    await expectCode(manager.accounts.succeed({ accountId: old.account.id, basis: "relocation_new_number", reason: "Again" }), "CONFLICT");
    expect((await env.db.select().from(account).where(eq(account.predecessorAccountId, old.account.id)))).toHaveLength(1);
  });

  it("turns a child into a full member with a number of its own and no parent", async () => {
    const parent = await activeAccount();
    const child = await activeAccount({ parentAccountId: parent.account.id });
    expect(child.account.number).toBe(`${parent.account.number}A`);
    await expectCode(env.manager().accounts.succeed({ accountId: parent.account.id, basis: "full_membership", reason: "x" }), "BAD_REQUEST");
    const done = await env.manager().accounts.succeed({ accountId: child.account.id, basis: "full_membership", reason: "Becomes a full member" });
    expect(done.successor).toMatchObject({ parentAccountId: null, customerId: child.customer.id, commercialStatus: "ACTIVE" });
    expect(done.successor.number).not.toBe(child.account.number);
    expect((await env.manager().accounts.get({ id: child.account.id })).commercialStatus).toBe("DORMANT");
  });

  it("keeps the parent when a child's successor is a change of name, and asks for a different customer", async () => {
    const parent = await activeAccount();
    const child = await activeAccount({ parentAccountId: parent.account.id });
    await expectCode(env.manager().accounts.succeed({ accountId: child.account.id, basis: "change_of_name", reason: "x" }), "BAD_REQUEST");
    const other = await env.person(env.clerk(), "New Owner");
    const done = await env.manager().accounts.succeed({ accountId: child.account.id, basis: "change_of_name", customerId: other.id, reason: "Sold" });
    expect(done.successor).toMatchObject({ parentAccountId: parent.account.id, customerId: other.id });
  });

  it("leaves the service points when asked, and takes only accounts that are active or dormant", async () => {
    const customer = await env.person(env.clerk());
    const fresh = await env.clerk().accounts.create({ customerId: customer.id });
    await expectCode(env.manager().accounts.succeed({ accountId: fresh.id, basis: "relocation_new_number", reason: "x" }), "PRECONDITION_FAILED");
    const old = await activeAccount();
    const dormant = await env.manager().accounts.makeDormant({ accountId: old.account.id, reason: "Away" });
    expect(dormant.account.commercialStatus).toBe("DORMANT");
    const done = await env.manager().accounts.succeed({ accountId: old.account.id, basis: "relocation_new_number", servicePoints: "leave", reason: "Moves, new number" });
    expect(done.successor).toMatchObject({ commercialStatus: "DORMANT" });
    expect(await env.db.select().from(servicePoint).where(eq(servicePoint.accountId, old.account.id))).toHaveLength(1);
    expect((await commandsOf(old.account.id)).filter((c) => c.kind === "make_dormant")).toHaveLength(1);
  });

  it("hands the balance and the final reading to the registered ports, inside the command", async () => {
    const transfers: BalanceTransferRequest[] = [];
    const handovers: ReadingHandoverRequest[] = [];
    registerBalanceTransfer(async (_tx, _org, request) => void transfers.push(request));
    registerReadingHandover(async (_tx, _org, request) => {
      handovers.push(request);
      return { closingReadingRef: "READING-77" };
    });
    const old = await activeAccount();
    const done = await env.manager().accounts.succeed({ accountId: old.account.id, basis: "relocation_new_number", reason: "Moves" });
    expect(transfers).toEqual([{ fromAccountId: old.account.id, toAccountId: done.successor.id, commandId: done.command.id }]);
    expect(handovers[0]).toMatchObject({ reason: "succession", fromAccountId: old.account.id, toAccountId: done.successor.id, commandId: done.command.id, servicePointIds: [old.points[0]!.id] });
    expect(done.command.payload).toMatchObject({ transfer: "done", readingHandover: "done", closingReadingRef: "READING-77" });
    expect((await events("accounts.account_succeeded", "predecessorAccountId", old.account.id))[0]!.payload).toMatchObject({ transfer: "done", readingHandover: "done" });
  });

  it("does not ask a port whose module is not licensed", async () => {
    let called = 0;
    registerBalanceTransfer(async () => void (called += 1), { requires: ["billing"] });
    registerReadingHandover(async () => void (called += 1), { requires: ["metering"] });
    const old = await activeAccount();
    const done = await env.manager().accounts.succeed({ accountId: old.account.id, basis: "relocation_new_number", reason: "Moves" });
    expect(called).toBe(0);
    expect(done.command.payload).toMatchObject({ transfer: "pending_ledger", readingHandover: "pending_metering" });
  });

  it("rolls everything back when a port fails", async () => {
    registerBalanceTransfer(async () => {
      throw new Error("Ledger is down");
    });
    const old = await activeAccount();
    await expect(env.manager().accounts.succeed({ accountId: old.account.id, basis: "relocation_new_number", reason: "Moves" })).rejects.toThrow(/Ledger is down/);
    expect(await accountRow(old.account.id)).toMatchObject({ commercialStatus: "ACTIVE", successorAccountId: null });
    expect(await env.db.select().from(account).where(eq(account.predecessorAccountId, old.account.id))).toHaveLength(0);
    expect(await env.db.select().from(servicePoint).where(eq(servicePoint.accountId, old.account.id))).toHaveLength(1);
  });

  it("is for managers, and pointers are set once in the database", async () => {
    const old = await activeAccount();
    await expectCode(env.clerk().accounts.succeed({ accountId: old.account.id, basis: "relocation_new_number", reason: "x" }), "FORBIDDEN");
    await expectCode(env.outsider().accounts.succeed({ accountId: old.account.id, basis: "relocation_new_number", reason: "x" }), "NOT_FOUND");
    await expectCode(env.bare().accounts.succeed({ accountId: old.account.id, basis: "relocation_new_number", reason: "x" }), "NOT_FOUND");
    const done = await env.manager().accounts.succeed({ accountId: old.account.id, basis: "relocation_new_number", reason: "Moves" });
    await expect(env.db.update(account).set({ successorAccountId: null }).where(eq(account.id, old.account.id))).rejects.toThrow();
    const third = await activeAccount();
    await expect(env.db.update(account).set({ predecessorAccountId: third.account.id }).where(eq(account.id, done.successor.id))).rejects.toThrow();
    await expect(env.db.update(account).set({ successorAccountId: done.successor.id }).where(eq(account.id, third.account.id))).rejects.toThrow();
  });
});

// C-10: the holder changes from a date; the number stays.
describe("change of name (C-10)", () => {
  it("records the new holder from the effective date and resolves earlier dates to the previous holder", async () => {
    const a = await activeAccount();
    const next = await env.person(env.clerk(), "Mary Atieno");
    const manager = env.manager();
    const id = randomUUID();
    const done = await manager.accounts.changeName({ id, accountId: a.account.id, customerId: next.id, effectiveDate: "2025-06-15", reason: "Transfer of ownership" });
    expect(done.account).toMatchObject({ number: a.account.number, customerId: next.id, customerName: "Mary Atieno", commercialStatus: "ACTIVE" });
    expect(done.command).toMatchObject({ id, kind: "change_name", toCommercialStatus: "ACTIVE" });
    expect(done.command.payload).toMatchObject({ fromCustomerId: a.customer.id, toCustomerId: next.id, effectiveDate: "2025-06-15", closing_reading_pending: true });

    expect(await inTenant((tx) => holderAt(tx, a.account.id, "2025-06-14"))).toMatchObject({ customerId: a.customer.id, validFrom: "2020-01-01", validTo: "2025-06-15" });
    expect(await inTenant((tx) => holderAt(tx, a.account.id, "2025-06-15"))).toMatchObject({ customerId: next.id, validTo: null, commandId: done.command.id });
    expect(await inTenant((tx) => holderAt(tx, a.account.id, "2019-12-31"))).toBeNull();
    expect(await env.manager().accounts.holders.at({ accountId: a.account.id, date: "2024-01-01" })).toMatchObject({ customerId: a.customer.id });

    // A later change keeps both earlier holders resolvable.
    const third = await env.person(env.clerk(), "Peter Otieno");
    await manager.accounts.changeName({ accountId: a.account.id, customerId: third.id, effectiveDate: "2025-09-01", closingReadingRef: "READ-0042", reason: "Sold again" });
    const history = await manager.accounts.holders.list({ accountId: a.account.id });
    expect(history.map((h) => [h.customerId, h.validFrom, h.validTo])).toEqual([
      [a.customer.id, "2020-01-01", "2025-06-15"],
      [next.id, "2025-06-15", "2025-09-01"],
      [third.id, "2025-09-01", null],
    ]);
    expect(history[2]!.previousClosingReadingRef).toBe("READ-0042");
    expect(await inTenant((tx) => holderAt(tx, a.account.id, "2025-08-31"))).toMatchObject({ customerId: next.id });
    const last = (await commandsOf(a.account.id)).filter((c) => c.kind === "change_name").sort((x, y) => x.occurredAt.getTime() - y.occurredAt.getTime())[1]!;
    expect(last.payload).toMatchObject({ closing_reading_pending: false, closingReadingRef: "READ-0042" });

    expect((await env.audit(a.account.id)).map((e) => e.action)).toContain("accounts.change_name");
    const [event] = await events("accounts.holder_changed", "commandId", done.command.id);
    expect(event!.payload).toMatchObject({ accountId: a.account.id, fromCustomerId: a.customer.id, toCustomerId: next.id, effectiveDate: "2025-06-15", closingReadingPending: true });

    // Replays by id.
    const replay = await manager.accounts.changeName({ id, accountId: a.account.id, customerId: next.id, effectiveDate: "2025-06-15", reason: "Transfer of ownership" });
    expect(replay.replayed).toBe(true);
    await expectCode(manager.accounts.changeName({ id, accountId: a.account.id, customerId: third.id, effectiveDate: "2025-06-15", reason: "Other" }), "CONFLICT");
  });

  it("creates the new customer with the change, and takes the closing reading from the Metering port", async () => {
    registerReadingHandover(async () => ({ closingReadingRef: "METER-9" }));
    const a = await activeAccount();
    const done = await env.manager().accounts.changeName({
      accountId: a.account.id,
      newCustomer: { type: "person", name: "Lucy Wambui", contacts: [] },
      effectiveDate: "2025-01-10",
      reason: "Tenant took over",
    });
    expect(done.account.customerName).toBe("Lucy Wambui");
    expect(done.command.payload).toMatchObject({ closing_reading_pending: false, closingReadingRef: "METER-9" });
    expect((await inTenant((tx) => holdersOf(tx, a.account.id)))[1]).toMatchObject({ previousClosingReadingRef: "METER-9" });
  });

  it("refuses a bad date, no new holder, the same holder, a terminated account and a clerk", async () => {
    const a = await activeAccount();
    const other = await env.person(env.clerk(), "Other Person");
    const manager = env.manager();
    await expectCode(manager.accounts.changeName({ accountId: a.account.id, customerId: other.id, effectiveDate: "2999-01-01", reason: "x" }), "BAD_REQUEST");
    await expectCode(manager.accounts.changeName({ accountId: a.account.id, customerId: other.id, effectiveDate: "2020-01-01", reason: "x" }), "PRECONDITION_FAILED");
    await expectCode(manager.accounts.changeName({ accountId: a.account.id, customerId: other.id, effectiveDate: "2019-01-01", reason: "x" }), "PRECONDITION_FAILED");
    await expectCode(manager.accounts.changeName({ accountId: a.account.id, effectiveDate: "2025-01-01", reason: "x" }), "BAD_REQUEST");
    await expectCode(manager.accounts.changeName({ accountId: a.account.id, customerId: a.customer.id, effectiveDate: "2025-01-01", reason: "x" }), "BAD_REQUEST");
    await expectCode(manager.accounts.changeName({ accountId: a.account.id, customerId: other.id, effectiveDate: "yesterday", reason: "x" }), "BAD_REQUEST");
    await expectCode(env.clerk().accounts.changeName({ accountId: a.account.id, customerId: other.id, effectiveDate: "2025-01-01", reason: "x" }), "FORBIDDEN");
    await expectCode(env.outsider().accounts.changeName({ accountId: a.account.id, customerId: other.id, effectiveDate: "2025-01-01", reason: "x" }), "NOT_FOUND");
    await manager.accounts.terminate({ accountId: a.account.id, reason: "Closed", acknowledgeNoLedger: true });
    await expectCode(manager.accounts.changeName({ accountId: a.account.id, customerId: other.id, effectiveDate: "2025-01-01", reason: "x" }), "PRECONDITION_FAILED");
  });

  it("lets the holder change only through the history, and keeps the history append-only", async () => {
    const a = await activeAccount();
    const other = await env.person(env.clerk(), "Sneaky");
    await expect(env.db.update(account).set({ customerId: other.id }).where(eq(account.id, a.account.id))).rejects.toThrow();
    await expect(env.t.app.execute(sql`update accounts.account_holder set valid_from = '2000-01-01'`)).rejects.toThrow();
    // Every account has exactly one open first holder from when it was opened.
    const rows = await env.db.select().from(accountHolder).where(eq(accountHolder.accountId, a.account.id)).orderBy(desc(accountHolder.validFrom));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.customerId).toBe(a.customer.id);
  });
});

// C-09: the same account, a new service point.
describe("relocation (C-09)", () => {
  const to = () => ({ address: "Plot 99, Kahawa West zone 2", location: { lat: -1.25, lng: 36.95 }, schemeId: env.areas.scheme, zoneId: env.areas.otherZone, routeId: env.routes.otherRoute });

  it("runs request, survey and completion: new service point, old one decommissioned, nothing else about the account changes", async () => {
    const a = await activeAccount();
    const manager = env.manager();
    const id = randomUUID();
    const requested = await manager.accounts.relocations.request({ id, accountId: a.account.id, fromServicePointId: a.points[0]!.id, to: to(), reason: "Customer moves house" });
    expect(requested.relocation).toMatchObject({ id, status: "requested", fromServicePointId: a.points[0]!.id, to: { zoneId: env.areas.otherZone } });
    expect((await manager.accounts.relocations.request({ id, accountId: a.account.id, fromServicePointId: a.points[0]!.id, to: to(), reason: "Customer moves house" })).replayed).toBe(true);
    await expectCode(manager.accounts.relocations.request({ accountId: a.account.id, fromServicePointId: a.points[0]!.id, to: to(), reason: "Again" }), "CONFLICT");

    // A survey is required by default.
    await expectCode(manager.accounts.relocations.complete({ relocationId: id }), "PRECONDITION_FAILED");
    const notFeasible = await manager.accounts.relocations.recordSurvey({ relocationId: id, feasibility: "not_feasible", findings: "No main there" });
    expect(notFeasible.relocation.status).toBe("requested");
    await expectCode(manager.accounts.relocations.complete({ relocationId: id }), "PRECONDITION_FAILED");
    expect((await manager.accounts.relocations.recordSurvey({ relocationId: id, feasibility: "feasible", findings: "Main 5 m away" })).relocation.status).toBe("surveyed");
    const work = await manager.accounts.relocations.recordWork({ relocationId: id, finalReading: "1234", initialReading: "0" });
    expect(work.relocation).toMatchObject({ finalReading: "1234", initialReading: "0" });

    const completeId = randomUUID();
    const done = await manager.accounts.relocations.complete({ id: completeId, relocationId: id });
    expect(done.relocation).toMatchObject({ status: "completed", newServicePointId: done.servicePoint!.id });
    expect(done.servicePoint).toMatchObject({ accountId: a.account.id, address: "Plot 99, Kahawa West zone 2", zoneId: env.areas.otherZone, dmaId: null, routeId: env.routes.otherRoute, connectionStatus: "CONNECTED" });
    expect(done.command).toMatchObject({ id: completeId, kind: "relocate", toCommercialStatus: "ACTIVE" });

    const old = (await env.db.select().from(servicePoint).where(eq(servicePoint.id, a.points[0]!.id)))[0]!;
    expect(old.connectionStatus).toBe("DECOMMISSIONED");
    // Same number, same status, same customer.
    expect(await accountRow(a.account.id)).toMatchObject({ number: a.account.number, commercialStatus: "ACTIVE", serviceStatus: "CONNECTED", customerId: a.customer.id });

    const [event] = await events("accounts.service_point_relocated", "relocationId", id);
    expect(event!.payload).toMatchObject({
      accountId: a.account.id,
      fromServicePointId: a.points[0]!.id,
      toServicePointId: done.servicePoint!.id,
      from: { zoneId: env.areas.zone, dmaId: env.areas.dma, routeId: env.routes.route },
      to: { zoneId: env.areas.otherZone, dmaId: null, routeId: env.routes.otherRoute },
      finalReading: "1234",
      initialReading: "0",
    });
    expect((await env.audit(a.account.id)).map((e) => e.action)).toContain("accounts.relocate");
    expect((await env.audit(old.id)).map((e) => e.action)).toContain("accounts.service_point_update");
    const got = await manager.accounts.relocations.get({ id });
    expect(got.events.map((e) => e.kind)).toEqual(["requested", "survey_recorded", "survey_recorded", "work_recorded", "completed"]);
    expect((await manager.accounts.relocations.list({ accountId: a.account.id })).map((r) => r.status)).toEqual(["completed"]);

    // Retry and double completion.
    expect((await manager.accounts.relocations.complete({ id: completeId, relocationId: id })).replayed).toBe(true);
    await expectCode(manager.accounts.relocations.complete({ relocationId: id }), "PRECONDITION_FAILED");
    await expectCode(manager.accounts.relocations.cancel({ relocationId: id, reason: "Too late" }), "PRECONDITION_FAILED");
    // The decommissioned point cannot be relocated again.
    await expectCode(manager.accounts.relocations.request({ accountId: a.account.id, fromServicePointId: a.points[0]!.id, to: to(), reason: "Again" }), "PRECONDITION_FAILED");
  });

  it("needs no survey when the organization does not require one, and can be cancelled", async () => {
    await setSetting("accounts.application", { relocation: { surveyRequired: false } });
    const a = await activeAccount();
    const manager = env.manager();
    const first = await manager.accounts.relocations.request({ accountId: a.account.id, fromServicePointId: a.points[0]!.id, to: to(), reason: "Moves" });
    const cancelled = await manager.accounts.relocations.cancel({ relocationId: first.relocation.id, reason: "Changed their mind" });
    expect(cancelled.relocation.status).toBe("cancelled");
    expect((await env.db.select().from(servicePoint).where(eq(servicePoint.id, a.points[0]!.id)))[0]!.connectionStatus).toBe("CONNECTED");
    const second = await manager.accounts.relocations.request({ accountId: a.account.id, fromServicePointId: a.points[0]!.id, to: to(), reason: "Moves after all" });
    const done = await manager.accounts.relocations.complete({ relocationId: second.relocation.id, reason: "Moved" });
    expect(done.relocation.status).toBe("completed");
  });

  it("checks the place, the service point and the fee codes", async () => {
    const a = await activeAccount();
    const b = await activeAccount();
    const manager = env.manager();
    await expectCode(manager.accounts.relocations.request({ accountId: a.account.id, fromServicePointId: b.points[0]!.id, to: to(), reason: "x" }), "BAD_REQUEST");
    await expectCode(manager.accounts.relocations.request({ accountId: a.account.id, fromServicePointId: randomUUID(), to: to(), reason: "x" }), "NOT_FOUND");
    await expectCode(manager.accounts.relocations.request({ accountId: a.account.id, fromServicePointId: a.points[0]!.id, to: { ...to(), dmaId: env.areas.dma }, reason: "x" }), "BAD_REQUEST");
    await expectCode(env.clerk().accounts.relocations.request({ accountId: a.account.id, fromServicePointId: a.points[0]!.id, to: to(), reason: "x" }), "FORBIDDEN");
    await expectCode(env.outsider().accounts.relocations.request({ accountId: a.account.id, fromServicePointId: a.points[0]!.id, to: to(), reason: "x" }), "NOT_FOUND");
    // Fee codes are checked against the catalog only while Tariffs is licensed.
    await expect(manager.accounts.relocations.request({ accountId: a.account.id, fromServicePointId: a.points[0]!.id, to: to(), reason: "x", feeItemCodes: ["unknown_fee"] })).resolves.toBeTruthy();
    await setEntitlements(env.t.app, env.orgA, ["accounts", "tariffs"]);
    await expectCode(manager.accounts.relocations.request({ accountId: b.account.id, fromServicePointId: b.points[0]!.id, to: to(), reason: "x", feeItemCodes: ["unknown_fee"] }), "BAD_REQUEST");
  });

  it("keeps a scoped manager inside their scope", async () => {
    const a = await activeAccount();
    const limited = await addMember(env.t, env.orgA, "manager");
    await env.admin.access.setScope({ userId: limited.userId, areaIds: [env.areas.zone], routeIds: [] });
    const own = env.as(limited);
    await expectCode(own.accounts.relocations.request({ accountId: a.account.id, fromServicePointId: a.points[0]!.id, to: to(), reason: "x" }), "FORBIDDEN");
    const inside = await own.accounts.relocations.request({
      accountId: a.account.id,
      fromServicePointId: a.points[0]!.id,
      to: { address: "Next door", schemeId: env.areas.scheme, zoneId: env.areas.zone },
      reason: "Moves next door",
    });
    expect((await own.accounts.relocations.get({ id: inside.relocation.id })).id).toBe(inside.relocation.id);
  });

  it("takes the readings and the job from a completed relocation work order", async () => {
    await setEntitlements(env.t.app, env.orgA, ["accounts", "work-orders"]);
    const tech = await addMember(env.t, env.orgA, "technician");
    const a = await activeAccount();
    const manager = env.manager();
    const r = await manager.accounts.relocations.request({ accountId: a.account.id, fromServicePointId: a.points[0]!.id, to: to(), reason: "Moves" });
    await manager.accounts.relocations.recordSurvey({ relocationId: r.relocation.id, feasibility: "feasible", findings: "Fine" });
    const job = await env.admin.workOrders.create({ kind: "relocation", title: "Relocate meter", assetId: r.relocation.id, assigneeId: tech.userId });
    const finished = await env.as(tech).workOrders.transition({
      eventId: randomUUID(),
      workOrderId: job.id,
      action: { type: "complete", outcome: "done", capture: { finalReading: "5521", initialReading: "0" } },
      position: { latitude: -1.25, longitude: 36.95 },
    });
    expect(finished.outcome).toBe("applied");
    await drainOutbox(env.t.app, consumers);
    await drainOutbox(env.t.app, consumers);
    expect((await env.db.select().from(relocation).where(eq(relocation.id, r.relocation.id)))[0]).toMatchObject({ finalReading: "5521", initialReading: "0", workOrderId: job.id, status: "surveyed" });
    const done = await manager.accounts.relocations.complete({ relocationId: r.relocation.id });
    expect(done.relocation).toMatchObject({ finalReading: "5521", initialReading: "0", status: "completed" });
  });
});
