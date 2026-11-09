import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { registerClosedPeriodSource } from "../closed-period";
import { nextPeriodStartIso } from "@flowless/shared-types";
import { tariffPolicySetting } from "../settings";
import { REFERENCE_BANDS, expectCode, increasingContent, setupTariffsEnv, uniformContent, type TariffsEnv } from "./test-support";

let env: TariffsEnv;
beforeAll(async () => {
  env = await setupTariffsEnv();
});
afterAll(() => env?.t.stop());
afterEach(() => registerClosedPeriodSource(null));

let n = 0;
const name = (prefix = "Tariff") => `${prefix} ${++n}`;
const makeTariff = (over: Record<string, unknown> = {}) => env.admin.tariffs.create({ name: name(), type: "uniform", content: uniformContent(9500n), ...over } as never);

// T-01, T-03: tariffs are versioned and effective-dated.
describe("tariffs.create and versions (T-01)", () => {
  it("creates an increasing-block tariff from the reference bands, starting today", async () => {
    const created = await env.admin.tariffs.create({ name: name("Domestic"), type: "increasing_block", content: increasingContent() });
    expect(created).toMatchObject({ type: "increasing_block", flatBasis: "none", active: true, firstVersion: { versionNo: 1, effectiveFrom: env.today() } });
    const got = await env.admin.tariffs.get({ id: created.id });
    expect(got.versions).toHaveLength(1);
    expect(got.inForce?.content).toEqual(increasingContent());
    expect(got.inForce?.until).toBeNull();
  });

  it("keeps rates as exact minor-unit bigints through the database and the wire", async () => {
    const created = await env.admin.tariffs.create({ name: name(), type: "uniform", content: uniformContent(123_456_789_012n) });
    const read = await env.admin.tariffs.inForce({ tariffId: created.id });
    expect(read.version?.content).toEqual({ type: "uniform", rate: 123_456_789_012n });
    expect(read.bands).toEqual([{ from: 0, to: null, rate: 123_456_789_012n }]);
  });

  it("creates decreasing, uniform and flat-rate tariffs", async () => {
    const decreasing = await env.admin.tariffs.create({
      name: name(),
      type: "decreasing_block",
      content: { type: "decreasing_block", bands: [{ from: 0, to: 10, rate: 20_000n }, { from: 10, to: null, rate: 15_000n }] },
    });
    expect(decreasing.type).toBe("decreasing_block");
    const flat = await env.admin.tariffs.create({
      name: name(),
      type: "flat_rate",
      flatBasis: "pipe_size",
      content: { type: "flat_rate", amounts: [{ key: "15mm", amount: 50_000n }, { key: "25mm", amount: 120_000n }] },
    });
    expect(flat).toMatchObject({ type: "flat_rate", flatBasis: "pipe_size" });
    expect((await env.admin.tariffs.get({ id: flat.id })).inForce?.content).toEqual({
      type: "flat_rate",
      amounts: [{ key: "15mm", amount: 50_000n }, { key: "25mm", amount: 120_000n }],
    });
  });

  it("rejects content that does not fit the type, with the reasons", async () => {
    await expectCode(
      env.admin.tariffs.create({ name: name(), type: "increasing_block", content: increasingContent([{ from: 0, to: 6, rate: 1n }, { from: 8, to: null, rate: 2n }]) }),
      "BAD_REQUEST",
      /Gap between bands 1 and 2/,
    );
    await expectCode(env.admin.tariffs.create({ name: name(), type: "uniform", content: increasingContent() }), "BAD_REQUEST", /uniform tariff/);
    await expectCode(
      env.admin.tariffs.create({ name: name(), type: "flat_rate", flatBasis: "taps", content: { type: "flat_rate", amounts: [{ key: "many", amount: 1n }] } }),
      "BAD_REQUEST",
      /number of taps/,
    );
    await expectCode(env.admin.tariffs.create({ name: name(), type: "uniform", flatBasis: "taps", content: uniformContent(1n) }), "BAD_REQUEST", /basis/);
    await expectCode(env.admin.tariffs.create({ name: name(), type: "uniform", content: { type: "uniform", rate: -1n } }), "BAD_REQUEST");
    // Nothing was created by the failed calls.
    expect((await env.admin.tariffs.list()).every((t) => t.versionCount === 1)).toBe(true);
  });

  it("refuses a duplicate tariff name, whatever its case", async () => {
    const first = await makeTariff({ name: "Kiosk tariff" });
    await expectCode(makeTariff({ name: "KIOSK TARIFF" }), "CONFLICT", /already exists/);
    const renamed = await env.admin.tariffs.update({ id: first.id, name: "Kiosk tariff 2" });
    expect(renamed.name).toBe("Kiosk tariff 2");
  });

  it("audits creation and publishes tariffs.tariff_version_created in the same transaction", async () => {
    const created = await makeTariff();
    const actions = (await env.audit(created.id)).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["tariffs.tariff_create", "tariffs.tariff_version_add"]));
    const entry = (await env.audit(created.id)).find((e) => e.action === "tariffs.tariff_version_add")!;
    expect(entry.after).toMatchObject({ versionNo: 1, effectiveFrom: env.today(), content: { type: "uniform", rate: "9500" } });
    expect((await env.events(env.orgA, "tariffs.tariff_version_created")).filter((p) => p.tariffId === created.id)).toEqual([
      expect.objectContaining({ versionNo: 1, type: "uniform", effectiveFrom: env.today(), createdByUserId: env.members.admin.userId }),
    ]);
  });
});

// T-01, T-03, T-04: a change is a new version; versions never overlap.
describe("tariffs.addVersion (T-03)", () => {
  it("defaults to the next billing period start", async () => {
    const t = await makeTariff();
    const added = await env.admin.tariffs.addVersion({ tariffId: t.id, content: uniformContent(10_000n) });
    expect(added).toMatchObject({ versionNo: 2 });
    expect(added.effectiveFrom).toBe(nextPeriodStartIso(env.today(), { periodStartDay: 1 }));
    const preview = await env.admin.tariffs.nextEffectiveDate();
    expect(preview).toMatchObject({ today: env.today(), effectiveFrom: added.effectiveFrom, periodStartDay: 1, closedThrough: null });
  });

  it("keeps the old version in force until the new one starts, and ends it there", async () => {
    const t = await makeTariff();
    const start = env.inDays(10);
    await env.admin.tariffs.addVersion({ tariffId: t.id, content: uniformContent(11_000n), effectiveFrom: start });
    const versions = await env.admin.tariffs.versions({ tariffId: t.id });
    expect(versions.map((v) => [v.versionNo, v.effectiveFrom, v.until])).toEqual([
      [1, env.today(), start],
      [2, start, null],
    ]);
    expect((await env.admin.tariffs.inForce({ tariffId: t.id })).version?.versionNo).toBe(1);
    expect((await env.admin.tariffs.inForce({ tariffId: t.id, date: env.inDays(9) })).version?.versionNo).toBe(1);
    const later = await env.admin.tariffs.inForce({ tariffId: t.id, date: start });
    expect(later.version?.versionNo).toBe(2);
    expect(later.bands).toEqual([{ from: 0, to: null, rate: 11_000n }]);
    // Before the first version there is nothing.
    expect((await env.admin.tariffs.inForce({ tariffId: t.id, date: env.inDays(-400) })).version).toBeNull();
    expect((await env.admin.tariffs.list()).find((x) => x.id === t.id)).toMatchObject({ versionCount: 2, nextChangeOn: start, current: { versionNo: 1 } });
  });

  it("follows the period start day in the tariffs.policy setting", async () => {
    const current = (await env.admin.config.list()).find((s) => s.key === tariffPolicySetting.key)!;
    expect(current).toMatchObject({ module: "tariffs", version: 0 });
    await env.admin.config.set({ key: tariffPolicySetting.key, value: { periodStartDay: 15 }, expectedVersion: current.version });
    try {
      const t = await makeTariff();
      const added = await env.admin.tariffs.addVersion({ tariffId: t.id, content: uniformContent(10_000n) });
      expect(added.effectiveFrom).toBe(nextPeriodStartIso(env.today(), { periodStartDay: 15 }));
      expect(added.effectiveFrom.endsWith("-15")).toBe(true);
    } finally {
      await env.admin.config.set({ key: tariffPolicySetting.key, value: { periodStartDay: 1 }, expectedVersion: 1 });
    }
  });

  it("rejects a period start day outside 1 to 28", async () => {
    await expectCode(env.admin.config.set({ key: tariffPolicySetting.key, value: { periodStartDay: 31 }, expectedVersion: 2 }), "BAD_REQUEST");
  });

  it("allows a past date that is not in a closed period (back-dating)", async () => {
    const t = await makeTariff();
    const added = await env.admin.tariffs.addVersion({ tariffId: t.id, content: uniformContent(8_000n), effectiveFrom: env.inDays(-3) });
    expect(added.effectiveFrom).toBe(env.inDays(-3));
    // Version 1 still starts today, later than the back-dated one, so it governs from today.
    expect((await env.admin.tariffs.inForce({ tariffId: t.id, date: env.inDays(-3) })).version?.versionNo).toBe(2);
    expect((await env.admin.tariffs.inForce({ tariffId: t.id })).version?.versionNo).toBe(1);
  });

  it("replaces a version still ahead by adding another with the same date, and refuses one already in force", async () => {
    const t = await makeTariff();
    const day = env.inDays(20);
    await env.admin.tariffs.addVersion({ tariffId: t.id, content: uniformContent(10_000n), effectiveFrom: day });
    const fixed = await env.admin.tariffs.addVersion({ tariffId: t.id, content: uniformContent(10_500n), effectiveFrom: day });
    expect(fixed.versionNo).toBe(3);
    const versions = await env.admin.tariffs.versions({ tariffId: t.id });
    // The mistaken version covers no days; the replacement is in force from the date.
    expect(versions.map((v) => [v.versionNo, v.effectiveFrom, v.until])).toEqual([
      [1, env.today(), day],
      [2, day, day],
      [3, day, null],
    ]);
    expect((await env.admin.tariffs.inForce({ tariffId: t.id, date: day })).version?.content).toEqual(uniformContent(10_500n));
    // The first version has been in force since today: its date cannot be taken again.
    await expectCode(env.admin.tariffs.addVersion({ tariffId: t.id, content: uniformContent(1n), effectiveFrom: env.today() }), "CONFLICT", /already takes effect/);
  });

  it("validates a new version against the tariff's type and basis", async () => {
    const t = await env.admin.tariffs.create({ name: name(), type: "flat_rate", flatBasis: "taps", content: { type: "flat_rate", amounts: [{ key: "1", amount: 100n }] } });
    await expectCode(env.admin.tariffs.addVersion({ tariffId: t.id, content: uniformContent(5n) }), "BAD_REQUEST", /flat rate/);
    await expectCode(env.admin.tariffs.addVersion({ tariffId: t.id, content: { type: "flat_rate", amounts: [{ key: null, amount: 5n }] } }), "BAD_REQUEST", /needs a taps/);
    const ok = await env.admin.tariffs.addVersion({ tariffId: t.id, content: { type: "flat_rate", amounts: [{ key: "1", amount: 150n }, { key: "2", amount: 250n }] } });
    expect(ok.versionNo).toBe(2);
  });

  it("numbers versions in turn when writers race, with no overlap and no gap in numbering", async () => {
    const t = await makeTariff();
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) => env.as(i % 2 ? env.members.manager : env.members.admin).tariffs.addVersion({ tariffId: t.id, content: uniformContent(BigInt(10_000 + i)), effectiveFrom: env.inDays(30 + i) })),
    );
    expect(results.filter((r) => r.status === "rejected")).toEqual([]);
    const versions = await env.admin.tariffs.versions({ tariffId: t.id });
    expect(versions.map((v) => v.versionNo).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    for (let i = 0; i + 1 < versions.length; i++) expect(versions[i]!.until).toBe(versions[i + 1]!.effectiveFrom);
  });

  it("deactivates a tariff without touching its versions", async () => {
    const t = await makeTariff();
    const off = await env.admin.tariffs.update({ id: t.id, active: false });
    expect(off.active).toBe(false);
    expect((await env.admin.tariffs.list({ active: true })).some((x) => x.id === t.id)).toBe(false);
    expect((await env.admin.tariffs.versions({ tariffId: t.id })).length).toBe(1);
    expect((await env.audit(t.id)).map((e) => e.action)).toContain("tariffs.tariff_update");
  });
});

// T-03: changes dated inside a closed period are blocked, through the port.
describe("closed-period port (T-03)", () => {
  it("blocks versions that start on or before the day the latest closed period ends", async () => {
    const t = await makeTariff();
    const closed = env.inDays(5);
    const seen: string[] = [];
    registerClosedPeriodSource(async (_tx, organizationId) => {
      seen.push(organizationId);
      return new Date(`${closed}T00:00:00Z`);
    });
    await expectCode(env.admin.tariffs.addVersion({ tariffId: t.id, content: uniformContent(1n), effectiveFrom: closed }), "BAD_REQUEST", /closed billing period/);
    await expectCode(env.admin.tariffs.addVersion({ tariffId: t.id, content: uniformContent(1n), effectiveFrom: env.inDays(-1) }), "BAD_REQUEST", /closed billing period/);
    // The default is the next period start, which may itself be closed.
    registerClosedPeriodSource(async () => new Date(`${nextPeriodStartIso(env.today(), { periodStartDay: 1 })}T00:00:00Z`));
    await expectCode(env.admin.tariffs.addVersion({ tariffId: t.id, content: uniformContent(1n) }), "BAD_REQUEST", /closed billing period/);
    expect((await env.admin.tariffs.nextEffectiveDate()).closedThrough).toBe(nextPeriodStartIso(env.today(), { periodStartDay: 1 }));
    registerClosedPeriodSource(async () => new Date(`${closed}T00:00:00Z`));
    const after = await env.admin.tariffs.addVersion({ tariffId: t.id, content: uniformContent(1n), effectiveFrom: env.inDays(6) });
    expect(after.effectiveFrom).toBe(env.inDays(6));
    expect(seen.every((id) => id === env.orgA)).toBe(true);
    expect((await env.admin.tariffs.versions({ tariffId: t.id })).length).toBe(2);
  });

  it("allows everything again when no source is registered", async () => {
    const t = await makeTariff();
    const added = await env.admin.tariffs.addVersion({ tariffId: t.id, content: uniformContent(2n), effectiveFrom: env.inDays(-100) });
    expect(added.effectiveFrom).toBe(env.inDays(-100));
  });
});

describe("tariff permissions and tenancy", () => {
  it("lets a clerk read but not change, and a cashier do neither", async () => {
    const t = await makeTariff();
    await expect(env.clerk().tariffs.list()).resolves.toBeTruthy();
    await expect(env.clerk().tariffs.get({ id: t.id })).resolves.toBeTruthy();
    await expectCode(env.clerk().tariffs.create({ name: name(), type: "uniform", content: uniformContent(1n) }), "FORBIDDEN", /tariffs:manage/);
    await expectCode(env.clerk().tariffs.addVersion({ tariffId: t.id, content: uniformContent(1n) }), "FORBIDDEN");
    await expectCode(env.clerk().tariffs.update({ id: t.id, active: false }), "FORBIDDEN");
    await expectCode(env.cashier().tariffs.list(), "FORBIDDEN", /tariffs:read/);
    await expectCode(env.cashier().tariffs.nextEffectiveDate(), "FORBIDDEN");
    await expect(env.manager().tariffs.addVersion({ tariffId: t.id, content: uniformContent(3n), effectiveFrom: env.inDays(40) })).resolves.toBeTruthy();
  });

  it("does not show one organization's tariffs to another", async () => {
    const mine = await makeTariff();
    expect((await env.outsider().tariffs.list()).map((x) => x.id)).not.toContain(mine.id);
    await expectCode(env.outsider().tariffs.get({ id: mine.id }), "NOT_FOUND");
    await expectCode(env.outsider().tariffs.addVersion({ tariffId: mine.id, content: uniformContent(1n) }), "NOT_FOUND");
    await expectCode(env.outsider().tariffs.inForce({ tariffId: mine.id }), "NOT_FOUND");
    expect(await env.outsider().tariffs.versions({ tariffId: (await env.outsider().tariffs.create({ name: name(), type: "uniform", content: uniformContent(1n) })).id })).toHaveLength(1);
  });

  it("is not found where Tariffs is not licensed", async () => {
    await expectCode(env.bare().tariffs.list(), "NOT_FOUND", /not licensed/);
    await expectCode(env.bare().tariffs.create({ name: "x", type: "uniform", content: uniformContent(1n) }), "NOT_FOUND");
  });

  it("keeps the reference bands exactly as given", () => {
    expect(REFERENCE_BANDS.at(-1)).toEqual({ from: 300, to: null, rate: 24000n });
  });
});
