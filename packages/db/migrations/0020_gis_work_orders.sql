CREATE SCHEMA "gis";
--> statement-breakpoint
CREATE SCHEMA "work_orders";
--> statement-breakpoint
CREATE TYPE "gis"."condition" AS ENUM('good', 'fair', 'poor', 'critical', 'unknown');--> statement-breakpoint
CREATE TYPE "gis"."junction_type" AS ENUM('tee', 'cross', 'elbow', 'wye', 'reducer');--> statement-breakpoint
CREATE TYPE "gis"."node_type" AS ENUM('reservoir', 'pumping_station', 'valve', 'junction', 'meter', 'hydrant');--> statement-breakpoint
CREATE TYPE "gis"."pipe_material" AS ENUM('pvc', 'ductile_iron', 'hdpe', 'steel', 'concrete', 'unknown');--> statement-breakpoint
CREATE TYPE "gis"."structure_type" AS ENUM('vault', 'chamber', 'manhole', 'kiosk', 'trench');--> statement-breakpoint
CREATE TABLE "gis"."asset" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	CONSTRAINT "asset_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "asset_kind_valid" CHECK ("gis"."asset"."kind" in ('node', 'pipe', 'structure', 'service_connection'))
);
--> statement-breakpoint
ALTER TABLE "gis"."asset" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "gis"."condition_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"branch" text DEFAULT 'main' NOT NULL,
	"condition" "gis"."condition" NOT NULL,
	"note" text,
	"recorded_at" timestamp with time zone NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_by_user_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gis"."condition_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "gis"."dma" (
	"version_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"area_id" uuid NOT NULL,
	"branch" text DEFAULT 'main' NOT NULL,
	"is_head" boolean DEFAULT true NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"supersedes_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"color" text NOT NULL,
	"tier_id" uuid NOT NULL,
	"inlet_meter_id" uuid,
	"boundary" geometry(Polygon, 4326) NOT NULL,
	CONSTRAINT "dma_organization_id_version_id_unique" UNIQUE("organization_id","version_id")
);
--> statement-breakpoint
ALTER TABLE "gis"."dma" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "gis"."dma_boundary_valve" (
	"organization_id" uuid NOT NULL,
	"dma_version_id" uuid NOT NULL,
	"valve_id" uuid NOT NULL,
	CONSTRAINT "dma_boundary_valve_organization_id_dma_version_id_valve_id_pk" PRIMARY KEY("organization_id","dma_version_id","valve_id")
);
--> statement-breakpoint
ALTER TABLE "gis"."dma_boundary_valve" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "gis"."node" (
	"version_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"branch" text DEFAULT 'main' NOT NULL,
	"is_head" boolean DEFAULT true NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"supersedes_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"type" "gis"."node_type" NOT NULL,
	"name" text NOT NULL,
	"location" geometry(Point, 4326) NOT NULL,
	"condition" "gis"."condition" DEFAULT 'unknown' NOT NULL,
	"is_open" boolean,
	"structure_id" uuid,
	"installed_at" timestamp with time zone,
	"last_inspected_at" timestamp with time zone,
	"junction_type" "gis"."junction_type",
	"main_size_mm" integer,
	"branch_size_mm" integer,
	CONSTRAINT "node_junction_fields" CHECK (("gis"."node"."type" = 'junction' or ("gis"."node"."junction_type" is null and "gis"."node"."main_size_mm" is null and "gis"."node"."branch_size_mm" is null))
        and (("gis"."node"."junction_type" is null) = ("gis"."node"."main_size_mm" is null))
        and ("gis"."node"."main_size_mm" is null or "gis"."node"."main_size_mm" > 0)
        and ("gis"."node"."branch_size_mm" is null or ("gis"."node"."main_size_mm" is not null and "gis"."node"."branch_size_mm" < "gis"."node"."main_size_mm"))
        and ("gis"."node"."junction_type" is distinct from 'reducer' or "gis"."node"."branch_size_mm" is not null))
);
--> statement-breakpoint
ALTER TABLE "gis"."node" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "gis"."pipe" (
	"version_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"branch" text DEFAULT 'main' NOT NULL,
	"is_head" boolean DEFAULT true NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"supersedes_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"from_node_id" uuid NOT NULL,
	"to_node_id" uuid NOT NULL,
	"path" geometry(LineString, 4326) NOT NULL,
	"material" "gis"."pipe_material" DEFAULT 'unknown' NOT NULL,
	"diameter_mm" real NOT NULL,
	"condition" "gis"."condition" DEFAULT 'unknown' NOT NULL,
	"length_m" real NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gis"."pipe" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "gis"."service_connection" (
	"version_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"branch" text DEFAULT 'main' NOT NULL,
	"is_head" boolean DEFAULT true NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"supersedes_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"connection_number" text NOT NULL,
	"location" geometry(Point, 4326) NOT NULL,
	"service_point_id" uuid,
	"pipe_id" uuid
);
--> statement-breakpoint
ALTER TABLE "gis"."service_connection" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "gis"."structure" (
	"version_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"branch" text DEFAULT 'main' NOT NULL,
	"is_head" boolean DEFAULT true NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"supersedes_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"type" "gis"."structure_type" NOT NULL,
	"name" text NOT NULL,
	"location" geometry(Point, 4326) NOT NULL,
	"condition" "gis"."condition" DEFAULT 'unknown' NOT NULL,
	"installed_at" timestamp with time zone,
	"last_inspected_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "gis"."structure" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "gis"."structure_attachment_rule" (
	"organization_id" uuid NOT NULL,
	"node_type" "gis"."node_type" NOT NULL,
	"structure_type" "gis"."structure_type" NOT NULL,
	CONSTRAINT "structure_attachment_rule_organization_id_node_type_structure_type_pk" PRIMARY KEY("organization_id","node_type","structure_type")
);
--> statement-breakpoint
ALTER TABLE "gis"."structure_attachment_rule" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "gis"."subnetwork" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"tier_id" uuid NOT NULL,
	"controller_node_id" uuid NOT NULL,
	"last_validated_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "gis"."subnetwork" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "gis"."tier" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"order" integer NOT NULL,
	CONSTRAINT "tier_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "tier_order_unique" UNIQUE("organization_id","order")
);
--> statement-breakpoint
ALTER TABLE "gis"."tier" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "gis"."valve_state_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"valve_id" uuid NOT NULL,
	"branch" text DEFAULT 'main' NOT NULL,
	"is_open" boolean NOT NULL,
	"note" text,
	"changed_at" timestamp with time zone NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by_user_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gis"."valve_state_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "work_orders"."crew" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "crew_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "crew_name_unique" UNIQUE("organization_id","name")
);
--> statement-breakpoint
ALTER TABLE "work_orders"."crew" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "work_orders"."crew_member" (
	"organization_id" uuid NOT NULL,
	"crew_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crew_member_organization_id_crew_id_user_id_pk" PRIMARY KEY("organization_id","crew_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "work_orders"."crew_member" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "work_orders"."work_order" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"kind" text NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"review" text DEFAULT 'none' NOT NULL,
	"source" text DEFAULT 'Office' NOT NULL,
	"parent_id" uuid,
	"asset_module" text,
	"asset_id" uuid,
	"area_id" uuid,
	"route_id" uuid,
	"location" geometry(Point, 4326),
	"location_note" text,
	"assigned_to_user_id" uuid,
	"crew_id" uuid,
	"due_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"hold_reason" text,
	"hold_note" text,
	"held_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"submitted_by_user_id" uuid,
	"reviewed_at" timestamp with time zone,
	"reviewed_by_user_id" uuid,
	"review_note" text,
	"completed_at" timestamp with time zone,
	"outcome" text,
	"completion_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_order_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "work_order_code_unique" UNIQUE("organization_id","code"),
	CONSTRAINT "work_order_priority_valid" CHECK ("work_orders"."work_order"."priority" in ('low', 'normal', 'high', 'urgent')),
	CONSTRAINT "work_order_status_valid" CHECK ("work_orders"."work_order"."status" in ('pending', 'in_progress', 'blocked', 'submitted', 'completed', 'cancelled')),
	CONSTRAINT "work_order_review_valid" CHECK ("work_orders"."work_order"."review" in ('none', 'optional', 'required')),
	CONSTRAINT "work_order_outcome_valid" CHECK ("work_orders"."work_order"."outcome" is null or "work_orders"."work_order"."outcome" in ('done', 'partial', 'no_fault')),
	CONSTRAINT "work_order_asset_pair" CHECK (("work_orders"."work_order"."asset_module" is null) = ("work_orders"."work_order"."asset_id" is null))
);
--> statement-breakpoint
ALTER TABLE "work_orders"."work_order" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "work_orders"."work_order_asset" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"work_order_id" uuid NOT NULL,
	"module" text NOT NULL,
	"asset_id" uuid NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"done_at" timestamp with time zone,
	"added_by_user_id" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_order_asset_role_valid" CHECK ("work_orders"."work_order_asset"."role" in ('primary', 'related')),
	CONSTRAINT "work_order_asset_status_valid" CHECK ("work_orders"."work_order_asset"."status" in ('pending', 'done'))
);
--> statement-breakpoint
ALTER TABLE "work_orders"."work_order_asset" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "work_orders"."work_order_capture" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"work_order_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"data" jsonb NOT NULL,
	"captured_by_user_id" uuid NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "work_orders"."work_order_capture" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "work_orders"."work_order_change_set" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"work_order_id" uuid NOT NULL,
	"branch" text NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "work_orders"."work_order_change_set" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "work_orders"."work_order_comment" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"work_order_id" uuid NOT NULL,
	"author_user_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_order_comment_body" CHECK (length(trim("work_orders"."work_order_comment"."body")) > 0)
);
--> statement-breakpoint
ALTER TABLE "work_orders"."work_order_comment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "work_orders"."work_order_counter" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"next_number" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "work_order_counter_positive" CHECK ("work_orders"."work_order_counter"."next_number" > 0)
);
--> statement-breakpoint
ALTER TABLE "work_orders"."work_order_counter" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "work_orders"."work_order_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"work_order_id" uuid NOT NULL,
	"type" text NOT NULL,
	"outcome" text NOT NULL,
	"reason" text,
	"payload" jsonb NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"latitude" double precision,
	"longitude" double precision,
	"occurred_at" timestamp with time zone NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_order_event_type_valid" CHECK ("work_orders"."work_order_event"."type" in ('create', 'assign', 'cancel', 'resume', 'hold', 'complete', 'submit', 'approve', 'return', 'finalize', 'log_link', 'add_asset', 'change_set', 'comment', 'capture')),
	CONSTRAINT "work_order_event_outcome_valid" CHECK ("work_orders"."work_order_event"."outcome" in ('applied', 'unchanged', 'replayed', 'rejected', 'stale')),
	CONSTRAINT "work_order_event_position_valid" CHECK (("work_orders"."work_order_event"."latitude" is null) = ("work_orders"."work_order_event"."longitude" is null) and coalesce("work_orders"."work_order_event"."latitude" between -90 and 90, true) and coalesce("work_orders"."work_order_event"."longitude" between -180 and 180, true))
);
--> statement-breakpoint
ALTER TABLE "work_orders"."work_order_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "work_orders"."work_order_log_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"work_order_id" uuid NOT NULL,
	"log_kind" text NOT NULL,
	"log_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_order_log_link_kind_valid" CHECK ("work_orders"."work_order_log_link"."log_kind" in ('condition', 'valve'))
);
--> statement-breakpoint
ALTER TABLE "work_orders"."work_order_log_link" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "gis"."asset" ADD CONSTRAINT "asset_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gis"."condition_log" ADD CONSTRAINT "condition_log_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gis"."condition_log" ADD CONSTRAINT "condition_log_asset_fk" FOREIGN KEY ("organization_id","asset_id") REFERENCES "gis"."asset"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gis"."dma" ADD CONSTRAINT "dma_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gis"."dma" ADD CONSTRAINT "dma_area_fk" FOREIGN KEY ("organization_id","area_id") REFERENCES "kernel"."area"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gis"."dma" ADD CONSTRAINT "dma_tier_fk" FOREIGN KEY ("organization_id","tier_id") REFERENCES "gis"."tier"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gis"."dma" ADD CONSTRAINT "dma_inlet_meter_fk" FOREIGN KEY ("organization_id","inlet_meter_id") REFERENCES "gis"."asset"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gis"."dma_boundary_valve" ADD CONSTRAINT "dma_boundary_valve_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gis"."dma_boundary_valve" ADD CONSTRAINT "dma_boundary_valve_dma_fk" FOREIGN KEY ("organization_id","dma_version_id") REFERENCES "gis"."dma"("organization_id","version_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gis"."dma_boundary_valve" ADD CONSTRAINT "dma_boundary_valve_valve_fk" FOREIGN KEY ("organization_id","valve_id") REFERENCES "gis"."asset"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gis"."node" ADD CONSTRAINT "node_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gis"."node" ADD CONSTRAINT "node_asset_fk" FOREIGN KEY ("organization_id","id") REFERENCES "gis"."asset"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gis"."node" ADD CONSTRAINT "node_structure_fk" FOREIGN KEY ("organization_id","structure_id") REFERENCES "gis"."asset"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gis"."pipe" ADD CONSTRAINT "pipe_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gis"."pipe" ADD CONSTRAINT "pipe_asset_fk" FOREIGN KEY ("organization_id","id") REFERENCES "gis"."asset"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gis"."pipe" ADD CONSTRAINT "pipe_from_node_fk" FOREIGN KEY ("organization_id","from_node_id") REFERENCES "gis"."asset"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gis"."pipe" ADD CONSTRAINT "pipe_to_node_fk" FOREIGN KEY ("organization_id","to_node_id") REFERENCES "gis"."asset"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gis"."service_connection" ADD CONSTRAINT "service_connection_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gis"."service_connection" ADD CONSTRAINT "service_connection_asset_fk" FOREIGN KEY ("organization_id","id") REFERENCES "gis"."asset"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gis"."service_connection" ADD CONSTRAINT "service_connection_pipe_fk" FOREIGN KEY ("organization_id","pipe_id") REFERENCES "gis"."asset"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gis"."structure" ADD CONSTRAINT "structure_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gis"."structure" ADD CONSTRAINT "structure_asset_fk" FOREIGN KEY ("organization_id","id") REFERENCES "gis"."asset"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gis"."structure_attachment_rule" ADD CONSTRAINT "structure_attachment_rule_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gis"."subnetwork" ADD CONSTRAINT "subnetwork_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gis"."subnetwork" ADD CONSTRAINT "subnetwork_tier_fk" FOREIGN KEY ("organization_id","tier_id") REFERENCES "gis"."tier"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gis"."subnetwork" ADD CONSTRAINT "subnetwork_controller_fk" FOREIGN KEY ("organization_id","controller_node_id") REFERENCES "gis"."asset"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gis"."tier" ADD CONSTRAINT "tier_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gis"."valve_state_log" ADD CONSTRAINT "valve_state_log_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gis"."valve_state_log" ADD CONSTRAINT "valve_state_log_valve_fk" FOREIGN KEY ("organization_id","valve_id") REFERENCES "gis"."asset"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders"."crew" ADD CONSTRAINT "crew_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders"."crew_member" ADD CONSTRAINT "crew_member_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders"."crew_member" ADD CONSTRAINT "crew_member_crew_fk" FOREIGN KEY ("organization_id","crew_id") REFERENCES "work_orders"."crew"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders"."crew_member" ADD CONSTRAINT "crew_member_member_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "auth"."member"("organization_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders"."work_order" ADD CONSTRAINT "work_order_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders"."work_order" ADD CONSTRAINT "work_order_parent_fk" FOREIGN KEY ("organization_id","parent_id") REFERENCES "work_orders"."work_order"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders"."work_order" ADD CONSTRAINT "work_order_area_fk" FOREIGN KEY ("organization_id","area_id") REFERENCES "kernel"."area"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders"."work_order" ADD CONSTRAINT "work_order_route_fk" FOREIGN KEY ("organization_id","route_id") REFERENCES "kernel"."route"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders"."work_order" ADD CONSTRAINT "work_order_crew_fk" FOREIGN KEY ("organization_id","crew_id") REFERENCES "work_orders"."crew"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders"."work_order_asset" ADD CONSTRAINT "work_order_asset_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders"."work_order_asset" ADD CONSTRAINT "work_order_asset_work_order_fk" FOREIGN KEY ("organization_id","work_order_id") REFERENCES "work_orders"."work_order"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders"."work_order_capture" ADD CONSTRAINT "work_order_capture_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders"."work_order_capture" ADD CONSTRAINT "work_order_capture_work_order_fk" FOREIGN KEY ("organization_id","work_order_id") REFERENCES "work_orders"."work_order"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders"."work_order_change_set" ADD CONSTRAINT "work_order_change_set_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders"."work_order_change_set" ADD CONSTRAINT "work_order_change_set_work_order_fk" FOREIGN KEY ("organization_id","work_order_id") REFERENCES "work_orders"."work_order"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders"."work_order_comment" ADD CONSTRAINT "work_order_comment_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders"."work_order_comment" ADD CONSTRAINT "work_order_comment_work_order_fk" FOREIGN KEY ("organization_id","work_order_id") REFERENCES "work_orders"."work_order"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders"."work_order_counter" ADD CONSTRAINT "work_order_counter_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders"."work_order_event" ADD CONSTRAINT "work_order_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders"."work_order_event" ADD CONSTRAINT "work_order_event_work_order_fk" FOREIGN KEY ("organization_id","work_order_id") REFERENCES "work_orders"."work_order"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders"."work_order_log_link" ADD CONSTRAINT "work_order_log_link_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders"."work_order_log_link" ADD CONSTRAINT "work_order_log_link_work_order_fk" FOREIGN KEY ("organization_id","work_order_id") REFERENCES "work_orders"."work_order"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "condition_log_asset_idx" ON "gis"."condition_log" USING btree ("organization_id","asset_id","recorded_at");--> statement-breakpoint
CREATE INDEX "condition_log_recorded_idx" ON "gis"."condition_log" USING btree ("organization_id","recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "dma_head_unique" ON "gis"."dma" USING btree ("organization_id","area_id","branch") WHERE "gis"."dma"."is_head" = true;--> statement-breakpoint
CREATE INDEX "dma_branch_idx" ON "gis"."dma" USING btree ("organization_id","branch");--> statement-breakpoint
CREATE INDEX "dma_boundary_gist" ON "gis"."dma" USING gist ("boundary");--> statement-breakpoint
CREATE UNIQUE INDEX "node_head_unique" ON "gis"."node" USING btree ("organization_id","id","branch") WHERE "gis"."node"."is_head" = true;--> statement-breakpoint
CREATE INDEX "node_branch_idx" ON "gis"."node" USING btree ("organization_id","branch");--> statement-breakpoint
CREATE INDEX "node_structure_idx" ON "gis"."node" USING btree ("organization_id","structure_id");--> statement-breakpoint
CREATE INDEX "node_location_gist" ON "gis"."node" USING gist ("location");--> statement-breakpoint
CREATE UNIQUE INDEX "pipe_head_unique" ON "gis"."pipe" USING btree ("organization_id","id","branch") WHERE "gis"."pipe"."is_head" = true;--> statement-breakpoint
CREATE INDEX "pipe_branch_idx" ON "gis"."pipe" USING btree ("organization_id","branch");--> statement-breakpoint
CREATE INDEX "pipe_from_idx" ON "gis"."pipe" USING btree ("organization_id","from_node_id");--> statement-breakpoint
CREATE INDEX "pipe_to_idx" ON "gis"."pipe" USING btree ("organization_id","to_node_id");--> statement-breakpoint
CREATE INDEX "pipe_path_gist" ON "gis"."pipe" USING gist ("path");--> statement-breakpoint
CREATE UNIQUE INDEX "service_connection_head_unique" ON "gis"."service_connection" USING btree ("organization_id","id","branch") WHERE "gis"."service_connection"."is_head" = true;--> statement-breakpoint
CREATE INDEX "service_connection_branch_idx" ON "gis"."service_connection" USING btree ("organization_id","branch");--> statement-breakpoint
CREATE UNIQUE INDEX "service_connection_number_unique" ON "gis"."service_connection" USING btree ("organization_id","connection_number") WHERE "gis"."service_connection"."branch" = 'main' and "gis"."service_connection"."is_head" = true and "gis"."service_connection"."is_deleted" = false;--> statement-breakpoint
CREATE INDEX "service_connection_service_point_idx" ON "gis"."service_connection" USING btree ("organization_id","service_point_id");--> statement-breakpoint
CREATE INDEX "service_connection_pipe_idx" ON "gis"."service_connection" USING btree ("organization_id","pipe_id");--> statement-breakpoint
CREATE INDEX "service_connection_location_gist" ON "gis"."service_connection" USING gist ("location");--> statement-breakpoint
CREATE UNIQUE INDEX "structure_head_unique" ON "gis"."structure" USING btree ("organization_id","id","branch") WHERE "gis"."structure"."is_head" = true;--> statement-breakpoint
CREATE INDEX "structure_branch_idx" ON "gis"."structure" USING btree ("organization_id","branch");--> statement-breakpoint
CREATE INDEX "structure_location_gist" ON "gis"."structure" USING gist ("location");--> statement-breakpoint
CREATE INDEX "valve_state_log_valve_idx" ON "gis"."valve_state_log" USING btree ("organization_id","valve_id","changed_at");--> statement-breakpoint
CREATE INDEX "crew_member_user_idx" ON "work_orders"."crew_member" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "work_order_status_idx" ON "work_orders"."work_order" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "work_order_assignee_idx" ON "work_orders"."work_order" USING btree ("organization_id","assigned_to_user_id","status");--> statement-breakpoint
CREATE INDEX "work_order_crew_idx" ON "work_orders"."work_order" USING btree ("organization_id","crew_id","status");--> statement-breakpoint
CREATE INDEX "work_order_asset_idx" ON "work_orders"."work_order" USING btree ("organization_id","asset_module","asset_id");--> statement-breakpoint
CREATE INDEX "work_order_parent_idx" ON "work_orders"."work_order" USING btree ("organization_id","parent_id");--> statement-breakpoint
CREATE INDEX "work_order_due_idx" ON "work_orders"."work_order" USING btree ("organization_id","due_at") WHERE "work_orders"."work_order"."status" not in ('completed', 'cancelled');--> statement-breakpoint
CREATE INDEX "work_order_location_gist" ON "work_orders"."work_order" USING gist ("location");--> statement-breakpoint
CREATE UNIQUE INDEX "work_order_asset_unique" ON "work_orders"."work_order_asset" USING btree ("organization_id","work_order_id","module","asset_id");--> statement-breakpoint
CREATE INDEX "work_order_asset_asset_idx" ON "work_orders"."work_order_asset" USING btree ("organization_id","module","asset_id");--> statement-breakpoint
CREATE INDEX "work_order_capture_order_idx" ON "work_orders"."work_order_capture" USING btree ("organization_id","work_order_id","captured_at");--> statement-breakpoint
CREATE UNIQUE INDEX "work_order_change_set_job_unique" ON "work_orders"."work_order_change_set" USING btree ("organization_id","work_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "work_order_change_set_branch_unique" ON "work_orders"."work_order_change_set" USING btree ("organization_id","branch");--> statement-breakpoint
CREATE INDEX "work_order_comment_order_idx" ON "work_orders"."work_order_comment" USING btree ("organization_id","work_order_id","created_at");--> statement-breakpoint
CREATE INDEX "work_order_event_order_idx" ON "work_orders"."work_order_event" USING btree ("organization_id","work_order_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "work_order_log_link_unique" ON "work_orders"."work_order_log_link" USING btree ("organization_id","work_order_id","log_kind","log_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "gis"."asset" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("gis"."asset"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("gis"."asset"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "gis"."condition_log" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("gis"."condition_log"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("gis"."condition_log"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "gis"."dma" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("gis"."dma"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("gis"."dma"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "gis"."dma_boundary_valve" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("gis"."dma_boundary_valve"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("gis"."dma_boundary_valve"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "gis"."node" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("gis"."node"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("gis"."node"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "gis"."pipe" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("gis"."pipe"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("gis"."pipe"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "gis"."service_connection" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("gis"."service_connection"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("gis"."service_connection"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "gis"."structure" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("gis"."structure"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("gis"."structure"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "gis"."structure_attachment_rule" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("gis"."structure_attachment_rule"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("gis"."structure_attachment_rule"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "gis"."subnetwork" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("gis"."subnetwork"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("gis"."subnetwork"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "gis"."tier" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("gis"."tier"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("gis"."tier"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "gis"."valve_state_log" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("gis"."valve_state_log"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("gis"."valve_state_log"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "work_orders"."crew" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("work_orders"."crew"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("work_orders"."crew"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "work_orders"."crew_member" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("work_orders"."crew_member"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("work_orders"."crew_member"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "work_orders"."work_order" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("work_orders"."work_order"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("work_orders"."work_order"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "work_orders"."work_order_asset" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("work_orders"."work_order_asset"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("work_orders"."work_order_asset"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "work_orders"."work_order_capture" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("work_orders"."work_order_capture"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("work_orders"."work_order_capture"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "work_orders"."work_order_change_set" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("work_orders"."work_order_change_set"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("work_orders"."work_order_change_set"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "work_orders"."work_order_comment" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("work_orders"."work_order_comment"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("work_orders"."work_order_comment"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "work_orders"."work_order_counter" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("work_orders"."work_order_counter"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("work_orders"."work_order_counter"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "work_orders"."work_order_event" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("work_orders"."work_order_event"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("work_orders"."work_order_event"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "work_orders"."work_order_log_link" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("work_orders"."work_order_log_link"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("work_orders"."work_order_log_link"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);