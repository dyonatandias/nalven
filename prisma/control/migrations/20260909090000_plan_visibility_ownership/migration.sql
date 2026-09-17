ALTER TABLE plans
  ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public',
  ADD COLUMN owner_organization_id TEXT,
  ADD COLUMN updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD CONSTRAINT plans_visibility_check CHECK (
    (visibility = 'public' AND owner_organization_id IS NULL) OR
    (visibility = 'private' AND owner_organization_id IS NOT NULL)
  ),
  ADD CONSTRAINT plans_owner_organization_id_fkey FOREIGN KEY (owner_organization_id)
    REFERENCES organizations(id) ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX plans_visibility_active_idx ON plans(visibility, active);
CREATE INDEX plans_owner_organization_id_idx ON plans(owner_organization_id);

-- An assignment and a simultaneous ownership change must serialize on the plan.
CREATE FUNCTION enforce_organization_plan_owner() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_visibility TEXT; target_owner TEXT; target_modules JSONB;
BEGIN
  SELECT visibility, owner_organization_id, modules INTO target_visibility, target_owner, target_modules
    FROM plans WHERE id = NEW.plan_id FOR SHARE;
  IF target_visibility = 'private' AND target_owner IS DISTINCT FROM NEW.id THEN
    RAISE EXCEPTION 'Private plan belongs to another organization' USING ERRCODE = '23514';
  END IF;
  IF target_visibility IS NOT NULL THEN NEW.modules := target_modules; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER organizations_plan_owner_guard BEFORE INSERT OR UPDATE OF plan_id, id
  ON organizations FOR EACH ROW EXECUTE FUNCTION enforce_organization_plan_owner();

CREATE FUNCTION enforce_private_plan_assignments() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.visibility = 'private' AND EXISTS (
    SELECT 1 FROM organizations WHERE plan_id = NEW.id AND id <> NEW.owner_organization_id
  ) THEN
    RAISE EXCEPTION 'Plan has assignments outside its exclusive organization' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER plans_owner_assignment_guard BEFORE UPDATE OF visibility, owner_organization_id
  ON plans FOR EACH ROW EXECUTE FUNCTION enforce_private_plan_assignments();
