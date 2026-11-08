import type { LatLng, Transaction } from "@flowless/db";
import { dma, node, pipe, serviceConnection, structure } from "@flowless/db/schema/gis";
import { NODE_PHOTO_RULE, type NodeType } from "@flowless/shared-types";
import { and, eq, inArray } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { createHash } from "node:crypto";
import { MAIN } from "../common";
import { areaNames, loadBoundaryValves, writeBoundaryValves } from "../dma-store";
import { pathLengthMetres } from "../geo";
import { junctionColumns, junctionFromRow, type JunctionSpec } from "../junction";
import { keyOf, normalize, type VersionedRow, type VersionedTable } from "./engine";
import { planMerge, type Conflict, type MergePlan, type Resolutions } from "./merge";

export type EntityType = "node" | "structure" | "pipe" | "connection" | "dma";
export type AnyRow = VersionedRow & Record<string, unknown>;
export type WritePlan = Extract<MergePlan, { kind: "write" }>;

/**
 * One kind of versioned entity, as reconcile sees it (ported from Majimap). Adding a kind
 * to the network means adding an entry here: the merge, the review token, branch listing
 * and discard all work off this list.
 */
export type Kind = {
  entityType: EntityType;
  table: VersionedTable;
  /**
   * Every column that can differ between two versions and so can be merged. Deliberately
   * absent: anything immutable (a node's or structure's `type`, a pipe's end nodes, a
   * connection's service point) and anything derived (see `finalize`).
   */
  fields: readonly string[];
  displayName: (row: AnyRow) => string;
  /**
   * Fields that are SETS held in child rows rather than columns (a DMA's boundary valves).
   * They merge by set algebra and never conflict, and being virtual they're kept out of the
   * row insert and written by `saveChildren` instead.
   */
  setFields?: readonly string[];
  /** Load child rows (and display-only values) onto every version that was loaded. */
  attachChildren?: (tx: Transaction, rows: AnyRow[]) => Promise<void>;
  /** Write the child rows belonging to a newly inserted main version. */
  saveChildren?: (tx: Transaction, next: AnyRow, values: Record<string, unknown>) => Promise<void>;
  /**
   * Recompute derived columns from the merged values. A pipe's length is a function of its
   * path, so it's never merged on its own: merging both would split one re-route into two
   * conflicts, and resolving them opposite ways would leave a length that doesn't match.
   */
  finalize?: (values: Record<string, unknown>) => Record<string, unknown>;
  /**
   * Fields that exist only on the loaded rows (a node's `junction` is three columns
   * presented as one value). They're merged as a unit, and `finalize` turns them back into
   * columns. They're never written as keys of their own.
   */
  virtualFields?: readonly string[];
};

/**
 * ORDER MATTERS: this is the order writes are applied in. A node housed in a structure
 * created on the same branch has to land after that structure (the attachment trigger
 * looks for the structure on main), and a pipe or a DMA after the nodes it uses.
 *
 * Flowless: a DMA's name is its kernel area's, so it is not merged; it is attached for
 * display only.
 */
export const KINDS: readonly Kind[] = [
  {
    entityType: "structure",
    table: structure,
    fields: ["name", "location", "condition", "installedAt", "lastInspectedAt"],
    displayName: (row) => String(row.name),
  },
  {
    entityType: "node",
    table: node,
    // Junction type and sizes merge as ONE field: sizes are only valid together (the branch
    // must be smaller than the main), so a half-merge could break the CHECK.
    fields: ["name", "location", "condition", "isOpen", "structureId", "installedAt", "lastInspectedAt", "junction"],
    virtualFields: ["junction"],
    displayName: (row) => String(row.name),
    attachChildren: async (_tx, rows) => {
      for (const row of rows) row.junction = junctionFromRow(row as never);
    },
    finalize: (values) => {
      const { junction, ...rest } = values;
      return { ...rest, ...junctionColumns(junction as JunctionSpec | null | undefined) };
    },
  },
  {
    entityType: "pipe",
    table: pipe,
    fields: ["path", "material", "diameterMm", "condition"],
    displayName: (row) => `Pipe ${row.id}`,
    finalize: (values) => ({ ...values, lengthM: pathLengthMetres(values.path as LatLng[]) }),
  },
  {
    // After pipes, since a connection may name a pipe created on the same branch.
    entityType: "connection",
    table: serviceConnection,
    // The service point is fixed: a different account at this connection is an Accounts change, not a GIS edit.
    fields: ["connectionNumber", "location", "pipeId"],
    displayName: (row) => `Connection ${row.connectionNumber}`,
  },
  {
    entityType: "dma",
    table: dma,
    fields: ["color", "tierId", "inletMeterId", "boundary", "boundaryValveIds"],
    setFields: ["boundaryValveIds"],
    virtualFields: ["name"],
    displayName: (row) => String(row.name ?? "DMA"),
    attachChildren: async (tx, rows) => {
      const valves = await loadBoundaryValves(tx, rows.map((row) => row.versionId));
      const names = await areaNames(tx, rows.map((row) => row.id));
      for (const row of rows) {
        row.boundaryValveIds = valves.get(row.versionId) ?? [];
        row.name = names.get(row.id) ?? "DMA";
      }
    },
    saveChildren: async (tx, next, values) => {
      await writeBoundaryValves(tx, next.organizationId, next.versionId, (values.boundaryValveIds as string[] | undefined) ?? []);
    },
  },
];

export type Entry = {
  kind: Kind;
  branchHead: AnyRow;
  /** The version the branch forked from; null if the entity was created on the branch. */
  base: AnyRow | null;
  mainHead: AnyRow | null;
};

export type Violation = {
  code:
    | "pipe-endpoint-missing"
    | "connection-pipe-missing"
    | "node-structure-missing"
    | "dma-inlet-missing"
    | "dma-valve-missing"
    | "subnetwork-controller-missing"
    | "node-photo-missing";
  /** The entity that would be left pointing at something that isn't there. */
  entityId: string;
  /** What it points at. */
  relatedId: string;
  message: string;
};

/** Thrown inside the post savepoint to roll everything back, then turned into a normal result. */
export class IntegrityFailure extends Error {
  constructor(readonly violations: Violation[]) {
    super("Posting this branch would leave main inconsistent");
  }
}

/** A branch's chain walks back through its own versions until it leaves the branch: that's the fork point. */
export function findBase(head: AnyRow, byVersion: Map<string, AnyRow>): AnyRow | null {
  let current = head;
  const seen = new Set<string>();
  while (current.branch === head.branch) {
    if (!current.supersedesVersionId) return null;
    if (seen.has(current.versionId)) throw new Error("Cycle in version chain");
    seen.add(current.versionId);
    const previous = byVersion.get(current.supersedesVersionId);
    if (!previous) throw new Error("Broken version chain");
    current = previous;
  }
  return current;
}

/** The versions a head's own branch contributed, newest first. */
export function branchChain(head: AnyRow, byVersion: Map<string, AnyRow>): AnyRow[] {
  const chain: AnyRow[] = [];
  const seen = new Set<string>();
  let current: AnyRow | undefined = head;
  while (current && current.branch === head.branch && !seen.has(current.versionId)) {
    seen.add(current.versionId);
    chain.push(current);
    current = current.supersedesVersionId ? byVersion.get(current.supersedesVersionId) : undefined;
  }
  return chain;
}

/** Every row of a kind matching `where`, normalized (a DMA's `id` is its area). */
export async function selectRows(tx: Transaction, kind: Kind, where: ReturnType<typeof and>): Promise<AnyRow[]> {
  return normalize(kind.table, await tx.select().from(kind.table as PgTable).where(where)) as AnyRow[];
}

export async function loadEntries(tx: Transaction, orgId: string, branch: string): Promise<Entry[]> {
  const entries: Entry[] = [];
  for (const kind of KINDS) {
    const table = kind.table;
    const branchHeads = await selectRows(tx, kind, and(eq(table.organizationId, orgId), eq(table.branch, branch), eq(table.isHead, true)));
    if (branchHeads.length === 0) continue;

    const allVersions = await selectRows(
      tx,
      kind,
      and(
        eq(table.organizationId, orgId),
        inArray(
          keyOf(table),
          branchHeads.map((h) => h.id),
        ),
      ),
    );
    await kind.attachChildren?.(tx, allVersions);

    const byEntity = new Map<string, AnyRow[]>();
    for (const row of allVersions) byEntity.set(row.id, [...(byEntity.get(row.id) ?? []), row]);

    for (const branchHead of branchHeads) {
      const versions = byEntity.get(branchHead.id) ?? [];
      const byVersion = new Map(versions.map((v) => [v.versionId, v]));
      entries.push({
        kind,
        // The copy from `allVersions`, which has any child rows attached.
        branchHead: byVersion.get(branchHead.versionId) ?? branchHead,
        base: findBase(branchHead, byVersion),
        mainHead: versions.find((v) => v.branch === MAIN && v.isHead) ?? null,
      });
    }
  }
  return entries;
}

/**
 * A fingerprint of exactly which branch versions were reviewed, across every kind of
 * entity. Posting with a stale one is refused, so "post" always means "post what I was shown".
 */
export function headsToken(entries: readonly Entry[]): string {
  return createHash("sha256")
    .update(
      entries
        .map((e) => `${e.branchHead.id}:${e.branchHead.versionId}`)
        .sort()
        .join("|"),
    )
    .digest("hex")
    .slice(0, 32);
}

export function planFor(entry: Entry, resolutions: Resolutions = {}): MergePlan {
  return planMerge({ base: entry.base, branch: entry.branchHead, main: entry.mainHead }, entry.kind.fields, resolutions, {
    setFields: entry.kind.setFields,
  });
}

export const wireConflict = (c: Conflict): Conflict => ({ field: c.field, base: c.base, branch: c.branch, main: c.main });

export function entityName(entry: Entry): string {
  const shown = entry.branchHead.isDeleted ? (entry.mainHead ?? entry.branchHead) : entry.branchHead;
  return entry.kind.displayName(shown);
}

/** What changes, field by field: the live value now, and what it becomes. */
export function changesOf(entry: Entry, plan: WritePlan) {
  if (plan.tombstone) return [];
  const live = entry.mainHead && !entry.mainHead.isDeleted ? entry.mainHead : null;
  return plan.changedFields.map((field) => ({ field, from: live ? live[field] : null, to: plan.values[field] }));
}

export function describePlan(entry: Entry, plan: MergePlan) {
  return {
    kind: plan.kind,
    detail: plan.kind === "write" ? plan.mode : plan.kind === "skip" ? plan.reason : "conflict",
    changedFields: plan.kind === "write" ? plan.changedFields : [],
    changes: plan.kind === "write" ? changesOf(entry, plan) : [],
    conflicts: plan.kind === "conflict" ? plan.conflicts.map(wireConflict) : [],
  };
}

export const needsPhotoEvidence = (entry: Entry, plan: MergePlan) =>
  entry.kind.entityType === "node" && plan.kind === "write" && plan.mode === "create" && NODE_PHOTO_RULE[entry.branchHead.type as NodeType] === "required";
