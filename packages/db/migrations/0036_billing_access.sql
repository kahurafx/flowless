-- Custom: grants and guarantees for the `billing` schema (NF-22, B-11, I-2, I-4), copied from
-- the kernel block of 0001_schema_access.sql. Only flowless_app reaches it.

GRANT USAGE ON SCHEMA "billing" TO "flowless_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "billing" TO "flowless_app";--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA "billing" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "flowless_app";--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA "billing" GRANT USAGE, SELECT ON SEQUENCES TO "flowless_app";--> statement-breakpoint

-- Ledger and documents are append-only (NF-22, B-11): a correction is a reversal, a credit
-- note, a debit note or a re-bill, never an update or a delete.
REVOKE UPDATE, DELETE, TRUNCATE ON "billing"."document" FROM "flowless_app";--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "billing"."document_line" FROM "flowless_app";--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "billing"."ledger_transaction" FROM "flowless_app";--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "billing"."ledger_entry" FROM "flowless_app";--> statement-breakpoint

-- A posting balances (double entry, enforced at commit): exactly `entry_count` entries, and
-- debits equal credits. Currency is tied to the header by a composite foreign key. Deferred,
-- so a transaction and its entries can be inserted in any order within one database
-- transaction; an entry added to an already committed transaction makes the count wrong and
-- is refused.
CREATE FUNCTION "billing"."check_transaction_balanced"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  tx_id uuid;
  org uuid;
  declared integer;
  n integer;
  debits numeric;
  credits numeric;
BEGIN
  IF TG_TABLE_NAME = 'ledger_transaction' THEN
    tx_id := NEW.id;
  ELSE
    tx_id := NEW.transaction_id;
  END IF;
  org := NEW.organization_id;
  SELECT t.entry_count INTO declared FROM billing.ledger_transaction AS t WHERE t.organization_id = org AND t.id = tx_id;
  IF declared IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT count(*),
         coalesce(sum(e.amount) FILTER (WHERE e.side = 'debit'), 0),
         coalesce(sum(e.amount) FILTER (WHERE e.side = 'credit'), 0)
    INTO n, debits, credits
    FROM billing.ledger_entry AS e WHERE e.organization_id = org AND e.transaction_id = tx_id;
  IF n <> declared THEN
    RAISE EXCEPTION 'Ledger transaction % declares % entries but has %', tx_id, declared, n USING ERRCODE = 'check_violation';
  END IF;
  IF debits <> credits THEN
    RAISE EXCEPTION 'Ledger transaction % is unbalanced: debits % and credits %', tx_id, debits, credits USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER "ledger_transaction_balanced"
AFTER INSERT ON "billing"."ledger_transaction"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "billing"."check_transaction_balanced"();--> statement-breakpoint

CREATE CONSTRAINT TRIGGER "ledger_entry_balanced"
AFTER INSERT ON "billing"."ledger_entry"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "billing"."check_transaction_balanced"();--> statement-breakpoint

-- A document's lines are exactly `line_count` and sum to its total (I-4).
CREATE FUNCTION "billing"."check_document_total"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  doc_id uuid;
  org uuid;
  declared integer;
  declared_total bigint;
  n integer;
  lines_total numeric;
BEGIN
  IF TG_TABLE_NAME = 'document' THEN
    doc_id := NEW.id;
  ELSE
    doc_id := NEW.document_id;
  END IF;
  org := NEW.organization_id;
  SELECT d.line_count, d.total INTO declared, declared_total FROM billing.document AS d WHERE d.organization_id = org AND d.id = doc_id;
  IF declared IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT count(*), coalesce(sum(l.amount), 0) INTO n, lines_total
    FROM billing.document_line AS l WHERE l.organization_id = org AND l.document_id = doc_id;
  IF n <> declared THEN
    RAISE EXCEPTION 'Document % declares % lines but has %', doc_id, declared, n USING ERRCODE = 'check_violation';
  END IF;
  IF lines_total <> declared_total THEN
    RAISE EXCEPTION 'Document % lines sum to % but its total is %', doc_id, lines_total, declared_total USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER "document_total_matches_lines"
AFTER INSERT ON "billing"."document"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "billing"."check_document_total"();--> statement-breakpoint

CREATE CONSTRAINT TRIGGER "document_line_total_matches"
AFTER INSERT ON "billing"."document_line"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "billing"."check_document_total"();
