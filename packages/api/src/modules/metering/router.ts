import { READING_STATUSES } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { procedureEnv } from "../../kernel/action-env";
import { accountVisibleTo, servicePointOf, visibleAccountIds, type Viewer } from "../accounts";
import { router } from "../../trpc";
import { bulkDueInputSchema, bulkSchedule } from "./bulk";
import { listSnapshots, readingTasks, snapshotById, snapshotFor, snapshotsInputSchema, takeSnapshot, takeSnapshotInputSchema, type SnapshotView } from "./eligibility";
import { handoversInputSchema, linkClosingInputSchema, linkClosingReading, listHandovers } from "./handover";
import { attemptInputSchema, attemptsFor, attemptsInputSchema, outcomeMapping, recordAttempt } from "./outcomes";
import { consecutiveEstimates, consecutiveMisses } from "./policy";
import { installationsInputSchema, installInputSchema, installMeter, listInstallations, removeInputSchema, removeMeter, replaceInputSchema, replaceMeter } from "./installations";
import { meteringProcedures as p } from "./procedures";
import { latestActualReading, queryReadings, readingById } from "./reads";
import {
  approveInputSchema,
  approveReading,
  correctInputSchema,
  correctReading,
  estimateInputSchema,
  recordEstimate,
  recordInputSchema,
  recordReading,
  voidInputSchema,
  voidReading,
} from "./readings";
import { changeMeterStatus, listInputSchema, listMeters, meterDetail, registerInputSchema, registerMeter, statusInputSchema } from "./register";
import type { Transaction as Tx } from "@flowless/db";

/** K-03: a limited viewer meets NOT_FOUND for anything on an account they cannot see. Called after the change; the throw rolls it back. */
async function assertVisible(tx: Tx, viewer: Viewer, accountId: string | null): Promise<void> {
  if (viewer.scope.kind === "all") return;
  if (!accountId || !(await accountVisibleTo(tx, viewer, accountId))) throw new TRPCError({ code: "NOT_FOUND", message: "Reading not found" });
}

/** K-03: a limited viewer sees only the snapshot rows of accounts they can see. */
async function visibleSnapshot(tx: Tx, viewer: Viewer, snapshot: SnapshotView): Promise<SnapshotView> {
  if (viewer.scope.kind === "all") return snapshot;
  const visible = new Set(await visibleAccountIds(tx, viewer));
  return { ...snapshot, rows: snapshot.rows.filter((r) => visible.has(r.accountId)) };
}

/**
 * The Metering router (M-01 to M-07, M-11), mounted at `metering`:
 * - `meters.*`, `installations.*`: the register, its lifecycle, installation and replacement.
 * - `readings.*`: append-only readings, validation at entry, review and correction.
 */
export const meteringRouter = router({
  meters: router({
    list: p.meters.input(listInputSchema.default({ limit: 50 })).query(({ ctx, input }) => listMeters(ctx.tx, input)),
    get: p.meters.input(z.object({ meterId: z.uuid() })).query(({ ctx, input }) => meterDetail(ctx.tx, input.meterId)),
    register: p.register.input(registerInputSchema).mutation(({ ctx, input }) => registerMeter(procedureEnv(ctx), input)),
    changeStatus: p.register.input(statusInputSchema).mutation(({ ctx, input }) => changeMeterStatus(procedureEnv(ctx), input)),
  }),

  installations: router({
    list: p.meters.input(installationsInputSchema.default({ limit: 50 })).query(({ ctx, input }) => listInstallations(ctx.tx, input)),
    install: p.register.input(installInputSchema).mutation(({ ctx, input }) => installMeter(procedureEnv(ctx), input)),
    remove: p.register.input(removeInputSchema).mutation(({ ctx, input }) => removeMeter(procedureEnv(ctx), input)),
    /** M-07: swap the meter on a service point, capturing the old final and the new initial reading. */
    replace: p.register.input(replaceInputSchema).mutation(async ({ ctx, input }) => {
      const result = await replaceMeter(procedureEnv(ctx), input);
      await assertVisible(ctx.tx, ctx.viewer, result.finalReading.accountId);
      return result;
    }),
  }),

  readings: router({
    /** M-02 to M-05: record a reading under a client-minted id; validation flags keep a doubtful one out of automatic billing. */
    record: p.capture.input(recordInputSchema).mutation(async ({ ctx, input }) => {
      const { source, ...rest } = input;
      const result = await recordReading(procedureEnv(ctx), rest, { source });
      await assertVisible(ctx.tx, ctx.viewer, result.reading.accountId);
      return result;
    }),
    /** M-03: an estimate, stored as its own type; never a baseline. */
    recordEstimate: p.approve.input(estimateInputSchema).mutation(async ({ ctx, input }) => {
      const result = await recordEstimate(procedureEnv(ctx), input);
      await assertVisible(ctx.tx, ctx.viewer, result.reading.accountId);
      return result;
    }),
    /** Replaces a reading with a corrected one; the old one is superseded. */
    correct: p.approve.input(correctInputSchema).mutation(async ({ ctx, input }) => {
      const result = await correctReading(procedureEnv(ctx), input);
      await assertVisible(ctx.tx, ctx.viewer, result.reading.accountId);
      return result;
    }),
    approve: p.approve.input(approveInputSchema).mutation(async ({ ctx, input }) => {
      const result = await approveReading(procedureEnv(ctx), input);
      await assertVisible(ctx.tx, ctx.viewer, result.reading.accountId);
      return result;
    }),
    void: p.approve.input(voidInputSchema).mutation(async ({ ctx, input }) => {
      const result = await voidReading(procedureEnv(ctx), input);
      await assertVisible(ctx.tx, ctx.viewer, result.reading.accountId);
      return result;
    }),
    get: p.read.input(z.object({ readingId: z.uuid() })).query(async ({ ctx, input }) => {
      const found = await readingById(ctx.tx, input.readingId);
      if (!found) throw new TRPCError({ code: "NOT_FOUND", message: "Reading not found" });
      await assertVisible(ctx.tx, ctx.viewer, found.accountId);
      return found;
    }),
    list: p.read
      .input(
        z
          .object({
            meterId: z.uuid().optional(),
            servicePointId: z.uuid().optional(),
            accountId: z.uuid().optional(),
            status: z.enum(READING_STATUSES).optional(),
            /** Only readings waiting for review: valid, not cleared. */
            needsReview: z.boolean().optional(),
            before: z.date().optional(),
            limit: z.number().int().min(1).max(200).default(50),
          })
          .default({ limit: 50 }),
      )
      .query(async ({ ctx, input }) => {
        if (input.accountId) await assertVisible(ctx.tx, ctx.viewer, input.accountId);
        const where = [
          ...(input.meterId ? [sql`r.meter_id = ${input.meterId}`] : []),
          ...(input.servicePointId ? [sql`r.service_point_id = ${input.servicePointId}`] : []),
          ...(input.accountId ? [sql`r.account_id = ${input.accountId}`] : []),
          ...(input.status ? [sql`s.status = ${input.status}`] : []),
          ...(input.needsReview ? [sql`s.status = 'valid' and not s.cleared`] : []),
          ...(input.before ? [sql`r.read_at < ${input.before.toISOString()}::timestamptz`] : []),
        ];
        if (ctx.viewer.scope.kind !== "all") {
          const visible = await visibleAccountIds(ctx.tx, ctx.viewer);
          where.push(visible.length ? sql`r.account_id in (${sql.join(visible.map((id) => sql`${id}`), sql`, `)})` : sql`false`);
        }
        return queryReadings(ctx.tx, { where, limit: input.limit });
      }),
    /** The latest reading that may be a baseline for a meter or service point. */
    latestActual: p.read
      .input(z.object({ meterId: z.uuid().optional(), servicePointId: z.uuid().optional(), asOf: z.date().optional() }).refine((v) => v.meterId || v.servicePointId, "Give a meter or a service point"))
      .query(async ({ ctx, input }) => {
        const found = await latestActualReading(ctx.tx, input);
        if (found) await assertVisible(ctx.tx, ctx.viewer, found.accountId);
        return found;
      }),
  }),
  /** M-06, M-09: visits to read a service point, with the outcome the reader found. */
  attempts: router({
    record: p.capture.input(attemptInputSchema).mutation(async ({ ctx, input }) => {
      const result = await recordAttempt(procedureEnv(ctx), input);
      await assertVisible(ctx.tx, ctx.viewer, result.attempt.accountId);
      return result;
    }),
    list: p.read.input(attemptsInputSchema.default({ limit: 50 })).query(async ({ ctx, input }) => {
      if (input.accountId) await assertVisible(ctx.tx, ctx.viewer, input.accountId);
      return attemptsFor(ctx.tx, ctx.viewer.scope.kind === "all" ? input : { ...input, accountIds: await visibleAccountIds(ctx.tx, ctx.viewer) });
    }),
  }),

  outcomes: router({
    /** What each outcome means for billing in this organization (`metering.outcomes` over the engine's defaults). */
    mapping: p.read.query(({ ctx }) => outcomeMapping(ctx.tx)),
  }),

  misses: router({
    /** The derived counters of a service point: visits without a reading, and estimates in a row. */
    get: p.read.input(z.object({ servicePointId: z.uuid() })).query(async ({ ctx, input }) => {
      const sp = await servicePointOf(ctx.tx, input.servicePointId);
      if (!sp) throw new TRPCError({ code: "NOT_FOUND", message: "Service point not found" });
      await assertVisible(ctx.tx, ctx.viewer, sp.accountId);
      return { servicePointId: input.servicePointId, consecutiveMisses: await consecutiveMisses(ctx.tx, input.servicePointId), consecutiveEstimates: await consecutiveEstimates(ctx.tx, input.servicePointId) };
    }),
  }),

  /** M-08: the eligibility snapshot per route and cycle date, and the reading tasks derived from it. */
  snapshots: router({
    take: p.register.input(takeSnapshotInputSchema).mutation(async ({ ctx, input }) => {
      const result = await takeSnapshot(procedureEnv(ctx), input);
      return { ...result, snapshot: await visibleSnapshot(ctx.tx, ctx.viewer, result.snapshot) };
    }),
    list: p.read.input(snapshotsInputSchema.default({ limit: 20 })).query(({ ctx, input }) => listSnapshots(ctx.tx, input)),
    get: p.read.input(z.union([z.object({ snapshotId: z.uuid() }), z.object({ routeId: z.uuid(), cycleDate: z.iso.date() })])).query(async ({ ctx, input }) => {
      const found = "snapshotId" in input ? await snapshotById(ctx.tx, input.snapshotId) : await snapshotFor(ctx.tx, input.routeId, input.cycleDate);
      if (!found) throw new TRPCError({ code: "NOT_FOUND", message: "Snapshot not found" });
      return visibleSnapshot(ctx.tx, ctx.viewer, found);
    }),
    tasks: p.read.input(z.object({ snapshotId: z.uuid() })).query(async ({ ctx, input }) => {
      const found = await snapshotById(ctx.tx, input.snapshotId);
      if (!found) throw new TRPCError({ code: "NOT_FOUND", message: "Snapshot not found" });
      const visible = ctx.viewer.scope.kind === "all" ? undefined : new Set(await visibleAccountIds(ctx.tx, ctx.viewer));
      return readingTasks(ctx.tx, found, visible);
    }),
  }),

  /** C-08, C-10: closing readings owed when an account changes hands or holder. */
  handovers: router({
    list: p.read.input(handoversInputSchema.default({ limit: 50 })).query(async ({ ctx, input }) =>
      listHandovers(ctx.tx, ctx.viewer.scope.kind === "all" ? input : { ...input, accountIds: await visibleAccountIds(ctx.tx, ctx.viewer) }),
    ),
    linkClosing: p.approve.input(linkClosingInputSchema).mutation(async ({ ctx, input }) => {
      const result = await linkClosingReading(procedureEnv(ctx), input);
      const linked = await readingById(ctx.tx, result.readingId);
      await assertVisible(ctx.tx, ctx.viewer, linked?.accountId ?? null);
      return result;
    }),
  }),

  /** M-12: bulk and master meters due for reading by their DMA's schedule. */
  bulk: router({
    schedule: p.meters.input(bulkDueInputSchema.default({})).query(({ ctx, input }) => bulkSchedule(ctx.tx, input.asOf)),
  }),
});
