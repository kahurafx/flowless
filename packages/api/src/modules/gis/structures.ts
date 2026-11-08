import type { Transaction } from "@flowless/db";
import { node, structure } from "@flowless/db/schema/gis";
import { ASSET_CONDITIONS, STRUCTURE_TYPES } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { router } from "../../trpc";
import { BranchSchema, compact, EntityId, GeoPointInput, guarded, MAIN, nonEmpty, VersionId } from "./common";
import { collectBlockers, deletedStamp, openJobsOn, type DeleteImpact } from "./deleted";
import { emit, gisConditionChanged } from "./events";
import type { GisProcedures } from "./procedures";
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

type StructureRow = typeof structure.$inferSelect;

export function toStructureDto(row: StructureRow) {
  return {
    id: row.id,
    versionId: row.versionId,
    branch: row.branch,
    type: row.type,
    name: row.name,
    location: row.location,
    condition: row.condition,
    installedAt: row.installedAt,
    lastInspectedAt: row.lastInspectedAt,
  };
}
export type StructureDto = ReturnType<typeof toStructureDto>;

const Condition = z.enum(ASSET_CONDITIONS);
const StructureType = z.enum(STRUCTURE_TYPES);

/** `type` is deliberately not patchable: changing it could silently break the attachment rules of whatever it houses. */
const StructurePatchSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    location: GeoPointInput,
    condition: Condition,
    installedAt: z.date().nullable(),
    lastInspectedAt: z.date().nullable(),
  })
  .partial()
  .refine(nonEmpty, "Patch is empty");

/**
 * A structure can't be deleted while it still houses something, judged by what the
 * CALLER'S BRANCH sees: a node housed on main but moved out on this branch no longer
 * blocks the delete here, though it still would on main.
 */
async function assertHousesNothing(tx: Transaction, orgId: string, branch: string, structureId: string) {
  const candidates = await tx
    .selectDistinct({ id: node.id })
    .from(node)
    .where(and(eq(node.organizationId, orgId), eq(node.structureId, structureId), eq(node.isHead, true), inArray(node.branch, [MAIN, branch])));
  if (candidates.length === 0) return;
  const effective = await listEffective(tx, node, {
    orgId,
    branch,
    where: inArray(
      node.id,
      candidates.map((c) => c.id),
    ),
  });
  const housed = effective.filter((n) => n.structureId === structureId);
  if (housed.length > 0) {
    const one = housed.length === 1;
    throw new TRPCError({
      code: "CONFLICT",
      message: `This structure still houses ${housed.length} asset${one ? "" : "s"}: move or delete ${one ? "it" : "them"} first`,
    });
  }
}

export function structuresRouter(p: GisProcedures) {
  return router({
    list: p.read
      .input(z.object({ branch: BranchSchema.default(MAIN), types: z.array(StructureType).optional() }).optional())
      .query(async ({ ctx, input }) => {
        const rows = await listEffective(ctx.tx, structure, {
          orgId: ctx.organizationId,
          branch: input?.branch ?? MAIN,
          where: input?.types?.length ? inArray(structure.type, input.types) : undefined,
        });
        return rows.map(toStructureDto);
      }),

    /** The same view as `list`, a page at a time in id order. */
    page: p.read
      .input(
        z.object({
          branch: BranchSchema.default(MAIN),
          types: z.array(StructureType).optional(),
          limit: z.number().int().min(1).max(1000).default(200),
          cursor: EntityId.optional(),
        }),
      )
      .query(async ({ ctx, input }) => {
        const { items, nextCursor } = await pageEffective(ctx.tx, structure, {
          orgId: ctx.organizationId,
          branch: input.branch,
          where: input.types?.length ? inArray(structure.type, input.types) : undefined,
          limit: input.limit,
          cursor: input.cursor,
        });
        return { items: items.map(toStructureDto), nextCursor };
      }),

    byId: p.read.input(z.object({ id: EntityId, branch: BranchSchema.default(MAIN) })).query(async ({ ctx, input }) => {
      const row = await loadEffective(ctx.tx, structure, { orgId: ctx.organizationId, id: input.id, branch: input.branch });
      if (!row || row.isDeleted) throw new TRPCError({ code: "NOT_FOUND", message: "Structure not found" });
      return toStructureDto(row);
    }),

    history: p.read.input(z.object({ id: EntityId })).query(async ({ ctx, input }) => {
      const rows = await loadHistory(ctx.tx, structure, { orgId: ctx.organizationId, id: input.id });
      if (rows.length === 0) throw new TRPCError({ code: "NOT_FOUND", message: "Structure not found" });
      return rows.map((row) => ({ ...toHistoryEntry(row), name: row.name, condition: row.condition }));
    }),

    create: p.edit
      .input(
        z.object({
          id: EntityId.optional(),
          branch: BranchSchema.default(MAIN),
          type: StructureType,
          name: z.string().trim().min(1).max(200),
          location: GeoPointInput,
          condition: Condition.default("unknown"),
          installedAt: z.date().nullable().default(null),
        }),
      )
      .mutation(async ({ ctx, input }) =>
        guarded(async () => {
          const id = input.id ?? randomUUID();
          const replay = await claimEntityId(ctx.tx, structure, { orgId: ctx.organizationId, id, branch: input.branch });
          if (replay) return toStructureDto(replay);
          await assertBranchWritable(ctx, input.branch);
          await insertAsset(ctx.tx, { orgId: ctx.organizationId, id, kind: "structure", userId: ctx.session.user.id });
          const [row] = await ctx.tx
            .insert(structure)
            .values({
              id,
              organizationId: ctx.organizationId,
              branch: input.branch,
              createdByUserId: ctx.session.user.id,
              type: input.type,
              name: input.name,
              location: input.location,
              condition: input.condition,
              installedAt: input.installedAt,
            })
            .returning();
          return toStructureDto(row!);
        }),
      ),

    update: p.edit
      .input(z.object({ id: EntityId, baseVersionId: VersionId, branch: BranchSchema.default(MAIN), patch: StructurePatchSchema }))
      .mutation(async ({ ctx, input }) => {
        const { patch } = input;
        return guarded(async () => {
          await assertBranchWritable(ctx, input.branch);
          const { previous, next } = await editVersioned(ctx.tx, structure, {
            orgId: ctx.organizationId,
            userId: ctx.session.user.id,
            id: input.id,
            branch: input.branch,
            baseVersionId: input.baseVersionId,
            tombstone: false,
            entity: "Structure",
            patch: compact({
              name: patch.name,
              location: patch.location,
              condition: patch.condition,
              installedAt: patch.installedAt,
              lastInspectedAt: patch.lastInspectedAt,
            }),
          });
          if (input.branch === MAIN && patch.condition !== undefined && patch.condition !== previous.condition) {
            await emit(ctx.tx, ctx.organizationId, gisConditionChanged, { assetId: next.id, from: previous.condition, to: next.condition, changedByUserId: ctx.session.user.id });
          }
          return toStructureDto(next);
        });
      }),

    delete: p.remove
      .input(z.object({ id: EntityId, baseVersionId: VersionId, branch: BranchSchema.default(MAIN) }))
      .mutation(async ({ ctx, input }) =>
        guarded(async () => {
          await assertBranchWritable(ctx, input.branch);
          await assertHousesNothing(ctx.tx, ctx.organizationId, input.branch, input.id);
          await editVersioned(ctx.tx, structure, {
            orgId: ctx.organizationId,
            userId: ctx.session.user.id,
            id: input.id,
            branch: input.branch,
            baseVersionId: input.baseVersionId,
            tombstone: true,
            entity: "Structure",
            patch: {},
          });
          return { ok: true as const };
        }),
      ),

    /** What's been deleted, newest first. */
    deleted: p.read.query(async ({ ctx }) => {
      const rows = await listDeleted(ctx.tx, structure, { orgId: ctx.organizationId });
      return rows.map((row) => ({ ...toStructureDto(row), ...deletedStamp(row) }));
    }),

    /** What deleting this structure would mean, for the confirmation dialog. */
    deleteImpact: p.remove.input(z.object({ id: EntityId })).query(
      async ({ ctx, input }): Promise<DeleteImpact> => ({
        blockers: await collectBlockers([() => assertHousesNothing(ctx.tx, ctx.organizationId, MAIN, input.id)]),
        connected: [],
        warnings: [],
        openJobs: await openJobsOn(ctx, input.id),
      }),
    ),

    /** Undo a delete. */
    restore: p.remove.input(z.object({ id: EntityId })).mutation(async ({ ctx, input }) =>
      guarded(async () => {
        await assertBranchWritable(ctx, MAIN);
        const { row, restored } = await restoreVersioned(ctx.tx, structure, { orgId: ctx.organizationId, userId: ctx.session.user.id, id: input.id, entity: "Structure" });
        if (restored) await ctx.audit({ action: "gis.restore", subjectType: "gis_structure", subjectId: row.id, after: { versionId: row.versionId } });
        return toStructureDto(row);
      }),
    ),
  });
}
