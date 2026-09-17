ALTER TABLE "fiscal_documents"
  ADD COLUMN "amount_cents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "attempt_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "last_queued_at" TIMESTAMPTZ,
  ADD COLUMN "sla_due_at" TIMESTAMPTZ;

UPDATE "fiscal_documents"
SET "amount_cents" = round("amount" * 100)::integer,
    "attempt_count" = CASE WHEN "status" = 'draft' THEN 0 ELSE 1 END,
    "last_queued_at" = CASE WHEN "status" IN ('queued', 'processing', 'contingency') THEN "updated_at" ELSE NULL END,
    "sla_due_at" = CASE WHEN "status" IN ('queued', 'processing', 'contingency') THEN "updated_at" + interval '30 minutes' ELSE NULL END;

ALTER TABLE "fiscal_documents"
  ADD CONSTRAINT "fiscal_documents_amount_cents_check" CHECK ("amount_cents" >= 0),
  ADD CONSTRAINT "fiscal_documents_attempt_count_check" CHECK ("attempt_count" >= 0);

CREATE OR REPLACE FUNCTION "sync_fiscal_document_amount"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW."amount_cents" = 0 AND NEW."amount" <> 0 THEN
    NEW."amount_cents" := round(NEW."amount" * 100)::integer;
  ELSIF TG_OP = 'INSERT' OR NEW."amount_cents" IS DISTINCT FROM OLD."amount_cents" THEN
    NEW."amount" := NEW."amount_cents" / 100.0;
  ELSIF NEW."amount" IS DISTINCT FROM OLD."amount" THEN
    NEW."amount_cents" := round(NEW."amount" * 100)::integer;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "fiscal_documents_sync_amount"
BEFORE INSERT OR UPDATE OF "amount", "amount_cents" ON "fiscal_documents"
FOR EACH ROW EXECUTE FUNCTION "sync_fiscal_document_amount"();

CREATE TABLE "fiscal_operations" (
  "id" SERIAL PRIMARY KEY,
  "branch_id" INTEGER NOT NULL REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "document_id" INTEGER REFERENCES "fiscal_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "type" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "priority" TEXT NOT NULL DEFAULT 'normal',
  "reason" TEXT,
  "details" JSONB,
  "correlation_id" TEXT NOT NULL UNIQUE,
  "requested_by" TEXT NOT NULL,
  "requested_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "due_at" TIMESTAMPTZ NOT NULL,
  "resolved_by" TEXT,
  "resolved_at" TIMESTAMPTZ,
  "resolution" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "fiscal_operations_type_check" CHECK ("type" IN ('issuance', 'retry', 'status_query', 'contingency', 'cancellation', 'correction', 'invalidation')),
  CONSTRAINT "fiscal_operations_status_check" CHECK ("status" IN ('pending', 'processing', 'completed', 'rejected', 'withdrawn')),
  CONSTRAINT "fiscal_operations_priority_check" CHECK ("priority" IN ('normal', 'urgent')),
  CONSTRAINT "fiscal_operations_resolution_check" CHECK (
    ("status" IN ('pending', 'processing') AND "resolved_at" IS NULL AND "resolved_by" IS NULL)
    OR
    ("status" IN ('completed', 'rejected', 'withdrawn') AND "resolved_at" IS NOT NULL AND "resolved_by" IS NOT NULL)
  )
);

CREATE INDEX "fiscal_operations_branch_id_status_due_at_idx" ON "fiscal_operations"("branch_id", "status", "due_at");
CREATE INDEX "fiscal_operations_document_id_status_requested_at_idx" ON "fiscal_operations"("document_id", "status", "requested_at");
CREATE INDEX "fiscal_operations_type_status_requested_at_idx" ON "fiscal_operations"("type", "status", "requested_at");
CREATE UNIQUE INDEX "fiscal_operations_one_open_per_document_type_idx"
  ON "fiscal_operations"("document_id", "type")
  WHERE "document_id" IS NOT NULL AND "status" IN ('pending', 'processing');

INSERT INTO "fiscal_operations" (
  "branch_id", "document_id", "type", "status", "priority", "reason", "correlation_id",
  "requested_by", "requested_at", "due_at", "resolved_by", "resolved_at", "resolution", "created_at", "updated_at"
)
SELECT
  "branch_id", "id", 'issuance',
  CASE WHEN "status" IN ('draft', 'queued', 'processing', 'contingency') THEN 'pending' ELSE 'completed' END,
  CASE WHEN "status" IN ('rejected', 'contingency') THEN 'urgent' ELSE 'normal' END,
  'Operação inicial migrada do histórico fiscal',
  'migration-fiscal-operation-' || "id",
  "created_by", COALESCE("last_queued_at", "created_at"),
  COALESCE("sla_due_at", "created_at" + interval '30 minutes'),
  CASE WHEN "status" IN ('draft', 'queued', 'processing', 'contingency') THEN NULL ELSE 'Migração fiscal' END,
  CASE WHEN "status" IN ('draft', 'queued', 'processing', 'contingency') THEN NULL ELSE COALESCE("issued_at", "cancelled_at", "updated_at") END,
  CASE WHEN "status" IN ('draft', 'queued', 'processing', 'contingency') THEN NULL ELSE 'Estado importado: ' || "status" END,
  "created_at", "updated_at"
FROM "fiscal_documents"
WHERE "status" <> 'draft';
