import type { Transaction } from "@flowless/db";
import { installation, meter } from "@flowless/db/schema/metering";
import { canMoveMeter, READING_QUALITIES, type MeterStatus } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { UserActionEnv } from "../../kernel/action-env";
import { servicePointOf } from "../accounts";
import { meterInstalled, meterRemoved, meterReplaced } from "./events";
import { readingById, type ReadingView } from "./reads";
import { recordReading } from "./readings";
import { toMeterDto } from "./register";
import { earlierStep, fingerprintOf, lockMeter, moveMeter, type MeterRow } from "./steps";

/*
 * Installations (M-01) and meter replacement (M-07). A meter is `installed` exactly while it
 * has an open installation; a service point has at most one open installation. The service
 * point is an opaque Accounts id, checked through Accounts' published `servicePointOf`.
 * Replacing a meter captures the old meter's final reading and the new meter's initial
 * reading in one step; the work order that does it in the field is a Work Orders concern.
 */

const FUTURE_SLACK_MS = 10 * 60 * 1000;
const INSTALLABLE: readonly MeterStatus[] = ["in_stock", "issued", "tested"];

/** A reading taken at the moment of a meter change (its time is the change's). */
const boundaryReadingSchema = z.object({
  id: z.uuid().optional(),
  value: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  source: z.enum(["technician", "office"]).default("technician"),
  quality: z.enum(READING_QUALITIES).default("good"),
  note: z.string().trim().max(1000).default(""),
  photoFileId: z.uuid().optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  rolloverConfirmed: z.boolean().default(false),
});
type BoundaryReading = z.infer<typeof boundaryReadingSchema>;

export const installInputSchema = z.object({
  /** The id of this step in the meter's log: a retry returns the earlier install. */
  id: z.uuid().optional(),
  meterId: z.uuid(),
  servicePointId: z.uuid(),
  installedAt: z.date(),
  /** The meter's first reading, taken at installation. */
  initialReading: boundaryReadingSchema.optional(),
});

export const removeInputSchema = z.object({
  id: z.uuid().optional(),
  meterId: z.uuid(),
  removedAt: z.date(),
  /** Where the meter goes next. */
  to: z.enum(["in_stock", "tested", "replaced", "disposed"]).default("in_stock"),
  reason: z.string().trim().min(1, "Say why").max(500),
  /** The reading at removal. */
  finalReading: boundaryReadingSchema.optional(),
});

export const replaceInputSchema = z.object({
  id: z.uuid().optional(),
  oldMeterId: z.uuid(),
  newMeterId: z.uuid(),
  replacedAt: z.date(),
  reason: z.string().trim().min(1, "Say why").max(500),
  finalReading: boundaryReadingSchema,
  initialReading: boundaryReadingSchema,
});

const notFuture = (at: Date) => {
  if (at.getTime() > Date.now() + FUTURE_SLACK_MS) throw new TRPCError({ code: "BAD_REQUEST", message: "A meter change cannot be dated in the future" });
};

async function openInstallation(tx: Transaction, meterId: string) {
  const [row] = await tx.select().from(installation).where(and(eq(installation.meterId, meterId), sql`${installation.removedAt} is null`));
  return row;
}

async function boundary(env: UserActionEnv, meterId: string, at: Date, installationId: string, purpose: "initial" | "final", r: BoundaryReading): Promise<ReadingView> {
  const { source, ...rest } = r;
  return (await recordReading(env, { ...rest, meterId, readAt: at }, { source, purpose, installationId })).reading;
}

async function openAt(env: UserActionEnv, m: MeterRow, servicePointId: string, at: Date, extra: Record<string, unknown> = {}) {
  const sp = await servicePointOf(env.tx, servicePointId);
  if (!sp) throw new TRPCError({ code: "NOT_FOUND", message: "Service point not found" });
  const [taken] = await env.tx.select({ id: installation.id }).from(installation).where(and(eq(installation.servicePointId, servicePointId), sql`${installation.removedAt} is null`));
  if (taken) throw new TRPCError({ code: "CONFLICT", message: "That service point already has a meter; remove or replace it first" });
  const [last] = await env.tx.select({ removedAt: installation.removedAt }).from(installation).where(eq(installation.servicePointId, servicePointId)).orderBy(desc(installation.removedAt)).limit(1);
  if (last?.removedAt && at < last.removedAt) throw new TRPCError({ code: "BAD_REQUEST", message: "The service point had another meter until later than that" });
  const [inst] = await env.tx
    .insert(installation)
    .values({ organizationId: env.organizationId, meterId: m.id, servicePointId, installedAt: at, installedByUserId: env.actor.userId })
    .returning();
  return { inst: inst!, sp, extra };
}

export async function installMeter(env: UserActionEnv, input: z.infer<typeof installInputSchema>) {
  const fingerprint = fingerprintOf({ meterId: input.meterId, servicePointId: input.servicePointId, installedAt: input.installedAt, initial: input.initialReading?.value });
  const earlier = await earlierStep(env, input.id, { meterId: input.meterId, kind: "install", fingerprint });
  const m = await lockMeter(env.tx, input.meterId);
  if (earlier) return replayInstall(env.tx, earlier.payload as { installationId: string; initialReadingId: string | null }, m);
  notFuture(input.installedAt);
  if (!INSTALLABLE.includes(m.status)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `A meter that is ${m.status.replace("_", " ")} cannot be installed` });
  const { inst, sp } = await openAt(env, m, input.servicePointId, input.installedAt);
  const initial = input.initialReading ? await boundary(env, m.id, input.installedAt, inst.id, "initial", input.initialReading) : null;
  const moved = await moveMeter(env, m, {
    id: input.id,
    meterId: m.id,
    kind: "install",
    from: m.status,
    to: "installed",
    reason: "Installed",
    payload: { installationId: inst.id, servicePointId: input.servicePointId, initialReadingId: initial?.id ?? null },
    fingerprint,
  });
  await env.audit({ action: "metering.meter_install", subjectType: "meter", subjectId: m.id, after: { servicePointId: input.servicePointId, installedAt: input.installedAt } });
  await env.publish(meterInstalled, { meterId: m.id, installationId: inst.id, servicePointId: input.servicePointId, accountId: sp.accountId, installedAt: input.installedAt.toISOString() });
  return { meter: toMeterDto(moved.meter), installationId: inst.id, initialReading: initial, replayed: false };
}

async function replayInstall(tx: Transaction, payload: { installationId: string; initialReadingId: string | null }, m: MeterRow) {
  return {
    meter: toMeterDto(m),
    installationId: payload.installationId,
    initialReading: payload.initialReadingId ? await readingById(tx, payload.initialReadingId) : null,
    replayed: true,
  };
}

/** Closes the meter's open installation. */
async function closeInstallation(env: UserActionEnv, m: MeterRow, removedAt: Date) {
  const inst = await openInstallation(env.tx, m.id);
  if (!inst || m.status !== "installed") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "That meter is not installed" });
  if (removedAt < inst.installedAt) throw new TRPCError({ code: "BAD_REQUEST", message: "A meter cannot be removed before it was installed" });
  notFuture(removedAt);
  return inst;
}

async function endInstallation(env: UserActionEnv, instId: string, removedAt: Date, reason: string) {
  await env.tx.update(installation).set({ removedAt, removedByUserId: env.actor.userId, removalReason: reason }).where(eq(installation.id, instId));
}

export async function removeMeter(env: UserActionEnv, input: z.infer<typeof removeInputSchema>) {
  const fingerprint = fingerprintOf({ meterId: input.meterId, removedAt: input.removedAt, to: input.to, reason: input.reason, final: input.finalReading?.value });
  const earlier = await earlierStep(env, input.id, { meterId: input.meterId, kind: "remove", fingerprint });
  const m = await lockMeter(env.tx, input.meterId);
  if (earlier) {
    const p = earlier.payload as { finalReadingId: string | null };
    return { meter: toMeterDto(m), finalReading: p.finalReadingId ? await readingById(env.tx, p.finalReadingId) : null, replayed: true };
  }
  if (!canMoveMeter("installed", input.to)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `An installed meter cannot become ${input.to.replace("_", " ")}` });
  const inst = await closeInstallation(env, m, input.removedAt);
  const final = input.finalReading ? await boundary(env, m.id, input.removedAt, inst.id, "final", input.finalReading) : null;
  await endInstallation(env, inst.id, input.removedAt, input.reason);
  const moved = await moveMeter(env, m, {
    id: input.id,
    meterId: m.id,
    kind: "remove",
    from: m.status,
    to: input.to,
    reason: input.reason,
    payload: { installationId: inst.id, servicePointId: inst.servicePointId, finalReadingId: final?.id ?? null },
    fingerprint,
  });
  await env.audit({ action: "metering.meter_remove", subjectType: "meter", subjectId: m.id, before: { servicePointId: inst.servicePointId }, after: { status: input.to, removedAt: input.removedAt }, reason: input.reason });
  await env.publish(meterRemoved, { meterId: m.id, installationId: inst.id, servicePointId: inst.servicePointId, removedAt: input.removedAt.toISOString(), reason: input.reason });
  return { meter: toMeterDto(moved.meter), finalReading: final, replayed: false };
}

/** M-07: swap a meter on its service point, capturing the old final and the new initial reading. */
export async function replaceMeter(env: UserActionEnv, input: z.infer<typeof replaceInputSchema>) {
  if (input.oldMeterId === input.newMeterId) throw new TRPCError({ code: "BAD_REQUEST", message: "Choose a different meter to replace it with" });
  const fingerprint = fingerprintOf({ old: input.oldMeterId, new: input.newMeterId, at: input.replacedAt, reason: input.reason, final: input.finalReading.value, initial: input.initialReading.value });
  const earlier = await earlierStep(env, input.id, { meterId: input.oldMeterId, kind: "replace", fingerprint });
  // Lock both meters in a fixed order so two replacements cannot deadlock.
  const [first, second] = [input.oldMeterId, input.newMeterId].sort();
  const locked = new Map<string, MeterRow>();
  locked.set(first!, await lockMeter(env.tx, first!));
  locked.set(second!, await lockMeter(env.tx, second!));
  const oldMeter = locked.get(input.oldMeterId)!;
  const newMeter = locked.get(input.newMeterId)!;
  if (earlier) {
    const p = earlier.payload as { finalReadingId: string; initialReadingId: string; servicePointId: string };
    return {
      servicePointId: p.servicePointId,
      oldMeter: toMeterDto(oldMeter),
      newMeter: toMeterDto(newMeter),
      finalReading: (await readingById(env.tx, p.finalReadingId))!,
      initialReading: (await readingById(env.tx, p.initialReadingId))!,
      replayed: true,
    };
  }
  if (!INSTALLABLE.includes(newMeter.status)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `A meter that is ${newMeter.status.replace("_", " ")} cannot be installed` });
  const oldInst = await closeInstallation(env, oldMeter, input.replacedAt);

  const final = await boundary(env, oldMeter.id, input.replacedAt, oldInst.id, "final", input.finalReading);
  await endInstallation(env, oldInst.id, input.replacedAt, input.reason);
  const { inst: newInst, sp } = await openAt(env, newMeter, oldInst.servicePointId, input.replacedAt);
  const initial = await boundary(env, newMeter.id, input.replacedAt, newInst.id, "initial", input.initialReading);

  const payload = { finalReadingId: final.id, initialReadingId: initial.id, servicePointId: oldInst.servicePointId, newMeterId: newMeter.id };
  const out = await moveMeter(env, oldMeter, { id: input.id, meterId: oldMeter.id, kind: "replace", from: oldMeter.status, to: "replaced", reason: input.reason, payload, fingerprint });
  const inn = await moveMeter(env, newMeter, {
    meterId: newMeter.id,
    kind: "install",
    from: newMeter.status,
    to: "installed",
    reason: `Replaced meter ${oldMeter.serial}`,
    payload: { installationId: newInst.id, servicePointId: oldInst.servicePointId, initialReadingId: initial.id, replacedMeterId: oldMeter.id },
    fingerprint: fingerprintOf({ replacing: oldMeter.id, at: input.replacedAt }),
  });
  await env.audit({
    action: "metering.meter_replace",
    subjectType: "meter",
    subjectId: oldMeter.id,
    before: { meterId: oldMeter.id, serial: oldMeter.serial },
    after: { meterId: newMeter.id, serial: newMeter.serial, servicePointId: oldInst.servicePointId, finalValue: final.value, initialValue: initial.value },
    reason: input.reason,
  });
  await env.publish(meterReplaced, {
    servicePointId: oldInst.servicePointId,
    accountId: sp.accountId,
    oldMeterId: oldMeter.id,
    newMeterId: newMeter.id,
    finalReadingId: final.id,
    initialReadingId: initial.id,
    replacedAt: input.replacedAt.toISOString(),
  });
  return { servicePointId: oldInst.servicePointId, oldMeter: toMeterDto(out.meter), newMeter: toMeterDto(inn.meter), finalReading: final, initialReading: initial, replayed: false };
}

export const installationsInputSchema = z.object({ meterId: z.uuid().optional(), servicePointId: z.uuid().optional(), limit: z.number().int().min(1).max(200).default(50) });

/** Installation history, newest first. */
export async function listInstallations(tx: Transaction, input: z.infer<typeof installationsInputSchema>) {
  const rows = await tx
    .select({ i: installation, serial: meter.serial })
    .from(installation)
    .innerJoin(meter, and(eq(meter.organizationId, installation.organizationId), eq(meter.id, installation.meterId)))
    .where(and(input.meterId ? eq(installation.meterId, input.meterId) : undefined, input.servicePointId ? eq(installation.servicePointId, input.servicePointId) : undefined))
    .orderBy(desc(installation.installedAt), asc(installation.id))
    .limit(input.limit);
  return rows.map(({ i, serial }) => ({ id: i.id, meterId: i.meterId, serial, servicePointId: i.servicePointId, installedAt: i.installedAt, removedAt: i.removedAt, removalReason: i.removalReason }));
}
