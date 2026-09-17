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
    'variable_code_rule.create', 'variable_code_rule.update', 'variable_code_rule.deactivate',
    'kit.create', 'kit.update', 'kit.activate', 'kit.retire'
  ));

CREATE TABLE "pos_kit_boms" (
  "id" TEXT PRIMARY KEY,
  "branch_id" INTEGER NOT NULL REFERENCES "branches"("id") ON DELETE RESTRICT,
  "kit_product_id" INTEGER NOT NULL REFERENCES "products"("id") ON DELETE RESTRICT,
  "kit_variation_id" INTEGER REFERENCES "product_variations"("id") ON DELETE RESTRICT,
  "scope_key" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "effective_from" TIMESTAMPTZ,
  "created_by" TEXT NOT NULL,
  "activated_by" TEXT,
  "activated_at" TIMESTAMPTZ,
  "retired_by" TEXT,
  "retired_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_kit_boms_scope_check" CHECK (
    "scope_key" = CASE WHEN "kit_variation_id" IS NULL THEN 'product:' || "kit_product_id"::text ELSE 'variation:' || "kit_variation_id"::text END
  ),
  CONSTRAINT "pos_kit_boms_values_check" CHECK (
    "version" BETWEEN 1 AND 1000000
    AND length(btrim("name")) BETWEEN 2 AND 160
    AND "status" IN ('draft', 'active', 'retired')
    AND length("created_by") BETWEEN 1 AND 160
    AND ("status" <> 'active' OR ("activated_by" IS NOT NULL AND "activated_at" IS NOT NULL))
    AND ("status" <> 'retired' OR ("retired_by" IS NOT NULL AND "retired_at" IS NOT NULL))
  ),
  CONSTRAINT "pos_kit_boms_variation_product_fk" FOREIGN KEY ("kit_variation_id", "kit_product_id") REFERENCES "product_variations"("id", "product_id") ON DELETE RESTRICT,
  UNIQUE ("branch_id", "scope_key", "version")
);
CREATE UNIQUE INDEX "pos_kit_boms_one_active_scope_key" ON "pos_kit_boms"("branch_id", "scope_key") WHERE "status" = 'active';
CREATE INDEX "pos_kit_boms_branch_status_effective_idx" ON "pos_kit_boms"("branch_id", "status", "effective_from");
CREATE INDEX "pos_kit_boms_product_variation_status_idx" ON "pos_kit_boms"("kit_product_id", "kit_variation_id", "status");

CREATE TABLE "pos_kit_bom_components" (
  "id" TEXT PRIMARY KEY,
  "bom_id" TEXT NOT NULL REFERENCES "pos_kit_boms"("id") ON DELETE CASCADE,
  "product_id" INTEGER NOT NULL REFERENCES "products"("id") ON DELETE RESTRICT,
  "variation_id" INTEGER REFERENCES "product_variations"("id") ON DELETE RESTRICT,
  "component_scope_key" TEXT NOT NULL,
  "quantity_micros" BIGINT NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_kit_bom_components_scope_check" CHECK (
    "component_scope_key" = CASE WHEN "variation_id" IS NULL THEN 'product:' || "product_id"::text ELSE 'variation:' || "variation_id"::text END
  ),
  CONSTRAINT "pos_kit_bom_components_values_check" CHECK (
    "quantity_micros" BETWEEN 1 AND 9007199254740991 AND "position" BETWEEN 0 AND 199
  ),
  CONSTRAINT "pos_kit_bom_components_variation_product_fk" FOREIGN KEY ("variation_id", "product_id") REFERENCES "product_variations"("id", "product_id") ON DELETE RESTRICT,
  UNIQUE ("bom_id", "component_scope_key")
);
CREATE INDEX "pos_kit_bom_components_product_variation_idx" ON "pos_kit_bom_components"("product_id", "variation_id");

CREATE TABLE "pos_kit_sale_components" (
  "id" TEXT PRIMARY KEY,
  "sale_item_id" INTEGER NOT NULL REFERENCES "sale_items"("id") ON DELETE RESTRICT,
  "bom_id" TEXT NOT NULL REFERENCES "pos_kit_boms"("id") ON DELETE RESTRICT,
  "bom_version" INTEGER NOT NULL,
  "product_id" INTEGER NOT NULL REFERENCES "products"("id") ON DELETE RESTRICT,
  "variation_id" INTEGER REFERENCES "product_variations"("id") ON DELETE RESTRICT,
  "component_scope_key" TEXT NOT NULL,
  "unit_quantity_micros" BIGINT NOT NULL,
  "quantity_micros" BIGINT NOT NULL,
  "returned_micros" BIGINT NOT NULL DEFAULT 0,
  "snapshot" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_kit_sale_components_scope_check" CHECK (
    "component_scope_key" = CASE WHEN "variation_id" IS NULL THEN 'product:' || "product_id"::text ELSE 'variation:' || "variation_id"::text END
  ),
  CONSTRAINT "pos_kit_sale_components_values_check" CHECK (
    "bom_version" BETWEEN 1 AND 1000000
    AND "unit_quantity_micros" BETWEEN 1 AND 9007199254740991
    AND "quantity_micros" BETWEEN 1 AND 9007199254740991
    AND "returned_micros" BETWEEN 0 AND "quantity_micros"
    AND jsonb_typeof("snapshot") = 'object'
  ),
  CONSTRAINT "pos_kit_sale_components_variation_product_fk" FOREIGN KEY ("variation_id", "product_id") REFERENCES "product_variations"("id", "product_id") ON DELETE RESTRICT,
  UNIQUE ("sale_item_id", "component_scope_key")
);
CREATE INDEX "pos_kit_sale_components_sale_returned_idx" ON "pos_kit_sale_components"("sale_item_id", "returned_micros");
CREATE INDEX "pos_kit_sale_components_product_variation_idx" ON "pos_kit_sale_components"("product_id", "variation_id");

CREATE FUNCTION "pos_kit_bom_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'POS kit BOM history cannot be deleted'; END IF;
  IF NEW."id" <> OLD."id"
     OR NEW."branch_id" <> OLD."branch_id"
     OR NEW."kit_product_id" <> OLD."kit_product_id"
     OR NEW."kit_variation_id" IS DISTINCT FROM OLD."kit_variation_id"
     OR NEW."scope_key" <> OLD."scope_key"
     OR NEW."version" <> OLD."version"
     OR NEW."created_by" <> OLD."created_by"
     OR NEW."created_at" <> OLD."created_at" THEN
    RAISE EXCEPTION 'Immutable POS kit BOM identity changed';
  END IF;
  IF OLD."status" = 'retired' OR (OLD."status" = 'active' AND NEW."status" <> 'retired')
     OR (OLD."status" = 'draft' AND NEW."status" NOT IN ('draft', 'active'))
     OR (OLD."status" = 'active' AND (NEW."name" <> OLD."name" OR NEW."effective_from" IS DISTINCT FROM OLD."effective_from")) THEN
    RAISE EXCEPTION 'Invalid POS kit BOM state transition';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "pos_kit_bom_guard_trigger" BEFORE UPDATE OR DELETE ON "pos_kit_boms" FOR EACH ROW EXECUTE FUNCTION "pos_kit_bom_guard"();

CREATE FUNCTION "pos_kit_bom_component_guard"() RETURNS trigger AS $$
DECLARE bom_status TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."bom_id" IS DISTINCT FROM OLD."bom_id" THEN
    RAISE EXCEPTION 'POS kit BOM components cannot move between versions';
  END IF;
  IF TG_OP = 'DELETE' THEN
    SELECT "status" INTO bom_status FROM "pos_kit_boms" WHERE "id" = OLD."bom_id";
  ELSE
    SELECT "status" INTO bom_status FROM "pos_kit_boms" WHERE "id" = NEW."bom_id";
  END IF;
  IF bom_status IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'Only draft POS kit BOM components may change'; END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "pos_kit_bom_component_guard_trigger" BEFORE INSERT OR UPDATE OR DELETE ON "pos_kit_bom_components" FOR EACH ROW EXECUTE FUNCTION "pos_kit_bom_component_guard"();

CREATE FUNCTION "pos_kit_sale_component_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'POS kit sale snapshots cannot be deleted'; END IF;
  IF NEW."id" <> OLD."id"
     OR NEW."sale_item_id" <> OLD."sale_item_id"
     OR NEW."bom_id" <> OLD."bom_id"
     OR NEW."bom_version" <> OLD."bom_version"
     OR NEW."product_id" <> OLD."product_id"
     OR NEW."variation_id" IS DISTINCT FROM OLD."variation_id"
     OR NEW."component_scope_key" <> OLD."component_scope_key"
     OR NEW."unit_quantity_micros" <> OLD."unit_quantity_micros"
     OR NEW."quantity_micros" <> OLD."quantity_micros"
     OR NEW."snapshot" <> OLD."snapshot"
     OR NEW."created_at" <> OLD."created_at"
     OR NEW."returned_micros" < OLD."returned_micros" THEN
    RAISE EXCEPTION 'Invalid POS kit sale snapshot mutation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "pos_kit_sale_component_guard_trigger" BEFORE UPDATE OR DELETE ON "pos_kit_sale_components" FOR EACH ROW EXECUTE FUNCTION "pos_kit_sale_component_guard"();
