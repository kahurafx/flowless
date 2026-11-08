-- Custom: the structure-attachment backstop (G-01), ported from Majimap's
-- structure-attachment-trigger.sql. A node may only be housed in a structure type its own
-- type allows, however the row got written. The API checks first with a friendlier message;
-- this holds if something bypasses it.
--
-- Changes from Majimap: the rules are per organization (gis.structure_attachment_rule has
-- organization_id and RLS, seeded from STRUCTURE_ATTACHMENT_RULES in shared-types), so the
-- lookup filters on the node's organization; names are fully qualified with a fixed
-- search_path. SECURITY INVOKER: it reads as the writing role, under RLS, which already
-- limits it to the node's own tenant.
--
-- Variables are prefixed v_ so they cannot be confused with column names.

CREATE FUNCTION "gis"."check_structure_attachment"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_structure_type text;
  v_rule_exists boolean;
BEGIN
  -- Only a live head is checked. Retiring a version (is_head -> false) or writing a
  -- tombstone must never fail, or reconcile could not retire a branch whose structure it
  -- has just moved.
  IF NEW.structure_id IS NULL OR NEW.is_deleted OR NOT NEW.is_head THEN
    RETURN NEW;
  END IF;

  -- The structure must be live in the same organization, on the node's branch or on main.
  SELECT s.type::text INTO v_structure_type
    FROM gis.structure AS s
   WHERE s.id = NEW.structure_id
     AND s.organization_id = NEW.organization_id
     AND s.branch IN (NEW.branch, 'main')
     AND s.is_head
     AND NOT s.is_deleted
   ORDER BY (s.branch = NEW.branch) DESC
   LIMIT 1;

  IF v_structure_type IS NULL THEN
    RAISE EXCEPTION 'structure_id % does not reference an existing structure in this organization', NEW.structure_id;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM gis.structure_attachment_rule AS r
     WHERE r.organization_id = NEW.organization_id
       AND r.node_type::text = NEW.type::text
       AND r.structure_type::text = v_structure_type
  ) INTO v_rule_exists;

  IF NOT v_rule_exists THEN
    RAISE EXCEPTION 'node type % may not be housed in structure type %', NEW.type, v_structure_type;
  END IF;

  RETURN NEW;
END
$$;--> statement-breakpoint

CREATE TRIGGER "enforce_structure_attachment" BEFORE INSERT OR UPDATE ON "gis"."node"
  FOR EACH ROW EXECUTE FUNCTION "gis"."check_structure_attachment"();
