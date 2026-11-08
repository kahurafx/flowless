import type { Transaction } from "@flowless/db";
import { pipe, serviceConnection } from "@flowless/db/schema/gis";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { router } from "../../trpc";
import { BranchSchema, EntityId, GeoPointInput, guarded, MAIN, nonEmpty, VersionId } from "./common";
import { deletedStamp, openJobsOn, type DeleteImpact } from "./deleted";
import { emit, gisConnectionPosted } from "./events";
import type { GisProcedures } from "./procedures";
import { assertBranchWritable } from "./versioning/branch-write";
import { claimEntityId, editVersioned, insertAsset, listDeleted, listEffective, loadEffective, restoreVersioned } from "./versioning/engine";

type ConnectionRow = typeof serviceConnection.$inferSelect;

/**
 * A service connection: where a supply leaves the network, ported from Majimap without
 * its customers. GIS holds no customers: `servicePointId` is the Accounts service point, by
 * id only, null until Accounts links one. A connection going live publishes
 * `gis.connection_posted` for Accounts.
 */
export function toConnectionDto(row: ConnectionRow) {
  return {
    id: row.id,
    versionId: row.versionId,
    branch: row.branch,
    connectionNumber: row.connectionNumber,
    location: row.location,
    servicePointId: row.servicePointId,
    pipeId: row.pipeId,
  };
}
export type ConnectionDto = ReturnType<typeof toConnectionDto>;

export async function listConnections(tx: Transaction, orgId: string, branch: string): Promise<ConnectionDto[]> {
  return (await listEffective(tx, serviceConnection, { orgId, branch })).map(toConnectionDto);
}

async function assertPipeExists(tx: Transaction, orgId: string, branch: string, pipeId: string | null | undefined) {
  if (!pipeId) return;
  const [found] = await listEffective(tx, pipe, { orgId, branch, where: eq(pipe.id, pipeId) });
  if (!found) throw new TRPCError({ code: "BAD_REQUEST", message: "That pipe isn't on the network" });
}

const ConnectionNumberInput = z.string().trim().min(1).max(60);

export function connectionsRouter(p: GisProcedures) {
  return router({
    list: p.read
      .input(z.object({ branch: BranchSchema.default(MAIN) }).optional())
      .query(({ ctx, input }) => listConnections(ctx.tx, ctx.organizationId, input?.branch ?? MAIN)),

    byId: p.read.input(z.object({ id: EntityId, branch: BranchSchema.default(MAIN) })).query(async ({ ctx, input }) => {
      const row = await loadEffective(ctx.tx, serviceConnection, { orgId: ctx.organizationId, id: input.id, branch: input.branch });
      if (!row || row.isDeleted) throw new TRPCError({ code: "NOT_FOUND", message: "Connection not found" });
      return toConnectionDto(row);
    }),

    /**
     * Capture a connection. On a branch it waits for review; created straight on main (by
     * someone who may post) it is live at once and announced to Accounts.
     */
    create: p.edit
      .input(
        z.object({
          id: EntityId.optional(),
          branch: BranchSchema.default(MAIN),
          connectionNumber: ConnectionNumberInput,
          location: GeoPointInput,
          servicePointId: EntityId.nullable().default(null),
          pipeId: EntityId.nullable().default(null),
        }),
      )
      .mutation(async ({ ctx, input }) =>
        guarded(async () => {
          const id = input.id ?? randomUUID();
          const replay = await claimEntityId(ctx.tx, serviceConnection, { orgId: ctx.organizationId, id, branch: input.branch });
          if (replay) return toConnectionDto(replay);
          await assertBranchWritable(ctx, input.branch);
          await assertPipeExists(ctx.tx, ctx.organizationId, input.branch, input.pipeId);
          await insertAsset(ctx.tx, { orgId: ctx.organizationId, id, kind: "service_connection", userId: ctx.session.user.id });
          const [row] = await ctx.tx
            .insert(serviceConnection)
            .values({
              id,
              organizationId: ctx.organizationId,
              branch: input.branch,
              createdByUserId: ctx.session.user.id,
              connectionNumber: input.connectionNumber,
              location: input.location,
              servicePointId: input.servicePointId,
              pipeId: input.pipeId,
            })
            .returning();
          if (input.branch === MAIN) {
            await emit(ctx.tx, ctx.organizationId, gisConnectionPosted, {
              connectionId: id,
              connectionNumber: row!.connectionNumber,
              location: row!.location,
              servicePointId: row!.servicePointId,
              pipeId: row!.pipeId,
              branch: MAIN,
              postedByUserId: ctx.session.user.id,
            });
          }
          return toConnectionDto(row!);
        }),
      ),

    /** Correct the number or position, or link it to the pipe that serves it. */
    update: p.edit
      .input(
        z.object({
          id: EntityId,
          baseVersionId: VersionId,
          branch: BranchSchema.default(MAIN),
          patch: z
            .object({ connectionNumber: ConnectionNumberInput, location: GeoPointInput, pipeId: EntityId.nullable() })
            .partial()
            .refine(nonEmpty, "Patch is empty"),
        }),
      )
      .mutation(async ({ ctx, input }) =>
        guarded(async () => {
          await assertBranchWritable(ctx, input.branch);
          await assertPipeExists(ctx.tx, ctx.organizationId, input.branch, input.patch.pipeId);
          const { next } = await editVersioned(ctx.tx, serviceConnection, {
            orgId: ctx.organizationId,
            userId: ctx.session.user.id,
            id: input.id,
            branch: input.branch,
            baseVersionId: input.baseVersionId,
            patch: Object.fromEntries(Object.entries(input.patch).filter(([, value]) => value !== undefined)),
            tombstone: false,
            entity: "Connection",
          });
          return toConnectionDto(next);
        }),
      ),

    /** Takes the map feature away. The account stays: it is Accounts', with its own history. */
    delete: p.remove
      .input(z.object({ id: EntityId, baseVersionId: VersionId, branch: BranchSchema.default(MAIN) }))
      .mutation(async ({ ctx, input }) =>
        guarded(async () => {
          await assertBranchWritable(ctx, input.branch);
          await editVersioned(ctx.tx, serviceConnection, {
            orgId: ctx.organizationId,
            userId: ctx.session.user.id,
            id: input.id,
            branch: input.branch,
            baseVersionId: input.baseVersionId,
            patch: {},
            tombstone: true,
            entity: "Connection",
          });
          return { ok: true as const };
        }),
      ),

    deleted: p.read.query(async ({ ctx }) => {
      const rows = await listDeleted(ctx.tx, serviceConnection, { orgId: ctx.organizationId });
      return rows.map((row) => ({ ...toConnectionDto(row), ...deletedStamp(row) }));
    }),

    deleteImpact: p.remove.input(z.object({ id: EntityId })).query(
      async ({ ctx, input }): Promise<DeleteImpact> => ({ blockers: [], connected: [], warnings: [], openJobs: await openJobsOn(ctx, input.id) }),
    ),

    /** Undo a delete. Its number might have been reused since, or its pipe deleted, and either refuses. */
    restore: p.remove.input(z.object({ id: EntityId })).mutation(async ({ ctx, input }) =>
      guarded(async () => {
        await assertBranchWritable(ctx, MAIN);
        const { row, restored } = await restoreVersioned(ctx.tx, serviceConnection, { orgId: ctx.organizationId, userId: ctx.session.user.id, id: input.id, entity: "Connection" });
        if (row.pipeId) {
          const [served] = await listEffective(ctx.tx, pipe, { orgId: ctx.organizationId, branch: MAIN, where: eq(pipe.id, row.pipeId) });
          if (!served) throw new TRPCError({ code: "CONFLICT", message: "The pipe serving this connection is deleted: restore that first" });
        }
        if (restored) await ctx.audit({ action: "gis.restore", subjectType: "gis_connection", subjectId: row.id, after: { versionId: row.versionId } });
        return toConnectionDto(row);
      }),
    ),
  });
}
