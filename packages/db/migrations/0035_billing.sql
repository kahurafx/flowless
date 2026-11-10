CREATE SCHEMA "billing";
--> statement-breakpoint
CREATE TABLE "billing"."document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"invoice_type_id" uuid NOT NULL,
	"number" text NOT NULL,
	"number_sequence" bigint NOT NULL,
	"account_id" uuid NOT NULL,
	"customer_id" uuid,
	"currency" text NOT NULL,
	"total" bigint NOT NULL,
	"line_count" integer NOT NULL,
	"issued_on" date NOT NULL,
	"due_on" date,
	"period_from" date,
	"period_to" date,
	"related_document_id" uuid,
	"reverses_document_id" uuid,
	"replaces_document_id" uuid,
	"run_id" uuid,
	"source" text DEFAULT 'live' NOT NULL,
	"idempotency_key" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid,
	CONSTRAINT "document_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "document_organization_id_id_currency_unique" UNIQUE("organization_id","id","currency"),
	CONSTRAINT "document_number_unique" UNIQUE("organization_id","number"),
	CONSTRAINT "document_sequence_unique" UNIQUE("organization_id","invoice_type_id","number_sequence"),
	CONSTRAINT "document_idempotency_unique" UNIQUE("organization_id","idempotency_key"),
	CONSTRAINT "document_kind_valid" CHECK ("billing"."document"."kind" in ('invoice', 'credit_note', 'debit_note', 'reversal')),
	CONSTRAINT "document_source_valid" CHECK ("billing"."document"."source" in ('live', 'migration')),
	CONSTRAINT "document_currency_valid" CHECK ("billing"."document"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "document_number_present" CHECK (length(btrim("billing"."document"."number")) > 0 and "billing"."document"."number_sequence" >= 0),
	CONSTRAINT "document_line_count_positive" CHECK ("billing"."document"."line_count" >= 1),
	CONSTRAINT "document_total_sign" CHECK (coalesce(case "billing"."document"."kind" when 'invoice' then "billing"."document"."total" >= 0 when 'debit_note' then "billing"."document"."total" >= 0 when 'credit_note' then "billing"."document"."total" <= 0 else true end, false)),
	CONSTRAINT "document_period" CHECK (("billing"."document"."period_from" is null) = ("billing"."document"."period_to" is null) and coalesce("billing"."document"."period_to" >= "billing"."document"."period_from", true)),
	CONSTRAINT "document_due_after_issue" CHECK ("billing"."document"."due_on" is null or "billing"."document"."due_on" >= "billing"."document"."issued_on"),
	CONSTRAINT "document_reversal_links" CHECK (coalesce(("billing"."document"."kind" = 'reversal') = ("billing"."document"."reverses_document_id" is not null), false)),
	CONSTRAINT "document_related_kinds" CHECK ("billing"."document"."related_document_id" is null or "billing"."document"."kind" in ('credit_note', 'debit_note')),
	CONSTRAINT "document_replaces_invoice" CHECK ("billing"."document"."replaces_document_id" is null or "billing"."document"."kind" = 'invoice'),
	CONSTRAINT "document_no_self_link" CHECK ("billing"."document"."related_document_id" is distinct from "billing"."document"."id" and "billing"."document"."reverses_document_id" is distinct from "billing"."document"."id" and "billing"."document"."replaces_document_id" is distinct from "billing"."document"."id")
);
--> statement-breakpoint
ALTER TABLE "billing"."document" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "billing"."document_line" (
	"organization_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"line_type" text NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(20, 6),
	"unit_rate" bigint,
	"amount" bigint NOT NULL,
	"service_from" date,
	"service_to" date,
	"tariff_version_id" uuid,
	"charge_item_id" uuid,
	"charge_item_amount_id" uuid,
	"charge_type" text,
	"calculation" jsonb,
	CONSTRAINT "document_line_pk" PRIMARY KEY("organization_id","document_id","position"),
	CONSTRAINT "document_line_type_valid" CHECK ("billing"."document_line"."line_type" in ('consumption', 'true_up', 'standing', 'charge', 'fee', 'penalty', 'deposit', 'adjustment', 'transfer')),
	CONSTRAINT "document_line_position" CHECK ("billing"."document_line"."position" >= 0),
	CONSTRAINT "document_line_description_present" CHECK (length(btrim("billing"."document_line"."description")) > 0),
	CONSTRAINT "document_line_service_span" CHECK (("billing"."document_line"."service_from" is null) = ("billing"."document_line"."service_to" is null) and coalesce("billing"."document_line"."service_to" >= "billing"."document_line"."service_from", true)),
	CONSTRAINT "document_line_cites_tariff_version" CHECK (coalesce("billing"."document_line"."line_type" not in ('consumption', 'true_up') or "billing"."document_line"."tariff_version_id" is not null, false)),
	CONSTRAINT "document_line_cites_charge_amount" CHECK (coalesce("billing"."document_line"."line_type" not in ('standing', 'charge', 'fee', 'penalty', 'deposit') or "billing"."document_line"."charge_item_amount_id" is not null, false)),
	CONSTRAINT "document_line_rate_nonnegative" CHECK ("billing"."document_line"."unit_rate" is null or "billing"."document_line"."unit_rate" >= 0)
);
--> statement-breakpoint
ALTER TABLE "billing"."document_line" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "billing"."ledger_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"currency" text NOT NULL,
	"side" text NOT NULL,
	"amount" bigint NOT NULL,
	"ledger_account" text NOT NULL,
	"account_id" uuid NOT NULL,
	"service_point_id" uuid,
	"scheme_id" uuid,
	"zone_id" uuid,
	"category_id" uuid,
	"charge_item_id" uuid,
	"charge_type" text,
	"invoice_type_id" uuid,
	"payment_channel" text,
	"service_from" date,
	"service_to" date,
	"tariff_version_id" uuid,
	"charge_item_amount_id" uuid,
	"document_id" uuid,
	"document_line_position" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entry_line_unique" UNIQUE("organization_id","transaction_id","line_no"),
	CONSTRAINT "ledger_entry_side_valid" CHECK ("billing"."ledger_entry"."side" in ('debit', 'credit')),
	CONSTRAINT "ledger_entry_account_valid" CHECK ("billing"."ledger_entry"."ledger_account" in ('receivable', 'revenue', 'deposit_liability', 'customer_credit', 'cash_clearing', 'write_off_expense', 'transfer_clearing', 'suspense')),
	CONSTRAINT "ledger_entry_currency_valid" CHECK ("billing"."ledger_entry"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "ledger_entry_amount_positive" CHECK ("billing"."ledger_entry"."amount" > 0),
	CONSTRAINT "ledger_entry_line_no" CHECK ("billing"."ledger_entry"."line_no" >= 0),
	CONSTRAINT "ledger_entry_service_span" CHECK (("billing"."ledger_entry"."service_from" is null) = ("billing"."ledger_entry"."service_to" is null) and coalesce("billing"."ledger_entry"."service_to" >= "billing"."ledger_entry"."service_from", true)),
	CONSTRAINT "ledger_entry_document_line_both" CHECK (("billing"."ledger_entry"."document_id" is null) = ("billing"."ledger_entry"."document_line_position" is null))
);
--> statement-breakpoint
ALTER TABLE "billing"."ledger_entry" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "billing"."ledger_transaction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"entry_type" text NOT NULL,
	"currency" text NOT NULL,
	"entry_count" integer NOT NULL,
	"effective_on" date NOT NULL,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"document_id" uuid,
	"source_ref" text,
	"reverses_transaction_id" uuid,
	"source" text DEFAULT 'live' NOT NULL,
	"idempotency_key" text NOT NULL,
	"description" text,
	"created_by_user_id" uuid,
	CONSTRAINT "ledger_transaction_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "ledger_transaction_id_currency_unique" UNIQUE("organization_id","id","currency"),
	CONSTRAINT "ledger_transaction_idempotency_unique" UNIQUE("organization_id","idempotency_key"),
	CONSTRAINT "ledger_transaction_type_valid" CHECK ("billing"."ledger_transaction"."entry_type" in ('charge', 'payment', 'adjustment', 'credit', 'deposit', 'write_off', 'transfer', 'reversal')),
	CONSTRAINT "ledger_transaction_source_valid" CHECK ("billing"."ledger_transaction"."source" in ('live', 'migration')),
	CONSTRAINT "ledger_transaction_currency_valid" CHECK ("billing"."ledger_transaction"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "ledger_transaction_entry_count" CHECK ("billing"."ledger_transaction"."entry_count" >= 2),
	CONSTRAINT "ledger_transaction_reversal_link" CHECK (coalesce(("billing"."ledger_transaction"."entry_type" = 'reversal') = ("billing"."ledger_transaction"."reverses_transaction_id" is not null), false)),
	CONSTRAINT "ledger_transaction_no_self_reversal" CHECK ("billing"."ledger_transaction"."reverses_transaction_id" is distinct from "billing"."ledger_transaction"."id")
);
--> statement-breakpoint
ALTER TABLE "billing"."ledger_transaction" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "billing"."document" ADD CONSTRAINT "document_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."document" ADD CONSTRAINT "document_related_fk" FOREIGN KEY ("organization_id","related_document_id") REFERENCES "billing"."document"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."document" ADD CONSTRAINT "document_reverses_fk" FOREIGN KEY ("organization_id","reverses_document_id") REFERENCES "billing"."document"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."document" ADD CONSTRAINT "document_replaces_fk" FOREIGN KEY ("organization_id","replaces_document_id") REFERENCES "billing"."document"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."document_line" ADD CONSTRAINT "document_line_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."document_line" ADD CONSTRAINT "document_line_document_fk" FOREIGN KEY ("organization_id","document_id") REFERENCES "billing"."document"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."ledger_entry" ADD CONSTRAINT "ledger_entry_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."ledger_entry" ADD CONSTRAINT "ledger_entry_transaction_fk" FOREIGN KEY ("organization_id","transaction_id","currency") REFERENCES "billing"."ledger_transaction"("organization_id","id","currency") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."ledger_entry" ADD CONSTRAINT "ledger_entry_document_line_fk" FOREIGN KEY ("organization_id","document_id","document_line_position") REFERENCES "billing"."document_line"("organization_id","document_id","position") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."ledger_transaction" ADD CONSTRAINT "ledger_transaction_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."ledger_transaction" ADD CONSTRAINT "ledger_transaction_reverses_fk" FOREIGN KEY ("organization_id","reverses_transaction_id") REFERENCES "billing"."ledger_transaction"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."ledger_transaction" ADD CONSTRAINT "ledger_transaction_document_fk" FOREIGN KEY ("organization_id","document_id","currency") REFERENCES "billing"."document"("organization_id","id","currency") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_reverses_unique" ON "billing"."document" USING btree ("organization_id","reverses_document_id") WHERE "billing"."document"."reverses_document_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "document_replaces_unique" ON "billing"."document" USING btree ("organization_id","replaces_document_id") WHERE "billing"."document"."replaces_document_id" is not null;--> statement-breakpoint
CREATE INDEX "document_account_idx" ON "billing"."document" USING btree ("organization_id","account_id","issued_on");--> statement-breakpoint
CREATE INDEX "document_run_idx" ON "billing"."document" USING btree ("organization_id","run_id") WHERE "billing"."document"."run_id" is not null;--> statement-breakpoint
CREATE INDEX "ledger_entry_account_idx" ON "billing"."ledger_entry" USING btree ("organization_id","account_id","ledger_account");--> statement-breakpoint
CREATE INDEX "ledger_entry_service_point_idx" ON "billing"."ledger_entry" USING btree ("organization_id","service_point_id") WHERE "billing"."ledger_entry"."service_point_id" is not null;--> statement-breakpoint
CREATE INDEX "ledger_entry_dimensions_idx" ON "billing"."ledger_entry" USING btree ("organization_id","scheme_id","zone_id","category_id");--> statement-breakpoint
CREATE INDEX "ledger_entry_service_idx" ON "billing"."ledger_entry" USING btree ("organization_id","service_from","service_to");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_transaction_reverses_unique" ON "billing"."ledger_transaction" USING btree ("organization_id","reverses_transaction_id") WHERE "billing"."ledger_transaction"."reverses_transaction_id" is not null;--> statement-breakpoint
CREATE INDEX "ledger_transaction_document_idx" ON "billing"."ledger_transaction" USING btree ("organization_id","document_id") WHERE "billing"."ledger_transaction"."document_id" is not null;--> statement-breakpoint
CREATE INDEX "ledger_transaction_effective_idx" ON "billing"."ledger_transaction" USING btree ("organization_id","effective_on");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "billing"."document" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("billing"."document"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("billing"."document"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "billing"."document_line" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("billing"."document_line"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("billing"."document_line"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "billing"."ledger_entry" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("billing"."ledger_entry"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("billing"."ledger_entry"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "billing"."ledger_transaction" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("billing"."ledger_transaction"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("billing"."ledger_transaction"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);