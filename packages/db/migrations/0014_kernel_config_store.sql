CREATE TABLE "kernel"."config_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"key" text NOT NULL,
	"version" integer NOT NULL,
	"value" jsonb NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "config_version_unique" UNIQUE("organization_id","key","version"),
	CONSTRAINT "config_version_positive" CHECK ("kernel"."config_version"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "kernel"."config_version" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kernel"."config_version" ADD CONSTRAINT "config_version_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "config_version_effective_idx" ON "kernel"."config_version" USING btree ("organization_id","key","effective_from");--> statement-breakpoint
-- Custom: time zone and language move into the configuration store as version 1 of
-- kernel.regional, before their columns go.
INSERT INTO "kernel"."config_version" ("organization_id", "key", "version", "value", "effective_from", "reason")
  SELECT "organization_id", 'kernel.regional', 1,
         jsonb_build_object('timeZone', "time_zone", 'locale', "locale"), "created_at", 'Onboarding'
    FROM "kernel"."organization_settings";--> statement-breakpoint
ALTER TABLE "kernel"."organization_settings" DROP COLUMN "time_zone";--> statement-breakpoint
ALTER TABLE "kernel"."organization_settings" DROP COLUMN "locale";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "kernel"."config_version" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("kernel"."config_version"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("kernel"."config_version"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
-- Custom: versions are history; a change is a new version (K-10).
REVOKE UPDATE, DELETE, TRUNCATE ON "kernel"."config_version" FROM "flowless_app";
