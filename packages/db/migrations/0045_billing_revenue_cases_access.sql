-- Custom: guarantees for the revenue-protection case log of 0044 (B-19, B-12).
-- The grants of 0036 already cover new tables through default privileges.

-- Case events are history: added, never changed or removed.
REVOKE UPDATE, DELETE, TRUNCATE ON "billing"."revenue_case" FROM "flowless_app";--> statement-breakpoint

-- An event continues an opened case: the case exists (its `opened` row), the kind and account
-- are the case's own, and a resolved case takes nothing more (one resolution only).
CREATE FUNCTION "billing"."guard_revenue_case"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  head billing.revenue_case%ROWTYPE;
BEGIN
  IF NEW.event = 'opened' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO head FROM billing.revenue_case AS c
   WHERE c.organization_id = NEW.organization_id AND c.id = NEW.case_id AND c.event = 'opened';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That case was never opened' USING ERRCODE = 'check_violation';
  END IF;
  IF head.kind <> NEW.kind OR head.account_id <> NEW.account_id THEN
    RAISE EXCEPTION 'An event cannot change the case''s kind or account' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM billing.revenue_case AS c
     WHERE c.organization_id = NEW.organization_id AND c.case_id = NEW.case_id AND c.event = 'resolved'
  ) THEN
    RAISE EXCEPTION 'The case is resolved; it takes no more events' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint

CREATE TRIGGER "revenue_case_guard"
BEFORE INSERT ON "billing"."revenue_case"
FOR EACH ROW EXECUTE FUNCTION "billing"."guard_revenue_case"();
