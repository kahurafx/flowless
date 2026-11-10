-- Custom: grants and guarantees for the `metering` schema (M-01, M-02, NF-22), copied from
-- the kernel block of 0001_schema_access.sql. Only flowless_app reaches it.

GRANT USAGE ON SCHEMA "metering" TO "flowless_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "metering" TO "flowless_app";--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA "metering" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "flowless_app";--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA "metering" GRANT USAGE, SELECT ON SEQUENCES TO "flowless_app";--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "metering" TO "flowless_app";--> statement-breakpoint

-- Readings and logs are append-only (M-02): a correction is a new row.
REVOKE UPDATE, DELETE, TRUNCATE ON "metering"."reading" FROM "flowless_app";--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "metering"."reading_status" FROM "flowless_app";--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "metering"."meter_event" FROM "flowless_app";--> statement-breakpoint
-- The register and installations are never deleted. A meter changes only its descriptive
-- columns and (with an event) its status; an installation only closes.
REVOKE DELETE, TRUNCATE ON "metering"."meter" FROM "flowless_app";--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "metering"."installation" FROM "flowless_app";--> statement-breakpoint
GRANT UPDATE ("removed_at", "removed_by_user_id", "removal_reason") ON "metering"."installation" TO "flowless_app";--> statement-breakpoint
REVOKE UPDATE ON "metering"."meter" FROM "flowless_app";--> statement-breakpoint
GRANT UPDATE ("model", "note", "status", "status_event_id") ON "metering"."meter" TO "flowless_app";--> statement-breakpoint

-- A meter's status changes only with a new event of that meter that describes the move.
CREATE FUNCTION "metering"."guard_meter_status"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status_event_id IS NULL OR NEW.status_event_id IS NOT DISTINCT FROM OLD.status_event_id THEN
      RAISE EXCEPTION 'Meter % status change needs a new meter_event', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM metering.meter_event e
      WHERE e.organization_id = NEW.organization_id AND e.id = NEW.status_event_id AND e.meter_id = NEW.id
        AND e.from_status = OLD.status AND e.to_status = NEW.status
    ) THEN
      RAISE EXCEPTION 'Meter % status change does not match its event', OLD.id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint

CREATE TRIGGER "meter_guard_status"
BEFORE UPDATE ON "metering"."meter"
FOR EACH ROW EXECUTE FUNCTION "metering"."guard_meter_status"();--> statement-breakpoint

-- An installation closes once.
CREATE FUNCTION "metering"."guard_installation_close"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Installation % is already closed', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint

CREATE TRIGGER "installation_guard_close"
BEFORE UPDATE ON "metering"."installation"
FOR EACH ROW EXECUTE FUNCTION "metering"."guard_installation_close"();--> statement-breakpoint

-- Every reading has a status row from the moment it is committed.
CREATE FUNCTION "metering"."check_reading_has_status"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM metering.reading_status s WHERE s.organization_id = NEW.organization_id AND s.reading_id = NEW.id) THEN
    RAISE EXCEPTION 'Reading % has no status row', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER "reading_has_status"
AFTER INSERT ON "metering"."reading"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "metering"."check_reading_has_status"();
