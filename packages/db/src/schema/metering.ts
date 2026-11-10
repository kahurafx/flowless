import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { MAX_DIAL_DIGITS, METER_STATUSES, MIN_DIAL_DIGITS, READING_PURPOSES, READING_QUALITIES, READING_SOURCES, READING_STATUSES } from "@flowless/shared-types";
import { tenantPolicy } from "../tenant";
import { organization } from "./auth";

/**
 * The Metering module's meter register and readings (M-01 to M-07, M-11, NF-22).
 *
 * - `meter` is the register; its status is the current state and changes only together with a
 *   new `meter_event` (trigger `metering.guard_meter_status`), so the lifecycle is always logged.
 * - `installation` puts a meter on a service point from `installed_at` to `removed_at`. The
 *   service point is an opaque Accounts id (no foreign key, no cross-module read).
 * - `reading` is append-only (the app role has no UPDATE or DELETE). Its status (valid, voided,
 *   superseded) and whether it has been cleared for billing live in the append-only
 *   `reading_status` log; the newest row decides. The previous reading, consumption and
 *   baseline are derived by queries, never stored.
 * - Estimates (`source = 'estimate'`) are a separate type and never a baseline.
 */
export const metering = pgSchema("metering");

const organizationId = () =>
  uuid("organization_id")
    .notNull()
    .references(() => organization.id);

const oneOf = (column: AnyPgColumn, values: readonly string[]) =>
  sql`${column} in (${sql.raw(values.map((v) => `'${v}'`).join(", "))})`;

/** How a step reached the system, as the audit log names it. */
export const METERING_SOURCES = ["web", "mobile", "api", "import", "system", "support"] as const;

export const METER_EVENT_KINDS = ["register", "status_change", "install", "remove", "replace"] as const;
export type MeterEventKind = (typeof METER_EVENT_KINDS)[number];

/* ---------- the register (M-01) ---------- */

export const meter = metering.table(
  "meter",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: organizationId(),
    serial: text("serial").notNull(),
    model: text("model").notNull().default(""),
    dialDigits: integer("dial_digits").notNull(),
    status: text("status", { enum: METER_STATUSES }).notNull(),
    /** The event that put the meter in this status; set with every status change (trigger). */
    statusEventId: uuid("status_event_id"),
    note: text("note").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: uuid("created_by_user_id"),
  },
  (t) => [
    unique("meter_organization_id_id_unique").on(t.organizationId, t.id),
    uniqueIndex("meter_serial_unique").on(t.organizationId, sql`lower(btrim(${t.serial}))`),
    check("meter_status_valid", oneOf(t.status, METER_STATUSES)),
    check("meter_serial_present", sql`length(btrim(${t.serial})) > 0`),
    check("meter_dial_digits_valid", sql`${t.dialDigits} between ${sql.raw(String(MIN_DIAL_DIGITS))} and ${sql.raw(String(MAX_DIAL_DIGITS))}`),
    index("meter_status_idx").on(t.organizationId, t.status),
    tenantPolicy(t.organizationId),
  ],
);

/** Every lifecycle step of a meter, append-only, with a client-mintable id (a retried step returns the earlier one). */
export const meterEvent = metering.table(
  "meter_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: organizationId(),
    meterId: uuid("meter_id").notNull(),
    kind: text("kind", { enum: METER_EVENT_KINDS }).notNull(),
    fromStatus: text("from_status", { enum: METER_STATUSES }),
    toStatus: text("to_status", { enum: METER_STATUSES }).notNull(),
    reason: text("reason").notNull().default(""),
    actorUserId: uuid("actor_user_id"),
    source: text("source", { enum: METERING_SOURCES }).notNull(),
    payload: jsonb("payload").notNull().default({}),
    /** What the request was, so a retry is told from a different request under the same id. */
    fingerprint: text("fingerprint").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("meter_event_organization_id_id_unique").on(t.organizationId, t.id),
    foreignKey({ name: "meter_event_meter_fk", columns: [t.organizationId, t.meterId], foreignColumns: [meter.organizationId, meter.id] }),
    check("meter_event_kind_valid", oneOf(t.kind, METER_EVENT_KINDS)),
    check("meter_event_to_valid", oneOf(t.toStatus, METER_STATUSES)),
    index("meter_event_meter_idx").on(t.organizationId, t.meterId, t.occurredAt),
    tenantPolicy(t.organizationId),
  ],
);

/** A meter on a service point from `installed_at` until `removed_at` (null while it is there). */
export const installation = metering.table(
  "installation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: organizationId(),
    meterId: uuid("meter_id").notNull(),
    /** Opaque Accounts service point. */
    servicePointId: uuid("service_point_id").notNull(),
    installedAt: timestamp("installed_at", { withTimezone: true }).notNull(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    installedByUserId: uuid("installed_by_user_id"),
    removedByUserId: uuid("removed_by_user_id"),
    removalReason: text("removal_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("installation_organization_id_id_unique").on(t.organizationId, t.id),
    foreignKey({ name: "installation_meter_fk", columns: [t.organizationId, t.meterId], foreignColumns: [meter.organizationId, meter.id] }),
    check("installation_span_valid", sql`${t.removedAt} is null or ${t.removedAt} >= ${t.installedAt}`),
    uniqueIndex("installation_meter_open").on(t.organizationId, t.meterId).where(sql`${t.removedAt} is null`),
    uniqueIndex("installation_service_point_open").on(t.organizationId, t.servicePointId).where(sql`${t.removedAt} is null`),
    index("installation_service_point_idx").on(t.organizationId, t.servicePointId, t.installedAt),
    index("installation_meter_idx").on(t.organizationId, t.meterId, t.installedAt),
    tenantPolicy(t.organizationId),
  ],
);

/* ---------- readings (M-02 to M-05, M-07, M-11) ---------- */

/**
 * One reading, as it was taken. `id` is minted by the device or caller, so a retried sync
 * returns the earlier row. `flags` are the validation findings at entry (M-05).
 */
export const reading = metering.table(
  "reading",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: organizationId(),
    meterId: uuid("meter_id").notNull(),
    installationId: uuid("installation_id").notNull(),
    /** Opaque Accounts ids, as they were when the reading was taken. */
    servicePointId: uuid("service_point_id").notNull(),
    accountId: uuid("account_id"),
    /** The dial value, whole units. */
    value: bigint("value", { mode: "number" }).notNull(),
    readAt: timestamp("read_at", { withTimezone: true }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    source: text("source", { enum: READING_SOURCES }).notNull(),
    purpose: text("purpose", { enum: READING_PURPOSES }).notNull().default("routine"),
    readerUserId: uuid("reader_user_id"),
    /** A `kernel.file` id (subject kind `reading`); the bytes live in object storage. */
    photoFileId: uuid("photo_file_id"),
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
    quality: text("quality", { enum: READING_QUALITIES }).notNull().default("good"),
    note: text("note").notNull().default(""),
    flags: text("flags").array().notNull().default(sql`'{}'::text[]`),
    /** The reading this one corrects (the older one gets a `superseded` status row). */
    replacesReadingId: uuid("replaces_reading_id"),
    fingerprint: text("fingerprint").notNull(),
  },
  (t) => [
    unique("reading_organization_id_id_unique").on(t.organizationId, t.id),
    foreignKey({ name: "reading_meter_fk", columns: [t.organizationId, t.meterId], foreignColumns: [meter.organizationId, meter.id] }),
    foreignKey({ name: "reading_installation_fk", columns: [t.organizationId, t.installationId], foreignColumns: [installation.organizationId, installation.id] }),
    foreignKey({ name: "reading_replaces_fk", columns: [t.organizationId, t.replacesReadingId], foreignColumns: [t.organizationId, t.id] }),
    uniqueIndex("reading_replaces_unique").on(t.organizationId, t.replacesReadingId).where(sql`${t.replacesReadingId} is not null`),
    check("reading_value_not_negative", sql`${t.value} >= 0`),
    check("reading_source_valid", oneOf(t.source, READING_SOURCES)),
    check("reading_purpose_valid", oneOf(t.purpose, READING_PURPOSES)),
    check("reading_quality_valid", oneOf(t.quality, READING_QUALITIES)),
    // An estimate is a separate type: always routine, never a boundary reading of a meter.
    check("reading_estimate_routine", sql`${t.source} <> 'estimate' or ${t.purpose} = 'routine'`),
    check(
      "reading_gps_valid",
      sql`(${t.latitude} is null and ${t.longitude} is null) or (${t.latitude} between -90 and 90 and ${t.longitude} between -180 and 180)`,
    ),
    index("reading_meter_read_idx").on(t.organizationId, t.meterId, t.readAt, t.recordedAt),
    index("reading_service_point_read_idx").on(t.organizationId, t.servicePointId, t.readAt, t.recordedAt),
    index("reading_account_idx").on(t.organizationId, t.accountId, t.readAt),
    tenantPolicy(t.organizationId),
  ],
);

/**
 * The append-only status log of a reading (M-02): the newest `seq` decides. Every reading has
 * a first row written with it (a deferred trigger checks). `cleared` says the reading may be
 * billed automatically: it raised no blocking flag, or someone approved it. A confirmed
 * dial rollover (M-07) is recorded here, because the reading itself never changes.
 */
export const readingStatus = metering.table(
  "reading_status",
  {
    seq: bigint("seq", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    organizationId: organizationId(),
    readingId: uuid("reading_id").notNull(),
    status: text("status", { enum: READING_STATUSES }).notNull(),
    cleared: boolean("cleared").notNull(),
    rolloverConfirmed: boolean("rollover_confirmed").notNull().default(false),
    reason: text("reason").notNull().default(""),
    actorUserId: uuid("actor_user_id"),
    source: text("source", { enum: METERING_SOURCES }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: "reading_status_reading_fk", columns: [t.organizationId, t.readingId], foreignColumns: [reading.organizationId, reading.id] }),
    check("reading_status_valid", oneOf(t.status, READING_STATUSES)),
    check("reading_status_voided_not_cleared", sql`${t.status} = 'valid' or ${t.cleared} = false`),
    index("reading_status_latest_idx").on(t.organizationId, t.readingId, t.seq.desc()),
    tenantPolicy(t.organizationId),
  ],
);
