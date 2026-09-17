BEGIN;

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('public.pos_manual_finalization_profiles') IS NULL
    OR pg_catalog.to_regprocedure('public.pos_manual_hash_canonical_json_v1(text,jsonb)') IS NULL
    OR pg_catalog.to_regprocedure('public.guard_pos_manual_t2_profile_inert()') IS NULL
  THEN RAISE EXCEPTION 'T2-01 requires frozen T2-00 catalog' USING ERRCODE='23514'; END IF;
  IF EXISTS (SELECT 1 FROM public."pos_manual_payment_applications")
    OR EXISTS (SELECT 1 FROM public."pos_manual_payment_reconciliation_gates" WHERE "enabled")
    OR EXISTS (SELECT 1 FROM public."pos_manual_finalization_profiles") THEN
    RAISE EXCEPTION 'T2-01 requires empty hard-off foundation' USING ERRCODE='23514';
  END IF;
END
$preflight$;

CREATE TABLE public."pos_manual_t2_authorities" (
  "capability" text PRIMARY KEY,
  "role_name" name NOT NULL UNIQUE,
  "authority_hash" text NOT NULL,
  "registered_at" timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT "pos_manual_t2_authorities_shape_check" CHECK (
    "capability" IN ('profile_admin_issuer','profile_accounting_issuer','profile_fiscal_issuer','profile_homologator',
      'runtime','manual_callback','manual_worker','manual_vault_binder')
    AND "authority_hash" ~ '^[0-9a-f]{64}$'
  )
);

CREATE TABLE public."pos_manual_t2_lock_contexts" (
  "id" bigserial PRIMARY KEY,
  "backend_pid" integer NOT NULL,
  "transaction_txid" numeric(20,0) NOT NULL,
  "caller_role_hash" text NOT NULL,
  "capability" text NOT NULL,
  "aggregate_kind" text NOT NULL,
  "aggregate_id" text NOT NULL,
  "transition_action" text,
  "old_digest" text,
  "new_digest" text,
  "request_digest" text,
  "nonce_hash" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT "pos_manual_t2_lock_contexts_identity_key" UNIQUE ("backend_pid","transaction_txid","capability","aggregate_kind","aggregate_id"),
  CONSTRAINT "pos_manual_t2_lock_contexts_shape_check" CHECK (
    "caller_role_hash" ~ '^[0-9a-f]{64}$' AND "nonce_hash" ~ '^[0-9a-f]{64}$'
    AND ("capability" IN ('profile_put','profile_activate','profile_retire')
      OR "capability" LIKE 'legacy_producer:%'
      OR "capability" IN ('session_transition','session_event','handoff_transition','plan_release','plan_operation'))
    AND pg_catalog.octet_length("aggregate_id") BETWEEN 1 AND 128
    AND (("capability" IN ('session_transition','session_event','handoff_transition','plan_release','plan_operation')
      AND "transition_action" IS NOT NULL AND "old_digest" ~ '^[0-9a-f]{64}$' AND "new_digest" ~ '^[0-9a-f]{64}$' AND "request_digest" ~ '^[0-9a-f]{64}$')
      OR ("capability" NOT IN ('session_transition','session_event','handoff_transition','plan_release','plan_operation')
        AND "transition_action" IS NULL AND "old_digest" IS NULL AND "new_digest" IS NULL AND "request_digest" IS NULL))
  )
);

CREATE TABLE public."pos_manual_t2_transaction_nonces" (
  "backend_pid" integer NOT NULL,
  "transaction_txid" numeric(20,0) NOT NULL,
  "nonce_hash" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT "pos_manual_t2_tx_nonces_pkey" PRIMARY KEY ("backend_pid","transaction_txid"),
  CONSTRAINT "pos_manual_t2_tx_nonces_hash_check" CHECK ("nonce_hash" ~ '^[0-9a-f]{64}$')
);

-- These two relations are deliberately transaction-scoped owner state.  A
-- capability opens one root with the exact, SQL-derived row projections it
-- intends to write; row guards later record the projections they actually
-- saw.  Neither relation is an application ledger and neither is readable or
-- writable by the runtime role.
CREATE TABLE public."pos_manual_t2_write_roots" (
  "id" bigserial PRIMARY KEY,
  "backend_pid" integer NOT NULL,
  "transaction_txid" numeric(20,0) NOT NULL,
  "nonce_hash" text NOT NULL,
  "caller_role_hash" text NOT NULL,
  "capability" text NOT NULL,
  "aggregate_kind" text NOT NULL,
  "aggregate_id" text NOT NULL,
  "action" text NOT NULL,
  "trigger_identity" text NOT NULL,
  "dml_operation" text NOT NULL,
  "expected_observation_count" integer NOT NULL,
  "expected_observation_multiset_digest" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT "pos_manual_t2_write_roots_identity_key" UNIQUE ("backend_pid","transaction_txid","capability","aggregate_kind","aggregate_id","action","trigger_identity","dml_operation"),
  CONSTRAINT "pos_manual_t2_write_roots_shape_check" CHECK (
    "nonce_hash" ~ '^[0-9a-f]{64}$'
    AND "caller_role_hash" ~ '^[0-9a-f]{64}$'
    AND "expected_observation_multiset_digest" ~ '^[0-9a-f]{64}$'
  )
);

CREATE TABLE public."pos_manual_t2_write_observations" (
  "id" bigserial PRIMARY KEY,
  "root_id" bigint NOT NULL REFERENCES public."pos_manual_t2_write_roots"("id") ON DELETE CASCADE,
  "capability" text NOT NULL,
  "aggregate_kind" text NOT NULL,
  "aggregate_id" text NOT NULL,
  "action" text NOT NULL,
  "trigger_identity" text NOT NULL,
  "dml_operation" text NOT NULL,
  "observation_digest" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT "pos_manual_t2_write_observations_shape_check" CHECK ("observation_digest" ~ '^[0-9a-f]{64}$')
);
CREATE INDEX "pos_manual_t2_write_observations_root_idx" ON public."pos_manual_t2_write_observations"("root_id","capability","aggregate_kind","aggregate_id","action","trigger_identity","dml_operation","observation_digest","id");

CREATE TABLE public."pos_manual_profile_operations" (
  "id" bigserial PRIMARY KEY,
  "profile_id" uuid NOT NULL,
  "branch_id" integer NOT NULL,
  "profile_version" integer NOT NULL,
  "action" text NOT NULL,
  "from_state" text,
  "to_state" text NOT NULL,
  "previous_config_hash" text,
  "resulting_config_hash" text NOT NULL,
  "executor_subject_id" text NOT NULL,
  "actor_profile_id" integer,
  "actor_user_id" text,
  "idempotency_key" text NOT NULL,
  "request_hash" text NOT NULL,
  "admin_assertion_id" uuid NOT NULL,
  "accounting_assertion_id" uuid,
  "fiscal_assertion_id" uuid,
  "write_txid" numeric(20,0) NOT NULL DEFAULT pg_catalog.txid_current()::numeric,
  "created_at" timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT "pos_manual_profile_ops_profile_fkey" FOREIGN KEY ("profile_id")
    REFERENCES public."pos_manual_finalization_profiles"("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "pos_manual_profile_ops_action_idem_key" UNIQUE ("profile_id","action","idempotency_key"),
  CONSTRAINT "pos_manual_profile_ops_one_action_key" UNIQUE ("profile_id","action"),
  CONSTRAINT "pos_manual_profile_ops_id_aggregate_key" UNIQUE ("id","profile_id","action"),
  CONSTRAINT "pos_manual_profile_ops_shape_check" CHECK (
    "action" IN ('put','activate','retire') AND "to_state" IN ('draft','active','retired')
    AND "idempotency_key" ~ '^([0-9a-f]{64}|[A-Za-z0-9_-]{43})$' AND "request_hash" ~ '^[0-9a-f]{64}$'
    AND "resulting_config_hash" ~ '^[0-9a-f]{64}$' AND ("previous_config_hash" IS NULL OR "previous_config_hash" ~ '^[0-9a-f]{64}$')
    AND pg_catalog.octet_length("executor_subject_id") BETWEEN 1 AND 128
    AND (("action"='activate' AND "accounting_assertion_id" IS NOT NULL AND "fiscal_assertion_id" IS NOT NULL)
      OR ("action" IN ('put','retire') AND "accounting_assertion_id" IS NULL AND "fiscal_assertion_id" IS NULL))
  )
);

CREATE TABLE public."pos_manual_profile_state_events" (
  "id" bigserial PRIMARY KEY,
  "operation_id" bigint NOT NULL UNIQUE REFERENCES public."pos_manual_profile_operations"("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  "profile_id" uuid NOT NULL,
  "branch_id" integer NOT NULL,
  "profile_version" integer NOT NULL,
  "action" text NOT NULL,
  "from_state" text,
  "to_state" text NOT NULL,
  "config_hash" text NOT NULL,
  "reason_code" text,
  "write_txid" numeric(20,0) NOT NULL,
  "lifecycle_txid" numeric(20,0) NOT NULL DEFAULT pg_catalog.txid_current()::numeric,
  "created_at" timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT "pos_manual_profile_events_shape_check" CHECK (
    "action" IN ('put','activate','retire') AND "to_state" IN ('draft','active','retired') AND "config_hash" ~ '^[0-9a-f]{64}$'
  )
);

ALTER TABLE public."pos_manual_finalization_profiles"
  ADD COLUMN "lifecycle_txid" numeric(20,0) NOT NULL DEFAULT pg_catalog.txid_current()::numeric,
  ADD COLUMN "lifecycle_operation_id" bigint NOT NULL;

CREATE TABLE public."pos_manual_profile_gate_bindings" (
  "id" bigserial PRIMARY KEY,
  "operation_id" bigint NOT NULL,
  "profile_id" uuid NOT NULL,
  "connector_id" text NOT NULL,
  "old_profile_id" uuid,
  "old_profile_version" integer,
  "old_profile_hash" text,
  "new_profile_version" integer NOT NULL,
  "new_profile_hash" text NOT NULL,
  "write_txid" numeric(20,0) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT "pos_manual_profile_gate_binding_once" UNIQUE ("operation_id","connector_id"),
  CONSTRAINT "pos_manual_profile_gate_binding_hashes" CHECK (
    ("old_profile_hash" IS NULL OR "old_profile_hash" ~ '^[0-9a-f]{64}$') AND "new_profile_hash" ~ '^[0-9a-f]{64}$')
);

CREATE TABLE public."pos_manual_profile_admin_assertions" (
  "id" uuid PRIMARY KEY,
  "action" text NOT NULL,
  "branch_id" integer NOT NULL REFERENCES public."branches"("id") ON DELETE RESTRICT,
  "profile_id" uuid NOT NULL,
  "expected_version" integer NOT NULL,
  "expected_config_hash" text NOT NULL,
  "issuer_subject_id" text NOT NULL,
  "subject_id" text NOT NULL,
  "assertion_hash" text NOT NULL UNIQUE,
  "authority_hash" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "request_hash" text NOT NULL,
  "issued_at" timestamptz NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "consumed_operation_id" bigint UNIQUE REFERENCES public."pos_manual_profile_operations"("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  "consumed_at" timestamptz,
  "write_txid" numeric(20,0) NOT NULL DEFAULT pg_catalog.txid_current()::numeric,
  CONSTRAINT "pos_manual_profile_admin_idem_key" UNIQUE ("profile_id","action","idempotency_key"),
  CONSTRAINT "pos_manual_profile_admin_assertions_shape_check" CHECK (
    "action" IN ('put','activate','retire') AND "expected_version">0
    AND "expected_config_hash" ~ '^[0-9a-f]{64}$' AND "assertion_hash" ~ '^[0-9a-f]{64}$'
    AND "authority_hash" ~ '^[0-9a-f]{64}$' AND "request_hash" ~ '^[0-9a-f]{64}$'
    AND "idempotency_key" ~ '^([0-9a-f]{64}|[A-Za-z0-9_-]{43})$'
    AND "expires_at"="issued_at"+interval '120 seconds'
    AND (("consumed_operation_id" IS NULL AND "consumed_at" IS NULL) OR ("consumed_operation_id" IS NOT NULL AND "consumed_at" IS NOT NULL))
  )
);

CREATE TABLE public."pos_manual_profile_accounting_assertions" (
  "id" uuid PRIMARY KEY, "profile_id" uuid NOT NULL, "expected_version" integer NOT NULL,
  "expected_config_hash" text NOT NULL, "expected_accounting_policy_hash" text NOT NULL,
  "issuer_subject_id" text NOT NULL, "approver_id" text NOT NULL,
  "assertion_hash" text NOT NULL UNIQUE, "authority_hash" text NOT NULL,
  "idempotency_key" text NOT NULL, "request_hash" text NOT NULL,
  "issued_at" timestamptz NOT NULL, "expires_at" timestamptz NOT NULL,
  "consumed_operation_id" bigint UNIQUE REFERENCES public."pos_manual_profile_operations"("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  "consumed_at" timestamptz, "write_txid" numeric(20,0) NOT NULL DEFAULT pg_catalog.txid_current()::numeric,
  CONSTRAINT "pos_manual_profile_account_idem_key" UNIQUE ("profile_id","idempotency_key"),
  CONSTRAINT "pos_manual_profile_account_assert_shape_check" CHECK (
    "expected_version">0 AND "expected_config_hash" ~ '^[0-9a-f]{64}$' AND "expected_accounting_policy_hash" ~ '^[0-9a-f]{64}$'
    AND "assertion_hash" ~ '^[0-9a-f]{64}$' AND "authority_hash" ~ '^[0-9a-f]{64}$' AND "request_hash" ~ '^[0-9a-f]{64}$'
    AND "idempotency_key" ~ '^([0-9a-f]{64}|[A-Za-z0-9_-]{43})$' AND "expires_at"="issued_at"+interval '120 seconds'
    AND (("consumed_operation_id" IS NULL AND "consumed_at" IS NULL) OR ("consumed_operation_id" IS NOT NULL AND "consumed_at" IS NOT NULL))
  )
);

CREATE TABLE public."pos_manual_profile_fiscal_assertions" (
  "id" uuid PRIMARY KEY, "profile_id" uuid NOT NULL, "expected_version" integer NOT NULL,
  "expected_config_hash" text NOT NULL, "fiscal_mode" text NOT NULL, "expected_fiscal_policy_hash" text NOT NULL,
  "issuer_subject_id" text NOT NULL, "approver_id" text NOT NULL,
  "assertion_hash" text NOT NULL UNIQUE, "authority_hash" text NOT NULL,
  "idempotency_key" text NOT NULL, "request_hash" text NOT NULL,
  "issued_at" timestamptz NOT NULL, "expires_at" timestamptz NOT NULL,
  "consumed_operation_id" bigint UNIQUE REFERENCES public."pos_manual_profile_operations"("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  "consumed_at" timestamptz, "write_txid" numeric(20,0) NOT NULL DEFAULT pg_catalog.txid_current()::numeric,
  CONSTRAINT "pos_manual_profile_fiscal_idem_key" UNIQUE ("profile_id","idempotency_key"),
  CONSTRAINT "pos_manual_profile_fiscal_assert_shape_check" CHECK (
    "expected_version">0 AND "fiscal_mode" IN ('required_queue','not_applicable') AND "expected_config_hash" ~ '^[0-9a-f]{64}$' AND "expected_fiscal_policy_hash" ~ '^[0-9a-f]{64}$'
    AND "assertion_hash" ~ '^[0-9a-f]{64}$' AND "authority_hash" ~ '^[0-9a-f]{64}$' AND "request_hash" ~ '^[0-9a-f]{64}$'
    AND "idempotency_key" ~ '^([0-9a-f]{64}|[A-Za-z0-9_-]{43})$' AND "expires_at"="issued_at"+interval '120 seconds'
    AND (("consumed_operation_id" IS NULL AND "consumed_at" IS NULL) OR ("consumed_operation_id" IS NOT NULL AND "consumed_at" IS NOT NULL))
  )
);

CREATE FUNCTION public."pos_manual_t2_authority_v1"(p_capability text)
RETURNS text LANGUAGE plpgsql STABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE expected_role name; expected_hash text; actual_hash text;
BEGIN
  SELECT "role_name","authority_hash" INTO expected_role,expected_hash FROM public."pos_manual_t2_authorities" WHERE "capability"=p_capability;
  actual_hash:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('t2-authority-v1','UTF8')||pg_catalog.decode('00','hex')||
    pg_catalog.convert_to(pg_catalog.current_database(),'UTF8')||pg_catalog.decode('00','hex')||pg_catalog.convert_to(session_user,'UTF8')),'hex');
  IF expected_role IS NULL OR session_user::name IS DISTINCT FROM expected_role OR actual_hash IS DISTINCT FROM expected_hash
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=session_user)) THEN
    RAISE EXCEPTION 'T2 profile authority denied' USING ERRCODE='42501';
  END IF;
  RETURN actual_hash;
END
$function$;

CREATE FUNCTION public."pos_manual_t2_new_handle_v1"()
RETURNS text LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $function$
  SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.gen_random_uuid()::text||pg_catalog.gen_random_uuid()::text||pg_catalog.gen_random_uuid()::text,'UTF8')),'hex')
$function$;

CREATE FUNCTION public."pos_manual_t2_transaction_nonce_hash_v1"()
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE result text;
BEGIN
  INSERT INTO public."pos_manual_t2_transaction_nonces"("backend_pid","transaction_txid","nonce_hash")
  VALUES(pg_catalog.pg_backend_pid(),pg_catalog.txid_current()::numeric,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(public."pos_manual_t2_new_handle_v1"(),'UTF8')),'hex'))
  ON CONFLICT ("backend_pid","transaction_txid") DO NOTHING;
  SELECT "nonce_hash" INTO result FROM public."pos_manual_t2_transaction_nonces"
   WHERE "backend_pid"=pg_catalog.pg_backend_pid() AND "transaction_txid"=pg_catalog.txid_current()::numeric;
  IF result IS NULL THEN RAISE EXCEPTION 'T2 transaction nonce unavailable' USING ERRCODE='23514'; END IF;
  RETURN result;
END
$function$;

CREATE FUNCTION public."pos_manual_t2_write_observation_multiset_digest_v1"(p_observation_digests text[])
RETURNS text LANGUAGE plpgsql STABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE normalized text[];
BEGIN
  IF pg_catalog.cardinality(p_observation_digests) NOT BETWEEN 1 AND 2048
    OR EXISTS (SELECT 1 FROM pg_catalog.unnest(p_observation_digests) AS input(digest) WHERE digest IS NULL OR digest !~ '^[0-9a-f]{64}$') THEN
    RAISE EXCEPTION 'invalid T2 write observation digest multiset' USING ERRCODE='22023';
  END IF;
  SELECT pg_catalog.array_agg(digest ORDER BY digest COLLATE "C") INTO normalized
    FROM pg_catalog.unnest(p_observation_digests) AS input(digest);
  RETURN pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to('t2-write-observation-multiset-v1','UTF8')||pg_catalog.decode('00','hex')||
    pg_catalog.convert_to(pg_catalog.current_database(),'UTF8')||pg_catalog.decode('00','hex')||
    pg_catalog.convert_to(pg_catalog.array_to_string(normalized,','),'UTF8')),'hex');
END
$function$;

CREATE FUNCTION public."pos_manual_t2_float8_hex_v1"(p_value double precision)
RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
  IF p_value::text IN ('Infinity','-Infinity','NaN') THEN RAISE EXCEPTION 'non-finite T2 float8 is forbidden' USING ERRCODE='22023'; END IF;
  RETURN pg_catalog.encode(pg_catalog.float8send(p_value),'hex');
END
$function$;

CREATE FUNCTION public."pos_manual_t2_write_metadata_valid_v1"(
  p_capability text,p_aggregate_kind text,p_aggregate_id text,p_action text,p_trigger_identity text,p_dml_operation text)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
  SELECT pg_catalog.octet_length(p_aggregate_id) BETWEEN 1 AND 128
    AND p_aggregate_id=normalize(p_aggregate_id,NFC) AND p_aggregate_id!~'[[:cntrl:]]'
    AND (
      (p_capability='held_sale_items' AND p_aggregate_kind='held_sale' AND p_trigger_identity='pos_held_sale_items_payment_plan_guard'
        AND ((p_action='insert' AND p_dml_operation='INSERT') OR (p_action='update' AND p_dml_operation='UPDATE')
          OR (p_action='delete' AND p_dml_operation='DELETE') OR (p_action='replace_batch' AND p_dml_operation IN ('INSERT','DELETE'))))
      OR (p_capability='payment_artifact:manual_reference' AND p_aggregate_kind='manual_reference'
        AND p_trigger_identity='pos_manual_payment_references_t2_write_guard'
        AND ((p_action='create' AND p_dml_operation='INSERT') OR (p_action IN ('revoke','consume') AND p_dml_operation='UPDATE')))
      OR (p_capability='payment_artifact:intent' AND p_aggregate_kind='payment_intent'
        AND p_trigger_identity='pos_payment_intents_t2_write_guard'
        AND ((p_action='create' AND p_dml_operation='INSERT') OR (p_action IN ('retry','apply_delivery','apply_callback','cancel_before_dispatch','expire_before_dispatch','schedule_reconcile','force_manual_review','consume') AND p_dml_operation='UPDATE')))
      OR (p_capability='payment_artifact:sale_payment' AND p_aggregate_kind='sale_payment'
        AND p_trigger_identity='pos_sale_payments_t2_write_guard'
        AND ((p_action IN ('create_commit','create_intent_consumption','insert_refund_compensation','insert_refund_cancel','insert_refund_return') AND p_dml_operation='INSERT')
          OR (p_action='update_refund_status' AND p_dml_operation='UPDATE')))
      OR (p_capability='payment_plan_graph:operation' AND p_aggregate_kind='payment_plan'
        AND p_trigger_identity='pos_payment_plan_operations_insert_guard' AND p_action IN ('quote','activate','consume','supersede','expire') AND p_dml_operation='INSERT')
      OR (p_capability='payment_plan_graph:quote_lines' AND p_aggregate_kind='payment_plan'
        AND p_trigger_identity='pos_payment_plan_quote_lines_immutable_guard' AND p_action='quote' AND p_dml_operation='INSERT')
      OR (p_capability='payment_plan_graph:slots' AND p_aggregate_kind='payment_plan'
        AND p_trigger_identity='pos_payment_plan_slots_immutable_guard' AND p_action='activate' AND p_dml_operation='INSERT')
      OR (p_capability='payment_plan_graph:plan_transition' AND p_aggregate_kind='payment_plan'
        AND ((p_trigger_identity='pos_payment_plans_immutable_guard' AND ((p_action='quote' AND p_dml_operation='INSERT') OR (p_action IN ('activate','consume','supersede','expire') AND p_dml_operation='UPDATE')))
          OR (p_trigger_identity='pos_payment_plans_activation_guard' AND p_action IN ('activate','consume') AND p_dml_operation='UPDATE')))
      OR (p_capability='order_claim' AND p_aggregate_kind='order_claim' AND p_trigger_identity='pos_order_claim_identity_guard'
        AND ((p_action='claim' AND p_dml_operation='INSERT') OR (p_action IN ('renew','release','expire','convert') AND p_dml_operation='UPDATE')))
      OR (p_capability='order_claim:operation' AND p_aggregate_kind='order_claim'
        AND p_trigger_identity='pos_order_claim_operations_write_guard'
        AND p_action IN ('claim','renew','release','expire','convert') AND p_dml_operation='INSERT')
      OR (p_capability='legacy_manual:open_case:case' AND p_aggregate_kind='manual_case'
        AND p_trigger_identity='protect_pos_manual_case' AND p_action='open' AND p_dml_operation='INSERT')
      OR (p_capability='legacy_manual:open_case:operation' AND p_aggregate_kind='manual_case'
        AND p_trigger_identity='guard_pos_manual_operation' AND p_action='open' AND p_dml_operation='INSERT')
      OR (p_capability='legacy_manual:open_case:state_event' AND p_aggregate_kind='manual_case'
        AND p_trigger_identity='guard_pos_manual_state_event' AND p_action='open' AND p_dml_operation='INSERT')
      OR (p_capability='legacy_manual:review:case' AND p_aggregate_kind='manual_case'
        AND p_trigger_identity='protect_pos_manual_case' AND p_action IN ('authorize_query','reject') AND p_dml_operation='UPDATE')
      OR (p_capability='legacy_manual:review:operation' AND p_aggregate_kind='manual_case'
        AND p_trigger_identity='guard_pos_manual_operation' AND p_action IN ('authorize_query','reject') AND p_dml_operation='INSERT')
      OR (p_capability='legacy_manual:review:state_event' AND p_aggregate_kind='manual_case'
        AND p_trigger_identity='guard_pos_manual_state_event' AND p_action IN ('authorize_query','reject') AND p_dml_operation='INSERT')
      OR (p_capability IN ('legacy_manual:record_callback:case','legacy_manual:complete_delivery:case')
        AND p_aggregate_kind='manual_case' AND p_trigger_identity='protect_pos_manual_case'
        AND p_action='observe' AND p_dml_operation='UPDATE')
      OR (p_capability IN ('legacy_manual:record_callback:operation','legacy_manual:complete_delivery:operation')
        AND p_aggregate_kind='manual_case' AND p_trigger_identity='guard_pos_manual_operation'
        AND p_action='observe' AND p_dml_operation='INSERT')
      OR (p_capability IN ('legacy_manual:record_callback:state_event','legacy_manual:complete_delivery:state_event')
        AND p_aggregate_kind='manual_case' AND p_trigger_identity='guard_pos_manual_state_event'
        AND p_action='observe' AND p_dml_operation='INSERT')
      OR (p_capability IN ('legacy_manual:report_transport:case','legacy_manual:claim_queries:case')
        AND p_aggregate_kind='manual_case' AND p_trigger_identity='protect_pos_manual_case'
        AND p_action='block' AND p_dml_operation='UPDATE')
      OR (p_capability='legacy_manual:report_transport:case_evidence' AND p_aggregate_kind='manual_case'
        AND p_trigger_identity='protect_pos_manual_case' AND p_action='evidence_update' AND p_dml_operation='UPDATE')
      OR (p_capability IN ('legacy_manual:report_transport:operation','legacy_manual:claim_queries:operation')
        AND p_aggregate_kind='manual_case' AND p_trigger_identity='guard_pos_manual_operation'
        AND p_action='block' AND p_dml_operation='INSERT')
      OR (p_capability IN ('legacy_manual:report_transport:state_event','legacy_manual:claim_queries:state_event')
        AND p_aggregate_kind='manual_case' AND p_trigger_identity='guard_pos_manual_state_event'
        AND p_action='block' AND p_dml_operation='INSERT')
    )
$function$;

ALTER TABLE public."pos_manual_t2_write_roots" ADD CONSTRAINT "pos_manual_t2_write_roots_metadata_check" CHECK (
  public."pos_manual_t2_write_metadata_valid_v1"("capability","aggregate_kind","aggregate_id","action","trigger_identity","dml_operation")
  AND (("capability"='held_sale_items' OR "capability"='payment_plan_graph:quote_lines') AND "expected_observation_count" BETWEEN 1 AND 200
    OR ("capability"='payment_plan_graph:slots' AND "expected_observation_count" BETWEEN 1 AND 10)
    OR ("capability" NOT IN ('held_sale_items','payment_plan_graph:quote_lines','payment_plan_graph:slots') AND "expected_observation_count"=1))
);
ALTER TABLE public."pos_manual_t2_write_observations" ADD CONSTRAINT "pos_manual_t2_write_observations_metadata_check" CHECK (
  public."pos_manual_t2_write_metadata_valid_v1"("capability","aggregate_kind","aggregate_id","action","trigger_identity","dml_operation")
);

CREATE FUNCTION public."pos_manual_t2_write_observation_digest_v1"(
  p_capability text,p_aggregate_kind text,p_aggregate_id text,p_action text,p_trigger_identity text,p_dml_operation text,p_old_projection jsonb,p_new_projection jsonb)
RETURNS text LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
  IF NOT public."pos_manual_t2_write_metadata_valid_v1"(p_capability,p_aggregate_kind,p_aggregate_id,p_action,p_trigger_identity,p_dml_operation)
    OR (p_dml_operation='INSERT' AND (p_old_projection IS NOT NULL OR pg_catalog.jsonb_typeof(p_new_projection)<>'object'))
    OR (p_dml_operation='DELETE' AND (pg_catalog.jsonb_typeof(p_old_projection)<>'object' OR p_new_projection IS NOT NULL))
    OR (p_dml_operation='UPDATE' AND (pg_catalog.jsonb_typeof(p_old_projection)<>'object' OR pg_catalog.jsonb_typeof(p_new_projection)<>'object')) THEN
    RAISE EXCEPTION 'invalid T2 write observation metadata or projection shape' USING ERRCODE='22023';
  END IF;
  RETURN pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to('t2-write-observation-v1','UTF8')||pg_catalog.decode('00','hex')||
    pg_catalog.convert_to(pg_catalog.current_database(),'UTF8')||pg_catalog.decode('00','hex')||
    pg_catalog.convert_to(p_capability,'UTF8')||pg_catalog.decode('00','hex')||pg_catalog.convert_to(p_aggregate_kind,'UTF8')||pg_catalog.decode('00','hex')||
    pg_catalog.convert_to(p_aggregate_id,'UTF8')||pg_catalog.decode('00','hex')||pg_catalog.convert_to(p_action,'UTF8')||pg_catalog.decode('00','hex')||
    pg_catalog.convert_to(p_trigger_identity,'UTF8')||pg_catalog.decode('00','hex')||pg_catalog.convert_to(p_dml_operation,'UTF8')||pg_catalog.decode('00','hex')||
    pg_catalog.convert_to(CASE WHEN p_old_projection IS NULL THEN 'null' ELSE public."pos_manual_canonical_json_v1"(p_old_projection) END,'UTF8')||pg_catalog.decode('00','hex')||
    pg_catalog.convert_to(CASE WHEN p_new_projection IS NULL THEN 'null' ELSE public."pos_manual_canonical_json_v1"(p_new_projection) END,'UTF8')),'hex');
END
$function$;

CREATE FUNCTION public."pos_manual_t2_write_authority_capability_v1"(p_capability text)
RETURNS text LANGUAGE sql IMMUTABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
  SELECT CASE
    WHEN p_capability LIKE 'legacy_manual:open_case:%' THEN 'manual_vault_binder'
    WHEN p_capability LIKE 'legacy_manual:record_callback:%' THEN 'manual_callback'
    WHEN p_capability LIKE 'legacy_manual:attest_query_response:%'
      OR p_capability LIKE 'legacy_manual:complete_delivery:%'
      OR p_capability LIKE 'legacy_manual:report_transport:%'
      OR p_capability LIKE 'legacy_manual:claim_queries:%' THEN 'manual_worker'
    ELSE 'runtime'
  END
$function$;

-- Closed projections for the legacy manual-payment lifecycle.  They omit only
-- physical creation/update clocks; every causal, identity and evidence field
-- remains committed by the root digest.  Producers must derive these values
-- from their locked rows -- no public API accepts either projection or digest.
CREATE FUNCTION public."pos_manual_t2_legacy_case_projection_v1"(
  p_row public."pos_manual_payment_cases")
RETURNS jsonb LANGUAGE sql IMMUTABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
  SELECT pg_catalog.to_jsonb(p_row)-'created_at'-'updated_at'
$function$;

CREATE FUNCTION public."pos_manual_t2_legacy_operation_projection_v1"(
  p_row public."pos_manual_payment_operations")
RETURNS jsonb LANGUAGE sql IMMUTABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
  SELECT pg_catalog.to_jsonb(p_row)-'created_at'
$function$;

CREATE FUNCTION public."pos_manual_t2_legacy_state_event_projection_v1"(
  p_row public."pos_manual_payment_state_events")
RETURNS jsonb LANGUAGE sql IMMUTABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
  SELECT pg_catalog.to_jsonb(p_row)-'created_at'
$function$;

-- Structural observer shared by the three eventual row guards.  Its only
-- lookup is the owner-only transaction root; it never reads a business table
-- and it never creates authority on behalf of the DML statement.
CREATE FUNCTION public."pos_manual_t2_observe_legacy_write_v1"(
  p_case_id uuid,p_trigger_identity text,p_dml_operation text,
  p_old_projection jsonb,p_new_projection jsonb)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE matched_capability text; matched_action text; matched_count integer;
BEGIN
  SELECT pg_catalog.max(root."capability"),pg_catalog.max(root."action"),pg_catalog.count(*)::integer
    INTO matched_capability,matched_action,matched_count
    FROM public."pos_manual_t2_write_roots" root
   WHERE root."backend_pid"=pg_catalog.pg_backend_pid()
     AND root."transaction_txid"=pg_catalog.txid_current()::numeric
     AND root."aggregate_kind"='manual_case'
     AND root."aggregate_id"=p_case_id::text
     AND root."capability" LIKE 'legacy_manual:%'
     AND root."trigger_identity"=p_trigger_identity
     AND root."dml_operation"=p_dml_operation;
  IF matched_count<>1 THEN
    RAISE EXCEPTION 'manual lifecycle write requires one exact producer root' USING ERRCODE='42501';
  END IF;
  PERFORM public."pos_manual_t2_observe_write_v1"(
    matched_capability,'manual_case',p_case_id::text,matched_action,
    p_trigger_identity,p_dml_operation,p_old_projection,p_new_projection);
END
$function$;

CREATE FUNCTION public."pos_manual_t2_observe_legacy_case_v1"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
  PERFORM public."pos_manual_t2_observe_legacy_write_v1"(
    NEW."id",'protect_pos_manual_case',TG_OP,
    CASE WHEN TG_OP='UPDATE' THEN public."pos_manual_t2_legacy_case_projection_v1"(OLD) ELSE NULL END,
    public."pos_manual_t2_legacy_case_projection_v1"(NEW));
  RETURN NEW;
END
$function$;

CREATE FUNCTION public."pos_manual_t2_observe_legacy_operation_v1"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
  PERFORM public."pos_manual_t2_observe_legacy_write_v1"(
    NEW."case_id",'guard_pos_manual_operation','INSERT',NULL,
    public."pos_manual_t2_legacy_operation_projection_v1"(NEW));
  RETURN NEW;
END
$function$;

CREATE FUNCTION public."pos_manual_t2_observe_legacy_state_event_v1"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
  PERFORM public."pos_manual_t2_observe_legacy_write_v1"(
    NEW."case_id",'guard_pos_manual_state_event','INSERT',NULL,
    public."pos_manual_t2_legacy_state_event_projection_v1"(NEW));
  RETURN NEW;
END
$function$;

CREATE FUNCTION public."pos_manual_t2_open_legacy_case_root_v1"(
  p_capability text,p_action text,p_dml_operation text,
  p_old public."pos_manual_payment_cases",p_new public."pos_manual_payment_cases")
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE old_doc jsonb; new_doc jsonb; authority text;
BEGIN
  old_doc:=CASE WHEN p_dml_operation='UPDATE' THEN public."pos_manual_t2_legacy_case_projection_v1"(p_old) ELSE NULL END;
  new_doc:=public."pos_manual_t2_legacy_case_projection_v1"(p_new);
  authority:=public."pos_manual_t2_authority_v1"(public."pos_manual_t2_write_authority_capability_v1"(p_capability));
  PERFORM public."pos_manual_t2_open_write_root_v1"(
    p_capability,'manual_case',p_new."id"::text,p_action,'protect_pos_manual_case',p_dml_operation,authority,
    ARRAY[public."pos_manual_t2_write_observation_digest_v1"(
      p_capability,'manual_case',p_new."id"::text,p_action,'protect_pos_manual_case',p_dml_operation,old_doc,new_doc)]);
END
$function$;

CREATE FUNCTION public."pos_manual_t2_open_legacy_operation_root_v1"(
  p_capability text,p_action text,p_new public."pos_manual_payment_operations")
RETURNS void LANGUAGE plpgsql VOLATILE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE new_doc jsonb; authority text;
BEGIN
  new_doc:=public."pos_manual_t2_legacy_operation_projection_v1"(p_new);
  authority:=public."pos_manual_t2_authority_v1"(public."pos_manual_t2_write_authority_capability_v1"(p_capability));
  PERFORM public."pos_manual_t2_open_write_root_v1"(
    p_capability,'manual_case',p_new."case_id"::text,p_action,'guard_pos_manual_operation','INSERT',authority,
    ARRAY[public."pos_manual_t2_write_observation_digest_v1"(
      p_capability,'manual_case',p_new."case_id"::text,p_action,'guard_pos_manual_operation','INSERT',NULL,new_doc)]);
END
$function$;

CREATE FUNCTION public."pos_manual_t2_open_legacy_state_event_root_v1"(
  p_capability text,p_action text,p_new public."pos_manual_payment_state_events")
RETURNS void LANGUAGE plpgsql VOLATILE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE new_doc jsonb; authority text;
BEGIN
  new_doc:=public."pos_manual_t2_legacy_state_event_projection_v1"(p_new);
  authority:=public."pos_manual_t2_authority_v1"(public."pos_manual_t2_write_authority_capability_v1"(p_capability));
  PERFORM public."pos_manual_t2_open_write_root_v1"(
    p_capability,'manual_case',p_new."case_id"::text,p_action,'guard_pos_manual_state_event','INSERT',authority,
    ARRAY[public."pos_manual_t2_write_observation_digest_v1"(
      p_capability,'manual_case',p_new."case_id"::text,p_action,'guard_pos_manual_state_event','INSERT',NULL,new_doc)]);
END
$function$;

CREATE FUNCTION public."pos_manual_t2_open_write_root_v1"(
  p_capability text,p_aggregate_kind text,p_aggregate_id text,p_action text,p_trigger_identity text,p_dml_operation text,p_caller_role_hash text,p_expected_observation_digests text[])
RETURNS void LANGUAGE plpgsql VOLATILE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE nonce_hash text; expected_count integer; expected_multiset_digest text;
BEGIN
  IF NOT public."pos_manual_t2_write_metadata_valid_v1"(p_capability,p_aggregate_kind,p_aggregate_id,p_action,p_trigger_identity,p_dml_operation)
    OR p_caller_role_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid T2 write root shape' USING ERRCODE='22023'; END IF;
  IF p_caller_role_hash IS DISTINCT FROM public."pos_manual_t2_authority_v1"(
      public."pos_manual_t2_write_authority_capability_v1"(p_capability)) THEN
    RAISE EXCEPTION 'T2 write root caller authority mismatch' USING ERRCODE='42501'; END IF;
  expected_count:=pg_catalog.cardinality(p_expected_observation_digests);
  IF NOT ((p_capability IN ('held_sale_items','payment_plan_graph:quote_lines') AND expected_count BETWEEN 1 AND 200)
    OR (p_capability='payment_plan_graph:slots' AND expected_count BETWEEN 1 AND 10)
    OR (p_capability NOT IN ('held_sale_items','payment_plan_graph:quote_lines','payment_plan_graph:slots') AND expected_count=1)) THEN
    RAISE EXCEPTION 'invalid T2 write root cardinality' USING ERRCODE='22023'; END IF;
  expected_multiset_digest:=public."pos_manual_t2_write_observation_multiset_digest_v1"(p_expected_observation_digests);
  nonce_hash:=public."pos_manual_t2_transaction_nonce_hash_v1"();
  INSERT INTO public."pos_manual_t2_write_roots"(
    "backend_pid","transaction_txid","nonce_hash","caller_role_hash","capability","aggregate_kind","aggregate_id","action","trigger_identity","dml_operation",
    "expected_observation_count","expected_observation_multiset_digest")
  VALUES (pg_catalog.pg_backend_pid(),pg_catalog.txid_current()::numeric,nonce_hash,p_caller_role_hash,p_capability,p_aggregate_kind,p_aggregate_id,p_action,p_trigger_identity,p_dml_operation,
    expected_count,expected_multiset_digest);
END
$function$;

CREATE FUNCTION public."pos_manual_t2_observe_write_v1"(
  p_capability text,p_aggregate_kind text,p_aggregate_id text,p_action text,p_trigger_identity text,p_dml_operation text,p_old_projection jsonb,p_new_projection jsonb)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE current_nonce_hash text; current_authority text; matched_root_id bigint; observation_digest text;
BEGIN
  observation_digest:=public."pos_manual_t2_write_observation_digest_v1"(p_capability,p_aggregate_kind,p_aggregate_id,p_action,p_trigger_identity,p_dml_operation,p_old_projection,p_new_projection);
  current_authority:=public."pos_manual_t2_authority_v1"(
    public."pos_manual_t2_write_authority_capability_v1"(p_capability));
  SELECT nonce."nonce_hash" INTO current_nonce_hash FROM public."pos_manual_t2_transaction_nonces" nonce
   WHERE nonce."backend_pid"=pg_catalog.pg_backend_pid() AND nonce."transaction_txid"=pg_catalog.txid_current()::numeric;
  IF current_nonce_hash IS NULL THEN RAISE EXCEPTION 'T2 write root is not live in this transaction' USING ERRCODE='23514'; END IF;
  SELECT root."id" INTO STRICT matched_root_id FROM public."pos_manual_t2_write_roots" root
   WHERE root."backend_pid"=pg_catalog.pg_backend_pid() AND root."transaction_txid"=pg_catalog.txid_current()::numeric AND root."nonce_hash"=current_nonce_hash
     AND root."caller_role_hash"=current_authority
     AND ROW(root."capability",root."aggregate_kind",root."aggregate_id",root."action",root."trigger_identity",root."dml_operation")
       = ROW(p_capability,p_aggregate_kind,p_aggregate_id,p_action,p_trigger_identity,p_dml_operation);
  INSERT INTO public."pos_manual_t2_write_observations"(
    "root_id","capability","aggregate_kind","aggregate_id","action","trigger_identity","dml_operation","observation_digest")
  VALUES (matched_root_id,p_capability,p_aggregate_kind,p_aggregate_id,p_action,p_trigger_identity,p_dml_operation,observation_digest);
EXCEPTION WHEN no_data_found OR too_many_rows THEN
  RAISE EXCEPTION 'T2 write root does not exactly match this trigger observation' USING ERRCODE='23514';
END
$function$;

CREATE FUNCTION public."pos_manual_t2_assert_shape_v1"(p_idempotency_key text,p_request_hash text)
RETURNS void LANGUAGE plpgsql IMMUTABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
  IF p_idempotency_key !~ '^([0-9a-f]{64}|[A-Za-z0-9_-]{43})$' OR p_request_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid T2 profile request shape' USING ERRCODE='22023';
  END IF;
END
$function$;

CREATE FUNCTION public."pos_manual_t2_profile_request_hash_v1"(p_domain text,p_parameters jsonb)
RETURNS text LANGUAGE plpgsql STABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
  IF p_domain NOT IN ('profile-admin-assert-v1','profile-accounting-assert-v1','profile-fiscal-assert-v1','profile-put-v1','profile-activate-v1','profile-retire-v1') THEN
    RAISE EXCEPTION 'invalid profile request domain' USING ERRCODE='22023'; END IF;
  RETURN pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_domain,'UTF8')||pg_catalog.decode('00','hex')||
    pg_catalog.convert_to(pg_catalog.current_database(),'UTF8')||pg_catalog.decode('00','hex')||pg_catalog.convert_to(session_user,'UTF8')||
    pg_catalog.decode('00','hex')||pg_catalog.convert_to(public."pos_manual_canonical_json_v1"(p_parameters),'UTF8')),'hex');
END
$function$;

CREATE FUNCTION public."pos_manual_t2_subject_safe_v1"(p_value text)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
  SELECT pg_catalog.octet_length(p_value) BETWEEN 1 AND 128 AND p_value=normalize(p_value,NFC) AND p_value!~'[[:cntrl:]]'
$function$;

CREATE FUNCTION public."pos_manual_t2_canonical_text_dlp_safe_v1"(p_canonical text)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
 SELECT NOT (
   public."pos_manual_identifier_contains_pan_321f"(p_canonical)
   OR p_canonical ~* '(cvv|cvc|pin|track[12]|vault[_ -]?token|open[_ -]?reference|authorization[_ -]?code|(^|[^a-z])nsu([^a-z]|$)|end[_ -]?to[_ -]?end|e2e)'
   OR p_canonical ~* '(^|[^A-Za-z0-9_])(customer[_ -]?(name|email|phone|address)|name|nome|e-?mail|telefone|phone|street|avenue|address|logradouro|postal[_ -]?code|cep|cpf|cnpj)([^A-Za-z0-9_]|$)'
   OR p_canonical ~* '[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}'
   OR p_canonical ~ '(^|[^0-9])([0-9]{3}[.]?[0-9]{3}[.]?[0-9]{3}-?[0-9]{2}|[0-9]{2}[.]?[0-9]{3}[.]?[0-9]{3}[/]?[0-9]{4}-?[0-9]{2})([^0-9]|$)'
   OR p_canonical ~* '(\+55[[:space:]]?)?[(][0-9]{2}[)][[:space:]]?[0-9]{4,5}-[0-9]{4}'
   OR p_canonical ~ '"[0-9]{5}-[0-9]{3}"'
   OR p_canonical ~* '"(rua|avenida|av[.]|travessa|street|avenue)[[:space:]][^"[:cntrl:]]{2,160}"')
$function$;

CREATE OR REPLACE FUNCTION public."pos_manual_t2_json_dlp_safe_v1"(p_document_kind text,p_value jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE canonical text;
BEGIN
 IF pg_catalog.jsonb_typeof(p_value)<>'object' OR pg_catalog.pg_column_size(p_value) NOT BETWEEN 2 AND 65536
   OR NOT (p_value?'schemaVersion') OR p_value->'schemaVersion'<>'1'::jsonb THEN RETURN false; END IF;
 IF p_document_kind='case_evidence' AND (NOT (p_value?'referenceLastFour') OR pg_catalog.jsonb_typeof(p_value->'referenceLastFour')<>'string'
   OR p_value->>'referenceLastFour'!~'^[A-Za-z0-9*#._:-]{4}$') THEN RETURN false; END IF;
 canonical:=public."pos_manual_canonical_json_v1"(p_value);
 RETURN public."pos_manual_t2_canonical_text_dlp_safe_v1"(canonical)
   AND public."pos_manual_t2_dlp_walk_impl_v1"(p_document_kind,p_value,0);
END
$function$;

CREATE OR REPLACE FUNCTION public."pos_manual_t2_subject_safe_v1"(p_value text)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
 SELECT pg_catalog.octet_length(p_value) BETWEEN 1 AND 128 AND p_value=normalize(p_value,NFC)
   AND p_value!~'[[:cntrl:]]'
   AND public."pos_manual_t2_canonical_text_dlp_safe_v1"(public."pos_manual_canonical_json_v1"(pg_catalog.to_jsonb(p_value)))
$function$;

CREATE FUNCTION public."pos_manual_t2_transition_digest_v1"(p_kind text,p_value jsonb)
RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
  IF p_kind NOT IN ('session','session_event','handoff','plan','plan_operation') THEN RAISE EXCEPTION 'invalid transition digest kind' USING ERRCODE='22023'; END IF;
  RETURN pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('t2-'||p_kind||'-transition-v1','UTF8')||pg_catalog.decode('00','hex')||
    pg_catalog.convert_to(public."pos_manual_canonical_json_v1"(p_value),'UTF8')),'hex');
END
$function$;

CREATE FUNCTION public."pos_manual_t2_request_digest_v1"(p_kind text,p_action text,p_aggregate_id text,p_old_digest text,p_new_digest text,p_causal_request_hash text)
RETURNS text LANGUAGE plpgsql STABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
 IF p_kind NOT IN ('session','session_event','handoff','plan','plan_operation') OR p_old_digest!~'^[0-9a-f]{64}$' OR p_new_digest!~'^[0-9a-f]{64}$' OR p_causal_request_hash!~'^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid operational request digest input' USING ERRCODE='22023'; END IF;
 RETURN pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('t2-'||p_kind||'-context-v1','UTF8')||pg_catalog.decode('00','hex')||pg_catalog.convert_to(pg_catalog.current_database(),'UTF8')||pg_catalog.decode('00','hex')||pg_catalog.convert_to(session_user,'UTF8')||pg_catalog.decode('00','hex')||pg_catalog.convert_to(p_action,'UTF8')||pg_catalog.decode('00','hex')||pg_catalog.convert_to(p_aggregate_id,'UTF8')||pg_catalog.decode('00','hex')||pg_catalog.convert_to(p_old_digest,'UTF8')||pg_catalog.decode('00','hex')||pg_catalog.convert_to(p_new_digest,'UTF8')||pg_catalog.decode('00','hex')||pg_catalog.convert_to(p_causal_request_hash,'UTF8')),'hex');
END
$function$;

CREATE FUNCTION public."pos_manual_t2_insert_transition_context_v1"(p_capability text,p_action text,p_aggregate_id text,p_old jsonb,p_new jsonb,p_request_hash text,p_authority text)
RETURNS void LANGUAGE plpgsql VOLATILE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE nonce_hash text; kind text;
BEGIN
  kind:=CASE p_capability WHEN 'session_transition' THEN 'session' WHEN 'session_event' THEN 'session_event' WHEN 'handoff_transition' THEN 'handoff' WHEN 'plan_release' THEN 'plan' WHEN 'plan_operation' THEN 'plan_operation' END;
  IF kind IS NULL THEN RAISE EXCEPTION 'invalid transition capability' USING ERRCODE='42501'; END IF;
  nonce_hash:=public."pos_manual_t2_transaction_nonce_hash_v1"();
  INSERT INTO public."pos_manual_t2_lock_contexts"("backend_pid","transaction_txid","caller_role_hash","capability","aggregate_kind","aggregate_id","transition_action","old_digest","new_digest","request_digest","nonce_hash")
  VALUES(pg_catalog.pg_backend_pid(),pg_catalog.txid_current()::numeric,p_authority,p_capability,kind,p_aggregate_id,p_action,
    public."pos_manual_t2_transition_digest_v1"(kind,p_old),public."pos_manual_t2_transition_digest_v1"(kind,p_new),
    public."pos_manual_t2_request_digest_v1"(kind,p_action,p_aggregate_id,public."pos_manual_t2_transition_digest_v1"(kind,p_old),public."pos_manual_t2_transition_digest_v1"(kind,p_new),p_request_hash),
    nonce_hash);
END
$function$;

CREATE FUNCTION public."pos_manual_prepare_session_transition_v1"(p_action text,p_session_id integer,p_expected_version integer,p_actor_profile_id integer,p_actor_user_id text,p_idempotency_key text,p_request_hash text)
RETURNS void LANGUAGE plpgsql VOLATILE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE s record; actor_row record; role_row record; authority text; old_doc jsonb; new_doc jsonb; target_status text; target_version integer; target_operator integer; target_close_hash text; session_branch integer;
BEGIN
  IF p_request_hash !~ '^[0-9a-f]{64}$' OR p_action NOT IN ('close','suspend','resume') OR p_expected_version<1 OR NOT public."pos_manual_t2_subject_safe_v1"(p_actor_user_id)
    OR (p_action='close' AND (pg_catalog.octet_length(p_idempotency_key) NOT BETWEEN 1 AND 100 OR p_idempotency_key<>normalize(p_idempotency_key,NFC) OR p_idempotency_key~'[[:cntrl:]]'))
    OR (p_action<>'close' AND (pg_catalog.octet_length(p_idempotency_key) NOT BETWEEN 16 AND 160 OR p_idempotency_key!~'^[A-Za-z0-9._:-]+$')) THEN RAISE EXCEPTION 'invalid session transition shape' USING ERRCODE='22023'; END IF;
  authority:=public."pos_manual_t2_authority_v1"('runtime');
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('t2-session:'||p_idempotency_key,0));
  SELECT * INTO s FROM public."cash_register_sessions" WHERE "id"=p_session_id FOR UPDATE;
  IF s.id IS NULL OR s.version<>p_expected_version OR s.operator_profile_id<>p_actor_profile_id THEN RAISE EXCEPTION 'session transition boundary changed' USING ERRCODE='23514'; END IF;
  SELECT "branch_id" INTO session_branch FROM public."pos_registers" WHERE "id"=s.register_id FOR SHARE;
  SELECT * INTO actor_row FROM public."tenant_user_profiles" WHERE "id"=p_actor_profile_id AND "user_id"=p_actor_user_id AND "status"='active' FOR SHARE;
  IF actor_row.id IS NULL THEN RAISE EXCEPTION 'session actor boundary missing' USING ERRCODE='42501'; END IF;
  SELECT * INTO role_row FROM public."tenant_roles" WHERE "id"=actor_row.role_id AND "active" FOR SHARE;
  IF role_row.id IS NULL THEN RAISE EXCEPTION 'session actor role denied' USING ERRCODE='42501'; END IF;
  IF role_row.key NOT IN ('owner','admin') THEN
    IF session_branch IS NOT NULL THEN
      PERFORM 1 FROM public."branch_user_accesses" WHERE "branch_id"=session_branch AND "user_profile_id"=p_actor_profile_id AND "can_sell" FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'session actor grant denied' USING ERRCODE='42501'; END IF;
    END IF;
  END IF;
  PERFORM 1 FROM public."pos_manual_payment_cases" WHERE "session_id"=s.id ORDER BY "id" FOR SHARE;
  IF EXISTS (SELECT 1 FROM public."pos_manual_payment_cases" WHERE "session_id"=s.id AND "state" IN ('review_pending','unknown','confirmed_paid','application_pending','blocked')) THEN RAISE EXCEPTION 'session has unresolved manual reconciliation' USING ERRCODE='23514'; END IF;
  target_status:=CASE WHEN p_action='close' AND s.status='open' THEN 'closing' WHEN p_action='close' AND s.status='closing' THEN 'closed' WHEN p_action='suspend' AND s.status='open' THEN 'suspended' WHEN p_action='resume' AND s.status='suspended' THEN 'open' END;
  IF target_status IS NULL THEN RAISE EXCEPTION 'session transition invalid' USING ERRCODE='23514'; END IF;
  target_version:=CASE WHEN p_action='close' AND s.status='closing' THEN s.version ELSE s.version+1 END; target_operator:=s.operator_profile_id;
  target_close_hash:=CASE WHEN p_action='close' AND s.status='open' THEN p_request_hash ELSE s.close_request_hash END;
  IF p_action='close' AND s.status='closing' AND s.close_request_hash<>p_request_hash THEN RAISE EXCEPTION 'session close causal request changed' USING ERRCODE='23505'; END IF;
  old_doc:=pg_catalog.jsonb_build_object('id',s.id,'status',s.status,'operatorProfileId',s.operator_profile_id,'version',s.version);
  new_doc:=pg_catalog.jsonb_build_object('id',s.id,'status',target_status,'operatorProfileId',target_operator,'version',target_version);
  PERFORM public."pos_manual_t2_insert_transition_context_v1"('session_transition',p_action,s.id::text,old_doc,new_doc,p_request_hash,authority);
  IF p_action IN ('suspend','resume') THEN
    PERFORM public."pos_manual_t2_insert_transition_context_v1"('session_event',p_action,s.id::text,'null'::jsonb,
      pg_catalog.jsonb_build_object('sessionId',s.id,'type',CASE p_action WHEN 'suspend' THEN 'session_suspended' ELSE 'session_resumed' END,
        'idempotencyKey',p_idempotency_key,'requestHash',p_request_hash),p_request_hash,authority);
  END IF;
END
$function$;

CREATE FUNCTION public."pos_manual_prepare_plan_release_v1"(p_action text,p_plan_id text,p_expected_version integer,p_actor_user_id text,p_idempotency_key text,p_request_hash text)
RETURNS void LANGUAGE plpgsql VOLATILE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE p public."pos_payment_plans"%ROWTYPE; locator public."pos_payment_plans"%ROWTYPE; authority text; target_state text;
BEGIN
  IF p_request_hash !~ '^[0-9a-f]{64}$' OR pg_catalog.octet_length(p_idempotency_key) NOT BETWEEN 16 AND 160 OR p_idempotency_key!~'^[A-Za-z0-9._:-]+$'
    OR p_action NOT IN ('supersede','expire') OR p_expected_version<0 OR NOT public."pos_manual_t2_subject_safe_v1"(p_actor_user_id)
    OR (p_action='expire' AND p_actor_user_id<>'system:pos-payment-maintenance') THEN RAISE EXCEPTION 'invalid plan release shape' USING ERRCODE='22023'; END IF;
  authority:=public."pos_manual_t2_authority_v1"('runtime');
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('t2-plan:'||p_idempotency_key,0));
  SELECT * INTO locator FROM public."pos_payment_plans" WHERE "id"=p_plan_id;
  IF locator.session_id IS NULL THEN RAISE EXCEPTION 'plan release boundary changed' USING ERRCODE='23514'; END IF;
  PERFORM 1 FROM public."cash_register_sessions" WHERE "id"=locator.session_id FOR UPDATE;
  PERFORM 1 FROM public."pos_terminals" WHERE "id"=locator.terminal_id FOR UPDATE;
  PERFORM 1
    FROM public."tenant_user_profiles" profile
    JOIN public."branches" branch ON branch."id"=locator.branch_id
    JOIN public."pos_registers" register ON register."id"=locator.register_id AND register."branch_id"=branch."id"
    JOIN public."branch_user_accesses" branch_access ON branch_access."branch_id"=branch."id" AND branch_access."user_profile_id"=profile."id"
    JOIN public."pos_register_accesses" register_access ON register_access."register_id"=register."id" AND register_access."user_profile_id"=profile."id"
   WHERE profile."id"=locator.operator_profile_id AND profile."status"='active' AND branch."status"='active' AND register."status"='active'
     AND branch_access."can_sell" AND register_access."active" AND register_access."can_sell"
     AND (register_access."valid_from" IS NULL OR register_access."valid_from"<=pg_catalog.clock_timestamp())
     AND (register_access."valid_until" IS NULL OR register_access."valid_until">=pg_catalog.clock_timestamp())
   FOR SHARE OF profile,branch,register,branch_access,register_access;
  IF NOT FOUND THEN RAISE EXCEPTION 'plan live access boundary changed' USING ERRCODE='23514'; END IF;
  IF locator.order_claim_id IS NOT NULL THEN PERFORM 1 FROM public."pos_order_claims" WHERE "id"=locator.order_claim_id FOR UPDATE; END IF;
  PERFORM 1 FROM public."pos_held_sales" WHERE "id"=locator.sale_draft_id FOR UPDATE;
  SELECT * INTO p FROM public."pos_payment_plans" WHERE "id"=p_plan_id FOR UPDATE;
  IF p.id IS NULL OR ROW(p.session_id,p.terminal_id,p.operator_profile_id,p.branch_id,p.register_id,p.order_claim_id,p.sale_draft_id)
    IS DISTINCT FROM ROW(locator.session_id,locator.terminal_id,locator.operator_profile_id,locator.branch_id,locator.register_id,locator.order_claim_id,locator.sale_draft_id)
    OR p.version<>p_expected_version OR p.state NOT IN ('quoted','active') THEN RAISE EXCEPTION 'plan release boundary changed' USING ERRCODE='23514'; END IF;
  PERFORM 1 FROM public."pos_manual_payment_cases" WHERE "payment_plan_id"=p.id ORDER BY "id" FOR SHARE;
  IF EXISTS (SELECT 1 FROM public."pos_manual_payment_cases" WHERE "payment_plan_id"=p.id AND "state" IN ('review_pending','unknown','confirmed_paid','application_pending','blocked')) THEN RAISE EXCEPTION 'plan has unresolved manual reconciliation' USING ERRCODE='23514'; END IF;
  target_state:=CASE p_action WHEN 'supersede' THEN 'superseded' ELSE 'expired' END;
  PERFORM public."pos_manual_t2_insert_transition_context_v1"('plan_release',p_action,p.id,
    pg_catalog.jsonb_build_object('id',p.id,'sessionId',p.session_id,'state',p.state,'version',p.version),
    pg_catalog.jsonb_build_object('id',p.id,'sessionId',p.session_id,'state',target_state,'version',p.version+1),p_request_hash,authority);
  PERFORM public."pos_manual_t2_insert_transition_context_v1"('plan_operation',p_action,p.id,
    'null'::jsonb,pg_catalog.jsonb_build_object('planId',p.id,'action',p_action,'expectedVersion',p.version,
      'resultingVersion',p.version+1,'resultingState',target_state,'idempotencyKey',p_idempotency_key,
      'requestHash',p_request_hash,'actorUserId',p_actor_user_id,'saleId',NULL,'writeTxid',pg_catalog.txid_current()::numeric),p_request_hash,authority);
END
$function$;

CREATE FUNCTION public."pos_manual_prepare_handoff_transition_v1"(p_action text,p_handoff_id text,p_session_id integer,p_expected_session_version integer,p_expected_handoff_revision integer,p_target_operator_profile_id integer,p_actor_profile_id integer,p_actor_user_id text,p_idempotency_key text,p_request_hash text,p_reason text,p_expires_at timestamptz,p_held_sale_snapshot jsonb)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE s record; h record; h_locator record; actor_row record; role_row record; target_row record; authority text; h_old jsonb; h_new jsonb; h_state text; h_revision integer; s_status text; s_operator integer; session_branch integer; database_snapshot jsonb;
BEGIN
  IF p_action IS NULL OR p_handoff_id IS NULL OR p_session_id IS NULL OR p_expected_session_version IS NULL OR p_expected_handoff_revision IS NULL OR p_actor_profile_id IS NULL OR p_actor_user_id IS NULL OR p_idempotency_key IS NULL OR p_request_hash IS NULL THEN RAISE EXCEPTION 'null handoff transition parameter' USING ERRCODE='22004'; END IF;
  IF p_request_hash !~ '^[0-9a-f]{64}$' OR pg_catalog.octet_length(p_idempotency_key) NOT BETWEEN 16 AND 160 OR p_idempotency_key!~'^[A-Za-z0-9._:-]+$'
    OR p_action NOT IN ('request','accept','cancel','expire') OR pg_catalog.octet_length(p_handoff_id) NOT BETWEEN 1 AND 128
    OR p_expected_session_version<0 OR p_expected_handoff_revision<0 OR NOT public."pos_manual_t2_subject_safe_v1"(p_actor_user_id)
    OR ((p_action IN ('request','accept'))<>(p_target_operator_profile_id IS NOT NULL))
    OR (p_action='request' AND (p_reason IS NULL OR p_expires_at IS NULL OR p_held_sale_snapshot IS NULL OR p_expires_at<=pg_catalog.clock_timestamp()))
    OR (p_action<>'request' AND (p_reason IS NOT NULL OR p_expires_at IS NOT NULL OR p_held_sale_snapshot IS NOT NULL)) THEN RAISE EXCEPTION 'invalid handoff transition shape' USING ERRCODE='22023'; END IF;
  authority:=public."pos_manual_t2_authority_v1"('runtime');
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('t2-handoff:'||p_handoff_id,0));
  IF p_action='accept' THEN
    SELECT * INTO h_locator FROM public."pos_session_handoffs" WHERE "id"=p_handoff_id;
    IF h_locator.id IS NULL OR h_locator.session_id<>p_session_id OR h_locator.revision<>p_expected_handoff_revision OR h_locator.state<>'requested' THEN
      RAISE EXCEPTION 'handoff accept locator changed' USING ERRCODE='23514'; END IF;
  END IF;
  SELECT * INTO s FROM public."cash_register_sessions" WHERE "id"=p_session_id FOR UPDATE;
  IF s.id IS NULL OR s.version<>p_expected_session_version THEN RAISE EXCEPTION 'handoff session boundary changed' USING ERRCODE='23514'; END IF;
  SELECT "branch_id" INTO session_branch FROM public."pos_registers" WHERE "id"=s.register_id FOR SHARE;
  PERFORM 1 FROM public."tenant_user_profiles" WHERE "id" IN (p_actor_profile_id,p_target_operator_profile_id) ORDER BY "id" FOR SHARE;
  IF session_branch IS NOT NULL THEN
    PERFORM 1 FROM public."branch_user_accesses" WHERE "branch_id"=session_branch
      AND "user_profile_id" IN (p_actor_profile_id,p_target_operator_profile_id) ORDER BY "user_profile_id" FOR SHARE;
  END IF;
  IF s.register_id IS NOT NULL THEN
    PERFORM 1 FROM public."pos_register_accesses" WHERE "register_id"=s.register_id
      AND "user_profile_id" IN (p_actor_profile_id,p_target_operator_profile_id) ORDER BY "user_profile_id" FOR SHARE;
  END IF;
  SELECT * INTO actor_row FROM public."tenant_user_profiles" WHERE "id"=p_actor_profile_id AND "user_id"=p_actor_user_id AND "status"='active' FOR SHARE;
  IF actor_row.id IS NULL THEN RAISE EXCEPTION 'handoff actor boundary missing' USING ERRCODE='42501'; END IF;
  SELECT * INTO role_row FROM public."tenant_roles" WHERE "id"=actor_row.role_id AND "active" FOR SHARE;
  IF role_row.id IS NULL THEN RAISE EXCEPTION 'handoff actor role denied' USING ERRCODE='42501'; END IF;
  IF role_row.key NOT IN ('owner','admin') THEN
    IF session_branch IS NOT NULL THEN
      PERFORM 1 FROM public."branch_user_accesses" WHERE "branch_id"=session_branch AND "user_profile_id"=p_actor_profile_id AND "can_sell" FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'handoff actor grant denied' USING ERRCODE='42501'; END IF;
    END IF;
  END IF;
  IF p_action IN ('request','accept') THEN
    SELECT * INTO target_row FROM public."tenant_user_profiles" WHERE "id"=p_target_operator_profile_id AND "status"='active' FOR SHARE;
    IF target_row.id IS NULL OR session_branch IS NULL THEN RAISE EXCEPTION 'handoff target boundary missing' USING ERRCODE='23514'; END IF;
    PERFORM 1 FROM public."branch_user_accesses" WHERE "branch_id"=session_branch AND "user_profile_id"=target_row.id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'handoff target branch grant missing' USING ERRCODE='23514'; END IF;
    PERFORM 1 FROM public."pos_register_accesses" WHERE "register_id"=s.register_id AND "user_profile_id"=target_row.id AND "active"
      AND ("valid_from" IS NULL OR "valid_from"<=pg_catalog.clock_timestamp()) AND ("valid_until" IS NULL OR "valid_until">pg_catalog.clock_timestamp()) FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'handoff target register grant missing' USING ERRCODE='23514'; END IF;
  END IF;
  IF p_action IN ('request','accept') THEN
    PERFORM 1 FROM public."pos_held_sales" WHERE "session_id"=s.id
      AND "register_id"=CASE WHEN p_action='request' THEN s.register_id ELSE h_locator.register_id END
      AND "operator_profile_id"=CASE WHEN p_action='request' THEN s.operator_profile_id ELSE h_locator.from_operator_profile_id END
      AND "status"='held' ORDER BY "id" FOR UPDATE;
    PERFORM 1 FROM public."pos_held_sale_items" item JOIN public."pos_held_sales" held ON held."id"=item."held_sale_id"
      WHERE held."session_id"=s.id AND held."register_id"=CASE WHEN p_action='request' THEN s.register_id ELSE h_locator.register_id END
        AND held."operator_profile_id"=CASE WHEN p_action='request' THEN s.operator_profile_id ELSE h_locator.from_operator_profile_id END
        AND held."status"='held' ORDER BY item."held_sale_id",item."id" FOR UPDATE OF item;
    SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id',held."id",'revision',held."revision") ORDER BY held."id"),'[]'::jsonb)
      INTO database_snapshot FROM public."pos_held_sales" held WHERE held."session_id"=s.id
        AND held."register_id"=CASE WHEN p_action='request' THEN s.register_id ELSE h_locator.register_id END
        AND held."operator_profile_id"=CASE WHEN p_action='request' THEN s.operator_profile_id ELSE h_locator.from_operator_profile_id END AND held."status"='held';
    IF database_snapshot IS DISTINCT FROM (CASE WHEN p_action='request' THEN p_held_sale_snapshot ELSE h_locator.held_sale_snapshot END) THEN
      RAISE EXCEPTION 'handoff held sale snapshot changed' USING ERRCODE='23514'; END IF;
  END IF;
  SELECT * INTO h FROM public."pos_session_handoffs" WHERE "id"=p_handoff_id FOR UPDATE;
  IF p_action='request' THEN
    IF h.id IS NOT NULL OR p_expected_handoff_revision<>0 OR s.status<>'open' OR s.operator_profile_id<>p_actor_profile_id
      OR p_target_operator_profile_id=s.operator_profile_id THEN RAISE EXCEPTION 'handoff request boundary changed' USING ERRCODE='23514'; END IF;
    h_old:='null'::jsonb; h_state:='requested'; h_revision:=1; s_status:='suspended'; s_operator:=s.operator_profile_id;
  ELSE
    IF h.id IS NULL OR h.session_id<>s.id OR h.revision<>p_expected_handoff_revision OR h.state<>'requested'
      OR (p_action='expire' AND h.expires_at>pg_catalog.clock_timestamp())
      OR (p_action IN ('accept','cancel') AND h.expires_at<=pg_catalog.clock_timestamp())
      OR (p_action='accept' AND (p_target_operator_profile_id<>h.to_operator_profile_id OR p_actor_profile_id<>h.to_operator_profile_id))
      OR (p_action='cancel' AND p_actor_profile_id NOT IN (h.from_operator_profile_id,h.to_operator_profile_id) AND role_row.key NOT IN ('owner','admin'))
    THEN RAISE EXCEPTION 'handoff boundary changed' USING ERRCODE='23514'; END IF;
    IF p_action='accept' THEN
      IF ROW(h.session_id,h.register_id,h.from_operator_profile_id,h.to_operator_profile_id,h.revision,h.state,h.held_sale_snapshot,h.request_hash)
        IS DISTINCT FROM ROW(h_locator.session_id,h_locator.register_id,h_locator.from_operator_profile_id,h_locator.to_operator_profile_id,h_locator.revision,h_locator.state,h_locator.held_sale_snapshot,h_locator.request_hash)
      THEN RAISE EXCEPTION 'handoff locator changed' USING ERRCODE='23514'; END IF;
    END IF;
    h_old:=pg_catalog.jsonb_build_object('id',h.id,'sessionId',h.session_id,'branchId',h.branch_id,'registerId',h.register_id,'fromOperatorProfileId',h.from_operator_profile_id,'toOperatorProfileId',h.to_operator_profile_id,'state',h.state,'reason',h.reason,'expiresAt',public."pos_manual_utc_micros_v1"(h.expires_at),'revision',h.revision,'requestIdempotencyKey',h.request_idempotency_key,'requestHash',h.request_hash,'heldSaleSnapshot',h.held_sale_snapshot,'requestedByActorId',h.requested_by_actor_id,'resolutionRequestHash',h.resolution_request_hash,'resolvedByActorId',h.resolved_by_actor_id);
    h_state:=CASE p_action WHEN 'accept' THEN 'accepted' WHEN 'cancel' THEN 'cancelled' ELSE 'expired' END; h_revision:=h.revision+1;
    s_status:='open'; s_operator:=CASE WHEN p_action='accept' THEN p_target_operator_profile_id ELSE s.operator_profile_id END;
  END IF;
  PERFORM 1 FROM public."pos_manual_payment_cases" WHERE "session_id"=s.id ORDER BY "id" FOR SHARE;
  IF EXISTS (SELECT 1 FROM public."pos_manual_payment_cases" WHERE "session_id"=s.id AND "state" IN ('review_pending','unknown','confirmed_paid','application_pending','blocked')) THEN RAISE EXCEPTION 'handoff has unresolved manual reconciliation' USING ERRCODE='23514'; END IF;
  h_new:=pg_catalog.jsonb_build_object('id',p_handoff_id,'sessionId',s.id,'branchId',CASE WHEN p_action='request' THEN session_branch ELSE h.branch_id END,'registerId',CASE WHEN p_action='request' THEN s.register_id ELSE h.register_id END,'fromOperatorProfileId',CASE WHEN p_action='request' THEN s.operator_profile_id ELSE h.from_operator_profile_id END,
    'toOperatorProfileId',CASE WHEN p_action='request' THEN p_target_operator_profile_id ELSE h.to_operator_profile_id END,'state',h_state,
    'reason',CASE WHEN p_action='request' THEN p_reason ELSE h.reason END,'expiresAt',public."pos_manual_utc_micros_v1"(CASE WHEN p_action='request' THEN p_expires_at ELSE h.expires_at END),'revision',h_revision,
    'requestIdempotencyKey',CASE WHEN p_action='request' THEN p_idempotency_key ELSE h.request_idempotency_key END,'requestHash',CASE WHEN p_action='request' THEN p_request_hash ELSE h.request_hash END,
    'heldSaleSnapshot',CASE WHEN p_action='request' THEN p_held_sale_snapshot ELSE h.held_sale_snapshot END,'requestedByActorId',CASE WHEN p_action='request' THEN p_actor_user_id ELSE h.requested_by_actor_id END,
    'resolutionRequestHash',CASE WHEN p_action='request' THEN NULL ELSE p_request_hash END,'resolvedByActorId',CASE WHEN p_action='request' THEN NULL ELSE p_actor_user_id END);
  IF p_action<>'expire' THEN
    PERFORM public."pos_manual_t2_insert_transition_context_v1"('session_transition','handoff_'||p_action,s.id::text,
      pg_catalog.jsonb_build_object('id',s.id,'status',s.status,'operatorProfileId',s.operator_profile_id,'version',s.version),
      pg_catalog.jsonb_build_object('id',s.id,'status',s_status,'operatorProfileId',s_operator,'version',s.version+1),p_request_hash,authority);
  END IF;
  PERFORM public."pos_manual_t2_insert_transition_context_v1"('handoff_transition',p_action,p_handoff_id,h_old,h_new,p_request_hash,authority);
  IF p_action<>'expire' THEN
    PERFORM public."pos_manual_t2_insert_transition_context_v1"('session_event','handoff_'||p_action,s.id::text,'null'::jsonb,
      pg_catalog.jsonb_build_object('sessionId',s.id,'type','session_handoff_'||CASE p_action WHEN 'request' THEN 'requested' WHEN 'accept' THEN 'accepted' ELSE 'cancelled' END,
        'idempotencyKey',NULL,'requestHash',NULL),p_request_hash,authority);
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION public."block_pos_session_with_manual_case"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE old_doc jsonb; new_doc jsonb; consumed integer;
BEGIN
  IF ROW(NEW."status",NEW."operator_profile_id",NEW."version") IS NOT DISTINCT FROM ROW(OLD."status",OLD."operator_profile_id",OLD."version") THEN RETURN NEW; END IF;
  old_doc:=pg_catalog.jsonb_build_object('id',OLD."id",'status',OLD."status",'operatorProfileId',OLD."operator_profile_id",'version',OLD."version");
  new_doc:=pg_catalog.jsonb_build_object('id',NEW."id",'status',NEW."status",'operatorProfileId',NEW."operator_profile_id",'version',NEW."version");
  DELETE FROM public."pos_manual_t2_lock_contexts" c WHERE c."backend_pid"=pg_catalog.pg_backend_pid() AND c."transaction_txid"=pg_catalog.txid_current()::numeric
    AND c."capability"='session_transition' AND c."aggregate_kind"='session' AND c."aggregate_id"=OLD."id"::text
    AND c."caller_role_hash"=public."pos_manual_t2_authority_v1"('runtime')
    AND ((OLD."status"='open' AND NEW."status"='closing' AND c."transition_action"='close')
      OR (OLD."status"='closing' AND NEW."status"='closed' AND c."transition_action"='close')
      OR (OLD."status"='open' AND NEW."status"='suspended' AND c."transition_action" IN ('suspend','handoff_request'))
      OR (OLD."status"='suspended' AND NEW."status"='open' AND c."transition_action" IN ('resume','handoff_accept','handoff_cancel')))
    AND c."nonce_hash"=public."pos_manual_t2_transaction_nonce_hash_v1"()
    AND c."old_digest"=public."pos_manual_t2_transition_digest_v1"('session',old_doc)
    AND c."new_digest"=public."pos_manual_t2_transition_digest_v1"('session',new_doc)
    AND (c."transition_action"<>'close' OR c."request_digest"=public."pos_manual_t2_request_digest_v1"('session','close',OLD."id"::text,
      public."pos_manual_t2_transition_digest_v1"('session',old_doc),public."pos_manual_t2_transition_digest_v1"('session',new_doc),NEW."close_request_hash"));
  GET DIAGNOSTICS consumed=ROW_COUNT;
  IF consumed<>1 THEN RAISE EXCEPTION 'session transition requires one-shot capability' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public."block_handoff_with_manual_case"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE old_doc jsonb; new_doc jsonb; consumed integer; aggregate text;
BEGIN
  aggregate:=NEW."id"; old_doc:=CASE WHEN TG_OP='INSERT' THEN 'null'::jsonb ELSE pg_catalog.jsonb_build_object('id',OLD."id",'sessionId',OLD."session_id",'branchId',OLD."branch_id",'registerId',OLD."register_id",'fromOperatorProfileId',OLD."from_operator_profile_id",'toOperatorProfileId',OLD."to_operator_profile_id",'state',OLD."state",'reason',OLD."reason",'expiresAt',public."pos_manual_utc_micros_v1"(OLD."expires_at"),'revision',OLD."revision",'requestIdempotencyKey',OLD."request_idempotency_key",'requestHash',OLD."request_hash",'heldSaleSnapshot',OLD."held_sale_snapshot",'requestedByActorId',OLD."requested_by_actor_id",'resolutionRequestHash',OLD."resolution_request_hash",'resolvedByActorId',OLD."resolved_by_actor_id") END;
  new_doc:=pg_catalog.jsonb_build_object('id',NEW."id",'sessionId',NEW."session_id",'branchId',NEW."branch_id",'registerId',NEW."register_id",'fromOperatorProfileId',NEW."from_operator_profile_id",'toOperatorProfileId',NEW."to_operator_profile_id",'state',NEW."state",'reason',NEW."reason",'expiresAt',public."pos_manual_utc_micros_v1"(NEW."expires_at"),'revision',NEW."revision",'requestIdempotencyKey',NEW."request_idempotency_key",'requestHash',NEW."request_hash",'heldSaleSnapshot',NEW."held_sale_snapshot",'requestedByActorId',NEW."requested_by_actor_id",'resolutionRequestHash',NEW."resolution_request_hash",'resolvedByActorId',NEW."resolved_by_actor_id");
  DELETE FROM public."pos_manual_t2_lock_contexts" c WHERE c."backend_pid"=pg_catalog.pg_backend_pid() AND c."transaction_txid"=pg_catalog.txid_current()::numeric
    AND c."capability"='handoff_transition' AND c."aggregate_kind"='handoff' AND c."aggregate_id"=aggregate
    AND c."caller_role_hash"=public."pos_manual_t2_authority_v1"('runtime')
    AND c."transition_action"=CASE WHEN TG_OP='INSERT' THEN 'request' WHEN NEW."state"='accepted' THEN 'accept' WHEN NEW."state"='cancelled' THEN 'cancel' WHEN NEW."state"='expired' THEN 'expire' END
    AND c."nonce_hash"=public."pos_manual_t2_transaction_nonce_hash_v1"()
    AND c."old_digest"=public."pos_manual_t2_transition_digest_v1"('handoff',old_doc)
    AND c."new_digest"=public."pos_manual_t2_transition_digest_v1"('handoff',new_doc)
    AND c."request_digest"=public."pos_manual_t2_request_digest_v1"('handoff',c."transition_action",aggregate,
      public."pos_manual_t2_transition_digest_v1"('handoff',old_doc),public."pos_manual_t2_transition_digest_v1"('handoff',new_doc),
      CASE WHEN TG_OP='INSERT' THEN NEW."request_hash" ELSE NEW."resolution_request_hash" END);
  GET DIAGNOSTICS consumed=ROW_COUNT;
  IF consumed<>1 THEN RAISE EXCEPTION 'handoff transition requires one-shot capability' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public."block_plan_release_with_manual_case"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE old_doc jsonb; new_doc jsonb; consumed integer;
BEGIN
  IF NEW."state" NOT IN ('expired','superseded') OR OLD."state" NOT IN ('quoted','active') THEN RETURN NEW; END IF;
  old_doc:=pg_catalog.jsonb_build_object('id',OLD."id",'sessionId',OLD."session_id",'state',OLD."state",'version',OLD."version");
  new_doc:=pg_catalog.jsonb_build_object('id',NEW."id",'sessionId',NEW."session_id",'state',NEW."state",'version',NEW."version");
  DELETE FROM public."pos_manual_t2_lock_contexts" c WHERE c."backend_pid"=pg_catalog.pg_backend_pid() AND c."transaction_txid"=pg_catalog.txid_current()::numeric
    AND c."capability"='plan_release' AND c."aggregate_kind"='plan' AND c."aggregate_id"=OLD."id"
    AND c."caller_role_hash"=public."pos_manual_t2_authority_v1"('runtime')
    AND c."transition_action"=CASE NEW."state" WHEN 'superseded' THEN 'supersede' WHEN 'expired' THEN 'expire' END
    AND c."nonce_hash"=public."pos_manual_t2_transaction_nonce_hash_v1"()
    AND c."old_digest"=public."pos_manual_t2_transition_digest_v1"('plan',old_doc)
    AND c."new_digest"=public."pos_manual_t2_transition_digest_v1"('plan',new_doc);
  GET DIAGNOSTICS consumed=ROW_COUNT;
  IF consumed<>1 THEN RAISE EXCEPTION 'plan release requires one-shot capability' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END
$function$;

CREATE FUNCTION public."pos_manual_t2_consume_session_event_context_v1"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE event_doc jsonb; action_name text;
BEGIN
 IF NEW."type" NOT IN ('session_suspended','session_resumed','session_handoff_requested','session_handoff_accepted','session_handoff_cancelled') THEN RETURN NEW; END IF;
 action_name:=CASE NEW."type" WHEN 'session_suspended' THEN 'suspend' WHEN 'session_resumed' THEN 'resume'
   WHEN 'session_handoff_requested' THEN 'handoff_request' WHEN 'session_handoff_accepted' THEN 'handoff_accept' ELSE 'handoff_cancel' END;
 event_doc:=pg_catalog.jsonb_build_object('sessionId',NEW."session_id",'type',NEW."type",'idempotencyKey',NEW."idempotency_key",'requestHash',NEW."request_hash");
 DELETE FROM public."pos_manual_t2_lock_contexts" c WHERE c."backend_pid"=pg_catalog.pg_backend_pid() AND c."transaction_txid"=pg_catalog.txid_current()::numeric
   AND c."capability"='session_event' AND c."aggregate_kind"='session_event' AND c."aggregate_id"=NEW."session_id"::text
   AND c."transition_action"=action_name AND c."caller_role_hash"=public."pos_manual_t2_authority_v1"('runtime')
   AND c."nonce_hash"=public."pos_manual_t2_transaction_nonce_hash_v1"()
   AND c."old_digest"=public."pos_manual_t2_transition_digest_v1"('session_event','null'::jsonb)
   AND c."new_digest"=public."pos_manual_t2_transition_digest_v1"('session_event',event_doc)
   AND (NEW."request_hash" IS NULL OR c."request_digest"=public."pos_manual_t2_request_digest_v1"('session_event',action_name,NEW."session_id"::text,
     public."pos_manual_t2_transition_digest_v1"('session_event','null'::jsonb),public."pos_manual_t2_transition_digest_v1"('session_event',event_doc),NEW."request_hash"));
 IF NOT FOUND THEN RAISE EXCEPTION 'session lifecycle event requires one-shot causal context' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END
$function$;
CREATE TRIGGER "cash_register_events_t2_context_guard" BEFORE INSERT ON public."cash_register_events"
FOR EACH ROW EXECUTE FUNCTION public."pos_manual_t2_consume_session_event_context_v1"();

CREATE FUNCTION public."pos_manual_t2_reject_live_context_at_commit_v1"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
 IF EXISTS (
   SELECT 1
     FROM public."pos_manual_t2_write_roots" root
     LEFT JOIN LATERAL (
       SELECT pg_catalog.count(*)::integer AS observation_count,
              pg_catalog.array_agg(observation."observation_digest" ORDER BY observation."observation_digest" COLLATE "C",observation."id") AS observation_digests
         FROM public."pos_manual_t2_write_observations" observation
        WHERE observation."root_id"=root."id"
     ) actual ON true
    WHERE root."backend_pid"=NEW."backend_pid" AND root."transaction_txid"=NEW."transaction_txid" AND root."nonce_hash"=NEW."nonce_hash"
      AND (actual.observation_count<>root."expected_observation_count"
        OR actual.observation_count NOT BETWEEN 1 AND 2048
        OR public."pos_manual_t2_write_observation_multiset_digest_v1"(actual.observation_digests)
           IS DISTINCT FROM root."expected_observation_multiset_digest"
        OR EXISTS (
          SELECT 1 FROM public."pos_manual_t2_write_observations" observation
           WHERE observation."root_id"=root."id"
             AND ROW(observation."capability",observation."aggregate_kind",observation."aggregate_id",observation."action",observation."trigger_identity",observation."dml_operation")
                 IS DISTINCT FROM ROW(root."capability",root."aggregate_kind",root."aggregate_id",root."action",root."trigger_identity",root."dml_operation")
        ))
 ) THEN RAISE EXCEPTION 'T2 write root observations were not fully matched' USING ERRCODE='23514'; END IF;
 DELETE FROM public."pos_manual_t2_write_observations" observation
  USING public."pos_manual_t2_write_roots" root
  WHERE observation."root_id"=root."id" AND root."backend_pid"=NEW."backend_pid"
    AND root."transaction_txid"=NEW."transaction_txid" AND root."nonce_hash"=NEW."nonce_hash";
 DELETE FROM public."pos_manual_t2_write_roots"
  WHERE "backend_pid"=NEW."backend_pid" AND "transaction_txid"=NEW."transaction_txid" AND "nonce_hash"=NEW."nonce_hash";
 IF EXISTS (SELECT 1 FROM public."pos_manual_t2_lock_contexts"
   WHERE "backend_pid"=NEW."backend_pid" AND "transaction_txid"=NEW."transaction_txid") THEN
   RAISE EXCEPTION 'T2 capability context was not fully consumed' USING ERRCODE='23514'; END IF;
 DELETE FROM public."pos_manual_t2_transaction_nonces"
  WHERE "backend_pid"=NEW."backend_pid" AND "transaction_txid"=NEW."transaction_txid"
    AND "nonce_hash"=NEW."nonce_hash";
 RETURN NULL;
END
$function$;
CREATE CONSTRAINT TRIGGER "pos_manual_t2_context_consumption_guard" AFTER INSERT ON public."pos_manual_t2_transaction_nonces"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public."pos_manual_t2_reject_live_context_at_commit_v1"();

CREATE FUNCTION public."pos_manual_issue_profile_admin_assertion_v1"(
  p_action text,p_branch_id integer,p_profile_id uuid,p_expected_version integer,p_expected_config_hash text,
  p_issuer_subject_id text,p_subject_id text,p_idempotency_key text,p_request_hash text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE authority text; handle text; now_at timestamptz; existing record; profile_row record;
BEGIN
  PERFORM public."pos_manual_t2_assert_shape_v1"(p_idempotency_key,p_request_hash);
  IF p_action NOT IN ('put','activate','retire') OR p_expected_version<=0 OR p_expected_config_hash !~ '^[0-9a-f]{64}$'
    OR NOT public."pos_manual_t2_subject_safe_v1"(p_issuer_subject_id) OR NOT public."pos_manual_t2_subject_safe_v1"(p_subject_id) THEN
    RAISE EXCEPTION 'invalid profile assertion shape' USING ERRCODE='22023'; END IF;
  authority:=public."pos_manual_t2_authority_v1"('profile_admin_issuer');
  IF p_request_hash<>public."pos_manual_t2_profile_request_hash_v1"('profile-admin-assert-v1',pg_catalog.jsonb_build_object('action',p_action,'branchId',p_branch_id,'profileId',p_profile_id,'expectedVersion',p_expected_version,'expectedConfigHash',p_expected_config_hash,'issuerSubjectId',p_issuer_subject_id,'subjectId',p_subject_id,'idempotencyKey',p_idempotency_key)) THEN RAISE EXCEPTION 'profile request hash mismatch' USING ERRCODE='23514'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('t2-profile-admin-assert:'||p_idempotency_key,0));
  SELECT * INTO existing FROM public."pos_manual_profile_admin_assertions" WHERE "profile_id"=p_profile_id AND "action"=p_action AND "idempotency_key"=p_idempotency_key FOR UPDATE;
  IF existing.id IS NOT NULL THEN
    IF ROW(existing.action,existing.branch_id,existing.profile_id,existing.expected_version,existing.expected_config_hash,existing.issuer_subject_id,existing.subject_id,existing.request_hash,existing.authority_hash)
      IS DISTINCT FROM ROW(p_action,p_branch_id,p_profile_id,p_expected_version,p_expected_config_hash,p_issuer_subject_id,p_subject_id,p_request_hash,authority)
    THEN RAISE EXCEPTION 'profile assertion idempotency conflict' USING ERRCODE='23505'; END IF;
    RETURN pg_catalog.jsonb_build_object('alreadyIssued',true,'assertionId',existing.id,'expiresAt',public."pos_manual_utc_micros_v1"(existing.expires_at));
  END IF;
  PERFORM 1 FROM public."branches" WHERE "id"=p_branch_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'profile assertion branch missing' USING ERRCODE='23514'; END IF;
  IF p_action IN ('activate','retire') THEN
    SELECT * INTO profile_row FROM public."pos_manual_finalization_profiles" WHERE "id"=p_profile_id FOR SHARE;
    IF profile_row.id IS NULL OR profile_row.branch_id<>p_branch_id OR profile_row.version<>p_expected_version
      OR profile_row.config_hash<>p_expected_config_hash OR (p_action='activate' AND profile_row.state<>'draft')
      OR (p_action='retire' AND profile_row.state<>'active') THEN RAISE EXCEPTION 'profile assertion lifecycle boundary missing' USING ERRCODE='23514'; END IF;
  ELSIF EXISTS (SELECT 1 FROM public."pos_manual_finalization_profiles" WHERE "id"=p_profile_id) THEN
    RAISE EXCEPTION 'profile put assertion id already exists' USING ERRCODE='23505';
  END IF;
  now_at:=pg_catalog.clock_timestamp(); handle:=public."pos_manual_t2_new_handle_v1"();
  INSERT INTO public."pos_manual_profile_admin_assertions" ("id","action","branch_id","profile_id","expected_version","expected_config_hash","issuer_subject_id","subject_id","assertion_hash","authority_hash","idempotency_key","request_hash","issued_at","expires_at","consumed_operation_id","consumed_at") VALUES
    (pg_catalog.gen_random_uuid(),p_action,p_branch_id,p_profile_id,p_expected_version,p_expected_config_hash,p_issuer_subject_id,p_subject_id,
     pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(handle,'UTF8')),'hex'),authority,p_idempotency_key,p_request_hash,now_at,now_at+interval '120 seconds',NULL,NULL)
  RETURNING * INTO existing;
  RETURN pg_catalog.jsonb_build_object('alreadyIssued',false,'assertionId',existing.id,'assertionHandle',handle,'expiresAt',public."pos_manual_utc_micros_v1"(existing.expires_at));
END
$function$;

CREATE FUNCTION public."pos_manual_issue_profile_accounting_assertion_v1"(
 p_profile_id uuid,p_expected_version integer,p_expected_config_hash text,p_expected_accounting_policy_hash text,
 p_issuer_subject_id text,p_approver_id text,p_idempotency_key text,p_request_hash text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE authority text; handle text; now_at timestamptz; existing record; profile_row record;
BEGIN
 PERFORM public."pos_manual_t2_assert_shape_v1"(p_idempotency_key,p_request_hash);
 IF p_expected_version<=0 OR p_expected_config_hash !~ '^[0-9a-f]{64}$' OR p_expected_accounting_policy_hash !~ '^[0-9a-f]{64}$' OR NOT public."pos_manual_t2_subject_safe_v1"(p_issuer_subject_id) OR NOT public."pos_manual_t2_subject_safe_v1"(p_approver_id) THEN RAISE EXCEPTION 'invalid accounting assertion shape' USING ERRCODE='22023'; END IF;
 authority:=public."pos_manual_t2_authority_v1"('profile_accounting_issuer');
 IF p_request_hash<>public."pos_manual_t2_profile_request_hash_v1"('profile-accounting-assert-v1',pg_catalog.jsonb_build_object('profileId',p_profile_id,'expectedVersion',p_expected_version,'expectedConfigHash',p_expected_config_hash,'expectedAccountingPolicyHash',p_expected_accounting_policy_hash,'issuerSubjectId',p_issuer_subject_id,'approverId',p_approver_id,'idempotencyKey',p_idempotency_key)) THEN RAISE EXCEPTION 'profile request hash mismatch' USING ERRCODE='23514'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('t2-profile-accounting-assert:'||p_idempotency_key,0));
 SELECT * INTO existing FROM public."pos_manual_profile_accounting_assertions" WHERE "profile_id"=p_profile_id AND "idempotency_key"=p_idempotency_key FOR UPDATE;
 IF existing.id IS NOT NULL THEN
  IF ROW(existing.profile_id,existing.expected_version,existing.expected_config_hash,existing.expected_accounting_policy_hash,existing.issuer_subject_id,existing.approver_id,existing.request_hash,existing.authority_hash)
   IS DISTINCT FROM ROW(p_profile_id,p_expected_version,p_expected_config_hash,p_expected_accounting_policy_hash,p_issuer_subject_id,p_approver_id,p_request_hash,authority) THEN RAISE EXCEPTION 'accounting assertion idempotency conflict' USING ERRCODE='23505'; END IF;
  RETURN pg_catalog.jsonb_build_object('alreadyIssued',true,'assertionId',existing.id,'expiresAt',public."pos_manual_utc_micros_v1"(existing.expires_at)); END IF;
 SELECT * INTO profile_row FROM public."pos_manual_finalization_profiles" WHERE "id"=p_profile_id FOR SHARE;
 IF profile_row.id IS NULL OR profile_row.version<>p_expected_version OR profile_row.config_hash<>p_expected_config_hash OR profile_row.accounting_policy_hash<>p_expected_accounting_policy_hash THEN RAISE EXCEPTION 'accounting assertion profile boundary missing' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM public."pos_accounting_policies" WHERE "id"=profile_row.accounting_policy_id AND "branch_id"=profile_row.branch_id AND "version"=profile_row.accounting_policy_version AND "mapping_hash"=p_expected_accounting_policy_hash FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'accounting assertion policy boundary missing' USING ERRCODE='23514'; END IF;
 now_at:=pg_catalog.clock_timestamp(); handle:=public."pos_manual_t2_new_handle_v1"();
 INSERT INTO public."pos_manual_profile_accounting_assertions" ("id","profile_id","expected_version","expected_config_hash","expected_accounting_policy_hash","issuer_subject_id","approver_id","assertion_hash","authority_hash","idempotency_key","request_hash","issued_at","expires_at","consumed_operation_id","consumed_at") VALUES(pg_catalog.gen_random_uuid(),p_profile_id,p_expected_version,p_expected_config_hash,p_expected_accounting_policy_hash,p_issuer_subject_id,p_approver_id,pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(handle,'UTF8')),'hex'),authority,p_idempotency_key,p_request_hash,now_at,now_at+interval '120 seconds',NULL,NULL) RETURNING * INTO existing;
 RETURN pg_catalog.jsonb_build_object('alreadyIssued',false,'assertionId',existing.id,'assertionHandle',handle,'expiresAt',public."pos_manual_utc_micros_v1"(existing.expires_at));
END
$function$;

CREATE FUNCTION public."pos_manual_issue_profile_fiscal_assertion_v1"(
 p_profile_id uuid,p_expected_version integer,p_expected_config_hash text,p_expected_fiscal_policy_hash text,
 p_issuer_subject_id text,p_approver_id text,p_idempotency_key text,p_request_hash text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE authority text; handle text; now_at timestamptz; existing record; profile_row record; profile_fiscal_mode text;
BEGIN
 PERFORM public."pos_manual_t2_assert_shape_v1"(p_idempotency_key,p_request_hash);
 IF p_expected_version<=0 OR p_expected_config_hash !~ '^[0-9a-f]{64}$' OR p_expected_fiscal_policy_hash !~ '^[0-9a-f]{64}$' OR NOT public."pos_manual_t2_subject_safe_v1"(p_issuer_subject_id) OR NOT public."pos_manual_t2_subject_safe_v1"(p_approver_id) THEN RAISE EXCEPTION 'invalid fiscal assertion shape' USING ERRCODE='22023'; END IF;
 authority:=public."pos_manual_t2_authority_v1"('profile_fiscal_issuer');
 IF p_request_hash<>public."pos_manual_t2_profile_request_hash_v1"('profile-fiscal-assert-v1',pg_catalog.jsonb_build_object('profileId',p_profile_id,'expectedVersion',p_expected_version,'expectedConfigHash',p_expected_config_hash,'expectedFiscalPolicyHash',p_expected_fiscal_policy_hash,'issuerSubjectId',p_issuer_subject_id,'approverId',p_approver_id,'idempotencyKey',p_idempotency_key)) THEN RAISE EXCEPTION 'profile request hash mismatch' USING ERRCODE='23514'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('t2-profile-fiscal-assert:'||p_idempotency_key,0));
 SELECT * INTO existing FROM public."pos_manual_profile_fiscal_assertions" WHERE "profile_id"=p_profile_id AND "idempotency_key"=p_idempotency_key FOR UPDATE;
 IF existing.id IS NOT NULL THEN
  IF ROW(existing.profile_id,existing.expected_version,existing.expected_config_hash,existing.expected_fiscal_policy_hash,existing.issuer_subject_id,existing.approver_id,existing.request_hash,existing.authority_hash)
   IS DISTINCT FROM ROW(p_profile_id,p_expected_version,p_expected_config_hash,p_expected_fiscal_policy_hash,p_issuer_subject_id,p_approver_id,p_request_hash,authority) THEN RAISE EXCEPTION 'fiscal assertion idempotency conflict' USING ERRCODE='23505'; END IF;
  RETURN pg_catalog.jsonb_build_object('alreadyIssued',true,'assertionId',existing.id,'expiresAt',public."pos_manual_utc_micros_v1"(existing.expires_at)); END IF;
 SELECT * INTO profile_row FROM public."pos_manual_finalization_profiles" WHERE "id"=p_profile_id FOR SHARE;
 IF profile_row.id IS NULL OR profile_row.version<>p_expected_version OR profile_row.config_hash<>p_expected_config_hash
   OR profile_row.fiscal_policy_hash<>p_expected_fiscal_policy_hash THEN RAISE EXCEPTION 'fiscal assertion profile boundary missing' USING ERRCODE='23514'; END IF;
 profile_fiscal_mode:=profile_row.fiscal_mode;
 IF profile_fiscal_mode='required_queue' THEN
   PERFORM 1 FROM public."pos_fiscal_profiles" WHERE "id"=profile_row.fiscal_profile_id AND "branch_id"=profile_row.branch_id
     AND "version"=profile_row.fiscal_profile_version AND "policy_digest"=p_expected_fiscal_policy_hash FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'fiscal assertion policy boundary missing' USING ERRCODE='23514'; END IF;
 END IF;
 now_at:=pg_catalog.clock_timestamp(); handle:=public."pos_manual_t2_new_handle_v1"();
 INSERT INTO public."pos_manual_profile_fiscal_assertions" ("id","profile_id","expected_version","expected_config_hash","fiscal_mode","expected_fiscal_policy_hash","issuer_subject_id","approver_id","assertion_hash","authority_hash","idempotency_key","request_hash","issued_at","expires_at","consumed_operation_id","consumed_at") VALUES(pg_catalog.gen_random_uuid(),p_profile_id,p_expected_version,p_expected_config_hash,profile_fiscal_mode,p_expected_fiscal_policy_hash,p_issuer_subject_id,p_approver_id,pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(handle,'UTF8')),'hex'),authority,p_idempotency_key,p_request_hash,now_at,now_at+interval '120 seconds',NULL,NULL) RETURNING * INTO existing;
 RETURN pg_catalog.jsonb_build_object('alreadyIssued',false,'assertionId',existing.id,'assertionHandle',handle,'expiresAt',public."pos_manual_utc_micros_v1"(existing.expires_at));
END
$function$;

-- T2-01 replaces the unconditional T2-00 guards with transaction-scoped,
-- owner-only context checks. No caller has table DML, and context rows can
-- only be created by the SECURITY DEFINER lifecycle capabilities below.
CREATE OR REPLACE FUNCTION public."guard_pos_manual_t2_profile_inert"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE context_capability text; profile_aggregate_id text;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'profile deletion is forbidden' USING ERRCODE='42501';
  END IF;
  IF TG_OP='UPDATE' AND NOT ((OLD."state"='draft' AND NEW."state"='active' AND NEW."lifecycle_txid"=pg_catalog.txid_current()::numeric)
    OR (OLD."state"='active' AND NEW."state"='retired' AND NEW."lifecycle_txid"=pg_catalog.txid_current()::numeric)) THEN
    RAISE EXCEPTION 'profile lifecycle transition denied' USING ERRCODE='23514'; END IF;
  profile_aggregate_id:=NEW."id"::text;
  SELECT c."capability" INTO context_capability FROM public."pos_manual_t2_lock_contexts" c
  WHERE c."backend_pid"=pg_catalog.pg_backend_pid() AND c."transaction_txid"=pg_catalog.txid_current()::numeric
    AND c."aggregate_kind"='profile' AND c."aggregate_id"=profile_aggregate_id
    AND c."nonce_hash"=public."pos_manual_t2_transaction_nonce_hash_v1"()
    AND c."capability" IN ('profile_put','profile_activate','profile_retire');
  IF context_capability IS NULL THEN RAISE EXCEPTION 'profile write requires T2 lifecycle capability' USING ERRCODE='42501'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW."state"<>'draft' OR NEW."lifecycle_txid"<>pg_catalog.txid_current()::numeric THEN
      RAISE EXCEPTION 'profile insert transition denied' USING ERRCODE='23514'; END IF;
    IF context_capability<>'profile_put' THEN RAISE EXCEPTION 'profile capability/transition mismatch' USING ERRCODE='42501'; END IF;
  ELSIF NOT ((OLD."state"='draft' AND NEW."state"='active' AND context_capability='profile_activate')
    OR (OLD."state"='active' AND NEW."state"='retired' AND context_capability='profile_retire')) THEN
    RAISE EXCEPTION 'profile lifecycle transition denied' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND OLD."state"='draft' AND
    (pg_catalog.to_jsonb(NEW)-'state'-'homologated_by'-'homologated_at'-'accounting_approved_by'-'accounting_approved_at'-'fiscal_approved_by'-'fiscal_approved_at'-'activated_at'-'updated_at'-'lifecycle_txid'-'lifecycle_operation_id')
      IS DISTINCT FROM (pg_catalog.to_jsonb(OLD)-'state'-'homologated_by'-'homologated_at'-'accounting_approved_by'-'accounting_approved_at'-'fiscal_approved_by'-'fiscal_approved_at'-'activated_at'-'updated_at'-'lifecycle_txid'-'lifecycle_operation_id') THEN
    RAISE EXCEPTION 'profile activation changed immutable columns' USING ERRCODE='23514';
  ELSIF TG_OP='UPDATE' AND OLD."state"='active' AND
    (pg_catalog.to_jsonb(NEW)-'state'-'retired_at'-'updated_at'-'lifecycle_txid'-'lifecycle_operation_id')
      IS DISTINCT FROM (pg_catalog.to_jsonb(OLD)-'state'-'retired_at'-'updated_at'-'lifecycle_txid'-'lifecycle_operation_id') THEN
    RAISE EXCEPTION 'profile retirement changed immutable columns' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public."protect_pos_manual_reconciliation_gate"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
  IF NEW."enabled" THEN RAISE EXCEPTION 'manual reconciliation remains hard-disabled' USING ERRCODE='42501'; END IF;
  IF TG_OP='INSERT' AND NEW."finalization_profile_id" IS NULL AND NEW."finalization_profile_version" IS NULL
    AND NEW."finalization_profile_hash" IS NULL THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND OLD."enabled" AND NOT NEW."enabled" THEN NEW."updated_at":=pg_catalog.clock_timestamp(); RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM public."pos_manual_t2_lock_contexts" c WHERE c."backend_pid"=pg_catalog.pg_backend_pid() AND c."transaction_txid"=pg_catalog.txid_current()::numeric
    AND c."aggregate_kind"='profile' AND c."aggregate_id"=NEW."finalization_profile_id"::text
    AND c."nonce_hash"=public."pos_manual_t2_transaction_nonce_hash_v1"()
    AND c."capability"='profile_activate') THEN
    IF TG_OP='INSERT' OR ROW(NEW."connector_id",NEW."connector_revision",NEW."credential_ref",NEW."credential_revision",NEW."finalization_profile_id",NEW."finalization_profile_version",NEW."finalization_profile_hash")
      IS DISTINCT FROM ROW(OLD."connector_id",OLD."connector_revision",OLD."credential_ref",OLD."credential_revision",OLD."finalization_profile_id",OLD."finalization_profile_version",OLD."finalization_profile_hash")
    THEN RAISE EXCEPTION 'manual reconciliation gate is immutable to runtime' USING ERRCODE='42501'; END IF;
  END IF;
  RETURN NEW;
END
$function$;

CREATE FUNCTION public."pos_manual_t2_open_context_v1"(p_capability text,p_aggregate_id text,p_caller_role_hash text)
RETURNS bigint LANGUAGE plpgsql VOLATILE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE nonce_hash text; context_id bigint;
BEGIN
  IF (p_capability NOT IN ('profile_put','profile_activate','profile_retire') AND p_capability NOT LIKE 'legacy_producer:%')
    OR p_caller_role_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid T2 lock context' USING ERRCODE='42501'; END IF;
  nonce_hash:=public."pos_manual_t2_transaction_nonce_hash_v1"();
  INSERT INTO public."pos_manual_t2_lock_contexts"("backend_pid","transaction_txid","caller_role_hash","capability","aggregate_kind","aggregate_id","nonce_hash")
  VALUES(pg_catalog.pg_backend_pid(),pg_catalog.txid_current()::numeric,p_caller_role_hash,p_capability,
    CASE WHEN p_capability LIKE 'legacy_producer:%' THEN 'legacy_producer' ELSE 'profile' END,p_aggregate_id,
    nonce_hash) RETURNING "id" INTO context_id;
  RETURN context_id;
END
$function$;

CREATE FUNCTION public."pos_manual_put_finalization_profile_v1"(
 p_branch_id integer,p_version integer,p_profile jsonb,p_actor_profile_id integer,p_actor_user_id text,
 p_admin_assertion_hash text,p_idempotency_key text,p_request_hash text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE authority text; assertion_row record; profile_row record; operation_row record; expected_hash text; now_at timestamptz; context_id bigint; operation_id bigint;
DECLARE cost_center integer; accounting_id text; accounting_version integer; accounting_hash text; fiscal_mode text;
DECLARE fiscal_id text; fiscal_version integer; fiscal_hash text; na_reason text; webhook_mode text; ttl integer;
BEGIN
  PERFORM public."pos_manual_t2_assert_shape_v1"(p_idempotency_key,p_request_hash);
  IF p_version<=0 OR p_admin_assertion_hash !~ '^[0-9a-f]{64}$' OR pg_catalog.octet_length(p_actor_user_id) NOT BETWEEN 1 AND 128
    OR NOT public."pos_manual_t2_subject_safe_v1"(p_actor_user_id) OR pg_catalog.jsonb_typeof(p_profile)<>'object' OR p_profile->'schemaVersion'<>'1'::jsonb THEN
    RAISE EXCEPTION 'invalid profile put shape' USING ERRCODE='22023'; END IF;
  IF (SELECT pg_catalog.array_agg(k ORDER BY k) FROM pg_catalog.jsonb_object_keys(p_profile) k) IS DISTINCT FROM
    ARRAY['accountingPolicyHash','accountingPolicyId','accountingPolicyVersion','costCenterId','fiscalMode','fiscalPolicyHash','fiscalProfileId','fiscalProfileVersion','notApplicableReason','reservationTtlSeconds','schemaVersion','stockMode','webhookMode']::text[] THEN
    RAISE EXCEPTION 'profile JSON keys are closed' USING ERRCODE='22023'; END IF;
  BEGIN
    cost_center:=(p_profile->>'costCenterId')::integer; accounting_id:=p_profile->>'accountingPolicyId';
    accounting_version:=(p_profile->>'accountingPolicyVersion')::integer; accounting_hash:=p_profile->>'accountingPolicyHash';
    fiscal_mode:=p_profile->>'fiscalMode'; fiscal_id:=p_profile->>'fiscalProfileId'; fiscal_version:=(p_profile->>'fiscalProfileVersion')::integer;
    fiscal_hash:=p_profile->>'fiscalPolicyHash'; na_reason:=p_profile->>'notApplicableReason'; webhook_mode:=p_profile->>'webhookMode';
    ttl:=(p_profile->>'reservationTtlSeconds')::integer;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RAISE EXCEPTION 'invalid profile JSON scalar' USING ERRCODE='22023'; END;
  IF COALESCE(pg_catalog.jsonb_typeof(p_profile->'costCenterId')<>'number' OR cost_center<=0
    OR pg_catalog.jsonb_typeof(p_profile->'accountingPolicyId')<>'string' OR pg_catalog.octet_length(accounting_id) NOT BETWEEN 1 AND 128
    OR accounting_id<>normalize(accounting_id,NFC) OR accounting_id~'[[:cntrl:]]'
    OR pg_catalog.jsonb_typeof(p_profile->'accountingPolicyVersion')<>'number' OR accounting_version<=0
    OR pg_catalog.jsonb_typeof(p_profile->'accountingPolicyHash')<>'string' OR accounting_hash!~'^[0-9a-f]{64}$'
    OR pg_catalog.jsonb_typeof(p_profile->'fiscalMode')<>'string'
    OR pg_catalog.jsonb_typeof(p_profile->'fiscalPolicyHash')<>'string' OR fiscal_hash!~'^[0-9a-f]{64}$'
    OR pg_catalog.jsonb_typeof(p_profile->'webhookMode')<>'string'
    OR pg_catalog.jsonb_typeof(p_profile->'stockMode')<>'string'
    OR pg_catalog.jsonb_typeof(p_profile->'reservationTtlSeconds')<>'number'
    OR p_profile->>'stockMode'<>'reserve_exact'
    OR fiscal_mode NOT IN ('required_queue','not_applicable') OR webhook_mode NOT IN ('required','disabled') OR ttl NOT BETWEEN 15 AND 300
    OR (fiscal_mode='required_queue' AND (pg_catalog.jsonb_typeof(p_profile->'fiscalProfileId')<>'string'
      OR pg_catalog.octet_length(fiscal_id) NOT BETWEEN 1 AND 128 OR fiscal_id<>normalize(fiscal_id,NFC) OR fiscal_id~'[[:cntrl:]]'
      OR pg_catalog.jsonb_typeof(p_profile->'fiscalProfileVersion')<>'number' OR fiscal_version<=0
      OR p_profile->'notApplicableReason'<>'null'::jsonb))
    OR (fiscal_mode='not_applicable' AND (p_profile->'fiscalProfileId'<>'null'::jsonb OR p_profile->'fiscalProfileVersion'<>'null'::jsonb
      OR pg_catalog.jsonb_typeof(p_profile->'notApplicableReason')<>'string' OR pg_catalog.octet_length(na_reason) NOT BETWEEN 1 AND 128
      OR na_reason<>normalize(na_reason,NFC) OR na_reason~'[[:cntrl:]]')),true) THEN
    RAISE EXCEPTION 'invalid profile boundary' USING ERRCODE='22023'; END IF;
  -- The T2-00 database CHECK remains the final hash authority. Build the exact
  -- persisted document rather than accepting a caller-selected profile id.
  expected_hash:=public."pos_manual_hash_canonical_json_v1"('t2-profile-v1',pg_catalog.jsonb_build_object(
    'schemaVersion',1,'branchId',p_branch_id,'version',p_version,'costCenterId',cost_center,
    'accountingPolicyId',accounting_id,'accountingPolicyVersion',accounting_version,'accountingPolicyHash',accounting_hash,
    'fiscalMode',fiscal_mode,'fiscalProfileId',CASE WHEN fiscal_mode='required_queue' THEN fiscal_id ELSE NULL END,
    'fiscalProfileVersion',CASE WHEN fiscal_mode='required_queue' THEN fiscal_version ELSE NULL END,'fiscalPolicyHash',fiscal_hash,
    'notApplicableReason',CASE WHEN fiscal_mode='not_applicable' THEN na_reason ELSE NULL END,
    'webhookMode',webhook_mode,'stockMode','reserve_exact','reservationTtlSeconds',ttl));
  IF NOT public."pos_manual_t2_canonical_text_dlp_safe_v1"(public."pos_manual_canonical_json_v1"(p_profile)) THEN
    RAISE EXCEPTION 'profile contains prohibited data' USING ERRCODE='22023'; END IF;
  authority:=public."pos_manual_t2_authority_v1"('runtime');
  IF p_request_hash<>public."pos_manual_t2_profile_request_hash_v1"('profile-put-v1',pg_catalog.jsonb_build_object('branchId',p_branch_id,'version',p_version,'profile',p_profile,'actorProfileId',p_actor_profile_id,'actorUserId',p_actor_user_id,'adminAssertionHash',pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_admin_assertion_hash,'UTF8')),'hex'),'idempotencyKey',p_idempotency_key)) THEN RAISE EXCEPTION 'profile request hash mismatch' USING ERRCODE='23514'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('t2-profile-put:'||p_idempotency_key,0));
  SELECT * INTO assertion_row FROM public."pos_manual_profile_admin_assertions" WHERE "assertion_hash"=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_admin_assertion_hash,'UTF8')),'hex');
  IF assertion_row.id IS NOT NULL THEN
    SELECT * INTO operation_row FROM public."pos_manual_profile_operations" WHERE "profile_id"=assertion_row.profile_id AND "action"='put' AND "idempotency_key"=p_idempotency_key;
    IF operation_row.id IS NOT NULL THEN
      IF operation_row.request_hash<>p_request_hash OR operation_row.resulting_config_hash<>expected_hash OR assertion_row.consumed_operation_id<>operation_row.id THEN RAISE EXCEPTION 'profile put idempotency conflict' USING ERRCODE='23505'; END IF;
      RETURN pg_catalog.jsonb_build_object('profileId',operation_row.profile_id,'version',operation_row.profile_version,'state','draft','configHash',operation_row.resulting_config_hash,'replayed',true);
    END IF;
  END IF;
  PERFORM 1 FROM public."branches" WHERE "id"=p_branch_id FOR SHARE;
  PERFORM 1 FROM public."tenant_user_profiles" profile WHERE profile."id"=p_actor_profile_id AND profile."user_id"=p_actor_user_id AND profile."status"='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'profile actor boundary missing' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM public."branch_user_accesses" grant_row WHERE grant_row."branch_id"=p_branch_id AND grant_row."user_profile_id"=p_actor_profile_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'profile actor grant missing' USING ERRCODE='42501'; END IF;
  IF fiscal_mode='required_queue' THEN
    PERFORM 1 FROM public."pos_fiscal_profiles" WHERE "id"=fiscal_id AND "branch_id"=p_branch_id AND "version"=fiscal_version AND "policy_digest"=fiscal_hash FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'profile fiscal boundary missing' USING ERRCODE='23514'; END IF;
  END IF;
  PERFORM 1 FROM public."pos_accounting_policies" WHERE "id"=accounting_id AND "branch_id"=p_branch_id AND "version"=accounting_version AND "mapping_hash"=accounting_hash FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'profile accounting boundary missing' USING ERRCODE='23514'; END IF;
  PERFORM 1 FROM public."cost_centers" WHERE "id"=cost_center AND "active" FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'profile cost center boundary missing' USING ERRCODE='23514'; END IF;
  SELECT * INTO assertion_row FROM public."pos_manual_profile_admin_assertions" WHERE "assertion_hash"=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_admin_assertion_hash,'UTF8')),'hex') FOR UPDATE;
  IF assertion_row.id IS NULL OR assertion_row.action<>'put' OR assertion_row.branch_id<>p_branch_id OR assertion_row.expected_version<>p_version
    OR assertion_row.expected_config_hash<>expected_hash OR assertion_row.subject_id<>p_actor_user_id OR assertion_row.issuer_subject_id=p_actor_user_id
    OR assertion_row.consumed_operation_id IS NOT NULL THEN RAISE EXCEPTION 'profile admin assertion denied' USING ERRCODE='42501'; END IF;
  now_at:=pg_catalog.clock_timestamp(); IF assertion_row.expires_at<=now_at THEN RAISE EXCEPTION 'profile assertion expired' USING ERRCODE='42501'; END IF;
  context_id:=public."pos_manual_t2_open_context_v1"('profile_put',assertion_row.profile_id::text,authority);
  operation_id:=pg_catalog.nextval('public.pos_manual_profile_operations_id_seq'::pg_catalog.regclass);
  INSERT INTO public."pos_manual_finalization_profiles"("id","branch_id","version","state","cost_center_id","accounting_policy_id","accounting_policy_version","accounting_policy_hash","fiscal_mode","fiscal_profile_id","fiscal_profile_version","fiscal_policy_hash","not_applicable_reason","webhook_mode","stock_mode","reservation_ttl_seconds","config_hash","created_by","lifecycle_operation_id")
  VALUES(assertion_row.profile_id,p_branch_id,p_version,'draft',cost_center,accounting_id,accounting_version,accounting_hash,fiscal_mode,
    CASE WHEN fiscal_mode='required_queue' THEN fiscal_id ELSE NULL END,CASE WHEN fiscal_mode='required_queue' THEN fiscal_version ELSE NULL END,fiscal_hash,
    CASE WHEN fiscal_mode='not_applicable' THEN na_reason ELSE NULL END,webhook_mode,'reserve_exact',ttl,expected_hash,p_actor_user_id,operation_id)
  ON CONFLICT DO NOTHING;
  PERFORM 1 FROM public."pos_manual_finalization_profiles"
   WHERE "id"=assertion_row.profile_id OR ("branch_id"=p_branch_id AND "version"=p_version)
   ORDER BY "id" FOR UPDATE;
  SELECT * INTO profile_row FROM public."pos_manual_finalization_profiles" WHERE "id"=assertion_row.profile_id;
  IF (SELECT pg_catalog.count(*) FROM public."pos_manual_finalization_profiles"
       WHERE "id"=assertion_row.profile_id OR ("branch_id"=p_branch_id AND "version"=p_version))<>1
    OR profile_row.id IS DISTINCT FROM assertion_row.profile_id OR profile_row.branch_id IS DISTINCT FROM p_branch_id
    OR profile_row.version IS DISTINCT FROM p_version OR profile_row.config_hash IS DISTINCT FROM expected_hash OR profile_row.state<>'draft' THEN
    RAISE EXCEPTION 'profile version conflict' USING ERRCODE='23505'; END IF;
  INSERT INTO public."pos_manual_profile_operations"("id","profile_id","branch_id","profile_version","action","from_state","to_state","previous_config_hash","resulting_config_hash","executor_subject_id","actor_profile_id","actor_user_id","idempotency_key","request_hash","admin_assertion_id")
  VALUES(operation_id,profile_row.id,p_branch_id,p_version,'put',NULL,'draft',NULL,expected_hash,p_actor_user_id,p_actor_profile_id,p_actor_user_id,p_idempotency_key,p_request_hash,assertion_row.id) RETURNING * INTO operation_row;
  INSERT INTO public."pos_manual_profile_state_events"("operation_id","profile_id","branch_id","profile_version","action","from_state","to_state","config_hash","write_txid")
  VALUES(operation_row.id,profile_row.id,p_branch_id,p_version,'put',NULL,'draft',expected_hash,operation_row.write_txid);
  UPDATE public."pos_manual_profile_admin_assertions" SET "consumed_operation_id"=operation_row.id,"consumed_at"=now_at WHERE "id"=assertion_row.id;
  DELETE FROM public."pos_manual_t2_lock_contexts" WHERE "id"=context_id;
  RETURN pg_catalog.jsonb_build_object('profileId',profile_row.id,'version',p_version,'state','draft','configHash',expected_hash,'replayed',false);
END
$function$;

CREATE FUNCTION public."pos_manual_activate_finalization_profile_v1"(
 p_profile_id uuid,p_expected_version integer,p_homologator_id text,p_admin_assertion_hash text,
 p_accounting_assertion_hash text,p_fiscal_assertion_hash text,p_idempotency_key text,p_request_hash text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE authority text; p record; a record; aa record; fa record; op record; now_at timestamptz; context_id bigint; operation_id bigint;
BEGIN
 PERFORM public."pos_manual_t2_assert_shape_v1"(p_idempotency_key,p_request_hash);
 IF p_expected_version<=0 OR p_admin_assertion_hash !~ '^[0-9a-f]{64}$' OR p_accounting_assertion_hash !~ '^[0-9a-f]{64}$' OR p_fiscal_assertion_hash !~ '^[0-9a-f]{64}$'
   OR NOT public."pos_manual_t2_subject_safe_v1"(p_homologator_id) THEN RAISE EXCEPTION 'invalid profile activation shape' USING ERRCODE='22023'; END IF;
 authority:=public."pos_manual_t2_authority_v1"('profile_homologator');
 IF p_request_hash<>public."pos_manual_t2_profile_request_hash_v1"('profile-activate-v1',pg_catalog.jsonb_build_object('profileId',p_profile_id,'expectedVersion',p_expected_version,'homologatorId',p_homologator_id,'adminAssertionHash',pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_admin_assertion_hash,'UTF8')),'hex'),'accountingAssertionHash',pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_accounting_assertion_hash,'UTF8')),'hex'),'fiscalAssertionHash',pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_fiscal_assertion_hash,'UTF8')),'hex'),'idempotencyKey',p_idempotency_key)) THEN RAISE EXCEPTION 'profile request hash mismatch' USING ERRCODE='23514'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('t2-profile-activate:'||p_idempotency_key,0));
 SELECT * INTO op FROM public."pos_manual_profile_operations" WHERE "profile_id"=p_profile_id AND "action"='activate' AND "idempotency_key"=p_idempotency_key;
 IF op.id IS NOT NULL THEN IF op.request_hash<>p_request_hash THEN RAISE EXCEPTION 'profile activation idempotency conflict' USING ERRCODE='23505'; END IF;
   RETURN pg_catalog.jsonb_build_object('profileId',p_profile_id,'version',op.profile_version,'state','active','configHash',op.resulting_config_hash,'replayed',true); END IF;
 SELECT * INTO p FROM public."pos_manual_finalization_profiles" WHERE "id"=p_profile_id;
 IF p.id IS NULL THEN RAISE EXCEPTION 'profile activation boundary changed' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM public."branches" WHERE "id"=p.branch_id FOR UPDATE;
 PERFORM 1 FROM public."pos_connectors" WHERE "branch_id"=p.branch_id ORDER BY "id" FOR UPDATE;
 PERFORM 1 FROM public."pos_manual_payment_reconciliation_gates" gate JOIN public."pos_connectors" connector ON connector."id"=gate."connector_id" WHERE connector."branch_id"=p.branch_id ORDER BY gate."connector_id" FOR UPDATE OF gate;
 SELECT * INTO p FROM public."pos_manual_finalization_profiles" WHERE "id"=p_profile_id FOR UPDATE;
 IF p.id IS NULL OR p.version<>p_expected_version OR p.state<>'draft' THEN RAISE EXCEPTION 'profile activation boundary changed' USING ERRCODE='23514'; END IF;
 IF p.fiscal_mode='required_queue' THEN
   PERFORM 1 FROM public."pos_fiscal_profiles" WHERE "id"=p.fiscal_profile_id AND "branch_id"=p.branch_id
     AND "version"=p.fiscal_profile_version AND "policy_digest"=p.fiscal_policy_hash FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'fiscal profile boundary missing' USING ERRCODE='23514'; END IF;
 END IF;
 PERFORM 1 FROM public."pos_accounting_policies" WHERE "id"=p.accounting_policy_id AND "branch_id"=p.branch_id
   AND "version"=p.accounting_policy_version AND "mapping_hash"=p.accounting_policy_hash FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'accounting policy boundary missing' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM public."cost_centers" WHERE "id"=p.cost_center_id AND "active" FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'profile cost center boundary missing' USING ERRCODE='23514'; END IF;
 SELECT * INTO a FROM public."pos_manual_profile_admin_assertions" WHERE "assertion_hash"=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_admin_assertion_hash,'UTF8')),'hex') FOR UPDATE;
 SELECT * INTO aa FROM public."pos_manual_profile_accounting_assertions" WHERE "assertion_hash"=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_accounting_assertion_hash,'UTF8')),'hex') FOR UPDATE;
 SELECT * INTO fa FROM public."pos_manual_profile_fiscal_assertions" WHERE "assertion_hash"=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_fiscal_assertion_hash,'UTF8')),'hex') FOR UPDATE;
 now_at:=pg_catalog.clock_timestamp();
 IF a.id IS NULL OR aa.id IS NULL OR fa.id IS NULL OR a.action<>'activate' OR a.branch_id<>p.branch_id OR a.profile_id<>p.id OR aa.profile_id<>p.id OR fa.profile_id<>p.id
  OR a.expected_version<>p.version OR aa.expected_version<>p.version OR fa.expected_version<>p.version
  OR a.expected_config_hash<>p.config_hash OR aa.expected_config_hash<>p.config_hash OR fa.expected_config_hash<>p.config_hash
  OR aa.expected_accounting_policy_hash<>p.accounting_policy_hash OR fa.expected_fiscal_policy_hash<>p.fiscal_policy_hash OR fa.fiscal_mode<>p.fiscal_mode
  OR a.subject_id<>p_homologator_id OR a.issuer_subject_id=p_homologator_id
  OR p_homologator_id=aa.approver_id OR p_homologator_id=fa.approver_id OR aa.approver_id=fa.approver_id
  OR a.consumed_operation_id IS NOT NULL OR aa.consumed_operation_id IS NOT NULL OR fa.consumed_operation_id IS NOT NULL
  OR a.expires_at<=now_at OR aa.expires_at<=now_at OR fa.expires_at<=now_at THEN RAISE EXCEPTION 'profile activation assertions denied' USING ERRCODE='42501'; END IF;
 IF EXISTS (SELECT 1 FROM public."pos_manual_finalization_profiles" WHERE "branch_id"=p.branch_id AND "state"='active' AND "id"<>p.id) THEN RAISE EXCEPTION 'branch already has active profile' USING ERRCODE='23514'; END IF;
 now_at:=pg_catalog.clock_timestamp();
 IF NOT EXISTS (SELECT 1 FROM public."pos_accounting_policies" WHERE "id"=p.accounting_policy_id AND "branch_id"=p.branch_id AND "version"=p.accounting_policy_version AND "mapping_hash"=p.accounting_policy_hash AND "status"='active'
   AND "effective_from"<=now_at::date AND ("effective_until" IS NULL OR "effective_until">=now_at::date)) THEN RAISE EXCEPTION 'accounting policy not effective' USING ERRCODE='23514'; END IF;
 IF p.fiscal_mode='required_queue' AND NOT EXISTS (SELECT 1 FROM public."pos_fiscal_profiles" WHERE "id"=p.fiscal_profile_id AND "branch_id"=p.branch_id AND "version"=p.fiscal_profile_version AND "policy_digest"=p.fiscal_policy_hash
   AND "status"='active' AND "environment" IN ('homologation','production') AND ("effective_from" IS NULL OR "effective_from"<=now_at) AND ("effective_until" IS NULL OR "effective_until">now_at)) THEN
   RAISE EXCEPTION 'fiscal profile not effective' USING ERRCODE='23514'; END IF;
 context_id:=public."pos_manual_t2_open_context_v1"('profile_activate',p.id::text,authority);
 operation_id:=pg_catalog.nextval('public.pos_manual_profile_operations_id_seq'::pg_catalog.regclass);
 UPDATE public."pos_manual_finalization_profiles" SET "state"='active',"homologated_by"=p_homologator_id,"homologated_at"=now_at,
   "accounting_approved_by"=aa.approver_id,"accounting_approved_at"=now_at,"fiscal_approved_by"=fa.approver_id,"fiscal_approved_at"=now_at,
   "activated_at"=now_at,"updated_at"=now_at,"lifecycle_txid"=pg_catalog.txid_current()::numeric,"lifecycle_operation_id"=operation_id WHERE "id"=p.id;
 INSERT INTO public."pos_manual_profile_operations"("id","profile_id","branch_id","profile_version","action","from_state","to_state","previous_config_hash","resulting_config_hash","executor_subject_id","idempotency_key","request_hash","admin_assertion_id","accounting_assertion_id","fiscal_assertion_id")
 VALUES(operation_id,p.id,p.branch_id,p.version,'activate','draft','active',p.config_hash,p.config_hash,p_homologator_id,p_idempotency_key,p_request_hash,a.id,aa.id,fa.id) RETURNING * INTO op;
 INSERT INTO public."pos_manual_profile_state_events"("operation_id","profile_id","branch_id","profile_version","action","from_state","to_state","config_hash","write_txid") VALUES(op.id,p.id,p.branch_id,p.version,'activate','draft','active',p.config_hash,op.write_txid);
 UPDATE public."pos_manual_profile_admin_assertions" SET "consumed_operation_id"=op.id,"consumed_at"=now_at WHERE "id"=a.id;
 UPDATE public."pos_manual_profile_accounting_assertions" SET "consumed_operation_id"=op.id,"consumed_at"=now_at WHERE "id"=aa.id;
 UPDATE public."pos_manual_profile_fiscal_assertions" SET "consumed_operation_id"=op.id,"consumed_at"=now_at WHERE "id"=fa.id;
 INSERT INTO public."pos_manual_profile_gate_bindings"("operation_id","profile_id","connector_id","old_profile_id","old_profile_version","old_profile_hash","new_profile_version","new_profile_hash","write_txid")
 SELECT op.id,p.id,gate."connector_id",gate."finalization_profile_id",gate."finalization_profile_version",gate."finalization_profile_hash",p.version,p.config_hash,op.write_txid
 FROM public."pos_manual_payment_reconciliation_gates" gate
 JOIN public."pos_connectors" connector ON connector."id"=gate."connector_id"
 WHERE connector."branch_id"=p.branch_id;
 UPDATE public."pos_manual_payment_reconciliation_gates" gate SET "finalization_profile_id"=p.id,
   "finalization_profile_version"=p.version,"finalization_profile_hash"=p.config_hash,"updated_at"=now_at
 FROM public."pos_connectors" connector WHERE connector."id"=gate."connector_id" AND connector."branch_id"=p.branch_id;
 DELETE FROM public."pos_manual_t2_lock_contexts" WHERE "id"=context_id;
 RETURN pg_catalog.jsonb_build_object('profileId',p.id,'version',p.version,'state','active','configHash',p.config_hash,'replayed',false,'gateEnabled',false);
END
$function$;

CREATE FUNCTION public."pos_manual_retire_finalization_profile_v1"(
 p_profile_id uuid,p_expected_version integer,p_homologator_id text,p_reason_code text,p_admin_assertion_hash text,p_idempotency_key text,p_request_hash text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE authority text; p record; a record; op record; now_at timestamptz; context_id bigint; operation_id bigint;
BEGIN
 PERFORM public."pos_manual_t2_assert_shape_v1"(p_idempotency_key,p_request_hash);
 IF p_expected_version<=0 OR p_admin_assertion_hash !~ '^[0-9a-f]{64}$'
   OR p_reason_code NOT IN ('policy_rotation','profile_superseded','security_incident','configuration_replaced','administrative_retirement')
   OR NOT public."pos_manual_t2_subject_safe_v1"(p_homologator_id) THEN RAISE EXCEPTION 'invalid profile retire shape' USING ERRCODE='22023'; END IF;
 authority:=public."pos_manual_t2_authority_v1"('profile_homologator');
 IF p_request_hash<>public."pos_manual_t2_profile_request_hash_v1"('profile-retire-v1',pg_catalog.jsonb_build_object('profileId',p_profile_id,'expectedVersion',p_expected_version,'homologatorId',p_homologator_id,'reasonCode',p_reason_code,'adminAssertionHash',pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_admin_assertion_hash,'UTF8')),'hex'),'idempotencyKey',p_idempotency_key)) THEN RAISE EXCEPTION 'profile request hash mismatch' USING ERRCODE='23514'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('t2-profile-retire:'||p_idempotency_key,0));
 SELECT * INTO op FROM public."pos_manual_profile_operations" WHERE "profile_id"=p_profile_id AND "action"='retire' AND "idempotency_key"=p_idempotency_key;
 IF op.id IS NOT NULL THEN IF op.request_hash<>p_request_hash THEN RAISE EXCEPTION 'profile retire idempotency conflict' USING ERRCODE='23505'; END IF;
   RETURN pg_catalog.jsonb_build_object('profileId',p_profile_id,'version',op.profile_version,'state','retired','configHash',op.resulting_config_hash,'replayed',true); END IF;
 SELECT * INTO p FROM public."pos_manual_finalization_profiles" WHERE "id"=p_profile_id;
 IF p.id IS NULL THEN RAISE EXCEPTION 'profile retire boundary changed' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM public."branches" WHERE "id"=p.branch_id FOR SHARE;
 PERFORM 1 FROM public."pos_connectors" WHERE "branch_id"=p.branch_id ORDER BY "id" FOR UPDATE;
 PERFORM 1 FROM public."pos_manual_payment_reconciliation_gates" gate JOIN public."pos_connectors" connector ON connector."id"=gate."connector_id" WHERE connector."branch_id"=p.branch_id ORDER BY gate."connector_id" FOR UPDATE OF gate;
 SELECT * INTO p FROM public."pos_manual_finalization_profiles" WHERE "id"=p_profile_id FOR UPDATE;
 IF p.id IS NULL OR p.version<>p_expected_version OR p.state<>'active' THEN RAISE EXCEPTION 'profile retire boundary changed' USING ERRCODE='23514'; END IF;
 SELECT * INTO a FROM public."pos_manual_profile_admin_assertions" WHERE "assertion_hash"=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_admin_assertion_hash,'UTF8')),'hex') FOR UPDATE;
 now_at:=pg_catalog.clock_timestamp();
 IF a.id IS NULL OR a.action<>'retire' OR a.branch_id<>p.branch_id OR a.profile_id<>p.id OR a.expected_version<>p.version OR a.expected_config_hash<>p.config_hash OR a.subject_id<>p_homologator_id
   OR a.issuer_subject_id=p_homologator_id OR a.consumed_operation_id IS NOT NULL OR a.expires_at<=now_at THEN RAISE EXCEPTION 'profile retire assertion denied' USING ERRCODE='42501'; END IF;
 context_id:=public."pos_manual_t2_open_context_v1"('profile_retire',p.id::text,authority);
 operation_id:=pg_catalog.nextval('public.pos_manual_profile_operations_id_seq'::pg_catalog.regclass);
 UPDATE public."pos_manual_finalization_profiles" SET "state"='retired',"retired_at"=now_at,"updated_at"=now_at,
   "lifecycle_txid"=pg_catalog.txid_current()::numeric,"lifecycle_operation_id"=operation_id WHERE "id"=p.id;
 INSERT INTO public."pos_manual_profile_operations"("id","profile_id","branch_id","profile_version","action","from_state","to_state","previous_config_hash","resulting_config_hash","executor_subject_id","idempotency_key","request_hash","admin_assertion_id")
 VALUES(operation_id,p.id,p.branch_id,p.version,'retire','active','retired',p.config_hash,p.config_hash,p_homologator_id,p_idempotency_key,p_request_hash,a.id) RETURNING * INTO op;
 INSERT INTO public."pos_manual_profile_state_events"("operation_id","profile_id","branch_id","profile_version","action","from_state","to_state","config_hash","reason_code","write_txid") VALUES(op.id,p.id,p.branch_id,p.version,'retire','active','retired',p.config_hash,p_reason_code,op.write_txid);
 UPDATE public."pos_manual_profile_admin_assertions" SET "consumed_operation_id"=op.id,"consumed_at"=now_at WHERE "id"=a.id;
 DELETE FROM public."pos_manual_t2_lock_contexts" WHERE "id"=context_id;
 RETURN pg_catalog.jsonb_build_object('profileId',p.id,'version',p.version,'state','retired','configHash',p.config_hash,'replayed',false);
END
$function$;

ALTER TABLE public."pos_manual_profile_operations"
  ADD CONSTRAINT "pos_manual_profile_ops_id_profile_key" UNIQUE ("id","profile_id"),
  ADD CONSTRAINT "pos_manual_profile_ops_id_profile_action_key" UNIQUE ("id","profile_id","action"),
  ADD CONSTRAINT "pos_manual_profile_ops_current_identity_key" UNIQUE ("id","profile_id","branch_id","profile_version","to_state","resulting_config_hash","write_txid"),
  ADD CONSTRAINT "pos_manual_profile_ops_gate_identity_key" UNIQUE ("id","profile_id","profile_version","resulting_config_hash","write_txid"),
  ADD CONSTRAINT "pos_manual_profile_ops_event_identity_key" UNIQUE ("id","profile_id","branch_id","profile_version","action","to_state","resulting_config_hash","write_txid");
ALTER TABLE public."pos_manual_finalization_profiles"
  ADD CONSTRAINT "pos_manual_fin_profiles_full_identity_key" UNIQUE ("id","branch_id","version","config_hash"),
  ADD CONSTRAINT "pos_manual_fin_profiles_lifecycle_key" UNIQUE ("id","version","config_hash","lifecycle_txid"),
  ADD CONSTRAINT "pos_manual_fin_profiles_lifecycle_identity_key" UNIQUE ("id","branch_id","version","config_hash","lifecycle_txid");
ALTER TABLE public."pos_manual_finalization_profiles"
  ADD CONSTRAINT "pos_manual_fin_profiles_current_operation_fkey" FOREIGN KEY ("lifecycle_operation_id","id","branch_id","version","state","config_hash","lifecycle_txid")
    REFERENCES public."pos_manual_profile_operations"("id","profile_id","branch_id","profile_version","to_state","resulting_config_hash","write_txid") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public."pos_manual_profile_admin_assertions"
  ADD CONSTRAINT "pos_manual_profile_admin_consumption_fkey" FOREIGN KEY ("consumed_operation_id","profile_id","action")
    REFERENCES public."pos_manual_profile_operations"("id","profile_id","action") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public."pos_manual_profile_operations"
  ADD CONSTRAINT "pos_manual_profile_ops_admin_assertion_fkey" FOREIGN KEY ("admin_assertion_id")
    REFERENCES public."pos_manual_profile_admin_assertions"("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT "pos_manual_profile_ops_account_assertion_fkey" FOREIGN KEY ("accounting_assertion_id")
    REFERENCES public."pos_manual_profile_accounting_assertions"("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT "pos_manual_profile_ops_fiscal_assertion_fkey" FOREIGN KEY ("fiscal_assertion_id")
    REFERENCES public."pos_manual_profile_fiscal_assertions"("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public."pos_manual_profile_accounting_assertions"
  ADD CONSTRAINT "pos_manual_profile_account_consumption_fkey" FOREIGN KEY ("consumed_operation_id","profile_id")
    REFERENCES public."pos_manual_profile_operations"("id","profile_id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public."pos_manual_profile_fiscal_assertions"
  ADD CONSTRAINT "pos_manual_profile_fiscal_consumption_fkey" FOREIGN KEY ("consumed_operation_id","profile_id")
    REFERENCES public."pos_manual_profile_operations"("id","profile_id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
-- Bind every consumed assertion to the exact operation version/config without
-- making its row trigger consult the operation ledger.  These reverse FKs are
-- deferred because lifecycle capabilities insert the operation and consume its
-- assertions in the same transaction.
ALTER TABLE public."pos_manual_profile_admin_assertions"
  ADD CONSTRAINT "pos_manual_profile_admin_causal_key" UNIQUE
    ("id","profile_id","action","expected_version","expected_config_hash");
ALTER TABLE public."pos_manual_profile_accounting_assertions"
  ADD CONSTRAINT "pos_manual_profile_account_causal_key" UNIQUE
    ("id","profile_id","expected_version","expected_config_hash");
ALTER TABLE public."pos_manual_profile_fiscal_assertions"
  ADD CONSTRAINT "pos_manual_profile_fiscal_causal_key" UNIQUE
    ("id","profile_id","expected_version","expected_config_hash");
ALTER TABLE public."pos_manual_profile_operations"
  ADD CONSTRAINT "pos_manual_profile_ops_admin_causal_fkey" FOREIGN KEY
    ("admin_assertion_id","profile_id","action","profile_version","resulting_config_hash")
    REFERENCES public."pos_manual_profile_admin_assertions"
      ("id","profile_id","action","expected_version","expected_config_hash")
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT "pos_manual_profile_ops_account_causal_fkey" FOREIGN KEY
    ("accounting_assertion_id","profile_id","profile_version","resulting_config_hash")
    REFERENCES public."pos_manual_profile_accounting_assertions"
      ("id","profile_id","expected_version","expected_config_hash")
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT "pos_manual_profile_ops_fiscal_causal_fkey" FOREIGN KEY
    ("fiscal_assertion_id","profile_id","profile_version","resulting_config_hash")
    REFERENCES public."pos_manual_profile_fiscal_assertions"
      ("id","profile_id","expected_version","expected_config_hash")
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public."pos_manual_profile_state_events"
  ADD CONSTRAINT "pos_manual_profile_event_operation_fkey" FOREIGN KEY ("operation_id","profile_id","action")
    REFERENCES public."pos_manual_profile_operations"("id","profile_id","action") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT "pos_manual_profile_event_profile_fkey" FOREIGN KEY ("profile_id")
    REFERENCES public."pos_manual_finalization_profiles"("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT "pos_manual_profile_event_causal_fkey" FOREIGN KEY ("operation_id","profile_id","branch_id","profile_version","action","to_state","config_hash","write_txid")
    REFERENCES public."pos_manual_profile_operations"("id","profile_id","branch_id","profile_version","action","to_state","resulting_config_hash","write_txid") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT "pos_manual_profile_event_profile_identity_fkey" FOREIGN KEY ("profile_id","branch_id","profile_version","config_hash")
    REFERENCES public."pos_manual_finalization_profiles"("id","branch_id","version","config_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public."pos_manual_profile_gate_bindings"
  ADD CONSTRAINT "pos_manual_profile_gate_binding_operation_fkey" FOREIGN KEY ("operation_id","profile_id")
    REFERENCES public."pos_manual_profile_operations"("id","profile_id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT "pos_manual_profile_gate_binding_operation_causal_fkey" FOREIGN KEY ("operation_id","profile_id","new_profile_version","new_profile_hash","write_txid")
    REFERENCES public."pos_manual_profile_operations"("id","profile_id","profile_version","resulting_config_hash","write_txid") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION public."guard_pos_manual_profile_assertion_v1"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE expected_capability text;
BEGIN
  expected_capability:=CASE
    WHEN TG_TABLE_NAME='pos_manual_profile_admin_assertions' THEN
      CASE COALESCE(pg_catalog.to_jsonb(NEW)->>'action',pg_catalog.to_jsonb(OLD)->>'action')
        WHEN 'put' THEN 'profile_put' WHEN 'activate' THEN 'profile_activate' WHEN 'retire' THEN 'profile_retire' END
    WHEN TG_TABLE_NAME IN ('pos_manual_profile_accounting_assertions','pos_manual_profile_fiscal_assertions') THEN 'profile_activate'
  END;
  IF TG_OP='DELETE' OR OLD."consumed_operation_id" IS NOT NULL
    OR NEW."consumed_operation_id" IS NULL OR expected_capability IS NULL
    OR (pg_catalog.to_jsonb(NEW)-'consumed_operation_id'-'consumed_at') IS DISTINCT FROM (pg_catalog.to_jsonb(OLD)-'consumed_operation_id'-'consumed_at')
    OR NOT EXISTS (SELECT 1 FROM public."pos_manual_t2_lock_contexts" c
      WHERE c."backend_pid"=pg_catalog.pg_backend_pid() AND c."transaction_txid"=pg_catalog.txid_current()::numeric
        AND c."aggregate_kind"='profile' AND c."aggregate_id"=NEW."profile_id"::text
        AND c."nonce_hash"=public."pos_manual_t2_transaction_nonce_hash_v1"()
        AND c."capability"=expected_capability) THEN
    RAISE EXCEPTION 'profile assertion is one-shot append-only evidence' USING ERRCODE='23514';
  END IF;
  -- Timestamp authority stays inside the database.  The deferred bidirectional
  -- FKs above prove assertion/operation/profile/action/version/config identity.
  NEW."consumed_at":=pg_catalog.clock_timestamp();
  RETURN NEW;
END
$function$;
CREATE TRIGGER "pos_manual_profile_admin_assertion_guard" BEFORE UPDATE OR DELETE ON public."pos_manual_profile_admin_assertions" FOR EACH ROW EXECUTE FUNCTION public."guard_pos_manual_profile_assertion_v1"();
CREATE TRIGGER "pos_manual_profile_account_assertion_guard" BEFORE UPDATE OR DELETE ON public."pos_manual_profile_accounting_assertions" FOR EACH ROW EXECUTE FUNCTION public."guard_pos_manual_profile_assertion_v1"();
CREATE TRIGGER "pos_manual_profile_fiscal_assertion_guard" BEFORE UPDATE OR DELETE ON public."pos_manual_profile_fiscal_assertions" FOR EACH ROW EXECUTE FUNCTION public."guard_pos_manual_profile_assertion_v1"();
CREATE TRIGGER "pos_manual_profile_operations_append_only" BEFORE UPDATE OR DELETE ON public."pos_manual_profile_operations" FOR EACH ROW EXECUTE FUNCTION public."protect_pos_manual_append_only"();
CREATE TRIGGER "pos_manual_profile_events_append_only" BEFORE UPDATE OR DELETE ON public."pos_manual_profile_state_events" FOR EACH ROW EXECUTE FUNCTION public."protect_pos_manual_append_only"();
CREATE TRIGGER "pos_manual_profile_gate_bindings_append_only" BEFORE UPDATE OR DELETE ON public."pos_manual_profile_gate_bindings" FOR EACH ROW EXECUTE FUNCTION public."protect_pos_manual_append_only"();

-- Retrofit every historical producer behind a transaction-scoped wrapper.
-- The implementation OIDs lose all non-owner EXECUTE ACLs; reconcile grants
-- only the original wrapper signatures after attesting their final bodies.
DO $retrofit$
DECLARE producer record; routine_oid oid; args text; identity_args text; call_args text; impl_name text; wrapper_sql text; acl_role name;
BEGIN
  FOR producer IN SELECT * FROM (VALUES
    ('pos_manual_review_case_v1','uuid,integer,integer,text,text,text,text,text,text'),
    ('pos_manual_record_callback_v1','text,text,text,text,text,text,text,text,timestamptz,text,text,text,integer,text,bigint,timestamptz,integer,text'),
    ('pos_manual_attest_query_response_v1','uuid,integer,text,text,text,text,text,text,text,text,text,timestamptz,text,text,text,integer,text,bigint,timestamptz,integer,text'),
    ('pos_manual_complete_delivery_v1','uuid,text,uuid,text'),
    ('pos_manual_report_transport_v1','uuid,text,text,text'),
    ('pos_manual_claim_queries_v1','text,integer,integer,text'),
    ('pos_manual_open_case_v1','uuid,text,bigint,text,text,text,text,text,text,text,text,text,text,timestamptz,timestamptz,text')
  ) expected(function_name,identity_signature)
  LOOP
    routine_oid:=pg_catalog.to_regprocedure('public.'||producer.function_name||'('||producer.identity_signature||')');
    IF routine_oid IS NULL THEN RAISE EXCEPTION 'T2-01 producer catalog incomplete: %',producer.function_name USING ERRCODE='23514'; END IF;
    SELECT pg_catalog.pg_get_function_arguments(routine_oid),pg_catalog.pg_get_function_identity_arguments(routine_oid),
      (SELECT pg_catalog.string_agg('$'||n::text,',' ORDER BY n) FROM pg_catalog.generate_series(1,p.pronargs) n)
      INTO args,identity_args,call_args FROM pg_catalog.pg_proc p WHERE p.oid=routine_oid;
    impl_name:=producer.function_name||'_t2_01_impl';
    EXECUTE pg_catalog.format('ALTER FUNCTION public.%I(%s) RENAME TO %I',producer.function_name,identity_args,impl_name);
    FOR acl_role IN SELECT DISTINCT role_row.rolname FROM pg_catalog.pg_proc p
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) privilege
      JOIN pg_catalog.pg_roles role_row ON role_row.oid=privilege.grantee
      WHERE p.oid=routine_oid AND privilege.grantee<>p.proowner AND privilege.privilege_type='EXECUTE'
    LOOP EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION public.%I(%s) FROM %I',impl_name,identity_args,acl_role); END LOOP;
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION public.%I(%s) FROM PUBLIC',impl_name,identity_args);
    wrapper_sql:=pg_catalog.format($wrapper$
      CREATE FUNCTION public.%I(%s) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
      DECLARE context_id bigint; result jsonb; caller_hash text;
      BEGIN
        caller_hash:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('t2-legacy-writer-v1','UTF8')||pg_catalog.decode('00','hex')||pg_catalog.convert_to(session_user,'UTF8')),'hex');
        context_id:=public."pos_manual_t2_open_context_v1"('legacy_producer:%s','%s',caller_hash);
        result:=public.%I(%s);
        DELETE FROM public."pos_manual_t2_lock_contexts" WHERE "id"=context_id;
        RETURN result;
      END
      $body$;
    $wrapper$,producer.function_name,args,producer.function_name,producer.function_name,impl_name,call_args);
    EXECUTE wrapper_sql;
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION public.%I(%s) FROM PUBLIC',producer.function_name,identity_args);
  END LOOP;
END
$retrofit$;

-- Attestation never mutates case/operation/state-event, so it needs no write
-- roots; keep its frozen body and close only the historical public search path.
ALTER FUNCTION public."pos_manual_attest_query_response_v1_t2_01_impl"(
  uuid,integer,text,text,text,text,text,text,text,text,text,timestamptz,text,text,text,integer,text,bigint,timestamptz,integer,text)
  SET search_path=pg_catalog, public;

-- First explicit legacy vertical slice.  This replaces the renamed historical
-- implementation with a version whose three protected rows are fully
-- materialized by the owner before their exact roots are opened.  The public
-- wrapper ABI and its nominal ACL remain unchanged.
CREATE OR REPLACE FUNCTION public."pos_manual_open_case_v1_t2_01_impl"(
  p_request_id uuid,p_claim_token text,p_fencing_token bigint,p_finalize_idempotency_key text,
  p_external_proof_id text,p_stable_reference_index text,p_reference_hash text,p_reference_key_id text,
  p_reference_last_four text,p_vault_key_id text,p_binding_hash text,p_proof_hash text,p_signature_hash text,
  p_issued_at timestamptz,p_retention_expires_at timestamptz,p_verifier_version text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog, public AS $function$
DECLARE
  r public."pos_manual_open_requests"%ROWTYPE;
  c public."pos_manual_payment_cases"%ROWTYPE;
  proof public."pos_manual_vault_proofs"%ROWTYPE;
  operation_row public."pos_manual_payment_operations"%ROWTYPE;
  event_row public."pos_manual_payment_state_events"%ROWTYPE;
  now_at timestamptz;
  new_case_id uuid:=pg_catalog.gen_random_uuid();
  tx numeric:=pg_catalog.txid_current()::numeric;
  idem_hash text; finalize_hash text; expected_proof_hash text; verifier_skew integer;
BEGIN
  IF p_request_id IS NULL OR p_claim_token IS NULL OR pg_catalog.length(p_claim_token) NOT BETWEEN 32 AND 160
    OR p_fencing_token IS NULL OR p_fencing_token<=0 OR p_finalize_idempotency_key IS NULL
    OR pg_catalog.length(p_finalize_idempotency_key) NOT BETWEEN 8 AND 160 OR p_external_proof_id IS NULL
    OR pg_catalog.length(p_external_proof_id) NOT BETWEEN 8 AND 160 OR p_reference_key_id IS NULL
    OR p_reference_last_four IS NULL OR p_vault_key_id IS NULL OR p_issued_at IS NULL
    OR p_retention_expires_at IS NULL OR p_verifier_version IS NULL
  THEN RAISE EXCEPTION 'invalid closed manual finalize input' USING ERRCODE='22023'; END IF;
  idem_hash:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    'pos-manual-finalize-idempotency-v1'||pg_catalog.jsonb_build_array(p_request_id,p_fencing_token,p_finalize_idempotency_key)::text,'UTF8')),'hex');
  finalize_hash:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    'pos-manual-finalize-request-v1'||pg_catalog.jsonb_build_array(p_request_id,p_fencing_token,p_finalize_idempotency_key,
      p_external_proof_id,p_stable_reference_index,p_reference_hash,p_reference_key_id,p_reference_last_four,p_vault_key_id,
      p_binding_hash,p_proof_hash,p_signature_hash,extract(epoch FROM p_issued_at),
      extract(epoch FROM p_retention_expires_at),p_verifier_version)::text,'UTF8')),'hex');
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('pos_manual_open_321f'),pg_catalog.hashtext(p_request_id::text));
  r:=public."pos_manual_lock_open_graph_321f"(p_request_id); now_at:=pg_catalog.clock_timestamp();
  IF r."state"='finalized' THEN
    IF r."finalize_idempotency_hash" IS DISTINCT FROM idem_hash OR r."finalize_request_hash" IS DISTINCT FROM finalize_hash
      THEN RAISE EXCEPTION 'manual finalize idempotency conflict' USING ERRCODE='23505'; END IF;
    RETURN pg_catalog.jsonb_build_object('caseId',r."case_id",'state','review_pending','version',0,'replayed',true);
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('pos-manual-proof-external-v1'),pg_catalog.hashtext(p_external_proof_id));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('pos-manual-proof-blind-v1'),pg_catalog.hashtext(p_stable_reference_index));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('pos-manual-proof-binding-v1'),pg_catalog.hashtext(p_binding_hash));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('pos-manual-proof-provider-reference-v1'),pg_catalog.hashtext(pg_catalog.jsonb_build_array(r."provider",p_reference_hash)::text));
  SELECT "max_future_skew_seconds" INTO verifier_skew FROM public."pos_manual_payment_vault_verifiers"
    WHERE "verifier_version"=p_verifier_version AND "enabled" FOR SHARE;
  now_at:=pg_catalog.clock_timestamp();
  IF public."pos_manual_open_boundary_failure_321f"(r."id",now_at) IS NOT NULL
    THEN RAISE EXCEPTION 'manual vault finalize boundary diverged after locks' USING ERRCODE='23514'; END IF;
  expected_proof_hash:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    'pos-manual-vault-proof-v1'||pg_catalog.jsonb_build_array(r."id",r."fencing_token",r."vault_idempotency_key",r."vault_adapter_id",r."provider",
      p_external_proof_id,p_stable_reference_index,p_reference_hash,p_reference_key_id,p_reference_last_four,p_vault_key_id,
      p_binding_hash,p_signature_hash,extract(epoch FROM p_issued_at),extract(epoch FROM p_retention_expires_at),p_verifier_version)::text,'UTF8')),'hex');
  IF r."state"<>'binding' OR r."fencing_token"<>p_fencing_token OR r."lease_expires_at"<=now_at
    OR r."lease_token_hash"<>pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_claim_token,'UTF8')),'hex')
    OR verifier_skew IS NULL OR p_reference_hash!~'^hmac-sha256:v[0-9]+:[0-9a-f]{64}$'
    OR p_stable_reference_index!~'^vault-blind:v[0-9]+:[0-9a-f]{64}$' OR p_binding_hash!~'^[0-9a-f]{64}$'
    OR p_proof_hash IS DISTINCT FROM expected_proof_hash OR p_signature_hash!~'^[0-9a-f]{64}$'
    OR p_issued_at<r."binding_at" OR p_issued_at>now_at+pg_catalog.make_interval(secs=>verifier_skew)
    OR p_retention_expires_at<=p_issued_at
    OR p_retention_expires_at<=LEAST((SELECT "expires_at" FROM public."pos_payment_plans" WHERE "id"=r."payment_plan_id"),now_at+interval '15 minutes')
    OR p_retention_expires_at>(SELECT "expires_at"+interval '60 seconds' FROM public."pos_payment_plans" WHERE "id"=r."payment_plan_id")
  THEN RAISE EXCEPTION 'manual vault finalize boundary diverged' USING ERRCODE='23514'; END IF;
  BEGIN
    c:=pg_catalog.jsonb_populate_record(NULL::public."pos_manual_payment_cases",pg_catalog.jsonb_build_object(
      'id',new_case_id,'branch_id',r."branch_id",'register_id',r."register_id",'session_id',r."session_id",
      'operator_profile_id',r."operator_profile_id",'terminal_id',r."terminal_id",'sale_draft_id',r."sale_draft_id",
      'draft_revision',r."draft_revision",'draft_request_hash',r."draft_request_hash",'quote_hash',r."quote_hash",
      'order_claim_id',r."order_claim_id",'payment_plan_id',r."payment_plan_id",'payment_index',0,'method',r."method",
      'amount_cents',r."amount_cents",'currency',r."currency",'installments',r."installments",'provider',r."provider",
      'connector_id',r."connector_id",'connector_revision',r."connector_revision",'credential_ref',r."credential_ref",
      'credential_revision',r."credential_revision",'reference_hash',p_reference_hash,'reference_key_id',p_reference_key_id,
      'reference_last_four',p_reference_last_four,'occurred_at',r."occurred_at",'reason_code',r."reason_code",
      'maker_profile_id',r."maker_profile_id",'maker_user_id',r."maker_user_id",'state','review_pending','version',0,
      'lifecycle_txid',tx,'idempotency_key',r."idempotency_key",'request_hash',r."intent_hash",
      'expires_at',LEAST((SELECT "expires_at" FROM public."pos_payment_plans" WHERE "id"=r."payment_plan_id"),now_at+interval '15 minutes'),
      'created_at',now_at,'updated_at',now_at));
    PERFORM public."pos_manual_t2_open_legacy_case_root_v1"('legacy_manual:open_case:case','open','INSERT',NULL,c);
    INSERT INTO public."pos_manual_payment_cases" SELECT (c).* RETURNING * INTO c;
    INSERT INTO public."pos_manual_vault_proofs"("open_request_id","case_id","vault_adapter_id","provider","external_proof_id","stable_reference_index","reference_hash","reference_key_id","reference_last_four","vault_key_id","binding_hash","proof_hash","signature_hash","issued_at","retention_expires_at","verifier_version","write_txid","created_at")
      VALUES(r."id",new_case_id,r."vault_adapter_id",r."provider",p_external_proof_id,p_stable_reference_index,p_reference_hash,p_reference_key_id,p_reference_last_four,p_vault_key_id,p_binding_hash,p_proof_hash,p_signature_hash,p_issued_at,p_retention_expires_at,p_verifier_version,tx,now_at) RETURNING * INTO proof;
    INSERT INTO public."pos_manual_payment_vault_bindings"("case_id","vault_provider","vault_reference","vault_key_id","binding_hash","stable_reference_index","retention_expires_at","vault_proof_id","binding_kind")
      VALUES(new_case_id,r."vault_adapter_id",'vault-proof:'||proof."id"::text,p_vault_key_id,p_binding_hash,p_stable_reference_index,p_retention_expires_at,proof."id",'proof_v1');
    operation_row:=pg_catalog.jsonb_populate_record(NULL::public."pos_manual_payment_operations",pg_catalog.jsonb_build_object(
      'id',pg_catalog.nextval(pg_catalog.pg_get_serial_sequence('public.pos_manual_payment_operations','id')::pg_catalog.regclass),'case_id',new_case_id,
      'action','open','expected_version',-1,'resulting_version',0,'resulting_state','review_pending',
      'idempotency_key','manual-open-321f:'||r."id"::text,'request_hash',r."intent_hash",'write_txid',tx,'created_at',now_at));
    PERFORM public."pos_manual_t2_open_legacy_operation_root_v1"('legacy_manual:open_case:operation','open',operation_row);
    INSERT INTO public."pos_manual_payment_operations" SELECT (operation_row).* RETURNING * INTO operation_row;
    event_row:=pg_catalog.jsonb_populate_record(NULL::public."pos_manual_payment_state_events",pg_catalog.jsonb_build_object(
      'id',pg_catalog.nextval(pg_catalog.pg_get_serial_sequence('public.pos_manual_payment_state_events','id')::pg_catalog.regclass),'case_id',new_case_id,
      'operation_id',operation_row."id",'from_state',NULL,'to_state','review_pending','resulting_version',0,
      'source','api','source_id',r."id"::text,'write_txid',tx,'created_at',now_at));
    PERFORM public."pos_manual_t2_open_legacy_state_event_root_v1"('legacy_manual:open_case:state_event','open',event_row);
    INSERT INTO public."pos_manual_payment_state_events" SELECT (event_row).*;
    UPDATE public."pos_manual_open_requests" SET "state"='finalized',"case_id"=new_case_id,"vault_proof_id"=proof."id",
      "finalize_idempotency_hash"=idem_hash,"finalize_request_hash"=finalize_hash,"lifecycle_txid"=tx,"finalized_at"=now_at,
      "lease_token_hash"=NULL,"lease_expires_at"=NULL WHERE "id"=r."id";
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'manual vault evidence conflict' USING ERRCODE='23505';
  END;
  RETURN pg_catalog.jsonb_build_object('caseId',new_case_id,'state','review_pending','version',0,'replayed',false);
END
$function$;

-- Worker delivery completion preserves the frozen 321e behaviour, but owns
-- every protected row before the observer-only guards see it.
CREATE OR REPLACE FUNCTION public."pos_manual_complete_delivery_v1_t2_01_impl"(
  p_attempt_id uuid,p_claim_token text,p_proof_id uuid,p_idempotency_key text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog, public AS $function$
DECLARE
  now_at timestamptz; claim_hash text;
  prior_delivery public."pos_manual_payment_delivery_results"%ROWTYPE;
  attempt_record public."pos_manual_payment_attempts"%ROWTYPE;
  outbox_record public."pos_manual_payment_outbox"%ROWTYPE;
  proof_record public."pos_manual_payment_provider_proofs"%ROWTYPE;
  case_record public."pos_manual_payment_cases"%ROWTYPE;
  target_case public."pos_manual_payment_cases"%ROWTYPE;
  delivery_record public."pos_manual_payment_delivery_results"%ROWTYPE;
  observation_record public."pos_manual_payment_observations"%ROWTYPE;
  operation_record public."pos_manual_payment_operations"%ROWTYPE;
  event_record public."pos_manual_payment_state_events"%ROWTYPE;
  prior_max_sequence bigint; prior_max_occurred_at timestamptz;
  boundary_failure text; next_state text; processing_result text; incident_code text;
  next_version integer; next_attempt_sequence integer; tx numeric:=pg_catalog.txid_current()::numeric;
BEGIN
  IF p_attempt_id IS NULL OR p_proof_id IS NULL OR p_claim_token IS NULL
    OR pg_catalog.length(p_claim_token) NOT BETWEEN 20 AND 240 OR p_claim_token !~ '^[A-Za-z0-9._:@/-]+$'
    OR p_idempotency_key IS NULL OR pg_catalog.length(p_idempotency_key) NOT BETWEEN 8 AND 160
  THEN RAISE EXCEPTION 'invalid closed delivery completion input' USING ERRCODE='22023'; END IF;
  claim_hash:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_claim_token,'UTF8')),'hex');
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('pos_manual_delivery_completion_v1'),pg_catalog.hashtext(p_idempotency_key));
  SELECT * INTO prior_delivery FROM public."pos_manual_payment_delivery_results" WHERE "completion_idempotency_key"=p_idempotency_key;
  IF FOUND THEN
    IF prior_delivery."result_kind" IS DISTINCT FROM 'provider_result' OR prior_delivery."attempt_id" IS DISTINCT FROM p_attempt_id
      OR prior_delivery."provider_proof_id" IS DISTINCT FROM p_proof_id OR prior_delivery."claim_token_hash" IS DISTINCT FROM claim_hash
    THEN RAISE EXCEPTION 'delivery completion idempotency conflict' USING ERRCODE='23505'; END IF;
    RETURN pg_catalog.jsonb_build_object('deliveryResultId',prior_delivery."id",'proofId',p_proof_id,
      'resultingState',prior_delivery."resulting_state",'resultingVersion',prior_delivery."resulting_version",
      'processingResult',prior_delivery."processing_result",'replayed',true);
  END IF;
  SELECT * INTO attempt_record FROM public."pos_manual_payment_attempts" WHERE "id"=p_attempt_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'manual query attempt not found' USING ERRCODE='23503'; END IF;
  case_record:=public."pos_manual_lock_case_graph_321e"(attempt_record."case_id");
  SELECT * INTO attempt_record FROM public."pos_manual_payment_attempts" WHERE "id"=p_attempt_id FOR UPDATE;
  SELECT * INTO outbox_record FROM public."pos_manual_payment_outbox" WHERE "attempt_id"=p_attempt_id FOR UPDATE;
  SELECT * INTO proof_record FROM public."pos_manual_payment_provider_proofs" WHERE "id"=p_proof_id FOR UPDATE;
  now_at:=pg_catalog.clock_timestamp();
  IF proof_record."id" IS NULL OR proof_record."source_kind"<>'query_response'
    OR proof_record."disposition" NOT IN ('accepted','replay') OR proof_record."case_id"<>case_record."id"
    OR proof_record."attempt_id"<>p_attempt_id OR proof_record."delivery_number"<>outbox_record."delivery_count"
    OR proof_record."provider_idempotency_key"<>attempt_record."provider_idempotency_key" OR proof_record."claim_token_hash"<>claim_hash
    OR EXISTS (SELECT 1 FROM public."pos_manual_payment_proof_consumptions" WHERE "proof_id"=p_proof_id)
    OR attempt_record."state"<>'claimed' OR outbox_record."state"<>'claimed'
    OR outbox_record."claim_token"<>p_claim_token OR outbox_record."claim_expires_at"<=now_at
  THEN RAISE EXCEPTION 'delivery completion requires one exact live unconsumed provider proof' USING ERRCODE='23514'; END IF;
  boundary_failure:=public."pos_manual_boundary_failure_321e"(case_record."id",proof_record."auth_key_id",proof_record."credential_revision",now_at);
  IF boundary_failure IS NOT NULL OR case_record."state"<>'unknown'
    OR ROW(case_record."provider",case_record."reference_hash",case_record."method",case_record."amount_cents",case_record."currency")
      IS DISTINCT FROM ROW(proof_record."provider",proof_record."reference_hash",proof_record."method",proof_record."amount_cents",proof_record."currency")
  THEN RAISE EXCEPTION 'provider proof no longer matches the manual boundary' USING ERRCODE='23514'; END IF;
  SELECT pg_catalog.max("provider_sequence"),pg_catalog.max("provider_occurred_at") INTO prior_max_sequence,prior_max_occurred_at
    FROM public."pos_manual_payment_provider_proofs" WHERE "case_id"=case_record."id" AND "id"<>proof_record."id"
      AND (proof_record."replay_of_proof_id" IS NULL OR "id"<>proof_record."replay_of_proof_id") AND "disposition"='accepted';
  IF proof_record."provider_occurred_at"<case_record."occurred_at"-interval '5 minutes'
    OR proof_record."provider_occurred_at">LEAST(now_at,case_record."expires_at")
    OR (prior_max_sequence IS NOT NULL AND proof_record."provider_sequence"<=prior_max_sequence)
    OR (prior_max_occurred_at IS NOT NULL AND proof_record."provider_occurred_at"<prior_max_occurred_at)
  THEN next_state:='blocked'; processing_result:='incident_opened'; incident_code:='provider_proof_causality_or_sequence_conflict';
  ELSIF proof_record."outcome"='confirmed_paid' AND case_record."expires_at">now_at THEN next_state:='confirmed_paid'; processing_result:='applied_transition';
  ELSIF proof_record."outcome" IN ('not_found','voided') AND case_record."expires_at">now_at THEN next_state:='no_funds'; processing_result:='applied_transition';
  ELSIF proof_record."outcome"='unknown' AND case_record."expires_at">now_at AND attempt_record."sequence"<12 THEN next_state:='unknown'; processing_result:='retry_scheduled';
  ELSE next_state:='blocked'; processing_result:='incident_opened';
    incident_code:=CASE WHEN proof_record."outcome"='refunded' THEN 'provider_reported_refund' ELSE 'late_or_exhausted_provider_proof' END;
  END IF;
  next_version:=case_record."version"+1;
  INSERT INTO public."pos_manual_payment_delivery_results"("attempt_id","delivery_number","claim_token_hash","response_hash","result_kind","outcome","evidence_hash","provider_sequence","occurred_at","retryable","superseded","resulting_state","resulting_version","provider_proof_id","processing_result","completion_idempotency_key")
  VALUES(p_attempt_id,outbox_record."delivery_count",claim_hash,proof_record."canonical_event_hash",'provider_result',proof_record."outcome",proof_record."evidence_hash",proof_record."provider_sequence",proof_record."provider_occurred_at",processing_result='retry_scheduled',processing_result='incident_opened',next_state,next_version,p_proof_id,processing_result,p_idempotency_key) RETURNING * INTO delivery_record;
  INSERT INTO public."pos_manual_payment_proof_consumptions"("proof_id","delivery_result_id","consumer_role") VALUES(p_proof_id,delivery_record."id",session_user);
  INSERT INTO public."pos_manual_payment_observations"("case_id","attempt_id","source","outcome","reference_hash","method","amount_cents","currency","provider_sequence","provider_occurred_at","auth_key_id","processing_result","evidence_hash","resulting_state","resulting_version","write_txid")
  VALUES(case_record."id",p_attempt_id,'worker',proof_record."outcome",proof_record."reference_hash",proof_record."method",proof_record."amount_cents",proof_record."currency",proof_record."provider_sequence",proof_record."provider_occurred_at",proof_record."auth_key_id",processing_result,proof_record."evidence_hash",next_state,next_version,tx) RETURNING * INTO observation_record;
  operation_record:=pg_catalog.jsonb_populate_record(NULL::public."pos_manual_payment_operations",pg_catalog.jsonb_build_object(
    'id',pg_catalog.nextval(pg_catalog.pg_get_serial_sequence('public.pos_manual_payment_operations','id')::pg_catalog.regclass),
    'case_id',case_record."id",'action','observe','expected_version',case_record."version",'resulting_version',next_version,
    'resulting_state',next_state,'observation_id',observation_record."id",'idempotency_key','manual-delivery:'||p_idempotency_key,
    'request_hash',proof_record."canonical_event_hash",'write_txid',tx,'created_at',now_at));
  PERFORM public."pos_manual_t2_open_legacy_operation_root_v1"('legacy_manual:complete_delivery:operation','observe',operation_record);
  INSERT INTO public."pos_manual_payment_operations" SELECT (operation_record).* RETURNING * INTO operation_record;
  event_record:=pg_catalog.jsonb_populate_record(NULL::public."pos_manual_payment_state_events",pg_catalog.jsonb_build_object(
    'id',pg_catalog.nextval(pg_catalog.pg_get_serial_sequence('public.pos_manual_payment_state_events','id')::pg_catalog.regclass),
    'case_id',case_record."id",'operation_id',operation_record."id",'from_state',case_record."state",'to_state',next_state,
    'resulting_version',next_version,'source','worker','source_id',p_attempt_id::text,'write_txid',tx,'created_at',now_at));
  PERFORM public."pos_manual_t2_open_legacy_state_event_root_v1"('legacy_manual:complete_delivery:state_event','observe',event_record);
  INSERT INTO public."pos_manual_payment_state_events" SELECT (event_record).*;
  target_case:=case_record;
  target_case."state":=next_state; target_case."version":=next_version; target_case."provider_outcome":=proof_record."outcome";
  target_case."next_reconcile_at":=CASE WHEN processing_result='retry_scheduled' THEN now_at+interval '30 seconds' ELSE NULL END;
  IF next_state='confirmed_paid' THEN target_case."confirmed_observation_id":=observation_record."id"; target_case."confirmed_at":=now_at;
    target_case."confirmation_expires_at":=LEAST(now_at+interval '5 minutes',target_case."expires_at"); END IF;
  IF next_state='no_funds' THEN target_case."no_funds_at":=now_at; END IF;
  IF next_state='blocked' THEN target_case."blocked_at":=now_at; END IF;
  target_case."lifecycle_txid":=tx; target_case."updated_at":=now_at;
  PERFORM public."pos_manual_t2_open_legacy_case_root_v1"('legacy_manual:complete_delivery:case','observe','UPDATE',case_record,target_case);
  UPDATE public."pos_manual_payment_cases" SET "state"=target_case."state","version"=target_case."version",
    "provider_outcome"=target_case."provider_outcome","next_reconcile_at"=target_case."next_reconcile_at",
    "confirmed_observation_id"=target_case."confirmed_observation_id","confirmed_at"=target_case."confirmed_at",
    "confirmation_expires_at"=target_case."confirmation_expires_at","no_funds_at"=target_case."no_funds_at",
    "blocked_at"=target_case."blocked_at","lifecycle_txid"=target_case."lifecycle_txid","updated_at"=target_case."updated_at"
    WHERE "id"=case_record."id";
  UPDATE public."pos_manual_payment_attempts" SET "state"=CASE WHEN processing_result='retry_scheduled' THEN 'unknown' WHEN next_state IN ('confirmed_paid','no_funds') THEN 'succeeded' ELSE 'failed' END,
    "outcome_unknown"=processing_result='retry_scheduled',"finished_at"=now_at WHERE "id"=p_attempt_id;
  UPDATE public."pos_manual_payment_outbox" SET "state"='completed',"claim_token"=NULL,"claim_expires_at"=NULL,"completed_at"=now_at,
    "last_error_code"=CASE WHEN processing_result='retry_scheduled' THEN 'provider_outcome_unknown' WHEN processing_result='incident_opened' THEN 'provider_proof_incident' ELSE NULL END WHERE "id"=outbox_record."id";
  IF incident_code IS NOT NULL THEN INSERT INTO public."pos_manual_payment_incidents"("case_id","observation_id","provider_proof_id","code","expected_hash","reported_hash")
    VALUES(case_record."id",observation_record."id",p_proof_id,incident_code,case_record."request_hash",proof_record."canonical_event_hash"); END IF;
  IF processing_result='retry_scheduled' THEN
    next_attempt_sequence:=attempt_record."sequence"+1;
    INSERT INTO public."pos_manual_payment_attempts"("case_id","sequence","provider_idempotency_key","request_hash") VALUES(case_record."id",next_attempt_sequence,'manual-query:'||case_record."id"::text||':'||next_attempt_sequence,proof_record."canonical_event_hash");
    INSERT INTO public."pos_manual_payment_outbox"("attempt_id","next_attempt_at") SELECT "id",now_at+interval '30 seconds' FROM public."pos_manual_payment_attempts" WHERE "case_id"=case_record."id" AND "sequence"=next_attempt_sequence;
  END IF;
  RETURN pg_catalog.jsonb_build_object('deliveryResultId',delivery_record."id",'proofId',p_proof_id,'caseId',case_record."id",
    'resultingState',next_state,'resultingVersion',next_version,'processingResult',processing_result,'replayed',false);
END
$function$;

CREATE OR REPLACE FUNCTION public."pos_manual_report_transport_v1_t2_01_impl"(
  p_attempt_id uuid,p_claim_token text,p_kind text,p_idempotency_key text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog, public AS $function$
DECLARE
  now_at timestamptz; claim_hash text; evidence_hash text;
  prior_delivery public."pos_manual_payment_delivery_results"%ROWTYPE;
  attempt_record public."pos_manual_payment_attempts"%ROWTYPE;
  outbox_record public."pos_manual_payment_outbox"%ROWTYPE;
  case_record public."pos_manual_payment_cases"%ROWTYPE;
  target_case public."pos_manual_payment_cases"%ROWTYPE;
  delivery_record public."pos_manual_payment_delivery_results"%ROWTYPE;
  operation_record public."pos_manual_payment_operations"%ROWTYPE;
  event_record public."pos_manual_payment_state_events"%ROWTYPE;
  result_kind text; processing_result text; next_attempt_sequence integer; next_version integer;
  tx numeric:=pg_catalog.txid_current()::numeric;
BEGIN
  IF p_attempt_id IS NULL OR p_claim_token IS NULL OR pg_catalog.length(p_claim_token) NOT BETWEEN 20 AND 240
    OR p_claim_token !~ '^[A-Za-z0-9._:@/-]+$' OR p_kind NOT IN ('pre_dispatch_failure','outcome_unknown','protocol_rejected')
    OR p_idempotency_key IS NULL OR pg_catalog.length(p_idempotency_key) NOT BETWEEN 8 AND 160
  THEN RAISE EXCEPTION 'invalid closed transport report input' USING ERRCODE='22023'; END IF;
  claim_hash:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_claim_token,'UTF8')),'hex');
  evidence_hash:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_attempt_id::text||':'||p_kind||':'||p_idempotency_key,'UTF8')),'hex');
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('pos_manual_delivery_completion_v1'),pg_catalog.hashtext(p_idempotency_key));
  SELECT * INTO prior_delivery FROM public."pos_manual_payment_delivery_results" WHERE "completion_idempotency_key"=p_idempotency_key;
  IF FOUND THEN
    IF prior_delivery."attempt_id"<>p_attempt_id OR prior_delivery."claim_token_hash"<>claim_hash
      OR prior_delivery."result_kind"<>(CASE p_kind WHEN 'pre_dispatch_failure' THEN 'transport_pre_dispatch_failure' WHEN 'outcome_unknown' THEN 'transport_outcome_unknown' ELSE 'protocol_rejected' END)
    THEN RAISE EXCEPTION 'transport report idempotency conflict' USING ERRCODE='23505'; END IF;
    RETURN pg_catalog.jsonb_build_object('deliveryResultId',prior_delivery."id",'resultingState',prior_delivery."resulting_state",
      'resultingVersion',prior_delivery."resulting_version",'processingResult',prior_delivery."processing_result",'replayed',true);
  END IF;
  SELECT * INTO attempt_record FROM public."pos_manual_payment_attempts" WHERE "id"=p_attempt_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'manual query attempt not found' USING ERRCODE='23503'; END IF;
  case_record:=public."pos_manual_lock_case_graph_321e"(attempt_record."case_id");
  SELECT * INTO attempt_record FROM public."pos_manual_payment_attempts" WHERE "id"=p_attempt_id FOR UPDATE;
  SELECT * INTO outbox_record FROM public."pos_manual_payment_outbox" WHERE "attempt_id"=p_attempt_id FOR UPDATE;
  now_at:=pg_catalog.clock_timestamp();
  IF case_record."state"<>'unknown' OR attempt_record."state"<>'claimed' OR outbox_record."state"<>'claimed'
    OR outbox_record."claim_token"<>p_claim_token OR outbox_record."claim_expires_at"<=now_at
  THEN RAISE EXCEPTION 'transport report requires the exact live claimed delivery' USING ERRCODE='23514'; END IF;
  result_kind:=CASE p_kind WHEN 'pre_dispatch_failure' THEN 'transport_pre_dispatch_failure' WHEN 'outcome_unknown' THEN 'transport_outcome_unknown' ELSE 'protocol_rejected' END;
  processing_result:=CASE WHEN p_kind='protocol_rejected' OR attempt_record."sequence">=12 OR case_record."expires_at"<=now_at THEN 'terminal_blocked' ELSE 'retry_scheduled' END;
  next_version:=case_record."version"+CASE WHEN processing_result='terminal_blocked' THEN 1 ELSE 0 END;
  INSERT INTO public."pos_manual_payment_delivery_results"("attempt_id","delivery_number","claim_token_hash","response_hash","result_kind","outcome","evidence_hash","retryable","superseded","resulting_state","resulting_version","processing_result","completion_idempotency_key")
  VALUES(p_attempt_id,outbox_record."delivery_count",claim_hash,evidence_hash,result_kind,'unknown',evidence_hash,
    processing_result='retry_scheduled',processing_result='terminal_blocked',CASE WHEN processing_result='terminal_blocked' THEN 'blocked' ELSE case_record."state" END,
    next_version,processing_result,p_idempotency_key) RETURNING * INTO delivery_record;
  IF processing_result='terminal_blocked' THEN
    operation_record:=pg_catalog.jsonb_populate_record(NULL::public."pos_manual_payment_operations",pg_catalog.jsonb_build_object(
      'id',pg_catalog.nextval(pg_catalog.pg_get_serial_sequence('public.pos_manual_payment_operations','id')::pg_catalog.regclass),
      'case_id',case_record."id",'action','block','expected_version',case_record."version",'resulting_version',next_version,
      'resulting_state','blocked','idempotency_key','manual-transport-block:'||p_idempotency_key,'request_hash',evidence_hash,
      'write_txid',tx,'created_at',now_at));
    PERFORM public."pos_manual_t2_open_legacy_operation_root_v1"('legacy_manual:report_transport:operation','block',operation_record);
    INSERT INTO public."pos_manual_payment_operations" SELECT (operation_record).* RETURNING * INTO operation_record;
    event_record:=pg_catalog.jsonb_populate_record(NULL::public."pos_manual_payment_state_events",pg_catalog.jsonb_build_object(
      'id',pg_catalog.nextval(pg_catalog.pg_get_serial_sequence('public.pos_manual_payment_state_events','id')::pg_catalog.regclass),
      'case_id',case_record."id",'operation_id',operation_record."id",'from_state',case_record."state",'to_state','blocked',
      'resulting_version',next_version,'source','worker','source_id',p_attempt_id::text,'write_txid',tx,'created_at',now_at));
    PERFORM public."pos_manual_t2_open_legacy_state_event_root_v1"('legacy_manual:report_transport:state_event','block',event_record);
    INSERT INTO public."pos_manual_payment_state_events" SELECT (event_record).*;
    target_case:=case_record; target_case."state":='blocked'; target_case."version":=next_version;
    target_case."blocked_at":=now_at; target_case."next_reconcile_at":=NULL;
    target_case."lifecycle_txid":=tx; target_case."updated_at":=now_at;
    PERFORM public."pos_manual_t2_open_legacy_case_root_v1"('legacy_manual:report_transport:case','block','UPDATE',case_record,target_case);
    UPDATE public."pos_manual_payment_cases" SET "state"=target_case."state","version"=target_case."version",
      "blocked_at"=target_case."blocked_at","next_reconcile_at"=target_case."next_reconcile_at",
      "lifecycle_txid"=target_case."lifecycle_txid","updated_at"=target_case."updated_at" WHERE "id"=case_record."id";
    UPDATE public."pos_manual_payment_attempts" SET "state"='failed',"outcome_unknown"=p_kind='outcome_unknown',"finished_at"=now_at WHERE "id"=p_attempt_id;
    UPDATE public."pos_manual_payment_outbox" SET "state"='dead',"claim_token"=NULL,"claim_expires_at"=NULL,"completed_at"=now_at,"last_error_code"=p_kind WHERE "id"=outbox_record."id";
    INSERT INTO public."pos_manual_payment_incidents"("case_id","code","expected_hash","reported_hash")
      VALUES(case_record."id",CASE WHEN p_kind='protocol_rejected' THEN 'provider_protocol_rejected' ELSE 'transport_retry_exhausted' END,case_record."request_hash",evidence_hash);
  ELSIF p_kind='pre_dispatch_failure' THEN
    UPDATE public."pos_manual_payment_attempts" SET "state"='queued',"finished_at"=NULL WHERE "id"=p_attempt_id;
    UPDATE public."pos_manual_payment_outbox" SET "state"='retry',"claim_token"=NULL,"claim_expires_at"=NULL,"next_attempt_at"=now_at+interval '30 seconds',"last_error_code"=p_kind WHERE "id"=outbox_record."id";
  ELSE
    UPDATE public."pos_manual_payment_attempts" SET "state"='unknown',"outcome_unknown"=true,"finished_at"=now_at WHERE "id"=p_attempt_id;
    UPDATE public."pos_manual_payment_outbox" SET "state"='completed',"claim_token"=NULL,"claim_expires_at"=NULL,"completed_at"=now_at,"last_error_code"=p_kind WHERE "id"=outbox_record."id";
    next_attempt_sequence:=attempt_record."sequence"+1;
    INSERT INTO public."pos_manual_payment_attempts"("case_id","sequence","provider_idempotency_key","request_hash") VALUES(case_record."id",next_attempt_sequence,'manual-query:'||case_record."id"::text||':'||next_attempt_sequence,evidence_hash);
    INSERT INTO public."pos_manual_payment_outbox"("attempt_id","next_attempt_at") SELECT "id",now_at+interval '30 seconds' FROM public."pos_manual_payment_attempts" WHERE "case_id"=case_record."id" AND "sequence"=next_attempt_sequence;
    target_case:=case_record; target_case."next_reconcile_at":=now_at+interval '30 seconds';
    PERFORM public."pos_manual_t2_open_legacy_case_root_v1"('legacy_manual:report_transport:case_evidence','evidence_update','UPDATE',case_record,target_case);
    UPDATE public."pos_manual_payment_cases" SET "next_reconcile_at"=target_case."next_reconcile_at" WHERE "id"=case_record."id";
  END IF;
  RETURN pg_catalog.jsonb_build_object('deliveryResultId',delivery_record."id",'caseId',case_record."id",
    'resultingState',delivery_record."resulting_state",'resultingVersion',delivery_record."resulting_version",
    'processingResult',processing_result,'replayed',false);
END
$function$;



-- Explicit static legacy producer bodies; no runtime source rewriting.
CREATE OR REPLACE FUNCTION public."pos_manual_review_case_v1_t2_01_impl"(
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
  event_record public."pos_manual_payment_state_events"%ROWTYPE;
  target_case public."pos_manual_payment_cases"%ROWTYPE;
  tx NUMERIC := pg_catalog.txid_current()::numeric;
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

  operation_record:=pg_catalog.jsonb_populate_record(NULL::public."pos_manual_payment_operations",pg_catalog.jsonb_build_object(
    'id',pg_catalog.nextval(pg_catalog.pg_get_serial_sequence('public.pos_manual_payment_operations','id')::pg_catalog.regclass),
    'case_id',p_case_id,'action',p_decision,'expected_version',p_expected_version,'resulting_version',next_version,
    'resulting_state',next_state,'actor_profile_id',p_checker_profile_id,'idempotency_key',operation_key,
    'request_hash',p_request_hash,'review_id',review_record."id",'write_txid',tx,'created_at',evaluation_time));
  PERFORM public."pos_manual_t2_open_legacy_operation_root_v1"('legacy_manual:review:operation',p_decision,operation_record);
  INSERT INTO public."pos_manual_payment_operations" SELECT (operation_record).* RETURNING * INTO operation_record;

  event_record:=pg_catalog.jsonb_populate_record(NULL::public."pos_manual_payment_state_events",pg_catalog.jsonb_build_object(
    'id',pg_catalog.nextval(pg_catalog.pg_get_serial_sequence('public.pos_manual_payment_state_events','id')::pg_catalog.regclass),
    'case_id',p_case_id,'operation_id',operation_record."id",'from_state',case_record."state",'to_state',next_state,
    'resulting_version',next_version,'source','api','source_id',review_record."id"::text,'write_txid',tx,'created_at',evaluation_time));
  PERFORM public."pos_manual_t2_open_legacy_state_event_root_v1"('legacy_manual:review:state_event',p_decision,event_record);
  INSERT INTO public."pos_manual_payment_state_events" SELECT (event_record).*;

  target_case:=case_record;
  target_case."state":=next_state; target_case."version":=next_version; target_case."reviewed_at":=evaluation_time;
  IF next_state='rejected' THEN target_case."rejected_at":=evaluation_time; END IF;
  IF next_state='unknown' THEN target_case."provider_outcome":='unknown'; target_case."unknown_since":=evaluation_time;
    target_case."next_reconcile_at":=evaluation_time; END IF;
  target_case."lifecycle_txid":=tx; target_case."updated_at":=evaluation_time;
  PERFORM public."pos_manual_t2_open_legacy_case_root_v1"('legacy_manual:review:case',p_decision,'UPDATE',case_record,target_case);
  UPDATE public."pos_manual_payment_cases" SET "state"=target_case."state","version"=target_case."version",
    "reviewed_at"=target_case."reviewed_at","rejected_at"=target_case."rejected_at",
    "provider_outcome"=target_case."provider_outcome","unknown_since"=target_case."unknown_since",
    "next_reconcile_at"=target_case."next_reconcile_at","lifecycle_txid"=target_case."lifecycle_txid",
    "updated_at"=target_case."updated_at" WHERE "id"=p_case_id;

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

CREATE OR REPLACE FUNCTION public."pos_manual_record_callback_v1_t2_01_impl"(
  p_provider TEXT, p_event_id TEXT, p_nonce_hash TEXT, p_payload_hash TEXT,
  p_signature_hash TEXT, p_canonical_event_hash TEXT, p_evidence_hash TEXT,
  p_auth_key_id TEXT, p_event_timestamp TIMESTAMPTZ, p_outcome TEXT,
  p_reference_hash TEXT, p_method TEXT, p_amount_cents INTEGER, p_currency TEXT,
  p_provider_sequence BIGINT, p_provider_occurred_at TIMESTAMPTZ,
  p_credential_revision INTEGER, p_verifier_version TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  now_at TIMESTAMPTZ := pg_catalog.clock_timestamp();
  exact_proof public."pos_manual_payment_provider_proofs"%ROWTYPE;
  event_proof public."pos_manual_payment_provider_proofs"%ROWTYPE;
  nonce_proof public."pos_manual_payment_provider_proofs"%ROWTYPE;
  proof_record public."pos_manual_payment_provider_proofs"%ROWTYPE;
  case_record public."pos_manual_payment_cases"%ROWTYPE;
  callback_record public."pos_manual_payment_callbacks"%ROWTYPE;
  observation_record public."pos_manual_payment_observations"%ROWTYPE;
  operation_record public."pos_manual_payment_operations"%ROWTYPE;
  event_record public."pos_manual_payment_state_events"%ROWTYPE;
  target_case public."pos_manual_payment_cases"%ROWTYPE;
  tx NUMERIC := pg_catalog.txid_current()::numeric;
  prior_max_sequence BIGINT;
  prior_max_occurred_at TIMESTAMPTZ;
  boundary_failure TEXT;
  processing_result TEXT;
  incident_code TEXT;
  next_state TEXT;
  next_version INTEGER;
  next_attempt_sequence INTEGER;
  nonce_is_owner BOOLEAN;
BEGIN
  IF p_provider IS NULL OR p_provider !~ '^[a-z][a-z0-9._:-]{1,79}$'
    OR p_event_id IS NULL OR p_event_id !~ '^evt:[0-9a-f]{64}$'
    OR p_nonce_hash !~ '^[0-9a-f]{64}$' OR p_payload_hash !~ '^[0-9a-f]{64}$'
    OR p_signature_hash !~ '^[0-9a-f]{64}$' OR p_canonical_event_hash !~ '^[0-9a-f]{64}$'
    OR p_evidence_hash !~ '^[0-9a-f]{64}$'
    OR p_auth_key_id !~ '^[A-Za-z][A-Za-z0-9._:-]{2,79}$'
    OR p_event_timestamp IS NULL OR abs(extract(epoch FROM (now_at-p_event_timestamp))) > 300
    OR p_outcome NOT IN ('confirmed_paid','not_found','voided','refunded','unknown')
    OR p_reference_hash !~ '^hmac-sha256:v[0-9]+:[0-9a-f]{64}$'
    OR p_method !~ '^[a-z][a-z0-9._:-]{1,39}$' OR p_amount_cents IS NULL OR p_amount_cents<=0
    OR p_currency IS DISTINCT FROM 'BRL' OR p_provider_sequence IS NULL OR p_provider_sequence<=0
    OR p_provider_occurred_at IS NULL OR p_credential_revision IS NULL OR p_credential_revision<0
    OR p_verifier_version IS NULL OR p_verifier_version !~ '^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,79}$'
  THEN RAISE EXCEPTION 'invalid authenticated callback envelope' USING ERRCODE='22023'; END IF;

  SELECT * INTO exact_proof FROM public."pos_manual_payment_provider_proofs"
   WHERE "provider"=p_provider AND "payload_hash"=p_payload_hash AND "signature_hash"=p_signature_hash;
  IF FOUND THEN
    RETURN pg_catalog.jsonb_build_object('proofId',exact_proof."id",'caseId',exact_proof."case_id",
      'disposition',exact_proof."disposition",'duplicate',true,'quarantined',exact_proof."disposition" NOT IN ('accepted','replay'));
  END IF;

  SELECT * INTO case_record FROM public."pos_manual_payment_cases"
   WHERE "provider"=p_provider AND "reference_hash"=p_reference_hash;
  IF FOUND THEN case_record := public."pos_manual_lock_case_graph_321e"(case_record."id"); END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('pos_manual_event_321e'),pg_catalog.hashtext(p_provider||':'||p_event_id));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('pos_manual_nonce_321e'),pg_catalog.hashtext(p_provider||':'||p_nonce_hash));

  SELECT * INTO exact_proof FROM public."pos_manual_payment_provider_proofs"
   WHERE "provider"=p_provider AND "payload_hash"=p_payload_hash AND "signature_hash"=p_signature_hash;
  IF FOUND THEN
    RETURN pg_catalog.jsonb_build_object('proofId',exact_proof."id",'caseId',exact_proof."case_id",
      'disposition',exact_proof."disposition",'duplicate',true,'quarantined',exact_proof."disposition" NOT IN ('accepted','replay'));
  END IF;
  SELECT * INTO event_proof FROM public."pos_manual_payment_provider_proofs"
   WHERE "provider"=p_provider AND "event_id"=p_event_id AND "event_owner" FOR UPDATE;
  SELECT * INTO nonce_proof FROM public."pos_manual_payment_provider_proofs"
   WHERE "provider"=p_provider AND "nonce_hash"=p_nonce_hash AND "nonce_owner" FOR UPDATE;
  now_at := pg_catalog.clock_timestamp();
  IF abs(extract(epoch FROM (now_at-p_event_timestamp)))>300 THEN
    RAISE EXCEPTION 'authenticated callback expired while waiting for canonical locks' USING ERRCODE='23514';
  END IF;

  IF event_proof."id" IS NOT NULL AND event_proof."payload_hash"=p_payload_hash
     AND event_proof."canonical_event_hash"=p_canonical_event_hash
     AND (nonce_proof."id" IS NULL OR (nonce_proof."event_id"=p_event_id
       AND nonce_proof."canonical_event_hash"=p_canonical_event_hash)) THEN
    INSERT INTO public."pos_manual_payment_provider_proofs" (
      "source_kind","case_id","provider","event_id","nonce_hash","payload_hash","signature_hash",
      "canonical_event_hash","evidence_hash","auth_key_id","event_timestamp","provider_sequence",
      "provider_occurred_at","outcome","reference_hash","method","amount_cents","currency",
      "credential_revision","verifier_version","disposition","event_owner","nonce_owner",
      "replay_of_proof_id","caller_role"
    ) VALUES ('callback',event_proof."case_id",p_provider,p_event_id,p_nonce_hash,p_payload_hash,p_signature_hash,
      p_canonical_event_hash,p_evidence_hash,p_auth_key_id,p_event_timestamp,p_provider_sequence,
      p_provider_occurred_at,p_outcome,p_reference_hash,p_method,p_amount_cents,p_currency,
      p_credential_revision,p_verifier_version,'replay',false,nonce_proof."id" IS NULL,event_proof."id",session_user)
    RETURNING * INTO proof_record;
    RETURN pg_catalog.jsonb_build_object('proofId',event_proof."id",'deliveryProofId',proof_record."id",
      'caseId',event_proof."case_id",'disposition','replay','duplicate',true,'quarantined',false);
  END IF;

  IF event_proof."id" IS NOT NULL AND (event_proof."payload_hash"<>p_payload_hash
     OR event_proof."canonical_event_hash"<>p_canonical_event_hash) THEN
    nonce_is_owner := nonce_proof."id" IS NULL;
    INSERT INTO public."pos_manual_payment_provider_proofs" (
      "source_kind","case_id","provider","event_id","nonce_hash","payload_hash","signature_hash",
      "canonical_event_hash","evidence_hash","auth_key_id","event_timestamp","provider_sequence",
      "provider_occurred_at","outcome","reference_hash","method","amount_cents","currency",
      "credential_revision","verifier_version","disposition","event_owner","nonce_owner","caller_role"
    ) VALUES ('callback',COALESCE(case_record."id",event_proof."case_id"),p_provider,p_event_id,p_nonce_hash,p_payload_hash,p_signature_hash,
      p_canonical_event_hash,p_evidence_hash,p_auth_key_id,p_event_timestamp,p_provider_sequence,
      p_provider_occurred_at,p_outcome,p_reference_hash,p_method,p_amount_cents,p_currency,
      p_credential_revision,p_verifier_version,'event_conflict',false,nonce_is_owner,session_user)
    RETURNING * INTO proof_record;
    INSERT INTO public."pos_manual_payment_incidents"("case_id","provider_proof_id","code","expected_hash","reported_hash")
    VALUES (COALESCE(event_proof."case_id",case_record."id"),proof_record."id",'event_id_payload_conflict',event_proof."canonical_event_hash",p_canonical_event_hash);
    RETURN pg_catalog.jsonb_build_object('proofId',proof_record."id",'caseId',proof_record."case_id",
      'disposition','event_conflict','duplicate',false,'quarantined',true);
  END IF;

  IF nonce_proof."id" IS NOT NULL THEN
    INSERT INTO public."pos_manual_payment_provider_proofs" (
      "source_kind","case_id","provider","event_id","nonce_hash","payload_hash","signature_hash",
      "canonical_event_hash","evidence_hash","auth_key_id","event_timestamp","provider_sequence",
      "provider_occurred_at","outcome","reference_hash","method","amount_cents","currency",
      "credential_revision","verifier_version","disposition","event_owner","nonce_owner","caller_role"
    ) VALUES ('callback',case_record."id",p_provider,p_event_id,p_nonce_hash,p_payload_hash,p_signature_hash,
      p_canonical_event_hash,p_evidence_hash,p_auth_key_id,p_event_timestamp,p_provider_sequence,
      p_provider_occurred_at,p_outcome,p_reference_hash,p_method,p_amount_cents,p_currency,
      p_credential_revision,p_verifier_version,'nonce_conflict',true,false,session_user)
    RETURNING * INTO proof_record;
    INSERT INTO public."pos_manual_payment_incidents"("case_id","provider_proof_id","code","expected_hash","reported_hash")
    VALUES (case_record."id",proof_record."id",'callback_nonce_reuse',nonce_proof."canonical_event_hash",p_canonical_event_hash);
    RETURN pg_catalog.jsonb_build_object('proofId',proof_record."id",'caseId',proof_record."case_id",
      'disposition','nonce_conflict','duplicate',false,'quarantined',true);
  END IF;

  IF case_record."id" IS NULL THEN
    INSERT INTO public."pos_manual_payment_provider_proofs" (
      "source_kind","provider","event_id","nonce_hash","payload_hash","signature_hash","canonical_event_hash",
      "evidence_hash","auth_key_id","event_timestamp","provider_sequence","provider_occurred_at","outcome",
      "reference_hash","method","amount_cents","currency","credential_revision","verifier_version",
      "disposition","event_owner","nonce_owner","caller_role"
    ) VALUES ('callback',p_provider,p_event_id,p_nonce_hash,p_payload_hash,p_signature_hash,p_canonical_event_hash,
      p_evidence_hash,p_auth_key_id,p_event_timestamp,p_provider_sequence,p_provider_occurred_at,p_outcome,
      p_reference_hash,p_method,p_amount_cents,p_currency,p_credential_revision,p_verifier_version,
      'orphan_reference',true,true,session_user) RETURNING * INTO proof_record;
    INSERT INTO public."pos_manual_payment_incidents"("case_id","provider_proof_id","code","expected_hash","reported_hash")
    VALUES (NULL,proof_record."id",'orphan_authenticated_callback',
      pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_reference_hash,'UTF8')),'hex'),p_canonical_event_hash);
    RETURN pg_catalog.jsonb_build_object('proofId',proof_record."id",'caseId',NULL,
      'disposition','orphan_reference','duplicate',false,'quarantined',true);
  END IF;

  boundary_failure := public."pos_manual_boundary_failure_321e"(case_record."id",p_auth_key_id,p_credential_revision,now_at);
  IF boundary_failure IS NOT NULL
     OR ROW(case_record."provider",case_record."reference_hash",case_record."method",case_record."amount_cents",case_record."currency")
       IS DISTINCT FROM ROW(p_provider,p_reference_hash,p_method,p_amount_cents,p_currency) THEN
    INSERT INTO public."pos_manual_payment_provider_proofs" (
      "source_kind","case_id","provider","event_id","nonce_hash","payload_hash","signature_hash",
      "canonical_event_hash","evidence_hash","auth_key_id","event_timestamp","provider_sequence",
      "provider_occurred_at","outcome","reference_hash","method","amount_cents","currency",
      "credential_revision","verifier_version","disposition","event_owner","nonce_owner","caller_role"
    ) VALUES ('callback',case_record."id",p_provider,p_event_id,p_nonce_hash,p_payload_hash,p_signature_hash,
      p_canonical_event_hash,p_evidence_hash,p_auth_key_id,p_event_timestamp,p_provider_sequence,
      p_provider_occurred_at,p_outcome,p_reference_hash,p_method,p_amount_cents,p_currency,
      p_credential_revision,p_verifier_version,'context_mismatch',true,true,session_user)
    RETURNING * INTO proof_record;
    INSERT INTO public."pos_manual_payment_incidents"("case_id","provider_proof_id","code","expected_hash","reported_hash")
    VALUES (case_record."id",proof_record."id",COALESCE(boundary_failure,'callback_context_mismatch'),case_record."request_hash",p_canonical_event_hash);
    RETURN pg_catalog.jsonb_build_object('proofId',proof_record."id",'caseId',case_record."id",
      'disposition','context_mismatch','duplicate',false,'quarantined',true);
  END IF;

  INSERT INTO public."pos_manual_payment_provider_proofs" (
    "source_kind","case_id","provider","event_id","nonce_hash","payload_hash","signature_hash",
    "canonical_event_hash","evidence_hash","auth_key_id","event_timestamp","provider_sequence",
    "provider_occurred_at","outcome","reference_hash","method","amount_cents","currency",
    "credential_revision","verifier_version","disposition","event_owner","nonce_owner","caller_role"
  ) VALUES ('callback',case_record."id",p_provider,p_event_id,p_nonce_hash,p_payload_hash,p_signature_hash,
    p_canonical_event_hash,p_evidence_hash,p_auth_key_id,p_event_timestamp,p_provider_sequence,
    p_provider_occurred_at,p_outcome,p_reference_hash,p_method,p_amount_cents,p_currency,
    p_credential_revision,p_verifier_version,'accepted',true,true,session_user)
  RETURNING * INTO proof_record;

  SELECT max("provider_sequence"),max("provider_occurred_at") INTO prior_max_sequence,prior_max_occurred_at
    FROM public."pos_manual_payment_provider_proofs"
   WHERE "case_id"=case_record."id" AND "id"<>proof_record."id" AND "disposition"='accepted';
  SELECT COALESCE(max("sequence"),0)+1 INTO next_attempt_sequence
    FROM public."pos_manual_payment_attempts" WHERE "case_id"=case_record."id";
  next_state := case_record."state";
  processing_result := 'applied_no_change';
  IF p_provider_occurred_at < case_record."occurred_at"-interval '5 minutes'
     OR p_provider_occurred_at > LEAST(now_at,case_record."expires_at")
     OR (prior_max_sequence IS NOT NULL AND p_provider_sequence<=prior_max_sequence)
     OR (prior_max_occurred_at IS NOT NULL AND p_provider_occurred_at<prior_max_occurred_at) THEN
    incident_code := 'callback_causality_or_sequence_conflict';
  ELSIF case_record."state"='unknown' AND case_record."expires_at">now_at THEN
    IF p_outcome='confirmed_paid' THEN next_state:='confirmed_paid'; processing_result:='applied_transition';
    ELSIF p_outcome IN ('not_found','voided') THEN next_state:='no_funds'; processing_result:='applied_transition';
    ELSIF p_outcome='unknown' AND next_attempt_sequence<=12 THEN next_state:='unknown'; processing_result:='retry_scheduled';
    ELSIF p_outcome='unknown' THEN next_state:='blocked'; processing_result:='incident_opened'; incident_code:='provider_unknown_retry_exhausted';
    ELSE next_state:='blocked'; processing_result:='incident_opened'; incident_code:='provider_reported_refund'; END IF;
  ELSIF case_record."provider_outcome" IS NOT DISTINCT FROM p_outcome THEN
    processing_result := 'applied_no_change';
  ELSE
    incident_code := CASE WHEN case_record."expires_at"<=now_at THEN 'late_provider_fact' ELSE 'terminal_state_provider_conflict' END;
  END IF;
  IF incident_code IS NOT NULL THEN
    processing_result := 'incident_opened';
    IF case_record."state" IN ('unknown','confirmed_paid','application_pending','rejected','no_funds','expired') THEN next_state:='blocked'; END IF;
  END IF;
  next_version := case_record."version"+1;

  INSERT INTO public."pos_manual_payment_callbacks" (
    "case_id","provider","event_key","key_id","payload_hash","signature_hash","outcome","reference_hash",
    "method","amount_cents","currency","provider_sequence","provider_occurred_at","auth_key_id",
    "processing_result","resulting_state","resulting_version","ingress_proof_id","canonical_event_hash",
    "nonce_hash","evidence_hash","event_timestamp","credential_revision","verifier_version"
  ) VALUES (case_record."id",p_provider,p_event_id,p_auth_key_id,p_payload_hash,p_signature_hash,p_outcome,p_reference_hash,
    p_method,p_amount_cents,p_currency,p_provider_sequence,p_provider_occurred_at,p_auth_key_id,
    processing_result,next_state,next_version,proof_record."id",p_canonical_event_hash,p_nonce_hash,p_evidence_hash,
    p_event_timestamp,p_credential_revision,p_verifier_version) RETURNING * INTO callback_record;
  INSERT INTO public."pos_manual_payment_observations" (
    "case_id","callback_id","source","outcome","reference_hash","method","amount_cents","currency",
    "provider_sequence","provider_occurred_at","auth_key_id","processing_result","evidence_hash",
    "resulting_state","resulting_version","write_txid"
  ) VALUES (case_record."id",callback_record."id",'callback',p_outcome,p_reference_hash,p_method,p_amount_cents,p_currency,
    p_provider_sequence,p_provider_occurred_at,p_auth_key_id,processing_result,p_evidence_hash,next_state,next_version,
    pg_catalog.txid_current()::numeric) RETURNING * INTO observation_record;
  operation_record:=pg_catalog.jsonb_populate_record(NULL::public."pos_manual_payment_operations",pg_catalog.jsonb_build_object(
    'id',pg_catalog.nextval(pg_catalog.pg_get_serial_sequence('public.pos_manual_payment_operations','id')::pg_catalog.regclass),
    'case_id',case_record."id",'action','observe','expected_version',case_record."version",'resulting_version',next_version,
    'resulting_state',next_state,'observation_id',observation_record."id",'idempotency_key','manual-callback:'||p_provider||':'||p_event_id,
    'request_hash',p_canonical_event_hash,'write_txid',tx,'created_at',now_at));
  PERFORM public."pos_manual_t2_open_legacy_operation_root_v1"('legacy_manual:record_callback:operation','observe',operation_record);
  INSERT INTO public."pos_manual_payment_operations" SELECT (operation_record).* RETURNING * INTO operation_record;
  event_record:=pg_catalog.jsonb_populate_record(NULL::public."pos_manual_payment_state_events",pg_catalog.jsonb_build_object(
    'id',pg_catalog.nextval(pg_catalog.pg_get_serial_sequence('public.pos_manual_payment_state_events','id')::pg_catalog.regclass),
    'case_id',case_record."id",'operation_id',operation_record."id",'from_state',case_record."state",'to_state',next_state,
    'resulting_version',next_version,'source','callback','source_id',p_event_id,'write_txid',tx,'created_at',now_at));
  PERFORM public."pos_manual_t2_open_legacy_state_event_root_v1"('legacy_manual:record_callback:state_event','observe',event_record);
  INSERT INTO public."pos_manual_payment_state_events" SELECT (event_record).*;
  target_case:=case_record; target_case."state":=next_state; target_case."version":=next_version;
  target_case."provider_outcome":=CASE WHEN incident_code IS NULL THEN p_outcome ELSE case_record."provider_outcome" END;
  target_case."next_reconcile_at":=CASE WHEN processing_result='retry_scheduled' THEN now_at+interval '30 seconds' ELSE NULL END;
  IF next_state='confirmed_paid' AND case_record."state"<>'confirmed_paid' THEN
    target_case."confirmed_observation_id":=observation_record."id"; target_case."confirmed_at":=now_at;
    target_case."confirmation_expires_at":=LEAST(now_at+interval '5 minutes',target_case."expires_at"); END IF;
  IF next_state='no_funds' AND case_record."state"<>'no_funds' THEN target_case."no_funds_at":=now_at; END IF;
  IF next_state='blocked' AND case_record."state"<>'blocked' THEN target_case."blocked_at":=now_at; END IF;
  target_case."lifecycle_txid":=tx; target_case."updated_at":=now_at;
  PERFORM public."pos_manual_t2_open_legacy_case_root_v1"('legacy_manual:record_callback:case','observe','UPDATE',case_record,target_case);
  UPDATE public."pos_manual_payment_cases" SET "state"=target_case."state","version"=target_case."version",
    "provider_outcome"=target_case."provider_outcome","next_reconcile_at"=target_case."next_reconcile_at",
    "confirmed_observation_id"=target_case."confirmed_observation_id","confirmed_at"=target_case."confirmed_at",
    "confirmation_expires_at"=target_case."confirmation_expires_at","no_funds_at"=target_case."no_funds_at",
    "blocked_at"=target_case."blocked_at","lifecycle_txid"=target_case."lifecycle_txid",
    "updated_at"=target_case."updated_at" WHERE "id"=case_record."id";
  IF incident_code IS NOT NULL THEN
    INSERT INTO public."pos_manual_payment_incidents"("case_id","callback_id","observation_id","provider_proof_id","code","expected_hash","reported_hash")
    VALUES (case_record."id",callback_record."id",observation_record."id",proof_record."id",incident_code,case_record."request_hash",p_canonical_event_hash);
  END IF;
  IF next_state<>'unknown' THEN
    UPDATE public."pos_manual_payment_attempts" SET "state"=CASE WHEN next_state IN ('confirmed_paid','no_funds') THEN 'succeeded' ELSE 'failed' END,
      "finished_at"=now_at WHERE "case_id"=case_record."id" AND "state" IN ('queued','claimed','unknown');
    UPDATE public."pos_manual_payment_outbox" outbox SET "state"=CASE WHEN next_state IN ('confirmed_paid','no_funds') THEN 'completed' ELSE 'dead' END,
      "claim_token"=NULL,"claim_expires_at"=NULL,"completed_at"=now_at,
      "last_error_code"=CASE WHEN next_state='blocked' THEN 'callback_incident' ELSE NULL END
     FROM public."pos_manual_payment_attempts" attempt
     WHERE attempt."id"=outbox."attempt_id" AND attempt."case_id"=case_record."id" AND outbox."state" IN ('pending','retry','claimed');
  ELSIF processing_result='retry_scheduled' THEN
    UPDATE public."pos_manual_payment_attempts" SET "state"='unknown',"outcome_unknown"=true,"finished_at"=now_at
     WHERE "case_id"=case_record."id" AND "state" IN ('queued','claimed');
    UPDATE public."pos_manual_payment_outbox" outbox SET "state"='completed',"claim_token"=NULL,"claim_expires_at"=NULL,
      "completed_at"=now_at,"last_error_code"='provider_outcome_unknown'
     FROM public."pos_manual_payment_attempts" attempt
     WHERE attempt."id"=outbox."attempt_id" AND attempt."case_id"=case_record."id" AND outbox."state" IN ('pending','retry','claimed');
    SELECT COALESCE(max("sequence"),0)+1 INTO next_attempt_sequence FROM public."pos_manual_payment_attempts" WHERE "case_id"=case_record."id";
    IF next_attempt_sequence<=12 AND case_record."expires_at">now_at THEN
      INSERT INTO public."pos_manual_payment_attempts"("case_id","sequence","provider_idempotency_key","request_hash")
      VALUES (case_record."id",next_attempt_sequence,'manual-query:'||case_record."id"::text||':'||next_attempt_sequence,p_canonical_event_hash);
      INSERT INTO public."pos_manual_payment_outbox"("attempt_id","next_attempt_at")
      SELECT "id",now_at+interval '30 seconds' FROM public."pos_manual_payment_attempts"
       WHERE "case_id"=case_record."id" AND "sequence"=next_attempt_sequence;
    END IF;
  END IF;
  RETURN pg_catalog.jsonb_build_object('proofId',proof_record."id",'callbackId',callback_record."id",
    'caseId',case_record."id",'resultingState',next_state,'resultingVersion',next_version,
    'disposition','accepted','duplicate',false,'quarantined',incident_code IS NOT NULL);
END; $$;

CREATE OR REPLACE FUNCTION public."pos_manual_claim_queries_v1_t2_01_impl"(
  p_worker_id TEXT, p_limit INTEGER, p_lease_seconds INTEGER, p_request_idempotency_key TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  candidate RECORD;
  case_record public."pos_manual_payment_cases"%ROWTYPE;
  attempt_record public."pos_manual_payment_attempts"%ROWTYPE;
  outbox_record public."pos_manual_payment_outbox"%ROWTYPE;
  gate_record public."pos_manual_payment_reconciliation_gates"%ROWTYPE;
  credential_record public."integration_credentials"%ROWTYPE;
  vault_record public."pos_manual_payment_vault_bindings"%ROWTYPE;
  receipt_record public."pos_manual_payment_claim_receipts"%ROWTYPE;
  operation_record public."pos_manual_payment_operations"%ROWTYPE;
  event_record public."pos_manual_payment_state_events"%ROWTYPE;
  target_case public."pos_manual_payment_cases"%ROWTYPE;
  tx NUMERIC := pg_catalog.txid_current()::numeric;
  prior_batch public."pos_manual_payment_claim_batches"%ROWTYPE;
  batch_id UUID := pg_catalog.gen_random_uuid();
  now_at TIMESTAMPTZ;
  lease_token TEXT;
  lease_token_digest TEXT;
  worker_id_hash TEXT;
  request_key_digest TEXT;
  request_digest TEXT;
  auth_key_id TEXT;
  boundary_failure TEXT;
  block_reason TEXT;
  block_hash TEXT;
  expired_claim BOOLEAN;
  due_queued BOOLEAN;
  next_version INTEGER;
  candidate_limit INTEGER;
  claimed_count INTEGER := 0;
  blocked_count INTEGER := 0;
  remaining_due INTEGER := 0;
  replay_live_count INTEGER := 0;
  replay_expired BOOLEAN := false;
  commands JSONB := '[]'::jsonb;
BEGIN
  IF p_worker_id IS NULL OR p_worker_id !~ '^[A-Za-z][A-Za-z0-9._:-]{2,79}$'
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50
    OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 15 AND 300
    OR p_request_idempotency_key IS NULL OR p_request_idempotency_key !~ '^[A-Za-z][A-Za-z0-9._:-]{7,159}$'
  THEN RAISE EXCEPTION 'invalid closed manual claim input' USING ERRCODE='22023'; END IF;

  worker_id_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_worker_id,'UTF8')),'hex');
  request_key_digest := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_request_idempotency_key,'UTF8')),'hex');
  request_digest := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    worker_id_hash||':'||p_limit::text||':'||p_lease_seconds::text,'UTF8')),'hex');
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('pos_manual_claim_queries_v1'),pg_catalog.hashtext(request_key_digest));
  SELECT * INTO prior_batch FROM public."pos_manual_payment_claim_batches" batch WHERE batch."request_key_hash"=request_key_digest;
  IF FOUND THEN
    IF prior_batch."request_hash" IS DISTINCT FROM request_digest THEN
      RAISE EXCEPTION 'manual claim idempotency key conflicts with different parameters' USING ERRCODE='23505';
    END IF;
    commands := '[]'::jsonb;
    FOR candidate IN SELECT receipt."id" AS receipt_id,receipt."batch_index",receipt."claim_token_hash",
      receipt."claim_expires_at" AS receipt_expires_at,attempt."id" AS attempt_id,attempt."case_id",outbox."id" AS outbox_id
      FROM public."pos_manual_payment_claim_receipts" receipt
      JOIN public."pos_manual_payment_attempts" attempt ON attempt."id"=receipt."attempt_id"
      JOIN public."pos_manual_payment_outbox" outbox ON outbox."attempt_id"=attempt."id"
      WHERE receipt."batch_id"=prior_batch."id" ORDER BY receipt."batch_index"
    LOOP
      case_record := public."pos_manual_lock_case_graph_321e"(candidate.case_id);
      SELECT * INTO attempt_record FROM public."pos_manual_payment_attempts" WHERE "id"=candidate.attempt_id FOR UPDATE;
      SELECT * INTO outbox_record FROM public."pos_manual_payment_outbox" WHERE "id"=candidate.outbox_id FOR UPDATE;
      now_at := pg_catalog.clock_timestamp();
      IF attempt_record."state"<>'claimed' OR outbox_record."state"<>'claimed'
        OR outbox_record."claim_token" IS NULL OR outbox_record."claim_expires_at"<=now_at
        OR outbox_record."claim_expires_at" IS DISTINCT FROM candidate.receipt_expires_at
        OR pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(outbox_record."claim_token",'UTF8')),'hex')
          IS DISTINCT FROM candidate.claim_token_hash THEN
        replay_expired := true;
        CONTINUE;
      END IF;
      SELECT * INTO credential_record FROM public."integration_credentials" WHERE "id"=case_record."credential_ref";
      SELECT * INTO gate_record FROM public."pos_manual_payment_reconciliation_gates" WHERE "connector_id"=case_record."connector_id";
      SELECT * INTO vault_record FROM public."pos_manual_payment_vault_bindings" WHERE "case_id"=case_record."id";
      auth_key_id := NULL;
      IF pg_catalog.jsonb_typeof(credential_record."config"->'manualReconciliation'->'callbackAuthKeyIds')='array' THEN
        SELECT value INTO auth_key_id FROM pg_catalog.jsonb_array_elements_text(
          credential_record."config"->'manualReconciliation'->'callbackAuthKeyIds') value ORDER BY value LIMIT 1;
      END IF;
      boundary_failure := CASE WHEN auth_key_id IS NULL THEN 'manual_boundary_changed'
        ELSE public."pos_manual_boundary_failure_321e"(case_record."id",auth_key_id,case_record."credential_revision",now_at) END;
      IF boundary_failure IS NOT NULL THEN
        RAISE EXCEPTION 'manual claim replay authority changed' USING ERRCODE='23514';
      END IF;
      commands := commands||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'claimReceiptId',candidate.receipt_id,'attemptId',attempt_record."id",'attemptSequence',attempt_record."sequence",
        'deliveryNumber',outbox_record."delivery_count",'providerIdempotencyKey',attempt_record."provider_idempotency_key",
        'claimToken',outbox_record."claim_token",'claimExpiresAt',outbox_record."claim_expires_at",'caseId',case_record."id",
        'provider',case_record."provider",'method',case_record."method",'amountCents',case_record."amount_cents",
        'currency',case_record."currency",'connectorRevision',case_record."connector_revision",
        'credentialRevision',case_record."credential_revision",'providerAdapterVersion',gate_record."provider_adapter_version",
        'gateConfigHash',gate_record."config_hash",'vaultBindingId',vault_record."id",'requiresVaultOpen',true));
      replay_live_count := replay_live_count+1;
    END LOOP;
    IF replay_expired OR replay_live_count<>prior_batch."claimed_count" THEN
      RETURN pg_catalog.jsonb_build_object('batchId',prior_batch."id",'claimed','[]'::jsonb,'claimedCount',0,
        'originalClaimedCount',prior_batch."claimed_count",'blockedCount',prior_batch."blocked_count",
        'remainingDue',0,'hasMore',false,'vaultOpenAvailable',false,'replayed',true,'replayExpired',true);
    END IF;
    claimed_count := replay_live_count;
    RETURN pg_catalog.jsonb_build_object('batchId',prior_batch."id",'claimed',commands,'claimedCount',claimed_count,
      'blockedCount',prior_batch."blocked_count",'remainingDue',0,'hasMore',false,
      'vaultOpenAvailable',false,'replayed',true,'replayExpired',false);
  END IF;
  -- Never retain more session locks than this sweep can consume. Boundary
  -- failures count as work for a later request id, preserving peer progress.
  candidate_limit := p_limit;

  FOR candidate IN
    WITH due_sessions AS MATERIALIZED (
      SELECT session."id",min(outbox."next_attempt_at") AS first_due,min(outbox."id") AS first_outbox
        FROM public."cash_register_sessions" session
        JOIN public."pos_manual_payment_cases" manual_case ON manual_case."session_id"=session."id"
        JOIN public."pos_manual_payment_attempts" attempt ON attempt."case_id"=manual_case."id"
        JOIN public."pos_manual_payment_outbox" outbox ON outbox."attempt_id"=attempt."id"
       WHERE manual_case."state"='unknown' AND (
         (attempt."state"='queued' AND outbox."state" IN ('pending','retry') AND outbox."next_attempt_at"<=pg_catalog.clock_timestamp())
         OR (attempt."state"='claimed' AND outbox."state"='claimed' AND outbox."claim_expires_at"<=pg_catalog.clock_timestamp())
       ) GROUP BY session."id"
    ), locked_sessions AS MATERIALIZED (
      SELECT session."id" FROM public."cash_register_sessions" session
        JOIN due_sessions due ON due."id"=session."id"
       ORDER BY due.first_due,due.first_outbox,session."id"
       FOR UPDATE OF session SKIP LOCKED LIMIT candidate_limit
    ), ranked AS MATERIALIZED (
      SELECT manual_case."id" AS case_id,attempt."id" AS attempt_id,outbox."id" AS outbox_id,
        manual_case."session_id",outbox."next_attempt_at",outbox."id" AS ordering_id,
        pg_catalog.row_number() OVER (PARTITION BY manual_case."session_id"
          ORDER BY outbox."next_attempt_at",outbox."id") AS session_rank
        FROM public."pos_manual_payment_outbox" outbox
        JOIN public."pos_manual_payment_attempts" attempt ON attempt."id"=outbox."attempt_id"
        JOIN public."pos_manual_payment_cases" manual_case ON manual_case."id"=attempt."case_id"
        JOIN locked_sessions locked ON locked."id"=manual_case."session_id"
       WHERE manual_case."state"='unknown' AND (
         (attempt."state"='queued' AND outbox."state" IN ('pending','retry') AND outbox."next_attempt_at"<=pg_catalog.clock_timestamp())
         OR (attempt."state"='claimed' AND outbox."state"='claimed' AND outbox."claim_expires_at"<=pg_catalog.clock_timestamp())
       )
    )
    SELECT case_id,attempt_id,outbox_id FROM ranked WHERE session_rank=1
     ORDER BY next_attempt_at,ordering_id LIMIT candidate_limit
  LOOP
    EXIT WHEN claimed_count>=p_limit;
    case_record := public."pos_manual_lock_case_graph_321e"(candidate.case_id);
    SELECT * INTO attempt_record FROM public."pos_manual_payment_attempts"
     WHERE "id"=candidate.attempt_id FOR UPDATE;
    SELECT * INTO outbox_record FROM public."pos_manual_payment_outbox"
     WHERE "id"=candidate.outbox_id FOR UPDATE;
    now_at := pg_catalog.clock_timestamp();

    expired_claim := attempt_record."state"='claimed' AND outbox_record."state"='claimed'
      AND outbox_record."claim_expires_at" IS NOT NULL AND outbox_record."claim_expires_at"<=now_at;
    due_queued := attempt_record."state"='queued' AND outbox_record."state" IN ('pending','retry')
      AND outbox_record."next_attempt_at"<=now_at;
    IF case_record."state"<>'unknown' OR attempt_record."case_id"<>case_record."id"
      OR outbox_record."attempt_id"<>attempt_record."id" OR NOT (expired_claim OR due_queued) THEN CONTINUE; END IF;

    SELECT * INTO credential_record FROM public."integration_credentials" WHERE "id"=case_record."credential_ref";
    SELECT * INTO gate_record FROM public."pos_manual_payment_reconciliation_gates" WHERE "connector_id"=case_record."connector_id";
    SELECT * INTO vault_record FROM public."pos_manual_payment_vault_bindings" WHERE "case_id"=case_record."id";
    auth_key_id := NULL;
    IF pg_catalog.jsonb_typeof(credential_record."config"->'manualReconciliation'->'callbackAuthKeyIds')='array' THEN
      SELECT value INTO auth_key_id FROM pg_catalog.jsonb_array_elements_text(
        credential_record."config"->'manualReconciliation'->'callbackAuthKeyIds') value ORDER BY value LIMIT 1;
    END IF;
    boundary_failure := CASE WHEN auth_key_id IS NULL THEN 'manual_boundary_changed'
      ELSE public."pos_manual_boundary_failure_321e"(case_record."id",auth_key_id,case_record."credential_revision",now_at) END;
    block_reason := CASE WHEN boundary_failure IS NOT NULL THEN boundary_failure
      WHEN outbox_record."delivery_count">=outbox_record."max_deliveries" THEN 'maximum_deliveries_reached' ELSE NULL END;

    IF block_reason IS NOT NULL THEN
      next_version := case_record."version"+1;
      block_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        case_record."id"::text||':'||attempt_record."id"::text||':'||block_reason||':'||next_version::text,'UTF8')),'hex');
      IF expired_claim THEN
        INSERT INTO public."pos_manual_payment_delivery_results"(
          "attempt_id","delivery_number","claim_token_hash","response_hash","result_kind","outcome","evidence_hash",
          "retryable","superseded","resulting_state","resulting_version","processing_result","completion_idempotency_key"
        ) VALUES (attempt_record."id",outbox_record."delivery_count",
          pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(outbox_record."claim_token",'UTF8')),'hex'),
          block_hash,'transport_outcome_unknown','unknown',block_hash,false,true,'blocked',next_version,
          'terminal_blocked','claim-expired-block:'||attempt_record."id"::text||':'||outbox_record."delivery_count"::text);
      END IF;
      operation_record:=pg_catalog.jsonb_populate_record(NULL::public."pos_manual_payment_operations",pg_catalog.jsonb_build_object(
        'id',pg_catalog.nextval(pg_catalog.pg_get_serial_sequence('public.pos_manual_payment_operations','id')::pg_catalog.regclass),
        'case_id',case_record."id",'action','block','expected_version',case_record."version",'resulting_version',next_version,
        'resulting_state','blocked','idempotency_key','manual-claim-block:'||attempt_record."id"::text||':'||outbox_record."delivery_count"::text||':'||block_reason,
        'request_hash',block_hash,'write_txid',tx,'created_at',now_at));
      PERFORM public."pos_manual_t2_open_legacy_operation_root_v1"('legacy_manual:claim_queries:operation','block',operation_record);
      INSERT INTO public."pos_manual_payment_operations" SELECT (operation_record).* RETURNING * INTO operation_record;
      event_record:=pg_catalog.jsonb_populate_record(NULL::public."pos_manual_payment_state_events",pg_catalog.jsonb_build_object(
        'id',pg_catalog.nextval(pg_catalog.pg_get_serial_sequence('public.pos_manual_payment_state_events','id')::pg_catalog.regclass),
        'case_id',case_record."id",'operation_id',operation_record."id",'from_state',case_record."state",'to_state','blocked',
        'resulting_version',next_version,'source','worker','source_id',attempt_record."id"::text,'write_txid',tx,'created_at',now_at));
      PERFORM public."pos_manual_t2_open_legacy_state_event_root_v1"('legacy_manual:claim_queries:state_event','block',event_record);
      INSERT INTO public."pos_manual_payment_state_events" SELECT (event_record).*;
      target_case:=case_record; target_case."state":='blocked'; target_case."version":=next_version;
      target_case."blocked_at":=now_at; target_case."next_reconcile_at":=NULL;
      target_case."lifecycle_txid":=tx; target_case."updated_at":=now_at;
      PERFORM public."pos_manual_t2_open_legacy_case_root_v1"('legacy_manual:claim_queries:case','block','UPDATE',case_record,target_case);
      UPDATE public."pos_manual_payment_cases" SET "state"=target_case."state","version"=target_case."version",
        "blocked_at"=target_case."blocked_at","next_reconcile_at"=target_case."next_reconcile_at",
        "lifecycle_txid"=target_case."lifecycle_txid","updated_at"=target_case."updated_at" WHERE "id"=case_record."id";
      UPDATE public."pos_manual_payment_attempts" SET "state"='failed',"finished_at"=now_at WHERE "id"=attempt_record."id";
      UPDATE public."pos_manual_payment_outbox" SET "state"='dead',"claim_token"=NULL,"claim_expires_at"=NULL,
        "completed_at"=now_at,"last_error_code"=block_reason WHERE "id"=outbox_record."id";
      INSERT INTO public."pos_manual_payment_incidents"("case_id","code","expected_hash","reported_hash")
        VALUES (case_record."id",block_reason,case_record."request_hash",block_hash);
      blocked_count := blocked_count+1;
      CONTINUE;
    END IF;

    IF expired_claim THEN
      block_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        attempt_record."id"::text||':expired-lease:'||outbox_record."delivery_count"::text,'UTF8')),'hex');
      INSERT INTO public."pos_manual_payment_delivery_results"(
        "attempt_id","delivery_number","claim_token_hash","response_hash","result_kind","outcome","evidence_hash",
        "retryable","superseded","resulting_state","resulting_version","processing_result","completion_idempotency_key"
      ) VALUES (attempt_record."id",outbox_record."delivery_count",
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(outbox_record."claim_token",'UTF8')),'hex'),
        block_hash,'transport_outcome_unknown','unknown',block_hash,true,false,case_record."state",case_record."version",
        'retry_scheduled','claim-expired-retry:'||attempt_record."id"::text||':'||outbox_record."delivery_count"::text);
    END IF;

    lease_token := 'claim:'||pg_catalog.replace(pg_catalog.gen_random_uuid()::text,'-','')
      ||pg_catalog.replace(pg_catalog.gen_random_uuid()::text,'-','');
    lease_token_digest := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(lease_token,'UTF8')),'hex');
    UPDATE public."pos_manual_payment_attempts" SET "state"='claimed',"dispatch_count"="dispatch_count"+1,
      "outcome_unknown"="outcome_unknown" OR expired_claim,"started_at"=now_at,"finished_at"=NULL
      WHERE "id"=attempt_record."id";
    UPDATE public."pos_manual_payment_outbox" SET "state"='claimed',"delivery_count"="delivery_count"+1,
      "claim_token"=lease_token,"claim_expires_at"=now_at+pg_catalog.make_interval(secs=>p_lease_seconds),
      "completed_at"=NULL,"last_error_code"=NULL WHERE "id"=outbox_record."id"
      RETURNING * INTO outbox_record;
    INSERT INTO public."pos_manual_payment_claim_receipts"(
      "batch_id","batch_index","attempt_id","delivery_number","worker_id_hash","claim_token_hash","claim_expires_at",
      "reclaimed_expired_lease","caller_role","claimed_at"
    ) VALUES (batch_id,claimed_count+1,attempt_record."id",outbox_record."delivery_count",worker_id_hash,lease_token_digest,
      outbox_record."claim_expires_at",expired_claim,session_user,now_at) RETURNING * INTO receipt_record;

    commands := commands||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'claimReceiptId',receipt_record."id",'attemptId',attempt_record."id",'attemptSequence',attempt_record."sequence",
      'deliveryNumber',outbox_record."delivery_count",'providerIdempotencyKey',attempt_record."provider_idempotency_key",
      'claimToken',lease_token,'claimExpiresAt',outbox_record."claim_expires_at",'caseId',case_record."id",
      'provider',case_record."provider",'method',case_record."method",'amountCents',case_record."amount_cents",
      'currency',case_record."currency",'connectorRevision',case_record."connector_revision",
      'credentialRevision',case_record."credential_revision",'providerAdapterVersion',gate_record."provider_adapter_version",
      'gateConfigHash',gate_record."config_hash",'vaultBindingId',vault_record."id",'requiresVaultOpen',true
    ));
    claimed_count := claimed_count+1;
  END LOOP;

  now_at := pg_catalog.clock_timestamp();
  SELECT count(*) INTO remaining_due FROM public."pos_manual_payment_outbox" outbox
    JOIN public."pos_manual_payment_attempts" attempt ON attempt."id"=outbox."attempt_id"
    JOIN public."pos_manual_payment_cases" manual_case ON manual_case."id"=attempt."case_id"
   WHERE manual_case."state"='unknown' AND (
     (attempt."state"='queued' AND outbox."state" IN ('pending','retry') AND outbox."next_attempt_at"<=now_at)
     OR (attempt."state"='claimed' AND outbox."state"='claimed' AND outbox."claim_expires_at"<=now_at));
  INSERT INTO public."pos_manual_payment_claim_batches"(
    "id","request_key_hash","request_hash","worker_id_hash","requested_limit","lease_seconds",
    "claimed_count","blocked_count","caller_role","created_at"
  ) VALUES (batch_id,request_key_digest,request_digest,worker_id_hash,p_limit,p_lease_seconds,
    claimed_count,blocked_count,session_user,now_at);
  RETURN pg_catalog.jsonb_build_object('batchId',batch_id,'claimed',commands,'claimedCount',claimed_count,
    'blockedCount',blocked_count,'remainingDue',remaining_due,'hasMore',remaining_due>0,
    'vaultOpenAvailable',false,'replayed',false,'replayExpired',false);
END; $$;

-- Atomic cutover: all five mutating legacy producers and open_case above own
-- exact typed roots. The three trigger OIDs now become pure observers. They
-- read only owner transaction state, never a business root and never create
-- authority on behalf of direct DML.
CREATE OR REPLACE FUNCTION public."protect_pos_manual_case"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
  PERFORM public."pos_manual_t2_observe_legacy_write_v1"(
    NEW."id",'protect_pos_manual_case',TG_OP,
    CASE WHEN TG_OP='UPDATE' THEN public."pos_manual_t2_legacy_case_projection_v1"(OLD) ELSE NULL END,
    public."pos_manual_t2_legacy_case_projection_v1"(NEW));
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public."guard_pos_manual_operation"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
  PERFORM public."pos_manual_t2_observe_legacy_write_v1"(
    NEW."case_id",'guard_pos_manual_operation','INSERT',NULL,
    public."pos_manual_t2_legacy_operation_projection_v1"(NEW));
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public."guard_pos_manual_state_event"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
  PERFORM public."pos_manual_t2_observe_legacy_write_v1"(
    NEW."case_id",'guard_pos_manual_state_event','INSERT',NULL,
    public."pos_manual_t2_legacy_state_event_projection_v1"(NEW));
  RETURN NEW;
END
$function$;

-- T2-01 recognizes the structural T2 markers in the three authoritative-plan
-- validators but keeps the branch fail-closed until reserve/apply installs the
-- complete application graph. Existing cash/value/intent/manual-legacy paths
-- execute their byte-preserved historical bodies.
DO $retrofit_plan_validators$
DECLARE item record; definition text; begin_at integer;
BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('public.authorize_pos_sale_payment_plan_slot()',
      E'  IF NEW."manual_payment_case_id" IS NOT NULL THEN RAISE EXCEPTION ''T2 manual payment graph is not executable before reserve/apply'' USING ERRCODE=''23514''; END IF;\n'),
    ('public.validate_consumed_pos_payment_plan()',
      E'  IF NEW."state"=''consumed'' AND EXISTS (SELECT 1 FROM public."pos_sale_payments" p WHERE p."payment_plan_id"=NEW."id" AND p."manual_payment_case_id" IS NOT NULL) THEN RAISE EXCEPTION ''T2 consumed plan requires the complete reserve/apply graph'' USING ERRCODE=''23514''; END IF;\n'),
    ('public.validate_sale_authoritative_payment_plan_commit()',
      E'  IF NEW."manual_payment_application_id" IS NOT NULL THEN RAISE EXCEPTION ''T2 sale requires the complete reserve/apply graph'' USING ERRCODE=''23514''; END IF;\n')
  ) v(signature,snippet) LOOP
    SELECT pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(item.signature)) INTO definition;
    IF definition IS NULL THEN RAISE EXCEPTION 'T2-01 plan validator missing: %',item.signature USING ERRCODE='23514'; END IF;
    begin_at:=pg_catalog.strpos(definition,E'BEGIN\n');
    IF begin_at=0 THEN RAISE EXCEPTION 'T2-01 plan validator body changed: %',item.signature USING ERRCODE='23514'; END IF;
    definition:=pg_catalog.substr(definition,1,begin_at+5)||item.snippet||pg_catalog.substr(definition,begin_at+6);
    EXECUTE definition;
  END LOOP;
END
$retrofit_plan_validators$;

DO $retrofit_plan_operation_guard$
DECLARE definition text; begin_at integer;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.protect_pos_payment_plan_operation()')) INTO definition;
  IF definition IS NULL THEN RAISE EXCEPTION 'T2-01 plan operation guard missing' USING ERRCODE='23514'; END IF;
  begin_at:=pg_catalog.strpos(definition,E'BEGIN\n');
  IF begin_at=0 THEN RAISE EXCEPTION 'T2-01 plan operation guard body changed' USING ERRCODE='23514'; END IF;
  definition:=pg_catalog.substr(definition,1,begin_at+5)||$snippet$
  IF TG_OP='INSERT' AND NEW."action" IN ('supersede','expire') THEN
    NEW."write_txid":=pg_catalog.txid_current()::numeric;
    DELETE FROM public."pos_manual_t2_lock_contexts" c
    WHERE c."backend_pid"=pg_catalog.pg_backend_pid() AND c."transaction_txid"=pg_catalog.txid_current()::numeric
      AND c."capability"='plan_operation' AND c."aggregate_kind"='plan_operation' AND c."aggregate_id"=NEW."plan_id"
      AND c."transition_action"=NEW."action" AND c."caller_role_hash"=public."pos_manual_t2_authority_v1"('runtime')
      AND c."nonce_hash"=public."pos_manual_t2_transaction_nonce_hash_v1"()
      AND c."old_digest"=public."pos_manual_t2_transition_digest_v1"('plan_operation','null'::jsonb)
      AND c."new_digest"=public."pos_manual_t2_transition_digest_v1"('plan_operation',pg_catalog.jsonb_build_object(
        'planId',NEW."plan_id",'action',NEW."action",'expectedVersion',NEW."expected_version",'resultingVersion',NEW."resulting_version",
        'resultingState',NEW."resulting_state",'idempotencyKey',NEW."idempotency_key",'requestHash',NEW."request_hash",
        'actorUserId',NEW."actor_user_id",'saleId',NEW."sale_id",'writeTxid',NEW."write_txid"))
      AND c."request_digest"=public."pos_manual_t2_request_digest_v1"('plan_operation',NEW."action",NEW."plan_id",
        public."pos_manual_t2_transition_digest_v1"('plan_operation','null'::jsonb),
        public."pos_manual_t2_transition_digest_v1"('plan_operation',pg_catalog.jsonb_build_object(
          'planId',NEW."plan_id",'action',NEW."action",'expectedVersion',NEW."expected_version",'resultingVersion',NEW."resulting_version",
          'resultingState',NEW."resulting_state",'idempotencyKey',NEW."idempotency_key",'requestHash',NEW."request_hash",
          'actorUserId',NEW."actor_user_id",'saleId',NEW."sale_id",'writeTxid',NEW."write_txid")),NEW."request_hash");
    IF NOT FOUND THEN RAISE EXCEPTION 'plan operation requires one-shot causal context' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  END IF;
$snippet$||pg_catalog.substr(definition,begin_at+6);
  EXECUTE definition;
  ALTER FUNCTION public."protect_pos_payment_plan_operation"() SECURITY DEFINER;
  ALTER FUNCTION public."protect_pos_payment_plan_operation"() SET search_path=pg_catalog,public;
END
$retrofit_plan_operation_guard$;

REVOKE ALL ON FUNCTION public."pos_manual_t2_open_context_v1"(text,text,text) FROM PUBLIC;

CREATE FUNCTION public."pos_manual_t2_held_sale_item_projection_v1"(
  p_id integer,p_held_sale_id text,p_product_id integer,p_variation_id integer,p_quantity double precision,p_unit_price_cents integer,p_discount_cents integer,p_scan_data jsonb,p_notes text,p_include_id boolean)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
  RETURN (CASE WHEN p_include_id THEN pg_catalog.jsonb_build_object('id',p_id) ELSE '{}'::jsonb END)
    || pg_catalog.jsonb_build_object('heldSaleId',p_held_sale_id,'productId',p_product_id,'variationId',p_variation_id,
      'quantityFloat8Hex',public."pos_manual_t2_float8_hex_v1"(p_quantity),'unitPriceCents',p_unit_price_cents,
      'discountCents',p_discount_cents,'scanData',p_scan_data,'notes',p_notes);
END
$function$;

CREATE FUNCTION public."pos_manual_t2_held_sale_items_request_hash_v1"(
  p_action text,p_held_sale_id text,p_expected_revision integer,p_actor_user_id text,p_idempotency_key text,
  p_branch_id integer,p_register_id integer,p_session_id integer,p_operator_profile_id integer,p_terminal_id text,p_order_claim_id text,p_expected_digest text)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
  IF p_action NOT IN ('insert','update','delete','replace_batch') OR p_expected_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid held item request digest shape' USING ERRCODE='22023'; END IF;
  RETURN pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to('t2-held-sale-items-request-v1','UTF8')||pg_catalog.decode('00','hex')||pg_catalog.convert_to(pg_catalog.current_database(),'UTF8')||pg_catalog.decode('00','hex')||
    pg_catalog.convert_to(session_user,'UTF8')||pg_catalog.decode('00','hex')||pg_catalog.convert_to(p_action,'UTF8')||pg_catalog.decode('00','hex')||
    pg_catalog.convert_to(p_held_sale_id,'UTF8')||pg_catalog.decode('00','hex')||pg_catalog.convert_to(p_expected_revision::text,'UTF8')||pg_catalog.decode('00','hex')||
    pg_catalog.convert_to(p_actor_user_id,'UTF8')||pg_catalog.decode('00','hex')||pg_catalog.convert_to(p_idempotency_key,'UTF8')||pg_catalog.decode('00','hex')||
    pg_catalog.convert_to(p_branch_id::text||':'||p_register_id::text||':'||p_session_id::text||':'||p_operator_profile_id::text||':'||p_terminal_id||':'||coalesce(p_order_claim_id,''),'UTF8')||pg_catalog.decode('00','hex')||
    pg_catalog.convert_to(p_expected_digest,'UTF8')),'hex');
END
$function$;

CREATE FUNCTION public."pos_manual_prepare_held_sale_items_write_v1"(
  p_action text,p_held_sale_id text,p_expected_revision integer,p_actor_user_id text,p_idempotency_key text,p_request_hash text,p_operational_context jsonb,p_target_items jsonb)
RETURNS void LANGUAGE plpgsql VOLATILE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE authority text; ctx_branch integer; ctx_register integer; ctx_session integer; ctx_profile integer; ctx_terminal text; ctx_claim text;
DECLARE item jsonb; keys text[]; ordinal integer; item_id integer; product_id integer; variation_id integer; quantity_value double precision; unit_price integer; discount integer; scan_data jsonb; item_notes text; claim_sales_order_id integer; sales_order_row record; advisory_key text;
DECLARE expected_insert text[]:=ARRAY[]::text[]; expected_delete text[]:=ARRAY[]::text[]; expected_update text[]:=ARRAY[]::text[]; request_digests text[]:=ARRAY[]::text[]; expected_digest text;
DECLARE session_row record; terminal_row record; profile_row record; branch_row record; register_row record; access_row record; register_access_row record; claim_row record; held_row record; existing_item record; target_doc jsonb; old_doc jsonb; new_doc jsonb;
BEGIN
  IF p_action NOT IN ('insert','update','delete','replace_batch') OR p_held_sale_id IS NULL OR pg_catalog.octet_length(p_held_sale_id) NOT BETWEEN 1 AND 128
    OR p_expected_revision<0 OR p_request_hash !~ '^[0-9a-f]{64}$' OR NOT public."pos_manual_t2_subject_safe_v1"(p_actor_user_id)
    OR pg_catalog.octet_length(p_idempotency_key) NOT BETWEEN 16 AND 160 OR p_idempotency_key!~'^[A-Za-z0-9._:-]+$'
    OR pg_catalog.jsonb_typeof(p_operational_context)<>'object' OR pg_catalog.jsonb_typeof(p_target_items)<>'array'
    OR pg_catalog.pg_column_size(p_operational_context)>65536 OR pg_catalog.pg_column_size(p_target_items)>65536
    OR pg_catalog.jsonb_array_length(p_target_items) NOT BETWEEN 1 AND 200
    OR (p_action='insert' AND p_expected_revision<>0)
    OR (p_action IN ('update','delete') AND pg_catalog.jsonb_array_length(p_target_items)<>1) THEN RAISE EXCEPTION 'invalid held item capability shape' USING ERRCODE='22023'; END IF;
  IF (SELECT pg_catalog.array_agg(k ORDER BY k) FROM pg_catalog.jsonb_object_keys(p_operational_context) k) IS DISTINCT FROM
    ARRAY['branchId','operatorProfileId','orderClaimId','registerId','sessionId','terminalId']::text[] THEN RAISE EXCEPTION 'held item operational context keys are closed' USING ERRCODE='22023'; END IF;
  BEGIN
    ctx_branch:=(p_operational_context->>'branchId')::integer; ctx_register:=(p_operational_context->>'registerId')::integer;
    ctx_session:=(p_operational_context->>'sessionId')::integer; ctx_profile:=(p_operational_context->>'operatorProfileId')::integer;
    ctx_terminal:=p_operational_context->>'terminalId'; ctx_claim:=p_operational_context->>'orderClaimId';
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RAISE EXCEPTION 'invalid held item operational scalar' USING ERRCODE='22023'; END;
  IF pg_catalog.jsonb_typeof(p_operational_context->'branchId')<>'number' OR pg_catalog.jsonb_typeof(p_operational_context->'registerId')<>'number'
    OR pg_catalog.jsonb_typeof(p_operational_context->'sessionId')<>'number' OR pg_catalog.jsonb_typeof(p_operational_context->'operatorProfileId')<>'number'
    OR pg_catalog.jsonb_typeof(p_operational_context->'terminalId')<>'string' OR pg_catalog.jsonb_typeof(p_operational_context->'orderClaimId') NOT IN ('string','null')
    OR ctx_branch<=0 OR ctx_register<=0 OR ctx_session<=0 OR ctx_profile<=0 OR NOT public."pos_manual_t2_subject_safe_v1"(ctx_terminal)
    OR (ctx_claim IS NOT NULL AND NOT public."pos_manual_t2_subject_safe_v1"(ctx_claim)) THEN RAISE EXCEPTION 'invalid held item operational context' USING ERRCODE='22023'; END IF;
  authority:=public."pos_manual_t2_authority_v1"('runtime');
  IF p_action IN ('insert','replace_batch') AND (
    EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(p_target_items) AS candidate(value)
      WHERE pg_catalog.jsonb_typeof(candidate.value->'transportOrdinal')<>'number' OR candidate.value->>'transportOrdinal' !~ '^(0|[1-9][0-9]{0,2})$'
        OR (candidate.value->>'transportOrdinal')::integer NOT BETWEEN 0 AND 199)
    OR (SELECT pg_catalog.count(DISTINCT candidate.value->>'transportOrdinal') FROM pg_catalog.jsonb_array_elements(p_target_items) AS candidate(value))<>pg_catalog.jsonb_array_length(p_target_items)
  ) THEN RAISE EXCEPTION 'held item transport ordinal invalid' USING ERRCODE='22023'; END IF;
  FOR item IN SELECT value FROM pg_catalog.jsonb_array_elements(p_target_items) LOOP
    IF pg_catalog.jsonb_typeof(item)<>'object' THEN RAISE EXCEPTION 'held item must be object' USING ERRCODE='22023'; END IF;
    keys:=(SELECT pg_catalog.array_agg(k ORDER BY k) FROM pg_catalog.jsonb_object_keys(item) k);
    IF p_action IN ('insert','replace_batch') THEN
      IF keys IS DISTINCT FROM ARRAY['discountCents','notes','productId','quantity','scanData','transportOrdinal','unitPriceCents','variationId']::text[] THEN RAISE EXCEPTION 'held item insert keys are closed' USING ERRCODE='22023'; END IF;
      ordinal:=(item->>'transportOrdinal')::integer;
      IF ordinal NOT BETWEEN 0 AND 199 THEN RAISE EXCEPTION 'held item transport ordinal invalid' USING ERRCODE='22023'; END IF;
      item_id:=NULL;
    ELSE
      IF keys IS DISTINCT FROM ARRAY['discountCents','id','notes','productId','quantity','scanData','unitPriceCents','variationId']::text[] THEN RAISE EXCEPTION 'held item mutation keys are closed' USING ERRCODE='22023'; END IF;
      item_id:=(item->>'id')::integer;
      IF pg_catalog.jsonb_typeof(item->'id')<>'number' OR item_id<=0 THEN RAISE EXCEPTION 'held item id invalid' USING ERRCODE='22023'; END IF;
    END IF;
    BEGIN
      product_id:=(item->>'productId')::integer; variation_id:=CASE WHEN item->'variationId'='null'::jsonb THEN NULL ELSE (item->>'variationId')::integer END;
      unit_price:=(item->>'unitPriceCents')::integer; discount:=(item->>'discountCents')::integer; quantity_value:=(item->>'quantity')::double precision; scan_data:=item->'scanData'; item_notes:=item->>'notes';
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RAISE EXCEPTION 'invalid held item scalar' USING ERRCODE='22023'; END;
    IF pg_catalog.jsonb_typeof(item->'productId')<>'number' OR product_id<=0 OR pg_catalog.jsonb_typeof(item->'variationId') NOT IN ('number','null') OR (variation_id IS NOT NULL AND variation_id<=0)
      OR pg_catalog.jsonb_typeof(item->'unitPriceCents')<>'number' OR pg_catalog.jsonb_typeof(item->'discountCents')<>'number'
      OR pg_catalog.jsonb_typeof(item->'quantity')<>'number' OR quantity_value::text IN ('Infinity','-Infinity','NaN') OR quantity_value<=0
      OR unit_price<0 OR discount<0
      OR pg_catalog.jsonb_typeof(item->'scanData') NOT IN ('object','null') OR pg_catalog.jsonb_typeof(item->'notes') NOT IN ('string','null')
      OR (item_notes IS NOT NULL AND (pg_catalog.octet_length(item_notes)>256 OR item_notes<>normalize(item_notes,NFC) OR item_notes~'[[:cntrl:]]'
          OR NOT public."pos_manual_t2_canonical_text_dlp_safe_v1"(public."pos_manual_canonical_json_v1"(pg_catalog.to_jsonb(item_notes)))))
      OR (scan_data IS NOT NULL AND NOT public."pos_manual_t2_canonical_text_dlp_safe_v1"(public."pos_manual_canonical_json_v1"(scan_data))) THEN RAISE EXCEPTION 'held item payload invalid or DLP unsafe' USING ERRCODE='22023'; END IF;
    new_doc:=pg_catalog.jsonb_build_object('heldSaleId',p_held_sale_id,'productId',product_id,'variationId',variation_id,'quantityFloat8Hex',public."pos_manual_t2_float8_hex_v1"(quantity_value),'unitPriceCents',unit_price,'discountCents',discount,'scanData',scan_data,'notes',item_notes);
    -- Inserts deliberately have no database identity yet.  Mutations must bind
    -- the caller's request hash to the exact existing row they intend to alter.
    target_doc:=CASE WHEN p_action IN ('update','delete') THEN pg_catalog.jsonb_build_object('id',item_id)||new_doc ELSE new_doc END;
    request_digests:=pg_catalog.array_append(request_digests,pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(public."pos_manual_canonical_json_v1"(target_doc),'UTF8')),'hex'));
    IF p_action IN ('insert','replace_batch') THEN expected_insert:=pg_catalog.array_append(expected_insert,public."pos_manual_t2_write_observation_digest_v1"('held_sale_items','held_sale',p_held_sale_id,'insert','pos_held_sale_items_payment_plan_guard','INSERT',NULL,new_doc));
    END IF;
  END LOOP;
  expected_digest:=public."pos_manual_t2_write_observation_multiset_digest_v1"(request_digests);
  IF p_request_hash<>public."pos_manual_t2_held_sale_items_request_hash_v1"(p_action,p_held_sale_id,p_expected_revision,p_actor_user_id,p_idempotency_key,ctx_branch,ctx_register,ctx_session,ctx_profile,ctx_terminal,ctx_claim,expected_digest) THEN
    RAISE EXCEPTION 'held item request hash mismatch' USING ERRCODE='23514'; END IF;
  IF ctx_claim IS NOT NULL THEN
    SELECT "sales_order_id" INTO claim_sales_order_id FROM public."pos_order_claims" WHERE "id"=ctx_claim;
    IF claim_sales_order_id IS NULL THEN RAISE EXCEPTION 'held item claim locator missing' USING ERRCODE='23514'; END IF;
  END IF;
  -- Acquire every writer namespace in one deterministic order, before any root
  -- can be opened.  The claim locator above is intentionally read-only.
  FOR advisory_key IN SELECT value FROM pg_catalog.unnest(ARRAY[
    'pos-held-sale-items:v1:held-sale:'||p_held_sale_id,
    'pos-held-sale-items:v1:idempotency:'||p_idempotency_key,
    CASE WHEN ctx_claim IS NOT NULL THEN 'pos-order-claim:v1:claim:'||ctx_claim END,
    CASE WHEN ctx_claim IS NOT NULL THEN 'pos-order-claim:v1:artifacts:'||ctx_claim END,
    CASE WHEN claim_sales_order_id IS NOT NULL THEN 'pos-order-claim:v1:order:'||claim_sales_order_id::text END
  ]) AS value WHERE value IS NOT NULL ORDER BY value LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(advisory_key,0));
  END LOOP;
  SELECT * INTO session_row FROM public."cash_register_sessions" WHERE "id"=ctx_session FOR UPDATE;
  SELECT * INTO terminal_row FROM public."pos_terminals" WHERE "id"=ctx_terminal FOR UPDATE;
  SELECT * INTO profile_row FROM public."tenant_user_profiles" WHERE "id"=ctx_profile FOR UPDATE;
  SELECT * INTO branch_row FROM public."branches" WHERE "id"=ctx_branch FOR UPDATE;
  SELECT * INTO register_row FROM public."pos_registers" WHERE "id"=ctx_register FOR UPDATE;
  SELECT * INTO access_row FROM public."branch_user_accesses" WHERE "branch_id"=ctx_branch AND "user_profile_id"=ctx_profile FOR UPDATE;
  SELECT * INTO register_access_row FROM public."pos_register_accesses" WHERE "register_id"=ctx_register AND "user_profile_id"=ctx_profile FOR UPDATE;
  IF session_row.id IS NULL OR terminal_row.id IS NULL OR profile_row.id IS NULL OR branch_row.id IS NULL OR register_row.id IS NULL OR access_row.branch_id IS NULL OR register_access_row.register_id IS NULL
    OR session_row.register_id<>ctx_register OR session_row.operator_profile_id<>ctx_profile OR session_row.status<>'open' OR terminal_row.register_id<>ctx_register OR terminal_row.status<>'online'
    OR terminal_row.paired_at IS NULL OR terminal_row.revoked_at IS NOT NULL OR terminal_row.token_hash IS NULL OR terminal_row.token_expires_at<=pg_catalog.clock_timestamp()
    OR terminal_row.last_seen_at<=pg_catalog.clock_timestamp()-interval '5 minutes' OR NULLIF(pg_catalog.btrim(terminal_row.app_version),'') IS NULL
    OR profile_row.user_id<>p_actor_user_id OR profile_row.status<>'active' OR register_row.branch_id<>ctx_branch OR register_row.status<>'active' OR branch_row.status<>'active'
    OR NOT access_row.can_sell OR NOT register_access_row.active OR NOT register_access_row.can_sell
    OR (register_access_row.valid_from IS NOT NULL AND register_access_row.valid_from>pg_catalog.clock_timestamp()) OR (register_access_row.valid_until IS NOT NULL AND register_access_row.valid_until<=pg_catalog.clock_timestamp()) THEN RAISE EXCEPTION 'held item operational boundary changed' USING ERRCODE='23514'; END IF;
  IF ctx_claim IS NOT NULL THEN
    SELECT * INTO sales_order_row FROM public."sales_orders" WHERE "id"=claim_sales_order_id FOR UPDATE;
    SELECT * INTO claim_row FROM public."pos_order_claims" WHERE "id"=ctx_claim FOR UPDATE;
    IF sales_order_row.id IS NULL OR sales_order_row.branch_id<>ctx_branch OR claim_row.id IS NULL OR claim_row.sales_order_id<>claim_sales_order_id OR claim_row.state<>'active' OR claim_row.lease_expires_at<=pg_catalog.clock_timestamp() OR claim_row.branch_id<>ctx_branch OR claim_row.register_id<>ctx_register OR claim_row.session_id<>ctx_session OR claim_row.operator_profile_id<>ctx_profile OR claim_row.terminal_id<>ctx_terminal THEN RAISE EXCEPTION 'held item claim boundary changed' USING ERRCODE='23514'; END IF;
  END IF;
  SELECT * INTO held_row FROM public."pos_held_sales" WHERE "id"=p_held_sale_id FOR UPDATE;
  IF p_action='insert' THEN
    IF held_row.id IS NOT NULL THEN RAISE EXCEPTION 'held item create requires absent parent' USING ERRCODE='23514'; END IF;
  ELSE
    IF held_row.id IS NULL OR held_row.revision<>p_expected_revision OR held_row.status NOT IN ('draft','held')
      OR ROW(held_row.session_id,held_row.register_id,held_row.operator_profile_id) IS DISTINCT FROM ROW(ctx_session,ctx_register,ctx_profile) THEN RAISE EXCEPTION 'held item parent boundary changed' USING ERRCODE='23514'; END IF;
  END IF;
  PERFORM 1 FROM public."pos_held_sale_items" WHERE "held_sale_id"=p_held_sale_id ORDER BY "id" FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public."pos_payment_plans" WHERE "sale_draft_id"=p_held_sale_id AND "state" IN ('quoted','active')) THEN RAISE EXCEPTION 'held sale item belongs to an open authoritative payment plan' USING ERRCODE='23514'; END IF;
  IF p_action='replace_batch' THEN
    FOR existing_item IN SELECT * FROM public."pos_held_sale_items" WHERE "held_sale_id"=p_held_sale_id ORDER BY "id" LOOP
      old_doc:=public."pos_manual_t2_held_sale_item_projection_v1"(existing_item.id,existing_item.held_sale_id,existing_item.product_id,existing_item.variation_id,existing_item.quantity,existing_item.unit_price_cents,existing_item.discount_cents,existing_item.scan_data,existing_item.notes,true);
      expected_delete:=pg_catalog.array_append(expected_delete,public."pos_manual_t2_write_observation_digest_v1"('held_sale_items','held_sale',p_held_sale_id,'delete','pos_held_sale_items_payment_plan_guard','DELETE',old_doc,NULL));
    END LOOP;
    IF pg_catalog.cardinality(expected_delete) IS NULL THEN RAISE EXCEPTION 'held item replace requires existing items' USING ERRCODE='23514'; END IF;
    PERFORM public."pos_manual_t2_open_write_root_v1"('held_sale_items','held_sale',p_held_sale_id,'delete','pos_held_sale_items_payment_plan_guard','DELETE',authority,expected_delete);
    PERFORM public."pos_manual_t2_open_write_root_v1"('held_sale_items','held_sale',p_held_sale_id,'insert','pos_held_sale_items_payment_plan_guard','INSERT',authority,expected_insert);
  ELSIF p_action='insert' THEN
    PERFORM public."pos_manual_t2_open_write_root_v1"('held_sale_items','held_sale',p_held_sale_id,'insert','pos_held_sale_items_payment_plan_guard','INSERT',authority,expected_insert);
  ELSE
    SELECT * INTO existing_item FROM public."pos_held_sale_items" WHERE "id"=(p_target_items->0->>'id')::integer AND "held_sale_id"=p_held_sale_id;
    IF existing_item.id IS NULL THEN RAISE EXCEPTION 'held item target disappeared' USING ERRCODE='23514'; END IF;
    old_doc:=public."pos_manual_t2_held_sale_item_projection_v1"(existing_item.id,existing_item.held_sale_id,existing_item.product_id,existing_item.variation_id,existing_item.quantity,existing_item.unit_price_cents,existing_item.discount_cents,existing_item.scan_data,existing_item.notes,true);
    IF p_action='delete' THEN
      target_doc:=pg_catalog.jsonb_build_object('id',(p_target_items->0->>'id')::integer,'heldSaleId',p_held_sale_id,'productId',(p_target_items->0->>'productId')::integer,'variationId',CASE WHEN p_target_items->0->'variationId'='null'::jsonb THEN NULL ELSE (p_target_items->0->>'variationId')::integer END,'quantityFloat8Hex',public."pos_manual_t2_float8_hex_v1"((p_target_items->0->>'quantity')::double precision),'unitPriceCents',(p_target_items->0->>'unitPriceCents')::integer,'discountCents',(p_target_items->0->>'discountCents')::integer,'scanData',p_target_items->0->'scanData','notes',p_target_items->0->>'notes');
      IF target_doc IS DISTINCT FROM old_doc THEN RAISE EXCEPTION 'held item delete target changed' USING ERRCODE='23514'; END IF;
      expected_delete:=ARRAY[public."pos_manual_t2_write_observation_digest_v1"('held_sale_items','held_sale',p_held_sale_id,'delete','pos_held_sale_items_payment_plan_guard','DELETE',old_doc,NULL)];
      PERFORM public."pos_manual_t2_open_write_root_v1"('held_sale_items','held_sale',p_held_sale_id,'delete','pos_held_sale_items_payment_plan_guard','DELETE',authority,expected_delete);
    ELSE
      item:=p_target_items->0; new_doc:=pg_catalog.jsonb_build_object('id',existing_item.id,'heldSaleId',p_held_sale_id,'productId',(item->>'productId')::integer,'variationId',CASE WHEN item->'variationId'='null'::jsonb THEN NULL ELSE (item->>'variationId')::integer END,'quantityFloat8Hex',public."pos_manual_t2_float8_hex_v1"((item->>'quantity')::double precision),'unitPriceCents',(item->>'unitPriceCents')::integer,'discountCents',(item->>'discountCents')::integer,'scanData',item->'scanData','notes',item->>'notes');
      expected_update:=ARRAY[public."pos_manual_t2_write_observation_digest_v1"('held_sale_items','held_sale',p_held_sale_id,'update','pos_held_sale_items_payment_plan_guard','UPDATE',old_doc,new_doc)];
      PERFORM public."pos_manual_t2_open_write_root_v1"('held_sale_items','held_sale',p_held_sale_id,'update','pos_held_sale_items_payment_plan_guard','UPDATE',authority,expected_update);
    END IF;
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION public."protect_held_sale_item_with_open_payment_plan"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE old_doc jsonb; new_doc jsonb; held_id text; operation text;
BEGIN
  IF TG_NARGS<>3 OR TG_ARGV[0]<>'held_sale_items' OR TG_ARGV[1]<>'held_sale' OR TG_ARGV[2]<>'pos_held_sale_items_payment_plan_guard' THEN
    RAISE EXCEPTION 'invalid held item guard installation' USING ERRCODE='42501'; END IF;
  operation:=TG_OP; held_id:=CASE WHEN TG_OP='DELETE' THEN OLD."held_sale_id" ELSE NEW."held_sale_id" END;
  old_doc:=CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN public."pos_manual_t2_held_sale_item_projection_v1"(OLD."id",OLD."held_sale_id",OLD."product_id",OLD."variation_id",OLD."quantity",OLD."unit_price_cents",OLD."discount_cents",OLD."scan_data",OLD."notes",true) ELSE NULL END;
  new_doc:=CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN public."pos_manual_t2_held_sale_item_projection_v1"(NEW."id",NEW."held_sale_id",NEW."product_id",NEW."variation_id",NEW."quantity",NEW."unit_price_cents",NEW."discount_cents",NEW."scan_data",NEW."notes",TG_OP='UPDATE') ELSE NULL END;
  BEGIN
    PERFORM public."pos_manual_t2_observe_write_v1"('held_sale_items','held_sale',held_id,pg_catalog.lower(operation),'pos_held_sale_items_payment_plan_guard',operation,old_doc,new_doc);
  EXCEPTION WHEN check_violation THEN
    RAISE EXCEPTION 'held sale item write requires canonical T2 capability' USING ERRCODE='42501';
  END;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END
$function$;
DROP TRIGGER "pos_held_sale_items_payment_plan_guard" ON public."pos_held_sale_items";
CREATE TRIGGER "pos_held_sale_items_payment_plan_guard" BEFORE INSERT OR UPDATE OR DELETE ON public."pos_held_sale_items"
FOR EACH ROW EXECUTE FUNCTION public."protect_held_sale_item_with_open_payment_plan"('held_sale_items','held_sale','pos_held_sale_items_payment_plan_guard');

-- §6 payment-plan graph.  The capability owns every business-root read and
-- lock; the five row guards below only stamp server-owned fields and account
-- for the exact OLD/NEW projection in owner-only transaction state.
CREATE FUNCTION public."pos_manual_t2_plan_transition_projection_v1"(p public."pos_payment_plans")
RETURNS jsonb LANGUAGE sql STABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
 SELECT pg_catalog.jsonb_build_object('id',p.id,'state',p.state,'version',p.version,'activatedAt',p.activated_at,
  'consumedSaleId',p.consumed_sale_id,'consumedAt',p.consumed_at,'supersededAt',p.superseded_at,
  'expiredAt',p.expired_at,'lifecycleTxid',p.lifecycle_txid,'updatedAt',p.updated_at)
$function$;

CREATE FUNCTION public."pos_manual_t2_plan_quote_projection_v1"(p public."pos_payment_plans")
RETURNS jsonb LANGUAGE sql STABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
 SELECT pg_catalog.jsonb_build_object('id',p.id,'branchId',p.branch_id,'registerId',p.register_id,'sessionId',p.session_id,
  'operatorProfileId',p.operator_profile_id,'terminalId',p.terminal_id,'saleDraftId',p.sale_draft_id,'draftRevision',p.draft_revision,
  'draftRequestHash',p.draft_request_hash,'draftStatus',p.draft_status,'orderClaimId',p.order_claim_id,'quoteHash',p.quote_hash,
  'promotionId',p.promotion_id,'couponId',p.coupon_id,'promotionDiscountCents',p.promotion_discount_cents,
  'evaluatedAt',p.evaluated_at,'expiresAt',p.expires_at,'currency',p.currency,'totalCents',p.total_cents,'state',p.state,
  'version',p.version,'idempotencyKey',p.idempotency_key,'requestHash',p.request_hash,'lifecycleTxid',p.lifecycle_txid,
  'createdAt',p.created_at,'updatedAt',p.updated_at)
$function$;

CREATE FUNCTION public."pos_manual_t2_json_keys_exact_v1"(p_value jsonb,p_keys text[])
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
 SELECT pg_catalog.jsonb_typeof(p_value)='object'
   AND (SELECT pg_catalog.array_agg(key ORDER BY key COLLATE "C") FROM pg_catalog.jsonb_object_keys(p_value) key)
       IS NOT DISTINCT FROM (SELECT pg_catalog.array_agg(key ORDER BY key COLLATE "C") FROM pg_catalog.unnest(p_keys) key)
$function$;

CREATE FUNCTION public."pos_manual_prepare_payment_plan_graph_write_v1"(
 p_action text,p_plan_id text,p_expected_version integer,p_actor_user_id text,p_idempotency_key text,p_request_hash text,
 p_target_plan jsonb,p_target_quote_lines jsonb,p_target_slots jsonb)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE locator public."pos_payment_plans"%ROWTYPE; locked_plan public."pos_payment_plans"%ROWTYPE; claim_row public."pos_order_claims"%ROWTYPE;
 held_row public."pos_held_sales"%ROWTYPE; held_item_row public."pos_held_sale_items"%ROWTYPE; connector_row public."pos_connectors"%ROWTYPE;
 authority text; plan_old jsonb; plan_new jsonb; operation_doc jsonb; line_doc jsonb; slot_doc jsonb; item jsonb;
 line_digests text[]:='{}'; slot_digests text[]:='{}'; now_at timestamp(3):=pg_catalog.transaction_timestamp()::timestamp(3);
 target_state text; target_version integer; sale_id integer; connector_ids text[]; credential_ids text[]; namespace text;
BEGIN
 IF p_action IS NULL OR p_plan_id IS NULL OR p_expected_version IS NULL OR p_actor_user_id IS NULL OR p_idempotency_key IS NULL OR p_request_hash IS NULL
   OR p_target_plan IS NULL OR p_target_quote_lines IS NULL OR p_target_slots IS NULL THEN RAISE EXCEPTION 'null payment plan graph parameter' USING ERRCODE='22004'; END IF;
 IF p_action NOT IN ('quote','activate','consume','supersede','expire') OR p_expected_version<0 OR p_request_hash!~'^[0-9a-f]{64}$'
   OR pg_catalog.octet_length(p_plan_id) NOT BETWEEN 1 AND 128 OR p_plan_id<>normalize(p_plan_id,NFC) OR p_plan_id~'[[:cntrl:]]'
   OR NOT public."pos_manual_t2_subject_safe_v1"(p_actor_user_id) OR pg_catalog.octet_length(p_idempotency_key) NOT BETWEEN 16 AND 160
   OR p_idempotency_key!~'^[A-Za-z0-9._:-]+$' OR pg_catalog.jsonb_typeof(p_target_plan)<>'object'
   OR pg_catalog.jsonb_typeof(p_target_quote_lines)<>'array' OR pg_catalog.jsonb_typeof(p_target_slots)<>'array'
   OR pg_catalog.octet_length(p_target_plan::text)+pg_catalog.octet_length(p_target_quote_lines::text)+pg_catalog.octet_length(p_target_slots::text)>65536
   OR (p_action='expire' AND p_actor_user_id<>'system:pos-payment-maintenance')
   OR (p_action='quote' AND p_expected_version<>0)
   OR (p_action='quote' AND pg_catalog.jsonb_array_length(p_target_quote_lines) NOT BETWEEN 1 AND 200)
   OR (p_action<>'quote' AND p_target_quote_lines<>'[]'::jsonb)
   OR (p_action='activate' AND pg_catalog.jsonb_array_length(p_target_slots) NOT BETWEEN 1 AND 10)
   OR (p_action<>'activate' AND p_target_slots<>'[]'::jsonb)
   OR (p_action='consume' AND (pg_catalog.jsonb_typeof(p_target_plan->'consumedSaleId')<>'number'
     OR p_target_plan->>'consumedSaleId'!~'^[1-9][0-9]{0,9}$' OR (p_target_plan->>'consumedSaleId')::bigint>2147483647)) THEN
   RAISE EXCEPTION 'invalid payment plan graph shape' USING ERRCODE='22023'; END IF;
 IF p_action='quote' AND NOT public."pos_manual_t2_json_keys_exact_v1"(p_target_plan,ARRAY['id','branchId','registerId','sessionId','operatorProfileId','terminalId','saleDraftId','draftRevision','draftRequestHash','draftStatus','orderClaimId','quoteHash','promotionId','couponId','promotionDiscountCents','evaluatedAt','expiresAt','currency','totalCents','state','version','idempotencyKey','requestHash'])
   OR p_action<>'quote' AND NOT public."pos_manual_t2_json_keys_exact_v1"(p_target_plan,ARRAY['id','state','version','consumedSaleId']) THEN
   RAISE EXCEPTION 'payment plan target keys are not exact' USING ERRCODE='22023'; END IF;
	 IF p_target_plan->>'id' IS DISTINCT FROM p_plan_id OR p_target_plan->>'state' IS DISTINCT FROM (CASE p_action WHEN 'quote' THEN 'quoted' WHEN 'activate' THEN 'active' WHEN 'consume' THEN 'consumed' WHEN 'supersede' THEN 'superseded' ELSE 'expired' END)
	   OR (p_target_plan->>'version')::integer IS DISTINCT FROM (CASE WHEN p_action='quote' THEN 0 ELSE p_expected_version+1 END)
   OR (p_action='quote' AND (p_target_plan->>'idempotencyKey' IS DISTINCT FROM p_idempotency_key OR p_target_plan->>'requestHash' IS DISTINCT FROM p_request_hash))
   OR (p_action='consume')<>(p_target_plan->'consumedSaleId'<>'null'::jsonb) THEN RAISE EXCEPTION 'payment plan target transition mismatch' USING ERRCODE='22023'; END IF;
 FOR item IN SELECT value FROM pg_catalog.jsonb_array_elements(p_target_quote_lines) value LOOP
   IF NOT public."pos_manual_t2_json_keys_exact_v1"(item,ARRAY['planId','lineIndex','heldSaleItemId','productId','variationId','quantity','unitPriceCents','grossCents','baseDiscountCents','orderDiscountCents','promotionDiscountCents','surchargeCents','totalCents'])
    OR item->>'planId' IS DISTINCT FROM p_plan_id OR (item->>'lineIndex')::integer NOT BETWEEN 0 AND 199 OR (item->>'heldSaleItemId')::integer<=0
    OR (item->>'quantity')::double precision<=0 OR (item->>'quantity')::double precision::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'invalid quote line transport' USING ERRCODE='22023'; END IF;
 END LOOP;
 FOR item IN SELECT value FROM pg_catalog.jsonb_array_elements(p_target_slots) value LOOP
   IF NOT public."pos_manual_t2_json_keys_exact_v1"(item,ARRAY['planId','paymentIndex','method','amountCents','installments','proofKind','connectorId','provider'])
    OR item->>'planId' IS DISTINCT FROM p_plan_id OR (item->>'paymentIndex')::integer NOT BETWEEN 0 AND 9 OR (item->>'amountCents')::bigint NOT BETWEEN 1 AND 2147483647
    OR (item->>'installments')::integer NOT BETWEEN 1 AND 24 OR item->>'method' NOT IN ('cash','pix','credit','debit','voucher','store_credit')
    OR item->>'proofKind' NOT IN ('cash','value','intent','manual') THEN RAISE EXCEPTION 'invalid payment slot transport' USING ERRCODE='22023'; END IF;
 END LOOP;
 IF p_action='quote' AND (SELECT pg_catalog.count(DISTINCT (value->>'lineIndex')::integer) FROM pg_catalog.jsonb_array_elements(p_target_quote_lines) value)<>pg_catalog.jsonb_array_length(p_target_quote_lines)
   OR p_action='quote' AND (SELECT pg_catalog.count(DISTINCT (value->>'heldSaleItemId')::integer) FROM pg_catalog.jsonb_array_elements(p_target_quote_lines) value)<>pg_catalog.jsonb_array_length(p_target_quote_lines)
   OR p_action='quote' AND (SELECT pg_catalog.min((value->>'lineIndex')::integer)=0 AND pg_catalog.max((value->>'lineIndex')::integer)=pg_catalog.count(*)-1 FROM pg_catalog.jsonb_array_elements(p_target_quote_lines) value) IS NOT TRUE
   OR p_action='activate' AND (SELECT pg_catalog.count(DISTINCT (value->>'paymentIndex')::integer) FROM pg_catalog.jsonb_array_elements(p_target_slots) value)<>pg_catalog.jsonb_array_length(p_target_slots)
   OR p_action='activate' AND (SELECT pg_catalog.min((value->>'paymentIndex')::integer)=0 AND pg_catalog.max((value->>'paymentIndex')::integer)=pg_catalog.count(*)-1 FROM pg_catalog.jsonb_array_elements(p_target_slots) value) IS NOT TRUE THEN
   RAISE EXCEPTION 'payment plan graph batch is not exact and contiguous' USING ERRCODE='22023'; END IF;
 -- A consume reserves a serial sale id before the checkout inserts its row.
 -- Validate and bind it before the advisory set; the authoritative sale
 -- boundary remains enforced by the plan consumption guard when the plan is
 -- finally updated after sale/items/payments have been materialized.
 sale_id:=CASE WHEN p_action='consume' THEN (p_target_plan->>'consumedSaleId')::integer ELSE NULL END;
 authority:=public."pos_manual_t2_authority_v1"('runtime');
 IF p_action='quote' THEN
   locator.id:=p_plan_id; locator.branch_id:=(p_target_plan->>'branchId')::integer; locator.register_id:=(p_target_plan->>'registerId')::integer;
   locator.session_id:=(p_target_plan->>'sessionId')::integer; locator.operator_profile_id:=(p_target_plan->>'operatorProfileId')::integer;
   locator.terminal_id:=p_target_plan->>'terminalId'; locator.sale_draft_id:=p_target_plan->>'saleDraftId'; locator.order_claim_id:=p_target_plan->>'orderClaimId';
 ELSE SELECT * INTO locator FROM public."pos_payment_plans" WHERE id=p_plan_id; END IF;
 IF locator.id IS NULL OR locator.session_id IS NULL OR locator.terminal_id IS NULL OR locator.sale_draft_id IS NULL THEN RAISE EXCEPTION 'payment plan graph locator changed' USING ERRCODE='23514'; END IF;
 IF locator.order_claim_id IS NOT NULL THEN SELECT * INTO claim_row FROM public."pos_order_claims" WHERE id=locator.order_claim_id; IF claim_row.id IS NULL THEN RAISE EXCEPTION 'payment plan claim locator changed' USING ERRCODE='23514'; END IF; END IF;
 -- A quote's plan id is not sufficient serialization: two quote ids can
 -- target the same held draft.  These namespaces are shared with held-item
 -- and claim writers, sorted together before the first business lock/root.
 FOR namespace IN SELECT value FROM pg_catalog.unnest(ARRAY[
   'pos-held-sale-items:v1:held-sale:'||locator.sale_draft_id,
   't2-payment-plan:aggregate:'||p_plan_id,
   CASE WHEN sale_id IS NOT NULL THEN 't2-payment-plan:consume-sale:'||sale_id::text END,
   't2-payment-plan:draft:'||locator.sale_draft_id,
   't2-payment-plan:idempotency:'||p_idempotency_key,
   CASE WHEN locator.order_claim_id IS NOT NULL THEN 'pos-order-claim:v1:claim:'||locator.order_claim_id END,
   CASE WHEN locator.order_claim_id IS NOT NULL THEN 'pos-order-claim:v1:artifacts:'||locator.order_claim_id END,
   CASE WHEN claim_row.sales_order_id IS NOT NULL THEN 'pos-order-claim:v1:order:'||claim_row.sales_order_id::text END
 ]) AS value WHERE value IS NOT NULL ORDER BY value COLLATE "C" LOOP
   PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(namespace,0));
 END LOOP;
 PERFORM 1 FROM public."cash_register_sessions" WHERE id=locator.session_id FOR UPDATE;
 PERFORM 1 FROM public."pos_terminals" WHERE id=locator.terminal_id FOR UPDATE;
 PERFORM 1 FROM public."tenant_user_profiles" WHERE id=locator.operator_profile_id FOR SHARE;
 PERFORM 1 FROM public."branches" WHERE id=locator.branch_id FOR SHARE;
 PERFORM 1 FROM public."pos_registers" WHERE id=locator.register_id FOR SHARE;
 PERFORM 1 FROM public."branch_user_accesses" WHERE branch_id=locator.branch_id AND user_profile_id=locator.operator_profile_id FOR SHARE;
 PERFORM 1 FROM public."pos_register_accesses" WHERE register_id=locator.register_id AND user_profile_id=locator.operator_profile_id FOR SHARE;
 IF claim_row.id IS NOT NULL THEN
   PERFORM 1 FROM public."sales_orders" WHERE id=claim_row.sales_order_id FOR UPDATE;
   SELECT * INTO claim_row FROM public."pos_order_claims" WHERE id=locator.order_claim_id FOR UPDATE;
 END IF;
 -- The aggregate advisory namespace serializes an absent quote parent too.
 -- Lock the parent relation before every dependent evidence relation so a
 -- release cannot race a producer that materializes an artifact afterwards.
 PERFORM 1 FROM public."pos_payment_plans" WHERE id=p_plan_id FOR UPDATE;
 IF p_action<>'quote' THEN SELECT * INTO locked_plan FROM public."pos_payment_plans" WHERE id=p_plan_id FOR UPDATE;
 ELSE locked_plan:=locator; END IF;
 PERFORM 1 FROM public."pos_payment_intents" WHERE payment_plan_id=p_plan_id ORDER BY id FOR UPDATE;
 PERFORM 1 FROM public."pos_payment_attempts" attempt JOIN public."pos_payment_intents" intent ON intent.id=attempt.intent_id
   WHERE intent.payment_plan_id=p_plan_id ORDER BY attempt.intent_id,attempt.sequence,attempt.id FOR UPDATE OF attempt;
 PERFORM 1 FROM public."pos_payment_outbox" outbox JOIN public."pos_payment_attempts" attempt ON attempt.id=outbox.attempt_id
   JOIN public."pos_payment_intents" intent ON intent.id=attempt.intent_id WHERE intent.payment_plan_id=p_plan_id ORDER BY outbox.attempt_id,outbox.id FOR UPDATE OF outbox;
 PERFORM 1 FROM public."pos_payment_delivery_results" delivery JOIN public."pos_payment_intents" intent ON intent.id=delivery.intent_id
   WHERE intent.payment_plan_id=p_plan_id ORDER BY delivery.intent_id,delivery.attempt_id,delivery.id FOR UPDATE OF delivery;
 PERFORM 1 FROM public."pos_payment_callbacks" callback JOIN public."pos_payment_intents" intent ON intent.id=callback.intent_id
   WHERE intent.payment_plan_id=p_plan_id ORDER BY callback.intent_id,callback.id FOR UPDATE OF callback;
 PERFORM 1 FROM public."pos_payment_integrity_incidents" incident JOIN public."pos_payment_intents" intent ON intent.id=incident.intent_id
   WHERE intent.payment_plan_id=p_plan_id ORDER BY incident.callback_id,incident.id FOR UPDATE OF incident;
 PERFORM 1 FROM public."pos_manual_payment_references" WHERE payment_plan_id=p_plan_id ORDER BY id FOR UPDATE;
 PERFORM 1 FROM public."pos_manual_payment_cases" WHERE payment_plan_id=p_plan_id ORDER BY id FOR UPDATE;
 PERFORM 1 FROM public."pos_sale_payments" WHERE payment_plan_id=p_plan_id ORDER BY id FOR UPDATE;
 SELECT * INTO held_row FROM public."pos_held_sales" WHERE id=locator.sale_draft_id FOR UPDATE;
 PERFORM 1 FROM public."pos_held_sale_items" WHERE held_sale_id=locator.sale_draft_id ORDER BY id FOR UPDATE;
 IF p_action='activate' THEN
   SELECT pg_catalog.array_agg(DISTINCT value->>'connectorId' ORDER BY value->>'connectorId') INTO connector_ids
     FROM pg_catalog.jsonb_array_elements(p_target_slots) value WHERE value->>'connectorId' IS NOT NULL;
   PERFORM 1 FROM public."pos_connectors" WHERE id=ANY(connector_ids) ORDER BY id FOR SHARE;
   SELECT pg_catalog.array_agg(DISTINCT credential_ref ORDER BY credential_ref) INTO credential_ids FROM public."pos_connectors" WHERE id=ANY(connector_ids) AND credential_ref IS NOT NULL;
   PERFORM 1 FROM public."integration_credentials" WHERE id=ANY(credential_ids) ORDER BY id FOR SHARE;
 END IF;
 PERFORM 1 FROM public."pos_payment_plan_quote_lines" WHERE plan_id=p_plan_id ORDER BY line_index FOR UPDATE;
 PERFORM 1 FROM public."pos_payment_plan_slots" WHERE plan_id=p_plan_id ORDER BY payment_index FOR UPDATE;
 PERFORM 1 FROM public."pos_payment_plan_operations" WHERE plan_id=p_plan_id ORDER BY id FOR UPDATE;
 -- The preview is advisory only. Recompute its domain-separated transport hash
 -- after every root has been reread, before opening a single write root.
 IF p_request_hash IS DISTINCT FROM public."pos_manual_t2_payment_plan_graph_request_hash_v1"(
   p_action,p_plan_id,p_expected_version,p_actor_user_id,p_idempotency_key,
   p_target_plan-ARRAY['idempotencyKey','requestHash','evaluatedAt','expiresAt','draftRequestHash'],p_target_quote_lines,p_target_slots) THEN
   RAISE EXCEPTION 'payment plan graph request hash changed under lock' USING ERRCODE='23514'; END IF;

 IF p_action<>'quote' AND (locked_plan.id IS NULL OR locked_plan.version<>p_expected_version OR
   ROW(locked_plan.branch_id,locked_plan.register_id,locked_plan.session_id,locked_plan.operator_profile_id,locked_plan.terminal_id,locked_plan.order_claim_id,locked_plan.sale_draft_id)
   IS DISTINCT FROM ROW(locator.branch_id,locator.register_id,locator.session_id,locator.operator_profile_id,locator.terminal_id,locator.order_claim_id,locator.sale_draft_id)) THEN
   RAISE EXCEPTION 'payment plan graph boundary changed' USING ERRCODE='23514'; END IF;
 IF held_row.id IS NULL OR held_row.register_id<>locator.register_id OR held_row.session_id<>locator.session_id OR held_row.operator_profile_id<>locator.operator_profile_id
   OR held_row.status NOT IN ('draft','held') OR (p_action='quote' AND (held_row.revision<>(p_target_plan->>'draftRevision')::integer OR held_row.status<>p_target_plan->>'draftStatus' OR public."pos_manual_t2_payment_plan_draft_snapshot_hash_v1"(held_row.id) IS DISTINCT FROM p_target_plan->>'draftRequestHash'
      OR (p_target_plan->>'expiresAt')::timestamp(3) IS DISTINCT FROM LEAST((p_target_plan->>'evaluatedAt')::timestamp(3)+interval '120 seconds',COALESCE(claim_row.lease_expires_at::timestamp(3),(p_target_plan->>'evaluatedAt')::timestamp(3)+interval '120 seconds'))))
   OR (p_action='quote' AND (SELECT pg_catalog.count(*) FROM public."pos_held_sale_items" WHERE held_sale_id=locator.sale_draft_id)<>pg_catalog.jsonb_array_length(p_target_quote_lines))
   THEN RAISE EXCEPTION 'payment plan held-sale boundary changed' USING ERRCODE='23514'; END IF;
 IF (p_action='activate' AND locked_plan.state<>'quoted') OR (p_action='consume' AND locked_plan.state<>'active')
   OR (p_action IN ('supersede','expire') AND locked_plan.state NOT IN ('quoted','active'))
   OR (p_action='expire' AND locked_plan.expires_at>pg_catalog.transaction_timestamp()) THEN RAISE EXCEPTION 'invalid payment plan graph transition' USING ERRCODE='23514'; END IF;
 IF p_action IN ('quote','activate','consume','supersede') AND NOT EXISTS (
   SELECT 1 FROM public."cash_register_sessions" s JOIN public."pos_terminals" t ON t.id=locator.terminal_id
   JOIN public."tenant_user_profiles" profile ON profile.id=locator.operator_profile_id JOIN public."branches" branch ON branch.id=locator.branch_id
   JOIN public."pos_registers" register ON register.id=locator.register_id AND register.branch_id=branch.id
   JOIN public."branch_user_accesses" ba ON ba.branch_id=branch.id AND ba.user_profile_id=profile.id
   JOIN public."pos_register_accesses" ra ON ra.register_id=register.id AND ra.user_profile_id=profile.id
   WHERE s.id=locator.session_id AND s.register_id=locator.register_id AND s.operator_profile_id=locator.operator_profile_id AND s.status='open'
    AND t.register_id=locator.register_id AND t.status='online' AND t.paired_at IS NOT NULL AND t.revoked_at IS NULL AND t.token_hash IS NOT NULL
    AND t.token_expires_at>now_at AND t.last_seen_at>now_at-interval '5 minutes' AND NULLIF(btrim(t.app_version),'') IS NOT NULL
    AND profile.status='active' AND branch.status='active' AND register.status='active' AND ba.can_sell AND ra.active AND ra.can_sell
    AND (ra.valid_from IS NULL OR ra.valid_from<=now_at) AND (ra.valid_until IS NULL OR ra.valid_until>now_at)) THEN
   RAISE EXCEPTION 'payment plan live boundary changed' USING ERRCODE='23514'; END IF;
 IF claim_row.id IS NOT NULL AND (claim_row.sales_order_id IS NULL OR claim_row.id<>locator.order_claim_id OR locator.order_claim_id<>locator.sale_draft_id OR claim_row.branch_id<>locator.branch_id
   OR claim_row.register_id<>locator.register_id OR claim_row.session_id<>locator.session_id OR claim_row.operator_profile_id<>locator.operator_profile_id
   OR claim_row.terminal_id<>locator.terminal_id OR (p_action<>'expire' AND (claim_row.state<>'active' OR claim_row.lease_expires_at<=now_at))) THEN RAISE EXCEPTION 'payment plan claim boundary changed' USING ERRCODE='23514'; END IF;

 IF p_action IN ('supersede','expire') AND (
   EXISTS (SELECT 1 FROM public."pos_manual_payment_references" reference WHERE reference.payment_plan_id=p_plan_id)
   OR EXISTS (SELECT 1 FROM public."pos_sale_payments" payment WHERE payment.payment_plan_id=p_plan_id)
   OR EXISTS (SELECT 1 FROM public."pos_manual_payment_cases" manual_case WHERE manual_case.payment_plan_id=p_plan_id
     AND manual_case.state IN ('review_pending','unknown','confirmed_paid','application_pending','blocked'))
   OR EXISTS (
     SELECT 1 FROM public."pos_payment_intents" intent WHERE intent.payment_plan_id=p_plan_id AND NOT (
       (intent.status='cancelled' AND intent.provider_reference IS NULL AND intent.provider_occurred_at IS NULL AND intent.unknown_since IS NULL
         AND NOT EXISTS (SELECT 1 FROM public."pos_payment_attempts" attempt LEFT JOIN public."pos_payment_outbox" outbox ON outbox.attempt_id=attempt.id
           WHERE attempt.intent_id=intent.id AND (outbox.id IS NULL OR NOT COALESCE((attempt.state='failed' AND attempt.dispatch_count=0
             AND attempt.started_at IS NULL AND attempt.finished_at IS NOT NULL AND NOT attempt.outcome_unknown
             AND attempt.failure_code IN ('operator_cancelled_before_dispatch','expired_before_dispatch') AND outbox.state IN ('dead','completed')
             AND outbox.delivery_count=0 AND outbox.claim_token IS NULL),false)))
         AND NOT EXISTS (SELECT 1 FROM public."pos_payment_callbacks" callback WHERE callback.intent_id=intent.id
           AND callback.reported_state IN ('authorized','captured','unknown','manual_review','partially_refunded','refunded')))
       OR
       (intent.status='declined' AND intent.consumed_at IS NULL AND intent.unknown_since IS NULL
         AND (EXISTS (SELECT 1 FROM public."pos_payment_attempts" attempt JOIN public."pos_payment_outbox" outbox ON outbox.attempt_id=attempt.id
               JOIN public."pos_payment_delivery_results" delivery ON delivery.attempt_id=attempt.id AND delivery.intent_id=intent.id
             WHERE attempt.intent_id=intent.id AND attempt.state='succeeded' AND NOT attempt.outcome_unknown AND outbox.state='completed'
               AND outbox.claim_token IS NULL AND delivery.result_kind='result' AND delivery.resulting_intent_state='declined' AND NOT delivery.superseded)
           OR EXISTS (SELECT 1 FROM public."pos_payment_callbacks" callback WHERE callback.intent_id=intent.id AND callback.provider=intent.provider
             AND callback.reported_state='declined' AND callback.resulting_state='declined' AND callback.resulting_version=intent.version
             AND callback.processing_result='applied' AND callback.amount_cents=intent.amount_cents AND callback.currency=intent.currency
             AND NOT EXISTS (SELECT 1 FROM public."pos_payment_integrity_incidents" incident WHERE incident.callback_id=callback.id AND incident.production_blocking)))
         AND NOT EXISTS (SELECT 1 FROM public."pos_payment_attempts" attempt LEFT JOIN public."pos_payment_outbox" outbox ON outbox.attempt_id=attempt.id
           WHERE attempt.intent_id=intent.id AND (attempt.outcome_unknown IS DISTINCT FROM false OR attempt.state NOT IN ('succeeded','failed')
             OR outbox.id IS NULL OR outbox.state NOT IN ('completed','dead') OR outbox.claim_token IS NOT NULL))
         AND NOT EXISTS (SELECT 1 FROM public."pos_payment_callbacks" callback WHERE callback.intent_id=intent.id
           AND callback.reported_state IN ('authorized','captured','unknown','manual_review','partially_refunded','refunded')))
     )
   )
 ) THEN RAISE EXCEPTION 'payment plan release has unresolved financial evidence' USING ERRCODE='23514'; END IF;

 target_state:=CASE p_action WHEN 'quote' THEN 'quoted' WHEN 'activate' THEN 'active' WHEN 'consume' THEN 'consumed' WHEN 'supersede' THEN 'superseded' ELSE 'expired' END;
 target_version:=CASE WHEN p_action='quote' THEN 0 ELSE p_expected_version+1 END;
 IF p_action='quote' THEN
   locked_plan.id:=p_plan_id; locked_plan.branch_id:=locator.branch_id; locked_plan.register_id:=locator.register_id; locked_plan.session_id:=locator.session_id;
   locked_plan.operator_profile_id:=locator.operator_profile_id; locked_plan.terminal_id:=locator.terminal_id; locked_plan.sale_draft_id:=locator.sale_draft_id;
   locked_plan.draft_revision:=(p_target_plan->>'draftRevision')::integer; locked_plan.draft_request_hash:=p_target_plan->>'draftRequestHash'; locked_plan.draft_status:=p_target_plan->>'draftStatus';
   locked_plan.order_claim_id:=locator.order_claim_id; locked_plan.quote_hash:=p_target_plan->>'quoteHash'; locked_plan.promotion_id:=p_target_plan->>'promotionId'; locked_plan.coupon_id:=p_target_plan->>'couponId';
   locked_plan.promotion_discount_cents:=COALESCE((p_target_plan->>'promotionDiscountCents')::integer,0); locked_plan.evaluated_at:=(p_target_plan->>'evaluatedAt')::timestamptz;
   locked_plan.expires_at:=(p_target_plan->>'expiresAt')::timestamptz; locked_plan.currency:=COALESCE(p_target_plan->>'currency','BRL'); locked_plan.total_cents:=(p_target_plan->>'totalCents')::integer;
   locked_plan.state:='quoted'; locked_plan.version:=0; locked_plan.idempotency_key:=p_idempotency_key; locked_plan.request_hash:=p_request_hash;
   locked_plan.lifecycle_txid:=pg_catalog.txid_current()::numeric; locked_plan.created_at:=now_at; locked_plan.updated_at:=now_at;
   IF EXISTS(SELECT 1 FROM public."pos_payment_plans" WHERE id=p_plan_id) THEN RAISE EXCEPTION 'payment plan already exists' USING ERRCODE='23505'; END IF;
   plan_new:=public."pos_manual_t2_plan_quote_projection_v1"(locked_plan); plan_old:=NULL;
 ELSE
   plan_old:=public."pos_manual_t2_plan_transition_projection_v1"(locked_plan); locked_plan.state:=target_state; locked_plan.version:=target_version;
   locked_plan.lifecycle_txid:=pg_catalog.txid_current()::numeric; locked_plan.updated_at:=now_at;
   IF p_action='activate' THEN locked_plan.activated_at:=now_at; ELSIF p_action='consume' THEN locked_plan.consumed_at:=now_at; locked_plan.consumed_sale_id:=sale_id;
   ELSIF p_action='supersede' THEN locked_plan.superseded_at:=now_at; ELSE locked_plan.expired_at:=now_at; END IF;
   plan_new:=public."pos_manual_t2_plan_transition_projection_v1"(locked_plan);
 END IF;
 IF p_action IN ('supersede','expire') THEN
   -- The historical release guard is still installed on this table. Feed its
   -- one-shot context from the graph capability, but never its obsolete
   -- `plan_operation` context: operation rows are observed by T2 roots.
   PERFORM public."pos_manual_t2_insert_transition_context_v1"('plan_release',p_action,p_plan_id,
     pg_catalog.jsonb_build_object('id',p_plan_id,'sessionId',locked_plan.session_id,'state',CASE WHEN p_action='quote' THEN NULL ELSE (SELECT state FROM public."pos_payment_plans" WHERE id=p_plan_id) END,'version',p_expected_version),
     pg_catalog.jsonb_build_object('id',p_plan_id,'sessionId',locked_plan.session_id,'state',target_state,'version',target_version),p_request_hash,authority);
 END IF;
 operation_doc:=pg_catalog.jsonb_build_object('planId',p_plan_id,'action',p_action,'expectedVersion',CASE WHEN p_action='quote' THEN -1 ELSE p_expected_version END,
  'resultingVersion',target_version,'resultingState',target_state,'idempotencyKey',p_idempotency_key,'requestHash',p_request_hash,
  'actorUserId',p_actor_user_id,'saleId',sale_id,'writeTxid',pg_catalog.txid_current()::numeric,'createdAt',now_at::timestamp(3));
 PERFORM public."pos_manual_t2_open_write_root_v1"('payment_plan_graph:operation','payment_plan',p_plan_id,p_action,'pos_payment_plan_operations_insert_guard','INSERT',authority,
  ARRAY[public."pos_manual_t2_write_observation_digest_v1"('payment_plan_graph:operation','payment_plan',p_plan_id,p_action,'pos_payment_plan_operations_insert_guard','INSERT',NULL,operation_doc)]);
 PERFORM public."pos_manual_t2_open_write_root_v1"('payment_plan_graph:plan_transition','payment_plan',p_plan_id,p_action,'pos_payment_plans_immutable_guard',CASE WHEN p_action='quote' THEN 'INSERT' ELSE 'UPDATE' END,authority,
  ARRAY[public."pos_manual_t2_write_observation_digest_v1"('payment_plan_graph:plan_transition','payment_plan',p_plan_id,p_action,'pos_payment_plans_immutable_guard',CASE WHEN p_action='quote' THEN 'INSERT' ELSE 'UPDATE' END,plan_old,plan_new)]);
 IF p_action IN ('activate','consume') THEN PERFORM public."pos_manual_t2_open_write_root_v1"('payment_plan_graph:plan_transition','payment_plan',p_plan_id,p_action,'pos_payment_plans_activation_guard','UPDATE',authority,
  ARRAY[public."pos_manual_t2_write_observation_digest_v1"('payment_plan_graph:plan_transition','payment_plan',p_plan_id,p_action,'pos_payment_plans_activation_guard','UPDATE',plan_old,plan_new)]); END IF;
 IF p_action='quote' THEN
   FOR item IN SELECT value FROM pg_catalog.jsonb_array_elements(p_target_quote_lines) value LOOP
    SELECT * INTO held_item_row FROM public."pos_held_sale_items" WHERE id=(item->>'heldSaleItemId')::integer AND held_sale_id=locator.sale_draft_id;
    IF held_item_row.id IS NULL THEN RAISE EXCEPTION 'quote line held item changed' USING ERRCODE='23514'; END IF;
   IF ROW(held_item_row.product_id,held_item_row.variation_id,public."pos_manual_t2_float8_hex_v1"(held_item_row.quantity),held_item_row.unit_price_cents,held_item_row.discount_cents)
      IS DISTINCT FROM ROW((item->>'productId')::integer,CASE WHEN item->'variationId'='null'::jsonb THEN NULL ELSE (item->>'variationId')::integer END,public."pos_manual_t2_float8_hex_v1"((item->>'quantity')::double precision),(item->>'unitPriceCents')::integer,(item->>'baseDiscountCents')::integer) THEN
     RAISE EXCEPTION 'quote line transport diverges from held item' USING ERRCODE='23514'; END IF;
   line_doc:=pg_catalog.jsonb_build_object('planId',p_plan_id,'lineIndex',(item->>'lineIndex')::integer,'heldSaleItemId',(item->>'heldSaleItemId')::integer,
     'productId',held_item_row.product_id,'variationId',held_item_row.variation_id,'quantityFloat8Hex',public."pos_manual_t2_float8_hex_v1"(held_item_row.quantity),
     'unitPriceCents',held_item_row.unit_price_cents,'grossCents',(item->>'grossCents')::integer,'baseDiscountCents',held_item_row.discount_cents,
     'orderDiscountCents',(item->>'orderDiscountCents')::integer,'promotionDiscountCents',(item->>'promotionDiscountCents')::integer,'surchargeCents',(item->>'surchargeCents')::integer,
     'totalCents',(item->>'totalCents')::integer,'createdAt',now_at::timestamp(3));
    IF (item->>'grossCents')::bigint<>pg_catalog.round(held_item_row.quantity*held_item_row.unit_price_cents)::bigint
      OR (item->>'totalCents')::bigint<>(item->>'grossCents')::bigint-held_item_row.discount_cents-(item->>'orderDiscountCents')::bigint-(item->>'promotionDiscountCents')::bigint+(item->>'surchargeCents')::bigint
      THEN RAISE EXCEPTION 'quote line arithmetic changed' USING ERRCODE='23514'; END IF;
    line_digests:=pg_catalog.array_append(line_digests,public."pos_manual_t2_write_observation_digest_v1"('payment_plan_graph:quote_lines','payment_plan',p_plan_id,'quote','pos_payment_plan_quote_lines_immutable_guard','INSERT',NULL,line_doc));
   END LOOP;
   PERFORM public."pos_manual_t2_open_write_root_v1"('payment_plan_graph:quote_lines','payment_plan',p_plan_id,'quote','pos_payment_plan_quote_lines_immutable_guard','INSERT',authority,line_digests);
 ELSIF p_action='activate' THEN
   IF (SELECT pg_catalog.sum((value->>'amountCents')::bigint) FROM pg_catalog.jsonb_array_elements(p_target_slots) value)<>locked_plan.total_cents THEN RAISE EXCEPTION 'payment slots do not total plan' USING ERRCODE='23514'; END IF;
   FOR item IN SELECT value FROM pg_catalog.jsonb_array_elements(p_target_slots) value LOOP
    connector_row:=NULL;
    IF item->>'connectorId' IS NOT NULL THEN SELECT * INTO connector_row FROM public."pos_connectors" WHERE id=item->>'connectorId'; END IF;
    slot_doc:=pg_catalog.jsonb_build_object('planId',p_plan_id,'paymentIndex',(item->>'paymentIndex')::integer,'method',item->>'method','amountCents',(item->>'amountCents')::integer,
     'installments',(item->>'installments')::integer,'proofKind',item->>'proofKind','connectorId',item->>'connectorId','credentialRef',item->>'credentialRef','provider',item->>'provider','createdAt',now_at::timestamp(3));
    IF item->>'connectorId' IS NOT NULL THEN
      IF connector_row.id IS NULL OR connector_row.credential_ref IS NULL THEN RAISE EXCEPTION 'slot connector credential changed' USING ERRCODE='23514'; END IF;
      slot_doc:=pg_catalog.jsonb_set(slot_doc,'{credentialRef}',pg_catalog.to_jsonb(connector_row.credential_ref),false);
    END IF;
    IF item->>'proofKind'='manual' THEN RAISE EXCEPTION 'manual payment plan slots remain hard-disabled' USING ERRCODE='23514'; END IF;
    IF item->>'proofKind'='intent' AND NOT EXISTS (
      SELECT 1 FROM public."pos_connectors" c
      JOIN public."integration_credentials" credential ON credential.id=c.credential_ref
      JOIN public."integration_providers" provider ON provider.id=credential.provider_id
       WHERE c.id=item->>'connectorId' AND c.provider=item->>'provider'
         AND c.status='active' AND c.branch_id=locator.branch_id AND (c.register_id IS NULL OR c.register_id=locator.register_id)
         AND c.type LIKE 'payment%' AND credential.enabled AND credential.provider_id=item->>'provider' AND provider.family='payment'
         AND CASE WHEN NOT COALESCE(c.settings ? 'methods',false) OR c.settings->'methods'='null'::jsonb THEN true
           WHEN pg_catalog.jsonb_typeof(c.settings->'methods')<>'array' THEN false
           ELSE c.settings->'methods' ? (item->>'method')
             AND NOT EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(c.settings->'methods') configured_method
               WHERE pg_catalog.jsonb_typeof(configured_method)<>'string' OR configured_method #>> '{}' NOT IN ('pix','credit','debit','voucher')) END
    ) THEN RAISE EXCEPTION 'slot connector or credential is no longer usable' USING ERRCODE='23514'; END IF;
    slot_digests:=pg_catalog.array_append(slot_digests,public."pos_manual_t2_write_observation_digest_v1"('payment_plan_graph:slots','payment_plan',p_plan_id,'activate','pos_payment_plan_slots_immutable_guard','INSERT',NULL,slot_doc));
   END LOOP;
   PERFORM public."pos_manual_t2_open_write_root_v1"('payment_plan_graph:slots','payment_plan',p_plan_id,'activate','pos_payment_plan_slots_immutable_guard','INSERT',authority,slot_digests);
 END IF;
END
$function$;

-- Preview ABI: it has precisely the graph capability inputs except the hash.
-- It is read-only and exists so producers can bind DB/session domain data
-- without ever supplying an OLD/NEW digest to the capability.
ALTER FUNCTION public."pos_manual_prepare_payment_plan_graph_write_v1"(text,text,integer,text,text,text,jsonb,jsonb,jsonb)
  RENAME TO "pos_manual_prepare_payment_plan_graph_write_core_v1";

CREATE FUNCTION public."pos_manual_t2_payment_plan_graph_request_hash_v1"(
 p_action text,p_plan_id text,p_expected_version integer,p_actor_user_id text,p_idempotency_key text,
 p_target_plan jsonb,p_target_quote_lines jsonb,p_target_slots jsonb)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE item jsonb; line_docs jsonb:='[]'::jsonb; slot_docs jsonb:='[]'::jsonb; quantity_value double precision;
BEGIN
 IF p_action NOT IN ('quote','activate','consume','supersede','expire') OR p_expected_version<0
    OR pg_catalog.octet_length(p_plan_id) NOT BETWEEN 1 AND 128 OR p_plan_id<>normalize(p_plan_id,NFC) OR p_plan_id~'[[:cntrl:] ]'
    OR NOT public."pos_manual_t2_subject_safe_v1"(p_actor_user_id) OR pg_catalog.octet_length(p_idempotency_key) NOT BETWEEN 16 AND 160
    OR p_idempotency_key!~'^[A-Za-z0-9._:-]+$' OR pg_catalog.jsonb_typeof(p_target_plan)<>'object'
    OR pg_catalog.jsonb_typeof(p_target_quote_lines)<>'array' OR pg_catalog.jsonb_typeof(p_target_slots)<>'array'
    OR pg_catalog.pg_column_size(p_target_plan)+pg_catalog.pg_column_size(p_target_quote_lines)+pg_catalog.pg_column_size(p_target_slots)>65536
    OR (p_action='expire' AND p_actor_user_id<>'system:pos-payment-maintenance')
    OR (p_action='quote' AND p_expected_version<>0)
    OR (p_action='quote' AND pg_catalog.jsonb_array_length(p_target_quote_lines) NOT BETWEEN 1 AND 200)
    OR (p_action<>'quote' AND p_target_quote_lines<>'[]'::jsonb)
    OR (p_action='activate' AND pg_catalog.jsonb_array_length(p_target_slots) NOT BETWEEN 1 AND 10)
    OR (p_action<>'activate' AND p_target_slots<>'[]'::jsonb) THEN RAISE EXCEPTION 'invalid payment plan graph preview shape' USING ERRCODE='22023'; END IF;
 IF (p_action='quote' AND NOT public."pos_manual_t2_json_keys_exact_v1"(p_target_plan,ARRAY['id','branchId','registerId','sessionId','operatorProfileId','terminalId','saleDraftId','draftRevision','draftStatus','orderClaimId','quoteHash','promotionId','couponId','promotionDiscountCents','currency','totalCents','state','version']))
    OR (p_action<>'quote' AND NOT public."pos_manual_t2_json_keys_exact_v1"(p_target_plan,ARRAY['id','state','version','consumedSaleId'])) THEN
   RAISE EXCEPTION 'payment plan preview target keys are not exact' USING ERRCODE='22023'; END IF;
 IF p_target_plan->>'id' IS DISTINCT FROM p_plan_id OR pg_catalog.jsonb_typeof(p_target_plan->'state')<>'string'
    OR p_target_plan->>'state' IS DISTINCT FROM (CASE p_action WHEN 'quote' THEN 'quoted' WHEN 'activate' THEN 'active' WHEN 'consume' THEN 'consumed' WHEN 'supersede' THEN 'superseded' ELSE 'expired' END)
    OR pg_catalog.jsonb_typeof(p_target_plan->'version')<>'number' OR p_target_plan->>'version'!~'^(0|[1-9][0-9]{0,9})$'
    OR (p_target_plan->>'version')::bigint<>(CASE WHEN p_action='quote' THEN 0 ELSE p_expected_version+1 END)
    OR (p_action='consume' AND (pg_catalog.jsonb_typeof(p_target_plan->'consumedSaleId')<>'number' OR p_target_plan->>'consumedSaleId'!~'^[1-9][0-9]{0,9}$'))
    OR (p_action<>'consume' AND p_target_plan->'consumedSaleId'<>'null'::jsonb) THEN RAISE EXCEPTION 'payment plan preview transition is invalid' USING ERRCODE='22023'; END IF;
 IF p_action='quote' AND (
    pg_catalog.jsonb_typeof(p_target_plan->'branchId')<>'number' OR pg_catalog.jsonb_typeof(p_target_plan->'registerId')<>'number' OR pg_catalog.jsonb_typeof(p_target_plan->'sessionId')<>'number' OR pg_catalog.jsonb_typeof(p_target_plan->'operatorProfileId')<>'number'
    OR pg_catalog.jsonb_typeof(p_target_plan->'terminalId')<>'string' OR pg_catalog.jsonb_typeof(p_target_plan->'saleDraftId')<>'string' OR pg_catalog.jsonb_typeof(p_target_plan->'draftRevision')<>'number'
    OR pg_catalog.jsonb_typeof(p_target_plan->'draftStatus')<>'string' OR pg_catalog.jsonb_typeof(p_target_plan->'orderClaimId') NOT IN ('string','null') OR pg_catalog.jsonb_typeof(p_target_plan->'quoteHash')<>'string'
    OR pg_catalog.jsonb_typeof(p_target_plan->'promotionId') NOT IN ('string','null') OR pg_catalog.jsonb_typeof(p_target_plan->'couponId') NOT IN ('string','null') OR pg_catalog.jsonb_typeof(p_target_plan->'promotionDiscountCents')<>'number'
    OR pg_catalog.jsonb_typeof(p_target_plan->'currency')<>'string' OR pg_catalog.jsonb_typeof(p_target_plan->'totalCents')<>'number'
    OR p_target_plan->>'branchId'!~'^[1-9][0-9]{0,9}$' OR p_target_plan->>'registerId'!~'^[1-9][0-9]{0,9}$' OR p_target_plan->>'sessionId'!~'^[1-9][0-9]{0,9}$' OR p_target_plan->>'operatorProfileId'!~'^[1-9][0-9]{0,9}$'
    OR p_target_plan->>'draftRevision'!~'^(0|[1-9][0-9]{0,9})$' OR p_target_plan->>'promotionDiscountCents'!~'^(0|[1-9][0-9]{0,9})$' OR p_target_plan->>'totalCents'!~'^[1-9][0-9]{0,9}$'
    OR p_target_plan->>'quoteHash'!~'^[0-9a-f]{64}$' OR p_target_plan->>'draftStatus' NOT IN ('draft','held') OR p_target_plan->>'currency'<>'BRL'
    OR NOT public."pos_manual_t2_subject_safe_v1"(p_target_plan->>'terminalId') OR NOT public."pos_manual_t2_subject_safe_v1"(p_target_plan->>'saleDraftId')
    OR (p_target_plan->'orderClaimId'<>'null'::jsonb AND NOT public."pos_manual_t2_subject_safe_v1"(p_target_plan->>'orderClaimId'))
    OR (p_target_plan->'promotionId'<>'null'::jsonb AND NOT public."pos_manual_t2_subject_safe_v1"(p_target_plan->>'promotionId'))
    OR (p_target_plan->'couponId'<>'null'::jsonb AND NOT public."pos_manual_t2_subject_safe_v1"(p_target_plan->>'couponId'))
 ) THEN RAISE EXCEPTION 'payment plan quote transport types are invalid' USING ERRCODE='22023'; END IF;
 FOR item IN SELECT value FROM pg_catalog.jsonb_array_elements(p_target_quote_lines) value LOOP
   IF pg_catalog.jsonb_typeof(item)<>'object' OR NOT public."pos_manual_t2_json_keys_exact_v1"(item,ARRAY['planId','lineIndex','heldSaleItemId','productId','variationId','quantity','unitPriceCents','grossCents','baseDiscountCents','orderDiscountCents','promotionDiscountCents','surchargeCents','totalCents'])
      OR pg_catalog.jsonb_typeof(item->'planId')<>'string' OR item->>'planId' IS DISTINCT FROM p_plan_id
      OR pg_catalog.jsonb_typeof(item->'lineIndex')<>'number' OR pg_catalog.jsonb_typeof(item->'heldSaleItemId')<>'number' OR pg_catalog.jsonb_typeof(item->'productId')<>'number' OR pg_catalog.jsonb_typeof(item->'variationId') NOT IN ('number','null') OR pg_catalog.jsonb_typeof(item->'quantity')<>'number'
      OR pg_catalog.jsonb_typeof(item->'unitPriceCents')<>'number' OR pg_catalog.jsonb_typeof(item->'grossCents')<>'number' OR pg_catalog.jsonb_typeof(item->'baseDiscountCents')<>'number' OR pg_catalog.jsonb_typeof(item->'orderDiscountCents')<>'number' OR pg_catalog.jsonb_typeof(item->'promotionDiscountCents')<>'number' OR pg_catalog.jsonb_typeof(item->'surchargeCents')<>'number' OR pg_catalog.jsonb_typeof(item->'totalCents')<>'number'
      OR item->>'lineIndex'!~'^(0|[1-9][0-9]{0,2})$' OR item->>'heldSaleItemId'!~'^[1-9][0-9]{0,9}$' OR item->>'productId'!~'^[1-9][0-9]{0,9}$' OR (item->'variationId'<>'null'::jsonb AND item->>'variationId'!~'^[1-9][0-9]{0,9}$')
      OR item->>'unitPriceCents'!~'^(0|[1-9][0-9]{0,9})$' OR item->>'grossCents'!~'^(0|[1-9][0-9]{0,9})$' OR item->>'baseDiscountCents'!~'^(0|[1-9][0-9]{0,9})$' OR item->>'orderDiscountCents'!~'^(0|[1-9][0-9]{0,9})$' OR item->>'promotionDiscountCents'!~'^(0|[1-9][0-9]{0,9})$' OR item->>'surchargeCents'!~'^(0|[1-9][0-9]{0,9})$' OR item->>'totalCents'!~'^(0|[1-9][0-9]{0,9})$' THEN RAISE EXCEPTION 'invalid quote line transport' USING ERRCODE='22023'; END IF;
   BEGIN quantity_value:=(item->>'quantity')::double precision; EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RAISE EXCEPTION 'invalid quote quantity' USING ERRCODE='22023'; END;
   IF quantity_value::text IN ('NaN','Infinity','-Infinity') OR quantity_value<=0 THEN RAISE EXCEPTION 'invalid quote quantity' USING ERRCODE='22023'; END IF;
 END LOOP;
 IF p_action='quote' AND ((SELECT count(DISTINCT value->>'lineIndex') FROM pg_catalog.jsonb_array_elements(p_target_quote_lines) value)<>pg_catalog.jsonb_array_length(p_target_quote_lines)
   OR (SELECT count(DISTINCT value->>'heldSaleItemId') FROM pg_catalog.jsonb_array_elements(p_target_quote_lines) value)<>pg_catalog.jsonb_array_length(p_target_quote_lines)) THEN RAISE EXCEPTION 'quote line multiplicity is invalid' USING ERRCODE='22023'; END IF;
 FOR item IN SELECT value FROM pg_catalog.jsonb_array_elements(p_target_slots) value LOOP
   IF pg_catalog.jsonb_typeof(item)<>'object' OR NOT public."pos_manual_t2_json_keys_exact_v1"(item,ARRAY['planId','paymentIndex','method','amountCents','installments','proofKind','connectorId','provider'])
      OR pg_catalog.jsonb_typeof(item->'planId')<>'string' OR item->>'planId' IS DISTINCT FROM p_plan_id OR pg_catalog.jsonb_typeof(item->'paymentIndex')<>'number' OR item->>'paymentIndex'!~'^(0|[1-9][0-9])$'
      OR pg_catalog.jsonb_typeof(item->'method')<>'string' OR pg_catalog.jsonb_typeof(item->'amountCents')<>'number' OR item->>'amountCents'!~'^[1-9][0-9]{0,9}$' OR pg_catalog.jsonb_typeof(item->'installments')<>'number' OR item->>'installments'!~'^(?:[1-9]|1[0-9]|2[0-4])$'
      OR pg_catalog.jsonb_typeof(item->'proofKind')<>'string' OR pg_catalog.jsonb_typeof(item->'connectorId') NOT IN ('string','null') OR pg_catalog.jsonb_typeof(item->'provider') NOT IN ('string','null')
      OR item->>'method' NOT IN ('cash','pix','credit','debit','voucher','store_credit') OR item->>'proofKind' NOT IN ('cash','value','intent','manual')
      OR (item->>'method'<>'credit' AND item->>'installments'<>'1')
      OR item->>'proofKind'='manual'
      OR (item->>'proofKind'='cash' AND (item->>'method'<>'cash' OR item->'connectorId'<>'null'::jsonb OR item->'provider'<>'null'::jsonb))
      OR (item->>'proofKind'='value' AND (item->>'method'<>'store_credit' OR item->'connectorId'<>'null'::jsonb OR item->'provider'<>'null'::jsonb))
      OR (item->>'proofKind'='intent' AND (item->>'method' NOT IN ('pix','credit','debit','voucher') OR item->'connectorId'='null'::jsonb OR item->'provider'='null'::jsonb))
      OR (item->'connectorId'<>'null'::jsonb AND NOT public."pos_manual_t2_subject_safe_v1"(item->>'connectorId'))
      OR (item->'provider'<>'null'::jsonb AND NOT public."pos_manual_t2_subject_safe_v1"(item->>'provider')) THEN RAISE EXCEPTION 'invalid payment slot transport' USING ERRCODE='22023'; END IF;
 END LOOP;
 IF p_action='activate' AND (SELECT count(DISTINCT value->>'paymentIndex') FROM pg_catalog.jsonb_array_elements(p_target_slots) value)<>pg_catalog.jsonb_array_length(p_target_slots) THEN RAISE EXCEPTION 'payment slot multiplicity is invalid' USING ERRCODE='22023'; END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('planId',p_plan_id,'lineIndex',(value->>'lineIndex')::integer,'heldSaleItemId',(value->>'heldSaleItemId')::integer,'productId',(value->>'productId')::integer,'variationId',CASE WHEN value->'variationId'='null'::jsonb THEN NULL ELSE (value->>'variationId')::integer END,'quantityFloat8Hex',public."pos_manual_t2_float8_hex_v1"((value->>'quantity')::double precision),'unitPriceCents',(value->>'unitPriceCents')::integer,'grossCents',(value->>'grossCents')::integer,'baseDiscountCents',(value->>'baseDiscountCents')::integer,'orderDiscountCents',(value->>'orderDiscountCents')::integer,'promotionDiscountCents',(value->>'promotionDiscountCents')::integer,'surchargeCents',(value->>'surchargeCents')::integer,'totalCents',(value->>'totalCents')::integer) ORDER BY (value->>'lineIndex')::integer),'[]'::jsonb) INTO line_docs FROM pg_catalog.jsonb_array_elements(p_target_quote_lines) value;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('planId',p_plan_id,'paymentIndex',(value->>'paymentIndex')::integer,'method',value->>'method','amountCents',(value->>'amountCents')::integer,'installments',(value->>'installments')::integer,'proofKind',value->>'proofKind','connectorId',value->'connectorId','provider',value->'provider') ORDER BY (value->>'paymentIndex')::integer),'[]'::jsonb) INTO slot_docs FROM pg_catalog.jsonb_array_elements(p_target_slots) value;
 IF NOT public."pos_manual_t2_canonical_text_dlp_safe_v1"(public."pos_manual_canonical_json_v1"(pg_catalog.jsonb_build_object(
   'action',p_action,'planId',p_plan_id,'expectedVersion',p_expected_version,'actorUserId',p_actor_user_id,'idempotencyKey',p_idempotency_key,
   'targetPlan',p_target_plan,'quoteLines',line_docs,'slots',slot_docs))) THEN
   RAISE EXCEPTION 'payment plan graph transport is DLP-unsafe' USING ERRCODE='22023';
 END IF;
 RETURN pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('t2-payment-plan-graph-request-v1','UTF8')||pg_catalog.decode('00','hex')||pg_catalog.convert_to(pg_catalog.current_database(),'UTF8')||pg_catalog.decode('00','hex')||pg_catalog.convert_to(session_user,'UTF8')||pg_catalog.decode('00','hex')||pg_catalog.convert_to(public."pos_manual_canonical_json_v1"(pg_catalog.jsonb_build_object('action',p_action,'planId',p_plan_id,'expectedVersion',p_expected_version,'actorUserId',p_actor_user_id,'idempotencyKey',p_idempotency_key,'targetPlan',p_target_plan,'quoteLines',line_docs,'slots',slot_docs)),'UTF8')),'hex');
END
$function$;

-- One SQL-owned snapshot contract for draftRequestHash. Its float fields are
-- represented as float8 hex, so it remains stable across JSON producers.
CREATE FUNCTION public."pos_manual_t2_payment_plan_draft_snapshot_hash_v1"(p_held_sale_id text)
RETURNS text LANGUAGE plpgsql STABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE draft_row public."pos_held_sales"%ROWTYPE; snapshot jsonb;
BEGIN
 SELECT * INTO draft_row FROM public."pos_held_sales" WHERE id=p_held_sale_id;
 IF draft_row.id IS NULL THEN RAISE EXCEPTION 'payment plan draft snapshot is absent' USING ERRCODE='23514'; END IF;
 SELECT pg_catalog.jsonb_build_object('id',draft_row.id,'registerId',draft_row.register_id,'sessionId',draft_row.session_id,'operatorProfileId',draft_row.operator_profile_id,
   'customerId',draft_row.customer_id,'notes',draft_row.notes,'discountCents',draft_row.discount_cents,'surchargeCents',draft_row.surcharge_cents,
   'revision',draft_row.revision,'status',draft_row.status,'items',COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('productId',item.product_id,'variationId',item.variation_id,
     'quantityFloat8Hex',public."pos_manual_t2_float8_hex_v1"(item.quantity),'unitPriceCents',item.unit_price_cents,'discountCents',item.discount_cents,'scanData',item.scan_data) ORDER BY item.id),'[]'::jsonb))
   INTO snapshot FROM public."pos_held_sale_items" item WHERE item.held_sale_id=draft_row.id;
 RETURN pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('t2-payment-plan-draft-snapshot-v1','UTF8')||pg_catalog.decode('00','hex')||pg_catalog.convert_to(public."pos_manual_canonical_json_v1"(snapshot),'UTF8')),'hex');
END
$function$;

CREATE FUNCTION public."pos_manual_prepare_payment_plan_graph_write_v1"(
 p_action text,p_plan_id text,p_expected_version integer,p_actor_user_id text,p_idempotency_key text,p_request_hash text,
 p_target_plan jsonb,p_target_quote_lines jsonb,p_target_slots jsonb)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE computed_hash text; core_target_plan jsonb; now_at timestamp(3):=pg_catalog.transaction_timestamp()::timestamp(3); claim_deadline timestamp(3);
BEGIN
 computed_hash:=public."pos_manual_t2_payment_plan_graph_request_hash_v1"(p_action,p_plan_id,p_expected_version,p_actor_user_id,p_idempotency_key,p_target_plan,p_target_quote_lines,p_target_slots);
 IF p_request_hash IS DISTINCT FROM computed_hash THEN RAISE EXCEPTION 'payment plan graph request hash mismatch' USING ERRCODE='23514'; END IF;
 IF p_action='quote' AND p_target_plan->'orderClaimId'<>'null'::jsonb THEN
   SELECT lease_expires_at::timestamp(3) INTO claim_deadline FROM public."pos_order_claims" WHERE id=p_target_plan->>'orderClaimId';
   IF claim_deadline IS NULL OR claim_deadline<=now_at THEN RAISE EXCEPTION 'payment plan quote claim lease is unavailable' USING ERRCODE='23514'; END IF;
 END IF;
 core_target_plan:=CASE WHEN p_action='quote' THEN p_target_plan||pg_catalog.jsonb_build_object('idempotencyKey',p_idempotency_key,'requestHash',p_request_hash,'draftRequestHash',public."pos_manual_t2_payment_plan_draft_snapshot_hash_v1"(p_target_plan->>'saleDraftId'),'evaluatedAt',now_at,'expiresAt',LEAST(now_at+interval '120 seconds',COALESCE(claim_deadline,now_at+interval '120 seconds'))) ELSE p_target_plan END;
 PERFORM public."pos_manual_prepare_payment_plan_graph_write_core_v1"(p_action,p_plan_id,p_expected_version,p_actor_user_id,p_idempotency_key,p_request_hash,core_target_plan,p_target_quote_lines,p_target_slots);
END
$function$;

CREATE OR REPLACE FUNCTION public."protect_pos_payment_plan_operation"() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE doc jsonb;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'pos payment plan operations are append-only' USING ERRCODE='23514'; END IF;
 NEW.write_txid:=pg_catalog.txid_current()::numeric; NEW.created_at:=pg_catalog.transaction_timestamp();
 doc:=pg_catalog.jsonb_build_object('planId',NEW.plan_id,'action',NEW.action,'expectedVersion',NEW.expected_version,'resultingVersion',NEW.resulting_version,'resultingState',NEW.resulting_state,
  'idempotencyKey',NEW.idempotency_key,'requestHash',NEW.request_hash,'actorUserId',NEW.actor_user_id,'saleId',NEW.sale_id,'writeTxid',NEW.write_txid,'createdAt',NEW.created_at);
 PERFORM public."pos_manual_t2_observe_write_v1"('payment_plan_graph:operation','payment_plan',NEW.plan_id,NEW.action,'pos_payment_plan_operations_insert_guard','INSERT',NULL,doc); RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public."protect_pos_payment_plan_quote_line"() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE doc jsonb;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'pos payment plan quote lines are immutable' USING ERRCODE='23514'; END IF; NEW.created_at:=pg_catalog.transaction_timestamp();
 doc:=pg_catalog.jsonb_build_object('planId',NEW.plan_id,'lineIndex',NEW.line_index,'heldSaleItemId',NEW.held_sale_item_id,'productId',NEW.product_id,'variationId',NEW.variation_id,
  'quantityFloat8Hex',public."pos_manual_t2_float8_hex_v1"(NEW.quantity),'unitPriceCents',NEW.unit_price_cents,'grossCents',NEW.gross_cents,'baseDiscountCents',NEW.base_discount_cents,
  'orderDiscountCents',NEW.order_discount_cents,'promotionDiscountCents',NEW.promotion_discount_cents,'surchargeCents',NEW.surcharge_cents,'totalCents',NEW.total_cents,'createdAt',NEW.created_at);
 PERFORM public."pos_manual_t2_observe_write_v1"('payment_plan_graph:quote_lines','payment_plan',NEW.plan_id,'quote','pos_payment_plan_quote_lines_immutable_guard','INSERT',NULL,doc); RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public."protect_pos_payment_plan_slot"() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE doc jsonb;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'pos payment plan slots are immutable' USING ERRCODE='23514'; END IF; NEW.created_at:=pg_catalog.transaction_timestamp();
 doc:=pg_catalog.jsonb_build_object('planId',NEW.plan_id,'paymentIndex',NEW.payment_index,'method',NEW.method,'amountCents',NEW.amount_cents,'installments',NEW.installments,
  'proofKind',NEW.proof_kind,'connectorId',NEW.connector_id,'credentialRef',NEW.credential_ref,'provider',NEW.provider,'createdAt',NEW.created_at);
 PERFORM public."pos_manual_t2_observe_write_v1"('payment_plan_graph:slots','payment_plan',NEW.plan_id,'activate','pos_payment_plan_slots_immutable_guard','INSERT',NULL,doc); RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public."validate_pos_payment_plan_activation"() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE action_name text; old_doc jsonb; new_doc jsonb;
BEGIN
 action_name:=CASE WHEN OLD.state='quoted' AND NEW.state='active' THEN 'activate' WHEN OLD.state='active' AND NEW.state='consumed' THEN 'consume' ELSE NULL END;
 IF action_name IS NULL THEN RETURN NEW; END IF; old_doc:=public."pos_manual_t2_plan_transition_projection_v1"(OLD);
 NEW.lifecycle_txid:=pg_catalog.txid_current()::numeric; NEW.updated_at:=pg_catalog.transaction_timestamp();
 IF action_name='activate' THEN NEW.activated_at:=pg_catalog.transaction_timestamp(); ELSE NEW.consumed_at:=pg_catalog.transaction_timestamp(); END IF;
 new_doc:=public."pos_manual_t2_plan_transition_projection_v1"(NEW);
 PERFORM public."pos_manual_t2_observe_write_v1"('payment_plan_graph:plan_transition','payment_plan',NEW.id,action_name,'pos_payment_plans_activation_guard','UPDATE',old_doc,new_doc); RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public."protect_pos_payment_plan"() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE action_name text; old_doc jsonb; new_doc jsonb;
BEGIN
 IF TG_OP='INSERT' THEN action_name:='quote'; NEW.state:='quoted'; NEW.version:=0; NEW.lifecycle_txid:=pg_catalog.txid_current()::numeric;
  NEW.created_at:=pg_catalog.transaction_timestamp(); NEW.updated_at:=pg_catalog.transaction_timestamp(); old_doc:=NULL; new_doc:=public."pos_manual_t2_plan_quote_projection_v1"(NEW);
 ELSE action_name:=CASE WHEN OLD.state='quoted' AND NEW.state='active' THEN 'activate' WHEN OLD.state='active' AND NEW.state='consumed' THEN 'consume'
   WHEN NEW.state='superseded' AND OLD.state IN ('quoted','active') THEN 'supersede' WHEN NEW.state='expired' AND OLD.state IN ('quoted','active') THEN 'expire' ELSE NULL END;
  IF action_name IS NULL OR NEW.version<>OLD.version+1 OR ROW(NEW.branch_id,NEW.register_id,NEW.session_id,NEW.operator_profile_id,NEW.terminal_id,NEW.sale_draft_id,NEW.draft_revision,NEW.draft_request_hash,NEW.draft_status,NEW.order_claim_id,NEW.quote_hash,NEW.promotion_id,NEW.coupon_id,NEW.promotion_discount_cents,NEW.evaluated_at,NEW.expires_at,NEW.currency,NEW.total_cents,NEW.idempotency_key,NEW.request_hash,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.branch_id,OLD.register_id,OLD.session_id,OLD.operator_profile_id,OLD.terminal_id,OLD.sale_draft_id,OLD.draft_revision,OLD.draft_request_hash,OLD.draft_status,OLD.order_claim_id,OLD.quote_hash,OLD.promotion_id,OLD.coupon_id,OLD.promotion_discount_cents,OLD.evaluated_at,OLD.expires_at,OLD.currency,OLD.total_cents,OLD.idempotency_key,OLD.request_hash,OLD.created_at)
   THEN RAISE EXCEPTION 'invalid pos payment plan transition' USING ERRCODE='23514'; END IF;
  old_doc:=public."pos_manual_t2_plan_transition_projection_v1"(OLD); NEW.lifecycle_txid:=pg_catalog.txid_current()::numeric; NEW.updated_at:=pg_catalog.transaction_timestamp();
  IF action_name='activate' THEN NEW.activated_at:=pg_catalog.transaction_timestamp(); ELSIF action_name='consume' THEN NEW.consumed_at:=pg_catalog.transaction_timestamp();
  ELSIF action_name='supersede' THEN NEW.superseded_at:=pg_catalog.transaction_timestamp(); ELSE NEW.expired_at:=pg_catalog.transaction_timestamp(); END IF;
  new_doc:=public."pos_manual_t2_plan_transition_projection_v1"(NEW);
 END IF;
 PERFORM public."pos_manual_t2_observe_write_v1"('payment_plan_graph:plan_transition','payment_plan',NEW.id,action_name,'pos_payment_plans_immutable_guard',TG_OP,old_doc,new_doc); RETURN NEW;
END $function$;

-- Rebind with literal identities; UPDATE/DELETE on operation/children remain
-- append-only through the same pure functions and never consume a write root.
DROP TRIGGER "pos_payment_plans_activation_guard" ON public."pos_payment_plans";
DROP TRIGGER "pos_payment_plans_immutable_guard" ON public."pos_payment_plans";
DROP TRIGGER "pos_payment_plan_slots_immutable_guard" ON public."pos_payment_plan_slots";
DROP TRIGGER "pos_payment_plan_quote_lines_immutable_guard" ON public."pos_payment_plan_quote_lines";
DROP TRIGGER "pos_payment_plan_operations_insert_guard" ON public."pos_payment_plan_operations";
DROP TRIGGER "pos_payment_plan_operations_immutable_guard" ON public."pos_payment_plan_operations";
CREATE TRIGGER "pos_payment_plans_activation_guard" BEFORE UPDATE ON public."pos_payment_plans" FOR EACH ROW EXECUTE FUNCTION public."validate_pos_payment_plan_activation"();
CREATE TRIGGER "pos_payment_plans_immutable_guard" BEFORE INSERT OR UPDATE ON public."pos_payment_plans" FOR EACH ROW EXECUTE FUNCTION public."protect_pos_payment_plan"();
CREATE TRIGGER "pos_payment_plan_slots_immutable_guard" BEFORE INSERT OR UPDATE OR DELETE ON public."pos_payment_plan_slots" FOR EACH ROW EXECUTE FUNCTION public."protect_pos_payment_plan_slot"();
CREATE TRIGGER "pos_payment_plan_quote_lines_immutable_guard" BEFORE INSERT OR UPDATE OR DELETE ON public."pos_payment_plan_quote_lines" FOR EACH ROW EXECUTE FUNCTION public."protect_pos_payment_plan_quote_line"();
CREATE TRIGGER "pos_payment_plan_operations_insert_guard" BEFORE INSERT ON public."pos_payment_plan_operations" FOR EACH ROW EXECUTE FUNCTION public."protect_pos_payment_plan_operation"();
CREATE TRIGGER "pos_payment_plan_operations_immutable_guard" BEFORE UPDATE OR DELETE ON public."pos_payment_plan_operations" FOR EACH ROW EXECUTE FUNCTION public."protect_pos_payment_plan_operation"();

-- T2-01 order-claim lifecycle. The capability owns every business-table read
-- and lock; both row guards below are deliberately projection-only.
CREATE FUNCTION public."pos_manual_t2_order_claim_projection_v1"(p public."pos_order_claims")
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog AS $function$
 SELECT pg_catalog.jsonb_build_object(
  'id',p.id,'salesOrderId',p.sales_order_id,'branchId',p.branch_id,'registerId',p.register_id,
  'sessionId',p.session_id,'operatorProfileId',p.operator_profile_id,'terminalId',p.terminal_id,
  'state',p.state,'version',p.version,'leaseExpiresAt',p.lease_expires_at,
  'idempotencyKey',p.idempotency_key,'requestHash',p.request_hash,'convertedSaleId',p.converted_sale_id,
  'claimedAt',p.claimed_at,'renewedAt',p.renewed_at,'releasedAt',p.released_at,
  'convertedAt',p.converted_at,'lifecycleTxid',p.lifecycle_txid,'updatedAt',p.updated_at)
$function$;

CREATE FUNCTION public."pos_manual_t2_order_claim_operation_projection_v1"(p public."pos_order_claim_operations")
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog AS $function$
 SELECT pg_catalog.jsonb_build_object(
  'claimId',p.claim_id,'action',p.action,'expectedVersion',p.expected_version,
  'resultingVersion',p.resulting_version,'resultingState',p.resulting_state,
  'idempotencyKey',p.idempotency_key,'requestHash',p.request_hash,
  'leaseExpiresAt',p.lease_expires_at,'writeTxid',p.write_txid,'createdAt',p.created_at)
$function$;

CREATE FUNCTION public."pos_manual_prepare_order_claim_write_v1"(
 p_action text,p_claim_id text,p_session_id integer,p_sales_order_id integer,p_expected_version integer,
 p_actor_user_id text,p_idempotency_key text,p_request_hash text,p_target_claim jsonb)
RETURNS void LANGUAGE plpgsql VOLATILE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
#variable_conflict use_variable
DECLARE
 authority text; now_at timestamp(3):=pg_catalog.transaction_timestamp()::timestamp(3); txid_at numeric:=pg_catalog.txid_current()::numeric;
 lock_key text; lock_keys text[]; target_keys text[]; dml text;
 claim_row public."pos_order_claims"%ROWTYPE; target_row public."pos_order_claims"%ROWTYPE;
 operation_row public."pos_order_claim_operations"%ROWTYPE; old_doc jsonb; new_doc jsonb; operation_doc jsonb;
 branch_id integer; register_id integer; profile_id integer; terminal_id text; converted_sale_id integer;
BEGIN
 IF p_action NOT IN ('claim','renew','release','expire','convert')
   OR p_claim_id<>pg_catalog.normalize(p_claim_id) OR pg_catalog.octet_length(p_claim_id) NOT BETWEEN 16 AND 128 OR p_claim_id~'[[:cntrl:]]'
   OR p_actor_user_id<>pg_catalog.normalize(p_actor_user_id) OR pg_catalog.octet_length(p_actor_user_id) NOT BETWEEN 1 AND 160 OR p_actor_user_id~'[[:cntrl:]]'
   OR p_idempotency_key<>pg_catalog.normalize(p_idempotency_key) OR pg_catalog.char_length(p_idempotency_key) NOT BETWEEN 8 AND 160 OR p_idempotency_key~'[[:cntrl:]]'
   OR p_request_hash!~'^[0-9a-f]{64}$' OR p_expected_version<0 OR pg_catalog.jsonb_typeof(p_target_claim)<>'object'
 THEN RAISE EXCEPTION 'invalid order-claim capability transport' USING ERRCODE='22023'; END IF;
 IF (p_action='expire') IS DISTINCT FROM (p_actor_user_id='system:pos-order-claim-expiry') THEN
   RAISE EXCEPTION 'order-claim expiry is system-only' USING ERRCODE='22023'; END IF;

 -- Every namespace is acquired before the first business-table read.
 lock_keys:=ARRAY[
  'pos-order-claim:v1:claim:'||p_claim_id,
  'pos-order-claim:v1:order:'||p_sales_order_id::text,
  'pos-order-claim:v1:artifacts:'||p_claim_id,
  'pos-order-claim:v1:operation:'||p_claim_id||':'||p_action||':'||p_expected_version::text,
  'pos-order-claim:v1:idempotency:'||p_idempotency_key];
 FOR lock_key IN SELECT value FROM pg_catalog.unnest(lock_keys) value ORDER BY value COLLATE "C" LOOP
   PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(lock_key,0));
 END LOOP;
 authority:=public."pos_manual_t2_authority_v1"('runtime');

 target_keys:=(SELECT pg_catalog.array_agg(key ORDER BY key COLLATE "C") FROM pg_catalog.jsonb_object_keys(p_target_claim) key);
 IF p_action='claim' THEN
   IF target_keys IS DISTINCT FROM ARRAY['branchId','id','idempotencyKey','operatorProfileId','registerId','requestHash','salesOrderId','sessionId','state','terminalId','version']::text[]
     OR pg_catalog.jsonb_typeof(p_target_claim->'id')<>'string' OR pg_catalog.jsonb_typeof(p_target_claim->'state')<>'string'
     OR pg_catalog.jsonb_typeof(p_target_claim->'terminalId')<>'string' OR pg_catalog.jsonb_typeof(p_target_claim->'idempotencyKey')<>'string'
     OR pg_catalog.jsonb_typeof(p_target_claim->'requestHash')<>'string'
     OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['salesOrderId','branchId','registerId','sessionId','operatorProfileId','version']) numeric_key
       WHERE pg_catalog.jsonb_typeof(p_target_claim->numeric_key)<>'number' OR p_target_claim->>numeric_key!~'^(0|[1-9][0-9]{0,9})$'
         OR (p_target_claim->>numeric_key)::numeric>2147483647)
     OR p_target_claim->>'id' IS DISTINCT FROM p_claim_id OR (p_target_claim->>'salesOrderId')::integer<>p_sales_order_id
     OR (p_target_claim->>'sessionId')::integer<>p_session_id OR (p_target_claim->>'version')::integer<>0
     OR p_expected_version<>0 OR p_target_claim->>'state'<>'active'
     OR p_idempotency_key IS DISTINCT FROM (p_target_claim->>'idempotencyKey')||':claim'
     OR p_target_claim->>'requestHash' IS DISTINCT FROM p_request_hash
   THEN RAISE EXCEPTION 'order-claim claim target mismatch' USING ERRCODE='22023'; END IF;
   branch_id:=(p_target_claim->>'branchId')::integer; register_id:=(p_target_claim->>'registerId')::integer;
   profile_id:=(p_target_claim->>'operatorProfileId')::integer; terminal_id:=p_target_claim->>'terminalId';
 ELSE
   IF target_keys IS DISTINCT FROM (CASE WHEN p_action='convert' THEN ARRAY['convertedSaleId','id','state','version'] ELSE ARRAY['id','state','version'] END)::text[]
     OR pg_catalog.jsonb_typeof(p_target_claim->'id')<>'string' OR pg_catalog.jsonb_typeof(p_target_claim->'state')<>'string'
     OR pg_catalog.jsonb_typeof(p_target_claim->'version')<>'number' OR p_target_claim->>'version'!~'^(0|[1-9][0-9]{0,9})$'
     OR (p_target_claim->>'version')::numeric>2147483647
     OR (p_action='convert' AND (pg_catalog.jsonb_typeof(p_target_claim->'convertedSaleId')<>'number'
       OR p_target_claim->>'convertedSaleId'!~'^[1-9][0-9]{0,9}$' OR (p_target_claim->>'convertedSaleId')::numeric>2147483647))
     OR p_target_claim->>'id' IS DISTINCT FROM p_claim_id OR (p_target_claim->>'version')::integer<>p_expected_version+1
     OR p_target_claim->>'state' IS DISTINCT FROM (CASE p_action WHEN 'renew' THEN 'active' WHEN 'release' THEN 'released' WHEN 'expire' THEN 'expired' ELSE 'converted' END)
   THEN RAISE EXCEPTION 'order-claim transition target mismatch' USING ERRCODE='22023'; END IF;
 END IF;

 -- Canonical row lock order: session -> terminal -> profile -> branch ->
 -- register -> grants -> sales_order -> claim -> operation -> artifacts.
 IF p_action<>'claim' THEN
   SELECT * INTO claim_row FROM public."pos_order_claims" WHERE id=p_claim_id;
   IF claim_row.id IS NULL OR claim_row.session_id<>p_session_id OR claim_row.sales_order_id<>p_sales_order_id OR claim_row.version<>p_expected_version
   THEN RAISE EXCEPTION 'order-claim binding or version mismatch' USING ERRCODE='40001'; END IF;
   branch_id:=claim_row.branch_id; register_id:=claim_row.register_id; profile_id:=claim_row.operator_profile_id; terminal_id:=claim_row.terminal_id;
 END IF;
 IF p_action<>'expire' THEN
   PERFORM 1 FROM public."cash_register_sessions" session_row WHERE session_row.id=p_session_id FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'order-claim session missing' USING ERRCODE='23503'; END IF;
   PERFORM 1 FROM public."pos_terminals" terminal_row WHERE terminal_row.id=terminal_id FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'order-claim terminal missing' USING ERRCODE='23503'; END IF;
   PERFORM 1 FROM public."tenant_user_profiles" profile_row WHERE profile_row.id=profile_id FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'order-claim profile missing' USING ERRCODE='23503'; END IF;
   PERFORM 1 FROM public."branches" branch_row WHERE branch_row.id=branch_id FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'order-claim branch missing' USING ERRCODE='23503'; END IF;
   PERFORM 1 FROM public."pos_registers" register_row WHERE register_row.id=register_id FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'order-claim register missing' USING ERRCODE='23503'; END IF;
   PERFORM 1 FROM public."branch_user_accesses" branch_grant WHERE branch_grant.branch_id=branch_id AND branch_grant.user_profile_id=profile_id FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'order-claim branch grant missing' USING ERRCODE='42501'; END IF;
   PERFORM 1 FROM public."pos_register_accesses" register_grant WHERE register_grant.register_id=register_id AND register_grant.user_profile_id=profile_id FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'order-claim register grant missing' USING ERRCODE='42501'; END IF;
 END IF;
 PERFORM 1 FROM public."sales_orders" order_row WHERE order_row.id=p_sales_order_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'order-claim sales order missing' USING ERRCODE='23503'; END IF;

 IF p_action='claim' THEN
   IF EXISTS (SELECT 1 FROM public."pos_order_claims" WHERE id=p_claim_id OR (sales_order_id=p_sales_order_id AND state='active')) THEN
     RAISE EXCEPTION 'order-claim identity is already allocated' USING ERRCODE='23505'; END IF;
 ELSE
   SELECT * INTO claim_row FROM public."pos_order_claims" WHERE id=p_claim_id FOR UPDATE;
   IF claim_row.id IS NULL OR claim_row.session_id<>p_session_id OR claim_row.sales_order_id<>p_sales_order_id OR claim_row.version<>p_expected_version OR claim_row.state<>'active'
   THEN RAISE EXCEPTION 'order-claim lifecycle compare-and-swap failed' USING ERRCODE='40001'; END IF;
 END IF;
 PERFORM 1 FROM public."pos_order_claim_operations" WHERE claim_id=p_claim_id ORDER BY id FOR UPDATE;
 PERFORM 1 FROM public."pos_held_sales" WHERE id=p_claim_id FOR UPDATE;
 PERFORM 1 FROM public."pos_payment_plans" WHERE sale_draft_id=p_claim_id ORDER BY id FOR UPDATE;
 PERFORM 1 FROM public."pos_payment_intents" WHERE sale_draft_id=p_claim_id ORDER BY id FOR UPDATE;
 PERFORM 1 FROM public."pos_manual_payment_references" WHERE sale_draft_id=p_claim_id ORDER BY id FOR UPDATE;

 IF p_action<>'expire' THEN
   PERFORM 1 FROM public."cash_register_sessions" s JOIN public."pos_terminals" t ON t.id=terminal_id
    JOIN public."tenant_user_profiles" u ON u.id=profile_id JOIN public."branches" b ON b.id=branch_id
    JOIN public."pos_registers" r ON r.id=register_id JOIN public."branch_user_accesses" ba ON ba.branch_id=branch_id AND ba.user_profile_id=profile_id
    JOIN public."pos_register_accesses" ra ON ra.register_id=register_id AND ra.user_profile_id=profile_id
    WHERE s.id=p_session_id AND s.register_id=register_id AND s.operator_profile_id=profile_id AND s.status='open'
      AND t.register_id=register_id AND t.status='online' AND t.revoked_at IS NULL AND t.paired_at IS NOT NULL AND t.token_hash IS NOT NULL
      AND t.token_expires_at>now_at AND t.last_seen_at>now_at-interval '5 minutes' AND t.app_version IS NOT NULL
      AND u.status='active' AND b.status='active' AND r.branch_id=branch_id AND r.status='active' AND ba.can_sell
      AND ra.active AND ra.can_sell AND (ra.valid_from IS NULL OR ra.valid_from<=now_at) AND (ra.valid_until IS NULL OR ra.valid_until>now_at);
   IF NOT FOUND THEN RAISE EXCEPTION 'order-claim live POS boundary is not valid' USING ERRCODE='42501'; END IF;
 END IF;
 IF p_action IN ('claim','renew','convert') AND p_action<>'claim' AND claim_row.lease_expires_at<=now_at THEN
   RAISE EXCEPTION 'order-claim lease is not live' USING ERRCODE='40001'; END IF;
 IF p_action='expire' AND claim_row.lease_expires_at>now_at THEN
   RAISE EXCEPTION 'order-claim lease has not expired' USING ERRCODE='40001'; END IF;
 IF p_action IN ('release','expire') AND (
   EXISTS (SELECT 1 FROM public."pos_payment_plans" plan_row WHERE plan_row.sale_draft_id=p_claim_id AND plan_row.state IN ('quoted','active'))
   OR
   EXISTS (SELECT 1 FROM public."pos_payment_intents" WHERE sale_draft_id=p_claim_id AND consumed_at IS NULL AND status IN ('created','processing','authorized','captured','partially_refunded','unknown','manual_review'))
   OR EXISTS (SELECT 1 FROM public."pos_manual_payment_references" WHERE sale_draft_id=p_claim_id AND consumed_sale_payment_id IS NULL AND status='pending')
 ) THEN RAISE EXCEPTION 'financial evidence blocks order-claim release' USING ERRCODE='23514'; END IF;

 IF p_action='claim' THEN
   PERFORM 1 FROM public."sales_orders" o WHERE o.id=p_sales_order_id AND o.branch_id=branch_id AND o.kind='order' AND o.status='approved' AND o.deleted_at IS NULL;
   IF NOT FOUND OR EXISTS (SELECT 1 FROM public."sales" WHERE source_type='sales_order' AND source_id=p_sales_order_id::text)
    OR EXISTS (SELECT 1 FROM public."shipments" WHERE sales_order_id=p_sales_order_id)
    OR EXISTS (SELECT 1 FROM public."order_tracking" WHERE sales_order_id=p_sales_order_id)
    OR EXISTS (SELECT 1 FROM public."order_shipping_labels" WHERE sales_order_id=p_sales_order_id AND status<>'cancelled')
   THEN RAISE EXCEPTION 'sales order is not claimable' USING ERRCODE='23514'; END IF;
   target_row.id:=p_claim_id; target_row.sales_order_id:=p_sales_order_id; target_row.branch_id:=branch_id; target_row.register_id:=register_id;
   target_row.session_id:=p_session_id; target_row.operator_profile_id:=profile_id; target_row.terminal_id:=terminal_id;
   target_row.state:='active'; target_row.version:=0; target_row.lease_expires_at:=now_at+interval '120 seconds';
   target_row.idempotency_key:=p_target_claim->>'idempotencyKey'; target_row.request_hash:=p_request_hash;
   target_row.claimed_at:=now_at; target_row.lifecycle_txid:=txid_at; target_row.updated_at:=now_at;
   old_doc:=NULL; dml:='INSERT';
 ELSE
   target_row:=claim_row; target_row.version:=p_expected_version+1; target_row.lifecycle_txid:=txid_at; target_row.updated_at:=now_at; dml:='UPDATE';
   IF p_action='renew' THEN target_row.lease_expires_at:=now_at+interval '120 seconds'; target_row.renewed_at:=now_at;
   ELSIF p_action IN ('release','expire') THEN target_row.state:=CASE p_action WHEN 'release' THEN 'released' ELSE 'expired' END; target_row.released_at:=now_at;
   ELSE
     converted_sale_id:=(p_target_claim->>'convertedSaleId')::integer;
     PERFORM 1 FROM public."sales" converted_sale WHERE converted_sale.id=converted_sale_id AND converted_sale.branch_id=branch_id
       AND converted_sale.session_id=p_session_id AND converted_sale.operator_profile_id=profile_id
       AND converted_sale.source_type='sales_order' AND converted_sale.source_id=p_sales_order_id::text AND converted_sale.source_creation_txid=txid_at FOR UPDATE;
     IF NOT FOUND THEN RAISE EXCEPTION 'converted sale is not exact current-transaction cause' USING ERRCODE='23514'; END IF;
     target_row.state:='converted'; target_row.converted_sale_id:=converted_sale_id; target_row.converted_at:=now_at;
   END IF;
   old_doc:=public."pos_manual_t2_order_claim_projection_v1"(claim_row);
 END IF;
 new_doc:=public."pos_manual_t2_order_claim_projection_v1"(target_row);
 operation_row.claim_id:=p_claim_id; operation_row.action:=p_action; operation_row.expected_version:=p_expected_version;
 operation_row.resulting_version:=target_row.version; operation_row.resulting_state:=target_row.state; operation_row.idempotency_key:=p_idempotency_key;
 operation_row.request_hash:=p_request_hash; operation_row.lease_expires_at:=target_row.lease_expires_at; operation_row.write_txid:=txid_at; operation_row.created_at:=now_at;
 operation_doc:=public."pos_manual_t2_order_claim_operation_projection_v1"(operation_row);
 PERFORM public."pos_manual_t2_open_write_root_v1"('order_claim','order_claim',p_claim_id,p_action,'pos_order_claim_identity_guard',dml,authority,
   ARRAY[public."pos_manual_t2_write_observation_digest_v1"('order_claim','order_claim',p_claim_id,p_action,'pos_order_claim_identity_guard',dml,old_doc,new_doc)]);
 PERFORM public."pos_manual_t2_open_write_root_v1"('order_claim:operation','order_claim',p_claim_id,p_action,'pos_order_claim_operations_write_guard','INSERT',authority,
   ARRAY[public."pos_manual_t2_write_observation_digest_v1"('order_claim:operation','order_claim',p_claim_id,p_action,'pos_order_claim_operations_write_guard','INSERT',NULL,operation_doc)]);
END;
$function$;

CREATE OR REPLACE FUNCTION public."enforce_pos_order_claim_identity"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE action_name text; old_doc jsonb; new_doc jsonb; now_at timestamp(3):=pg_catalog.transaction_timestamp()::timestamp(3);
BEGIN
 IF TG_OP='INSERT' THEN
   IF NEW.state<>'active' OR NEW.version<>0 OR NEW.converted_sale_id IS NOT NULL OR NEW.renewed_at IS NOT NULL OR NEW.released_at IS NOT NULL OR NEW.converted_at IS NOT NULL THEN
     RAISE EXCEPTION 'order-claim insert shape is not canonical' USING ERRCODE='42501'; END IF;
   action_name:='claim'; NEW.state:='active'; NEW.version:=0; NEW.lease_expires_at:=now_at+interval '120 seconds';
   NEW.converted_sale_id:=NULL; NEW.claimed_at:=now_at; NEW.renewed_at:=NULL; NEW.released_at:=NULL; NEW.converted_at:=NULL;
   NEW.lifecycle_txid:=pg_catalog.txid_current()::numeric; NEW.updated_at:=now_at; old_doc:=NULL;
 ELSE
   IF ROW(NEW.sales_order_id,NEW.branch_id,NEW.register_id,NEW.session_id,NEW.operator_profile_id,NEW.terminal_id,NEW.idempotency_key,NEW.request_hash,NEW.claimed_at)
      IS DISTINCT FROM ROW(OLD.sales_order_id,OLD.branch_id,OLD.register_id,OLD.session_id,OLD.operator_profile_id,OLD.terminal_id,OLD.idempotency_key,OLD.request_hash,OLD.claimed_at)
      OR OLD.state<>'active' OR NEW.version<>OLD.version+1
   THEN RAISE EXCEPTION 'invalid order-claim identity or compare-and-swap' USING ERRCODE='23514'; END IF;
   action_name:=CASE WHEN NEW.state='active' THEN 'renew' WHEN NEW.state='released' THEN 'release' WHEN NEW.state='expired' THEN 'expire' WHEN NEW.state='converted' THEN 'convert' END;
   IF action_name IS NULL THEN RAISE EXCEPTION 'invalid order-claim transition' USING ERRCODE='23514'; END IF;
   IF action_name='renew' THEN
     IF NEW.converted_sale_id IS DISTINCT FROM OLD.converted_sale_id OR NEW.released_at IS DISTINCT FROM OLD.released_at OR NEW.converted_at IS DISTINCT FROM OLD.converted_at THEN RAISE EXCEPTION 'invalid order-claim renewal' USING ERRCODE='23514'; END IF;
     NEW.lease_expires_at:=now_at+interval '120 seconds'; NEW.renewed_at:=now_at;
   ELSIF action_name IN ('release','expire') THEN
     IF NEW.converted_sale_id IS NOT NULL OR NEW.converted_at IS NOT NULL THEN RAISE EXCEPTION 'invalid order-claim release' USING ERRCODE='23514'; END IF;
     NEW.lease_expires_at:=OLD.lease_expires_at; NEW.renewed_at:=OLD.renewed_at; NEW.released_at:=now_at;
   ELSE
     IF NEW.converted_sale_id IS NULL OR NEW.released_at IS NOT NULL THEN RAISE EXCEPTION 'invalid order-claim conversion' USING ERRCODE='23514'; END IF;
     NEW.lease_expires_at:=OLD.lease_expires_at; NEW.renewed_at:=OLD.renewed_at; NEW.converted_at:=now_at;
   END IF;
   NEW.lifecycle_txid:=pg_catalog.txid_current()::numeric; NEW.updated_at:=now_at;
   old_doc:=public."pos_manual_t2_order_claim_projection_v1"(OLD);
 END IF;
 new_doc:=public."pos_manual_t2_order_claim_projection_v1"(NEW);
 BEGIN
   PERFORM public."pos_manual_t2_observe_write_v1"('order_claim','order_claim',NEW.id,action_name,'pos_order_claim_identity_guard',TG_OP,old_doc,new_doc);
 EXCEPTION WHEN check_violation OR no_data_found OR too_many_rows THEN
   RAISE EXCEPTION 'order-claim write requires its exact capability root' USING ERRCODE='42501';
 END;
 RETURN NEW;
END $function$;

CREATE FUNCTION public."protect_pos_order_claim_operation"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE doc jsonb;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'order-claim operation is append-only' USING ERRCODE='23514'; END IF;
 NEW.write_txid:=pg_catalog.txid_current()::numeric; NEW.created_at:=pg_catalog.transaction_timestamp()::timestamp(3);
 doc:=public."pos_manual_t2_order_claim_operation_projection_v1"(NEW);
 BEGIN
   PERFORM public."pos_manual_t2_observe_write_v1"('order_claim:operation','order_claim',NEW.claim_id,NEW.action,'pos_order_claim_operations_write_guard','INSERT',NULL,doc);
 EXCEPTION WHEN check_violation OR no_data_found OR too_many_rows THEN
   RAISE EXCEPTION 'order-claim operation requires its exact capability root' USING ERRCODE='42501';
 END;
 RETURN NEW;
END $function$;

DROP TRIGGER "pos_order_claims_operation_ledger_guard" ON public."pos_order_claims";
DROP TRIGGER "pos_order_claim_operations_claim_state_guard" ON public."pos_order_claim_operations";
DROP TRIGGER "pos_order_claim_identity_guard" ON public."pos_order_claims";
DROP TRIGGER "pos_order_claim_operations_txid_guard" ON public."pos_order_claim_operations";
CREATE TRIGGER "pos_order_claim_identity_guard" BEFORE INSERT OR UPDATE ON public."pos_order_claims"
 FOR EACH ROW EXECUTE FUNCTION public."enforce_pos_order_claim_identity"();
CREATE TRIGGER "pos_order_claim_operations_write_guard" BEFORE INSERT ON public."pos_order_claim_operations"
 FOR EACH ROW EXECUTE FUNCTION public."protect_pos_order_claim_operation"();

-- Intent writer: provider evidence is committed only as hashes/last-four in
-- roots and observations.  Raw provider references never enter T2 state.
CREATE FUNCTION public."pos_manual_t2_payment_intent_projection_v1"(p public."pos_payment_intents")
RETURNS jsonb LANGUAGE sql STABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
 SELECT pg_catalog.jsonb_build_object('id',p.id,'branchId',p.branch_id,'registerId',p.register_id,'sessionId',p.session_id,
 'operatorProfileId',p.operator_profile_id,'terminalId',p.terminal_id,'connectorId',p.connector_id,'credentialRef',p.credential_ref,
 'saleDraftId',p.sale_draft_id,'paymentPlanId',p.payment_plan_id,'paymentIndex',p.payment_index,'status',p.status,'version',p.version,
 'amountCents',p.amount_cents,'currency',p.currency,'method',p.method,'installments',p.installments,'provider',p.provider,
 'commitments',pg_catalog.jsonb_build_object('v0',CASE WHEN p.provider_reference IS NULL THEN NULL ELSE pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.provider_reference,'UTF8')),'hex') END,
  'v1',CASE WHEN p.transaction_id IS NULL THEN NULL ELSE pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.transaction_id,'UTF8')),'hex') END,
  'v2',CASE WHEN p.end_to_end_id IS NULL THEN NULL ELSE pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.end_to_end_id,'UTF8')),'hex') END,
  'v3',CASE WHEN p.nsu IS NULL THEN NULL ELSE pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.nsu,'UTF8')),'hex') END,
  'v4',CASE WHEN p.authorization_code IS NULL THEN NULL ELSE pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.authorization_code,'UTF8')),'hex') END,
  'v5',CASE WHEN p.evidence_id IS NULL THEN NULL ELSE pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.evidence_id,'UTF8')),'hex') END,
  'v6',CASE WHEN p.failure_message IS NULL THEN NULL ELSE pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.failure_message,'UTF8')),'hex') END),
 'cardBrand',p.card_brand,'cardLastFour',p.card_last_four,'failureCode',p.failure_code,
 'providerSequence',p.provider_sequence,'providerOccurredAt',p.provider_occurred_at,'unknownSince',p.unknown_since,'nextReconcileAt',p.next_reconcile_at,
 'expiresAt',p.expires_at,'idempotencyKey',p.idempotency_key,'requestHash',p.request_hash,'consumedAt',p.consumed_at,
 'lifecycleTxid',p.lifecycle_txid,'createdAt',p.created_at,'updatedAt',p.updated_at)
$function$;

CREATE FUNCTION public."pos_manual_t2_payment_intent_target_keys_v1"(p_target jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
 SELECT public."pos_manual_t2_json_keys_exact_v1"(p_target,ARRAY['id','branch_id','register_id','session_id','operator_profile_id','terminal_id','connector_id','credential_ref','sale_draft_id','payment_plan_id','payment_index','status','version','amount_cents','currency','method','installments','provider','provider_reference','transaction_id','end_to_end_id','nsu','authorization_code','card_brand','card_last_four','evidence_id','failure_code','failure_message','provider_sequence','provider_occurred_at','unknown_since','next_reconcile_at','expires_at','idempotency_key','request_hash','consumed_at'])
$function$;

CREATE FUNCTION public."pos_manual_t2_payment_intent_transport_projection_v1"(p_target jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE row_value public."pos_payment_intents"%ROWTYPE;
BEGIN
 BEGIN row_value:=pg_catalog.jsonb_populate_record(NULL::public."pos_payment_intents",p_target); EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RAISE EXCEPTION 'payment intent transport types are invalid' USING ERRCODE='22023'; END;
 RETURN public."pos_manual_t2_payment_intent_projection_v1"(row_value)-ARRAY['lifecycleTxid','createdAt','updatedAt'];
END $function$;

CREATE FUNCTION public."pos_manual_t2_payment_intent_request_hash_v1"(
 p_action text,p_intent_id text,p_expected_version integer,p_actor_user_id text,p_idempotency_key text,p_target jsonb)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE material jsonb;
BEGIN
 IF p_action NOT IN ('create','retry','apply_delivery','apply_callback','cancel_before_dispatch','expire_before_dispatch','schedule_reconcile','force_manual_review','consume')
   OR p_expected_version<0 OR NOT public."pos_manual_t2_subject_safe_v1"(p_intent_id) OR NOT public."pos_manual_t2_subject_safe_v1"(p_actor_user_id)
   OR pg_catalog.octet_length(p_idempotency_key) NOT BETWEEN 16 AND 160 OR p_idempotency_key!~'^[A-Za-z0-9._:-]+$'
   OR NOT public."pos_manual_t2_payment_intent_target_keys_v1"(p_target) OR p_target->>'id' IS DISTINCT FROM p_intent_id
   OR pg_catalog.jsonb_typeof(p_target->'payment_plan_id')<>'string' OR pg_catalog.jsonb_typeof(p_target->'payment_index')<>'number'
   OR pg_catalog.jsonb_typeof(p_target->'version')<>'number' OR pg_catalog.jsonb_typeof(p_target->'status')<>'string' THEN
   RAISE EXCEPTION 'invalid payment intent preview shape' USING ERRCODE='22023'; END IF;
 material:=pg_catalog.jsonb_build_object('action',p_action,'intentId',p_intent_id,'expectedVersion',p_expected_version,'actorUserId',p_actor_user_id,'idempotencyKey',p_idempotency_key,'target',public."pos_manual_t2_payment_intent_transport_projection_v1"(p_target));
 IF NOT public."pos_manual_t2_canonical_text_dlp_safe_v1"(public."pos_manual_canonical_json_v1"(material)) THEN RAISE EXCEPTION 'payment intent preview is DLP-unsafe' USING ERRCODE='22023'; END IF;
 RETURN pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('t2-payment-intent-request-v1','UTF8')||pg_catalog.decode('00','hex')||pg_catalog.convert_to(pg_catalog.current_database(),'UTF8')||pg_catalog.decode('00','hex')||pg_catalog.convert_to(session_user,'UTF8')||pg_catalog.decode('00','hex')||pg_catalog.convert_to(public."pos_manual_canonical_json_v1"(material),'UTF8')),'hex');
END $function$;

CREATE FUNCTION public."pos_manual_prepare_payment_intent_write_v1"(
 p_action text,p_intent_id text,p_expected_version integer,p_actor_user_id text,p_idempotency_key text,p_request_hash text,p_target jsonb)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE locator public."pos_payment_intents"%ROWTYPE; plan_row public."pos_payment_plans"%ROWTYPE; claim_row public."pos_order_claims"%ROWTYPE;
 target_row public."pos_payment_intents"%ROWTYPE; old_doc jsonb; new_doc jsonb; authority text; namespace text; now_ts timestamptz:=pg_catalog.transaction_timestamp(); dml text;
BEGIN
 IF (p_action='create' AND p_target->>'idempotency_key' IS DISTINCT FROM p_idempotency_key)
   OR p_request_hash IS DISTINCT FROM public."pos_manual_t2_payment_intent_request_hash_v1"(p_action,p_intent_id,p_expected_version,p_actor_user_id,p_idempotency_key,p_target) THEN
   RAISE EXCEPTION 'payment intent request hash mismatch' USING ERRCODE='23514'; END IF;
 dml:=CASE WHEN p_action='create' THEN 'INSERT' ELSE 'UPDATE' END;
 IF NOT public."pos_manual_t2_write_metadata_valid_v1"('payment_artifact:intent','payment_intent',p_intent_id,p_action,'pos_payment_intents_t2_write_guard',dml) THEN RAISE EXCEPTION 'payment intent action is not allowlisted' USING ERRCODE='22023'; END IF;
 SELECT * INTO locator FROM public."pos_payment_intents" WHERE id=p_intent_id;
 SELECT * INTO plan_row FROM public."pos_payment_plans" WHERE id=p_target->>'payment_plan_id';
 IF plan_row.id IS NULL THEN RAISE EXCEPTION 'payment intent plan locator changed' USING ERRCODE='23514'; END IF;
 IF plan_row.order_claim_id IS NOT NULL THEN SELECT * INTO claim_row FROM public."pos_order_claims" WHERE id=plan_row.order_claim_id; END IF;
 FOR namespace IN SELECT value FROM pg_catalog.unnest(ARRAY['pos-held-sale-items:v1:held-sale:'||plan_row.sale_draft_id,'t2-payment-plan:aggregate:'||plan_row.id,'t2-payment-plan:draft:'||plan_row.sale_draft_id,'t2-payment-intent:'||p_intent_id,'t2-payment-intent:idempotency:'||p_idempotency_key,CASE WHEN plan_row.order_claim_id IS NOT NULL THEN 'pos-order-claim:v1:claim:'||plan_row.order_claim_id END,CASE WHEN plan_row.order_claim_id IS NOT NULL THEN 'pos-order-claim:v1:artifacts:'||plan_row.order_claim_id END,CASE WHEN claim_row.sales_order_id IS NOT NULL THEN 'pos-order-claim:v1:order:'||claim_row.sales_order_id::text END]) value WHERE value IS NOT NULL ORDER BY value COLLATE "C" LOOP PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(namespace,0)); END LOOP;
 PERFORM 1 FROM public."cash_register_sessions" WHERE id=plan_row.session_id FOR UPDATE;
 PERFORM 1 FROM public."pos_terminals" WHERE id=plan_row.terminal_id FOR UPDATE;
 PERFORM 1 FROM public."tenant_user_profiles" WHERE id=plan_row.operator_profile_id FOR SHARE;
 PERFORM 1 FROM public."branches" WHERE id=plan_row.branch_id FOR SHARE;
 PERFORM 1 FROM public."pos_registers" WHERE id=plan_row.register_id FOR SHARE;
 PERFORM 1 FROM public."branch_user_accesses" WHERE branch_id=plan_row.branch_id AND user_profile_id=plan_row.operator_profile_id FOR SHARE;
 PERFORM 1 FROM public."pos_register_accesses" WHERE register_id=plan_row.register_id AND user_profile_id=plan_row.operator_profile_id FOR SHARE;
 IF plan_row.order_claim_id IS NOT NULL THEN PERFORM 1 FROM public."sales_orders" order_row JOIN public."pos_order_claims" claim ON claim.sales_order_id=order_row.id WHERE claim.id=plan_row.order_claim_id FOR UPDATE OF order_row; SELECT * INTO claim_row FROM public."pos_order_claims" WHERE id=plan_row.order_claim_id FOR UPDATE; END IF;
 PERFORM 1 FROM public."pos_held_sales" WHERE id=plan_row.sale_draft_id FOR UPDATE; PERFORM 1 FROM public."pos_held_sale_items" WHERE held_sale_id=plan_row.sale_draft_id ORDER BY id FOR UPDATE;
 PERFORM 1 FROM public."pos_connectors" WHERE id=p_target->>'connector_id' FOR SHARE; PERFORM 1 FROM public."integration_credentials" WHERE id=p_target->>'credential_ref' FOR SHARE; PERFORM 1 FROM public."integration_providers" provider_lock JOIN public."integration_credentials" credential_lock ON credential_lock.provider_id=provider_lock.id WHERE credential_lock.id=p_target->>'credential_ref' FOR SHARE;
 SELECT * INTO plan_row FROM public."pos_payment_plans" WHERE id=plan_row.id FOR UPDATE; PERFORM 1 FROM public."pos_payment_plan_slots" slot_row WHERE slot_row.plan_id=plan_row.id AND slot_row.payment_index=(p_target->>'payment_index')::integer FOR UPDATE;
 SELECT * INTO locator FROM public."pos_payment_intents" WHERE id=p_intent_id FOR UPDATE;
 BEGIN target_row:=pg_catalog.jsonb_populate_record(NULL::public."pos_payment_intents",p_target); EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RAISE EXCEPTION 'payment intent transport types are invalid' USING ERRCODE='22023'; END;
 target_row.lifecycle_txid:=pg_catalog.txid_current()::numeric; target_row.created_at:=CASE WHEN dml='INSERT' THEN now_ts ELSE locator.created_at END; target_row.updated_at:=now_ts;
 IF p_action='create' THEN
   IF locator.id IS NOT NULL OR p_expected_version<>0 OR p_target->>'status'<>'created' OR p_target->>'version'<>'0' OR plan_row.state<>'active' OR plan_row.expires_at<=now_ts OR (p_target->>'expires_at')::timestamptz>plan_row.expires_at
    OR ROW(target_row.provider_reference,target_row.transaction_id,target_row.end_to_end_id,target_row.nsu,target_row.authorization_code,target_row.card_brand,target_row.card_last_four,target_row.evidence_id,target_row.failure_code,target_row.failure_message,target_row.provider_sequence,target_row.provider_occurred_at,target_row.unknown_since,target_row.next_reconcile_at,target_row.consumed_at) IS DISTINCT FROM ROW(NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::bigint,NULL::timestamptz,NULL::timestamptz,NULL::timestamptz,NULL::timestamptz)
    OR NOT EXISTS (SELECT 1 FROM public."pos_payment_plan_slots" slot JOIN public."pos_connectors" connector ON connector.id=p_target->>'connector_id' JOIN public."integration_credentials" credential ON credential.id=p_target->>'credential_ref' JOIN public."integration_providers" provider_row ON provider_row.id=credential.provider_id WHERE slot.plan_id=plan_row.id AND slot.payment_index=(p_target->>'payment_index')::integer AND slot.proof_kind='intent' AND ROW((p_target->>'branch_id')::integer,(p_target->>'register_id')::integer,(p_target->>'session_id')::integer,(p_target->>'operator_profile_id')::integer,p_target->>'terminal_id',p_target->>'sale_draft_id',p_target->>'method',(p_target->>'amount_cents')::integer,(p_target->>'installments')::integer,p_target->>'provider',p_target->>'connector_id',p_target->>'credential_ref') IS NOT DISTINCT FROM ROW(plan_row.branch_id,plan_row.register_id,plan_row.session_id,plan_row.operator_profile_id,plan_row.terminal_id,plan_row.sale_draft_id,slot.method,slot.amount_cents,slot.installments,slot.provider,slot.connector_id,slot.credential_ref) AND connector.status='active' AND connector.credential_ref=p_target->>'credential_ref' AND connector.provider=slot.provider AND connector.branch_id=plan_row.branch_id AND (connector.register_id IS NULL OR connector.register_id=plan_row.register_id) AND connector.type LIKE 'payment%' AND credential.enabled AND credential.provider_id=slot.provider AND provider_row.family='payment' AND CASE WHEN NOT COALESCE(connector.settings ? 'methods',false) OR connector.settings->'methods'='null'::jsonb THEN true WHEN pg_catalog.jsonb_typeof(connector.settings->'methods')<>'array' THEN false ELSE connector.settings->'methods' ? (p_target->>'method') AND NOT EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(connector.settings->'methods') configured_method WHERE pg_catalog.jsonb_typeof(configured_method)<>'string' OR configured_method #>> '{}' NOT IN ('pix','credit','debit','voucher')) END)
    OR NOT EXISTS (SELECT 1 FROM public."cash_register_sessions" session_row JOIN public."pos_terminals" terminal_row ON terminal_row.id=plan_row.terminal_id JOIN public."tenant_user_profiles" profile_row ON profile_row.id=plan_row.operator_profile_id JOIN public."branches" branch_row ON branch_row.id=plan_row.branch_id JOIN public."pos_registers" register_row ON register_row.id=plan_row.register_id AND register_row.branch_id=branch_row.id JOIN public."branch_user_accesses" branch_access ON branch_access.branch_id=branch_row.id AND branch_access.user_profile_id=profile_row.id JOIN public."pos_register_accesses" register_access ON register_access.register_id=register_row.id AND register_access.user_profile_id=profile_row.id WHERE session_row.id=plan_row.session_id AND session_row.register_id=plan_row.register_id AND session_row.operator_profile_id=plan_row.operator_profile_id AND session_row.status='open' AND terminal_row.status='online' AND terminal_row.paired_at IS NOT NULL AND terminal_row.revoked_at IS NULL AND terminal_row.token_hash IS NOT NULL AND terminal_row.token_expires_at>now_ts AND terminal_row.last_seen_at>now_ts-interval '5 minutes' AND NULLIF(btrim(terminal_row.app_version),'') IS NOT NULL AND profile_row.user_id=p_actor_user_id AND profile_row.status='active' AND branch_row.status='active' AND register_row.status='active' AND branch_access.can_sell AND register_access.active AND register_access.can_sell AND (register_access.valid_from IS NULL OR register_access.valid_from<=now_ts) AND (register_access.valid_until IS NULL OR register_access.valid_until>now_ts))
    OR plan_row.order_claim_id IS NOT NULL AND (plan_row.order_claim_id<>plan_row.sale_draft_id OR claim_row.id IS NULL OR claim_row.state<>'active' OR claim_row.lease_expires_at<=now_ts) THEN RAISE EXCEPTION 'payment intent create boundary changed' USING ERRCODE='23514'; END IF;
   old_doc:=NULL;
 ELSE
   IF locator.id IS NULL OR locator.version<>p_expected_version OR target_row.version<>locator.version+1 THEN RAISE EXCEPTION 'payment intent compare-and-swap failed' USING ERRCODE='40001'; END IF;
   IF ROW(target_row.id,target_row.branch_id,target_row.register_id,target_row.session_id,target_row.operator_profile_id,target_row.terminal_id,target_row.connector_id,target_row.credential_ref,target_row.sale_draft_id,target_row.payment_plan_id,target_row.payment_index,target_row.amount_cents,target_row.currency,target_row.method,target_row.installments,target_row.provider,target_row.idempotency_key,target_row.request_hash,target_row.expires_at,target_row.created_at)
      IS DISTINCT FROM ROW(locator.id,locator.branch_id,locator.register_id,locator.session_id,locator.operator_profile_id,locator.terminal_id,locator.connector_id,locator.credential_ref,locator.sale_draft_id,locator.payment_plan_id,locator.payment_index,locator.amount_cents,locator.currency,locator.method,locator.installments,locator.provider,locator.idempotency_key,locator.request_hash,locator.expires_at,locator.created_at) THEN
     RAISE EXCEPTION 'payment intent identity is immutable' USING ERRCODE='55000'; END IF;
   IF locator.provider_reference IS NOT NULL AND target_row.provider_reference IS DISTINCT FROM locator.provider_reference THEN RAISE EXCEPTION 'payment intent provider reference is immutable once bound' USING ERRCODE='55000'; END IF;
   IF locator.consumed_at IS NOT NULL AND target_row.consumed_at IS DISTINCT FROM locator.consumed_at THEN RAISE EXCEPTION 'payment intent consumption is immutable once bound' USING ERRCODE='55000'; END IF;
   IF target_row.provider_sequence IS NOT NULL AND locator.provider_sequence IS NOT NULL AND target_row.provider_sequence<locator.provider_sequence THEN RAISE EXCEPTION 'payment intent provider sequence cannot regress' USING ERRCODE='22000'; END IF;
   IF locator.status<>target_row.status AND NOT ((locator.status='created' AND target_row.status IN ('processing','authorized','captured','declined','unknown','manual_review','cancelled')) OR (locator.status='processing' AND target_row.status IN ('authorized','captured','declined','unknown','manual_review','cancelled')) OR (locator.status='authorized' AND target_row.status IN ('captured','unknown','manual_review','cancelled')) OR (locator.status='unknown' AND target_row.status IN ('processing','authorized','captured','declined','manual_review','cancelled')) OR (locator.status='manual_review' AND target_row.status IN ('processing','authorized','captured','declined','cancelled')) OR (locator.status='captured' AND target_row.status IN ('partially_refunded','refunded')) OR (locator.status='partially_refunded' AND target_row.status IN ('partially_refunded','refunded'))) THEN RAISE EXCEPTION 'invalid payment intent transition' USING ERRCODE='22000'; END IF;
   IF p_action='retry' AND ROW(target_row.status,target_row.provider_reference,target_row.transaction_id,target_row.end_to_end_id,target_row.nsu,target_row.authorization_code,target_row.card_brand,target_row.card_last_four,target_row.evidence_id,target_row.failure_code,target_row.failure_message,target_row.provider_sequence,target_row.provider_occurred_at,target_row.unknown_since,target_row.next_reconcile_at,target_row.consumed_at) IS DISTINCT FROM ROW(locator.status,locator.provider_reference,locator.transaction_id,locator.end_to_end_id,locator.nsu,locator.authorization_code,locator.card_brand,locator.card_last_four,locator.evidence_id,locator.failure_code,locator.failure_message,locator.provider_sequence,locator.provider_occurred_at,locator.unknown_since,locator.next_reconcile_at,locator.consumed_at) THEN RAISE EXCEPTION 'payment intent retry mutates evidence' USING ERRCODE='23514'; END IF;
   IF p_action IN ('cancel_before_dispatch','expire_before_dispatch') AND (locator.status<>'created' OR target_row.status<>'cancelled' OR target_row.failure_code IS DISTINCT FROM CASE WHEN p_action='cancel_before_dispatch' THEN 'operator_cancelled_before_dispatch' ELSE 'expired_before_dispatch' END OR ROW(target_row.provider_reference,target_row.transaction_id,target_row.end_to_end_id,target_row.nsu,target_row.authorization_code,target_row.card_brand,target_row.card_last_four,target_row.evidence_id,target_row.provider_sequence,target_row.provider_occurred_at,target_row.unknown_since,target_row.consumed_at) IS DISTINCT FROM ROW(NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::bigint,NULL::timestamptz,NULL::timestamptz,NULL::timestamptz)) THEN RAISE EXCEPTION 'payment intent cancellation is not pristine' USING ERRCODE='23514'; END IF;
   IF p_action='consume' THEN
     IF locator.status<>'captured' OR locator.consumed_at IS NOT NULL OR p_target->'consumed_at'<>'null'::jsonb THEN RAISE EXCEPTION 'payment intent consume is invalid' USING ERRCODE='23514'; END IF;
     target_row.consumed_at:=now_ts;
   ELSIF p_action='schedule_reconcile' AND ROW(target_row.status,target_row.provider_reference,target_row.transaction_id,target_row.end_to_end_id,target_row.nsu,target_row.authorization_code,target_row.card_brand,target_row.card_last_four,target_row.evidence_id,target_row.failure_code,target_row.failure_message,target_row.provider_sequence,target_row.provider_occurred_at,target_row.unknown_since,target_row.consumed_at) IS DISTINCT FROM ROW(locator.status,locator.provider_reference,locator.transaction_id,locator.end_to_end_id,locator.nsu,locator.authorization_code,locator.card_brand,locator.card_last_four,locator.evidence_id,locator.failure_code,locator.failure_message,locator.provider_sequence,locator.provider_occurred_at,locator.unknown_since,locator.consumed_at) THEN RAISE EXCEPTION 'payment intent reconcile mutates evidence' USING ERRCODE='23514';
   ELSIF p_action='force_manual_review' AND target_row.status<>'manual_review' THEN RAISE EXCEPTION 'payment intent manual-review action is invalid' USING ERRCODE='23514'; END IF;
   old_doc:=public."pos_manual_t2_payment_intent_projection_v1"(locator);
 END IF;
 new_doc:=public."pos_manual_t2_payment_intent_projection_v1"(target_row); authority:=public."pos_manual_t2_authority_v1"('runtime');
 PERFORM public."pos_manual_t2_open_write_root_v1"('payment_artifact:intent','payment_intent',p_intent_id,p_action,'pos_payment_intents_t2_write_guard',dml,authority,ARRAY[public."pos_manual_t2_write_observation_digest_v1"('payment_artifact:intent','payment_intent',p_intent_id,p_action,'pos_payment_intents_t2_write_guard',dml,old_doc,new_doc)]);
END $function$;

CREATE FUNCTION public."pos_manual_t2_payment_intent_root_action_v1"(p_intent_id text,p_dml text)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE action text; n integer;
BEGIN
 SELECT max(root.action),count(*)::integer INTO action,n FROM public."pos_manual_t2_write_roots" root WHERE root.backend_pid=pg_catalog.pg_backend_pid() AND root.transaction_txid=pg_catalog.txid_current()::numeric AND root.capability='payment_artifact:intent' AND root.aggregate_kind='payment_intent' AND root.aggregate_id=p_intent_id AND root.trigger_identity='pos_payment_intents_t2_write_guard' AND root.dml_operation=p_dml;
 IF n<>1 THEN RAISE EXCEPTION 'payment intent has no unique capability root' USING ERRCODE='23514'; END IF;
 RETURN action;
END $function$;

CREATE FUNCTION public."pos_manual_t2_observe_payment_intent_v1"(p_intent_id text,p_action text,p_dml text,p_old jsonb,p_new jsonb)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
 PERFORM public."pos_manual_t2_observe_write_v1"('payment_artifact:intent','payment_intent',p_intent_id,p_action,'pos_payment_intents_t2_write_guard',p_dml,p_old,p_new);
END $function$;

CREATE FUNCTION public."protect_pos_payment_intent_artifact_t2"() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE old_doc jsonb; new_doc jsonb; action text;
BEGIN
 NEW.lifecycle_txid:=pg_catalog.txid_current()::numeric; IF TG_OP='INSERT' THEN NEW.created_at:=pg_catalog.transaction_timestamp(); END IF; NEW.updated_at:=pg_catalog.transaction_timestamp();
 action:=public."pos_manual_t2_payment_intent_root_action_v1"(NEW.id,TG_OP);
 IF action='consume' THEN NEW.consumed_at:=pg_catalog.transaction_timestamp(); END IF;
 old_doc:=CASE WHEN TG_OP='UPDATE' THEN public."pos_manual_t2_payment_intent_projection_v1"(OLD) ELSE NULL END; new_doc:=public."pos_manual_t2_payment_intent_projection_v1"(NEW);
 PERFORM public."pos_manual_t2_observe_payment_intent_v1"(NEW.id,action,TG_OP,old_doc,new_doc); RETURN NEW;
EXCEPTION WHEN check_violation OR no_data_found OR too_many_rows THEN RAISE EXCEPTION 'payment intent write requires its exact T2 capability root' USING ERRCODE='42501'; END $function$;
DROP TRIGGER "pos_payment_intents_authoritative_plan_guard" ON public."pos_payment_intents";
CREATE TRIGGER "pos_payment_intents_t2_write_guard" BEFORE INSERT OR UPDATE ON public."pos_payment_intents" FOR EACH ROW EXECUTE FUNCTION public."protect_pos_payment_intent_artifact_t2"();

-- Manual-reference foundation remains deliberately sealed by the 320000
-- trigger. These entrypoints bind future writes without opening that feature.
CREATE FUNCTION public."pos_manual_t2_manual_reference_projection_v1"(p public."pos_manual_payment_references") RETURNS jsonb LANGUAGE sql STABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
 SELECT pg_catalog.jsonb_build_object('id',p.id,'branchId',p.branch_id,'registerId',p.register_id,'sessionId',p.session_id,'requesterProfileId',p.requester_profile_id,'requesterUserId',p.requester_user_id,'saleDraftId',p.sale_draft_id,'paymentPlanId',p.payment_plan_id,'quoteHash',p.quote_hash,'paymentIndex',p.payment_index,'method',p.method,'amountCents',p.amount_cents,'installments',p.installments,'provider',p.provider,'referenceHash',p.reference_hash,'referenceLastFour',p.reference_last_four,'occurredAt',p.occurred_at,'status',p.status,'approvalId',p.approval_id,'idempotencyKey',p.idempotency_key,'requestHash',p.request_hash,'consumedSalePaymentId',p.consumed_sale_payment_id,'consumedAt',p.consumed_at,'revokedAt',p.revoked_at,'revokedBy',p.revoked_by,'commitment',CASE WHEN p.revoke_reason IS NULL THEN NULL ELSE pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.revoke_reason,'UTF8')),'hex') END,'revokeIdempotencyKey',p.revoke_idempotency_key,'revokeRequestHash',p.revoke_request_hash,'createdAt',p.created_at,'updatedAt',p.updated_at)
$function$;
CREATE FUNCTION public."pos_manual_t2_manual_reference_target_keys_v1"(p_target jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
 SELECT public."pos_manual_t2_json_keys_exact_v1"(p_target,ARRAY['id','branch_id','register_id','session_id','requester_profile_id','requester_user_id','sale_draft_id','payment_plan_id','quote_hash','payment_index','method','amount_cents','installments','provider','reference','reference_hash','reference_last_four','occurred_at','status','approval_id','idempotency_key','request_hash','consumed_sale_payment_id','consumed_at','revoked_at','revoked_by','revoke_reason','revoke_idempotency_key','revoke_request_hash'])
$function$;

CREATE FUNCTION public."pos_manual_t2_manual_reference_request_hash_v1"(p_action text,p_id text,p_expected_plan_version integer,p_actor text,p_key text,p_target jsonb) RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE r public."pos_manual_payment_references"%ROWTYPE; m jsonb;
BEGIN
 IF p_action NOT IN ('create','revoke','consume') OR p_expected_plan_version<0 OR pg_catalog.pg_column_size(p_target) NOT BETWEEN 2 AND 65536 OR NOT public."pos_manual_t2_subject_safe_v1"(p_id) OR NOT public."pos_manual_t2_subject_safe_v1"(p_actor)
    OR pg_catalog.octet_length(p_key) NOT BETWEEN 16 AND 160 OR p_key!~'^[A-Za-z0-9._:-]+$' OR NOT public."pos_manual_t2_manual_reference_target_keys_v1"(p_target)
    OR p_target->>'id' IS DISTINCT FROM p_id
    OR pg_catalog.jsonb_typeof(p_target->'id')<>'string' OR pg_catalog.jsonb_typeof(p_target->'branch_id')<>'number' OR pg_catalog.jsonb_typeof(p_target->'register_id')<>'number' OR pg_catalog.jsonb_typeof(p_target->'session_id')<>'number' OR pg_catalog.jsonb_typeof(p_target->'requester_profile_id')<>'number'
    OR pg_catalog.jsonb_typeof(p_target->'requester_user_id')<>'string' OR pg_catalog.jsonb_typeof(p_target->'sale_draft_id')<>'string' OR pg_catalog.jsonb_typeof(p_target->'payment_plan_id')<>'string' OR pg_catalog.jsonb_typeof(p_target->'quote_hash')<>'string' OR pg_catalog.jsonb_typeof(p_target->'payment_index')<>'number'
    OR pg_catalog.jsonb_typeof(p_target->'method')<>'string' OR pg_catalog.jsonb_typeof(p_target->'amount_cents')<>'number' OR pg_catalog.jsonb_typeof(p_target->'installments')<>'number' OR pg_catalog.jsonb_typeof(p_target->'provider')<>'string' OR pg_catalog.jsonb_typeof(p_target->'reference')<>'string'
    OR pg_catalog.jsonb_typeof(p_target->'reference_hash')<>'string' OR pg_catalog.jsonb_typeof(p_target->'reference_last_four')<>'string' OR pg_catalog.jsonb_typeof(p_target->'occurred_at')<>'string' OR pg_catalog.jsonb_typeof(p_target->'status')<>'string' OR pg_catalog.jsonb_typeof(p_target->'approval_id')<>'string'
    OR pg_catalog.jsonb_typeof(p_target->'idempotency_key')<>'string' OR pg_catalog.jsonb_typeof(p_target->'request_hash')<>'string'
    OR pg_catalog.jsonb_typeof(p_target->'consumed_sale_payment_id') NOT IN ('string','null') OR pg_catalog.jsonb_typeof(p_target->'consumed_at') NOT IN ('string','null') OR pg_catalog.jsonb_typeof(p_target->'revoked_at') NOT IN ('string','null') OR pg_catalog.jsonb_typeof(p_target->'revoked_by') NOT IN ('string','null') OR pg_catalog.jsonb_typeof(p_target->'revoke_reason') NOT IN ('string','null') OR pg_catalog.jsonb_typeof(p_target->'revoke_idempotency_key') NOT IN ('string','null') OR pg_catalog.jsonb_typeof(p_target->'revoke_request_hash') NOT IN ('string','null') THEN RAISE EXCEPTION 'invalid sealed manual reference preview shape' USING ERRCODE='22023'; END IF;
 -- Raw reference/revoke reason are deliberately parsed only in local memory. The
 -- canonical request and every root/observation use the redacted projection.
 BEGIN r:=pg_catalog.jsonb_populate_record(NULL::public."pos_manual_payment_references",p_target); EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RAISE EXCEPTION 'invalid sealed manual reference transport' USING ERRCODE='22023'; END;
 IF r.id IS NULL OR r.branch_id IS NULL OR r.register_id IS NULL OR r.session_id IS NULL OR r.requester_profile_id IS NULL OR r.requester_user_id IS NULL OR r.sale_draft_id IS NULL OR r.payment_plan_id IS NULL OR NOT public."pos_manual_t2_subject_safe_v1"(r.id) OR NOT public."pos_manual_t2_subject_safe_v1"(r.requester_user_id) OR NOT public."pos_manual_t2_subject_safe_v1"(r.sale_draft_id) OR NOT public."pos_manual_t2_subject_safe_v1"(r.payment_plan_id) OR r.quote_hash !~ '^[0-9a-f]{64}$' OR r.payment_index NOT BETWEEN 0 AND 9 OR r.amount_cents<=0 OR r.method NOT IN ('pix','credit','debit','voucher') OR r.installments NOT BETWEEN 1 AND 24 OR (r.method<>'credit' AND r.installments<>1) OR r.provider !~ '^[a-z0-9][a-z0-9._:-]*$' OR r.reference IS NULL OR r.reference<>normalize(r.reference,NFC) OR r.reference~'[[:cntrl:]]' OR pg_catalog.char_length(r.reference) NOT BETWEEN 6 AND 160 OR r.reference_hash IS DISTINCT FROM pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(r.reference,'UTF8')),'hex') OR r.reference_last_four IS DISTINCT FROM pg_catalog.right(r.reference,pg_catalog.least(4,pg_catalog.char_length(r.reference))) OR r.idempotency_key IS NULL OR pg_catalog.octet_length(r.idempotency_key) NOT BETWEEN 8 AND 120 OR r.idempotency_key!~'^[A-Za-z0-9._:-]+$' OR r.request_hash !~ '^[0-9a-f]{64}$' OR (p_action='revoke' AND (r.revoke_reason IS NULL OR r.revoke_reason<>normalize(r.revoke_reason,NFC) OR r.revoke_reason~'[[:cntrl:]]' OR pg_catalog.octet_length(r.revoke_reason)>512 OR r.revoke_request_hash !~ '^[0-9a-f]{64}$')) THEN RAISE EXCEPTION 'invalid sealed manual reference transport values' USING ERRCODE='22023'; END IF;
 -- Operation hash is DB/session-bound. The persisted reference/revoke hashes
 -- are independent business commitments and remain part of the target.
 m:=pg_catalog.jsonb_build_object('action',p_action,'id',p_id,'expectedPlanVersion',p_expected_plan_version,'actorUserId',p_actor,'operationIdempotencyKey',p_key,'target',public."pos_manual_t2_manual_reference_projection_v1"(r)-ARRAY['createdAt','updatedAt','consumedAt','revokedAt']);
 IF NOT public."pos_manual_t2_canonical_text_dlp_safe_v1"(public."pos_manual_canonical_json_v1"(m)) THEN RAISE EXCEPTION 'sealed manual reference preview is DLP-unsafe' USING ERRCODE='22023'; END IF;
 RETURN pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('t2-manual-reference-request-v1','UTF8')||pg_catalog.decode('00','hex')||pg_catalog.convert_to(pg_catalog.current_database(),'UTF8')||pg_catalog.decode('00','hex')||pg_catalog.convert_to(session_user,'UTF8')||pg_catalog.decode('00','hex')||pg_catalog.convert_to(public."pos_manual_canonical_json_v1"(m),'UTF8')),'hex');
END $function$;

CREATE FUNCTION public."pos_manual_prepare_manual_payment_reference_write_v1"(p_action text,p_id text,p_expected_plan_version integer,p_actor text,p_key text,p_hash text,p_target jsonb) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE plan_row public."pos_payment_plans"%ROWTYPE; claim_row public."pos_order_claims"%ROWTYPE; locator public."pos_manual_payment_references"%ROWTYPE; target public."pos_manual_payment_references"%ROWTYPE; approval_row public."pos_approvals"%ROWTYPE; old_doc jsonb; new_doc jsonb; namespace text; dml text; now_at timestamp(3):=pg_catalog.transaction_timestamp()::timestamp(3);
BEGIN
 IF p_hash IS DISTINCT FROM public."pos_manual_t2_manual_reference_request_hash_v1"(p_action,p_id,p_expected_plan_version,p_actor,p_key,p_target) THEN RAISE EXCEPTION 'sealed manual reference request hash mismatch' USING ERRCODE='23514'; END IF;
 dml:=CASE WHEN p_action='create' THEN 'INSERT' ELSE 'UPDATE' END;
 IF NOT public."pos_manual_t2_write_metadata_valid_v1"('payment_artifact:manual_reference','manual_reference',p_id,p_action,'pos_manual_payment_references_t2_write_guard',dml) THEN RAISE EXCEPTION 'sealed manual reference action is not allowlisted' USING ERRCODE='22023'; END IF;
 BEGIN target:=pg_catalog.jsonb_populate_record(NULL::public."pos_manual_payment_references",p_target); EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RAISE EXCEPTION 'invalid sealed manual reference transport' USING ERRCODE='22023'; END;
 SELECT * INTO plan_row FROM public."pos_payment_plans" WHERE id=target.payment_plan_id;
 IF plan_row.id IS NULL THEN RAISE EXCEPTION 'sealed manual reference plan locator changed' USING ERRCODE='23514'; END IF;
 IF plan_row.order_claim_id IS NOT NULL THEN SELECT * INTO claim_row FROM public."pos_order_claims" WHERE id=plan_row.order_claim_id; END IF;
 -- All namespace locks precede every mutable row lock. Locators above are read-only.
 FOR namespace IN SELECT value FROM pg_catalog.unnest(ARRAY['pos-held-sale-items:v1:held-sale:'||plan_row.sale_draft_id,'pos-manual-payment-reference:v1:operation:'||p_key,'pos-manual-payment-reference:v1:reference:'||p_id,'pos-manual-payment-reference:v1:slot:'||plan_row.id||':'||target.payment_index::text,CASE WHEN p_action='consume' THEN 'pos-manual-payment-reference:v1:sale-payment:'||target.consumed_sale_payment_id END,'t2-payment-plan:aggregate:'||plan_row.id,'t2-payment-plan:draft:'||plan_row.sale_draft_id,CASE WHEN plan_row.order_claim_id IS NOT NULL THEN 'pos-order-claim:v1:claim:'||plan_row.order_claim_id END,CASE WHEN plan_row.order_claim_id IS NOT NULL THEN 'pos-order-claim:v1:artifacts:'||plan_row.order_claim_id END,CASE WHEN claim_row.sales_order_id IS NOT NULL THEN 'pos-order-claim:v1:order:'||claim_row.sales_order_id::text END]) value WHERE value IS NOT NULL ORDER BY value COLLATE "C" LOOP PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(namespace,0)); END LOOP;
 PERFORM 1 FROM public."cash_register_sessions" WHERE id=plan_row.session_id FOR UPDATE;
 PERFORM 1 FROM public."pos_terminals" WHERE id=plan_row.terminal_id FOR UPDATE;
 PERFORM 1 FROM public."tenant_user_profiles" WHERE id=plan_row.operator_profile_id FOR SHARE;
 PERFORM 1 FROM public."branches" WHERE id=plan_row.branch_id FOR SHARE;
 PERFORM 1 FROM public."pos_registers" WHERE id=plan_row.register_id FOR SHARE;
 PERFORM 1 FROM public."branch_user_accesses" WHERE branch_id=plan_row.branch_id AND user_profile_id=plan_row.operator_profile_id FOR SHARE;
 PERFORM 1 FROM public."pos_register_accesses" WHERE register_id=plan_row.register_id AND user_profile_id=plan_row.operator_profile_id FOR SHARE;
 IF plan_row.order_claim_id IS NOT NULL THEN PERFORM 1 FROM public."sales_orders" order_row JOIN public."pos_order_claims" claim ON claim.sales_order_id=order_row.id WHERE claim.id=plan_row.order_claim_id FOR UPDATE OF order_row; SELECT * INTO claim_row FROM public."pos_order_claims" WHERE id=plan_row.order_claim_id FOR UPDATE; END IF;
 PERFORM 1 FROM public."pos_held_sales" WHERE id=plan_row.sale_draft_id FOR UPDATE; PERFORM 1 FROM public."pos_held_sale_items" WHERE held_sale_id=plan_row.sale_draft_id ORDER BY id FOR UPDATE;
 -- A manual slot intentionally has no connector/credential, but the selected
 -- provider must still have a live branch/register payment connector. Lock its
 -- connector, credential and provider before the plan/slot boundary.
 PERFORM 1 FROM public."pos_connectors" connector JOIN public."integration_credentials" credential ON credential.id=connector.credential_ref JOIN public."integration_providers" provider_row ON provider_row.id=credential.provider_id WHERE connector.provider=target.provider AND connector.branch_id=plan_row.branch_id AND (connector.register_id IS NULL OR connector.register_id=plan_row.register_id) FOR SHARE OF connector,credential,provider_row;
 SELECT * INTO plan_row FROM public."pos_payment_plans" WHERE id=plan_row.id FOR UPDATE;
 PERFORM 1 FROM public."pos_payment_plan_slots" WHERE plan_id=plan_row.id AND payment_index=target.payment_index FOR UPDATE;
 SELECT * INTO approval_row FROM public."pos_approvals" WHERE id=target.approval_id FOR UPDATE;
 SELECT * INTO locator FROM public."pos_manual_payment_references" WHERE id=p_id FOR UPDATE;
 IF plan_row.version<>p_expected_plan_version THEN RAISE EXCEPTION 'sealed manual reference compare-and-swap failed' USING ERRCODE='40001'; END IF;
 target.created_at:=CASE WHEN p_action='create' THEN now_at ELSE locator.created_at END; target.updated_at:=now_at;
 IF p_action='create' THEN
   IF locator.id IS NOT NULL OR plan_row.state<>'active' OR plan_row.expires_at<=now_at OR target.status<>'pending'
      OR ROW(target.branch_id,target.register_id,target.session_id,target.requester_profile_id,target.sale_draft_id,target.quote_hash,target.payment_plan_id,target.payment_index,target.method,target.amount_cents,target.installments,target.provider) IS DISTINCT FROM ROW(plan_row.branch_id,plan_row.register_id,plan_row.session_id,plan_row.operator_profile_id,plan_row.sale_draft_id,plan_row.quote_hash,plan_row.id,target.payment_index,(SELECT method FROM public."pos_payment_plan_slots" WHERE plan_id=plan_row.id AND payment_index=target.payment_index),(SELECT amount_cents FROM public."pos_payment_plan_slots" WHERE plan_id=plan_row.id AND payment_index=target.payment_index),(SELECT installments FROM public."pos_payment_plan_slots" WHERE plan_id=plan_row.id AND payment_index=target.payment_index),(SELECT provider FROM public."pos_payment_plan_slots" WHERE plan_id=plan_row.id AND payment_index=target.payment_index))
      OR NOT EXISTS (SELECT 1 FROM public."pos_payment_plan_slots" slot JOIN public."integration_providers" provider_row ON provider_row.id=slot.provider AND provider_row.family='payment' WHERE slot.plan_id=plan_row.id AND slot.payment_index=target.payment_index AND slot.proof_kind='manual')
      OR target.requester_user_id IS DISTINCT FROM p_actor OR NOT EXISTS (SELECT 1 FROM public."tenant_user_profiles" profile WHERE profile.id=target.requester_profile_id AND profile.user_id=p_actor AND profile.status='active')
      OR approval_row.id IS NULL OR approval_row.branch_id IS DISTINCT FROM plan_row.branch_id OR approval_row.action<>'payment.manual_reference' OR approval_row.entity_type<>'sale_draft' OR approval_row.entity_id IS DISTINCT FROM plan_row.sale_draft_id OR approval_row.status<>'pending' OR approval_row.requester_id IS DISTINCT FROM p_actor OR approval_row.approver_id IS NOT NULL OR approval_row.expires_at<=now_at OR pg_catalog.jsonb_typeof(approval_row.context)<>'object'
      OR ROW(target.consumed_sale_payment_id,target.consumed_at,target.revoked_at,target.revoked_by,target.revoke_reason,target.revoke_idempotency_key,target.revoke_request_hash) IS DISTINCT FROM ROW(NULL::text,NULL::timestamp,NULL::timestamp,NULL::text,NULL::text,NULL::text,NULL::text)
      OR NOT EXISTS (SELECT 1 FROM public."pos_connectors" connector JOIN public."integration_credentials" credential ON credential.id=connector.credential_ref JOIN public."integration_providers" provider_row ON provider_row.id=credential.provider_id WHERE connector.provider=target.provider AND connector.status='active' AND connector.branch_id=plan_row.branch_id AND (connector.register_id IS NULL OR connector.register_id=plan_row.register_id) AND connector.type LIKE 'payment%' AND credential.enabled AND provider_row.family='payment')
      OR NOT EXISTS (SELECT 1 FROM public."cash_register_sessions" session_row JOIN public."pos_terminals" terminal_row ON terminal_row.id=plan_row.terminal_id JOIN public."branches" branch_row ON branch_row.id=plan_row.branch_id JOIN public."pos_registers" register_row ON register_row.id=plan_row.register_id AND register_row.branch_id=branch_row.id JOIN public."branch_user_accesses" branch_access ON branch_access.branch_id=branch_row.id AND branch_access.user_profile_id=plan_row.operator_profile_id JOIN public."pos_register_accesses" register_access ON register_access.register_id=register_row.id AND register_access.user_profile_id=plan_row.operator_profile_id WHERE session_row.id=plan_row.session_id AND session_row.register_id=plan_row.register_id AND session_row.operator_profile_id=plan_row.operator_profile_id AND session_row.status='open' AND terminal_row.status='online' AND terminal_row.paired_at IS NOT NULL AND terminal_row.revoked_at IS NULL AND terminal_row.token_hash IS NOT NULL AND terminal_row.token_expires_at>now_at AND terminal_row.last_seen_at>now_at-interval '5 minutes' AND NULLIF(btrim(terminal_row.app_version),'') IS NOT NULL AND branch_row.status='active' AND register_row.status='active' AND branch_access.can_sell AND register_access.active AND register_access.can_sell AND register_access.can_manual_payment AND (register_access.valid_from IS NULL OR register_access.valid_from<=now_at) AND (register_access.valid_until IS NULL OR register_access.valid_until>now_at))
      OR plan_row.order_claim_id IS NOT NULL AND (plan_row.order_claim_id<>plan_row.sale_draft_id OR claim_row.id IS NULL OR claim_row.state<>'active' OR claim_row.lease_expires_at<=now_at) THEN RAISE EXCEPTION 'sealed manual reference create boundary changed' USING ERRCODE='23514'; END IF;
   old_doc:=NULL;
 ELSIF p_action='revoke' THEN
   IF locator.id IS NULL OR locator.status<>'pending' OR ROW(target.id,target.branch_id,target.register_id,target.session_id,target.requester_profile_id,target.requester_user_id,target.sale_draft_id,target.quote_hash,target.payment_plan_id,target.payment_index,target.method,target.amount_cents,target.installments,target.provider,target.reference,target.reference_hash,target.reference_last_four,target.occurred_at,target.approval_id,target.idempotency_key,target.request_hash,target.consumed_sale_payment_id,target.consumed_at,target.created_at) IS DISTINCT FROM ROW(locator.id,locator.branch_id,locator.register_id,locator.session_id,locator.requester_profile_id,locator.requester_user_id,locator.sale_draft_id,locator.quote_hash,locator.payment_plan_id,locator.payment_index,locator.method,locator.amount_cents,locator.installments,locator.provider,locator.reference,locator.reference_hash,locator.reference_last_four,locator.occurred_at,locator.approval_id,locator.idempotency_key,locator.request_hash,NULL::text,NULL::timestamp,locator.created_at) OR target.status<>'revoked' OR p_target->'revoked_at'<>'null'::jsonb OR target.revoked_by IS DISTINCT FROM p_actor OR target.revoke_reason IS NULL OR target.revoke_idempotency_key IS DISTINCT FROM p_key OR target.revoke_request_hash !~ '^[0-9a-f]{64}$' OR approval_row.id IS NULL OR approval_row.status<>'rejected' OR approval_row.approver_id IS NULL OR approval_row.approver_id=locator.requester_user_id THEN RAISE EXCEPTION 'sealed manual reference revoke boundary changed' USING ERRCODE='23514'; END IF;
   target.revoked_at:=now_at; old_doc:=public."pos_manual_t2_manual_reference_projection_v1"(locator);
 ELSE
   -- The sale payment is deliberately allowed to be a reserved identity: the
   -- producer opens this root, inserts sale/payment, then updates this row.
   -- `pos_manual_payment_references_consumed_context_guard` verifies the full
   -- sale/payment/approval tuple at deferred commit after materialization.
   IF locator.id IS NULL OR locator.status<>'pending' OR ROW(target.id,target.branch_id,target.register_id,target.session_id,target.requester_profile_id,target.requester_user_id,target.sale_draft_id,target.quote_hash,target.payment_plan_id,target.payment_index,target.method,target.amount_cents,target.installments,target.provider,target.reference,target.reference_hash,target.reference_last_four,target.occurred_at,target.approval_id,target.idempotency_key,target.request_hash,target.revoked_at,target.revoked_by,target.revoke_reason,target.revoke_idempotency_key,target.revoke_request_hash,target.created_at) IS DISTINCT FROM ROW(locator.id,locator.branch_id,locator.register_id,locator.session_id,locator.requester_profile_id,locator.requester_user_id,locator.sale_draft_id,locator.quote_hash,locator.payment_plan_id,locator.payment_index,locator.method,locator.amount_cents,locator.installments,locator.provider,locator.reference,locator.reference_hash,locator.reference_last_four,locator.occurred_at,locator.approval_id,locator.idempotency_key,locator.request_hash,NULL::timestamp,NULL::text,NULL::text,NULL::text,NULL::text,locator.created_at) OR target.status<>'consumed' OR target.consumed_sale_payment_id IS NULL OR NOT public."pos_manual_t2_subject_safe_v1"(target.consumed_sale_payment_id) OR p_target->'consumed_at'<>'null'::jsonb THEN RAISE EXCEPTION 'sealed manual reference consume boundary changed' USING ERRCODE='23514'; END IF;
   target.consumed_at:=now_at; old_doc:=public."pos_manual_t2_manual_reference_projection_v1"(locator);
 END IF;
 new_doc:=public."pos_manual_t2_manual_reference_projection_v1"(target);
 PERFORM public."pos_manual_t2_open_write_root_v1"('payment_artifact:manual_reference','manual_reference',p_id,p_action,'pos_manual_payment_references_t2_write_guard',dml,public."pos_manual_t2_authority_v1"('runtime'),ARRAY[public."pos_manual_t2_write_observation_digest_v1"('payment_artifact:manual_reference','manual_reference',p_id,p_action,'pos_manual_payment_references_t2_write_guard',dml,old_doc,new_doc)]);
END $function$;

CREATE FUNCTION public."pos_manual_t2_manual_reference_root_action_v1"(p_reference_id text,p_dml text) RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE action text; n integer;
BEGIN
 SELECT max(root.action),count(*)::integer INTO action,n FROM public."pos_manual_t2_write_roots" root WHERE root.backend_pid=pg_catalog.pg_backend_pid() AND root.transaction_txid=pg_catalog.txid_current()::numeric AND root.capability='payment_artifact:manual_reference' AND root.aggregate_kind='manual_reference' AND root.aggregate_id=p_reference_id AND root.trigger_identity='pos_manual_payment_references_t2_write_guard' AND root.dml_operation=p_dml;
 IF n<>1 THEN RAISE EXCEPTION 'manual reference has no unique capability root' USING ERRCODE='23514'; END IF;
 RETURN action;
END $function$;
CREATE FUNCTION public."pos_manual_t2_observe_manual_reference_v1"(p_reference_id text,p_action text,p_dml text,p_old jsonb,p_new jsonb) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
 PERFORM public."pos_manual_t2_observe_write_v1"('payment_artifact:manual_reference','manual_reference',p_reference_id,p_action,'pos_manual_payment_references_t2_write_guard',p_dml,p_old,p_new);
END $function$;
-- The 000 legacy seal fires before this trigger and continues to deny all DML.
-- This body is intentionally observer-only so removing that seal in a future,
-- atomic vault/gate migration does not introduce a second business guard.
CREATE FUNCTION public."protect_pos_manual_payment_reference_t2"() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE action text; old_doc jsonb; new_doc jsonb;
BEGIN
 action:=public."pos_manual_t2_manual_reference_root_action_v1"(NEW.id,TG_OP);
 IF TG_OP='INSERT' THEN NEW.created_at:=pg_catalog.transaction_timestamp()::timestamp(3); END IF;
 NEW.updated_at:=pg_catalog.transaction_timestamp()::timestamp(3);
 IF action='consume' THEN NEW.consumed_at:=pg_catalog.transaction_timestamp()::timestamp(3); ELSIF action='revoke' THEN NEW.revoked_at:=pg_catalog.transaction_timestamp()::timestamp(3); END IF;
 old_doc:=CASE WHEN TG_OP='UPDATE' THEN public."pos_manual_t2_manual_reference_projection_v1"(OLD) ELSE NULL END;
 new_doc:=public."pos_manual_t2_manual_reference_projection_v1"(NEW);
 PERFORM public."pos_manual_t2_observe_manual_reference_v1"(NEW.id,action,TG_OP,old_doc,new_doc);
 RETURN NEW;
EXCEPTION WHEN check_violation OR no_data_found OR too_many_rows THEN RAISE EXCEPTION 'manual reference write requires its exact T2 capability root' USING ERRCODE='42501';
END $function$;
DROP TRIGGER "pos_manual_payment_references_authoritative_plan_guard" ON public."pos_manual_payment_references";
CREATE TRIGGER "pos_manual_payment_references_t2_write_guard" BEFORE INSERT OR UPDATE ON public."pos_manual_payment_references" FOR EACH ROW EXECUTE FUNCTION public."protect_pos_manual_payment_reference_t2"();

-- Sale-payment T2 ABI.  Sensitive provider evidence and arbitrary metadata are
-- represented only by neutral commitments in roots/observations.
CREATE FUNCTION public."pos_manual_t2_sale_payment_projection_v1"(p public."pos_sale_payments") RETURNS jsonb LANGUAGE sql STABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
 SELECT pg_catalog.jsonb_build_object('id',p.id,'saleId',p.sale_id,'connectorId',p.connector_id,'originalPaymentId',p.original_payment_id,'processingSessionId',p.processing_session_id,'type',p.type,'method',p.method,'status',p.status,'amountCents',p.amount_cents,'tenderedCents',p.tendered_cents,'changeCents',p.change_cents,'provider',p.provider,'installments',p.installments,'idempotencyKey',p.idempotency_key,'paymentIntentId',p.payment_intent_id,'compensationId',p.compensation_id,'paymentPlanId',p.payment_plan_id,'paymentIndex',p.payment_index,'valueReservationId',p.value_reservation_id,'valueCaptureEntryId',p.value_capture_entry_id::text,'valueAmountUnits',p.value_amount_units::text,'manualPaymentCaseId',p.manual_payment_case_id,'proofCommitments',pg_catalog.jsonb_build_array(CASE WHEN p.transaction_id IS NULL THEN NULL ELSE pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.transaction_id,'UTF8')),'hex') END,CASE WHEN p.end_to_end_id IS NULL THEN NULL ELSE pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.end_to_end_id,'UTF8')),'hex') END,CASE WHEN p.nsu IS NULL THEN NULL ELSE pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.nsu,'UTF8')),'hex') END,CASE WHEN p.authorization_code IS NULL THEN NULL ELSE pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.authorization_code,'UTF8')),'hex') END,CASE WHEN p.metadata IS NULL THEN NULL ELSE pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(public."pos_manual_canonical_json_v1"(p.metadata),'UTF8')),'hex') END),'cardBrand',p.card_brand,'cardLastFour',p.card_last_four,'authorizedAt',p.authorized_at,'capturedAt',p.captured_at,'refundedAt',p.refunded_at,'createdAt',p.created_at,'updatedAt',p.updated_at)
$function$;
CREATE FUNCTION public."pos_manual_t2_sale_payment_target_keys_v1"(p jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
 SELECT public."pos_manual_t2_json_keys_exact_v1"(p,ARRAY['id','sale_id','connector_id','original_payment_id','processing_session_id','type','method','status','amount_cents','tendered_cents','change_cents','provider','transaction_id','end_to_end_id','nsu','authorization_code','card_brand','card_last_four','installments','idempotency_key','payment_intent_id','compensation_id','payment_plan_id','payment_index','value_reservation_id','value_capture_entry_id','value_amount_units','manual_payment_case_id','metadata','authorized_at','captured_at','refunded_at'])
$function$;
CREATE FUNCTION public."pos_manual_t2_sale_payment_evidence_transport_safe_v1"(p text) RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog AS $function$
 SELECT p IS NULL OR (pg_catalog.octet_length(p) BETWEEN 1 AND 512 AND p=normalize(p,NFC) AND p!~'[[:cntrl:]]'
   AND NOT public."pos_manual_identifier_contains_pan_321f"(p)
   AND public."pos_manual_t2_canonical_text_dlp_safe_v1"(public."pos_manual_canonical_json_v1"(pg_catalog.to_jsonb(p))))
$function$;
CREATE FUNCTION public."pos_manual_t2_sale_payment_request_hash_v1"(p_action text,p_id text,p_expected integer,p_actor text,p_key text,p_target jsonb) RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE row_value public."pos_sale_payments"%ROWTYPE; material jsonb;
BEGIN
 IF p_action NOT IN ('create_commit','create_intent_consumption','insert_refund_compensation','insert_refund_cancel','insert_refund_return','update_refund_status') OR p_expected< -1 OR pg_catalog.pg_column_size(p_target) NOT BETWEEN 2 AND 65536 OR NOT public."pos_manual_t2_subject_safe_v1"(p_id) OR NOT public."pos_manual_t2_subject_safe_v1"(p_actor) OR pg_catalog.octet_length(p_key) NOT BETWEEN 16 AND 160 OR p_key!~'^[A-Za-z0-9._:-]+$' OR NOT public."pos_manual_t2_sale_payment_target_keys_v1"(p_target) OR p_target->>'id' IS DISTINCT FROM p_id THEN RAISE EXCEPTION 'invalid sale payment preview shape' USING ERRCODE='22023'; END IF;
 IF pg_catalog.jsonb_typeof(p_target->'id')<>'string' OR pg_catalog.jsonb_typeof(p_target->'sale_id')<>'number'
   OR pg_catalog.jsonb_typeof(p_target->'type')<>'string' OR pg_catalog.jsonb_typeof(p_target->'method')<>'string'
   OR pg_catalog.jsonb_typeof(p_target->'status')<>'string' OR pg_catalog.jsonb_typeof(p_target->'amount_cents')<>'number'
   OR pg_catalog.jsonb_typeof(p_target->'tendered_cents')<>'number' OR pg_catalog.jsonb_typeof(p_target->'change_cents')<>'number'
   OR pg_catalog.jsonb_typeof(p_target->'installments')<>'number' OR pg_catalog.jsonb_typeof(p_target->'idempotency_key')<>'string'
   OR pg_catalog.jsonb_typeof(p_target->'payment_index') NOT IN ('number','null')
   OR pg_catalog.jsonb_typeof(p_target->'value_capture_entry_id') NOT IN ('string','null')
   OR pg_catalog.jsonb_typeof(p_target->'value_amount_units') NOT IN ('string','null')
   OR pg_catalog.jsonb_typeof(p_target->'metadata') NOT IN ('object','null')
   OR pg_catalog.jsonb_typeof(p_target->'authorized_at') NOT IN ('string','null')
   OR pg_catalog.jsonb_typeof(p_target->'captured_at') NOT IN ('string','null')
   OR pg_catalog.jsonb_typeof(p_target->'refunded_at') NOT IN ('string','null')
 THEN RAISE EXCEPTION 'invalid sale payment transport types' USING ERRCODE='22023'; END IF;
 BEGIN row_value:=pg_catalog.jsonb_populate_record(NULL::public."pos_sale_payments",p_target); EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RAISE EXCEPTION 'invalid sale payment transport' USING ERRCODE='22023'; END;
 IF row_value.sale_id IS NULL OR row_value.sale_id<=0 OR row_value.type NOT IN ('payment','refund') OR row_value.method NOT IN ('cash','pix','credit','debit','voucher','store_credit') OR row_value.amount_cents<=0 OR row_value.tendered_cents<0 OR row_value.change_cents<0 OR row_value.installments NOT BETWEEN 1 AND 24 OR (row_value.method<>'credit' AND row_value.installments<>1) OR NOT public."pos_manual_t2_subject_safe_v1"(row_value.idempotency_key) THEN RAISE EXCEPTION 'invalid sale payment transport values' USING ERRCODE='22023'; END IF;
 IF NOT public."pos_manual_t2_sale_payment_evidence_transport_safe_v1"(row_value.transaction_id)
   OR NOT public."pos_manual_t2_sale_payment_evidence_transport_safe_v1"(row_value.end_to_end_id)
   OR NOT public."pos_manual_t2_sale_payment_evidence_transport_safe_v1"(row_value.nsu)
   OR NOT public."pos_manual_t2_sale_payment_evidence_transport_safe_v1"(row_value.authorization_code)
   OR NOT public."pos_manual_t2_sale_payment_evidence_transport_safe_v1"(row_value.card_brand)
   OR (row_value.card_last_four IS NOT NULL AND row_value.card_last_four!~'^[A-Za-z0-9*#._:-]{4}$')
   OR (row_value.metadata IS NOT NULL AND NOT public."pos_manual_t2_canonical_text_dlp_safe_v1"(public."pos_manual_canonical_json_v1"(row_value.metadata)))
 THEN RAISE EXCEPTION 'sale payment evidence transport is DLP-unsafe' USING ERRCODE='22023'; END IF;
 material:=pg_catalog.jsonb_build_object('action',p_action,'id',p_id,'expectedVersion',p_expected,'actorUserId',p_actor,'operationIdempotencyKey',p_key,'target',public."pos_manual_t2_sale_payment_projection_v1"(row_value)-ARRAY['createdAt','updatedAt','authorizedAt','capturedAt','refundedAt'],'serverTimestampSentinels',pg_catalog.jsonb_build_object('authorizedAt',p_target->'authorized_at','capturedAt',p_target->'captured_at','refundedAt',p_target->'refunded_at'));
 IF NOT public."pos_manual_t2_canonical_text_dlp_safe_v1"(public."pos_manual_canonical_json_v1"(material)) THEN RAISE EXCEPTION 'sale payment preview is DLP-unsafe' USING ERRCODE='22023'; END IF;
 RETURN pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('t2-sale-payment-request-v1','UTF8')||pg_catalog.decode('00','hex')||pg_catalog.convert_to(pg_catalog.current_database(),'UTF8')||pg_catalog.decode('00','hex')||pg_catalog.convert_to(session_user,'UTF8')||pg_catalog.decode('00','hex')||pg_catalog.convert_to(public."pos_manual_canonical_json_v1"(material),'UTF8')),'hex');
END $function$;
CREATE FUNCTION public."pos_manual_prepare_sale_payment_write_v1"(p_action text,p_id text,p_expected integer,p_actor text,p_key text,p_hash text,p_target jsonb) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE
 target public."pos_sale_payments"%ROWTYPE; locator public."pos_sale_payments"%ROWTYPE;
 original_row public."pos_sale_payments"%ROWTYPE; plan_locator public."pos_payment_plans"%ROWTYPE; plan_row public."pos_payment_plans"%ROWTYPE;
 slot_locator public."pos_payment_plan_slots"%ROWTYPE; slot_row public."pos_payment_plan_slots"%ROWTYPE;
 claim_locator public."pos_order_claims"%ROWTYPE; claim_row public."pos_order_claims"%ROWTYPE;
 sale_row public."sales"%ROWTYPE; compensation_row public."pos_payment_compensations"%ROWTYPE;
 return_row public."pos_returns"%ROWTYPE;
 old_doc jsonb; new_doc jsonb; dml text; namespace text; operation_ref text; now_at timestamp(3):=pg_catalog.transaction_timestamp()::timestamp(3);
 refund_total bigint; original_available bigint; earlier_available bigint; expected_status text; proof_ok boolean:=false;
BEGIN
 IF p_hash IS DISTINCT FROM public."pos_manual_t2_sale_payment_request_hash_v1"(p_action,p_id,p_expected,p_actor,p_key,p_target) THEN RAISE EXCEPTION 'sale payment request hash mismatch' USING ERRCODE='23514'; END IF;
 dml:=CASE WHEN p_action='update_refund_status' THEN 'UPDATE' ELSE 'INSERT' END;
 IF NOT public."pos_manual_t2_write_metadata_valid_v1"('payment_artifact:sale_payment','sale_payment',p_id,p_action,'pos_sale_payments_t2_write_guard',dml) THEN RAISE EXCEPTION 'sale payment action is not allowlisted' USING ERRCODE='22023'; END IF;
 target:=pg_catalog.jsonb_populate_record(NULL::public."pos_sale_payments",p_target);
 operation_ref:=CASE WHEN target.original_payment_id IS NOT NULL AND pg_catalog.right(p_key,pg_catalog.length(':refund:'||target.original_payment_id))=':refund:'||target.original_payment_id
   THEN pg_catalog.left(p_key,pg_catalog.length(p_key)-pg_catalog.length(':refund:'||target.original_payment_id)) END;
 -- Locator reads choose the complete advisory set only. No business decision
 -- trusts these rows until the canonical locks below have been acquired.
 SELECT * INTO plan_locator FROM public."pos_payment_plans" WHERE id=target.payment_plan_id;
 IF plan_locator.id IS NOT NULL THEN SELECT * INTO slot_locator FROM public."pos_payment_plan_slots" WHERE plan_id=target.payment_plan_id AND payment_index=target.payment_index; END IF;
 IF plan_locator.order_claim_id IS NOT NULL THEN SELECT * INTO claim_locator FROM public."pos_order_claims" WHERE id=plan_locator.order_claim_id; END IF;
 FOR namespace IN SELECT value FROM pg_catalog.unnest(ARRAY[
   'pos-sale-payment-insert:'||target.idempotency_key,
   CASE WHEN p_action='update_refund_status' THEN 'pos-sale-payment-refund-range:'||p_id WHEN target.original_payment_id IS NOT NULL THEN 'pos-sale-payment-refund-range:'||target.original_payment_id END,
   CASE WHEN plan_locator.id IS NOT NULL THEN 't2-payment-plan:aggregate:'||plan_locator.id END,
   CASE WHEN plan_locator.id IS NOT NULL THEN 't2-payment-plan:draft:'||plan_locator.sale_draft_id END,
   CASE WHEN plan_locator.id IS NOT NULL THEN 'pos-held-sale-items:v1:held-sale:'||plan_locator.sale_draft_id END,
   CASE WHEN plan_locator.order_claim_id IS NOT NULL THEN 'pos-order-claim:v1:claim:'||plan_locator.order_claim_id END,
   CASE WHEN plan_locator.order_claim_id IS NOT NULL THEN 'pos-order-claim:v1:artifacts:'||plan_locator.order_claim_id END,
   CASE WHEN claim_locator.id IS NOT NULL THEN 'pos-order-claim:v1:order:'||claim_locator.sales_order_id::text END
 ]) value WHERE value IS NOT NULL ORDER BY value COLLATE "C" LOOP
   PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(namespace,0));
 END LOOP;

 -- Canonical roots: session -> terminal -> profile/branch/register/access ->
 -- order/claim -> held/items -> connector/credential -> plan/slot -> sale ->
 -- proof -> original/range -> target.
 IF plan_locator.id IS NOT NULL THEN
   PERFORM 1 FROM public."cash_register_sessions" WHERE id=plan_locator.session_id FOR UPDATE;
   PERFORM 1 FROM public."pos_terminals" WHERE id=plan_locator.terminal_id FOR UPDATE;
   PERFORM 1 FROM public."tenant_user_profiles" WHERE id=plan_locator.operator_profile_id FOR SHARE;
   PERFORM 1 FROM public."branches" WHERE id=plan_locator.branch_id FOR SHARE;
   PERFORM 1 FROM public."pos_registers" WHERE id=plan_locator.register_id FOR SHARE;
   PERFORM 1 FROM public."branch_user_accesses" WHERE branch_id=plan_locator.branch_id AND user_profile_id=plan_locator.operator_profile_id FOR SHARE;
   PERFORM 1 FROM public."pos_register_accesses" WHERE register_id=plan_locator.register_id AND user_profile_id=plan_locator.operator_profile_id FOR SHARE;
   IF claim_locator.id IS NOT NULL THEN
     PERFORM 1 FROM public."sales_orders" WHERE id=claim_locator.sales_order_id FOR UPDATE;
     SELECT * INTO claim_row FROM public."pos_order_claims" WHERE id=plan_locator.order_claim_id FOR UPDATE;
   END IF;
   PERFORM 1 FROM public."pos_held_sales" WHERE id=plan_locator.sale_draft_id FOR UPDATE;
   PERFORM 1 FROM public."pos_held_sale_items" WHERE held_sale_id=plan_locator.sale_draft_id ORDER BY id FOR UPDATE;
 END IF;
 IF p_action LIKE 'insert_refund_%' THEN
   PERFORM 1 FROM public."cash_register_sessions" WHERE id=target.processing_session_id FOR UPDATE;
   PERFORM 1 FROM public."tenant_user_profiles" WHERE user_id=p_actor FOR SHARE;
   PERFORM 1 FROM public."pos_registers" register WHERE EXISTS (SELECT 1 FROM public."cash_register_sessions" session WHERE session.id=target.processing_session_id AND session.register_id=register.id) FOR SHARE;
   PERFORM 1 FROM public."pos_approvals" approval WHERE approval.entity_type='sale' AND approval.entity_id=target.sale_id::text
     AND approval.consumed_by=p_actor AND approval.consumption_ref=operation_ref ORDER BY approval.id FOR UPDATE;
 END IF;
 IF target.connector_id IS NOT NULL THEN PERFORM 1 FROM public."pos_connectors" WHERE id=target.connector_id FOR SHARE; END IF;
 IF slot_locator.provider IS NOT NULL THEN PERFORM 1 FROM public."integration_providers" WHERE id=slot_locator.provider FOR SHARE; END IF;
 IF slot_locator.credential_ref IS NOT NULL THEN
   PERFORM 1 FROM public."integration_credentials" WHERE id=slot_locator.credential_ref FOR SHARE;
 END IF;
 IF slot_locator.proof_kind='manual' THEN
   PERFORM 1 FROM public."pos_connectors" WHERE provider=slot_locator.provider AND branch_id=plan_locator.branch_id
     AND (register_id IS NULL OR register_id=plan_locator.register_id) AND status='active' AND type LIKE 'payment%' ORDER BY id FOR SHARE;
   PERFORM 1 FROM public."integration_credentials" credential WHERE EXISTS (SELECT 1 FROM public."pos_connectors" connector
     WHERE connector.provider=slot_locator.provider AND connector.branch_id=plan_locator.branch_id
       AND (connector.register_id IS NULL OR connector.register_id=plan_locator.register_id) AND connector.status='active'
       AND connector.type LIKE 'payment%' AND connector.credential_ref=credential.id) ORDER BY id FOR SHARE;
 END IF;
 IF plan_locator.id IS NOT NULL THEN
   SELECT * INTO plan_row FROM public."pos_payment_plans" WHERE id=target.payment_plan_id FOR UPDATE;
   SELECT * INTO slot_row FROM public."pos_payment_plan_slots" WHERE plan_id=target.payment_plan_id AND payment_index=target.payment_index FOR UPDATE;
   IF ROW(plan_row.id,plan_row.version,plan_row.branch_id,plan_row.register_id,plan_row.session_id,plan_row.operator_profile_id,plan_row.terminal_id,plan_row.sale_draft_id,plan_row.order_claim_id)
     IS DISTINCT FROM ROW(plan_locator.id,plan_locator.version,plan_locator.branch_id,plan_locator.register_id,plan_locator.session_id,plan_locator.operator_profile_id,plan_locator.terminal_id,plan_locator.sale_draft_id,plan_locator.order_claim_id)
     OR ROW(slot_row.plan_id,slot_row.payment_index,slot_row.method,slot_row.amount_cents,slot_row.installments,slot_row.proof_kind,slot_row.connector_id,slot_row.credential_ref,slot_row.provider)
     IS DISTINCT FROM ROW(slot_locator.plan_id,slot_locator.payment_index,slot_locator.method,slot_locator.amount_cents,slot_locator.installments,slot_locator.proof_kind,slot_locator.connector_id,slot_locator.credential_ref,slot_locator.provider)
     OR (claim_locator.id IS NOT NULL AND ROW(claim_row.id,claim_row.sales_order_id,claim_row.branch_id,claim_row.register_id,claim_row.session_id,claim_row.operator_profile_id,claim_row.terminal_id)
       IS DISTINCT FROM ROW(claim_locator.id,claim_locator.sales_order_id,claim_locator.branch_id,claim_locator.register_id,claim_locator.session_id,claim_locator.operator_profile_id,claim_locator.terminal_id))
   THEN RAISE EXCEPTION 'sale payment locator graph changed after advisory locks' USING ERRCODE='40001'; END IF;
   IF slot_row.proof_kind='manual' AND target.metadata IS NOT NULL THEN
     PERFORM 1 FROM public."pos_approvals" WHERE id=target.metadata->>'manualApprovalId' FOR UPDATE;
     PERFORM 1 FROM public."pos_manual_payment_references" WHERE id=target.metadata->>'manualReferenceId' FOR UPDATE;
   END IF;
   PERFORM 1 FROM public."pos_sale_payments" WHERE payment_plan_id=plan_row.id ORDER BY id FOR UPDATE;
 END IF;
 SELECT * INTO sale_row FROM public."sales" WHERE id=target.sale_id FOR UPDATE;
 IF target.payment_intent_id IS NOT NULL THEN PERFORM 1 FROM public."pos_payment_intents" WHERE id=target.payment_intent_id FOR UPDATE; END IF;
 IF target.value_reservation_id IS NOT NULL THEN PERFORM 1 FROM public."pos_value_reservations" WHERE id=target.value_reservation_id FOR UPDATE; END IF;
 IF target.value_capture_entry_id IS NOT NULL THEN PERFORM 1 FROM public."pos_value_ledger_entries" WHERE id=target.value_capture_entry_id FOR UPDATE; END IF;
 IF p_action='insert_refund_return' THEN
   SELECT * INTO return_row FROM public."pos_returns" returned WHERE returned.sale_id=target.sale_id
     AND returned.processing_session_id=target.processing_session_id
     AND returned.idempotency_key||':refund:'||target.original_payment_id=p_key FOR UPDATE;
 END IF;
 IF target.original_payment_id IS NOT NULL THEN
   SELECT * INTO original_row FROM public."pos_sale_payments" WHERE id=target.original_payment_id FOR UPDATE;
   PERFORM 1 FROM public."pos_sale_payments" WHERE original_payment_id=target.original_payment_id ORDER BY id FOR UPDATE;
 ELSIF p_action='update_refund_status' THEN
   SELECT * INTO original_row FROM public."pos_sale_payments" WHERE id=p_id FOR UPDATE;
   PERFORM 1 FROM public."pos_sale_payments" WHERE original_payment_id=p_id ORDER BY id FOR UPDATE;
 END IF;
 IF target.compensation_id IS NOT NULL THEN SELECT * INTO compensation_row FROM public."pos_payment_compensations" WHERE id=target.compensation_id FOR UPDATE; END IF;
 SELECT * INTO locator FROM public."pos_sale_payments" WHERE id=p_id FOR UPDATE;
 IF p_action IN ('create_commit','create_intent_consumption') THEN
   IF locator.id IS NOT NULL OR p_expected<0 OR plan_row.id IS NULL OR plan_row.version<>p_expected OR plan_row.state<>'active'
     OR slot_row.plan_id IS NULL OR target.type<>'payment' OR target.original_payment_id IS NOT NULL
     OR target.compensation_id IS NOT NULL OR target.payment_plan_id IS DISTINCT FROM plan_row.id
     OR target.processing_session_id IS DISTINCT FROM plan_row.session_id OR target.payment_index IS DISTINCT FROM slot_row.payment_index
     OR target.method IS DISTINCT FROM slot_row.method OR target.amount_cents IS DISTINCT FROM slot_row.amount_cents
     OR target.installments IS DISTINCT FROM slot_row.installments OR target.sale_id IS NULL OR target.refunded_at IS NOT NULL
     OR target.idempotency_key IS DISTINCT FROM p_key
     OR (sale_row.id IS NOT NULL AND (sale_row.branch_id IS DISTINCT FROM plan_row.branch_id OR sale_row.session_id IS DISTINCT FROM plan_row.session_id OR sale_row.operator_profile_id IS DISTINCT FROM plan_row.operator_profile_id OR sale_row.idempotency_key IS DISTINCT FROM plan_row.sale_draft_id))
   THEN RAISE EXCEPTION 'planned sale payment boundary changed' USING ERRCODE='23514'; END IF;
   IF NOT EXISTS (SELECT 1 FROM public."cash_register_sessions" session
       JOIN public."pos_terminals" terminal ON terminal.id=plan_row.terminal_id AND terminal.register_id=plan_row.register_id
       JOIN public."tenant_user_profiles" profile ON profile.id=plan_row.operator_profile_id
       JOIN public."tenant_roles" role ON role.id=profile.role_id AND role.active
       JOIN public."branches" branch ON branch.id=plan_row.branch_id
       JOIN public."pos_registers" register ON register.id=plan_row.register_id AND register.branch_id=plan_row.branch_id
       JOIN public."branch_user_accesses" branch_access ON branch_access.branch_id=plan_row.branch_id AND branch_access.user_profile_id=plan_row.operator_profile_id AND branch_access.can_sell
       JOIN public."pos_register_accesses" register_access ON register_access.register_id=plan_row.register_id AND register_access.user_profile_id=plan_row.operator_profile_id
     WHERE session.id=plan_row.session_id AND session.register_id=plan_row.register_id AND session.operator_profile_id=plan_row.operator_profile_id AND session.status='open'
       AND profile.status='active' AND branch.status='active' AND register.status='active' AND register_access.active AND register_access.can_sell
       AND (register_access.valid_from IS NULL OR register_access.valid_from<=pg_catalog.clock_timestamp())
       AND (register_access.valid_until IS NULL OR register_access.valid_until>pg_catalog.clock_timestamp())
       AND terminal.status='online' AND terminal.paired_at IS NOT NULL AND terminal.revoked_at IS NULL AND terminal.token_hash IS NOT NULL
       AND terminal.token_expires_at>pg_catalog.clock_timestamp() AND terminal.last_seen_at>pg_catalog.clock_timestamp()-interval '5 minutes'
       AND NULLIF(pg_catalog.btrim(terminal.app_version),'') IS NOT NULL)
   THEN RAISE EXCEPTION 'planned sale payment live boundary changed' USING ERRCODE='23514'; END IF;
   IF (p_action='create_commit' AND NOT EXISTS (SELECT 1 FROM public."tenant_user_profiles" WHERE id=plan_row.operator_profile_id AND user_id=p_actor))
     OR (p_action='create_intent_consumption' AND p_actor<>'system:pos-sale-commit')
   THEN RAISE EXCEPTION 'sale payment actor is not bound to the plan' USING ERRCODE='23514'; END IF;
   IF slot_row.proof_kind='intent' AND NOT EXISTS (SELECT 1 FROM public."pos_connectors" connector
       JOIN public."integration_credentials" credential ON credential.id=slot_row.credential_ref AND credential.enabled
       JOIN public."integration_providers" provider ON provider.id=credential.provider_id
     WHERE connector.id=slot_row.connector_id AND connector.id=target.connector_id AND connector.branch_id=plan_row.branch_id
       AND (connector.register_id IS NULL OR connector.register_id=plan_row.register_id) AND connector.status='active'
       AND connector.type LIKE 'payment%' AND connector.provider=slot_row.provider AND connector.provider=target.provider
       AND connector.credential_ref=slot_row.credential_ref AND credential.provider_id=slot_row.provider AND provider.id=connector.provider AND provider.family='payment'
       AND CASE WHEN NOT COALESCE(connector.settings?'methods',false) OR connector.settings->'methods'='null'::jsonb THEN true
         WHEN pg_catalog.jsonb_typeof(connector.settings->'methods')<>'array' THEN false
         ELSE connector.settings->'methods'?target.method AND NOT EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(connector.settings->'methods') configured_method
           WHERE pg_catalog.jsonb_typeof(configured_method)<>'string' OR configured_method#>>'{}' NOT IN ('pix','credit','debit','voucher')) END)
   THEN RAISE EXCEPTION 'intent connector credential/provider boundary changed' USING ERRCODE='23514'; END IF;
   IF slot_row.proof_kind='cash' THEN
     proof_ok:=p_action='create_commit' AND target.status='captured' AND target.provider='cash'
       AND target.tendered_cents>=target.amount_cents AND target.change_cents=target.tendered_cents-target.amount_cents
       AND target.connector_id IS NULL AND target.payment_intent_id IS NULL AND target.value_reservation_id IS NULL
       AND target.value_capture_entry_id IS NULL AND target.value_amount_units IS NULL AND target.manual_payment_case_id IS NULL
       AND public."pos_manual_t2_json_keys_exact_v1"(target.metadata,ARRAY['requestHash']) AND target.metadata->>'requestHash'~'^[0-9a-f]{64}$';
   ELSIF slot_row.proof_kind='value' THEN
     proof_ok:=p_action='create_commit' AND target.status='captured' AND target.provider='pos_value'
       AND target.tendered_cents=target.amount_cents AND target.change_cents=0 AND target.connector_id IS NULL
       AND target.payment_intent_id IS NULL AND target.value_reservation_id IS NOT NULL
       AND target.value_capture_entry_id IS NOT NULL AND target.value_amount_units>0 AND target.manual_payment_case_id IS NULL
       AND public."pos_manual_t2_json_keys_exact_v1"(target.metadata,ARRAY['requestHash','valueAccountId','valueAccountKind','valueAmountUnits','valueReservationId','valueCaptureEntryId'])
       AND target.metadata->>'requestHash'~'^[0-9a-f]{64}$'
       AND EXISTS (SELECT 1 FROM public."pos_value_reservations" reservation
         JOIN public."pos_value_ledger_entries" capture ON capture.id=target.value_capture_entry_id AND capture.account_id=reservation.account_id
         JOIN public."pos_value_accounts" account ON account.id=reservation.account_id
         LEFT JOIN public."pos_value_programs" program ON program.id=account.program_id
         WHERE reservation.id=target.value_reservation_id AND reservation.branch_id=plan_row.branch_id
           AND reservation.state='completed' AND reservation.reference_type='sale_draft' AND reservation.reference_id=plan_row.sale_draft_id
           AND reservation.operation_key=plan_row.sale_draft_id||':value:'||target.payment_index::text||':reserve'
           AND capture.reservation_id=reservation.id AND capture.type='capture' AND capture.amount_units=target.value_amount_units
           AND capture.balance_delta_units=-target.value_amount_units AND capture.reserved_delta_units=-target.value_amount_units
           AND capture.reference_type='sale_draft' AND capture.reference_id=plan_row.sale_draft_id
           AND capture.operation_key=plan_row.sale_draft_id||':value:'||target.payment_index::text||':capture'
           AND account.branch_id=plan_row.branch_id AND ((account.unit='cents' AND target.value_amount_units=target.amount_cents)
             OR (account.kind='loyalty_points' AND program.redeem_cents_per_unit>0 AND target.value_amount_units*program.redeem_cents_per_unit=target.amount_cents))
           AND target.metadata->>'valueAccountId'=account.id AND target.metadata->>'valueAccountKind'=account.kind
           AND target.metadata->>'valueAmountUnits'=target.value_amount_units::text
           AND target.metadata->>'valueReservationId'=target.value_reservation_id
           AND target.metadata->>'valueCaptureEntryId'=target.value_capture_entry_id::text);
   ELSIF slot_row.proof_kind='intent' THEN
     proof_ok:=p_action='create_intent_consumption' AND target.status='captured' AND target.connector_id IS NOT DISTINCT FROM slot_row.connector_id
       AND target.provider IS NOT DISTINCT FROM slot_row.provider AND target.tendered_cents=target.amount_cents AND target.change_cents=0
       AND target.payment_intent_id IS NOT NULL AND target.value_reservation_id IS NULL AND target.value_capture_entry_id IS NULL
       AND target.value_amount_units IS NULL AND target.manual_payment_case_id IS NULL
       AND public."pos_manual_t2_json_keys_exact_v1"(target.metadata,ARRAY['paymentIntentId','evidenceId','providerSequence','providerOccurredAt'])
       AND EXISTS (SELECT 1 FROM public."pos_payment_intents" intent WHERE intent.id=target.payment_intent_id
         AND intent.payment_plan_id=target.payment_plan_id AND intent.payment_index=target.payment_index AND intent.status='captured'
         AND intent.connector_id IS NOT DISTINCT FROM target.connector_id AND intent.provider IS NOT DISTINCT FROM target.provider
         AND intent.method=target.method AND intent.amount_cents=target.amount_cents AND intent.installments=target.installments
         AND intent.provider_reference IS NOT NULL AND intent.provider_occurred_at IS NOT NULL
         AND target.transaction_id IS NOT DISTINCT FROM COALESCE(intent.transaction_id,intent.provider_reference)
         AND target.end_to_end_id IS NOT DISTINCT FROM intent.end_to_end_id AND target.nsu IS NOT DISTINCT FROM intent.nsu
         AND target.authorization_code IS NOT DISTINCT FROM intent.authorization_code AND target.card_brand IS NOT DISTINCT FROM intent.card_brand
         AND target.card_last_four IS NOT DISTINCT FROM intent.card_last_four
         AND target.metadata->>'paymentIntentId'=intent.id AND target.metadata->>'evidenceId' IS NOT DISTINCT FROM intent.evidence_id
         AND target.metadata->>'providerSequence' IS NOT DISTINCT FROM intent.provider_sequence::text
         AND (target.metadata->>'providerOccurredAt')::timestamptz IS NOT DISTINCT FROM intent.provider_occurred_at);
   ELSIF slot_row.proof_kind='manual' THEN
     proof_ok:=p_action='create_commit' AND target.status='manual_confirmed' AND target.provider IS NOT DISTINCT FROM slot_row.provider
       AND target.tendered_cents=target.amount_cents AND target.change_cents=0 AND target.connector_id IS NULL
       AND target.payment_intent_id IS NULL AND target.value_reservation_id IS NULL AND target.value_capture_entry_id IS NULL
       AND target.value_amount_units IS NULL AND target.manual_payment_case_id IS NULL
       AND public."pos_manual_t2_json_keys_exact_v1"(target.metadata,ARRAY['requestHash','confirmationMode','manualReferenceId','manualApprovalId','externalProviderClaim','referenceHash','operatorClaimedOccurredAt'])
       AND target.metadata->>'requestHash'~'^[0-9a-f]{64}$' AND target.metadata->>'confirmationMode'='manual_dual_control'
       AND EXISTS (SELECT 1 FROM public."integration_providers" provider WHERE provider.id=slot_row.provider AND provider.family='payment')
       AND EXISTS (SELECT 1 FROM public."pos_connectors" connector
         JOIN public."integration_credentials" credential ON credential.id=connector.credential_ref AND credential.enabled
         JOIN public."integration_providers" provider ON provider.id=credential.provider_id AND provider.family='payment'
         WHERE connector.provider=slot_row.provider AND connector.branch_id=plan_row.branch_id
           AND (connector.register_id IS NULL OR connector.register_id=plan_row.register_id) AND connector.status='active' AND connector.type LIKE 'payment%')
       AND EXISTS (SELECT 1 FROM public."tenant_user_profiles" profile JOIN public."tenant_roles" role ON role.id=profile.role_id
         LEFT JOIN public."pos_register_accesses" access ON access.register_id=plan_row.register_id AND access.user_profile_id=profile.id
         WHERE profile.id=plan_row.operator_profile_id AND (role.key IN ('owner','admin') OR (access.active AND access.can_manual_payment
           AND (access.valid_from IS NULL OR access.valid_from<=pg_catalog.clock_timestamp()) AND (access.valid_until IS NULL OR access.valid_until>pg_catalog.clock_timestamp()))))
       AND EXISTS (SELECT 1 FROM public."pos_manual_payment_references" reference
         JOIN public."pos_approvals" approval ON approval.id=reference.approval_id
         WHERE reference.id=target.metadata->>'manualReferenceId' AND reference.approval_id=target.metadata->>'manualApprovalId'
           AND reference.payment_plan_id=plan_row.id AND reference.sale_draft_id=plan_row.sale_draft_id
           AND reference.branch_id=plan_row.branch_id AND reference.register_id=plan_row.register_id
           AND reference.session_id=plan_row.session_id AND reference.requester_profile_id=plan_row.operator_profile_id
           AND reference.requester_user_id=p_actor AND reference.payment_index=target.payment_index
           AND reference.method=target.method AND reference.amount_cents=target.amount_cents AND reference.installments=target.installments
           AND reference.provider=target.provider AND reference.reference_hash=target.metadata->>'referenceHash'
           AND target.metadata->>'externalProviderClaim'=reference.provider
           AND (target.metadata->>'operatorClaimedOccurredAt')::timestamptz=reference.occurred_at
           AND reference.status='pending' AND reference.consumed_sale_payment_id IS NULL
           AND ((reference.method='pix' AND target.end_to_end_id=reference.reference AND target.transaction_id IS NULL)
             OR (reference.method<>'pix' AND target.transaction_id=reference.reference AND target.end_to_end_id IS NULL))
           AND approval.status='approved' AND approval.approver_id IS NOT NULL AND approval.approver_id<>approval.requester_id
           AND approval.consumed_at IS NOT NULL AND approval.consumed_by=p_actor
           AND approval.action='payment.manual_reference' AND approval.entity_type='sale_draft' AND approval.entity_id=plan_row.sale_draft_id
           AND approval.consumption_ref=plan_row.sale_draft_id)
       AND 1=(SELECT pg_catalog.count(*) FROM public."pos_manual_t2_write_roots" root
         WHERE root.backend_pid=pg_catalog.pg_backend_pid() AND root.transaction_txid=pg_catalog.txid_current()::numeric
           AND root.capability='payment_artifact:manual_reference' AND root.aggregate_kind='manual_reference'
           AND root.aggregate_id=target.metadata->>'manualReferenceId' AND root.action='consume'
           AND root.trigger_identity='pos_manual_payment_references_t2_write_guard' AND root.dml_operation='UPDATE');
   END IF;
   IF proof_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'sale payment lacks its exact plan-slot proof' USING ERRCODE='23514'; END IF;
   old_doc:=NULL;
 ELSIF p_action LIKE 'insert_refund_%' THEN
   SELECT COALESCE(pg_catalog.sum(amount_cents),0) INTO refund_total FROM public."pos_sale_payments" WHERE original_payment_id=target.original_payment_id AND type='refund';
   IF locator.id IS NOT NULL OR p_expected<>-1 OR original_row.id IS NULL OR original_row.type<>'payment'
     OR original_row.status NOT IN ('captured','manual_confirmed','partially_refunded')
     OR target.type<>'refund' OR target.payment_plan_id IS NOT NULL OR target.payment_index IS NOT NULL
     OR target.payment_intent_id IS NOT NULL OR target.value_reservation_id IS NOT NULL OR target.value_capture_entry_id IS NOT NULL
     OR target.value_amount_units IS NOT NULL OR target.manual_payment_case_id IS NOT NULL
     OR target.sale_id IS DISTINCT FROM original_row.sale_id OR target.method IS DISTINCT FROM original_row.method
     OR target.provider IS DISTINCT FROM original_row.provider OR target.amount_cents<=0
     OR refund_total+target.amount_cents>original_row.amount_cents OR target.status<>'refunded'
     OR target.refunded_at IS NULL OR target.authorized_at IS NOT NULL OR target.captured_at IS NOT NULL
     OR target.idempotency_key IS DISTINCT FROM p_key OR sale_row.id IS NULL
   THEN RAISE EXCEPTION 'refund sale payment boundary changed' USING ERRCODE='23514'; END IF;
   IF p_action='insert_refund_compensation' THEN
     IF compensation_row.id IS NULL OR compensation_row.id IS DISTINCT FROM target.compensation_id
       OR compensation_row.status<>'applied' OR compensation_row.application_state<>'applied' OR compensation_row.provider_state<>'succeeded'
       OR compensation_row.original_payment_id IS DISTINCT FROM original_row.id OR compensation_row.sale_id IS DISTINCT FROM target.sale_id
       OR compensation_row.method IS DISTINCT FROM target.method OR compensation_row.provider IS DISTINCT FROM target.provider
       OR compensation_row.connector_id IS DISTINCT FROM target.connector_id OR compensation_row.confirmed_amount_cents IS DISTINCT FROM target.amount_cents
       OR compensation_row.provider_operation_reference IS DISTINCT FROM target.transaction_id OR compensation_row.provider_occurred_at IS DISTINCT FROM target.refunded_at
       OR target.tendered_cents<>0 OR target.change_cents<>0
       OR public."pos_manual_t2_json_keys_exact_v1"(target.metadata,ARRAY['compensationId','kind','evidenceHash','providerSequence','providerOccurredAt']) IS DISTINCT FROM true
       OR target.metadata->>'compensationId' IS DISTINCT FROM compensation_row.id OR target.metadata->>'evidenceHash' IS DISTINCT FROM compensation_row.evidence_hash
       OR target.metadata->>'kind' IS DISTINCT FROM compensation_row.kind
       OR target.metadata->>'providerSequence' IS DISTINCT FROM compensation_row.provider_sequence::text
       OR (target.metadata->>'providerOccurredAt')::timestamptz IS DISTINCT FROM compensation_row.provider_occurred_at
     THEN RAISE EXCEPTION 'refund compensation evidence changed' USING ERRCODE='23514'; END IF;
   ELSIF p_action='insert_refund_cancel' THEN
     IF target.compensation_id IS NOT NULL OR target.method NOT IN ('cash','store_credit') OR target.amount_cents<>original_row.amount_cents
       OR target.connector_id IS NOT NULL OR target.transaction_id IS NOT NULL OR target.end_to_end_id IS NOT NULL OR target.nsu IS NOT NULL
       OR target.authorization_code IS NOT NULL OR target.tendered_cents<>target.amount_cents OR target.change_cents<>0
       OR target.metadata IS NOT NULL
       OR refund_total<>0 OR sale_row.status<>'completed' OR operation_ref IS NULL
       OR NOT (EXISTS (SELECT 1 FROM public."tenant_user_profiles" profile JOIN public."tenant_roles" role ON role.id=profile.role_id
             LEFT JOIN public."cash_register_sessions" session ON session.id=target.processing_session_id
             LEFT JOIN public."pos_register_accesses" access ON access.register_id=session.register_id AND access.user_profile_id=profile.id
           WHERE profile.user_id=p_actor AND profile.status='active' AND (role.key IN ('owner','admin') OR access.can_cancel))
         OR EXISTS (SELECT 1 FROM public."pos_approvals" approval WHERE approval.action='sale.cancel' AND approval.entity_type='sale'
           AND approval.entity_id=target.sale_id::text AND approval.status='approved' AND approval.requester_id=p_actor
           AND approval.approver_id IS NOT NULL AND approval.approver_id<>approval.requester_id AND approval.consumed_at IS NOT NULL
           AND approval.consumed_by=p_actor AND approval.consumption_ref=operation_ref))
     THEN RAISE EXCEPTION 'cancel refund causal boundary changed' USING ERRCODE='23514'; END IF;
   ELSE
     SELECT original_row.amount_cents-COALESCE(pg_catalog.sum(refund.amount_cents),0) INTO original_available
       FROM public."pos_sale_payments" refund WHERE refund.original_payment_id=original_row.id AND refund.type='refund'
         AND pg_catalog.left(refund.idempotency_key,pg_catalog.length(operation_ref||':refund:'))<>operation_ref||':refund:';
     SELECT COALESCE(pg_catalog.sum(GREATEST(payment.amount_cents-COALESCE(refunded.amount_cents,0),0)),0) INTO earlier_available
       FROM public."pos_sale_payments" payment
       LEFT JOIN LATERAL (SELECT pg_catalog.sum(refund.amount_cents) amount_cents FROM public."pos_sale_payments" refund
         WHERE refund.original_payment_id=payment.id AND refund.type='refund'
           AND pg_catalog.left(refund.idempotency_key,pg_catalog.length(operation_ref||':refund:'))<>operation_ref||':refund:') refunded ON true
       WHERE payment.sale_id=target.sale_id AND payment.type='payment'
         AND ROW(payment.created_at,payment.id)<ROW(original_row.created_at,original_row.id);
     IF target.compensation_id IS NOT NULL OR target.method NOT IN ('cash','store_credit')
       OR target.connector_id IS NOT NULL OR target.transaction_id IS NOT NULL OR target.end_to_end_id IS NOT NULL OR target.nsu IS NOT NULL
       OR target.authorization_code IS NOT NULL OR target.tendered_cents<>target.amount_cents OR target.change_cents<>0
       OR target.metadata IS NOT NULL
       OR return_row.id IS NULL OR return_row.status<>'completed' OR return_row.idempotency_key IS DISTINCT FROM operation_ref
       OR target.amount_cents IS DISTINCT FROM LEAST(original_available,GREATEST(return_row.total_refund_cents-earlier_available,0))
       OR (SELECT COALESCE(pg_catalog.sum(refund.amount_cents),0) FROM public."pos_sale_payments" refund
           WHERE refund.type='refund' AND pg_catalog.left(refund.idempotency_key,pg_catalog.length(operation_ref||':refund:'))=operation_ref||':refund:')+target.amount_cents>return_row.total_refund_cents
       OR NOT (EXISTS (SELECT 1 FROM public."tenant_user_profiles" profile JOIN public."tenant_roles" role ON role.id=profile.role_id
             LEFT JOIN public."cash_register_sessions" session ON session.id=target.processing_session_id
             LEFT JOIN public."pos_register_accesses" access ON access.register_id=session.register_id AND access.user_profile_id=profile.id
           WHERE profile.user_id=p_actor AND profile.status='active' AND (role.key IN ('owner','admin') OR access.can_refund))
         OR EXISTS (SELECT 1 FROM public."pos_approvals" approval WHERE approval.action='return.create' AND approval.entity_type='sale'
           AND approval.entity_id=target.sale_id::text AND approval.status='approved' AND approval.requester_id=p_actor
           AND approval.approver_id IS NOT NULL AND approval.approver_id<>approval.requester_id AND approval.consumed_at IS NOT NULL
           AND approval.consumed_by=p_actor AND approval.consumption_ref=operation_ref))
     THEN RAISE EXCEPTION 'return refund causal boundary changed' USING ERRCODE='23514'; END IF;
   END IF;
   old_doc:=NULL;
 ELSE
   SELECT COALESCE(pg_catalog.sum(amount_cents),0) INTO refund_total FROM public."pos_sale_payments" WHERE original_payment_id=p_id AND type='refund';
   expected_status:=CASE WHEN refund_total=locator.amount_cents THEN 'refunded' WHEN refund_total>0 AND refund_total<locator.amount_cents THEN 'partially_refunded' END;
   IF locator.id IS NULL OR locator.type<>'payment' OR p_expected<>-1 OR expected_status IS NULL OR target.status IS DISTINCT FROM expected_status
     OR p_target->'refunded_at'<>'null'::jsonb
     OR ROW(target.id,target.sale_id,target.connector_id,target.original_payment_id,target.processing_session_id,target.type,target.method,target.amount_cents,target.tendered_cents,target.change_cents,target.provider,target.transaction_id,target.end_to_end_id,target.nsu,target.authorization_code,target.card_brand,target.card_last_four,target.installments,target.idempotency_key,target.payment_intent_id,target.compensation_id,target.payment_plan_id,target.payment_index,target.value_reservation_id,target.value_capture_entry_id,target.value_amount_units,target.manual_payment_case_id,target.metadata,target.authorized_at,target.captured_at)
       IS DISTINCT FROM
       ROW(locator.id,locator.sale_id,locator.connector_id,locator.original_payment_id,locator.processing_session_id,locator.type,locator.method,locator.amount_cents,locator.tendered_cents,locator.change_cents,locator.provider,locator.transaction_id,locator.end_to_end_id,locator.nsu,locator.authorization_code,locator.card_brand,locator.card_last_four,locator.installments,locator.idempotency_key,locator.payment_intent_id,locator.compensation_id,locator.payment_plan_id,locator.payment_index,locator.value_reservation_id,locator.value_capture_entry_id,locator.value_amount_units,locator.manual_payment_case_id,locator.metadata,locator.authorized_at,locator.captured_at)
   THEN RAISE EXCEPTION 'refund update is not exact' USING ERRCODE='23514'; END IF;
   IF expected_status='refunded' THEN target.refunded_at:=now_at; END IF;
   old_doc:=public."pos_manual_t2_sale_payment_projection_v1"(locator);
 END IF;
 target.created_at:=CASE WHEN dml='INSERT' THEN now_at ELSE locator.created_at END; target.updated_at:=now_at; new_doc:=public."pos_manual_t2_sale_payment_projection_v1"(target);
 PERFORM public."pos_manual_t2_open_write_root_v1"('payment_artifact:sale_payment','sale_payment',p_id,p_action,'pos_sale_payments_t2_write_guard',dml,public."pos_manual_t2_authority_v1"('runtime'),ARRAY[public."pos_manual_t2_write_observation_digest_v1"('payment_artifact:sale_payment','sale_payment',p_id,p_action,'pos_sale_payments_t2_write_guard',dml,old_doc,new_doc)]);
END $function$;
CREATE FUNCTION public."pos_manual_t2_sale_payment_root_action_v1"(p_id text,p_dml text) RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE action text; n integer; BEGIN SELECT max(root.action),count(*)::integer INTO action,n FROM public."pos_manual_t2_write_roots" root WHERE root.backend_pid=pg_catalog.pg_backend_pid() AND root.transaction_txid=pg_catalog.txid_current()::numeric AND root.capability='payment_artifact:sale_payment' AND root.aggregate_kind='sale_payment' AND root.aggregate_id=p_id AND root.trigger_identity='pos_sale_payments_t2_write_guard' AND root.dml_operation=p_dml; IF n<>1 THEN RAISE EXCEPTION 'sale payment has no unique capability root' USING ERRCODE='23514'; END IF; RETURN action; END $function$;
CREATE FUNCTION public."protect_pos_sale_payment_t2"() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE action text; old_doc jsonb; new_doc jsonb; BEGIN action:=public."pos_manual_t2_sale_payment_root_action_v1"(NEW.id,TG_OP); IF TG_OP='INSERT' THEN NEW.created_at:=pg_catalog.transaction_timestamp()::timestamp(3); END IF; NEW.updated_at:=pg_catalog.transaction_timestamp()::timestamp(3); IF action='update_refund_status' AND NEW.status='refunded' THEN NEW.refunded_at:=pg_catalog.transaction_timestamp()::timestamp(3); END IF; old_doc:=CASE WHEN TG_OP='UPDATE' THEN public."pos_manual_t2_sale_payment_projection_v1"(OLD) ELSE NULL END; new_doc:=public."pos_manual_t2_sale_payment_projection_v1"(NEW); PERFORM public."pos_manual_t2_observe_write_v1"('payment_artifact:sale_payment','sale_payment',NEW.id,action,'pos_sale_payments_t2_write_guard',TG_OP,old_doc,new_doc); RETURN NEW; EXCEPTION WHEN check_violation OR no_data_found OR too_many_rows THEN RAISE EXCEPTION 'sale payment write requires its exact T2 capability root' USING ERRCODE='42501'; END $function$;
DROP TRIGGER "pos_sale_payments_authoritative_plan_guard" ON public."pos_sale_payments";
CREATE TRIGGER "pos_sale_payments_t2_write_guard" BEFORE INSERT OR UPDATE ON public."pos_sale_payments" FOR EACH ROW EXECUTE FUNCTION public."protect_pos_sale_payment_t2"();

REVOKE ALL ON FUNCTION public."pos_manual_prepare_order_claim_write_v1"(text,text,integer,integer,integer,text,text,text,jsonb),
 public."pos_manual_t2_order_claim_projection_v1"(public."pos_order_claims"),
 public."pos_manual_t2_order_claim_operation_projection_v1"(public."pos_order_claim_operations"),
 public."enforce_pos_order_claim_identity"(),public."protect_pos_order_claim_operation"() FROM PUBLIC;

REVOKE ALL ON FUNCTION public."pos_manual_prepare_held_sale_items_write_v1"(text,text,integer,text,text,text,jsonb,jsonb),public."pos_manual_t2_held_sale_item_projection_v1"(integer,text,integer,integer,double precision,integer,integer,jsonb,text,boolean),public."pos_manual_t2_held_sale_items_request_hash_v1"(text,text,integer,text,text,integer,integer,integer,integer,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_manual_prepare_payment_plan_graph_write_v1"(text,text,integer,text,text,text,jsonb,jsonb,jsonb),
 public."pos_manual_prepare_payment_plan_graph_write_core_v1"(text,text,integer,text,text,text,jsonb,jsonb,jsonb),
 public."pos_manual_t2_payment_plan_graph_request_hash_v1"(text,text,integer,text,text,jsonb,jsonb,jsonb),
 public."pos_manual_t2_plan_transition_projection_v1"(public."pos_payment_plans"),public."pos_manual_t2_plan_quote_projection_v1"(public."pos_payment_plans") FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_manual_prepare_payment_intent_write_v1"(text,text,integer,text,text,text,jsonb),
 public."pos_manual_t2_payment_intent_request_hash_v1"(text,text,integer,text,text,jsonb),public."pos_manual_t2_payment_intent_target_keys_v1"(jsonb),public."pos_manual_t2_payment_intent_transport_projection_v1"(jsonb),
 public."pos_manual_t2_payment_intent_projection_v1"(public."pos_payment_intents"),public."pos_manual_t2_payment_intent_root_action_v1"(text,text),public."pos_manual_t2_observe_payment_intent_v1"(text,text,text,jsonb,jsonb),public."protect_pos_payment_intent_artifact_t2"() FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_manual_prepare_manual_payment_reference_write_v1"(text,text,integer,text,text,text,jsonb),
 public."pos_manual_t2_manual_reference_request_hash_v1"(text,text,integer,text,text,jsonb),public."pos_manual_t2_manual_reference_target_keys_v1"(jsonb),
 public."pos_manual_t2_manual_reference_projection_v1"(public."pos_manual_payment_references"),public."pos_manual_t2_manual_reference_root_action_v1"(text,text),public."pos_manual_t2_observe_manual_reference_v1"(text,text,text,jsonb,jsonb),public."protect_pos_manual_payment_reference_t2"() FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_manual_prepare_sale_payment_write_v1"(text,text,integer,text,text,text,jsonb),public."pos_manual_t2_sale_payment_request_hash_v1"(text,text,integer,text,text,jsonb),public."pos_manual_t2_sale_payment_target_keys_v1"(jsonb),public."pos_manual_t2_sale_payment_evidence_transport_safe_v1"(text),public."pos_manual_t2_sale_payment_projection_v1"(public."pos_sale_payments"),public."pos_manual_t2_sale_payment_root_action_v1"(text,text),public."protect_pos_sale_payment_t2"() FROM PUBLIC;

-- Lifecycle writers are installed fail-closed. The authority registry is
-- intentionally empty until reconcile binds nominal roles and grants exact
-- signatures. Put/activate/retire bodies are added in the same migration by
-- the following owner-only implementation block.

REVOKE ALL ON TABLE public."pos_manual_t2_authorities",public."pos_manual_t2_lock_contexts",public."pos_manual_t2_transaction_nonces",
 public."pos_manual_t2_write_roots",public."pos_manual_t2_write_observations",
 public."pos_manual_profile_operations",public."pos_manual_profile_state_events",
 public."pos_manual_profile_gate_bindings",
 public."pos_manual_profile_admin_assertions",public."pos_manual_profile_accounting_assertions",
 public."pos_manual_profile_fiscal_assertions" FROM PUBLIC;
REVOKE ALL ON SEQUENCE public."pos_manual_t2_lock_contexts_id_seq",public."pos_manual_t2_write_roots_id_seq",public."pos_manual_t2_write_observations_id_seq",public."pos_manual_profile_operations_id_seq",public."pos_manual_profile_state_events_id_seq",public."pos_manual_profile_gate_bindings_id_seq" FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_manual_t2_authority_v1"(text),public."pos_manual_t2_new_handle_v1"(),public."pos_manual_t2_transaction_nonce_hash_v1"(),
 public."pos_manual_t2_write_observation_multiset_digest_v1"(text[]),public."pos_manual_t2_float8_hex_v1"(double precision),public."pos_manual_t2_write_metadata_valid_v1"(text,text,text,text,text,text),
 public."pos_manual_t2_write_authority_capability_v1"(text),
 public."pos_manual_t2_write_observation_digest_v1"(text,text,text,text,text,text,jsonb,jsonb),public."pos_manual_t2_open_write_root_v1"(text,text,text,text,text,text,text,text[]),
 public."pos_manual_t2_legacy_case_projection_v1"(public."pos_manual_payment_cases"),
 public."pos_manual_t2_legacy_operation_projection_v1"(public."pos_manual_payment_operations"),
 public."pos_manual_t2_legacy_state_event_projection_v1"(public."pos_manual_payment_state_events"),
 public."pos_manual_t2_observe_legacy_write_v1"(uuid,text,text,jsonb,jsonb),
 public."pos_manual_t2_observe_legacy_case_v1"(),public."pos_manual_t2_observe_legacy_operation_v1"(),
 public."pos_manual_t2_observe_legacy_state_event_v1"(),
 public."pos_manual_t2_open_legacy_case_root_v1"(text,text,text,public."pos_manual_payment_cases",public."pos_manual_payment_cases"),
 public."pos_manual_t2_open_legacy_operation_root_v1"(text,text,public."pos_manual_payment_operations"),
 public."pos_manual_t2_open_legacy_state_event_root_v1"(text,text,public."pos_manual_payment_state_events"),
 public."pos_manual_t2_observe_write_v1"(text,text,text,text,text,text,jsonb,jsonb),
 public."pos_manual_t2_assert_shape_v1"(text,text),public."pos_manual_t2_profile_request_hash_v1"(text,jsonb),public."pos_manual_t2_subject_safe_v1"(text),public."pos_manual_t2_open_context_v1"(text,text,text),
 public."pos_manual_t2_canonical_text_dlp_safe_v1"(text),public."pos_manual_t2_transition_digest_v1"(text,jsonb),
 public."pos_manual_t2_request_digest_v1"(text,text,text,text,text,text),
 public."pos_manual_t2_insert_transition_context_v1"(text,text,text,jsonb,jsonb,text,text),
 public."pos_manual_t2_json_dlp_safe_v1"(text,jsonb),public."pos_manual_t2_json_keys_exact_v1"(jsonb,text[]),
 public."pos_manual_t2_payment_plan_draft_snapshot_hash_v1"(text),
 public."pos_manual_prepare_session_transition_v1"(text,integer,integer,integer,text,text,text),
 public."pos_manual_prepare_handoff_transition_v1"(text,text,integer,integer,integer,integer,integer,text,text,text,text,timestamptz,jsonb),
 public."pos_manual_prepare_plan_release_v1"(text,text,integer,text,text,text),
 public."pos_manual_issue_profile_admin_assertion_v1"(text,integer,uuid,integer,text,text,text,text,text),
 public."pos_manual_issue_profile_accounting_assertion_v1"(uuid,integer,text,text,text,text,text,text),
 public."pos_manual_issue_profile_fiscal_assertion_v1"(uuid,integer,text,text,text,text,text,text),
 public."pos_manual_put_finalization_profile_v1"(integer,integer,jsonb,integer,text,text,text,text),
 public."pos_manual_activate_finalization_profile_v1"(uuid,integer,text,text,text,text,text,text),
 public."pos_manual_retire_finalization_profile_v1"(uuid,integer,text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."guard_pos_manual_t2_profile_inert"(),public."protect_pos_manual_reconciliation_gate"(),
 public."protect_pos_manual_case"(),public."guard_pos_manual_operation"(),public."guard_pos_manual_state_event"(),
 public."guard_pos_manual_profile_assertion_v1"(),public."block_pos_session_with_manual_case"(),
 public."block_handoff_with_manual_case"(),public."block_plan_release_with_manual_case"(),
 public."protect_held_sale_item_with_open_payment_plan"(),public."protect_pos_payment_plan_quote_line"(),
 public."protect_pos_payment_plan_slot"(),public."validate_pos_payment_plan_activation"(),public."protect_pos_payment_plan"(),
 public."pos_manual_t2_consume_session_event_context_v1"(),public."pos_manual_t2_reject_live_context_at_commit_v1"(),
 public."protect_pos_payment_plan_operation"(),
 public."authorize_pos_payment_plan_artifact"(),public."authorize_pos_sale_payment_plan_slot"(),public."validate_consumed_pos_payment_plan"(),
 public."validate_sale_authoritative_payment_plan_commit"() FROM PUBLIC;

REVOKE ALL ON FUNCTION
 public."pos_manual_review_case_v1_t2_01_impl"(uuid,integer,integer,text,text,text,text,text,text),
 public."pos_manual_record_callback_v1_t2_01_impl"(text,text,text,text,text,text,text,text,timestamptz,text,text,text,integer,text,bigint,timestamptz,integer,text),
 public."pos_manual_attest_query_response_v1_t2_01_impl"(uuid,integer,text,text,text,text,text,text,text,text,text,timestamptz,text,text,text,integer,text,bigint,timestamptz,integer,text),
 public."pos_manual_complete_delivery_v1_t2_01_impl"(uuid,text,uuid,text),
 public."pos_manual_report_transport_v1_t2_01_impl"(uuid,text,text,text),
 public."pos_manual_claim_queries_v1_t2_01_impl"(text,integer,integer,text),
 public."pos_manual_open_case_v1_t2_01_impl"(uuid,text,bigint,text,text,text,text,text,text,text,text,text,text,timestamptz,timestamptz,text)
 FROM PUBLIC;

COMMIT;
