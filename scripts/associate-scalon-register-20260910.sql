\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE pos_registers IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
  IF current_database() <> 'nalven_t_scalon_modas' OR NOT EXISTS (
    SELECT 1 FROM branches WHERE id=1 AND status='active'
    AND regexp_replace(document, '[^0-9]', '', 'g')='62119228000152'
  ) OR (SELECT count(*) FROM tenant_user_profiles WHERE email IN
    ('scalonmodas@hotmail.com','dyonatandias+1@gmail.com') AND status='active'
    AND (access_expires_at IS NULL OR access_expires_at > now())) <> 2 THEN
    RAISE EXCEPTION 'Tenant, branch or users do not match';
  END IF;
  IF EXISTS (SELECT 1 FROM pos_registers WHERE branch_id<>1 OR code<>'CX01' OR status<>'active') THEN
    RAISE EXCEPTION 'Unexpected register; review before associating users';
  END IF;
END $$;
WITH created AS (
 INSERT INTO pos_registers (branch_id,code,name)
 SELECT 1,'CX01','Caixa Matriz' WHERE NOT EXISTS (SELECT 1 FROM pos_registers)
 RETURNING *
)
INSERT INTO audit_events (actor_id,action,entity_type,entity_id,after_data)
SELECT 'maintenance:scalon-register-20260910','pos.register.created','pos_register',id::text,to_jsonb(created) FROM created;
WITH linked AS (
 INSERT INTO pos_register_accesses (register_id,user_profile_id)
 SELECT r.id,p.id FROM pos_registers r CROSS JOIN tenant_user_profiles p
 WHERE r.branch_id=1 AND r.code='CX01'
 AND p.email IN ('scalonmodas@hotmail.com','dyonatandias+1@gmail.com')
 ON CONFLICT (register_id,user_profile_id) DO NOTHING
 RETURNING *
)
INSERT INTO audit_events (actor_id,action,entity_type,entity_id,after_data)
SELECT 'maintenance:scalon-register-20260910','pos.register.access.created','pos_register_access',id::text,to_jsonb(linked) FROM linked;
COMMIT;
SELECT p.email,r.name,a.active,a.can_open,a.can_sell,a.can_close,a.can_reprint
FROM pos_register_accesses a JOIN pos_registers r ON r.id=a.register_id
JOIN tenant_user_profiles p ON p.id=a.user_profile_id;
