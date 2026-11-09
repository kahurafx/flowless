import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Transaction } from "./client";
import { account, accountCommand, activationCheck, customer } from "./schema";
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

async function newAccount(tx: Transaction, organizationId: string) {
  const [c] = await tx.insert(customer).values({ organizationId, type: "person", name: "Wanjiru Kamau", createdByUserId: user }).returning();
  const [a] = await tx
    .insert(account)
    .values({ organizationId, number: `N-${randomUUID().slice(0, 8)}`, customerId: c!.id, serviceStatusReason: "New account", createdByUserId: user })
    .returning();
  return a!;
}

/** A command row describing NEW/DISCONNECTED to PENDING_PAYMENT/DISCONNECTED. */
const pending = (organizationId: string, accountId: string, over: Partial<typeof accountCommand.$inferInsert> = {}): typeof accountCommand.$inferInsert => ({
  organizationId,
  accountId,
  kind: "mark_pending_payment",
  fromCommercialStatus: "NEW",
  toCommercialStatus: "PENDING_PAYMENT",
  fromServiceStatus: "DISCONNECTED",
  toServiceStatus: "DISCONNECTED",
  serviceReason: "New account",
  reason: "Invoice issued",
  actorUserId: user,
  source: "api",
  ...over,
});

// C-03, C-06: the account lifecycle's tables keep their guarantees in the database.
describe("accounts lifecycle schema", () => {
  it("refuses any change to the status columns that skips the command log", async () => {
    const a = await asA((tx) => newAccount(tx, tenants.a.id));
    const direct = (set: Partial<typeof account.$inferInsert>) => asA((tx) => tx.update(account).set(set).where(eq(account.id, a.id)));
    await expect(direct({ commercialStatus: "ACTIVE" })).rejects.toMatchObject(pgError(/status changes only through a logged command/));
    await expect(direct({ serviceStatus: "CONNECTED", serviceStatusReason: null })).rejects.toBeDefined();
    await expect(direct({ serviceStatusReason: "Edited by hand" })).rejects.toMatchObject(pgError(/logged command/));
    await expect(direct({ statusCommandId: randomUUID() })).rejects.toMatchObject(pgError(/logged command/));
    // Other columns are not guarded.
    await expect(direct({ categoryId: randomUUID() })).resolves.toBeDefined();
    expect((await asA((tx) => tx.select().from(account).where(eq(account.id, a.id))))[0]).toMatchObject({ commercialStatus: "NEW", statusCommandId: null });
    // Not even the admin role gets round it.
    await expect(t.admin.update(account).set({ commercialStatus: "DORMANT" }).where(eq(account.id, a.id))).rejects.toMatchObject(pgError(/logged command/));
  });

  it("allows the change when a command of this account describes exactly it", async () => {
    const a = await asA((tx) => newAccount(tx, tenants.a.id));
    const moved = await asA(async (tx) => {
      const [cmd] = await tx.insert(accountCommand).values(pending(tenants.a.id, a.id)).returning();
      const [row] = await tx
        .update(account)
        .set({ commercialStatus: "PENDING_PAYMENT", statusCommandId: cmd!.id })
        .where(eq(account.id, a.id))
        .returning();
      return row!;
    });
    expect(moved).toMatchObject({ commercialStatus: "PENDING_PAYMENT" });
  });

  it("refuses a command that describes a different change, another account's command, and a reused one", async () => {
    const a = await asA((tx) => newAccount(tx, tenants.a.id));
    const other = await asA((tx) => newAccount(tx, tenants.a.id));
    const set = (id: string, to: "PENDING_PAYMENT" | "ACTIVE", commandId: string) =>
      asA((tx) => tx.update(account).set({ commercialStatus: to, statusCommandId: commandId }).where(eq(account.id, id)));
    const [wrongTarget] = await asA((tx) => tx.insert(accountCommand).values(pending(tenants.a.id, a.id)).returning());
    await expect(set(a.id, "ACTIVE", wrongTarget!.id)).rejects.toMatchObject(pgError(/logged command/));
    const [elsewhere] = await asA((tx) => tx.insert(accountCommand).values(pending(tenants.a.id, other.id)).returning());
    await expect(set(a.id, "PENDING_PAYMENT", elsewhere!.id)).rejects.toMatchObject(pgError(/logged command/));
    // From-state must be the row being replaced.
    const [stale] = await asA((tx) => tx.insert(accountCommand).values(pending(tenants.a.id, a.id, { fromCommercialStatus: "ACTIVE" })).returning());
    await expect(set(a.id, "PENDING_PAYMENT", stale!.id)).rejects.toMatchObject(pgError(/logged command/));
    // A command cannot be used twice for the same status.
    await set(a.id, "PENDING_PAYMENT", wrongTarget!.id);
    await expect(
      asA((tx) => tx.update(account).set({ serviceStatusReason: "again" }).where(eq(account.id, a.id))),
    ).rejects.toMatchObject(pgError(/logged command/));
  });

  it("keeps a NEW, PENDING_PAYMENT or TERMINATED account from being connected", async () => {
    const a = await asA((tx) => newAccount(tx, tenants.a.id));
    await expect(
      t.admin.execute(sql`alter table accounts.account disable trigger account_status_guard`).then(() =>
        t.admin.update(account).set({ serviceStatus: "CONNECTED", serviceStatusReason: null }).where(eq(account.id, a.id)),
      ),
    ).rejects.toMatchObject(pgError(/account_service_needs_live_status/));
    await t.admin.execute(sql`alter table accounts.account enable trigger account_status_guard`);
  });

  it("checks a command's statuses, reason, disconnected reason and actor", async () => {
    const a = await asA((tx) => newAccount(tx, tenants.a.id));
    const add = (over: Partial<typeof accountCommand.$inferInsert>) => asA((tx) => tx.insert(accountCommand).values(pending(tenants.a.id, a.id, over)));
    await expect(add({ kind: "cancel" as never })).rejects.toMatchObject(pgError(/account_command_kind_valid/));
    await expect(add({ toCommercialStatus: "GONE" as never })).rejects.toMatchObject(pgError(/account_command_to_commercial_valid/));
    await expect(add({ reason: "   " })).rejects.toMatchObject(pgError(/account_command_reason_present/));
    await expect(add({ serviceReason: null })).rejects.toMatchObject(pgError(/account_command_disconnected_has_reason/));
    await expect(add({ actorUserId: null })).rejects.toMatchObject(pgError(/account_command_actor_present/));
    await expect(add({ actorUserId: null, source: "system" })).resolves.toBeDefined();
  });

  it("never updates, deletes or truncates the command log or the checklist", async () => {
    const a = await asA((tx) => newAccount(tx, tenants.a.id));
    const [cmd] = await asA((tx) => tx.insert(accountCommand).values(pending(tenants.a.id, a.id)).returning());
    const [tick] = await asA((tx) =>
      tx.insert(activationCheck).values({ organizationId: tenants.a.id, accountId: a.id, gateKey: "meter_installed", action: "tick", byUserId: user }).returning(),
    );
    await expect(asA((tx) => tx.update(accountCommand).set({ reason: "Edited" }).where(eq(accountCommand.id, cmd!.id)))).rejects.toMatchObject(pgError(/permission denied/));
    await expect(asA((tx) => tx.delete(accountCommand).where(eq(accountCommand.id, cmd!.id)))).rejects.toMatchObject(pgError(/permission denied/));
    await expect(asA((tx) => tx.execute(sql`truncate accounts.account_command`))).rejects.toMatchObject(pgError(/permission denied/));
    await expect(asA((tx) => tx.update(activationCheck).set({ action: "untick" }).where(eq(activationCheck.id, tick!.id)))).rejects.toMatchObject(pgError(/permission denied/));
    await expect(asA((tx) => tx.delete(activationCheck).where(eq(activationCheck.id, tick!.id)))).rejects.toMatchObject(pgError(/permission denied/));
    await expect(asA((tx) => tx.execute(sql`truncate accounts.activation_check`))).rejects.toMatchObject(pgError(/permission denied/));
  });

  it("orders the checklist by seq and checks the gate key shape", async () => {
    const a = await asA((tx) => newAccount(tx, tenants.a.id));
    const rows = await asA(async (tx) => {
      const base = { organizationId: tenants.a.id, accountId: a.id, gateKey: "site_visit", byUserId: user };
      await tx.insert(activationCheck).values({ ...base, action: "tick" });
      await tx.insert(activationCheck).values({ ...base, action: "untick", note: "Wrong plot" });
      return tx.select().from(activationCheck).where(eq(activationCheck.accountId, a.id)).orderBy(activationCheck.seq);
    });
    expect(rows.map((r) => r.action)).toEqual(["tick", "untick"]);
    expect(rows[0]!.seq).toBeLessThan(rows[1]!.seq);
    await expect(
      asA((tx) => tx.insert(activationCheck).values({ organizationId: tenants.a.id, accountId: a.id, gateKey: "Bad Key", action: "tick", byUserId: user })),
    ).rejects.toMatchObject(pgError(/activation_check_gate_key_valid/));
  });

  it("isolates both tables by tenant and by composite key", async () => {
    const a = await asA((tx) => newAccount(tx, tenants.a.id));
    await asA((tx) => tx.insert(accountCommand).values(pending(tenants.a.id, a.id)));
    await asA((tx) => tx.insert(activationCheck).values({ organizationId: tenants.a.id, accountId: a.id, gateKey: "initial_reading", action: "tick", byUserId: user }));
    expect(await asB((tx) => tx.select().from(accountCommand))).toEqual([]);
    expect(await asB((tx) => tx.select().from(activationCheck))).toEqual([]);
    expect(await t.app.select().from(accountCommand)).toEqual([]);
    await expect(asB((tx) => tx.insert(accountCommand).values(pending(tenants.b.id, a.id)))).rejects.toMatchObject(pgError(/account_command_account_fk/));
    await expect(asB((tx) => tx.insert(accountCommand).values(pending(tenants.a.id, a.id)))).rejects.toMatchObject(pgError(/row-level security/));
  });

  it("lists organizations for the stale sweep without exposing accounts, only to licensed ones", async () => {
    await asA((tx) => newAccount(tx, tenants.a.id));
    const find = () => t.app.execute<{ organization_id: string }>(sql`select * from accounts.sweep_organizations(null::uuid, 100)`);
    expect((await find()).map((r) => r.organization_id)).not.toContain(tenants.a.id);
    await t.admin.execute(sql`insert into kernel.organization_module (organization_id, module) values (${tenants.a.id}, 'accounts') on conflict do nothing`);
    expect((await find()).map((r) => r.organization_id)).toContain(tenants.a.id);
    expect((await find()).map((r) => r.organization_id)).not.toContain(tenants.b.id);
    expect(await t.app.execute(sql`select * from accounts.sweep_organizations(${tenants.a.id}::uuid, 100)`).then((r) => r.map((x) => x.organization_id))).not.toContain(tenants.a.id);
  });
});
