-- Custom: the account lifecycle's guarantees (C-03, C-06, C-11) for the tables added in
-- 0030_accounts_lifecycle.sql.

-- The command log and the activation checklist are history: a row is added, never changed
-- or removed. A correction is another command, or an untick (a retraction row).
REVOKE UPDATE, DELETE, TRUNCATE ON "accounts"."account_command" FROM "flowless_app";--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "accounts"."activation_check" FROM "flowless_app";--> statement-breakpoint

-- An account's status columns change only together with a command row that describes that
-- exact change (C-03: "every change is a logged command with actor and reason"). The
-- account's `status_command_id` must name a command of this account whose from-state is the
-- row being replaced and whose to-state is the new one, and it must be a different command
-- from the one before, so an old command cannot be reused. The command is inserted first,
-- in the same transaction. Application code is the only writer, but this makes a path that
-- skips the log impossible rather than merely absent.
CREATE FUNCTION "accounts"."guard_account_status"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.commercial_status IS DISTINCT FROM OLD.commercial_status
     OR NEW.service_status IS DISTINCT FROM OLD.service_status
     OR NEW.service_status_reason IS DISTINCT FROM OLD.service_status_reason
     OR NEW.status_command_id IS DISTINCT FROM OLD.status_command_id THEN
    IF NEW.status_command_id IS NULL
       OR NEW.status_command_id IS NOT DISTINCT FROM OLD.status_command_id
       OR NOT EXISTS (
         SELECT 1 FROM accounts.account_command AS c
          WHERE c.id = NEW.status_command_id
            AND c.organization_id = NEW.organization_id
            AND c.account_id = NEW.id
            AND c.from_commercial_status = OLD.commercial_status
            AND c.to_commercial_status = NEW.commercial_status
            AND c.from_service_status = OLD.service_status
            AND c.to_service_status = NEW.service_status
            AND c.service_reason IS NOT DISTINCT FROM NEW.service_status_reason
       ) THEN
      RAISE EXCEPTION 'An account''s status changes only through a logged command' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint

CREATE TRIGGER "account_status_guard"
BEFORE UPDATE ON "accounts"."account"
FOR EACH ROW EXECUTE FUNCTION "accounts"."guard_account_status"();--> statement-breakpoint

-- The worker's one cross-tenant read for the stale-account sweep (C-06, X-02), like
-- work_orders.overdue_work_orders: the organizations licensed for Accounts that have an
-- account still in NEW or PENDING_PAYMENT, or an open exception this sweep raised and may now
-- resolve, in id order after `after_id`. Only organization ids come back; the sweep then
-- reads each organization's accounts inside withTenant.

CREATE FUNCTION "accounts"."sweep_organizations"(after_id uuid, batch integer)
RETURNS TABLE(organization_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT m.organization_id FROM kernel.organization_module AS m
   WHERE m.module = 'accounts'
     AND (after_id IS NULL OR m.organization_id > after_id)
     AND (
       EXISTS (
         SELECT 1 FROM accounts.account AS a
          WHERE a.organization_id = m.organization_id AND a.commercial_status IN ('NEW', 'PENDING_PAYMENT')
       )
       OR EXISTS (
         SELECT 1 FROM kernel.exception AS e
          WHERE e.organization_id = m.organization_id AND e.source = 'accounts' AND e.status <> 'resolved'
            AND e.type IN ('STALE_ACTIVATION', 'ACCOUNT_NOT_ACTIVE_WITH_METER')
       )
     )
   ORDER BY m.organization_id
   LIMIT batch
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION "accounts"."sweep_organizations"(uuid, integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "accounts"."sweep_organizations"(uuid, integer) TO "flowless_app";
