import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  COMMERCIAL_STATUSES,
  CONTACT_CHANNELS,
  CONTACT_KINDS,
  CUSTOMER_TYPES,
  SERVICE_POINT_STATUSES,
  SERVICE_STATES,
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
 * Both status axes start at NEW and DISCONNECTED; changing them is the account lifecycle
 * (Phase 3 F3). A disconnected service always has a reason.
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
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: uuid("created_by_user_id").notNull(),
  },
  (t) => [
    unique("account_organization_id_id_unique").on(t.organizationId, t.id),
    unique("account_number_unique").on(t.organizationId, t.number),
    foreignKey({ name: "account_customer_fk", columns: [t.organizationId, t.customerId], foreignColumns: [customer.organizationId, customer.id] }),
    foreignKey({ name: "account_parent_fk", columns: [t.organizationId, t.parentAccountId], foreignColumns: [t.organizationId, t.id] }),
    check("account_commercial_status_valid", oneOf(t.commercialStatus, COMMERCIAL_STATUSES)),
    check("account_service_status_valid", oneOf(t.serviceStatus, SERVICE_STATES)),
    check("account_disconnected_has_reason", sql`${t.serviceStatus} = 'CONNECTED' or ${t.serviceStatusReason} is not null`),
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
