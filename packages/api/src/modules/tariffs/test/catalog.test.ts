import { withTenant } from "@flowless/db";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { registerClosedPeriodSource } from "../closed-period";
import { nextPeriodStartIso } from "@flowless/shared-types";
import { categoriesById, categoryExists, categoryPricing, chargeItemByCode } from "../index";
import { expectCode, setupTariffsEnv, uniformContent, type TariffsEnv } from "./test-support";

let env: TariffsEnv;
beforeAll(async () => {
  env = await setupTariffsEnv();
});
afterAll(() => env?.t.stop());
afterEach(() => registerClosedPeriodSource(null));

let n = 0;
const code = (prefix = "item") => `${prefix}_${++n}`;
const tariff = () => env.admin.tariffs.create({ name: `Tariff ${++n}`, type: "uniform", content: uniformContent(9500n) });
const standing = (over: Record<string, unknown> = {}) => env.admin.tariffs.chargeItems.create({ code: code("standing"), name: "Standing", type: "recurring", ...over } as never);

// T-02: per-organization categories, each with its own tariff, standing charge, meter rent and discount.
describe("categories (T-02)", () => {
  it("creates, lists, renames, deactivates and reactivates a category, audited", async () => {
    const c = await env.admin.tariffs.categories.create({ code: "school", name: "  Primary   school " });
    expect(c).toMatchObject({ code: "school", name: "Primary school", active: true, current: null, upcoming: [] });
    expect((await env.clerk().tariffs.categories.list()).map((x) => x.code)).toContain("school");

    const renamed = await env.admin.tariffs.categories.update({ id: c.id, name: "Schools" });
    expect(renamed.name).toBe("Schools");
    await env.admin.tariffs.categories.deactivate({ id: c.id });
    expect((await env.admin.tariffs.categories.list()).map((x) => x.code)).not.toContain("school");
    expect((await env.admin.tariffs.categories.list({ includeInactive: true })).find((x) => x.code === "school")).toMatchObject({ active: false });
    await env.admin.tariffs.categories.reactivate({ id: c.id });
    expect((await env.admin.tariffs.categories.get({ id: c.id })).active).toBe(true);
    expect((await env.audit(c.id)).map((e) => e.action).reverse()).toEqual([
      "tariffs.category_create",
      "tariffs.category_update",
      "tariffs.category_deactivate",
      "tariffs.category_reactivate",
    ]);
  });

  it("keeps codes unique per organization and well formed", async () => {
    await env.admin.tariffs.categories.create({ code: "farm_a", name: "Farm A" });
    await expectCode(env.admin.tariffs.categories.create({ code: "farm_a", name: "Again" }), "CONFLICT", /already exists/);
    await expectCode(env.admin.tariffs.categories.create({ code: "Farm A", name: "Bad" }), "BAD_REQUEST");
    await expect(env.outsider().tariffs.categories.create({ code: "farm_a", name: "Their farm" })).resolves.toBeTruthy();
  });

  it("assigns a tariff, standing charge, meter rent and discount from a date, never editing the past", async () => {
    const cat = await env.admin.tariffs.categories.create({ code: code("dom"), name: "Domestic" });
    const t1 = await tariff();
    const t2 = await tariff();
    const rent = await standing({ code: code("rent"), name: "Meter rent" });
    const sc = await standing();
    const discount = await env.admin.tariffs.chargeItems.create({ code: code("discount"), name: "Discount", type: "adjustment" });

    // The first assignment starts today; the next one defaults to the next period start.
    const first = await env.admin.tariffs.categories.assignTariff({ categoryId: cat.id, tariffId: t1.id, standingChargeItemId: sc.id, meterRentItemId: rent.id });
    expect(first).toMatchObject({ versionNo: 1, effectiveFrom: env.today(), tariffId: t1.id, standingChargeItemId: sc.id, meterRentItemId: rent.id, discountItemId: null });
    const second = await env.admin.tariffs.categories.assignTariff({ categoryId: cat.id, tariffId: t2.id, discountItemId: discount.id });
    expect(second.effectiveFrom).toBe(nextPeriodStartIso(env.today(), { periodStartDay: 1 }));
    // Left out means unchanged: the standing charge and rent carry over.
    expect(second).toMatchObject({ versionNo: 2, tariffId: t2.id, standingChargeItemId: sc.id, meterRentItemId: rent.id, discountItemId: discount.id });

    const view = await env.admin.tariffs.categories.get({ id: cat.id });
    expect(view.current).toMatchObject({ tariffId: t1.id });
    expect(view.upcoming).toEqual([expect.objectContaining({ tariffId: t2.id })]);
    expect(view.history.map((h) => [h.versionNo, h.tariffId])).toEqual([[1, t1.id], [2, t2.id]]);

    // Category to tariff over time: the answer for a past date does not change when the tariff is switched.
    const read = (on: string) => withTenant(env.t.app, env.orgA, (tx) => categoryPricing(tx, env.orgA, cat.id, on));
    expect((await read(env.today()))?.tariffId).toBe(t1.id);
    expect((await read(second.effectiveFrom))?.tariffId).toBe(t2.id);
    expect(await read(env.inDays(-30))).toBeNull();

    // null clears one reference.
    const cleared = await env.admin.tariffs.categories.assignTariff({ categoryId: cat.id, discountItemId: null, effectiveFrom: env.inDays(60) });
    expect(cleared).toMatchObject({ discountItemId: null, tariffId: t2.id });
    expect((await env.audit(cat.id)).filter((e) => e.action === "tariffs.category_assign")).toHaveLength(3);
  });

  it("checks what an assignment points at", async () => {
    const cat = await env.admin.tariffs.categories.create({ code: code("chk"), name: "Check" });
    const fee = await env.admin.tariffs.chargeItems.create({ code: code("fee"), name: "Fee", type: "fee" });
    const off = await tariff();
    await env.admin.tariffs.update({ id: off.id, active: false });
    await expectCode(env.admin.tariffs.categories.assignTariff({ categoryId: cat.id, standingChargeItemId: fee.id }), "BAD_REQUEST", /recurring charge item/);
    await expectCode(env.admin.tariffs.categories.assignTariff({ categoryId: cat.id, meterRentItemId: fee.id }), "BAD_REQUEST", /recurring/);
    await expectCode(env.admin.tariffs.categories.assignTariff({ categoryId: cat.id, discountItemId: fee.id }), "BAD_REQUEST", /adjustment/);
    await expectCode(env.admin.tariffs.categories.assignTariff({ categoryId: cat.id, tariffId: off.id }), "BAD_REQUEST", /not active/);
    await expectCode(env.admin.tariffs.categories.assignTariff({ categoryId: cat.id, tariffId: randomUUID() }), "NOT_FOUND");
    await expectCode(env.admin.tariffs.categories.assignTariff({ categoryId: randomUUID(), tariffId: null }), "NOT_FOUND");
    await expect(env.admin.tariffs.categories.get({ id: cat.id })).resolves.toMatchObject({ history: [] });
  });

  it("dates an assignment like a tariff: replaced while ahead, refused once in force, blocked in a closed period", async () => {
    const cat = await env.admin.tariffs.categories.create({ code: code("date"), name: "Dates" });
    const t1 = await tariff();
    const t2 = await tariff();
    const day = env.inDays(15);
    await env.admin.tariffs.categories.assignTariff({ categoryId: cat.id, tariffId: t1.id, effectiveFrom: day });
    await expect(env.admin.tariffs.categories.assignTariff({ categoryId: cat.id, tariffId: t2.id, effectiveFrom: day })).resolves.toMatchObject({ versionNo: 2 });
    expect((await withTenant(env.t.app, env.orgA, (tx) => categoryPricing(tx, env.orgA, cat.id, day)))?.tariffId).toBe(t2.id);
    await env.admin.tariffs.categories.assignTariff({ categoryId: cat.id, tariffId: t1.id, effectiveFrom: env.today() });
    await expectCode(env.admin.tariffs.categories.assignTariff({ categoryId: cat.id, tariffId: t2.id, effectiveFrom: env.today() }), "CONFLICT");
    registerClosedPeriodSource(async () => new Date(`${env.inDays(2)}T00:00:00Z`));
    await expectCode(env.admin.tariffs.categories.assignTariff({ categoryId: cat.id, tariffId: t2.id, effectiveFrom: env.inDays(1) }), "BAD_REQUEST", /closed billing period/);
  });

  it("publishes reads for modules that hold the opaque category id", async () => {
    const cat = await env.admin.tariffs.categories.create({ code: code("pub"), name: "Published" });
    const read = <T,>(fn: (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => Promise<T>, org: string = env.orgA) => withTenant(env.t.app, org, fn);
    expect(await read((tx) => categoryExists(tx, env.orgA, cat.id))).toBe(true);
    expect(await read((tx) => categoryExists(tx, env.orgA, randomUUID()))).toBe(false);
    // Another organization's id is not a category here, even by id.
    expect(await read((tx) => categoryExists(tx, env.orgB, cat.id), env.orgB)).toBe(false);
    await env.admin.tariffs.categories.deactivate({ id: cat.id });
    expect(await read((tx) => categoryExists(tx, env.orgA, cat.id))).toBe(true);
    expect(await read((tx) => categoryExists(tx, env.orgA, cat.id, { activeOnly: true }))).toBe(false);
    expect((await read((tx) => categoriesById(tx, env.orgA, [cat.id, randomUUID()]))).get(cat.id)).toMatchObject({ code: cat.code, active: false });
  });

  it("is read-only for a clerk, invisible to a cashier and to another organization", async () => {
    const cat = await env.admin.tariffs.categories.create({ code: code("perm"), name: "Perm" });
    await expectCode(env.clerk().tariffs.categories.create({ code: code(), name: "No" }), "FORBIDDEN");
    await expectCode(env.clerk().tariffs.categories.assignTariff({ categoryId: cat.id, tariffId: null }), "FORBIDDEN");
    await expectCode(env.cashier().tariffs.categories.list(), "FORBIDDEN");
    await expect(env.manager().tariffs.categories.update({ id: cat.id, name: "Manager renamed" })).resolves.toBeTruthy();
    await expectCode(env.outsider().tariffs.categories.get({ id: cat.id }), "NOT_FOUND");
    await expectCode(env.outsider().tariffs.categories.update({ id: cat.id, name: "Mine now" }), "NOT_FOUND");
    await expectCode(env.bare().tariffs.categories.list(), "NOT_FOUND", /not licensed/);
  });
});

// T-07: the charge catalog.
describe("charge catalog (T-07)", () => {
  it("derives the revenue kind from the type: a deposit is a liability", async () => {
    const kinds: Record<string, string> = {};
    for (const type of ["usage", "recurring", "fee", "penalty", "deposit", "material", "labour", "transfer", "adjustment"] as const) {
      const item = await env.admin.tariffs.chargeItems.create({ code: code(type), name: type, type });
      kinds[type] = item.revenueKind;
    }
    expect(kinds).toEqual({
      usage: "revenue",
      recurring: "revenue",
      fee: "revenue",
      penalty: "revenue",
      deposit: "liability",
      material: "revenue",
      labour: "revenue",
      transfer: "non_revenue",
      adjustment: "revenue",
    });
  });

  it("gives a recurring item a monthly recurrence by default and no other type one", async () => {
    expect(await standing()).toMatchObject({ type: "recurring", recurrence: "monthly" });
    expect(await standing({ recurrence: "quarterly" })).toMatchObject({ recurrence: "quarterly" });
    await expectCode(env.admin.tariffs.chargeItems.create({ code: code(), name: "Fee", type: "fee", recurrence: "monthly" }), "BAD_REQUEST", /recurring/);
  });

  it("keeps codes unique per organization and refuses a bad one", async () => {
    const c = code("dup");
    await env.admin.tariffs.chargeItems.create({ code: c, name: "One", type: "fee" });
    await expectCode(env.admin.tariffs.chargeItems.create({ code: c, name: "Two", type: "fee" }), "CONFLICT", /already exists/);
    await expectCode(env.admin.tariffs.chargeItems.create({ code: "Has Space", name: "Bad", type: "fee" }), "BAD_REQUEST");
    await expect(env.outsider().tariffs.chargeItems.create({ code: c, name: "Theirs", type: "fee" })).resolves.toBeTruthy();
  });

  it("holds amounts as immutable effective-dated versions in bigint minor units", async () => {
    const item = await env.admin.tariffs.chargeItems.create({ code: code("conn"), name: "Connection fee", type: "fee", amount: 1_500_000n });
    expect(item.amount).toMatchObject({ versionNo: 1, effectiveFrom: env.today(), amount: 1_500_000n });
    const later = await env.admin.tariffs.chargeItems.addAmountVersion({ chargeItemId: item.id, amount: 1_800_000n, reason: "Annual review" });
    expect(later).toMatchObject({ versionNo: 2, effectiveFrom: nextPeriodStartIso(env.today(), { periodStartDay: 1 }), amount: 1_800_000n });
    const got = await env.admin.tariffs.chargeItems.get({ id: item.id });
    expect(got.amount?.amount).toBe(1_500_000n);
    expect(got.upcoming.map((u) => u.amount)).toEqual([1_800_000n]);
    expect(got.amounts.map((a) => [a.versionNo, a.amount, a.until])).toEqual([[1, 1_500_000n, later.effectiveFrom], [2, 1_800_000n, null]]);

    const amountAt = (on: string) => withTenant(env.t.app, env.orgA, (tx) => chargeItemByCode(tx, env.orgA, item.code, on));
    expect((await amountAt(env.today()))?.amount?.amount).toBe(1_500_000n);
    expect((await amountAt(later.effectiveFrom))?.amount?.amount).toBe(1_800_000n);
    expect((await amountAt(env.inDays(-5)))?.amount).toBeNull();
    expect(await withTenant(env.t.app, env.orgA, (tx) => chargeItemByCode(tx, env.orgA, "nope", env.today()))).toBeNull();

    const events = (await env.events(env.orgA, "tariffs.charge_item_amount_changed")).filter((e) => e.chargeItemId === item.id);
    expect(events).toEqual([
      expect.objectContaining({ versionNo: 1, amount: "1500000", previousAmount: null }),
      expect.objectContaining({ versionNo: 2, amount: "1800000", previousAmount: "1500000" }),
    ]);
    expect((await env.events(env.orgA, "tariffs.charge_item_created")).filter((e) => e.chargeItemId === item.id)).toEqual([
      expect.objectContaining({ code: item.code, type: "fee", revenueKind: "revenue" }),
    ]);
    const trail = (await env.audit(item.id)).map((e) => e.action).reverse();
    expect(trail).toEqual(["tariffs.charge_item_create", "tariffs.charge_item_amount_add", "tariffs.charge_item_amount_add"]);
  });

  it("refuses an amount for a usage item, a negative amount, and a closed or taken date", async () => {
    const usage = await env.admin.tariffs.chargeItems.create({ code: code("use"), name: "Usage", type: "usage" });
    expect(usage.amount).toBeNull();
    await expectCode(env.admin.tariffs.chargeItems.addAmountVersion({ chargeItemId: usage.id, amount: 5n }), "BAD_REQUEST", /priced by a tariff/);
    await expectCode(env.admin.tariffs.chargeItems.create({ code: code(), name: "Usage amount", type: "usage", amount: 5n }), "BAD_REQUEST");
    const fee = await env.admin.tariffs.chargeItems.create({ code: code("fee"), name: "Fee", type: "fee", amount: 100n });
    await expectCode(env.admin.tariffs.chargeItems.addAmountVersion({ chargeItemId: fee.id, amount: -1n }), "BAD_REQUEST");
    await expectCode(env.admin.tariffs.chargeItems.addAmountVersion({ chargeItemId: fee.id, amount: 200n, effectiveFrom: env.today() }), "CONFLICT", /already takes effect/);
    registerClosedPeriodSource(async () => new Date(`${env.inDays(3)}T00:00:00Z`));
    await expectCode(env.admin.tariffs.chargeItems.addAmountVersion({ chargeItemId: fee.id, amount: 200n, effectiveFrom: env.inDays(3) }), "BAD_REQUEST", /closed billing period/);
    await expect(env.admin.tariffs.chargeItems.addAmountVersion({ chargeItemId: fee.id, amount: 200n, effectiveFrom: env.inDays(4) })).resolves.toBeTruthy();
  });

  it("renames, links to inventory, and deactivates an item", async () => {
    const item = await env.admin.tariffs.chargeItems.create({ code: code("mat"), name: "Pipe", type: "material" });
    const ref = randomUUID();
    const updated = await env.admin.tariffs.chargeItems.update({ id: item.id, name: "Pipe 25mm", inventoryItemRef: ref });
    expect(updated).toMatchObject({ name: "Pipe 25mm", inventoryItemRef: ref });
    expect((await env.admin.tariffs.chargeItems.update({ id: item.id, inventoryItemRef: null })).inventoryItemRef).toBeNull();
    await expectCode(env.admin.tariffs.chargeItems.update({ id: item.id, recurrence: "monthly" }), "BAD_REQUEST");
    const off = await env.admin.tariffs.chargeItems.deactivate({ id: item.id });
    expect(off.active).toBe(false);
    expect((await env.admin.tariffs.chargeItems.list({ active: true })).map((i) => i.code)).not.toContain(item.code);
    expect((await env.admin.tariffs.chargeItems.get({ code: item.code })).active).toBe(false);
    expect((await env.admin.tariffs.chargeItems.reactivate({ id: item.id })).active).toBe(true);
  });

  it("is read-only for a clerk and separate per organization", async () => {
    const item = await env.admin.tariffs.chargeItems.create({ code: code("sep"), name: "Separate", type: "fee", amount: 1n });
    await expect(env.clerk().tariffs.chargeItems.list()).resolves.toBeTruthy();
    await expectCode(env.clerk().tariffs.chargeItems.create({ code: code(), name: "No", type: "fee" }), "FORBIDDEN");
    await expectCode(env.clerk().tariffs.chargeItems.addAmountVersion({ chargeItemId: item.id, amount: 2n }), "FORBIDDEN");
    await expectCode(env.cashier().tariffs.chargeItems.list(), "FORBIDDEN");
    await expectCode(env.outsider().tariffs.chargeItems.get({ id: item.id }), "NOT_FOUND");
    await expectCode(env.outsider().tariffs.chargeItems.addAmountVersion({ chargeItemId: item.id, amount: 2n }), "NOT_FOUND");
    expect((await env.outsider().tariffs.chargeItems.list()).map((i) => i.id)).not.toContain(item.id);
  });
});
