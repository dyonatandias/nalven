-- Preserve the exact credential/account used to dispatch each payment intent.
-- Connector rotation must not silently redirect retries or callbacks in flight.

ALTER TABLE "pos_payment_intents" ADD COLUMN "credential_ref" TEXT;

UPDATE "pos_payment_intents" AS intent
SET "credential_ref" = connector."credential_ref"
FROM "pos_connectors" AS connector
WHERE connector."id" = intent."connector_id"
  AND intent."credential_ref" IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "pos_payment_intents" WHERE "credential_ref" IS NULL) THEN
    RAISE EXCEPTION 'payment intents without dispatch credential require reconciliation before migration';
  END IF;
END;
$$;

ALTER TABLE "pos_payment_intents"
  ALTER COLUMN "credential_ref" SET NOT NULL,
  ADD CONSTRAINT "pos_payment_intents_credential_ref_fkey"
    FOREIGN KEY ("credential_ref") REFERENCES "integration_credentials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "pos_payment_intents_credential_ref_status_idx"
  ON "pos_payment_intents"("credential_ref", "status");

CREATE OR REPLACE FUNCTION "protect_pos_payment_intent"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."id" IS DISTINCT FROM NEW."id"
    OR OLD."branch_id" IS DISTINCT FROM NEW."branch_id"
    OR OLD."register_id" IS DISTINCT FROM NEW."register_id"
    OR OLD."session_id" IS DISTINCT FROM NEW."session_id"
    OR OLD."operator_profile_id" IS DISTINCT FROM NEW."operator_profile_id"
    OR OLD."terminal_id" IS DISTINCT FROM NEW."terminal_id"
    OR OLD."connector_id" IS DISTINCT FROM NEW."connector_id"
    OR NEW."credential_ref" IS DISTINCT FROM OLD."credential_ref"
    OR OLD."sale_draft_id" IS DISTINCT FROM NEW."sale_draft_id"
    OR OLD."payment_index" IS DISTINCT FROM NEW."payment_index"
    OR OLD."amount_cents" IS DISTINCT FROM NEW."amount_cents"
    OR OLD."currency" IS DISTINCT FROM NEW."currency"
    OR OLD."method" IS DISTINCT FROM NEW."method"
    OR OLD."installments" IS DISTINCT FROM NEW."installments"
    OR OLD."provider" IS DISTINCT FROM NEW."provider"
    OR OLD."idempotency_key" IS DISTINCT FROM NEW."idempotency_key"
    OR OLD."request_hash" IS DISTINCT FROM NEW."request_hash"
    OR OLD."expires_at" IS DISTINCT FROM NEW."expires_at"
    OR OLD."created_at" IS DISTINCT FROM NEW."created_at"
  THEN RAISE EXCEPTION 'pos_payment_intent identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."version" <> OLD."version" + 1 THEN RAISE EXCEPTION 'pos_payment_intent version must advance exactly once' USING ERRCODE = '40001'; END IF;
  IF OLD."provider_reference" IS NOT NULL AND NEW."provider_reference" IS DISTINCT FROM OLD."provider_reference" THEN
    RAISE EXCEPTION 'pos_payment_intent provider reference is immutable once bound' USING ERRCODE = '55000';
  END IF;
  IF OLD."consumed_at" IS NOT NULL AND NEW."consumed_at" IS DISTINCT FROM OLD."consumed_at" THEN
    RAISE EXCEPTION 'pos_payment_intent consumption is immutable once bound' USING ERRCODE = '55000';
  END IF;
  IF NEW."provider_sequence" IS NOT NULL AND OLD."provider_sequence" IS NOT NULL AND NEW."provider_sequence" < OLD."provider_sequence" THEN
    RAISE EXCEPTION 'pos_payment_intent provider sequence cannot regress' USING ERRCODE = '22000';
  END IF;
  IF OLD."status" <> NEW."status" AND NOT (
    (OLD."status" = 'created' AND NEW."status" IN ('processing', 'authorized', 'captured', 'declined', 'unknown', 'manual_review', 'cancelled'))
    OR (OLD."status" = 'processing' AND NEW."status" IN ('authorized', 'captured', 'declined', 'unknown', 'manual_review', 'cancelled'))
    OR (OLD."status" = 'authorized' AND NEW."status" IN ('captured', 'unknown', 'manual_review', 'cancelled'))
    OR (OLD."status" = 'unknown' AND NEW."status" IN ('processing', 'authorized', 'captured', 'declined', 'manual_review', 'cancelled'))
    OR (OLD."status" = 'manual_review' AND NEW."status" IN ('processing', 'authorized', 'captured', 'declined', 'cancelled'))
    OR (OLD."status" = 'captured' AND NEW."status" IN ('partially_refunded', 'refunded'))
    OR (OLD."status" = 'partially_refunded' AND NEW."status" IN ('partially_refunded', 'refunded'))
  ) THEN RAISE EXCEPTION 'invalid pos payment intent transition % -> %', OLD."status", NEW."status" USING ERRCODE = '22000'; END IF;
  RETURN NEW;
END;
$$;
