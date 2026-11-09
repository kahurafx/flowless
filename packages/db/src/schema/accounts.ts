import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  date,
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
  ACCOUNT_COMMAND_KINDS,
  ACTIVATION_CHECK_ACTIONS,
  APPLICATION_EVENT_KINDS,
  APPLICATION_STAGES,
  COMMERCIAL_STATUSES,
  CONTACT_CHANNELS,
  CONTACT_KINDS,
  CUSTOMER_TYPES,
  RELOCATION_EVENT_KINDS,
  RELOCATION_STATUSES,
  SERVICE_POINT_STATUSES,
  SERVICE_STATES,
  SURVEY_APPROVAL_STATES,
  SURVEY_FEASIBILITIES,
} from "@flowless/shared-types";
import { pointColumn } from "../geometry";
import { tenantPolicy } from "../tenant";
import { organization } from "./auth";
import { area, route } from "./kernel";

/**
 * The Accounts module (C-01, C-02, glossary: customer, account, service point). Statuses
 * and the like are text with check constraints built from shared-types (`accounts.ts`), as
 * in the kernel. Foreign keys between these tables, and to `kernel.area`/`route`, include
 * `organization_id`, so nothing points across tenants. Customers, accounts and service
 * points are never deleted (their history is the audit log and, later, the ledger); a
 * contact can be removed.
 */
export const accounts = pgSchema("accounts");

const organizationId = () =>
  uuid("organization_id")
    .notNull()
    .references(() => organization.id);

/** `<column> in (...)`, from a shared-types list. */
const oneOf = (column: AnyPgColumn, values: readonly string[]) =>
  sql`${column} in (${sql.raw(values.map((v) => `'${v}'`).join(", "))})`;

/**
 * The organization's customer (C-01). A person has a national id, an organization a
 * registration number; both are held normalised (upper case, letters and digits only) so
 * duplicates are found across spellings, and neither is unique: a possible duplicate is a
 * warning (`accounts.customers.duplicates`), never a block. `language` is a BCP 47 tag for
 * messages and documents.
 */
export const customer = accounts.table(
  "customer",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: organizationId(),
    type: text("type", { enum: CUSTOMER_TYPES }).notNull(),
    name: text("name").notNull(),
    nationalId: text("national_id"),
    registrationNumber: text("registration_number"),
    language: text("language"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: uuid("created_by_user_id").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("customer_organization_id_id_unique").on(t.organizationId, t.id),
    check("customer_type_valid", oneOf(t.type, CUSTOMER_TYPES)),
    check("customer_name_present", sql`length(btrim(${t.name})) > 0`),
    check("customer_national_id_person", sql`${t.type} = 'person' or ${t.nationalId} is null`),
    check("customer_registration_organization", sql`${t.type} = 'organization' or ${t.registrationNumber} is null`),
    index("customer_name_idx").on(t.organizationId, sql`lower(${t.name})`),
    index("customer_national_id_idx").on(t.organizationId, t.nationalId).where(sql`${t.nationalId} is not null`),
    index("customer_registration_idx").on(t.organizationId, t.registrationNumber).where(sql`${t.registrationNumber} is not null`),
    tenantPolicy(t.organizationId),
  ],
);

/**
 * A way to reach a customer (C-01). `value` is what was typed. For a phone, `normalized` is
 * the 254-format digits ("254712345678") and is what duplicates and search match on; a
 * placeholder such as 25400000000 is kept as typed with `is_placeholder` true and no
 * `normalized`, so it counts as no phone and the data-quality rules (C-12) can find it.
 * An email's `normalized` is its lower-cased address. At most one contact per customer and
 * channel is primary, and a placeholder never is.
 */
export const customerContact = accounts.table(
  "customer_contact",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: organizationId(),
    customerId: uuid("customer_id").notNull(),
    channel: text("channel", { enum: CONTACT_CHANNELS }).notNull(),
    kind: text("kind", { enum: CONTACT_KINDS }).notNull().default("personal"),
    value: text("value").notNull(),
    normalized: text("normalized"),
    isPlaceholder: boolean("is_placeholder").notNull().default(false),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: uuid("created_by_user_id").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("customer_contact_organization_id_id_unique").on(t.organizationId, t.id),
    foreignKey({ name: "customer_contact_customer_fk", columns: [t.organizationId, t.customerId], foreignColumns: [customer.organizationId, customer.id] }),
    check("customer_contact_channel_valid", oneOf(t.channel, CONTACT_CHANNELS)),
    check("customer_contact_kind_valid", oneOf(t.kind, CONTACT_KINDS)),
    check("customer_contact_placeholder_phone", sql`not ${t.isPlaceholder} or (${t.channel} = 'phone' and ${t.normalized} is null and not ${t.isPrimary})`),
    check("customer_contact_normalized_present", sql`${t.isPlaceholder} or ${t.normalized} is not null`),
    uniqueIndex("customer_contact_primary_unique")
      .on(t.organizationId, t.customerId, t.channel)
      .where(sql`${t.isPrimary}`),
    index("customer_contact_customer_idx").on(t.organizationId, t.customerId),
    index("customer_contact_normalized_idx").on(t.organizationId, t.channel, t.normalized).where(sql`${t.normalized} is not null`),
    tenantPolicy(t.organizationId),
  ],
);

/**
 * The billing relationship (C-02, C-03). `number` is unique per organization and held in
 * upper case; a child account is linked to its parent (`parent_account_id`, a composite
 * key, so never across tenants) and either carries the parent's number plus letters
 * ("1008B", `suffix_index` 2) or its own number ("1009"). `category_id` is Tariffs' category,
 * opaque here and without a foreign key (the tariff is derived from it, never stored).
 * Both status axes start at NEW and DISCONNECTED and change only through a logged command
 * (`account_command`, C-03); the database refuses any other change. A disconnected service
 * always has a reason.
 */
export const account = accounts.table(
  "account",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: organizationId(),
    number: text("number").notNull(),
    customerId: uuid("customer_id").notNull(),
    parentAccountId: uuid("parent_account_id"),
    /** Which letter, counted from 1 (A), this child took under its parent; null for any other account. */
    suffixIndex: integer("suffix_index"),
    categoryId: uuid("category_id"),
    commercialStatus: text("commercial_status", { enum: COMMERCIAL_STATUSES }).notNull().default("NEW"),
    serviceStatus: text("service_status", { enum: SERVICE_STATES }).notNull().default("DISCONNECTED"),
    serviceStatusReason: text("service_status_reason"),
    /**
     * The `account_command` that put the account in its current status, null while it is
     * still as opened. A trigger (`accounts.guard_account_status`) refuses any change to the
     * status columns that this does not point at: from-state = old row, to-state = new row.
     */
    statusCommandId: uuid("status_command_id"),
    /**
     * The membership class of a child account (C-07): a key of the `accounts.membership`
     * setting, validated by the application, and the class names the catalog item (by code)
     * Billing prices its connection fee with.
     */
    membershipClass: text("membership_class"),
    /**
     * Succession (C-08): the account this one succeeded, and on the old account the one that
     * succeeded it. Each is set once, and an account has at most one successor (a trigger
     * refuses to move or clear a pointer).
     */
    predecessorAccountId: uuid("predecessor_account_id"),
    successorAccountId: uuid("successor_account_id"),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: uuid("created_by_user_id").notNull(),
  },
  (t) => [
    unique("account_organization_id_id_unique").on(t.organizationId, t.id),
    unique("account_number_unique").on(t.organizationId, t.number),
    foreignKey({ name: "account_customer_fk", columns: [t.organizationId, t.customerId], foreignColumns: [customer.organizationId, customer.id] }),
    foreignKey({ name: "account_parent_fk", columns: [t.organizationId, t.parentAccountId], foreignColumns: [t.organizationId, t.id] }),
    foreignKey({ name: "account_predecessor_fk", columns: [t.organizationId, t.predecessorAccountId], foreignColumns: [t.organizationId, t.id] }),
    foreignKey({ name: "account_successor_fk", columns: [t.organizationId, t.successorAccountId], foreignColumns: [t.organizationId, t.id] }),
    check("account_succession_not_self", sql`coalesce(${t.predecessorAccountId} <> ${t.id} and ${t.successorAccountId} <> ${t.id}, true)`),
    check("account_membership_needs_parent", sql`${t.membershipClass} is null or ${t.parentAccountId} is not null`),
    uniqueIndex("account_predecessor_unique")
      .on(t.organizationId, t.predecessorAccountId)
      .where(sql`${t.predecessorAccountId} is not null`),
    uniqueIndex("account_successor_unique")
      .on(t.organizationId, t.successorAccountId)
      .where(sql`${t.successorAccountId} is not null`),
    check("account_commercial_status_valid", oneOf(t.commercialStatus, COMMERCIAL_STATUSES)),
    check("account_service_status_valid", oneOf(t.serviceStatus, SERVICE_STATES)),
    check("account_disconnected_has_reason", sql`${t.serviceStatus} = 'CONNECTED' or ${t.serviceStatusReason} is not null`),
    // A NEW or PENDING_PAYMENT account has no service yet and a TERMINATED one has none any more (C-03).
    check("account_service_needs_live_status", sql`${t.commercialStatus} in ('ACTIVE', 'DORMANT') or ${t.serviceStatus} = 'DISCONNECTED'`),
    check("account_suffix_needs_parent", sql`${t.suffixIndex} is null or (${t.parentAccountId} is not null and ${t.suffixIndex} >= 1)`),
    check("account_not_own_parent", sql`${t.parentAccountId} is null or ${t.parentAccountId} <> ${t.id}`),
    uniqueIndex("account_suffix_unique")
      .on(t.organizationId, t.parentAccountId, t.suffixIndex)
      .where(sql`${t.suffixIndex} is not null`),
    index("account_customer_idx").on(t.organizationId, t.customerId),
    index("account_parent_idx").on(t.organizationId, t.parentAccountId).where(sql`${t.parentAccountId} is not null`),
    index("account_status_idx").on(t.organizationId, t.commercialStatus),
    tenantPolicy(t.organizationId),
  ],
);

/**
 * The counter behind account numbers (C-02): one row per organization and scope, `main` for
 * the organization's sequence and `child:<parent account id>` for a parent's letters.
 * `next_value` is the next number to hand out; allocation is one `INSERT ... ON CONFLICT DO
 * UPDATE ... RETURNING`, which locks the row until the transaction ends, so concurrent
 * creates take turns and a rolled-back create gives its number back.
 */
export const accountCounter = accounts.table(
  "account_counter",
  {
    organizationId: organizationId(),
    scope: text("scope").notNull(),
    nextValue: bigint("next_value", { mode: "number" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.scope] }), check("account_counter_positive", sql`${t.nextValue} >= 1`), tenantPolicy(t.organizationId)],
);

/**
 * The physical connection (glossary). It belongs to an account. `scheme_id`, `zone_id`
 * (a zone or sub-zone) and `dma_id` are kernel areas of that level and `route_id` a kernel
 * route, all checked through the kernel's published reads before they are written, and
 * foreign keys here. `location` is a PostGIS point like GIS's, in SRID 4326 (a GiST index
 * serves the map). `gis_connection_id` is GIS's service connection, by id only, no foreign
 * key: Accounts never reads GIS tables, and GIS holds the other half of the link.
 */
export const servicePoint = accounts.table(
  "service_point",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: organizationId(),
    accountId: uuid("account_id").notNull(),
    address: text("address").notNull(),
    location: pointColumn("location"),
    schemeId: uuid("scheme_id"),
    zoneId: uuid("zone_id"),
    dmaId: uuid("dma_id"),
    routeId: uuid("route_id"),
    connectionStatus: text("connection_status", { enum: SERVICE_POINT_STATUSES }).notNull().default("PLANNED"),
    gisConnectionId: uuid("gis_connection_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: uuid("created_by_user_id").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("service_point_organization_id_id_unique").on(t.organizationId, t.id),
    foreignKey({ name: "service_point_account_fk", columns: [t.organizationId, t.accountId], foreignColumns: [account.organizationId, account.id] }),
    foreignKey({ name: "service_point_scheme_fk", columns: [t.organizationId, t.schemeId], foreignColumns: [area.organizationId, area.id] }),
    foreignKey({ name: "service_point_zone_fk", columns: [t.organizationId, t.zoneId], foreignColumns: [area.organizationId, area.id] }),
    foreignKey({ name: "service_point_dma_fk", columns: [t.organizationId, t.dmaId], foreignColumns: [area.organizationId, area.id] }),
    foreignKey({ name: "service_point_route_fk", columns: [t.organizationId, t.routeId], foreignColumns: [route.organizationId, route.id] }),
    check("service_point_status_valid", oneOf(t.connectionStatus, SERVICE_POINT_STATUSES)),
    check("service_point_address_present", sql`length(btrim(${t.address})) > 0`),
    index("service_point_account_idx").on(t.organizationId, t.accountId),
    index("service_point_route_idx").on(t.organizationId, t.routeId).where(sql`${t.routeId} is not null`),
    index("service_point_scheme_idx").on(t.organizationId, t.schemeId).where(sql`${t.schemeId} is not null`),
    index("service_point_zone_idx").on(t.organizationId, t.zoneId).where(sql`${t.zoneId} is not null`),
    index("service_point_dma_idx").on(t.organizationId, t.dmaId).where(sql`${t.dmaId} is not null`),
    index("service_point_gis_connection_idx").on(t.organizationId, t.gisConnectionId).where(sql`${t.gisConnectionId} is not null`),
    index("service_point_location_gist").using("gist", t.location),
    tenantPolicy(t.organizationId),
  ],
);

/**
 * The account's step log (named `account_command` for its main use): every change of an
 * account's status, as one append-only row (C-03): who did it, from where,
 * why, and the status on both axes before and after. The account's two status columns are the
 * current state; this table is the history that explains them, and the trigger on
 * `account` allows a change only with a row here that describes exactly that change.
 * `id` is minted by the client when it can, so a retry returns the earlier result;
 * `fingerprint` is the request it came from (a different request under the same id is a
 * conflict). A system actor (automatic activation, an approval's outcome) has no user.
 * Not every kind moves the status: `write_off_decided` rows, and the `succeed`, `change_name`
 * and `relocate` rows (C-08 to C-10), change nothing on the status axes (from = to) and exist
 * for the id, the actor, the reason and the payload. The app role cannot UPDATE, DELETE or
 * TRUNCATE them.
 */
export const accountCommand = accounts.table(
  "account_command",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: organizationId(),
    accountId: uuid("account_id").notNull(),
    kind: text("kind", { enum: ACCOUNT_COMMAND_KINDS }).notNull(),
    fromCommercialStatus: text("from_commercial_status", { enum: COMMERCIAL_STATUSES }).notNull(),
    toCommercialStatus: text("to_commercial_status", { enum: COMMERCIAL_STATUSES }).notNull(),
    fromServiceStatus: text("from_service_status", { enum: SERVICE_STATES }).notNull(),
    toServiceStatus: text("to_service_status", { enum: SERVICE_STATES }).notNull(),
    /** The service status reason after the command: set when DISCONNECTED, null when CONNECTED. */
    serviceReason: text("service_reason"),
    reason: text("reason").notNull(),
    reasonCode: text("reason_code"),
    /** Null only for the system (source "system"). */
    actorUserId: uuid("actor_user_id"),
    /** Where the command came from (AUDIT_SOURCES in packages/db). */
    source: text("source").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    note: text("note"),
    /** What the command carried and decided (override, termination basis, approval); amounts as decimal strings. */
    payload: jsonb("payload").notNull().default({}),
    fingerprint: text("fingerprint"),
  },
  (t) => [
    unique("account_command_organization_id_id_unique").on(t.organizationId, t.id),
    foreignKey({ name: "account_command_account_fk", columns: [t.organizationId, t.accountId], foreignColumns: [account.organizationId, account.id] }),
    check("account_command_kind_valid", oneOf(t.kind, ACCOUNT_COMMAND_KINDS)),
    check("account_command_from_commercial_valid", oneOf(t.fromCommercialStatus, COMMERCIAL_STATUSES)),
    check("account_command_to_commercial_valid", oneOf(t.toCommercialStatus, COMMERCIAL_STATUSES)),
    check("account_command_from_service_valid", oneOf(t.fromServiceStatus, SERVICE_STATES)),
    check("account_command_to_service_valid", oneOf(t.toServiceStatus, SERVICE_STATES)),
    check("account_command_reason_present", sql`length(btrim(${t.reason})) > 0`),
    check("account_command_disconnected_has_reason", sql`${t.toServiceStatus} = 'CONNECTED' or length(btrim(coalesce(${t.serviceReason}, ''))) > 0`),
    check("account_command_actor_present", sql`${t.actorUserId} is not null or ${t.source} = 'system'`),
    index("account_command_account_idx").on(t.organizationId, t.accountId, t.occurredAt),
    tenantPolicy(t.organizationId),
  ],
);

/**
 * The office checklist behind activation (C-06), insert-only: a tick and a later untick are
 * two rows, and the newest row (highest `seq`) per account and gate says whether it is
 * ticked now. `gate_key` is one of the built-in gates or an office item the organization
 * defined in `accounts.activation`.
 */
export const activationCheck = accounts.table(
  "activation_check",
  {
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: organizationId(),
    accountId: uuid("account_id").notNull(),
    gateKey: text("gate_key").notNull(),
    action: text("action", { enum: ACTIVATION_CHECK_ACTIONS }).notNull(),
    byUserId: uuid("by_user_id").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    note: text("note"),
  },
  (t) => [
    foreignKey({ name: "activation_check_account_fk", columns: [t.organizationId, t.accountId], foreignColumns: [account.organizationId, account.id] }),
    check("activation_check_action_valid", oneOf(t.action, ACTIVATION_CHECK_ACTIONS)),
    check("activation_check_gate_key_valid", sql`${t.gateKey} ~ '^[a-z][a-z0-9_]{1,39}$'`),
    index("activation_check_account_idx").on(t.organizationId, t.accountId, t.gateKey, t.seq),
    tenantPolicy(t.organizationId),
  ],
);

/**
 * Who held an account, from when (C-10): the account's holder history, insert-only. A row
 * is the holder from `valid_from` until the next row's `valid_from`, so a past date still
 * resolves to the holder then (`holderAt`, which Billing splits a bill with). The newest
 * row is the current holder and equals `account.customer_id`, which a trigger lets change
 * only to the customer of the newest row. `previous_closing_reading_ref` is the closing
 * reading taken for the holder before this one (an opaque reference until Metering exists),
 * `command_id` the `change_name` or `succeed` command that made the row, null for the first
 * holder. The app role cannot UPDATE, DELETE or TRUNCATE it.
 */
export const accountHolder = accounts.table(
  "account_holder",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: organizationId(),
    accountId: uuid("account_id").notNull(),
    customerId: uuid("customer_id").notNull(),
    validFrom: date("valid_from", { mode: "string" }).notNull(),
    previousClosingReadingRef: text("previous_closing_reading_ref"),
    commandId: uuid("command_id"),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: uuid("created_by_user_id"),
  },
  (t) => [
    unique("account_holder_organization_id_id_unique").on(t.organizationId, t.id),
    unique("account_holder_from_unique").on(t.organizationId, t.accountId, t.validFrom),
    foreignKey({ name: "account_holder_account_fk", columns: [t.organizationId, t.accountId], foreignColumns: [account.organizationId, account.id] }),
    foreignKey({ name: "account_holder_customer_fk", columns: [t.organizationId, t.customerId], foreignColumns: [customer.organizationId, customer.id] }),
    foreignKey({ name: "account_holder_command_fk", columns: [t.organizationId, t.commandId], foreignColumns: [accountCommand.organizationId, accountCommand.id] }),
    index("account_holder_account_idx").on(t.organizationId, t.accountId, t.validFrom),
    tenantPolicy(t.organizationId),
  ],
);

/**
 * An application for a new connection (C-05): the enquiry through to the account it
 * becomes. `stage` is the current milestone and changes only together with a row in
 * `application_event` (the application's own append-only history). The customer is an
 * existing one or was created together with the application; the requested place is an
 * address, a GPS point and optionally the kernel's scheme, zone, DMA and route. The
 * category is Tariffs' opaque id. The survey, the new-connection invoice and the payment
 * are held as facts (the survey's findings, an approval request id, opaque invoice and
 * payment references until Billing and Payments exist). When converted, `account_id` and
 * `service_point_id` name what was created.
 */
export const application = accounts.table(
  "application",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: organizationId(),
    customerId: uuid("customer_id").notNull(),
    requestedCategoryId: uuid("requested_category_id"),
    /** A child connection under this account (C-07). */
    parentAccountId: uuid("parent_account_id"),
    membershipClass: text("membership_class"),
    address: text("address").notNull(),
    location: pointColumn("location"),
    schemeId: uuid("scheme_id"),
    zoneId: uuid("zone_id"),
    dmaId: uuid("dma_id"),
    routeId: uuid("route_id"),
    notes: text("notes"),
    stage: text("stage", { enum: APPLICATION_STAGES }).notNull().default("enquiry"),
    surveyFeasibility: text("survey_feasibility", { enum: SURVEY_FEASIBILITIES }),
    surveyFindings: text("survey_findings"),
    surveyMaterials: text("survey_materials"),
    surveyRecordedAt: timestamp("survey_recorded_at", { withTimezone: true }),
    surveyRecordedByUserId: uuid("survey_recorded_by_user_id"),
    /** `office` (recorded by hand) or `work_order` (the completed survey job). */
    surveySource: text("survey_source"),
    surveyWorkOrderId: uuid("survey_work_order_id"),
    /** The K-05 request for the survey, with where it stands; both null while none was asked for. */
    surveyApprovalId: uuid("survey_approval_id"),
    surveyApprovalState: text("survey_approval_state", { enum: SURVEY_APPROVAL_STATES }),
    /** The new-connection invoice and its payment, opaque until Billing (Phase 4) and Payments (Phase 6) replace them with events. */
    invoiceRef: text("invoice_ref"),
    paymentRef: text("payment_ref"),
    accountId: uuid("account_id"),
    servicePointId: uuid("service_point_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: uuid("created_by_user_id").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("application_organization_id_id_unique").on(t.organizationId, t.id),
    foreignKey({ name: "application_customer_fk", columns: [t.organizationId, t.customerId], foreignColumns: [customer.organizationId, customer.id] }),
    foreignKey({ name: "application_parent_account_fk", columns: [t.organizationId, t.parentAccountId], foreignColumns: [account.organizationId, account.id] }),
    foreignKey({ name: "application_account_fk", columns: [t.organizationId, t.accountId], foreignColumns: [account.organizationId, account.id] }),
    foreignKey({ name: "application_service_point_fk", columns: [t.organizationId, t.servicePointId], foreignColumns: [servicePoint.organizationId, servicePoint.id] }),
    foreignKey({ name: "application_scheme_fk", columns: [t.organizationId, t.schemeId], foreignColumns: [area.organizationId, area.id] }),
    foreignKey({ name: "application_zone_fk", columns: [t.organizationId, t.zoneId], foreignColumns: [area.organizationId, area.id] }),
    foreignKey({ name: "application_dma_fk", columns: [t.organizationId, t.dmaId], foreignColumns: [area.organizationId, area.id] }),
    foreignKey({ name: "application_route_fk", columns: [t.organizationId, t.routeId], foreignColumns: [route.organizationId, route.id] }),
    check("application_stage_valid", oneOf(t.stage, APPLICATION_STAGES)),
    check("application_feasibility_valid", sql`${t.surveyFeasibility} is null or ${oneOf(t.surveyFeasibility, SURVEY_FEASIBILITIES)}`),
    check("application_approval_state_valid", sql`${t.surveyApprovalState} is null or ${oneOf(t.surveyApprovalState, SURVEY_APPROVAL_STATES)}`),
    check("application_address_present", sql`length(btrim(${t.address})) > 0`),
    check("application_converted_has_account", sql`(${t.stage} = 'converted') = (${t.accountId} is not null)`),
    check("application_membership_needs_parent", sql`${t.membershipClass} is null or ${t.parentAccountId} is not null`),
    index("application_stage_idx").on(t.organizationId, t.stage, t.createdAt),
    index("application_customer_idx").on(t.organizationId, t.customerId),
    index("application_survey_approval_idx").on(t.organizationId, t.surveyApprovalId).where(sql`${t.surveyApprovalId} is not null`),
    index("application_location_gist").using("gist", t.location),
    tenantPolicy(t.organizationId),
  ],
);

/**
 * An application's step log (named `application_event` for its main use), append-only: stage
 * changes, the survey result and the decision on it, each with who (null for the system, which
 * also decides approvals), from where and why. Only the `created` and `stage_changed` kinds
 * move the stage; `survey_recorded` and `survey_decided` rows leave it as it was (from = to). `id` is client-mintable, so a retried call returns the earlier result;
 * `fingerprint` identifies the request it came from.
 */
export const applicationEvent = accounts.table(
  "application_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: organizationId(),
    applicationId: uuid("application_id").notNull(),
    kind: text("kind", { enum: APPLICATION_EVENT_KINDS }).notNull(),
    fromStage: text("from_stage", { enum: APPLICATION_STAGES }),
    toStage: text("to_stage", { enum: APPLICATION_STAGES }).notNull(),
    actorUserId: uuid("actor_user_id"),
    source: text("source").notNull(),
    reason: text("reason").notNull(),
    payload: jsonb("payload").notNull().default({}),
    fingerprint: text("fingerprint"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("application_event_organization_id_id_unique").on(t.organizationId, t.id),
    foreignKey({ name: "application_event_application_fk", columns: [t.organizationId, t.applicationId], foreignColumns: [application.organizationId, application.id] }),
    check("application_event_kind_valid", oneOf(t.kind, APPLICATION_EVENT_KINDS)),
    check("application_event_from_valid", sql`${t.fromStage} is null or ${oneOf(t.fromStage, APPLICATION_STAGES)}`),
    check("application_event_to_valid", oneOf(t.toStage, APPLICATION_STAGES)),
    check("application_event_actor_present", sql`${t.actorUserId} is not null or ${t.source} = 'system'`),
    index("application_event_application_idx").on(t.organizationId, t.applicationId, t.occurredAt),
    tenantPolicy(t.organizationId),
  ],
);

/**
 * A relocation on the same account (C-09): the customer moves the connection. It names the
 * service point being closed and the place of the new one; completing it creates the new
 * service point and decommissions the old. The account keeps its number and status. The
 * fees to transfer are charge item codes (no foreign key; recorded, not invoiced), the
 * final and initial readings are opaque text until Metering exists, and `work_order_id` is
 * the Work Orders job doing the work, by id only. History is `relocation_event`.
 */
export const relocation = accounts.table(
  "relocation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: organizationId(),
    accountId: uuid("account_id").notNull(),
    fromServicePointId: uuid("from_service_point_id").notNull(),
    newServicePointId: uuid("new_service_point_id"),
    toAddress: text("to_address").notNull(),
    toLocation: pointColumn("to_location"),
    toSchemeId: uuid("to_scheme_id"),
    toZoneId: uuid("to_zone_id"),
    toDmaId: uuid("to_dma_id"),
    toRouteId: uuid("to_route_id"),
    status: text("status", { enum: RELOCATION_STATUSES }).notNull().default("requested"),
    reason: text("reason").notNull(),
    feeItemCodes: jsonb("fee_item_codes").notNull().default([]),
    surveyFeasibility: text("survey_feasibility", { enum: SURVEY_FEASIBILITIES }),
    surveyFindings: text("survey_findings"),
    finalReading: text("final_reading"),
    initialReading: text("initial_reading"),
    workOrderId: uuid("work_order_id"),
    requestedByUserId: uuid("requested_by_user_id").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("relocation_organization_id_id_unique").on(t.organizationId, t.id),
    foreignKey({ name: "relocation_account_fk", columns: [t.organizationId, t.accountId], foreignColumns: [account.organizationId, account.id] }),
    foreignKey({ name: "relocation_from_service_point_fk", columns: [t.organizationId, t.fromServicePointId], foreignColumns: [servicePoint.organizationId, servicePoint.id] }),
    foreignKey({ name: "relocation_new_service_point_fk", columns: [t.organizationId, t.newServicePointId], foreignColumns: [servicePoint.organizationId, servicePoint.id] }),
    foreignKey({ name: "relocation_scheme_fk", columns: [t.organizationId, t.toSchemeId], foreignColumns: [area.organizationId, area.id] }),
    foreignKey({ name: "relocation_zone_fk", columns: [t.organizationId, t.toZoneId], foreignColumns: [area.organizationId, area.id] }),
    foreignKey({ name: "relocation_dma_fk", columns: [t.organizationId, t.toDmaId], foreignColumns: [area.organizationId, area.id] }),
    foreignKey({ name: "relocation_route_fk", columns: [t.organizationId, t.toRouteId], foreignColumns: [route.organizationId, route.id] }),
    check("relocation_status_valid", oneOf(t.status, RELOCATION_STATUSES)),
    check("relocation_feasibility_valid", sql`${t.surveyFeasibility} is null or ${oneOf(t.surveyFeasibility, SURVEY_FEASIBILITIES)}`),
    check("relocation_address_present", sql`length(btrim(${t.toAddress})) > 0`),
    check("relocation_completed_has_service_point", sql`(${t.status} = 'completed') = (${t.newServicePointId} is not null)`),
    index("relocation_account_idx").on(t.organizationId, t.accountId, t.requestedAt),
    index("relocation_status_idx").on(t.organizationId, t.status),
    // One open relocation per service point.
    uniqueIndex("relocation_open_unique")
      .on(t.organizationId, t.fromServicePointId)
      .where(sql`${t.status} in ('requested', 'surveyed')`),
    index("relocation_to_location_gist").using("gist", t.toLocation),
    tenantPolicy(t.organizationId),
  ],
);

/**
 * A relocation's step log (named `relocation_event` for its main use), append-only, like
 * `application_event`. `work_recorded` rows never move the status (from = to), and a
 * `survey_recorded` row may leave it where it was; the other kinds move it.
 */
export const relocationEvent = accounts.table(
  "relocation_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: organizationId(),
    relocationId: uuid("relocation_id").notNull(),
    kind: text("kind", { enum: RELOCATION_EVENT_KINDS }).notNull(),
    fromStatus: text("from_status", { enum: RELOCATION_STATUSES }),
    toStatus: text("to_status", { enum: RELOCATION_STATUSES }).notNull(),
    actorUserId: uuid("actor_user_id"),
    source: text("source").notNull(),
    reason: text("reason").notNull(),
    payload: jsonb("payload").notNull().default({}),
    fingerprint: text("fingerprint"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("relocation_event_organization_id_id_unique").on(t.organizationId, t.id),
    foreignKey({ name: "relocation_event_relocation_fk", columns: [t.organizationId, t.relocationId], foreignColumns: [relocation.organizationId, relocation.id] }),
    check("relocation_event_kind_valid", oneOf(t.kind, RELOCATION_EVENT_KINDS)),
    check("relocation_event_from_valid", sql`${t.fromStatus} is null or ${oneOf(t.fromStatus, RELOCATION_STATUSES)}`),
    check("relocation_event_to_valid", oneOf(t.toStatus, RELOCATION_STATUSES)),
    check("relocation_event_actor_present", sql`${t.actorUserId} is not null or ${t.source} = 'system'`),
    index("relocation_event_relocation_idx").on(t.organizationId, t.relocationId, t.occurredAt),
    tenantPolicy(t.organizationId),
  ],
);
