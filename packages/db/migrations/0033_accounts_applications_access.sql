-- Custom: the guarantees of Phase 3 F3b (C-05, C-07 to C-10) for the tables and columns
-- added in 0032_accounts_applications.sql. Grants to flowless_app on the new tables come
-- from the default privileges set in 0027_accounts_access.sql.

-- History is append-only: a holder row, an application event and a relocation event are
-- added, never changed or removed. A correction is a later row.
REVOKE UPDATE, DELETE, TRUNCATE ON "accounts"."account_holder" FROM "flowless_app";--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "accounts"."application_event" FROM "flowless_app";--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "accounts"."relocation_event" FROM "flowless_app";--> statement-breakpoint
-- Applications and relocations are never deleted: a rejected or cancelled one is a stage.
REVOKE DELETE, TRUNCATE ON "accounts"."application" FROM "flowless_app";--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "accounts"."relocation" FROM "flowless_app";--> statement-breakpoint

-- Every account so far has one open holder row: its current customer, from the day it was opened.
INSERT INTO "accounts"."account_holder" ("organization_id", "account_id", "customer_id", "valid_from", "reason", "created_by_user_id")
SELECT a."organization_id", a."id", a."customer_id", (a."opened_at" AT TIME ZONE 'UTC')::date, 'Holder when the history began', a."created_by_user_id"
  FROM "accounts"."account" AS a;--> statement-breakpoint

-- The holder of an account (C-10): `account.customer_id` is the current holder and changes
-- only to the customer of the newest `account_holder` row (the row is inserted first, in the
-- same transaction, by the change-of-name or succession use case). The links of a
-- succession (C-08) are set once and never moved or cleared.
CREATE FUNCTION "accounts"."guard_account_links"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.customer_id IS DISTINCT FROM OLD.customer_id THEN
    IF NOT EXISTS (
      SELECT 1 FROM (
        SELECT h.customer_id
          FROM accounts.account_holder AS h
         WHERE h.organization_id = NEW.organization_id AND h.account_id = NEW.id
         ORDER BY h.valid_from DESC, h.created_at DESC
         LIMIT 1
      ) AS newest
      WHERE newest.customer_id = NEW.customer_id
    ) THEN
      RAISE EXCEPTION 'An account''s holder changes only through a recorded change of name' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (OLD.predecessor_account_id IS NOT NULL AND NEW.predecessor_account_id IS DISTINCT FROM OLD.predecessor_account_id)
     OR (OLD.successor_account_id IS NOT NULL AND NEW.successor_account_id IS DISTINCT FROM OLD.successor_account_id) THEN
    RAISE EXCEPTION 'An account''s predecessor and successor are set once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint

CREATE TRIGGER "account_links_guard"
BEFORE UPDATE ON "accounts"."account"
FOR EACH ROW EXECUTE FUNCTION "accounts"."guard_account_links"();--> statement-breakpoint

-- An application's stage moves only with a `stage_changed` event of that application that
-- describes the move (from the old stage to the new). Stages are one-way, so a move can be
-- described by only one event, once.
CREATE FUNCTION "accounts"."guard_application_stage"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.stage IS DISTINCT FROM OLD.stage THEN
    IF NOT EXISTS (
      SELECT 1 FROM accounts.application_event AS e
       WHERE e.organization_id = NEW.organization_id AND e.application_id = NEW.id
         AND e.kind = 'stage_changed' AND e.from_stage = OLD.stage AND e.to_stage = NEW.stage
    ) THEN
      RAISE EXCEPTION 'An application''s stage changes only through a logged event' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint

CREATE TRIGGER "application_stage_guard"
BEFORE UPDATE ON "accounts"."application"
FOR EACH ROW EXECUTE FUNCTION "accounts"."guard_application_stage"();--> statement-breakpoint

-- Likewise a relocation's status.
CREATE FUNCTION "accounts"."guard_relocation_status"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT EXISTS (
      SELECT 1 FROM accounts.relocation_event AS e
       WHERE e.organization_id = NEW.organization_id AND e.relocation_id = NEW.id
         AND e.from_status = OLD.status AND e.to_status = NEW.status
    ) THEN
      RAISE EXCEPTION 'A relocation''s status changes only through a logged event' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint

CREATE TRIGGER "relocation_status_guard"
BEFORE UPDATE ON "accounts"."relocation"
FOR EACH ROW EXECUTE FUNCTION "accounts"."guard_relocation_status"();
