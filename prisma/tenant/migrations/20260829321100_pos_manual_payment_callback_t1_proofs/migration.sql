-- Authenticated provider evidence and the first closed callback/T1 slice.
-- The 320000 hard-disable remains in force. These capabilities are deliberately
-- useless to ordinary runtime roles until a separately audited gate cutover.

CREATE TABLE public."pos_manual_payment_provider_proofs" (
  "id" UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  "source_kind" TEXT NOT NULL CHECK ("source_kind" IN ('callback','query_response')),
  "case_id" UUID REFERENCES public."pos_manual_payment_cases"("id") ON DELETE RESTRICT,
  "attempt_id" UUID REFERENCES public."pos_manual_payment_attempts"("id") ON DELETE RESTRICT,
  "delivery_number" INTEGER,
  "claim_token_hash" TEXT CHECK ("claim_token_hash" IS NULL OR "claim_token_hash" ~ '^[0-9a-f]{64}$'),
  "provider_idempotency_key" TEXT,
  "provider" TEXT NOT NULL,
  "event_id" TEXT NOT NULL,
  "nonce_hash" TEXT NOT NULL CHECK ("nonce_hash" ~ '^[0-9a-f]{64}$'),
  "payload_hash" TEXT NOT NULL CHECK ("payload_hash" ~ '^[0-9a-f]{64}$'),
  "signature_hash" TEXT NOT NULL CHECK ("signature_hash" ~ '^[0-9a-f]{64}$'),
  "canonical_event_hash" TEXT NOT NULL CHECK ("canonical_event_hash" ~ '^[0-9a-f]{64}$'),
  "evidence_hash" TEXT NOT NULL CHECK ("evidence_hash" ~ '^[0-9a-f]{64}$'),
  "auth_key_id" TEXT NOT NULL,
  "event_timestamp" TIMESTAMPTZ NOT NULL,
  "provider_sequence" BIGINT NOT NULL CHECK ("provider_sequence" > 0),
  "provider_occurred_at" TIMESTAMPTZ NOT NULL,
  "outcome" TEXT NOT NULL CHECK ("outcome" IN ('confirmed_paid','not_found','voided','refunded','unknown')),
  "reference_hash" TEXT NOT NULL CHECK ("reference_hash" ~ '^hmac-sha256:v[0-9]+:[0-9a-f]{64}$'),
  "method" TEXT NOT NULL,
  "amount_cents" INTEGER NOT NULL CHECK ("amount_cents" > 0),
  "currency" TEXT NOT NULL CHECK ("currency" = 'BRL'),
  "credential_revision" INTEGER NOT NULL CHECK ("credential_revision" >= 0),
  "verifier_version" TEXT NOT NULL,
  "disposition" TEXT NOT NULL CHECK ("disposition" IN ('accepted','replay','event_conflict','nonce_conflict','orphan_reference','context_mismatch')),
  "event_owner" BOOLEAN NOT NULL,
  "nonce_owner" BOOLEAN NOT NULL,
  "replay_of_proof_id" UUID REFERENCES public."pos_manual_payment_provider_proofs"("id") ON DELETE RESTRICT,
  "caller_role" TEXT NOT NULL,
  "received_at" TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CHECK (length("provider") BETWEEN 2 AND 80 AND length("event_id") BETWEEN 8 AND 160
    AND length("auth_key_id") BETWEEN 3 AND 80 AND length("verifier_version") BETWEEN 1 AND 80),
  CHECK (("source_kind"='callback' AND "attempt_id" IS NULL AND "delivery_number" IS NULL
      AND "claim_token_hash" IS NULL AND "provider_idempotency_key" IS NULL)
    OR ("source_kind"='query_response' AND "case_id" IS NOT NULL AND "attempt_id" IS NOT NULL
      AND "delivery_number" IS NOT NULL AND "delivery_number">0 AND "claim_token_hash" IS NOT NULL
      AND "provider_idempotency_key" IS NOT NULL)),
  CHECK (("disposition"='replay') = ("replay_of_proof_id" IS NOT NULL))
);
CREATE UNIQUE INDEX "pos_manual_provider_proofs_event_owner_key"
  ON public."pos_manual_payment_provider_proofs"("provider","event_id") WHERE "event_owner";
CREATE UNIQUE INDEX "pos_manual_provider_proofs_nonce_owner_key"
  ON public."pos_manual_payment_provider_proofs"("provider","nonce_hash") WHERE "nonce_owner";
CREATE INDEX "pos_manual_provider_proofs_exact_transport_idx"
  ON public."pos_manual_payment_provider_proofs"("provider","payload_hash","signature_hash");
CREATE INDEX "pos_manual_provider_proofs_case_sequence_idx"
  ON public."pos_manual_payment_provider_proofs"("case_id","provider_sequence","received_at");

ALTER TABLE public."pos_manual_payment_delivery_results"
  ADD COLUMN "provider_proof_id" UUID UNIQUE REFERENCES public."pos_manual_payment_provider_proofs"("id") ON DELETE RESTRICT,
  ADD COLUMN "processing_result" TEXT NOT NULL DEFAULT 'applied_transition',
  ADD COLUMN "completion_idempotency_key" TEXT UNIQUE;
ALTER TABLE public."pos_manual_payment_delivery_results" DROP CONSTRAINT "pos_manual_payment_delivery_results_result_kind_check";
ALTER TABLE public."pos_manual_payment_delivery_results" ADD CONSTRAINT "pos_manual_delivery_result_kind_321e_check"
  CHECK ("result_kind" IN ('provider_result','transport_pre_dispatch_failure','transport_outcome_unknown','protocol_rejected'));
ALTER TABLE public."pos_manual_payment_delivery_results" ADD CONSTRAINT "pos_manual_delivery_processing_321e_check"
  CHECK ("processing_result" IN ('applied_transition','applied_no_change','retry_scheduled','ignored_stale','incident_opened','terminal_blocked'));
ALTER TABLE public."pos_manual_payment_delivery_results" ADD CONSTRAINT "pos_manual_delivery_proof_321e_check"
  CHECK (("result_kind"='provider_result')=("provider_proof_id" IS NOT NULL));
ALTER TABLE public."pos_manual_payment_delivery_results" ALTER COLUMN "processing_result" DROP DEFAULT;

CREATE TABLE public."pos_manual_payment_proof_consumptions" (
  "proof_id" UUID PRIMARY KEY REFERENCES public."pos_manual_payment_provider_proofs"("id") ON DELETE RESTRICT,
  "delivery_result_id" BIGINT NOT NULL UNIQUE REFERENCES public."pos_manual_payment_delivery_results"("id") ON DELETE RESTRICT,
  "consumed_at" TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  "consumer_role" TEXT NOT NULL
);

ALTER TABLE public."pos_manual_payment_callbacks"
  ADD COLUMN "ingress_proof_id" UUID UNIQUE REFERENCES public."pos_manual_payment_provider_proofs"("id") ON DELETE RESTRICT,
  ADD COLUMN "canonical_event_hash" TEXT,
  ADD COLUMN "nonce_hash" TEXT,
  ADD COLUMN "evidence_hash" TEXT,
  ADD COLUMN "event_timestamp" TIMESTAMPTZ,
  ADD COLUMN "credential_revision" INTEGER,
  ADD COLUMN "verifier_version" TEXT;
ALTER TABLE public."pos_manual_payment_callbacks" DROP CONSTRAINT "pos_manual_payment_callbacks_processing_result_check";
ALTER TABLE public."pos_manual_payment_callbacks" ADD CONSTRAINT "pos_manual_callback_processing_321e_check"
  CHECK ("processing_result" IN ('applied_transition','applied_no_change','retry_scheduled','ignored_stale','incident_opened'));
ALTER TABLE public."pos_manual_payment_callbacks" ADD CONSTRAINT "pos_manual_callback_proof_321e_check"
  CHECK ("ingress_proof_id" IS NOT NULL AND "canonical_event_hash" ~ '^[0-9a-f]{64}$'
    AND "nonce_hash" ~ '^[0-9a-f]{64}$' AND "evidence_hash" ~ '^[0-9a-f]{64}$'
    AND "event_timestamp" IS NOT NULL AND "credential_revision">=0 AND length("verifier_version") BETWEEN 1 AND 80
    AND "key_id"="auth_key_id");

ALTER TABLE public."pos_manual_payment_incidents" ALTER COLUMN "case_id" DROP NOT NULL;
ALTER TABLE public."pos_manual_payment_incidents"
  ADD COLUMN "provider_proof_id" UUID UNIQUE REFERENCES public."pos_manual_payment_provider_proofs"("id") ON DELETE RESTRICT;

CREATE TRIGGER "pos_manual_provider_proofs_append_only" BEFORE UPDATE OR DELETE
  ON public."pos_manual_payment_provider_proofs" FOR EACH ROW
  EXECUTE FUNCTION public."protect_pos_manual_append_only"();
CREATE TRIGGER "pos_manual_proof_consumptions_append_only" BEFORE UPDATE OR DELETE
  ON public."pos_manual_payment_proof_consumptions" FOR EACH ROW
  EXECUTE FUNCTION public."protect_pos_manual_append_only"();

-- Same-state observations still advance the aggregate version. This replacement
-- preserves every 320000 invariant and only broadens a transition when an exact
-- same-transaction observe operation exists.
CREATE OR REPLACE FUNCTION public."protect_pos_manual_case"() RETURNS trigger AS $$
DECLARE
  plan_record public."pos_payment_plans"%ROWTYPE;
  slot_record public."pos_payment_plan_slots"%ROWTYPE;
  matching_operation public."pos_manual_payment_operations"%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO plan_record FROM public."pos_payment_plans" WHERE "id" = NEW."payment_plan_id";
    IF plan_record."id" IS NULL THEN RAISE EXCEPTION 'manual case requires an authoritative plan' USING ERRCODE='23503'; END IF;
    PERFORM 1 FROM public."cash_register_sessions" WHERE "id"=plan_record."session_id" AND "status"='open' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'manual case requires an open session' USING ERRCODE='23514'; END IF;
    PERFORM 1 FROM public."pos_terminals" WHERE "id"=plan_record."terminal_id" AND "status"='online' AND "revoked_at" IS NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'manual case requires a live terminal' USING ERRCODE='23514'; END IF;
    PERFORM public."assert_pos_payment_plan_live_access"(plan_record);
    IF plan_record."order_claim_id" IS NOT NULL THEN PERFORM 1 FROM public."pos_order_claims" WHERE "id"=plan_record."order_claim_id" FOR UPDATE; END IF;
    PERFORM 1 FROM public."pos_held_sales" WHERE "id"=plan_record."sale_draft_id" FOR UPDATE;
    SELECT * INTO plan_record FROM public."pos_payment_plans" WHERE "id"=NEW."payment_plan_id" FOR UPDATE;
    SELECT * INTO slot_record FROM public."pos_payment_plan_slots" WHERE "plan_id"=NEW."payment_plan_id" AND "payment_index"=NEW."payment_index" FOR UPDATE;
    IF plan_record."state" <> 'active' OR plan_record."expires_at" <= pg_catalog.clock_timestamp() OR slot_record."proof_kind" <> 'manual'
      OR NEW."payment_index" <> 0 OR (SELECT count(*) FROM public."pos_payment_plan_slots" WHERE "plan_id"=NEW."payment_plan_id") <> 1
      OR ROW(NEW."branch_id",NEW."register_id",NEW."session_id",NEW."operator_profile_id",NEW."terminal_id",NEW."sale_draft_id",NEW."draft_revision",NEW."draft_request_hash",NEW."quote_hash",NEW."order_claim_id")
        IS DISTINCT FROM ROW(plan_record."branch_id",plan_record."register_id",plan_record."session_id",plan_record."operator_profile_id",plan_record."terminal_id",plan_record."sale_draft_id",plan_record."draft_revision",plan_record."draft_request_hash",plan_record."quote_hash",plan_record."order_claim_id")
      OR ROW(NEW."method",NEW."amount_cents",NEW."installments",NEW."provider",NEW."connector_id",NEW."credential_ref")
        IS DISTINCT FROM ROW(slot_record."method",slot_record."amount_cents",slot_record."installments",slot_record."provider",slot_record."connector_id",slot_record."credential_ref")
      OR NEW."currency" <> plan_record."currency" OR NEW."amount_cents" <> plan_record."total_cents"
      OR NOT EXISTS (SELECT 1 FROM public."pos_connectors" c JOIN public."integration_credentials" credential ON credential."id"=c."credential_ref"
        WHERE c."id"=NEW."connector_id" AND c."revision"=NEW."connector_revision" AND c."status"='active'
          AND credential."id"=NEW."credential_ref" AND credential."revision"=NEW."credential_revision" AND credential."enabled"=true
          AND c."settings" @> '{"manualReconciliation":{"enabled":true,"vaultBindingRequired":true}}'::jsonb
          AND c."settings"->'capabilities' ? 'manual_reference_query')
    THEN RAISE EXCEPTION 'manual case diverges from its single authoritative slot' USING ERRCODE='23514'; END IF;
    IF NEW."maker_profile_id" <> NEW."operator_profile_id" OR NEW."state" <> 'review_pending' OR NEW."version" <> 0 THEN
      RAISE EXCEPTION 'manual case must start review_pending by its operator' USING ERRCODE='23514';
    END IF;
    NEW."created_at" := pg_catalog.clock_timestamp(); NEW."updated_at" := NEW."created_at";
    NEW."expires_at" := LEAST(plan_record."expires_at", NEW."created_at" + interval '15 minutes');
    NEW."lifecycle_txid" := pg_catalog.txid_current()::numeric;
    RETURN NEW;
  END IF;
  IF ROW(NEW."branch_id",NEW."register_id",NEW."session_id",NEW."operator_profile_id",NEW."terminal_id",NEW."sale_draft_id",NEW."draft_revision",NEW."draft_request_hash",NEW."quote_hash",NEW."order_claim_id",NEW."payment_plan_id",NEW."payment_index",NEW."method",NEW."amount_cents",NEW."currency",NEW."installments",NEW."provider",NEW."connector_id",NEW."connector_revision",NEW."credential_ref",NEW."credential_revision",NEW."reference_hash",NEW."reference_key_id",NEW."reference_last_four",NEW."occurred_at",NEW."reason_code",NEW."maker_profile_id",NEW."maker_user_id",NEW."idempotency_key",NEW."request_hash",NEW."expires_at",NEW."created_at")
    IS DISTINCT FROM ROW(OLD."branch_id",OLD."register_id",OLD."session_id",OLD."operator_profile_id",OLD."terminal_id",OLD."sale_draft_id",OLD."draft_revision",OLD."draft_request_hash",OLD."quote_hash",OLD."order_claim_id",OLD."payment_plan_id",OLD."payment_index",OLD."method",OLD."amount_cents",OLD."currency",OLD."installments",OLD."provider",OLD."connector_id",OLD."connector_revision",OLD."credential_ref",OLD."credential_revision",OLD."reference_hash",OLD."reference_key_id",OLD."reference_last_four",OLD."occurred_at",OLD."reason_code",OLD."maker_profile_id",OLD."maker_user_id",OLD."idempotency_key",OLD."request_hash",OLD."expires_at",OLD."created_at")
  THEN RAISE EXCEPTION 'manual case identity and TTL are immutable' USING ERRCODE='23514'; END IF;
  IF NEW."state" IS DISTINCT FROM OLD."state" OR NEW."version" IS DISTINCT FROM OLD."version" THEN
    SELECT * INTO matching_operation FROM public."pos_manual_payment_operations" operation
      WHERE operation."case_id"=OLD."id" AND operation."expected_version"=OLD."version"
        AND operation."resulting_version"=NEW."version" AND operation."resulting_state"=NEW."state"
        AND operation."write_txid"=pg_catalog.txid_current()::numeric;
    IF matching_operation."id" IS NULL OR NEW."version" <> OLD."version"+1 THEN
      RAISE EXCEPTION 'manual case transition requires exact same-tx operation' USING ERRCODE='23514'; END IF;
    IF matching_operation."action"='observe' AND OLD."state"=NEW."state" THEN
      IF OLD."state" NOT IN ('unknown','confirmed_paid','no_funds','application_pending','blocked','applied','rejected','expired') THEN
        RAISE EXCEPTION 'invalid manual payment same-state observation' USING ERRCODE='23514'; END IF;
    ELSIF NOT ((OLD."state"='review_pending' AND NEW."state" IN ('rejected','unknown','expired'))
      OR (OLD."state"='unknown' AND NEW."state" IN ('confirmed_paid','no_funds','blocked','expired'))
      OR (OLD."state"='confirmed_paid' AND NEW."state" IN ('application_pending','blocked','expired'))
      OR (OLD."state"='application_pending' AND NEW."state" IN ('applied','blocked'))
      OR (OLD."state" IN ('rejected','no_funds','expired') AND NEW."state"='blocked')) THEN
      RAISE EXCEPTION 'invalid manual payment case transition' USING ERRCODE='23514'; END IF;
    NEW."lifecycle_txid":=pg_catalog.txid_current()::numeric; NEW."updated_at":=pg_catalog.clock_timestamp();
    IF NEW."state" IN ('rejected','unknown') AND OLD."state"='review_pending' THEN NEW."reviewed_at":=pg_catalog.clock_timestamp(); END IF;
    IF NEW."state"='confirmed_paid' AND OLD."state"<>'confirmed_paid' THEN NEW."confirmation_expires_at":=LEAST(pg_catalog.clock_timestamp()+interval '5 minutes', NEW."expires_at"); END IF;
    IF NEW."state"='expired' AND OLD."state"<>'expired' THEN NEW."expired_at":=pg_catalog.clock_timestamp(); END IF;
    IF NEW."state"='applied' AND OLD."state"<>'applied' THEN NEW."applied_at":=pg_catalog.clock_timestamp(); END IF;
  ELSE
    IF ROW(NEW."provider_outcome",NEW."confirmation_expires_at",NEW."applied_sale_payment_id",NEW."lifecycle_txid",NEW."reviewed_at",NEW."applied_at",NEW."expired_at")
      IS DISTINCT FROM ROW(OLD."provider_outcome",OLD."confirmation_expires_at",OLD."applied_sale_payment_id",OLD."lifecycle_txid",OLD."reviewed_at",OLD."applied_at",OLD."expired_at")
    THEN RAISE EXCEPTION 'manual case lifecycle evidence requires transition' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public."guard_pos_manual_operation"() RETURNS trigger AS $$
DECLARE case_record public."pos_manual_payment_cases"%ROWTYPE;
BEGIN
  NEW."write_txid":=pg_catalog.txid_current()::numeric;
  SELECT * INTO case_record FROM public."pos_manual_payment_cases" WHERE "id"=NEW."case_id";
  IF case_record."id" IS NULL THEN RAISE EXCEPTION 'manual operation requires an existing case' USING ERRCODE='23503'; END IF;
  PERFORM 1 FROM public."cash_register_sessions" WHERE "id"=case_record."session_id" FOR UPDATE;
  PERFORM 1 FROM public."pos_terminals" WHERE "id"=case_record."terminal_id" FOR UPDATE;
  PERFORM 1 FROM public."tenant_user_profiles" WHERE "id"=case_record."operator_profile_id" FOR SHARE;
  PERFORM 1 FROM public."branches" WHERE "id"=case_record."branch_id" FOR SHARE;
  PERFORM 1 FROM public."pos_registers" WHERE "id"=case_record."register_id" FOR SHARE;
  IF case_record."order_claim_id" IS NOT NULL THEN PERFORM 1 FROM public."pos_order_claims" WHERE "id"=case_record."order_claim_id" FOR UPDATE; END IF;
  PERFORM 1 FROM public."pos_held_sales" WHERE "id"=case_record."sale_draft_id" FOR UPDATE;
  PERFORM 1 FROM public."pos_payment_plans" WHERE "id"=case_record."payment_plan_id" FOR UPDATE;
  PERFORM 1 FROM public."pos_payment_plan_slots" WHERE "plan_id"=case_record."payment_plan_id" AND "payment_index"=case_record."payment_index" FOR UPDATE;
  PERFORM 1 FROM public."pos_connectors" WHERE "id"=case_record."connector_id" FOR SHARE;
  PERFORM 1 FROM public."integration_credentials" WHERE "id"=case_record."credential_ref" FOR SHARE;
  SELECT * INTO case_record FROM public."pos_manual_payment_cases" WHERE "id"=NEW."case_id" FOR UPDATE;
  IF NEW."expected_version" IS DISTINCT FROM (CASE WHEN NEW."action"='open' THEN -1 ELSE case_record."version" END)
    OR NEW."resulting_version"<>NEW."expected_version"+1
    OR NOT ((NEW."action"='open' AND case_record."state"='review_pending' AND NEW."resulting_state"='review_pending' AND NEW."review_id" IS NULL AND NEW."observation_id" IS NULL AND NEW."application_id" IS NULL)
      OR (NEW."action"='authorize_query' AND case_record."state"='review_pending' AND NEW."resulting_state"='unknown' AND NEW."review_id" IS NOT NULL)
      OR (NEW."action"='reject' AND case_record."state"='review_pending' AND NEW."resulting_state"='rejected' AND NEW."review_id" IS NOT NULL)
      OR (NEW."action"='observe' AND case_record."state" IN ('unknown','confirmed_paid','no_funds','application_pending','blocked','applied','rejected','expired')
        AND (NEW."resulting_state"=case_record."state" OR NEW."resulting_state" IN ('confirmed_paid','no_funds','blocked')) AND NEW."observation_id" IS NOT NULL)
      OR (NEW."action"='reserve_application' AND case_record."state"='confirmed_paid' AND NEW."resulting_state"='application_pending' AND NEW."application_id" IS NOT NULL)
      OR (NEW."action"='apply' AND case_record."state"='application_pending' AND NEW."resulting_state"='applied' AND NEW."application_id" IS NOT NULL)
      OR (NEW."action"='expire' AND case_record."state" IN ('review_pending','unknown','confirmed_paid') AND NEW."resulting_state"='expired')
      OR (NEW."action"='block' AND NEW."resulting_state"='blocked'))
  THEN RAISE EXCEPTION 'manual operation action/state/causal row mismatch' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

-- Internal canonical lock helper. It has no operational EXECUTE grant.
CREATE FUNCTION public."pos_manual_lock_case_graph_321e"(p_case_id UUID)
RETURNS public."pos_manual_payment_cases"
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE c public."pos_manual_payment_cases"%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public."pos_manual_payment_cases" WHERE "id"=p_case_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'manual case not found' USING ERRCODE='23503'; END IF;
  PERFORM 1 FROM public."cash_register_sessions" WHERE "id"=c."session_id" FOR UPDATE;
  PERFORM 1 FROM public."pos_terminals" WHERE "id"=c."terminal_id" FOR UPDATE;
  PERFORM 1 FROM public."tenant_user_profiles" WHERE "id"=c."operator_profile_id" FOR SHARE;
  PERFORM 1 FROM public."branches" WHERE "id"=c."branch_id" FOR SHARE;
  PERFORM 1 FROM public."pos_registers" WHERE "id"=c."register_id" FOR SHARE;
  PERFORM 1 FROM public."branch_user_accesses"
   WHERE "branch_id"=c."branch_id" AND "user_profile_id"=c."operator_profile_id" FOR SHARE;
  PERFORM 1 FROM public."pos_register_accesses"
   WHERE "register_id"=c."register_id" AND "user_profile_id"=c."operator_profile_id" FOR SHARE;
  IF c."order_claim_id" IS NOT NULL THEN PERFORM 1 FROM public."pos_order_claims" WHERE "id"=c."order_claim_id" FOR UPDATE; END IF;
  PERFORM 1 FROM public."pos_held_sales" WHERE "id"=c."sale_draft_id" FOR UPDATE;
  PERFORM 1 FROM public."pos_payment_plans" WHERE "id"=c."payment_plan_id" FOR UPDATE;
  PERFORM 1 FROM public."pos_payment_plan_slots" WHERE "plan_id"=c."payment_plan_id" AND "payment_index"=c."payment_index" FOR UPDATE;
  PERFORM 1 FROM public."pos_connectors" WHERE "id"=c."connector_id" FOR SHARE;
  PERFORM 1 FROM public."integration_credentials" WHERE "id"=c."credential_ref" FOR SHARE;
  PERFORM 1 FROM public."integration_providers" WHERE "id"=c."provider" FOR SHARE;
  PERFORM 1 FROM public."pos_manual_payment_reconciliation_gates" WHERE "connector_id"=c."connector_id" FOR SHARE;
  PERFORM 1 FROM public."pos_manual_payment_vault_bindings" WHERE "case_id"=c."id" FOR SHARE;
  SELECT * INTO c FROM public."pos_manual_payment_cases" WHERE "id"=p_case_id FOR UPDATE;
  RETURN c;
END; $$;
REVOKE ALL ON FUNCTION public."pos_manual_lock_case_graph_321e"(UUID) FROM PUBLIC;

-- Returns null when the frozen operational/authentication boundary diverged.
CREATE FUNCTION public."pos_manual_boundary_failure_321e"(
  p_case_id UUID, p_auth_key_id TEXT, p_credential_revision INTEGER, p_now TIMESTAMPTZ
) RETURNS TEXT
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE c public."pos_manual_payment_cases"%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public."pos_manual_payment_cases" WHERE "id"=p_case_id;
  IF NOT EXISTS (
    SELECT 1
      FROM public."cash_register_sessions" session
      JOIN public."pos_terminals" terminal ON terminal."id"=c."terminal_id"
      JOIN public."tenant_user_profiles" profile ON profile."id"=c."operator_profile_id"
      JOIN public."branches" branch ON branch."id"=c."branch_id"
      JOIN public."pos_registers" register ON register."id"=c."register_id"
      JOIN public."branch_user_accesses" branch_grant
        ON branch_grant."branch_id"=c."branch_id" AND branch_grant."user_profile_id"=c."operator_profile_id"
      JOIN public."pos_register_accesses" register_grant
        ON register_grant."register_id"=c."register_id" AND register_grant."user_profile_id"=c."operator_profile_id"
      JOIN public."pos_held_sales" draft ON draft."id"=c."sale_draft_id"
      JOIN public."pos_payment_plans" plan ON plan."id"=c."payment_plan_id"
      JOIN public."pos_payment_plan_slots" slot ON slot."plan_id"=plan."id" AND slot."payment_index"=0
      JOIN public."pos_connectors" connector ON connector."id"=c."connector_id"
      JOIN public."integration_credentials" credential ON credential."id"=c."credential_ref"
      JOIN public."integration_providers" provider ON provider."id"=c."provider"
      JOIN public."pos_manual_payment_reconciliation_gates" gate ON gate."connector_id"=connector."id"
      JOIN public."pos_manual_payment_vault_bindings" vault ON vault."case_id"=c."id"
      LEFT JOIN public."pos_order_claims" order_claim ON order_claim."id"=c."order_claim_id"
     WHERE session."id"=c."session_id" AND session."register_id"=c."register_id"
       AND session."operator_profile_id"=c."operator_profile_id" AND session."status"='open'
       AND terminal."register_id"=c."register_id" AND terminal."status"='online'
       AND terminal."paired_at" IS NOT NULL AND terminal."revoked_at" IS NULL
       AND terminal."token_hash" IS NOT NULL AND terminal."token_expires_at">p_now
       AND terminal."last_seen_at">p_now-interval '5 minutes'
       AND terminal."app_version" IS NOT NULL AND length(pg_catalog.btrim(terminal."app_version"))>0
       AND profile."user_id"=c."maker_user_id" AND profile."status"='active'
       AND branch."status"='active' AND register."branch_id"=c."branch_id" AND register."status"='active'
       AND branch_grant."can_sell"=true
       AND register_grant."active"=true AND register_grant."can_sell"=true
       AND register_grant."can_manual_payment"=true
       AND (register_grant."valid_from" IS NULL OR register_grant."valid_from"<=p_now)
       AND (register_grant."valid_until" IS NULL OR register_grant."valid_until">=p_now)
       AND c."expires_at">p_now
       AND ROW(draft."register_id",draft."session_id",draft."operator_profile_id",draft."revision",draft."request_hash",draft."status")
         IS NOT DISTINCT FROM ROW(c."register_id",c."session_id",c."operator_profile_id",c."draft_revision",c."draft_request_hash",plan."draft_status")
       AND (draft."expires_at" IS NULL OR draft."expires_at">p_now)
       AND ROW(plan."branch_id",plan."register_id",plan."session_id",plan."operator_profile_id",plan."terminal_id",
         plan."sale_draft_id",plan."draft_revision",plan."draft_request_hash",plan."quote_hash",plan."order_claim_id",
         plan."currency",plan."total_cents",plan."state")
         IS NOT DISTINCT FROM ROW(c."branch_id",c."register_id",c."session_id",c."operator_profile_id",c."terminal_id",
         c."sale_draft_id",c."draft_revision",c."draft_request_hash",c."quote_hash",c."order_claim_id",
         c."currency",c."amount_cents",'active')
       AND plan."expires_at">p_now
       AND ROW(slot."payment_index",slot."method",slot."amount_cents",slot."installments",slot."proof_kind",
         slot."provider",slot."connector_id",slot."credential_ref")
         IS NOT DISTINCT FROM ROW(c."payment_index",c."method",c."amount_cents",c."installments",'manual',
         c."provider",c."connector_id",c."credential_ref")
       AND connector."status"='active' AND connector."revision"=c."connector_revision"
       AND connector."branch_id"=c."branch_id" AND (connector."register_id" IS NULL OR connector."register_id"=c."register_id")
       AND connector."provider"=c."provider" AND connector."credential_ref"=c."credential_ref"
       AND connector."settings" @> '{"manualReconciliation":{"enabled":true,"vaultBindingRequired":true}}'::jsonb
       AND connector."settings"->'capabilities' ? 'manual_reference_query'
       AND credential."enabled"=true AND credential."revision"=c."credential_revision"
       AND credential."revision"=p_credential_revision AND credential."provider_id"=c."provider"
       AND provider."family"='payment'
       AND gate."enabled"=true AND gate."connector_revision"=c."connector_revision"
       AND gate."credential_ref"=c."credential_ref" AND gate."credential_revision"=c."credential_revision"
       AND gate."vault_adapter_id" IS NOT NULL AND gate."provider_adapter_version" IS NOT NULL
       AND gate."config_hash" ~ '^[0-9a-f]{64}$'
       AND vault."retention_expires_at">p_now
       AND CASE WHEN pg_catalog.jsonb_typeof(credential."config"->'manualReconciliation'->'callbackAuthKeyIds')='array'
         AND pg_catalog.jsonb_array_length(credential."config"->'manualReconciliation'->'callbackAuthKeyIds') BETWEEN 1 AND 16
         THEN EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements_text(
           credential."config"->'manualReconciliation'->'callbackAuthKeyIds') key_id WHERE key_id=p_auth_key_id)
         ELSE false END
       AND (c."order_claim_id" IS NULL OR (order_claim."id"=c."order_claim_id"
         AND order_claim."branch_id"=c."branch_id" AND order_claim."register_id"=c."register_id"
         AND order_claim."session_id"=c."session_id" AND order_claim."operator_profile_id"=c."operator_profile_id"
         AND order_claim."terminal_id"=c."terminal_id" AND order_claim."state"='active'
         AND order_claim."lease_expires_at">p_now))
  ) THEN RETURN 'manual_boundary_changed'; END IF;
  RETURN NULL;
END; $$;
REVOKE ALL ON FUNCTION public."pos_manual_boundary_failure_321e"(UUID,TEXT,INTEGER,TIMESTAMPTZ) FROM PUBLIC;

CREATE FUNCTION public."pos_manual_record_callback_v1"(
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
  INSERT INTO public."pos_manual_payment_operations" (
    "case_id","action","expected_version","resulting_version","resulting_state","observation_id",
    "idempotency_key","request_hash","write_txid"
  ) VALUES (case_record."id",'observe',case_record."version",next_version,next_state,observation_record."id",
    'manual-callback:'||p_provider||':'||p_event_id,p_canonical_event_hash,pg_catalog.txid_current()::numeric)
  RETURNING * INTO operation_record;
  INSERT INTO public."pos_manual_payment_state_events" (
    "case_id","operation_id","from_state","to_state","resulting_version","source","source_id","write_txid"
  ) VALUES (case_record."id",operation_record."id",case_record."state",next_state,next_version,'callback',p_event_id,
    pg_catalog.txid_current()::numeric);
  UPDATE public."pos_manual_payment_cases" SET "state"=next_state,"version"=next_version,
    "provider_outcome"=CASE WHEN incident_code IS NULL THEN p_outcome ELSE case_record."provider_outcome" END,
    "next_reconcile_at"=CASE WHEN processing_result='retry_scheduled' THEN now_at+interval '30 seconds' ELSE NULL END,
    "confirmed_observation_id"=CASE WHEN next_state='confirmed_paid' AND case_record."state"<>'confirmed_paid' THEN observation_record."id" ELSE "confirmed_observation_id" END,
    "confirmed_at"=CASE WHEN next_state='confirmed_paid' AND case_record."state"<>'confirmed_paid' THEN now_at ELSE "confirmed_at" END,
    "no_funds_at"=CASE WHEN next_state='no_funds' AND case_record."state"<>'no_funds' THEN now_at ELSE "no_funds_at" END,
    "blocked_at"=CASE WHEN next_state='blocked' AND case_record."state"<>'blocked' THEN now_at ELSE "blocked_at" END
   WHERE "id"=case_record."id";
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

REVOKE ALL ON FUNCTION public."pos_manual_record_callback_v1"(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ,TEXT,TEXT,TEXT,INTEGER,TEXT,BIGINT,TIMESTAMPTZ,INTEGER,TEXT) FROM PUBLIC;

CREATE FUNCTION public."pos_manual_attest_query_response_v1"(
  p_attempt_id UUID, p_delivery_number INTEGER, p_provider_idempotency_key TEXT,
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
  attempt_record public."pos_manual_payment_attempts"%ROWTYPE;
  outbox_record public."pos_manual_payment_outbox"%ROWTYPE;
  case_record public."pos_manual_payment_cases"%ROWTYPE;
  exact_proof public."pos_manual_payment_provider_proofs"%ROWTYPE;
  event_proof public."pos_manual_payment_provider_proofs"%ROWTYPE;
  nonce_proof public."pos_manual_payment_provider_proofs"%ROWTYPE;
  proof_record public."pos_manual_payment_provider_proofs"%ROWTYPE;
  boundary_failure TEXT;
BEGIN
  IF p_attempt_id IS NULL OR p_delivery_number IS NULL OR p_delivery_number<=0
    OR p_provider_idempotency_key IS NULL OR length(p_provider_idempotency_key) NOT BETWEEN 8 AND 200
    OR p_provider IS NULL OR p_provider !~ '^[a-z][a-z0-9._:-]{1,79}$'
    OR p_event_id IS NULL OR p_event_id !~ '^evt:[0-9a-f]{64}$'
    OR p_nonce_hash !~ '^[0-9a-f]{64}$' OR p_payload_hash !~ '^[0-9a-f]{64}$'
    OR p_signature_hash !~ '^[0-9a-f]{64}$' OR p_canonical_event_hash !~ '^[0-9a-f]{64}$'
    OR p_evidence_hash !~ '^[0-9a-f]{64}$' OR p_auth_key_id !~ '^[A-Za-z][A-Za-z0-9._:-]{2,79}$'
    OR p_event_timestamp IS NULL OR abs(extract(epoch FROM (now_at-p_event_timestamp)))>300
    OR p_outcome NOT IN ('confirmed_paid','not_found','voided','refunded','unknown')
    OR p_reference_hash !~ '^hmac-sha256:v[0-9]+:[0-9a-f]{64}$'
    OR p_method !~ '^[a-z][a-z0-9._:-]{1,39}$' OR p_amount_cents IS NULL OR p_amount_cents<=0
    OR p_currency IS DISTINCT FROM 'BRL' OR p_provider_sequence IS NULL OR p_provider_sequence<=0
    OR p_provider_occurred_at IS NULL OR p_credential_revision IS NULL OR p_credential_revision<0
    OR p_verifier_version IS NULL OR p_verifier_version !~ '^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,79}$'
  THEN RAISE EXCEPTION 'invalid authenticated query-response envelope' USING ERRCODE='22023'; END IF;

  SELECT * INTO attempt_record FROM public."pos_manual_payment_attempts" WHERE "id"=p_attempt_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'manual query attempt not found' USING ERRCODE='23503'; END IF;
  case_record := public."pos_manual_lock_case_graph_321e"(attempt_record."case_id");
  SELECT * INTO attempt_record FROM public."pos_manual_payment_attempts" WHERE "id"=p_attempt_id FOR UPDATE;
  SELECT * INTO outbox_record FROM public."pos_manual_payment_outbox" WHERE "attempt_id"=p_attempt_id FOR UPDATE;
  now_at := pg_catalog.clock_timestamp();
  IF attempt_record."case_id"<>case_record."id" OR attempt_record."provider_idempotency_key"<>p_provider_idempotency_key
    OR attempt_record."state"<>'claimed' OR outbox_record."state"<>'claimed'
    OR outbox_record."delivery_count"<>p_delivery_number OR outbox_record."claim_token" IS NULL
    OR outbox_record."claim_expires_at"<=now_at THEN
    RAISE EXCEPTION 'query-response attestation requires the exact live claimed delivery' USING ERRCODE='23514';
  END IF;
  boundary_failure := public."pos_manual_boundary_failure_321e"(case_record."id",p_auth_key_id,p_credential_revision,now_at);
  IF boundary_failure IS NOT NULL OR case_record."state"<>'unknown'
    OR ROW(case_record."provider",case_record."reference_hash",case_record."method",case_record."amount_cents",case_record."currency")
      IS DISTINCT FROM ROW(p_provider,p_reference_hash,p_method,p_amount_cents,p_currency) THEN
    RAISE EXCEPTION 'query-response attestation boundary diverged' USING ERRCODE='23514';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('pos_manual_event_321e'),pg_catalog.hashtext(p_provider||':'||p_event_id));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('pos_manual_nonce_321e'),pg_catalog.hashtext(p_provider||':'||p_nonce_hash));
  SELECT * INTO exact_proof FROM public."pos_manual_payment_provider_proofs"
   WHERE "provider"=p_provider AND "payload_hash"=p_payload_hash AND "signature_hash"=p_signature_hash;
  IF FOUND AND exact_proof."source_kind"='query_response'
    AND exact_proof."attempt_id"=p_attempt_id
    AND exact_proof."delivery_number"=p_delivery_number
    AND exact_proof."claim_token_hash"=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(outbox_record."claim_token",'UTF8')),'hex') THEN
    RETURN pg_catalog.jsonb_build_object('proofId',exact_proof."id",'caseId',exact_proof."case_id",
      'attemptId',exact_proof."attempt_id",'disposition',exact_proof."disposition",'duplicate',true,
      'quarantined',exact_proof."disposition" NOT IN ('accepted','replay'));
  END IF;
  SELECT * INTO event_proof FROM public."pos_manual_payment_provider_proofs"
   WHERE "provider"=p_provider AND "event_id"=p_event_id AND "event_owner" FOR UPDATE;
  SELECT * INTO nonce_proof FROM public."pos_manual_payment_provider_proofs"
   WHERE "provider"=p_provider AND "nonce_hash"=p_nonce_hash AND "nonce_owner" FOR UPDATE;
  now_at := pg_catalog.clock_timestamp();
  IF abs(extract(epoch FROM (now_at-p_event_timestamp)))>300
    OR outbox_record."claim_expires_at"<=now_at THEN
    RAISE EXCEPTION 'query-response expired while waiting for canonical locks' USING ERRCODE='23514';
  END IF;
  IF event_proof."id" IS NOT NULL AND event_proof."payload_hash"=p_payload_hash
     AND event_proof."canonical_event_hash"=p_canonical_event_hash
     AND (nonce_proof."id" IS NULL OR (nonce_proof."event_id"=p_event_id
       AND nonce_proof."canonical_event_hash"=p_canonical_event_hash)) THEN
    INSERT INTO public."pos_manual_payment_provider_proofs" (
      "source_kind","case_id","attempt_id","delivery_number","claim_token_hash","provider_idempotency_key",
      "provider","event_id","nonce_hash","payload_hash","signature_hash","canonical_event_hash","evidence_hash",
      "auth_key_id","event_timestamp","provider_sequence","provider_occurred_at","outcome","reference_hash",
      "method","amount_cents","currency","credential_revision","verifier_version","disposition","event_owner",
      "nonce_owner","replay_of_proof_id","caller_role"
    ) VALUES ('query_response',case_record."id",p_attempt_id,p_delivery_number,
      pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(outbox_record."claim_token",'UTF8')),'hex'),p_provider_idempotency_key,
      p_provider,p_event_id,p_nonce_hash,p_payload_hash,p_signature_hash,p_canonical_event_hash,p_evidence_hash,
      p_auth_key_id,p_event_timestamp,p_provider_sequence,p_provider_occurred_at,p_outcome,p_reference_hash,
      p_method,p_amount_cents,p_currency,p_credential_revision,p_verifier_version,'replay',false,
      nonce_proof."id" IS NULL,event_proof."id",session_user)
    RETURNING * INTO proof_record;
    RETURN pg_catalog.jsonb_build_object('proofId',event_proof."id",'deliveryProofId',proof_record."id",
      'caseId',event_proof."case_id",'attemptId',event_proof."attempt_id",'disposition','replay','duplicate',true,'quarantined',false);
  END IF;
  IF event_proof."id" IS NOT NULL OR nonce_proof."id" IS NOT NULL THEN
    INSERT INTO public."pos_manual_payment_provider_proofs" (
      "source_kind","case_id","attempt_id","delivery_number","claim_token_hash","provider_idempotency_key",
      "provider","event_id","nonce_hash","payload_hash","signature_hash","canonical_event_hash","evidence_hash",
      "auth_key_id","event_timestamp","provider_sequence","provider_occurred_at","outcome","reference_hash",
      "method","amount_cents","currency","credential_revision","verifier_version","disposition","event_owner",
      "nonce_owner","caller_role"
    ) VALUES ('query_response',case_record."id",p_attempt_id,p_delivery_number,
      pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(outbox_record."claim_token",'UTF8')),'hex'),p_provider_idempotency_key,
      p_provider,p_event_id,p_nonce_hash,p_payload_hash,p_signature_hash,p_canonical_event_hash,p_evidence_hash,
      p_auth_key_id,p_event_timestamp,p_provider_sequence,p_provider_occurred_at,p_outcome,p_reference_hash,
      p_method,p_amount_cents,p_currency,p_credential_revision,p_verifier_version,
      CASE WHEN event_proof."id" IS NOT NULL AND (event_proof."payload_hash"<>p_payload_hash
        OR event_proof."canonical_event_hash"<>p_canonical_event_hash) THEN 'event_conflict' ELSE 'nonce_conflict' END,
      event_proof."id" IS NULL,nonce_proof."id" IS NULL,session_user) RETURNING * INTO proof_record;
    INSERT INTO public."pos_manual_payment_incidents"("case_id","provider_proof_id","code","expected_hash","reported_hash")
    VALUES (case_record."id",proof_record."id",CASE WHEN proof_record."disposition"='event_conflict' THEN 'event_id_payload_conflict' ELSE 'query_response_nonce_reuse' END,
      COALESCE(event_proof."canonical_event_hash",nonce_proof."canonical_event_hash"),p_canonical_event_hash);
    RETURN pg_catalog.jsonb_build_object('proofId',proof_record."id",'caseId',case_record."id",'attemptId',p_attempt_id,
      'disposition',proof_record."disposition",'duplicate',false,'quarantined',true);
  END IF;

  INSERT INTO public."pos_manual_payment_provider_proofs" (
    "source_kind","case_id","attempt_id","delivery_number","claim_token_hash","provider_idempotency_key",
    "provider","event_id","nonce_hash","payload_hash","signature_hash","canonical_event_hash","evidence_hash",
    "auth_key_id","event_timestamp","provider_sequence","provider_occurred_at","outcome","reference_hash",
    "method","amount_cents","currency","credential_revision","verifier_version","disposition","event_owner",
    "nonce_owner","caller_role"
  ) VALUES ('query_response',case_record."id",p_attempt_id,p_delivery_number,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(outbox_record."claim_token",'UTF8')),'hex'),p_provider_idempotency_key,
    p_provider,p_event_id,p_nonce_hash,p_payload_hash,p_signature_hash,p_canonical_event_hash,p_evidence_hash,
    p_auth_key_id,p_event_timestamp,p_provider_sequence,p_provider_occurred_at,p_outcome,p_reference_hash,
    p_method,p_amount_cents,p_currency,p_credential_revision,p_verifier_version,'accepted',true,true,session_user)
  RETURNING * INTO proof_record;
  RETURN pg_catalog.jsonb_build_object('proofId',proof_record."id",'caseId',case_record."id",'attemptId',p_attempt_id,
    'disposition','accepted','duplicate',false,'quarantined',false);
END; $$;

REVOKE ALL ON FUNCTION public."pos_manual_attest_query_response_v1"(UUID,INTEGER,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ,TEXT,TEXT,TEXT,INTEGER,TEXT,BIGINT,TIMESTAMPTZ,INTEGER,TEXT) FROM PUBLIC;

CREATE FUNCTION public."pos_manual_complete_delivery_v1"(
  p_attempt_id UUID, p_claim_token TEXT, p_proof_id UUID, p_idempotency_key TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  now_at TIMESTAMPTZ;
  claim_hash TEXT;
  prior_delivery public."pos_manual_payment_delivery_results"%ROWTYPE;
  attempt_record public."pos_manual_payment_attempts"%ROWTYPE;
  outbox_record public."pos_manual_payment_outbox"%ROWTYPE;
  proof_record public."pos_manual_payment_provider_proofs"%ROWTYPE;
  case_record public."pos_manual_payment_cases"%ROWTYPE;
  delivery_record public."pos_manual_payment_delivery_results"%ROWTYPE;
  observation_record public."pos_manual_payment_observations"%ROWTYPE;
  operation_record public."pos_manual_payment_operations"%ROWTYPE;
  prior_max_sequence BIGINT;
  prior_max_occurred_at TIMESTAMPTZ;
  boundary_failure TEXT;
  next_state TEXT;
  processing_result TEXT;
  incident_code TEXT;
  next_version INTEGER;
  next_attempt_sequence INTEGER;
BEGIN
  IF p_attempt_id IS NULL OR p_proof_id IS NULL OR p_claim_token IS NULL
    OR length(p_claim_token) NOT BETWEEN 20 AND 240 OR p_claim_token !~ '^[A-Za-z0-9._:@/-]+$'
    OR p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 8 AND 160
  THEN RAISE EXCEPTION 'invalid closed delivery completion input' USING ERRCODE='22023'; END IF;
  claim_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_claim_token,'UTF8')),'hex');
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('pos_manual_delivery_completion_v1'),pg_catalog.hashtext(p_idempotency_key));
  SELECT * INTO prior_delivery FROM public."pos_manual_payment_delivery_results"
   WHERE "completion_idempotency_key"=p_idempotency_key;
  IF FOUND THEN
    IF prior_delivery."result_kind" IS DISTINCT FROM 'provider_result'
      OR prior_delivery."attempt_id" IS DISTINCT FROM p_attempt_id
      OR prior_delivery."provider_proof_id" IS DISTINCT FROM p_proof_id
      OR prior_delivery."claim_token_hash" IS DISTINCT FROM claim_hash THEN
      RAISE EXCEPTION 'delivery completion idempotency conflict' USING ERRCODE='23505';
    END IF;
    RETURN pg_catalog.jsonb_build_object('deliveryResultId',prior_delivery."id",'proofId',p_proof_id,
      'resultingState',prior_delivery."resulting_state",'resultingVersion',prior_delivery."resulting_version",
      'processingResult',prior_delivery."processing_result",'replayed',true);
  END IF;

  SELECT * INTO attempt_record FROM public."pos_manual_payment_attempts" WHERE "id"=p_attempt_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'manual query attempt not found' USING ERRCODE='23503'; END IF;
  case_record := public."pos_manual_lock_case_graph_321e"(attempt_record."case_id");
  SELECT * INTO attempt_record FROM public."pos_manual_payment_attempts" WHERE "id"=p_attempt_id FOR UPDATE;
  SELECT * INTO outbox_record FROM public."pos_manual_payment_outbox" WHERE "attempt_id"=p_attempt_id FOR UPDATE;
  SELECT * INTO proof_record FROM public."pos_manual_payment_provider_proofs" WHERE "id"=p_proof_id FOR UPDATE;
  now_at := pg_catalog.clock_timestamp();
  IF proof_record."id" IS NULL OR proof_record."source_kind"<>'query_response'
    OR proof_record."disposition" NOT IN ('accepted','replay') OR proof_record."case_id"<>case_record."id"
    OR proof_record."attempt_id"<>p_attempt_id OR proof_record."delivery_number"<>outbox_record."delivery_count"
    OR proof_record."provider_idempotency_key"<>attempt_record."provider_idempotency_key"
    OR proof_record."claim_token_hash"<>claim_hash
    OR EXISTS (SELECT 1 FROM public."pos_manual_payment_proof_consumptions" WHERE "proof_id"=p_proof_id)
    OR attempt_record."state"<>'claimed' OR outbox_record."state"<>'claimed'
    OR outbox_record."claim_token"<>p_claim_token OR outbox_record."claim_expires_at"<=now_at THEN
    RAISE EXCEPTION 'delivery completion requires one exact live unconsumed provider proof' USING ERRCODE='23514';
  END IF;
  boundary_failure := public."pos_manual_boundary_failure_321e"(case_record."id",proof_record."auth_key_id",proof_record."credential_revision",now_at);
  IF boundary_failure IS NOT NULL OR case_record."state"<>'unknown'
    OR ROW(case_record."provider",case_record."reference_hash",case_record."method",case_record."amount_cents",case_record."currency")
      IS DISTINCT FROM ROW(proof_record."provider",proof_record."reference_hash",proof_record."method",proof_record."amount_cents",proof_record."currency") THEN
    RAISE EXCEPTION 'provider proof no longer matches the manual boundary' USING ERRCODE='23514';
  END IF;

  SELECT max("provider_sequence"),max("provider_occurred_at") INTO prior_max_sequence,prior_max_occurred_at
    FROM public."pos_manual_payment_provider_proofs"
   WHERE "case_id"=case_record."id" AND "id"<>proof_record."id"
     AND (proof_record."replay_of_proof_id" IS NULL OR "id"<>proof_record."replay_of_proof_id")
     AND "disposition"='accepted';
  IF proof_record."provider_occurred_at"<case_record."occurred_at"-interval '5 minutes'
    OR proof_record."provider_occurred_at">LEAST(now_at,case_record."expires_at")
    OR (prior_max_sequence IS NOT NULL AND proof_record."provider_sequence"<=prior_max_sequence)
    OR (prior_max_occurred_at IS NOT NULL AND proof_record."provider_occurred_at"<prior_max_occurred_at) THEN
    next_state:='blocked'; processing_result:='incident_opened'; incident_code:='provider_proof_causality_or_sequence_conflict';
  ELSIF proof_record."outcome"='confirmed_paid' AND case_record."expires_at">now_at THEN
    next_state:='confirmed_paid'; processing_result:='applied_transition';
  ELSIF proof_record."outcome" IN ('not_found','voided') AND case_record."expires_at">now_at THEN
    next_state:='no_funds'; processing_result:='applied_transition';
  ELSIF proof_record."outcome"='unknown' AND case_record."expires_at">now_at AND attempt_record."sequence"<12 THEN
    next_state:='unknown'; processing_result:='retry_scheduled';
  ELSE
    next_state:='blocked'; processing_result:='incident_opened';
    incident_code:=CASE WHEN proof_record."outcome"='refunded' THEN 'provider_reported_refund' ELSE 'late_or_exhausted_provider_proof' END;
  END IF;
  next_version:=case_record."version"+1;

  INSERT INTO public."pos_manual_payment_delivery_results" (
    "attempt_id","delivery_number","claim_token_hash","response_hash","result_kind","outcome",
    "evidence_hash","provider_sequence","occurred_at","retryable","superseded","resulting_state",
    "resulting_version","provider_proof_id","processing_result","completion_idempotency_key"
  ) VALUES (p_attempt_id,outbox_record."delivery_count",claim_hash,proof_record."canonical_event_hash",'provider_result',
    proof_record."outcome",proof_record."evidence_hash",proof_record."provider_sequence",proof_record."provider_occurred_at",
    processing_result='retry_scheduled',processing_result='incident_opened',next_state,next_version,p_proof_id,
    processing_result,p_idempotency_key) RETURNING * INTO delivery_record;
  INSERT INTO public."pos_manual_payment_proof_consumptions"("proof_id","delivery_result_id","consumer_role")
    VALUES (p_proof_id,delivery_record."id",session_user);
  INSERT INTO public."pos_manual_payment_observations" (
    "case_id","attempt_id","source","outcome","reference_hash","method","amount_cents","currency",
    "provider_sequence","provider_occurred_at","auth_key_id","processing_result","evidence_hash",
    "resulting_state","resulting_version","write_txid"
  ) VALUES (case_record."id",p_attempt_id,'worker',proof_record."outcome",proof_record."reference_hash",
    proof_record."method",proof_record."amount_cents",proof_record."currency",proof_record."provider_sequence",
    proof_record."provider_occurred_at",proof_record."auth_key_id",processing_result,proof_record."evidence_hash",
    next_state,next_version,pg_catalog.txid_current()::numeric) RETURNING * INTO observation_record;
  INSERT INTO public."pos_manual_payment_operations" (
    "case_id","action","expected_version","resulting_version","resulting_state","observation_id",
    "idempotency_key","request_hash","write_txid"
  ) VALUES (case_record."id",'observe',case_record."version",next_version,next_state,observation_record."id",
    'manual-delivery:'||p_idempotency_key,proof_record."canonical_event_hash",pg_catalog.txid_current()::numeric)
  RETURNING * INTO operation_record;
  INSERT INTO public."pos_manual_payment_state_events" (
    "case_id","operation_id","from_state","to_state","resulting_version","source","source_id","write_txid"
  ) VALUES (case_record."id",operation_record."id",case_record."state",next_state,next_version,'worker',p_attempt_id::text,
    pg_catalog.txid_current()::numeric);
  UPDATE public."pos_manual_payment_cases" SET "state"=next_state,"version"=next_version,
    "provider_outcome"=proof_record."outcome",
    "next_reconcile_at"=CASE WHEN processing_result='retry_scheduled' THEN now_at+interval '30 seconds' ELSE NULL END,
    "confirmed_observation_id"=CASE WHEN next_state='confirmed_paid' THEN observation_record."id" ELSE "confirmed_observation_id" END,
    "confirmed_at"=CASE WHEN next_state='confirmed_paid' THEN now_at ELSE "confirmed_at" END,
    "no_funds_at"=CASE WHEN next_state='no_funds' THEN now_at ELSE "no_funds_at" END,
    "blocked_at"=CASE WHEN next_state='blocked' THEN now_at ELSE "blocked_at" END
   WHERE "id"=case_record."id";
  UPDATE public."pos_manual_payment_attempts" SET "state"=CASE WHEN processing_result='retry_scheduled' THEN 'unknown'
      WHEN next_state IN ('confirmed_paid','no_funds') THEN 'succeeded' ELSE 'failed' END,
    "outcome_unknown"=processing_result='retry_scheduled',"finished_at"=now_at WHERE "id"=p_attempt_id;
  UPDATE public."pos_manual_payment_outbox" SET "state"='completed',"claim_token"=NULL,"claim_expires_at"=NULL,
    "completed_at"=now_at,"last_error_code"=CASE WHEN processing_result='retry_scheduled' THEN 'provider_outcome_unknown'
      WHEN processing_result='incident_opened' THEN 'provider_proof_incident' ELSE NULL END WHERE "id"=outbox_record."id";
  IF incident_code IS NOT NULL THEN
    INSERT INTO public."pos_manual_payment_incidents"("case_id","observation_id","provider_proof_id","code","expected_hash","reported_hash")
    VALUES (case_record."id",observation_record."id",p_proof_id,incident_code,case_record."request_hash",proof_record."canonical_event_hash");
  END IF;
  IF processing_result='retry_scheduled' THEN
    next_attempt_sequence:=attempt_record."sequence"+1;
    INSERT INTO public."pos_manual_payment_attempts"("case_id","sequence","provider_idempotency_key","request_hash")
    VALUES (case_record."id",next_attempt_sequence,'manual-query:'||case_record."id"::text||':'||next_attempt_sequence,
      proof_record."canonical_event_hash");
    INSERT INTO public."pos_manual_payment_outbox"("attempt_id","next_attempt_at")
    SELECT "id",now_at+interval '30 seconds' FROM public."pos_manual_payment_attempts"
     WHERE "case_id"=case_record."id" AND "sequence"=next_attempt_sequence;
  END IF;
  RETURN pg_catalog.jsonb_build_object('deliveryResultId',delivery_record."id",'proofId',p_proof_id,
    'caseId',case_record."id",'resultingState',next_state,'resultingVersion',next_version,
    'processingResult',processing_result,'replayed',false);
END; $$;

REVOKE ALL ON FUNCTION public."pos_manual_complete_delivery_v1"(UUID,TEXT,UUID,TEXT) FROM PUBLIC;

CREATE FUNCTION public."pos_manual_report_transport_v1"(
  p_attempt_id UUID, p_claim_token TEXT, p_kind TEXT, p_idempotency_key TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  now_at TIMESTAMPTZ;
  claim_hash TEXT;
  evidence_hash TEXT;
  prior_delivery public."pos_manual_payment_delivery_results"%ROWTYPE;
  attempt_record public."pos_manual_payment_attempts"%ROWTYPE;
  outbox_record public."pos_manual_payment_outbox"%ROWTYPE;
  case_record public."pos_manual_payment_cases"%ROWTYPE;
  delivery_record public."pos_manual_payment_delivery_results"%ROWTYPE;
  operation_record public."pos_manual_payment_operations"%ROWTYPE;
  result_kind TEXT;
  processing_result TEXT;
  next_attempt_sequence INTEGER;
  next_version INTEGER;
BEGIN
  IF p_attempt_id IS NULL OR p_claim_token IS NULL OR length(p_claim_token) NOT BETWEEN 20 AND 240
    OR p_claim_token !~ '^[A-Za-z0-9._:@/-]+$'
    OR p_kind NOT IN ('pre_dispatch_failure','outcome_unknown','protocol_rejected')
    OR p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 8 AND 160
  THEN RAISE EXCEPTION 'invalid closed transport report input' USING ERRCODE='22023'; END IF;
  claim_hash:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_claim_token,'UTF8')),'hex');
  evidence_hash:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    p_attempt_id::text||':'||p_kind||':'||p_idempotency_key,'UTF8')),'hex');
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('pos_manual_delivery_completion_v1'),pg_catalog.hashtext(p_idempotency_key));
  SELECT * INTO prior_delivery FROM public."pos_manual_payment_delivery_results" WHERE "completion_idempotency_key"=p_idempotency_key;
  IF FOUND THEN
    IF prior_delivery."attempt_id"<>p_attempt_id OR prior_delivery."claim_token_hash"<>claim_hash
      OR prior_delivery."result_kind"<>(CASE p_kind WHEN 'pre_dispatch_failure' THEN 'transport_pre_dispatch_failure'
        WHEN 'outcome_unknown' THEN 'transport_outcome_unknown' ELSE 'protocol_rejected' END) THEN
      RAISE EXCEPTION 'transport report idempotency conflict' USING ERRCODE='23505'; END IF;
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
    OR outbox_record."claim_token"<>p_claim_token OR outbox_record."claim_expires_at"<=now_at THEN
    RAISE EXCEPTION 'transport report requires the exact live claimed delivery' USING ERRCODE='23514'; END IF;
  result_kind:=CASE p_kind WHEN 'pre_dispatch_failure' THEN 'transport_pre_dispatch_failure'
    WHEN 'outcome_unknown' THEN 'transport_outcome_unknown' ELSE 'protocol_rejected' END;
  processing_result:=CASE WHEN p_kind='protocol_rejected' OR attempt_record."sequence">=12 OR case_record."expires_at"<=now_at
    THEN 'terminal_blocked' ELSE 'retry_scheduled' END;
  next_version:=case_record."version"+CASE WHEN processing_result='terminal_blocked' THEN 1 ELSE 0 END;
  INSERT INTO public."pos_manual_payment_delivery_results"(
    "attempt_id","delivery_number","claim_token_hash","response_hash","result_kind","outcome","evidence_hash",
    "retryable","superseded","resulting_state","resulting_version","processing_result","completion_idempotency_key"
  ) VALUES (p_attempt_id,outbox_record."delivery_count",claim_hash,evidence_hash,result_kind,'unknown',evidence_hash,
    processing_result='retry_scheduled',processing_result='terminal_blocked',
    CASE WHEN processing_result='terminal_blocked' THEN 'blocked' ELSE case_record."state" END,
    next_version,processing_result,p_idempotency_key) RETURNING * INTO delivery_record;
  IF processing_result='terminal_blocked' THEN
    INSERT INTO public."pos_manual_payment_operations"(
      "case_id","action","expected_version","resulting_version","resulting_state","idempotency_key","request_hash","write_txid"
    ) VALUES (case_record."id",'block',case_record."version",next_version,'blocked','manual-transport-block:'||p_idempotency_key,
      evidence_hash,pg_catalog.txid_current()::numeric) RETURNING * INTO operation_record;
    INSERT INTO public."pos_manual_payment_state_events"(
      "case_id","operation_id","from_state","to_state","resulting_version","source","source_id","write_txid"
    ) VALUES (case_record."id",operation_record."id",case_record."state",'blocked',next_version,'worker',p_attempt_id::text,
      pg_catalog.txid_current()::numeric);
    UPDATE public."pos_manual_payment_cases" SET "state"='blocked',"version"=next_version,"blocked_at"=now_at,"next_reconcile_at"=NULL
     WHERE "id"=case_record."id";
    UPDATE public."pos_manual_payment_attempts" SET "state"='failed',"outcome_unknown"=p_kind='outcome_unknown',"finished_at"=now_at
     WHERE "id"=p_attempt_id;
    UPDATE public."pos_manual_payment_outbox" SET "state"='dead',"claim_token"=NULL,"claim_expires_at"=NULL,
      "completed_at"=now_at,"last_error_code"=p_kind WHERE "id"=outbox_record."id";
    INSERT INTO public."pos_manual_payment_incidents"("case_id","code","expected_hash","reported_hash")
    VALUES (case_record."id",CASE WHEN p_kind='protocol_rejected' THEN 'provider_protocol_rejected' ELSE 'transport_retry_exhausted' END,
      case_record."request_hash",evidence_hash);
  ELSIF p_kind='pre_dispatch_failure' THEN
    UPDATE public."pos_manual_payment_attempts" SET "state"='queued',"finished_at"=NULL WHERE "id"=p_attempt_id;
    UPDATE public."pos_manual_payment_outbox" SET "state"='retry',"claim_token"=NULL,"claim_expires_at"=NULL,
      "next_attempt_at"=now_at+interval '30 seconds',"last_error_code"=p_kind WHERE "id"=outbox_record."id";
  ELSE
    UPDATE public."pos_manual_payment_attempts" SET "state"='unknown',"outcome_unknown"=true,"finished_at"=now_at WHERE "id"=p_attempt_id;
    UPDATE public."pos_manual_payment_outbox" SET "state"='completed',"claim_token"=NULL,"claim_expires_at"=NULL,
      "completed_at"=now_at,"last_error_code"=p_kind WHERE "id"=outbox_record."id";
    next_attempt_sequence:=attempt_record."sequence"+1;
    INSERT INTO public."pos_manual_payment_attempts"("case_id","sequence","provider_idempotency_key","request_hash")
    VALUES (case_record."id",next_attempt_sequence,'manual-query:'||case_record."id"::text||':'||next_attempt_sequence,evidence_hash);
    INSERT INTO public."pos_manual_payment_outbox"("attempt_id","next_attempt_at")
    SELECT "id",now_at+interval '30 seconds' FROM public."pos_manual_payment_attempts"
     WHERE "case_id"=case_record."id" AND "sequence"=next_attempt_sequence;
    UPDATE public."pos_manual_payment_cases" SET "next_reconcile_at"=now_at+interval '30 seconds' WHERE "id"=case_record."id";
  END IF;
  RETURN pg_catalog.jsonb_build_object('deliveryResultId',delivery_record."id",'caseId',case_record."id",
    'resultingState',delivery_record."resulting_state",'resultingVersion',delivery_record."resulting_version",
    'processingResult',processing_result,'replayed',false);
END; $$;

REVOKE ALL ON FUNCTION public."pos_manual_report_transport_v1"(UUID,TEXT,TEXT,TEXT) FROM PUBLIC;

-- Migrations run before tenant login roles in development. Production grant
-- reconciliation repeats this exact allowlist after revoking every wildcard.
DO $grant$
DECLARE callback_role NAME := (current_database()||'_mc')::NAME;
        worker_role NAME := (current_database()||'_mw')::NAME;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=callback_role) THEN
    EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION public.pos_manual_record_callback_v1(text,text,text,text,text,text,text,text,timestamptz,text,text,text,integer,text,bigint,timestamptz,integer,text) TO %I',callback_role);
    EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION public.pos_manual_attest_query_response_v1(uuid,integer,text,text,text,text,text,text,text,text,text,timestamptz,text,text,text,integer,text,bigint,timestamptz,integer,text) TO %I',callback_role);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=worker_role) THEN
    EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION public.pos_manual_complete_delivery_v1(uuid,text,uuid,text) TO %I',worker_role);
    EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION public.pos_manual_report_transport_v1(uuid,text,text,text) TO %I',worker_role);
  END IF;
END;
$grant$;
