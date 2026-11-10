import { READING_STATUSES } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { procedureEnv } from "../../kernel/action-env";
import { accountVisibleTo, visibleAccountIds, type Viewer } from "../accounts";
import { router } from "../../trpc";
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
});
