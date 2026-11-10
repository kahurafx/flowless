-- Custom: guarantees for the billing cycle tables of 0042 (B-02, B-03, B-04, B-15, B-16).
-- The grants of 0036 already cover new tables through default privileges.

-- Event, account, outcome and review rows are history: added, never changed or removed.
REVOKE UPDATE, DELETE, TRUNCATE ON "billing"."cycle_event" FROM "flowless_app";--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "billing"."cycle_account" FROM "flowless_app";--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "billing"."cycle_outcome" FROM "flowless_app";--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "billing"."cycle_review" FROM "flowless_app";--> statement-breakpoint
-- A cycle is never deleted and only its state may change, and only through a logged event.
REVOKE UPDATE, DELETE, TRUNCATE ON "billing"."cycle" FROM "flowless_app";--> statement-breakpoint
GRANT UPDATE ("state") ON "billing"."cycle" TO "flowless_app";--> statement-breakpoint

-- Expected accounts of a cycle that have no outcome yet (B-04). Every outcome row carries a
-- reason where one is required (check constraint), so "has an outcome" is "explained".
CREATE FUNCTION "billing"."cycle_unexplained"(org uuid, the_cycle uuid)
RETURNS bigint
LANGUAGE sql STABLE
AS $$
  SELECT count(*) FROM billing.cycle_account AS a
   WHERE a.organization_id = org AND a.cycle_id = the_cycle AND a.expected
     AND NOT EXISTS (
       SELECT 1 FROM billing.cycle_outcome AS o
        WHERE o.organization_id = a.organization_id AND o.cycle_id = a.cycle_id AND o.account_id = a.account_id)
$$;--> statement-breakpoint

-- The event log is a chain: each event continues from the newest one, moves by the table in
-- `modules/billing/cycle-machine.ts` (advance one step, skip forward or retreat with a reason,
-- close only from `completeness`), and `closed` is terminal. Closing is refused while any
-- expected account is unexplained.
CREATE FUNCTION "billing"."guard_cycle_event"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  states text[] := ARRAY['open','reading_window','validation','estimation','calculation','review','issue','deliver','completeness','closed'];
  last_seq integer;
  last_to text;
  from_pos integer;
  to_pos integer;
  missing bigint;
BEGIN
  SELECT e.seq, e.to_state INTO last_seq, last_to FROM billing.cycle_event AS e
   WHERE e.organization_id = NEW.organization_id AND e.cycle_id = NEW.cycle_id ORDER BY e.seq DESC LIMIT 1;
  IF NOT FOUND THEN
    IF NEW.seq <> 1 OR NEW.kind <> 'open' OR NEW.to_state <> 'open' THEN
      RAISE EXCEPTION 'A cycle''s first event opens it' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.seq <> last_seq + 1 OR NEW.from_state IS DISTINCT FROM last_to THEN
    RAISE EXCEPTION 'A cycle event continues from the newest one' USING ERRCODE = 'check_violation';
  END IF;
  IF last_to = 'closed' THEN
    RAISE EXCEPTION 'A closed cycle does not move' USING ERRCODE = 'check_violation';
  END IF;
  from_pos := array_position(states, NEW.from_state);
  to_pos := array_position(states, NEW.to_state);
  IF NOT (
       (NEW.kind = 'advance' AND to_pos = from_pos + 1 AND NEW.to_state <> 'closed')
    OR (NEW.kind = 'skip' AND to_pos > from_pos + 1 AND NEW.to_state <> 'closed')
    OR (NEW.kind = 'retreat' AND to_pos < from_pos AND to_pos >= 2)
    OR (NEW.kind = 'close' AND NEW.from_state = 'completeness' AND NEW.to_state = 'closed')
  ) THEN
    RAISE EXCEPTION 'A cycle cannot move from % to % as %', NEW.from_state, NEW.to_state, NEW.kind USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.to_state = 'closed' THEN
    missing := billing.cycle_unexplained(NEW.organization_id, NEW.cycle_id);
    IF missing > 0 THEN
      RAISE EXCEPTION 'A cycle closes only when every expected account has an outcome (% without)', missing USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint

CREATE TRIGGER "cycle_event_guard"
BEFORE INSERT ON "billing"."cycle_event"
FOR EACH ROW EXECUTE FUNCTION "billing"."guard_cycle_event"();--> statement-breakpoint

-- A cycle starts open, and its state changes only to the newest event's, from the state the
-- event left (the same pattern as accounts.guard_account_status).
CREATE FUNCTION "billing"."guard_cycle"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'open' THEN
      RAISE EXCEPTION 'A cycle starts open' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NOT EXISTS (
      SELECT 1 FROM billing.cycle_event AS e
       WHERE e.organization_id = NEW.organization_id AND e.cycle_id = NEW.id
         AND e.seq = (SELECT max(x.seq) FROM billing.cycle_event AS x WHERE x.organization_id = NEW.organization_id AND x.cycle_id = NEW.id)
         AND e.from_state = OLD.state AND e.to_state = NEW.state
    ) THEN
      RAISE EXCEPTION 'A cycle''s state changes only through a logged event' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint

CREATE TRIGGER "cycle_guard"
BEFORE INSERT OR UPDATE ON "billing"."cycle"
FOR EACH ROW EXECUTE FUNCTION "billing"."guard_cycle"();--> statement-breakpoint

-- A closed cycle's period is locked (B-15): nothing is added to its accounts, outcomes or reviews.
CREATE FUNCTION "billing"."guard_cycle_open"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM billing.cycle AS c WHERE c.organization_id = NEW.organization_id AND c.id = NEW.cycle_id AND c.state = 'closed') THEN
    RAISE EXCEPTION 'The cycle is closed; its period is locked' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint

CREATE TRIGGER "cycle_account_open" BEFORE INSERT ON "billing"."cycle_account" FOR EACH ROW EXECUTE FUNCTION "billing"."guard_cycle_open"();--> statement-breakpoint
CREATE TRIGGER "cycle_outcome_open" BEFORE INSERT ON "billing"."cycle_outcome" FOR EACH ROW EXECUTE FUNCTION "billing"."guard_cycle_open"();--> statement-breakpoint
CREATE TRIGGER "cycle_review_open" BEFORE INSERT ON "billing"."cycle_review" FOR EACH ROW EXECUTE FUNCTION "billing"."guard_cycle_open"();
