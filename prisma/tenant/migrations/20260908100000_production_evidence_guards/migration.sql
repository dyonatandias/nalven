-- Foundational order data cannot change after materials have been planned.
CREATE FUNCTION production_preserve_order_basis() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE revision public.production_bom_revisions;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Production order history is immutable'; END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW.snapshot IS DISTINCT FROM OLD.snapshot OR NEW.revision_id IS DISTINCT FROM OLD.revision_id
    OR NEW.bom_id <> OLD.bom_id OR NEW.output_product_id <> OLD.output_product_id
    OR NEW.warehouse_id <> OLD.warehouse_id OR NEW.planned_quantity <> OLD.planned_quantity
  ) THEN RAISE EXCEPTION 'Production order basis is immutable'; END IF;
  SELECT * INTO revision FROM public.production_bom_revisions WHERE id = NEW.revision_id;
  IF NOT FOUND OR NEW.snapshot IS NULL OR NEW.snapshot IS DISTINCT FROM revision.snapshot
    OR NEW.bom_id <> revision.bom_id OR NEW.output_product_id <> (NEW.snapshot->>'outputProductId')::integer
  THEN RAISE EXCEPTION 'Production order basis does not match its revision'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER production_order_basis_immutable BEFORE INSERT OR UPDATE OR DELETE ON production_orders
FOR EACH ROW EXECUTE FUNCTION production_preserve_order_basis();

CREATE FUNCTION production_guard_reservation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE target_warehouse integer; lot public.pos_inventory_lots;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Production reservation history is immutable'; END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW.order_id <> OLD.order_id OR NEW.product_id <> OLD.product_id
    OR NEW.variation_id IS DISTINCT FROM OLD.variation_id OR NEW.quantity_micros <> OLD.quantity_micros
    OR NEW.consumed_micros < OLD.consumed_micros OR NEW.released_micros < OLD.released_micros
    OR (OLD.lot_id IS NOT NULL AND NEW.lot_id IS DISTINCT FROM OLD.lot_id)
  ) THEN RAISE EXCEPTION 'Production reservation identity and history are immutable'; END IF;
  IF NEW.variation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.product_variations WHERE id = NEW.variation_id AND product_id = NEW.product_id
  ) THEN RAISE EXCEPTION 'Production reservation variation mismatch'; END IF;
  IF NEW.lot_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.lot_id IS DISTINCT FROM OLD.lot_id) THEN
    SELECT warehouse_id INTO target_warehouse FROM public.production_orders WHERE id = NEW.order_id;
    SELECT * INTO lot FROM public.pos_inventory_lots WHERE id = NEW.lot_id;
    IF NOT FOUND OR lot.product_id <> NEW.product_id OR lot.variation_id IS DISTINCT FROM NEW.variation_id
      OR lot.warehouse_id <> target_warehouse
    THEN RAISE EXCEPTION 'Production reservation lot scope mismatch'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER production_reservation_scope BEFORE INSERT OR UPDATE OR DELETE ON production_material_reservations
FOR EACH ROW EXECUTE FUNCTION production_guard_reservation();

CREATE FUNCTION production_guard_consumption_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.production_reports report
    JOIN public.production_material_reservations reservation ON reservation.order_id = report.order_id
    WHERE report.id = NEW.report_id AND reservation.id = NEW.reservation_id
  ) THEN RAISE EXCEPTION 'Production consumption belongs to a different order'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER production_consumption_scope BEFORE INSERT ON production_consumptions
FOR EACH ROW EXECUTE FUNCTION production_guard_consumption_scope();

-- Inspectors insert the immutable certificate and change report state in one
-- transaction. At commit neither a decision without evidence nor an orphan
-- certificate is permitted.
CREATE FUNCTION production_guard_quality_evidence() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE evidence_report_id uuid; report_status text; decision text;
BEGIN
  IF TG_TABLE_NAME = 'production_reports' THEN evidence_report_id := NEW.id;
  ELSE evidence_report_id := NEW.report_id; END IF;
  SELECT status INTO report_status FROM public.production_reports WHERE id = evidence_report_id;
  SELECT inspection.decision INTO decision FROM public.production_inspections inspection WHERE inspection.report_id = evidence_report_id;
  IF (report_status = 'quarantine' AND decision IS NOT NULL)
    OR (report_status IN ('approved','rejected') AND decision IS DISTINCT FROM report_status)
  THEN RAISE EXCEPTION 'Production quality decision requires matching inspection evidence'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER production_report_quality_evidence AFTER INSERT OR UPDATE ON production_reports
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION production_guard_quality_evidence();
CREATE CONSTRAINT TRIGGER production_inspection_quality_evidence AFTER INSERT ON production_inspections
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION production_guard_quality_evidence();
