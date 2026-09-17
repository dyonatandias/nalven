\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '30s';
SELECT pg_advisory_xact_lock(73890122);
LOCK TABLE plans, organizations IN SHARE ROW EXCLUSIVE MODE;
DO $$
DECLARE target_owner TEXT; links INTEGER; target plans%ROWTYPE;
BEGIN
  SELECT * INTO STRICT target FROM plans WHERE id='fashion-demo';
  SELECT count(*), min(id) INTO links, target_owner FROM organizations WHERE plan_id=target.id;
  IF links <> 1 OR target.active THEN
    RAISE EXCEPTION 'Demo plan no longer matches reviewed inactive, single-client scope';
  END IF;
  IF target.visibility='private' AND target.owner_organization_id=target_owner THEN RETURN; END IF;
  IF target.visibility <> 'public' OR target.owner_organization_id IS NOT NULL THEN
    RAISE EXCEPTION 'Unexpected existing plan ownership';
  END IF;
  IF (SELECT count(*) FROM plans WHERE visibility='public' AND id<>target.id) <> 3 THEN
    RAISE EXCEPTION 'Public catalogue differs from reviewed three-plan scope';
  END IF;
  UPDATE plans SET visibility='private',owner_organization_id=target_owner,updated_at=now() WHERE id=target.id;
  INSERT INTO audit_logs(id,action,entity_type,entity_id,metadata)
  VALUES ('admin-plan-rollout-' || gen_random_uuid()::text,'plan.save','plan',target.id,
    jsonb_build_object('source','reviewed-production-rollout','visibility','private','ownerOrganizationId',target_owner,'previousVisibility','public','permissionsPreserved',true));
END;
$$;
COMMIT;
SELECT id,active,visibility,seats FROM plans ORDER BY id;
