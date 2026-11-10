import { dispositionFor as engineDisposition, DEFAULT_OUTCOME_MAPPING, type OutcomeMapping } from "@flowless/billing-engine";
import type { Transaction } from "@flowless/db";
import { installation, readAttempt } from "@flowless/db/schema/metering";
import { ATTEMPT_MAX_TAGS, DISPOSITIONS, READING_OUTCOMES, READING_QUALITIES, type Disposition, type ReadingOutcome } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { UserActionEnv } from "../../kernel/action-env";
import { readSetting } from "../../kernel/config-store";
import { servicePointOf } from "../accounts";
import { readingAttempted } from "./events-policy";
import { applyMissPolicy, consecutiveMisses } from "./policy";
import { meteringOutcomesSetting } from "./policy-settings";
import { readingById, type ReadingView } from "./reads";
import { recordReading } from "./readings";
import { fingerprintOf, ID_REUSED } from "./steps";

/*
 * Reading outcomes (M-06) and the visits they describe (M-09). Every visit to a service point
 * is a `read_attempt`: what the reader found (one of the engine's eight outcomes), condition
 * tags, a note and a photo. `read_ok` carries the reading; the others carry none and Billing
 * decides by the disposition the organization maps the outcome to (`metering.outcomes`,
 * defaulting to the engine's mapping). Attempts are append-only; the consecutive-miss counter
 * is derived from them (`policy.ts`).
 */

/** A deterministic uuid from a seed, so a retried attempt derives the same reading id. */
export function derivedId(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** The organization's outcome mapping: its overrides over the engine's defaults. */
export async function outcomeMapping(tx: Transaction): Promise<Record<ReadingOutcome, Disposition>> {
  const stored = (await readSetting(tx, meteringOutcomesSetting)).value;
  const overrides: OutcomeMapping = Object.fromEntries(Object.entries(stored).filter(([, v]) => v !== undefined));
  return Object.fromEntries(READING_OUTCOMES.map((o) => [o, engineDisposition(o, overrides)])) as Record<ReadingOutcome, Disposition>;
}

/** Published (M-06): what Billing does for an outcome in this organization. */
export async function dispositionFor(tx: Transaction, outcome: ReadingOutcome): Promise<Disposition> {
  return (await outcomeMapping(tx))[outcome];
}

export { DEFAULT_OUTCOME_MAPPING };

const readingEntrySchema = z.object({
  /** Minted from the attempt id when left out. */
  id: z.uuid().optional(),
  value: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  readAt: z.date().optional(),
  source: z.enum(["technician", "office", "customer", "import"]).default("technician"),
  quality: z.enum(READING_QUALITIES).default("good"),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  rolloverConfirmed: z.boolean().default(false),
});

export const attemptInputSchema = z.object({
  /** Minted by the device: a retried sync returns the same attempt (M-04). */
  id: z.uuid().optional(),
  servicePointId: z.uuid(),
  outcome: z.enum(READING_OUTCOMES),
  tags: z.array(z.string().trim().min(1).max(40)).max(ATTEMPT_MAX_TAGS).default([]),
  note: z.string().trim().max(1000).default(""),
  photoFileId: z.uuid().optional(),
  attemptedAt: z.date(),
  /** The eligibility snapshot's cycle date this visit serves. */
  cycleDate: z.iso.date().optional(),
  /** Required for `read_ok`, refused for every other outcome. */
  reading: readingEntrySchema.optional(),
});
export type AttemptInput = z.infer<typeof attemptInputSchema>;

export interface AttemptView {
  id: string;
  servicePointId: string;
  accountId: string | null;
  meterId: string | null;
  cycleDate: string | null;
  outcome: ReadingOutcome;
  disposition: Disposition;
  tags: string[];
  note: string;
  photoFileId: string | null;
  readingId: string | null;
  readerUserId: string | null;
  attemptedAt: Date;
}

type AttemptRow = typeof readAttempt.$inferSelect;

function toView(row: AttemptRow, disposition: Disposition): AttemptView {
  return {
    id: row.id,
    servicePointId: row.servicePointId,
    accountId: row.accountId,
    meterId: row.meterId,
    cycleDate: row.cycleDate,
    outcome: row.outcome,
    disposition,
    tags: row.tags,
    note: row.note,
    photoFileId: row.photoFileId,
    readingId: row.readingId,
    readerUserId: row.readerUserId,
    attemptedAt: row.attemptedAt,
  };
}

const FUTURE_SLACK_MS = 10 * 60 * 1000;

/** Records one visit (M-06). A `read_ok` visit records its reading through the same path as `readings.record`. */
export async function recordAttempt(env: UserActionEnv, input: AttemptInput): Promise<{ attempt: AttemptView; reading: ReadingView | null; consecutiveMisses: number; replayed: boolean }> {
  const mapping = await outcomeMapping(env.tx);
  const fingerprint = fingerprintOf({
    servicePointId: input.servicePointId,
    outcome: input.outcome,
    tags: input.tags,
    note: input.note,
    at: input.attemptedAt,
    cycle: input.cycleDate,
    value: input.reading?.value,
  });
  if (input.id) {
    const [earlier] = await env.tx.select().from(readAttempt).where(eq(readAttempt.id, input.id));
    if (earlier) {
      if (earlier.fingerprint !== fingerprint || earlier.readerUserId !== env.actor.userId) throw new TRPCError({ code: "CONFLICT", message: ID_REUSED });
      return { attempt: toView(earlier, mapping[earlier.outcome]), reading: earlier.readingId ? await readingById(env.tx, earlier.readingId) : null, consecutiveMisses: await consecutiveMisses(env.tx, earlier.servicePointId), replayed: true };
    }
  }
  if (input.attemptedAt.getTime() > Date.now() + FUTURE_SLACK_MS) throw new TRPCError({ code: "BAD_REQUEST", message: "A visit cannot be dated in the future" });
  if (input.outcome === "read_ok" && !input.reading) throw new TRPCError({ code: "BAD_REQUEST", message: "A successful read needs the reading" });
  if (input.outcome !== "read_ok" && input.reading) throw new TRPCError({ code: "BAD_REQUEST", message: "Only a successful read carries a reading" });

  const sp = await servicePointOf(env.tx, input.servicePointId);
  if (!sp) throw new TRPCError({ code: "NOT_FOUND", message: "Service point not found" });
  const [open] = await env.tx
    .select({ id: installation.id, meterId: installation.meterId })
    .from(installation)
    .where(and(eq(installation.servicePointId, input.servicePointId), sql`${installation.removedAt} is null`))
    .orderBy(desc(installation.installedAt))
    .limit(1);

  const attemptId = input.id ?? crypto.randomUUID();
  let recorded: ReadingView | null = null;
  if (input.reading) {
    if (!open) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "That service point has no meter installed" });
    const { source, readAt, id, ...rest } = input.reading;
    recorded = (
      await recordReading(
        env,
        { ...rest, id: id ?? derivedId(`attempt:${attemptId}`), meterId: open.meterId, readAt: readAt ?? input.attemptedAt, note: input.note, photoFileId: input.photoFileId },
        { source },
      )
    ).reading;
  }

  const [row] = await env.tx
    .insert(readAttempt)
    .values({
      id: attemptId,
      organizationId: env.organizationId,
      servicePointId: input.servicePointId,
      accountId: sp.accountId,
      meterId: open?.meterId ?? null,
      cycleDate: input.cycleDate ?? null,
      outcome: input.outcome,
      tags: input.tags,
      note: input.note,
      photoFileId: input.photoFileId ?? null,
      readingId: recorded?.id ?? null,
      readerUserId: env.actor.userId,
      source: env.source,
      attemptedAt: input.attemptedAt,
      fingerprint,
    })
    .returning();
  const misses = await consecutiveMisses(env.tx, input.servicePointId);
  await env.audit({ action: "metering.attempt_record", subjectType: "reading_attempt", subjectId: row!.id, after: { servicePointId: input.servicePointId, outcome: input.outcome, disposition: mapping[input.outcome], tags: input.tags } });
  await env.publish(readingAttempted, {
    attemptId: row!.id,
    servicePointId: input.servicePointId,
    accountId: sp.accountId,
    meterId: open?.meterId ?? null,
    cycleDate: input.cycleDate ?? null,
    outcome: input.outcome,
    disposition: mapping[input.outcome],
    readingId: recorded?.id ?? null,
    attemptedAt: input.attemptedAt.toISOString(),
    consecutiveMisses: misses,
  });
  if (input.outcome !== "read_ok") {
    await applyMissPolicy(env, { servicePointId: sp.servicePointId, accountId: sp.accountId, areaId: sp.areaId, routeId: sp.routeId }, misses, input.cycleDate ?? null);
  }
  return { attempt: toView(row!, mapping[row!.outcome]), reading: recorded, consecutiveMisses: misses, replayed: false };
}

export const attemptsInputSchema = z.object({
  servicePointId: z.uuid().optional(),
  accountId: z.uuid().optional(),
  cycleDate: z.iso.date().optional(),
  outcome: z.enum(READING_OUTCOMES).optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

/** Visits, newest first. Published (M-06) for Billing, which decides a cycle's accounts by their latest disposition. */
export async function attemptsFor(tx: Transaction, f: z.infer<typeof attemptsInputSchema> & { accountIds?: readonly string[] }): Promise<AttemptView[]> {
  const mapping = await outcomeMapping(tx);
  const rows = await tx
    .select()
    .from(readAttempt)
    .where(
      and(
        f.servicePointId ? eq(readAttempt.servicePointId, f.servicePointId) : undefined,
        f.accountId ? eq(readAttempt.accountId, f.accountId) : undefined,
        f.cycleDate ? eq(readAttempt.cycleDate, f.cycleDate) : undefined,
        f.outcome ? eq(readAttempt.outcome, f.outcome) : undefined,
        f.accountIds ? (f.accountIds.length ? sql`${readAttempt.accountId} in (${sql.join(f.accountIds.map((id) => sql`${id}`), sql`, `)})` : sql`false`) : undefined,
      ),
    )
    .orderBy(desc(readAttempt.attemptedAt), desc(readAttempt.recordedAt))
    .limit(f.limit);
  return rows.map((r) => toView(r, mapping[r.outcome]));
}

export { DISPOSITIONS };
