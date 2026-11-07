CREATE TABLE "kernel"."audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" uuid,
	"actor_label" text,
	"source" text NOT NULL,
	"action" text NOT NULL,
	"subject_type" text,
	"subject_id" text,
	"before" jsonb,
	"after" jsonb,
	"reason" text,
	"ip_address" text,
	"chain_index" bigint DEFAULT 0 NOT NULL,
	"prev_hash" "bytea",
	"hash" "bytea",
	CONSTRAINT "audit_log_chain_unique" UNIQUE("organization_id","chain_index")
);
--> statement-breakpoint
ALTER TABLE "kernel"."audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kernel"."audit_log" ADD CONSTRAINT "audit_log_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_recent_idx" ON "kernel"."audit_log" USING btree ("organization_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_subject_idx" ON "kernel"."audit_log" USING btree ("organization_id","subject_type","subject_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "kernel"."audit_log" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("kernel"."audit_log"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("kernel"."audit_log"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "auth_insert" ON "kernel"."audit_log" AS PERMISSIVE FOR INSERT TO "flowless_auth" WITH CHECK (true);