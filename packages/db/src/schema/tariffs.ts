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
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  CHARGE_RECURRENCES,
  CHARGE_TYPES,
  FLAT_BASES,
  INVOICE_APPLIES_TO,
  LATE_FEE_BASES,
  LATE_FEE_FREQUENCIES,
  OVERDUE_ACTIONS,
  PAYMENT_TERMS_KINDS,
  TARIFF_TYPES,
} from "@flowless/shared-types";
import { tenantPolicy } from "../tenant";
import { organization } from "./auth";

/**
 * The Tariffs module (T-01 to T-03, T-07 to T-10): customer categories, tariffs with
 * immutable effective-dated versions, the charge catalog with its own amount versions, and
 * invoice types with terms, overdue policy, line templates and late-fee rules.
 *
 * Money is `bigint` minor units, rates included: a rate is minor units per unit consumed
 * (82.50 a unit is 8250), which is what docs/billing-engine.html prices with. Dates
 * (`effective_from`) are calendar dates in the organization's time zone.
 *
 * "Version i is in force from its `effective_from` until the next version's": a version
 * has no end column. Versions, category assignments and charge amounts are insert-only
 * (the app role has no UPDATE or DELETE on them); a change is a new row. Two rows may share
 * an `effective_from` while that date is still ahead: the newest row (`version_no`) wins,
 * which is how a mistaken future version is replaced without rewriting history.
 * `accounts.account.category_id` points at `category` by id only (no foreign key).
 */
export const tariffs = pgSchema("tariffs");

const organizationId = () =>
  uuid("organization_id")
    .notNull()
    .references(() => organization.id);

const oneOf = (column: AnyPgColumn, values: readonly string[]) =>
  sql`${column} in (${sql.raw(values.map((v) => `'${v}'`).join(", "))})`;

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/* ---------- tariffs and versions (T-01, T-03) ---------- */

/**
 * A tariff's identity. `type` and `flat_basis` are fixed for its life: every version has
 * the shape that type needs. Only the name and the active flag change.
 */
export const tariff = tariffs.table(
  "tariff",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: organizationId(),
    name: text("name").notNull(),
    type: text("type", { enum: TARIFF_TYPES }).notNull(),
    flatBasis: text("flat_basis", { enum: FLAT_BASES }).notNull().default("none"),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    createdByUserId: uuid("created_by_user_id").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("tariff_organization_id_id_unique").on(t.organizationId, t.id),
    uniqueIndex("tariff_name_unique").on(t.organizationId, sql`lower(${t.name})`),
    check("tariff_type_valid", oneOf(t.type, TARIFF_TYPES)),
    check("tariff_flat_basis_valid", oneOf(t.flatBasis, FLAT_BASES)),
    check("tariff_name_present", sql`length(btrim(${t.name})) > 0`),
    check("tariff_basis_only_flat", sql`${t.type} = 'flat_rate' or ${t.flatBasis} = 'none'`),
    tenantPolicy(t.organizationId),
  ],
);

/** One immutable version of a tariff. Its rates are the rows of `tariff_version_line`. */
export const tariffVersion = tariffs.table(
  "tariff_version",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: organizationId(),
    tariffId: uuid("tariff_id").notNull(),
    versionNo: integer("version_no").notNull(),
    effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
    note: text("note"),
    createdAt: createdAt(),
    createdByUserId: uuid("created_by_user_id").notNull(),
  },
  (t) => [
    unique("tariff_version_organization_id_id_unique").on(t.organizationId, t.id),
    unique("tariff_version_no_unique").on(t.organizationId, t.tariffId, t.versionNo),
    foreignKey({ name: "tariff_version_tariff_fk", columns: [t.organizationId, t.tariffId], foreignColumns: [tariff.organizationId, tariff.id] }),
    check("tariff_version_no_positive", sql`${t.versionNo} >= 1`),
    index("tariff_version_effective_idx").on(t.organizationId, t.tariffId, t.effectiveFrom),
    tenantPolicy(t.organizationId),
  ],
);

/**
 * A version's content, one row per band (block tariffs: `from_units` inclusive,
 * `to_units` exclusive-of-next, null on the open top band), one row for a uniform rate, one
 * row per basis value for a flat rate (`key`: the property type, pipe size or tap count; null
 * when the basis is none). `rate` is minor units: per unit consumed for block and uniform
 * tariffs, per billing month for flat ones.
 */
export const tariffVersionLine = tariffs.table(
  "tariff_version_line",
  {
    organizationId: organizationId(),
    versionId: uuid("version_id").notNull(),
    position: integer("position").notNull(),
    fromUnits: integer("from_units"),
    toUnits: integer("to_units"),
    key: text("key"),
    rate: bigint("rate", { mode: "bigint" }).notNull(),
  },
  (t) => [
    primaryKey({ name: "tariff_version_line_pk", columns: [t.organizationId, t.versionId, t.position] }),
    foreignKey({ name: "tariff_version_line_version_fk", columns: [t.organizationId, t.versionId], foreignColumns: [tariffVersion.organizationId, tariffVersion.id] }),
    check("tariff_version_line_position", sql`${t.position} >= 0`),
    check("tariff_version_line_rate_nonnegative", sql`${t.rate} >= 0`),
    check("tariff_version_line_band", sql`${t.fromUnits} is null or (${t.fromUnits} >= 0 and (${t.toUnits} is null or ${t.toUnits} > ${t.fromUnits}))`),
    check("tariff_version_line_bounds", sql`${t.toUnits} is null or ${t.fromUnits} is not null`),
    tenantPolicy(t.organizationId),
  ],
);

/* ---------- charge catalog (T-07) ---------- */

/**
 * A charge catalog item. `code` and `type` are fixed; the revenue kind is derived from the
 * type (a deposit is a liability). Rate-driven items (usage) have no amount versions. A
 * recurring item has a recurrence, and no other type does. `inventory_item_ref` is
 * Inventory's item, by id only.
 */
export const chargeItem = tariffs.table(
  "charge_item",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: organizationId(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    type: text("type", { enum: CHARGE_TYPES }).notNull(),
    recurrence: text("recurrence", { enum: CHARGE_RECURRENCES }),
    inventoryItemRef: uuid("inventory_item_ref"),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    createdByUserId: uuid("created_by_user_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("charge_item_organization_id_id_unique").on(t.organizationId, t.id),
    unique("charge_item_code_unique").on(t.organizationId, t.code),
    check("charge_item_type_valid", oneOf(t.type, CHARGE_TYPES)),
    check("charge_item_recurrence_valid", sql`${t.recurrence} is null or ${t.recurrence} in (${sql.raw(CHARGE_RECURRENCES.map((v) => `'${v}'`).join(", "))})`),
    check("charge_item_code_format", sql`${t.code} ~ '^[a-z][a-z0-9_]{0,39}$'`),
    check("charge_item_name_present", sql`length(btrim(${t.name})) > 0`),
    check("charge_item_recurrence_only_recurring", sql`(${t.type} = 'recurring') = (${t.recurrence} is not null)`),
    tenantPolicy(t.organizationId),
  ],
);

/** An amount of a charge item from a date, immutable like tariff versions. */
export const chargeItemAmount = tariffs.table(
  "charge_item_amount",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: organizationId(),
    chargeItemId: uuid("charge_item_id").notNull(),
    versionNo: integer("version_no").notNull(),
    effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
    amount: bigint("amount", { mode: "bigint" }).notNull(),
    reason: text("reason"),
    createdAt: createdAt(),
    createdByUserId: uuid("created_by_user_id").notNull(),
  },
  (t) => [
    unique("charge_item_amount_no_unique").on(t.organizationId, t.chargeItemId, t.versionNo),
    foreignKey({ name: "charge_item_amount_item_fk", columns: [t.organizationId, t.chargeItemId], foreignColumns: [chargeItem.organizationId, chargeItem.id] }),
    check("charge_item_amount_no_positive", sql`${t.versionNo} >= 1`),
    check("charge_item_amount_nonnegative", sql`${t.amount} >= 0`),
    index("charge_item_amount_effective_idx").on(t.organizationId, t.chargeItemId, t.effectiveFrom),
    tenantPolicy(t.organizationId),
  ],
);

/* ---------- categories (T-02) ---------- */

/** A customer category. `accounts.account.category_id` is this table's id, with no foreign key. */
export const category = tariffs.table(
  "category",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: organizationId(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    createdByUserId: uuid("created_by_user_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("category_organization_id_id_unique").on(t.organizationId, t.id),
    unique("category_code_unique").on(t.organizationId, t.code),
    check("category_code_format", sql`${t.code} ~ '^[a-z][a-z0-9_]{0,39}$'`),
    check("category_name_present", sql`length(btrim(${t.name})) > 0`),
    tenantPolicy(t.organizationId),
  ],
);

/**
 * What a category is priced with from a date: its tariff, standing charge, meter rent and
 * discount (the last three are charge catalog items). Insert-only: pointing a category at
 * another tariff is a new row, so category to tariff can change over time. Any of the four
 * may be null (a category with no tariff yet; billing raises "missing tariff", B-08).
 */
export const categoryAssignment = tariffs.table(
  "category_assignment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: organizationId(),
    categoryId: uuid("category_id").notNull(),
    versionNo: integer("version_no").notNull(),
    effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
    tariffId: uuid("tariff_id"),
    standingChargeItemId: uuid("standing_charge_item_id"),
    meterRentItemId: uuid("meter_rent_item_id"),
    discountItemId: uuid("discount_item_id"),
    reason: text("reason"),
    createdAt: createdAt(),
    createdByUserId: uuid("created_by_user_id").notNull(),
  },
  (t) => [
    unique("category_assignment_no_unique").on(t.organizationId, t.categoryId, t.versionNo),
    foreignKey({ name: "category_assignment_category_fk", columns: [t.organizationId, t.categoryId], foreignColumns: [category.organizationId, category.id] }),
    foreignKey({ name: "category_assignment_tariff_fk", columns: [t.organizationId, t.tariffId], foreignColumns: [tariff.organizationId, tariff.id] }),
    foreignKey({ name: "category_assignment_standing_fk", columns: [t.organizationId, t.standingChargeItemId], foreignColumns: [chargeItem.organizationId, chargeItem.id] }),
    foreignKey({ name: "category_assignment_rent_fk", columns: [t.organizationId, t.meterRentItemId], foreignColumns: [chargeItem.organizationId, chargeItem.id] }),
    foreignKey({ name: "category_assignment_discount_fk", columns: [t.organizationId, t.discountItemId], foreignColumns: [chargeItem.organizationId, chargeItem.id] }),
    check("category_assignment_no_positive", sql`${t.versionNo} >= 1`),
    index("category_assignment_effective_idx").on(t.organizationId, t.categoryId, t.effectiveFrom),
    tenantPolicy(t.organizationId),
  ],
);

/* ---------- invoice types (T-08 to T-10) ---------- */

/**
 * An invoice type (T-08): numbering (prefix, zero-padded width, first number), default
 * days to due, payment terms (T-09: full, a minimum deposit as basis points of the total or
 * a fixed amount, or installments), and the overdue policy. An invoice that bills an
 * `application` can pause or cancel it and never disconnects; one that bills an `account` can
 * disconnect: the check constraint is the rule's last line of defence.
 */
export const invoiceType = tariffs.table(
  "invoice_type",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: organizationId(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    appliesTo: text("applies_to", { enum: INVOICE_APPLIES_TO }).notNull(),
    numberPrefix: text("number_prefix").notNull().default(""),
    numberWidth: integer("number_width").notNull().default(6),
    numberStart: bigint("number_start", { mode: "number" }).notNull().default(1),
    dueDays: integer("due_days").notNull().default(14),
    termsKind: text("terms_kind", { enum: PAYMENT_TERMS_KINDS }).notNull().default("full"),
    minDepositBp: integer("min_deposit_bp"),
    minDepositAmount: bigint("min_deposit_amount", { mode: "bigint" }),
    installmentCount: integer("installment_count"),
    installmentIntervalDays: integer("installment_interval_days"),
    overdueAction: text("overdue_action", { enum: OVERDUE_ACTIONS }).notNull().default("none"),
    overdueAfterDays: integer("overdue_after_days").notNull().default(0),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    createdByUserId: uuid("created_by_user_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("invoice_type_organization_id_id_unique").on(t.organizationId, t.id),
    unique("invoice_type_code_unique").on(t.organizationId, t.code),
    check("invoice_type_code_format", sql`${t.code} ~ '^[a-z][a-z0-9_]{0,39}$'`),
    check("invoice_type_name_present", sql`length(btrim(${t.name})) > 0`),
    check("invoice_type_applies_to_valid", oneOf(t.appliesTo, INVOICE_APPLIES_TO)),
    check("invoice_type_terms_valid", oneOf(t.termsKind, PAYMENT_TERMS_KINDS)),
    check("invoice_type_overdue_valid", oneOf(t.overdueAction, OVERDUE_ACTIONS)),
    check("invoice_type_number_width", sql`${t.numberWidth} between 1 and 12`),
    check("invoice_type_number_start", sql`${t.numberStart} >= 1`),
    check("invoice_type_prefix_format", sql`${t.numberPrefix} ~ '^[A-Za-z0-9/_-]{0,12}$'`),
    check("invoice_type_due_days", sql`${t.dueDays} between 0 and 365`),
    check("invoice_type_overdue_after", sql`${t.overdueAfterDays} between 0 and 365`),
    // Null-safe (coalesce): a comparison with a missing value is NULL, which a check would let through.
    check(
      "invoice_type_terms_shape",
      sql`coalesce((${t.termsKind} = 'full' and ${t.minDepositBp} is null and ${t.minDepositAmount} is null and ${t.installmentCount} is null and ${t.installmentIntervalDays} is null)
        or (${t.termsKind} = 'minimum_deposit' and ((${t.minDepositBp} between 1 and 10000 and ${t.minDepositAmount} is null) or (${t.minDepositBp} is null and ${t.minDepositAmount} > 0)) and ${t.installmentCount} is null and ${t.installmentIntervalDays} is null)
        or (${t.termsKind} = 'installments' and ${t.minDepositBp} is null and ${t.minDepositAmount} is null and ${t.installmentCount} between 2 and 60 and ${t.installmentIntervalDays} between 1 and 365), false)`,
    ),
    // T-09: an application's unpaid invoice pauses or cancels the application and never disconnects.
    check("invoice_type_overdue_fits", sql`(${t.appliesTo} = 'application' and ${t.overdueAction} <> 'disconnect') or (${t.appliesTo} = 'account' and ${t.overdueAction} in ('disconnect', 'none'))`),
    tenantPolicy(t.organizationId),
  ],
);

/**
 * The next sequence number of an invoice type, taken with one `INSERT ... ON CONFLICT DO
 * UPDATE ... RETURNING` so the row lock serialises allocation. Numbers are allocated by
 * Billing through `allocateInvoiceNumber`; a number once taken is never reused.
 */
export const invoiceTypeCounter = tariffs.table(
  "invoice_type_counter",
  {
    organizationId: organizationId(),
    invoiceTypeId: uuid("invoice_type_id").notNull(),
    nextValue: bigint("next_value", { mode: "number" }).notNull(),
  },
  (t) => [
    primaryKey({ name: "invoice_type_counter_pk", columns: [t.organizationId, t.invoiceTypeId] }),
    foreignKey({ name: "invoice_type_counter_type_fk", columns: [t.organizationId, t.invoiceTypeId], foreignColumns: [invoiceType.organizationId, invoiceType.id] }),
    check("invoice_type_counter_positive", sql`${t.nextValue} >= 1`),
    tenantPolicy(t.organizationId),
  ],
);

/** A line of an invoice type's template (T-08): a charge item, a quantity and an optional amount that overrides the catalog's. */
export const invoiceTypeLine = tariffs.table(
  "invoice_type_line",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: organizationId(),
    invoiceTypeId: uuid("invoice_type_id").notNull(),
    position: integer("position").notNull(),
    chargeItemId: uuid("charge_item_id").notNull(),
    quantity: integer("quantity").notNull().default(1),
    amountOverride: bigint("amount_override", { mode: "bigint" }),
    optional: boolean("optional").notNull().default(false),
  },
  (t) => [
    unique("invoice_type_line_position_unique").on(t.organizationId, t.invoiceTypeId, t.position),
    unique("invoice_type_line_item_unique").on(t.organizationId, t.invoiceTypeId, t.chargeItemId),
    foreignKey({ name: "invoice_type_line_type_fk", columns: [t.organizationId, t.invoiceTypeId], foreignColumns: [invoiceType.organizationId, invoiceType.id] }),
    foreignKey({ name: "invoice_type_line_item_fk", columns: [t.organizationId, t.chargeItemId], foreignColumns: [chargeItem.organizationId, chargeItem.id] }),
    check("invoice_type_line_position", sql`${t.position} >= 0`),
    check("invoice_type_line_quantity", sql`${t.quantity} between 1 and 1000`),
    check("invoice_type_line_override", sql`${t.amountOverride} is null or ${t.amountOverride} >= 0`),
    tenantPolicy(t.organizationId),
  ],
);

/**
 * The late-fee rule of an invoice type (T-10), at most one per type: it starts
 * `trigger_days` after the due date, charges a percentage (basis points) or a flat amount of
 * the overdue balance or the invoice total, up to `cap` in all, once or each 30 days, or
 * only when staff apply it (`manual_only`). The calculation is `lateFee` in the module.
 */
export const lateFeeRule = tariffs.table(
  "late_fee_rule",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: organizationId(),
    invoiceTypeId: uuid("invoice_type_id").notNull(),
    triggerDays: integer("trigger_days").notNull(),
    base: text("base", { enum: LATE_FEE_BASES }).notNull(),
    rateBp: integer("rate_bp"),
    flatAmount: bigint("flat_amount", { mode: "bigint" }),
    cap: bigint("cap", { mode: "bigint" }),
    frequency: text("frequency", { enum: LATE_FEE_FREQUENCIES }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("late_fee_rule_type_unique").on(t.organizationId, t.invoiceTypeId),
    foreignKey({ name: "late_fee_rule_type_fk", columns: [t.organizationId, t.invoiceTypeId], foreignColumns: [invoiceType.organizationId, invoiceType.id] }),
    check("late_fee_rule_base_valid", oneOf(t.base, LATE_FEE_BASES)),
    check("late_fee_rule_frequency_valid", oneOf(t.frequency, LATE_FEE_FREQUENCIES)),
    check("late_fee_rule_trigger_days", sql`${t.triggerDays} between 0 and 365`),
    check("late_fee_rule_rate_xor_flat", sql`coalesce((${t.rateBp} between 1 and 10000 and ${t.flatAmount} is null) or (${t.rateBp} is null and ${t.flatAmount} > 0), false)`),
    check("late_fee_rule_cap_positive", sql`${t.cap} is null or ${t.cap} > 0`),
    tenantPolicy(t.organizationId),
  ],
);
