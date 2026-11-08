import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  REVIEW_POLICIES,
  WORK_ORDER_EVENT_OUTCOMES,
  WORK_ORDER_EVENT_TYPES,
  WORK_ORDER_OUTCOMES,
  WORK_ORDER_STATUSES,
  WORK_PRIORITIES,
} from "@flowless/shared-types";
import { pointColumn } from "../geometry";
import { tenantPolicy } from "../tenant";
import { member, organization } from "./auth";
import { area, route } from "./kernel";

/**
 * The Work Orders module (W-01 to W-04), ported from Majimap: one lifecycle for every kind
 * of job, whichever module registered the kind. Kinds are code (`defineWorkKind` in
 * packages/api), so `kind` is text. Statuses and the like are text with check constraints,
 * as in the kernel. Foreign keys between these tables include `organization_id`.
 */
export const workOrders = pgSchema("work_orders");

const organizationId = () =>
  uuid("organization_id")
    .notNull()
    .references(() => organization.id);

/** `<column> in (...)`, from a shared-types list. */
const oneOf = (column: AnyPgColumn, values: readonly string[]) =>
  sql`${column} in (${sql.raw(values.map((v) => `'${v}'`).join(", "))})`;

/** A composite foreign key to `work_order`, so a job reference never crosses tenants. */
const workOrderFk = (name: string, t: { organizationId: AnyPgColumn; workOrderId: AnyPgColumn }) =>
  foreignKey({ name, columns: [t.organizationId, t.workOrderId], foreignColumns: [workOrder.organizationId, workOrder.id] });

/**
 * Crews (W-02): who works together. Archived, never deleted, because jobs keep pointing at
 * them.
 */
export const crew = workOrders.table(
  "crew",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: organizationId(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    unique("crew_organization_id_id_unique").on(t.organizationId, t.id),
    unique("crew_name_unique").on(t.organizationId, t.name),
    tenantPolicy(t.organizationId),
  ],
);

/** A crew's members; removed with the membership. */
export const crewMember = workOrders.table(
  "crew_member",
  {
    organizationId: organizationId(),
    crewId: uuid("crew_id").notNull(),
    userId: uuid("user_id").notNull(),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.crewId, t.userId] }),
    foreignKey({ name: "crew_member_crew_fk", columns: [t.organizationId, t.crewId], foreignColumns: [crew.organizationId, crew.id] }).onDelete(
      "cascade",
    ),
    foreignKey({
      name: "crew_member_member_fk",
      columns: [t.organizationId, t.userId],
      foreignColumns: [member.organizationId, member.userId],
    }).onDelete("cascade"),
    index("crew_member_user_idx").on(t.organizationId, t.userId),
    tenantPolicy(t.organizationId),
  ],
);

/**
 * A job (W-01). `code` is the organization's running number (`work_order_counter`). The
 * primary asset is `(asset_module, asset_id)`: a module's own asset id, resolved through
 * the kernel work ports, never a foreign key into another module. `area_id` / `route_id`
 * place the job for area and route targets and for scope (K-03). The assignee must be a
 * member; when they leave the job stays and becomes unassigned (SET NULL on
 * `assigned_to_user_id` only, `0022_work_orders_access.sql`). Other user columns are
 * history and have no foreign key. `overdue_at` marks a job whose breach was raised, so the
 * sweep (`work_orders.overdue_work_orders`, `0025_work_orders_overdue.sql`) raises it once.
 */
export const workOrder = workOrders.table(
  "work_order",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: organizationId(),
    code: text("code").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    kind: text("kind").notNull(),
    priority: text("priority", { enum: WORK_PRIORITIES }).notNull().default("normal"),
    status: text("status", { enum: WORK_ORDER_STATUSES }).notNull().default("pending"),
    review: text("review", { enum: REVIEW_POLICIES }).notNull().default("none"),
    /** Who raised it, in words ("Office", "Field report"). */
    source: text("source").notNull().default("Office"),
    parentId: uuid("parent_id"),
    assetModule: text("asset_module"),
    assetId: uuid("asset_id"),
    areaId: uuid("area_id"),
    routeId: uuid("route_id"),
    location: pointColumn("location"),
    locationNote: text("location_note"),
    assignedToUserId: uuid("assigned_to_user_id"),
    crewId: uuid("crew_id"),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    holdReason: text("hold_reason"),
    holdNote: text("hold_note"),
    heldAt: timestamp("held_at", { withTimezone: true }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    submittedByUserId: uuid("submitted_by_user_id"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedByUserId: uuid("reviewed_by_user_id"),
    reviewNote: text("review_note"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    outcome: text("outcome", { enum: WORK_ORDER_OUTCOMES }),
    completionNote: text("completion_note"),
    /** When the SLA breach was put in the exception queue (X-02); cleared when the job is rescheduled. */
    overdueAt: timestamp("overdue_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: uuid("created_by_user_id").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("work_order_organization_id_id_unique").on(t.organizationId, t.id),
    unique("work_order_code_unique").on(t.organizationId, t.code),
    foreignKey({ name: "work_order_parent_fk", columns: [t.organizationId, t.parentId], foreignColumns: [t.organizationId, t.id] }),
    foreignKey({ name: "work_order_area_fk", columns: [t.organizationId, t.areaId], foreignColumns: [area.organizationId, area.id] }),
    foreignKey({ name: "work_order_route_fk", columns: [t.organizationId, t.routeId], foreignColumns: [route.organizationId, route.id] }),
    foreignKey({ name: "work_order_crew_fk", columns: [t.organizationId, t.crewId], foreignColumns: [crew.organizationId, crew.id] }),
    check("work_order_priority_valid", oneOf(t.priority, WORK_PRIORITIES)),
    check("work_order_status_valid", oneOf(t.status, WORK_ORDER_STATUSES)),
    check("work_order_review_valid", oneOf(t.review, REVIEW_POLICIES)),
    check("work_order_outcome_valid", sql`${t.outcome} is null or ${oneOf(t.outcome, WORK_ORDER_OUTCOMES)}`),
    check("work_order_asset_pair", sql`(${t.assetModule} is null) = (${t.assetId} is null)`),
    index("work_order_status_idx").on(t.organizationId, t.status),
    index("work_order_assignee_idx").on(t.organizationId, t.assignedToUserId, t.status),
    index("work_order_crew_idx").on(t.organizationId, t.crewId, t.status),
    index("work_order_asset_idx").on(t.organizationId, t.assetModule, t.assetId),
    index("work_order_parent_idx").on(t.organizationId, t.parentId),
    index("work_order_due_idx").on(t.organizationId, t.dueAt).where(sql`${t.status} not in ('completed', 'cancelled')`),
    index("work_order_location_gist").using("gist", t.location),
    tenantPolicy(t.organizationId),
  ],
);

/**
 * The assets a job is about: one primary, any number of related ones. For a route job each
 * row's `status` is the per-asset progress. `(module, asset_id)` is the owning module's id,
 * with no foreign key: whether it is registered or proposed is worked out when read, via the
 * kernel work ports (no shared assets table).
 */
export const workOrderAsset = workOrders.table(
  "work_order_asset",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: organizationId(),
    workOrderId: uuid("work_order_id").notNull(),
    module: text("module").notNull(),
    assetId: uuid("asset_id").notNull(),
    role: text("role", { enum: ["primary", "related"] }).notNull(),
    status: text("status", { enum: ["pending", "done"] }).notNull().default("pending"),
    doneAt: timestamp("done_at", { withTimezone: true }),
    addedByUserId: uuid("added_by_user_id").notNull(),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    workOrderFk("work_order_asset_work_order_fk", t).onDelete("cascade"),
    uniqueIndex("work_order_asset_unique").on(t.organizationId, t.workOrderId, t.module, t.assetId),
    index("work_order_asset_asset_idx").on(t.organizationId, t.module, t.assetId),
    check("work_order_asset_role_valid", sql`${t.role} in ('primary', 'related')`),
    check("work_order_asset_status_valid", sql`${t.status} in ('pending', 'done')`),
    tenantPolicy(t.organizationId),
  ],
);

/**
 * The link between a job and the GIS branch holding its edits (`wo-<code>`): the only place
 * the two meet, since GIS sees a branch as just a name. One branch per job. History:
 * append-only for the app role.
 */
export const workOrderChangeSet = workOrders.table(
  "work_order_change_set",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: organizationId(),
    workOrderId: uuid("work_order_id").notNull(),
    branch: text("branch").notNull(),
    createdByUserId: uuid("created_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    workOrderFk("work_order_change_set_work_order_fk", t),
    uniqueIndex("work_order_change_set_job_unique").on(t.organizationId, t.workOrderId),
    uniqueIndex("work_order_change_set_branch_unique").on(t.organizationId, t.branch),
    tenantPolicy(t.organizationId),
  ],
);

/**
 * Everything done to a job, once each: its history (append-only for the app role). For
 * device actions the id comes from the device, so a retried sync finds its own event and
 * does nothing twice; server actions mint one. Rejected and stale actions are kept with
 * their reason. `latitude`/`longitude` are where the device was (W-02).
 */
export const workOrderEvent = workOrders.table(
  "work_order_event",
  {
    id: uuid("id").primaryKey(),
    organizationId: organizationId(),
    workOrderId: uuid("work_order_id").notNull(),
    type: text("type", { enum: WORK_ORDER_EVENT_TYPES }).notNull(),
    outcome: text("outcome", { enum: WORK_ORDER_EVENT_OUTCOMES }).notNull(),
    reason: text("reason"),
    payload: jsonb("payload").notNull(),
    actorUserId: uuid("actor_user_id").notNull(),
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    workOrderFk("work_order_event_work_order_fk", t),
    index("work_order_event_order_idx").on(t.organizationId, t.workOrderId, t.occurredAt),
    check("work_order_event_type_valid", oneOf(t.type, WORK_ORDER_EVENT_TYPES)),
    check("work_order_event_outcome_valid", oneOf(t.outcome, WORK_ORDER_EVENT_OUTCOMES)),
    check(
      "work_order_event_position_valid",
      sql`(${t.latitude} is null) = (${t.longitude} is null) and coalesce(${t.latitude} between -90 and 90, true) and coalesce(${t.longitude} between -180 and 180, true)`,
    ),
    tenantPolicy(t.organizationId),
  ],
);

/**
 * Which GIS logs were recorded as part of a job. `log_id` points into the GIS log tables by
 * id only: modules hold no keys into each other. Append-only for the app role.
 */
export const workOrderLogLink = workOrders.table(
  "work_order_log_link",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: organizationId(),
    workOrderId: uuid("work_order_id").notNull(),
    logKind: text("log_kind", { enum: ["condition", "valve"] }).notNull(),
    logId: uuid("log_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    workOrderFk("work_order_log_link_work_order_fk", t),
    uniqueIndex("work_order_log_link_unique").on(t.organizationId, t.workOrderId, t.logKind, t.logId),
    check("work_order_log_link_kind_valid", sql`${t.logKind} in ('condition', 'valve')`),
    tenantPolicy(t.organizationId),
  ],
);

/** One row per organization: the next job number to hand out. */
export const workOrderCounter = workOrders.table(
  "work_order_counter",
  {
    organizationId: uuid("organization_id")
      .primaryKey()
      .references(() => organization.id),
    nextNumber: integer("next_number").notNull().default(1),
  },
  (t) => [check("work_order_counter_positive", sql`${t.nextNumber} > 0`), tenantPolicy(t.organizationId)],
);

/**
 * Comments on a job, by anyone who can see it. Client-minted ids for offline devices.
 * Append-only for the app role: a correction is another comment.
 */
export const workOrderComment = workOrders.table(
  "work_order_comment",
  {
    id: uuid("id").primaryKey(),
    organizationId: organizationId(),
    workOrderId: uuid("work_order_id").notNull(),
    authorUserId: uuid("author_user_id").notNull(),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    workOrderFk("work_order_comment_work_order_fk", t),
    index("work_order_comment_order_idx").on(t.organizationId, t.workOrderId, t.createdAt),
    check("work_order_comment_body", sql`length(trim(${t.body})) > 0`),
    tenantPolicy(t.organizationId),
  ],
);

/**
 * Completion data for kinds with a `capture` schema (W-03), e.g. a meter serial and its first
 * reading, validated by the kind before it is written. Append-only for the app role: a job
 * returned for rework captures again, and the newest row is the one in force (derived when
 * read, never flagged). `kind` and `schema_version` record what the data was checked against.
 */
export const workOrderCapture = workOrders.table(
  "work_order_capture",
  {
    id: uuid("id").primaryKey(),
    organizationId: organizationId(),
    workOrderId: uuid("work_order_id").notNull(),
    kind: text("kind").notNull(),
    schemaVersion: integer("schema_version").notNull().default(1),
    data: jsonb("data").notNull(),
    capturedByUserId: uuid("captured_by_user_id").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    workOrderFk("work_order_capture_work_order_fk", t),
    index("work_order_capture_order_idx").on(t.organizationId, t.workOrderId, t.capturedAt),
    tenantPolicy(t.organizationId),
  ],
);
