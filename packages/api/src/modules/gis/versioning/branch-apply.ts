import type { Transaction } from "@flowless/db";
import { dma, dmaBoundaryValve, node, pipe, serviceConnection, structure, subnetwork } from "@flowless/db/schema/gis";
import { NODE_PHOTO_RULE, type AssetCondition, type NodeType } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, or } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { photoCounts } from "../../../kernel/file-subjects";
import { MAIN } from "../common";
import { loadBoundaryValves } from "../dma-store";
import { emit, gisConditionChanged } from "../events";
import { GIS_ASSET_FILES } from "../files";
import type { AnyRow, Entry, EntityType, Kind, Violation, WritePlan } from "./branch-entries";
import { carry, normalize, type VersionedTable } from "./engine";

export function assertNotMain(branch: string) {
  if (branch === MAIN) throw new TRPCError({ code: "BAD_REQUEST", message: "Main can't be reconciled onto itself" });
}

export async function retireHead(tx: Transaction, kind: Kind, versionId: string) {
  const table = kind.table;
  const flipped = await tx
    .update(table)
    .set({ isHead: false } as never)
    .where(and(eq(table.versionId, versionId), eq(table.isHead, true)))
    .returning({ versionId: table.versionId });
  if (flipped.length === 0) {
    throw new TRPCError({ code: "CONFLICT", message: "The branch changed while it was being reconciled: review it again" });
  }
}

export type Applied = { entityType: EntityType; id: string; tombstone: boolean; next: AnyRow; mode: WritePlan["mode"] };

export async function applyWrite(
  tx: Transaction,
  args: { orgId: string; userId: string; branch: string; entry: Entry; plan: WritePlan },
): Promise<Applied> {
  const { orgId, userId, branch, entry, plan } = args;
  const { kind, mainHead, branchHead } = entry;
  const table = kind.table;

  if (mainHead) {
    // Compare-and-set: if main moved since we read it, this matches nothing and the whole
    // reconcile rolls back rather than overwriting someone's edit.
    const flipped = await tx
      .update(table)
      .set({ isHead: false } as never)
      .where(and(eq(table.versionId, mainHead.versionId), eq(table.isHead, true)))
      .returning({ versionId: table.versionId });
    if (flipped.length === 0) throw new TRPCError({ code: "CONFLICT", message: "Main changed while reconciling: review again and retry" });
  }

  const source = mainHead ?? branchHead;
  const carried = carry(source);
  const values = plan.tombstone ? {} : kind.finalize ? kind.finalize(plan.values) : plan.values;
  const virtual = new Set([...(kind.setFields ?? []), ...(kind.virtualFields ?? [])]);
  const columnsOnly = (record: Record<string, unknown>) => Object.fromEntries(Object.entries(record).filter(([key]) => !virtual.has(key)));

  const row = {
    ...columnsOnly(carried),
    ...columnsOnly(values),
    versionId: randomUUID(),
    branch: MAIN,
    isHead: true,
    isDeleted: plan.tombstone,
    supersedesVersionId: mainHead?.versionId ?? branchHead.versionId,
    createdByUserId: userId,
  };
  const [next] = normalize(table, await tx.insert(table).values(row as never).returning()) as AnyRow[];
  if (!next) throw new Error("Insert returned no row");
  if (!plan.tombstone) await kind.saveChildren?.(tx, next, values);

  // A condition change is only a fact other modules should react to once it lands on main.
  if (mainHead && !mainHead.isDeleted && !plan.tombstone && plan.changedFields.includes("condition")) {
    await emit(tx, orgId, gisConditionChanged, {
      assetId: next.id,
      from: mainHead.condition as AssetCondition,
      to: next.condition as AssetCondition,
      changedByUserId: userId,
      reconciledFromBranch: branch,
    });
  }
  return { entityType: kind.entityType, id: next.id, tombstone: plan.tombstone, next, mode: plan.mode };
}

/**
 * Each entity can merge cleanly on its own and main can still end up inconsistent: the
 * guards that stop you deleting a node with pipes on it, or a structure with nodes in it,
 * only saw the branch as it was, and main may have moved since. So after the writes, look
 * at what they touched and what depends on it, on main, and report anything left pointing
 * at something that isn't there.
 */
export async function findViolations(tx: Transaction, orgId: string, applied: readonly Applied[]): Promise<Violation[]> {
  const violations: Violation[] = [];
  const mainLive = (table: VersionedTable) => and(eq(table.organizationId, orgId), eq(table.branch, MAIN), eq(table.isHead, true), eq(table.isDeleted, false));

  const deletedNodes = applied.filter((a) => a.entityType === "node" && a.tombstone).map((a) => a.id);
  const deletedStructures = applied.filter((a) => a.entityType === "structure" && a.tombstone).map((a) => a.id);
  const writtenPipes = applied.filter((a) => a.entityType === "pipe" && !a.tombstone).map((a) => a.id);
  const housedNodes = applied.filter((a) => a.entityType === "node" && !a.tombstone && a.next.structureId).map((a) => a.id);

  // Pipes: ones just written, plus any live pipe on main that ended on a node just deleted.
  const pipeIds = new Set(writtenPipes);
  if (deletedNodes.length > 0) {
    const attached = await tx
      .select({ id: pipe.id })
      .from(pipe)
      .where(and(mainLive(pipe), or(inArray(pipe.fromNodeId, deletedNodes), inArray(pipe.toNodeId, deletedNodes))));
    for (const row of attached) pipeIds.add(row.id);
  }
  if (pipeIds.size > 0) {
    const pipeRows = await tx
      .select({ id: pipe.id, fromNodeId: pipe.fromNodeId, toNodeId: pipe.toNodeId })
      .from(pipe)
      .where(and(mainLive(pipe), inArray(pipe.id, [...pipeIds])));
    const endpointIds = [...new Set(pipeRows.flatMap((p) => [p.fromNodeId, p.toNodeId]))];
    const liveEndpoints = new Set(
      endpointIds.length === 0
        ? []
        : (
            await tx
              .select({ id: node.id })
              .from(node)
              .where(and(mainLive(node), inArray(node.id, endpointIds)))
          ).map((row) => row.id),
    );
    for (const p of pipeRows) {
      for (const endId of [p.fromNodeId, p.toNodeId]) {
        if (!liveEndpoints.has(endId)) {
          violations.push({
            code: "pipe-endpoint-missing",
            entityId: p.id,
            relatedId: endId,
            message: `Pipe ${p.id} would end on node ${endId}, which doesn't exist on main`,
          });
        }
      }
    }
  }

  // Nodes: ones just written with a structure, plus any live node on main housed in one just deleted.
  const nodeIds = new Set(housedNodes);
  if (deletedStructures.length > 0) {
    const housed = await tx
      .select({ id: node.id })
      .from(node)
      .where(and(mainLive(node), inArray(node.structureId, deletedStructures)));
    for (const row of housed) nodeIds.add(row.id);
  }
  if (nodeIds.size > 0) {
    const nodeRows = await tx
      .select({ id: node.id, structureId: node.structureId })
      .from(node)
      .where(and(mainLive(node), inArray(node.id, [...nodeIds])));
    const structureIds = [...new Set(nodeRows.flatMap((n) => (n.structureId ? [n.structureId] : [])))];
    const liveStructures = new Set(
      structureIds.length === 0
        ? []
        : (
            await tx
              .select({ id: structure.id })
              .from(structure)
              .where(and(mainLive(structure), inArray(structure.id, structureIds)))
          ).map((row) => row.id),
    );
    for (const n of nodeRows) {
      if (n.structureId && !liveStructures.has(n.structureId)) {
        violations.push({
          code: "node-structure-missing",
          entityId: n.id,
          relatedId: n.structureId,
          message: `Node ${n.id} would be housed in structure ${n.structureId}, which doesn't exist on main`,
        });
      }
    }
  }

  // DMAs: ones just written, plus any live DMA on main that used a node just deleted.
  const dmaIds = new Set(applied.filter((a) => a.entityType === "dma" && !a.tombstone).map((a) => a.id));
  if (deletedNodes.length > 0) {
    const byInlet = await tx
      .select({ id: dma.areaId })
      .from(dma)
      .where(and(mainLive(dma), inArray(dma.inletMeterId, deletedNodes)));
    const byValve = await tx
      .select({ id: dma.areaId })
      .from(dma)
      .innerJoin(dmaBoundaryValve, eq(dmaBoundaryValve.dmaVersionId, dma.versionId))
      .where(and(mainLive(dma), inArray(dmaBoundaryValve.valveId, deletedNodes)));
    for (const row of [...byInlet, ...byValve]) dmaIds.add(row.id);
  }
  if (dmaIds.size > 0) {
    const dmaRows = await tx
      .select({ id: dma.areaId, versionId: dma.versionId, inletMeterId: dma.inletMeterId })
      .from(dma)
      .where(and(mainLive(dma), inArray(dma.areaId, [...dmaIds])));
    const valvesByVersion = await loadBoundaryValves(
      tx,
      dmaRows.map((d) => d.versionId),
    );
    const referenced = [...new Set(dmaRows.flatMap((d) => [...(d.inletMeterId ? [d.inletMeterId] : []), ...(valvesByVersion.get(d.versionId) ?? [])]))];
    const liveTypes = new Map(
      referenced.length === 0
        ? []
        : (
            await tx
              .select({ id: node.id, type: node.type })
              .from(node)
              .where(and(mainLive(node), inArray(node.id, referenced)))
          ).map((row): [string, string] => [row.id, row.type]),
    );
    for (const d of dmaRows) {
      if (d.inletMeterId && liveTypes.get(d.inletMeterId) !== "meter") {
        violations.push({
          code: "dma-inlet-missing",
          entityId: d.id,
          relatedId: d.inletMeterId,
          message: `DMA ${d.id} would have inlet meter ${d.inletMeterId}, which doesn't exist on main`,
        });
      }
      for (const valveId of valvesByVersion.get(d.versionId) ?? []) {
        if (liveTypes.get(valveId) !== "valve") {
          violations.push({
            code: "dma-valve-missing",
            entityId: d.id,
            relatedId: valveId,
            message: `DMA ${d.id} would have boundary valve ${valveId}, which doesn't exist on main`,
          });
        }
      }
    }
  }

  // Subnetworks live on main only, so one whose controller was just deleted is left pointing at nothing.
  if (deletedNodes.length > 0) {
    const orphaned = await tx
      .select({ id: subnetwork.id, controllerNodeId: subnetwork.controllerNodeId })
      .from(subnetwork)
      .where(and(eq(subnetwork.organizationId, orgId), inArray(subnetwork.controllerNodeId, deletedNodes)));
    for (const s of orphaned) {
      violations.push({
        code: "subnetwork-controller-missing",
        entityId: s.id,
        relatedId: s.controllerNodeId,
        message: `Subnetwork ${s.id} would lose its controller ${s.controllerNodeId}, which is being deleted`,
      });
    }
  }

  // New nodes of a type that needs photo evidence can't go live without at least one uploaded photo.
  const needPhoto = applied.filter((a) => a.entityType === "node" && a.mode === "create" && !a.tombstone && NODE_PHOTO_RULE[a.next.type as NodeType] === "required");
  if (needPhoto.length > 0) {
    const have = await photoCounts(
      tx,
      GIS_ASSET_FILES,
      needPhoto.map((a) => a.id),
    );
    for (const a of needPhoto) {
      if ((have.get(a.id) ?? 0) === 0) {
        violations.push({ code: "node-photo-missing", entityId: a.id, relatedId: a.id, message: `${String(a.next.name)} needs at least one photo before it can go live` });
      }
    }
  }

  // Connections: ones just written, plus any live connection on main served by a pipe just deleted.
  const deletedPipes = applied.filter((a) => a.entityType === "pipe" && a.tombstone).map((a) => a.id);
  const writtenConnections = applied.filter((a) => a.entityType === "connection" && !a.tombstone && a.next.pipeId);
  if (deletedPipes.length > 0) {
    const stranded = await tx
      .select({ id: serviceConnection.id, pipeId: serviceConnection.pipeId })
      .from(serviceConnection)
      .where(and(mainLive(serviceConnection), inArray(serviceConnection.pipeId, deletedPipes)));
    for (const row of stranded) {
      violations.push({
        code: "connection-pipe-missing",
        entityId: row.id,
        relatedId: row.pipeId ?? "",
        message: `Connection ${row.id} is served by a pipe this would delete. Relink it first.`,
      });
    }
  }
  if (writtenConnections.length > 0) {
    const wanted = writtenConnections.map((a) => String(a.next.pipeId));
    const live = new Set(
      (
        await tx
          .select({ id: pipe.id })
          .from(pipe)
          .where(and(mainLive(pipe), inArray(pipe.id, wanted)))
      ).map((p) => p.id),
    );
    for (const a of writtenConnections) {
      if (!live.has(String(a.next.pipeId))) {
        violations.push({
          code: "connection-pipe-missing",
          entityId: a.id,
          relatedId: String(a.next.pipeId),
          message: `${String(a.next.connectionNumber)} points at a pipe that isn't on the live network.`,
        });
      }
    }
  }

  return violations;
}
