import type { Transaction } from "@flowless/db";
import { installation, meter } from "@flowless/db/schema/metering";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { readSetting } from "../../kernel/config-store";
import { meteringBulkSetting } from "./policy-settings";
import { latestActualReading } from "./reads";

/*
 * Bulk and master meters (M-12, S): meters of kind `bulk` (a DMA's inlet) or `master` (a
 * scheme) that measure supply, not a customer. They are registered, installed and read through
 * the same procedures as customer meters; their own reading schedule is the per-DMA
 * `metering.bulk_schedules` setting. This is the whole of M-12 for now: which of them are due,
 * derived from their last actual reading. They are never on an eligibility snapshot (they are
 * not on an account's route) and never billed.
 */

export const bulkDueInputSchema = z.object({ asOf: z.iso.date().optional() });

export interface BulkDue {
  meterId: string;
  serial: string;
  kind: "bulk" | "master";
  dmaId: string;
  servicePointId: string;
  lastReadAt: Date | null;
  /** The date this meter's reading falls due, from its DMA's schedule. */
  dueDate: string;
  due: boolean;
}

const DAY = 86_400_000;
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

/** The installed bulk and master meters whose DMA has a schedule, with when each is due as of `asOf` (default today, UTC). */
export async function bulkSchedule(tx: Transaction, asOf: string = new Date().toISOString().slice(0, 10)): Promise<BulkDue[]> {
  const schedules = (await readSetting(tx, meteringBulkSetting)).value.schedules;
  if (!schedules.length) return [];
  const rows = await tx
    .select({ id: meter.id, serial: meter.serial, kind: meter.kind, dmaId: meter.dmaId, servicePointId: installation.servicePointId })
    .from(meter)
    .innerJoin(installation, and(eq(installation.organizationId, meter.organizationId), eq(installation.meterId, meter.id), isNull(installation.removedAt)))
    .where(and(inArray(meter.kind, ["bulk", "master"]), inArray(meter.dmaId, schedules.map((s) => s.dmaId))));
  const out: BulkDue[] = [];
  for (const r of rows) {
    const schedule = schedules.find((s) => s.dmaId === r.dmaId);
    if (!schedule || !r.dmaId || r.kind === "customer") continue;
    const last = await latestActualReading(tx, { meterId: r.id });
    const next = last ? addDays(last.readAt.toISOString().slice(0, 10), schedule.everyDays) : schedule.startDate;
    const dueDate = next > schedule.startDate ? next : schedule.startDate;
    out.push({ meterId: r.id, serial: r.serial, kind: r.kind, dmaId: r.dmaId, servicePointId: r.servicePointId, lastReadAt: last?.readAt ?? null, dueDate, due: dueDate <= asOf });
  }
  return out.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.serial.localeCompare(b.serial));
}
