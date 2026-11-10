import { withTenant } from "@flowless/db";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setEntitlements } from "../../../kernel/entitlement-store";
import { drainOutbox } from "../../../kernel/events";
import { runJobs, type JobDef } from "../../../kernel/jobs";
import { consumers, jobs } from "../../../wiring";
import { billAccountJob } from "../bill-job";
import { setupBillingEnv, type BillingEnv } from "./test-support";

// P5-4: the per-account billing job, the cycle-driven batch, bill-on-reading (B-01, B-05 to B-10, B-12; NF-24).

let env: BillingEnv;
let schemeId: string;
const at = (iso: string) => new Date(`${iso}T08:00:00Z`);

beforeAll(async () => {
  env = await setupBillingEnv({ metering: true });
  schemeId = (await env.admin.hierarchy.createArea({ level: "scheme", code: "S1", name: "Scheme" })).id;
  const current = (await env.admin.config.list()).find((s) => s.key === "billing.policy");
  await env.admin.config.set({ key: "billing.policy", value: { ...(current?.value as object), usageInvoiceTypeCode: "water_bill" }, expectedVersion: current?.version ?? 0 });
});
afterAll(() => env?.t.stop());

const newRoute = async () => (await env.admin.hierarchy.createRoute({ code: `R-${randomUUID().slice(0, 6)}`, name: "Route" })).id;

/** An ACTIVE account in the domestic category with a CONNECTED service point and a meter installed 2024-12-01 reading 100. */
async function account(routeId: string, readings: [string, number][]) {
  const customer = await env.admin.accounts.customers.create({ type: "person", name: `Holder ${randomUUID().slice(0, 6)}` });
  const acct = await env.admin.accounts.create({ customerId: customer.id, categoryId: env.categoryId });
  await env.admin.accounts.activate({ accountId: acct.id, reason: "Test", override: true });
  const sp = await env.admin.accounts.servicePoints.create({ accountId: acct.id, address: "Plot 1", schemeId, routeId, connectionStatus: "CONNECTED" });
  const meter = (await env.admin.metering.meters.register({ serial: `M-${randomUUID().slice(0, 8)}`, dialDigits: 5 })).meter;
  await env.admin.metering.installations.install({ meterId: meter.id, servicePointId: sp.id, installedAt: at("2024-12-01"), initialReading: { value: 100 } });
  for (const [date, value] of readings) await env.admin.metering.readings.record({ meterId: meter.id, value, readAt: at(date), source: "technician" });
  return { accountId: acct.id, servicePointId: sp.id, meterId: meter.id };
}

const drainJobs = async (defs: readonly JobDef[] = jobs) => {
  for (let i = 0; i < 50; i++) if ((await runJobs(env.t.app, defs, { batch: 100 })).claimed === 0) return;
};
const outcomes = async (cycleId: string) => Object.fromEntries((await env.admin.billing.cycles.accounts({ cycleId, limit: 500 })).rows.map((r) => [r.accountId, r]));
const queue = (dedupe: string) => env.rows<{ status: string; type: string; owner_user_id: string | null; raised_at: Date }>(sql`select status, type, owner_user_id, raised_at from kernel.exception where dedupe_key = ${dedupe}`);

describe("batch run: one job per account (B-07)", () => {
  let route: string;
  let cycleId: string;
  const a: Record<string, { accountId: string; servicePointId: string; meterId: string }> = {};

  it("queues the missed visits at estimation and the rest at calculation, each account once", async () => {
    route = await newRoute();
    const history: [string, number][] = [["2024-12-31", 105], ["2025-01-31", 115]];
    a.read = await account(route, [...history, ["2025-02-27", 130]]); // 15 units
    a.noReading = await account(route, history); // estimated from history: 10 units
    a.flagged = await account(route, [...history, ["2025-02-27", 50]]); // below the last reading: blocked, awaits approval (M-05)
    a.locked = await account(route, history); // locked premises: disposition estimate
    a.refused = await account(route, history); // customer refused: disposition hold
    a.noHistory = await account(route, []); // nothing to estimate from
    const tech = env.admin.metering.attempts;
    await tech.record({ servicePointId: a.locked!.servicePointId, outcome: "locked_premises", attemptedAt: at("2025-02-26"), cycleDate: "2025-02-28" });
    await tech.record({ servicePointId: a.refused!.servicePointId, outcome: "customer_refused", attemptedAt: at("2025-02-26"), cycleDate: "2025-02-28" });

    const opened = await env.admin.billing.cycles.open({ routeId: route, period: "2025-02" });
    cycleId = opened.cycle.id;
    expect(opened).toMatchObject({ expected: 6 });
    await env.admin.billing.cycles.advance({ cycleId, to: "reading_window" });
    await env.admin.billing.cycles.advance({ cycleId, to: "validation" });
    expect(await env.admin.billing.cycles.advance({ cycleId, to: "estimation" })).toMatchObject({ enqueued: 2 });
    expect(await env.admin.billing.cycles.advance({ cycleId, to: "calculation" })).toMatchObject({ enqueued: 4 });
    expect(await env.admin.billing.cycles.progress({ cycleId })).toMatchObject({ expected: 6, done: 0, jobs: { queued: 6 } });
    // Resume is safe: nothing new while the jobs wait.
    expect(await env.admin.billing.cycles.run({ cycleId })).toMatchObject({ enqueued: 0, candidates: 6 });
  });

  it("bills, estimates, holds and explains every account; flags are non-blocking exceptions", async () => {
    await drainJobs();
    const o = await outcomes(cycleId);
    expect(o[a.read!.accountId]).toMatchObject({ outcome: "billed", flagged: false });
    expect(o[a.noReading!.accountId]).toMatchObject({ outcome: "billed_estimate" });
    expect(o[a.locked!.accountId]).toMatchObject({ outcome: "billed_estimate" });
    expect(o[a.refused!.accountId]).toMatchObject({ outcome: "exception", reason: expect.stringMatching(/OUTCOME_HOLD/) });
    expect(o[a.flagged!.accountId]).toMatchObject({ outcome: "exception", reason: expect.stringMatching(/flagged or awaiting approval/) });
    expect(o[a.noHistory!.accountId]).toMatchObject({ outcome: "exception", reason: expect.stringMatching(/NO_BASELINE/) });

    // 15 units: 6 at 82.50, 9 at 96.00, plus the 150.00 standing charge (minor units).
    const doc = await env.admin.billing.documents.get({ id: o[a.read!.accountId]!.documentId! });
    expect(doc.total).toBe(6n * 8250n + 9n * 9600n + 15_000n);

    // Exceptions have an owner and an age (NF-24).
    const held = await queue(`cycle:${cycleId}:${a.refused!.accountId}`);
    expect(held).toMatchObject([{ status: "open", type: "UNBILLED_ACCOUNT", owner_user_id: env.members.admin.userId }]);
    expect(new Date(held[0]!.raised_at).getTime()).toBeGreaterThan(0);

    const p = await env.admin.billing.cycles.progress({ cycleId });
    expect(p).toMatchObject({ expected: 6, done: 6, percent: 100, byOutcome: { billed: 1, billed_estimate: 2, exception: 3, excluded: 0, none: 0 }, jobs: { done: 6, queued: 0, failed: 0 } });
    expect(p.failures.map((f) => f.accountId).sort()).toEqual([a.refused!.accountId, a.flagged!.accountId, a.noHistory!.accountId].sort());
  });

  it("re-running a finished cycle queues only the accounts that ended in an exception, and bills each document once", async () => {
    expect(await env.admin.billing.cycles.run({ cycleId })).toMatchObject({ enqueued: 0, candidates: 0 });
    expect(await env.admin.billing.cycles.retry({ cycleId })).toMatchObject({ enqueued: 3, candidates: 3 });
    // Nothing changed for them, so they end as exceptions again, with their exception items still open.
    await drainJobs();
    const o = await outcomes(cycleId);
    expect(o[a.flagged!.accountId]!.outcome).toBe("exception");
    expect(o[a.refused!.accountId]!.outcome).toBe("exception");
    const bills = await env.rows<{ n: string }>(sql`select count(*)::text n from billing.document where account_id = ${a.read!.accountId}`);
    expect(bills[0]!.n).toBe("1");
  });

  it("completeness lets the cycle close only when the retried accounts are explained", async () => {
    const c = await env.admin.billing.cycles.completeness({ cycleId });
    expect(c.expected).toBe(6);
    expect(c.unexplained).toBe(0);
  });
});

describe("a job killed mid-way (NF-24)", () => {
  it("shows the exception with owner and age, the siblings finish, and a retry succeeds", async () => {
    const route = await newRoute();
    const history: [string, number][] = [["2024-12-31", 105], ["2025-01-31", 115], ["2025-02-27", 130]];
    const good1 = await account(route, history);
    const doomed = await account(route, history);
    const good2 = await account(route, history);
    const cycleId = (await env.admin.billing.cycles.open({ routeId: route, period: "2025-02" })).cycle.id;
    for (const to of ["reading_window", "validation", "estimation", "calculation"] as const) await env.admin.billing.cycles.advance({ cycleId, to });

    // The first transaction of the doomed account's job posts the bill and then dies before it commits.
    const killer: JobDef = {
      ...(billAccountJob as JobDef),
      async run(ctx, payload) {
        const bad = (payload as { accountId: string }).accountId === doomed.accountId;
        let first = true;
        return billAccountJob.run({ ...ctx, withTenant: (fn) => ctx.withTenant(async (tx) => {
          const result = await fn(tx);
          if (bad && first) { first = false; throw new Error("boom: killed mid-way"); }
          first = false;
          return result;
        }) }, payload as never);
      },
    };
    await drainJobs([killer]);

    const o = await outcomes(cycleId);
    expect(o[good1.accountId]!.outcome).toBe("billed");
    expect(o[good2.accountId]!.outcome).toBe("billed");
    expect(o[doomed.accountId]).toMatchObject({ outcome: "exception", reason: expect.stringMatching(/boom: killed mid-way/) });
    // Nothing of the half-done bill survived the rollback.
    expect((await env.rows<{ n: string }>(sql`select count(*)::text n from billing.document where account_id = ${doomed.accountId}`))[0]!.n).toBe("0");
    const item = await queue(`cycle:${cycleId}:${doomed.accountId}`);
    expect(item).toMatchObject([{ status: "open", type: "UNBILLED_ACCOUNT", owner_user_id: env.members.admin.userId }]);
    expect(new Date(item[0]!.raised_at).getTime()).toBeGreaterThan(0);
    expect(await env.admin.billing.cycles.progress({ cycleId })).toMatchObject({ byOutcome: { billed: 2, exception: 1 }, jobs: { done: 2, queued: 1 } });

    // The retry is a fresh job; success resolves the exception.
    expect(await env.admin.billing.cycles.retry({ cycleId })).toMatchObject({ enqueued: 1 });
    await drainJobs();
    expect((await outcomes(cycleId))[doomed.accountId]!.outcome).toBe("billed");
    expect((await queue(`cycle:${cycleId}:${doomed.accountId}`))[0]!.status).toBe("resolved");
  });
});

describe("meter change and engine policy inputs", () => {
  it("prices old span plus new span across a replaced meter (M-07)", async () => {
    const route = await newRoute();
    const x = await account(route, [["2024-12-31", 105], ["2025-01-31", 115]]);
    const newMeter = (await env.admin.metering.meters.register({ serial: `M-${randomUUID().slice(0, 8)}`, dialDigits: 5 })).meter;
    await env.admin.metering.installations.replace({ oldMeterId: x.meterId, newMeterId: newMeter.id, replacedAt: at("2025-02-10"), reason: "Faulty", finalReading: { value: 125 }, initialReading: { value: 3 } });
    await env.admin.metering.readings.record({ meterId: newMeter.id, value: 8, readAt: at("2025-02-27"), source: "technician" });
    const cycleId = (await env.admin.billing.cycles.open({ routeId: route, period: "2025-02" })).cycle.id;
    for (const to of ["reading_window", "validation", "estimation", "calculation"] as const) await env.admin.billing.cycles.advance({ cycleId, to });
    await drainJobs();
    const row = (await outcomes(cycleId))[x.accountId]!;
    expect(row.outcome).toBe("billed");
    const doc = await env.admin.billing.documents.get({ id: row.documentId! });
    // old span 125 - 115 = 10, new span 8 - 3 = 5: 15 units.
    expect(doc.lines.find((l) => l.calculation && (l.calculation as { code?: string }).code === "USAGE")).toBeTruthy();
    expect(doc.total).toBe(6n * 8250n + 9n * 9600n + 15_000n);
  });

  it("flags zero consumption without holding the bill, and uses the policy's estimation method", async () => {
    const route = await newRoute();
    const zero = await account(route, [["2024-12-31", 105], ["2025-01-31", 115], ["2025-02-27", 115]]);
    const cycleId = (await env.admin.billing.cycles.open({ routeId: route, period: "2025-02" })).cycle.id;
    for (const to of ["reading_window", "validation", "estimation", "calculation"] as const) await env.admin.billing.cycles.advance({ cycleId, to });
    await drainJobs();
    const row = (await outcomes(cycleId))[zero.accountId]!;
    expect(row).toMatchObject({ outcome: "billed", flagged: true });
    expect(await queue(`billflag:${cycleId}:${zero.accountId}:ZERO_CONSUMPTION`)).toMatchObject([{ status: "open", type: "READING_EXCEPTION" }]);
  });
});

describe("bill on reading (B-01)", () => {
  it("bills a clean reading when the trigger is on_reading, leaves flagged ones to the queue, and does nothing in batch mode", async () => {
    const history: [string, number][] = [["2024-12-31", 105], ["2025-01-31", 115]];
    const route = await newRoute();
    const batch = await account(route, history);
    const batchCycle = (await env.admin.billing.cycles.open({ routeId: route, period: "2025-02" })).cycle.id;
    await env.admin.billing.cycles.advance({ cycleId: batchCycle, to: "reading_window" });
    await env.admin.metering.readings.record({ meterId: batch.meterId, value: 122, readAt: at("2025-02-20"), source: "technician" });
    await drainOutbox(env.t.app, consumers);
    await drainJobs();
    expect((await outcomes(batchCycle))[batch.accountId]!.outcome).toBeNull();

    const current = (await env.admin.config.list()).find((s) => s.key === "billing.cycle")!;
    await env.admin.config.set({ key: "billing.cycle", value: { trigger: "on_reading", frequency: "monthly" }, expectedVersion: current.version ?? 0 });
    try {
      const route2 = await newRoute();
      const clean = await account(route2, history);
      const flagged = await account(route2, history);
      const noBilling = await account(route2, history);
      const cycleId = (await env.admin.billing.cycles.open({ routeId: route2, period: "2025-02" })).cycle.id;
      expect(await env.admin.billing.cycles.get({ cycleId })).toMatchObject({ trigger: "on_reading" });
      await env.admin.metering.readings.record({ meterId: clean.meterId, value: 122, readAt: at("2025-02-20"), source: "technician" });
      await env.admin.metering.readings.record({ meterId: flagged.meterId, value: 50, readAt: at("2025-02-20"), source: "technician" });
      await drainOutbox(env.t.app, consumers);
      await drainJobs();
      const o = await outcomes(cycleId);
      expect(o[clean.accountId]!.outcome).toBe("billed");
      expect(o[flagged.accountId]!.outcome).toBeNull();

      // Billing unlicensed: the reading is recorded and nothing else happens (NF-31).
      await setEntitlements(env.t.app, env.orgA, ["accounts", "tariffs", "metering"]);
      await env.admin.metering.readings.record({ meterId: noBilling.meterId, value: 122, readAt: at("2025-02-20"), source: "technician" });
      await drainOutbox(env.t.app, consumers);
      await drainJobs();
      await setEntitlements(env.t.app, env.orgA, ["accounts", "tariffs", "billing", "metering"]);
      expect((await outcomes(cycleId))[noBilling.accountId]!.outcome).toBeNull();
    } finally {
      await env.admin.config.set({ key: "billing.cycle", value: { trigger: "batch", frequency: "monthly" }, expectedVersion: (current.version ?? 0) + 1 });
    }
  });
});

describe("Billing without Metering", () => {
  it("opens and runs a cycle from Accounts' facts; every account is an explained exception, never a silent failure", async () => {
    const plain = await setupBillingEnv();
    try {
      const scheme = (await plain.admin.hierarchy.createArea({ level: "scheme", code: "S9", name: "S" })).id;
      const route = (await plain.admin.hierarchy.createRoute({ code: "RX", name: "Route" })).id;
      const customer = await plain.admin.accounts.customers.create({ type: "person", name: "Holder" });
      const acct = await plain.admin.accounts.create({ customerId: customer.id, categoryId: plain.categoryId });
      await plain.admin.accounts.activate({ accountId: acct.id, reason: "Test", override: true });
      await plain.admin.accounts.servicePoints.create({ accountId: acct.id, address: "P", schemeId: scheme, routeId: route, connectionStatus: "CONNECTED" });
      const current = (await plain.admin.config.list()).find((s) => s.key === "billing.policy");
      await plain.admin.config.set({ key: "billing.policy", value: { ...(current?.value as object), usageInvoiceTypeCode: "water_bill" }, expectedVersion: current?.version ?? 0 });
      const cycleId = (await plain.admin.billing.cycles.open({ routeId: route, period: "2025-02" })).cycle.id;
      for (const to of ["reading_window", "validation", "estimation", "calculation"] as const) await plain.admin.billing.cycles.advance({ cycleId, to });
      for (let i = 0; i < 5; i++) if ((await runJobs(plain.t.app, jobs, { batch: 50 })).claimed === 0) break;
      const progress = await plain.admin.billing.cycles.progress({ cycleId });
      expect(progress).toMatchObject({ expected: 1, done: 1, byOutcome: { exception: 1 } });
      expect(progress.failures[0]!.reason).toMatch(/Metering is not licensed/);
      await withTenant(plain.t.app, plain.orgA, async () => undefined);
    } finally {
      await plain.t.stop();
    }
  });
});
