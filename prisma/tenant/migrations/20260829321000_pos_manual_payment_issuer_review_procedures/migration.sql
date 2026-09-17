-- First executable slice of the manual-payment reconciliation boundary.
-- Opening a case and touching the vault are deliberately out of scope: the
-- 320000 hard gate and proof_kind=manual activation boundary remain unchanged.

CREATE TRIGGER "pos_manual_vault_bindings_append_only"
BEFORE UPDATE OR DELETE ON public."pos_manual_payment_vault_bindings"
FOR EACH ROW EXECUTE FUNCTION public."protect_pos_manual_append_only"();

-- The hard gate made legitimate pre-321 assertions impossible. Refuse to
-- invent semantics for rows fabricated while the gate was bypassed.
DO $precondition$
BEGIN
  IF EXISTS (SELECT 1 FROM public."pos_manual_payment_step_up_assertions") THEN
    RAISE EXCEPTION '321000 requires an empty step-up assertion table while the manual gate is hard-disabled';
  END IF;
END;
$precondition$;

ALTER TABLE public."pos_manual_payment_step_up_assertions"
  ADD COLUMN "expected_case_version" INTEGER NOT NULL CHECK ("expected_case_version" >= 0),
  ADD COLUMN "decision" TEXT NOT NULL CHECK ("decision" IN ('authorize_query','reject')),
  ADD COLUMN "reason_code" TEXT NOT NULL CHECK ("reason_code" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$');

CREATE OR REPLACE FUNCTION public."protect_pos_manual_step_up_assertion"() RETURNS trigger AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    NEW."verified_at":=clock_timestamp();
    NEW."expires_at":=NEW."verified_at"+interval '5 minutes';
    RETURN NEW;
  END IF;
  IF ROW(NEW."case_id",NEW."expected_case_version",NEW."checker_profile_id",NEW."checker_user_id",
         NEW."purpose",NEW."decision",NEW."reason_code",NEW."request_hash",NEW."assertion_hash",
         NEW."idempotency_key",NEW."verified_at",NEW."expires_at",NEW."created_at")
    IS DISTINCT FROM
       ROW(OLD."case_id",OLD."expected_case_version",OLD."checker_profile_id",OLD."checker_user_id",
         OLD."purpose",OLD."decision",OLD."reason_code",OLD."request_hash",OLD."assertion_hash",
         OLD."idempotency_key",OLD."verified_at",OLD."expires_at",OLD."created_at")
    OR OLD."consumed_review_id" IS NOT NULL OR NEW."consumed_review_id" IS NULL OR NEW."consumed_at" IS NULL
  THEN
    RAISE EXCEPTION 'step-up assertion is immutable and single-use' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION public."pos_manual_issue_step_up_v1"(
  p_case_id UUID,
  p_expected_case_version INTEGER,
  p_checker_profile_id INTEGER,
  p_checker_user_id TEXT,
  p_purpose TEXT,
  p_decision TEXT,
  p_reason_code TEXT,
  p_request_hash TEXT,
  p_assertion_hash TEXT,
  p_idempotency_key TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  case_record public."pos_manual_payment_cases"%ROWTYPE;
  replay_record public."pos_manual_payment_step_up_assertions"%ROWTYPE;
  assertion_record public."pos_manual_payment_step_up_assertions"%ROWTYPE;
  evaluation_time TIMESTAMPTZ;
BEGIN
  IF p_case_id IS NULL
     OR p_expected_case_version IS NULL OR p_expected_case_version < 0
     OR p_checker_profile_id IS NULL OR p_checker_profile_id <= 0
     OR p_checker_user_id IS NULL OR length(p_checker_user_id) NOT BETWEEN 1 AND 160
     OR p_purpose IS DISTINCT FROM 'manual_payment.review'
     OR p_decision IS NULL OR p_decision NOT IN ('authorize_query', 'reject')
     OR p_reason_code IS NULL OR p_reason_code !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'
     OR p_request_hash IS NULL OR p_request_hash !~ '^[0-9a-f]{64}$'
     OR p_assertion_hash IS NULL OR p_assertion_hash !~ '^[0-9a-f]{64}$'
     OR p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 1 AND 160
  THEN
    RAISE EXCEPTION 'invalid closed step-up issuance input' USING ERRCODE='22023';
  END IF;

  -- Serialize equal idempotency keys even when hostile requests target
  -- different cases. The case lock below serializes all issuance per case.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('pos_manual_issue_step_up_v1'),
    pg_catalog.hashtext(p_idempotency_key)
  );

  SELECT * INTO case_record
    FROM public."pos_manual_payment_cases"
   WHERE "id" = p_case_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'step-up issuance requires an existing case' USING ERRCODE='23503';
  END IF;

  SELECT * INTO replay_record
    FROM public."pos_manual_payment_step_up_assertions"
   WHERE "idempotency_key" = p_idempotency_key
   FOR UPDATE;
  IF FOUND THEN
    IF ROW(replay_record."case_id", replay_record."checker_profile_id", replay_record."checker_user_id",
           replay_record."expected_case_version", replay_record."purpose", replay_record."decision",
           replay_record."reason_code", replay_record."request_hash", replay_record."assertion_hash")
       IS DISTINCT FROM
       ROW(p_case_id, p_checker_profile_id, p_checker_user_id, p_expected_case_version, p_purpose,
           p_decision, p_reason_code, p_request_hash, p_assertion_hash)
    THEN
      RAISE EXCEPTION 'step-up idempotency key conflicts with a different request'
        USING ERRCODE='23505';
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'assertionId', replay_record."id",
      'caseId', replay_record."case_id",
      'verifiedAt', replay_record."verified_at",
      'expiresAt', replay_record."expires_at",
      'consumed', replay_record."consumed_review_id" IS NOT NULL,
      'consumedReviewId', replay_record."consumed_review_id",
      'consumedAt', replay_record."consumed_at",
      'currentlyValid', replay_record."consumed_review_id" IS NULL
        AND replay_record."expires_at">pg_catalog.clock_timestamp()
        AND case_record."state"='review_pending'
        AND case_record."version"=replay_record."expected_case_version"
        AND case_record."expires_at">pg_catalog.clock_timestamp(),
      'replayed', true
    );
  END IF;

  IF case_record."state" IS DISTINCT FROM 'review_pending'
     OR case_record."version" IS DISTINCT FROM p_expected_case_version
     OR case_record."maker_profile_id" = p_checker_profile_id
     OR case_record."maker_user_id" = p_checker_user_id
  THEN
    RAISE EXCEPTION 'step-up issuance requires a live review-pending case and distinct checker'
      USING ERRCODE='23514';
  END IF;

  PERFORM 1
    FROM public."tenant_user_profiles"
   WHERE "id" = p_checker_profile_id
     AND "user_id" = p_checker_user_id
     AND "status" = 'active'
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'step-up checker profile/user binding is not active'
      USING ERRCODE='23514';
  END IF;
  -- Profile locking may wait. Evaluate the case TTL only after every
  -- authoritative identity row used by issuance is locked.
  evaluation_time := pg_catalog.clock_timestamp();
  IF case_record."expires_at" <= evaluation_time THEN
    RAISE EXCEPTION 'step-up issuance requires a live review-pending case and distinct checker'
      USING ERRCODE='23514';
  END IF;

  INSERT INTO public."pos_manual_payment_step_up_assertions" (
    "case_id", "expected_case_version", "checker_profile_id", "checker_user_id", "purpose",
    "decision", "reason_code",
    "request_hash", "assertion_hash", "idempotency_key",
    "verified_at", "expires_at"
  ) VALUES (
    p_case_id, p_expected_case_version, p_checker_profile_id, p_checker_user_id, p_purpose,
    p_decision, p_reason_code,
    p_request_hash, p_assertion_hash, p_idempotency_key,
    evaluation_time, evaluation_time + interval '5 minutes'
  ) RETURNING * INTO assertion_record;

  -- The assertion guard authoritatively overwrites the clock and TTL. Return
  -- only persisted values, never caller-provided temporal evidence.
  RETURN pg_catalog.jsonb_build_object(
    'assertionId', assertion_record."id",
    'caseId', assertion_record."case_id",
    'verifiedAt', assertion_record."verified_at",
    'expiresAt', assertion_record."expires_at",
    'consumed', false,
    'consumedReviewId', NULL,
    'consumedAt', NULL,
    'currentlyValid', true,
    'replayed', false
  );
END;
$function$;

CREATE FUNCTION public."pos_manual_review_case_v1"(
  p_case_id UUID,
  p_expected_version INTEGER,
  p_checker_profile_id INTEGER,
  p_checker_user_id TEXT,
  p_assertion_hash TEXT,
  p_decision TEXT,
  p_reason_code TEXT,
  p_idempotency_key TEXT,
  p_request_hash TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  case_record public."pos_manual_payment_cases"%ROWTYPE;
  session_record public."cash_register_sessions"%ROWTYPE;
  terminal_record public."pos_terminals"%ROWTYPE;
  maker_profile_record public."tenant_user_profiles"%ROWTYPE;
  checker_profile_record public."tenant_user_profiles"%ROWTYPE;
  branch_record public."branches"%ROWTYPE;
  register_record public."pos_registers"%ROWTYPE;
  maker_branch_grant public."branch_user_accesses"%ROWTYPE;
  checker_branch_grant public."branch_user_accesses"%ROWTYPE;
  maker_register_grant public."pos_register_accesses"%ROWTYPE;
  checker_register_grant public."pos_register_accesses"%ROWTYPE;
  claim_record public."pos_order_claims"%ROWTYPE;
  draft_record public."pos_held_sales"%ROWTYPE;
  plan_record public."pos_payment_plans"%ROWTYPE;
  slot_record public."pos_payment_plan_slots"%ROWTYPE;
  connector_record public."pos_connectors"%ROWTYPE;
  credential_record public."integration_credentials"%ROWTYPE;
  provider_record public."integration_providers"%ROWTYPE;
  gate_record public."pos_manual_payment_reconciliation_gates"%ROWTYPE;
  prior_operation public."pos_manual_payment_operations"%ROWTYPE;
  prior_review public."pos_manual_payment_reviews"%ROWTYPE;
  assertion_record public."pos_manual_payment_step_up_assertions"%ROWTYPE;
  review_record public."pos_manual_payment_reviews"%ROWTYPE;
  operation_record public."pos_manual_payment_operations"%ROWTYPE;
  attempt_record public."pos_manual_payment_attempts"%ROWTYPE;
  outbox_record public."pos_manual_payment_outbox"%ROWTYPE;
  operation_key TEXT;
  next_state TEXT;
  next_version INTEGER;
  evaluation_time TIMESTAMPTZ;
BEGIN
  IF p_case_id IS NULL
     OR p_expected_version IS NULL OR p_expected_version < 0
     OR p_checker_profile_id IS NULL OR p_checker_profile_id <= 0
     OR p_checker_user_id IS NULL OR length(p_checker_user_id) NOT BETWEEN 1 AND 160
     OR p_assertion_hash IS NULL OR p_assertion_hash !~ '^[0-9a-f]{64}$'
     OR p_decision IS NULL OR p_decision NOT IN ('authorize_query', 'reject')
     OR p_reason_code IS NULL OR p_reason_code !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'
     OR p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 1 AND 160
     OR p_request_hash IS NULL OR p_request_hash !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'invalid closed manual review input' USING ERRCODE='22023';
  END IF;

  operation_key := 'manual-review:' || p_idempotency_key;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('pos_manual_review_case_v1'),
    pg_catalog.hashtext(operation_key)
  );

  SELECT * INTO prior_operation
    FROM public."pos_manual_payment_operations"
   WHERE "idempotency_key" = operation_key;
  IF FOUND THEN
    SELECT * INTO prior_review
      FROM public."pos_manual_payment_reviews"
     WHERE "id" = prior_operation."review_id";
    IF prior_review."id" IS NULL
       OR prior_operation."case_id" IS DISTINCT FROM p_case_id
       OR prior_operation."expected_version" IS DISTINCT FROM p_expected_version
       OR prior_operation."request_hash" IS DISTINCT FROM p_request_hash
       OR prior_operation."action" IS DISTINCT FROM p_decision
       OR prior_review."checker_profile_id" IS DISTINCT FROM p_checker_profile_id
       OR prior_review."checker_user_id" IS DISTINCT FROM p_checker_user_id
       OR prior_review."step_up_proof_hash" IS DISTINCT FROM p_assertion_hash
       OR prior_review."decision" IS DISTINCT FROM p_decision
       OR prior_review."reason_code" IS DISTINCT FROM p_reason_code
       OR prior_review."request_hash" IS DISTINCT FROM p_request_hash
    THEN
      RAISE EXCEPTION 'manual review idempotency key conflicts with a different request'
        USING ERRCODE='23505';
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'caseId', prior_operation."case_id",
      'reviewId', prior_review."id",
      'operationId', prior_operation."id",
      'resultingState', prior_operation."resulting_state",
      'resultingVersion', prior_operation."resulting_version",
      'replayed', true
    );
  END IF;

  -- Canonical lock order mirrors guard_pos_manual_operation: session,
  -- terminal, operator, branch, register, optional claim, draft, plan, slot,
  -- connector, credential and finally the aggregate case.
  SELECT * INTO case_record
    FROM public."pos_manual_payment_cases"
   WHERE "id" = p_case_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'manual review case does not exist' USING ERRCODE='23503';
  END IF;
  SELECT * INTO session_record FROM public."cash_register_sessions" WHERE "id"=case_record."session_id" FOR UPDATE;
  SELECT * INTO terminal_record FROM public."pos_terminals" WHERE "id"=case_record."terminal_id" FOR UPDATE;
  PERFORM 1 FROM public."tenant_user_profiles"
    WHERE "id" IN (case_record."maker_profile_id", p_checker_profile_id) ORDER BY "id" FOR SHARE;
  SELECT * INTO maker_profile_record FROM public."tenant_user_profiles" WHERE "id"=case_record."maker_profile_id";
  SELECT * INTO checker_profile_record FROM public."tenant_user_profiles" WHERE "id"=p_checker_profile_id;
  SELECT * INTO branch_record FROM public."branches" WHERE "id"=case_record."branch_id" FOR SHARE;
  SELECT * INTO register_record FROM public."pos_registers" WHERE "id"=case_record."register_id" FOR SHARE;
  PERFORM 1 FROM public."branch_user_accesses"
    WHERE "branch_id"=case_record."branch_id" AND "user_profile_id" IN (case_record."maker_profile_id",p_checker_profile_id)
    ORDER BY "user_profile_id" FOR SHARE;
  SELECT * INTO maker_branch_grant FROM public."branch_user_accesses"
    WHERE "branch_id"=case_record."branch_id" AND "user_profile_id"=case_record."maker_profile_id";
  SELECT * INTO checker_branch_grant FROM public."branch_user_accesses"
    WHERE "branch_id"=case_record."branch_id" AND "user_profile_id"=p_checker_profile_id;
  PERFORM 1 FROM public."pos_register_accesses"
    WHERE "register_id"=case_record."register_id" AND "user_profile_id" IN (case_record."maker_profile_id",p_checker_profile_id)
    ORDER BY "user_profile_id" FOR SHARE;
  SELECT * INTO maker_register_grant FROM public."pos_register_accesses"
    WHERE "register_id"=case_record."register_id" AND "user_profile_id"=case_record."maker_profile_id";
  SELECT * INTO checker_register_grant FROM public."pos_register_accesses"
    WHERE "register_id"=case_record."register_id" AND "user_profile_id"=p_checker_profile_id;
  IF case_record."order_claim_id" IS NOT NULL THEN
    SELECT * INTO claim_record FROM public."pos_order_claims" WHERE "id"=case_record."order_claim_id" FOR UPDATE;
  END IF;
  SELECT * INTO draft_record FROM public."pos_held_sales" WHERE "id"=case_record."sale_draft_id" FOR UPDATE;
  SELECT * INTO plan_record FROM public."pos_payment_plans" WHERE "id"=case_record."payment_plan_id" FOR UPDATE;
  SELECT * INTO slot_record FROM public."pos_payment_plan_slots"
    WHERE "plan_id"=case_record."payment_plan_id" AND "payment_index"=case_record."payment_index" FOR UPDATE;
  SELECT * INTO connector_record FROM public."pos_connectors" WHERE "id"=case_record."connector_id" FOR SHARE;
  SELECT * INTO credential_record FROM public."integration_credentials" WHERE "id"=case_record."credential_ref" FOR SHARE;
  SELECT * INTO provider_record FROM public."integration_providers" WHERE "id"=case_record."provider" FOR SHARE;
  SELECT * INTO gate_record FROM public."pos_manual_payment_reconciliation_gates" WHERE "connector_id"=case_record."connector_id" FOR SHARE;
  SELECT * INTO case_record
    FROM public."pos_manual_payment_cases"
   WHERE "id" = p_case_id
   FOR UPDATE;

  evaluation_time := pg_catalog.clock_timestamp();
  IF case_record."state" IS DISTINCT FROM 'review_pending'
     OR case_record."version" IS DISTINCT FROM p_expected_version
     OR case_record."expires_at" <= evaluation_time
     OR case_record."maker_profile_id" = p_checker_profile_id
     OR case_record."maker_user_id" = p_checker_user_id
  THEN
    RAISE EXCEPTION 'manual review requires expected live review-pending case version and distinct checker'
      USING ERRCODE='23514';
  END IF;

  SELECT * INTO assertion_record
    FROM public."pos_manual_payment_step_up_assertions"
   WHERE "assertion_hash"=p_assertion_hash
     AND "case_id"=p_case_id
     AND "checker_profile_id"=p_checker_profile_id
     AND "checker_user_id"=p_checker_user_id
     AND "purpose"='manual_payment.review'
     AND "expected_case_version"=p_expected_version
     AND "decision"=p_decision
     AND "reason_code"=p_reason_code
     AND "request_hash"=p_request_hash
     AND "consumed_review_id" IS NULL
     AND "verified_at"<=evaluation_time
     AND "expires_at">evaluation_time
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'manual review requires a live matching one-shot assertion'
      USING ERRCODE='23514';
  END IF;

  IF pg_catalog.jsonb_typeof(credential_record."config"->'manualReconciliation'->'callbackAuthKeyIds') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'manual review credential callback keyring is not an array' USING ERRCODE='23514';
  END IF;
  IF pg_catalog.jsonb_array_length(credential_record."config"->'manualReconciliation'->'callbackAuthKeyIds') NOT BETWEEN 1 AND 16
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.jsonb_array_elements(credential_record."config"->'manualReconciliation'->'callbackAuthKeyIds') element
        WHERE pg_catalog.jsonb_typeof(element)<>'string'
           OR (element #>> '{}') !~ '^[A-Za-z][A-Za-z0-9._:-]{2,79}$'
     )
  THEN
    RAISE EXCEPTION 'manual review credential callback keyring is invalid' USING ERRCODE='23514';
  END IF;

  -- Every lock above may wait. Re-evaluate all temporal authority against a
  -- post-lock clock before consuming the assertion or writing any ledger row.
  evaluation_time := pg_catalog.clock_timestamp();
  IF case_record."expires_at" <= evaluation_time
     OR assertion_record."verified_at">evaluation_time
     OR assertion_record."expires_at"<=evaluation_time
     OR ROW(maker_profile_record."user_id",maker_profile_record."status") IS DISTINCT FROM ROW(case_record."maker_user_id",'active')
     OR ROW(checker_profile_record."user_id",checker_profile_record."status") IS DISTINCT FROM ROW(p_checker_user_id,'active')
     OR ROW(session_record."register_id",session_record."operator_profile_id",session_record."status")
        IS DISTINCT FROM ROW(case_record."register_id",case_record."maker_profile_id",'open')
     OR terminal_record."register_id" IS DISTINCT FROM case_record."register_id"
     OR terminal_record."status" IS DISTINCT FROM 'online' OR terminal_record."paired_at" IS NULL OR terminal_record."revoked_at" IS NOT NULL
     OR terminal_record."token_hash" IS NULL OR terminal_record."token_expires_at" IS NULL OR terminal_record."token_expires_at"<=evaluation_time
     OR terminal_record."last_seen_at" IS NULL OR terminal_record."last_seen_at"<=evaluation_time-interval '5 minutes'
     OR terminal_record."app_version" IS NULL OR length(pg_catalog.btrim(terminal_record."app_version"))=0
     OR branch_record."status" IS DISTINCT FROM 'active'
     OR register_record."branch_id" IS DISTINCT FROM case_record."branch_id" OR register_record."status" IS DISTINCT FROM 'active'
     OR maker_branch_grant."can_sell" IS DISTINCT FROM true
     OR maker_register_grant."active" IS DISTINCT FROM true OR maker_register_grant."can_sell" IS DISTINCT FROM true
     OR maker_register_grant."can_manual_payment" IS DISTINCT FROM true
     OR (maker_register_grant."valid_from" IS NOT NULL AND maker_register_grant."valid_from">evaluation_time)
     OR (maker_register_grant."valid_until" IS NOT NULL AND maker_register_grant."valid_until"<evaluation_time)
     OR checker_branch_grant."can_sell" IS DISTINCT FROM true
     OR checker_register_grant."active" IS DISTINCT FROM true OR checker_register_grant."can_review_manual_payment" IS DISTINCT FROM true
     OR checker_register_grant."manual_payment_review_limit_cents"<case_record."amount_cents"
     OR (checker_register_grant."valid_from" IS NOT NULL AND checker_register_grant."valid_from">evaluation_time)
     OR (checker_register_grant."valid_until" IS NOT NULL AND checker_register_grant."valid_until"<evaluation_time)
     OR ROW(draft_record."id",draft_record."register_id",draft_record."session_id",draft_record."operator_profile_id",
            draft_record."revision",draft_record."request_hash",draft_record."status")
        IS DISTINCT FROM ROW(case_record."sale_draft_id",case_record."register_id",case_record."session_id",case_record."maker_profile_id",
            case_record."draft_revision",case_record."draft_request_hash",plan_record."draft_status")
     OR (draft_record."expires_at" IS NOT NULL AND draft_record."expires_at"<=evaluation_time)
     OR ROW(plan_record."id",plan_record."branch_id",plan_record."register_id",plan_record."session_id",plan_record."operator_profile_id",
            plan_record."terminal_id",plan_record."sale_draft_id",plan_record."draft_revision",plan_record."draft_request_hash",
            plan_record."quote_hash",plan_record."order_claim_id",plan_record."currency",plan_record."total_cents",plan_record."state")
        IS DISTINCT FROM ROW(case_record."payment_plan_id",case_record."branch_id",case_record."register_id",case_record."session_id",case_record."maker_profile_id",
            case_record."terminal_id",case_record."sale_draft_id",case_record."draft_revision",case_record."draft_request_hash",
            case_record."quote_hash",case_record."order_claim_id",case_record."currency",case_record."amount_cents",'active')
     OR plan_record."expires_at"<=evaluation_time
     OR ROW(slot_record."plan_id",slot_record."payment_index",slot_record."method",slot_record."amount_cents",slot_record."installments",
            slot_record."proof_kind",slot_record."provider",slot_record."connector_id",slot_record."credential_ref")
        IS DISTINCT FROM ROW(case_record."payment_plan_id",case_record."payment_index",case_record."method",case_record."amount_cents",case_record."installments",
            'manual',case_record."provider",case_record."connector_id",case_record."credential_ref")
     OR connector_record."revision" IS DISTINCT FROM case_record."connector_revision" OR connector_record."status" IS DISTINCT FROM 'active'
     OR connector_record."branch_id" IS DISTINCT FROM case_record."branch_id"
     OR (connector_record."register_id" IS NOT NULL AND connector_record."register_id" IS DISTINCT FROM case_record."register_id")
     OR connector_record."provider" IS DISTINCT FROM case_record."provider" OR connector_record."credential_ref" IS DISTINCT FROM case_record."credential_ref"
     OR NOT (connector_record."settings" @> '{"manualReconciliation":{"enabled":true,"vaultBindingRequired":true}}'::jsonb)
     OR NOT (connector_record."settings"->'capabilities' ? 'manual_reference_query')
     OR credential_record."revision" IS DISTINCT FROM case_record."credential_revision" OR credential_record."enabled" IS DISTINCT FROM true
     OR credential_record."provider_id" IS DISTINCT FROM case_record."provider"
     OR provider_record."family" IS DISTINCT FROM 'payment'
     OR gate_record."enabled" IS DISTINCT FROM true OR gate_record."connector_revision" IS DISTINCT FROM case_record."connector_revision"
     OR gate_record."credential_ref" IS DISTINCT FROM case_record."credential_ref" OR gate_record."credential_revision" IS DISTINCT FROM case_record."credential_revision"
     OR gate_record."vault_adapter_id" IS NULL OR gate_record."provider_adapter_version" IS NULL OR gate_record."config_hash" !~ '^[0-9a-f]{64}$'
     OR (case_record."order_claim_id" IS NOT NULL AND (
       ROW(claim_record."id",claim_record."branch_id",claim_record."register_id",claim_record."session_id",claim_record."operator_profile_id",claim_record."terminal_id",claim_record."state")
       IS DISTINCT FROM ROW(case_record."order_claim_id",case_record."branch_id",case_record."register_id",case_record."session_id",case_record."maker_profile_id",case_record."terminal_id",'active')
       OR claim_record."lease_expires_at"<=evaluation_time
     ))
  THEN
    RAISE EXCEPTION 'manual review temporal authority expired while acquiring locks'
      USING ERRCODE='23514';
  END IF;

  next_state := CASE WHEN p_decision='reject' THEN 'rejected' ELSE 'unknown' END;
  next_version := case_record."version" + 1;

  INSERT INTO public."pos_manual_payment_reviews" (
    "case_id", "decision", "maker_profile_id", "maker_user_id",
    "checker_profile_id", "checker_user_id", "step_up_evidence_id",
    "step_up_proof_hash", "step_up_verified_at", "step_up_expires_at",
    "branch_grant_id", "register_grant_id", "authority_limit_cents",
    "reason_code", "idempotency_key", "request_hash", "write_txid"
  ) VALUES (
    p_case_id, p_decision, case_record."maker_profile_id", case_record."maker_user_id",
    p_checker_profile_id, p_checker_user_id, assertion_record."id"::text,
    p_assertion_hash, assertion_record."verified_at", assertion_record."expires_at",
    0, 0, 0, p_reason_code, p_idempotency_key, p_request_hash,
    pg_catalog.txid_current()::numeric
  ) RETURNING * INTO review_record;

  INSERT INTO public."pos_manual_payment_operations" (
    "case_id", "action", "expected_version", "resulting_version", "resulting_state",
    "actor_profile_id", "idempotency_key", "request_hash", "review_id", "write_txid"
  ) VALUES (
    p_case_id, p_decision, p_expected_version, next_version, next_state,
    p_checker_profile_id, operation_key, p_request_hash, review_record."id",
    pg_catalog.txid_current()::numeric
  ) RETURNING * INTO operation_record;

  INSERT INTO public."pos_manual_payment_state_events" (
    "case_id", "operation_id", "from_state", "to_state", "resulting_version",
    "source", "source_id", "write_txid"
  ) VALUES (
    p_case_id, operation_record."id", case_record."state", next_state, next_version,
    'api', review_record."id"::text, pg_catalog.txid_current()::numeric
  );

  UPDATE public."pos_manual_payment_cases"
     SET "state"=next_state,
         "version"=next_version,
         "reviewed_at"=evaluation_time,
         "rejected_at"=CASE WHEN next_state='rejected' THEN evaluation_time ELSE "rejected_at" END,
         "provider_outcome"=CASE WHEN next_state='unknown' THEN 'unknown' ELSE "provider_outcome" END,
         "unknown_since"=CASE WHEN next_state='unknown' THEN evaluation_time ELSE "unknown_since" END,
         "next_reconcile_at"=CASE WHEN next_state='unknown' THEN evaluation_time ELSE "next_reconcile_at" END
   WHERE "id"=p_case_id;

  IF p_decision='authorize_query' THEN
    INSERT INTO public."pos_manual_payment_attempts" (
      "case_id", "sequence", "operation", "state", "provider_idempotency_key", "request_hash"
    ) VALUES (
      p_case_id, 1, 'query', 'queued', 'manual-query:' || p_case_id::text || ':1', p_request_hash
    ) RETURNING * INTO attempt_record;
    INSERT INTO public."pos_manual_payment_outbox" ("attempt_id", "next_attempt_at")
    VALUES (attempt_record."id", evaluation_time)
    RETURNING * INTO outbox_record;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'caseId', p_case_id,
    'reviewId', review_record."id",
    'operationId', operation_record."id",
    'attemptId', attempt_record."id",
    'outboxId', outbox_record."id",
    'resultingState', next_state,
    'resultingVersion', next_version,
    'replayed', false
  );
END;
$function$;

ALTER FUNCTION public."pos_manual_issue_step_up_v1"(UUID, INTEGER, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT)
  OWNER TO CURRENT_USER;
ALTER FUNCTION public."pos_manual_review_case_v1"(UUID, INTEGER, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT)
  OWNER TO CURRENT_USER;

REVOKE ALL ON FUNCTION public."pos_manual_issue_step_up_v1"(UUID, INTEGER, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_manual_review_case_v1"(UUID, INTEGER, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;

-- Migrations also run in development databases where production login roles do
-- not exist. Provisioning/reconciliation repeats these exact grants.
DO $grant$
DECLARE
  issuer_role NAME := (current_database() || '_si')::NAME;
  runtime_role NAME := (current_database() || '_runtime')::NAME;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=issuer_role) THEN
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION public.pos_manual_issue_step_up_v1(uuid,integer,integer,text,text,text,text,text,text,text) TO %I',
      issuer_role
    );
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=runtime_role) THEN
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION public.pos_manual_review_case_v1(uuid,integer,integer,text,text,text,text,text,text) TO %I',
      runtime_role
    );
  END IF;
END;
$grant$;
