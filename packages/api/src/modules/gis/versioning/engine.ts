import type { Transaction } from "@flowless/db";
import { asset } from "@flowless/db/schema/gis";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, gt, inArray, sql, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { randomUUID } from "node:crypto";
import { MAIN } from "../common";

/*
 * The branch-versioning engine, ported from Majimap's versioning/engine.ts as it is. It
 * works on ANY versioned GIS table, so the concurrency-sensitive part (which row is the
 * head, how a head is superseded, what a branch's first edit is built from) exists once.
 *
 * Flowless adaptations: everything runs in the caller's tenant transaction (RLS; the
 * organization filters Majimap had are kept, harmlessly); ids are uuids; there is no
 * shared asset registry (`gis.asset` is identity only, so nothing is synced on main). A
 * DMA's map data is keyed by the kernel area it belongs to (`area_id`), not `id`: the
 * engine reads that table's key through `keyOf` and hands its rows back with `id` set to
 * the area id, so callers treat every kind alike. Drizzle can't prove a generic table's
 * insert and update shapes, so those calls cast; the casts stay in this file.
 */

/** The columns every versioned row has (the asset's or DMA area's id as `id`). */
export type VersionedRow = {
  versionId: string;
  id: string;
  organizationId: string;
  branch: string;
  isHead: boolean;
  isDeleted: boolean;
  supersedesVersionId: string | null;
  createdAt: Date;
  createdByUserId: string;
};

export type VersionedTable = PgTable & {
  versionId: PgColumn;
  organizationId: PgColumn;
  branch: PgColumn;
  isHead: PgColumn;
  isDeleted: PgColumn;
  supersedesVersionId: PgColumn;
  createdAt: PgColumn;
  createdByUserId: PgColumn;
};

/** A row of `T`, with `id` always present (for a DMA, its area id). */
export type RowOf<T extends VersionedTable> = T["$inferSelect"] & VersionedRow;

/** The entity key: `id` for assets, `area_id` for a DMA's map data. */
export function keyOf(table: VersionedTable): PgColumn {
  const t = table as VersionedTable & { id?: PgColumn; areaId?: PgColumn };
  return (t.areaId ?? t.id)!;
}

const keyed = (table: VersionedTable) => "areaId" in table;

/** Rows as callers see them: a DMA row also carries its area id as `id`. */
export function normalize<T extends VersionedTable>(table: T, rows: unknown[]): RowOf<T>[] {
  if (!keyed(table)) return rows as RowOf<T>[];
  return (rows as (Record<string, unknown> & { areaId: string })[]).map((r) => ({ ...r, id: r.areaId })) as unknown as RowOf<T>[];
}

/** Values to insert for a version: a DMA row's key column is `area_id`. */
function insertable(table: VersionedTable, values: Record<string, unknown>): Record<string, unknown> {
  return keyed(table) ? { ...values, areaId: values.id } : values;
}

/**
 * A branch's view of the entities: for each id, the branch's head if it has one, otherwise
 * main's. Tombstones are dropped AFTER that overlay, so a branch can hide something that
 * still exists on main.
 */
export async function listEffective<T extends VersionedTable>(
  tx: Transaction,
  table: T,
  args: { orgId: string; branch: string; where?: SQL | undefined },
): Promise<RowOf<T>[]> {
  const key = keyOf(table);
  const rows = await tx
    .selectDistinctOn([key])
    .from(table as PgTable)
    .where(and(eq(table.organizationId, args.orgId), eq(table.isHead, true), inArray(table.branch, [MAIN, args.branch]), args.where))
    .orderBy(key, sql`(${table.branch} = ${args.branch}) desc`);
  return normalize(table, rows).filter((row) => !row.isDeleted);
}

/**
 * One page of `listEffective`, in id order: up to `limit` live entities after `cursor`, and
 * the cursor for the next page (null on the last one). Tombstones are dropped after the
 * overlay, so a page is filled by reading on until it's full or the table runs out.
 */
export async function pageEffective<T extends VersionedTable>(
  tx: Transaction,
  table: T,
  args: { orgId: string; branch: string; where?: SQL | undefined; limit: number; cursor?: string | undefined },
): Promise<{ items: RowOf<T>[]; nextCursor: string | null }> {
  const key = keyOf(table);
  const items: RowOf<T>[] = [];
  let after = args.cursor;
  for (;;) {
    const want = args.limit + 1 - items.length;
    const batch = normalize(
      table,
      await tx
        .selectDistinctOn([key])
        .from(table as PgTable)
        .where(
          and(
            eq(table.organizationId, args.orgId),
            eq(table.isHead, true),
            inArray(table.branch, [MAIN, args.branch]),
            after ? gt(key, after) : undefined,
            args.where,
          ),
        )
        .orderBy(key, sql`(${table.branch} = ${args.branch}) desc`)
        .limit(want),
    );
    items.push(...batch.filter((row) => !row.isDeleted));
    if (batch.length < want || items.length > args.limit) break;
    after = batch[batch.length - 1]!.id;
  }
  const page = items.slice(0, args.limit);
  return { items: page, nextCursor: items.length > args.limit ? page[page.length - 1]!.id : null };
}

/** One entity as a branch sees it. Returns tombstones too: callers decide what a deleted entity means. */
export async function loadEffective<T extends VersionedTable>(
  tx: Transaction,
  table: T,
  args: { orgId: string; id: string; branch: string },
): Promise<RowOf<T> | undefined> {
  const rows = await tx
    .select()
    .from(table as PgTable)
    .where(and(eq(table.organizationId, args.orgId), eq(keyOf(table), args.id), eq(table.isHead, true), inArray(table.branch, [MAIN, args.branch])))
    .orderBy(sql`(${table.branch} = ${args.branch}) desc`)
    .limit(1);
  return normalize(table, rows)[0];
}

/** What's been deleted from main: each tombstone still holds the entity's last columns, geometry included. */
export async function listDeleted<T extends VersionedTable>(tx: Transaction, table: T, args: { orgId: string }): Promise<RowOf<T>[]> {
  const rows = await tx
    .select()
    .from(table as PgTable)
    .where(and(eq(table.organizationId, args.orgId), eq(table.branch, MAIN), eq(table.isHead, true), eq(table.isDeleted, true)))
    .orderBy(desc(table.createdAt));
  return normalize(table, rows);
}

/** The row's own columns, minus what every new version gets afresh. */
export function carry(row: VersionedRow): Record<string, unknown> {
  const carried: Record<string, unknown> = { ...row };
  delete carried.versionId;
  delete carried.createdAt;
  return carried;
}

/**
 * Bring a deleted entity back on main, as a new version with the columns it had. Restoring
 * something already live changes nothing and returns it, so an Undo clicked twice is
 * harmless. There's no base version to check: a tombstone can't be edited.
 */
export async function restoreVersioned<T extends VersionedTable>(
  tx: Transaction,
  table: T,
  args: { orgId: string; userId: string; id: string; entity: string },
): Promise<{ row: RowOf<T>; restored: boolean }> {
  const [head] = normalize(
    table,
    await tx
      .select()
      .from(table as PgTable)
      .where(and(eq(table.organizationId, args.orgId), eq(keyOf(table), args.id), eq(table.branch, MAIN), eq(table.isHead, true)))
      .limit(1),
  );
  if (!head) throw new TRPCError({ code: "NOT_FOUND", message: `${args.entity} not found` });
  if (!head.isDeleted) return { row: head, restored: false };

  const flipped = await tx
    .update(table)
    .set({ isHead: false } as never)
    .where(and(eq(table.versionId, head.versionId), eq(table.isHead, true)))
    .returning({ versionId: table.versionId });
  if (flipped.length === 0) {
    throw new TRPCError({ code: "CONFLICT", message: `This ${args.entity.toLowerCase()} was changed concurrently: refetch and retry` });
  }
  const [next] = normalize(
    table,
    await tx
      .insert(table)
      .values(
        insertable(table, {
          ...carry(head),
          versionId: randomUUID(),
          isHead: true,
          isDeleted: false,
          supersedesVersionId: head.versionId,
          createdByUserId: args.userId,
        }) as never,
      )
      .returning(),
  );
  if (!next) throw new Error("Insert returned no row");
  return { row: next, restored: true };
}

/** Every version of one entity across all branches, newest first. */
export async function loadHistory<T extends VersionedTable>(tx: Transaction, table: T, args: { orgId: string; id: string }): Promise<RowOf<T>[]> {
  const rows = await tx
    .select()
    .from(table as PgTable)
    .where(and(eq(table.organizationId, args.orgId), eq(keyOf(table), args.id)))
    .orderBy(desc(table.createdAt));
  return normalize(table, rows);
}

/** The audit-trail shape every entity's `history` endpoint returns. */
export function toHistoryEntry(row: VersionedRow) {
  return {
    versionId: row.versionId,
    branch: row.branch,
    isHead: row.isHead,
    isDeleted: row.isDeleted,
    supersedesVersionId: row.supersedesVersionId,
    createdAt: row.createdAt,
    createdByUserId: row.createdByUserId,
  };
}

/**
 * Entity ids may come from the client, so claiming one has three outcomes: it's free
 * (null); it's a retry of a create that already landed on this branch (what's there, so
 * the retry is a no-op); or it's taken by something else (CONFLICT, saying nothing about
 * which). Another organization's id is invisible here (RLS): inserting its `gis.asset` row
 * fails on the primary key, which `rethrowDbError` turns into the same CONFLICT.
 */
export async function claimEntityId<T extends VersionedTable>(
  tx: Transaction,
  table: T,
  args: { orgId: string; id: string; branch: string },
): Promise<RowOf<T> | null> {
  const [existing] = await tx.select({ id: asset.id }).from(asset).where(eq(asset.id, args.id)).limit(1);
  if (!existing) return null;
  const [head] = normalize(
    table,
    await tx
      .select()
      .from(table as PgTable)
      .where(and(eq(table.organizationId, args.orgId), eq(keyOf(table), args.id), eq(table.branch, args.branch), eq(table.isHead, true)))
      .limit(1),
  );
  if (head && !head.isDeleted) return head;
  throw new TRPCError({ code: "CONFLICT", message: "That id is already in use" });
}

/** Registers a new asset's identity. A taken id fails on the primary key (CONFLICT). */
export async function insertAsset(tx: Transaction, args: { orgId: string; id: string; kind: (typeof asset.$inferInsert)["kind"]; userId: string }) {
  await tx.insert(asset).values({ id: args.id, organizationId: args.orgId, kind: args.kind, createdByUserId: args.userId });
}

export type EditArgs = {
  orgId: string;
  userId: string;
  id: string;
  branch: string;
  baseVersionId: string;
  /** Column values to change. Everything else is carried over from the version being superseded. */
  patch: Record<string, unknown>;
  tombstone: boolean;
  /** For error messages: "Structure", "Pipe". */
  entity: string;
};

/**
 * The versioned write. Never changes a row's data: it supersedes it.
 *
 * - The branch already has a head for this entity: the edit must be based on that head
 *   (otherwise it's stale). The head is flipped with a compare-and-set UPDATE, so of two
 *   racing edits exactly one flips it and the other sees zero rows and gets CONFLICT.
 * - No head on the branch (a feature branch's first edit): the new row is built from
 *   `baseVersionId` (the version the client edited), NOT from main's current head, and
 *   main's row is left alone. That keeps branch = base + exactly the client's changes,
 *   which is what lets a reconcile tell the branch's edits apart from main's.
 * - No head on main: either it never existed (NOT_FOUND) or a concurrent edit just
 *   superseded the head we expected (CONFLICT).
 */
export async function editVersioned<T extends VersionedTable>(
  tx: Transaction,
  table: T,
  args: EditArgs,
): Promise<{ previous: RowOf<T>; next: RowOf<T> }> {
  const { orgId, userId, id, branch, baseVersionId, patch, tombstone, entity } = args;
  const key = keyOf(table);
  const noun = entity.toLowerCase();
  const notFound = () => new TRPCError({ code: "NOT_FOUND", message: `${entity} not found` });
  const concurrent = () => new TRPCError({ code: "CONFLICT", message: `This ${noun} was changed concurrently: refetch and retry` });

  const [branchHead] = normalize(
    table,
    await tx
      .select()
      .from(table as PgTable)
      .where(and(eq(table.organizationId, orgId), eq(key, id), eq(table.branch, branch), eq(table.isHead, true)))
      .limit(1),
  );

  let previous: RowOf<T>;
  if (branchHead) {
    if (branchHead.isDeleted) throw notFound();
    if (branchHead.versionId !== baseVersionId) {
      throw new TRPCError({ code: "CONFLICT", message: `This ${noun} changed since you loaded it: refetch and reapply your edit` });
    }
    const flipped = await tx
      .update(table)
      .set({ isHead: false } as never)
      .where(and(eq(table.versionId, branchHead.versionId), eq(table.isHead, true)))
      .returning({ versionId: table.versionId });
    if (flipped.length === 0) throw concurrent();
    previous = branchHead;
  } else if (branch === MAIN) {
    const [anyVersion] = await tx
      .select({ versionId: table.versionId })
      .from(table as PgTable)
      .where(and(eq(table.organizationId, orgId), eq(key, id), eq(table.branch, MAIN)))
      .limit(1);
    throw anyVersion ? concurrent() : notFound();
  } else {
    // A branch's first edit has to be built on a version of MAIN. A base taken from another
    // branch would make the branch look as if it forked from someone else's unreviewed work,
    // and reconcile could then "create" the entity on main without that branch being reviewed.
    const [base] = normalize(
      table,
      await tx
        .select()
        .from(table as PgTable)
        .where(and(eq(table.organizationId, orgId), eq(key, id), eq(table.versionId, baseVersionId)))
        .limit(1),
    );
    if (!base || base.isDeleted || base.branch !== MAIN) throw notFound();
    previous = base;
  }

  const [next] = normalize(
    table,
    await tx
      .insert(table)
      .values(
        insertable(table, {
          ...carry(previous),
          ...patch,
          versionId: randomUUID(),
          branch,
          isHead: true,
          isDeleted: tombstone,
          supersedesVersionId: previous.versionId,
          createdByUserId: userId,
        }) as never,
      )
      .returning(),
  );
  if (!next) throw new Error("Insert returned no row");
  return { previous, next };
}
