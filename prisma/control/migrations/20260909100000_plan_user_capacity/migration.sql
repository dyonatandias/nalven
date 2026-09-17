-- Active memberships (including the owner) occupy seats. Pending invitations do
-- not reserve seats. Existing over-capacity customers are not disabled by this
-- migration; only capacity-increasing membership changes are rejected.
CREATE FUNCTION enforce_membership_plan_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE maximum_seats INTEGER; occupied BIGINT;
BEGIN
  IF NEW.status <> 'active' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'active' AND OLD.organization_id = NEW.organization_id THEN RETURN NEW; END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(73890122);
  SELECT p.seats INTO maximum_seats FROM organizations o JOIN plans p ON p.id = o.plan_id WHERE o.id = NEW.organization_id;
  SELECT count(*) INTO occupied FROM memberships WHERE organization_id = NEW.organization_id AND status = 'active';
  IF maximum_seats IS NOT NULL AND occupied >= maximum_seats THEN
    RAISE EXCEPTION 'NALVEN_PLAN_CAPACITY' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER memberships_plan_capacity_guard BEFORE INSERT OR UPDATE OF status, organization_id
  ON memberships FOR EACH ROW EXECUTE FUNCTION enforce_membership_plan_capacity();

CREATE FUNCTION enforce_assignment_plan_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE maximum_seats INTEGER; occupied BIGINT;
BEGIN
  IF NEW.plan_id = OLD.plan_id THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(73890122);
  SELECT seats INTO maximum_seats FROM plans WHERE id = NEW.plan_id;
  SELECT count(*) INTO occupied FROM memberships WHERE organization_id = OLD.id AND status = 'active';
  IF maximum_seats IS NOT NULL AND occupied > maximum_seats THEN
    RAISE EXCEPTION 'NALVEN_PLAN_CAPACITY' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER organizations_plan_capacity_guard BEFORE UPDATE OF plan_id
  ON organizations FOR EACH ROW EXECUTE FUNCTION enforce_assignment_plan_capacity();

CREATE FUNCTION enforce_plan_capacity_reduction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.seats >= OLD.seats THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(73890122);
  IF EXISTS (
    SELECT o.id FROM organizations o JOIN memberships m ON m.organization_id = o.id AND m.status = 'active'
    WHERE o.plan_id = NEW.id GROUP BY o.id HAVING count(*) > NEW.seats
  ) THEN
    RAISE EXCEPTION 'NALVEN_PLAN_CAPACITY' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER plans_capacity_reduction_guard BEFORE UPDATE OF seats
  ON plans FOR EACH ROW EXECUTE FUNCTION enforce_plan_capacity_reduction();
