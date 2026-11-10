import type { Transaction } from "@flowless/db";
import { installation, meter, meterEvent } from "@flowless/db/schema/metering";
import { canMoveMeter, MAX_DIAL_DIGITS, METER_KINDS, METER_STATUSES, MIN_DIAL_DIGITS, type MeterStatus } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, gt, ilike, sql } from "drizzle-orm";
import { z } from "zod";
import type { UserActionEnv } from "../../kernel/action-env";
import { areasById } from "../../kernel/areas";
import { isUniqueViolation } from "../../kernel/pg-errors";
import { likeEscape } from "../../kernel/text";
import { meterStatusChanged } from "./events";
import { appendStep, earlierStep, fingerprintOf, ID_REUSED, lockMeter, moveMeter, type MeterRow } from "./steps";

/*
 * The meter register (M-01): model, serial, dial digits, status and a logged lifecycle.
 * `installed` is reached only through an installation and left only by removing the meter,
 * so a meter is `installed` exactly while it has an open installation.
 */

export const registerInputSchema = z.object({
  /** The meter's id, minted by the caller so a retry returns the same meter. */
  id: z.uuid().optional(),
  serial: z.string().trim().min(1).max(64),
  model: z.string().trim().max(120).default(""),
  dialDigits: z.number().int().min(MIN_DIAL_DIGITS).max(MAX_DIAL_DIGITS),
  /** Where the meter enters the register. */
  status: z.enum(["procured", "in_stock"]).default("in_stock"),
  note: z.string().trim().max(1000).default(""),
  /** M-12: a customer meter (default), or a bulk meter on a DMA / master meter on a scheme. */
  kind: z.enum(METER_KINDS).default("customer"),
  /** M-12: the DMA a bulk meter measures (a kernel area id); refused for a customer meter. */
  dmaId: z.uuid().optional(),
});

export const statusInputSchema = z.object({
  /** The id of this step in the meter's log. */
  id: z.uuid().optional(),
  meterId: z.uuid(),
  to: z.enum(METER_STATUSES),
  reason: z.string().trim().min(1, "Say why").max(500),
});

export function toMeterDto(m: MeterRow) {
  return { id: m.id, serial: m.serial, model: m.model, dialDigits: m.dialDigits, status: m.status, kind: m.kind, dmaId: m.dmaId, note: m.note, createdAt: m.createdAt };
}
export type MeterDto = ReturnType<typeof toMeterDto>;

export async function registerMeter(env: UserActionEnv, input: z.infer<typeof registerInputSchema>) {
  const fingerprint = fingerprintOf({ serial: input.serial.toLowerCase(), model: input.model, dialDigits: input.dialDigits, status: input.status, kind: input.kind, dmaId: input.dmaId });
  if (input.kind === "customer" && input.dmaId) throw new TRPCError({ code: "BAD_REQUEST", message: "Only a bulk or master meter measures a DMA" });
  if (input.dmaId && !(await areasById(env.tx, [input.dmaId])).has(input.dmaId)) throw new TRPCError({ code: "NOT_FOUND", message: "Area not found" });
  if (input.id) {
    const [earlier] = await env.tx.select().from(meter).where(eq(meter.id, input.id));
    if (earlier) {
      const [first] = await env.tx.select().from(meterEvent).where(and(eq(meterEvent.meterId, earlier.id), eq(meterEvent.kind, "register")));
      if (first?.fingerprint !== fingerprint || first.actorUserId !== env.actor.userId) throw new TRPCError({ code: "CONFLICT", message: ID_REUSED });
      return { meter: toMeterDto(earlier), replayed: true };
    }
  }
  let row: MeterRow;
  try {
    [row] = await env.tx
      .insert(meter)
      .values({ ...(input.id ? { id: input.id } : {}), organizationId: env.organizationId, serial: input.serial, model: input.model, dialDigits: input.dialDigits, status: input.status, kind: input.kind, dmaId: input.dmaId ?? null, note: input.note, createdByUserId: env.actor.userId })
      .returning() as [MeterRow];
  } catch (error) {
    if (isUniqueViolation(error)) throw new TRPCError({ code: "CONFLICT", message: `A meter with serial ${input.serial} is already in the register` });
    throw error;
  }
  const event = await appendStep(env, { meterId: row.id, kind: "register", from: null, to: input.status, reason: "Registered", fingerprint });
  await env.tx.update(meter).set({ statusEventId: event.id }).where(eq(meter.id, row.id));
  await env.audit({ action: "metering.meter_register", subjectType: "meter", subjectId: row.id, after: toMeterDto(row) });
  await env.publish(meterStatusChanged, { meterId: row.id, serial: row.serial, from: null, to: row.status, reason: "Registered" });
  return { meter: toMeterDto(row), replayed: false };
}

/** A lifecycle move that is not an installation or a removal (those are `installations.ts`). */
export async function changeMeterStatus(env: UserActionEnv, input: z.infer<typeof statusInputSchema>) {
  const fingerprint = fingerprintOf({ meterId: input.meterId, to: input.to, reason: input.reason });
  const earlier = await earlierStep(env, input.id, { meterId: input.meterId, kind: "status_change", fingerprint });
  const current = await lockMeter(env.tx, input.meterId);
  if (earlier) return { meter: toMeterDto(current), replayed: true };
  if (input.to === "installed" || current.status === "installed") {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "A meter is installed or removed through its installation" });
  }
  if (input.to === "replaced") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "A meter is marked replaced by replacing it on its service point" });
  if (!canMoveMeter(current.status, input.to)) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: `A meter that is ${current.status.replace("_", " ")} cannot become ${input.to.replace("_", " ")}` });
  }
  const { meter: updated } = await moveMeter(env, current, { id: input.id, meterId: current.id, kind: "status_change", from: current.status, to: input.to, reason: input.reason, fingerprint });
  await env.audit({ action: "metering.meter_status", subjectType: "meter", subjectId: current.id, before: { status: current.status }, after: { status: input.to }, reason: input.reason });
  await env.publish(meterStatusChanged, { meterId: current.id, serial: current.serial, from: current.status, to: input.to, reason: input.reason });
  return { meter: toMeterDto(updated), replayed: false };
}

export async function findMeter(tx: Transaction, meterId: string): Promise<MeterRow> {
  const [row] = await tx.select().from(meter).where(eq(meter.id, meterId));
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Meter not found" });
  return row;
}

export const listInputSchema = z.object({
  status: z.enum(METER_STATUSES).optional(),
  kind: z.enum(METER_KINDS).optional(),
  search: z.string().trim().max(64).optional(),
  after: z.string().max(64).optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

/** Meters by serial, keyset-paged. */
export async function listMeters(tx: Transaction, input: z.infer<typeof listInputSchema>) {
  const where = and(
    input.status ? eq(meter.status, input.status as MeterStatus) : undefined,
    input.kind ? eq(meter.kind, input.kind) : undefined,
    input.search ? ilike(meter.serial, `%${likeEscape(input.search)}%`) : undefined,
    input.after ? gt(sql`lower(${meter.serial})`, input.after.toLowerCase()) : undefined,
  );
  const rows = await tx.select().from(meter).where(where).orderBy(asc(sql`lower(${meter.serial})`)).limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  return { meters: page.map(toMeterDto), next: rows.length > input.limit ? page[page.length - 1]!.serial : null };
}

/** One meter with its open installation and its lifecycle log. */
export async function meterDetail(tx: Transaction, meterId: string) {
  const row = await findMeter(tx, meterId);
  const [open] = await tx.select().from(installation).where(and(eq(installation.meterId, meterId), sql`${installation.removedAt} is null`));
  const events = await tx.select().from(meterEvent).where(eq(meterEvent.meterId, meterId)).orderBy(asc(meterEvent.occurredAt));
  return {
    meter: toMeterDto(row),
    installation: open ? { id: open.id, servicePointId: open.servicePointId, installedAt: open.installedAt } : null,
    events: events.map((e) => ({ id: e.id, kind: e.kind, from: e.fromStatus, to: e.toStatus, reason: e.reason, actorUserId: e.actorUserId, source: e.source, occurredAt: e.occurredAt })),
  };
}
