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
  numeric,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { CHARGE_TYPES } from "@flowless/shared-types";
import { tenantPolicy } from "../tenant";
import { organization } from "./auth";

/**
 * The Billing module's sub-ledger and documents (B-10, B-11, B-14, B-17, B-18, T-04, NF-22,
 * requirements section 5): an append-only double-entry customer ledger and the frozen
 * documents (invoices, credit notes, debit notes, reversals) it posts.
 *
 * - Money is `bigint` minor units with an explicit `currency`; nothing here is a float.
 * - Every table is insert-only for the app role (no UPDATE, DELETE or TRUNCATE); a correction
 *   is a reversal, a credit note, a debit note or a re-bill (a replacement that names the
 *   document it replaces). Balances, running totals and previous readings are never stored;
 *   they are derived by queries in the module.
 * - A ledger transaction is sealed: it declares its `entry_count` and currency, and a
 *   deferred constraint trigger refuses a commit in which its entries are not exactly that
 *   many, not all in that currency, or debits differ from credits. A document likewise
 *   declares `line_count` and a `total`, and its lines must sum to it (I-4).
 * - References to other modules (`account_id`, `service_point_id`, `category_id`,
 *   `charge_item_id`, `invoice_type_id`, `tariff_version_id`, `charge_item_amount_id`, scheme,
 *   zone) are opaque ids with no foreign key: modules never read each other's tables, and
 *   history must survive a deactivated category or moved service point. The dimensions are
 *   a snapshot taken at posting.
 * - Document numbers come from Tariffs' `allocateInvoiceNumber` (opaque `invoice_type_id`,
 *   `number`, `number_sequence`).
 */
export const billing = pgSchema("billing");

export const DOCUMENT_KINDS = ["invoice", "credit_note", "debit_note", "reversal"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/** `consumption` is usage priced from a tariff version; `true_up` is the visible estimate credit (B-10). */
export const DOCUMENT_LINE_TYPES = ["consumption", "true_up", "standing", "charge", "fee", "penalty", "deposit", "adjustment", "transfer"] as const;
export type DocumentLineType = (typeof DOCUMENT_LINE_TYPES)[number];

/** Entry types of requirements section 5, plus `reversal` for the mirror of an earlier transaction. */
export const LEDGER_ENTRY_TYPES = ["charge", "payment", "adjustment", "credit", "deposit", "write_off", "transfer", "reversal"] as const;
export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number];

/** The sub-ledger's accounts; `receivable` is the customer's balance (debit = owes). */
export const LEDGER_ACCOUNTS = ["receivable", "revenue", "deposit_liability", "customer_credit", "cash_clearing", "write_off_expense", "transfer_clearing", "suspense"] as const;
export type LedgerAccount = (typeof LEDGER_ACCOUNTS)[number];

export const LEDGER_SIDES = ["debit", "credit"] as const;
export type LedgerSide = (typeof LEDGER_SIDES)[number];

/** `migration` rows are history written by the importer (Q-05); they carry their original dates. */
export const BILLING_SOURCES = ["live", "migration"] as const;
export type BillingSource = (typeof BILLING_SOURCES)[number];

const organizationId = () =>
  uuid("organization_id")
    .notNull()
    .references(() => organization.id);

const oneOf = (column: AnyPgColumn, values: readonly string[]) =>
  sql`${column} in (${sql.raw(values.map((v) => `'${v}'`).join(", "))})`;

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const money = (name: string) => bigint(name, { mode: "bigint" });
const currency = () => text("currency").notNull();
const currencyCheck = (name: string, column: AnyPgColumn) => check(name, sql`${column} ~ '^[A-Z]{3}$'`);

/* ---------- documents (B-10, B-11, B-14, T-04) ---------- */

/**
 * A frozen billing document. The total is signed by its effect on what the customer owes:
 * an invoice or debit note is zero or more, a credit note zero or less, a reversal the
 * opposite of the document it reverses. `idempotency_key` makes a retried issue return the
 * earlier document (NF-22).
 */
export const document = billing.table(
  "document",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: organizationId(),
    kind: text("kind", { enum: DOCUMENT_KINDS }).notNull(),
    /** Opaque Tariffs invoice type, number and sequence from `allocateInvoiceNumber`. */
    invoiceTypeId: uuid("invoice_type_id").notNull(),
    number: text("number").notNull(),
    numberSequence: bigint("number_sequence", { mode: "number" }).notNull(),
    /** Opaque Accounts ids. */
    accountId: uuid("account_id").notNull(),
    customerId: uuid("customer_id"),
    currency: currency(),
    total: money("total").notNull(),
    /** Lines the document must end up with; checked at commit, so no line can be added later. */
    lineCount: integer("line_count").notNull(),
    issuedOn: date("issued_on", { mode: "string" }).notNull(),
    dueOn: date("due_on", { mode: "string" }),
    periodFrom: date("period_from", { mode: "string" }),
    periodTo: date("period_to", { mode: "string" }),
    /** A credit or debit note cites the document it corrects (B-14); optional for a stand-alone credit. */
    relatedDocumentId: uuid("related_document_id"),
    /** A reversal (void) names the one document it reverses, once. */
    reversesDocumentId: uuid("reverses_document_id"),
    /** A re-bill replacement names the voided document it replaces (B-11, a linked pair). */
    replacesDocumentId: uuid("replaces_document_id"),
    /** Opaque billing run or cycle, when issued by one. */
    runId: uuid("run_id"),
    source: text("source", { enum: BILLING_SOURCES }).notNull().default("live"),
    /** The final bill of a disconnection (B-12, C-11): Accounts' termination check looks for a live one. Set at insert, never changed. */
    finalBill: boolean("final_bill").notNull().default(false),
    idempotencyKey: text("idempotency_key").notNull(),
    note: text("note"),
    createdAt: createdAt(),
    createdByUserId: uuid("created_by_user_id"),
  },
  (t) => [
    unique("document_organization_id_id_unique").on(t.organizationId, t.id),
    unique("document_organization_id_id_currency_unique").on(t.organizationId, t.id, t.currency),
    unique("document_number_unique").on(t.organizationId, t.number),
    unique("document_sequence_unique").on(t.organizationId, t.invoiceTypeId, t.numberSequence),
    unique("document_idempotency_unique").on(t.organizationId, t.idempotencyKey),
    uniqueIndex("document_reverses_unique").on(t.organizationId, t.reversesDocumentId).where(sql`${t.reversesDocumentId} is not null`),
    uniqueIndex("document_replaces_unique").on(t.organizationId, t.replacesDocumentId).where(sql`${t.replacesDocumentId} is not null`),
    foreignKey({ name: "document_related_fk", columns: [t.organizationId, t.relatedDocumentId], foreignColumns: [t.organizationId, t.id] }),
    foreignKey({ name: "document_reverses_fk", columns: [t.organizationId, t.reversesDocumentId], foreignColumns: [t.organizationId, t.id] }),
    foreignKey({ name: "document_replaces_fk", columns: [t.organizationId, t.replacesDocumentId], foreignColumns: [t.organizationId, t.id] }),
    index("document_account_idx").on(t.organizationId, t.accountId, t.issuedOn),
    index("document_run_idx").on(t.organizationId, t.runId).where(sql`${t.runId} is not null`),
    check("document_kind_valid", oneOf(t.kind, DOCUMENT_KINDS)),
    check("document_source_valid", oneOf(t.source, BILLING_SOURCES)),
    currencyCheck("document_currency_valid", t.currency),
    check("document_number_present", sql`length(btrim(${t.number})) > 0 and ${t.numberSequence} >= 0`),
    check("document_line_count_positive", sql`${t.lineCount} >= 1`),
    check(
      "document_total_sign",
      sql`coalesce(case ${t.kind} when 'invoice' then ${t.total} >= 0 when 'debit_note' then ${t.total} >= 0 when 'credit_note' then ${t.total} <= 0 else true end, false)`,
    ),
    check("document_period", sql`(${t.periodFrom} is null) = (${t.periodTo} is null) and coalesce(${t.periodTo} >= ${t.periodFrom}, true)`),
    check("document_due_after_issue", sql`${t.dueOn} is null or ${t.dueOn} >= ${t.issuedOn}`),
    check("document_reversal_links", sql`coalesce((${t.kind} = 'reversal') = (${t.reversesDocumentId} is not null), false)`),
    check("document_related_kinds", sql`${t.relatedDocumentId} is null or ${t.kind} in ('credit_note', 'debit_note')`),
    check("document_final_kind", sql`not ${t.finalBill} or ${t.kind} in ('invoice', 'credit_note')`),
    check("document_replaces_invoice", sql`${t.replacesDocumentId} is null or ${t.kind} = 'invoice'`),
    check("document_no_self_link", sql`${t.relatedDocumentId} is distinct from ${t.id} and ${t.reversesDocumentId} is distinct from ${t.id} and ${t.replacesDocumentId} is distinct from ${t.id}`),
    tenantPolicy(t.organizationId),
  ],
);

/**
 * One line of a document. `amount` is signed (a true-up line is negative). Tariff-priced
 * lines cite the tariff version used (T-04) and catalog lines the charge amount version
 * charged, both opaque; `service_from` and `service_to` say which days the line covers
 * (B-14). `calculation` is the attached working for office users (B-13).
 */
export const documentLine = billing.table(
  "document_line",
  {
    organizationId: organizationId(),
    documentId: uuid("document_id").notNull(),
    position: integer("position").notNull(),
    lineType: text("line_type", { enum: DOCUMENT_LINE_TYPES }).notNull(),
    description: text("description").notNull(),
    /** Units (for example cubic metres) or months; null for lines that are not quantities. */
    quantity: numeric("quantity", { precision: 20, scale: 6 }),
    unitRate: money("unit_rate"),
    amount: money("amount").notNull(),
    serviceFrom: date("service_from", { mode: "string" }),
    serviceTo: date("service_to", { mode: "string" }),
    tariffVersionId: uuid("tariff_version_id"),
    chargeItemId: uuid("charge_item_id"),
    chargeItemAmountId: uuid("charge_item_amount_id"),
    chargeType: text("charge_type", { enum: CHARGE_TYPES }),
    calculation: jsonb("calculation"),
  },
  (t) => [
    primaryKey({ name: "document_line_pk", columns: [t.organizationId, t.documentId, t.position] }),
    foreignKey({ name: "document_line_document_fk", columns: [t.organizationId, t.documentId], foreignColumns: [document.organizationId, document.id] }),
    check("document_line_type_valid", oneOf(t.lineType, DOCUMENT_LINE_TYPES)),
    check("document_line_position", sql`${t.position} >= 0`),
    check("document_line_description_present", sql`length(btrim(${t.description})) > 0`),
    check("document_line_service_span", sql`(${t.serviceFrom} is null) = (${t.serviceTo} is null) and coalesce(${t.serviceTo} >= ${t.serviceFrom}, true)`),
    // T-04: a tariff-priced line stores the version it was priced with; a catalog line the amount version.
    check("document_line_cites_tariff_version", sql`coalesce(${t.lineType} not in ('consumption', 'true_up') or ${t.tariffVersionId} is not null, false)`),
    check("document_line_cites_charge_amount", sql`coalesce(${t.lineType} not in ('standing', 'charge', 'fee', 'penalty', 'deposit') or ${t.chargeItemAmountId} is not null, false)`),
    check("document_line_rate_nonnegative", sql`${t.unitRate} is null or ${t.unitRate} >= 0`),
    tenantPolicy(t.organizationId),
  ],
);

/* ---------- sub-ledger (NF-22, section 5) ---------- */

/**
 * The header of one balanced posting. `entry_count` and `currency` seal it: the deferred
 * trigger `billing.check_transaction_balanced` requires exactly that many entries, all in
 * that currency, with debits equal to credits. `reverses_transaction_id` makes a reversal
 * the mirror of one earlier transaction (at most once). `idempotency_key` makes a retried
 * post return the earlier transaction.
 */
export const ledgerTransaction = billing.table(
  "ledger_transaction",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: organizationId(),
    entryType: text("entry_type", { enum: LEDGER_ENTRY_TYPES }).notNull(),
    currency: currency(),
    entryCount: integer("entry_count").notNull(),
    /** The date the posting counts for (period placement); `posted_at` is when it was written. */
    effectiveOn: date("effective_on", { mode: "string" }).notNull(),
    postedAt: timestamp("posted_at", { withTimezone: true }).notNull().defaultNow(),
    documentId: uuid("document_id"),
    /** Opaque id of what caused the posting outside Billing (a payment, a write-off approval). */
    sourceRef: text("source_ref"),
    reversesTransactionId: uuid("reverses_transaction_id"),
    source: text("source", { enum: BILLING_SOURCES }).notNull().default("live"),
    idempotencyKey: text("idempotency_key").notNull(),
    description: text("description"),
    createdByUserId: uuid("created_by_user_id"),
  },
  (t) => [
    unique("ledger_transaction_organization_id_id_unique").on(t.organizationId, t.id),
    unique("ledger_transaction_id_currency_unique").on(t.organizationId, t.id, t.currency),
    unique("ledger_transaction_idempotency_unique").on(t.organizationId, t.idempotencyKey),
    uniqueIndex("ledger_transaction_reverses_unique").on(t.organizationId, t.reversesTransactionId).where(sql`${t.reversesTransactionId} is not null`),
    foreignKey({ name: "ledger_transaction_reverses_fk", columns: [t.organizationId, t.reversesTransactionId], foreignColumns: [t.organizationId, t.id] }),
    // The document and the transaction posting it share a currency.
    foreignKey({ name: "ledger_transaction_document_fk", columns: [t.organizationId, t.documentId, t.currency], foreignColumns: [document.organizationId, document.id, document.currency] }),
    index("ledger_transaction_document_idx").on(t.organizationId, t.documentId).where(sql`${t.documentId} is not null`),
    index("ledger_transaction_effective_idx").on(t.organizationId, t.effectiveOn),
    check("ledger_transaction_type_valid", oneOf(t.entryType, LEDGER_ENTRY_TYPES)),
    check("ledger_transaction_source_valid", oneOf(t.source, BILLING_SOURCES)),
    currencyCheck("ledger_transaction_currency_valid", t.currency),
    check("ledger_transaction_entry_count", sql`${t.entryCount} >= 2`),
    check("ledger_transaction_reversal_link", sql`coalesce((${t.entryType} = 'reversal') = (${t.reversesTransactionId} is not null), false)`),
    check("ledger_transaction_no_self_reversal", sql`${t.reversesTransactionId} is distinct from ${t.id}`),
    tenantPolicy(t.organizationId),
  ],
);

/**
 * One side of a posting: a positive `amount` on the `debit` or `credit` side of a ledger
 * account. The receivable's balance is debits minus credits, derived by queries. The
 * dimensions (account, service point, scheme, zone, category, charge item and type,
 * invoice type, payment channel, service period) are a snapshot of the posting time.
 */
export const ledgerEntry = billing.table(
  "ledger_entry",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: organizationId(),
    transactionId: uuid("transaction_id").notNull(),
    lineNo: integer("line_no").notNull(),
    currency: currency(),
    side: text("side", { enum: LEDGER_SIDES }).notNull(),
    amount: money("amount").notNull(),
    ledgerAccount: text("ledger_account", { enum: LEDGER_ACCOUNTS }).notNull(),
    /** Dimensions. `account_id` is required: this is the customer sub-ledger. */
    accountId: uuid("account_id").notNull(),
    servicePointId: uuid("service_point_id"),
    schemeId: uuid("scheme_id"),
    zoneId: uuid("zone_id"),
    categoryId: uuid("category_id"),
    chargeItemId: uuid("charge_item_id"),
    chargeType: text("charge_type", { enum: CHARGE_TYPES }),
    invoiceTypeId: uuid("invoice_type_id"),
    paymentChannel: text("payment_channel"),
    serviceFrom: date("service_from", { mode: "string" }),
    serviceTo: date("service_to", { mode: "string" }),
    tariffVersionId: uuid("tariff_version_id"),
    chargeItemAmountId: uuid("charge_item_amount_id"),
    /** The document line this entry posts, when it posts one. */
    documentId: uuid("document_id"),
    documentLinePosition: integer("document_line_position"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("ledger_entry_line_unique").on(t.organizationId, t.transactionId, t.lineNo),
    foreignKey({ name: "ledger_entry_transaction_fk", columns: [t.organizationId, t.transactionId, t.currency], foreignColumns: [ledgerTransaction.organizationId, ledgerTransaction.id, ledgerTransaction.currency] }),
    foreignKey({ name: "ledger_entry_document_line_fk", columns: [t.organizationId, t.documentId, t.documentLinePosition], foreignColumns: [documentLine.organizationId, documentLine.documentId, documentLine.position] }),
    index("ledger_entry_account_idx").on(t.organizationId, t.accountId, t.ledgerAccount),
    index("ledger_entry_service_point_idx").on(t.organizationId, t.servicePointId).where(sql`${t.servicePointId} is not null`),
    index("ledger_entry_dimensions_idx").on(t.organizationId, t.schemeId, t.zoneId, t.categoryId),
    index("ledger_entry_service_idx").on(t.organizationId, t.serviceFrom, t.serviceTo),
    check("ledger_entry_side_valid", oneOf(t.side, LEDGER_SIDES)),
    check("ledger_entry_account_valid", oneOf(t.ledgerAccount, LEDGER_ACCOUNTS)),
    currencyCheck("ledger_entry_currency_valid", t.currency),
    check("ledger_entry_amount_positive", sql`${t.amount} > 0`),
    check("ledger_entry_line_no", sql`${t.lineNo} >= 0`),
    check("ledger_entry_service_span", sql`(${t.serviceFrom} is null) = (${t.serviceTo} is null) and coalesce(${t.serviceTo} >= ${t.serviceFrom}, true)`),
    check("ledger_entry_document_line_both", sql`(${t.documentId} is null) = (${t.documentLinePosition} is null)`),
    tenantPolicy(t.organizationId),
  ],
);
