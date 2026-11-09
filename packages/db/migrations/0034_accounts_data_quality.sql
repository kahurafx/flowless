-- Custom: the worker's one cross-tenant read for the data-quality sweep (C-12, X-02), like
-- accounts.sweep_organizations: the organizations licensed for Accounts that have ever set
-- `accounts.data_quality` (so may have chosen to raise exceptions) or still have an open
-- DATA_QUALITY exception the sweep may now resolve, in id order after `after_id`. Only
-- organization ids come back; the sweep then reads each organization's setting and accounts
-- inside withTenant. An unlicensed organization is never returned.

CREATE FUNCTION "accounts"."data_quality_organizations"(after_id uuid, batch integer)
RETURNS TABLE(organization_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT m.organization_id FROM kernel.organization_module AS m
   WHERE m.module = 'accounts'
     AND (after_id IS NULL OR m.organization_id > after_id)
     AND (
       EXISTS (
         SELECT 1 FROM kernel.config_version AS c
          WHERE c.organization_id = m.organization_id AND c.key = 'accounts.data_quality'
       )
       OR EXISTS (
         SELECT 1 FROM kernel.exception AS e
          WHERE e.organization_id = m.organization_id AND e.source = 'accounts' AND e.status <> 'resolved'
            AND e.type = 'DATA_QUALITY'
       )
     )
   ORDER BY m.organization_id
   LIMIT batch
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION "accounts"."data_quality_organizations"(uuid, integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "accounts"."data_quality_organizations"(uuid, integer) TO "flowless_app";
