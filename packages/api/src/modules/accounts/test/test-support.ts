import { createDatabase } from "@flowless/db";
import { startTestDatabase, tenants } from "@flowless/db/testing";
import { TRPCError } from "@trpc/server";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { setEntitlements } from "../../../kernel/entitlement-store";
import { createCaller } from "../../../root";
import { addMember, sessionOf, type Member } from "../../../test-support";

/** Assert a call fails with a specific tRPC error code, and say what it did instead if it doesn't. */
export async function expectCode(promise: Promise<unknown>, code: TRPCError["code"]) {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof TRPCError, `expected a TRPCError but got: ${String(err)}`);
    assert.equal(err.code, code, `${err.code}: ${err.message}`);
    return;
  }
  assert.fail(`expected ${code} but the call succeeded`);
}

/**
 * The Accounts tests' environment, on a private database cloned from the test template.
 *  - A (tenants.a): Accounts. owner ("admin"), clerk, cashier (read only), supervisor.
 *  - B (tenants.b): Accounts. One owner ("outsider").
 *  - C: no modules. One owner ("bare").
 * Callers use the RLS-bound app role through a small pool, so racing calls really race.
 * Tenant A has a scheme > zone > DMA chain, a second zone, and two routes.
 */
export async function setupAccountsEnv() {
  const t = await startTestDatabase();
  const pool = createDatabase(t.urlFor("flowless_api"), { max: 8 });
  const orgC = randomUUID();
  await t.admin.execute(sql`insert into auth.organization (id, name, slug, created_at) values (${orgC}, 'Org C', ${`org-${orgC}`}, now())`);
  await setEntitlements(t.app, tenants.a.id, ["accounts"]);
  await setEntitlements(t.app, tenants.b.id, ["accounts"]);

  const members = {
    admin: await addMember(t, tenants.a.id, "owner"),
    clerk: await addMember(t, tenants.a.id, "clerk"),
    cashier: await addMember(t, tenants.a.id, "cashier"),
    supervisor: await addMember(t, tenants.a.id, "supervisor"),
    outsider: await addMember(t, tenants.b.id, "owner"),
    bare: await addMember(t, orgC, "owner"),
  };
  const as = (m: Member) => createCaller({ db: pool.db, session: sessionOf(m) });
  const admin = as(members.admin);

  const scheme = await admin.hierarchy.createArea({ level: "scheme", code: "KW", name: "Kahawa West" });
  const zone = await admin.hierarchy.createArea({ level: "zone", code: "KW-1", name: "Kahawa West zone 1", parentId: scheme.id });
  const otherZone = await admin.hierarchy.createArea({ level: "zone", code: "KW-2", name: "Kahawa West zone 2", parentId: scheme.id });
  const dma = await admin.hierarchy.createArea({ level: "dma", code: "KW-1-D1", name: "Kahawa West DMA 1", parentId: zone.id });
  const otherScheme = await admin.hierarchy.createArea({ level: "scheme", code: "RU", name: "Ruiru" });
  const route = await admin.hierarchy.createRoute({ code: "R-1", name: "Route 1", areaId: zone.id });
  const otherRoute = await admin.hierarchy.createRoute({ code: "R-2", name: "Route 2", areaId: otherScheme.id });

  return {
    t,
    db: t.admin,
    orgA: tenants.a.id,
    orgB: tenants.b.id,
    orgC,
    members,
    users: Object.fromEntries(Object.entries(members).map(([k, m]) => [k, m.userId])) as Record<keyof typeof members, string>,
    as,
    admin,
    clerk: () => as(members.clerk),
    cashier: () => as(members.cashier),
    supervisor: () => as(members.supervisor),
    outsider: () => as(members.outsider),
    bare: () => as(members.bare),
    areas: { scheme: scheme.id, zone: zone.id, otherZone: otherZone.id, dma: dma.id, otherScheme: otherScheme.id },
    routes: { route: route.id, otherRoute: otherRoute.id },
    /** The audit entries about one subject, newest first. */
    audit: async (subjectId: string) => (await admin.audit.list({ subjectId, limit: 200 })).entries,
    /** A person with a real phone, to keep tests short. */
    person: (caller: ReturnType<typeof as>, name = "Wanjiru Kamau", extra: Record<string, unknown> = {}) =>
      caller.accounts.customers.create({ type: "person", name, ...extra }),
  };
}

export type AccountsEnv = Awaited<ReturnType<typeof setupAccountsEnv>>;
