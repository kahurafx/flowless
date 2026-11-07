-- Custom: exception ownership and job claiming (X-02, NF-12, NF-24).
--
-- An exception's owner must be a member of its organization. When they leave, the
-- exception stays and becomes unassigned: SET NULL on owner_user_id only, which
-- drizzle-kit cannot express.

ALTER TABLE "kernel"."exception" ADD CONSTRAINT "exception_owner_fk"
  FOREIGN KEY ("organization_id", "owner_user_id") REFERENCES "auth"."member"("organization_id", "user_id")
  ON DELETE SET NULL ("owner_user_id");--> statement-breakpoint

-- Like kernel.claim_outbox: the worker's one cross-tenant read for jobs. Takes queued jobs
-- that are due and running jobs whose lease ran out (their worker died), leases them,
-- and returns what running needs. The job itself then runs inside withTenant.
CREATE FUNCTION "kernel"."claim_jobs"(batch integer, lease_seconds integer)
RETURNS TABLE(id uuid, organization_id uuid, type text, payload jsonb, attempts integer, max_attempts integer, created_by_user_id uuid)
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  WITH claimed AS (
    UPDATE kernel.job AS j
       SET status = 'running',
           run_at = clock_timestamp() + make_interval(secs => lease_seconds),
           started_at = coalesce(j.started_at, clock_timestamp()),
           attempts = j.attempts + 1
     WHERE j.id IN (
       SELECT d.id FROM kernel.job AS d
        WHERE d.status IN ('queued', 'running') AND d.run_at <= clock_timestamp()
        ORDER BY d.run_at, d.id
        LIMIT batch
        FOR UPDATE SKIP LOCKED
     )
    RETURNING j.id, j.organization_id, j.type, j.payload, j.attempts, j.max_attempts, j.created_by_user_id, j.created_at
  )
  SELECT c.id, c.organization_id, c.type, c.payload, c.attempts, c.max_attempts, c.created_by_user_id
    FROM claimed AS c ORDER BY c.created_at, c.id
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION "kernel"."claim_jobs"(integer, integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "kernel"."claim_jobs"(integer, integer) TO "flowless_app";
