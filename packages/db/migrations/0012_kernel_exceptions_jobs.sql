CREATE TABLE "kernel"."exception" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"type" text NOT NULL,
	"source" text NOT NULL,
	"title" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_ref" text NOT NULL,
	"area_id" uuid,
	"route_id" uuid,
	"owner_user_id" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"dedupe_key" text,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by_user_id" uuid,
	"resolution_note" text,
	CONSTRAINT "exception_status_valid" CHECK ("kernel"."exception"."status" in ('open', 'in_progress', 'resolved'))
);
--> statement-breakpoint
ALTER TABLE "kernel"."exception" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "kernel"."job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"idempotency_key" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"last_error" text,
	"result" jsonb,
	CONSTRAINT "job_status_valid" CHECK ("kernel"."job"."status" in ('queued', 'running', 'done', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "kernel"."job" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kernel"."exception" ADD CONSTRAINT "exception_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kernel"."exception" ADD CONSTRAINT "exception_area_fk" FOREIGN KEY ("organization_id","area_id") REFERENCES "kernel"."area"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kernel"."exception" ADD CONSTRAINT "exception_route_fk" FOREIGN KEY ("organization_id","route_id") REFERENCES "kernel"."route"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kernel"."job" ADD CONSTRAINT "job_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "exception_open_dedupe_unique" ON "kernel"."exception" USING btree ("organization_id","dedupe_key") WHERE "kernel"."exception"."status" <> 'resolved';--> statement-breakpoint
CREATE INDEX "exception_queue_idx" ON "kernel"."exception" USING btree ("organization_id","status","raised_at");--> statement-breakpoint
CREATE INDEX "exception_owner_idx" ON "kernel"."exception" USING btree ("organization_id","owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_idempotency_unique" ON "kernel"."job" USING btree ("organization_id","type","idempotency_key");--> statement-breakpoint
CREATE INDEX "job_due_idx" ON "kernel"."job" USING btree ("run_at") WHERE "kernel"."job"."status" in ('queued', 'running');--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "kernel"."exception" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("kernel"."exception"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("kernel"."exception"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "kernel"."job" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("kernel"."job"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("kernel"."job"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);