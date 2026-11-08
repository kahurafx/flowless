import type { Transaction } from "@flowless/db";
import { asset, conditionLog, node, pipe, structure, valveStateLog } from "@flowless/db/schema/gis";
import { ASSET_CONDITIONS, type AssetCondition } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { router } from "../../trpc";
import { BranchSchema, deviceTime, EntityId, guarded, MAIN } from "./common";
import { assetDeleted, notDeletedAsset } from "./deleted";
import { emit, gisConditionChanged } from "./events";
import type { GisProcedures } from "./procedures";
import { branchAllowsWrite } from "./versioning/branch-write";
import { editVersioned, loadEffective } from "./versioning/engine";

type ConditionLogRow = typeof conditionLog.$inferSelect;
type ValveStateLogRow = typeof valveStateLog.$inferSelect;
type Inspectable = "node" | "pipe" | "structure";

/** An inspection, with the kind of asset it was on and the branch it was logged on. */
export function toConditionLogDto(row: ConditionLogRow, kind: Inspectable) {
  return {
    id: row.id,
    assetId: row.assetId,
    assetType: kind,
    nodeId: kind === "node" ? row.assetId : null,
    pipeId: kind === "pipe" ? row.assetId : null,
    structureId: kind === "structure" ? row.assetId : null,
    condition: row.condition,
    note: row.note,
    recordedAt: row.recordedAt,
    recordedByUserId: row.recordedByUserId,
    syncedAt: row.syncedAt,
    branch: row.branch,
  };
}

/** A valve operation, with its note and the branch it was logged on. */
export function toValveStateLogDto(row: ValveStateLogRow) {
  return {
    id: row.id,
    nodeId: row.valveId,
    isOpen: row.isOpen,
    changedAt: row.changedAt,
    changedByUserId: row.changedByUserId,
    syncedAt: row.syncedAt,
    note: row.note,
    branch: row.branch,
  };
}

const Condition = z.enum(ASSET_CONDITIONS);
const NoteInput = z.string().trim().max(2000).nullable().default(null);
const LimitInput = z.number().int().min(1).max(200).default(50);
const cleanNote = (note: string | null) => (note && note.length > 0 ? note : null);

/** What kind of asset an id is, which also confirms it's this organization's (RLS). */
async function resolveAssetKind(tx: Transaction, assetId: string): Promise<Inspectable> {
  const [found] = await tx.select({ kind: asset.kind }).from(asset).where(eq(asset.id, assetId)).limit(1);
  if (!found) throw new TRPCError({ code: "NOT_FOUND", message: "Asset not found" });
  if (found.kind === "service_connection") throw new TRPCError({ code: "BAD_REQUEST", message: "A service connection isn't something that gets inspected" });
  return found.kind;
}

/** The kinds of many assets at once, for log lists. */
async function kindsOf(tx: Transaction, ids: readonly string[]): Promise<Map<string, Inspectable>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ id: asset.id, kind: asset.kind })
    .from(asset)
    .where(inArray(asset.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, r.kind === "service_connection" ? "node" : r.kind]));
}

async function conditionDtos(tx: Transaction, rows: ConditionLogRow[]) {
  const kinds = await kindsOf(
    tx,
    rows.map((r) => r.assetId),
  );
  return rows.map((r) => toConditionLogDto(r, kinds.get(r.assetId) ?? "node"));
}

const tableFor = (kind: Inspectable) => (kind === "pipe" ? pipe : kind === "structure" ? structure : node);

/**
 * How a record landed:
 * - `applied`: the asset's own record was updated to match.
 * - `unchanged`: nothing about the asset needed to change.
 * - `stale`: kept as history, but the asset was left alone: a newer observation already
 *   exists, or the caller may not change the asset on that branch (a closed job's branch,
 *   someone else's, or main without `gis:post`). An offline device syncing last week's
 *   inspection must not undo this morning's.
 * - `replayed`: this exact record had already arrived (a retried sync); nothing happened.
 */
type Outcome = "applied" | "unchanged" | "stale" | "replayed";

/**
 * Inspection and valve logs (G-02), ported from Majimap. A log is a fact and is always
 * kept (append-only); the asset edit it implies is an ordinary versioned edit on `branch`,
 * so on a job's branch it is a proposal reviewed with the job. Logs recorded for a job go
 * on the job's branch: Work Orders only links a log recorded there.
 */
export function logsRouter(p: GisProcedures) {
  return router({
    recordCondition: p.edit
      .input(
        z.object({
          /** Supply one from the device so a retried sync can't create a duplicate. */
          id: EntityId.optional(),
          assetId: EntityId,
          branch: BranchSchema.default(MAIN),
          condition: Condition,
          note: NoteInput,
          /** When the inspection happened, by the device's clock. Defaults to now. */
          recordedAt: z.date().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const recordedAt = deviceTime(input.recordedAt);
        const note = cleanNote(input.note);
        return guarded(async () => {
          const id = input.id ?? randomUUID();
          const [existing] = await ctx.tx.select().from(conditionLog).where(eq(conditionLog.id, id)).limit(1);
          if (existing) return { log: (await conditionDtos(ctx.tx, [existing]))[0]!, outcome: "replayed" as Outcome };

          const kind = await resolveAssetKind(ctx.tx, input.assetId);
          const result = (row: ConditionLogRow, outcome: Outcome) => ({ log: toConditionLogDto(row, kind), outcome });
          const table = tableFor(kind);
          const current = (await loadEffective(ctx.tx, table, { orgId: ctx.organizationId, id: input.assetId, branch: input.branch })) as
            | { versionId: string; isDeleted: boolean; condition: AssetCondition; lastInspectedAt?: Date | null }
            | undefined;
          if (!current) throw new TRPCError({ code: "NOT_FOUND", message: "Asset not found" });
          if (current.isDeleted) throw assetDeleted();

          const [latest] = await ctx.tx
            .select({ recordedAt: conditionLog.recordedAt })
            .from(conditionLog)
            .where(eq(conditionLog.assetId, input.assetId))
            .orderBy(desc(conditionLog.recordedAt))
            .limit(1);
          const stale = latest !== undefined && latest.recordedAt.getTime() > recordedAt.getTime();

          const [row] = await ctx.tx
            .insert(conditionLog)
            .values({
              id,
              organizationId: ctx.organizationId,
              assetId: input.assetId,
              branch: input.branch,
              condition: input.condition,
              note,
              recordedAt,
              recordedByUserId: ctx.session.user.id,
            })
            .returning();
          if (stale) return result(row!, "stale");
          if (!(await branchAllowsWrite(ctx, input.branch))) return result(row!, "stale");

          const patch: Record<string, unknown> = {};
          if (current.condition !== input.condition) patch.condition = input.condition;
          // Pipes have no last-inspected date, so only nodes and structures move it.
          if (kind !== "pipe" && (!current.lastInspectedAt || current.lastInspectedAt.getTime() < recordedAt.getTime())) patch.lastInspectedAt = recordedAt;
          if (Object.keys(patch).length === 0) return result(row!, "unchanged");

          // The log is a fact and must survive. If the asset moved under us (a concurrent edit),
          // the edit runs in a savepoint so its failure can't take the log down: `stale`.
          try {
            await ctx.tx.transaction(async (sp) => {
              const { previous, next } = await editVersioned(sp, table, {
                orgId: ctx.organizationId,
                userId: ctx.session.user.id,
                id: input.assetId,
                branch: input.branch,
                baseVersionId: current.versionId,
                tombstone: false,
                entity: "Asset",
                patch,
              });
              if (input.branch === MAIN && patch.condition !== undefined) {
                await emit(sp, ctx.organizationId, gisConditionChanged, {
                  assetId: input.assetId,
                  from: previous.condition as AssetCondition,
                  to: next.condition as AssetCondition,
                  changedByUserId: ctx.session.user.id,
                });
              }
            });
          } catch (err) {
            if (err instanceof TRPCError && err.code === "CONFLICT") return result(row!, "stale");
            throw err;
          }
          return result(row!, "applied");
        });
      }),

    /** Log that a valve was opened or closed, and bring the valve's recorded state into line: same rules as an inspection. */
    recordValveState: p.edit
      .input(
        z.object({
          id: EntityId.optional(),
          valveId: EntityId,
          branch: BranchSchema.default(MAIN),
          isOpen: z.boolean(),
          note: NoteInput,
          /** When the valve was operated, by the device's clock. Defaults to now. */
          changedAt: z.date().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const changedAt = deviceTime(input.changedAt);
        const note = cleanNote(input.note);
        return guarded(async () => {
          const id = input.id ?? randomUUID();
          const result = (row: ValveStateLogRow, outcome: Outcome) => ({ log: toValveStateLogDto(row), outcome });
          const [existing] = await ctx.tx.select().from(valveStateLog).where(eq(valveStateLog.id, id)).limit(1);
          if (existing) return result(existing, "replayed");

          const valve = await loadEffective(ctx.tx, node, { orgId: ctx.organizationId, id: input.valveId, branch: input.branch });
          if (!valve) throw new TRPCError({ code: "NOT_FOUND", message: "Valve not found" });
          if (valve.isDeleted) throw assetDeleted("valve");
          if (valve.type !== "valve") throw new TRPCError({ code: "BAD_REQUEST", message: "That node isn't a valve" });

          const [latest] = await ctx.tx
            .select({ changedAt: valveStateLog.changedAt })
            .from(valveStateLog)
            .where(eq(valveStateLog.valveId, input.valveId))
            .orderBy(desc(valveStateLog.changedAt))
            .limit(1);
          const stale = latest !== undefined && latest.changedAt.getTime() > changedAt.getTime();

          const [row] = await ctx.tx
            .insert(valveStateLog)
            .values({
              id,
              organizationId: ctx.organizationId,
              valveId: input.valveId,
              branch: input.branch,
              isOpen: input.isOpen,
              note,
              changedAt,
              changedByUserId: ctx.session.user.id,
            })
            .returning();
          if (stale) return result(row!, "stale");
          if (!(await branchAllowsWrite(ctx, input.branch))) return result(row!, "stale");
          if (valve.isOpen === input.isOpen) return result(row!, "unchanged");
          try {
            await ctx.tx.transaction(async (sp) => {
              await editVersioned(sp, node, {
                orgId: ctx.organizationId,
                userId: ctx.session.user.id,
                id: input.valveId,
                branch: input.branch,
                baseVersionId: valve.versionId,
                tombstone: false,
                entity: "Valve",
                patch: { isOpen: input.isOpen },
              });
            });
          } catch (err) {
            if (err instanceof TRPCError && err.code === "CONFLICT") return result(row!, "stale");
            throw err;
          }
          return result(row!, "applied");
        });
      }),

    /** An asset's inspections, newest first by when they happened. */
    conditionHistory: p.read.input(z.object({ assetId: EntityId, limit: LimitInput })).query(async ({ ctx, input }) => {
      const kind = await resolveAssetKind(ctx.tx, input.assetId);
      const rows = await ctx.tx.select().from(conditionLog).where(eq(conditionLog.assetId, input.assetId)).orderBy(desc(conditionLog.recordedAt)).limit(input.limit);
      return rows.map((r) => toConditionLogDto(r, kind));
    }),

    /** A valve's open/close history, newest first by when it happened. */
    valveHistory: p.read.input(z.object({ valveId: EntityId, limit: LimitInput })).query(async ({ ctx, input }) => {
      await resolveAssetKind(ctx.tx, input.valveId);
      const rows = await ctx.tx.select().from(valveStateLog).where(eq(valveStateLog.valveId, input.valveId)).orderBy(desc(valveStateLog.changedAt)).limit(input.limit);
      return rows.map(toValveStateLogDto);
    }),

    /** Recent inspections across the whole organization: what an alerts or activity view is built from. */
    conditionFeed: p.read
      .input(
        z
          .object({
            /** Only these conditions, e.g. `["poor", "critical"]` for an alerts view. */
            conditions: z.array(Condition).min(1).optional(),
            since: z.date().optional(),
            limit: LimitInput,
          })
          .default({ limit: 50 }),
      )
      .query(async ({ ctx, input }) => {
        const rows = await ctx.tx
          .select()
          .from(conditionLog)
          .where(
            and(
              notDeletedAsset(conditionLog.assetId),
              input.conditions ? inArray(conditionLog.condition, input.conditions) : undefined,
              input.since ? gte(conditionLog.recordedAt, input.since) : undefined,
            ),
          )
          .orderBy(desc(conditionLog.recordedAt))
          .limit(input.limit);
        return conditionDtos(ctx.tx, rows);
      }),

    /** Recent valve operations across the whole organization, so a device can show history without asking valve by valve. */
    valveFeed: p.read
      .input(z.object({ since: z.date().optional(), limit: LimitInput }).default({ limit: 50 }))
      .query(async ({ ctx, input }) => {
        const rows = await ctx.tx
          .select()
          .from(valveStateLog)
          .where(and(notDeletedAsset(valveStateLog.valveId), input.since ? gte(valveStateLog.changedAt, input.since) : undefined))
          .orderBy(desc(valveStateLog.changedAt))
          .limit(input.limit);
        return rows.map(toValveStateLogDto);
      }),
  });
}
