CREATE TABLE "kernel"."support_grant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"engineer_email" text NOT NULL,
	"reason" text NOT NULL,
	"permissions" jsonb NOT NULL,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"granted_by_user_id" uuid NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" uuid,
	CONSTRAINT "support_grant_window" CHECK ("kernel"."support_grant"."expires_at" > "kernel"."support_grant"."starts_at" and "kernel"."support_grant"."expires_at" <= "kernel"."support_grant"."starts_at" + interval '72 hours'),
	CONSTRAINT "support_grant_reason" CHECK (length(trim("kernel"."support_grant"."reason")) > 0)
);
--> statement-breakpoint
ALTER TABLE "kernel"."support_grant" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kernel"."support_grant" ADD CONSTRAINT "support_grant_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "support_grant_active_idx" ON "kernel"."support_grant" USING btree ("organization_id","expires_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "kernel"."support_grant" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("kernel"."support_grant"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("kernel"."support_grant"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
-- Custom: grants are history; revoking sets revoked_at (K-12).
REVOKE DELETE, TRUNCATE ON "kernel"."support_grant" FROM "flowless_app";
