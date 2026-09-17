-- One-time, idempotent repair. Only the verified Scalon database is allowed.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$
BEGIN
  IF current_database() <> 'nalven_t_scalon_modas' OR NOT EXISTS (
    SELECT 1 FROM branches WHERE id = 1
      AND regexp_replace(document, '[^0-9]', '', 'g') = '62119228000152'
  ) THEN
    RAISE EXCEPTION 'Unexpected tenant or branch document; repair aborted';
  END IF;
END $$;
WITH initialized AS (
  INSERT INTO tenant_settings (id, organization_name, trade_name, updated_by)
  VALUES (1, '62.119.226 DENIZE BATISTA FRANCO', 'Scalon Modas', 'maintenance:settings-repair-20260910')
  ON CONFLICT (id) DO NOTHING
  RETURNING *
)
INSERT INTO audit_events (actor_id, action, entity_type, entity_id, correlation_id, after_data)
SELECT 'maintenance:settings-repair-20260910', 'tenant_settings.initialized',
  'tenant_settings', '1', 'scalon-settings-repair-20260910', to_jsonb(initialized)
FROM initialized;
COMMIT;
SELECT id, organization_name, default_payment_method, allow_negative_stock, max_discount_percent
FROM tenant_settings WHERE id = 1;
