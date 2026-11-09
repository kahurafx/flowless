CREATE TABLE "accounts"."account_command" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"from_commercial_status" text NOT NULL,
	"to_commercial_status" text NOT NULL,
	"from_service_status" text NOT NULL,
	"to_service_status" text NOT NULL,
	"service_reason" text,
	"reason" text NOT NULL,
	"reason_code" text,
	"actor_user_id" uuid,
	"source" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fingerprint" text,
	CONSTRAINT "account_command_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "account_command_kind_valid" CHECK ("accounts"."account_command"."kind" in ('activate', 'mark_pending_payment', 'make_dormant', 'reactivate', 'terminate', 'disconnect_service', 'reconnect_service', 'write_off_decided')),
	CONSTRAINT "account_command_from_commercial_valid" CHECK ("accounts"."account_command"."from_commercial_status" in ('NEW', 'PENDING_PAYMENT', 'ACTIVE', 'DORMANT', 'TERMINATED')),
	CONSTRAINT "account_command_to_commercial_valid" CHECK ("accounts"."account_command"."to_commercial_status" in ('NEW', 'PENDING_PAYMENT', 'ACTIVE', 'DORMANT', 'TERMINATED')),
	CONSTRAINT "account_command_from_service_valid" CHECK ("accounts"."account_command"."from_service_status" in ('CONNECTED', 'DISCONNECTED')),
	CONSTRAINT "account_command_to_service_valid" CHECK ("accounts"."account_command"."to_service_status" in ('CONNECTED', 'DISCONNECTED')),
	CONSTRAINT "account_command_reason_present" CHECK (length(btrim("accounts"."account_command"."reason")) > 0),
	CONSTRAINT "account_command_disconnected_has_reason" CHECK ("accounts"."account_command"."to_service_status" = 'CONNECTED' or length(btrim(coalesce("accounts"."account_command"."service_reason", ''))) > 0),
	CONSTRAINT "account_command_actor_present" CHECK ("accounts"."account_command"."actor_user_id" is not null or "accounts"."account_command"."source" = 'system')
);
--> statement-breakpoint
ALTER TABLE "accounts"."account_command" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "accounts"."activation_check" (
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "accounts"."activation_check_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"gate_key" text NOT NULL,
	"action" text NOT NULL,
	"by_user_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text,
	CONSTRAINT "activation_check_action_valid" CHECK ("accounts"."activation_check"."action" in ('tick', 'untick')),
	CONSTRAINT "activation_check_gate_key_valid" CHECK ("accounts"."activation_check"."gate_key" ~ '^[a-z][a-z0-9_]{1,39}$')
);
--> statement-breakpoint
ALTER TABLE "accounts"."activation_check" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "accounts"."account" ADD COLUMN "status_command_id" uuid;--> statement-breakpoint
ALTER TABLE "accounts"."account_command" ADD CONSTRAINT "account_command_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."account_command" ADD CONSTRAINT "account_command_account_fk" FOREIGN KEY ("organization_id","account_id") REFERENCES "accounts"."account"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."activation_check" ADD CONSTRAINT "activation_check_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."activation_check" ADD CONSTRAINT "activation_check_account_fk" FOREIGN KEY ("organization_id","account_id") REFERENCES "accounts"."account"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_command_account_idx" ON "accounts"."account_command" USING btree ("organization_id","account_id","occurred_at");--> statement-breakpoint
CREATE INDEX "activation_check_account_idx" ON "accounts"."activation_check" USING btree ("organization_id","account_id","gate_key","seq");--> statement-breakpoint
ALTER TABLE "accounts"."account" ADD CONSTRAINT "account_service_needs_live_status" CHECK ("accounts"."account"."commercial_status" in ('ACTIVE', 'DORMANT') or "accounts"."account"."service_status" = 'DISCONNECTED');--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "accounts"."account_command" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("accounts"."account_command"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("accounts"."account_command"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "accounts"."activation_check" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("accounts"."activation_check"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("accounts"."activation_check"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);