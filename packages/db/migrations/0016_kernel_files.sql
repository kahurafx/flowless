CREATE TABLE "kernel"."file" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"file_name" text NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"latitude" double precision,
	"longitude" double precision,
	"captured_at" timestamp with time zone,
	"uploaded_by_user_id" uuid NOT NULL,
	"announced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"uploaded_at" timestamp with time zone,
	CONSTRAINT "file_status_valid" CHECK ("kernel"."file"."status" in ('pending', 'uploaded')),
	CONSTRAINT "file_size_positive" CHECK ("kernel"."file"."size_bytes" > 0),
	CONSTRAINT "file_position_valid" CHECK (("kernel"."file"."latitude" is null) = ("kernel"."file"."longitude" is null) and coalesce("kernel"."file"."latitude" between -90 and 90, true) and coalesce("kernel"."file"."longitude" between -180 and 180, true))
);
--> statement-breakpoint
ALTER TABLE "kernel"."file" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kernel"."file" ADD CONSTRAINT "file_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "file_storage_key_unique" ON "kernel"."file" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "file_subject_idx" ON "kernel"."file" USING btree ("organization_id","subject_kind","subject_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "kernel"."file" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("kernel"."file"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("kernel"."file"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);