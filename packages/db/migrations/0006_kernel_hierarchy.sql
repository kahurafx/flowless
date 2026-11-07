CREATE TYPE "kernel"."area_level" AS ENUM('scheme', 'zone', 'sub_zone', 'dma');--> statement-breakpoint
CREATE TABLE "kernel"."area" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"level" "kernel"."area_level" NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"parent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "area_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "area_code_unique" UNIQUE("organization_id","level","code")
);
--> statement-breakpoint
ALTER TABLE "kernel"."area" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "kernel"."member_area_scope" (
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"area_id" uuid NOT NULL,
	CONSTRAINT "member_area_scope_organization_id_user_id_area_id_pk" PRIMARY KEY("organization_id","user_id","area_id")
);
--> statement-breakpoint
ALTER TABLE "kernel"."member_area_scope" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "kernel"."member_route_scope" (
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"route_id" uuid NOT NULL,
	CONSTRAINT "member_route_scope_organization_id_user_id_route_id_pk" PRIMARY KEY("organization_id","user_id","route_id")
);
--> statement-breakpoint
ALTER TABLE "kernel"."member_route_scope" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "kernel"."route" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"parent_id" uuid,
	"area_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "route_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "route_code_unique" UNIQUE("organization_id","code")
);
--> statement-breakpoint
ALTER TABLE "kernel"."route" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kernel"."area" ADD CONSTRAINT "area_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kernel"."area" ADD CONSTRAINT "area_parent_fk" FOREIGN KEY ("organization_id","parent_id") REFERENCES "kernel"."area"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kernel"."member_area_scope" ADD CONSTRAINT "member_area_scope_member_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "auth"."member"("organization_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kernel"."member_area_scope" ADD CONSTRAINT "member_area_scope_area_fk" FOREIGN KEY ("organization_id","area_id") REFERENCES "kernel"."area"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kernel"."member_route_scope" ADD CONSTRAINT "member_route_scope_member_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "auth"."member"("organization_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kernel"."member_route_scope" ADD CONSTRAINT "member_route_scope_route_fk" FOREIGN KEY ("organization_id","route_id") REFERENCES "kernel"."route"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kernel"."route" ADD CONSTRAINT "route_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kernel"."route" ADD CONSTRAINT "route_parent_fk" FOREIGN KEY ("organization_id","parent_id") REFERENCES "kernel"."route"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kernel"."route" ADD CONSTRAINT "route_area_fk" FOREIGN KEY ("organization_id","area_id") REFERENCES "kernel"."area"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "area_parent_idx" ON "kernel"."area" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "route_parent_idx" ON "kernel"."route" USING btree ("parent_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "kernel"."area" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("kernel"."area"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("kernel"."area"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "kernel"."member_area_scope" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("kernel"."member_area_scope"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("kernel"."member_area_scope"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "kernel"."member_route_scope" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("kernel"."member_route_scope"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("kernel"."member_route_scope"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "kernel"."route" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("kernel"."route"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("kernel"."route"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);