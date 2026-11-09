import { enqueueEvent, withTenant } from "@flowless/db";
import { DEFAULT_CATEGORIES } from "@flowless/shared-types";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { consumers } from "../../../kernel/consumers";
import { setEntitlements } from "../../../kernel/entitlement-store";
import { drainOutbox, replayEvents, type Consumer } from "../../../kernel/events";
import { DEFAULT_CHARGE_ITEMS, DEFAULT_INVOICE_TYPES, ensureDefaults, seedDefaultsOnCreation } from "../index";
import { expectCode, setupTariffsEnv, type TariffsEnv } from "./test-support";

let env: TariffsEnv;
beforeAll(async () => {
  env = await setupTariffsEnv();
});
afterAll(() => env?.t.stop());

/** Rows per table of one organization, read around RLS. */
async function counts(organizationId: string) {
  const one = async (table: string) => Number((await env.db.execute<{ n: string }>(sql`select count(*)::text as n from ${sql.raw(`tariffs.${table}`)} where organization_id = ${organizationId}`))[0]!.n);
  return { categories: await one("category"), items: await one("charge_item"), types: await one("invoice_type"), lines: await one("invoice_type_line"), amounts: await one("charge_item_amount") };
}

const newOrganization = async () => {
  const id = randomUUID();
  await env.db.execute(sql`insert into auth.organization (id, name, slug, created_at) values (${id}, 'Seeded', ${`org-${id}`}, now())`);
  return id;
};
const created = (organizationId: string) =>
  withTenant(env.t.app, organizationId, (tx) => enqueueEvent(tx, { organizationId, type: "organization.created", id: organizationId, payload: { name: "Seeded", code: "seeded" } }));

const EXPECTED = {
  categories: DEFAULT_CATEGORIES.length,
  items: DEFAULT_CHARGE_ITEMS.length,
  types: DEFAULT_INVOICE_TYPES.length,
  lines: DEFAULT_INVOICE_TYPES.reduce((sum, t) => sum + t.lines.length, 0),
  amounts: 0,
};

// T-02, T-07, T-08: a new organization starts with categories, a charge catalog and invoice types.
describe("default seeding", () => {
  it("seeds a licensed organization once the licence event is delivered", async () => {
    expect(await counts(env.orgA)).toMatchObject({ categories: 0, items: 0, types: 0 });
    const drained = await drainOutbox(env.t.app, consumers);
    expect(drained.failed).toBe(0);
    expect(await counts(env.orgA)).toEqual(EXPECTED);
    expect(await counts(env.orgB)).toEqual(EXPECTED);
    // Organization C does not have Tariffs: nothing for it.
    expect(await counts(env.orgC)).toMatchObject({ categories: 0, items: 0, types: 0 });
  });

  it("seeds the six categories, the eleven catalog items and the new-connection template", async () => {
    expect((await env.admin.tariffs.categories.list()).map((c) => c.code).sort()).toEqual(["commercial", "domestic", "farming", "institution", "kiosk", "reseller"]);
    const items = await env.admin.tariffs.chargeItems.list();
    const byCode = Object.fromEntries(items.map((i) => [i.code, i]));
    expect(Object.keys(byCode).sort()).toEqual(
      ["application_fee", "connection_fee", "deposit", "labour", "late_fee", "materials", "meter", "meter_rent", "reconnection_fee", "standing_charge", "water_usage"].sort(),
    );
    expect(byCode.deposit).toMatchObject({ type: "deposit", revenueKind: "liability" });
    expect(byCode.standing_charge).toMatchObject({ type: "recurring", recurrence: "monthly" });
    expect(byCode.meter_rent).toMatchObject({ type: "recurring", recurrence: "monthly" });
    expect(byCode.water_usage).toMatchObject({ type: "usage", amount: null });
    expect(byCode.late_fee?.type).toBe("penalty");
    // No prices: those are the organization's.
    expect(items.every((i) => i.amount === null)).toBe(true);

    const types = await env.admin.tariffs.invoiceTypes.list();
    expect(types.map((t) => t.code).sort()).toEqual(["adjustment", "deposit", "new_connection", "penalty", "usage"]);
    const connection = types.find((t) => t.code === "new_connection")!;
    expect(connection).toMatchObject({ appliesTo: "application", overdue: { action: "pause_application" }, terms: { kind: "full" } });
    expect(connection.lines.map((l) => l.code)).toEqual(["application_fee", "connection_fee", "meter", "materials", "labour", "deposit"]);
    expect(types.filter((t) => t.appliesTo === "application").every((t) => t.overdue.action !== "disconnect")).toBe(true);
  });

  it("is idempotent: a repeat, a replay and a parallel run add nothing and keep the organization's changes", async () => {
    const domestic = (await env.admin.tariffs.categories.list()).find((c) => c.code === "domestic")!;
    await env.admin.tariffs.categories.update({ id: domestic.id, name: "Household" });
    const kiosk = (await env.admin.tariffs.categories.list()).find((c) => c.code === "kiosk")!;
    await env.admin.tariffs.categories.deactivate({ id: kiosk.id });
    const item = (await env.admin.tariffs.chargeItems.list()).find((i) => i.code === "meter")!;
    await env.admin.tariffs.chargeItems.addAmountVersion({ chargeItemId: item.id, amount: 450_000n });
    const connection = (await env.admin.tariffs.invoiceTypes.list()).find((t) => t.code === "new_connection")!;
    await env.admin.tariffs.invoiceTypes.setLines({ id: connection.id, lines: [{ chargeItemCode: "connection_fee" }] });

    // The creation event for an organization that is already licensed and seeded.
    await created(env.orgA);
    await drainOutbox(env.t.app, consumers);
    expect(await replayEvents(env.t.app, seedDefaultsOnCreation as Consumer, { organizationId: env.orgA })).toBe(1);
    await Promise.all([
      withTenant(env.pool.db, env.orgA, (tx) => ensureDefaults(tx, env.orgA)),
      withTenant(env.pool.db, env.orgA, (tx) => ensureDefaults(tx, env.orgA)),
      withTenant(env.pool.db, env.orgA, (tx) => ensureDefaults(tx, env.orgA)),
    ]);

    expect(await counts(env.orgA)).toEqual({ ...EXPECTED, lines: EXPECTED.lines - 5, amounts: 1 });
    const after = await env.admin.tariffs.categories.list({ includeInactive: true });
    expect(after.find((c) => c.code === "domestic")?.name).toBe("Household");
    expect(after.find((c) => c.code === "kiosk")?.active).toBe(false);
    expect((await env.admin.tariffs.invoiceTypes.get({ id: connection.id })).lines.map((l) => l.code)).toEqual(["connection_fee"]);
    expect((await env.admin.tariffs.chargeItems.get({ id: item.id })).amount?.amount).toBe(450_000n);
  });

  it("seeds on organization.created when Tariffs is already licensed, and again harmlessly on the licence event", async () => {
    const org = await newOrganization();
    await setEntitlements(env.t.app, org, ["accounts", "tariffs"]);
    await created(org);
    const first = await drainOutbox(env.t.app, consumers);
    expect(first.failed).toBe(0);
    expect(await counts(org)).toEqual(EXPECTED);
    // The same licence set again publishes another event; nothing is added.
    await setEntitlements(env.t.app, org, ["accounts", "tariffs", "billing"]);
    await drainOutbox(env.t.app, consumers);
    expect(await counts(org)).toEqual(EXPECTED);
  });

  it("waits for the licence: organization.created before Tariffs is licensed seeds nothing, the licence event does", async () => {
    const org = await newOrganization();
    await created(org);
    await drainOutbox(env.t.app, consumers);
    expect(await counts(org)).toMatchObject({ categories: 0, items: 0, types: 0 });
    await setEntitlements(env.t.app, org, ["accounts"]);
    await drainOutbox(env.t.app, consumers);
    expect(await counts(org)).toMatchObject({ categories: 0, items: 0, types: 0 });
    await setEntitlements(env.t.app, org, ["accounts", "tariffs"]);
    await drainOutbox(env.t.app, consumers);
    expect(await counts(org)).toEqual(EXPECTED);
  });

  it("seeds each organization separately", async () => {
    const mine = (await env.admin.tariffs.categories.list({ includeInactive: true })).map((c) => c.id);
    const theirs = (await env.outsider().tariffs.categories.list({ includeInactive: true })).map((c) => c.id);
    expect(mine.length).toBe(6);
    expect(theirs.length).toBe(6);
    expect(mine.filter((id) => theirs.includes(id))).toEqual([]);
  });
});

// NF-31, K-04: Tariffs requires Accounts; Accounts works without Tariffs.
describe("licensing", () => {
  it("refuses to license Tariffs without Accounts", async () => {
    const org = await newOrganization();
    await expect(setEntitlements(env.t.app, org, ["tariffs"])).rejects.toThrow(/tariffs needs accounts/);
    await expect(setEntitlements(env.t.app, org, ["billing", "accounts"])).rejects.toThrow(/billing needs tariffs/);
  });

  it("leaves Accounts working, category and all, in an organization without Tariffs", async () => {
    const bare = env.bare();
    await expectCode(bare.tariffs.categories.list(), "NOT_FOUND", /not licensed/);
    const customer = await bare.accounts.customers.create({ type: "person", name: "No Tariffs Ltd" });
    const account = await bare.accounts.create({ customerId: customer.id, categoryId: randomUUID() });
    expect(account).toMatchObject({ commercialStatus: "NEW" });
  });

  it("keeps the data when Tariffs is unlicensed again, for when it returns", async () => {
    const org = await newOrganization();
    await setEntitlements(env.t.app, org, ["accounts", "tariffs"]);
    await drainOutbox(env.t.app, consumers);
    await setEntitlements(env.t.app, org, ["accounts"]);
    expect(await counts(org)).toEqual(EXPECTED);
  });
});
