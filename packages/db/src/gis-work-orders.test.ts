import { randomUUID } from "node:crypto";
import { STRUCTURE_ATTACHMENT_RULES, type NodeType, type StructureType } from "@flowless/shared-types";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Transaction } from "./client";
import type { LatLng } from "./geometry";
import {
  area,
  asset,
  conditionLog,
  crew,
  crewMember,
  dma,
  dmaBoundaryValve,
  node,
  pipe,
  structure,
  structureAttachmentRule,
  tier,
  workOrder,
  workOrderEvent,
} from "./schema";
import { withTenant } from "./tenant";
import { startTestDatabase, tenants, type TestDatabase } from "./testing";

/** Drizzle wraps driver errors; the Postgres error is the `cause`. */
const pgError = (pattern: RegExp) => ({ cause: { message: expect.stringMatching(pattern) } });

let t: TestDatabase;
const userA = randomUUID();

beforeAll(async () => {
  t = await startTestDatabase();
  await t.admin.execute(sql`insert into auth.user (id, name, email) values (${userA}, 'Tech A', ${`${userA}@example.test`})`);
  await t.admin.execute(
    sql`insert into auth.member (organization_id, user_id, role, created_at) values (${tenants.a.id}, ${userA}, 'technician', now())`,
  );
});
afterAll(() => t?.stop());

const asA = <T>(fn: (tx: Transaction) => Promise<T>) => withTenant(t.app, tenants.a.id, fn);
const asB = <T>(fn: (tx: Transaction) => Promise<T>) => withTenant(t.app, tenants.b.id, fn);

/** A new GIS asset identity for the current tenant. */
async function newAsset(tx: Transaction, organizationId: string, kind: "node" | "pipe" | "structure" | "service_connection") {
  const [row] = await tx.insert(asset).values({ organizationId, kind, createdByUserId: userA }).returning({ id: asset.id });
  return row!.id;
}

async function addNode(tx: Transaction, organizationId: string, values: { type: NodeType; location?: LatLng; structureId?: string; branch?: string }) {
  const id = await newAsset(tx, organizationId, "node");
  await tx.insert(node).values({
    id,
    organizationId,
    type: values.type,
    name: `${values.type} ${id.slice(0, 4)}`,
    location: values.location ?? { lat: -1.2195, lng: 36.8869 },
    structureId: values.structureId,
    branch: values.branch,
    createdByUserId: userA,
  });
  return id;
}

async function addStructure(tx: Transaction, organizationId: string, type: StructureType, branch?: string) {
  const id = await newAsset(tx, organizationId, "structure");
  await tx.insert(structure).values({
    id,
    organizationId,
    type,
    name: `${type} ${id.slice(0, 4)}`,
    location: { lat: -1.2196, lng: 36.887 },
    branch,
    createdByUserId: userA,
  });
  return id;
}

async function seedRules(tx: Transaction, organizationId: string) {
  const rows = (Object.entries(STRUCTURE_ATTACHMENT_RULES) as [NodeType, readonly StructureType[]][]).flatMap(([nodeType, types]) =>
    types.map((structureType) => ({ organizationId, nodeType, structureType })),
  );
  await tx.insert(structureAttachmentRule).values(rows).onConflictDoNothing();
}

const newWorkOrder = (tx: Transaction, organizationId: string, code: string) =>
  tx
    .insert(workOrder)
    .values({ organizationId, code, title: `Job ${code}`, kind: "inspection", dueAt: new Date(Date.now() + 86_400_000), createdByUserId: userA })
    .returning({ id: workOrder.id })
    .then((rows) => rows[0]!.id);

// G-01: geometry columns read back as plain coordinates on every path.
describe("geometry columns", () => {
  it("round-trip points, lines and polygons through PostGIS", async () => {
    const path = [
      { lng: 36.78, lat: -1.29 },
      { lng: 36.79, lat: -1.3 },
    ];
    const ring = [
      { lng: 36.775, lat: -1.28 },
      { lng: 36.785, lat: -1.28 },
      { lng: 36.785, lat: -1.29 },
    ];
    const read = await asA(async (tx) => {
      const from = await addNode(tx, tenants.a.id, { type: "reservoir", location: { lat: -1.29, lng: 36.78 } });
      const to = await addNode(tx, tenants.a.id, { type: "junction", location: { lat: -1.3, lng: 36.79 } });
      const pipeId = await newAsset(tx, tenants.a.id, "pipe");
      const [returned] = await tx
        .insert(pipe)
        .values({ id: pipeId, organizationId: tenants.a.id, fromNodeId: from, toNodeId: to, path, diameterMm: 110, lengthM: 1500, createdByUserId: userA })
        .returning({ path: pipe.path });
      const [zone] = await tx
        .insert(area)
        .values({ organizationId: tenants.a.id, level: "dma", code: "DMA-GEO", name: "Geometry DMA", parentId: null })
        .returning({ id: area.id });
      const [band] = await tx.insert(tier).values({ organizationId: tenants.a.id, name: "DMA", order: 3 }).returning({ id: tier.id });
      await tx
        .insert(dma)
        .values({ organizationId: tenants.a.id, areaId: zone!.id, color: "#3B82F6", tierId: band!.id, boundary: ring, createdByUserId: userA });
      const [nodeRow] = await tx.select({ location: node.location }).from(node).where(eq(node.id, from));
      const [dmaRow] = await tx.select({ boundary: dma.boundary, areaId: dma.areaId }).from(dma);
      const [srid] = await tx.execute<{ srid: number; text: string }>(
        sql`select st_srid(location) as srid, st_astext(location) as text from gis.node where id = ${from}`,
      );
      return { returned: returned!.path, nodeRow: nodeRow!, dmaRow: dmaRow!, srid: srid! };
    });
    expect(read.returned).toEqual(path);
    expect(read.nodeRow.location).toEqual({ lat: -1.29, lng: 36.78 });
    // The ring is closed on write.
    expect(read.dmaRow.boundary).toEqual([...ring, ring[0]]);
    expect(read.srid).toEqual({ srid: 4326, text: "POINT(36.78 -1.29)" });
  });

  it("every geometry column in gis and work_orders has a GiST index", async () => {
    const rows = await t.admin.execute<{ table: string; column: string; gist: boolean }>(sql`
      select c.relname as table, a.attname as column,
             exists (select 1 from pg_index i join pg_class ic on ic.oid = i.indexrelid join pg_am am on am.oid = ic.relam
                      where i.indrelid = c.oid and am.amname = 'gist' and a.attnum = any(i.indkey)) as gist
        from pg_attribute a
        join pg_class c on c.oid = a.attrelid
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname in ('gis', 'work_orders') and c.relkind = 'r' and a.atttypid = 'geometry'::regtype and not a.attisdropped`);
    expect(rows.length).toBeGreaterThanOrEqual(6);
    expect(rows.filter((r) => !r.gist)).toEqual([]);
  });
});

// NF-01, NF-02: the new schemas follow the kernel's tenancy rules.
describe("tenancy", () => {
  it("every gis and work_orders table has organization_id, RLS and the tenant policy", async () => {
    const rows = await t.admin.execute<{ table: string; has_org: boolean; rls: boolean; policy: boolean }>(sql`
      select n.nspname || '.' || c.relname as table,
             exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'organization_id' and a.attnotnull) as has_org,
             c.relrowsecurity as rls,
             exists (select 1 from pg_policies p where p.schemaname = n.nspname and p.tablename = c.relname and p.policyname = 'tenant_isolation') as policy
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname in ('gis', 'work_orders') and c.relkind = 'r'`);
    expect(rows.length).toBe(22);
    expect(rows.filter((r) => !r.has_org || !r.rls || !r.policy)).toEqual([]);
  });

  it("a tenant sees only its own network and jobs", async () => {
    const bNode = await asB((tx) => addNode(tx, tenants.b.id, { type: "hydrant" }));
    const bJob = await asB((tx) => newWorkOrder(tx, tenants.b.id, "B-1"));
    const seen = await asA(async (tx) => ({
      nodes: await tx.select({ id: node.id }).from(node).where(eq(node.id, bNode)),
      jobs: await tx.select({ id: workOrder.id }).from(workOrder).where(eq(workOrder.id, bJob)),
    }));
    expect(seen).toEqual({ nodes: [], jobs: [] });
    expect(await t.app.select().from(node)).toEqual([]);
  });

  it("refuses to write another tenant's rows", async () => {
    await expect(asA((tx) => newAsset(tx, tenants.b.id, "node"))).rejects.toMatchObject(pgError(/row-level security/));
    await expect(asA((tx) => newWorkOrder(tx, tenants.b.id, "X-1"))).rejects.toMatchObject(pgError(/row-level security/));
  });

  it("composite foreign keys keep references inside the tenant", async () => {
    const bNode = await asB((tx) => addNode(tx, tenants.b.id, { type: "valve" }));
    await expect(
      asA(async (tx) => {
        const own = await addNode(tx, tenants.a.id, { type: "junction" });
        const pipeId = await newAsset(tx, tenants.a.id, "pipe");
        await tx.insert(pipe).values({
          id: pipeId,
          organizationId: tenants.a.id,
          fromNodeId: own,
          toNodeId: bNode,
          path: [
            { lng: 36.78, lat: -1.29 },
            { lng: 36.79, lat: -1.3 },
          ],
          diameterMm: 90,
          lengthM: 10,
          createdByUserId: userA,
        });
      }),
    ).rejects.toMatchObject(pgError(/pipe_to_node_fk/));
  });

  it("allows one head per asset and branch", async () => {
    await expect(
      asA(async (tx) => {
        const id = await addNode(tx, tenants.a.id, { type: "meter" });
        await tx.insert(node).values({ id, organizationId: tenants.a.id, type: "meter", name: "again", location: { lat: 0, lng: 0 }, createdByUserId: userA });
      }),
    ).rejects.toMatchObject(pgError(/node_head_unique/));
  });

  it("the auth role cannot reach the new schemas", async () => {
    await expect(t.auth.select().from(node)).rejects.toMatchObject(pgError(/permission denied/));
    await expect(t.auth.select().from(workOrder)).rejects.toMatchObject(pgError(/permission denied/));
  });
});

// G-01: gis.check_structure_attachment, ported from Majimap.
describe("structure attachment trigger", () => {
  it("houses a node only in a structure type its organization's rules allow", async () => {
    await asA(async (tx) => {
      await seedRules(tx, tenants.a.id);
      const chamber = await addStructure(tx, tenants.a.id, "chamber");
      await addNode(tx, tenants.a.id, { type: "valve", structureId: chamber });
    });
    await expect(
      asA(async (tx) => {
        const chamber = await addStructure(tx, tenants.a.id, "chamber");
        await addNode(tx, tenants.a.id, { type: "hydrant", structureId: chamber });
      }),
    ).rejects.toMatchObject(pgError(/node type hydrant may not be housed in structure type chamber/));
  });

  it("uses each organization's own rules", async () => {
    // Tenant B has no rules yet, so nothing may be housed.
    await expect(
      asB(async (tx) => {
        const chamber = await addStructure(tx, tenants.b.id, "chamber");
        await addNode(tx, tenants.b.id, { type: "valve", structureId: chamber });
      }),
    ).rejects.toMatchObject(pgError(/may not be housed/));
  });

  it("needs a live structure on the node's branch or main", async () => {
    await expect(
      asA(async (tx) => {
        const elsewhere = await addStructure(tx, tenants.a.id, "vault", "wo-OTHER");
        await addNode(tx, tenants.a.id, { type: "valve", structureId: elsewhere, branch: "wo-MINE" });
      }),
    ).rejects.toMatchObject(pgError(/does not reference an existing structure/));
    await asA(async (tx) => {
      const onBranch = await addStructure(tx, tenants.a.id, "vault", "wo-MINE");
      await addNode(tx, tenants.a.id, { type: "valve", structureId: onBranch, branch: "wo-MINE" });
    });
  });

  it("never blocks retiring a version or writing a tombstone", async () => {
    await asA(async (tx) => {
      const chamber = await addStructure(tx, tenants.a.id, "chamber");
      const id = await addNode(tx, tenants.a.id, { type: "valve", structureId: chamber });
      // The structure goes away; the node's old head can still be retired and tombstoned.
      await tx.update(structure).set({ isDeleted: true }).where(eq(structure.id, chamber));
      await tx.update(node).set({ isHead: false }).where(and(eq(node.id, id), eq(node.branch, "main")));
      await tx.insert(node).values({
        id,
        organizationId: tenants.a.id,
        type: "valve",
        name: "gone",
        location: { lat: 0, lng: 0 },
        structureId: chamber,
        isDeleted: true,
        createdByUserId: userA,
      });
    });
  });
});

// NF-22 style history: logs and job history are append-only for the app role.
describe("append-only history", () => {
  it("condition logs and job events can be written but never changed or removed", async () => {
    const ids = await asA(async (tx) => {
      const assetId = await addNode(tx, tenants.a.id, { type: "hydrant" });
      const [log] = await tx
        .insert(conditionLog)
        .values({ organizationId: tenants.a.id, assetId, condition: "poor", recordedAt: new Date(), recordedByUserId: userA })
        .returning({ id: conditionLog.id });
      const workOrderId = await newWorkOrder(tx, tenants.a.id, "A-HIST");
      const eventId = randomUUID();
      await tx.insert(workOrderEvent).values({
        id: eventId,
        organizationId: tenants.a.id,
        workOrderId,
        type: "create",
        outcome: "applied",
        payload: {},
        actorUserId: userA,
        latitude: -1.2195,
        longitude: 36.8869,
        occurredAt: new Date(),
      });
      return { log: log!.id, eventId };
    });
    await expect(asA((tx) => tx.update(conditionLog).set({ note: "edited" }).where(eq(conditionLog.id, ids.log)))).rejects.toMatchObject(
      pgError(/permission denied/),
    );
    await expect(asA((tx) => tx.delete(conditionLog).where(eq(conditionLog.id, ids.log)))).rejects.toMatchObject(pgError(/permission denied/));
    await expect(asA((tx) => tx.update(workOrderEvent).set({ reason: "x" }).where(eq(workOrderEvent.id, ids.eventId)))).rejects.toMatchObject(
      pgError(/permission denied/),
    );
    await expect(asA((tx) => tx.delete(workOrderEvent).where(eq(workOrderEvent.id, ids.eventId)))).rejects.toMatchObject(
      pgError(/permission denied/),
    );
  });

  it("the history tables have no UPDATE, DELETE or TRUNCATE for the app role", async () => {
    const tables = [
      "gis.condition_log",
      "gis.valve_state_log",
      "work_orders.work_order_event",
      "work_orders.work_order_change_set",
      "work_orders.work_order_log_link",
      "work_orders.work_order_comment",
      "work_orders.work_order_capture",
    ];
    for (const table of tables) {
      const [row] = await t.admin.execute<{ ins: boolean; upd: boolean; del: boolean; trn: boolean }>(sql`
        select has_table_privilege('flowless_app', ${table}, 'INSERT') as ins,
               has_table_privilege('flowless_app', ${table}, 'UPDATE') as upd,
               has_table_privilege('flowless_app', ${table}, 'DELETE') as del,
               has_table_privilege('flowless_app', ${table}, 'TRUNCATE') as trn`);
      expect({ table, ...row }).toEqual({ table, ins: true, upd: false, del: false, trn: false });
    }
  });

  it("DMA boundary valves belong to one version of the DMA's map data", async () => {
    await asA(async (tx) => {
      const valve = await addNode(tx, tenants.a.id, { type: "valve" });
      const [zone] = await tx
        .insert(area)
        .values({ organizationId: tenants.a.id, level: "dma", code: "DMA-V", name: "Valve DMA" })
        .returning({ id: area.id });
      const [band] = await tx.insert(tier).values({ organizationId: tenants.a.id, name: "Valve tier", order: 9 }).returning({ id: tier.id });
      const [version] = await tx
        .insert(dma)
        .values({
          organizationId: tenants.a.id,
          areaId: zone!.id,
          color: "#10B981",
          tierId: band!.id,
          boundary: [
            { lng: 0, lat: 0 },
            { lng: 1, lat: 0 },
            { lng: 1, lat: 1 },
          ],
          createdByUserId: userA,
        })
        .returning({ versionId: dma.versionId });
      await tx.insert(dmaBoundaryValve).values({ organizationId: tenants.a.id, dmaVersionId: version!.versionId, valveId: valve });
      expect(await tx.select().from(dmaBoundaryValve).where(eq(dmaBoundaryValve.dmaVersionId, version!.versionId))).toHaveLength(1);
    });
  });
});

// W-02: the assignee and crew members must be members; leaving unassigns, never deletes the job.
describe("memberships", () => {
  it("a job's assignee leaving unassigns it; their crew membership goes", async () => {
    const leaver = randomUUID();
    await t.admin.execute(sql`insert into auth.user (id, name, email) values (${leaver}, 'Leaver', ${`${leaver}@example.test`})`);
    await t.admin.execute(
      sql`insert into auth.member (organization_id, user_id, role, created_at) values (${tenants.a.id}, ${leaver}, 'technician', now())`,
    );
    const ids = await asA(async (tx) => {
      const workOrderId = await newWorkOrder(tx, tenants.a.id, "A-LEAVE");
      await tx.update(workOrder).set({ assignedToUserId: leaver }).where(eq(workOrder.id, workOrderId));
      const [team] = await tx.insert(crew).values({ organizationId: tenants.a.id, name: "Night crew" }).returning({ id: crew.id });
      await tx.insert(crewMember).values({ organizationId: tenants.a.id, crewId: team!.id, userId: leaver });
      return { workOrderId, crewId: team!.id };
    });
    await t.admin.execute(sql`delete from auth.member where user_id = ${leaver}`);
    const after = await asA(async (tx) => ({
      job: await tx.select({ assignee: workOrder.assignedToUserId, organizationId: workOrder.organizationId }).from(workOrder).where(eq(workOrder.id, ids.workOrderId)),
      crew: await tx.select().from(crewMember).where(eq(crewMember.crewId, ids.crewId)),
    }));
    expect(after).toEqual({ job: [{ assignee: null, organizationId: tenants.a.id }], crew: [] });
  });

  it("refuses an assignee who is not a member of the organization", async () => {
    await expect(
      asA(async (tx) => {
        const workOrderId = await newWorkOrder(tx, tenants.a.id, "A-STRANGER");
        await tx.update(workOrder).set({ assignedToUserId: randomUUID() }).where(eq(workOrder.id, workOrderId));
      }),
    ).rejects.toMatchObject(pgError(/work_order_assignee_fk/));
  });
});
