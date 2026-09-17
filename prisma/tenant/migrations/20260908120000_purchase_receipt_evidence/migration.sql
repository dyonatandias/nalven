-- Posted receipts are accounting and inventory evidence; corrections require new events.
CREATE FUNCTION purchase_preserve_receipt_evidence() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'Posted purchase receipt history is immutable';
END $$;
CREATE TRIGGER goods_receipt_evidence_immutable BEFORE UPDATE OR DELETE ON goods_receipts
FOR EACH ROW EXECUTE FUNCTION purchase_preserve_receipt_evidence();
CREATE TRIGGER goods_receipt_item_evidence_immutable BEFORE UPDATE OR DELETE ON goods_receipt_items
FOR EACH ROW EXECUTE FUNCTION purchase_preserve_receipt_evidence();
