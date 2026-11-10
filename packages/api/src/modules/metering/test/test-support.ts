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

/** 08:00 UTC, `n` (at least 1) days ago: always in the past, whatever the clock says. */
export const ago = (n: number) => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - n, 8, 0, 0));
};

/**
 * The Metering tests' environment on a private database.
 *  - A: Accounts and Metering. owner (admin), technician (capture), supervisor (approve, manage meters), clerk, cashier (no readings), a limited technician.
 *  - B: the same, one owner. C: Accounts only (Metering unlicensed).
 */
export async function setupMeteringEnv() {
  const t = await startTestDatabase();
  const pool = createDatabase(t.urlFor("flowless_api"), { max: 8 });
  const orgC = randomUUID();
  await t.admin.execute(sql`insert into auth.organization (id, name, slug, created_at) values (${orgC}, 'Org C', ${`org-${orgC}`}, now())`);
  await setEntitlements(t.app, tenants.a.id, ["accounts", "metering"]);
  await setEntitlements(t.app, tenants.b.id, ["accounts", "metering"]);
  await setEntitlements(t.app, orgC, ["accounts"]);
  const members = {
    admin: await addMember(t, tenants.a.id, "owner"),
    technician: await addMember(t, tenants.a.id, "technician"),
    supervisor: await addMember(t, tenants.a.id, "supervisor"),
    clerk: await addMember(t, tenants.a.id, "clerk"),
    cashier: await addMember(t, tenants.a.id, "cashier"),
    limited: await addMember(t, tenants.a.id, "technician"),
    outsider: await addMember(t, tenants.b.id, "owner"),
    bare: await addMember(t, orgC, "owner"),
  };
  const as = (m: Member) => createCaller({ db: pool.db, session: sessionOf(m) });
  const admin = as(members.admin);

  const scheme = await admin.hierarchy.createArea({ level: "scheme", code: "S1", name: "Scheme" });
  const route = await admin.hierarchy.createRoute({ code: "R1", name: "Route 1" });
  const otherRoute = await admin.hierarchy.createRoute({ code: "R2", name: "Route 2" });
  await admin.access.setScope({ userId: members.limited.userId, areaIds: [], routeIds: [otherRoute.id] });

  /** A customer, account and service point on route 1 (the limited technician covers only route 2). */
  async function newServicePoint(routeId = route.id) {
    const customer = await admin.accounts.customers.create({ type: "person", name: `Customer ${randomUUID().slice(0, 6)}` });
    const account = await admin.accounts.create({ customerId: customer.id });
    const sp = await admin.accounts.servicePoints.create({ accountId: account.id, address: "Plot 1", schemeId: scheme.id, routeId });
    return { accountId: account.id, servicePointId: sp.id };
  }

  let n = 0;
  /** A registered meter (5-digit dial) in stock. */
  const newMeter = async (dialDigits = 5) => (await admin.metering.meters.register({ serial: `M-${++n}-${randomUUID().slice(0, 6)}`, dialDigits })).meter;
  /** A meter installed on a fresh service point 100 days ago with an initial reading. */
  async function installedMeter(initial = 100, routeId = route.id, dialDigits = 5) {
    const m = await newMeter(dialDigits);
    const sp = await newServicePoint(routeId);
    const installed = await admin.metering.installations.install({ meterId: m.id, servicePointId: sp.servicePointId, installedAt: ago(100), initialReading: { value: initial } });
    return { meter: m, ...sp, installationId: installed.installationId, initialReading: installed.initialReading! };
  }

  return {
    t,
    pool,
    orgA: tenants.a.id,
    orgB: tenants.b.id,
    orgC,
    members,
    as,
    admin,
    technician: () => as(members.technician),
    supervisor: () => as(members.supervisor),
    clerk: () => as(members.clerk),
    cashier: () => as(members.cashier),
    limited: () => as(members.limited),
    outsider: () => as(members.outsider),
    bare: () => as(members.bare),
    routes: { route, otherRoute },
    newServicePoint,
    newMeter,
    installedMeter,
    id: () => randomUUID(),
  };
}
export type MeteringEnv = Awaited<ReturnType<typeof setupMeteringEnv>>;
