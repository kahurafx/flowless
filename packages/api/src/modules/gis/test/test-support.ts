import { createDatabase, outboxEvent } from "@flowless/db";
import { startTestDatabase, tenants } from "@flowless/db/testing";
import { TRPCError } from "@trpc/server";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { setEntitlements } from "../../../kernel/entitlement-store";
import { createMemoryStorage } from "../../../kernel/storage";
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
 * The GIS tests' environment, after Majimap's gis/test/test-support.ts, on a private
 * database cloned from the test template. Four organizations:
 *  - A (tenants.a): GIS and Work Orders. admin (owner), engineer (gis_engineer), senior
 *    (supervisor, plus gis:edit: Majimap's senior technician), tech and tech2
 *    (technician) and viewer (member, plus gis:read).
 *  - B (tenants.b): GIS and Work Orders. One owner ("outsider").
 *  - C: GIS only, so work orders at level basic. One owner ("gisOnly").
 *  - D: no modules. One owner ("bare").
 * Callers use the RLS-bound app role through a small pool, so racing calls really race.
 */
export async function setupTestEnv() {
  const t = await startTestDatabase();
  const pool = createDatabase(t.urlFor("flowless_api"), { max: 4 });
  const memory = createMemoryStorage();
  const run = randomUUID().slice(0, 8);

  const orgC = randomUUID();
  const orgD = randomUUID();
  for (const [id, name] of [
    [orgC, "Org C"],
    [orgD, "Org D"],
  ] as const) {
    await t.admin.execute(sql`insert into auth.organization (id, name, slug, created_at) values (${id}, ${name}, ${`org-${id}`}, now())`);
  }
  await setEntitlements(t.app, tenants.a.id, ["gis", "work-orders"]);
  await setEntitlements(t.app, tenants.b.id, ["gis", "work-orders"]);
  await setEntitlements(t.app, orgC, ["gis"]);

  const admin = await addMember(t, tenants.a.id, "owner");
  const members = {
    admin,
    engineer: await addMember(t, tenants.a.id, "gis_engineer"),
    senior: await addMember(t, tenants.a.id, "supervisor"),
    tech: await addMember(t, tenants.a.id, "technician"),
    tech2: await addMember(t, tenants.a.id, "technician"),
    viewer: await addMember(t, tenants.a.id, "member"),
    outsider: await addMember(t, tenants.b.id, "owner"),
    gisOnly: await addMember(t, orgC, "owner"),
    bare: await addMember(t, orgD, "owner"),
  };
  const as = (m: Member) => createCaller({ db: pool.db, session: sessionOf(m), storage: memory.storage });
  await as(admin).access.grant({ userId: members.senior.userId, permission: "gis:edit" });
  await as(admin).access.grant({ userId: members.viewer.userId, permission: "gis:read" });

  const schemes = new Map<string, string>();
  const users = Object.fromEntries(Object.entries(members).map(([k, m]) => [k, m.userId])) as Record<keyof typeof members, string>;

  return {
    t,
    /** Owner connection: bypasses RLS, for seeding and checking raw state only. */
    db: t.admin,
    run,
    /** A fresh client-minted id (Majimap named them; Flowless ids are uuids). */
    id: () => randomUUID(),
    orgA: tenants.a.id,
    orgB: tenants.b.id,
    orgC,
    orgD,
    members,
    users,
    as,
    storage: memory.storage,
    putObject: memory.put,
    anonymous: () => createCaller({ db: pool.db, session: null, storage: memory.storage }),
    admin: () => as(members.admin),
    engineer: () => as(members.engineer),
    senior: () => as(members.senior),
    tech: () => as(members.tech),
    tech2: () => as(members.tech2),
    viewer: () => as(members.viewer),
    outsider: () => as(members.outsider),
    gisOnly: () => as(members.gisOnly),
    bare: () => as(members.bare),
    /** Announces, "uploads" and confirms a photo on a GIS asset. */
    async photo(m: Member, assetId: string) {
      const input = { id: randomUUID(), subjectKind: "gis_asset", subjectId: assetId, fileName: "p.jpg", mimeType: "image/jpeg" as const, sizeBytes: 1000 };
      const { file, upload } = await as(m).files.announce(input);
      memory.put(upload!.url.replace("memory://", ""), input.sizeBytes);
      return (await as(m).files.confirm({ id: file.id })).file!;
    },
    /** Outbox events of a type whose payload has `field` = `value`. */
    events(type: string, field: string, value: string) {
      return t.admin
        .select()
        .from(outboxEvent)
        .where(and(eq(outboxEvent.type, type), sql`${outboxEvent.payload}->>${field} = ${value}`));
    },
    /** A kernel DMA area to draw map data on. */
    async dmaArea(name = `DMA ${randomUUID().slice(0, 5)}`, m: Member = admin) {
      let parentId = schemes.get(m.organizationId);
      if (!parentId) {
        parentId = (await as(m).hierarchy.createArea({ level: "scheme", code: `S${randomUUID().slice(0, 8)}`, name: "Scheme" })).id;
        schemes.set(m.organizationId, parentId);
      }
      return as(m).hierarchy.createArea({ level: "dma", code: `D${randomUUID().slice(0, 8)}`, name, parentId });
    },
    close: async () => {
      await pool.close();
      await t.stop();
    },
  };
}

export type TestEnv = Awaited<ReturnType<typeof setupTestEnv>>;
