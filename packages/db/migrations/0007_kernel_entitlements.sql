CREATE TABLE "kernel"."organization_module" (
	"organization_id" uuid NOT NULL,
	"module" text NOT NULL,
	"licensed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_module_organization_id_module_pk" PRIMARY KEY("organization_id","module")
);
--> statement-breakpoint
ALTER TABLE "kernel"."organization_module" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kernel"."organization_module" ADD CONSTRAINT "organization_module_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "kernel"."organization_module" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("kernel"."organization_module"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("kernel"."organization_module"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);