import { withTenant } from "@flowless/db";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerClosedPeriodSource } from "../../tariffs";
import { latestActualReading, readingsFor } from "../index";
import { ago, expectCode, setupMeteringEnv, type MeteringEnv } from "./test-support";

let env: MeteringEnv;
beforeAll(async () => {
  env = await setupMeteringEnv();
});
afterAll(async () => {
  registerClosedPeriodSource(null);
  await env?.t.stop();
});

const events = async (type: string) =>
  env.t.admin.execute<{ payload: Record<string, unknown> }>(sql`select payload from kernel.outbox_event where organization_id = ${env.orgA} and type = ${type}`);
const openExceptions = (readingId: string) =>
  env.t.admin.execute<{ status: string }>(sql`select status from kernel.exception where organization_id = ${env.orgA} and dedupe_key = ${`reading:${readingId}`}`);

describe("meter register (M-01)", () => {
  it("registers a meter, audits it, publishes it and replays a retried id", async () => {
    const id = randomUUID();
    const first = await env.supervisor().metering.meters.register({ id, serial: "  REG-1 ", model: "DN15", dialDigits: 5 });
    expect(first).toMatchObject({ replayed: false, meter: { serial: "REG-1", status: "in_stock", dialDigits: 5 } });
    const again = await env.supervisor().metering.meters.register({ id, serial: "REG-1", model: "DN15", dialDigits: 5 });
    expect(again).toMatchObject({ replayed: true, meter: { id } });
    // The same id for a different meter, or by someone else, is a conflict.
    await expectCode(env.supervisor().metering.meters.register({ id, serial: "REG-OTHER", dialDigits: 5 }), "CONFLICT");
    await expectCode(env.admin.metering.meters.register({ id, serial: "REG-1", model: "DN15", dialDigits: 5 }), "CONFLICT");
    const audit = await env.t.admin.execute<{ action: string }>(sql`select action from kernel.audit_log where organization_id = ${env.orgA} and subject_id = ${id}`);
    expect(audit.map((a) => a.action)).toContain("metering.meter_register");
    expect((await events("metering.meter_status_changed")).length).toBeGreaterThan(0);
  });

  it("keeps serials unique ignoring case, and dial digits within range", async () => {
    await env.admin.metering.meters.register({ serial: "Case-1", dialDigits: 4 });
    await expectCode(env.admin.metering.meters.register({ serial: "case-1", dialDigits: 4 }), "CONFLICT", /already in the register/);
    await expectCode(env.admin.metering.meters.register({ serial: "X", dialDigits: 0 }), "BAD_REQUEST");
    await expectCode(env.admin.metering.meters.register({ serial: "X", dialDigits: 13 }), "BAD_REQUEST");
  });

  it("is licence- and permission-gated, and isolated by tenant", async () => {
    await expectCode(env.bare().metering.meters.list(), "NOT_FOUND");
    await expectCode(env.cashier().metering.meters.list(), "FORBIDDEN");
    await expectCode(env.clerk().metering.meters.register({ serial: "NOPE", dialDigits: 5 }), "FORBIDDEN");
    await expectCode(env.technician().metering.meters.register({ serial: "NOPE", dialDigits: 5 }), "FORBIDDEN");
    const m = await env.newMeter();
    await env.clerk().metering.meters.get({ meterId: m.id });
    await expectCode(env.outsider().metering.meters.get({ meterId: m.id }), "NOT_FOUND");
    expect((await env.outsider().metering.meters.list()).meters.map((x) => x.id)).not.toContain(m.id);
  });

  it("logs every lifecycle move and refuses impossible ones", async () => {
    const m = await env.newMeter();
    const move = (to: "procured" | "in_stock" | "issued" | "tested" | "installed" | "replaced" | "disposed", reason = "because") => env.supervisor().metering.meters.changeStatus({ meterId: m.id, to, reason });
    await move("issued");
    await expectCode(move("in_stock").then(() => move("procured")), "PRECONDITION_FAILED");
    await expectCode(move("installed"), "PRECONDITION_FAILED", /installation/);
    await expectCode(move("replaced"), "PRECONDITION_FAILED");
    await move("tested");
    const stepId = randomUUID();
    await env.supervisor().metering.meters.changeStatus({ id: stepId, meterId: m.id, to: "disposed", reason: "scrapped" });
    expect(await env.supervisor().metering.meters.changeStatus({ id: stepId, meterId: m.id, to: "disposed", reason: "scrapped" })).toMatchObject({ replayed: true });
    await expectCode(move("in_stock"), "PRECONDITION_FAILED");
    const detail = await env.supervisor().metering.meters.get({ meterId: m.id });
    expect(detail.meter.status).toBe("disposed");
    expect(detail.events.map((e) => e.to)).toEqual(["in_stock", "issued", "in_stock", "tested", "disposed"]);
  });
});

describe("installations (M-01)", () => {
  it("installs a meter on a service point, once, and removes it", async () => {
    const m = await env.newMeter();
    const sp = await env.newServicePoint();
    const out = await env.supervisor().metering.installations.install({ meterId: m.id, servicePointId: sp.servicePointId, installedAt: ago(50), initialReading: { value: 5 } });
    expect(out).toMatchObject({ meter: { status: "installed" }, initialReading: { value: 5, purpose: "initial", cleared: true, accountId: sp.accountId } });
    const other = await env.newMeter();
    await expectCode(env.supervisor().metering.installations.install({ meterId: other.id, servicePointId: sp.servicePointId, installedAt: ago(40) }), "CONFLICT", /already has a meter/);
    await expectCode(env.supervisor().metering.installations.install({ meterId: m.id, servicePointId: (await env.newServicePoint()).servicePointId, installedAt: ago(40) }), "PRECONDITION_FAILED");
    await expectCode(env.supervisor().metering.installations.install({ meterId: other.id, servicePointId: randomUUID(), installedAt: ago(40) }), "NOT_FOUND", /Service point/);
    await expectCode(env.supervisor().metering.installations.install({ meterId: other.id, servicePointId: (await env.newServicePoint()).servicePointId, installedAt: new Date(Date.now() + 86_400_000) }), "BAD_REQUEST");

    const removed = await env.supervisor().metering.installations.remove({ meterId: m.id, removedAt: ago(10), to: "tested", reason: "Bench test", finalReading: { value: 30 } });
    expect(removed).toMatchObject({ meter: { status: "tested" }, finalReading: { value: 30, purpose: "final" } });
    await expectCode(env.supervisor().metering.installations.remove({ meterId: m.id, removedAt: ago(9), reason: "again" }), "PRECONDITION_FAILED");
    // The service point is free again, and the history keeps both.
    await env.supervisor().metering.installations.install({ meterId: other.id, servicePointId: sp.servicePointId, installedAt: ago(9) });
    const history = await env.supervisor().metering.installations.list({ servicePointId: sp.servicePointId });
    expect(history.map((h) => h.removedAt === null)).toEqual([true, false]);
  });

  it("replays a retried install and remove by their ids", async () => {
    const m = await env.newMeter();
    const sp = await env.newServicePoint();
    const id = randomUUID();
    const input = { id, meterId: m.id, servicePointId: sp.servicePointId, installedAt: ago(30), initialReading: { id: randomUUID(), value: 7 } };
    const first = await env.supervisor().metering.installations.install(input);
    const again = await env.supervisor().metering.installations.install(input);
    expect(again).toMatchObject({ replayed: true, installationId: first.installationId, initialReading: { id: input.initialReading.id } });
    await expectCode(env.supervisor().metering.installations.install({ ...input, installedAt: ago(31) }), "CONFLICT");
  });
});

describe("readings (M-02 to M-05)", () => {
  it("records a reading with source, reader, GPS, quality and photo reference; the previous reading is derived", async () => {
    const m = await env.installedMeter(100);
    const id = randomUUID();
    const photoFileId = randomUUID();
    const { reading, replayed } = await env.technician().metering.readings.record({
      id, meterId: m.meter.id, value: 130, readAt: ago(60), source: "technician", latitude: -1.28, longitude: 36.82, quality: "doubtful", note: "Dial dirty", photoFileId,
    });
    expect(replayed).toBe(false);
    expect(reading).toMatchObject({
      id, value: 130, source: "technician", kind: "actual", readerUserId: env.members.technician.userId, quality: "doubtful", latitude: -1.28, photoFileId,
      previousValue: 100, units: 30, status: "valid", cleared: true, flags: [], accountId: m.accountId, servicePointId: m.servicePointId,
    });
    const next = (await env.technician().metering.readings.record({ meterId: m.meter.id, value: 150, readAt: ago(30), source: "technician" })).reading;
    expect(next).toMatchObject({ previousValue: 130, units: 20 });
    expect((await events("metering.reading_recorded")).some((e) => e.payload.readingId === id && e.payload.cleared === true)).toBe(true);
  });

  it("replays a retried sync and refuses a reused id with a different reading", async () => {
    const m = await env.installedMeter(100);
    const input = { id: randomUUID(), meterId: m.meter.id, value: 120, readAt: ago(60), source: "technician" as const };
    const first = await env.technician().metering.readings.record(input);
    const again = await env.technician().metering.readings.record(input);
    expect(again).toMatchObject({ replayed: true, reading: { id: first.reading.id } });
    expect(await env.technician().metering.readings.list({ meterId: m.meter.id })).toHaveLength(2);
    await expectCode(env.technician().metering.readings.record({ ...input, value: 121 }), "CONFLICT");
    await expectCode(env.admin.metering.readings.record(input), "CONFLICT");
  });

  it("needs readings:capture, and an installation covering the time", async () => {
    const m = await env.installedMeter(100);
    await expectCode(env.clerk().metering.readings.record({ meterId: m.meter.id, value: 101, readAt: ago(5), source: "office" }).then(() => env.cashier().metering.readings.list()), "FORBIDDEN");
    await expectCode(env.supervisor().metering.readings.record({ meterId: m.meter.id, value: 101, readAt: ago(5), source: "office" }), "FORBIDDEN");
    await expectCode(env.technician().metering.readings.record({ meterId: m.meter.id, value: 101, readAt: ago(200), source: "technician" }), "PRECONDITION_FAILED", /not installed/);
    await expectCode(env.technician().metering.readings.record({ meterId: m.meter.id, value: 101, readAt: new Date(Date.now() + 86_400_000), source: "technician" }), "BAD_REQUEST", /future/);
    await expectCode(env.technician().metering.readings.record({ meterId: m.meter.id, value: 100_000, readAt: ago(5), source: "technician" }), "BAD_REQUEST", /5-digit/);
    const stock = await env.newMeter();
    await expectCode(env.technician().metering.readings.record({ meterId: stock.id, value: 1, readAt: ago(5), source: "technician" }), "PRECONDITION_FAILED");
    await expectCode(env.technician().metering.readings.record({ meterId: randomUUID(), value: 1, readAt: ago(5), source: "technician" }), "NOT_FOUND");
  });

  it("flags a reading below the last actual: exception raised, not cleared, not a baseline; approving clears it and resolves the exception", async () => {
    const m = await env.installedMeter(500);
    const { reading } = await env.technician().metering.readings.record({ meterId: m.meter.id, value: 400, readAt: ago(30), source: "technician" });
    expect(reading).toMatchObject({ flags: ["BELOW_LAST"], cleared: false, status: "valid", previousValue: 500, units: null });
    expect((await openExceptions(reading.id))[0]).toMatchObject({ status: "open" });
    const exceptions = await env.admin.exceptions.list({});
    expect(JSON.stringify(exceptions)).toContain(reading.id);
    expect((await env.admin.metering.readings.list({ needsReview: true, meterId: m.meter.id })).map((r) => r.id)).toEqual([reading.id]);
    // Not a baseline while flagged.
    expect(await env.admin.metering.readings.latestActual({ meterId: m.meter.id })).toMatchObject({ value: 500 });

    await expectCode(env.technician().metering.readings.approve({ readingId: reading.id, reason: "ok" }), "FORBIDDEN");
    const approved = await env.supervisor().metering.readings.approve({ readingId: reading.id, reason: "Meter was swapped back, confirmed by visit" });
    expect(approved).toMatchObject({ replayed: false, reading: { cleared: true, status: "valid", flags: ["BELOW_LAST"] } });
    expect(await env.supervisor().metering.readings.approve({ readingId: reading.id, reason: "Meter was swapped back, confirmed by visit" })).toMatchObject({ replayed: true });
    expect((await openExceptions(reading.id))[0]).toMatchObject({ status: "resolved" });
    await expectCode(env.supervisor().metering.readings.approve({ readingId: reading.id, rollover: true, reason: "x" }), "BAD_REQUEST");
    expect(await env.admin.metering.readings.latestActual({ meterId: m.meter.id })).toMatchObject({ value: 400 });
  });

  it("detects a dial rollover from the dial digits and needs it confirmed (M-07)", async () => {
    const m = await env.installedMeter(99_950);
    const candidate = (await env.technician().metering.readings.record({ meterId: m.meter.id, value: 20, readAt: ago(30), source: "technician" })).reading;
    expect(candidate).toMatchObject({ flags: ["ROLLOVER_CANDIDATE"], cleared: false, units: null });
    // Confirmed by the reviewer: consumption counts the wrap.
    const confirmed = (await env.supervisor().metering.readings.approve({ readingId: candidate.id, rollover: true, reason: "Dial wrapped" })).reading;
    expect(confirmed).toMatchObject({ cleared: true, rolloverConfirmed: true, units: 70 });

    // Confirmed by the technician at entry.
    const m2 = await env.installedMeter(99_990);
    const direct = (await env.technician().metering.readings.record({ meterId: m2.meter.id, value: 15, readAt: ago(30), source: "technician", rolloverConfirmed: true })).reading;
    expect(direct).toMatchObject({ flags: [], cleared: true, rolloverConfirmed: true, units: 25 });
    // A confirmation the arithmetic cannot support is not taken on trust.
    const m3 = await env.installedMeter(40_000);
    const bogus = (await env.technician().metering.readings.record({ meterId: m3.meter.id, value: 100, readAt: ago(30), source: "technician", rolloverConfirmed: true })).reading;
    expect(bogus).toMatchObject({ flags: ["BELOW_LAST"], cleared: false });
  });

  it("flags zero, a same-day duplicate and an unexpected range; zero consumption is only advisory", async () => {
    const m = await env.installedMeter(100);
    const rec = (value: number, d: number) => env.technician().metering.readings.record({ meterId: m.meter.id, value, readAt: ago(d), source: "technician" });
    const zero = (await env.technician().metering.readings.record({ meterId: m.meter.id, value: 0, readAt: ago(80), source: "technician" })).reading;
    expect(zero.flags).toContain("ZERO");
    expect(zero.cleared).toBe(false);
    await env.admin.metering.readings.void({ readingId: zero.id, reason: "Typo" });

    const first = (await rec(110, 70)).reading;
    expect(first.cleared).toBe(true);
    const dup = (await env.technician().metering.readings.record({ meterId: m.meter.id, value: 111, readAt: new Date(ago(70).getTime() + 3_600_000), source: "technician" })).reading;
    expect(dup.flags).toContain("SAME_DAY_DUPLICATE");
    expect(dup.cleared).toBe(false);

    // History of 10 units every 10 days; 500 units in ten days is far above three times the usual.
    await rec(120, 60);
    await rec(130, 50);
    const high = (await rec(630, 40)).reading;
    expect(high.flags).toEqual(["ABOVE_RANGE"]);
    expect(high.cleared).toBe(false);

    const same = (await rec(130, 30)).reading;
    // 130 is below 630 only if 630 counted; it is not a baseline, so this is zero consumption against 130.
    expect(same).toMatchObject({ flags: ["ZERO_CONSUMPTION"], cleared: true, units: 0, previousValue: 130 });
  });

  it("flags a back-dated reading higher than a later one", async () => {
    const m = await env.installedMeter(100);
    await env.technician().metering.readings.record({ meterId: m.meter.id, value: 150, readAt: ago(30), source: "technician" });
    const late = (await env.technician().metering.readings.record({ meterId: m.meter.id, value: 160, readAt: ago(50), source: "technician" })).reading;
    expect(late.flags).toEqual(["OUT_OF_SEQUENCE"]);
    expect(late.cleared).toBe(false);
  });

  it("keeps estimates apart: never a baseline, never validated", async () => {
    const m = await env.installedMeter(100);
    await env.technician().metering.readings.record({ meterId: m.meter.id, value: 120, readAt: ago(60), source: "technician" });
    await expectCode(env.technician().metering.readings.recordEstimate({ meterId: m.meter.id, value: 140, readAt: ago(40) }), "FORBIDDEN");
    const est = (await env.supervisor().metering.readings.recordEstimate({ meterId: m.meter.id, value: 140, readAt: ago(40) })).reading;
    expect(est).toMatchObject({ source: "estimate", kind: "estimate", cleared: true });
    expect(await env.admin.metering.readings.latestActual({ meterId: m.meter.id })).toMatchObject({ value: 120, kind: "actual" });
    // The next actual is measured against the last actual, not the estimate.
    const actual = (await env.technician().metering.readings.record({ meterId: m.meter.id, value: 135, readAt: ago(20), source: "technician" })).reading;
    expect(actual).toMatchObject({ previousValue: 120, units: 15, flags: [] });
    // The published read can leave estimates out.
    const spId = m.servicePointId;
    const actualOnly = await withTenant(env.pool.db, env.orgA, (tx) => readingsFor(tx, { servicePointId: spId, actualOnly: true, order: "asc" }));
    expect(actualOnly.map((r) => r.value)).toEqual([100, 120, 135]);
    const everything = await withTenant(env.pool.db, env.orgA, (tx) => readingsFor(tx, { servicePointId: spId, order: "asc" }));
    expect(everything.map((r) => r.kind)).toEqual(["actual", "actual", "estimate", "actual"]);
  });

  it("voids and supersedes without ever changing a reading (M-02)", async () => {
    const m = await env.installedMeter(100);
    const a = (await env.technician().metering.readings.record({ meterId: m.meter.id, value: 120, readAt: ago(30), source: "technician" })).reading;
    const b = (await env.technician().metering.readings.record({ meterId: m.meter.id, value: 140, readAt: ago(20), source: "technician" })).reading;
    expect(b.previousValue).toBe(120);

    const fixedId = randomUUID();
    const fixed = await env.supervisor().metering.readings.correct({ id: fixedId, readingId: a.id, value: 125, source: "office", reason: "Misread the dial" });
    expect(fixed.reading).toMatchObject({ id: fixedId, value: 125, replacesReadingId: a.id, readAt: a.readAt, source: "office" });
    expect(await env.supervisor().metering.readings.get({ readingId: a.id })).toMatchObject({ value: 120, status: "superseded", cleared: false });
    // The next reading's baseline moves to the corrected one.
    expect(await env.supervisor().metering.readings.get({ readingId: b.id })).toMatchObject({ previousValue: 125, units: 15 });
    // A retry replays; a second correction of the same reading is refused.
    expect(await env.supervisor().metering.readings.correct({ id: fixedId, readingId: a.id, value: 125, source: "office", reason: "Misread the dial" })).toMatchObject({ replayed: true });
    await expectCode(env.supervisor().metering.readings.correct({ readingId: a.id, value: 126, source: "office", reason: "again" }), "PRECONDITION_FAILED");

    const voided = await env.supervisor().metering.readings.void({ readingId: b.id, reason: "Wrong meter" });
    expect(voided.reading).toMatchObject({ status: "voided", cleared: false, value: 140 });
    expect(await env.supervisor().metering.readings.void({ readingId: b.id, reason: "Wrong meter" })).toMatchObject({ replayed: true });
    await expectCode(env.supervisor().metering.readings.void({ readingId: a.id, reason: "x" }), "PRECONDITION_FAILED");
    expect((await events("metering.reading_status_changed")).length).toBeGreaterThan(0);
    // Voided and superseded rows stay in the history and out of the baseline.
    const all = await env.admin.metering.readings.list({ meterId: m.meter.id });
    expect(all.map((r) => r.status).sort()).toEqual(["superseded", "valid", "valid", "voided"]);
    expect(await env.admin.metering.readings.latestActual({ meterId: m.meter.id })).toMatchObject({ value: 125 });
  });

  it("accepts a late reading inside a closed period and marks it (M-11)", async () => {
    const m = await env.installedMeter(100);
    registerClosedPeriodSource(async () => ago(40));
    try {
      const late = (await env.technician().metering.readings.record({ meterId: m.meter.id, value: 120, readAt: ago(45), source: "customer" })).reading;
      expect(late).toMatchObject({ flags: ["CLOSED_PERIOD"], cleared: true, source: "customer" });
      const recorded = (await events("metering.reading_recorded")).find((e) => e.payload.readingId === late.id);
      expect(recorded?.payload).toMatchObject({ inClosedPeriod: true, cleared: true });
      const open = (await env.technician().metering.readings.record({ meterId: m.meter.id, value: 130, readAt: ago(30), source: "technician" })).reading;
      expect(open.flags).toEqual([]);
    } finally {
      registerClosedPeriodSource(null);
    }
  });

  it("applies the organization's validation setting (NF-32)", async () => {
    const m = await env.installedMeter(100);
    await env.admin.config.set({ key: "metering.validation", value: { highFactor: 1000, lowFactor: 0, historyIntervals: 3, maxUnitsPerDay: 1, rolloverMaxFraction: 0.5 }, expectedVersion: 0 });
    const r = (await env.technician().metering.readings.record({ meterId: m.meter.id, value: 130, readAt: ago(90), source: "technician" })).reading;
    // 30 units in 10 days is 3 a day against a ceiling of 1.
    expect(r.flags).toEqual(["ABOVE_RANGE"]);
    await env.admin.config.set({ key: "metering.validation", value: { highFactor: 3, lowFactor: 0, historyIntervals: 3, maxUnitsPerDay: null, rolloverMaxFraction: 0.5 }, expectedVersion: 1 });
  });
});

describe("meter replacement (M-07)", () => {
  it("captures the old final and the new initial reading in one step, and replays it", async () => {
    const old = await env.installedMeter(100);
    await env.technician().metering.readings.record({ meterId: old.meter.id, value: 140, readAt: ago(60), source: "technician" });
    const fresh = await env.newMeter();
    const id = randomUUID();
    const input = { id, oldMeterId: old.meter.id, newMeterId: fresh.id, replacedAt: ago(20), reason: "Stuck dial", finalReading: { value: 160 }, initialReading: { value: 0 } };
    const done = await env.supervisor().metering.installations.replace(input);
    expect(done).toMatchObject({
      replayed: false,
      servicePointId: old.servicePointId,
      oldMeter: { status: "replaced" },
      newMeter: { status: "installed" },
      finalReading: { value: 160, purpose: "final", meterId: old.meter.id, previousValue: 140, units: 20, cleared: true },
      initialReading: { value: 0, purpose: "initial", meterId: fresh.id, previousValue: null, units: null, cleared: true },
    });
    expect(await env.supervisor().metering.installations.replace(input)).toMatchObject({ replayed: true, finalReading: { id: done.finalReading.id } });
    await expectCode(env.supervisor().metering.installations.replace({ ...input, reason: "Different" }), "CONFLICT");
    expect((await events("metering.meter_replaced")).some((e) => e.payload.finalReadingId === done.finalReading.id)).toBe(true);

    // Both meters' readings are on the service point, in order; later readings are against the new meter's baseline.
    const next = (await env.technician().metering.readings.record({ meterId: fresh.id, value: 12, readAt: ago(5), source: "technician" })).reading;
    expect(next).toMatchObject({ previousValue: 0, units: 12, flags: [] });
    const trail = await withTenant(env.pool.db, env.orgA, (tx) => readingsFor(tx, { servicePointId: old.servicePointId, order: "asc" }));
    expect(trail.map((r) => [r.value, r.purpose])).toEqual([[100, "initial"], [140, "routine"], [160, "final"], [0, "initial"], [12, "routine"]]);
    // The old meter is no longer installed: no more readings on it.
    await expectCode(env.technician().metering.readings.record({ meterId: old.meter.id, value: 170, readAt: ago(4), source: "technician" }), "PRECONDITION_FAILED");
    expect(await withTenant(env.pool.db, env.orgA, (tx) => latestActualReading(tx, { servicePointId: old.servicePointId }))).toMatchObject({ value: 12 });
  });

  it("refuses a bad replacement and flags a final reading below the last", async () => {
    const old = await env.installedMeter(100);
    await expectCode(env.supervisor().metering.installations.replace({ oldMeterId: old.meter.id, newMeterId: old.meter.id, replacedAt: ago(5), reason: "x", finalReading: { value: 1 }, initialReading: { value: 0 } }), "BAD_REQUEST");
    const installed = await env.installedMeter(1);
    await expectCode(env.supervisor().metering.installations.replace({ oldMeterId: old.meter.id, newMeterId: installed.meter.id, replacedAt: ago(5), reason: "x", finalReading: { value: 100 }, initialReading: { value: 0 } }), "PRECONDITION_FAILED");
    const stock = await env.newMeter();
    const low = await env.supervisor().metering.installations.replace({ oldMeterId: old.meter.id, newMeterId: stock.id, replacedAt: ago(5), reason: "x", finalReading: { value: 50 }, initialReading: { value: 0 } });
    expect(low.finalReading).toMatchObject({ flags: ["BELOW_LAST"], cleared: false });
  });
});

describe("scope (K-03)", () => {
  it("shows a limited member only readings on accounts inside their scope", async () => {
    const outside = await env.installedMeter(100, env.routes.route.id);
    const inside = await env.installedMeter(100, env.routes.otherRoute.id);
    const seen = await env.limited().metering.readings.list({});
    expect(seen.every((r) => r.servicePointId === inside.servicePointId)).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    await expectCode(env.limited().metering.readings.record({ meterId: outside.meter.id, value: 110, readAt: ago(5), source: "technician" }), "NOT_FOUND");
    // The refused reading left nothing behind.
    expect((await env.admin.metering.readings.list({ meterId: outside.meter.id })).map((r) => r.value)).toEqual([100]);
    const ok = await env.limited().metering.readings.record({ meterId: inside.meter.id, value: 110, readAt: ago(5), source: "technician" });
    expect(ok.reading.value).toBe(110);
    await expectCode(env.limited().metering.readings.get({ readingId: outside.initialReading.id }), "NOT_FOUND");
  });
});
