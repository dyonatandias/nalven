ALTER TABLE "pos_admin_mutations"
  DROP CONSTRAINT "pos_admin_mutations_action_check";

ALTER TABLE "pos_admin_mutations"
  ADD CONSTRAINT "pos_admin_mutations_action_check" CHECK ("action" IN (
    'register.create', 'register.update', 'register.deactivate',
    'terminal.create', 'terminal.update', 'terminal.deactivate',
    'device.create', 'device.update', 'device.deactivate',
    'connector.create', 'connector.update', 'connector.deactivate',
    'terminal.pairing.issue', 'terminal.token.rotate', 'terminal.revoke',
    'promotion.create', 'promotion.update', 'promotion.deactivate',
    'coupon.create', 'coupon.update', 'coupon.rotate', 'coupon.deactivate',
    'inventory.receive', 'inventory.quarantine', 'inventory.release', 'inventory.discard',
    'value.program.create', 'value.program.deactivate',
    'value.account.issue', 'value.account.credit', 'value.account.debit', 'value.account.expire',
    'value.reservation.create', 'value.reservation.capture', 'value.reservation.release',
    'value.entry.reverse',
    'product_code.create', 'product_code.update', 'product_code.deactivate',
    'variable_code_rule.create', 'variable_code_rule.update', 'variable_code_rule.deactivate'
  ));

ALTER TABLE "pos_product_codes"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "pos_product_codes"
  DROP CONSTRAINT "pos_product_codes_values_check";

ALTER TABLE "pos_product_codes"
  ADD CONSTRAINT "pos_product_codes_values_check" CHECK (
    char_length("code") BETWEEN 1 AND 256
    AND char_length("normalized_code") BETWEEN 1 AND 160
    AND "symbology" IN ('gtin', 'ean13', 'ean8', 'upca', 'code128', 'code39', 'qr', 'plu', 'sku', 'internal', 'unknown')
    AND "package_quantity" > 0 AND "package_quantity" <= 999999
    AND abs("package_quantity" * 1000 - round("package_quantity" * 1000)) < 0.000001
    AND ("unit" IS NULL OR char_length(btrim("unit")) BETWEEN 1 AND 20)
    AND "priority" BETWEEN -1000 AND 1000
    AND "version" >= 0
    AND ("metadata" IS NULL OR jsonb_typeof("metadata") = 'object')
    AND (("branch_id" IS NULL AND "scope_key" = 'global') OR ("branch_id" IS NOT NULL AND "scope_key" = 'branch:' || "branch_id"::text))
  );

CREATE TABLE "pos_variable_code_rules" (
  "id" TEXT NOT NULL,
  "branch_id" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "prefix" TEXT NOT NULL,
  "total_length" INTEGER NOT NULL,
  "product_code_start" INTEGER NOT NULL,
  "product_code_length" INTEGER NOT NULL,
  "lookup_symbology" TEXT NOT NULL DEFAULT 'plu',
  "value_start" INTEGER NOT NULL,
  "value_length" INTEGER NOT NULL,
  "value_mode" TEXT NOT NULL,
  "value_scale" INTEGER NOT NULL,
  "measurement_unit" TEXT NOT NULL,
  "check_digit_algorithm" TEXT NOT NULL DEFAULT 'gtin',
  "priority" INTEGER NOT NULL DEFAULT 0,
  "version" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "pos_variable_code_rules_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_variable_code_rules_status_check" CHECK ("status" IN ('active', 'inactive')),
  CONSTRAINT "pos_variable_code_rules_name_check" CHECK (char_length(btrim("name")) BETWEEN 2 AND 160),
  CONSTRAINT "pos_variable_code_rules_prefix_check" CHECK ("prefix" ~ '^[0-9]{1,12}$'),
  CONSTRAINT "pos_variable_code_rules_format_check" CHECK (
    "total_length" BETWEEN 4 AND 64
    AND "product_code_start" >= char_length("prefix")
    AND "product_code_length" BETWEEN 1 AND 20
    AND "value_start" >= char_length("prefix")
    AND "value_length" BETWEEN 1 AND 20
    AND "product_code_start" + "product_code_length" <= "total_length" - CASE WHEN "check_digit_algorithm" = 'gtin' THEN 1 ELSE 0 END
    AND "value_start" + "value_length" <= "total_length" - CASE WHEN "check_digit_algorithm" = 'gtin' THEN 1 ELSE 0 END
    AND ("product_code_start" + "product_code_length" <= "value_start" OR "value_start" + "value_length" <= "product_code_start")
  ),
  CONSTRAINT "pos_variable_code_rules_lookup_check" CHECK ("lookup_symbology" IN ('plu', 'sku', 'internal')),
  CONSTRAINT "pos_variable_code_rules_value_check" CHECK (
    "value_mode" IN ('quantity', 'total_price')
    AND "value_scale" IN (1, 10, 100, 1000)
    AND char_length(btrim("measurement_unit")) BETWEEN 1 AND 20
  ),
  CONSTRAINT "pos_variable_code_rules_check_digit_check" CHECK (
    "check_digit_algorithm" IN ('gtin', 'none')
    AND ("check_digit_algorithm" <> 'gtin' OR "total_length" IN (8, 12, 13, 14))
  ),
  CONSTRAINT "pos_variable_code_rules_priority_check" CHECK ("priority" BETWEEN -1000 AND 1000 AND "version" >= 0)
);

CREATE UNIQUE INDEX "pos_variable_code_rules_branch_id_name_key" ON "pos_variable_code_rules"("branch_id", "name");
CREATE INDEX "pos_variable_code_rules_branch_id_status_priority_idx" ON "pos_variable_code_rules"("branch_id", "status", "priority");

ALTER TABLE "pos_variable_code_rules"
  ADD CONSTRAINT "pos_variable_code_rules_branch_id_fkey"
  FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
