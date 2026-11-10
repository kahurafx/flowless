import { withTenant } from "@flowless/db";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setEntitlements } from "../../../kernel/entitlement-store";
import { closedPeriodSource } from "../ports";
import { expectCode, setupBillingEnv, type BillingEnv } from "./test-support";

// P5-3: billing cycles (B-01 to B-04, B-15, B-16).

let env: BillingEnv;
let schemeId: string;
beforeAll(async () => {
  env = await setupBillingEnv();
  schemeId = (await env.admin.hierarchy.createArea({ level: "scheme", code: "S1", name: "Scheme" })).id;
});
afterAll(() => env?.t.stop());

const newRoute = async () => (await env.admin.hierarchy.createRoute({ code: `R-${randomUUID().slice(0, 6)}`, name: "Route" })).id;

/** An ACTIVE account with a CONNECTED service point on the route. */
async function liveAccount(routeId: string, opts: { connected?: boolean } = {}) {
  const customer = await env.admin.accounts.customers.create({ type: "person", name: `Holder ${randomUUID().slice(0, 6)}` });
  const account = await env.admin.accounts.create({ customerId: customer.id });
  if (opts.connected !== false) await env.admin.accounts.activate({ accountId: account.id, reason: "Test", override: true });
  const sp = await env.admin.accounts.servicePoints.create({
    accountId: account.id,
    address: "Plot 1",
    schemeId,
    routeId,
    ...(opts.connected === false ? {} : { connectionStatus: "CONNECTED" as const }),
  });
  return { accountId: account.id, servicePointId: sp.id };
}

/** Issues the account's usage bill for the period and returns the document. */
async function bill(accountId: string, period: string, dial = 110) {
  const result = await env.admin.billing.invoices.issueUsage(env.usage(accountId, { period, reading: { dial }, readings: [{ period: "2025-01", kind: "actual", dial: 100 }] }) as never);
  if (result.outcome !== "issued") throw new Error(`expected an invoice, got ${result.outcome}`);
  return result.document;
}

const WALK = ["reading_window", "validation", "estimation", "calculation", "review", "issue", "deliver", "completeness"] as const;
async function walkTo(cycleId: string, last: (typeof WALK)[number]) {
  for (const to of WALK) {
    await env.admin.billing.cycles.advance({ cycleId, to });
    if (to === last) return;
  }
}

describe("billing cycle (B-02, B-03, B-04, B-15)", () => {
  let route: string;
  let a1: string;
  let a2: string;
  let a3: string;
  let pending: string;
  let cycleId: string;

  it("opens from Accounts' facts when Metering is not licensed, recording every account and who is expected", async () => {
    route = await newRoute();
    a1 = (await liveAccount(route)).accountId;
    a2 = (await liveAccount(route)).accountId;
    a3 = (await liveAccount(route)).accountId;
    pending = (await liveAccount(route, { connected: false })).accountId;

    await expectCode(env.clerk().billing.cycles.open({ routeId: route, period: "2025-02" }), "FORBIDDEN");
    await expectCode(env.admin.billing.cycles.open({ routeId: randomUUID(), period: "2025-02" }), "NOT_FOUND");
    const id = randomUUID();
    const opened = await env.admin.billing.cycles.open({ id, routeId: route, period: "2025-02" });
    cycleId = opened.cycle.id;
    expect(opened).toMatchObject({ replayed: false, accounts: 4, expected: 3, cycle: { id, state: "open", period: "2025-02", cycleDate: "2025-02-28", frequency: "monthly", trigger: "batch", snapshotId: null } });

    // Idempotent: the same id, or the same route and period without an id, replays; anything else is a conflict.
    expect(await env.admin.billing.cycles.open({ id, routeId: route, period: "2025-02" })).toMatchObject({ replayed: true, cycle: { id } });
    expect(await env.admin.billing.cycles.open({ routeId: route, period: "2025-02" })).toMatchObject({ replayed: true, cycle: { id } });
    await expectCode(env.admin.billing.cycles.open({ id: randomUUID(), routeId: route, period: "2025-02" }), "CONFLICT");
    await expectCode(env.admin.billing.cycles.open({ id, routeId: route, period: "2025-03" }), "CONFLICT");

    const detail = await env.admin.billing.cycles.get({ cycleId });
    expect(detail).toMatchObject({ eligibilitySource: "accounts_fallback", state: "open", completeness: { expected: 3, unexplained: 3 } });
    expect(detail.events).toMatchObject([{ seq: 1, from: null, to: "open", kind: "open" }]);
    const all = await env.admin.billing.cycles.accounts({ cycleId });
    expect(all.total).toBe(4);
    expect(all.rows.find((r) => r.accountId === pending)).toMatchObject({ expected: false, snapshotReason: "service_point_not_live" });
    expect((await env.admin.billing.cycles.accounts({ cycleId, outcome: "none" })).total).toBe(3);
    expect((await env.admin.billing.cycles.list({ routeId: route })).map((c) => c.id)).toEqual([cycleId]);
    expect((await env.clerk().billing.cycles.list({})).length).toBe(1);
    expect(await env.events(env.orgA, "billing.cycle_opened")).toMatchObject([{ cycleId, expected: 3, snapshotId: null }]);
  });

  it("moves through the states by logged events; skipping and going back need a reason", async () => {
    await expectCode(env.admin.billing.cycles.advance({ cycleId, to: "calculation" }), "BAD_REQUEST", /reason/);
    await expectCode(env.admin.billing.cycles.advance({ cycleId, to: "closed" }), "BAD_REQUEST");
    await expectCode(env.admin.billing.cycles.advance({ cycleId, to: "open", reason: "x" }), "BAD_REQUEST");
    await expectCode(env.clerk().billing.cycles.advance({ cycleId, to: "reading_window" }), "FORBIDDEN");
    const eventId = randomUUID();
    expect(await env.admin.billing.cycles.advance({ id: eventId, cycleId, to: "reading_window" })).toMatchObject({ replayed: false, cycle: { state: "reading_window" } });
    expect(await env.admin.billing.cycles.advance({ id: eventId, cycleId, to: "reading_window" })).toMatchObject({ replayed: true });
    await expectCode(env.admin.billing.cycles.advance({ id: eventId, cycleId, to: "validation" }), "CONFLICT");
    await env.admin.billing.cycles.advance({ cycleId, to: "validation" });
    await env.admin.billing.cycles.advance({ cycleId, to: "calculation", reason: "no estimates needed this month" });
    await env.admin.billing.cycles.advance({ cycleId, to: "validation", reason: "late readings came in" });
    const detail = await env.admin.billing.cycles.get({ cycleId });
    expect(detail.events.map((e) => `${e.kind}:${e.to}`)).toEqual(["open:open", "advance:reading_window", "advance:validation", "skip:calculation", "retreat:validation"]);
    expect(detail.events[3]!.reason).toBe("no estimates needed this month");
    expect(await env.events(env.orgA, "billing.cycle_state_changed")).toHaveLength(4);
    // The log is the only way: the database refuses a state with no event behind it.
    await expect(env.t.admin.execute(sql`update billing.cycle set state = 'review' where id = ${cycleId}`)).rejects.toThrow();
  });

  it("refuses to close until every expected account is explained, listing counts and examples (B-04)", async () => {
    for (const to of ["estimation", "calculation", "review", "issue", "deliver", "completeness"] as const) await env.admin.billing.cycles.advance({ cycleId, to });
    await expectCode(env.admin.billing.cycles.close({ cycleId }), "PRECONDITION_FAILED", /3 of 3 expected accounts are unexplained/);

    // A1 is billed, A2 is an exception with its queue item; A3 stays unexplained.
    const doc = await bill(a1, "2025-02");
    await expectCode(env.admin.billing.cycles.recordOutcome({ cycleId, accountId: a1, outcome: "billed" }), "BAD_REQUEST");
    await expectCode(env.admin.billing.cycles.recordOutcome({ cycleId, accountId: a1, outcome: "billed", documentId: randomUUID() }), "BAD_REQUEST");
    await expectCode(env.admin.billing.cycles.recordOutcome({ cycleId, accountId: a2, outcome: "exception" }), "BAD_REQUEST", /reason/);
    await expectCode(env.admin.billing.cycles.recordOutcome({ cycleId, accountId: pending, outcome: "excluded", reason: "x" }), "BAD_REQUEST", /not expected/);
    await expectCode(env.admin.billing.cycles.recordOutcome({ cycleId, accountId: randomUUID(), outcome: "excluded", reason: "x" }), "NOT_FOUND");
    const outcomeId = randomUUID();
    await env.admin.billing.cycles.recordOutcome({ id: outcomeId, cycleId, accountId: a1, outcome: "billed", documentId: doc.id });
    expect(await env.admin.billing.cycles.recordOutcome({ id: outcomeId, cycleId, accountId: a1, outcome: "billed", documentId: doc.id })).toMatchObject({ replayed: true });
    await expectCode(env.admin.billing.cycles.recordOutcome({ id: outcomeId, cycleId, accountId: a2, outcome: "excluded", reason: "x" }), "CONFLICT");
    const exc = await env.admin.billing.cycles.recordOutcome({ cycleId, accountId: a2, outcome: "exception", reason: "No reading and no history" });
    expect(exc.exceptionId).toBeTruthy();
    const queue = await env.rows<{ status: string; type: string; owner_user_id: string; subject_ref: string }>(sql`select status, type, owner_user_id, subject_ref from kernel.exception where id = ${exc.exceptionId}`);
    expect(queue).toMatchObject([{ status: "open", type: "UNBILLED_ACCOUNT", owner_user_id: env.members.admin.userId, subject_ref: a2 }]);

    const c = await env.admin.billing.cycles.completeness({ cycleId });
    expect(c).toMatchObject({ complete: false, expected: 3, explained: 2, unexplained: 1, byOutcome: { billed: 1, exception: 1 }, examples: [{ accountId: a3, problem: "no outcome" }] });
    await expectCode(env.admin.billing.cycles.close({ cycleId }), "PRECONDITION_FAILED", new RegExp(`1 of 3 expected accounts are unexplained.*${a3}`));
    expect(await env.admin.billing.cycles.get({ cycleId })).toMatchObject({ state: "completeness" });
  });

  it("closes once everything is explained, locks the period and moves the closed-period source (B-15)", async () => {
    await env.admin.billing.cycles.recordOutcome({ cycleId, accountId: a3, outcome: "excluded", reason: "Meter being replaced this month" });
    const closeId = randomUUID();
    const closed = await env.admin.billing.cycles.close({ id: closeId, cycleId });
    expect(closed).toMatchObject({ replayed: false, cycle: { state: "closed" }, completeness: { complete: true } });
    expect(await env.admin.billing.cycles.close({ id: closeId, cycleId })).toMatchObject({ replayed: true });
    await expectCode(env.admin.billing.cycles.close({ cycleId }), "BAD_REQUEST", /already closed/);
    await expectCode(env.admin.billing.cycles.advance({ cycleId, to: "review", reason: "reopen" }), "BAD_REQUEST", /closed cycle does not move/);
    await expectCode(env.admin.billing.cycles.recordOutcome({ cycleId, accountId: a3, outcome: "excluded", reason: "again" }), "PRECONDITION_FAILED", /closed/);
    expect(await env.events(env.orgA, "billing.cycle_closed")).toMatchObject([{ cycleId, period: "2025-02", lockedThrough: "2025-02-28", expected: 3 }]);

    // A normal invoice into the locked period is refused for any account of the cycle, billed or not, with a pointer to B-14.
    for (const account of [a1, a3]) {
      await expectCode(env.admin.billing.invoices.issueUsage(env.usage(account) as never), "PRECONDITION_FAILED", /credit note, a debit note or a void and re-bill \(B-14\)/);
    }
    // An account the cycle never looked at (no row) is unaffected, as is another period.
    expect((await env.admin.billing.invoices.issueUsage(env.usage(env.newAccount()) as never)).outcome).toBe("issued");
    expect((await env.admin.billing.invoices.issueUsage(env.usage(a3, { period: "2025-03", reading: { dial: 120 } }) as never)).outcome).toBe("issued");
    // Corrections stay possible: a credit note and a void are not blocked by the lock.
    const doc = (await env.admin.billing.documents.list({ accountId: a1 }))[0]!;
    await env.accountant().billing.documents.void({ idempotencyKey: env.key("void"), documentId: doc.id, reason: "Billed in error" });

    // Tariffs' closed-period source reflects the lock (T-03): through the end of the period.
    const through = await withTenant(env.pool.db, env.orgA, (tx) => closedPeriodSource(tx, env.orgA));
    expect(through?.toISOString().slice(0, 10)).toBe("2025-03-31");
    const stored = await env.rows<{ state: string }>(sql`select state from billing.cycle where id = ${cycleId}`);
    expect(stored[0]!.state).toBe("closed");
    await expect(env.t.admin.execute(sql`insert into billing.cycle_outcome (organization_id, cycle_id, account_id, outcome, reason) values (${env.orgA}, ${cycleId}, ${a3}, 'excluded', 'x')`)).rejects.toThrow();
  });

  it("closed-period source reflects a closed cycle with no documents in it", async () => {
    const r = await newRoute();
    const empty = await env.admin.billing.cycles.open({ routeId: r, period: "2026-06" });
    await walkTo(empty.cycle.id, "completeness");
    await env.admin.billing.cycles.close({ cycleId: empty.cycle.id });
    const through = await withTenant(env.pool.db, env.orgA, (tx) => closedPeriodSource(tx, env.orgA));
    expect(through?.toISOString().slice(0, 10)).toBe("2026-06-30");
  });

  it("is tenant-isolated and needs the module", async () => {
    await expectCode(env.outsider().billing.cycles.get({ cycleId }), "NOT_FOUND");
    expect(await env.outsider().billing.cycles.list({})).toEqual([]);
    await expectCode(env.bare().billing.cycles.list({}), "NOT_FOUND");
  });
});

describe("review by exception (B-16)", () => {
  it("bulk approves clean bills except a sample, holds the rest for a person, and gates leaving review", async () => {
    const route = await newRoute();
    const accounts = [] as string[];
    for (let i = 0; i < 5; i += 1) accounts.push((await liveAccount(route)).accountId);
    const { cycle } = await env.admin.billing.cycles.open({ routeId: route, period: "2025-04" });
    const cycleId = cycle.id;
    await walkTo(cycleId, "review");

    const docs = [] as { id: string; total: bigint }[];
    for (const [i, account] of accounts.entries()) {
      const d = await bill(account, "2025-04", 110 + i);
      docs.push(d);
      await env.admin.billing.cycles.recordOutcome({ cycleId, accountId: account, outcome: i === 4 ? "billed_estimate" : "billed", documentId: d.id, flagged: i === 3 });
    }
    const config = await env.admin.config.list();
    const current = config.find((s) => s.key === "billing.review");
    await env.admin.config.set({ key: "billing.review", value: { bulkApproveBelow: "100000000", individualAbove: "200000000", sampleRate: 0, sampleMinimum: 1 }, expectedVersion: current?.version ?? 0 });

    const queue = await env.admin.billing.cycles.review.queue({ cycleId });
    expect(queue.pending.map((p) => p.bucket).sort()).toEqual(["attention", "clean", "clean", "clean", "clean"]);
    expect(queue.pending[0]!.accountId).toBe(accounts[3]);
    await expectCode(env.admin.billing.cycles.advance({ cycleId, to: "issue" }), "PRECONDITION_FAILED", /5 bills are not approved/);

    const bulk = await env.admin.billing.cycles.review.bulkApprove({ cycleId });
    expect(bulk.approved).toBe(3);
    expect(bulk.sample).toHaveLength(1);
    expect(bulk.needAttention).toBe(1);
    expect(await env.admin.billing.cycles.review.bulkApprove({ cycleId })).toMatchObject({ approved: 0 });
    // The same cycle always selects the same sample.
    const pendingNow = (await env.admin.billing.cycles.review.queue({ cycleId })).pending;
    expect(pendingNow.map((p) => p.accountId).sort()).toEqual([...bulk.sample, accounts[3]!].sort());

    await expectCode(env.admin.billing.cycles.review.decide({ cycleId, accountId: accounts[3]!, decision: "hold" }), "BAD_REQUEST", /why/);
    await env.admin.billing.cycles.review.decide({ cycleId, accountId: accounts[3]!, decision: "hold", reason: "Meter read looks high" });
    await expectCode(env.admin.billing.cycles.advance({ cycleId, to: "issue" }), "PRECONDITION_FAILED", /2 bills are not approved/);
    await env.admin.billing.cycles.review.decide({ cycleId, accountId: accounts[3]!, decision: "approve" });
    await env.admin.billing.cycles.review.decide({ cycleId, accountId: bulk.sample[0]!, decision: "approve", basis: "sample" });
    expect((await env.admin.billing.cycles.review.queue({ cycleId })).pending).toEqual([]);
    expect(await env.admin.billing.cycles.advance({ cycleId, to: "issue" })).toMatchObject({ cycle: { state: "issue" } });
    // Going back from issue to review is a reasoned retreat; review decisions made before still stand.
    await env.admin.billing.cycles.advance({ cycleId, to: "review", reason: "check one more" });
    expect((await env.admin.billing.cycles.review.queue({ cycleId })).approved).toBe(5);
  });

  it("leaves bills over the individual threshold to a member who may approve", async () => {
    const route = await newRoute();
    const account = (await liveAccount(route)).accountId;
    const { cycle } = await env.admin.billing.cycles.open({ routeId: route, period: "2025-05" });
    await walkTo(cycle.id, "review");
    const d = await bill(account, "2025-05");
    await env.admin.billing.cycles.recordOutcome({ cycleId: cycle.id, accountId: account, outcome: "billed", documentId: d.id });
    const current = (await env.admin.config.list()).find((s) => s.key === "billing.review");
    await env.admin.config.set({ key: "billing.review", value: { bulkApproveBelow: "1", individualAbove: "2", sampleRate: 0, sampleMinimum: 0 }, expectedVersion: current!.version });
    await env.admin.access.grant({ userId: env.members.clerk.userId, permission: "billing:run" });
    expect((await env.admin.billing.cycles.review.queue({ cycleId: cycle.id })).pending[0]!.bucket).toBe("high");
    await expectCode(env.clerk().billing.cycles.review.decide({ cycleId: cycle.id, accountId: account, decision: "approve" }), "FORBIDDEN", /may approve/);
    expect(await env.accountant().billing.cycles.review.decide({ cycleId: cycle.id, accountId: account, decision: "approve" })).toMatchObject({ bucket: "high", replayed: false });
    // Reviews happen in the review state only.
    await env.admin.billing.cycles.advance({ cycleId: cycle.id, to: "issue" });
    await expectCode(env.accountant().billing.cycles.review.decide({ cycleId: cycle.id, accountId: account, decision: "hold", reason: "x" }), "PRECONDITION_FAILED");
  });
});

describe("settings (B-01)", () => {
  it("takes the trigger and frequency from the billing.cycle setting at open, and a frequency override", async () => {
    const current = (await env.admin.config.list()).find((s) => s.key === "billing.cycle");
    await env.admin.config.set({ key: "billing.cycle", value: { trigger: "on_reading", frequency: "quarterly" }, expectedVersion: current?.version ?? 0 });
    const route = await newRoute();
    const opened = await env.admin.billing.cycles.open({ routeId: route, period: "2025-06" });
    expect(opened.cycle).toMatchObject({ trigger: "on_reading", frequency: "quarterly" });
    const other = await env.admin.billing.cycles.open({ routeId: await newRoute(), period: "2025-06", frequency: "monthly" });
    expect(other.cycle.frequency).toBe("monthly");
    await expectCode(env.admin.config.set({ key: "billing.cycle", value: { trigger: "never" }, expectedVersion: 1 }), "BAD_REQUEST");
  });
});

describe("with Metering licensed (B-03)", () => {
  it("uses Metering's eligibility snapshot, the same one the reading tasks use, and Metering's no_meter reason", async () => {
    await setEntitlements(env.t.app, env.orgA, ["accounts", "tariffs", "billing", "metering"]);
    const route = await newRoute();
    const metered = await liveAccount(route);
    const bare = await liveAccount(route);
    const meter = (await env.admin.metering.meters.register({ serial: `M-${randomUUID().slice(0, 8)}`, dialDigits: 5 })).meter;
    await env.admin.metering.installations.install({ meterId: meter.id, servicePointId: metered.servicePointId, installedAt: new Date(Date.now() - 100 * 86_400_000), initialReading: { value: 100 } });

    const opened = await env.admin.billing.cycles.open({ routeId: route, period: "2025-07" });
    expect(opened).toMatchObject({ accounts: 2, expected: 1 });
    expect(opened.cycle.snapshotId).toBeTruthy();
    const snapshot = await env.admin.metering.snapshots.get({ routeId: route, cycleDate: "2025-07-31" });
    expect(opened.cycle.snapshotId).toBe(snapshot.id);
    const rows = (await env.admin.billing.cycles.accounts({ cycleId: opened.cycle.id })).rows;
    expect(rows.find((r) => r.accountId === bare.accountId)).toMatchObject({ expected: false, snapshotReason: "no_meter" });
    expect(rows.find((r) => r.accountId === metered.accountId)).toMatchObject({ expected: true, snapshotReason: "eligible" });
    expect(await env.admin.billing.cycles.get({ cycleId: opened.cycle.id })).toMatchObject({ eligibilitySource: "metering_snapshot", snapshotRows: 2 });
    // The snapshot taken first is the one the cycle uses.
    const route2 = await newRoute();
    await liveAccount(route2);
    const first = await env.admin.metering.snapshots.take({ routeId: route2, cycleDate: "2025-07-31" });
    expect((await env.admin.billing.cycles.open({ routeId: route2, period: "2025-07" })).cycle.snapshotId).toBe(first.snapshot.id);
    await setEntitlements(env.t.app, env.orgA, ["accounts", "tariffs", "billing"]);
  });
});
