CREATE TABLE "billing"."cycle" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"period" text NOT NULL,
	"cycle_date" date NOT NULL,
	"frequency" text DEFAULT 'monthly' NOT NULL,
	"route_id" uuid NOT NULL,
	"snapshot_id" uuid,
	"trigger" text DEFAULT 'batch' NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"opened_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cycle_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "cycle_route_period_unique" UNIQUE("organization_id","route_id","period"),
	CONSTRAINT "cycle_route_date_unique" UNIQUE("organization_id","route_id","cycle_date"),
	CONSTRAINT "cycle_period_valid" CHECK ("billing"."cycle"."period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "cycle_state_valid" CHECK ("billing"."cycle"."state" in ('open', 'reading_window', 'validation', 'estimation', 'calculation', 'review', 'issue', 'deliver', 'completeness', 'closed')),
	CONSTRAINT "cycle_frequency_valid" CHECK ("billing"."cycle"."frequency" in ('monthly', 'bimonthly', 'quarterly')),
	CONSTRAINT "cycle_trigger_valid" CHECK ("billing"."cycle"."trigger" in ('on_reading', 'batch'))
);
--> statement-breakpoint
ALTER TABLE "billing"."cycle" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "billing"."cycle_account" (
	"organization_id" uuid NOT NULL,
	"cycle_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"service_point_id" uuid,
	"expected" boolean NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cycle_account_pk" PRIMARY KEY("organization_id","cycle_id","account_id")
);
--> statement-breakpoint
ALTER TABLE "billing"."cycle_account" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "billing"."cycle_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"cycle_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"kind" text NOT NULL,
	"reason" text,
	"actor_user_id" uuid,
	"source" text DEFAULT 'web' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cycle_event_seq_unique" UNIQUE("organization_id","cycle_id","seq"),
	CONSTRAINT "cycle_event_to_valid" CHECK ("billing"."cycle_event"."to_state" in ('open', 'reading_window', 'validation', 'estimation', 'calculation', 'review', 'issue', 'deliver', 'completeness', 'closed')),
	CONSTRAINT "cycle_event_kind_valid" CHECK ("billing"."cycle_event"."kind" in ('open', 'advance', 'skip', 'retreat', 'close')),
	CONSTRAINT "cycle_event_first" CHECK (("billing"."cycle_event"."seq" = 1) = ("billing"."cycle_event"."from_state" is null)),
	CONSTRAINT "cycle_event_reason" CHECK ("billing"."cycle_event"."kind" in ('open', 'advance', 'close') or length(btrim(coalesce("billing"."cycle_event"."reason", ''))) > 0)
);
--> statement-breakpoint
ALTER TABLE "billing"."cycle_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "billing"."cycle_outcome" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "billing"."cycle_outcome_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"organization_id" uuid NOT NULL,
	"cycle_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"reason" text,
	"exception_id" uuid,
	"document_id" uuid,
	"amount" bigint,
	"flagged" boolean DEFAULT false NOT NULL,
	"actor_user_id" uuid,
	"source" text DEFAULT 'web' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cycle_outcome_seq_unique" UNIQUE("seq"),
	CONSTRAINT "cycle_outcome_valid" CHECK ("billing"."cycle_outcome"."outcome" in ('billed', 'billed_estimate', 'exception', 'excluded')),
	CONSTRAINT "cycle_outcome_reason" CHECK ("billing"."cycle_outcome"."outcome" in ('billed', 'billed_estimate') or length(btrim(coalesce("billing"."cycle_outcome"."reason", ''))) > 0),
	CONSTRAINT "cycle_outcome_exception_link" CHECK (("billing"."cycle_outcome"."outcome" = 'exception') = ("billing"."cycle_outcome"."exception_id" is not null)),
	CONSTRAINT "cycle_outcome_document" CHECK (("billing"."cycle_outcome"."outcome" in ('billed', 'billed_estimate')) = ("billing"."cycle_outcome"."document_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "billing"."cycle_outcome" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "billing"."cycle_review" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "billing"."cycle_review_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"organization_id" uuid NOT NULL,
	"cycle_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"outcome_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"basis" text NOT NULL,
	"reason" text,
	"actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cycle_review_seq_unique" UNIQUE("seq"),
	CONSTRAINT "cycle_review_decision_valid" CHECK ("billing"."cycle_review"."decision" in ('approve', 'hold')),
	CONSTRAINT "cycle_review_basis_valid" CHECK ("billing"."cycle_review"."basis" in ('bulk', 'sample', 'individual')),
	CONSTRAINT "cycle_review_hold_reason" CHECK ("billing"."cycle_review"."decision" = 'approve' or length(btrim(coalesce("billing"."cycle_review"."reason", ''))) > 0)
);
--> statement-breakpoint
ALTER TABLE "billing"."cycle_review" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "billing"."cycle" ADD CONSTRAINT "cycle_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."cycle_account" ADD CONSTRAINT "cycle_account_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."cycle_account" ADD CONSTRAINT "cycle_account_cycle_fk" FOREIGN KEY ("organization_id","cycle_id") REFERENCES "billing"."cycle"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."cycle_event" ADD CONSTRAINT "cycle_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."cycle_event" ADD CONSTRAINT "cycle_event_cycle_fk" FOREIGN KEY ("organization_id","cycle_id") REFERENCES "billing"."cycle"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."cycle_outcome" ADD CONSTRAINT "cycle_outcome_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."cycle_outcome" ADD CONSTRAINT "cycle_outcome_account_fk" FOREIGN KEY ("organization_id","cycle_id","account_id") REFERENCES "billing"."cycle_account"("organization_id","cycle_id","account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."cycle_review" ADD CONSTRAINT "cycle_review_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."cycle_review" ADD CONSTRAINT "cycle_review_account_fk" FOREIGN KEY ("organization_id","cycle_id","account_id") REFERENCES "billing"."cycle_account"("organization_id","cycle_id","account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cycle_state_idx" ON "billing"."cycle" USING btree ("organization_id","state","period");--> statement-breakpoint
CREATE INDEX "cycle_account_account_idx" ON "billing"."cycle_account" USING btree ("organization_id","account_id");--> statement-breakpoint
CREATE INDEX "cycle_outcome_latest_idx" ON "billing"."cycle_outcome" USING btree ("organization_id","cycle_id","account_id","seq");--> statement-breakpoint
CREATE INDEX "cycle_review_latest_idx" ON "billing"."cycle_review" USING btree ("organization_id","cycle_id","account_id","seq");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "billing"."cycle" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("billing"."cycle"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("billing"."cycle"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "billing"."cycle_account" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("billing"."cycle_account"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("billing"."cycle_account"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "billing"."cycle_event" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("billing"."cycle_event"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("billing"."cycle_event"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "billing"."cycle_outcome" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("billing"."cycle_outcome"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("billing"."cycle_outcome"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "billing"."cycle_review" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("billing"."cycle_review"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("billing"."cycle_review"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);