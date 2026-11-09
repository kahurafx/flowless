CREATE TABLE "accounts"."account_holder" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"valid_from" date NOT NULL,
	"previous_closing_reading_ref" text,
	"command_id" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid,
	CONSTRAINT "account_holder_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "account_holder_from_unique" UNIQUE("organization_id","account_id","valid_from")
);
--> statement-breakpoint
ALTER TABLE "accounts"."account_holder" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "accounts"."application" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"requested_category_id" uuid,
	"parent_account_id" uuid,
	"membership_class" text,
	"address" text NOT NULL,
	"location" geometry(Point, 4326),
	"scheme_id" uuid,
	"zone_id" uuid,
	"dma_id" uuid,
	"route_id" uuid,
	"notes" text,
	"stage" text DEFAULT 'enquiry' NOT NULL,
	"survey_feasibility" text,
	"survey_findings" text,
	"survey_materials" text,
	"survey_recorded_at" timestamp with time zone,
	"survey_recorded_by_user_id" uuid,
	"survey_source" text,
	"survey_work_order_id" uuid,
	"survey_approval_id" uuid,
	"survey_approval_state" text,
	"invoice_ref" text,
	"payment_ref" text,
	"account_id" uuid,
	"service_point_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "application_stage_valid" CHECK ("accounts"."application"."stage" in ('enquiry', 'survey', 'application', 'invoice', 'payment', 'installation', 'ready', 'converted', 'rejected', 'cancelled')),
	CONSTRAINT "application_feasibility_valid" CHECK ("accounts"."application"."survey_feasibility" is null or "accounts"."application"."survey_feasibility" in ('feasible', 'not_feasible')),
	CONSTRAINT "application_approval_state_valid" CHECK ("accounts"."application"."survey_approval_state" is null or "accounts"."application"."survey_approval_state" in ('pending', 'approved', 'rejected')),
	CONSTRAINT "application_address_present" CHECK (length(btrim("accounts"."application"."address")) > 0),
	CONSTRAINT "application_converted_has_account" CHECK (("accounts"."application"."stage" = 'converted') = ("accounts"."application"."account_id" is not null)),
	CONSTRAINT "application_membership_needs_parent" CHECK ("accounts"."application"."membership_class" is null or "accounts"."application"."parent_account_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "accounts"."application" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "accounts"."application_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"from_stage" text,
	"to_stage" text NOT NULL,
	"actor_user_id" uuid,
	"source" text NOT NULL,
	"reason" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fingerprint" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_event_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "application_event_kind_valid" CHECK ("accounts"."application_event"."kind" in ('created', 'stage_changed', 'survey_recorded', 'survey_decided')),
	CONSTRAINT "application_event_from_valid" CHECK ("accounts"."application_event"."from_stage" is null or "accounts"."application_event"."from_stage" in ('enquiry', 'survey', 'application', 'invoice', 'payment', 'installation', 'ready', 'converted', 'rejected', 'cancelled')),
	CONSTRAINT "application_event_to_valid" CHECK ("accounts"."application_event"."to_stage" in ('enquiry', 'survey', 'application', 'invoice', 'payment', 'installation', 'ready', 'converted', 'rejected', 'cancelled')),
	CONSTRAINT "application_event_actor_present" CHECK ("accounts"."application_event"."actor_user_id" is not null or "accounts"."application_event"."source" = 'system')
);
--> statement-breakpoint
ALTER TABLE "accounts"."application_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "accounts"."relocation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"from_service_point_id" uuid NOT NULL,
	"new_service_point_id" uuid,
	"to_address" text NOT NULL,
	"to_location" geometry(Point, 4326),
	"to_scheme_id" uuid,
	"to_zone_id" uuid,
	"to_dma_id" uuid,
	"to_route_id" uuid,
	"status" text DEFAULT 'requested' NOT NULL,
	"reason" text NOT NULL,
	"fee_item_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"survey_feasibility" text,
	"survey_findings" text,
	"final_reading" text,
	"initial_reading" text,
	"work_order_id" uuid,
	"requested_by_user_id" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relocation_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "relocation_status_valid" CHECK ("accounts"."relocation"."status" in ('requested', 'surveyed', 'completed', 'cancelled')),
	CONSTRAINT "relocation_feasibility_valid" CHECK ("accounts"."relocation"."survey_feasibility" is null or "accounts"."relocation"."survey_feasibility" in ('feasible', 'not_feasible')),
	CONSTRAINT "relocation_address_present" CHECK (length(btrim("accounts"."relocation"."to_address")) > 0),
	CONSTRAINT "relocation_completed_has_service_point" CHECK (("accounts"."relocation"."status" = 'completed') = ("accounts"."relocation"."new_service_point_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "accounts"."relocation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "accounts"."relocation_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"relocation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"actor_user_id" uuid,
	"source" text NOT NULL,
	"reason" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fingerprint" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relocation_event_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "relocation_event_kind_valid" CHECK ("accounts"."relocation_event"."kind" in ('requested', 'survey_recorded', 'work_recorded', 'completed', 'cancelled')),
	CONSTRAINT "relocation_event_from_valid" CHECK ("accounts"."relocation_event"."from_status" is null or "accounts"."relocation_event"."from_status" in ('requested', 'surveyed', 'completed', 'cancelled')),
	CONSTRAINT "relocation_event_to_valid" CHECK ("accounts"."relocation_event"."to_status" in ('requested', 'surveyed', 'completed', 'cancelled')),
	CONSTRAINT "relocation_event_actor_present" CHECK ("accounts"."relocation_event"."actor_user_id" is not null or "accounts"."relocation_event"."source" = 'system')
);
--> statement-breakpoint
ALTER TABLE "accounts"."relocation_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "accounts"."account_command" DROP CONSTRAINT "account_command_kind_valid";--> statement-breakpoint
ALTER TABLE "accounts"."account" ADD COLUMN "membership_class" text;--> statement-breakpoint
ALTER TABLE "accounts"."account" ADD COLUMN "predecessor_account_id" uuid;--> statement-breakpoint
ALTER TABLE "accounts"."account" ADD COLUMN "successor_account_id" uuid;--> statement-breakpoint
ALTER TABLE "accounts"."account_holder" ADD CONSTRAINT "account_holder_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."account_holder" ADD CONSTRAINT "account_holder_account_fk" FOREIGN KEY ("organization_id","account_id") REFERENCES "accounts"."account"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."account_holder" ADD CONSTRAINT "account_holder_customer_fk" FOREIGN KEY ("organization_id","customer_id") REFERENCES "accounts"."customer"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."account_holder" ADD CONSTRAINT "account_holder_command_fk" FOREIGN KEY ("organization_id","command_id") REFERENCES "accounts"."account_command"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."application" ADD CONSTRAINT "application_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."application" ADD CONSTRAINT "application_customer_fk" FOREIGN KEY ("organization_id","customer_id") REFERENCES "accounts"."customer"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."application" ADD CONSTRAINT "application_parent_account_fk" FOREIGN KEY ("organization_id","parent_account_id") REFERENCES "accounts"."account"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."application" ADD CONSTRAINT "application_account_fk" FOREIGN KEY ("organization_id","account_id") REFERENCES "accounts"."account"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."application" ADD CONSTRAINT "application_service_point_fk" FOREIGN KEY ("organization_id","service_point_id") REFERENCES "accounts"."service_point"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."application" ADD CONSTRAINT "application_scheme_fk" FOREIGN KEY ("organization_id","scheme_id") REFERENCES "kernel"."area"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."application" ADD CONSTRAINT "application_zone_fk" FOREIGN KEY ("organization_id","zone_id") REFERENCES "kernel"."area"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."application" ADD CONSTRAINT "application_dma_fk" FOREIGN KEY ("organization_id","dma_id") REFERENCES "kernel"."area"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."application" ADD CONSTRAINT "application_route_fk" FOREIGN KEY ("organization_id","route_id") REFERENCES "kernel"."route"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."application_event" ADD CONSTRAINT "application_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."application_event" ADD CONSTRAINT "application_event_application_fk" FOREIGN KEY ("organization_id","application_id") REFERENCES "accounts"."application"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."relocation" ADD CONSTRAINT "relocation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."relocation" ADD CONSTRAINT "relocation_account_fk" FOREIGN KEY ("organization_id","account_id") REFERENCES "accounts"."account"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."relocation" ADD CONSTRAINT "relocation_from_service_point_fk" FOREIGN KEY ("organization_id","from_service_point_id") REFERENCES "accounts"."service_point"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."relocation" ADD CONSTRAINT "relocation_new_service_point_fk" FOREIGN KEY ("organization_id","new_service_point_id") REFERENCES "accounts"."service_point"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."relocation" ADD CONSTRAINT "relocation_scheme_fk" FOREIGN KEY ("organization_id","to_scheme_id") REFERENCES "kernel"."area"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."relocation" ADD CONSTRAINT "relocation_zone_fk" FOREIGN KEY ("organization_id","to_zone_id") REFERENCES "kernel"."area"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."relocation" ADD CONSTRAINT "relocation_dma_fk" FOREIGN KEY ("organization_id","to_dma_id") REFERENCES "kernel"."area"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."relocation" ADD CONSTRAINT "relocation_route_fk" FOREIGN KEY ("organization_id","to_route_id") REFERENCES "kernel"."route"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."relocation_event" ADD CONSTRAINT "relocation_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."relocation_event" ADD CONSTRAINT "relocation_event_relocation_fk" FOREIGN KEY ("organization_id","relocation_id") REFERENCES "accounts"."relocation"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_holder_account_idx" ON "accounts"."account_holder" USING btree ("organization_id","account_id","valid_from");--> statement-breakpoint
CREATE INDEX "application_stage_idx" ON "accounts"."application" USING btree ("organization_id","stage","created_at");--> statement-breakpoint
CREATE INDEX "application_customer_idx" ON "accounts"."application" USING btree ("organization_id","customer_id");--> statement-breakpoint
CREATE INDEX "application_survey_approval_idx" ON "accounts"."application" USING btree ("organization_id","survey_approval_id") WHERE "accounts"."application"."survey_approval_id" is not null;--> statement-breakpoint
CREATE INDEX "application_location_gist" ON "accounts"."application" USING gist ("location");--> statement-breakpoint
CREATE INDEX "application_event_application_idx" ON "accounts"."application_event" USING btree ("organization_id","application_id","occurred_at");--> statement-breakpoint
CREATE INDEX "relocation_account_idx" ON "accounts"."relocation" USING btree ("organization_id","account_id","requested_at");--> statement-breakpoint
CREATE INDEX "relocation_status_idx" ON "accounts"."relocation" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "relocation_open_unique" ON "accounts"."relocation" USING btree ("organization_id","from_service_point_id") WHERE "accounts"."relocation"."status" in ('requested', 'surveyed');--> statement-breakpoint
CREATE INDEX "relocation_to_location_gist" ON "accounts"."relocation" USING gist ("to_location");--> statement-breakpoint
CREATE INDEX "relocation_event_relocation_idx" ON "accounts"."relocation_event" USING btree ("organization_id","relocation_id","occurred_at");--> statement-breakpoint
ALTER TABLE "accounts"."account" ADD CONSTRAINT "account_predecessor_fk" FOREIGN KEY ("organization_id","predecessor_account_id") REFERENCES "accounts"."account"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."account" ADD CONSTRAINT "account_successor_fk" FOREIGN KEY ("organization_id","successor_account_id") REFERENCES "accounts"."account"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_predecessor_unique" ON "accounts"."account" USING btree ("organization_id","predecessor_account_id") WHERE "accounts"."account"."predecessor_account_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "account_successor_unique" ON "accounts"."account" USING btree ("organization_id","successor_account_id") WHERE "accounts"."account"."successor_account_id" is not null;--> statement-breakpoint
ALTER TABLE "accounts"."account" ADD CONSTRAINT "account_succession_not_self" CHECK (coalesce("accounts"."account"."predecessor_account_id" <> "accounts"."account"."id" and "accounts"."account"."successor_account_id" <> "accounts"."account"."id", true));--> statement-breakpoint
ALTER TABLE "accounts"."account" ADD CONSTRAINT "account_membership_needs_parent" CHECK ("accounts"."account"."membership_class" is null or "accounts"."account"."parent_account_id" is not null);--> statement-breakpoint
ALTER TABLE "accounts"."account_command" ADD CONSTRAINT "account_command_kind_valid" CHECK ("accounts"."account_command"."kind" in ('activate', 'mark_pending_payment', 'make_dormant', 'reactivate', 'terminate', 'disconnect_service', 'reconnect_service', 'write_off_decided', 'succeed', 'change_name', 'relocate'));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "accounts"."account_holder" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("accounts"."account_holder"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("accounts"."account_holder"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "accounts"."application" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("accounts"."application"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("accounts"."application"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "accounts"."application_event" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("accounts"."application_event"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("accounts"."application_event"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "accounts"."relocation" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("accounts"."relocation"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("accounts"."relocation"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "accounts"."relocation_event" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("accounts"."relocation_event"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("accounts"."relocation_event"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);