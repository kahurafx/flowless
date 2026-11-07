CREATE TABLE "kernel"."consumer_receipt" (
	"organization_id" uuid NOT NULL,
	"consumer" text NOT NULL,
	"event_id" uuid NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consumer_receipt_consumer_event_id_pk" PRIMARY KEY("consumer","event_id")
);
--> statement-breakpoint
ALTER TABLE "kernel"."consumer_receipt" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "kernel"."outbox_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"type" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_error" text,
	"completed_at" timestamp with time zone,
	CONSTRAINT "outbox_event_status_valid" CHECK ("kernel"."outbox_event"."status" in ('pending', 'done', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "kernel"."outbox_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kernel"."consumer_receipt" ADD CONSTRAINT "consumer_receipt_event_id_outbox_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "kernel"."outbox_event"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kernel"."outbox_event" ADD CONSTRAINT "outbox_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outbox_event_due_idx" ON "kernel"."outbox_event" USING btree ("available_at") WHERE "kernel"."outbox_event"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "outbox_event_type_idx" ON "kernel"."outbox_event" USING btree ("organization_id","type","occurred_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "kernel"."consumer_receipt" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("kernel"."consumer_receipt"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("kernel"."consumer_receipt"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "kernel"."outbox_event" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("kernel"."outbox_event"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("kernel"."outbox_event"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "auth_insert" ON "kernel"."outbox_event" AS PERMISSIVE FOR INSERT TO "flowless_auth" WITH CHECK (true);