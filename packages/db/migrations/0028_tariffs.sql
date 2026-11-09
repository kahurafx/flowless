CREATE SCHEMA "tariffs";
--> statement-breakpoint
CREATE TABLE "tariffs"."category" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "category_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "category_code_unique" UNIQUE("organization_id","code"),
	CONSTRAINT "category_code_format" CHECK ("tariffs"."category"."code" ~ '^[a-z][a-z0-9_]{0,39}$'),
	CONSTRAINT "category_name_present" CHECK (length(btrim("tariffs"."category"."name")) > 0)
);
--> statement-breakpoint
ALTER TABLE "tariffs"."category" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tariffs"."category_assignment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"effective_from" date NOT NULL,
	"tariff_id" uuid,
	"standing_charge_item_id" uuid,
	"meter_rent_item_id" uuid,
	"discount_item_id" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	CONSTRAINT "category_assignment_no_unique" UNIQUE("organization_id","category_id","version_no"),
	CONSTRAINT "category_assignment_no_positive" CHECK ("tariffs"."category_assignment"."version_no" >= 1)
);
--> statement-breakpoint
ALTER TABLE "tariffs"."category_assignment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tariffs"."charge_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"recurrence" text,
	"inventory_item_ref" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "charge_item_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "charge_item_code_unique" UNIQUE("organization_id","code"),
	CONSTRAINT "charge_item_type_valid" CHECK ("tariffs"."charge_item"."type" in ('usage', 'recurring', 'fee', 'penalty', 'deposit', 'material', 'labour', 'transfer', 'adjustment')),
	CONSTRAINT "charge_item_recurrence_valid" CHECK ("tariffs"."charge_item"."recurrence" is null or "tariffs"."charge_item"."recurrence" in ('monthly', 'quarterly', 'annually')),
	CONSTRAINT "charge_item_code_format" CHECK ("tariffs"."charge_item"."code" ~ '^[a-z][a-z0-9_]{0,39}$'),
	CONSTRAINT "charge_item_name_present" CHECK (length(btrim("tariffs"."charge_item"."name")) > 0),
	CONSTRAINT "charge_item_recurrence_only_recurring" CHECK (("tariffs"."charge_item"."type" = 'recurring') = ("tariffs"."charge_item"."recurrence" is not null))
);
--> statement-breakpoint
ALTER TABLE "tariffs"."charge_item" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tariffs"."charge_item_amount" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"charge_item_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"effective_from" date NOT NULL,
	"amount" bigint NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	CONSTRAINT "charge_item_amount_no_unique" UNIQUE("organization_id","charge_item_id","version_no"),
	CONSTRAINT "charge_item_amount_no_positive" CHECK ("tariffs"."charge_item_amount"."version_no" >= 1),
	CONSTRAINT "charge_item_amount_nonnegative" CHECK ("tariffs"."charge_item_amount"."amount" >= 0)
);
--> statement-breakpoint
ALTER TABLE "tariffs"."charge_item_amount" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tariffs"."invoice_type" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"applies_to" text NOT NULL,
	"number_prefix" text DEFAULT '' NOT NULL,
	"number_width" integer DEFAULT 6 NOT NULL,
	"number_start" bigint DEFAULT 1 NOT NULL,
	"due_days" integer DEFAULT 14 NOT NULL,
	"terms_kind" text DEFAULT 'full' NOT NULL,
	"min_deposit_bp" integer,
	"min_deposit_amount" bigint,
	"installment_count" integer,
	"installment_interval_days" integer,
	"overdue_action" text DEFAULT 'none' NOT NULL,
	"overdue_after_days" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_type_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "invoice_type_code_unique" UNIQUE("organization_id","code"),
	CONSTRAINT "invoice_type_code_format" CHECK ("tariffs"."invoice_type"."code" ~ '^[a-z][a-z0-9_]{0,39}$'),
	CONSTRAINT "invoice_type_name_present" CHECK (length(btrim("tariffs"."invoice_type"."name")) > 0),
	CONSTRAINT "invoice_type_applies_to_valid" CHECK ("tariffs"."invoice_type"."applies_to" in ('application', 'account')),
	CONSTRAINT "invoice_type_terms_valid" CHECK ("tariffs"."invoice_type"."terms_kind" in ('full', 'minimum_deposit', 'installments')),
	CONSTRAINT "invoice_type_overdue_valid" CHECK ("tariffs"."invoice_type"."overdue_action" in ('disconnect', 'pause_application', 'cancel_application', 'none')),
	CONSTRAINT "invoice_type_number_width" CHECK ("tariffs"."invoice_type"."number_width" between 1 and 12),
	CONSTRAINT "invoice_type_number_start" CHECK ("tariffs"."invoice_type"."number_start" >= 1),
	CONSTRAINT "invoice_type_prefix_format" CHECK ("tariffs"."invoice_type"."number_prefix" ~ '^[A-Za-z0-9/_-]{0,12}$'),
	CONSTRAINT "invoice_type_due_days" CHECK ("tariffs"."invoice_type"."due_days" between 0 and 365),
	CONSTRAINT "invoice_type_overdue_after" CHECK ("tariffs"."invoice_type"."overdue_after_days" between 0 and 365),
	CONSTRAINT "invoice_type_terms_shape" CHECK (coalesce(("tariffs"."invoice_type"."terms_kind" = 'full' and "tariffs"."invoice_type"."min_deposit_bp" is null and "tariffs"."invoice_type"."min_deposit_amount" is null and "tariffs"."invoice_type"."installment_count" is null and "tariffs"."invoice_type"."installment_interval_days" is null)
        or ("tariffs"."invoice_type"."terms_kind" = 'minimum_deposit' and (("tariffs"."invoice_type"."min_deposit_bp" between 1 and 10000 and "tariffs"."invoice_type"."min_deposit_amount" is null) or ("tariffs"."invoice_type"."min_deposit_bp" is null and "tariffs"."invoice_type"."min_deposit_amount" > 0)) and "tariffs"."invoice_type"."installment_count" is null and "tariffs"."invoice_type"."installment_interval_days" is null)
        or ("tariffs"."invoice_type"."terms_kind" = 'installments' and "tariffs"."invoice_type"."min_deposit_bp" is null and "tariffs"."invoice_type"."min_deposit_amount" is null and "tariffs"."invoice_type"."installment_count" between 2 and 60 and "tariffs"."invoice_type"."installment_interval_days" between 1 and 365), false)),
	CONSTRAINT "invoice_type_overdue_fits" CHECK (("tariffs"."invoice_type"."applies_to" = 'application' and "tariffs"."invoice_type"."overdue_action" <> 'disconnect') or ("tariffs"."invoice_type"."applies_to" = 'account' and "tariffs"."invoice_type"."overdue_action" in ('disconnect', 'none')))
);
--> statement-breakpoint
ALTER TABLE "tariffs"."invoice_type" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tariffs"."invoice_type_counter" (
	"organization_id" uuid NOT NULL,
	"invoice_type_id" uuid NOT NULL,
	"next_value" bigint NOT NULL,
	CONSTRAINT "invoice_type_counter_pk" PRIMARY KEY("organization_id","invoice_type_id"),
	CONSTRAINT "invoice_type_counter_positive" CHECK ("tariffs"."invoice_type_counter"."next_value" >= 1)
);
--> statement-breakpoint
ALTER TABLE "tariffs"."invoice_type_counter" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tariffs"."invoice_type_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"invoice_type_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"charge_item_id" uuid NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"amount_override" bigint,
	"optional" boolean DEFAULT false NOT NULL,
	CONSTRAINT "invoice_type_line_position_unique" UNIQUE("organization_id","invoice_type_id","position"),
	CONSTRAINT "invoice_type_line_item_unique" UNIQUE("organization_id","invoice_type_id","charge_item_id"),
	CONSTRAINT "invoice_type_line_position" CHECK ("tariffs"."invoice_type_line"."position" >= 0),
	CONSTRAINT "invoice_type_line_quantity" CHECK ("tariffs"."invoice_type_line"."quantity" between 1 and 1000),
	CONSTRAINT "invoice_type_line_override" CHECK ("tariffs"."invoice_type_line"."amount_override" is null or "tariffs"."invoice_type_line"."amount_override" >= 0)
);
--> statement-breakpoint
ALTER TABLE "tariffs"."invoice_type_line" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tariffs"."late_fee_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"invoice_type_id" uuid NOT NULL,
	"trigger_days" integer NOT NULL,
	"base" text NOT NULL,
	"rate_bp" integer,
	"flat_amount" bigint,
	"cap" bigint,
	"frequency" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "late_fee_rule_type_unique" UNIQUE("organization_id","invoice_type_id"),
	CONSTRAINT "late_fee_rule_base_valid" CHECK ("tariffs"."late_fee_rule"."base" in ('overdue_balance', 'invoice_total')),
	CONSTRAINT "late_fee_rule_frequency_valid" CHECK ("tariffs"."late_fee_rule"."frequency" in ('once', 'monthly', 'manual_only')),
	CONSTRAINT "late_fee_rule_trigger_days" CHECK ("tariffs"."late_fee_rule"."trigger_days" between 0 and 365),
	CONSTRAINT "late_fee_rule_rate_xor_flat" CHECK (coalesce(("tariffs"."late_fee_rule"."rate_bp" between 1 and 10000 and "tariffs"."late_fee_rule"."flat_amount" is null) or ("tariffs"."late_fee_rule"."rate_bp" is null and "tariffs"."late_fee_rule"."flat_amount" > 0), false)),
	CONSTRAINT "late_fee_rule_cap_positive" CHECK ("tariffs"."late_fee_rule"."cap" is null or "tariffs"."late_fee_rule"."cap" > 0)
);
--> statement-breakpoint
ALTER TABLE "tariffs"."late_fee_rule" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tariffs"."tariff" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"flat_basis" text DEFAULT 'none' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tariff_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "tariff_type_valid" CHECK ("tariffs"."tariff"."type" in ('increasing_block', 'decreasing_block', 'uniform', 'flat_rate')),
	CONSTRAINT "tariff_flat_basis_valid" CHECK ("tariffs"."tariff"."flat_basis" in ('property', 'pipe_size', 'taps', 'none')),
	CONSTRAINT "tariff_name_present" CHECK (length(btrim("tariffs"."tariff"."name")) > 0),
	CONSTRAINT "tariff_basis_only_flat" CHECK ("tariffs"."tariff"."type" = 'flat_rate' or "tariffs"."tariff"."flat_basis" = 'none')
);
--> statement-breakpoint
ALTER TABLE "tariffs"."tariff" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tariffs"."tariff_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"tariff_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"effective_from" date NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	CONSTRAINT "tariff_version_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "tariff_version_no_unique" UNIQUE("organization_id","tariff_id","version_no"),
	CONSTRAINT "tariff_version_no_positive" CHECK ("tariffs"."tariff_version"."version_no" >= 1)
);
--> statement-breakpoint
ALTER TABLE "tariffs"."tariff_version" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tariffs"."tariff_version_line" (
	"organization_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"from_units" integer,
	"to_units" integer,
	"key" text,
	"rate" bigint NOT NULL,
	CONSTRAINT "tariff_version_line_pk" PRIMARY KEY("organization_id","version_id","position"),
	CONSTRAINT "tariff_version_line_position" CHECK ("tariffs"."tariff_version_line"."position" >= 0),
	CONSTRAINT "tariff_version_line_rate_nonnegative" CHECK ("tariffs"."tariff_version_line"."rate" >= 0),
	CONSTRAINT "tariff_version_line_band" CHECK ("tariffs"."tariff_version_line"."from_units" is null or ("tariffs"."tariff_version_line"."from_units" >= 0 and ("tariffs"."tariff_version_line"."to_units" is null or "tariffs"."tariff_version_line"."to_units" > "tariffs"."tariff_version_line"."from_units"))),
	CONSTRAINT "tariff_version_line_bounds" CHECK ("tariffs"."tariff_version_line"."to_units" is null or "tariffs"."tariff_version_line"."from_units" is not null)
);
--> statement-breakpoint
ALTER TABLE "tariffs"."tariff_version_line" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tariffs"."category" ADD CONSTRAINT "category_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tariffs"."category_assignment" ADD CONSTRAINT "category_assignment_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tariffs"."category_assignment" ADD CONSTRAINT "category_assignment_category_fk" FOREIGN KEY ("organization_id","category_id") REFERENCES "tariffs"."category"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tariffs"."category_assignment" ADD CONSTRAINT "category_assignment_tariff_fk" FOREIGN KEY ("organization_id","tariff_id") REFERENCES "tariffs"."tariff"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tariffs"."category_assignment" ADD CONSTRAINT "category_assignment_standing_fk" FOREIGN KEY ("organization_id","standing_charge_item_id") REFERENCES "tariffs"."charge_item"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tariffs"."category_assignment" ADD CONSTRAINT "category_assignment_rent_fk" FOREIGN KEY ("organization_id","meter_rent_item_id") REFERENCES "tariffs"."charge_item"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tariffs"."category_assignment" ADD CONSTRAINT "category_assignment_discount_fk" FOREIGN KEY ("organization_id","discount_item_id") REFERENCES "tariffs"."charge_item"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tariffs"."charge_item" ADD CONSTRAINT "charge_item_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tariffs"."charge_item_amount" ADD CONSTRAINT "charge_item_amount_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tariffs"."charge_item_amount" ADD CONSTRAINT "charge_item_amount_item_fk" FOREIGN KEY ("organization_id","charge_item_id") REFERENCES "tariffs"."charge_item"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tariffs"."invoice_type" ADD CONSTRAINT "invoice_type_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tariffs"."invoice_type_counter" ADD CONSTRAINT "invoice_type_counter_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tariffs"."invoice_type_counter" ADD CONSTRAINT "invoice_type_counter_type_fk" FOREIGN KEY ("organization_id","invoice_type_id") REFERENCES "tariffs"."invoice_type"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tariffs"."invoice_type_line" ADD CONSTRAINT "invoice_type_line_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tariffs"."invoice_type_line" ADD CONSTRAINT "invoice_type_line_type_fk" FOREIGN KEY ("organization_id","invoice_type_id") REFERENCES "tariffs"."invoice_type"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tariffs"."invoice_type_line" ADD CONSTRAINT "invoice_type_line_item_fk" FOREIGN KEY ("organization_id","charge_item_id") REFERENCES "tariffs"."charge_item"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tariffs"."late_fee_rule" ADD CONSTRAINT "late_fee_rule_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tariffs"."late_fee_rule" ADD CONSTRAINT "late_fee_rule_type_fk" FOREIGN KEY ("organization_id","invoice_type_id") REFERENCES "tariffs"."invoice_type"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tariffs"."tariff" ADD CONSTRAINT "tariff_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tariffs"."tariff_version" ADD CONSTRAINT "tariff_version_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tariffs"."tariff_version" ADD CONSTRAINT "tariff_version_tariff_fk" FOREIGN KEY ("organization_id","tariff_id") REFERENCES "tariffs"."tariff"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tariffs"."tariff_version_line" ADD CONSTRAINT "tariff_version_line_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tariffs"."tariff_version_line" ADD CONSTRAINT "tariff_version_line_version_fk" FOREIGN KEY ("organization_id","version_id") REFERENCES "tariffs"."tariff_version"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "category_assignment_effective_idx" ON "tariffs"."category_assignment" USING btree ("organization_id","category_id","effective_from");--> statement-breakpoint
CREATE INDEX "charge_item_amount_effective_idx" ON "tariffs"."charge_item_amount" USING btree ("organization_id","charge_item_id","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "tariff_name_unique" ON "tariffs"."tariff" USING btree ("organization_id",lower("name"));--> statement-breakpoint
CREATE INDEX "tariff_version_effective_idx" ON "tariffs"."tariff_version" USING btree ("organization_id","tariff_id","effective_from");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tariffs"."category" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("tariffs"."category"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("tariffs"."category"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tariffs"."category_assignment" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("tariffs"."category_assignment"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("tariffs"."category_assignment"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tariffs"."charge_item" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("tariffs"."charge_item"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("tariffs"."charge_item"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tariffs"."charge_item_amount" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("tariffs"."charge_item_amount"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("tariffs"."charge_item_amount"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tariffs"."invoice_type" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("tariffs"."invoice_type"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("tariffs"."invoice_type"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tariffs"."invoice_type_counter" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("tariffs"."invoice_type_counter"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("tariffs"."invoice_type_counter"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tariffs"."invoice_type_line" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("tariffs"."invoice_type_line"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("tariffs"."invoice_type_line"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tariffs"."late_fee_rule" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("tariffs"."late_fee_rule"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("tariffs"."late_fee_rule"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tariffs"."tariff" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("tariffs"."tariff"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("tariffs"."tariff"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tariffs"."tariff_version" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("tariffs"."tariff_version"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("tariffs"."tariff_version"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tariffs"."tariff_version_line" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("tariffs"."tariff_version_line"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("tariffs"."tariff_version_line"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);