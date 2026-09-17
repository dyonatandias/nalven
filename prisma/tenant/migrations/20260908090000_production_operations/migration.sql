CREATE TABLE production_bom_revisions (
  id UUID PRIMARY KEY, bom_id INTEGER NOT NULL REFERENCES bills_of_material(id),
  version INTEGER NOT NULL CHECK (version > 0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','retired')),
  snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  effective_at TIMESTAMPTZ, created_by TEXT NOT NULL, approved_by TEXT,
  approved_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT production_bom_revisions_bom_id_version_key UNIQUE (bom_id,version),
  CHECK (status = 'draft' OR (effective_at IS NOT NULL AND approved_at IS NOT NULL AND approved_by IS NOT NULL))
);
CREATE INDEX production_bom_revisions_bom_id_status_effective_at_idx ON production_bom_revisions(bom_id,status,effective_at);
CREATE TABLE production_work_centers (
  id UUID PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'machine' CHECK (kind IN ('machine','team','line')),
  active BOOLEAN NOT NULL DEFAULT true, wip_limit INTEGER NOT NULL DEFAULT 1 CHECK (wip_limit BETWEEN 1 AND 1000),
  time_zone TEXT NOT NULL DEFAULT 'America/Sao_Paulo', shifts JSONB NOT NULL CHECK (jsonb_typeof(shifts) = 'array'),
  hourly_cost_cents INTEGER NOT NULL DEFAULT 0 CHECK (hourly_cost_cents >= 0),
  version INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE production_orders
  ADD COLUMN revision_id UUID REFERENCES production_bom_revisions(id),
  ADD COLUMN snapshot JSONB,
  ADD COLUMN version INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN position INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN work_center_id UUID REFERENCES production_work_centers(id),
  ADD COLUMN scheduled_start TIMESTAMPTZ,
  ADD COLUMN scheduled_end TIMESTAMPTZ,
  ADD COLUMN quality_status TEXT NOT NULL DEFAULT 'pending' CHECK (quality_status IN ('pending','quarantine','approved','rejected','mixed')),
  ADD CONSTRAINT production_orders_schedule_check CHECK (
    (scheduled_start IS NULL AND scheduled_end IS NULL) OR
    (scheduled_start IS NOT NULL AND scheduled_end IS NOT NULL AND scheduled_end > scheduled_start)
  );
CREATE INDEX production_orders_updated_at_id_idx ON production_orders(updated_at,id);
CREATE INDEX production_orders_work_center_id_scheduled_start_scheduled_en_idx ON production_orders(work_center_id,scheduled_start,scheduled_end);
CREATE TABLE production_dependencies (
  order_id INTEGER NOT NULL REFERENCES production_orders(id),
  predecessor_id INTEGER NOT NULL REFERENCES production_orders(id),
  PRIMARY KEY(order_id,predecessor_id), CHECK(order_id <> predecessor_id)
);
CREATE TABLE production_material_reservations (
  id UUID PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES production_orders(id),
  product_id INTEGER NOT NULL REFERENCES products(id), variation_id INTEGER REFERENCES product_variations(id),
  lot_id TEXT REFERENCES pos_inventory_lots(id),
  quantity_micros BIGINT NOT NULL CHECK(quantity_micros > 0),
  consumed_micros BIGINT NOT NULL DEFAULT 0 CHECK(consumed_micros >= 0),
  released_micros BIGINT NOT NULL DEFAULT 0 CHECK(released_micros >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK(consumed_micros + released_micros <= quantity_micros)
);
CREATE INDEX production_material_reservations_order_id_product_id_idx ON production_material_reservations(order_id,product_id);
CREATE INDEX production_material_reservations_lot_id_idx ON production_material_reservations(lot_id);
CREATE TABLE production_reports (
  id UUID PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES production_orders(id),
  produced_micros BIGINT NOT NULL CHECK(produced_micros >= 0),
  scrap_micros BIGINT NOT NULL DEFAULT 0 CHECK(scrap_micros >= 0),
  rework_micros BIGINT NOT NULL DEFAULT 0 CHECK(rework_micros >= 0),
  material_cost_cents INTEGER NOT NULL CHECK(material_cost_cents >= 0),
  labor_cost_cents INTEGER NOT NULL DEFAULT 0 CHECK(labor_cost_cents >= 0),
  machine_cost_cents INTEGER NOT NULL DEFAULT 0 CHECK(machine_cost_cents >= 0),
  energy_cost_cents INTEGER NOT NULL DEFAULT 0 CHECK(energy_cost_cents >= 0),
  overhead_cost_cents INTEGER NOT NULL DEFAULT 0 CHECK(overhead_cost_cents >= 0),
  labor_minutes INTEGER NOT NULL DEFAULT 0 CHECK(labor_minutes >= 0),
  machine_minutes INTEGER NOT NULL DEFAULT 0 CHECK(machine_minutes >= 0),
  status TEXT NOT NULL DEFAULT 'quarantine' CHECK(status IN ('quarantine','approved','rejected')),
  notes TEXT, output_identity JSONB NOT NULL, actor TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK(produced_micros + scrap_micros + rework_micros > 0)
);
CREATE INDEX production_reports_order_id_created_at_idx ON production_reports(order_id,created_at);
CREATE INDEX production_reports_status_created_at_idx ON production_reports(status,created_at);
CREATE TABLE production_consumptions (
  id UUID PRIMARY KEY, report_id UUID NOT NULL REFERENCES production_reports(id),
  reservation_id UUID NOT NULL REFERENCES production_material_reservations(id),
  quantity_micros BIGINT NOT NULL CHECK(quantity_micros > 0),
  unit_cost_cents INTEGER NOT NULL CHECK(unit_cost_cents >= 0), total_cost_cents INTEGER NOT NULL CHECK(total_cost_cents >= 0),
  CONSTRAINT production_consumptions_report_id_reservation_id_key UNIQUE(report_id,reservation_id)
);
CREATE TABLE production_inspections (
  id UUID PRIMARY KEY, report_id UUID NOT NULL REFERENCES production_reports(id),
  decision TEXT NOT NULL CHECK(decision IN ('approved','rejected')),
  checklist JSONB NOT NULL CHECK(jsonb_typeof(checklist) = 'array'), notes TEXT NOT NULL,
  actor TEXT NOT NULL, certificate TEXT NOT NULL UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX production_inspections_report_once_idx ON production_inspections(report_id);
CREATE INDEX production_inspections_report_id_created_at_idx ON production_inspections(report_id,created_at);
CREATE TABLE production_events (
  id BIGSERIAL PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES production_orders(id),
  action TEXT NOT NULL, actor TEXT NOT NULL, data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX production_events_order_id_id_idx ON production_events(order_id,id);
CREATE TABLE production_commands (
  key UUID PRIMARY KEY, actor_id TEXT NOT NULL, action TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'), response JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE production_procurements (
  id UUID PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES production_orders(id),
  product_id INTEGER NOT NULL REFERENCES products(id), quantity_micros BIGINT NOT NULL CHECK(quantity_micros > 0),
  kind TEXT NOT NULL CHECK(kind IN ('purchase','transfer')),
  purchase_order_id INTEGER REFERENCES purchase_orders(id), transfer_id INTEGER REFERENCES stock_transfers(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK((kind = 'purchase' AND purchase_order_id IS NOT NULL AND transfer_id IS NULL)
    OR (kind = 'transfer' AND transfer_id IS NOT NULL AND purchase_order_id IS NULL))
);
CREATE INDEX production_procurements_order_id_product_id_idx ON production_procurements(order_id,product_id);

-- Import the existing composition as an explicit version without changing stock.
INSERT INTO production_bom_revisions(id,bom_id,version,status,snapshot,effective_at,created_by,approved_by,approved_at)
SELECT gen_random_uuid(), b.id, 1, 'approved', jsonb_build_object(
  'name', b.name, 'code', b.code, 'outputProductId', b.output_product_id,
  'outputVariationId', NULL, 'yieldQuantity', b.yield_quantity,
  'notes', b.notes, 'laborHourlyCents', 0, 'machineHourlyCents', 0,
  'energyBatchCents', 0, 'overheadBatchCents', 0,
  'checklist', jsonb_build_array('Quantidade conferida','Composição conferida','Integridade do produto'),
  'items', COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'productId', i.product_id, 'variationId', NULL, 'quantity', i.quantity,
    'wastePercent', i.waste_percent
  ) ORDER BY i.product_id) FROM bill_of_material_items i WHERE i.bom_id = b.id), '[]'::jsonb)
), b.created_at, 'migration:production_operations', 'migration:production_operations', now()
FROM bills_of_material b;
UPDATE production_orders o SET revision_id = r.id, snapshot = r.snapshot,
  quality_status = CASE WHEN o.status = 'completed' THEN 'approved' ELSE 'pending' END
FROM production_bom_revisions r WHERE r.bom_id = o.bom_id AND r.version = 1;

CREATE FUNCTION production_immutable_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Production evidence is immutable'; END $$;
CREATE TRIGGER production_consumptions_immutable BEFORE UPDATE OR DELETE ON production_consumptions FOR EACH ROW EXECUTE FUNCTION production_immutable_evidence();
CREATE TRIGGER production_inspections_immutable BEFORE UPDATE OR DELETE ON production_inspections FOR EACH ROW EXECUTE FUNCTION production_immutable_evidence();
CREATE TRIGGER production_events_immutable BEFORE UPDATE OR DELETE ON production_events FOR EACH ROW EXECUTE FUNCTION production_immutable_evidence();
CREATE TRIGGER production_commands_immutable BEFORE UPDATE OR DELETE ON production_commands FOR EACH ROW EXECUTE FUNCTION production_immutable_evidence();
CREATE TRIGGER production_procurements_immutable BEFORE UPDATE OR DELETE ON production_procurements FOR EACH ROW EXECUTE FUNCTION production_immutable_evidence();
CREATE FUNCTION production_preserve_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status <> 'draft' AND
    (NEW.snapshot IS DISTINCT FROM OLD.snapshot OR NEW.bom_id <> OLD.bom_id OR NEW.version <> OLD.version
     OR NEW.effective_at IS DISTINCT FROM OLD.effective_at OR NEW.status = 'draft') THEN
    RAISE EXCEPTION 'Approved production revision is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER production_revision_immutable BEFORE UPDATE OR DELETE ON production_bom_revisions FOR EACH ROW EXECUTE FUNCTION production_preserve_revision();
CREATE FUNCTION production_preserve_report() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Production report is immutable'; END IF;
  IF (to_jsonb(NEW) - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'status')
     OR OLD.status <> 'quarantine' OR NEW.status NOT IN ('approved','rejected') THEN
    RAISE EXCEPTION 'Production report may only receive a quality decision';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER production_report_immutable BEFORE UPDATE OR DELETE ON production_reports FOR EACH ROW EXECUTE FUNCTION production_preserve_report();
