import { createDatabase } from "@flowless/db";
import { startTestDatabase, tenants } from "@flowless/db/testing";
import { TRPCError } from "@trpc/server";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { setEntitlements } from "../../../kernel/entitlement-store";
import { createCaller } from "../../../root";
import { addMember, sessionOf, type Member } from "../../../test-support";

export async function expectCode(promise: Promise<unknown>, code: TRPCError["code"], message?: RegExp) {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof TRPCError, `expected a TRPCError but got: ${String(err)}`);
    assert.equal(err.code, code, `${err.code}: ${err.message}`);
    if (message) assert.match(err.message, message);
    return;
  }
  assert.fail(`expected ${code} but the call succeeded`);
}

/** Reference bands from docs/billing-engine.html (minor units per unit). */
export const BANDS = [
  { from: 0, to: 6, rate: 8250n },
  { from: 6, to: 20, rate: 9600n },
  { from: 20, to: 50, rate: 11000n },
  { from: 50, to: 100, rate: 13100n },
  { from: 100, to: 300, rate: 17250n },
  { from: 300, to: null, rate: 24000n },
];
export const STANDING = 15_000n;
const SINCE = "2020-01-01";

/**
 * The Billing tests' environment on a private database.
 *  - A: Accounts, Tariffs and Billing. owner (admin), accountant (approves), clerk (reads), cashier (no billing).
 *  - B: the same, one owner. C: Accounts and Tariffs only (Billing unlicensed).
 * Tariffs are set up through the Tariffs API, effective from 2020 so any 2025 period prices.
 */
export async function setupBillingEnv(options: { metering?: boolean } = {}) {
  const t = await startTestDatabase();
  const pool = createDatabase(t.urlFor("flowless_api"), { max: 8 });
  const orgC = randomUUID();
  await t.admin.execute(sql`insert into auth.organization (id, name, slug, created_at) values (${orgC}, 'Org C', ${`org-${orgC}`}, now())`);
  await setEntitlements(t.app, tenants.a.id, options.metering ? ["accounts", "tariffs", "billing", "metering"] : ["accounts", "tariffs", "billing"]);
  await setEntitlements(t.app, tenants.b.id, ["accounts", "tariffs", "billing"]);
  await setEntitlements(t.app, orgC, ["accounts", "tariffs"]);
  const members = {
    admin: await addMember(t, tenants.a.id, "owner"),
    accountant: await addMember(t, tenants.a.id, "accountant"),
    clerk: await addMember(t, tenants.a.id, "clerk"),
    cashier: await addMember(t, tenants.a.id, "cashier"),
    outsider: await addMember(t, tenants.b.id, "owner"),
    bare: await addMember(t, orgC, "owner"),
  };
  const as = (m: Member) => createCaller({ db: pool.db, session: sessionOf(m) });
  const admin = as(members.admin);

  const tariff = await admin.tariffs.create({ name: "Domestic", type: "increasing_block", content: { type: "increasing_block", bands: BANDS } });
  await admin.tariffs.addVersion({ tariffId: tariff.id, content: { type: "increasing_block", bands: BANDS }, effectiveFrom: SINCE });
  const standing = await admin.tariffs.chargeItems.create({ code: "standing", name: "Standing charge", type: "recurring", amount: STANDING });
  await admin.tariffs.chargeItems.addAmountVersion({ chargeItemId: standing.id, amount: STANDING, effectiveFrom: SINCE });
  const category = await admin.tariffs.categories.create({ code: "domestic", name: "Domestic" });
  await admin.tariffs.categories.assignTariff({ categoryId: category.id, tariffId: tariff.id, standingChargeItemId: standing.id, effectiveFrom: SINCE });
  const invoiceType = await admin.tariffs.invoiceTypes.create({ code: "water_bill", name: "Water bill", appliesTo: "account", numbering: { prefix: "INV-", width: 6, start: 1 } });

  let n = 0;
  /** A fresh account id (opaque to Billing) and an idempotency key. */
  const newAccount = () => randomUUID();
  const key = (prefix = "key") => `${prefix}-${++n}-${randomUUID().slice(0, 8)}`;

  return {
    t,
    pool,
    orgA: tenants.a.id,
    orgB: tenants.b.id,
    orgC,
    members,
    as,
    admin,
    accountant: () => as(members.accountant),
    clerk: () => as(members.clerk),
    cashier: () => as(members.cashier),
    outsider: () => as(members.outsider),
    bare: () => as(members.bare),
    categoryId: category.id,
    invoiceTypeId: invoiceType.id,
    tariffId: tariff.id,
    newAccount,
    key,
    /** Input for a one-month actual bill after a baseline at the previous month. */
    usage: (accountId: string, over: Record<string, unknown> = {}) => ({
      idempotencyKey: key("bill"),
      accountId,
      categoryId: category.id,
      invoiceTypeId: invoiceType.id,
      period: "2025-02",
      reading: { dial: 110 },
      readings: [{ period: "2025-01", kind: "actual" as const, dial: 100 }],
      ...over,
    }),
    rows: async <T = Record<string, unknown>>(query: ReturnType<typeof sql>) => (await t.admin.execute(query)) as unknown as T[],
    events: async (organizationId: string, type: string) =>
      (
        await t.admin.execute<{ payload: Record<string, unknown> }>(
          sql`select payload from kernel.outbox_event where organization_id = ${organizationId} and type = ${type} order by occurred_at, id`,
        )
      ).map((r) => r.payload),
  };
}

export type BillingEnv = Awaited<ReturnType<typeof setupBillingEnv>>;
