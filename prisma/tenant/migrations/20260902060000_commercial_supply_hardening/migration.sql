-- Operational histories and stock evidence must never be rewritten in place.
CREATE OR REPLACE FUNCTION protect_commercial_supply_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is forbidden', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS crm_stage_history_append_only ON crm_stage_history;
CREATE TRIGGER crm_stage_history_append_only
BEFORE UPDATE OR DELETE ON crm_stage_history
FOR EACH ROW EXECUTE FUNCTION protect_commercial_supply_append_only();

DROP TRIGGER IF EXISTS service_order_history_append_only ON service_order_history;
CREATE TRIGGER service_order_history_append_only
BEFORE UPDATE OR DELETE ON service_order_history
FOR EACH ROW EXECUTE FUNCTION protect_commercial_supply_append_only();

DROP TRIGGER IF EXISTS warehouse_ledger_entries_append_only ON warehouse_ledger_entries;
CREATE TRIGGER warehouse_ledger_entries_append_only
BEFORE UPDATE OR DELETE ON warehouse_ledger_entries
FOR EACH ROW EXECUTE FUNCTION protect_commercial_supply_append_only();

DROP TRIGGER IF EXISTS goods_receipts_append_only ON goods_receipts;
CREATE TRIGGER goods_receipts_append_only
BEFORE UPDATE OR DELETE ON goods_receipts
FOR EACH ROW EXECUTE FUNCTION protect_commercial_supply_append_only();

DROP TRIGGER IF EXISTS goods_receipt_items_append_only ON goods_receipt_items;
CREATE TRIGGER goods_receipt_items_append_only
BEFORE UPDATE OR DELETE ON goods_receipt_items
FOR EACH ROW EXECUTE FUNCTION protect_commercial_supply_append_only();

CREATE INDEX IF NOT EXISTS crm_opportunities_status_updated_idx
  ON crm_opportunities (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS service_orders_status_updated_idx
  ON service_orders (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS purchase_orders_status_updated_idx
  ON purchase_orders (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS production_orders_status_completed_idx
  ON production_orders (status, completed_at DESC);
