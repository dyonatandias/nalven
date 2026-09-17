BEGIN;
DO $$ BEGIN IF current_database()<>'nalven_t_demo' THEN RAISE EXCEPTION 'Demo database required'; END IF; END $$;
WITH desired AS (SELECT product_id,sum(quantity) AS quantity FROM warehouse_balances GROUP BY product_id), changed AS (UPDATE products p SET stock=d.quantity FROM desired d WHERE p.id=d.product_id AND p.stock IS DISTINCT FROM d.quantity RETURNING p.id,p.stock)
INSERT INTO audit_events (actor_id,action,entity_type,entity_id,after_data)
SELECT 'demo-configuration','demo.stock_cache_reconciled','product',id::text,jsonb_build_object('stock',stock,'source','sum of existing warehouse balances; no physical movement') FROM changed;
COMMIT;
