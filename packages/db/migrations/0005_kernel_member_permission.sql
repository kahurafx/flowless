CREATE TABLE "kernel"."member_permission" (
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"permission" text NOT NULL,
	"granted_by" uuid NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_permission_organization_id_user_id_permission_pk" PRIMARY KEY("organization_id","user_id","permission")
);
--> statement-breakpoint
ALTER TABLE "kernel"."member_permission" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kernel"."member_permission" ADD CONSTRAINT "member_permission_member_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "auth"."member"("organization_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "kernel"."member_permission" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("kernel"."member_permission"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("kernel"."member_permission"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);