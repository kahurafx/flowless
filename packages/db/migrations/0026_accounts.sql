CREATE SCHEMA "accounts";
--> statement-breakpoint
CREATE TABLE "accounts"."account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"parent_account_id" uuid,
	"suffix_index" integer,
	"category_id" uuid,
	"commercial_status" text DEFAULT 'NEW' NOT NULL,
	"service_status" text DEFAULT 'DISCONNECTED' NOT NULL,
	"service_status_reason" text,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	CONSTRAINT "account_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "account_number_unique" UNIQUE("organization_id","number"),
	CONSTRAINT "account_commercial_status_valid" CHECK ("accounts"."account"."commercial_status" in ('NEW', 'PENDING_PAYMENT', 'ACTIVE', 'DORMANT', 'TERMINATED')),
	CONSTRAINT "account_service_status_valid" CHECK ("accounts"."account"."service_status" in ('CONNECTED', 'DISCONNECTED')),
	CONSTRAINT "account_disconnected_has_reason" CHECK ("accounts"."account"."service_status" = 'CONNECTED' or "accounts"."account"."service_status_reason" is not null),
	CONSTRAINT "account_suffix_needs_parent" CHECK ("accounts"."account"."suffix_index" is null or ("accounts"."account"."parent_account_id" is not null and "accounts"."account"."suffix_index" >= 1)),
	CONSTRAINT "account_not_own_parent" CHECK ("accounts"."account"."parent_account_id" is null or "accounts"."account"."parent_account_id" <> "accounts"."account"."id")
);
--> statement-breakpoint
ALTER TABLE "accounts"."account" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "accounts"."account_counter" (
	"organization_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"next_value" bigint NOT NULL,
	CONSTRAINT "account_counter_organization_id_scope_pk" PRIMARY KEY("organization_id","scope"),
	CONSTRAINT "account_counter_positive" CHECK ("accounts"."account_counter"."next_value" >= 1)
);
--> statement-breakpoint
ALTER TABLE "accounts"."account_counter" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "accounts"."customer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"national_id" text,
	"registration_number" text,
	"language" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "customer_type_valid" CHECK ("accounts"."customer"."type" in ('person', 'organization')),
	CONSTRAINT "customer_name_present" CHECK (length(btrim("accounts"."customer"."name")) > 0),
	CONSTRAINT "customer_national_id_person" CHECK ("accounts"."customer"."type" = 'person' or "accounts"."customer"."national_id" is null),
	CONSTRAINT "customer_registration_organization" CHECK ("accounts"."customer"."type" = 'organization' or "accounts"."customer"."registration_number" is null)
);
--> statement-breakpoint
ALTER TABLE "accounts"."customer" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "accounts"."customer_contact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"kind" text DEFAULT 'personal' NOT NULL,
	"value" text NOT NULL,
	"normalized" text,
	"is_placeholder" boolean DEFAULT false NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_contact_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "customer_contact_channel_valid" CHECK ("accounts"."customer_contact"."channel" in ('phone', 'email')),
	CONSTRAINT "customer_contact_kind_valid" CHECK ("accounts"."customer_contact"."kind" in ('personal', 'home', 'work', 'billing', 'next_of_kin', 'other')),
	CONSTRAINT "customer_contact_placeholder_phone" CHECK (not "accounts"."customer_contact"."is_placeholder" or ("accounts"."customer_contact"."channel" = 'phone' and "accounts"."customer_contact"."normalized" is null and not "accounts"."customer_contact"."is_primary")),
	CONSTRAINT "customer_contact_normalized_present" CHECK ("accounts"."customer_contact"."is_placeholder" or "accounts"."customer_contact"."normalized" is not null)
);
--> statement-breakpoint
ALTER TABLE "accounts"."customer_contact" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "accounts"."service_point" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"address" text NOT NULL,
	"location" geometry(Point, 4326),
	"scheme_id" uuid,
	"zone_id" uuid,
	"dma_id" uuid,
	"route_id" uuid,
	"connection_status" text DEFAULT 'PLANNED' NOT NULL,
	"gis_connection_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_point_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "service_point_status_valid" CHECK ("accounts"."service_point"."connection_status" in ('PLANNED', 'CONNECTED', 'DISCONNECTED', 'DECOMMISSIONED')),
	CONSTRAINT "service_point_address_present" CHECK (length(btrim("accounts"."service_point"."address")) > 0)
);
--> statement-breakpoint
ALTER TABLE "accounts"."service_point" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "accounts"."account" ADD CONSTRAINT "account_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."account" ADD CONSTRAINT "account_customer_fk" FOREIGN KEY ("organization_id","customer_id") REFERENCES "accounts"."customer"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."account" ADD CONSTRAINT "account_parent_fk" FOREIGN KEY ("organization_id","parent_account_id") REFERENCES "accounts"."account"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."account_counter" ADD CONSTRAINT "account_counter_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."customer" ADD CONSTRAINT "customer_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."customer_contact" ADD CONSTRAINT "customer_contact_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."customer_contact" ADD CONSTRAINT "customer_contact_customer_fk" FOREIGN KEY ("organization_id","customer_id") REFERENCES "accounts"."customer"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."service_point" ADD CONSTRAINT "service_point_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."service_point" ADD CONSTRAINT "service_point_account_fk" FOREIGN KEY ("organization_id","account_id") REFERENCES "accounts"."account"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."service_point" ADD CONSTRAINT "service_point_scheme_fk" FOREIGN KEY ("organization_id","scheme_id") REFERENCES "kernel"."area"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."service_point" ADD CONSTRAINT "service_point_zone_fk" FOREIGN KEY ("organization_id","zone_id") REFERENCES "kernel"."area"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."service_point" ADD CONSTRAINT "service_point_dma_fk" FOREIGN KEY ("organization_id","dma_id") REFERENCES "kernel"."area"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."service_point" ADD CONSTRAINT "service_point_route_fk" FOREIGN KEY ("organization_id","route_id") REFERENCES "kernel"."route"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_suffix_unique" ON "accounts"."account" USING btree ("organization_id","parent_account_id","suffix_index") WHERE "accounts"."account"."suffix_index" is not null;--> statement-breakpoint
CREATE INDEX "account_customer_idx" ON "accounts"."account" USING btree ("organization_id","customer_id");--> statement-breakpoint
CREATE INDEX "account_parent_idx" ON "accounts"."account" USING btree ("organization_id","parent_account_id") WHERE "accounts"."account"."parent_account_id" is not null;--> statement-breakpoint
CREATE INDEX "account_status_idx" ON "accounts"."account" USING btree ("organization_id","commercial_status");--> statement-breakpoint
CREATE INDEX "customer_name_idx" ON "accounts"."customer" USING btree ("organization_id",lower("name"));--> statement-breakpoint
CREATE INDEX "customer_national_id_idx" ON "accounts"."customer" USING btree ("organization_id","national_id") WHERE "accounts"."customer"."national_id" is not null;--> statement-breakpoint
CREATE INDEX "customer_registration_idx" ON "accounts"."customer" USING btree ("organization_id","registration_number") WHERE "accounts"."customer"."registration_number" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_contact_primary_unique" ON "accounts"."customer_contact" USING btree ("organization_id","customer_id","channel") WHERE "accounts"."customer_contact"."is_primary";--> statement-breakpoint
CREATE INDEX "customer_contact_customer_idx" ON "accounts"."customer_contact" USING btree ("organization_id","customer_id");--> statement-breakpoint
CREATE INDEX "customer_contact_normalized_idx" ON "accounts"."customer_contact" USING btree ("organization_id","channel","normalized") WHERE "accounts"."customer_contact"."normalized" is not null;--> statement-breakpoint
CREATE INDEX "service_point_account_idx" ON "accounts"."service_point" USING btree ("organization_id","account_id");--> statement-breakpoint
CREATE INDEX "service_point_route_idx" ON "accounts"."service_point" USING btree ("organization_id","route_id") WHERE "accounts"."service_point"."route_id" is not null;--> statement-breakpoint
CREATE INDEX "service_point_scheme_idx" ON "accounts"."service_point" USING btree ("organization_id","scheme_id") WHERE "accounts"."service_point"."scheme_id" is not null;--> statement-breakpoint
CREATE INDEX "service_point_zone_idx" ON "accounts"."service_point" USING btree ("organization_id","zone_id") WHERE "accounts"."service_point"."zone_id" is not null;--> statement-breakpoint
CREATE INDEX "service_point_dma_idx" ON "accounts"."service_point" USING btree ("organization_id","dma_id") WHERE "accounts"."service_point"."dma_id" is not null;--> statement-breakpoint
CREATE INDEX "service_point_gis_connection_idx" ON "accounts"."service_point" USING btree ("organization_id","gis_connection_id") WHERE "accounts"."service_point"."gis_connection_id" is not null;--> statement-breakpoint
CREATE INDEX "service_point_location_gist" ON "accounts"."service_point" USING gist ("location");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "accounts"."account" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("accounts"."account"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("accounts"."account"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "accounts"."account_counter" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("accounts"."account_counter"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("accounts"."account_counter"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "accounts"."customer" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("accounts"."customer"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("accounts"."customer"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "accounts"."customer_contact" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("accounts"."customer_contact"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("accounts"."customer_contact"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "accounts"."service_point" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("accounts"."service_point"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("accounts"."service_point"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);