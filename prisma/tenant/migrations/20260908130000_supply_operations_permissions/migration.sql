-- Extend only the built-in supply role. Preserve custom roles, memberships,
-- suspended profiles and unrelated permissions; never give this role admin access.
WITH previous AS MATERIALIZED (
  SELECT id, permissions FROM tenant_roles
  WHERE key='stock' AND system=true AND jsonb_typeof(permissions)='array'
    AND NOT permissions @> '["production.read","production.write","logistics.read","logistics.write"]'::jsonb
), changed AS (
  UPDATE tenant_roles role SET
    permissions=(SELECT jsonb_agg(permission ORDER BY permission)
      FROM (SELECT DISTINCT jsonb_array_elements_text(previous.permissions ||
        '["production.read","production.write","logistics.read","logistics.write"]'::jsonb) AS permission) expanded),
    updated_at=now()
  FROM previous WHERE role.id=previous.id
  RETURNING role.id, previous.permissions AS before_permissions, role.permissions AS after_permissions
)
INSERT INTO audit_events(actor_id,action,entity_type,entity_id,correlation_id,before_data,after_data)
SELECT 'migration:supply_operations_permissions','tenant_role.permissions_extended','tenant_role',id::text,
  gen_random_uuid()::text,jsonb_build_object('permissions',before_permissions),jsonb_build_object('permissions',after_permissions)
FROM changed;
