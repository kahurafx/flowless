-- Custom: the audit log is append-only and tamper-evident (K-06, NF-07).
--
-- 1. Grants: the app role may read and insert, never change or remove. The auth role may
--    only insert, so Better Auth events are recorded; it still reads nothing outside `auth`.
-- 2. A trigger chains each organization's rows: chain_index counts up from 1 and
--    hash = sha256(prev_hash | row). Editing or removing a row breaks the chain from that
--    row on, which kernel.verify_audit_chain() reports. Removing the newest rows cannot
--    be detected from the chain alone; anchoring the latest hash elsewhere covers that.
-- 3. The trigger stamps occurred_at itself, so callers cannot backdate an entry.

REVOKE UPDATE, DELETE, TRUNCATE ON "kernel"."audit_log" FROM "flowless_app";--> statement-breakpoint
GRANT USAGE ON SCHEMA "kernel" TO "flowless_auth";--> statement-breakpoint
GRANT INSERT ON "kernel"."audit_log" TO "flowless_auth";--> statement-breakpoint

CREATE FUNCTION "kernel"."audit_digest"(prev bytea, r "kernel"."audit_log") RETURNS bytea
LANGUAGE sql STABLE
SET search_path = pg_catalog
AS $$
  SELECT sha256(convert_to(concat_ws('|',
    coalesce(encode(prev, 'hex'), ''),
    r.organization_id::text,
    r.chain_index::text,
    to_char(r.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
    coalesce(r.actor_user_id::text, ''),
    coalesce(r.actor_label, ''),
    r.source,
    r.action,
    coalesce(r.subject_type, ''),
    coalesce(r.subject_id, ''),
    coalesce(r.before::text, ''),
    coalesce(r.after::text, ''),
    coalesce(r.reason, ''),
    coalesce(r.ip_address, '')
  ), 'UTF8'))
$$;--> statement-breakpoint

-- SECURITY DEFINER: runs as the table owner, so it can read the previous row whatever the
-- inserting role may see. The advisory lock serialises inserts per organization.
CREATE FUNCTION "kernel"."audit_chain"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  last_index bigint;
  last_hash bytea;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('kernel.audit_log:' || NEW.organization_id::text, 0));
  SELECT chain_index, hash INTO last_index, last_hash
    FROM kernel.audit_log
    WHERE organization_id = NEW.organization_id
    ORDER BY chain_index DESC
    LIMIT 1;
  NEW.occurred_at := clock_timestamp();
  NEW.chain_index := coalesce(last_index, 0) + 1;
  NEW.prev_hash := last_hash;
  NEW.hash := kernel.audit_digest(last_hash, NEW);
  RETURN NEW;
END
$$;--> statement-breakpoint

CREATE TRIGGER "audit_chain" BEFORE INSERT ON "kernel"."audit_log"
  FOR EACH ROW EXECUTE FUNCTION "kernel"."audit_chain"();--> statement-breakpoint

-- Checks the current tenant's chain (app.organization_id). Returns how many rows were
-- checked and the chain_index of the first broken row, or NULL when the chain is intact.
CREATE FUNCTION "kernel"."verify_audit_chain"() RETURNS TABLE(checked bigint, first_broken bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  org uuid := nullif(current_setting('app.organization_id', true), '')::uuid;
  r kernel.audit_log;
  prev bytea;
  expected bigint := 1;
BEGIN
  IF org IS NULL THEN
    RAISE EXCEPTION 'No organization is set for this transaction';
  END IF;
  checked := 0;
  FOR r IN SELECT * FROM kernel.audit_log WHERE organization_id = org ORDER BY chain_index LOOP
    checked := checked + 1;
    IF r.chain_index <> expected OR r.prev_hash IS DISTINCT FROM prev OR r.hash IS DISTINCT FROM kernel.audit_digest(prev, r) THEN
      first_broken := r.chain_index;
      RETURN NEXT;
      RETURN;
    END IF;
    prev := r.hash;
    expected := expected + 1;
  END LOOP;
  first_broken := NULL;
  RETURN NEXT;
END
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION "kernel"."verify_audit_chain"() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "kernel"."verify_audit_chain"() TO "flowless_app";--> statement-breakpoint
REVOKE ALL ON FUNCTION "kernel"."audit_chain"() FROM PUBLIC;
