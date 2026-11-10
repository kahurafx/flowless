import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runJobs } from "../../../kernel/jobs";
import { jobs } from "../../../wiring";
import { setupBillingEnv, type BillingEnv } from "./test-support";

/*
 * NF-11 groundwork: a micro benchmark of the per-account job path. Skipped unless
 * BILLING_BENCH=1 (BILLING_BENCH_N accounts, default 2000; BILLING_BENCH_WORKERS parallel
 * runners, default 4). It prints throughput; the full 100,000-account seed is P5-8.
 */
const enabled = process.env.BILLING_BENCH === "1";
const N = Number(process.env.BILLING_BENCH_N ?? 2000);
const WORKERS = Number(process.env.BILLING_BENCH_WORKERS ?? 4);
const at = (iso: string) => new Date(`${iso}T08:00:00Z`);

describe.skipIf(!enabled)("billing run throughput", () => {
  let env: BillingEnv;
  beforeAll(async () => {
    env = await setupBillingEnv({ metering: true });
    const current = (await env.admin.config.list()).find((s) => s.key === "billing.policy");
    await env.admin.config.set({ key: "billing.policy", value: { ...(current?.value as object), usageInvoiceTypeCode: "water_bill" }, expectedVersion: current?.version ?? 0 });
  }, 600_000);
  afterAll(() => env?.t.stop());

  it(`bills ${N} accounts`, async () => {
    const scheme = (await env.admin.hierarchy.createArea({ level: "scheme", code: "S1", name: "S" })).id;
    const route = (await env.admin.hierarchy.createRoute({ code: "RB", name: "Bench" })).id;
    const seedStart = Date.now();
    let next = 0;
    const worker = async () => {
      while (next < N) {
        const i = next++;
        const customer = await env.admin.accounts.customers.create({ type: "person", name: `Holder ${i}` });
        const acct = await env.admin.accounts.create({ customerId: customer.id, categoryId: env.categoryId });
        await env.admin.accounts.activate({ accountId: acct.id, reason: "Bench", override: true });
        const sp = await env.admin.accounts.servicePoints.create({ accountId: acct.id, address: "P", schemeId: scheme, routeId: route, connectionStatus: "CONNECTED" });
        const meter = (await env.admin.metering.meters.register({ serial: `B-${i}-${randomUUID().slice(0, 6)}`, dialDigits: 6 })).meter;
        await env.admin.metering.installations.install({ meterId: meter.id, servicePointId: sp.id, installedAt: at("2024-12-01"), initialReading: { value: 100 } });
        for (const [d, v] of [["2024-12-31", 105], ["2025-01-31", 115], ["2025-02-27", 122]] as const) await env.admin.metering.readings.record({ meterId: meter.id, value: v, readAt: at(d), source: "technician" });
      }
    };
    await Promise.all(Array.from({ length: 12 }, worker));
    process.stderr.write(`bench: seeded ${N} accounts in ${((Date.now() - seedStart) / 1000).toFixed(1)}s` + "\n");

    const cycleId = (await env.admin.billing.cycles.open({ routeId: route, period: "2025-02" })).cycle.id;
    for (const to of ["reading_window", "validation", "estimation"] as const) await env.admin.billing.cycles.advance({ cycleId, to });
    const enqueueStart = Date.now();
    const advanced = await env.admin.billing.cycles.advance({ cycleId, to: "calculation" });
    const enqueueMs = Date.now() - enqueueStart;
    expect(advanced.enqueued).toBe(N);

    const runStart = Date.now();
    await Promise.all(
      Array.from({ length: WORKERS }, async () => {
        for (;;) if ((await runJobs(env.t.app, jobs, { batch: 50 })).claimed === 0) return;
      }),
    );
    const seconds = (Date.now() - runStart) / 1000;
    const progress = await env.admin.billing.cycles.progress({ cycleId });
    process.stderr.write(`bench: enqueue ${enqueueMs} ms; ${N} accounts with ${WORKERS} runner(s) in ${seconds.toFixed(1)}s = ${(N / seconds).toFixed(1)} accounts/s; outcomes ${JSON.stringify(progress.byOutcome)}` + "\n");
    expect(progress.byOutcome.none).toBe(0);
    expect(progress.byOutcome.billed).toBe(N);
  }, 3_600_000);
});
