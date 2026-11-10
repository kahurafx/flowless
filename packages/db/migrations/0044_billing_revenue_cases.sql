CREATE TABLE "billing"."revenue_case" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "billing"."revenue_case_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"organization_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"event" text NOT NULL,
	"kind" text NOT NULL,
	"account_id" uuid NOT NULL,
	"service_point_id" uuid,
	"title" text,
	"detail" text DEFAULT '' NOT NULL,
	"data" jsonb,
	"file_id" uuid,
	"decision" text,
	"document_id" uuid,
	"exception_id" uuid,
	"actor_user_id" uuid,
	"source" text DEFAULT 'web' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "revenue_case_seq_unique" UNIQUE("seq"),
	CONSTRAINT "revenue_case_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "revenue_case_event_valid" CHECK ("billing"."revenue_case"."event" in ('opened', 'evidence', 'resolved')),
	CONSTRAINT "revenue_case_kind_valid" CHECK ("billing"."revenue_case"."kind" in ('illegal_consumption', 'terminated_but_consuming', 'unbilled_account', 'back_billing')),
	CONSTRAINT "revenue_case_decision_valid" CHECK ("billing"."revenue_case"."decision" is null or "billing"."revenue_case"."decision" in ('no_action', 'false_positive', 'back_billed', 'penalty_applied', 'referred')),
	CONSTRAINT "revenue_case_opened_self" CHECK (("billing"."revenue_case"."event" = 'opened') = ("billing"."revenue_case"."case_id" = "billing"."revenue_case"."id")),
	CONSTRAINT "revenue_case_opened_title" CHECK ("billing"."revenue_case"."event" <> 'opened' or length(btrim(coalesce("billing"."revenue_case"."title", ''))) > 0),
	CONSTRAINT "revenue_case_decision_on_resolved" CHECK (("billing"."revenue_case"."event" = 'resolved') = ("billing"."revenue_case"."decision" is not null)),
	CONSTRAINT "revenue_case_evidence_content" CHECK ("billing"."revenue_case"."event" <> 'evidence' or "billing"."revenue_case"."file_id" is not null or length(btrim("billing"."revenue_case"."detail")) > 0),
	CONSTRAINT "revenue_case_resolved_note" CHECK ("billing"."revenue_case"."event" <> 'resolved' or length(btrim("billing"."revenue_case"."detail")) > 0)
);
--> statement-breakpoint
ALTER TABLE "billing"."revenue_case" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "billing"."revenue_case" ADD CONSTRAINT "revenue_case_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."revenue_case" ADD CONSTRAINT "revenue_case_case_fk" FOREIGN KEY ("organization_id","case_id") REFERENCES "billing"."revenue_case"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "revenue_case_log_idx" ON "billing"."revenue_case" USING btree ("organization_id","case_id","seq");--> statement-breakpoint
CREATE INDEX "revenue_case_account_idx" ON "billing"."revenue_case" USING btree ("organization_id","account_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "billing"."revenue_case" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("billing"."revenue_case"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("billing"."revenue_case"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);