import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ago, expectCode, setupMeteringEnv, type MeteringEnv } from "./test-support";

let env: MeteringEnv;
beforeAll(async () => {
  env = await setupMeteringEnv();
});
afterAll(() => env?.t.stop());

const rowsOf = async (key: string, params: Record<string, unknown> = {}) => (await env.admin.reports.run({ key, params })).rows;

// X-01: reports from the append-only attempts and readings.
describe("metering reports", () => {
  it("counts visits by outcome and route, and lists the miss and zero-consumption streaks", async () => {
    const missed = await env.installedMeter(100);
    const stuck = await env.installedMeter(100);
    const fine = await env.installedMeter(100);
    await env.admin.metering.snapshots.take({ routeId: env.routes.route.id, cycleDate: "2026-01-31" });

    await env.admin.metering.attempts.record({ servicePointId: missed.servicePointId, outcome: "locked_premises", attemptedAt: ago(5) });
    await env.admin.metering.attempts.record({ servicePointId: missed.servicePointId, outcome: "meter_faulty", attemptedAt: ago(4) });
    await env.admin.metering.attempts.record({ servicePointId: fine.servicePointId, outcome: "read_ok", attemptedAt: ago(3), reading: { value: 130 } });
    for (const d of [30, 20, 10]) await env.admin.metering.readings.record({ meterId: stuck.meter.id, value: 100, readAt: ago(d), source: "technician" });
    await env.admin.metering.readings.record({ meterId: fine.meter.id, value: 135, readAt: ago(1), source: "technician" });

    const byOutcome = await rowsOf("metering.readings_by_outcome", { groupBy: ["outcome", "routeId"] });
    expect(byOutcome).toEqual(
      expect.arrayContaining([
        { outcome: "locked_premises", routeId: env.routes.route.id, visits: 1, withReading: 0, servicePoints: 1 },
        { outcome: "read_ok", routeId: env.routes.route.id, visits: 1, withReading: 1, servicePoints: 1 },
      ]),
    );
    expect(await rowsOf("metering.readings_by_outcome", { groupBy: [], measures: ["visits"], outcome: "meter_faulty" })).toEqual([{ visits: 1 }]);
    expect(await rowsOf("metering.readings_by_outcome", { groupBy: [], measures: ["visits"], routeId: env.routes.otherRoute.id })).toEqual([{ visits: 0 }]);

    const streaks = await rowsOf("metering.read_streaks");
    const of = (sp: string) => streaks.find((r) => r.servicePointId === sp);
    expect(of(missed.servicePointId)).toMatchObject({ misses: 2, zeroStreak: 0, routeId: env.routes.route.id });
    expect(of(stuck.servicePointId)).toMatchObject({ misses: 0, zeroStreak: 3 });
    expect(of(fine.servicePointId)).toBeUndefined();
    expect((await rowsOf("metering.read_streaks", { minMisses: 2 })).map((r) => r.servicePointId)).toEqual([missed.servicePointId]);
    expect((await rowsOf("metering.read_streaks", { minZeroStreak: 3 })).map((r) => r.servicePointId)).toEqual([stuck.servicePointId]);
  });

  it("needs readings:read and a Metering licence", async () => {
    await expectCode(env.cashier().reports.run({ key: "metering.read_streaks", params: {} }), "FORBIDDEN");
    await expectCode(env.bare().reports.run({ key: "metering.read_streaks", params: {} }), "NOT_FOUND");
    expect((await env.supervisor().reports.list()).map((r) => r.key)).toEqual(expect.arrayContaining(["metering.readings_by_outcome", "metering.read_streaks"]));
    expect((await env.bare().reports.list()).map((r) => r.key).filter((k) => k.startsWith("metering."))).toEqual([]);
  });

  it("exports CSV for a registered metering report", async () => {
    const file = await env.admin.reports.export({ key: "metering.read_streaks", format: "csv", params: {} });
    expect(file.content).toContain("Visits without a reading");
    expect(file.rows).toBeGreaterThan(0);
  });
});
