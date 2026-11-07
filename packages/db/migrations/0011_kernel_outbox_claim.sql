-- Custom: outbox claiming and the auth role's insert-only access (K-09).
--
-- The dispatcher runs as the app role, which RLS limits to one tenant at a time, yet it
-- must find due events across tenants. kernel.claim_outbox() is the one controlled
-- cross-tenant read: SECURITY DEFINER, it leases a batch of due events (FOR UPDATE SKIP
-- LOCKED, so several workers never take the same event) and returns only what routing
-- needs. Everything a consumer does then runs inside withTenant for the event's tenant.
-- A lease that expires (a worker died) makes the event due again.

GRANT INSERT ON "kernel"."outbox_event" TO "flowless_auth";--> statement-breakpoint

CREATE FUNCTION "kernel"."claim_outbox"(batch integer, lease_seconds integer)
RETURNS TABLE(id uuid, organization_id uuid, type text, version integer, payload jsonb, attempts integer)
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  WITH claimed AS (
    UPDATE kernel.outbox_event AS e
       SET available_at = clock_timestamp() + make_interval(secs => lease_seconds),
           attempts = e.attempts + 1
     WHERE e.id IN (
       SELECT d.id FROM kernel.outbox_event AS d
        WHERE d.status = 'pending' AND d.available_at <= clock_timestamp()
        ORDER BY d.occurred_at, d.id
        LIMIT batch
        FOR UPDATE SKIP LOCKED
     )
    RETURNING e.id, e.organization_id, e.type, e.version, e.payload, e.attempts, e.occurred_at
  )
  -- RETURNING has no order of its own: deliver oldest first.
  SELECT c.id, c.organization_id, c.type, c.version, c.payload, c.attempts FROM claimed AS c ORDER BY c.occurred_at, c.id
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION "kernel"."claim_outbox"(integer, integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "kernel"."claim_outbox"(integer, integer) TO "flowless_app";
