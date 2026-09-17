CREATE TABLE "pos_order_claims" (
  "id" TEXT NOT NULL,
  "sales_order_id" INTEGER NOT NULL,
  "branch_id" INTEGER NOT NULL,
  "register_id" INTEGER NOT NULL,
  "session_id" INTEGER NOT NULL,
  "operator_profile_id" INTEGER NOT NULL,
  "terminal_id" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'active',
  "version" INTEGER NOT NULL DEFAULT 0,
  "lease_expires_at" TIMESTAMP(3) NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "converted_sale_id" INTEGER,
  "claimed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "renewed_at" TIMESTAMP(3),
  "released_at" TIMESTAMP(3),
  "converted_at" TIMESTAMP(3),
  "lifecycle_txid" NUMERIC(20,0) NOT NULL DEFAULT txid_current()::numeric,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "pos_order_claims_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_order_claims_state_check" CHECK ("state" IN ('active', 'released', 'expired', 'converted')),
  CONSTRAINT "pos_order_claims_version_check" CHECK ("version" >= 0),
  CONSTRAINT "pos_order_claims_idempotency_key_check" CHECK (char_length("idempotency_key") BETWEEN 8 AND 120),
  CONSTRAINT "pos_order_claims_request_hash_check" CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "pos_order_claims_lease_check" CHECK ("lease_expires_at" > "claimed_at" AND "lease_expires_at" <= COALESCE("renewed_at", "claimed_at") + INTERVAL '5 minutes'),
  CONSTRAINT "pos_order_claims_state_timestamps_check" CHECK (
    ("state" = 'active' AND "released_at" IS NULL AND "converted_at" IS NULL AND "converted_sale_id" IS NULL)
    OR ("state" IN ('released', 'expired') AND "released_at" IS NOT NULL AND "converted_at" IS NULL AND "converted_sale_id" IS NULL)
    OR ("state" = 'converted' AND "released_at" IS NULL AND "converted_at" IS NOT NULL AND "converted_sale_id" IS NOT NULL)
  )
);

ALTER TABLE "pos_manual_payment_references"
  ADD COLUMN "installments" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "revoked_at" TIMESTAMP(3),
  ADD COLUMN "revoked_by" TEXT,
  ADD COLUMN "revoke_reason" TEXT,
  ADD COLUMN "revoke_idempotency_key" TEXT,
  ADD COLUMN "revoke_request_hash" TEXT,
  ADD CONSTRAINT "pos_manual_payment_references_revoke_state_check" CHECK (
    ("status" = 'revoked' AND "revoked_at" IS NOT NULL AND "revoked_by" IS NOT NULL AND "revoke_reason" IS NOT NULL AND "revoke_idempotency_key" IS NOT NULL AND "revoke_request_hash" IS NOT NULL)
    OR ("status" <> 'revoked' AND "revoked_at" IS NULL AND "revoked_by" IS NULL AND "revoke_reason" IS NULL AND "revoke_idempotency_key" IS NULL AND "revoke_request_hash" IS NULL)
  );

ALTER TABLE "sales" ADD COLUMN "source_creation_txid" NUMERIC(20,0);

ALTER TABLE "pos_manual_payment_references"
  ADD CONSTRAINT "pos_manual_payment_references_installments_check" CHECK (
    "installments" BETWEEN 1 AND 24 AND ("method" = 'credit' OR "installments" = 1)
  );

CREATE UNIQUE INDEX "pos_manual_payment_references_revoke_idempotency_key_key"
  ON "pos_manual_payment_references"("revoke_idempotency_key");

CREATE TABLE "pos_order_claim_operations" (
  "id" BIGSERIAL NOT NULL,
  "claim_id" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "expected_version" INTEGER NOT NULL,
  "resulting_version" INTEGER NOT NULL,
  "resulting_state" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "lease_expires_at" TIMESTAMP(3) NOT NULL,
  "write_txid" NUMERIC(20,0) NOT NULL DEFAULT txid_current()::numeric,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "pos_order_claim_operations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_order_claim_operations_action_check" CHECK ("action" IN ('claim', 'renew', 'release', 'expire', 'convert')),
  CONSTRAINT "pos_order_claim_operations_state_check" CHECK ("resulting_state" IN ('active', 'released', 'expired', 'converted')),
  CONSTRAINT "pos_order_claim_operations_version_check" CHECK (
    ("action" = 'claim' AND "expected_version" = 0 AND "resulting_version" = 0 AND "resulting_state" = 'active')
    OR ("action" = 'renew' AND "resulting_version" = "expected_version" + 1 AND "resulting_state" = 'active')
    OR ("action" = 'release' AND "resulting_version" = "expected_version" + 1 AND "resulting_state" = 'released')
    OR ("action" = 'expire' AND "resulting_version" = "expected_version" + 1 AND "resulting_state" = 'expired')
    OR ("action" = 'convert' AND "resulting_version" = "expected_version" + 1 AND "resulting_state" = 'converted')
  ),
  CONSTRAINT "pos_order_claim_operations_idempotency_key_check" CHECK (char_length("idempotency_key") BETWEEN 8 AND 160),
  CONSTRAINT "pos_order_claim_operations_request_hash_check" CHECK ("request_hash" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "pos_order_claims_idempotency_key_key" ON "pos_order_claims"("idempotency_key");
CREATE UNIQUE INDEX "pos_order_claims_converted_sale_id_key" ON "pos_order_claims"("converted_sale_id");
CREATE UNIQUE INDEX "pos_order_claims_one_active_order_key" ON "pos_order_claims"("sales_order_id") WHERE "state" = 'active';
CREATE INDEX "pos_order_claims_sales_order_id_state_lease_expires_at_idx" ON "pos_order_claims"("sales_order_id", "state", "lease_expires_at");
CREATE INDEX "pos_order_claims_session_id_operator_profile_id_state_idx" ON "pos_order_claims"("session_id", "operator_profile_id", "state");
CREATE INDEX "pos_order_claims_terminal_id_state_lease_expires_at_idx" ON "pos_order_claims"("terminal_id", "state", "lease_expires_at");
CREATE UNIQUE INDEX "pos_order_claim_operations_idempotency_key_key" ON "pos_order_claim_operations"("idempotency_key");
CREATE UNIQUE INDEX "pos_order_claim_operations_claim_id_resulting_version_key" ON "pos_order_claim_operations"("claim_id", "resulting_version");
CREATE INDEX "pos_order_claim_operations_claim_id_created_at_idx" ON "pos_order_claim_operations"("claim_id", "created_at");

ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_id_branch_id_key" UNIQUE ("id", "branch_id");
ALTER TABLE "pos_order_claims" ADD CONSTRAINT "pos_order_claims_sales_order_id_branch_id_fkey" FOREIGN KEY ("sales_order_id", "branch_id") REFERENCES "sales_orders"("id", "branch_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "pos_order_claims" ADD CONSTRAINT "pos_order_claims_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "pos_order_claims" ADD CONSTRAINT "pos_order_claims_register_id_branch_id_fkey" FOREIGN KEY ("register_id", "branch_id") REFERENCES "pos_registers"("id", "branch_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "pos_order_claims" ADD CONSTRAINT "pos_order_claims_terminal_id_register_id_fkey" FOREIGN KEY ("terminal_id", "register_id") REFERENCES "pos_terminals"("id", "register_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "pos_order_claims" ADD CONSTRAINT "pos_order_claims_session_id_register_id_fkey" FOREIGN KEY ("session_id", "register_id") REFERENCES "cash_register_sessions"("id", "register_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "pos_order_claims" ADD CONSTRAINT "pos_order_claims_operator_profile_id_fkey" FOREIGN KEY ("operator_profile_id") REFERENCES "tenant_user_profiles"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "pos_order_claims" ADD CONSTRAINT "pos_order_claims_converted_sale_id_fkey" FOREIGN KEY ("converted_sale_id") REFERENCES "sales"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "pos_order_claim_operations" ADD CONSTRAINT "pos_order_claim_operations_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "pos_order_claims"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "prevent_pos_order_claim_operation_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'pos_order_claim_operations is append-only' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "pos_order_claim_operations_no_update"
BEFORE UPDATE ON "pos_order_claim_operations"
FOR EACH ROW EXECUTE FUNCTION "prevent_pos_order_claim_operation_mutation"();

CREATE TRIGGER "pos_order_claim_operations_no_delete"
BEFORE DELETE ON "pos_order_claim_operations"
FOR EACH ROW EXECUTE FUNCTION "prevent_pos_order_claim_operation_mutation"();

CREATE FUNCTION "stamp_pos_order_claim_operation_txid"() RETURNS trigger AS $$
BEGIN
  NEW."write_txid" := txid_current()::numeric;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "pos_order_claim_operations_txid_guard"
BEFORE INSERT ON "pos_order_claim_operations"
FOR EACH ROW EXECUTE FUNCTION "stamp_pos_order_claim_operation_txid"();

CREATE FUNCTION "stamp_sales_order_source_txid"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."source_creation_txid" := CASE WHEN NEW."source_type" = 'sales_order' THEN txid_current()::numeric ELSE NULL END;
  ELSIF OLD."source_type" = 'sales_order' OR NEW."source_type" = 'sales_order' THEN
    IF ROW(NEW."source_type", NEW."source_id", NEW."source_creation_txid")
      IS DISTINCT FROM ROW(OLD."source_type", OLD."source_id", OLD."source_creation_txid")
    THEN
      RAISE EXCEPTION 'sales_order source identity and transaction marker are immutable' USING ERRCODE = '55000';
    END IF;
  ELSE
    NEW."source_creation_txid" := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "sales_order_source_txid_guard"
BEFORE INSERT OR UPDATE OF "source_type", "source_id", "source_creation_txid" ON "sales"
FOR EACH ROW EXECUTE FUNCTION "stamp_sales_order_source_txid"();

CREATE FUNCTION "enforce_pos_order_claim_identity"() RETURNS trigger AS $$
DECLARE
  converted_sale_matches BOOLEAN;
BEGIN
  NEW."lifecycle_txid" := txid_current()::numeric;
  IF TG_OP = 'UPDATE' AND (
    NEW."sales_order_id", NEW."branch_id", NEW."register_id", NEW."session_id", NEW."operator_profile_id", NEW."terminal_id",
    NEW."idempotency_key", NEW."request_hash", NEW."claimed_at"
  ) IS DISTINCT FROM (
    OLD."sales_order_id", OLD."branch_id", OLD."register_id", OLD."session_id", OLD."operator_profile_id", OLD."terminal_id",
    OLD."idempotency_key", OLD."request_hash", OLD."claimed_at"
  ) THEN
    RAISE EXCEPTION 'pos_order_claim identity is immutable' USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'UPDATE' AND (
    OLD."state" <> 'active'
    OR NEW."version" <> OLD."version" + 1
    OR NEW."state" NOT IN ('active', 'released', 'expired', 'converted')
    OR (NEW."state" = 'active' AND (NEW."renewed_at" IS NULL OR NEW."lease_expires_at" <= OLD."lease_expires_at"))
  ) THEN
    RAISE EXCEPTION 'invalid pos_order_claim lifecycle transition' USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' THEN
    PERFORM 1 FROM "cash_register_sessions" s
    WHERE s."id" = NEW."session_id"
      AND s."register_id" = NEW."register_id"
      AND s."operator_profile_id" = NEW."operator_profile_id"
      AND s."status" = 'open'
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'pos_order_claim session/operator context mismatch or session is not open' USING ERRCODE = '23503';
    END IF;
    PERFORM 1 FROM "sales_orders" o
    WHERE o."id" = NEW."sales_order_id" AND o."branch_id" = NEW."branch_id"
      AND o."kind" = 'order' AND o."status" = 'approved' AND o."deleted_at" IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'pos_order_claim order/branch context mismatch' USING ERRCODE = '23503';
    END IF;
    IF EXISTS (SELECT 1 FROM "sales" v WHERE v."source_type" = 'sales_order' AND v."source_id" = NEW."sales_order_id"::text)
      OR EXISTS (SELECT 1 FROM "shipments" s WHERE s."sales_order_id" = NEW."sales_order_id")
      OR EXISTS (SELECT 1 FROM "order_tracking" t WHERE t."sales_order_id" = NEW."sales_order_id")
      OR EXISTS (SELECT 1 FROM "order_shipping_labels" l WHERE l."sales_order_id" = NEW."sales_order_id" AND l."status" <> 'cancelled')
    THEN
      RAISE EXCEPTION 'pos_order_claim order already has logistics artifacts' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."state" = 'converted' THEN
    SELECT EXISTS (
      SELECT 1 FROM "sales" s
      WHERE s."id" = NEW."converted_sale_id"
        AND s."branch_id" = NEW."branch_id"
        AND s."session_id" = NEW."session_id"
        AND s."operator_profile_id" = NEW."operator_profile_id"
        AND s."source_type" = 'sales_order'
        AND s."source_id" = NEW."sales_order_id"::text
    ) INTO converted_sale_matches;
    IF NOT converted_sale_matches THEN
      RAISE EXCEPTION 'converted sale does not match pos_order_claim context' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "pos_order_claim_identity_guard"
BEFORE INSERT OR UPDATE ON "pos_order_claims"
FOR EACH ROW EXECUTE FUNCTION "enforce_pos_order_claim_identity"();

CREATE FUNCTION "prevent_session_handoff_with_active_pos_order_claim"() RETURNS trigger AS $$
BEGIN
  IF NEW."operator_profile_id" IS DISTINCT FROM OLD."operator_profile_id" AND EXISTS (
    SELECT 1 FROM "pos_order_claims" c
    WHERE c."session_id" = OLD."id"
      AND c."operator_profile_id" = OLD."operator_profile_id"
      AND c."state" = 'active'
  ) THEN
    RAISE EXCEPTION 'active pos_order_claim blocks session handoff' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "cash_register_sessions_active_order_claim_handoff_guard"
BEFORE UPDATE OF "operator_profile_id" ON "cash_register_sessions"
FOR EACH ROW EXECUTE FUNCTION "prevent_session_handoff_with_active_pos_order_claim"();

CREATE FUNCTION "prevent_shipment_for_pos_claim_or_conversion"() RETURNS trigger AS $$
DECLARE
  order_status TEXT;
BEGIN
  SELECT "status" INTO order_status FROM "sales_orders" WHERE "id" = NEW."sales_order_id" FOR UPDATE;
  IF order_status IS NULL OR order_status <> 'approved'
    OR EXISTS (SELECT 1 FROM "pos_order_claims" c WHERE c."sales_order_id" = NEW."sales_order_id" AND c."state" = 'active')
    OR EXISTS (SELECT 1 FROM "sales" s WHERE s."source_type" = 'sales_order' AND s."source_id" = NEW."sales_order_id"::text)
  THEN
    RAISE EXCEPTION 'sales order is claimed or converted by POS and cannot enter shipment' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "shipments_pos_order_conversion_guard"
BEFORE INSERT OR UPDATE OF "sales_order_id" ON "shipments"
FOR EACH ROW EXECUTE FUNCTION "prevent_shipment_for_pos_claim_or_conversion"();

CREATE FUNCTION "prevent_commercial_order_transition_with_active_pos_claim"() RETURNS trigger AS $$
DECLARE
  current_tx_conversion BOOLEAN;
  exact_pos_completion BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM "pos_order_claims" c
    JOIN "sales" s ON s."id" = c."converted_sale_id"
    JOIN "pos_order_claim_operations" o ON o."claim_id" = c."id" AND o."resulting_version" = c."version" AND o."action" = 'convert'
    WHERE c."sales_order_id" = NEW."id" AND c."state" = 'converted'
      AND s."source_type" = 'sales_order' AND s."source_id" = NEW."id"::text
      AND c."lifecycle_txid" = txid_current()::numeric
      AND s."source_creation_txid" = txid_current()::numeric
      AND o."write_txid" = txid_current()::numeric
  ) INTO current_tx_conversion;
  exact_pos_completion := current_tx_conversion
    AND OLD."status" = 'approved' AND NEW."status" = 'completed' AND NEW."completed_at" IS NOT NULL
    AND (to_jsonb(NEW) - ARRAY['status', 'completed_at', 'updated_at']) = (to_jsonb(OLD) - ARRAY['status', 'completed_at', 'updated_at']);
  IF (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at')
    AND (
      EXISTS (SELECT 1 FROM "pos_order_claims" c WHERE c."sales_order_id" = NEW."id" AND c."state" = 'active')
      OR EXISTS (SELECT 1 FROM "sales" s WHERE s."source_type" = 'sales_order' AND s."source_id" = NEW."id"::text)
    )
    AND NOT exact_pos_completion
  THEN
    RAISE EXCEPTION 'POS claim or converted sale blocks commercial order mutation' USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "sales_orders_active_pos_claim_transition_guard"
AFTER UPDATE ON "sales_orders"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "prevent_commercial_order_transition_with_active_pos_claim"();

CREATE FUNCTION "prevent_pos_claim_order_child_mutation"() RETURNS trigger AS $$
DECLARE
  old_order_id INTEGER;
  new_order_id INTEGER;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN old_order_id := OLD."sales_order_id"; END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN new_order_id := NEW."sales_order_id"; END IF;
  IF EXISTS (
      SELECT 1 FROM "pos_order_claims" c
      WHERE c."state" = 'active' AND (c."sales_order_id" = old_order_id OR c."sales_order_id" = new_order_id)
    ) OR EXISTS (
      SELECT 1 FROM "sales" s
      WHERE s."source_type" = 'sales_order' AND (s."source_id" = old_order_id::text OR s."source_id" = new_order_id::text)
    )
  THEN
    RAISE EXCEPTION 'POS claim or converted sale blocks order child mutation on %', TG_TABLE_NAME USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "sales_order_items_active_pos_claim_guard"
AFTER INSERT OR UPDATE OR DELETE ON "sales_order_items"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "prevent_pos_claim_order_child_mutation"();
CREATE CONSTRAINT TRIGGER "order_payments_active_pos_claim_guard"
AFTER INSERT OR UPDATE OR DELETE ON "order_payments"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "prevent_pos_claim_order_child_mutation"();
CREATE CONSTRAINT TRIGGER "order_tracking_active_pos_claim_guard"
AFTER INSERT OR UPDATE OR DELETE ON "order_tracking"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "prevent_pos_claim_order_child_mutation"();
CREATE CONSTRAINT TRIGGER "order_shipping_labels_active_pos_claim_guard"
AFTER INSERT OR UPDATE OR DELETE ON "order_shipping_labels"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "prevent_pos_claim_order_child_mutation"();

CREATE FUNCTION "prevent_pos_claim_reservation_mutation"() RETURNS trigger AS $$
DECLARE
  old_order_id INTEGER;
  new_order_id INTEGER;
  exact_current_tx_consumption BOOLEAN := FALSE;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN old_order_id := OLD."sales_order_id"; END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN new_order_id := NEW."sales_order_id"; END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" = 'active' AND NEW."status" = 'consumed' AND NEW."consumed_at" IS NOT NULL
    AND (to_jsonb(NEW) - ARRAY['status', 'consumed_at']) = (to_jsonb(OLD) - ARRAY['status', 'consumed_at'])
  THEN
    SELECT EXISTS (
      SELECT 1 FROM "pos_order_claims" c
      JOIN "sales" s ON s."id" = c."converted_sale_id"
      JOIN "pos_order_claim_operations" o ON o."claim_id" = c."id" AND o."resulting_version" = c."version" AND o."action" = 'convert'
      WHERE c."sales_order_id" = new_order_id AND c."state" = 'converted'
        AND s."source_type" = 'sales_order' AND s."source_id" = new_order_id::text
        AND c."lifecycle_txid" = txid_current()::numeric
        AND s."source_creation_txid" = txid_current()::numeric
        AND o."write_txid" = txid_current()::numeric
    ) INTO exact_current_tx_consumption;
  END IF;
  IF (EXISTS (
      SELECT 1 FROM "pos_order_claims" c
      WHERE c."state" = 'active' AND (c."sales_order_id" = old_order_id OR c."sales_order_id" = new_order_id)
    ) OR EXISTS (
      SELECT 1 FROM "sales" s
      WHERE s."source_type" = 'sales_order' AND (s."source_id" = old_order_id::text OR s."source_id" = new_order_id::text)
    ))
    AND NOT exact_current_tx_consumption
  THEN
    RAISE EXCEPTION 'POS claim or converted sale blocks stock reservation mutation' USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "stock_reservations_active_pos_claim_guard"
AFTER INSERT OR UPDATE OR DELETE ON "stock_reservations"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "prevent_pos_claim_reservation_mutation"();

CREATE FUNCTION "validate_pos_order_claim_operation_ledger"() RETURNS trigger AS $$
DECLARE
  target_claim_id TEXT;
  claim_state TEXT;
  claim_version INTEGER;
  claim_txid NUMERIC(20,0);
  claim_lease_expires_at TIMESTAMP(3);
  expected_action TEXT;
  expected_previous_version INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'pos_order_claims' THEN
    target_claim_id := NEW."id";
  ELSE
    target_claim_id := NEW."claim_id";
  END IF;
  SELECT "state", "version", "lifecycle_txid", "lease_expires_at" INTO claim_state, claim_version, claim_txid, claim_lease_expires_at FROM "pos_order_claims" WHERE "id" = target_claim_id;
  IF claim_state IS NULL THEN RETURN NULL; END IF;
  IF claim_txid <> txid_current()::numeric THEN
    RAISE EXCEPTION 'pos_order_claim lifecycle and operation ledger must be written in the same database transaction' USING ERRCODE = '23514';
  END IF;
  expected_action := CASE
    WHEN claim_state = 'active' AND claim_version = 0 THEN 'claim'
    WHEN claim_state = 'active' THEN 'renew'
    WHEN claim_state = 'released' THEN 'release'
    WHEN claim_state = 'expired' THEN 'expire'
    WHEN claim_state = 'converted' THEN 'convert'
  END;
  expected_previous_version := CASE WHEN expected_action = 'claim' THEN 0 ELSE claim_version - 1 END;
  IF TG_TABLE_NAME = 'pos_order_claim_operations' THEN
    IF NEW."resulting_version" <> claim_version
      OR NEW."resulting_state" <> claim_state
      OR NEW."action" <> expected_action
      OR NEW."expected_version" <> expected_previous_version
      OR NEW."lease_expires_at" <> claim_lease_expires_at
    THEN
      RAISE EXCEPTION 'pos_order_claim operation does not exactly match the lifecycle transition in this database transaction' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "pos_order_claim_operations" o
    WHERE o."claim_id" = target_claim_id
      AND o."resulting_version" = claim_version
      AND o."resulting_state" = claim_state
      AND o."action" = expected_action
      AND o."write_txid" = txid_current()::numeric
  ) THEN
    RAISE EXCEPTION 'pos_order_claim lifecycle is missing its append-only operation ledger' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "pos_order_claims_operation_ledger_guard"
AFTER INSERT OR UPDATE ON "pos_order_claims"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "validate_pos_order_claim_operation_ledger"();
CREATE CONSTRAINT TRIGGER "pos_order_claim_operations_claim_state_guard"
AFTER INSERT ON "pos_order_claim_operations"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "validate_pos_order_claim_operation_ledger"();

CREATE UNIQUE INDEX "pos_payment_intents_one_unresolved_draft_slot_key"
ON "pos_payment_intents"("sale_draft_id", "payment_index")
WHERE "consumed_at" IS NULL AND "status" IN ('created', 'processing', 'authorized', 'captured', 'partially_refunded', 'unknown', 'manual_review');

CREATE UNIQUE INDEX "pos_manual_payment_references_one_pending_draft_slot_key"
ON "pos_manual_payment_references"("sale_draft_id", "payment_index")
WHERE "consumed_sale_payment_id" IS NULL AND "status" = 'pending';

CREATE FUNCTION "enforce_pos_payment_draft_slot_exclusivity"() RETURNS trigger AS $$
DECLARE
  draft_id TEXT;
  slot_index INTEGER;
BEGIN
  draft_id := NEW."sale_draft_id";
  slot_index := NEW."payment_index";
  PERFORM pg_advisory_xact_lock(hashtextextended('pos-payment-slot:' || draft_id || ':' || slot_index::text, 0));

  IF TG_TABLE_NAME = 'pos_payment_intents' THEN
    IF EXISTS (
      SELECT 1 FROM "pos_payment_intents" i
      WHERE i."sale_draft_id" = draft_id AND i."payment_index" = slot_index
        AND i."consumed_at" IS NULL AND i."status" IN ('created', 'processing', 'authorized', 'captured', 'partially_refunded', 'unknown', 'manual_review')
    ) OR EXISTS (
      SELECT 1 FROM "pos_manual_payment_references" m
      WHERE m."sale_draft_id" = draft_id AND m."payment_index" = slot_index
        AND m."consumed_sale_payment_id" IS NULL AND m."status" = 'pending'
    ) THEN
      RAISE EXCEPTION 'pos payment draft slot already has unresolved evidence' USING ERRCODE = '23505';
    END IF;
  ELSE
    IF EXISTS (
      SELECT 1 FROM "pos_manual_payment_references" m
      WHERE m."sale_draft_id" = draft_id AND m."payment_index" = slot_index
        AND m."consumed_sale_payment_id" IS NULL AND m."status" = 'pending'
    ) OR EXISTS (
      SELECT 1 FROM "pos_payment_intents" i
      WHERE i."sale_draft_id" = draft_id AND i."payment_index" = slot_index
        AND i."consumed_at" IS NULL AND i."status" IN ('created', 'processing', 'authorized', 'captured', 'partially_refunded', 'unknown', 'manual_review')
    ) THEN
      RAISE EXCEPTION 'pos payment draft slot already has unresolved evidence' USING ERRCODE = '23505';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "pos_payment_intents_draft_slot_guard"
BEFORE INSERT ON "pos_payment_intents"
FOR EACH ROW EXECUTE FUNCTION "enforce_pos_payment_draft_slot_exclusivity"();

CREATE TRIGGER "pos_manual_payment_references_draft_slot_guard"
BEFORE INSERT ON "pos_manual_payment_references"
FOR EACH ROW EXECUTE FUNCTION "enforce_pos_payment_draft_slot_exclusivity"();

CREATE OR REPLACE FUNCTION "reject_pos_manual_payment_reference_rewrite"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pos manual payment reference is append-only' USING ERRCODE = '55000';
  END IF;
  IF ROW(NEW."branch_id", NEW."register_id", NEW."session_id", NEW."requester_profile_id", NEW."requester_user_id", NEW."sale_draft_id", NEW."quote_hash", NEW."payment_index", NEW."method", NEW."amount_cents", NEW."installments", NEW."provider", NEW."reference", NEW."reference_hash", NEW."reference_last_four", NEW."occurred_at", NEW."approval_id", NEW."idempotency_key", NEW."request_hash", NEW."created_at")
    IS DISTINCT FROM ROW(OLD."branch_id", OLD."register_id", OLD."session_id", OLD."requester_profile_id", OLD."requester_user_id", OLD."sale_draft_id", OLD."quote_hash", OLD."payment_index", OLD."method", OLD."amount_cents", OLD."installments", OLD."provider", OLD."reference", OLD."reference_hash", OLD."reference_last_four", OLD."occurred_at", OLD."approval_id", OLD."idempotency_key", OLD."request_hash", OLD."created_at") THEN
    RAISE EXCEPTION 'pos manual payment reference identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" <> 'pending' THEN
    IF ROW(NEW."status", NEW."consumed_sale_payment_id", NEW."consumed_at", NEW."revoked_at", NEW."revoked_by", NEW."revoke_reason", NEW."revoke_idempotency_key", NEW."revoke_request_hash")
      IS DISTINCT FROM ROW(OLD."status", OLD."consumed_sale_payment_id", OLD."consumed_at", OLD."revoked_at", OLD."revoked_by", OLD."revoke_reason", OLD."revoke_idempotency_key", OLD."revoke_request_hash") THEN
      RAISE EXCEPTION 'pos manual payment reference terminal state is immutable' USING ERRCODE = '55000';
    END IF;
  ELSIF NEW."status" = 'consumed' THEN
    IF NEW."consumed_sale_payment_id" IS NULL OR NEW."consumed_at" IS NULL OR NEW."revoked_at" IS NOT NULL THEN
      RAISE EXCEPTION 'invalid consumed manual payment reference' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."status" = 'revoked' THEN
    IF NEW."consumed_sale_payment_id" IS NOT NULL OR NEW."consumed_at" IS NOT NULL OR NEW."revoked_at" IS NULL OR NEW."revoked_by" IS NULL OR NEW."revoke_reason" IS NULL OR NEW."revoke_idempotency_key" IS NULL OR NEW."revoke_request_hash" IS NULL THEN
      RAISE EXCEPTION 'invalid revoked manual payment reference' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM "pos_approvals" a
      WHERE a."id" = NEW."approval_id" AND a."status" = 'rejected'
        AND a."approver_id" IS NOT NULL AND a."approver_id" <> NEW."requester_user_id"
    ) THEN
      RAISE EXCEPTION 'manual payment reference revocation requires independent rejected approval' USING ERRCODE = '23514';
    END IF;
  ELSIF ROW(NEW."status", NEW."consumed_sale_payment_id", NEW."consumed_at", NEW."revoked_at", NEW."revoked_by", NEW."revoke_reason", NEW."revoke_idempotency_key", NEW."revoke_request_hash")
    IS DISTINCT FROM ROW(OLD."status", OLD."consumed_sale_payment_id", OLD."consumed_at", OLD."revoked_at", OLD."revoked_by", OLD."revoke_reason", OLD."revoke_idempotency_key", OLD."revoke_request_hash") THEN
    RAISE EXCEPTION 'invalid manual payment reference transition' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
