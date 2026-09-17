-- POS foundation: registers, operators, shifts, payments, returns, devices and offline sync.
-- Legacy Float columns remain temporarily for backwards-compatible reports; all new writes
-- also persist exact integer cents and the migration backfills existing rows.

ALTER TABLE "sales"
  ADD COLUMN "session_id" INTEGER,
  ADD COLUMN "customer_id" INTEGER,
  ADD COLUMN "operator_profile_id" INTEGER,
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'completed',
  ADD COLUMN "subtotal_cents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "discount_cents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "surcharge_cents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "total_cents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "change_cents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "idempotency_key" TEXT,
  ADD COLUMN "request_hash" TEXT,
  ADD COLUMN "notes" TEXT,
  ADD COLUMN "cancelled_reason" TEXT,
  ADD COLUMN "cancelled_by" TEXT,
  ADD COLUMN "cancelled_at" TIMESTAMP(3),
  ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT now();

UPDATE "sales"
SET "subtotal_cents" = CASE WHEN "total"::text NOT IN ('NaN', 'Infinity', '-Infinity') AND "total" BETWEEN 0 AND 21474836.47 THEN ROUND("total"::numeric * 100)::INTEGER ELSE 0 END,
    "total_cents" = CASE WHEN "total"::text NOT IN ('NaN', 'Infinity', '-Infinity') AND "total" BETWEEN 0 AND 21474836.47 THEN ROUND("total"::numeric * 100)::INTEGER ELSE 0 END;

CREATE UNIQUE INDEX "sales_idempotency_key_key" ON "sales"("idempotency_key");
CREATE INDEX "sales_session_id_created_at_idx" ON "sales"("session_id", "created_at");
CREATE INDEX "sales_customer_id_created_at_idx" ON "sales"("customer_id", "created_at");
CREATE INDEX "sales_operator_profile_id_created_at_idx" ON "sales"("operator_profile_id", "created_at");
CREATE INDEX "sales_status_created_at_idx" ON "sales"("status", "created_at");

ALTER TABLE "sale_items"
  ADD COLUMN "sku_snapshot" TEXT,
  ADD COLUMN "gtin_snapshot" TEXT,
  ADD COLUMN "variation_id" INTEGER,
  ADD COLUMN "unit" TEXT NOT NULL DEFAULT 'UN',
  ADD COLUMN "unit_price_cents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "gross_cents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "discount_cents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "surcharge_cents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "total_cents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "scan_data" JSONB,
  ADD COLUMN "returned_quantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "returned_cents" INTEGER NOT NULL DEFAULT 0;

UPDATE "sale_items"
SET "unit_price_cents" = CASE WHEN "unit_price"::text NOT IN ('NaN', 'Infinity', '-Infinity') AND "unit_price" BETWEEN 0 AND 21474836.47 THEN ROUND("unit_price"::numeric * 100)::INTEGER ELSE 0 END,
    "gross_cents" = CASE WHEN "total"::text NOT IN ('NaN', 'Infinity', '-Infinity') AND "total" BETWEEN 0 AND 21474836.47 THEN ROUND("total"::numeric * 100)::INTEGER ELSE 0 END,
    "total_cents" = CASE WHEN "total"::text NOT IN ('NaN', 'Infinity', '-Infinity') AND "total" BETWEEN 0 AND 21474836.47 THEN ROUND("total"::numeric * 100)::INTEGER ELSE 0 END;

ALTER TABLE "sales"
  ALTER COLUMN "subtotal_cents" DROP DEFAULT,
  ALTER COLUMN "discount_cents" DROP DEFAULT,
  ALTER COLUMN "surcharge_cents" DROP DEFAULT,
  ALTER COLUMN "total_cents" DROP DEFAULT,
  ALTER COLUMN "change_cents" DROP DEFAULT;

ALTER TABLE "sale_items"
  ALTER COLUMN "unit_price_cents" DROP DEFAULT,
  ALTER COLUMN "gross_cents" DROP DEFAULT,
  ALTER COLUMN "discount_cents" DROP DEFAULT,
  ALTER COLUMN "surcharge_cents" DROP DEFAULT,
  ALTER COLUMN "total_cents" DROP DEFAULT;

CREATE INDEX "sale_items_sale_id_product_id_idx" ON "sale_items"("sale_id", "product_id");
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_variation_id_fkey" FOREIGN KEY ("variation_id") REFERENCES "product_variations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "cash_register_sessions"
  ADD COLUMN "register_id" INTEGER,
  ADD COLUMN "operator_profile_id" INTEGER,
  ADD COLUMN "opening_amount_cents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "expected_amount_cents" INTEGER,
  ADD COLUMN "closing_amount_cents" INTEGER,
  ADD COLUMN "difference_cents" INTEGER,
  ADD COLUMN "close_notes" TEXT,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "open_idempotency_key" TEXT,
  ADD COLUMN "open_request_hash" TEXT,
  ADD COLUMN "close_idempotency_key" TEXT,
  ADD COLUMN "close_request_hash" TEXT;

UPDATE "cash_register_sessions"
SET "opening_amount_cents" = ROUND("opening_amount" * 100)::INTEGER,
    "expected_amount_cents" = CASE WHEN "expected_amount" IS NULL THEN NULL ELSE ROUND("expected_amount" * 100)::INTEGER END,
    "closing_amount_cents" = CASE WHEN "closing_amount" IS NULL THEN NULL ELSE ROUND("closing_amount" * 100)::INTEGER END,
    "difference_cents" = CASE WHEN "difference" IS NULL THEN NULL ELSE ROUND("difference" * 100)::INTEGER END;

CREATE UNIQUE INDEX "cash_register_sessions_open_idempotency_key_key" ON "cash_register_sessions"("open_idempotency_key");
CREATE UNIQUE INDEX "cash_register_sessions_close_idempotency_key_key" ON "cash_register_sessions"("close_idempotency_key");

ALTER TABLE "cash_register_events"
  ADD COLUMN "amount_cents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "payment_method" TEXT,
  ADD COLUMN "approved_by" TEXT,
  ADD COLUMN "reason_code" TEXT,
  ADD COLUMN "correlation_id" TEXT,
  ADD COLUMN "idempotency_key" TEXT,
  ADD COLUMN "request_hash" TEXT;

UPDATE "cash_register_events" SET "amount_cents" = CASE WHEN "amount"::text NOT IN ('NaN', 'Infinity', '-Infinity') AND abs("amount") BETWEEN 0 AND 21474836.47 THEN ROUND(abs("amount")::numeric * 100)::INTEGER ELSE 0 END;
CREATE UNIQUE INDEX "cash_register_events_idempotency_key_key" ON "cash_register_events"("idempotency_key");

CREATE TABLE "pos_registers" (
  "id" SERIAL PRIMARY KEY,
  "branch_id" INTEGER NOT NULL,
  "warehouse_id" INTEGER,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "settings" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "pos_registers_branch_id_code_key" ON "pos_registers"("branch_id", "code");
CREATE INDEX "pos_registers_branch_id_status_idx" ON "pos_registers"("branch_id", "status");
ALTER TABLE "pos_registers" ADD CONSTRAINT "pos_registers_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pos_registers" ADD CONSTRAINT "pos_registers_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "pos_registers" ("branch_id", "warehouse_id", "code", "name", "settings")
SELECT "id", "default_warehouse_id", 'PRINCIPAL', 'Caixa principal', '{"requireOpenShift":true,"blindClose":true}'::jsonb
FROM "branches"
ON CONFLICT ("branch_id", "code") DO NOTHING;

CREATE TABLE "pos_register_accesses" (
  "id" SERIAL PRIMARY KEY,
  "register_id" INTEGER NOT NULL,
  "user_profile_id" INTEGER NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "can_open" BOOLEAN NOT NULL DEFAULT true,
  "can_close" BOOLEAN NOT NULL DEFAULT true,
  "can_sell" BOOLEAN NOT NULL DEFAULT true,
  "can_supply" BOOLEAN NOT NULL DEFAULT false,
  "can_withdraw" BOOLEAN NOT NULL DEFAULT false,
  "can_cancel" BOOLEAN NOT NULL DEFAULT false,
  "can_refund" BOOLEAN NOT NULL DEFAULT false,
  "can_reprint" BOOLEAN NOT NULL DEFAULT true,
  "can_manual_payment" BOOLEAN NOT NULL DEFAULT false,
  "max_discount_basis_points" INTEGER NOT NULL DEFAULT 0,
  "valid_from" TIMESTAMP(3),
  "valid_until" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT now(),
  CONSTRAINT "pos_register_accesses_register_id_fkey" FOREIGN KEY ("register_id") REFERENCES "pos_registers"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pos_register_accesses_user_profile_id_fkey" FOREIGN KEY ("user_profile_id") REFERENCES "tenant_user_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "pos_register_accesses_register_id_user_profile_id_key" ON "pos_register_accesses"("register_id", "user_profile_id");
CREATE INDEX "pos_register_accesses_user_profile_id_active_idx" ON "pos_register_accesses"("user_profile_id", "active");

CREATE TABLE "pos_terminals" (
  "id" TEXT PRIMARY KEY,
  "register_id" INTEGER NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'unpaired',
  "token_hash" TEXT,
  "certificate_fingerprint" TEXT,
  "app_version" TEXT,
  "settings" JSONB,
  "last_seen_at" TIMESTAMP(3),
  "last_sync_cursor" BIGINT NOT NULL DEFAULT 0,
  "offline_allowed_until" TIMESTAMP(3),
  "paired_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT now(),
  CONSTRAINT "pos_terminals_register_id_fkey" FOREIGN KEY ("register_id") REFERENCES "pos_registers"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "pos_terminals_register_id_code_key" ON "pos_terminals"("register_id", "code");
CREATE INDEX "pos_terminals_status_last_seen_at_idx" ON "pos_terminals"("status", "last_seen_at");

CREATE TABLE "pos_devices" (
  "id" TEXT PRIMARY KEY,
  "terminal_id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "provider" TEXT,
  "vendor_id" TEXT,
  "product_id" TEXT,
  "serial_number" TEXT,
  "status" TEXT NOT NULL DEFAULT 'unknown',
  "capabilities" JSONB,
  "settings" JSONB,
  "last_error" TEXT,
  "last_seen_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT now(),
  CONSTRAINT "pos_devices_terminal_id_fkey" FOREIGN KEY ("terminal_id") REFERENCES "pos_terminals"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "pos_devices_terminal_id_type_name_key" ON "pos_devices"("terminal_id", "type", "name");
CREATE INDEX "pos_devices_terminal_id_status_idx" ON "pos_devices"("terminal_id", "status");

CREATE TABLE "pos_connectors" (
  "id" TEXT PRIMARY KEY,
  "branch_id" INTEGER NOT NULL,
  "register_id" INTEGER,
  "type" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "mode" TEXT NOT NULL DEFAULT 'server',
  "status" TEXT NOT NULL DEFAULT 'inactive',
  "credential_ref" TEXT,
  "settings" JSONB,
  "last_health_ok" BOOLEAN,
  "last_checked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT now(),
  CONSTRAINT "pos_connectors_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pos_connectors_register_id_fkey" FOREIGN KEY ("register_id") REFERENCES "pos_registers"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "pos_connectors_branch_id_register_id_type_provider_key" ON "pos_connectors"("branch_id", "register_id", "type", "provider");
CREATE INDEX "pos_connectors_branch_id_type_status_idx" ON "pos_connectors"("branch_id", "type", "status");

ALTER TABLE "cash_register_sessions" ADD CONSTRAINT "cash_register_sessions_register_id_fkey" FOREIGN KEY ("register_id") REFERENCES "pos_registers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cash_register_sessions" ADD CONSTRAINT "cash_register_sessions_operator_profile_id_fkey" FOREIGN KEY ("operator_profile_id") REFERENCES "tenant_user_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "cash_register_sessions_register_id_status_idx" ON "cash_register_sessions"("register_id", "status");
CREATE INDEX "cash_register_sessions_operator_profile_id_opened_at_idx" ON "cash_register_sessions"("operator_profile_id", "opened_at");

ALTER TABLE "sales" ADD CONSTRAINT "sales_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "cash_register_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "sales" ADD CONSTRAINT "sales_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "sales" ADD CONSTRAINT "sales_operator_profile_id_fkey" FOREIGN KEY ("operator_profile_id") REFERENCES "tenant_user_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "pos_sale_payments" (
  "id" TEXT PRIMARY KEY,
  "sale_id" INTEGER NOT NULL,
  "connector_id" TEXT,
  "original_payment_id" TEXT,
  "processing_session_id" INTEGER,
  "type" TEXT NOT NULL DEFAULT 'payment',
  "method" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'captured',
  "amount_cents" INTEGER NOT NULL,
  "tendered_cents" INTEGER NOT NULL DEFAULT 0,
  "change_cents" INTEGER NOT NULL DEFAULT 0,
  "provider" TEXT,
  "transaction_id" TEXT,
  "end_to_end_id" TEXT,
  "nsu" TEXT,
  "authorization_code" TEXT,
  "card_brand" TEXT,
  "card_last_four" TEXT,
  "installments" INTEGER NOT NULL DEFAULT 1,
  "idempotency_key" TEXT NOT NULL,
  "metadata" JSONB,
  "authorized_at" TIMESTAMP(3),
  "captured_at" TIMESTAMP(3),
  "refunded_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT now(),
  CONSTRAINT "pos_sale_payments_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pos_sale_payments_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "pos_connectors"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "pos_sale_payments_original_payment_id_fkey" FOREIGN KEY ("original_payment_id") REFERENCES "pos_sale_payments"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "pos_sale_payments_processing_session_id_fkey" FOREIGN KEY ("processing_session_id") REFERENCES "cash_register_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "pos_sale_payments_idempotency_key_key" ON "pos_sale_payments"("idempotency_key");
CREATE INDEX "pos_sale_payments_sale_id_status_idx" ON "pos_sale_payments"("sale_id", "status");
CREATE INDEX "pos_sale_payments_processing_session_id_status_idx" ON "pos_sale_payments"("processing_session_id", "status");
CREATE INDEX "pos_sale_payments_provider_transaction_id_idx" ON "pos_sale_payments"("provider", "transaction_id");
CREATE INDEX "pos_sale_payments_end_to_end_id_idx" ON "pos_sale_payments"("end_to_end_id");

CREATE TABLE "pos_sale_events" (
  "id" BIGSERIAL PRIMARY KEY,
  "sale_id" INTEGER NOT NULL,
  "type" TEXT NOT NULL,
  "actor_id" TEXT,
  "actor_name" TEXT NOT NULL,
  "correlation_id" TEXT NOT NULL,
  "causation_id" TEXT,
  "data" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(),
  CONSTRAINT "pos_sale_events_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "pos_sale_events_sale_id_created_at_idx" ON "pos_sale_events"("sale_id", "created_at");
CREATE INDEX "pos_sale_events_correlation_id_idx" ON "pos_sale_events"("correlation_id");

CREATE TABLE "pos_held_sales" (
  "id" TEXT PRIMARY KEY,
  "register_id" INTEGER NOT NULL,
  "session_id" INTEGER NOT NULL,
  "customer_id" INTEGER,
  "operator_profile_id" INTEGER NOT NULL,
  "idempotency_key" TEXT,
  "request_hash" TEXT,
  "discard_idempotency_key" TEXT,
  "discard_request_hash" TEXT,
  "label" TEXT,
  "status" TEXT NOT NULL DEFAULT 'held',
  "notes" TEXT,
  "discount_cents" INTEGER NOT NULL DEFAULT 0,
  "surcharge_cents" INTEGER NOT NULL DEFAULT 0,
  "expires_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT now(),
  CONSTRAINT "pos_held_sales_register_id_fkey" FOREIGN KEY ("register_id") REFERENCES "pos_registers"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pos_held_sales_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "cash_register_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pos_held_sales_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "pos_held_sales_operator_profile_id_fkey" FOREIGN KEY ("operator_profile_id") REFERENCES "tenant_user_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "pos_held_sales_idempotency_key_key" ON "pos_held_sales"("idempotency_key");
CREATE UNIQUE INDEX "pos_held_sales_discard_idempotency_key_key" ON "pos_held_sales"("discard_idempotency_key");
CREATE INDEX "pos_held_sales_register_id_status_updated_at_idx" ON "pos_held_sales"("register_id", "status", "updated_at");
CREATE INDEX "pos_held_sales_session_id_status_idx" ON "pos_held_sales"("session_id", "status");

CREATE TABLE "pos_held_sale_items" (
  "id" SERIAL PRIMARY KEY,
  "held_sale_id" TEXT NOT NULL,
  "product_id" INTEGER NOT NULL,
  "variation_id" INTEGER,
  "quantity" DOUBLE PRECISION NOT NULL,
  "unit_price_cents" INTEGER NOT NULL,
  "discount_cents" INTEGER NOT NULL DEFAULT 0,
  "scan_data" JSONB,
  "notes" TEXT,
  CONSTRAINT "pos_held_sale_items_held_sale_id_fkey" FOREIGN KEY ("held_sale_id") REFERENCES "pos_held_sales"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pos_held_sale_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_held_sale_items_variation_id_fkey" FOREIGN KEY ("variation_id") REFERENCES "product_variations"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "pos_held_sale_items_held_sale_id_idx" ON "pos_held_sale_items"("held_sale_id");
CREATE INDEX "pos_held_sale_items_variation_id_idx" ON "pos_held_sale_items"("variation_id");

CREATE TABLE "pos_session_payment_counts" (
  "id" SERIAL PRIMARY KEY,
  "session_id" INTEGER NOT NULL,
  "method" TEXT NOT NULL,
  "provider" TEXT NOT NULL DEFAULT '',
  "expected_cents" INTEGER NOT NULL DEFAULT 0,
  "declared_cents" INTEGER NOT NULL DEFAULT 0,
  "difference_cents" INTEGER NOT NULL DEFAULT 0,
  "details" JSONB,
  "counted_at" TIMESTAMP(3) NOT NULL DEFAULT now(),
  CONSTRAINT "pos_session_payment_counts_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "cash_register_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "pos_session_payment_counts_session_id_method_provider_key" ON "pos_session_payment_counts"("session_id", "method", "provider");
CREATE INDEX "pos_session_payment_counts_session_id_method_idx" ON "pos_session_payment_counts"("session_id", "method");

CREATE TABLE "pos_returns" (
  "id" TEXT PRIMARY KEY,
  "number" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "sale_id" INTEGER NOT NULL,
  "processing_session_id" INTEGER NOT NULL,
  "register_id" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'requested',
  "reason_code" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "disposition" TEXT NOT NULL DEFAULT 'restock',
  "refund_method" TEXT,
  "total_refund_cents" INTEGER NOT NULL DEFAULT 0,
  "requested_by" TEXT NOT NULL,
  "approved_by" TEXT,
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT now(),
  CONSTRAINT "pos_returns_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_returns_processing_session_id_fkey" FOREIGN KEY ("processing_session_id") REFERENCES "cash_register_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_returns_register_id_fkey" FOREIGN KEY ("register_id") REFERENCES "pos_registers"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "pos_returns_number_key" ON "pos_returns"("number");
CREATE UNIQUE INDEX "pos_returns_idempotency_key_key" ON "pos_returns"("idempotency_key");
CREATE INDEX "pos_returns_sale_id_status_idx" ON "pos_returns"("sale_id", "status");
CREATE INDEX "pos_returns_processing_session_id_status_idx" ON "pos_returns"("processing_session_id", "status");
CREATE INDEX "pos_returns_status_created_at_idx" ON "pos_returns"("status", "created_at");

CREATE TABLE "pos_return_items" (
  "id" SERIAL PRIMARY KEY,
  "return_id" TEXT NOT NULL,
  "sale_item_id" INTEGER NOT NULL,
  "product_id" INTEGER NOT NULL,
  "quantity" DOUBLE PRECISION NOT NULL,
  "refund_cents" INTEGER NOT NULL,
  "disposition" TEXT NOT NULL DEFAULT 'restock',
  "warehouse_id" INTEGER,
  CONSTRAINT "pos_return_items_return_id_fkey" FOREIGN KEY ("return_id") REFERENCES "pos_returns"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pos_return_items_sale_item_id_fkey" FOREIGN KEY ("sale_item_id") REFERENCES "sale_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_return_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_return_items_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "pos_return_items_return_id_sale_item_id_key" ON "pos_return_items"("return_id", "sale_item_id");
CREATE INDEX "pos_return_items_sale_item_id_idx" ON "pos_return_items"("sale_item_id");

CREATE TABLE "pos_promotions" (
  "id" TEXT PRIMARY KEY,
  "branch_id" INTEGER,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "priority" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "stack_mode" TEXT NOT NULL DEFAULT 'exclusive',
  "conditions" JSONB NOT NULL,
  "effects" JSONB NOT NULL,
  "starts_at" TIMESTAMP(3) NOT NULL,
  "ends_at" TIMESTAMP(3),
  "usage_limit" INTEGER,
  "per_customer_limit" INTEGER,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT now(),
  CONSTRAINT "pos_promotions_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "pos_promotions_branch_id_status_starts_at_ends_at_idx" ON "pos_promotions"("branch_id", "status", "starts_at", "ends_at");

CREATE TABLE "pos_coupons" (
  "id" TEXT PRIMARY KEY,
  "promotion_id" TEXT NOT NULL,
  "code_hash" TEXT NOT NULL,
  "code_last_four" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "usage_limit" INTEGER,
  "used_count" INTEGER NOT NULL DEFAULT 0,
  "expires_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(),
  CONSTRAINT "pos_coupons_promotion_id_fkey" FOREIGN KEY ("promotion_id") REFERENCES "pos_promotions"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "pos_coupons_code_hash_key" ON "pos_coupons"("code_hash");
CREATE INDEX "pos_coupons_promotion_id_status_idx" ON "pos_coupons"("promotion_id", "status");

CREATE TABLE "pos_promotion_redemptions" (
  "id" BIGSERIAL PRIMARY KEY,
  "promotion_id" TEXT NOT NULL,
  "coupon_id" TEXT,
  "sale_id" INTEGER NOT NULL,
  "customer_id" INTEGER,
  "discount_cents" INTEGER NOT NULL,
  "snapshot" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(),
  CONSTRAINT "pos_promotion_redemptions_promotion_id_fkey" FOREIGN KEY ("promotion_id") REFERENCES "pos_promotions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_promotion_redemptions_coupon_id_fkey" FOREIGN KEY ("coupon_id") REFERENCES "pos_coupons"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "pos_promotion_redemptions_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_promotion_redemptions_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "pos_promotion_redemptions_promotion_id_created_at_idx" ON "pos_promotion_redemptions"("promotion_id", "created_at");
CREATE INDEX "pos_promotion_redemptions_sale_id_idx" ON "pos_promotion_redemptions"("sale_id");
CREATE INDEX "pos_promotion_redemptions_customer_id_created_at_idx" ON "pos_promotion_redemptions"("customer_id", "created_at");

CREATE TABLE "pos_sync_operations" (
  "id" BIGSERIAL PRIMARY KEY,
  "terminal_id" TEXT NOT NULL,
  "operation_id" TEXT NOT NULL,
  "sequence" BIGINT NOT NULL,
  "type" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'received',
  "request_hash" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "response" JSONB,
  "conflict" JSONB,
  "occurred_at" TIMESTAMP(3) NOT NULL,
  "received_at" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "processed_at" TIMESTAMP(3),
  CONSTRAINT "pos_sync_operations_terminal_id_fkey" FOREIGN KEY ("terminal_id") REFERENCES "pos_terminals"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "pos_sync_operations_terminal_id_operation_id_key" ON "pos_sync_operations"("terminal_id", "operation_id");
CREATE UNIQUE INDEX "pos_sync_operations_terminal_id_sequence_key" ON "pos_sync_operations"("terminal_id", "sequence");
CREATE INDEX "pos_sync_operations_state_received_at_idx" ON "pos_sync_operations"("state", "received_at");

CREATE TABLE "pos_approvals" (
  "id" TEXT PRIMARY KEY,
  "action" TEXT NOT NULL,
  "entity_type" TEXT NOT NULL,
  "entity_id" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "requester_id" TEXT NOT NULL,
  "requester_name" TEXT NOT NULL,
  "approver_id" TEXT,
  "approver_name" TEXT,
  "reason" TEXT NOT NULL,
  "context" JSONB NOT NULL,
  "correlation_id" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "decided_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE INDEX "pos_approvals_status_expires_at_idx" ON "pos_approvals"("status", "expires_at");
CREATE INDEX "pos_approvals_entity_type_entity_id_created_at_idx" ON "pos_approvals"("entity_type", "entity_id", "created_at");

CREATE TABLE "pos_print_jobs" (
  "id" TEXT PRIMARY KEY,
  "terminal_id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "reference_type" TEXT NOT NULL,
  "reference_id" TEXT NOT NULL,
  "template_version" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "last_error" TEXT,
  "requested_by" TEXT NOT NULL,
  "printed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT now(),
  CONSTRAINT "pos_print_jobs_terminal_id_fkey" FOREIGN KEY ("terminal_id") REFERENCES "pos_terminals"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "pos_print_jobs_terminal_id_status_created_at_idx" ON "pos_print_jobs"("terminal_id", "status", "created_at");
CREATE INDEX "pos_print_jobs_reference_type_reference_id_idx" ON "pos_print_jobs"("reference_type", "reference_id");

ALTER TABLE "pos_register_accesses" ADD CONSTRAINT "pos_register_accesses_discount_limit_check" CHECK ("max_discount_basis_points" BETWEEN 0 AND 10000);
ALTER TABLE "pos_sale_payments" ADD CONSTRAINT "pos_sale_payments_amount_check" CHECK ("amount_cents" > 0 AND "tendered_cents" >= 0 AND "change_cents" >= 0);
ALTER TABLE "pos_session_payment_counts" ADD CONSTRAINT "pos_session_payment_counts_amounts_check" CHECK ("declared_cents" >= 0);
ALTER TABLE "sales" ADD CONSTRAINT "sales_pos_amounts_check" CHECK ("subtotal_cents" >= 0 AND "discount_cents" >= 0 AND "surcharge_cents" >= 0 AND "total_cents" >= 0 AND "change_cents" >= 0) NOT VALID;
ALTER TABLE "sales" ADD CONSTRAINT "sales_pos_total_equation_check" CHECK ("total_cents" = "subtotal_cents" - "discount_cents" + "surcharge_cents") NOT VALID;
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_pos_amounts_check" CHECK ("unit_price_cents" >= 0 AND "gross_cents" >= 0 AND "discount_cents" >= 0 AND "surcharge_cents" >= 0 AND "total_cents" = "gross_cents" - "discount_cents" + "surcharge_cents" AND "returned_quantity" >= 0 AND "returned_quantity" <= "quantity" AND "returned_cents" >= 0 AND "returned_cents" <= "total_cents") NOT VALID;
ALTER TABLE "pos_return_items" ADD CONSTRAINT "pos_return_items_amounts_check" CHECK ("quantity" > 0 AND "refund_cents" >= 0);

CREATE TABLE "pos_product_codes" (
  "id" SERIAL PRIMARY KEY,
  "product_id" INTEGER NOT NULL,
  "variation_id" INTEGER,
  "branch_id" INTEGER,
  "scope_key" TEXT NOT NULL DEFAULT 'global',
  "code" TEXT NOT NULL,
  "normalized_code" TEXT NOT NULL,
  "symbology" TEXT NOT NULL DEFAULT 'unknown',
  "package_quantity" DOUBLE PRECISION NOT NULL DEFAULT 1,
  "unit" TEXT,
  "priority" INTEGER NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT now(),
  CONSTRAINT "pos_product_codes_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pos_product_codes_variation_id_fkey" FOREIGN KEY ("variation_id") REFERENCES "product_variations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pos_product_codes_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "pos_product_codes_scope_key_normalized_code_key" ON "pos_product_codes"("scope_key", "normalized_code");
CREATE INDEX "pos_product_codes_product_id_active_idx" ON "pos_product_codes"("product_id", "active");
CREATE INDEX "pos_product_codes_variation_id_active_idx" ON "pos_product_codes"("variation_id", "active");
CREATE INDEX "pos_product_codes_branch_id_active_idx" ON "pos_product_codes"("branch_id", "active");

-- Import only unambiguous legacy codes. Duplicates deliberately remain unmapped so
-- resolveScan can reject them instead of silently selecting an arbitrary product.
WITH candidates AS (
  SELECT "id" AS product_id, NULL::INTEGER AS variation_id, "gtin" AS code,
         regexp_replace("gtin", '[^0-9A-Za-z]', '', 'g') AS normalized_code, 'gtin' AS symbology, 100 AS priority
  FROM "products" WHERE "gtin" IS NOT NULL AND length(trim("gtin")) > 0
  UNION ALL
  SELECT "id", NULL::INTEGER, "barcode", regexp_replace("barcode", '[^0-9A-Za-z]', '', 'g'), 'internal', 50
  FROM "products" WHERE "barcode" IS NOT NULL AND length(trim("barcode")) > 0
  UNION ALL
  SELECT "product_id", "id", "gtin", regexp_replace("gtin", '[^0-9A-Za-z]', '', 'g'), 'gtin', 110
  FROM "product_variations" WHERE "gtin" IS NOT NULL AND length(trim("gtin")) > 0
), unique_codes AS (
  SELECT "normalized_code" FROM candidates WHERE "normalized_code" <> '' GROUP BY "normalized_code"
  HAVING COUNT(DISTINCT "product_id") = 1 AND COUNT(*) = 1
)
INSERT INTO "pos_product_codes" ("product_id", "variation_id", "scope_key", "code", "normalized_code", "symbology", "priority")
SELECT c."product_id", c."variation_id", 'global', c."code", c."normalized_code", c."symbology", c."priority"
FROM candidates c JOIN unique_codes u USING ("normalized_code");

CREATE UNIQUE INDEX "cash_register_sessions_one_open_per_register_idx"
ON "cash_register_sessions"("register_id") WHERE "register_id" IS NOT NULL AND "status" IN ('open', 'closing');

CREATE UNIQUE INDEX "cash_register_sessions_one_open_per_operator_idx"
ON "cash_register_sessions"("operator_profile_id") WHERE "operator_profile_id" IS NOT NULL AND "status" IN ('open', 'closing');

CREATE UNIQUE INDEX "pos_sale_payments_provider_transaction_key"
ON "pos_sale_payments"("provider", "transaction_id")
WHERE "type" = 'payment' AND "provider" IS NOT NULL AND "transaction_id" IS NOT NULL;

CREATE UNIQUE INDEX "pos_sale_payments_end_to_end_key"
ON "pos_sale_payments"("end_to_end_id")
WHERE "type" = 'payment' AND "end_to_end_id" IS NOT NULL;

CREATE UNIQUE INDEX "pos_connectors_global_key"
ON "pos_connectors"("branch_id", "type", "provider") WHERE "register_id" IS NULL;

ALTER TABLE "pos_product_codes" ADD CONSTRAINT "pos_product_codes_values_check" CHECK ("normalized_code" <> '' AND "package_quantity" > 0 AND (("branch_id" IS NULL AND "scope_key" = 'global') OR ("branch_id" IS NOT NULL AND "scope_key" = 'branch:' || "branch_id"::text)));
CREATE UNIQUE INDEX "product_variations_id_product_id_key" ON "product_variations"("id", "product_id");
ALTER TABLE "pos_product_codes" ADD CONSTRAINT "pos_product_codes_variation_product_fkey" FOREIGN KEY ("variation_id", "product_id") REFERENCES "product_variations"("id", "product_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_variation_product_fkey" FOREIGN KEY ("variation_id", "product_id") REFERENCES "product_variations"("id", "product_id") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "pos_held_sale_items" ADD CONSTRAINT "pos_held_sale_items_variation_product_fkey" FOREIGN KEY ("variation_id", "product_id") REFERENCES "product_variations"("id", "product_id") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;
CREATE UNIQUE INDEX "sale_items_id_product_id_key" ON "sale_items"("id", "product_id");
ALTER TABLE "pos_return_items" ADD CONSTRAINT "pos_return_items_sale_item_product_fkey" FOREIGN KEY ("sale_item_id", "product_id") REFERENCES "sale_items"("id", "product_id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "pos_sale_payments_id_sale_id_key" ON "pos_sale_payments"("id", "sale_id");
ALTER TABLE "pos_sale_payments" ADD CONSTRAINT "pos_sale_payments_original_same_sale_fkey" FOREIGN KEY ("original_payment_id", "sale_id") REFERENCES "pos_sale_payments"("id", "sale_id") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;
CREATE UNIQUE INDEX "cash_register_sessions_id_register_id_key" ON "cash_register_sessions"("id", "register_id");
ALTER TABLE "pos_returns" ADD CONSTRAINT "pos_returns_session_register_fkey" FOREIGN KEY ("processing_session_id", "register_id") REFERENCES "cash_register_sessions"("id", "register_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cash_register_events" ADD CONSTRAINT "cash_register_events_positive_amount_check" CHECK ("amount_cents" > 0) NOT VALID;
