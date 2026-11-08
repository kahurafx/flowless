import { AREA_LEVELS, EXCEPTION_STATUSES } from "@flowless/shared-types";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  char,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgPolicy,
  uniqueIndex,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { authRole, tenantPolicy } from "../tenant";
import { member, organization } from "./auth";

/** Kernel module tables (requirements §4.1). */
export const kernel = pgSchema("kernel");

/**
 * The currency all money is held in (B-18), fixed when Flowless onboards the
 * organization. One row per tenant; the organization itself is Better Auth's
 * `auth.organization`, which only packages/auth reads. Time zone and language are a
 * versioned setting in `config_version` (K-10).
 */
export const organizationSettings = kernel.table(
  "organization_settings",
  {
    organizationId: uuid("organization_id")
      .primaryKey()
      .references(() => organization.id),
    currency: char("currency", { length: 3 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [tenantPolicy(t.organizationId)],
);

/**
 * Extra permissions an administrator granted a member on top of their role's defaults
 * (K-03; catalogue in `@flowless/shared-types` permissions). One row per permission.
 * The foreign key to the membership deletes a member's grants when they leave.
 */
export const memberPermission = kernel.table(
  "member_permission",
  {
    organizationId: uuid("organization_id").notNull(),
    userId: uuid("user_id").notNull(),
    permission: text("permission").notNull(),
    grantedBy: uuid("granted_by").notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.userId, t.permission] }),
    foreignKey({
      name: "member_permission_member_fk",
      columns: [t.organizationId, t.userId],
      foreignColumns: [member.organizationId, member.userId],
    }).onDelete("cascade"),
    tenantPolicy(t.organizationId),
  ],
);

export const areaLevel = kernel.enum("area_level", AREA_LEVELS);

/**
 * The organization hierarchy (K-02): schemes, zones, sub-zones and DMAs in one tree.
 * A parent sits at a higher level (checked by the hierarchy service, `areaParentProblem`).
 * Foreign keys include `organization_id`, so a tree never crosses tenants. Areas are
 * archived, never deleted, because accounts and readings will reference them.
 * GIS adds map data (boundary, inlet meter) to DMA ids in Phase 2.
 */
export const area = kernel.table(
  "area",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id),
    level: areaLevel("level").notNull(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    parentId: uuid("parent_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    unique("area_organization_id_id_unique").on(t.organizationId, t.id),
    unique("area_code_unique").on(t.organizationId, t.level, t.code),
    foreignKey({ name: "area_parent_fk", columns: [t.organizationId, t.parentId], foreignColumns: [t.organizationId, t.id] }),
    index("area_parent_idx").on(t.parentId),
    tenantPolicy(t.organizationId),
  ],
);

/**
 * The operational route hierarchy (K-02), separate from areas: route groups and routes.
 * Service points join routes in the Accounts module; `area_id` only groups a route.
 */
export const route = kernel.table(
  "route",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id),
    code: text("code").notNull(),
    name: text("name").notNull(),
    parentId: uuid("parent_id"),
    areaId: uuid("area_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    unique("route_organization_id_id_unique").on(t.organizationId, t.id),
    unique("route_code_unique").on(t.organizationId, t.code),
    foreignKey({ name: "route_parent_fk", columns: [t.organizationId, t.parentId], foreignColumns: [t.organizationId, t.id] }),
    foreignKey({ name: "route_area_fk", columns: [t.organizationId, t.areaId], foreignColumns: [area.organizationId, area.id] }),
    index("route_parent_idx").on(t.parentId),
    tenantPolicy(t.organizationId),
  ],
);

const memberFk = (name: string, t: { organizationId: AnyPgColumn; userId: AnyPgColumn }) =>
  foreignKey({ name, columns: [t.organizationId, t.userId], foreignColumns: [member.organizationId, member.userId] }).onDelete(
    "cascade",
  );

/**
 * Scope restrictions (K-03): the areas a member is limited to, each including everything
 * below it. A member with no area and no route rows is unrestricted.
 */
export const memberAreaScope = kernel.table(
  "member_area_scope",
  {
    organizationId: uuid("organization_id").notNull(),
    userId: uuid("user_id").notNull(),
    areaId: uuid("area_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.userId, t.areaId] }),
    memberFk("member_area_scope_member_fk", t),
    foreignKey({
      name: "member_area_scope_area_fk",
      columns: [t.organizationId, t.areaId],
      foreignColumns: [area.organizationId, area.id],
    }).onDelete("cascade"),
    tenantPolicy(t.organizationId),
  ],
);

/** Scope restrictions (K-03): the routes a member is limited to, with their sub-routes. */
export const memberRouteScope = kernel.table(
  "member_route_scope",
  {
    organizationId: uuid("organization_id").notNull(),
    userId: uuid("user_id").notNull(),
    routeId: uuid("route_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.userId, t.routeId] }),
    memberFk("member_route_scope_member_fk", t),
    foreignKey({
      name: "member_route_scope_route_fk",
      columns: [t.organizationId, t.routeId],
      foreignColumns: [route.organizationId, route.id],
    }).onDelete("cascade"),
    tenantPolicy(t.organizationId),
  ],
);

/**
 * Module licensing (K-04): one row per module the organization is licensed for. The
 * kernel is always on and has no row. Set by Flowless when onboarding or changing a plan
 * (`setEntitlements` in packages/api), never by the tenant; module keys are validated
 * there against `MODULE_KEYS`, so adding a module needs no migration.
 */
export const organizationModule = kernel.table(
  "organization_module",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id),
    module: text("module").notNull(),
    licensedAt: timestamp("licensed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.module] }), tenantPolicy(t.organizationId)],
);

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

/**
 * The audit log (K-06, NF-07): who did what, when, to which record, before and after,
 * and from where. Append-only: the app role may only insert and read (grants in
 * `0009_kernel_audit_append_only.sql`), and the auth role may only insert, so Better Auth
 * events land here too. Tamper-evident: a trigger chains each organization's rows with
 * SHA-256 (`chain_index`, `prev_hash`, `hash`); `kernel.verify_audit_chain()` re-checks it.
 */
export const auditLog = kernel.table(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    /** Null for system actions (jobs, onboarding) and failed sign-ins. */
    actorUserId: uuid("actor_user_id"),
    /** Name or identifier at the time, so the entry reads correctly after the user changes. */
    actorLabel: text("actor_label"),
    /** web, mobile, api, import or system (AUDIT_SOURCES). */
    source: text("source").notNull(),
    /** "<area>.<verb>", e.g. "access.grant", "auth.sign_in_failed". */
    action: text("action").notNull(),
    subjectType: text("subject_type"),
    subjectId: text("subject_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    reason: text("reason"),
    ipAddress: text("ip_address"),
    // Filled by the kernel.audit_chain trigger; never set by callers.
    chainIndex: bigint("chain_index", { mode: "bigint" }).notNull().default(sql`0`),
    prevHash: bytea("prev_hash"),
    hash: bytea("hash"),
  },
  (t) => [
    unique("audit_log_chain_unique").on(t.organizationId, t.chainIndex),
    index("audit_log_recent_idx").on(t.organizationId, t.occurredAt.desc()),
    index("audit_log_subject_idx").on(t.organizationId, t.subjectType, t.subjectId),
    tenantPolicy(t.organizationId),
    pgPolicy("auth_insert", { for: "insert", to: authRole, withCheck: sql`true` }),
  ],
);

export const OUTBOX_STATUSES = ["pending", "done", "failed"] as const;

/**
 * The transactional outbox (K-09). An event is written in the same transaction as the
 * change it describes, so it exists only if the change committed. `id` is the stable
 * event id consumers deduplicate on. `apps/worker` claims due events through
 * `kernel.claim_outbox()` (no RLS bypass), delivers each to its consumers inside the
 * event's tenant, then marks it done; failures back off through `available_at` until
 * `failed`. The auth role may insert (organization lifecycle events) and nothing else.
 */
export const outboxEvent = kernel.table(
  "outbox_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id),
    /** "<area>.<event>", e.g. "organization.created". */
    type: text("type").notNull(),
    /** Payload schema version; consumers accept every version they know. */
    version: integer("version").notNull().default(1),
    payload: jsonb("payload").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    status: text("status", { enum: OUTBOX_STATUSES }).notNull().default("pending"),
    lastError: text("last_error"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    check("outbox_event_status_valid", sql`${t.status} in ('pending', 'done', 'failed')`),
    index("outbox_event_due_idx").on(t.availableAt).where(sql`${t.status} = 'pending'`),
    index("outbox_event_type_idx").on(t.organizationId, t.type, t.occurredAt),
    tenantPolicy(t.organizationId),
    pgPolicy("auth_insert", { for: "insert", to: authRole, withCheck: sql`true` }),
  ],
);

/**
 * Which consumer has processed which event (K-09): written in the consumer's own
 * transaction, so a retried event never runs a consumer twice.
 */
export const consumerReceipt = kernel.table(
  "consumer_receipt",
  {
    organizationId: uuid("organization_id").notNull(),
    consumer: text("consumer").notNull(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => outboxEvent.id),
    processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.consumer, t.eventId] }), tenantPolicy(t.organizationId)],
);

/**
 * The exception queue (X-02, NF-24): everything that needs a person. Modules raise
 * exceptions with `raiseException` (packages/api); the kernel raises background
 * failures. Age is derived from `raised_at` when read, never stored. While open, one row
 * per `dedupe_key`: raising the same problem again counts an occurrence instead of
 * adding a row. `owner_user_id` falls back to null when the owner leaves (custom FK in
 * `0013_kernel_exception_owner.sql`). `area_id`/`route_id` place it for scope (K-03).
 */
export const exception = kernel.table(
  "exception",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id),
    /** EXCEPTION_TYPES in shared-types. */
    type: text("type").notNull(),
    /** The module that raised it, or "kernel". */
    source: text("source").notNull(),
    title: text("title").notNull(),
    detail: text("detail").notNull().default(""),
    subjectKind: text("subject_kind").notNull(),
    subjectRef: text("subject_ref").notNull(),
    areaId: uuid("area_id"),
    routeId: uuid("route_id"),
    ownerUserId: uuid("owner_user_id"),
    status: text("status", { enum: EXCEPTION_STATUSES }).notNull().default("open"),
    dedupeKey: text("dedupe_key"),
    occurrences: integer("occurrences").notNull().default(1),
    raisedAt: timestamp("raised_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedByUserId: uuid("resolved_by_user_id"),
    resolutionNote: text("resolution_note"),
  },
  (t) => [
    check("exception_status_valid", sql`${t.status} in ('open', 'in_progress', 'resolved')`),
    uniqueIndex("exception_open_dedupe_unique").on(t.organizationId, t.dedupeKey).where(sql`${t.status} <> 'resolved'`),
    index("exception_queue_idx").on(t.organizationId, t.status, t.raisedAt),
    index("exception_owner_idx").on(t.organizationId, t.ownerUserId),
    foreignKey({ name: "exception_area_fk", columns: [t.organizationId, t.areaId], foreignColumns: [area.organizationId, area.id] }),
    foreignKey({ name: "exception_route_fk", columns: [t.organizationId, t.routeId], foreignColumns: [route.organizationId, route.id] }),
    tenantPolicy(t.organizationId),
  ],
);

export const JOB_STATUSES = ["queued", "running", "done", "failed"] as const;

/**
 * Queued background work (NF-12): billing runs, imports, reconciliation, messaging.
 * Enqueued with `ctx.enqueue` in the transaction that asks for it, claimed by
 * `apps/worker` through `kernel.claim_jobs()`, retried with backoff, and raised as a
 * JOB_FAILURE exception owned by whoever queued it after the last attempt (NF-24).
 */
export const job = kernel.table(
  "job",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status", { enum: JOB_STATUSES }).notNull().default("queued"),
    /** Queued jobs start at `run_at`; running jobs are leased until it. */
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    /** A stable key from the requester: enqueueing the same work twice is a no-op. */
    idempotencyKey: text("idempotency_key"),
    createdByUserId: uuid("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    lastError: text("last_error"),
    result: jsonb("result"),
  },
  (t) => [
    check("job_status_valid", sql`${t.status} in ('queued', 'running', 'done', 'failed')`),
    uniqueIndex("job_idempotency_unique").on(t.organizationId, t.type, t.idempotencyKey),
    index("job_due_idx").on(t.runAt).where(sql`${t.status} in ('queued', 'running')`),
    tenantPolicy(t.organizationId),
  ],
);

/**
 * The configuration store (K-10, NF-32): every change to an organization's setting is a
 * new version, never an edit (append-only by grants). The value in force at a time is
 * the newest version whose `effective_from` has passed, so a change can be scheduled and
 * a past billing run re-reads the policy it ran with. Keys and schemas are defined in
 * code by the module that owns them (`defineSetting` in packages/api).
 */
export const configVersion = kernel.table(
  "config_version",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id),
    key: text("key").notNull(),
    /** 1, 2, 3 … per organization and key. */
    version: integer("version").notNull(),
    value: jsonb("value").notNull(),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
    reason: text("reason"),
    /** Null for changes made by Flowless itself (onboarding). */
    createdByUserId: uuid("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("config_version_unique").on(t.organizationId, t.key, t.version),
    index("config_version_effective_idx").on(t.organizationId, t.key, t.effectiveFrom),
    check("config_version_positive", sql`${t.version} > 0`),
    tenantPolicy(t.organizationId),
  ],
);
