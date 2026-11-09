import { createDatabase } from "@flowless/db";
import { startTestDatabase, tenants } from "@flowless/db/testing";
import { TRPCError } from "@trpc/server";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { setEntitlements } from "../../../kernel/entitlement-store";
import { createCaller } from "../../../root";
import { addMember, sessionOf, type Member } from "../../../test-support";
import { addDays, todayIn } from "@flowless/shared-types";

/** Assert a call fails with a specific tRPC error code, and say what it did instead if it doesn't. */
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

/**
 * The Tariffs tests' environment, on a private database cloned from the test template.
 *  - A (tenants.a): Accounts and Tariffs. owner ("admin"), manager (manages tariffs),
 *    clerk (reads tariffs), cashier (no tariffs permission).
 *  - B (tenants.b): Accounts and Tariffs. One owner ("outsider").
 *  - C: Accounts only. One owner ("bare").
 * Callers use the RLS-bound app role through a small pool, so racing calls really race.
 */
export async function setupTariffsEnv() {
  const t = await startTestDatabase();
  const pool = createDatabase(t.urlFor("flowless_api"), { max: 8 });
  const orgC = randomUUID();
  await t.admin.execute(sql`insert into auth.organization (id, name, slug, created_at) values (${orgC}, 'Org C', ${`org-${orgC}`}, now())`);
  await setEntitlements(t.app, tenants.a.id, ["accounts", "tariffs"]);
  await setEntitlements(t.app, tenants.b.id, ["accounts", "tariffs"]);
  await setEntitlements(t.app, orgC, ["accounts"]);

  const members = {
    admin: await addMember(t, tenants.a.id, "owner"),
    manager: await addMember(t, tenants.a.id, "manager"),
    clerk: await addMember(t, tenants.a.id, "clerk"),
    cashier: await addMember(t, tenants.a.id, "cashier"),
    outsider: await addMember(t, tenants.b.id, "owner"),
    bare: await addMember(t, orgC, "owner"),
  };
  const as = (m: Member) => createCaller({ db: pool.db, session: sessionOf(m) });
  const admin = as(members.admin);
  /** The organization's date today (Africa/Nairobi unless a test changes it), and offsets from it. */
  const today = () => todayIn("Africa/Nairobi");
  const inDays = (days: number) => addDays(today(), days);

  return {
    t,
    pool,
    db: t.admin,
    orgA: tenants.a.id,
    orgB: tenants.b.id,
    orgC,
    members,
    as,
    admin,
    manager: () => as(members.manager),
    clerk: () => as(members.clerk),
    cashier: () => as(members.cashier),
    outsider: () => as(members.outsider),
    bare: () => as(members.bare),
    today,
    inDays,
    /** The audit entries about one subject, newest first. */
    audit: async (subjectId: string) => (await admin.audit.list({ subjectId, limit: 200 })).entries,
    /** The outbox events of a type for an organization, oldest first. */
    events: async (organizationId: string, type: string) =>
      (
        await t.admin.execute<{ payload: Record<string, unknown> }>(
          sql`select payload from kernel.outbox_event where organization_id = ${organizationId} and type = ${type} order by occurred_at, id`,
        )
      ).map((r) => r.payload),
  };
}

export type TariffsEnv = Awaited<ReturnType<typeof setupTariffsEnv>>;

/** Reference bands from docs/billing-engine.html (cents per unit), the top rate its placeholder. */
export const REFERENCE_BANDS = [
  { from: 0, to: 6, rate: 8250n },
  { from: 6, to: 20, rate: 9600n },
  { from: 20, to: 50, rate: 11000n },
  { from: 50, to: 100, rate: 13100n },
  { from: 100, to: 300, rate: 17250n },
  { from: 300, to: null, rate: 24000n },
];
export const increasingContent = (bands = REFERENCE_BANDS) => ({ type: "increasing_block" as const, bands });
export const uniformContent = (rate: bigint) => ({ type: "uniform" as const, rate });
