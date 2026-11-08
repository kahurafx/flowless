import { workOrder } from "@flowless/db/schema/work-orders";
import { workLevel } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { loadEntitlements } from "../../kernel/entitlement-store";
import { defineFileSubject } from "../../kernel/file-subjects";
import { abilitiesOf, canActOn, canSeeJob, seesJobs, visibilityFor } from "./access";
import { crewIdsOf } from "./procedures";

/**
 * Photos and documents on a job (K-08, W-02), ported from Majimap's attachments rules for
 * work orders. Reading follows the job's visibility; adding needs to be able to act on it
 * (its assignee, crew or a manager); nothing changes on a cancelled job. Adding after
 * completion stays allowed (a device that finished offline uploads its photos afterwards),
 * but taking evidence off a submitted or finished job is a manager's call.
 */
export const workOrderFileSubject = defineFileSubject({
  kind: "work_order",
  module: ["work-orders", "gis"],
  label: "Work order",
  async authorize(ctx, subjectId, mode) {
    const abilities = abilitiesOf(ctx.permissions);
    const notFound = () => new TRPCError({ code: "NOT_FOUND", message: "Work order not found" });
    if (!seesJobs(abilities) || !/^[0-9a-f-]{36}$/i.test(subjectId)) throw notFound();
    const [order] = await ctx.tx.select().from(workOrder).where(eq(workOrder.id, subjectId));
    if (!order) throw notFound();
    const full = workLevel(await loadEntitlements(ctx.tx)) === "full";
    const visibility = visibilityFor(abilities, ctx.userId, full ? await crewIdsOf(ctx.tx, ctx.userId) : [], await ctx.scope());
    // A job the caller may not see is reported as missing, so ids can't be probed.
    if (!canSeeJob(visibility, order)) throw notFound();
    if (mode === "read") return { manage: abilities.assign };
    if (!canActOn(abilities, visibility, order)) throw new TRPCError({ code: "FORBIDDEN", message: "Only the job's assignee, crew or a supervisor can change its files" });
    if (order.status === "cancelled") throw new TRPCError({ code: "CONFLICT", message: "This job is cancelled" });
    if (mode === "remove" && (order.status === "completed" || order.status === "submitted") && !abilities.assign) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Evidence on a submitted or finished job can only be removed by a supervisor" });
    }
    return { manage: abilities.assign };
  },
});
