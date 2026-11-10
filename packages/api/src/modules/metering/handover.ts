import type { Transaction } from "@flowless/db";
import { handoverClosing, installation, meter, readingHandover } from "@flowless/db/schema/metering";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { systemEnv, type UserActionEnv } from "../../kernel/action-env";
import { raiseException, resolveByDedupeKey } from "../../kernel/exception-store";
import { regionalSetting } from "../../kernel/regional";
import { readSetting } from "../../kernel/config-store";
import { servicePointOf, type ReadingHandover } from "../accounts";
import { readingHandoverOpened } from "./events-policy";
import { queryReadings, readingById } from "./reads";

/*
 * Reading handover (C-08, C-10): when an account changes hands (succession) or holder (change
 * of name), the meter on each of its service points needs a closing reading for the old
 * account or holder. Accounts asks through its `registerReadingHandover` port, inside the
 * command's transaction. For each service point with a meter Metering records one
 * `reading_handover` (keyed by the Accounts command, so a retry changes nothing), links a
 * cleared actual reading taken on the effective date when there is one, and otherwise leaves
 * the closing reading pending: an exception in the queue until someone links the reading
 * (`handovers.linkClosing`). Whether a closing reading is pending is derived from the link
 * table, not stored.
 */

const handoverKey = (id: string) => `handover:${id}`;

/** The port Accounts calls. Metering registers it with `requires: ["metering"]`. */
export const readingHandoverPort: ReadingHandover = async (tx, organizationId, request) => {
  const env = systemEnv(tx, organizationId);
  const timeZone = (await readSetting(tx, regionalSetting)).value.timeZone;
  let pending = false;
  const found: string[] = [];
  for (const servicePointId of request.servicePointIds) {
    const [open] = await tx
      .select({ meterId: installation.meterId })
      .from(installation)
      .innerJoin(meter, and(eq(meter.organizationId, installation.organizationId), eq(meter.id, installation.meterId)))
      .where(and(eq(installation.servicePointId, servicePointId), isNull(installation.removedAt), eq(meter.kind, "customer")));
    if (!open) continue;

    const inserted = await tx
      .insert(readingHandover)
      .values({ organizationId, commandId: request.commandId, reason: request.reason, fromAccountId: request.fromAccountId, toAccountId: request.toAccountId, servicePointId, meterId: open.meterId, effectiveDate: request.effectiveDate })
      .onConflictDoNothing()
      .returning();
    const [row] = inserted.length ? inserted : await tx.select().from(readingHandover).where(and(eq(readingHandover.commandId, request.commandId), eq(readingHandover.servicePointId, servicePointId)));
    const [linked] = await tx.select().from(handoverClosing).where(eq(handoverClosing.handoverId, row!.id));
    let closingId = linked?.readingId ?? null;
    if (!closingId) {
      const day = await queryReadings(tx, {
        where: [
          sql`r.meter_id = ${open.meterId}`,
          sql`r.source <> 'estimate'`,
          sql`s.status = 'valid' and s.cleared`,
          sql`(r.read_at at time zone ${timeZone})::date = ${request.effectiveDate}::date`,
        ],
        limit: 1,
      });
      closingId = day[0]?.id ?? null;
      if (closingId) await tx.insert(handoverClosing).values({ handoverId: row!.id, organizationId, readingId: closingId });
    }
    if (inserted.length) {
      await env.publish(readingHandoverOpened, { handoverId: row!.id, commandId: request.commandId, servicePointId, meterId: open.meterId, effectiveDate: request.effectiveDate, closingReadingId: closingId });
      await env.audit({ action: "metering.handover_open", subjectType: "reading_handover", subjectId: row!.id, after: { reason: request.reason, servicePointId, closingReadingId: closingId } });
    }
    if (closingId) found.push(closingId);
    else {
      pending = true;
      const sp = await servicePointOf(tx, servicePointId);
      await raiseException(tx, organizationId, {
        type: "READING_EXCEPTION",
        source: "metering",
        title: "Closing reading needed",
        detail: `The account ${request.reason === "succession" ? "changed hands" : "changed holder"} on ${request.effectiveDate}; take the meter reading for that day and link it.`,
        subject: { kind: "meter", ref: open.meterId },
        areaId: sp?.areaId ?? null,
        routeId: sp?.routeId ?? null,
        dedupeKey: handoverKey(row!.id),
      });
    }
  }
  return { closingReadingRef: !pending ? (found[0] ?? null) : null, closingReadingPending: pending };
};

export const linkClosingInputSchema = z.object({ handoverId: z.uuid(), readingId: z.uuid() });

/** Links the closing reading to a pending handover (an actual reading of the same meter, not an estimate). */
export async function linkClosingReading(env: UserActionEnv, input: z.infer<typeof linkClosingInputSchema>) {
  const [row] = await env.tx.select().from(readingHandover).where(eq(readingHandover.id, input.handoverId));
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Handover not found" });
  const [linked] = await env.tx.select().from(handoverClosing).where(eq(handoverClosing.handoverId, row.id));
  if (linked) {
    if (linked.readingId !== input.readingId) throw new TRPCError({ code: "CONFLICT", message: "That handover already has a closing reading" });
    return { handoverId: row.id, readingId: linked.readingId, replayed: true };
  }
  const r = await readingById(env.tx, input.readingId);
  if (!r || r.meterId !== row.meterId) throw new TRPCError({ code: "NOT_FOUND", message: "Reading not found on that handover's meter" });
  if (r.kind === "estimate" || r.status !== "valid") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The closing reading must be a valid actual reading" });
  await env.tx.insert(handoverClosing).values({ handoverId: row.id, organizationId: env.organizationId, readingId: r.id, linkedByUserId: env.actor.userId });
  await resolveByDedupeKey(env.tx, handoverKey(row.id), "Closing reading linked");
  await env.audit({ action: "metering.handover_link", subjectType: "reading_handover", subjectId: row.id, after: { readingId: r.id } });
  return { handoverId: row.id, readingId: r.id, replayed: false };
}

export const handoversInputSchema = z.object({ pending: z.boolean().optional(), servicePointId: z.uuid().optional(), limit: z.number().int().min(1).max(200).default(50) });

export interface HandoverView {
  id: string;
  commandId: string;
  reason: "succession" | "change_name";
  fromAccountId: string;
  toAccountId: string;
  servicePointId: string;
  meterId: string;
  effectiveDate: string;
  closingReadingId: string | null;
  pending: boolean;
}

/** Handovers, newest first, with whether the closing reading is still pending (derived). */
export async function listHandovers(tx: Transaction, input: z.infer<typeof handoversInputSchema> & { accountIds?: readonly string[] }): Promise<HandoverView[]> {
  const rows = await tx
    .select({ h: readingHandover, readingId: handoverClosing.readingId })
    .from(readingHandover)
    .leftJoin(handoverClosing, eq(handoverClosing.handoverId, readingHandover.id))
    .where(
      and(
        input.servicePointId ? eq(readingHandover.servicePointId, input.servicePointId) : undefined,
        input.pending === undefined ? undefined : input.pending ? isNull(handoverClosing.readingId) : sql`${handoverClosing.readingId} is not null`,
        input.accountIds ? (input.accountIds.length ? sql`(${readingHandover.fromAccountId} in (${sql.join(input.accountIds.map((i) => sql`${i}`), sql`, `)}) or ${readingHandover.toAccountId} in (${sql.join(input.accountIds.map((i) => sql`${i}`), sql`, `)}))` : sql`false`) : undefined,
      ),
    )
    .orderBy(desc(readingHandover.createdAt))
    .limit(input.limit);
  return rows.map(({ h, readingId }) => ({
    id: h.id,
    commandId: h.commandId,
    reason: h.reason,
    fromAccountId: h.fromAccountId,
    toAccountId: h.toAccountId,
    servicePointId: h.servicePointId,
    meterId: h.meterId,
    effectiveDate: h.effectiveDate,
    closingReadingId: readingId,
    pending: readingId === null,
  }));
}
