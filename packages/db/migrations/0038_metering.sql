CREATE SCHEMA "metering";
--> statement-breakpoint
CREATE TABLE "metering"."installation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"meter_id" uuid NOT NULL,
	"service_point_id" uuid NOT NULL,
	"installed_at" timestamp with time zone NOT NULL,
	"removed_at" timestamp with time zone,
	"installed_by_user_id" uuid,
	"removed_by_user_id" uuid,
	"removal_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "installation_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "installation_span_valid" CHECK ("metering"."installation"."removed_at" is null or "metering"."installation"."removed_at" >= "metering"."installation"."installed_at")
);
--> statement-breakpoint
ALTER TABLE "metering"."installation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "metering"."meter" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"serial" text NOT NULL,
	"model" text DEFAULT '' NOT NULL,
	"dial_digits" integer NOT NULL,
	"status" text NOT NULL,
	"status_event_id" uuid,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid,
	CONSTRAINT "meter_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "meter_status_valid" CHECK ("metering"."meter"."status" in ('procured', 'in_stock', 'issued', 'installed', 'tested', 'replaced', 'disposed')),
	CONSTRAINT "meter_serial_present" CHECK (length(btrim("metering"."meter"."serial")) > 0),
	CONSTRAINT "meter_dial_digits_valid" CHECK ("metering"."meter"."dial_digits" between 1 and 12)
);
--> statement-breakpoint
ALTER TABLE "metering"."meter" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "metering"."meter_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"meter_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"actor_user_id" uuid,
	"source" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fingerprint" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meter_event_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "meter_event_kind_valid" CHECK ("metering"."meter_event"."kind" in ('register', 'status_change', 'install', 'remove', 'replace')),
	CONSTRAINT "meter_event_to_valid" CHECK ("metering"."meter_event"."to_status" in ('procured', 'in_stock', 'issued', 'installed', 'tested', 'replaced', 'disposed'))
);
--> statement-breakpoint
ALTER TABLE "metering"."meter_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "metering"."reading" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"meter_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"service_point_id" uuid NOT NULL,
	"account_id" uuid,
	"value" bigint NOT NULL,
	"read_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	"purpose" text DEFAULT 'routine' NOT NULL,
	"reader_user_id" uuid,
	"photo_file_id" uuid,
	"latitude" double precision,
	"longitude" double precision,
	"quality" text DEFAULT 'good' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"replaces_reading_id" uuid,
	"fingerprint" text NOT NULL,
	CONSTRAINT "reading_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "reading_value_not_negative" CHECK ("metering"."reading"."value" >= 0),
	CONSTRAINT "reading_source_valid" CHECK ("metering"."reading"."source" in ('technician', 'office', 'customer', 'import', 'estimate')),
	CONSTRAINT "reading_purpose_valid" CHECK ("metering"."reading"."purpose" in ('routine', 'initial', 'final')),
	CONSTRAINT "reading_quality_valid" CHECK ("metering"."reading"."quality" in ('good', 'doubtful', 'poor')),
	CONSTRAINT "reading_estimate_routine" CHECK ("metering"."reading"."source" <> 'estimate' or "metering"."reading"."purpose" = 'routine'),
	CONSTRAINT "reading_gps_valid" CHECK (("metering"."reading"."latitude" is null and "metering"."reading"."longitude" is null) or ("metering"."reading"."latitude" between -90 and 90 and "metering"."reading"."longitude" between -180 and 180))
);
--> statement-breakpoint
ALTER TABLE "metering"."reading" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "metering"."reading_status" (
	"seq" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "metering"."reading_status_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"organization_id" uuid NOT NULL,
	"reading_id" uuid NOT NULL,
	"status" text NOT NULL,
	"cleared" boolean NOT NULL,
	"rollover_confirmed" boolean DEFAULT false NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"actor_user_id" uuid,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reading_status_valid" CHECK ("metering"."reading_status"."status" in ('valid', 'voided', 'superseded')),
	CONSTRAINT "reading_status_voided_not_cleared" CHECK ("metering"."reading_status"."status" = 'valid' or "metering"."reading_status"."cleared" = false)
);
--> statement-breakpoint
ALTER TABLE "metering"."reading_status" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "metering"."installation" ADD CONSTRAINT "installation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metering"."installation" ADD CONSTRAINT "installation_meter_fk" FOREIGN KEY ("organization_id","meter_id") REFERENCES "metering"."meter"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metering"."meter" ADD CONSTRAINT "meter_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metering"."meter_event" ADD CONSTRAINT "meter_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metering"."meter_event" ADD CONSTRAINT "meter_event_meter_fk" FOREIGN KEY ("organization_id","meter_id") REFERENCES "metering"."meter"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metering"."reading" ADD CONSTRAINT "reading_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metering"."reading" ADD CONSTRAINT "reading_meter_fk" FOREIGN KEY ("organization_id","meter_id") REFERENCES "metering"."meter"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metering"."reading" ADD CONSTRAINT "reading_installation_fk" FOREIGN KEY ("organization_id","installation_id") REFERENCES "metering"."installation"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metering"."reading" ADD CONSTRAINT "reading_replaces_fk" FOREIGN KEY ("organization_id","replaces_reading_id") REFERENCES "metering"."reading"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metering"."reading_status" ADD CONSTRAINT "reading_status_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metering"."reading_status" ADD CONSTRAINT "reading_status_reading_fk" FOREIGN KEY ("organization_id","reading_id") REFERENCES "metering"."reading"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "installation_meter_open" ON "metering"."installation" USING btree ("organization_id","meter_id") WHERE "metering"."installation"."removed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "installation_service_point_open" ON "metering"."installation" USING btree ("organization_id","service_point_id") WHERE "metering"."installation"."removed_at" is null;--> statement-breakpoint
CREATE INDEX "installation_service_point_idx" ON "metering"."installation" USING btree ("organization_id","service_point_id","installed_at");--> statement-breakpoint
CREATE INDEX "installation_meter_idx" ON "metering"."installation" USING btree ("organization_id","meter_id","installed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "meter_serial_unique" ON "metering"."meter" USING btree ("organization_id",lower(btrim("serial")));--> statement-breakpoint
CREATE INDEX "meter_status_idx" ON "metering"."meter" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "meter_event_meter_idx" ON "metering"."meter_event" USING btree ("organization_id","meter_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reading_replaces_unique" ON "metering"."reading" USING btree ("organization_id","replaces_reading_id") WHERE "metering"."reading"."replaces_reading_id" is not null;--> statement-breakpoint
CREATE INDEX "reading_meter_read_idx" ON "metering"."reading" USING btree ("organization_id","meter_id","read_at","recorded_at");--> statement-breakpoint
CREATE INDEX "reading_service_point_read_idx" ON "metering"."reading" USING btree ("organization_id","service_point_id","read_at","recorded_at");--> statement-breakpoint
CREATE INDEX "reading_account_idx" ON "metering"."reading" USING btree ("organization_id","account_id","read_at");--> statement-breakpoint
CREATE INDEX "reading_status_latest_idx" ON "metering"."reading_status" USING btree ("organization_id","reading_id","seq" DESC NULLS LAST);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "metering"."installation" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("metering"."installation"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("metering"."installation"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "metering"."meter" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("metering"."meter"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("metering"."meter"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "metering"."meter_event" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("metering"."meter_event"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("metering"."meter_event"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "metering"."reading" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("metering"."reading"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("metering"."reading"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "metering"."reading_status" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("metering"."reading_status"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("metering"."reading_status"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);