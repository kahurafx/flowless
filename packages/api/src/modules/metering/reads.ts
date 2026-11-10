import type { Transaction } from "@flowless/db";
import { consumptionBetween, type ReadingPurpose, type ReadingQuality, type ReadingSource, type ReadingStatus } from "@flowless/shared-types";
import { sql, type SQL } from "drizzle-orm";

/*
 * Derived reads over readings (M-02): the status is the newest `reading_status` row, the
 * previous reading is the latest cleared valid actual of the same meter before this one, and
 * consumption is computed from the two. Nothing here is stored. These are Metering's
 * published reads (see `index.ts`): Billing and later modules call them with their own
 * transaction instead of reading the `metering` schema.
 */

export interface ReadingView {
  id: string;
  meterId: string;
  servicePointId: string;
  accountId: string | null;
  value: number;
  readAt: Date;
  recordedAt: Date;
  source: ReadingSource;
  /** An estimate is a separate type and never a baseline. */
  kind: "actual" | "estimate";
  purpose: ReadingPurpose;
  readerUserId: string | null;
  photoFileId: string | null;
  latitude: number | null;
  longitude: number | null;
  quality: ReadingQuality;
  note: string;
  flags: string[];
  status: ReadingStatus;
  /** May be billed automatically: valid, and either clean or approved. */
  cleared: boolean;
  rolloverConfirmed: boolean;
  replacesReadingId: string | null;
  dialDigits: number;
  /** The baseline: value of the previous cleared valid actual of the same meter; null for a meter's first reading. */
  previousValue: number | null;
  /** Units since the previous reading, counting a confirmed wrap; null with no previous or when the drop is unconfirmed. */
  units: number | null;
}

/** The newest status row of a reading, as a lateral join. */
const latestStatus = (reading: string, alias: string) => sql.raw(`join lateral (
  select s.status, s.cleared, s.rollover_confirmed from metering.reading_status s
  where s.organization_id = ${reading}.organization_id and s.reading_id = ${reading}.id order by s.seq desc limit 1) ${alias} on true`);

const asDate = (v: unknown) => (v instanceof Date ? v : new Date(v as string));

type Raw = Record<string, unknown>;

function toView(r: Raw): ReadingView {
  const value = Number(r.value);
  const previous = r.prev_value === null || r.prev_value === undefined ? null : Number(r.prev_value);
  const digits = Number(r.dial_digits);
  const rollover = Boolean(r.rollover_confirmed);
  let units: number | null = null;
  if (previous !== null && r.purpose !== "initial") {
    if (value >= previous) units = value - previous;
    else if (rollover) units = consumptionBetween(previous, value, digits, true);
  }
  return {
    id: r.id as string,
    meterId: r.meter_id as string,
    servicePointId: r.service_point_id as string,
    accountId: (r.account_id as string | null) ?? null,
    value,
    readAt: asDate(r.read_at),
    recordedAt: asDate(r.recorded_at),
    source: r.source as ReadingSource,
    kind: r.source === "estimate" ? "estimate" : "actual",
    purpose: r.purpose as ReadingPurpose,
    readerUserId: (r.reader_user_id as string | null) ?? null,
    photoFileId: (r.photo_file_id as string | null) ?? null,
    latitude: (r.latitude as number | null) ?? null,
    longitude: (r.longitude as number | null) ?? null,
    quality: r.quality as ReadingQuality,
    note: r.note as string,
    flags: (r.flags as string[]) ?? [],
    status: r.status as ReadingStatus,
    cleared: Boolean(r.cleared),
    rolloverConfirmed: rollover,
    replacesReadingId: (r.replaces_reading_id as string | null) ?? null,
    dialDigits: digits,
    previousValue: previous,
    units,
  };
}

export interface ReadingQuery {
  /** Conditions on the alias `r` (reading), `s` (its current status) and `m` (meter). */
  where?: SQL[];
  /** Newest first (default) or oldest first. */
  order?: "desc" | "asc";
  limit?: number;
}

/** Readings with their current status, previous reading and units, newest first by default. */
export async function queryReadings(tx: Transaction, query: ReadingQuery = {}): Promise<ReadingView[]> {
  const where = query.where?.length ? sql`where ${sql.join(query.where, sql` and `)}` : sql``;
  const direction = query.order === "asc" ? sql`asc` : sql`desc`;
  const rows: Raw[] = await tx.execute(sql`
    select r.id, r.meter_id, r.service_point_id, r.account_id, r.value, r.read_at, r.recorded_at, r.source, r.purpose,
           r.reader_user_id, r.photo_file_id, r.latitude, r.longitude, r.quality, r.note, r.flags, r.replaces_reading_id,
           s.status, s.cleared, s.rollover_confirmed, m.dial_digits, prev.value as prev_value
    from metering.reading r
    join metering.meter m on m.organization_id = r.organization_id and m.id = r.meter_id
    ${latestStatus("r", "s")}
    left join lateral (
      select p.value from metering.reading p
      ${latestStatus("p", "ps")}
      where p.organization_id = r.organization_id and p.meter_id = r.meter_id and p.source <> 'estimate'
        and ps.status = 'valid' and ps.cleared and (p.read_at, p.recorded_at) < (r.read_at, r.recorded_at)
      order by p.read_at desc, p.recorded_at desc limit 1) prev on true
    ${where}
    order by r.read_at ${direction}, r.recorded_at ${direction}
    limit ${query.limit ?? 200}`);
  return rows.map(toView);
}

export async function readingById(tx: Transaction, id: string): Promise<ReadingView | null> {
  return (await queryReadings(tx, { where: [sql`r.id = ${id}`], limit: 1 }))[0] ?? null;
}

export interface ReadingsFor {
  servicePointId?: string;
  meterId?: string;
  accountId?: string;
  /** read_at at or after / at or before. */
  from?: Date;
  to?: Date;
  /** Only valid readings (default true): voided and superseded ones are corrections history. */
  validOnly?: boolean;
  /** Only readings cleared for billing (default false). */
  clearedOnly?: boolean;
  /** Leave estimates out (default false). */
  actualOnly?: boolean;
  order?: "desc" | "asc";
  limit?: number;
}

/**
 * Published read (M-02): a service point's, meter's or account's readings with the baseline
 * and units derived. Across a meter change the service point's list holds both meters'
 * readings, the old meter's `final` and the new meter's `initial` included.
 */
export function readingsFor(tx: Transaction, f: ReadingsFor): Promise<ReadingView[]> {
  const where: SQL[] = [];
  if (f.servicePointId) where.push(sql`r.service_point_id = ${f.servicePointId}`);
  if (f.meterId) where.push(sql`r.meter_id = ${f.meterId}`);
  if (f.accountId) where.push(sql`r.account_id = ${f.accountId}`);
  if (f.from) where.push(sql`r.read_at >= ${f.from.toISOString()}::timestamptz`);
  if (f.to) where.push(sql`r.read_at <= ${f.to.toISOString()}::timestamptz`);
  if (f.validOnly ?? true) where.push(sql`s.status = 'valid'`);
  if (f.clearedOnly) where.push(sql`s.cleared`);
  if (f.actualOnly) where.push(sql`r.source <> 'estimate'`);
  return queryReadings(tx, { where, ...(f.order ? { order: f.order } : {}), ...(f.limit ? { limit: f.limit } : {}) });
}

/**
 * Published read (M-02, M-03): the latest actual reading that may be a baseline: valid,
 * cleared, not an estimate, read at or before `asOf` (default: now).
 */
export async function latestActualReading(tx: Transaction, f: { servicePointId?: string; meterId?: string; asOf?: Date }): Promise<ReadingView | null> {
  if (!f.servicePointId && !f.meterId) throw new Error("latestActualReading needs a service point or a meter");
  const where: SQL[] = [sql`s.status = 'valid'`, sql`s.cleared`, sql`r.source <> 'estimate'`];
  if (f.servicePointId) where.push(sql`r.service_point_id = ${f.servicePointId}`);
  if (f.meterId) where.push(sql`r.meter_id = ${f.meterId}`);
  if (f.asOf) where.push(sql`r.read_at <= ${f.asOf.toISOString()}::timestamptz`);
  return (await queryReadings(tx, { where, limit: 1 }))[0] ?? null;
}
