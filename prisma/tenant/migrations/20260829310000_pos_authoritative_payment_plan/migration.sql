CREATE TABLE "pos_payment_plans" (
  "id" TEXT NOT NULL,
  "branch_id" INTEGER NOT NULL,
  "register_id" INTEGER NOT NULL,
  "session_id" INTEGER NOT NULL,
  "operator_profile_id" INTEGER NOT NULL,
  "terminal_id" TEXT NOT NULL,
  "sale_draft_id" TEXT NOT NULL,
  "draft_revision" INTEGER NOT NULL,
  "draft_request_hash" TEXT NOT NULL,
  "draft_status" TEXT NOT NULL,
  "order_claim_id" TEXT,
  "quote_hash" TEXT NOT NULL,
  "promotion_id" TEXT,
  "coupon_id" TEXT,
  "promotion_discount_cents" INTEGER NOT NULL DEFAULT 0,
  "evaluated_at" TIMESTAMP(3) NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'BRL',
  "total_cents" INTEGER NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'quoted',
  "version" INTEGER NOT NULL DEFAULT 0,
  "idempotency_key" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "consumed_sale_id" INTEGER,
  "activated_at" TIMESTAMP(3),
  "consumed_at" TIMESTAMP(3),
  "superseded_at" TIMESTAMP(3),
  "expired_at" TIMESTAMP(3),
  "lifecycle_txid" NUMERIC(20,0) NOT NULL DEFAULT txid_current()::numeric,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_payment_plans_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_payment_plans_state_check" CHECK ("state" IN ('quoted', 'active', 'consumed', 'superseded', 'expired')),
  CONSTRAINT "pos_payment_plans_values_check" CHECK (
    "draft_revision" >= 0 AND "draft_status" IN ('draft', 'held') AND "currency" = 'BRL'
    AND "total_cents" > 0 AND "version" >= 0 AND "expires_at" > "evaluated_at" AND "expires_at" <= "evaluated_at" + INTERVAL '5 minutes'
    AND "quote_hash" ~ '^[0-9a-f]{64}$' AND "draft_request_hash" ~ '^[0-9a-f]{64}$'
    AND "request_hash" ~ '^[0-9a-f]{64}$' AND length("idempotency_key") BETWEEN 16 AND 160
    AND ("order_claim_id" IS NULL OR "order_claim_id" = "sale_draft_id")
    AND "promotion_discount_cents" >= 0 AND ("promotion_id" IS NOT NULL OR "promotion_discount_cents" = 0 AND "coupon_id" IS NULL)
  ),
  CONSTRAINT "pos_payment_plans_lifecycle_shape_check" CHECK (
    ("state" = 'quoted' AND "activated_at" IS NULL AND "consumed_at" IS NULL AND "consumed_sale_id" IS NULL AND "superseded_at" IS NULL AND "expired_at" IS NULL)
    OR ("state" = 'active' AND "activated_at" IS NOT NULL AND "consumed_at" IS NULL AND "consumed_sale_id" IS NULL AND "superseded_at" IS NULL AND "expired_at" IS NULL)
    OR ("state" = 'consumed' AND "activated_at" IS NOT NULL AND "consumed_at" IS NOT NULL AND "consumed_sale_id" IS NOT NULL AND "superseded_at" IS NULL AND "expired_at" IS NULL)
    OR ("state" = 'superseded' AND "consumed_at" IS NULL AND "consumed_sale_id" IS NULL AND "superseded_at" IS NOT NULL AND "expired_at" IS NULL)
    OR ("state" = 'expired' AND "consumed_at" IS NULL AND "consumed_sale_id" IS NULL AND "superseded_at" IS NULL AND "expired_at" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "pos_payment_plans_idempotency_key_key" ON "pos_payment_plans"("idempotency_key");
CREATE UNIQUE INDEX "pos_payment_plans_consumed_sale_id_key" ON "pos_payment_plans"("consumed_sale_id");
CREATE UNIQUE INDEX "pos_payment_plans_one_open_draft_key" ON "pos_payment_plans"("sale_draft_id") WHERE "state" IN ('quoted', 'active');
CREATE INDEX "pos_payment_plans_sale_draft_state_created_idx" ON "pos_payment_plans"("sale_draft_id", "state", "created_at");
CREATE INDEX "pos_payment_plans_session_state_expires_idx" ON "pos_payment_plans"("session_id", "state", "expires_at");
CREATE INDEX "pos_payment_plans_branch_state_expires_idx" ON "pos_payment_plans"("branch_id", "state", "expires_at");

ALTER TABLE "pos_payment_plans"
  ADD CONSTRAINT "pos_payment_plans_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "pos_payment_plans_register_id_fkey" FOREIGN KEY ("register_id") REFERENCES "pos_registers"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "pos_payment_plans_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "cash_register_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "pos_payment_plans_operator_profile_id_fkey" FOREIGN KEY ("operator_profile_id") REFERENCES "tenant_user_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "pos_payment_plans_terminal_id_fkey" FOREIGN KEY ("terminal_id") REFERENCES "pos_terminals"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "pos_payment_plans_sale_draft_id_fkey" FOREIGN KEY ("sale_draft_id") REFERENCES "pos_held_sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "pos_payment_plans_order_claim_id_fkey" FOREIGN KEY ("order_claim_id") REFERENCES "pos_order_claims"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "pos_payment_plans_promotion_id_fkey" FOREIGN KEY ("promotion_id") REFERENCES "pos_promotions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "pos_payment_plans_coupon_id_fkey" FOREIGN KEY ("coupon_id") REFERENCES "pos_coupons"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "pos_payment_plans_consumed_sale_id_fkey" FOREIGN KEY ("consumed_sale_id") REFERENCES "sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "pos_payment_plans_session_register_fkey" FOREIGN KEY ("session_id", "register_id") REFERENCES "cash_register_sessions"("id", "register_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "pos_payment_plans_register_branch_fkey" FOREIGN KEY ("register_id", "branch_id") REFERENCES "pos_registers"("id", "branch_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "pos_payment_plans_terminal_register_fkey" FOREIGN KEY ("terminal_id", "register_id") REFERENCES "pos_terminals"("id", "register_id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "pos_payment_plan_slots" (
  "plan_id" TEXT NOT NULL,
  "payment_index" INTEGER NOT NULL,
  "method" TEXT NOT NULL,
  "amount_cents" INTEGER NOT NULL,
  "installments" INTEGER NOT NULL DEFAULT 1,
  "proof_kind" TEXT NOT NULL,
  "connector_id" TEXT,
  "credential_ref" TEXT,
  "provider" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_payment_plan_slots_pkey" PRIMARY KEY ("plan_id", "payment_index"),
  CONSTRAINT "pos_payment_plan_slots_values_check" CHECK (
    "payment_index" BETWEEN 0 AND 9 AND "amount_cents" > 0 AND "installments" BETWEEN 1 AND 24
    AND "method" IN ('cash', 'pix', 'credit', 'debit', 'voucher', 'store_credit')
    AND "proof_kind" IN ('cash', 'value', 'intent', 'manual')
    AND ("method" = 'credit' OR "installments" = 1)
    AND (
      ("proof_kind" = 'cash' AND "method" = 'cash' AND "connector_id" IS NULL AND "credential_ref" IS NULL AND "provider" IS NULL)
      OR ("proof_kind" = 'value' AND "method" = 'store_credit' AND "connector_id" IS NULL AND "credential_ref" IS NULL AND "provider" IS NULL)
      OR ("proof_kind" = 'intent' AND "method" IN ('pix', 'credit', 'debit', 'voucher') AND "connector_id" IS NOT NULL AND "credential_ref" IS NOT NULL AND "provider" IS NOT NULL)
      OR ("proof_kind" = 'manual' AND "method" IN ('pix', 'credit', 'debit', 'voucher') AND "connector_id" IS NULL AND "credential_ref" IS NULL AND "provider" IS NOT NULL)
    )
  )
);

CREATE INDEX "pos_payment_plan_slots_connector_id_idx" ON "pos_payment_plan_slots"("connector_id");
CREATE INDEX "pos_payment_plan_slots_credential_ref_idx" ON "pos_payment_plan_slots"("credential_ref");
CREATE UNIQUE INDEX "pos_payment_plan_slots_exact_financial_key" ON "pos_payment_plan_slots"("plan_id", "payment_index", "method", "amount_cents", "installments");
ALTER TABLE "pos_payment_plan_slots"
  ADD CONSTRAINT "pos_payment_plan_slots_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "pos_payment_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "pos_payment_plan_slots_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "pos_connectors"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "pos_payment_plan_slots_credential_ref_fkey" FOREIGN KEY ("credential_ref") REFERENCES "integration_credentials"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE "pos_payment_plan_quote_lines" (
  "plan_id" TEXT NOT NULL,
  "line_index" INTEGER NOT NULL,
  "held_sale_item_id" INTEGER NOT NULL,
  "product_id" INTEGER NOT NULL,
  "variation_id" INTEGER,
  "quantity" DOUBLE PRECISION NOT NULL,
  "unit_price_cents" INTEGER NOT NULL,
  "gross_cents" INTEGER NOT NULL,
  "base_discount_cents" INTEGER NOT NULL,
  "order_discount_cents" INTEGER NOT NULL,
  "promotion_discount_cents" INTEGER NOT NULL,
  "surcharge_cents" INTEGER NOT NULL,
  "total_cents" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_payment_plan_quote_lines_pkey" PRIMARY KEY ("plan_id", "line_index"),
  CONSTRAINT "pos_payment_plan_quote_lines_values_check" CHECK (
    "line_index" BETWEEN 0 AND 199 AND "quantity" > 0 AND "unit_price_cents" >= 0 AND "gross_cents" >= 0
    AND "base_discount_cents" >= 0 AND "order_discount_cents" >= 0 AND "promotion_discount_cents" >= 0
    AND "surcharge_cents" >= 0 AND "total_cents" >= 0
    AND "gross_cents" = round("quantity"::numeric * "unit_price_cents")::integer
    AND "total_cents" = "gross_cents" - "base_discount_cents" - "order_discount_cents" - "promotion_discount_cents" + "surcharge_cents"
  )
);
CREATE UNIQUE INDEX "pos_payment_plan_quote_lines_plan_item_key" ON "pos_payment_plan_quote_lines"("plan_id", "held_sale_item_id");
CREATE INDEX "pos_payment_plan_quote_lines_held_item_idx" ON "pos_payment_plan_quote_lines"("held_sale_item_id");
ALTER TABLE "pos_payment_plan_quote_lines"
  ADD CONSTRAINT "pos_payment_plan_quote_lines_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "pos_payment_plans"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "pos_payment_plan_quote_lines_held_sale_item_id_fkey" FOREIGN KEY ("held_sale_item_id") REFERENCES "pos_held_sale_items"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE "pos_payment_plan_operations" (
  "id" BIGSERIAL NOT NULL,
  "plan_id" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "expected_version" INTEGER NOT NULL,
  "resulting_version" INTEGER NOT NULL,
  "resulting_state" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "actor_user_id" TEXT,
  "sale_id" INTEGER,
  "write_txid" NUMERIC(20,0) NOT NULL DEFAULT txid_current()::numeric,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_payment_plan_operations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_payment_plan_operations_action_check" CHECK ("action" IN ('quote', 'activate', 'supersede', 'expire', 'consume')),
  CONSTRAINT "pos_payment_plan_operations_action_result_check" CHECK (
    ("action" = 'quote' AND "expected_version" = -1 AND "resulting_version" = 0 AND "resulting_state" = 'quoted')
    OR ("action" = 'activate' AND "expected_version" >= 0 AND "resulting_version" = "expected_version" + 1 AND "resulting_state" = 'active')
    OR ("action" = 'supersede' AND "expected_version" >= 0 AND "resulting_version" = "expected_version" + 1 AND "resulting_state" = 'superseded')
    OR ("action" = 'expire' AND "expected_version" >= 0 AND "resulting_version" = "expected_version" + 1 AND "resulting_state" = 'expired')
    OR ("action" = 'consume' AND "expected_version" >= 0 AND "resulting_version" = "expected_version" + 1 AND "resulting_state" = 'consumed')
  ),
  CONSTRAINT "pos_payment_plan_operations_sale_binding_check" CHECK (("action" = 'consume') = ("sale_id" IS NOT NULL)),
  CONSTRAINT "pos_payment_plan_operations_request_hash_check" CHECK (
    "request_hash" ~ '^[0-9a-f]{64}$' AND length("idempotency_key") BETWEEN 16 AND 160
  )
);

CREATE UNIQUE INDEX "pos_payment_plan_operations_idempotency_key_key" ON "pos_payment_plan_operations"("idempotency_key");
CREATE UNIQUE INDEX "pos_payment_plan_operations_plan_version_key" ON "pos_payment_plan_operations"("plan_id", "resulting_version");
CREATE INDEX "pos_payment_plan_operations_plan_created_idx" ON "pos_payment_plan_operations"("plan_id", "created_at");
ALTER TABLE "pos_payment_plan_operations" ADD CONSTRAINT "pos_payment_plan_operations_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "pos_payment_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pos_payment_plan_operations" ADD CONSTRAINT "pos_payment_plan_operations_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "pos_payment_intents" ADD COLUMN "payment_plan_id" TEXT, ADD COLUMN "lifecycle_txid" NUMERIC(20,0) NOT NULL DEFAULT txid_current()::numeric;
ALTER TABLE "pos_payment_state_events" ADD COLUMN "write_txid" NUMERIC(20,0) NOT NULL DEFAULT txid_current()::numeric;
ALTER TABLE "pos_payment_integrity_incidents"
  DROP CONSTRAINT "pos_payment_integrity_incidents_kind_check",
  ADD CONSTRAINT "pos_payment_integrity_incidents_kind_check" CHECK (
    "kind" IN ('callback_monetary_mismatch', 'consumed_evidence_mismatch', 'terminal_state_callback_conflict')
  );
ALTER TABLE "pos_manual_payment_references" ADD COLUMN "payment_plan_id" TEXT;
ALTER TABLE "pos_sale_payments"
  ADD COLUMN "payment_plan_id" TEXT,
  ADD COLUMN "payment_index" INTEGER,
  ADD COLUMN "value_reservation_id" TEXT,
  ADD COLUMN "value_capture_entry_id" BIGINT,
  ADD COLUMN "value_amount_units" BIGINT;

CREATE INDEX "pos_payment_intents_payment_plan_slot_idx" ON "pos_payment_intents"("payment_plan_id", "payment_index");
CREATE INDEX "pos_manual_payment_references_payment_plan_slot_idx" ON "pos_manual_payment_references"("payment_plan_id", "payment_index");
CREATE UNIQUE INDEX "pos_sale_payments_payment_plan_slot_key" ON "pos_sale_payments"("payment_plan_id", "payment_index") WHERE "payment_plan_id" IS NOT NULL;
CREATE UNIQUE INDEX "pos_sale_payments_value_reservation_id_key" ON "pos_sale_payments"("value_reservation_id") WHERE "value_reservation_id" IS NOT NULL;
CREATE UNIQUE INDEX "pos_sale_payments_value_capture_entry_id_key" ON "pos_sale_payments"("value_capture_entry_id") WHERE "value_capture_entry_id" IS NOT NULL;

ALTER TABLE "pos_payment_intents" ADD CONSTRAINT "pos_payment_intents_payment_plan_slot_fkey" FOREIGN KEY ("payment_plan_id", "payment_index") REFERENCES "pos_payment_plan_slots"("plan_id", "payment_index") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pos_manual_payment_references" ADD CONSTRAINT "pos_manual_payment_references_payment_plan_slot_fkey" FOREIGN KEY ("payment_plan_id", "payment_index") REFERENCES "pos_payment_plan_slots"("plan_id", "payment_index") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pos_sale_payments" ADD CONSTRAINT "pos_sale_payments_payment_plan_slot_fkey" FOREIGN KEY ("payment_plan_id", "payment_index") REFERENCES "pos_payment_plan_slots"("plan_id", "payment_index") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pos_payment_intents" ADD CONSTRAINT "pos_payment_intents_payment_plan_exact_fkey" FOREIGN KEY ("payment_plan_id", "payment_index", "method", "amount_cents", "installments") REFERENCES "pos_payment_plan_slots"("plan_id", "payment_index", "method", "amount_cents", "installments") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "pos_manual_payment_references" ADD CONSTRAINT "pos_manual_payment_references_payment_plan_exact_fkey" FOREIGN KEY ("payment_plan_id", "payment_index", "method", "amount_cents", "installments") REFERENCES "pos_payment_plan_slots"("plan_id", "payment_index", "method", "amount_cents", "installments") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "pos_sale_payments" ADD CONSTRAINT "pos_sale_payments_payment_plan_exact_fkey" FOREIGN KEY ("payment_plan_id", "payment_index", "method", "amount_cents", "installments") REFERENCES "pos_payment_plan_slots"("plan_id", "payment_index", "method", "amount_cents", "installments") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "pos_sale_payments" ADD CONSTRAINT "pos_sale_payments_value_reservation_id_fkey" FOREIGN KEY ("value_reservation_id") REFERENCES "pos_value_reservations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "pos_sale_payments" ADD CONSTRAINT "pos_sale_payments_value_capture_entry_id_fkey" FOREIGN KEY ("value_capture_entry_id") REFERENCES "pos_value_ledger_entries"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "validate_pos_payment_plan_promotion"(plan_record "pos_payment_plans") RETURNS void AS $$
DECLARE
  promotion_record "pos_promotions"%ROWTYPE;
  draft_customer_id INTEGER;
  eligible_subtotal BIGINT;
  eligible_quantity NUMERIC;
  expected_discount BIGINT;
  coupon_required BOOLEAN;
BEGIN
  IF plan_record."promotion_id" IS NULL THEN
    IF plan_record."promotion_discount_cents" <> 0 OR plan_record."coupon_id" IS NOT NULL
      OR EXISTS (SELECT 1 FROM "pos_payment_plan_quote_lines" line WHERE line."plan_id" = plan_record."id" AND line."promotion_discount_cents" <> 0)
    THEN
      RAISE EXCEPTION 'payment plan without promotion cannot claim promotion discount' USING ERRCODE = '23514';
    END IF;
    RETURN;
  END IF;
  SELECT * INTO promotion_record FROM "pos_promotions" WHERE "id" = plan_record."promotion_id";
  IF promotion_record."id" IS NULL OR promotion_record."status" <> 'active' OR promotion_record."stack_mode" <> 'exclusive'
    OR promotion_record."starts_at" > plan_record."evaluated_at" OR promotion_record."ends_at" IS NOT NULL AND promotion_record."ends_at" <= plan_record."evaluated_at"
    OR promotion_record."branch_id" IS NOT NULL AND promotion_record."branch_id" <> plan_record."branch_id"
  THEN
    RAISE EXCEPTION 'payment plan promotion was not active in its quote context' USING ERRCODE = '23514';
  END IF;
  SELECT draft."customer_id" INTO draft_customer_id FROM "pos_held_sales" draft WHERE draft."id" = plan_record."sale_draft_id";
  SELECT COALESCE(SUM(line."gross_cents" - line."base_discount_cents" - line."order_discount_cents"), 0), COALESCE(SUM(line."quantity"::numeric), 0)
    INTO eligible_subtotal, eligible_quantity
  FROM "pos_payment_plan_quote_lines" line
  JOIN "products" product ON product."id" = line."product_id"
  WHERE line."plan_id" = plan_record."id"
    AND (NOT (promotion_record."conditions" ? 'productIds') OR EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(promotion_record."conditions"->'productIds') item WHERE item::integer = line."product_id"
    ))
    AND (NOT (promotion_record."conditions" ? 'categoryIds') OR EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(promotion_record."conditions"->'categoryIds') category
      WHERE category::integer = product."category_id" OR EXISTS (
        SELECT 1 FROM "product_category_links" link WHERE link."product_id" = line."product_id" AND link."category_id" = category::integer
      )
    ));
  IF eligible_subtotal <= 0 OR promotion_record."conditions" ? 'minimumQuantity'
    AND eligible_quantity < (promotion_record."conditions"->>'minimumQuantity')::numeric
  THEN
    RAISE EXCEPTION 'payment plan promotion has no eligible subtotal/quantity' USING ERRCODE = '23514';
  END IF;
  IF promotion_record."usage_limit" IS NOT NULL AND (
      SELECT COUNT(*) FROM "pos_promotion_redemptions" redemption WHERE redemption."promotion_id" = promotion_record."id" AND redemption."reversed_at" IS NULL
    ) >= promotion_record."usage_limit"
  THEN
    RAISE EXCEPTION 'payment plan promotion usage limit was exhausted' USING ERRCODE = '23514';
  END IF;
  IF promotion_record."per_customer_limit" IS NOT NULL AND (draft_customer_id IS NULL OR (
      SELECT COUNT(*) FROM "pos_promotion_redemptions" redemption
      WHERE redemption."promotion_id" = promotion_record."id" AND redemption."customer_id" = draft_customer_id AND redemption."reversed_at" IS NULL
    ) >= promotion_record."per_customer_limit")
  THEN
    RAISE EXCEPTION 'payment plan promotion customer limit was exhausted' USING ERRCODE = '23514';
  END IF;
  coupon_required := COALESCE((promotion_record."conditions"->>'couponRequired')::boolean, false);
  IF coupon_required AND NOT EXISTS (
    SELECT 1 FROM "pos_coupons" coupon WHERE coupon."id" = plan_record."coupon_id" AND coupon."promotion_id" = promotion_record."id"
      AND coupon."status" = 'active' AND (coupon."expires_at" IS NULL OR coupon."expires_at" > plan_record."evaluated_at")
      AND (coupon."usage_limit" IS NULL OR coupon."used_count" < coupon."usage_limit")
  ) OR NOT coupon_required AND plan_record."coupon_id" IS NOT NULL THEN
    RAISE EXCEPTION 'payment plan coupon does not match promotion requirements' USING ERRCODE = '23514';
  END IF;
  IF promotion_record."effects"->>'type' = 'fixed' THEN
    expected_discount := LEAST((promotion_record."effects"->>'discountCents')::bigint, eligible_subtotal);
  ELSIF promotion_record."effects"->>'type' = 'percentage' THEN
    expected_discount := eligible_subtotal * (promotion_record."effects"->>'percentageBasisPoints')::bigint / 10000;
    IF promotion_record."effects" ? 'maximumDiscountCents' AND promotion_record."effects"->>'maximumDiscountCents' IS NOT NULL THEN
      expected_discount := LEAST(expected_discount, (promotion_record."effects"->>'maximumDiscountCents')::bigint);
    END IF;
    expected_discount := LEAST(expected_discount, eligible_subtotal);
  ELSE
    RAISE EXCEPTION 'payment plan promotion effect is unsupported' USING ERRCODE = '23514';
  END IF;
  IF expected_discount <= 0 OR expected_discount <> plan_record."promotion_discount_cents"
    OR expected_discount <> (SELECT COALESCE(SUM(line."promotion_discount_cents"), 0) FROM "pos_payment_plan_quote_lines" line WHERE line."plan_id" = plan_record."id")
    OR EXISTS (
      SELECT 1 FROM "pos_payment_plan_quote_lines" line
      JOIN "products" product ON product."id" = line."product_id"
      WHERE line."plan_id" = plan_record."id" AND line."promotion_discount_cents" > 0 AND NOT (
        (NOT (promotion_record."conditions" ? 'productIds') OR EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(promotion_record."conditions"->'productIds') item WHERE item::integer = line."product_id"
        )) AND (NOT (promotion_record."conditions" ? 'categoryIds') OR EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(promotion_record."conditions"->'categoryIds') category
          WHERE category::integer = product."category_id" OR EXISTS (
            SELECT 1 FROM "product_category_links" link WHERE link."product_id" = line."product_id" AND link."category_id" = category::integer
          )
        ))
      )
    )
  THEN
    RAISE EXCEPTION 'payment plan promotion discount is not recomputable from its relational quote lines' USING ERRCODE = '23514';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION "assert_pos_payment_plan_live_access"(plan_record "pos_payment_plans") RETURNS void AS $$
BEGIN
  PERFORM profile."id"
  FROM "tenant_user_profiles" profile
  JOIN "branches" branch ON branch."id" = plan_record."branch_id"
  JOIN "pos_registers" register ON register."id" = plan_record."register_id" AND register."branch_id" = branch."id"
  JOIN "branch_user_accesses" branch_access
    ON branch_access."branch_id" = branch."id" AND branch_access."user_profile_id" = profile."id"
  JOIN "pos_register_accesses" register_access
    ON register_access."register_id" = register."id" AND register_access."user_profile_id" = profile."id"
  WHERE profile."id" = plan_record."operator_profile_id"
    AND profile."status" = 'active' AND branch."status" = 'active' AND register."status" = 'active'
    AND branch_access."can_sell" = true AND register_access."active" = true AND register_access."can_sell" = true
    AND (register_access."valid_from" IS NULL OR register_access."valid_from" <= clock_timestamp())
    AND (register_access."valid_until" IS NULL OR register_access."valid_until" >= clock_timestamp())
  FOR SHARE OF profile, branch, register, branch_access, register_access;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'authoritative payment plan requires live explicit branch/register sale access' USING ERRCODE = '23514';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION "validate_pos_payment_plan_activation"() RETURNS trigger AS $$
DECLARE
  slot_count INTEGER;
  slot_sum BIGINT;
  minimum_index INTEGER;
  maximum_index INTEGER;
  quote_line_count INTEGER;
  minimum_line_index INTEGER;
  maximum_line_index INTEGER;
  held_item_count INTEGER;
  quote_total BIGINT;
  order_discount_total BIGINT;
  surcharge_total BIGINT;
BEGIN
  IF NEW."state" IN ('active', 'consumed') AND OLD."state" IS DISTINCT FROM NEW."state" THEN
    IF NOT EXISTS (
      SELECT 1 FROM "pos_payment_plan_operations" operation
      WHERE operation."plan_id" = OLD."id"
        AND operation."expected_version" = OLD."version"
        AND operation."resulting_version" = NEW."version"
        AND operation."resulting_state" = NEW."state"
        AND operation."action" = CASE WHEN NEW."state" = 'active' THEN 'activate' ELSE 'consume' END
        AND operation."write_txid" = txid_current()::numeric
    ) THEN
      RAISE EXCEPTION 'pos payment plan lifecycle validation requires its canonical operation first' USING ERRCODE = '23514';
    END IF;
    PERFORM 1 FROM "cash_register_sessions" session
    WHERE session."id" = NEW."session_id" AND session."register_id" = NEW."register_id"
      AND session."operator_profile_id" = NEW."operator_profile_id" AND session."status" = 'open';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'pos payment plan session changed before lifecycle transition' USING ERRCODE = '23514';
    END IF;
    PERFORM 1 FROM "pos_terminals" terminal
    WHERE terminal."id" = NEW."terminal_id" AND terminal."register_id" = NEW."register_id"
      AND terminal."status" = 'online' AND terminal."paired_at" IS NOT NULL AND terminal."revoked_at" IS NULL
      AND terminal."token_hash" IS NOT NULL AND terminal."token_expires_at" > clock_timestamp()
      AND terminal."last_seen_at" > clock_timestamp() - INTERVAL '5 minutes' AND NULLIF(btrim(terminal."app_version"), '') IS NOT NULL
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'pos payment plan terminal changed before lifecycle transition' USING ERRCODE = '23514';
    END IF;
    PERFORM "assert_pos_payment_plan_live_access"(NEW);
    PERFORM 1 FROM "pos_held_sales" d
    WHERE d."id" = NEW."sale_draft_id" AND d."register_id" = NEW."register_id" AND d."session_id" = NEW."session_id"
      AND d."operator_profile_id" = NEW."operator_profile_id" AND d."revision" = NEW."draft_revision"
      AND d."status" = NEW."draft_status" AND d."status" IN ('draft', 'held');
    IF NOT FOUND THEN
      RAISE EXCEPTION 'pos payment plan draft changed before lifecycle transition' USING ERRCODE = '23514';
    END IF;
    IF NEW."order_claim_id" IS NOT NULL THEN
      PERFORM 1 FROM "pos_order_claims" c
      WHERE c."id" = NEW."order_claim_id" AND c."id" = NEW."sale_draft_id"
        AND c."branch_id" = NEW."branch_id" AND c."register_id" = NEW."register_id" AND c."session_id" = NEW."session_id"
        AND c."operator_profile_id" = NEW."operator_profile_id" AND c."terminal_id" = NEW."terminal_id"
        AND c."state" = 'active' AND c."lease_expires_at" > clock_timestamp() AND NEW."expires_at" <= c."lease_expires_at";
      IF NOT FOUND THEN
        RAISE EXCEPTION 'pos payment plan order claim expired or changed before lifecycle transition' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  IF NEW."state" = 'active' AND OLD."state" = 'quoted' THEN
    IF NEW."expires_at" <= clock_timestamp() THEN
      RAISE EXCEPTION 'expired pos payment plan cannot be activated' USING ERRCODE = '23514';
    END IF;
    SELECT COUNT(*), MIN("line_index"), MAX("line_index"), COALESCE(SUM("total_cents"), 0), COALESCE(SUM("order_discount_cents"), 0), COALESCE(SUM("surcharge_cents"), 0)
      INTO quote_line_count, minimum_line_index, maximum_line_index, quote_total, order_discount_total, surcharge_total
      FROM "pos_payment_plan_quote_lines" WHERE "plan_id" = NEW."id";
    SELECT COUNT(*) INTO held_item_count FROM "pos_held_sale_items" WHERE "held_sale_id" = NEW."sale_draft_id";
    IF quote_line_count < 1 OR quote_line_count <> held_item_count OR minimum_line_index <> 0 OR maximum_line_index <> quote_line_count - 1
      OR quote_total <> NEW."total_cents"
      OR order_discount_total <> (SELECT "discount_cents" FROM "pos_held_sales" WHERE "id" = NEW."sale_draft_id")
      OR surcharge_total <> (SELECT "surcharge_cents" FROM "pos_held_sales" WHERE "id" = NEW."sale_draft_id")
      OR EXISTS (
        SELECT 1 FROM "pos_payment_plan_quote_lines" line
        LEFT JOIN "pos_held_sale_items" item ON item."id" = line."held_sale_item_id" AND item."held_sale_id" = NEW."sale_draft_id"
        WHERE line."plan_id" = NEW."id" AND (
          item."id" IS NULL OR line."line_index" < 0 OR line."product_id" IS DISTINCT FROM item."product_id"
          OR line."variation_id" IS DISTINCT FROM item."variation_id" OR line."quantity" IS DISTINCT FROM item."quantity"
          OR line."unit_price_cents" IS DISTINCT FROM item."unit_price_cents" OR line."base_discount_cents" IS DISTINCT FROM item."discount_cents"
        )
      )
    THEN
      RAISE EXCEPTION 'payment plan quote lines do not exactly recompute the frozen draft/pricing total' USING ERRCODE = '23514';
    END IF;
    PERFORM "validate_pos_payment_plan_promotion"(NEW);
    PERFORM connector."id"
    FROM "pos_payment_plan_slots" slot
    JOIN "pos_connectors" connector ON connector."id" = slot."connector_id"
    WHERE slot."plan_id" = NEW."id" AND slot."proof_kind" = 'intent'
    ORDER BY connector."id"
    FOR SHARE OF connector;
    PERFORM credential."id"
    FROM "pos_payment_plan_slots" slot
    JOIN "integration_credentials" credential ON credential."id" = slot."credential_ref"
    WHERE slot."plan_id" = NEW."id" AND slot."proof_kind" = 'intent'
    ORDER BY credential."id"
    FOR SHARE OF credential;
    SELECT COUNT(*), COALESCE(SUM("amount_cents"), 0), MIN("payment_index"), MAX("payment_index")
      INTO slot_count, slot_sum, minimum_index, maximum_index
      FROM "pos_payment_plan_slots" WHERE "plan_id" = NEW."id";
    IF slot_count < 1 OR slot_count > 10 OR slot_sum <> NEW."total_cents" OR minimum_index <> 0 OR maximum_index <> slot_count - 1 THEN
      RAISE EXCEPTION 'pos payment plan slots must be contiguous and total exactly the quote' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM "pos_payment_plan_slots" s
      LEFT JOIN "pos_connectors" c ON c."id" = s."connector_id"
      LEFT JOIN "integration_credentials" credential ON credential."id" = s."credential_ref"
      LEFT JOIN "integration_providers" credential_provider ON credential_provider."id" = credential."provider_id"
      WHERE s."plan_id" = NEW."id" AND s."proof_kind" = 'intent'
        AND (c."id" IS NULL OR c."branch_id" <> NEW."branch_id" OR c."status" <> 'active' OR c."provider" <> s."provider"
          OR c."credential_ref" IS DISTINCT FROM s."credential_ref"
          OR credential."id" IS NULL OR credential."enabled" = false OR credential."provider_id" <> s."provider" OR credential_provider."family" <> 'payment'
          OR (c."register_id" IS NOT NULL AND c."register_id" <> NEW."register_id") OR c."type" NOT LIKE 'payment%'
          OR CASE
            WHEN COALESCE(c."settings" ? 'methods', false) AND c."settings"->'methods' IS DISTINCT FROM 'null'::jsonb THEN
              CASE
                WHEN jsonb_typeof(c."settings"->'methods') IS DISTINCT FROM 'array' THEN true
                ELSE
                  NOT (c."settings"->'methods' ? s."method")
                  OR EXISTS (
                    SELECT 1 FROM jsonb_array_elements(c."settings"->'methods') configured_method
                    WHERE jsonb_typeof(configured_method) IS DISTINCT FROM 'string'
                      OR configured_method #>> '{}' NOT IN ('pix', 'credit', 'debit', 'voucher')
                  )
              END
            ELSE false
          END)
    ) THEN
      RAISE EXCEPTION 'pos payment plan connector is not active in the plan context' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM "pos_payment_plan_slots" WHERE "plan_id" = NEW."id" AND "proof_kind" = 'manual') THEN
      RAISE EXCEPTION 'manual payment plan slots remain disabled until the reconciliation workflow is installed' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION "protect_pos_payment_plan"() RETURNS trigger AS $$
DECLARE
  matching_operation BOOLEAN;
  operation_sale_id INTEGER;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."lifecycle_txid" := txid_current()::numeric;
    IF NEW."state" <> 'quoted' OR NEW."version" <> 0 OR NEW."activated_at" IS NOT NULL OR NEW."consumed_at" IS NOT NULL
      OR NEW."consumed_sale_id" IS NOT NULL OR NEW."superseded_at" IS NOT NULL OR NEW."expired_at" IS NOT NULL
    THEN
      RAISE EXCEPTION 'pos payment plan must be inserted as quoted version zero' USING ERRCODE = '23514';
    END IF;
    IF NEW."evaluated_at" < clock_timestamp() - INTERVAL '60 seconds' OR NEW."evaluated_at" > clock_timestamp() + INTERVAL '5 seconds' THEN
      RAISE EXCEPTION 'pos payment plan evaluation timestamp is outside the authoritative clock skew' USING ERRCODE = '23514';
    END IF;
    IF NEW."order_claim_id" IS NULL AND NEW."expires_at" IS DISTINCT FROM NEW."evaluated_at" + INTERVAL '5 minutes' THEN
      RAISE EXCEPTION 'generic pos payment plan TTL must be exactly five minutes' USING ERRCODE = '23514';
    END IF;
    PERFORM 1 FROM "cash_register_sessions" session
    WHERE session."id" = NEW."session_id" AND session."register_id" = NEW."register_id"
      AND session."operator_profile_id" = NEW."operator_profile_id" AND session."status" = 'open'
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'pos payment plan requires its exact open session/operator/register' USING ERRCODE = '23514';
    END IF;
    PERFORM 1 FROM "pos_terminals" terminal
    JOIN "pos_registers" register ON register."id" = terminal."register_id"
    JOIN "branches" branch ON branch."id" = register."branch_id"
    WHERE terminal."id" = NEW."terminal_id" AND terminal."register_id" = NEW."register_id"
      AND terminal."status" = 'online' AND terminal."paired_at" IS NOT NULL AND terminal."revoked_at" IS NULL
      AND terminal."token_hash" IS NOT NULL AND terminal."token_expires_at" > clock_timestamp()
      AND terminal."last_seen_at" > clock_timestamp() - INTERVAL '5 minutes' AND NULLIF(btrim(terminal."app_version"), '') IS NOT NULL
      AND register."branch_id" = NEW."branch_id" AND register."status" = 'active' AND branch."status" = 'active'
    FOR UPDATE OF terminal;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'pos payment plan requires its exact online authenticated terminal context' USING ERRCODE = '23514';
    END IF;
    PERFORM "assert_pos_payment_plan_live_access"(NEW);
    IF NEW."order_claim_id" IS NOT NULL THEN
      PERFORM 1 FROM "pos_order_claims" c
      WHERE c."id" = NEW."order_claim_id"
        AND c."id" = NEW."sale_draft_id"
        AND c."branch_id" = NEW."branch_id"
        AND c."register_id" = NEW."register_id"
        AND c."session_id" = NEW."session_id"
        AND c."operator_profile_id" = NEW."operator_profile_id"
        AND c."terminal_id" = NEW."terminal_id"
        AND c."state" = 'active'
        AND c."lease_expires_at" > clock_timestamp()
        AND NEW."expires_at" <= c."lease_expires_at"
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'pos payment plan order claim/context mismatch or lease inactive' USING ERRCODE = '23514';
      END IF;
      IF NEW."expires_at" IS DISTINCT FROM LEAST(NEW."evaluated_at" + INTERVAL '5 minutes', (
        SELECT c."lease_expires_at" FROM "pos_order_claims" c WHERE c."id" = NEW."order_claim_id"
      )) THEN
        RAISE EXCEPTION 'claimed-order payment plan TTL must be capped exactly by its lease' USING ERRCODE = '23514';
      END IF;
    END IF;
    PERFORM 1
    FROM "pos_held_sales" d
    JOIN "pos_registers" r ON r."id" = d."register_id"
    WHERE d."id" = NEW."sale_draft_id"
      AND d."register_id" = NEW."register_id"
      AND d."session_id" = NEW."session_id"
      AND d."operator_profile_id" = NEW."operator_profile_id"
      AND d."revision" = NEW."draft_revision"
      AND d."status" = NEW."draft_status"
      AND d."status" IN ('draft', 'held')
      AND r."branch_id" = NEW."branch_id"
    FOR UPDATE OF d;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'pos payment plan draft revision/context mismatch' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."state" IS DISTINCT FROM OLD."state" THEN
    NEW."lifecycle_txid" := txid_current()::numeric;
    IF NEW."state" = 'active' THEN NEW."activated_at" := clock_timestamp(); END IF;
    IF NEW."state" = 'consumed' THEN NEW."consumed_at" := clock_timestamp(); END IF;
    IF NEW."state" = 'superseded' THEN NEW."superseded_at" := clock_timestamp(); END IF;
    IF NEW."state" = 'expired' THEN NEW."expired_at" := clock_timestamp(); END IF;
  ELSIF NEW."lifecycle_txid" IS DISTINCT FROM OLD."lifecycle_txid" THEN
    RAISE EXCEPTION 'pos payment plan lifecycle marker is immutable without transition' USING ERRCODE = '23514';
  END IF;
  IF NEW."state" IS NOT DISTINCT FROM OLD."state" AND ROW(NEW."consumed_sale_id", NEW."activated_at", NEW."consumed_at", NEW."superseded_at", NEW."expired_at")
    IS DISTINCT FROM ROW(OLD."consumed_sale_id", OLD."activated_at", OLD."consumed_at", OLD."superseded_at", OLD."expired_at")
  THEN
    RAISE EXCEPTION 'pos payment plan lifecycle evidence is immutable outside an exact transition' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW."branch_id", NEW."register_id", NEW."session_id", NEW."operator_profile_id", NEW."terminal_id", NEW."sale_draft_id", NEW."draft_revision", NEW."draft_request_hash", NEW."draft_status", NEW."order_claim_id", NEW."quote_hash", NEW."promotion_id", NEW."coupon_id", NEW."promotion_discount_cents", NEW."evaluated_at", NEW."expires_at", NEW."currency", NEW."total_cents", NEW."idempotency_key", NEW."request_hash", NEW."created_at")
    IS DISTINCT FROM ROW(OLD."branch_id", OLD."register_id", OLD."session_id", OLD."operator_profile_id", OLD."terminal_id", OLD."sale_draft_id", OLD."draft_revision", OLD."draft_request_hash", OLD."draft_status", OLD."order_claim_id", OLD."quote_hash", OLD."promotion_id", OLD."coupon_id", OLD."promotion_discount_cents", OLD."evaluated_at", OLD."expires_at", OLD."currency", OLD."total_cents", OLD."idempotency_key", OLD."request_hash", OLD."created_at") THEN
    RAISE EXCEPTION 'pos payment plan financial identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW."state" IS DISTINCT FROM OLD."state" THEN
    IF NEW."version" <> OLD."version" + 1 OR NOT (
      (OLD."state" = 'quoted' AND NEW."state" IN ('active', 'superseded', 'expired'))
      OR (OLD."state" = 'active' AND NEW."state" IN ('consumed', 'superseded', 'expired'))
    ) THEN
      RAISE EXCEPTION 'invalid pos payment plan transition' USING ERRCODE = '23514';
    END IF;
    IF NEW."state" IN ('superseded', 'expired') AND (
      EXISTS (
        SELECT 1 FROM "pos_payment_intents" i
        WHERE i."payment_plan_id" = OLD."id"
          AND NOT (
            (
              i."status" = 'cancelled' AND i."provider_reference" IS NULL AND i."provider_occurred_at" IS NULL AND i."unknown_since" IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM "pos_payment_attempts" a
                LEFT JOIN "pos_payment_outbox" o ON o."attempt_id" = a."id"
                WHERE a."intent_id" = i."id" AND (o."id" IS NULL OR NOT COALESCE((
                  a."state" = 'failed' AND a."dispatch_count" = 0 AND a."started_at" IS NULL AND a."finished_at" IS NOT NULL
                  AND a."outcome_unknown" = false AND a."failure_code" IN ('operator_cancelled_before_dispatch', 'expired_before_dispatch')
                  AND o."state" IN ('dead', 'completed') AND o."delivery_count" = 0 AND o."claim_token" IS NULL
                ), false))
              )
              AND NOT EXISTS (
                SELECT 1 FROM "pos_payment_callbacks" callback
                WHERE callback."intent_id" = i."id"
                  AND callback."reported_state" IN ('authorized', 'captured', 'unknown', 'manual_review', 'partially_refunded', 'refunded')
              )
            )
            OR (
              i."status" = 'declined' AND i."consumed_at" IS NULL AND i."unknown_since" IS NULL
              AND (
                EXISTS (
                  SELECT 1 FROM "pos_payment_attempts" a
                  JOIN "pos_payment_outbox" o ON o."attempt_id" = a."id"
                  JOIN "pos_payment_delivery_results" delivery ON delivery."attempt_id" = a."id" AND delivery."intent_id" = i."id"
                  WHERE a."intent_id" = i."id" AND a."state" = 'succeeded' AND a."outcome_unknown" = false
                    AND o."state" = 'completed' AND o."claim_token" IS NULL AND delivery."result_kind" = 'result'
                    AND delivery."resulting_intent_state" = 'declined' AND delivery."superseded" = false
                )
                OR EXISTS (
                  SELECT 1 FROM "pos_payment_callbacks" callback
                  WHERE callback."intent_id" = i."id" AND callback."provider" = i."provider"
                    AND callback."reported_state" = 'declined' AND callback."resulting_state" = 'declined'
                    AND callback."resulting_version" = i."version" AND callback."processing_result" = 'applied'
                    AND callback."amount_cents" = i."amount_cents" AND callback."currency" = i."currency"
                    AND NOT EXISTS (
                      SELECT 1 FROM "pos_payment_integrity_incidents" incident
                      WHERE incident."callback_id" = callback."id" AND incident."production_blocking" = true
                    )
                )
              )
              AND NOT EXISTS (
                SELECT 1 FROM "pos_payment_attempts" a
                LEFT JOIN "pos_payment_outbox" o ON o."attempt_id" = a."id"
                WHERE a."intent_id" = i."id" AND (
                  a."outcome_unknown" IS DISTINCT FROM false OR a."state" NOT IN ('succeeded', 'failed')
                  OR o."id" IS NULL OR o."state" NOT IN ('completed', 'dead') OR o."claim_token" IS NOT NULL
                )
              )
              AND NOT EXISTS (
                SELECT 1 FROM "pos_payment_callbacks" callback
                WHERE callback."intent_id" = i."id" AND callback."reported_state" IN ('authorized', 'captured', 'unknown', 'manual_review', 'partially_refunded', 'refunded')
              )
            )
          )
      )
      OR EXISTS (SELECT 1 FROM "pos_manual_payment_references" m WHERE m."payment_plan_id" = OLD."id")
      OR EXISTS (SELECT 1 FROM "pos_sale_payments" p WHERE p."payment_plan_id" = OLD."id")
    ) THEN
      RAISE EXCEPTION 'pos payment plan has unresolved financial evidence' USING ERRCODE = '23514';
    END IF;
    IF NEW."state" = 'expired' AND NEW."expires_at" > clock_timestamp() THEN
      RAISE EXCEPTION 'pos payment plan cannot expire before its authoritative TTL' USING ERRCODE = '23514';
    END IF;
    SELECT EXISTS (
      SELECT 1 FROM "pos_payment_plan_operations" o
      WHERE o."plan_id" = OLD."id"
        AND o."expected_version" = OLD."version"
        AND o."resulting_version" = NEW."version"
        AND o."resulting_state" = NEW."state"
        AND o."write_txid" = txid_current()::numeric
        AND (
          (o."action" = 'activate' AND OLD."state" = 'quoted' AND NEW."state" = 'active')
          OR (o."action" = 'consume' AND OLD."state" = 'active' AND NEW."state" = 'consumed')
          OR (o."action" = 'supersede' AND NEW."state" = 'superseded')
          OR (o."action" = 'expire' AND NEW."state" = 'expired')
        )
    ) INTO matching_operation;
    IF NOT matching_operation THEN
      RAISE EXCEPTION 'pos payment plan transition requires an exact operation in the same transaction' USING ERRCODE = '23514';
    END IF;
    IF NEW."state" = 'consumed' THEN
      SELECT o."sale_id" INTO operation_sale_id FROM "pos_payment_plan_operations" o
      WHERE o."plan_id" = OLD."id" AND o."expected_version" = OLD."version" AND o."resulting_version" = NEW."version"
        AND o."action" = 'consume' AND o."write_txid" = txid_current()::numeric;
      IF operation_sale_id IS NULL THEN
        RAISE EXCEPTION 'consumed pos payment plan requires its sale-bound operation' USING ERRCODE = '23514';
      END IF;
      NEW."consumed_sale_id" := operation_sale_id;
    ELSIF NEW."consumed_sale_id" IS DISTINCT FROM OLD."consumed_sale_id" THEN
      RAISE EXCEPTION 'consumed sale may change only on consume transition' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."version" IS DISTINCT FROM OLD."version" THEN
    RAISE EXCEPTION 'pos payment plan version may change only with state' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "pos_payment_plans_activation_guard" BEFORE UPDATE ON "pos_payment_plans" FOR EACH ROW EXECUTE FUNCTION "validate_pos_payment_plan_activation"();
CREATE TRIGGER "pos_payment_plans_immutable_guard" BEFORE INSERT OR UPDATE ON "pos_payment_plans" FOR EACH ROW EXECUTE FUNCTION "protect_pos_payment_plan"();

CREATE FUNCTION "protect_pos_payment_plan_slot"() RETURNS trigger AS $$
DECLARE plan_record "pos_payment_plans"%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'pos payment plan slots are immutable' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO plan_record FROM "pos_payment_plans" WHERE "id" = NEW."plan_id";
  IF plan_record."id" IS NULL THEN
    RAISE EXCEPTION 'pos payment plan slot requires an existing plan' USING ERRCODE = '23503';
  END IF;
  PERFORM 1 FROM "cash_register_sessions" WHERE "id" = plan_record."session_id" FOR UPDATE;
  PERFORM 1 FROM "pos_terminals" WHERE "id" = plan_record."terminal_id" FOR UPDATE;
  PERFORM "assert_pos_payment_plan_live_access"(plan_record);
  IF plan_record."order_claim_id" IS NOT NULL THEN
    PERFORM 1 FROM "pos_order_claims" WHERE "id" = plan_record."order_claim_id" FOR UPDATE;
  END IF;
  PERFORM 1 FROM "pos_held_sales" WHERE "id" = plan_record."sale_draft_id" FOR UPDATE;
  SELECT * INTO plan_record FROM "pos_payment_plans" WHERE "id" = NEW."plan_id" FOR UPDATE;
  IF plan_record."state" IS DISTINCT FROM 'quoted' THEN
    RAISE EXCEPTION 'pos payment plan slots may only be added while quoted' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "pos_payment_plan_slots_immutable_guard" BEFORE INSERT OR UPDATE OR DELETE ON "pos_payment_plan_slots" FOR EACH ROW EXECUTE FUNCTION "protect_pos_payment_plan_slot"();

CREATE FUNCTION "protect_pos_payment_plan_quote_line"() RETURNS trigger AS $$
DECLARE
  plan_record "pos_payment_plans"%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'pos payment plan quote lines are immutable' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO plan_record FROM "pos_payment_plans" WHERE "id" = NEW."plan_id";
  IF plan_record."id" IS NULL THEN
    RAISE EXCEPTION 'pos payment plan quote line requires an existing plan' USING ERRCODE = '23503';
  END IF;
  PERFORM 1 FROM "cash_register_sessions" WHERE "id" = plan_record."session_id" FOR UPDATE;
  PERFORM 1 FROM "pos_terminals" WHERE "id" = plan_record."terminal_id" FOR UPDATE;
  PERFORM "assert_pos_payment_plan_live_access"(plan_record);
  IF plan_record."order_claim_id" IS NOT NULL THEN
    PERFORM 1 FROM "pos_order_claims" WHERE "id" = plan_record."order_claim_id" FOR UPDATE;
  END IF;
  PERFORM 1 FROM "pos_held_sales" WHERE "id" = plan_record."sale_draft_id" FOR UPDATE;
  SELECT * INTO plan_record FROM "pos_payment_plans" WHERE "id" = NEW."plan_id" FOR UPDATE;
  IF plan_record."state" IS DISTINCT FROM 'quoted' OR plan_record."lifecycle_txid" IS DISTINCT FROM txid_current()::numeric THEN
    RAISE EXCEPTION 'pos payment plan quote lines belong only to the initial quote transaction' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "pos_payment_plan_quote_lines_immutable_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "pos_payment_plan_quote_lines"
FOR EACH ROW EXECUTE FUNCTION "protect_pos_payment_plan_quote_line"();

CREATE FUNCTION "validate_pos_payment_plan_slot_commit"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "pos_payment_plans" plan
    WHERE plan."id" = NEW."plan_id" AND plan."state" IN ('active', 'consumed')
  ) THEN
    RAISE EXCEPTION 'inserted payment plan slots require activation in the same transaction' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "pos_payment_plan_slots_phase_commit_guard"
AFTER INSERT ON "pos_payment_plan_slots"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "validate_pos_payment_plan_slot_commit"();

CREATE FUNCTION "protect_pos_payment_plan_operation"() RETURNS trigger AS $$
DECLARE
  plan_record "pos_payment_plans"%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'pos payment plan operations are append-only' USING ERRCODE = '23514';
  END IF;
  NEW."write_txid" := txid_current()::numeric;
  SELECT * INTO plan_record FROM "pos_payment_plans" WHERE "id" = NEW."plan_id";
  IF plan_record."id" IS NULL THEN
    RAISE EXCEPTION 'pos payment plan operation requires an existing plan' USING ERRCODE = '23503';
  END IF;
  PERFORM 1 FROM "cash_register_sessions" WHERE "id" = plan_record."session_id" FOR UPDATE;
  PERFORM 1 FROM "pos_terminals" WHERE "id" = plan_record."terminal_id" FOR UPDATE;
  PERFORM "assert_pos_payment_plan_live_access"(plan_record);
  IF plan_record."order_claim_id" IS NOT NULL THEN
    PERFORM 1 FROM "pos_order_claims" WHERE "id" = plan_record."order_claim_id" FOR UPDATE;
  END IF;
  PERFORM 1 FROM "pos_held_sales" WHERE "id" = plan_record."sale_draft_id" FOR UPDATE;
  SELECT * INTO plan_record FROM "pos_payment_plans" WHERE "id" = NEW."plan_id" FOR UPDATE;
  IF NEW."action" = 'quote' THEN
    IF plan_record."state" <> 'quoted' OR plan_record."version" <> 0 OR NEW."expected_version" <> -1
      OR NEW."resulting_version" <> 0 OR NEW."resulting_state" <> 'quoted'
      OR plan_record."lifecycle_txid" <> txid_current()::numeric
      OR NEW."request_hash" IS DISTINCT FROM plan_record."request_hash" OR NEW."idempotency_key" IS DISTINCT FROM plan_record."idempotency_key"
    THEN
      RAISE EXCEPTION 'quote operation does not match the inserted plan transaction' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."expected_version" <> plan_record."version" OR NEW."resulting_version" <> plan_record."version" + 1 OR NOT (
    (NEW."action" = 'activate' AND plan_record."state" = 'quoted' AND NEW."resulting_state" = 'active')
    OR (NEW."action" = 'consume' AND plan_record."state" = 'active' AND NEW."resulting_state" = 'consumed')
    OR (NEW."action" = 'supersede' AND plan_record."state" IN ('quoted', 'active') AND NEW."resulting_state" = 'superseded')
    OR (NEW."action" = 'expire' AND plan_record."state" IN ('quoted', 'active') AND NEW."resulting_state" = 'expired')
  ) THEN
    RAISE EXCEPTION 'pos payment plan operation does not match current plan state/version' USING ERRCODE = '23514';
  END IF;
  IF NEW."action" = 'consume' AND NOT EXISTS (
    SELECT 1 FROM "sales" sale WHERE sale."id" = NEW."sale_id" AND sale."idempotency_key" = plan_record."sale_draft_id"
  ) THEN
    RAISE EXCEPTION 'consume operation sale does not match the plan draft' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "pos_payment_plan_operations_insert_guard" BEFORE INSERT ON "pos_payment_plan_operations" FOR EACH ROW EXECUTE FUNCTION "protect_pos_payment_plan_operation"();
CREATE TRIGGER "pos_payment_plan_operations_immutable_guard" BEFORE UPDATE OR DELETE ON "pos_payment_plan_operations" FOR EACH ROW EXECUTE FUNCTION "protect_pos_payment_plan_operation"();

CREATE FUNCTION "validate_pos_payment_plan_operation_commit"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "pos_payment_plans" p
    WHERE p."id" = NEW."plan_id"
      AND p."version" = NEW."resulting_version"
      AND p."state" = NEW."resulting_state"
      AND p."lifecycle_txid" = NEW."write_txid"
      AND (NEW."action" <> 'consume' OR p."consumed_sale_id" = NEW."sale_id")
  ) THEN
    RAISE EXCEPTION 'pos payment plan operation was not completed by its exact lifecycle transition' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "pos_payment_plan_operation_commit_guard"
AFTER INSERT ON "pos_payment_plan_operations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "validate_pos_payment_plan_operation_commit"();

CREATE FUNCTION "validate_quoted_pos_payment_plan_commit"() RETURNS trigger AS $$
DECLARE
  plan_record "pos_payment_plans"%ROWTYPE;
  quote_line_count INTEGER;
  held_item_count INTEGER;
  minimum_line_index INTEGER;
  maximum_line_index INTEGER;
  quote_total BIGINT;
  order_discount_total BIGINT;
  promotion_discount_total BIGINT;
  surcharge_total BIGINT;
BEGIN
  SELECT * INTO plan_record FROM "pos_payment_plans" WHERE "id" = NEW."id";
  IF NOT EXISTS (
    SELECT 1 FROM "pos_payment_plan_operations" o
    WHERE o."plan_id" = NEW."id" AND o."action" = 'quote'
      AND o."expected_version" = -1 AND o."resulting_version" = 0 AND o."resulting_state" = 'quoted'
      AND o."write_txid" = NEW."lifecycle_txid"
  ) THEN
    RAISE EXCEPTION 'inserted pos payment plan requires a quote operation in the same transaction' USING ERRCODE = '23514';
  END IF;
  PERFORM "assert_pos_payment_plan_live_access"(plan_record);
  SELECT COUNT(*), MIN("line_index"), MAX("line_index"), COALESCE(SUM("total_cents"), 0),
      COALESCE(SUM("order_discount_cents"), 0), COALESCE(SUM("promotion_discount_cents"), 0),
      COALESCE(SUM("surcharge_cents"), 0)
    INTO quote_line_count, minimum_line_index, maximum_line_index, quote_total,
      order_discount_total, promotion_discount_total, surcharge_total
  FROM "pos_payment_plan_quote_lines" WHERE "plan_id" = NEW."id";
  SELECT COUNT(*) INTO held_item_count
  FROM "pos_held_sale_items" WHERE "held_sale_id" = NEW."sale_draft_id";
  IF plan_record."state" IS DISTINCT FROM 'quoted' OR plan_record."version" IS DISTINCT FROM 0
    OR EXISTS (SELECT 1 FROM "pos_payment_plan_slots" slot WHERE slot."plan_id" = NEW."id")
    OR quote_line_count < 1 OR quote_line_count <> held_item_count
    OR minimum_line_index <> 0 OR maximum_line_index <> quote_line_count - 1
    OR quote_total <> NEW."total_cents"
    OR order_discount_total <> (SELECT draft."discount_cents" FROM "pos_held_sales" draft WHERE draft."id" = NEW."sale_draft_id")
    OR promotion_discount_total <> NEW."promotion_discount_cents"
    OR surcharge_total <> (SELECT draft."surcharge_cents" FROM "pos_held_sales" draft WHERE draft."id" = NEW."sale_draft_id")
    OR EXISTS (
      SELECT 1
      FROM "pos_payment_plan_quote_lines" line
      LEFT JOIN "pos_held_sale_items" item
        ON item."id" = line."held_sale_item_id" AND item."held_sale_id" = NEW."sale_draft_id"
      WHERE line."plan_id" = NEW."id" AND (
        item."id" IS NULL OR line."product_id" IS DISTINCT FROM item."product_id"
        OR line."variation_id" IS DISTINCT FROM item."variation_id"
        OR line."quantity" IS DISTINCT FROM item."quantity"
        OR line."unit_price_cents" IS DISTINCT FROM item."unit_price_cents"
        OR line."base_discount_cents" IS DISTINCT FROM item."discount_cents"
      )
    )
  THEN
    RAISE EXCEPTION 'quoted payment plan requires exact contiguous relational quote lines and zero slots' USING ERRCODE = '23514';
  END IF;
  PERFORM "validate_pos_payment_plan_promotion"(plan_record);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "pos_payment_plan_quote_commit_guard"
AFTER INSERT ON "pos_payment_plans"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "validate_quoted_pos_payment_plan_commit"();

CREATE FUNCTION "authorize_pos_payment_plan_artifact"() RETURNS trigger AS $$
DECLARE plan_record "pos_payment_plans"%ROWTYPE;
DECLARE slot_record "pos_payment_plan_slots"%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'pos_payment_intents' THEN
    NEW."lifecycle_txid" := txid_current()::numeric;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW."payment_plan_id", NEW."payment_index") IS DISTINCT FROM ROW(OLD."payment_plan_id", OLD."payment_index") THEN
      RAISE EXCEPTION 'pos payment artifact plan/slot identity is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD."payment_plan_id" IS NULL THEN
      RETURN NEW;
    END IF;
  END IF;
  IF NEW."payment_plan_id" IS NULL THEN
    RAISE EXCEPTION 'new pos payment artifacts require an authoritative plan' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO plan_record FROM "pos_payment_plans" WHERE "id" = NEW."payment_plan_id";
  IF TG_OP = 'INSERT' AND plan_record."state" = 'active' THEN
    PERFORM 1 FROM "cash_register_sessions" session
    WHERE session."id" = plan_record."session_id" AND session."register_id" = plan_record."register_id"
      AND session."operator_profile_id" = plan_record."operator_profile_id" AND session."status" = 'open'
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'pos payment artifact session is no longer open in its authoritative context' USING ERRCODE = '23514';
    END IF;
    PERFORM 1 FROM "pos_terminals" terminal
    WHERE terminal."id" = plan_record."terminal_id" AND terminal."register_id" = plan_record."register_id"
      AND terminal."status" = 'online' AND terminal."paired_at" IS NOT NULL AND terminal."revoked_at" IS NULL
      AND terminal."token_hash" IS NOT NULL AND terminal."token_expires_at" > clock_timestamp()
      AND terminal."last_seen_at" > clock_timestamp() - INTERVAL '5 minutes' AND NULLIF(btrim(terminal."app_version"), '') IS NOT NULL
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'pos payment artifact terminal is no longer operational' USING ERRCODE = '23514';
    END IF;
    PERFORM "assert_pos_payment_plan_live_access"(plan_record);
  END IF;
  IF TG_OP = 'INSERT' AND plan_record."state" = 'active' AND plan_record."order_claim_id" IS NOT NULL THEN
    PERFORM 1 FROM "pos_order_claims" c
    WHERE c."id" = plan_record."order_claim_id" AND c."id" = plan_record."sale_draft_id"
      AND c."branch_id" = plan_record."branch_id" AND c."register_id" = plan_record."register_id"
      AND c."session_id" = plan_record."session_id" AND c."operator_profile_id" = plan_record."operator_profile_id"
      AND c."terminal_id" = plan_record."terminal_id" AND c."state" = 'active' AND c."lease_expires_at" > clock_timestamp()
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'pos payment artifact order claim is no longer active for this terminal' USING ERRCODE = '23514';
    END IF;
  END IF;
  -- INSERTs acquire the complete parent graph before the plan. Existing artifact
  -- updates are observational lifecycle writes (callback/reconciliation/worker)
  -- and must not take a reverse intent -> draft -> plan lock after PostgreSQL has
  -- already locked the intent row. Their immutable tuple is checked below.
  IF TG_OP = 'INSERT' AND plan_record."id" IS NOT NULL THEN
    PERFORM 1 FROM "pos_held_sales" WHERE "id" = plan_record."sale_draft_id" FOR UPDATE;
    SELECT * INTO plan_record FROM "pos_payment_plans" WHERE "id" = NEW."payment_plan_id" FOR UPDATE;
  END IF;
  SELECT * INTO slot_record FROM "pos_payment_plan_slots" WHERE "plan_id" = NEW."payment_plan_id" AND "payment_index" = NEW."payment_index";
  IF TG_OP = 'INSERT' AND TG_TABLE_NAME = 'pos_payment_intents' THEN
    PERFORM 1 FROM "pos_connectors" WHERE "id" = slot_record."connector_id" FOR SHARE;
    PERFORM 1 FROM "integration_credentials" WHERE "id" = slot_record."credential_ref" FOR SHARE;
  END IF;
  IF plan_record."id" IS NULL OR slot_record."plan_id" IS NULL
    OR (TG_OP = 'INSERT' AND (plan_record."state" <> 'active' OR plan_record."expires_at" <= clock_timestamp()))
    OR (TG_OP = 'UPDATE' AND plan_record."state" NOT IN ('active', 'consumed', 'superseded', 'expired'))
  THEN
    RAISE EXCEPTION 'pos payment plan is absent or does not authorize this artifact write' USING ERRCODE = '23514';
  END IF;
  IF NEW."branch_id" IS DISTINCT FROM plan_record."branch_id" OR NEW."register_id" IS DISTINCT FROM plan_record."register_id" OR NEW."session_id" IS DISTINCT FROM plan_record."session_id"
    OR NEW."sale_draft_id" IS DISTINCT FROM plan_record."sale_draft_id" OR NEW."method" IS DISTINCT FROM slot_record."method" OR NEW."amount_cents" IS DISTINCT FROM slot_record."amount_cents"
    OR NEW."installments" IS DISTINCT FROM slot_record."installments" THEN
    RAISE EXCEPTION 'pos payment artifact diverges from authoritative plan slot' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'pos_payment_intents' THEN
    IF slot_record."proof_kind" IS DISTINCT FROM 'intent' OR NEW."operator_profile_id" IS DISTINCT FROM plan_record."operator_profile_id"
      OR NEW."terminal_id" IS DISTINCT FROM plan_record."terminal_id" OR NEW."connector_id" IS DISTINCT FROM slot_record."connector_id" OR NEW."provider" IS DISTINCT FROM slot_record."provider"
      OR NEW."credential_ref" IS DISTINCT FROM slot_record."credential_ref" OR NEW."expires_at" > plan_record."expires_at"
      OR TG_OP = 'INSERT' AND NOT EXISTS (
        SELECT 1 FROM "pos_connectors" connector
        JOIN "integration_credentials" credential ON credential."id" = connector."credential_ref"
        JOIN "integration_providers" credential_provider ON credential_provider."id" = credential."provider_id"
        WHERE connector."id" = slot_record."connector_id" AND connector."branch_id" = plan_record."branch_id"
          AND connector."provider" = slot_record."provider" AND connector."credential_ref" = slot_record."credential_ref"
          AND connector."status" = 'active' AND connector."type" LIKE 'payment%'
          AND (connector."register_id" IS NULL OR connector."register_id" = plan_record."register_id")
          AND credential."enabled" = true AND credential."provider_id" = slot_record."provider" AND credential_provider."family" = 'payment'
          AND CASE
            WHEN NOT COALESCE(connector."settings" ? 'methods', false) OR connector."settings"->'methods' = 'null'::jsonb THEN true
            WHEN jsonb_typeof(connector."settings"->'methods') IS DISTINCT FROM 'array' THEN false
            ELSE connector."settings"->'methods' ? slot_record."method"
              AND NOT EXISTS (
                SELECT 1 FROM jsonb_array_elements(connector."settings"->'methods') configured_method
                WHERE jsonb_typeof(configured_method) IS DISTINCT FROM 'string'
                  OR configured_method #>> '{}' NOT IN ('pix', 'credit', 'debit', 'voucher')
              )
          END
      ) THEN
      RAISE EXCEPTION 'pos payment intent diverges from authoritative plan context' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'INSERT' AND (
      NEW."status" <> 'created' OR NEW."version" <> 0 OR NEW."provider_reference" IS NOT NULL OR NEW."transaction_id" IS NOT NULL
      OR NEW."end_to_end_id" IS NOT NULL OR NEW."nsu" IS NOT NULL OR NEW."authorization_code" IS NOT NULL OR NEW."card_brand" IS NOT NULL
      OR NEW."card_last_four" IS NOT NULL OR NEW."evidence_id" IS NOT NULL OR NEW."failure_code" IS NOT NULL OR NEW."failure_message" IS NOT NULL
      OR NEW."provider_sequence" IS NOT NULL OR NEW."provider_occurred_at" IS NOT NULL OR NEW."unknown_since" IS NOT NULL
      OR NEW."next_reconcile_at" IS NOT NULL OR NEW."consumed_at" IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'pos payment intent must originate as pristine created version zero' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'pos_manual_payment_references' THEN
    IF slot_record."proof_kind" IS DISTINCT FROM 'manual' OR NEW."requester_profile_id" IS DISTINCT FROM plan_record."operator_profile_id"
      OR NEW."quote_hash" IS DISTINCT FROM plan_record."quote_hash" OR NEW."provider" IS DISTINCT FROM slot_record."provider" THEN
      RAISE EXCEPTION 'pos manual reference diverges from authoritative plan context' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "pos_payment_intents_authoritative_plan_guard" BEFORE INSERT OR UPDATE ON "pos_payment_intents" FOR EACH ROW EXECUTE FUNCTION "authorize_pos_payment_plan_artifact"();
CREATE TRIGGER "pos_manual_payment_references_authoritative_plan_guard" BEFORE INSERT OR UPDATE ON "pos_manual_payment_references" FOR EACH ROW EXECUTE FUNCTION "authorize_pos_payment_plan_artifact"();

CREATE FUNCTION "stamp_pos_payment_state_event_txid"() RETURNS trigger AS $$
BEGIN
  NEW."write_txid" := txid_current()::numeric;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "pos_payment_state_events_txid_guard"
BEFORE INSERT ON "pos_payment_state_events"
FOR EACH ROW EXECUTE FUNCTION "stamp_pos_payment_state_event_txid"();

CREATE FUNCTION "validate_pos_payment_intent_graph_commit"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NOT EXISTS (
    SELECT 1
    FROM "pos_payment_attempts" attempt
    JOIN "pos_payment_outbox" outbox ON outbox."attempt_id" = attempt."id"
    JOIN "pos_payment_state_events" event ON event."intent_id" = NEW."id" AND event."resulting_version" = 0
    WHERE attempt."intent_id" = NEW."id" AND attempt."sequence" = 1 AND attempt."operation" = 'create'
      AND attempt."state" = 'queued' AND attempt."operation_key" = NEW."idempotency_key"
      AND attempt."provider_idempotency_key" = NEW."idempotency_key" AND attempt."request_hash" = NEW."request_hash"
      AND attempt."dispatch_count" = 0 AND attempt."outcome_unknown" = false AND attempt."started_at" IS NULL AND attempt."finished_at" IS NULL
      AND outbox."state" = 'pending' AND outbox."delivery_count" = 0 AND outbox."claim_token" IS NULL AND outbox."completed_at" IS NULL
      AND event."from_state" IS NULL AND event."to_state" = 'created' AND event."source" = 'api'
      AND event."source_id" = NEW."idempotency_key" AND event."write_txid" = NEW."lifecycle_txid"
  ) THEN
    RAISE EXCEPTION 'new pos payment intent requires its exact initial attempt/outbox/state-event graph' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND NOT EXISTS (
    SELECT 1 FROM "pos_payment_state_events" event
    WHERE event."intent_id" = NEW."id" AND event."resulting_version" = NEW."version"
      AND event."from_state" = OLD."status" AND event."to_state" = NEW."status"
      AND event."write_txid" = NEW."lifecycle_txid"
      AND (
        OLD."status" = 'captured'
        OR NEW."status" <> 'captured'
        OR event."source" = 'worker' AND event."attempt_id" IS NOT NULL AND EXISTS (
          SELECT 1 FROM "pos_payment_delivery_results" delivery
          WHERE delivery."intent_id" = NEW."id" AND delivery."attempt_id" = event."attempt_id"
            AND delivery."result_kind" = 'result' AND delivery."resulting_intent_state" = 'captured'
            AND delivery."resulting_intent_version" = NEW."version"
        )
        OR event."source" = 'callback' AND EXISTS (
          SELECT 1 FROM "pos_payment_callbacks" callback
          WHERE callback."intent_id" = NEW."id" AND callback."event_id" = event."source_id"
            AND callback."reported_state" = 'captured' AND callback."resulting_state" = 'captured'
            AND callback."resulting_version" = NEW."version"
        )
      )
  ) THEN
    RAISE EXCEPTION 'pos payment intent transition requires its exact same-transaction state-event provenance' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "pos_payment_intents_graph_commit_guard"
AFTER INSERT OR UPDATE ON "pos_payment_intents"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "validate_pos_payment_intent_graph_commit"();

CREATE FUNCTION "validate_pos_payment_state_event_commit"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "pos_payment_intents" intent
    WHERE intent."id" = NEW."intent_id" AND intent."version" = NEW."resulting_version"
      AND intent."status" = NEW."to_state" AND intent."lifecycle_txid" = NEW."write_txid"
  ) THEN
    RAISE EXCEPTION 'pos payment state event does not match the exact same-transaction intent version/state' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "pos_payment_state_events_intent_commit_guard"
AFTER INSERT ON "pos_payment_state_events"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "validate_pos_payment_state_event_commit"();

CREATE FUNCTION "authorize_pos_sale_payment_plan_slot"() RETURNS trigger AS $$
DECLARE plan_record "pos_payment_plans"%ROWTYPE;
DECLARE slot_record "pos_payment_plan_slots"%ROWTYPE;
DECLARE proof_status_valid BOOLEAN;
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(NEW."value_reservation_id", NEW."value_capture_entry_id", NEW."value_amount_units")
    IS DISTINCT FROM ROW(OLD."value_reservation_id", OLD."value_capture_entry_id", OLD."value_amount_units")
  THEN
    RAISE EXCEPTION 'pos sale payment value proof identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW."type" <> 'payment' THEN
    IF NEW."payment_plan_id" IS NOT NULL OR NEW."payment_index" IS NOT NULL
      OR NEW."value_reservation_id" IS NOT NULL OR NEW."value_capture_entry_id" IS NOT NULL OR NEW."value_amount_units" IS NOT NULL
    THEN
      RAISE EXCEPTION 'refund/adjustment rows must not claim authoritative plan or value proof fields' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."payment_plan_id" IS NULL AND NEW."payment_plan_id" IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW."payment_plan_id" IS NULL OR NEW."payment_index" IS NULL THEN
    RAISE EXCEPTION 'new pos sale payments require an authoritative plan slot' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND ROW(NEW."payment_plan_id", NEW."payment_index") IS DISTINCT FROM ROW(OLD."payment_plan_id", OLD."payment_index") THEN
    RAISE EXCEPTION 'pos sale payment plan slot is immutable' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO plan_record FROM "pos_payment_plans" WHERE "id" = NEW."payment_plan_id" FOR UPDATE;
  SELECT * INTO slot_record FROM "pos_payment_plan_slots" WHERE "plan_id" = NEW."payment_plan_id" AND "payment_index" = NEW."payment_index";
  IF plan_record."id" IS NULL OR plan_record."state" NOT IN ('active', 'consumed') OR slot_record."plan_id" IS NULL
    OR NEW."type" IS DISTINCT FROM 'payment' OR NEW."method" IS DISTINCT FROM slot_record."method" OR NEW."amount_cents" IS DISTINCT FROM slot_record."amount_cents" OR NEW."installments" IS DISTINCT FROM slot_record."installments"
    OR NOT EXISTS (
      SELECT 1 FROM "sales" s WHERE s."id" = NEW."sale_id"
        AND s."branch_id" = plan_record."branch_id" AND s."session_id" = plan_record."session_id"
        AND s."operator_profile_id" = plan_record."operator_profile_id"
        AND s."idempotency_key" = plan_record."sale_draft_id"
    )
  THEN
    RAISE EXCEPTION 'pos sale payment diverges from authoritative plan slot' USING ERRCODE = '23514';
  END IF;
  proof_status_valid := CASE
    WHEN slot_record."proof_kind" = 'manual' THEN NEW."status" = 'manual_confirmed'
      OR TG_OP = 'UPDATE' AND OLD."status" IN ('manual_confirmed', 'partially_refunded') AND NEW."status" IN ('partially_refunded', 'refunded')
    ELSE NEW."status" = 'captured'
      OR TG_OP = 'UPDATE' AND OLD."status" IN ('captured', 'partially_refunded') AND NEW."status" IN ('partially_refunded', 'refunded')
  END;
  IF slot_record."proof_kind" = 'cash' AND NOT (
    proof_status_valid AND NEW."provider" = 'cash' AND NEW."tendered_cents" >= NEW."amount_cents"
    AND NEW."change_cents" = NEW."tendered_cents" - NEW."amount_cents" AND NEW."payment_intent_id" IS NULL
    AND NEW."value_reservation_id" IS NULL AND NEW."value_capture_entry_id" IS NULL AND NEW."value_amount_units" IS NULL
  ) THEN
    RAISE EXCEPTION 'cash sale payment lacks exact captured tender/change proof' USING ERRCODE = '23514';
  END IF;
  IF slot_record."proof_kind" = 'value' AND NOT (
    proof_status_valid AND NEW."provider" = 'pos_value' AND NEW."tendered_cents" = NEW."amount_cents" AND NEW."change_cents" = 0
    AND NEW."payment_intent_id" IS NULL AND NEW."value_reservation_id" IS NOT NULL AND NEW."value_capture_entry_id" IS NOT NULL
    AND NEW."value_amount_units" IS NOT NULL AND NEW."value_amount_units" > 0
    AND EXISTS (
      SELECT 1 FROM "pos_value_reservations" reservation
      JOIN "pos_value_ledger_entries" capture ON capture."id" = NEW."value_capture_entry_id"
      JOIN "pos_value_accounts" account ON account."id" = reservation."account_id"
      LEFT JOIN "pos_value_programs" program ON program."id" = account."program_id"
      WHERE reservation."id" = NEW."value_reservation_id" AND reservation."account_id" = capture."account_id"
        AND reservation."branch_id" = plan_record."branch_id" AND reservation."state" = 'completed'
        AND reservation."reference_type" = 'sale_draft' AND reservation."reference_id" = plan_record."sale_draft_id"
        AND reservation."operation_key" = plan_record."sale_draft_id" || ':value:' || NEW."payment_index"::text || ':reserve'
        AND capture."reservation_id" = reservation."id" AND capture."type" = 'capture'
        AND capture."amount_units" = NEW."value_amount_units" AND capture."balance_delta_units" = -NEW."value_amount_units"
        AND capture."reserved_delta_units" = -NEW."value_amount_units" AND capture."reference_type" = 'sale_draft'
        AND capture."reference_id" = plan_record."sale_draft_id"
        AND capture."operation_key" = plan_record."sale_draft_id" || ':value:' || NEW."payment_index"::text || ':capture'
        AND account."branch_id" = plan_record."branch_id"
        AND (
          account."unit" = 'cents' AND NEW."value_amount_units" = NEW."amount_cents"
          OR account."kind" = 'loyalty_points' AND program."redeem_cents_per_unit" > 0
            AND NEW."value_amount_units" * program."redeem_cents_per_unit" = NEW."amount_cents"
        )
    )
  ) THEN
    RAISE EXCEPTION 'value sale payment lacks exact reservation/capture ledger proof' USING ERRCODE = '23514';
  END IF;
  IF slot_record."proof_kind" = 'intent' AND NOT (
    proof_status_valid AND NEW."provider" = slot_record."provider" AND NEW."tendered_cents" = NEW."amount_cents" AND NEW."change_cents" = 0
    AND NEW."payment_intent_id" IS NOT NULL AND NEW."value_reservation_id" IS NULL AND NEW."value_capture_entry_id" IS NULL AND NEW."value_amount_units" IS NULL
    AND EXISTS (
      SELECT 1 FROM "pos_payment_intents" intent
      WHERE intent."id" = NEW."payment_intent_id" AND intent."payment_plan_id" = NEW."payment_plan_id"
        AND intent."payment_index" = NEW."payment_index" AND intent."status" = 'captured'
        AND intent."provider_reference" IS NOT NULL AND intent."provider_occurred_at" IS NOT NULL
    )
  ) THEN
    RAISE EXCEPTION 'intent sale payment lacks exact captured provider proof' USING ERRCODE = '23514';
  END IF;
  IF slot_record."proof_kind" = 'manual' AND NOT (
    proof_status_valid AND NEW."provider" = slot_record."provider" AND NEW."tendered_cents" = NEW."amount_cents" AND NEW."change_cents" = 0
    AND NEW."payment_intent_id" IS NULL AND NEW."value_reservation_id" IS NULL AND NEW."value_capture_entry_id" IS NULL AND NEW."value_amount_units" IS NULL
  ) THEN
    RAISE EXCEPTION 'manual sale payment lacks its exact external proof shape' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "pos_sale_payments_authoritative_plan_guard" BEFORE INSERT OR UPDATE ON "pos_sale_payments" FOR EACH ROW EXECUTE FUNCTION "authorize_pos_sale_payment_plan_slot"();

CREATE FUNCTION "protect_held_sale_with_open_payment_plan"() RETURNS trigger AS $$
BEGIN
  IF (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at')
    AND EXISTS (SELECT 1 FROM "pos_payment_plans" p WHERE p."sale_draft_id" = OLD."id" AND p."state" IN ('quoted', 'active')) THEN
    RAISE EXCEPTION 'held sale has an open authoritative payment plan' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "pos_held_sales_payment_plan_guard" BEFORE UPDATE ON "pos_held_sales" FOR EACH ROW EXECUTE FUNCTION "protect_held_sale_with_open_payment_plan"();

CREATE FUNCTION "protect_held_sale_item_with_open_payment_plan"() RETURNS trigger AS $$
DECLARE
  old_held_sale_id TEXT;
  new_held_sale_id TEXT;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN old_held_sale_id := OLD."held_sale_id"; END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN new_held_sale_id := NEW."held_sale_id"; END IF;
  PERFORM d."id" FROM "pos_held_sales" d
  WHERE d."id" = old_held_sale_id OR d."id" = new_held_sale_id
  ORDER BY d."id"
  FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM "pos_payment_plans" p
    WHERE p."state" IN ('quoted', 'active')
      AND (p."sale_draft_id" = old_held_sale_id OR p."sale_draft_id" = new_held_sale_id)
  ) THEN
    RAISE EXCEPTION 'held sale item belongs to an open authoritative payment plan' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "pos_held_sale_items_payment_plan_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "pos_held_sale_items"
FOR EACH ROW EXECUTE FUNCTION "protect_held_sale_item_with_open_payment_plan"();

CREATE FUNCTION "protect_session_with_open_payment_plan"() RETURNS trigger AS $$
BEGIN
  IF ROW(NEW."operator_profile_id", NEW."register_id", NEW."status")
    IS DISTINCT FROM ROW(OLD."operator_profile_id", OLD."register_id", OLD."status")
    AND EXISTS (
      SELECT 1 FROM "pos_payment_plans" p
      WHERE p."session_id" = OLD."id" AND p."state" IN ('quoted', 'active')
    )
  THEN
    RAISE EXCEPTION 'open authoritative payment plan blocks session close, suspension or operator handoff' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "cash_register_sessions_payment_plan_guard"
BEFORE UPDATE OF "operator_profile_id", "register_id", "status" ON "cash_register_sessions"
FOR EACH ROW EXECUTE FUNCTION "protect_session_with_open_payment_plan"();

CREATE FUNCTION "validate_consumed_pos_payment_plan"() RETURNS trigger AS $$
DECLARE sale_record "sales"%ROWTYPE;
DECLARE slot_count INTEGER;
DECLARE payment_count INTEGER;
DECLARE payment_sum BIGINT;
DECLARE cash_change BIGINT;
DECLARE quote_line_count INTEGER;
DECLARE sale_item_count INTEGER;
BEGIN
  IF NEW."state" = 'consumed' AND OLD."state" = 'active' THEN
    SELECT * INTO sale_record FROM "sales" WHERE "id" = NEW."consumed_sale_id";
    SELECT COUNT(*) INTO slot_count FROM "pos_payment_plan_slots" WHERE "plan_id" = NEW."id";
    SELECT COUNT(*) INTO quote_line_count FROM "pos_payment_plan_quote_lines" WHERE "plan_id" = NEW."id";
    SELECT COUNT(*) INTO sale_item_count FROM "sale_items" WHERE "sale_id" = NEW."consumed_sale_id";
    SELECT COUNT(*), COALESCE(SUM("amount_cents"), 0) INTO payment_count, payment_sum
      FROM "pos_sale_payments" WHERE "payment_plan_id" = NEW."id" AND "sale_id" = NEW."consumed_sale_id" AND "type" = 'payment';
    SELECT COALESCE(SUM(payment."change_cents"), 0) INTO cash_change
      FROM "pos_sale_payments" payment
      JOIN "pos_payment_plan_slots" slot ON slot."plan_id" = payment."payment_plan_id" AND slot."payment_index" = payment."payment_index"
      WHERE payment."payment_plan_id" = NEW."id" AND payment."sale_id" = NEW."consumed_sale_id" AND slot."proof_kind" = 'cash';
    IF NEW."expires_at" <= clock_timestamp()
      OR sale_record."id" IS NULL OR sale_record."idempotency_key" IS DISTINCT FROM NEW."sale_draft_id"
      OR sale_record."branch_id" IS DISTINCT FROM NEW."branch_id" OR sale_record."session_id" IS DISTINCT FROM NEW."session_id"
      OR sale_record."operator_profile_id" IS DISTINCT FROM NEW."operator_profile_id" OR sale_record."total_cents" IS DISTINCT FROM NEW."total_cents"
      OR sale_record."change_cents" IS DISTINCT FROM cash_change
      OR quote_line_count <> sale_item_count
      OR sale_record."subtotal_cents" IS DISTINCT FROM (
        SELECT COALESCE(SUM(line."gross_cents" - line."base_discount_cents"), 0) FROM "pos_payment_plan_quote_lines" line WHERE line."plan_id" = NEW."id"
      )
      OR sale_record."discount_cents" IS DISTINCT FROM (
        SELECT COALESCE(SUM(line."order_discount_cents" + line."promotion_discount_cents"), 0) FROM "pos_payment_plan_quote_lines" line WHERE line."plan_id" = NEW."id"
      )
      OR sale_record."surcharge_cents" IS DISTINCT FROM (
        SELECT COALESCE(SUM(line."surcharge_cents"), 0) FROM "pos_payment_plan_quote_lines" line WHERE line."plan_id" = NEW."id"
      )
      OR EXISTS (
        SELECT 1 FROM (
          (
            SELECT line."product_id", line."variation_id", line."quantity", line."unit_price_cents", line."gross_cents",
              line."base_discount_cents" + line."order_discount_cents" + line."promotion_discount_cents" AS "discount_cents",
              line."surcharge_cents", line."total_cents"
            FROM "pos_payment_plan_quote_lines" line WHERE line."plan_id" = NEW."id"
            EXCEPT ALL
            SELECT item."product_id", item."variation_id", item."quantity", item."unit_price_cents", item."gross_cents",
              item."discount_cents", item."surcharge_cents", item."total_cents"
            FROM "sale_items" item WHERE item."sale_id" = NEW."consumed_sale_id"
          )
          UNION ALL
          (
            SELECT item."product_id", item."variation_id", item."quantity", item."unit_price_cents", item."gross_cents",
              item."discount_cents", item."surcharge_cents", item."total_cents"
            FROM "sale_items" item WHERE item."sale_id" = NEW."consumed_sale_id"
            EXCEPT ALL
            SELECT line."product_id", line."variation_id", line."quantity", line."unit_price_cents", line."gross_cents",
              line."base_discount_cents" + line."order_discount_cents" + line."promotion_discount_cents" AS "discount_cents",
              line."surcharge_cents", line."total_cents"
            FROM "pos_payment_plan_quote_lines" line WHERE line."plan_id" = NEW."id"
          )
        ) financial_multiset_mismatch
      )
      OR (NEW."promotion_id" IS NULL AND EXISTS (SELECT 1 FROM "pos_promotion_redemptions" redemption WHERE redemption."sale_id" = NEW."consumed_sale_id" AND redemption."reversed_at" IS NULL))
      OR (NEW."promotion_id" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "pos_promotion_redemptions" redemption WHERE redemption."sale_id" = NEW."consumed_sale_id"
          AND redemption."promotion_id" = NEW."promotion_id" AND redemption."coupon_id" IS NOT DISTINCT FROM NEW."coupon_id"
          AND redemption."discount_cents" = NEW."promotion_discount_cents" AND redemption."reversed_at" IS NULL
      ))
      OR payment_count <> slot_count OR payment_sum <> NEW."total_cents"
      OR EXISTS (SELECT 1 FROM "pos_sale_payments" p WHERE p."payment_plan_id" = NEW."id" AND p."sale_id" <> NEW."consumed_sale_id")
      OR EXISTS (
        SELECT 1
        FROM "pos_payment_plan_slots" slot
        LEFT JOIN "pos_sale_payments" payment
          ON payment."payment_plan_id" = slot."plan_id" AND payment."payment_index" = slot."payment_index" AND payment."sale_id" = NEW."consumed_sale_id"
        WHERE slot."plan_id" = NEW."id" AND (
          payment."id" IS NULL
          OR (slot."proof_kind" = 'intent' AND (
            payment."payment_intent_id" IS NULL OR NOT EXISTS (
              SELECT 1 FROM "pos_payment_intents" intent
              WHERE intent."id" = payment."payment_intent_id" AND intent."payment_plan_id" = slot."plan_id"
                AND intent."payment_index" = slot."payment_index" AND intent."status" = 'captured' AND intent."consumed_at" IS NOT NULL
            )
          ))
          OR (slot."proof_kind" = 'manual' AND NOT EXISTS (
            SELECT 1 FROM "pos_manual_payment_references" manual
            WHERE manual."payment_plan_id" = slot."plan_id" AND manual."payment_index" = slot."payment_index"
              AND manual."status" = 'consumed' AND manual."consumed_sale_payment_id" = payment."id" AND manual."consumed_at" IS NOT NULL
          ))
          OR (slot."proof_kind" = 'cash' AND NOT (
            payment."status" = 'captured' AND payment."provider" = 'cash' AND payment."tendered_cents" >= payment."amount_cents"
            AND payment."change_cents" = payment."tendered_cents" - payment."amount_cents" AND payment."payment_intent_id" IS NULL
            AND payment."value_reservation_id" IS NULL AND payment."value_capture_entry_id" IS NULL AND payment."value_amount_units" IS NULL
          ))
          OR (slot."proof_kind" = 'value' AND (
            payment."status" IS DISTINCT FROM 'captured' OR payment."provider" IS DISTINCT FROM 'pos_value'
            OR payment."tendered_cents" IS DISTINCT FROM payment."amount_cents" OR payment."change_cents" IS DISTINCT FROM 0
            OR payment."payment_intent_id" IS NOT NULL OR payment."value_reservation_id" IS NULL
            OR payment."value_capture_entry_id" IS NULL OR payment."value_amount_units" IS NULL
          ))
          OR (slot."proof_kind" IN ('cash', 'value') AND EXISTS (
              SELECT 1 FROM "pos_manual_payment_references" manual WHERE manual."consumed_sale_payment_id" = payment."id"
          ))
        )
      )
    THEN
      RAISE EXCEPTION 'consumed pos payment plan does not exactly match sale payments' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "pos_payment_plans_consumption_guard" BEFORE UPDATE ON "pos_payment_plans" FOR EACH ROW EXECUTE FUNCTION "validate_consumed_pos_payment_plan"();

CREATE FUNCTION "protect_sale_bound_to_consumed_payment_plan"() RETURNS trigger AS $$
BEGIN
  IF ROW(NEW."branch_id", NEW."session_id", NEW."operator_profile_id", NEW."idempotency_key", NEW."request_hash", NEW."payment_method",
      NEW."subtotal_cents", NEW."discount_cents", NEW."surcharge_cents", NEW."total_cents", NEW."change_cents")
    IS DISTINCT FROM ROW(OLD."branch_id", OLD."session_id", OLD."operator_profile_id", OLD."idempotency_key", OLD."request_hash", OLD."payment_method",
      OLD."subtotal_cents", OLD."discount_cents", OLD."surcharge_cents", OLD."total_cents", OLD."change_cents")
    AND EXISTS (SELECT 1 FROM "pos_payment_plans" plan WHERE plan."consumed_sale_id" = OLD."id" AND plan."state" = 'consumed')
  THEN
    RAISE EXCEPTION 'sale financial/context identity is frozen by its consumed payment plan' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "sales_consumed_payment_plan_guard"
BEFORE UPDATE ON "sales"
FOR EACH ROW EXECUTE FUNCTION "protect_sale_bound_to_consumed_payment_plan"();

CREATE FUNCTION "protect_sale_item_bound_to_consumed_payment_plan"() RETURNS trigger AS $$
DECLARE target_sale_id INTEGER;
BEGIN
  target_sale_id := CASE WHEN TG_OP = 'INSERT' THEN NEW."sale_id" ELSE OLD."sale_id" END;
  IF EXISTS (SELECT 1 FROM "pos_payment_plans" plan WHERE plan."consumed_sale_id" = target_sale_id AND plan."state" = 'consumed')
    AND (
      TG_OP IN ('INSERT', 'DELETE')
      OR ROW(NEW."sale_id", NEW."product_id", NEW."variation_id", NEW."quantity", NEW."unit_price_cents", NEW."gross_cents", NEW."discount_cents", NEW."surcharge_cents", NEW."total_cents")
        IS DISTINCT FROM ROW(OLD."sale_id", OLD."product_id", OLD."variation_id", OLD."quantity", OLD."unit_price_cents", OLD."gross_cents", OLD."discount_cents", OLD."surcharge_cents", OLD."total_cents")
    )
  THEN
    RAISE EXCEPTION 'sale item financial identity is frozen by its consumed payment plan' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "sale_items_consumed_payment_plan_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "sale_items"
FOR EACH ROW EXECUTE FUNCTION "protect_sale_item_bound_to_consumed_payment_plan"();

CREATE FUNCTION "validate_sale_authoritative_payment_plan_commit"() RETURNS trigger AS $$
BEGIN
  IF NEW."idempotency_key" IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM "pos_payment_plans" plan WHERE plan."sale_draft_id" = NEW."idempotency_key"
    )
    AND NOT EXISTS (
      SELECT 1 FROM "pos_payment_plans" plan
      WHERE plan."sale_draft_id" = NEW."idempotency_key"
        AND plan."state" = 'consumed' AND plan."consumed_sale_id" = NEW."id"
    )
  THEN
    RAISE EXCEPTION 'sale bound to an authoritative payment plan must consume that exact plan atomically' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "sales_authoritative_payment_plan_commit_guard"
AFTER INSERT OR UPDATE ON "sales"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "validate_sale_authoritative_payment_plan_commit"();

CREATE FUNCTION "validate_sale_payment_authoritative_plan_commit"() RETURNS trigger AS $$
BEGIN
  IF NEW."payment_plan_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "pos_payment_plans" plan
    WHERE plan."id" = NEW."payment_plan_id" AND plan."state" = 'consumed'
      AND plan."consumed_sale_id" = NEW."sale_id"
  ) THEN
    RAISE EXCEPTION 'sale payment authoritative plan must be consumed by the same sale atomically' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "pos_sale_payments_authoritative_plan_commit_guard"
AFTER INSERT OR UPDATE ON "pos_sale_payments"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "validate_sale_payment_authoritative_plan_commit"();

CREATE FUNCTION "validate_consumed_intent_authoritative_plan_commit"() RETURNS trigger AS $$
BEGIN
  IF NEW."consumed_at" IS NOT NULL AND NEW."payment_plan_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM "pos_sale_payments" payment
    JOIN "pos_payment_plans" plan ON plan."id" = NEW."payment_plan_id"
    WHERE payment."payment_intent_id" = NEW."id"
      AND payment."payment_plan_id" = NEW."payment_plan_id"
      AND payment."payment_index" = NEW."payment_index"
      AND payment."type" = 'payment'
      AND plan."state" = 'consumed' AND plan."consumed_sale_id" = payment."sale_id"
  ) THEN
    RAISE EXCEPTION 'consumed payment intent requires its exact sale payment and plan consumption atomically' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "pos_payment_intents_consumed_plan_commit_guard"
AFTER INSERT OR UPDATE ON "pos_payment_intents"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "validate_consumed_intent_authoritative_plan_commit"();
