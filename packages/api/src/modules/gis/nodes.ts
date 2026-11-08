import type { Transaction } from "@flowless/db";
import { node, structure } from "@flowless/db/schema/gis";
import { ASSET_CONDITIONS, NODE_TYPES, type NodeType } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import { eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { router } from "../../trpc";
import { BranchSchema, compact, EntityId, GeoPointInput, guarded, MAIN, nonEmpty, VersionId } from "./common";
import { collectBlockers, deletedStamp, openJobsOn, pipesOnNode, type DeleteImpact } from "./deleted";
import { assertNodeNotUsedByDma } from "./dmas";
import { emit, gisConditionChanged } from "./events";
import { junctionColumns, junctionFromRow, JunctionSchema } from "./junction";
import { assertNodeHasNoPipes } from "./pipes";
import type { GisProcedures } from "./procedures";
import { attachmentAllowed } from "./rules";
import { assertNodeNotController } from "./subnetworks";
import { assertBranchWritable } from "./versioning/branch-write";
import {
  claimEntityId,
  editVersioned,
  insertAsset,
  listDeleted,
  listEffective,
  loadEffective,
  loadHistory,
  pageEffective,
  restoreVersioned,
  toHistoryEntry,
} from "./versioning/engine";

type NodeRow = typeof node.$inferSelect;

export function toNodeDto(row: NodeRow) {
  return {
    id: row.id,
    versionId: row.versionId,
    branch: row.branch,
    type: row.type,
    name: row.name,
    location: row.location,
    condition: row.condition,
    isOpen: row.isOpen,
    structureId: row.structureId,
    installedAt: row.installedAt,
    lastInspectedAt: row.lastInspectedAt,
    junction: junctionFromRow(row),
  };
}
export type NodeDto = ReturnType<typeof toNodeDto>;

const Condition = z.enum(ASSET_CONDITIONS);
const NodeType_ = z.enum(NODE_TYPES);
const Name = z.string().trim().min(1).max(200);

const NodePatchSchema = z
  .object({
    name: Name,
    location: GeoPointInput,
    condition: Condition,
    isOpen: z.boolean().nullable(),
    structureId: EntityId.nullable(),
    installedAt: z.date().nullable(),
    lastInspectedAt: z.date().nullable(),
    junction: JunctionSchema.nullable(),
  })
  .partial()
  .refine(nonEmpty, "Patch is empty");

/** The structure must be live where the node is (its branch or main), and the organization's rules must allow the pairing. */
async function assertStructureAllows(tx: Transaction, orgId: string, branch: string, nodeType: NodeType, structureId: string) {
  const [found] = await listEffective(tx, structure, { orgId, branch, where: eq(structure.id, structureId) });
  if (!found) throw new TRPCError({ code: "BAD_REQUEST", message: "That structure doesn't exist in this organization" });
  if (!(await attachmentAllowed(tx, nodeType, found.type))) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `A ${nodeType.replace("_", " ")} can't be housed in a ${found.type}` });
  }
}

export function nodesRouter(p: GisProcedures) {
  return router({
    list: p.read
      .input(z.object({ branch: BranchSchema.default(MAIN), types: z.array(NodeType_).optional() }).optional())
      .query(async ({ ctx, input }) => {
        const rows = await listEffective(ctx.tx, node, {
          orgId: ctx.organizationId,
          branch: input?.branch ?? MAIN,
          where: input?.types?.length ? inArray(node.type, input.types) : undefined,
        });
        return rows.map(toNodeDto);
      }),

    /** The same view as `list`, a page at a time in id order, for clients that can't hold a large network at once. */
    page: p.read
      .input(
        z.object({
          branch: BranchSchema.default(MAIN),
          types: z.array(NodeType_).optional(),
          limit: z.number().int().min(1).max(1000).default(200),
          cursor: EntityId.optional(),
        }),
      )
      .query(async ({ ctx, input }) => {
        const { items, nextCursor } = await pageEffective(ctx.tx, node, {
          orgId: ctx.organizationId,
          branch: input.branch,
          where: input.types?.length ? inArray(node.type, input.types) : undefined,
          limit: input.limit,
          cursor: input.cursor,
        });
        return { items: items.map(toNodeDto), nextCursor };
      }),

    byId: p.read.input(z.object({ id: EntityId, branch: BranchSchema.default(MAIN) })).query(async ({ ctx, input }) => {
      const row = await loadEffective(ctx.tx, node, { orgId: ctx.organizationId, id: input.id, branch: input.branch });
      if (!row || row.isDeleted) throw new TRPCError({ code: "NOT_FOUND", message: "Node not found" });
      return toNodeDto(row);
    }),

    /** Every version of one node, newest first, across all branches: the audit trail the version chain gives for free. */
    history: p.read.input(z.object({ id: EntityId })).query(async ({ ctx, input }) => {
      const rows = await loadHistory(ctx.tx, node, { orgId: ctx.organizationId, id: input.id });
      if (rows.length === 0) throw new TRPCError({ code: "NOT_FOUND", message: "Node not found" });
      return rows.map((row) => ({ ...toHistoryEntry(row), name: row.name, condition: row.condition, isOpen: row.isOpen }));
    }),

    create: p.edit
      .input(
        z.object({
          id: EntityId.optional(),
          branch: BranchSchema.default(MAIN),
          type: NodeType_,
          name: Name,
          location: GeoPointInput,
          condition: Condition.default("unknown"),
          isOpen: z.boolean().nullable().default(null),
          structureId: EntityId.nullable().default(null),
          installedAt: z.date().nullable().default(null),
          junction: JunctionSchema.nullable().default(null),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        if (input.type !== "junction" && input.junction) throw new TRPCError({ code: "BAD_REQUEST", message: "Only junctions have junction details" });
        if (input.type !== "valve" && input.isOpen !== null) throw new TRPCError({ code: "BAD_REQUEST", message: "Only valves have an open/closed state" });
        return guarded(async () => {
          const id = input.id ?? randomUUID();
          // A retry of an offline create that already landed is not an error: hand back what's there.
          const replay = await claimEntityId(ctx.tx, node, { orgId: ctx.organizationId, id, branch: input.branch });
          if (replay) return toNodeDto(replay);
          await assertBranchWritable(ctx, input.branch);
          if (input.structureId) await assertStructureAllows(ctx.tx, ctx.organizationId, input.branch, input.type, input.structureId);
          await insertAsset(ctx.tx, { orgId: ctx.organizationId, id, kind: "node", userId: ctx.session.user.id });
          const [row] = await ctx.tx
            .insert(node)
            .values({
              id,
              organizationId: ctx.organizationId,
              branch: input.branch,
              createdByUserId: ctx.session.user.id,
              type: input.type,
              name: input.name,
              location: input.location,
              condition: input.condition,
              isOpen: input.isOpen,
              structureId: input.structureId,
              installedAt: input.installedAt,
              ...junctionColumns(input.junction),
            })
            .returning();
          return toNodeDto(row!);
        });
      }),

    update: p.edit
      .input(z.object({ id: EntityId, baseVersionId: VersionId, branch: BranchSchema.default(MAIN), patch: NodePatchSchema }))
      .mutation(async ({ ctx, input }) => {
        const { patch } = input;
        return guarded(async () => {
          await assertBranchWritable(ctx, input.branch);
          const { previous, next } = await editVersioned(ctx.tx, node, {
            orgId: ctx.organizationId,
            userId: ctx.session.user.id,
            id: input.id,
            branch: input.branch,
            baseVersionId: input.baseVersionId,
            tombstone: false,
            entity: "Node",
            patch: {
              ...compact({
                name: patch.name,
                location: patch.location,
                condition: patch.condition,
                isOpen: patch.isOpen,
                structureId: patch.structureId,
                installedAt: patch.installedAt,
                lastInspectedAt: patch.lastInspectedAt,
              }),
              ...(patch.junction !== undefined ? junctionColumns(patch.junction) : {}),
            },
          });
          // Rules that depend on the merged result, checked after the fact: the transaction rolls back if any fail.
          if (next.type !== "valve" && next.isOpen !== null) throw new TRPCError({ code: "BAD_REQUEST", message: "Only valves have an open/closed state" });
          if (next.type !== "junction" && next.mainSizeMm !== null) throw new TRPCError({ code: "BAD_REQUEST", message: "Only junctions have junction details" });
          if (patch.structureId) await assertStructureAllows(ctx.tx, ctx.organizationId, input.branch, next.type, patch.structureId);
          // Only edits that land on main are facts other modules should react to; a branch edit is a proposal.
          if (input.branch === MAIN && patch.condition !== undefined && patch.condition !== previous.condition) {
            await emit(ctx.tx, ctx.organizationId, gisConditionChanged, {
              assetId: next.id,
              from: previous.condition,
              to: next.condition,
              changedByUserId: ctx.session.user.id,
            });
          }
          return toNodeDto(next);
        });
      }),

    delete: p.remove
      .input(z.object({ id: EntityId, baseVersionId: VersionId, branch: BranchSchema.default(MAIN) }))
      .mutation(async ({ ctx, input }) =>
        guarded(async () => {
          await assertBranchWritable(ctx, input.branch);
          await assertNodeHasNoPipes(ctx.tx, ctx.organizationId, input.branch, input.id);
          await assertNodeNotUsedByDma(ctx.tx, ctx.organizationId, input.branch, input.id);
          await assertNodeNotController(ctx.tx, input.id);
          await editVersioned(ctx.tx, node, {
            orgId: ctx.organizationId,
            userId: ctx.session.user.id,
            id: input.id,
            branch: input.branch,
            baseVersionId: input.baseVersionId,
            tombstone: true,
            entity: "Node",
            patch: {},
          });
          return { ok: true as const };
        }),
      ),

    /** What's been deleted, newest first. Enough to list it and draw it; nothing live is computed from these. */
    deleted: p.read.query(async ({ ctx }) => {
      const rows = await listDeleted(ctx.tx, node, { orgId: ctx.organizationId });
      return rows.map((row) => ({ ...toNodeDto(row), ...deletedStamp(row) }));
    }),

    /** What deleting this node would mean, for the confirmation dialog. The delete re-checks all of it. */
    deleteImpact: p.remove.input(z.object({ id: EntityId })).query(
      async ({ ctx, input }): Promise<DeleteImpact> => ({
        blockers: await collectBlockers([
          () => assertNodeHasNoPipes(ctx.tx, ctx.organizationId, MAIN, input.id),
          () => assertNodeNotUsedByDma(ctx.tx, ctx.organizationId, MAIN, input.id),
          () => assertNodeNotController(ctx.tx, input.id),
        ]),
        connected: await pipesOnNode(ctx.tx, ctx.organizationId, input.id),
        warnings: [],
        openJobs: await openJobsOn(ctx, input.id),
      }),
    ),

    /** Undo a delete on main. A node housed in a structure needs that structure back first. */
    restore: p.remove.input(z.object({ id: EntityId })).mutation(async ({ ctx, input }) =>
      guarded(async () => {
        await assertBranchWritable(ctx, MAIN);
        const current = await loadEffective(ctx.tx, node, { orgId: ctx.organizationId, id: input.id, branch: MAIN });
        if (current?.structureId) {
          const [home] = await listEffective(ctx.tx, structure, { orgId: ctx.organizationId, branch: MAIN, where: eq(structure.id, current.structureId) });
          if (!home) throw new TRPCError({ code: "CONFLICT", message: "The structure this node was housed in is deleted: restore that first" });
        }
        const { row, restored } = await restoreVersioned(ctx.tx, node, { orgId: ctx.organizationId, userId: ctx.session.user.id, id: input.id, entity: "Node" });
        if (restored) await ctx.audit({ action: "gis.restore", subjectType: "gis_node", subjectId: row.id, after: { versionId: row.versionId } });
        return toNodeDto(row);
      }),
    ),
  });
}
