import type { Transaction } from "@flowless/db";
import { installation, reading, readingStatus } from "@flowless/db/schema/metering";
import { READING_FLAGS, READING_PURPOSES, READING_QUALITIES, READING_SOURCES, type ReadingFlag } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { ActionEnv, UserActionEnv } from "../../kernel/action-env";
import { readSetting } from "../../kernel/config-store";
import { isUniqueViolation } from "../../kernel/pg-errors";
import { raiseException, resolveByDedupeKey } from "../../kernel/exception-store";
import { regionalSetting } from "../../kernel/regional";
import { servicePointOf } from "../accounts";
import { closedThrough } from "../tariffs";
import { applyReadingPolicy } from "./policy";
import { readingRecorded, readingStatusChanged } from "./events";
import { queryReadings, readingById, type ReadingView } from "./reads";
import { meteringValidationSetting } from "./settings";
import { fingerprintOf, ID_REUSED, lockMeter } from "./steps";
import { blocks, validateReading, type Neighbour } from "./validate";

/*
 * Recording readings (M-02 to M-05, M-07, M-11). Everything goes through `recordReading`:
 * it locks the meter (readings of one meter take turns), replays a retried client id, finds
 * the installation the reading belongs to, validates against the derived neighbours, appends
 * the reading with its first status row, raises an exception for a blocking flag and
 * publishes `metering.reading_recorded`. Readings are never updated; approving, voiding and
 * superseding are new status rows.
 */

const FUTURE_SLACK_MS = 10 * 60 * 1000;

export const recordInputSchema = z.object({
  /** The reading's id, minted by the device or caller: a retried sync returns the same reading (M-04). */
  id: z.uuid().optional(),
  meterId: z.uuid(),
  value: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  readAt: z.date(),
  source: z.enum(READING_SOURCES.filter((s) => s !== "estimate") as ["technician", "office", "customer", "import"]),
  quality: z.enum(READING_QUALITIES).default("good"),
  note: z.string().trim().max(1000).default(""),
  /** A `kernel.file` id of the photo; the file is attached to the reading afterwards with subject kind `reading`. */
  photoFileId: z.uuid().optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  /** The technician confirms the dial wrapped (M-07). Only counts when the value is below the previous reading. */
  rolloverConfirmed: z.boolean().default(false),
});
export type RecordInput = z.infer<typeof recordInputSchema>;

export const estimateInputSchema = z.object({
  id: z.uuid().optional(),
  meterId: z.uuid(),
  value: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  readAt: z.date(),
  note: z.string().trim().max(1000).default(""),
});

export const correctInputSchema = recordInputSchema.omit({ meterId: true, readAt: true }).extend({
  readingId: z.uuid(),
  /** Defaults to the corrected reading's own time. */
  readAt: z.date().optional(),
  reason: z.string().trim().min(1, "Say why").max(500),
});

/** What `recordReading` needs beyond the input. */
export interface RecordOptions {
  source: (typeof READING_SOURCES)[number];
  purpose?: (typeof READING_PURPOSES)[number];
  replaces?: string;
  /** Use this installation instead of finding the one covering `readAt` (a replacement closes one and opens another in the same step). */
  installationId?: string;
  reason?: string;
}

export type Recorded = { reading: ReadingView; replayed: boolean };

/** The installation of this meter that covers the instant, or undefined. */
export async function installationAt(tx: Transaction, meterId: string, at: Date) {
  const [row] = await tx
    .select()
    .from(installation)
    .where(and(eq(installation.meterId, meterId), lte(installation.installedAt, at), or(sql`${installation.removedAt} is null`, sql`${installation.removedAt} >= ${at.toISOString()}::timestamptz`)))
    .orderBy(desc(installation.installedAt))
    .limit(1);
  return row;
}

const clearedActual = (alias: string) => sql.raw(`${alias}.source <> 'estimate' and s.status = 'valid' and s.cleared`);

async function neighbours(tx: Transaction, meterId: string, readAt: Date, ignoring: string | null, historySize: number) {
  const at = readAt.toISOString();
  const skip = ignoring ? [sql`r.id <> ${ignoring}`] : [];
  const rows = (await queryReadings(tx, { where: [sql`r.meter_id = ${meterId}`, clearedActual("r"), sql`r.read_at < ${at}::timestamptz`, ...skip], limit: historySize + 1 })).map<Neighbour>((r) => ({ value: r.value, readAt: r.readAt }));
  const next = (await queryReadings(tx, { where: [sql`r.meter_id = ${meterId}`, clearedActual("r"), sql`r.read_at > ${at}::timestamptz`, ...skip], limit: 1, order: "asc" })).map<Neighbour>((r) => ({ value: r.value, readAt: r.readAt }));
  return { previous: rows[0] ?? null, history: rows.slice(1), next: next[0] ?? null };
}

async function sameDay(tx: Transaction, meterId: string, readAt: Date, ignoring: string | null, timeZone: string): Promise<boolean> {
  const rows = await queryReadings(tx, {
    where: [
      sql`r.meter_id = ${meterId}`,
      sql`s.status = 'valid'`,
      sql`r.source <> 'estimate' and r.purpose = 'routine'`,
      sql`(r.read_at at time zone ${timeZone})::date = (${readAt.toISOString()}::timestamptz at time zone ${timeZone})::date`,
      ...(ignoring ? [sql`r.id <> ${ignoring}`] : []),
    ],
    limit: 1,
  });
  return rows.length > 0;
}

/** M-11: the instant falls on or before the last day of the latest closed period. */
async function inClosedPeriod(tx: Transaction, organizationId: string, readAt: Date): Promise<boolean> {
  const closed = await closedThrough(tx, organizationId);
  return closed !== null && readAt.toISOString().slice(0, 10) <= closed.toISOString().slice(0, 10);
}

export async function recordReading(env: ActionEnv, input: Omit<RecordInput, "source"> & { photoFileId?: string | undefined }, options: RecordOptions): Promise<Recorded> {
  const purpose = options.purpose ?? "routine";
  const estimate = options.source === "estimate";
  const fingerprint = fingerprintOf({ meterId: input.meterId, value: input.value, readAt: input.readAt, source: options.source, purpose, replaces: options.replaces });

  if (input.id) {
    const [earlier] = await env.tx.select().from(reading).where(eq(reading.id, input.id));
    if (earlier) {
      if (earlier.fingerprint !== fingerprint || earlier.readerUserId !== env.actor.userId) throw new TRPCError({ code: "CONFLICT", message: ID_REUSED });
      return { reading: (await readingById(env.tx, earlier.id))!, replayed: true };
    }
  }

  const m = await lockMeter(env.tx, input.meterId);
  if (input.readAt.getTime() > Date.now() + FUTURE_SLACK_MS) throw new TRPCError({ code: "BAD_REQUEST", message: "A reading cannot be dated in the future" });
  if (input.value >= 10 ** m.dialDigits) throw new TRPCError({ code: "BAD_REQUEST", message: `A ${m.dialDigits}-digit dial cannot show ${input.value}` });

  const inst = options.installationId
    ? (await env.tx.select().from(installation).where(eq(installation.id, options.installationId)))[0]
    : await installationAt(env.tx, m.id, input.readAt);
  if (!inst) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "That meter was not installed on a service point at the time of the reading" });

  const sp = await servicePointOf(env.tx, inst.servicePointId);
  const config = (await readSetting(env.tx, meteringValidationSetting)).value;
  const closed = await inClosedPeriod(env.tx, env.organizationId, input.readAt);

  let flags: ReadingFlag[] = closed ? ["CLOSED_PERIOD"] : [];
  let rollover = false;
  if (!estimate) {
    const near = await neighbours(env.tx, m.id, input.readAt, options.replaces ?? null, config.historyIntervals);
    const timeZone = (await readSetting(env.tx, regionalSetting)).value.timeZone;
    const verdict = validateReading(
      {
        value: input.value,
        readAt: input.readAt,
        dialDigits: m.dialDigits,
        purpose,
        rolloverConfirmed: input.rolloverConfirmed,
        previous: near.previous,
        next: near.next,
        history: near.history,
        sameDayDuplicate: await sameDay(env.tx, m.id, input.readAt, options.replaces ?? null, timeZone),
        inClosedPeriod: closed,
      },
      config,
    );
    flags = verdict.flags;
    rollover = verdict.rollover;
  }
  const cleared = !blocks(flags);

  let row: typeof reading.$inferSelect;
  try {
    [row] = (await env.tx
      .insert(reading)
      .values({
        ...(input.id ? { id: input.id } : {}),
        organizationId: env.organizationId,
        meterId: m.id,
        installationId: inst.id,
        servicePointId: inst.servicePointId,
        accountId: sp?.accountId ?? null,
        value: input.value,
        readAt: input.readAt,
        source: options.source,
        purpose,
        readerUserId: env.actor.userId,
        photoFileId: input.photoFileId ?? null,
        latitude: input.latitude ?? null,
        longitude: input.longitude ?? null,
        quality: input.quality,
        note: input.note,
        flags,
        replacesReadingId: options.replaces ?? null,
        fingerprint,
      })
      .returning()) as [typeof reading.$inferSelect];
  } catch (error) {
    if (isUniqueViolation(error)) throw new TRPCError({ code: "CONFLICT", message: options.replaces ? "That reading was already corrected" : "That id is already in use" });
    throw error;
  }
  await env.tx.insert(readingStatus).values({ organizationId: env.organizationId, readingId: row.id, status: "valid", cleared, rolloverConfirmed: rollover, reason: "", actorUserId: env.actor.userId, source: env.source });

  if (options.replaces) {
    await env.tx.insert(readingStatus).values({ organizationId: env.organizationId, readingId: options.replaces, status: "superseded", cleared: false, reason: options.reason ?? "Corrected", actorUserId: env.actor.userId, source: env.source });
    await resolveByDedupeKey(env.tx, `reading:${options.replaces}`, "The reading was corrected");
  }

  if (!cleared) {
    const why = flags.filter((f) => READING_FLAGS[f].blocking).map((f) => READING_FLAGS[f].label);
    await raiseException(env.tx, env.organizationId, {
      type: "READING_EXCEPTION",
      source: "metering",
      title: `Reading ${input.value} needs review on meter ${m.serial}`,
      detail: why.join("; "),
      subject: { kind: "reading", ref: row.id },
      areaId: sp?.areaId ?? null,
      routeId: sp?.routeId ?? null,
      ownerUserId: env.actor.userId,
      dedupeKey: `reading:${row.id}`,
    });
  }

  await env.audit({ action: "metering.reading_record", subjectType: "reading", subjectId: row.id, after: { meterId: m.id, value: row.value, readAt: row.readAt, source: row.source, purpose, flags, cleared } });
  await env.publish(readingRecorded, {
    readingId: row.id,
    meterId: m.id,
    servicePointId: row.servicePointId,
    accountId: row.accountId,
    value: row.value,
    readAt: row.readAt.toISOString(),
    source: row.source,
    purpose,
    flags,
    cleared,
    rolloverConfirmed: rollover,
    inClosedPeriod: closed,
    replacesReadingId: row.replacesReadingId,
  });
  const view = (await readingById(env.tx, row.id))!;
  await applyReadingPolicy(env, view, { servicePointId: row.servicePointId, accountId: row.accountId, areaId: sp?.areaId ?? null, routeId: sp?.routeId ?? null });
  return { reading: view, replayed: false };
}

/** M-03: an estimate is stored as a reading of its own type, never a baseline. */
export function recordEstimate(env: UserActionEnv, input: z.infer<typeof estimateInputSchema>) {
  return recordReading(env, { ...input, quality: "good", rolloverConfirmed: false }, { source: "estimate" });
}

/** Replaces a reading with a corrected one; the old one is superseded (M-02). */
export async function correctReading(env: UserActionEnv, input: z.infer<typeof correctInputSchema>): Promise<Recorded> {
  const old = await readingById(env.tx, input.readingId);
  if (!old) throw new TRPCError({ code: "NOT_FOUND", message: "Reading not found" });
  const [earlier] = input.id ? await env.tx.select().from(reading).where(eq(reading.id, input.id)) : [];
  if (earlier && earlier.replacesReadingId !== old.id) throw new TRPCError({ code: "CONFLICT", message: ID_REUSED });
  // A retry of the same correction replays inside recordReading; a new one needs a valid reading (the unique index also refuses a second correction).
  if (!earlier && old.status !== "valid") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `That reading is ${old.status}; only a valid reading can be corrected` });
  const { readingId, reason, readAt, source, ...rest } = input;
  return recordReading(env, { ...rest, meterId: old.meterId, readAt: readAt ?? old.readAt }, { source, replaces: readingId, reason, purpose: old.purpose });
}

async function statusChange(env: UserActionEnv, current: ReadingView, next: { status: "valid" | "voided"; cleared: boolean; rolloverConfirmed: boolean; reason: string }, action: string) {
  await env.tx.insert(readingStatus).values({ organizationId: env.organizationId, readingId: current.id, status: next.status, cleared: next.cleared, rolloverConfirmed: next.rolloverConfirmed, reason: next.reason, actorUserId: env.actor.userId, source: env.source });
  await resolveByDedupeKey(env.tx, `reading:${current.id}`, next.reason);
  await env.audit({ action, subjectType: "reading", subjectId: current.id, before: { status: current.status, cleared: current.cleared }, after: { status: next.status, cleared: next.cleared, rolloverConfirmed: next.rolloverConfirmed }, reason: next.reason });
  await env.publish(readingStatusChanged, { readingId: current.id, meterId: current.meterId, servicePointId: current.servicePointId, accountId: current.accountId, status: next.status, cleared: next.cleared, rolloverConfirmed: next.rolloverConfirmed, reason: next.reason });
}

export const approveInputSchema = z.object({
  readingId: z.uuid(),
  /** Confirm the dial wrapped (M-07): needed for a reading that dropped below the previous one. */
  rollover: z.boolean().default(false),
  reason: z.string().trim().min(1, "Say why").max(500),
});

/** A reviewer clears a flagged reading for billing. Repeating it changes nothing. */
export async function approveReading(env: UserActionEnv, input: z.infer<typeof approveInputSchema>) {
  const first = await readingById(env.tx, input.readingId);
  if (!first) throw new TRPCError({ code: "NOT_FOUND", message: "Reading not found" });
  await lockMeter(env.tx, first.meterId);
  const current = (await readingById(env.tx, input.readingId))!;
  if (current.status !== "valid") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `That reading is ${current.status}` });
  if (current.cleared && current.rolloverConfirmed === input.rollover) return { reading: current, replayed: true };
  if (current.kind === "estimate") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "An estimate is not reviewed" });
  if (input.rollover) {
    const capacity = 10 ** current.dialDigits;
    const fraction = (await readSetting(env.tx, meteringValidationSetting)).value.rolloverMaxFraction;
    if (current.previousValue === null || current.value >= current.previousValue || capacity - current.previousValue + current.value >= capacity * fraction) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "That reading cannot be a rollover: it must be below the previous one by less than the dial's range allows" });
    }
  }
  await statusChange(env, current, { status: "valid", cleared: true, rolloverConfirmed: input.rollover, reason: input.reason }, "metering.reading_approve");
  return { reading: (await readingById(env.tx, current.id))!, replayed: false };
}

export const voidInputSchema = z.object({ readingId: z.uuid(), reason: z.string().trim().min(1, "Say why").max(500) });

/** Takes a reading out of use. It stays in the history. Repeating it changes nothing. */
export async function voidReading(env: UserActionEnv, input: z.infer<typeof voidInputSchema>) {
  const first = await readingById(env.tx, input.readingId);
  if (!first) throw new TRPCError({ code: "NOT_FOUND", message: "Reading not found" });
  await lockMeter(env.tx, first.meterId);
  const current = (await readingById(env.tx, input.readingId))!;
  if (current.status === "voided") return { reading: current, replayed: true };
  if (current.status === "superseded") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "That reading was already corrected" });
  await statusChange(env, current, { status: "voided", cleared: false, rolloverConfirmed: false, reason: input.reason }, "metering.reading_void");
  return { reading: (await readingById(env.tx, current.id))!, replayed: false };
}
