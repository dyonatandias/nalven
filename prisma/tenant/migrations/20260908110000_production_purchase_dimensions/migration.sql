ALTER TABLE purchase_order_items ADD COLUMN variation_id INTEGER REFERENCES product_variations(id) ON DELETE RESTRICT;
ALTER TABLE goods_receipts
  ADD COLUMN warehouse_id INTEGER REFERENCES warehouses(id) ON DELETE RESTRICT,
  ADD COLUMN idempotency_key UUID,
  ADD COLUMN request_hash TEXT CHECK(request_hash IS NULL OR request_hash ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT goods_receipts_idempotency_pair CHECK((idempotency_key IS NULL) = (request_hash IS NULL));
CREATE UNIQUE INDEX goods_receipts_idempotency_key_key ON goods_receipts(idempotency_key);
ALTER TABLE goods_receipt_items
  ADD COLUMN variation_id INTEGER REFERENCES product_variations(id) ON DELETE RESTRICT,
  ADD COLUMN tracking JSONB NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(tracking) = 'array');
ALTER TABLE production_procurements ADD COLUMN variation_id INTEGER REFERENCES product_variations(id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION production_preserve_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Production revision history is immutable'; END IF;
  IF OLD.status <> 'draft' AND (
    (to_jsonb(NEW) - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'status')
    OR (NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'approved' AND NEW.status = 'retired'))
  ) THEN RAISE EXCEPTION 'Approved production revision is immutable'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION purchase_guard_variation_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.variation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.product_variations WHERE id=NEW.variation_id AND product_id=NEW.product_id
  ) THEN RAISE EXCEPTION 'Purchase variation does not belong to product'; END IF;
  IF TG_TABLE_NAME = 'goods_receipt_items' THEN
    IF NOT EXISTS (
    SELECT 1 FROM public.purchase_order_items item JOIN public.goods_receipts receipt ON receipt.purchase_order_id=item.purchase_order_id
    WHERE item.id=NEW.purchase_order_item_id AND receipt.id=NEW.goods_receipt_id
      AND item.product_id=NEW.product_id AND item.variation_id IS NOT DISTINCT FROM NEW.variation_id
    ) THEN RAISE EXCEPTION 'Purchase receipt item scope mismatch'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER purchase_order_item_variation_scope BEFORE INSERT OR UPDATE ON purchase_order_items
FOR EACH ROW EXECUTE FUNCTION purchase_guard_variation_scope();
CREATE TRIGGER goods_receipt_item_variation_scope BEFORE INSERT OR UPDATE ON goods_receipt_items
FOR EACH ROW EXECUTE FUNCTION purchase_guard_variation_scope();
CREATE TRIGGER production_procurement_variation_scope BEFORE INSERT ON production_procurements
FOR EACH ROW EXECUTE FUNCTION purchase_guard_variation_scope();
