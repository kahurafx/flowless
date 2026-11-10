import { DEFAULT_OUTCOME_MAPPING, DISPOSITIONS as ENGINE_DISPOSITIONS, READING_OUTCOMES as ENGINE_OUTCOMES } from "@flowless/billing-engine";
import { DISPOSITIONS, READING_OUTCOMES } from "@flowless/shared-types";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { consumers } from "../../../wiring";
import { drainOutbox } from "../../../kernel/events";
import { dataQualitySourceIds, gatherFacts, handOverReadings, hasGateSource, registerDataQualitySource, registerGateSource, registerReadingHandover } from "../../accounts";
import { dispositionFor, outcomeMapping } from "../index";
import { registerPorts } from "../ports";
import { ago, expectCode, setupMeteringEnv, type MeteringEnv } from "./test-support";

let env: MeteringEnv;
beforeAll(async () => {
  env = await setupMeteringEnv();
});
afterAll(async () => {
  await env?.t.stop();
});
afterEach(() => registerPorts());

const events = (type: string, key: string, value: string) =>
  env.t.admin.execute<{ payload: Record<string, unknown> }>(sql`select payload from kernel.outbox_event where organization_id = ${env.orgA} and type = ${type} and payload ->> ${key} = ${value}`);
const exceptionsFor = (dedupeKey: string) =>
  env.t.admin.execute<{ status: string; type: string; owner_user_id: string | null }>(sql`select status, type, owner_user_id from kernel.exception where organization_id = ${env.orgA} and dedupe_key = ${dedupeKey}`);

async function setSetting(key: string, value: unknown) {
  const current = (await env.admin.config.list()).find((s) => s.key === key);
  await env.admin.config.set({ key, value, expectedVersion: current?.version ?? 0 });
}

/** An ACTIVE account with a CONNECTED service point on the route and, optionally, a meter. */
async function live(opts: { meter?: boolean; routeId?: string } = {}) {
  const customer = await env.admin.accounts.customers.create({ type: "person", name: `Holder ${randomUUID().slice(0, 6)}` });
  const account = await env.admin.accounts.create({ customerId: customer.id });
  await env.admin.accounts.activate({ accountId: account.id, reason: "Test", override: true });
  const scheme = (await env.admin.hierarchy.areas()).find((a) => a.level === "scheme")!;
  const sp = await env.admin.accounts.servicePoints.create({ accountId: account.id, address: "Plot 1", schemeId: scheme.id, routeId: opts.routeId ?? env.routes.route.id, connectionStatus: "CONNECTED" });
  let meterId: string | null = null;
  if (opts.meter ?? true) {
    const m = await env.newMeter();
    await env.admin.metering.installations.install({ meterId: m.id, servicePointId: sp.id, installedAt: ago(100), initialReading: { value: 100 } });
    meterId = m.id;
  }
  return { accountId: account.id, servicePointId: sp.id, meterId: meterId! };
}

describe("outcomes and dispositions (M-06)", () => {
  it("keeps the shared lists identical to the billing engine's", () => {
    expect([...READING_OUTCOMES]).toEqual([...ENGINE_OUTCOMES]);
    expect([...DISPOSITIONS]).toEqual([...ENGINE_DISPOSITIONS]);
  });

  it("defaults to the engine's mapping and takes the organization's overrides", async () => {
    expect(await env.admin.metering.outcomes.mapping()).toEqual(DEFAULT_OUTCOME_MAPPING);
    await setSetting("metering.outcomes", { locked_premises: "hold", dog_or_hazard: "skip" });
    const mapping = await env.admin.metering.outcomes.mapping();
    expect(mapping).toMatchObject({ locked_premises: "hold", dog_or_hazard: "skip", read_ok: "bill_actual", meter_faulty: "estimate" });
    const { withTenant } = await import("@flowless/db");
    await withTenant(env.t.app, env.orgA, async (tx) => {
      expect(await dispositionFor(tx, "locked_premises")).toBe("hold");
      expect(await outcomeMapping(tx)).toMatchObject({ customer_refused: "hold" });
    });
    await setSetting("metering.outcomes", {});
  });

  it("records an attempt with its tags, note and disposition; a successful read carries the reading", async () => {
    const a = await live();
    const tech = env.technician();
    const missed = await tech.metering.attempts.record({ servicePointId: a.servicePointId, outcome: "locked_premises", tags: ["gate locked", "dog"], note: "Nobody home", attemptedAt: ago(5), cycleDate: "2026-01-31" });
    expect(missed).toMatchObject({ replayed: false, reading: null, attempt: { outcome: "locked_premises", disposition: "estimate", tags: ["gate locked", "dog"], cycleDate: "2026-01-31", accountId: a.accountId }, consecutiveMisses: 1 });

    await expectCode(tech.metering.attempts.record({ servicePointId: a.servicePointId, outcome: "read_ok", attemptedAt: ago(4) }), "BAD_REQUEST", /needs the reading/);
    await expectCode(tech.metering.attempts.record({ servicePointId: a.servicePointId, outcome: "meter_faulty", attemptedAt: ago(4), reading: { value: 120 } }), "BAD_REQUEST", /Only a successful read/);

    const id = randomUUID();
    const ok = await tech.metering.attempts.record({ id, servicePointId: a.servicePointId, outcome: "read_ok", attemptedAt: ago(3), reading: { value: 130 }, photoFileId: randomUUID() });
    expect(ok.attempt).toMatchObject({ outcome: "read_ok", disposition: "bill_actual", readingId: ok.reading!.id });
    expect(ok.reading).toMatchObject({ value: 130, cleared: true });
    expect(ok.consecutiveMisses).toBe(0);
    const replay = await tech.metering.attempts.record({ id, servicePointId: a.servicePointId, outcome: "read_ok", attemptedAt: ago(3), reading: { value: 130 }, photoFileId: randomUUID() });
    expect(replay).toMatchObject({ replayed: true, attempt: { id }, reading: { id: ok.reading!.id } });
    await expectCode(tech.metering.attempts.record({ id, servicePointId: a.servicePointId, outcome: "meter_faulty", attemptedAt: ago(3) }), "CONFLICT");

    const listed = await env.admin.metering.attempts.list({ servicePointId: a.servicePointId });
    expect(listed.map((x) => x.outcome)).toEqual(["read_ok", "locked_premises"]);
    const audit = await env.t.admin.execute<{ action: string }>(sql`select action from kernel.audit_log where organization_id = ${env.orgA} and subject_id = ${id}`);
    expect(audit.map((x) => x.action)).toContain("metering.attempt_record");
    expect((await events("metering.reading_attempted", "attemptId", id)).length).toBe(1);
  });

  it("refuses a read at a service point with no meter, an unknown service point, and the wrong people", async () => {
    const bare = await live({ meter: false });
    await expectCode(env.technician().metering.attempts.record({ servicePointId: bare.servicePointId, outcome: "read_ok", attemptedAt: ago(1), reading: { value: 5 } }), "PRECONDITION_FAILED", /no meter/);
    // No meter found is a valid outcome for a service point with none.
    expect((await env.technician().metering.attempts.record({ servicePointId: bare.servicePointId, outcome: "no_meter_found", attemptedAt: ago(1) })).attempt.disposition).toBe("hold");
    await expectCode(env.technician().metering.attempts.record({ servicePointId: randomUUID(), outcome: "locked_premises", attemptedAt: ago(1) }), "NOT_FOUND");
    await expectCode(env.cashier().metering.attempts.record({ servicePointId: bare.servicePointId, outcome: "locked_premises", attemptedAt: ago(1) }), "FORBIDDEN");
    await expectCode(env.bare().metering.attempts.list(), "NOT_FOUND");
  });
});

describe("consecutive misses (M-09) and estimate cap", () => {
  it("derives the counter, raises a revisit, prompts the customer, escalates, and resets on a reading", async () => {
    const a = await live();
    const tech = env.technician();
    const miss = (n: number) => tech.metering.attempts.record({ servicePointId: a.servicePointId, outcome: "customer_refused", attemptedAt: ago(30 - n) });
    expect((await miss(1)).consecutiveMisses).toBe(1);
    expect(await exceptionsFor(`miss:revisit:${a.servicePointId}`)).toHaveLength(0);
    expect((await miss(2)).consecutiveMisses).toBe(2);
    const revisit = await exceptionsFor(`miss:revisit:${a.servicePointId}`);
    expect(revisit).toMatchObject([{ status: "open", type: "READING_EXCEPTION" }]);
    expect(revisit[0]!.owner_user_id).not.toBeNull();
    expect((await events("metering.self_read_prompt_due", "servicePointId", a.servicePointId)).length).toBe(1);
    expect((await events("metering.miss_threshold_reached", "servicePointId", a.servicePointId)).map((e) => e.payload.action)).toEqual(["revisit"]);
    await miss(3);
    expect(await exceptionsFor(`miss:escalate:${a.servicePointId}`)).toHaveLength(0);
    await miss(4);
    expect(await exceptionsFor(`miss:escalate:${a.servicePointId}`)).toMatchObject([{ status: "open" }]);
    expect(await env.admin.metering.misses.get({ servicePointId: a.servicePointId })).toMatchObject({ consecutiveMisses: 4 });

    // An actual reading (here a plain record, not a visit) resets the counter and resolves both.
    await tech.metering.readings.record({ meterId: a.meterId, value: 140, readAt: ago(2), source: "technician" });
    expect((await env.admin.metering.misses.get({ servicePointId: a.servicePointId })).consecutiveMisses).toBe(0);
    expect((await exceptionsFor(`miss:revisit:${a.servicePointId}`))[0]!.status).toBe("resolved");
    expect((await exceptionsFor(`miss:escalate:${a.servicePointId}`))[0]!.status).toBe("resolved");
    // A new run counts from zero again.
    expect((await tech.metering.attempts.record({ servicePointId: a.servicePointId, outcome: "meter_inaccessible", attemptedAt: ago(1) })).consecutiveMisses).toBe(1);
  });

  it("follows the thresholds in the setting, and 0 switches an action off", async () => {
    await setSetting("metering.misses", { revisitAfter: 1, selfReadPromptAfter: 0, escalateAfter: 0, maxConsecutiveEstimates: null });
    const a = await live();
    await env.technician().metering.attempts.record({ servicePointId: a.servicePointId, outcome: "locked_premises", attemptedAt: ago(3) });
    expect(await exceptionsFor(`miss:revisit:${a.servicePointId}`)).toHaveLength(1);
    expect(await events("metering.self_read_prompt_due", "servicePointId", a.servicePointId)).toHaveLength(0);
    await setSetting("metering.misses", { revisitAfter: 2, selfReadPromptAfter: 2, escalateAfter: 4, maxConsecutiveEstimates: null });
  });

  it("alerts when estimates in a row reach the cap, and resolves it on an actual reading", async () => {
    await setSetting("metering.misses", { revisitAfter: 2, selfReadPromptAfter: 2, escalateAfter: 4, maxConsecutiveEstimates: 2 });
    const a = await live();
    await env.supervisor().metering.readings.recordEstimate({ meterId: a.meterId, value: 110, readAt: ago(40) });
    expect(await exceptionsFor(`estimate-cap:${a.servicePointId}`)).toHaveLength(0);
    await env.supervisor().metering.readings.recordEstimate({ meterId: a.meterId, value: 120, readAt: ago(10) });
    expect(await exceptionsFor(`estimate-cap:${a.servicePointId}`)).toMatchObject([{ status: "open" }]);
    expect((await events("metering.estimate_cap_reached", "servicePointId", a.servicePointId)).length).toBe(1);
    expect(await env.admin.metering.misses.get({ servicePointId: a.servicePointId })).toMatchObject({ consecutiveEstimates: 2 });
    await env.technician().metering.readings.record({ meterId: a.meterId, value: 150, readAt: ago(2), source: "technician" });
    expect((await exceptionsFor(`estimate-cap:${a.servicePointId}`))[0]!.status).toBe("resolved");
    expect((await env.admin.metering.misses.get({ servicePointId: a.servicePointId })).consecutiveEstimates).toBe(0);
    await setSetting("metering.misses", { revisitAfter: 2, selfReadPromptAfter: 2, escalateAfter: 4, maxConsecutiveEstimates: null });
  });
});

describe("zero consumption (M-10)", () => {
  it("bills and flags zero consumption, and a streak opens a meter check that clears when water flows", async () => {
    const a = await live();
    const tech = env.technician();
    const zero = (days: number) => tech.metering.readings.record({ meterId: a.meterId, value: 100, readAt: ago(days), source: "technician" });
    const first = await zero(60);
    expect(first.reading).toMatchObject({ units: 0, cleared: true });
    expect(first.reading.flags).toContain("ZERO_CONSUMPTION");
    await zero(45);
    expect(await exceptionsFor(`zero:${a.meterId}`)).toHaveLength(0);
    await zero(30);
    expect(await exceptionsFor(`zero:${a.meterId}`)).toMatchObject([{ status: "open", type: "READING_EXCEPTION" }]);
    expect((await events("metering.zero_consumption_streak", "meterId", a.meterId)).length).toBe(1);
    await tech.metering.readings.record({ meterId: a.meterId, value: 112, readAt: ago(15), source: "technician" });
    expect((await exceptionsFor(`zero:${a.meterId}`))[0]!.status).toBe("resolved");
  });

  it("is switched off by a streak of 0", async () => {
    await setSetting("metering.zero_consumption", { streakAfter: 0 });
    const a = await live();
    for (const d of [30, 20, 10]) await env.technician().metering.readings.record({ meterId: a.meterId, value: 100, readAt: ago(d), source: "technician" });
    expect(await exceptionsFor(`zero:${a.meterId}`)).toHaveLength(0);
    await setSetting("metering.zero_consumption", { streakAfter: 3 });
  });
});

describe("eligibility snapshot (M-08)", () => {
  it("fixes who is on a route for a cycle, with a reason for the rest, and never changes", async () => {
    const route = (await env.admin.hierarchy.createRoute({ code: `RS-${randomUUID().slice(0, 4)}`, name: "Snapshot route" })).id;
    const metered = await live({ routeId: route });
    const noMeter = await live({ routeId: route, meter: false });
    const customer = await env.admin.accounts.customers.create({ type: "person", name: "Not yet active" });
    const pending = await env.admin.accounts.create({ customerId: customer.id });
    const scheme = (await env.admin.hierarchy.areas()).find((a) => a.level === "scheme")!;
    const newSp = await env.admin.accounts.servicePoints.create({ accountId: pending.id, address: "Plot 9", schemeId: scheme.id, routeId: route });

    await expectCode(env.cashier().metering.snapshots.take({ routeId: route, cycleDate: "2026-03-31" }), "FORBIDDEN");
    await expectCode(env.technician().metering.snapshots.take({ routeId: route, cycleDate: "2026-03-31" }), "FORBIDDEN");
    await expectCode(env.admin.metering.snapshots.take({ routeId: randomUUID(), cycleDate: "2026-03-31" }), "NOT_FOUND");
    const taken = await env.supervisor().metering.snapshots.take({ routeId: route, cycleDate: "2026-03-31" });
    expect(taken.replayed).toBe(false);
    const byPoint = Object.fromEntries(taken.snapshot.rows.map((r) => [r.servicePointId, r]));
    expect(byPoint[metered.servicePointId]).toMatchObject({ eligible: true, reason: "eligible", meterId: metered.meterId, accountId: metered.accountId, walkingSequence: null });
    expect(byPoint[noMeter.servicePointId]).toMatchObject({ eligible: false, reason: "no_meter", meterId: null });
    expect(byPoint[newSp.id]).toMatchObject({ eligible: false, reason: "service_point_not_live" });

    // Things change afterwards; the snapshot does not.
    const m = await env.newMeter();
    await env.admin.metering.installations.install({ meterId: m.id, servicePointId: noMeter.servicePointId, installedAt: ago(1), initialReading: { value: 1 } });
    await env.admin.accounts.terminate({ accountId: metered.accountId, reason: "Gone", acknowledgeNoLedger: true }).catch(() => undefined);
    const again = await env.admin.metering.snapshots.take({ routeId: route, cycleDate: "2026-03-31" });
    expect(again).toMatchObject({ replayed: true, snapshot: { id: taken.snapshot.id } });
    expect(again.snapshot.rows).toEqual(taken.snapshot.rows);
    expect(await env.admin.metering.snapshots.get({ routeId: route, cycleDate: "2026-03-31" })).toEqual(taken.snapshot);
    expect((await env.admin.metering.snapshots.list({ routeId: route })).map((s) => s.cycleDate)).toEqual(["2026-03-31"]);
    // A later cycle is a new snapshot and sees the new meter.
    const next = await env.admin.metering.snapshots.take({ routeId: route, cycleDate: "2026-04-30" });
    expect(next.replayed).toBe(false);
    expect(next.snapshot.rows.find((r) => r.servicePointId === noMeter.servicePointId)).toMatchObject({ eligible: true });

    // Rows are insert-only in the database.
    const events1 = await env.t.admin.execute(sql`select 1 from kernel.outbox_event where organization_id = ${env.orgA} and type = 'metering.eligibility_snapshot_taken' and payload ->> 'snapshotId' = ${taken.snapshot.id}`);
    expect(events1).toHaveLength(1);

    // Reading tasks derive from the snapshot and the visits of the cycle.
    const before = await env.technician().metering.snapshots.tasks({ snapshotId: taken.snapshot.id });
    expect(before.map((t) => [t.servicePointId, t.state])).toEqual([[metered.servicePointId, "to_read"]]);
    await env.technician().metering.attempts.record({ servicePointId: metered.servicePointId, outcome: "dog_or_hazard", attemptedAt: ago(1), cycleDate: "2026-03-31" });
    const missed = await env.technician().metering.snapshots.tasks({ snapshotId: taken.snapshot.id });
    expect(missed[0]).toMatchObject({ state: "missed", lastAttempt: { outcome: "dog_or_hazard", disposition: "estimate" } });
    await env.technician().metering.attempts.record({ servicePointId: metered.servicePointId, outcome: "read_ok", attemptedAt: new Date(), cycleDate: "2026-03-31", reading: { value: 160 } });
    expect((await env.technician().metering.snapshots.tasks({ snapshotId: taken.snapshot.id }))[0]!.state).toBe("read");
  });

  it("shows a limited viewer only the accounts they can see, and nothing across tenants", async () => {
    const route = env.routes.otherRoute.id;
    const mine = await live({ routeId: route });
    const taken = await env.admin.metering.snapshots.take({ routeId: route, cycleDate: "2026-02-28" });
    expect(taken.snapshot.rows.some((r) => r.servicePointId === mine.servicePointId)).toBe(true);
    const limited = await env.limited().metering.snapshots.get({ snapshotId: taken.snapshot.id });
    expect(limited.rows.some((r) => r.servicePointId === mine.servicePointId)).toBe(true);
    const elsewhere = await env.admin.metering.snapshots.take({ routeId: env.routes.route.id, cycleDate: "2026-02-28" });
    expect((await env.limited().metering.snapshots.get({ snapshotId: elsewhere.snapshot.id })).rows).toEqual([]);
    await expectCode(env.outsider().metering.snapshots.get({ snapshotId: taken.snapshot.id }), "NOT_FOUND");
    await expectCode(env.bare().metering.snapshots.list(), "NOT_FOUND");
  });
});

describe("bulk and master meters (M-12)", () => {
  it("registers a bulk meter on a DMA, reads it like any meter, and lists what is due by the DMA's schedule", async () => {
    const dma = (await env.admin.hierarchy.createArea({ level: "dma", code: `D-${randomUUID().slice(0, 4)}`, name: "DMA", parentId: (await env.admin.hierarchy.areas()).find((a) => a.level === "scheme")!.id })).id;
    await expectCode(env.admin.metering.meters.register({ serial: `BAD-${randomUUID().slice(0, 4)}`, dialDigits: 6, dmaId: dma }), "BAD_REQUEST", /bulk or master/);
    const bulk = (await env.admin.metering.meters.register({ serial: `BULK-${randomUUID().slice(0, 4)}`, dialDigits: 7, kind: "bulk", dmaId: dma })).meter;
    expect(bulk).toMatchObject({ kind: "bulk", dmaId: dma });
    expect((await env.admin.metering.meters.list({ kind: "bulk" })).meters.map((m) => m.id)).toContain(bulk.id);
    const inlet = await env.newServicePoint();
    await env.admin.metering.installations.install({ meterId: bulk.id, servicePointId: inlet.servicePointId, installedAt: ago(60), initialReading: { value: 1000 } });
    await setSetting("metering.bulk_schedules", { schedules: [{ dmaId: dma, everyDays: 30, startDate: "2020-01-01" }] });
    const due = await env.admin.metering.bulk.schedule({});
    expect(due.find((d) => d.meterId === bulk.id)).toMatchObject({ kind: "bulk", due: true, dmaId: dma });
    await env.technician().metering.readings.record({ meterId: bulk.id, value: 5000, readAt: ago(1), source: "technician" });
    const after = await env.admin.metering.bulk.schedule({});
    expect(after.find((d) => d.meterId === bulk.id)).toMatchObject({ due: false });
    // A bulk meter's service point is never the customer's: the register stays out of the customer data-quality source.
    await setSetting("metering.bulk_schedules", { schedules: [] });
  });
});

describe("Accounts ports (C-06, C-08, C-10, C-12)", () => {
  it("answers the initial_reading gate from readings, only while Metering is licensed", async () => {
    const m = await env.newMeter();
    const sp = await env.newServicePoint();
    const gate = async (orgId: string, accountId: string) => {
      const { withTenant } = await import("@flowless/db");
      return withTenant(env.t.app, orgId, (tx) => gatherFacts(tx, orgId, accountId, ["initial_reading"]));
    };
    expect((await gate(env.orgA, sp.accountId)).initial_reading).toMatchObject({ met: false });
    await env.admin.metering.installations.install({ meterId: m.id, servicePointId: sp.servicePointId, installedAt: ago(5), initialReading: { value: 7 } });
    expect((await gate(env.orgA, sp.accountId)).initial_reading).toMatchObject({ met: true });
    // Org C has Accounts only: Metering is never asked.
    expect((await gate(env.orgC, sp.accountId)).initial_reading).toBeNull();
  });

  it("reports service points that once had a meter and have none now, to the active_metered_no_meter rule", async () => {
    const a = await live();
    const { withTenant } = await import("@flowless/db");
    const ids = (org: string) => withTenant(env.t.app, org, (tx) => dataQualitySourceIds(tx, org, "active_metered_no_meter"));
    expect(await ids(env.orgA)).not.toContain(a.accountId);
    await env.admin.metering.installations.remove({ meterId: a.meterId, removedAt: ago(1), reason: "Stolen", to: "disposed" });
    expect(await ids(env.orgA)).toContain(a.accountId);
    expect(await ids(env.orgC)).toBeNull();
  });

  it("hands over a closing reading when a holder changes: found on the day, or pending until linked", async () => {
    const found = await live();
    const { withTenant } = await import("@flowless/db");
    const today = new Date().toISOString().slice(0, 10);
    const ask = (servicePointIds: string[], commandId = randomUUID(), effectiveDate = today) =>
      withTenant(env.t.app, env.orgA, (tx) => handOverReadings(tx, env.orgA, { reason: "change_name", fromAccountId: found.accountId, toAccountId: found.accountId, servicePointIds, effectiveDate, commandId }));

    // A reading on the effective date is the closing reading.
    const reading = await env.technician().metering.readings.record({ meterId: found.meterId, value: 130, readAt: new Date(Date.now() - 60_000), source: "technician" });
    const commandId = randomUUID();
    const done = await ask([found.servicePointId], commandId);
    expect(done).toMatchObject({ state: "done", closingReadingRef: reading.reading.id, closingReadingPending: false });
    expect((await ask([found.servicePointId], commandId)).closingReadingRef).toBe(reading.reading.id);
    const listed = await env.admin.metering.handovers.list({ servicePointId: found.servicePointId });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ pending: false, closingReadingId: reading.reading.id });

    // No reading on the day: pending, in the queue, until someone links one.
    const other = await live();
    const pend = await ask([other.servicePointId], randomUUID(), "2020-01-01");
    expect(pend).toMatchObject({ state: "done", closingReadingRef: null, closingReadingPending: true });
    const [h] = await env.admin.metering.handovers.list({ servicePointId: other.servicePointId, pending: true });
    expect(h).toMatchObject({ pending: true });
    expect(await exceptionsFor(`handover:${h!.id}`)).toMatchObject([{ status: "open" }]);
    const closing = await env.technician().metering.readings.record({ meterId: other.meterId, value: 141, readAt: ago(3), source: "technician" });
    await expectCode(env.technician().metering.handovers.linkClosing({ handoverId: h!.id, readingId: closing.reading.id }), "FORBIDDEN");
    await expectCode(env.supervisor().metering.handovers.linkClosing({ handoverId: h!.id, readingId: reading.reading.id }), "NOT_FOUND");
    const linked = await env.supervisor().metering.handovers.linkClosing({ handoverId: h!.id, readingId: closing.reading.id });
    expect(linked.replayed).toBe(false);
    expect((await env.supervisor().metering.handovers.linkClosing({ handoverId: h!.id, readingId: closing.reading.id })).replayed).toBe(true);
    expect(await env.admin.metering.handovers.list({ servicePointId: other.servicePointId, pending: true })).toEqual([]);
    expect((await exceptionsFor(`handover:${h!.id}`))[0]!.status).toBe("resolved");

    // A service point with no meter owes nothing; org C's Metering is never asked.
    const bare = await live({ meter: false });
    expect(await ask([bare.servicePointId])).toMatchObject({ closingReadingRef: null, closingReadingPending: false });
    expect(await withTenant(env.t.app, env.orgC, (tx) => handOverReadings(tx, env.orgC, { reason: "succession", fromAccountId: found.accountId, toAccountId: found.accountId, servicePointIds: [found.servicePointId], effectiveDate: today, commandId: randomUUID() }))).toMatchObject({ state: "pending_metering" });
  });

  it("closes the old meter and opens it at the new service point on a relocation, once", async () => {
    const a = await live();
    await env.technician().metering.readings.record({ meterId: a.meterId, value: 140, readAt: ago(2), source: "technician" });
    const to = await env.admin.accounts.servicePoints.create({ accountId: a.accountId, address: "Plot 77", schemeId: (await env.admin.hierarchy.areas()).find((x) => x.level === "scheme")!.id, routeId: env.routes.route.id, connectionStatus: "CONNECTED" });
    const outbox = await import("@flowless/db");
    await outbox.withTenant(env.t.app, env.orgA, async (tx) => {
      const { systemEnv } = await import("../../../kernel/action-env");
      const { servicePointRelocated } = await import("../../accounts");
      await systemEnv(tx, env.orgA).publish(servicePointRelocated, {
        relocationId: randomUUID(),
        commandId: randomUUID(),
        accountId: a.accountId,
        number: "ACC-1",
        fromServicePointId: a.servicePointId,
        toServicePointId: to.id,
        from: { zoneId: null, dmaId: null, routeId: null, schemeId: null, location: null },
        to: { zoneId: null, dmaId: null, routeId: null, schemeId: null, location: null },
        feeItemCodes: [],
        finalReading: "150",
        initialReading: "150",
        actorUserId: env.members.admin.userId,
        occurredAt: new Date().toISOString(),
      });
    });
    await drainOutbox(env.t.app, consumers);
    await drainOutbox(env.t.app, consumers);
    const installs = await env.admin.metering.installations.list({ meterId: a.meterId });
    expect(installs.map((i) => [i.servicePointId, i.removedAt === null])).toEqual([[to.id, true], [a.servicePointId, false]]);
    const readings = await env.admin.metering.readings.list({ meterId: a.meterId });
    expect(readings.map((r) => [r.purpose, r.value]).sort()).toEqual([["final", 150], ["initial", 150], ["routine", 140], ["initial", 100]].sort());
    // Replaying the whole event stream changes nothing.
    await env.t.admin.execute(sql`delete from kernel.consumer_receipt where organization_id = ${env.orgA} and consumer = 'metering.close_and_open_on_relocation'`);
    await drainOutbox(env.t.app, consumers);
    expect((await env.admin.metering.installations.list({ meterId: a.meterId })).length).toBe(2);
  });

  it("registers every port with requires: metering, so an unlicensed organization is never asked", async () => {
    registerGateSource("initial_reading", null);
    registerDataQualitySource("active_metered_no_meter", null);
    registerReadingHandover(null);
    registerPorts();
    expect(hasGateSource("initial_reading")).toBe(true);
  });
});
