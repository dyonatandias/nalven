-- Make financial history non-destructive and bind every kit return balance to
-- an immutable operation ledger validated at transaction commit.

ALTER TABLE "pos_sale_payments" DROP CONSTRAINT "pos_sale_payments_sale_id_fkey";
ALTER TABLE "pos_sale_payments" ADD CONSTRAINT "pos_sale_payments_sale_id_fkey"
  FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

UPDATE "pos_sale_payments" AS payment
SET "refunded_at" = evidence."refunded_at"
FROM (
  SELECT "original_payment_id", max(COALESCE("refunded_at", "created_at")) AS "refunded_at"
  FROM "pos_sale_payments"
  WHERE "type" = 'refund' AND "original_payment_id" IS NOT NULL
  GROUP BY "original_payment_id"
) AS evidence
WHERE payment."id" = evidence."original_payment_id"
  AND payment."status" = 'refunded'
  AND payment."refunded_at" IS NULL;

CREATE FUNCTION "protect_pos_sale_payment_history"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pos sale payment history is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."id" IS DISTINCT FROM NEW."id"
    OR OLD."sale_id" IS DISTINCT FROM NEW."sale_id"
    OR OLD."connector_id" IS DISTINCT FROM NEW."connector_id"
    OR OLD."original_payment_id" IS DISTINCT FROM NEW."original_payment_id"
    OR OLD."processing_session_id" IS DISTINCT FROM NEW."processing_session_id"
    OR OLD."type" IS DISTINCT FROM NEW."type"
    OR OLD."method" IS DISTINCT FROM NEW."method"
    OR OLD."amount_cents" IS DISTINCT FROM NEW."amount_cents"
    OR OLD."tendered_cents" IS DISTINCT FROM NEW."tendered_cents"
    OR OLD."change_cents" IS DISTINCT FROM NEW."change_cents"
    OR OLD."provider" IS DISTINCT FROM NEW."provider"
    OR OLD."transaction_id" IS DISTINCT FROM NEW."transaction_id"
    OR OLD."end_to_end_id" IS DISTINCT FROM NEW."end_to_end_id"
    OR OLD."nsu" IS DISTINCT FROM NEW."nsu"
    OR OLD."authorization_code" IS DISTINCT FROM NEW."authorization_code"
    OR OLD."card_brand" IS DISTINCT FROM NEW."card_brand"
    OR OLD."card_last_four" IS DISTINCT FROM NEW."card_last_four"
    OR OLD."installments" IS DISTINCT FROM NEW."installments"
    OR OLD."idempotency_key" IS DISTINCT FROM NEW."idempotency_key"
    OR OLD."payment_intent_id" IS DISTINCT FROM NEW."payment_intent_id"
    OR OLD."metadata" IS DISTINCT FROM NEW."metadata"
    OR OLD."authorized_at" IS DISTINCT FROM NEW."authorized_at"
    OR OLD."captured_at" IS DISTINCT FROM NEW."captured_at"
    OR OLD."created_at" IS DISTINCT FROM NEW."created_at"
  THEN RAISE EXCEPTION 'pos sale payment evidence is immutable' USING ERRCODE = '55000'; END IF;
  IF OLD."status" IS DISTINCT FROM NEW."status" AND NOT (
    OLD."status" IN ('captured', 'manual_confirmed') AND NEW."status" IN ('partially_refunded', 'refunded')
    OR OLD."status" = 'partially_refunded' AND NEW."status" = 'refunded'
  ) THEN RAISE EXCEPTION 'invalid pos sale payment transition % -> %', OLD."status", NEW."status" USING ERRCODE = '22000'; END IF;
  IF OLD."refunded_at" IS NOT NULL AND NEW."refunded_at" IS DISTINCT FROM OLD."refunded_at" THEN
    RAISE EXCEPTION 'pos sale payment refund timestamp is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."status" = 'refunded' AND NEW."refunded_at" IS NULL THEN
    RAISE EXCEPTION 'refunded pos sale payment requires refunded_at' USING ERRCODE = '22000';
  END IF;
  IF NEW."status" <> 'refunded' AND NEW."refunded_at" IS NOT NULL AND OLD."refunded_at" IS DISTINCT FROM NEW."refunded_at" THEN
    RAISE EXCEPTION 'refunded_at is only valid for a fully refunded payment' USING ERRCODE = '22000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "pos_sale_payments_history_guard"
BEFORE UPDATE OR DELETE ON "pos_sale_payments"
FOR EACH ROW EXECUTE FUNCTION "protect_pos_sale_payment_history"();

CREATE FUNCTION "validate_consumed_pos_manual_payment_reference"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" <> 'consumed' THEN RETURN NEW; END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM "pos_sale_payments" payment
    JOIN "sales" sale ON sale."id" = payment."sale_id"
    JOIN "pos_approvals" approval ON approval."id" = NEW."approval_id"
    WHERE payment."id" = NEW."consumed_sale_payment_id"
      AND payment."type" = 'payment'
      AND payment."status" IN ('manual_confirmed', 'partially_refunded', 'refunded')
      AND payment."method" = NEW."method"
      AND payment."amount_cents" = NEW."amount_cents"
      AND payment."provider" = NEW."provider"
      AND payment."processing_session_id" = NEW."session_id"
      AND ((NEW."method" = 'pix' AND payment."end_to_end_id" = NEW."reference" AND payment."transaction_id" IS NULL)
        OR (NEW."method" <> 'pix' AND payment."transaction_id" = NEW."reference" AND payment."end_to_end_id" IS NULL))
      AND payment."metadata"->>'confirmationMode' = 'manual_dual_control'
      AND payment."metadata"->>'manualReferenceId' = NEW."id"
      AND payment."metadata"->>'manualApprovalId' = NEW."approval_id"
      AND sale."branch_id" = NEW."branch_id"
      AND sale."session_id" = NEW."session_id"
      AND sale."operator_profile_id" = NEW."requester_profile_id"
      AND approval."branch_id" = NEW."branch_id"
      AND approval."action" = 'payment.manual_reference'
      AND approval."entity_type" = 'sale_draft'
      AND approval."entity_id" = NEW."sale_draft_id"
      AND approval."status" = 'approved'
      AND approval."requester_id" = NEW."requester_user_id"
      AND approval."approver_id" IS NOT NULL
      AND approval."approver_id" <> approval."requester_id"
      AND approval."consumed_at" IS NOT NULL
      AND approval."consumed_by" = NEW."requester_user_id"
      AND approval."consumption_ref" = NEW."sale_draft_id"
  ) THEN RAISE EXCEPTION 'consumed manual payment reference does not match payment, sale and approval context' USING ERRCODE = '22000'; END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "pos_manual_payment_references_consumed_context_guard"
AFTER INSERT OR UPDATE ON "pos_manual_payment_references"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "validate_consumed_pos_manual_payment_reference"();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "pos_manual_payment_references" reference
    WHERE reference."status" = 'consumed'
      AND NOT EXISTS (
        SELECT 1
        FROM "pos_sale_payments" payment
        JOIN "sales" sale ON sale."id" = payment."sale_id"
        JOIN "pos_approvals" approval ON approval."id" = reference."approval_id"
        WHERE payment."id" = reference."consumed_sale_payment_id"
          AND payment."type" = 'payment'
          AND payment."status" IN ('manual_confirmed', 'partially_refunded', 'refunded')
          AND payment."method" = reference."method"
          AND payment."amount_cents" = reference."amount_cents"
          AND payment."provider" = reference."provider"
          AND payment."processing_session_id" = reference."session_id"
          AND ((reference."method" = 'pix' AND payment."end_to_end_id" = reference."reference" AND payment."transaction_id" IS NULL)
            OR (reference."method" <> 'pix' AND payment."transaction_id" = reference."reference" AND payment."end_to_end_id" IS NULL))
          AND payment."metadata"->>'confirmationMode' = 'manual_dual_control'
          AND payment."metadata"->>'manualReferenceId' = reference."id"
          AND payment."metadata"->>'manualApprovalId' = reference."approval_id"
          AND sale."branch_id" = reference."branch_id"
          AND sale."session_id" = reference."session_id"
          AND sale."operator_profile_id" = reference."requester_profile_id"
          AND approval."branch_id" = reference."branch_id"
          AND approval."action" = 'payment.manual_reference'
          AND approval."entity_type" = 'sale_draft'
          AND approval."entity_id" = reference."sale_draft_id"
          AND approval."status" = 'approved'
          AND approval."requester_id" = reference."requester_user_id"
          AND approval."approver_id" IS NOT NULL
          AND approval."approver_id" <> approval."requester_id"
          AND approval."consumed_at" IS NOT NULL
          AND approval."consumed_by" = reference."requester_user_id"
          AND approval."consumption_ref" = reference."sale_draft_id"
      )
  ) THEN RAISE EXCEPTION 'existing consumed manual payment references require reconciliation before migration'; END IF;
END;
$$;

CREATE UNIQUE INDEX "pos_kit_boms_id_version_key" ON "pos_kit_boms"("id", "version");
ALTER TABLE "pos_kit_sale_components" DROP CONSTRAINT "pos_kit_sale_components_bom_id_fkey";
ALTER TABLE "pos_kit_sale_components" ADD CONSTRAINT "pos_kit_sale_components_bom_id_version_fkey"
  FOREIGN KEY ("bom_id", "bom_version") REFERENCES "pos_kit_boms"("id", "version") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "pos_kit_component_return_movements" (
  "id" BIGSERIAL NOT NULL,
  "sale_component_id" TEXT NOT NULL,
  "return_item_id" INTEGER,
  "quantity_micros" BIGINT NOT NULL,
  "disposition" TEXT NOT NULL,
  "reference_type" TEXT NOT NULL,
  "reference_id" TEXT NOT NULL,
  "operation_key" TEXT NOT NULL,
  "actor" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_kit_component_return_movements_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_kit_component_return_movements_values_check" CHECK (
    "quantity_micros" BETWEEN 1 AND 9007199254740991
    AND "disposition" IN ('restock', 'quarantine', 'discard', 'legacy')
    AND "reference_type" IN ('sale_cancel', 'pos_return', 'legacy_migration')
    AND char_length("reference_id") BETWEEN 1 AND 160
    AND char_length("operation_key") BETWEEN 8 AND 240
    AND char_length("actor") BETWEEN 1 AND 160
  ),
  CONSTRAINT "pos_kit_component_return_movements_sale_component_id_fkey"
    FOREIGN KEY ("sale_component_id") REFERENCES "pos_kit_sale_components"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_kit_component_return_movements_return_item_id_fkey"
    FOREIGN KEY ("return_item_id") REFERENCES "pos_return_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "pos_kit_component_return_movements_operation_key_key"
  ON "pos_kit_component_return_movements"("operation_key");
CREATE INDEX "pos_kit_component_return_movements_component_created_idx"
  ON "pos_kit_component_return_movements"("sale_component_id", "created_at");
CREATE INDEX "pos_kit_component_return_movements_reference_idx"
  ON "pos_kit_component_return_movements"("reference_type", "reference_id");

INSERT INTO "pos_kit_component_return_movements" (
  "sale_component_id", "quantity_micros", "disposition", "reference_type", "reference_id", "operation_key", "actor"
)
SELECT "id", "returned_micros", 'legacy', 'legacy_migration', "id", 'migration:20260829240000:' || "id", 'system:migration'
FROM "pos_kit_sale_components"
WHERE "returned_micros" > 0;

CREATE FUNCTION "reject_pos_kit_return_movement_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pos kit component return movement is immutable' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "pos_kit_component_return_movements_immutable_guard"
BEFORE UPDATE OR DELETE ON "pos_kit_component_return_movements"
FOR EACH ROW EXECUTE FUNCTION "reject_pos_kit_return_movement_mutation"();

CREATE FUNCTION "assert_pos_kit_component_return_balance"(component_id TEXT) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE stored_balance BIGINT;
DECLARE ledger_balance NUMERIC;
BEGIN
  SELECT "returned_micros" INTO stored_balance FROM "pos_kit_sale_components" WHERE "id" = component_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'pos kit sale component is missing for return ledger' USING ERRCODE = '23503'; END IF;
  SELECT COALESCE(sum("quantity_micros"), 0) INTO ledger_balance
  FROM "pos_kit_component_return_movements" WHERE "sale_component_id" = component_id;
  IF stored_balance::NUMERIC <> ledger_balance THEN
    RAISE EXCEPTION 'pos kit returned balance does not match immutable movement ledger' USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE FUNCTION "validate_pos_kit_component_return_balance"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'pos_kit_sale_components' THEN
    PERFORM "assert_pos_kit_component_return_balance"(NEW."id");
  ELSE
    PERFORM "assert_pos_kit_component_return_balance"(NEW."sale_component_id");
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "pos_kit_sale_components_return_balance_guard"
AFTER INSERT OR UPDATE ON "pos_kit_sale_components"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "validate_pos_kit_component_return_balance"();

CREATE CONSTRAINT TRIGGER "pos_kit_component_return_movements_balance_guard"
AFTER INSERT ON "pos_kit_component_return_movements"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "validate_pos_kit_component_return_balance"();
