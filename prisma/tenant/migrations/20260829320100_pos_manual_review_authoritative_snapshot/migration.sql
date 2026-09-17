-- Preserve PostgreSQL's full timestamp precision in manual-payment reviews.
-- Review callers identify the assertion and checker; the database snapshots
-- grant IDs, validity, authority limit, and assertion timestamps itself.
CREATE OR REPLACE FUNCTION "validate_pos_manual_review"() RETURNS trigger AS $$
DECLARE
  case_record "pos_manual_payment_cases"%ROWTYPE;
  assertion_record "pos_manual_payment_step_up_assertions"%ROWTYPE;
  branch_grant_record "branch_user_accesses"%ROWTYPE;
  register_grant_record "pos_register_accesses"%ROWTYPE;
  evaluation_time TIMESTAMPTZ;
BEGIN
  SELECT * INTO case_record
    FROM "pos_manual_payment_cases"
   WHERE "id" = NEW."case_id";
  IF NOT FOUND
     OR NEW."maker_profile_id" IS DISTINCT FROM case_record."maker_profile_id"
     OR NEW."maker_user_id" IS DISTINCT FROM case_record."maker_user_id"
     OR NEW."checker_profile_id" = case_record."maker_profile_id"
     OR NEW."checker_user_id" = case_record."maker_user_id"
  THEN
    RAISE EXCEPTION 'manual payment review requires distinct checker, live grants and bounded step-up'
      USING ERRCODE='23514';
  END IF;

  PERFORM 1
    FROM "cash_register_sessions"
   WHERE "id" = case_record."session_id" AND "status" = 'open'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'manual payment review requires distinct checker, live grants and bounded step-up'
      USING ERRCODE='23514';
  END IF;

  PERFORM 1
    FROM "pos_terminals"
   WHERE "id" = case_record."terminal_id" AND "status" = 'online' AND "revoked_at" IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'manual payment review requires distinct checker, live grants and bounded step-up'
      USING ERRCODE='23514';
  END IF;

  PERFORM 1
    FROM "tenant_user_profiles"
   WHERE "id" = NEW."checker_profile_id"
     AND "user_id" = NEW."checker_user_id"
     AND "status" = 'active'
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'manual payment review requires distinct checker, live grants and bounded step-up'
      USING ERRCODE='23514';
  END IF;

  SELECT * INTO branch_grant_record
    FROM "branch_user_accesses"
   WHERE "branch_id" = case_record."branch_id"
     AND "user_profile_id" = NEW."checker_profile_id"
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'manual payment review requires distinct checker, live grants and bounded step-up'
      USING ERRCODE='23514';
  END IF;

  SELECT * INTO register_grant_record
    FROM "pos_register_accesses"
   WHERE "register_id" = case_record."register_id"
     AND "user_profile_id" = NEW."checker_profile_id"
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'manual payment review requires distinct checker, live grants and bounded step-up'
      USING ERRCODE='23514';
  END IF;

  SELECT * INTO assertion_record
    FROM "pos_manual_payment_step_up_assertions" assertion
   WHERE assertion."assertion_hash" = NEW."step_up_proof_hash"
     AND assertion."case_id" = NEW."case_id"
     AND assertion."checker_profile_id" = NEW."checker_profile_id"
     AND assertion."checker_user_id" = NEW."checker_user_id"
     AND assertion."purpose" = 'manual_payment.review'
     AND assertion."request_hash" = NEW."request_hash"
   FOR UPDATE;
  IF assertion_record."id" IS NULL THEN
    RAISE EXCEPTION 'manual payment review requires a live one-shot server assertion'
      USING ERRCODE='23514';
  END IF;

  -- Any of the locks above may wait. Evaluate temporal authority only after all
  -- authoritative rows are locked, so an expiry during contention fails closed.
  evaluation_time := clock_timestamp();
  IF branch_grant_record."can_sell" IS DISTINCT FROM true
     OR register_grant_record."active" IS DISTINCT FROM true
     OR register_grant_record."can_review_manual_payment" IS DISTINCT FROM true
     OR register_grant_record."manual_payment_review_limit_cents" < case_record."amount_cents"
     OR (register_grant_record."valid_from" IS NOT NULL AND register_grant_record."valid_from" > evaluation_time)
     OR (register_grant_record."valid_until" IS NOT NULL AND register_grant_record."valid_until" < evaluation_time)
  THEN
    RAISE EXCEPTION 'manual payment review requires distinct checker, live grants and bounded step-up'
      USING ERRCODE='23514';
  END IF;
  IF assertion_record."consumed_review_id" IS NOT NULL
     OR assertion_record."verified_at" > evaluation_time
     OR assertion_record."expires_at" <= evaluation_time
  THEN
    RAISE EXCEPTION 'manual payment review requires a live one-shot server assertion'
      USING ERRCODE='23514';
  END IF;

  NEW."branch_grant_id" := branch_grant_record."id";
  NEW."register_grant_id" := register_grant_record."id";
  NEW."grant_valid_from" := register_grant_record."valid_from";
  NEW."grant_valid_until" := register_grant_record."valid_until";
  NEW."authority_limit_cents" := register_grant_record."manual_payment_review_limit_cents";
  NEW."step_up_evidence_id" := assertion_record."id"::text;
  NEW."step_up_proof_hash" := assertion_record."assertion_hash";
  NEW."step_up_verified_at" := assertion_record."verified_at";
  NEW."step_up_expires_at" := assertion_record."expires_at";

  UPDATE "pos_manual_payment_step_up_assertions"
     SET "consumed_review_id" = NEW."id", "consumed_at" = evaluation_time
   WHERE "id" = assertion_record."id";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
