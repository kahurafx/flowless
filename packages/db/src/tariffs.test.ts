import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Transaction } from "./client";
import { category, categoryAssignment, chargeItem, chargeItemAmount, invoiceType, invoiceTypeCounter, invoiceTypeLine, lateFeeRule, tariff, tariffVersion, tariffVersionLine } from "./schema";
import { withTenant } from "./tenant";
import { startTestDatabase, tenants, type TestDatabase } from "./testing";

/** Drizzle wraps driver errors; the Postgres error is the `cause`. */
const pgError = (pattern: RegExp) => ({ cause: { message: expect.stringMatching(pattern) } });

let t: TestDatabase;
const user = randomUUID();

beforeAll(async () => {
  t = await startTestDatabase();
});
afterAll(() => t?.stop());

const asA = <T>(fn: (tx: Transaction) => Promise<T>) => withTenant(t.app, tenants.a.id, fn);
const asB = <T>(fn: (tx: Transaction) => Promise<T>) => withTenant(t.app, tenants.b.id, fn);
const code = () => `c_${randomUUID().slice(0, 8).replace(/-/g, "")}`;

async function addTariff(tx: Transaction, organizationId: string, values: Partial<typeof tariff.$inferInsert> = {}) {
  const [row] = await tx
    .insert(tariff)
    .values({ organizationId, name: `Tariff ${randomUUID()}`, type: "uniform", createdByUserId: user, ...values })
    .returning();
  return row!;
}

async function addVersion(tx: Transaction, organizationId: string, tariffId: string, values: Partial<typeof tariffVersion.$inferInsert> = {}) {
  const [row] = await tx
    .insert(tariffVersion)
    .values({ organizationId, tariffId, versionNo: 1, effectiveFrom: "2026-01-01", createdByUserId: user, ...values })
    .returning();
  await tx.insert(tariffVersionLine).values({ organizationId, versionId: row!.id, position: 0, rate: 9500n });
  return row!;
}

async function addItem(tx: Transaction, organizationId: string, values: Partial<typeof chargeItem.$inferInsert> = {}) {
  const [row] = await tx
    .insert(chargeItem)
    .values({ organizationId, code: code(), name: "Item", type: "fee", ...values })
    .returning();
  return row!;
}

async function addType(tx: Transaction, organizationId: string, values: Partial<typeof invoiceType.$inferInsert> = {}) {
  const [row] = await tx
    .insert(invoiceType)
    .values({ organizationId, code: code(), name: "Type", appliesTo: "account", ...values })
    .returning();
  return row!;
}

// NF-01, T-01, T-07 to T-10: the tariffs schema isolates tenants and keeps its invariants in the database.
describe("tariffs schema", () => {
  it("hides one tenant's rows from another and fails closed with no tenant", async () => {
    const mine = await asA((tx) => addTariff(tx, tenants.a.id));
    await asA((tx) => addItem(tx, tenants.a.id));
    expect(await asB((tx) => tx.select().from(tariff))).toEqual([]);
    expect(await asB((tx) => tx.select().from(chargeItem))).toEqual([]);
    expect(await t.app.select().from(tariff)).toEqual([]);
    expect((await asA((tx) => tx.select().from(tariff))).map((r) => r.id)).toContain(mine.id);
  });

  it("refuses a row for another tenant (RLS check)", async () => {
    await expect(asA((tx) => addTariff(tx, tenants.b.id))).rejects.toMatchObject(pgError(/row-level security/));
    await expect(asA((tx) => addItem(tx, tenants.b.id))).rejects.toMatchObject(pgError(/row-level security/));
  });

  it("has row-level security on every table of the schema", async () => {
    const rows = await t.admin.execute<{ relname: string; relrowsecurity: boolean }>(
      sql`select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'tariffs' and c.relkind = 'r'`,
    );
    expect(rows.length).toBe(11);
    expect(rows.filter((r) => !r.relrowsecurity)).toEqual([]);
  });

  it("composite keys stop a row pointing at another tenant's record", async () => {
    const theirs = await asB((tx) => addTariff(tx, tenants.b.id));
    await expect(asA((tx) => addVersion(tx, tenants.a.id, theirs.id))).rejects.toMatchObject(pgError(/tariff_version_tariff_fk/));
    const theirItem = await asB((tx) => addItem(tx, tenants.b.id));
    const mine = await asA(async (tx) => (await tx.insert(category).values({ organizationId: tenants.a.id, code: code(), name: "Cat" }).returning())[0]!);
    await expect(
      asA((tx) => tx.insert(categoryAssignment).values({ organizationId: tenants.a.id, categoryId: mine.id, versionNo: 1, effectiveFrom: "2026-01-01", standingChargeItemId: theirItem.id, createdByUserId: user })),
    ).rejects.toMatchObject(pgError(/category_assignment_standing_fk/));
  });

  it("keeps codes unique per organization, not across them", async () => {
    const same = code();
    await asA((tx) => addItem(tx, tenants.a.id, { code: same }));
    await expect(asA((tx) => addItem(tx, tenants.a.id, { code: same }))).rejects.toMatchObject(pgError(/charge_item_code_unique/));
    await expect(asB((tx) => addItem(tx, tenants.b.id, { code: same }))).resolves.toBeTruthy();
    await expect(asA((tx) => addItem(tx, tenants.a.id, { code: "Bad Code" }))).rejects.toMatchObject(pgError(/charge_item_code_format/));
  });

  it("makes versions immutable: no UPDATE or DELETE for the app role (T-01, T-04)", async () => {
    const { v, item, cat } = await asA(async (tx) => {
      const tr = await addTariff(tx, tenants.a.id);
      const v = await addVersion(tx, tenants.a.id, tr.id);
      const item = await addItem(tx, tenants.a.id, { type: "fee" });
      await tx.insert(chargeItemAmount).values({ organizationId: tenants.a.id, chargeItemId: item.id, versionNo: 1, effectiveFrom: "2026-01-01", amount: 1000n, createdByUserId: user });
      const cat = (await tx.insert(category).values({ organizationId: tenants.a.id, code: code(), name: "Cat" }).returning())[0]!;
      await tx.insert(categoryAssignment).values({ organizationId: tenants.a.id, categoryId: cat.id, versionNo: 1, effectiveFrom: "2026-01-01", tariffId: tr.id, createdByUserId: user });
      return { v, item, cat };
    });
    const denied = pgError(/permission denied/);
    await expect(asA((tx) => tx.update(tariffVersion).set({ effectiveFrom: "2027-01-01" }).where(sql`id = ${v.id}`))).rejects.toMatchObject(denied);
    await expect(asA((tx) => tx.delete(tariffVersion).where(sql`id = ${v.id}`))).rejects.toMatchObject(denied);
    await expect(asA((tx) => tx.update(tariffVersionLine).set({ rate: 1n }).where(sql`version_id = ${v.id}`))).rejects.toMatchObject(denied);
    await expect(asA((tx) => tx.delete(tariffVersionLine).where(sql`version_id = ${v.id}`))).rejects.toMatchObject(denied);
    await expect(asA((tx) => tx.update(chargeItemAmount).set({ amount: 1n }).where(sql`charge_item_id = ${item.id}`))).rejects.toMatchObject(denied);
    await expect(asA((tx) => tx.delete(chargeItemAmount).where(sql`charge_item_id = ${item.id}`))).rejects.toMatchObject(denied);
    await expect(asA((tx) => tx.update(categoryAssignment).set({ tariffId: null }).where(sql`category_id = ${cat.id}`))).rejects.toMatchObject(denied);
    await expect(asA((tx) => tx.delete(categoryAssignment).where(sql`category_id = ${cat.id}`))).rejects.toMatchObject(denied);
    await expect(t.app.execute(sql`truncate tariffs.tariff_version cascade`)).rejects.toMatchObject(denied);
  });

  it("never deletes identities or the invoice counter, but replaces an invoice type's template and rule", async () => {
    const { tr, item, ty } = await asA(async (tx) => ({ tr: await addTariff(tx, tenants.a.id), item: await addItem(tx, tenants.a.id), ty: await addType(tx, tenants.a.id) }));
    const denied = pgError(/permission denied/);
    await expect(asA((tx) => tx.delete(tariff).where(sql`id = ${tr.id}`))).rejects.toMatchObject(denied);
    await expect(asA((tx) => tx.delete(chargeItem).where(sql`id = ${item.id}`))).rejects.toMatchObject(denied);
    await expect(asA((tx) => tx.delete(invoiceType).where(sql`id = ${ty.id}`))).rejects.toMatchObject(denied);
    await expect(asA((tx) => tx.delete(category))).rejects.toMatchObject(denied);
    await asA(async (tx) => {
      await tx.insert(invoiceTypeCounter).values({ organizationId: tenants.a.id, invoiceTypeId: ty.id, nextValue: 5 });
      await tx.insert(invoiceTypeLine).values({ organizationId: tenants.a.id, invoiceTypeId: ty.id, position: 0, chargeItemId: item.id });
      await tx.insert(lateFeeRule).values({ organizationId: tenants.a.id, invoiceTypeId: ty.id, triggerDays: 7, base: "overdue_balance", rateBp: 500, frequency: "once" });
    });
    await expect(asA((tx) => tx.delete(invoiceTypeCounter))).rejects.toMatchObject(denied);
    await expect(asA((tx) => tx.delete(invoiceTypeLine).where(sql`invoice_type_id = ${ty.id}`))).resolves.toBeTruthy();
    await expect(asA((tx) => tx.delete(lateFeeRule).where(sql`invoice_type_id = ${ty.id}`))).resolves.toBeTruthy();
  });

  it("refuses malformed content: negative rates, bad bands, a basis on a block tariff", async () => {
    const tr = await asA((tx) => addTariff(tx, tenants.a.id));
    const v = await asA((tx) => addVersion(tx, tenants.a.id, tr.id));
    const line = (values: Partial<typeof tariffVersionLine.$inferInsert>) =>
      asA((tx) => tx.insert(tariffVersionLine).values({ organizationId: tenants.a.id, versionId: v.id, position: 5, rate: 100n, ...values }));
    await expect(line({ rate: -1n })).rejects.toMatchObject(pgError(/tariff_version_line_rate_nonnegative/));
    await expect(line({ fromUnits: 10, toUnits: 10 })).rejects.toMatchObject(pgError(/tariff_version_line_band/));
    await expect(line({ fromUnits: null, toUnits: 5 })).rejects.toMatchObject(pgError(/tariff_version_line_bounds/));
    await expect(line({ position: 0 })).rejects.toMatchObject(pgError(/tariff_version_line_pk/));
    await expect(asA((tx) => addTariff(tx, tenants.a.id, { type: "uniform", flatBasis: "taps" }))).rejects.toMatchObject(pgError(/tariff_basis_only_flat/));
    await expect(asA((tx) => addTariff(tx, tenants.a.id, { name: tr.name.toUpperCase() }))).rejects.toMatchObject(pgError(/tariff_name_unique/));
    await expect(asA((tx) => addVersion(tx, tenants.a.id, tr.id, { versionNo: 1, effectiveFrom: "2026-02-01" }))).rejects.toMatchObject(pgError(/tariff_version_no_unique/));
  });

  it("allows a recurrence only on recurring items and a non-negative amount", async () => {
    await expect(asA((tx) => addItem(tx, tenants.a.id, { type: "fee", recurrence: "monthly" }))).rejects.toMatchObject(pgError(/charge_item_recurrence_only_recurring/));
    await expect(asA((tx) => addItem(tx, tenants.a.id, { type: "recurring" }))).rejects.toMatchObject(pgError(/charge_item_recurrence_only_recurring/));
    const item = await asA((tx) => addItem(tx, tenants.a.id, { type: "recurring", recurrence: "monthly" }));
    await expect(
      asA((tx) => tx.insert(chargeItemAmount).values({ organizationId: tenants.a.id, chargeItemId: item.id, versionNo: 1, effectiveFrom: "2026-01-01", amount: -1n, createdByUserId: user })),
    ).rejects.toMatchObject(pgError(/charge_item_amount_nonnegative/));
  });

  it("keeps the overdue policy and payment terms of an invoice type valid (T-09)", async () => {
    // An application's invoice never disconnects.
    await expect(asA((tx) => addType(tx, tenants.a.id, { appliesTo: "application", overdueAction: "disconnect" }))).rejects.toMatchObject(pgError(/invoice_type_overdue_fits/));
    await expect(asA((tx) => addType(tx, tenants.a.id, { appliesTo: "account", overdueAction: "cancel_application" }))).rejects.toMatchObject(pgError(/invoice_type_overdue_fits/));
    await expect(asA((tx) => addType(tx, tenants.a.id, { appliesTo: "application", overdueAction: "pause_application" }))).resolves.toBeTruthy();
    await expect(asA((tx) => addType(tx, tenants.a.id, { appliesTo: "account", overdueAction: "disconnect" }))).resolves.toBeTruthy();
    // Terms: each kind carries exactly its own parameters.
    await expect(asA((tx) => addType(tx, tenants.a.id, { termsKind: "minimum_deposit" }))).rejects.toMatchObject(pgError(/invoice_type_terms_shape/));
    await expect(asA((tx) => addType(tx, tenants.a.id, { termsKind: "minimum_deposit", minDepositBp: 2500, minDepositAmount: 100n }))).rejects.toMatchObject(pgError(/invoice_type_terms_shape/));
    await expect(asA((tx) => addType(tx, tenants.a.id, { termsKind: "minimum_deposit", minDepositBp: 2500 }))).resolves.toBeTruthy();
    await expect(asA((tx) => addType(tx, tenants.a.id, { termsKind: "minimum_deposit", minDepositAmount: 500_000n }))).resolves.toBeTruthy();
    await expect(asA((tx) => addType(tx, tenants.a.id, { termsKind: "installments", installmentCount: 3 }))).rejects.toMatchObject(pgError(/invoice_type_terms_shape/));
    await expect(asA((tx) => addType(tx, tenants.a.id, { termsKind: "installments", installmentCount: 3, installmentIntervalDays: 30 }))).resolves.toBeTruthy();
    await expect(asA((tx) => addType(tx, tenants.a.id, { termsKind: "full", installmentCount: 3 }))).rejects.toMatchObject(pgError(/invoice_type_terms_shape/));
  });

  it("requires a late-fee rule to have a rate or a flat amount, not both", async () => {
    const ty = await asA((tx) => addType(tx, tenants.a.id));
    const rule = (values: Partial<typeof lateFeeRule.$inferInsert>) =>
      asA((tx) => tx.insert(lateFeeRule).values({ organizationId: tenants.a.id, invoiceTypeId: ty.id, triggerDays: 7, base: "overdue_balance", frequency: "once", ...values }));
    await expect(rule({})).rejects.toMatchObject(pgError(/late_fee_rule_rate_xor_flat/));
    await expect(rule({ rateBp: 500, flatAmount: 100n })).rejects.toMatchObject(pgError(/late_fee_rule_rate_xor_flat/));
    await expect(rule({ rateBp: 500, cap: 0n })).rejects.toMatchObject(pgError(/late_fee_rule_cap_positive/));
    await expect(rule({ flatAmount: 100_00n, cap: 500_00n })).resolves.toBeTruthy();
    await expect(rule({ rateBp: 500 })).rejects.toMatchObject(pgError(/late_fee_rule_type_unique/));
  });
});
