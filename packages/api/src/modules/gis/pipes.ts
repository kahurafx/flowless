import type { LatLng, Transaction } from "@flowless/db";
import { node, pipe } from "@flowless/db/schema/gis";
import { ASSET_CONDITIONS, PIPE_MATERIALS } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, or } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { router } from "../../trpc";
import { BranchSchema, compact, EntityId, GeoPointInput, guarded, MAIN, nonEmpty, VersionId } from "./common";
import { assertPipeServesNobody, collectBlockers, connectionsOnPipe, deletedStamp, nodesStrandedBy, openJobsOn, type DeleteImpact } from "./deleted";
import { emit, gisConditionChanged } from "./events";
import { pathLengthMetres } from "./geo";
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

type PipeRow = typeof pipe.$inferSelect;

export function toPipeDto(row: PipeRow) {
  return {
    id: row.id,
    versionId: row.versionId,
    branch: row.branch,
    fromNodeId: row.fromNodeId,
    toNodeId: row.toNodeId,
    path: row.path,
    material: row.material,
    diameterMm: row.diameterMm,
    condition: row.condition,
    lengthM: row.lengthM,
  };
}
export type PipeDto = ReturnType<typeof toPipeDto>;

const Material = z.enum(PIPE_MATERIALS);
const Condition = z.enum(ASSET_CONDITIONS);
const PathInput = z.array(GeoPointInput).min(2).max(10_000);
const DiameterInput = z.number().positive().max(5_000);

const PipePatchSchema = z
  .object({ path: PathInput, material: Material, diameterMm: DiameterInput, condition: Condition })
  .partial()
  .refine(nonEmpty, "Patch is empty");

/** A pipe with no length can't carry water, and a zero would also make it vanish from length-weighted reports. */
function lengthOrThrow(path: readonly LatLng[]): number {
  const length = pathLengthMetres(path);
  if (!(length > 0)) throw new TRPCError({ code: "BAD_REQUEST", message: "A pipe's path must have some length" });
  return length;
}

/** Both ends have to be nodes the caller's branch can actually see, and different ones. */
async function assertEndpoints(tx: Transaction, orgId: string, branch: string, fromNodeId: string, toNodeId: string) {
  if (fromNodeId === toNodeId) throw new TRPCError({ code: "BAD_REQUEST", message: "A pipe needs two different end nodes" });
  const found = await listEffective(tx, node, { orgId, branch, where: inArray(node.id, [fromNodeId, toNodeId]) });
  if (found.length !== 2) throw new TRPCError({ code: "BAD_REQUEST", message: "Both ends of a pipe must be existing nodes" });
}

/**
 * A node can't be deleted while pipes still end on it, judged by what the caller's branch
 * sees (a pipe already deleted on this branch no longer blocks it). Called by `nodes.delete`.
 */
export async function assertNodeHasNoPipes(tx: Transaction, orgId: string, branch: string, nodeId: string) {
  const candidates = await tx
    .selectDistinct({ id: pipe.id })
    .from(pipe)
    .where(and(eq(pipe.organizationId, orgId), eq(pipe.isHead, true), inArray(pipe.branch, [MAIN, branch]), or(eq(pipe.fromNodeId, nodeId), eq(pipe.toNodeId, nodeId))));
  if (candidates.length === 0) return;
  const effective = await listEffective(tx, pipe, {
    orgId,
    branch,
    where: inArray(
      pipe.id,
      candidates.map((c) => c.id),
    ),
  });
  const attached = effective.filter((p) => p.fromNodeId === nodeId || p.toNodeId === nodeId);
  if (attached.length > 0) {
    const one = attached.length === 1;
    throw new TRPCError({
      code: "CONFLICT",
      message: `${attached.length} pipe${one ? " is" : "s are"} still connected to this node: delete ${one ? "it" : "them"} first`,
    });
  }
}

export function pipesRouter(p: GisProcedures) {
  return router({
    list: p.read.input(z.object({ branch: BranchSchema.default(MAIN) }).optional()).query(async ({ ctx, input }) => {
      const rows = await listEffective(ctx.tx, pipe, { orgId: ctx.organizationId, branch: input?.branch ?? MAIN });
      return rows.map(toPipeDto);
    }),

    /** The same view as `list`, a page at a time in id order. */
    page: p.read
      .input(z.object({ branch: BranchSchema.default(MAIN), limit: z.number().int().min(1).max(1000).default(200), cursor: EntityId.optional() }))
      .query(async ({ ctx, input }) => {
        const { items, nextCursor } = await pageEffective(ctx.tx, pipe, { orgId: ctx.organizationId, branch: input.branch, limit: input.limit, cursor: input.cursor });
        return { items: items.map(toPipeDto), nextCursor };
      }),

    byId: p.read.input(z.object({ id: EntityId, branch: BranchSchema.default(MAIN) })).query(async ({ ctx, input }) => {
      const row = await loadEffective(ctx.tx, pipe, { orgId: ctx.organizationId, id: input.id, branch: input.branch });
      if (!row || row.isDeleted) throw new TRPCError({ code: "NOT_FOUND", message: "Pipe not found" });
      return toPipeDto(row);
    }),

    history: p.read.input(z.object({ id: EntityId })).query(async ({ ctx, input }) => {
      const rows = await loadHistory(ctx.tx, pipe, { orgId: ctx.organizationId, id: input.id });
      if (rows.length === 0) throw new TRPCError({ code: "NOT_FOUND", message: "Pipe not found" });
      return rows.map((row) => ({ ...toHistoryEntry(row), condition: row.condition, material: row.material, diameterMm: row.diameterMm, lengthM: row.lengthM }));
    }),

    /** The length is always computed from the path; there's deliberately no way to supply one. */
    create: p.edit
      .input(
        z.object({
          id: EntityId.optional(),
          branch: BranchSchema.default(MAIN),
          fromNodeId: EntityId,
          toNodeId: EntityId,
          path: PathInput,
          material: Material.default("unknown"),
          diameterMm: DiameterInput,
          condition: Condition.default("unknown"),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const lengthM = lengthOrThrow(input.path);
        return guarded(async () => {
          const id = input.id ?? randomUUID();
          const replay = await claimEntityId(ctx.tx, pipe, { orgId: ctx.organizationId, id, branch: input.branch });
          if (replay) return toPipeDto(replay);
          await assertBranchWritable(ctx, input.branch);
          await assertEndpoints(ctx.tx, ctx.organizationId, input.branch, input.fromNodeId, input.toNodeId);
          await insertAsset(ctx.tx, { orgId: ctx.organizationId, id, kind: "pipe", userId: ctx.session.user.id });
          const [row] = await ctx.tx
            .insert(pipe)
            .values({
              id,
              organizationId: ctx.organizationId,
              branch: input.branch,
              createdByUserId: ctx.session.user.id,
              fromNodeId: input.fromNodeId,
              toNodeId: input.toNodeId,
              path: input.path,
              material: input.material,
              diameterMm: input.diameterMm,
              condition: input.condition,
              lengthM,
            })
            .returning();
          return toPipeDto(row!);
        });
      }),

    /** The end nodes are fixed once a pipe exists; to reconnect it, delete it and draw a new one. */
    update: p.edit
      .input(z.object({ id: EntityId, baseVersionId: VersionId, branch: BranchSchema.default(MAIN), patch: PipePatchSchema }))
      .mutation(async ({ ctx, input }) => {
        const { patch } = input;
        const lengthM = patch.path ? lengthOrThrow(patch.path) : undefined;
        return guarded(async () => {
          await assertBranchWritable(ctx, input.branch);
          const { previous, next } = await editVersioned(ctx.tx, pipe, {
            orgId: ctx.organizationId,
            userId: ctx.session.user.id,
            id: input.id,
            branch: input.branch,
            baseVersionId: input.baseVersionId,
            tombstone: false,
            entity: "Pipe",
            patch: compact({ path: patch.path, lengthM, material: patch.material, diameterMm: patch.diameterMm, condition: patch.condition }),
          });
          if (input.branch === MAIN && patch.condition !== undefined && patch.condition !== previous.condition) {
            await emit(ctx.tx, ctx.organizationId, gisConditionChanged, { assetId: next.id, from: previous.condition, to: next.condition, changedByUserId: ctx.session.user.id });
          }
          return toPipeDto(next);
        });
      }),

    delete: p.remove
      .input(z.object({ id: EntityId, baseVersionId: VersionId, branch: BranchSchema.default(MAIN) }))
      .mutation(async ({ ctx, input }) =>
        guarded(async () => {
          await assertBranchWritable(ctx, input.branch);
          await assertPipeServesNobody(ctx.tx, ctx.organizationId, input.branch, input.id);
          await editVersioned(ctx.tx, pipe, {
            orgId: ctx.organizationId,
            userId: ctx.session.user.id,
            id: input.id,
            branch: input.branch,
            baseVersionId: input.baseVersionId,
            tombstone: true,
            entity: "Pipe",
            patch: {},
          });
          return { ok: true as const };
        }),
      ),

    /** What's been deleted, newest first. */
    deleted: p.read.query(async ({ ctx }) => {
      const rows = await listDeleted(ctx.tx, pipe, { orgId: ctx.organizationId });
      return rows.map((row) => ({ ...toPipeDto(row), ...deletedStamp(row) }));
    }),

    /** What deleting this pipe would mean, for the confirmation dialog. */
    deleteImpact: p.remove.input(z.object({ id: EntityId })).query(async ({ ctx, input }): Promise<DeleteImpact> => {
      const orgId = ctx.organizationId;
      const row = await loadEffective(ctx.tx, pipe, { orgId, id: input.id, branch: MAIN });
      if (!row || row.isDeleted) throw new TRPCError({ code: "NOT_FOUND", message: "Pipe not found" });
      const stranded = await nodesStrandedBy(ctx.tx, orgId, row);
      return {
        blockers: await collectBlockers([() => assertPipeServesNobody(ctx.tx, orgId, MAIN, input.id)]),
        connected: await connectionsOnPipe(ctx.tx, orgId, MAIN, input.id),
        warnings: stranded.length ? [`${stranded.join(" and ")} will have no pipes left, so traces won't reach ${stranded.length === 1 ? "it" : "them"}.`] : [],
        openJobs: await openJobsOn(ctx, input.id),
      };
    }),

    /** Undo a delete. Both end nodes have to be live, or the pipe would lead nowhere. */
    restore: p.remove.input(z.object({ id: EntityId })).mutation(async ({ ctx, input }) =>
      guarded(async () => {
        await assertBranchWritable(ctx, MAIN);
        const { row, restored } = await restoreVersioned(ctx.tx, pipe, { orgId: ctx.organizationId, userId: ctx.session.user.id, id: input.id, entity: "Pipe" });
        const ends = await listEffective(ctx.tx, node, { orgId: ctx.organizationId, branch: MAIN, where: inArray(node.id, [row.fromNodeId, row.toNodeId]) });
        if (ends.length !== 2) throw new TRPCError({ code: "CONFLICT", message: "A node at one end of this pipe is deleted: restore that first" });
        if (restored) await ctx.audit({ action: "gis.restore", subjectType: "gis_pipe", subjectId: row.id, after: { versionId: row.versionId } });
        return toPipeDto(row);
      }),
    ),
  });
}
