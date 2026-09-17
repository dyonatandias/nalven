-- Keep one effective A1 per branch before enforcing the invariant.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY branch_id
           ORDER BY expires_at DESC, created_at DESC, id DESC
         ) AS position
  FROM fiscal_certificates
  WHERE active = true
)
UPDATE fiscal_certificates AS certificate
SET active = false, updated_at = CURRENT_TIMESTAMP
FROM ranked
WHERE certificate.id = ranked.id AND ranked.position > 1;

-- Recovery-safe cleanup: Prisma/PostgreSQL may preserve earlier DDL statements
-- when a later statement in the same migration fails.
DROP INDEX IF EXISTS fiscal_certificates_one_active_per_branch_idx;
DROP INDEX IF EXISTS fiscal_documents_branch_status_created_idx;
DROP INDEX IF EXISTS fiscal_documents_access_key_idx;
ALTER TABLE fiscal_certificates DROP CONSTRAINT IF EXISTS fiscal_certificates_branch_fk;
ALTER TABLE fiscal_documents DROP CONSTRAINT IF EXISTS fiscal_documents_branch_fk;
ALTER TABLE fiscal_documents DROP CONSTRAINT IF EXISTS fiscal_documents_type_check;
ALTER TABLE fiscal_documents DROP CONSTRAINT IF EXISTS fiscal_documents_status_check;
ALTER TABLE fiscal_documents DROP CONSTRAINT IF EXISTS fiscal_documents_environment_check;
ALTER TABLE fiscal_documents DROP CONSTRAINT IF EXISTS fiscal_documents_series_check;
ALTER TABLE fiscal_documents DROP CONSTRAINT IF EXISTS fiscal_documents_number_check;
ALTER TABLE fiscal_documents DROP CONSTRAINT IF EXISTS fiscal_documents_amount_check;
DROP TRIGGER IF EXISTS fiscal_events_append_only ON fiscal_events;

CREATE UNIQUE INDEX fiscal_certificates_one_active_per_branch_idx
  ON fiscal_certificates (branch_id)
  WHERE active = true;

CREATE INDEX fiscal_documents_branch_status_created_idx
  ON fiscal_documents (branch_id, status, created_at);
CREATE INDEX fiscal_documents_access_key_idx
  ON fiscal_documents (access_key);

ALTER TABLE fiscal_certificates
  ADD CONSTRAINT fiscal_certificates_branch_fk
  FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE fiscal_documents
  ADD CONSTRAINT fiscal_documents_branch_fk
  FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE fiscal_documents
  ADD CONSTRAINT fiscal_documents_type_check CHECK (type IN ('nfe', 'nfce', 'nfse')),
  ADD CONSTRAINT fiscal_documents_status_check CHECK (status IN ('draft', 'queued', 'processing', 'authorized', 'rejected', 'contingency', 'cancelled')),
  ADD CONSTRAINT fiscal_documents_environment_check CHECK (environment IN ('homologation', 'production')),
  ADD CONSTRAINT fiscal_documents_series_check CHECK (series BETWEEN 1 AND 999),
  ADD CONSTRAINT fiscal_documents_number_check CHECK (number BETWEEN 1 AND 999999999),
  ADD CONSTRAINT fiscal_documents_amount_check CHECK (
    amount >= 0
    AND amount NOT IN ('NaN'::double precision, 'Infinity'::double precision, '-Infinity'::double precision)
  );

CREATE OR REPLACE FUNCTION prevent_fiscal_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'fiscal events are append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER fiscal_events_append_only
BEFORE UPDATE OR DELETE ON fiscal_events
FOR EACH ROW EXECUTE FUNCTION prevent_fiscal_event_mutation();
