CREATE TABLE "kernel"."notification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"recipient_user_id" uuid NOT NULL,
	"topic" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"link" text,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "kernel"."notification" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kernel"."notification" ADD CONSTRAINT "notification_recipient_fk" FOREIGN KEY ("organization_id","recipient_user_id") REFERENCES "auth"."member"("organization_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_inbox_idx" ON "kernel"."notification" USING btree ("organization_id","recipient_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_dedupe_unique" ON "kernel"."notification" USING btree ("organization_id","recipient_user_id","dedupe_key");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "kernel"."notification" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("kernel"."notification"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("kernel"."notification"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);