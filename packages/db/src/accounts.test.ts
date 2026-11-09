import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Transaction } from "./client";
import { account, accountCounter, area, customer, customerContact, servicePoint } from "./schema";
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

async function addCustomer(tx: Transaction, organizationId: string, values: Partial<typeof customer.$inferInsert> = {}) {
  const [row] = await tx
    .insert(customer)
    .values({ organizationId, type: "person", name: "Wanjiru Kamau", createdByUserId: user, ...values })
    .returning();
  return row!;
}

async function addAccount(tx: Transaction, organizationId: string, customerId: string, values: Partial<typeof account.$inferInsert> = {}) {
  const [row] = await tx
    .insert(account)
    .values({
      organizationId,
      number: `N-${randomUUID().slice(0, 8)}`,
      customerId,
      serviceStatusReason: "New account",
      createdByUserId: user,
      ...values,
    })
    .returning();
  return row!;
}

// NF-01, C-01, C-02: the accounts schema isolates tenants and keeps its invariants in the database.
describe("accounts schema", () => {
  it("hides one tenant's rows from another and fails closed with no tenant", async () => {
    const mine = await asA(async (tx) => {
      const c = await addCustomer(tx, tenants.a.id);
      await addAccount(tx, tenants.a.id, c.id);
      return c.id;
    });
    expect(await asB((tx) => tx.select().from(customer))).toEqual([]);
    expect(await asB((tx) => tx.select().from(account))).toEqual([]);
    expect(await t.app.select().from(customer)).toEqual([]);
    expect((await asA((tx) => tx.select().from(customer))).map((c) => c.id)).toContain(mine);
  });

  it("refuses a row for another tenant (RLS check)", async () => {
    await expect(asA((tx) => addCustomer(tx, tenants.b.id))).rejects.toMatchObject(pgError(/row-level security/));
  });

  it("composite keys stop an account pointing at another tenant's customer", async () => {
    const theirs = await asB((tx) => addCustomer(tx, tenants.b.id));
    await expect(asA((tx) => addAccount(tx, tenants.a.id, theirs.id))).rejects.toMatchObject(pgError(/account_customer_fk/));
    const otherParent = await asB(async (tx) => addAccount(tx, tenants.b.id, theirs.id));
    const mine = await asA((tx) => addCustomer(tx, tenants.a.id));
    await expect(asA((tx) => addAccount(tx, tenants.a.id, mine.id, { parentAccountId: otherParent.id }))).rejects.toMatchObject(pgError(/account_parent_fk/));
  });

  it("keeps account numbers unique per organization, not across them", async () => {
    const number = `UNIQ-${randomUUID().slice(0, 6)}`;
    await asA(async (tx) => addAccount(tx, tenants.a.id, (await addCustomer(tx, tenants.a.id)).id, { number }));
    await expect(asA(async (tx) => addAccount(tx, tenants.a.id, (await addCustomer(tx, tenants.a.id)).id, { number }))).rejects.toMatchObject(
      pgError(/account_number_unique/),
    );
    await expect(asB(async (tx) => addAccount(tx, tenants.b.id, (await addCustomer(tx, tenants.b.id)).id, { number }))).resolves.toBeTruthy();
  });

  it("checks statuses, the disconnection reason and the person/organization identifiers", async () => {
    const c = await asA((tx) => addCustomer(tx, tenants.a.id));
    await expect(asA((tx) => addAccount(tx, tenants.a.id, c.id, { commercialStatus: "BOGUS" as never }))).rejects.toMatchObject(pgError(/account_commercial_status_valid/));
    await expect(asA((tx) => addAccount(tx, tenants.a.id, c.id, { serviceStatusReason: null }))).rejects.toMatchObject(pgError(/account_disconnected_has_reason/));
    await expect(asA((tx) => addAccount(tx, tenants.a.id, c.id, { serviceStatus: "CONNECTED", serviceStatusReason: null }))).resolves.toBeTruthy();
    await expect(asA((tx) => addCustomer(tx, tenants.a.id, { type: "organization", nationalId: "123" }))).rejects.toMatchObject(pgError(/customer_national_id_person/));
    await expect(asA((tx) => addCustomer(tx, tenants.a.id, { type: "person", registrationNumber: "PVT-1" }))).rejects.toMatchObject(pgError(/customer_registration_organization/));
    await expect(asA((tx) => addCustomer(tx, tenants.a.id, { name: "   " }))).rejects.toMatchObject(pgError(/customer_name_present/));
  });

  it("gives each child one letter slot under its parent", async () => {
    await asA(async (tx) => {
      const c = await addCustomer(tx, tenants.a.id);
      const parent = await addAccount(tx, tenants.a.id, c.id);
      await addAccount(tx, tenants.a.id, c.id, { parentAccountId: parent.id, suffixIndex: 1 });
      await expect(
        tx.transaction((inner) => addAccount(inner, tenants.a.id, c.id, { parentAccountId: parent.id, suffixIndex: 1 })),
      ).rejects.toMatchObject(pgError(/account_suffix_unique/));
    });
    const c = await asA((tx) => addCustomer(tx, tenants.a.id));
    await expect(asA((tx) => addAccount(tx, tenants.a.id, c.id, { suffixIndex: 1 }))).rejects.toMatchObject(pgError(/account_suffix_needs_parent/));
  });

  it("allows one primary contact per customer and channel, and no primary placeholder", async () => {
    await asA(async (tx) => {
      const c = await addCustomer(tx, tenants.a.id);
      const contact = (values: Partial<typeof customerContact.$inferInsert>) =>
        tx.transaction((inner) =>
          inner.insert(customerContact).values({ organizationId: tenants.a.id, customerId: c.id, channel: "phone", value: "0712345678", normalized: "254712345678", createdByUserId: user, ...values }),
        );
      await contact({ isPrimary: true });
      await expect(contact({ isPrimary: true })).rejects.toMatchObject(pgError(/customer_contact_primary_unique/));
      await expect(contact({ channel: "email", value: "a@b.test", normalized: "a@b.test", isPrimary: true })).resolves.toBeTruthy();
      await expect(contact({ isPlaceholder: true, normalized: null, isPrimary: true })).rejects.toMatchObject(pgError(/customer_contact_placeholder_phone/));
      await expect(contact({ normalized: null })).rejects.toMatchObject(pgError(/customer_contact_normalized_present/));
      await expect(contact({ isPlaceholder: true, normalized: null, value: "25400000000" })).resolves.toBeTruthy();
    });
  });

  it("is never deleted from, except contacts; the counter only moves forward", async () => {
    const { c, a, sp, contactId } = await asA(async (tx) => {
      const c = await addCustomer(tx, tenants.a.id);
      const a = await addAccount(tx, tenants.a.id, c.id);
      const [sp] = await tx.insert(servicePoint).values({ organizationId: tenants.a.id, accountId: a.id, address: "Plot 4", createdByUserId: user }).returning();
      const [contact] = await tx
        .insert(customerContact)
        .values({ organizationId: tenants.a.id, customerId: c.id, channel: "email", value: "x@y.test", normalized: "x@y.test", createdByUserId: user })
        .returning();
      await tx.insert(accountCounter).values({ organizationId: tenants.a.id, scope: `test-${a.id}`, nextValue: 5 });
      return { c, a, sp: sp!, contactId: contact!.id };
    });
    for (const table of ["customer", "account", "service_point"]) {
      const id = { customer: c.id, account: a.id, service_point: sp.id }[table]!;
      await expect(asA((tx) => tx.execute(sql`delete from ${sql.identifier("accounts")}.${sql.identifier(table)} where id = ${id}`))).rejects.toMatchObject(pgError(/permission denied/));
    }
    await expect(asA((tx) => tx.execute(sql`delete from accounts.account_counter where scope = ${`test-${a.id}`}`))).rejects.toMatchObject(pgError(/permission denied/));
    await expect(asA((tx) => tx.execute(sql`truncate accounts.customer_contact`))).rejects.toMatchObject(pgError(/permission denied/));
    await expect(asA((tx) => tx.execute(sql`delete from accounts.customer_contact where id = ${contactId}`))).resolves.toBeTruthy();
  });

  it("holds a service point's place as composite keys to the kernel and takes a PostGIS point", async () => {
    const theirArea = await asB(async (tx) => {
      const [row] = await tx.insert(area).values({ organizationId: tenants.b.id, level: "scheme", code: `S${randomUUID().slice(0, 5)}`, name: "B scheme" }).returning();
      return row!;
    });
    const a = await asA(async (tx) => addAccount(tx, tenants.a.id, (await addCustomer(tx, tenants.a.id)).id));
    await expect(
      asA((tx) => tx.insert(servicePoint).values({ organizationId: tenants.a.id, accountId: a.id, address: "Plot 5", schemeId: theirArea.id, createdByUserId: user })),
    ).rejects.toMatchObject(pgError(/service_point_scheme_fk/));
    const [row] = await asA((tx) =>
      tx.insert(servicePoint).values({ organizationId: tenants.a.id, accountId: a.id, address: "Plot 6", location: { lat: -1.2195, lng: 36.8869 }, createdByUserId: user }).returning(),
    );
    expect(row!.location).toEqual({ lat: -1.2195, lng: 36.8869 });
    expect(row!.connectionStatus).toBe("PLANNED");
    await expect(
      asA((tx) => tx.insert(servicePoint).values({ organizationId: tenants.a.id, accountId: a.id, address: "  ", createdByUserId: user })),
    ).rejects.toMatchObject(pgError(/service_point_address_present/));
  });

  it("has a GiST index on the location, like every geometry column", async () => {
    const rows = await t.admin.execute<{ indexdef: string }>(
      sql`select indexdef from pg_indexes where schemaname = 'accounts' and tablename = 'service_point' and indexname = 'service_point_location_gist'`,
    );
    expect(rows[0]?.indexdef).toMatch(/USING gist/i);
  });
});
