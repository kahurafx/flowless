CREATE TABLE "metering"."eligibility_row" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"service_point_id" uuid NOT NULL,
	"route_id" uuid NOT NULL,
	"meter_id" uuid,
	"walking_sequence" integer,
	"eligible" boolean NOT NULL,
	"reason" text NOT NULL,
	CONSTRAINT "eligibility_row_snapshot_sp_unique" UNIQUE("snapshot_id","service_point_id"),
	CONSTRAINT "eligibility_row_reason_valid" CHECK ("metering"."eligibility_row"."reason" in ('eligible', 'consumption_not_billed', 'no_meter', 'service_point_not_live')),
	CONSTRAINT "eligibility_row_eligible_reason" CHECK (("metering"."eligibility_row"."eligible" and "metering"."eligibility_row"."reason" = 'eligible') or (not "metering"."eligibility_row"."eligible" and "metering"."eligibility_row"."reason" <> 'eligible'))
);
--> statement-breakpoint
ALTER TABLE "metering"."eligibility_row" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "metering"."eligibility_snapshot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"route_id" uuid NOT NULL,
	"cycle_date" date NOT NULL,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL,
	"taken_by_user_id" uuid,
	"source" text NOT NULL,
	CONSTRAINT "eligibility_snapshot_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "eligibility_snapshot_route_cycle_unique" UNIQUE("organization_id","route_id","cycle_date")
);
--> statement-breakpoint
ALTER TABLE "metering"."eligibility_snapshot" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "metering"."handover_closing" (
	"handover_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"reading_id" uuid NOT NULL,
	"linked_by_user_id" uuid,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "metering"."handover_closing" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "metering"."read_attempt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"service_point_id" uuid NOT NULL,
	"account_id" uuid,
	"meter_id" uuid,
	"cycle_date" date,
	"outcome" text NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"photo_file_id" uuid,
	"reading_id" uuid,
	"reader_user_id" uuid,
	"source" text NOT NULL,
	"attempted_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fingerprint" text NOT NULL,
	CONSTRAINT "read_attempt_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "read_attempt_outcome_valid" CHECK ("metering"."read_attempt"."outcome" in ('read_ok', 'meter_inaccessible', 'meter_faulty', 'no_meter_found', 'locked_premises', 'dog_or_hazard', 'customer_refused', 'illegal_connection_suspected')),
	CONSTRAINT "read_attempt_reading_only_when_read" CHECK ("metering"."read_attempt"."reading_id" is null or "metering"."read_attempt"."outcome" = 'read_ok')
);
--> statement-breakpoint
ALTER TABLE "metering"."read_attempt" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "metering"."reading_handover" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"command_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"from_account_id" uuid NOT NULL,
	"to_account_id" uuid NOT NULL,
	"service_point_id" uuid NOT NULL,
	"meter_id" uuid NOT NULL,
	"effective_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reading_handover_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "reading_handover_command_sp_unique" UNIQUE("organization_id","command_id","service_point_id")
);
--> statement-breakpoint
ALTER TABLE "metering"."reading_handover" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "metering"."meter" ADD COLUMN "kind" text DEFAULT 'customer' NOT NULL;--> statement-breakpoint
ALTER TABLE "metering"."meter" ADD COLUMN "dma_id" uuid;--> statement-breakpoint
ALTER TABLE "metering"."eligibility_row" ADD CONSTRAINT "eligibility_row_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metering"."eligibility_row" ADD CONSTRAINT "eligibility_row_snapshot_fk" FOREIGN KEY ("organization_id","snapshot_id") REFERENCES "metering"."eligibility_snapshot"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metering"."eligibility_snapshot" ADD CONSTRAINT "eligibility_snapshot_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metering"."handover_closing" ADD CONSTRAINT "handover_closing_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metering"."handover_closing" ADD CONSTRAINT "handover_closing_handover_fk" FOREIGN KEY ("organization_id","handover_id") REFERENCES "metering"."reading_handover"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metering"."handover_closing" ADD CONSTRAINT "handover_closing_reading_fk" FOREIGN KEY ("organization_id","reading_id") REFERENCES "metering"."reading"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metering"."read_attempt" ADD CONSTRAINT "read_attempt_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metering"."read_attempt" ADD CONSTRAINT "read_attempt_reading_fk" FOREIGN KEY ("organization_id","reading_id") REFERENCES "metering"."reading"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metering"."reading_handover" ADD CONSTRAINT "reading_handover_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "eligibility_row_snapshot_idx" ON "metering"."eligibility_row" USING btree ("organization_id","snapshot_id","walking_sequence");--> statement-breakpoint
CREATE INDEX "eligibility_row_account_idx" ON "metering"."eligibility_row" USING btree ("organization_id","account_id");--> statement-breakpoint
CREATE INDEX "read_attempt_service_point_idx" ON "metering"."read_attempt" USING btree ("organization_id","service_point_id","attempted_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "read_attempt_cycle_idx" ON "metering"."read_attempt" USING btree ("organization_id","cycle_date") WHERE "metering"."read_attempt"."cycle_date" is not null;--> statement-breakpoint
ALTER TABLE "metering"."meter" ADD CONSTRAINT "meter_kind_valid" CHECK ("metering"."meter"."kind" in ('customer', 'bulk', 'master'));--> statement-breakpoint
ALTER TABLE "metering"."meter" ADD CONSTRAINT "meter_customer_has_no_dma" CHECK ("metering"."meter"."kind" <> 'customer' or "metering"."meter"."dma_id" is null);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "metering"."eligibility_row" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("metering"."eligibility_row"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("metering"."eligibility_row"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "metering"."eligibility_snapshot" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("metering"."eligibility_snapshot"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("metering"."eligibility_snapshot"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "metering"."handover_closing" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("metering"."handover_closing"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("metering"."handover_closing"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "metering"."read_attempt" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("metering"."read_attempt"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("metering"."read_attempt"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "metering"."reading_handover" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("metering"."reading_handover"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("metering"."reading_handover"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);