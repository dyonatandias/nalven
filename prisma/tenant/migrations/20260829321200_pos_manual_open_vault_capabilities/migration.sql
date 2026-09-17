-- 321f: inert, fail-closed database half of the manual open/vault protocol.
-- Raw references and redeemable vault tokens are deliberately absent.

CREATE FUNCTION public."pos_manual_identifier_contains_pan_321f"(p_value TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
DECLARE candidate TEXT; digits TEXT; total INTEGER; alternate BOOLEAN; digit INTEGER; i INTEGER;
BEGIN
 FOR candidate IN SELECT match[1] FROM pg_catalog.regexp_matches(p_value,'([0-9][0-9 ./_():-]{10,42}[0-9])','g') AS match LOOP
   digits:=pg_catalog.regexp_replace(candidate,'[^0-9]','','g');
   IF length(digits) BETWEEN 12 AND 19 THEN
     total:=0; alternate:=false;
     FOR i IN REVERSE length(digits)..1 LOOP digit:=substr(digits,i,1)::integer; IF alternate THEN digit:=digit*2; IF digit>9 THEN digit:=digit-9; END IF; END IF; total:=total+digit; alternate:=NOT alternate; END LOOP;
     IF total%10=0 THEN RETURN true; END IF;
   END IF;
 END LOOP;
 RETURN false;
END $$;
REVOKE ALL ON FUNCTION public."pos_manual_identifier_contains_pan_321f"(TEXT) FROM PUBLIC;

CREATE TABLE public."pos_manual_open_requests" (
  "id" UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  "branch_id" INTEGER NOT NULL, "register_id" INTEGER NOT NULL, "session_id" INTEGER NOT NULL,
  "operator_profile_id" INTEGER NOT NULL, "terminal_id" TEXT NOT NULL, "sale_draft_id" TEXT NOT NULL,
  "draft_revision" INTEGER NOT NULL CHECK ("draft_revision">=0), "draft_request_hash" TEXT NOT NULL CHECK ("draft_request_hash"~'^[0-9a-f]{64}$'),
  "quote_hash" TEXT NOT NULL CHECK ("quote_hash"~'^[0-9a-f]{64}$'), "order_claim_id" TEXT,
  "payment_plan_id" TEXT NOT NULL, "payment_index" INTEGER NOT NULL CHECK ("payment_index"=0),
  "method" TEXT NOT NULL, "amount_cents" INTEGER NOT NULL CHECK ("amount_cents">0), "currency" TEXT NOT NULL CHECK ("currency"='BRL'),
  "installments" INTEGER NOT NULL CHECK ("installments" BETWEEN 1 AND 24), "provider" TEXT NOT NULL,
  "connector_id" TEXT NOT NULL, "connector_revision" INTEGER NOT NULL CHECK ("connector_revision">=0),
  "credential_ref" TEXT NOT NULL, "credential_revision" INTEGER NOT NULL CHECK ("credential_revision">=0),
  "vault_adapter_id" TEXT NOT NULL, "provider_adapter_version" TEXT NOT NULL,
  "gate_config_hash" TEXT NOT NULL CHECK ("gate_config_hash"~'^[0-9a-f]{64}$'),
  "occurred_at" TIMESTAMPTZ NOT NULL, "reason_code" TEXT NOT NULL CHECK ("reason_code"~'^[a-z][a-z0-9._:-]{2,79}$' AND NOT public."pos_manual_identifier_contains_pan_321f"("reason_code")),
  "maker_profile_id" INTEGER NOT NULL, "maker_user_id" TEXT NOT NULL,
  "intent_hash" TEXT NOT NULL CHECK ("intent_hash"~'^[0-9a-f]{64}$'), "idempotency_key" TEXT NOT NULL CHECK ("idempotency_key"~'^[0-9a-f]{64,160}$'),
  "prepare_request_hash" TEXT NOT NULL CHECK ("prepare_request_hash"~'^[0-9a-f]{64}$'),
  "ticket_hash" TEXT NOT NULL UNIQUE CHECK ("ticket_hash"~'^[0-9a-f]{64}$'), "ticket_expires_at" TIMESTAMPTZ NOT NULL, "ticket_consumed_at" TIMESTAMPTZ,
  "vault_idempotency_key" TEXT NOT NULL UNIQUE,
  "state" TEXT NOT NULL CHECK ("state" IN ('prepared','binding','finalized','rejected','expired')),
  "lease_token_hash" TEXT UNIQUE CHECK ("lease_token_hash" IS NULL OR "lease_token_hash"~'^[0-9a-f]{64}$'),
  "lease_expires_at" TIMESTAMPTZ, "fencing_token" BIGINT NOT NULL DEFAULT 0 CHECK ("fencing_token">=0),
  "claim_idempotency_hash" TEXT CHECK ("claim_idempotency_hash" IS NULL OR "claim_idempotency_hash"~'^[0-9a-f]{64}$'),
  "claim_binder_id" TEXT CHECK ("claim_binder_id" IS NULL OR NOT public."pos_manual_identifier_contains_pan_321f"("claim_binder_id")), "claim_lease_seconds" INTEGER,
  "finalize_idempotency_hash" TEXT CHECK ("finalize_idempotency_hash" IS NULL OR "finalize_idempotency_hash"~'^[0-9a-f]{64}$'),
  "finalize_request_hash" TEXT CHECK ("finalize_request_hash" IS NULL OR "finalize_request_hash"~'^[0-9a-f]{64}$'),
  "abandon_idempotency_hash" TEXT CHECK ("abandon_idempotency_hash" IS NULL OR "abandon_idempotency_hash"~'^[0-9a-f]{64}$'),
  "abandon_request_hash" TEXT CHECK ("abandon_request_hash" IS NULL OR "abandon_request_hash"~'^[0-9a-f]{64}$'),
  "case_id" UUID UNIQUE, "vault_proof_id" UUID UNIQUE, "terminal_code" TEXT,
  "lifecycle_txid" NUMERIC(20,0), "prepared_at" TIMESTAMPTZ NOT NULL, "binding_at" TIMESTAMPTZ,
  "finalized_at" TIMESTAMPTZ, "abandoned_at" TIMESTAMPTZ, "created_at" TIMESTAMPTZ NOT NULL,
  "updated_at" TIMESTAMPTZ NOT NULL,
  UNIQUE ("branch_id","maker_user_id","idempotency_key"),
  FOREIGN KEY ("branch_id") REFERENCES public."branches"("id") ON DELETE RESTRICT,
  FOREIGN KEY ("register_id","branch_id") REFERENCES public."pos_registers"("id","branch_id") ON DELETE RESTRICT,
  FOREIGN KEY ("operator_profile_id") REFERENCES public."tenant_user_profiles"("id") ON DELETE RESTRICT,
  FOREIGN KEY ("maker_profile_id") REFERENCES public."tenant_user_profiles"("id") ON DELETE RESTRICT,
  FOREIGN KEY ("sale_draft_id") REFERENCES public."pos_held_sales"("id") ON DELETE RESTRICT,
  FOREIGN KEY ("order_claim_id") REFERENCES public."pos_order_claims"("id") ON DELETE RESTRICT,
  FOREIGN KEY ("payment_plan_id","payment_index") REFERENCES public."pos_payment_plan_slots"("plan_id","payment_index") ON DELETE RESTRICT,
  FOREIGN KEY ("session_id","register_id") REFERENCES public."cash_register_sessions"("id","register_id") ON DELETE RESTRICT,
  FOREIGN KEY ("terminal_id","register_id") REFERENCES public."pos_terminals"("id","register_id") ON DELETE RESTRICT,
  FOREIGN KEY ("connector_id","branch_id","provider") REFERENCES public."pos_connectors"("id","branch_id","provider") ON DELETE RESTRICT,
  FOREIGN KEY ("credential_ref") REFERENCES public."integration_credentials"("id") ON DELETE RESTRICT,
  CHECK (("case_id" IS NULL)=("vault_proof_id" IS NULL)),
  CHECK (("state"='prepared' AND "ticket_consumed_at" IS NULL AND "lease_token_hash" IS NULL AND "lease_expires_at" IS NULL AND "fencing_token"=0 AND "claim_idempotency_hash" IS NULL AND "claim_binder_id" IS NULL AND "claim_lease_seconds" IS NULL AND "finalize_idempotency_hash" IS NULL AND "finalize_request_hash" IS NULL AND "abandon_idempotency_hash" IS NULL AND "abandon_request_hash" IS NULL AND "case_id" IS NULL AND "binding_at" IS NULL AND "finalized_at" IS NULL AND "abandoned_at" IS NULL AND "terminal_code" IS NULL AND "lifecycle_txid" IS NULL)
    OR ("state"='binding' AND "ticket_consumed_at" IS NOT NULL AND "lease_token_hash" IS NOT NULL AND "lease_expires_at" IS NOT NULL AND "fencing_token">0 AND "claim_idempotency_hash" IS NOT NULL AND "claim_binder_id" IS NOT NULL AND "claim_lease_seconds" BETWEEN 15 AND 300 AND "finalize_idempotency_hash" IS NULL AND "finalize_request_hash" IS NULL AND "abandon_idempotency_hash" IS NULL AND "abandon_request_hash" IS NULL AND "case_id" IS NULL AND "binding_at" IS NOT NULL AND "finalized_at" IS NULL AND "abandoned_at" IS NULL AND "terminal_code" IS NULL AND "lifecycle_txid" IS NULL)
    OR ("state"='finalized' AND "ticket_consumed_at" IS NOT NULL AND "case_id" IS NOT NULL AND "finalized_at" IS NOT NULL AND "binding_at" IS NOT NULL AND "fencing_token">0 AND "claim_idempotency_hash" IS NOT NULL AND "claim_binder_id" IS NOT NULL AND "claim_lease_seconds" BETWEEN 15 AND 300 AND "lease_token_hash" IS NULL AND "lease_expires_at" IS NULL AND "finalize_idempotency_hash" IS NOT NULL AND "finalize_request_hash" IS NOT NULL AND "abandon_idempotency_hash" IS NULL AND "abandon_request_hash" IS NULL AND "abandoned_at" IS NULL AND "terminal_code" IS NULL AND "lifecycle_txid" IS NOT NULL)
    OR ("state"='rejected' AND "ticket_consumed_at" IS NOT NULL AND "fencing_token">0 AND "claim_idempotency_hash" IS NOT NULL AND "claim_binder_id" IS NOT NULL AND "claim_lease_seconds" BETWEEN 15 AND 300 AND "case_id" IS NULL AND "lease_token_hash" IS NULL AND "lease_expires_at" IS NULL AND "terminal_code"='binder_abandoned' AND "abandoned_at" IS NOT NULL AND "binding_at" IS NOT NULL AND "abandon_idempotency_hash" IS NOT NULL AND "abandon_request_hash" IS NOT NULL AND "finalize_idempotency_hash" IS NULL AND "finalize_request_hash" IS NULL AND "finalized_at" IS NULL AND "lifecycle_txid" IS NULL)
    OR ("state"='expired' AND "case_id" IS NULL AND "lease_token_hash" IS NULL AND "lease_expires_at" IS NULL AND "abandoned_at" IS NOT NULL AND "finalized_at" IS NULL AND "finalize_idempotency_hash" IS NULL AND "finalize_request_hash" IS NULL AND "abandon_idempotency_hash" IS NULL AND "abandon_request_hash" IS NULL AND "lifecycle_txid" IS NULL AND (("terminal_code"='ticket_expired' AND "ticket_consumed_at" IS NULL AND "fencing_token"=0 AND "binding_at" IS NULL AND "claim_idempotency_hash" IS NULL AND "claim_binder_id" IS NULL AND "claim_lease_seconds" IS NULL) OR ("terminal_code"='lease_expired' AND "ticket_consumed_at" IS NOT NULL AND "fencing_token">0 AND "binding_at" IS NOT NULL AND "claim_idempotency_hash" IS NOT NULL AND "claim_binder_id" IS NOT NULL AND "claim_lease_seconds" BETWEEN 15 AND 300))))
);
CREATE INDEX "pos_manual_open_requests_state_lease_idx" ON public."pos_manual_open_requests"("state","lease_expires_at");
CREATE INDEX "pos_manual_open_requests_session_state_idx" ON public."pos_manual_open_requests"("session_id","state");
CREATE INDEX "pos_manual_open_requests_plan_slot_idx" ON public."pos_manual_open_requests"("payment_plan_id","payment_index");

CREATE TABLE public."pos_manual_vault_proofs" (
  "id" UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(), "open_request_id" UUID NOT NULL UNIQUE,
  "case_id" UUID NOT NULL UNIQUE, "vault_adapter_id" TEXT NOT NULL, "provider" TEXT NOT NULL,
  "external_proof_id" TEXT NOT NULL UNIQUE, "stable_reference_index" TEXT NOT NULL UNIQUE CHECK ("stable_reference_index"~'^vault-blind:v[0-9]+:[0-9a-f]{64}$'),
  "reference_hash" TEXT NOT NULL CHECK ("reference_hash"~'^hmac-sha256:v[0-9]+:[0-9a-f]{64}$'),
  "reference_key_id" TEXT NOT NULL, "reference_last_four" TEXT NOT NULL CHECK ("reference_last_four"~'^[A-Za-z0-9]{4}$'),
  "vault_key_id" TEXT NOT NULL, "binding_hash" TEXT NOT NULL UNIQUE CHECK ("binding_hash"~'^[0-9a-f]{64}$'),
  "proof_hash" TEXT NOT NULL CHECK ("proof_hash"~'^[0-9a-f]{64}$'), "signature_hash" TEXT NOT NULL CHECK ("signature_hash"~'^[0-9a-f]{64}$'),
  "issued_at" TIMESTAMPTZ NOT NULL, "retention_expires_at" TIMESTAMPTZ NOT NULL,
  "verifier_version" TEXT NOT NULL, "write_txid" NUMERIC(20,0) NOT NULL, "created_at" TIMESTAMPTZ NOT NULL,
  FOREIGN KEY ("open_request_id") REFERENCES public."pos_manual_open_requests"("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY ("case_id") REFERENCES public."pos_manual_payment_cases"("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK ("external_proof_id"~'^[A-Za-z][A-Za-z0-9._:-]{7,159}$' AND "reference_key_id"~'^[A-Za-z][A-Za-z0-9._:-]{2,79}$'
    AND "vault_key_id"~'^[A-Za-z][A-Za-z0-9._:-]{2,159}$' AND "verifier_version"~'^[A-Za-z][A-Za-z0-9._:-]{2,79}$'
    AND NOT public."pos_manual_identifier_contains_pan_321f"("external_proof_id") AND NOT public."pos_manual_identifier_contains_pan_321f"("reference_key_id") AND NOT public."pos_manual_identifier_contains_pan_321f"("vault_key_id") AND NOT public."pos_manual_identifier_contains_pan_321f"("verifier_version"))
);

CREATE TABLE public."pos_manual_payment_vault_verifiers" (
  "verifier_version" TEXT PRIMARY KEY CHECK ("verifier_version"~'^[A-Za-z][A-Za-z0-9._:-]{2,79}$' AND NOT public."pos_manual_identifier_contains_pan_321f"("verifier_version")),
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "max_future_skew_seconds" INTEGER NOT NULL DEFAULT 30 CHECK ("max_future_skew_seconds" BETWEEN 0 AND 300),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
ALTER TABLE public."pos_manual_vault_proofs" ADD FOREIGN KEY ("verifier_version") REFERENCES public."pos_manual_payment_vault_verifiers"("verifier_version") ON DELETE RESTRICT;
ALTER TABLE public."pos_manual_open_requests" ADD FOREIGN KEY ("case_id") REFERENCES public."pos_manual_payment_cases"("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public."pos_manual_open_requests" ADD FOREIGN KEY ("vault_proof_id") REFERENCES public."pos_manual_vault_proofs"("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public."pos_manual_payment_vault_bindings" ADD COLUMN "vault_proof_id" UUID UNIQUE REFERENCES public."pos_manual_vault_proofs"("id") ON DELETE RESTRICT;
ALTER TABLE public."pos_manual_payment_vault_bindings" ADD COLUMN "binding_kind" TEXT;
UPDATE public."pos_manual_payment_vault_bindings" SET "binding_kind"='legacy_history' WHERE "binding_kind" IS NULL;
ALTER TABLE public."pos_manual_payment_vault_bindings" ALTER COLUMN "binding_kind" SET NOT NULL;
ALTER TABLE public."pos_manual_payment_vault_bindings" ALTER COLUMN "binding_kind" SET DEFAULT 'proof_v1';
ALTER TABLE public."pos_manual_payment_vault_bindings" ADD CHECK (("binding_kind"='legacy_history' AND "vault_proof_id" IS NULL) OR ("binding_kind"='proof_v1' AND "vault_proof_id" IS NOT NULL AND "vault_reference"='vault-proof:'||"vault_proof_id"::text));

CREATE FUNCTION public."guard_pos_manual_vault_binding_321f"() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='INSERT' AND (NEW."binding_kind"<>'proof_v1' OR NEW."vault_proof_id" IS NULL) THEN
   RAISE EXCEPTION 'new manual vault bindings require proof_v1' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND NEW IS DISTINCT FROM OLD THEN
   RAISE EXCEPTION 'manual vault binding evidence is immutable' USING ERRCODE='23514';
 END IF;
 RETURN CASE WHEN TG_OP='UPDATE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER "pos_manual_vault_binding_321f_guard" BEFORE INSERT OR UPDATE ON public."pos_manual_payment_vault_bindings" FOR EACH ROW EXECUTE FUNCTION public."guard_pos_manual_vault_binding_321f"();

-- These pre-321f trigger functions contain legacy unqualified references. A
-- SECURITY DEFINER caller uses pg_catalog-only, so pin their lookup explicitly;
-- CREATE on public is revoked from every operational principal by deployment.
ALTER FUNCTION public."protect_pos_manual_case"() SET search_path=pg_catalog, public;
ALTER FUNCTION public."guard_pos_manual_operation"() SET search_path=pg_catalog, public;
ALTER FUNCTION public."stamp_pos_manual_ledger"() SET search_path=pg_catalog, public;
ALTER FUNCTION public."protect_pos_manual_append_only"() SET search_path=pg_catalog, public;

CREATE TRIGGER "pos_manual_vault_proofs_append_only" BEFORE UPDATE OR DELETE ON public."pos_manual_vault_proofs"
  FOR EACH ROW EXECUTE FUNCTION public."protect_pos_manual_append_only"();
CREATE TRIGGER "pos_manual_open_requests_delete_guard" BEFORE DELETE ON public."pos_manual_open_requests"
  FOR EACH ROW EXECUTE FUNCTION public."protect_pos_manual_append_only"();

CREATE FUNCTION public."guard_pos_manual_open_request_321f"() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW."branch_id",NEW."register_id",NEW."session_id",NEW."operator_profile_id",NEW."terminal_id",NEW."sale_draft_id",NEW."draft_revision",NEW."draft_request_hash",NEW."quote_hash",NEW."order_claim_id",NEW."payment_plan_id",NEW."payment_index",NEW."method",NEW."amount_cents",NEW."currency",NEW."installments",NEW."provider",NEW."connector_id",NEW."connector_revision",NEW."credential_ref",NEW."credential_revision",NEW."vault_adapter_id",NEW."provider_adapter_version",NEW."gate_config_hash",NEW."occurred_at",NEW."reason_code",NEW."maker_profile_id",NEW."maker_user_id",NEW."intent_hash",NEW."idempotency_key",NEW."prepare_request_hash",NEW."vault_idempotency_key",NEW."prepared_at",NEW."created_at")
      IS DISTINCT FROM ROW(OLD."branch_id",OLD."register_id",OLD."session_id",OLD."operator_profile_id",OLD."terminal_id",OLD."sale_draft_id",OLD."draft_revision",OLD."draft_request_hash",OLD."quote_hash",OLD."order_claim_id",OLD."payment_plan_id",OLD."payment_index",OLD."method",OLD."amount_cents",OLD."currency",OLD."installments",OLD."provider",OLD."connector_id",OLD."connector_revision",OLD."credential_ref",OLD."credential_revision",OLD."vault_adapter_id",OLD."provider_adapter_version",OLD."gate_config_hash",OLD."occurred_at",OLD."reason_code",OLD."maker_profile_id",OLD."maker_user_id",OLD."intent_hash",OLD."idempotency_key",OLD."prepare_request_hash",OLD."vault_idempotency_key",OLD."prepared_at",OLD."created_at") THEN
      RAISE EXCEPTION 'manual open request snapshots are immutable' USING ERRCODE='23514'; END IF;
    IF NOT ((OLD."state"='prepared' AND NEW."state" IN ('prepared','binding','expired'))
      OR (OLD."state"='binding' AND NEW."state" IN ('binding','finalized','rejected','expired'))
      OR (OLD."state"=NEW."state" AND OLD."state" IN ('finalized','rejected','expired'))) THEN
      RAISE EXCEPTION 'invalid manual open request transition' USING ERRCODE='23514'; END IF;
    IF NEW."fencing_token"<OLD."fencing_token" THEN RAISE EXCEPTION 'manual open fencing regressed' USING ERRCODE='23514'; END IF;
    IF OLD."state"='prepared' AND NEW."state"='prepared' AND ROW(NEW."ticket_consumed_at",NEW."lease_token_hash",NEW."lease_expires_at",NEW."fencing_token",NEW."claim_idempotency_hash",NEW."claim_binder_id",NEW."claim_lease_seconds",NEW."case_id",NEW."vault_proof_id",NEW."terminal_code",NEW."binding_at",NEW."finalized_at",NEW."abandoned_at") IS DISTINCT FROM ROW(OLD."ticket_consumed_at",OLD."lease_token_hash",OLD."lease_expires_at",OLD."fencing_token",OLD."claim_idempotency_hash",OLD."claim_binder_id",OLD."claim_lease_seconds",OLD."case_id",OLD."vault_proof_id",OLD."terminal_code",OLD."binding_at",OLD."finalized_at",OLD."abandoned_at") THEN RAISE EXCEPTION 'prepared replay may only rotate ticket' USING ERRCODE='23514'; END IF;
    IF OLD."state"='binding' AND NEW."state"='binding' AND NOT (OLD."lease_expires_at"<=pg_catalog.clock_timestamp() AND NEW."fencing_token"=OLD."fencing_token"+1 AND NEW."ticket_consumed_at"=OLD."ticket_consumed_at" AND NEW."case_id" IS NULL AND NEW."vault_proof_id" IS NULL) THEN RAISE EXCEPTION 'binding reclaim shape is invalid' USING ERRCODE='23514'; END IF;
    IF OLD."state" IN ('finalized','rejected','expired') THEN
      IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'terminal manual open request is immutable' USING ERRCODE='23514'; END IF;
      RETURN OLD;
    END IF;
  END IF;
  NEW."updated_at":=pg_catalog.clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER "pos_manual_open_requests_guard" BEFORE UPDATE ON public."pos_manual_open_requests"
  FOR EACH ROW EXECUTE FUNCTION public."guard_pos_manual_open_request_321f"();

CREATE FUNCTION public."validate_pos_manual_open_graph_321f"() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW."state"='finalized' AND NOT EXISTS (
    SELECT 1 FROM public."pos_manual_vault_proofs" p
    JOIN public."pos_manual_payment_vault_bindings" b ON b."case_id"=NEW."case_id" AND b."vault_proof_id"=p."id"
    JOIN public."pos_manual_payment_operations" o ON o."case_id"=NEW."case_id" AND o."action"='open' AND o."expected_version"=-1 AND o."resulting_version"=0
    JOIN public."pos_manual_payment_state_events" e ON e."operation_id"=o."id" AND e."to_state"='review_pending' AND e."resulting_version"=0
    JOIN public."pos_manual_payment_cases" c ON c."id"=NEW."case_id"
    WHERE p."id"=NEW."vault_proof_id" AND p."open_request_id"=NEW."id" AND p."case_id"=c."id"
      AND p."write_txid"=NEW."lifecycle_txid"
      AND o."write_txid"=NEW."lifecycle_txid" AND e."write_txid"=NEW."lifecycle_txid"
      AND ROW(c."branch_id",c."register_id",c."session_id",c."operator_profile_id",c."terminal_id",c."sale_draft_id",c."draft_revision",c."draft_request_hash",c."quote_hash",c."order_claim_id",c."payment_plan_id",c."payment_index",c."method",c."amount_cents",c."currency",c."installments",c."provider",c."connector_id",c."connector_revision",c."credential_ref",c."credential_revision",c."occurred_at",c."reason_code",c."maker_profile_id",c."maker_user_id",c."request_hash",c."reference_hash",c."reference_key_id",c."reference_last_four")
        IS NOT DISTINCT FROM ROW(NEW."branch_id",NEW."register_id",NEW."session_id",NEW."operator_profile_id",NEW."terminal_id",NEW."sale_draft_id",NEW."draft_revision",NEW."draft_request_hash",NEW."quote_hash",NEW."order_claim_id",NEW."payment_plan_id",NEW."payment_index",NEW."method",NEW."amount_cents",NEW."currency",NEW."installments",NEW."provider",NEW."connector_id",NEW."connector_revision",NEW."credential_ref",NEW."credential_revision",NEW."occurred_at",NEW."reason_code",NEW."maker_profile_id",NEW."maker_user_id",NEW."intent_hash",p."reference_hash",p."reference_key_id",p."reference_last_four")
      AND p."vault_adapter_id"=NEW."vault_adapter_id" AND p."provider"=NEW."provider"
      AND b."binding_kind"='proof_v1' AND b."vault_provider"=p."vault_adapter_id" AND b."vault_reference"='vault-proof:'||p."id"::text
      AND b."binding_hash"=p."binding_hash" AND b."stable_reference_index"=p."stable_reference_index"
      AND b."vault_key_id"=p."vault_key_id" AND b."retention_expires_at"=p."retention_expires_at"
      AND o."resulting_state"='review_pending' AND o."idempotency_key"='manual-open-321f:'||NEW."id"::text AND o."request_hash"=NEW."intent_hash"
      AND e."case_id"=NEW."case_id" AND e."from_state" IS NULL AND e."source"='api' AND e."source_id"=NEW."id"::text) THEN
    RAISE EXCEPTION 'manual open finalized graph is incomplete or divergent' USING ERRCODE='23514';
  END IF;
  IF NEW."state" IN ('rejected','expired') AND (EXISTS (SELECT 1 FROM public."pos_manual_vault_proofs" p WHERE p."open_request_id"=NEW."id") OR NEW."case_id" IS NOT NULL) THEN
    RAISE EXCEPTION 'terminal manual open request retained a graph' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "pos_manual_open_graph_guard" AFTER INSERT OR UPDATE ON public."pos_manual_open_requests"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public."validate_pos_manual_open_graph_321f"();

-- Every mutable vertex schedules validation of its owning request. This closes
-- the delete/insert-half gap that a request-only deferred trigger leaves open.
CREATE FUNCTION public."validate_pos_manual_open_graph_vertex_321f"() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE request_id UUID; r public."pos_manual_open_requests"%ROWTYPE;
BEGIN
 IF TG_TABLE_NAME='pos_manual_vault_proofs' THEN request_id:=COALESCE(NEW."open_request_id",OLD."open_request_id");
 ELSIF TG_TABLE_NAME='pos_manual_payment_cases' THEN SELECT "id" INTO request_id FROM public."pos_manual_open_requests" WHERE "case_id"=COALESCE(NEW."id",OLD."id");
 ELSIF TG_TABLE_NAME='pos_manual_payment_vault_bindings' THEN SELECT "id" INTO request_id FROM public."pos_manual_open_requests" WHERE "case_id"=COALESCE(NEW."case_id",OLD."case_id");
 ELSIF TG_TABLE_NAME='pos_manual_payment_operations' THEN SELECT "id" INTO request_id FROM public."pos_manual_open_requests" WHERE "case_id"=COALESCE(NEW."case_id",OLD."case_id");
 ELSE SELECT "id" INTO request_id FROM public."pos_manual_open_requests" WHERE "case_id"=COALESCE(NEW."case_id",OLD."case_id"); END IF;
 IF request_id IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO r FROM public."pos_manual_open_requests" WHERE "id"=request_id;
 IF r."state"='finalized' THEN
   IF (SELECT count(*) FROM public."pos_manual_vault_proofs" WHERE "open_request_id"=r."id" AND "case_id"=r."case_id" AND "id"=r."vault_proof_id")<>1
      OR (SELECT count(*) FROM public."pos_manual_payment_vault_bindings" WHERE "case_id"=r."case_id" AND "vault_proof_id"=r."vault_proof_id" AND "binding_kind"='proof_v1')<>1
      OR (SELECT count(*) FROM public."pos_manual_payment_operations" WHERE "case_id"=r."case_id" AND "action"='open')<>1
      OR (SELECT count(*) FROM public."pos_manual_payment_operations" WHERE "case_id"=r."case_id" AND "action"='open' AND "expected_version"=-1 AND "resulting_version"=0 AND "resulting_state"='review_pending' AND "idempotency_key"='manual-open-321f:'||r."id"::text AND "request_hash"=r."intent_hash" AND "write_txid"=r."lifecycle_txid")<>1
      OR (SELECT count(*) FROM public."pos_manual_payment_state_events" e JOIN public."pos_manual_payment_operations" o ON o."id"=e."operation_id" WHERE o."case_id"=r."case_id" AND o."action"='open')<>1
      OR (SELECT count(*) FROM public."pos_manual_payment_state_events" e JOIN public."pos_manual_payment_operations" o ON o."id"=e."operation_id" WHERE e."case_id"=r."case_id" AND o."action"='open' AND e."from_state" IS NULL AND e."to_state"='review_pending' AND e."resulting_version"=0 AND e."source"='api' AND e."source_id"=r."id"::text AND e."write_txid"=r."lifecycle_txid")<>1 THEN
     RAISE EXCEPTION 'manual open graph cardinality diverged' USING ERRCODE='23514';
   END IF;
   IF NOT EXISTS (SELECT 1 FROM public."pos_manual_vault_proofs" p JOIN public."pos_manual_payment_vault_bindings" b ON b."vault_proof_id"=p."id" AND b."case_id"=p."case_id" JOIN public."pos_manual_payment_cases" c ON c."id"=p."case_id"
     WHERE p."open_request_id"=r."id" AND p."id"=r."vault_proof_id" AND p."vault_adapter_id"=r."vault_adapter_id" AND p."provider"=r."provider"
       AND ROW(c."branch_id",c."register_id",c."session_id",c."operator_profile_id",c."terminal_id",c."sale_draft_id",c."draft_revision",c."draft_request_hash",c."quote_hash",c."order_claim_id",c."payment_plan_id",c."payment_index",c."method",c."amount_cents",c."currency",c."installments",c."provider",c."connector_id",c."connector_revision",c."credential_ref",c."credential_revision",c."occurred_at",c."reason_code",c."maker_profile_id",c."maker_user_id",c."request_hash",c."reference_hash",c."reference_key_id",c."reference_last_four") IS NOT DISTINCT FROM ROW(r."branch_id",r."register_id",r."session_id",r."operator_profile_id",r."terminal_id",r."sale_draft_id",r."draft_revision",r."draft_request_hash",r."quote_hash",r."order_claim_id",r."payment_plan_id",r."payment_index",r."method",r."amount_cents",r."currency",r."installments",r."provider",r."connector_id",r."connector_revision",r."credential_ref",r."credential_revision",r."occurred_at",r."reason_code",r."maker_profile_id",r."maker_user_id",r."intent_hash",p."reference_hash",p."reference_key_id",p."reference_last_four")
       AND b."binding_kind"='proof_v1' AND b."vault_provider"=p."vault_adapter_id" AND b."vault_reference"='vault-proof:'||p."id"::text AND b."vault_key_id"=p."vault_key_id" AND b."binding_hash"=p."binding_hash" AND b."stable_reference_index"=p."stable_reference_index" AND b."retention_expires_at"=p."retention_expires_at" AND p."write_txid"=r."lifecycle_txid") THEN
     RAISE EXCEPTION 'manual open graph snapshots diverged' USING ERRCODE='23514';
   END IF;
 ELSIF EXISTS(SELECT 1 FROM public."pos_manual_vault_proofs" WHERE "open_request_id"=r."id") OR r."case_id" IS NOT NULL THEN
   RAISE EXCEPTION 'non-final manual open request retained graph' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "pos_manual_open_graph_from_proof" AFTER INSERT OR UPDATE OR DELETE ON public."pos_manual_vault_proofs" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public."validate_pos_manual_open_graph_vertex_321f"();
CREATE CONSTRAINT TRIGGER "pos_manual_open_graph_from_case" AFTER INSERT OR UPDATE OR DELETE ON public."pos_manual_payment_cases" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public."validate_pos_manual_open_graph_vertex_321f"();
CREATE CONSTRAINT TRIGGER "pos_manual_open_graph_from_binding" AFTER INSERT OR UPDATE OR DELETE ON public."pos_manual_payment_vault_bindings" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public."validate_pos_manual_open_graph_vertex_321f"();
CREATE CONSTRAINT TRIGGER "pos_manual_open_graph_from_operation" AFTER INSERT OR UPDATE OR DELETE ON public."pos_manual_payment_operations" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public."validate_pos_manual_open_graph_vertex_321f"();
CREATE CONSTRAINT TRIGGER "pos_manual_open_graph_from_event" AFTER INSERT OR UPDATE OR DELETE ON public."pos_manual_payment_state_events" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public."validate_pos_manual_open_graph_vertex_321f"();

CREATE FUNCTION public."pos_manual_lock_open_graph_321f"(p_request_id UUID) RETURNS public."pos_manual_open_requests"
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE r public."pos_manual_open_requests"%ROWTYPE;
BEGIN
 SELECT * INTO r FROM public."pos_manual_open_requests" WHERE "id"=p_request_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'manual open request not found' USING ERRCODE='23503'; END IF;
 PERFORM 1 FROM public."cash_register_sessions" WHERE "id"=r."session_id" FOR UPDATE;
 PERFORM 1 FROM public."pos_terminals" WHERE "id"=r."terminal_id" FOR UPDATE;
 PERFORM 1 FROM public."tenant_user_profiles" WHERE "id"=r."operator_profile_id" FOR SHARE;
 PERFORM 1 FROM public."branches" WHERE "id"=r."branch_id" FOR SHARE;
 PERFORM 1 FROM public."pos_registers" WHERE "id"=r."register_id" FOR SHARE;
 PERFORM 1 FROM public."branch_user_accesses" WHERE "branch_id"=r."branch_id" AND "user_profile_id"=r."operator_profile_id" FOR SHARE;
 PERFORM 1 FROM public."pos_register_accesses" WHERE "register_id"=r."register_id" AND "user_profile_id"=r."operator_profile_id" FOR SHARE;
 IF r."order_claim_id" IS NOT NULL THEN PERFORM 1 FROM public."pos_order_claims" WHERE "id"=r."order_claim_id" FOR UPDATE; END IF;
 PERFORM 1 FROM public."pos_held_sales" WHERE "id"=r."sale_draft_id" FOR UPDATE;
 PERFORM 1 FROM public."pos_payment_plans" WHERE "id"=r."payment_plan_id" FOR UPDATE;
 PERFORM 1 FROM public."pos_payment_plan_slots" WHERE "plan_id"=r."payment_plan_id" AND "payment_index"=r."payment_index" FOR UPDATE;
 PERFORM 1 FROM public."pos_connectors" WHERE "id"=r."connector_id" FOR SHARE;
 PERFORM 1 FROM public."integration_credentials" WHERE "id"=r."credential_ref" FOR SHARE;
 PERFORM 1 FROM public."integration_providers" WHERE "id"=r."provider" FOR SHARE;
 PERFORM 1 FROM public."pos_manual_payment_reconciliation_gates" WHERE "connector_id"=r."connector_id" FOR SHARE;
 SELECT * INTO r FROM public."pos_manual_open_requests" WHERE "id"=p_request_id FOR UPDATE;
 RETURN r;
END $$;
REVOKE ALL ON FUNCTION public."pos_manual_lock_open_graph_321f"(UUID) FROM PUBLIC;

CREATE FUNCTION public."pos_manual_open_boundary_failure_321f"(p_request_id UUID,p_now TIMESTAMPTZ) RETURNS TEXT
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE r public."pos_manual_open_requests"%ROWTYPE;
BEGIN
 SELECT * INTO r FROM public."pos_manual_open_requests" WHERE "id"=p_request_id;
 IF NOT EXISTS(SELECT 1 FROM public."cash_register_sessions" s
  JOIN public."pos_terminals" t ON t."id"=r."terminal_id"
  JOIN public."tenant_user_profiles" u ON u."id"=r."operator_profile_id"
  JOIN public."branches" b ON b."id"=r."branch_id"
  JOIN public."pos_registers" reg ON reg."id"=r."register_id"
  JOIN public."branch_user_accesses" ba ON ba."branch_id"=r."branch_id" AND ba."user_profile_id"=r."operator_profile_id"
  JOIN public."pos_register_accesses" ra ON ra."register_id"=r."register_id" AND ra."user_profile_id"=r."operator_profile_id"
  JOIN public."pos_held_sales" d ON d."id"=r."sale_draft_id"
  JOIN public."pos_payment_plans" p ON p."id"=r."payment_plan_id"
  JOIN public."pos_payment_plan_slots" slot ON slot."plan_id"=p."id" AND slot."payment_index"=r."payment_index"
  JOIN public."pos_connectors" c ON c."id"=r."connector_id"
  JOIN public."integration_credentials" cred ON cred."id"=r."credential_ref"
  JOIN public."integration_providers" provider ON provider."id"=r."provider"
  JOIN public."pos_manual_payment_reconciliation_gates" g ON g."connector_id"=r."connector_id"
  LEFT JOIN public."pos_order_claims" oc ON oc."id"=r."order_claim_id"
 WHERE s."id"=r."session_id" AND s."register_id"=r."register_id" AND s."operator_profile_id"=r."operator_profile_id" AND s."status"='open'
  AND t."register_id"=r."register_id" AND t."status"='online' AND t."revoked_at" IS NULL AND t."paired_at" IS NOT NULL
  AND t."token_hash" IS NOT NULL AND t."token_expires_at">p_now AND t."last_seen_at">p_now-interval '5 minutes' AND length(pg_catalog.btrim(t."app_version"))>0
  AND u."user_id"=r."maker_user_id" AND u."status"='active' AND b."status"='active' AND reg."branch_id"=r."branch_id" AND reg."status"='active'
  AND ba."can_sell" AND ra."active" AND ra."can_sell" AND ra."can_manual_payment"
  AND (ra."valid_from" IS NULL OR ra."valid_from"<=p_now) AND (ra."valid_until" IS NULL OR ra."valid_until">p_now)
  AND ROW(d."register_id",d."session_id",d."operator_profile_id",d."revision",d."request_hash",d."status") IS NOT DISTINCT FROM ROW(r."register_id",r."session_id",r."operator_profile_id",r."draft_revision",r."draft_request_hash",p."draft_status")
  AND (d."expires_at" IS NULL OR d."expires_at">p_now)
  AND ROW(p."branch_id",p."register_id",p."session_id",p."operator_profile_id",p."terminal_id",p."sale_draft_id",p."draft_revision",p."draft_request_hash",p."quote_hash",p."order_claim_id",p."currency",p."total_cents",p."state") IS NOT DISTINCT FROM ROW(r."branch_id",r."register_id",r."session_id",r."operator_profile_id",r."terminal_id",r."sale_draft_id",r."draft_revision",r."draft_request_hash",r."quote_hash",r."order_claim_id",r."currency",r."amount_cents",'active')
  AND p."expires_at">p_now AND ROW(slot."payment_index",slot."method",slot."amount_cents",slot."installments",slot."proof_kind",slot."provider",slot."connector_id",slot."credential_ref") IS NOT DISTINCT FROM ROW(0,r."method",r."amount_cents",r."installments",'manual',r."provider",r."connector_id",r."credential_ref")
  AND c."status"='active' AND c."revision"=r."connector_revision" AND c."branch_id"=r."branch_id" AND (c."register_id" IS NULL OR c."register_id"=r."register_id") AND c."provider"=r."provider" AND c."credential_ref"=r."credential_ref"
  AND c."settings" @> '{"manualReconciliation":{"enabled":true,"vaultBindingRequired":true}}'::jsonb AND c."settings"->'capabilities' ? 'manual_reference_query'
  AND cred."enabled" AND cred."revision"=r."credential_revision" AND cred."provider_id"=r."provider" AND provider."family"='payment'
  AND g."enabled" AND g."connector_revision"=r."connector_revision" AND g."credential_ref"=r."credential_ref" AND g."credential_revision"=r."credential_revision"
  AND g."vault_adapter_id"=r."vault_adapter_id" AND g."provider_adapter_version"=r."provider_adapter_version" AND g."config_hash"=r."gate_config_hash"
  AND (r."order_claim_id" IS NULL OR (oc."state"='active' AND oc."lease_expires_at">p_now AND oc."session_id"=r."session_id" AND oc."terminal_id"=r."terminal_id" AND oc."operator_profile_id"=r."operator_profile_id"))) THEN RETURN 'manual_open_boundary_changed'; END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public."pos_manual_open_boundary_failure_321f"(UUID,TIMESTAMPTZ) FROM PUBLIC;

-- Prepare uses the authoritative payment plan as locator, then follows the same
-- session-first lock order used by 321e before it re-reads the plan.
CREATE FUNCTION public."pos_manual_prepare_open_v1"(p_payment_plan_id TEXT,p_payment_index INTEGER,p_maker_profile_id INTEGER,p_maker_user_id TEXT,p_occurred_at TIMESTAMPTZ,p_reason_code TEXT,p_idempotency_key TEXT,p_intent_hash TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE plan public."pos_payment_plans"%ROWTYPE; slot public."pos_payment_plan_slots"%ROWTYPE; gate public."pos_manual_payment_reconciliation_gates"%ROWTYPE; prior public."pos_manual_open_requests"%ROWTYPE; now_at TIMESTAMPTZ; ticket TEXT; ticket_digest TEXT; prepare_hash TEXT;
BEGIN
 IF p_payment_plan_id IS NULL OR p_payment_index<>0 OR p_maker_profile_id<=0 OR p_maker_user_id IS NULL OR p_occurred_at IS NULL OR p_reason_code IS NULL OR p_intent_hash!~'^[0-9a-f]{64}$' OR length(p_idempotency_key) NOT BETWEEN 32 AND 160 THEN RAISE EXCEPTION 'invalid closed manual prepare input' USING ERRCODE='22023'; END IF;
 prepare_hash:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('pos-manual-prepare-v1'||pg_catalog.jsonb_build_array(p_payment_plan_id,p_payment_index,p_maker_profile_id,p_maker_user_id,extract(epoch FROM p_occurred_at),p_reason_code,p_idempotency_key,p_intent_hash)::text,'UTF8')),'hex');
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('pos_manual_prepare_open_v1'),pg_catalog.hashtext(p_maker_user_id||':'||p_idempotency_key));
 SELECT * INTO plan FROM public."pos_payment_plans" WHERE "id"=p_payment_plan_id; IF NOT FOUND THEN RAISE EXCEPTION 'manual plan not found' USING ERRCODE='23503'; END IF;
 PERFORM 1 FROM public."cash_register_sessions" WHERE "id"=plan."session_id" FOR UPDATE;
 PERFORM 1 FROM public."pos_terminals" WHERE "id"=plan."terminal_id" FOR UPDATE;
 PERFORM 1 FROM public."tenant_user_profiles" WHERE "id"=p_maker_profile_id FOR SHARE;
 PERFORM 1 FROM public."branches" WHERE "id"=plan."branch_id" FOR SHARE; PERFORM 1 FROM public."pos_registers" WHERE "id"=plan."register_id" FOR SHARE;
 PERFORM 1 FROM public."branch_user_accesses" WHERE "branch_id"=plan."branch_id" AND "user_profile_id"=p_maker_profile_id FOR SHARE;
 PERFORM 1 FROM public."pos_register_accesses" WHERE "register_id"=plan."register_id" AND "user_profile_id"=p_maker_profile_id FOR SHARE;
 IF plan."order_claim_id" IS NOT NULL THEN PERFORM 1 FROM public."pos_order_claims" WHERE "id"=plan."order_claim_id" FOR UPDATE; END IF;
 PERFORM 1 FROM public."pos_held_sales" WHERE "id"=plan."sale_draft_id" FOR UPDATE;
 SELECT * INTO plan FROM public."pos_payment_plans" WHERE "id"=p_payment_plan_id FOR UPDATE;
 SELECT * INTO slot FROM public."pos_payment_plan_slots" WHERE "plan_id"=plan."id" AND "payment_index"=0 FOR UPDATE;
 PERFORM 1 FROM public."pos_connectors" WHERE "id"=slot."connector_id" FOR SHARE; PERFORM 1 FROM public."integration_credentials" WHERE "id"=slot."credential_ref" FOR SHARE;
 SELECT * INTO gate FROM public."pos_manual_payment_reconciliation_gates" WHERE "connector_id"=slot."connector_id" FOR SHARE;
 SELECT * INTO prior FROM public."pos_manual_open_requests" WHERE "branch_id"=plan."branch_id" AND "maker_user_id"=p_maker_user_id AND "idempotency_key"=p_idempotency_key FOR UPDATE;
 now_at:=pg_catalog.clock_timestamp();
 IF p_occurred_at<now_at-interval '24 hours' OR p_occurred_at>now_at+interval '5 minutes' OR p_occurred_at>plan."expires_at" OR public."pos_manual_identifier_contains_pan_321f"(p_reason_code) THEN RAISE EXCEPTION 'manual prepare causal input is invalid' USING ERRCODE='22023'; END IF;
 IF FOUND THEN IF prior."prepare_request_hash" IS DISTINCT FROM prepare_hash THEN RAISE EXCEPTION 'manual prepare idempotency conflict' USING ERRCODE='23505'; END IF;
   IF public."pos_manual_open_boundary_failure_321f"(prior."id",now_at) IS NOT NULL THEN RAISE EXCEPTION 'manual prepare replay authority changed' USING ERRCODE='23514'; END IF;
   IF prior."state"='prepared' AND prior."ticket_expires_at"<=now_at THEN UPDATE public."pos_manual_open_requests" SET "state"='expired',"terminal_code"='ticket_expired',"abandoned_at"=now_at WHERE "id"=prior."id" RETURNING * INTO prior; END IF;
   IF prior."state"<>'prepared' THEN RETURN pg_catalog.jsonb_build_object('requestId',prior."id",'state',prior."state",'ticket',NULL,'ticketExpiresAt',prior."ticket_expires_at",'replayed',true); END IF;
   ticket:=pg_catalog.replace(pg_catalog.gen_random_uuid()::text,'-','')||pg_catalog.replace(pg_catalog.gen_random_uuid()::text,'-',''); ticket_digest:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(ticket,'UTF8')),'hex');
   UPDATE public."pos_manual_open_requests" SET "ticket_hash"=ticket_digest,"ticket_expires_at"=now_at+interval '90 seconds' WHERE "id"=prior."id";
   RETURN pg_catalog.jsonb_build_object('requestId',prior."id",'state','prepared','ticket',ticket,'ticketExpiresAt',now_at+interval '90 seconds','replayed',true); END IF;
 IF plan."state"<>'active' OR plan."expires_at"<=now_at OR slot."proof_kind"<>'manual' OR slot."payment_index"<>0 OR plan."operator_profile_id"<>p_maker_profile_id
   OR gate."enabled" IS DISTINCT FROM true OR gate."connector_revision"<>(SELECT "revision" FROM public."pos_connectors" WHERE "id"=slot."connector_id")
   OR gate."vault_adapter_id" IS NULL OR gate."provider_adapter_version" IS NULL OR gate."config_hash"!~'^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'manual prepare boundary is disabled or divergent' USING ERRCODE='23514'; END IF;
 ticket:=pg_catalog.replace(pg_catalog.gen_random_uuid()::text,'-','')||pg_catalog.replace(pg_catalog.gen_random_uuid()::text,'-',''); ticket_digest:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(ticket,'UTF8')),'hex');
 INSERT INTO public."pos_manual_open_requests"("branch_id","register_id","session_id","operator_profile_id","terminal_id","sale_draft_id","draft_revision","draft_request_hash","quote_hash","order_claim_id","payment_plan_id","payment_index","method","amount_cents","currency","installments","provider","connector_id","connector_revision","credential_ref","credential_revision","vault_adapter_id","provider_adapter_version","gate_config_hash","occurred_at","reason_code","maker_profile_id","maker_user_id","intent_hash","idempotency_key","prepare_request_hash","ticket_hash","ticket_expires_at","vault_idempotency_key","state","prepared_at","created_at","updated_at")
 VALUES(plan."branch_id",plan."register_id",plan."session_id",plan."operator_profile_id",plan."terminal_id",plan."sale_draft_id",plan."draft_revision",plan."draft_request_hash",plan."quote_hash",plan."order_claim_id",plan."id",0,slot."method",slot."amount_cents",plan."currency",slot."installments",slot."provider",slot."connector_id",gate."connector_revision",slot."credential_ref",gate."credential_revision",gate."vault_adapter_id",gate."provider_adapter_version",gate."config_hash",p_occurred_at,p_reason_code,p_maker_profile_id,p_maker_user_id,p_intent_hash,p_idempotency_key,prepare_hash,ticket_digest,now_at+interval '90 seconds','tenant:'||pg_catalog.current_database()||':open:'||pg_catalog.gen_random_uuid()::text,'prepared',now_at,now_at,now_at) RETURNING * INTO prior;
 IF public."pos_manual_open_boundary_failure_321f"(prior."id",now_at) IS NOT NULL THEN RAISE EXCEPTION 'manual prepare boundary diverged after locks' USING ERRCODE='23514'; END IF;
 RETURN pg_catalog.jsonb_build_object('requestId',prior."id",'state','prepared','ticket',ticket,'ticketExpiresAt',prior."ticket_expires_at",'replayed',false);
END $$;

CREATE FUNCTION public."pos_manual_claim_open_for_vault_v1"(p_request_id UUID,p_ticket TEXT,p_binder_id TEXT,p_claim_idempotency_key TEXT,p_lease_seconds INTEGER)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r public."pos_manual_open_requests"%ROWTYPE; now_at TIMESTAMPTZ; claim_token TEXT; claim_hash TEXT; idem_hash TEXT;
BEGIN
 IF p_request_id IS NULL OR p_ticket IS NULL OR length(p_ticket) NOT BETWEEN 32 AND 160 OR p_binder_id IS NULL OR p_binder_id!~'^[A-Za-z][A-Za-z0-9._:-]{2,79}$' OR public."pos_manual_identifier_contains_pan_321f"(p_binder_id) OR p_claim_idempotency_key IS NULL OR p_claim_idempotency_key!~'^[0-9a-f]{64,160}$' OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 15 AND 300 THEN RAISE EXCEPTION 'invalid closed vault claim input' USING ERRCODE='22023'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('pos_manual_open_321f'),pg_catalog.hashtext(p_request_id::text));
 r:=public."pos_manual_lock_open_graph_321f"(p_request_id); now_at:=pg_catalog.clock_timestamp();
 IF r."state"='prepared' AND r."ticket_expires_at"<=now_at THEN UPDATE public."pos_manual_open_requests" SET "state"='expired',"terminal_code"='ticket_expired',"abandoned_at"=now_at WHERE "id"=r."id" RETURNING * INTO r; RETURN pg_catalog.jsonb_build_object('requestId',r."id",'state','expired','claimToken',NULL,'safeToCompensate',true); END IF;
 IF public."pos_manual_open_boundary_failure_321f"(r."id",now_at) IS NOT NULL THEN RAISE EXCEPTION 'manual vault claim boundary diverged' USING ERRCODE='23514'; END IF;
 idem_hash:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('pos-manual-claim-idempotency-v1'||pg_catalog.jsonb_build_array(p_request_id,p_binder_id,p_claim_idempotency_key,p_lease_seconds)::text,'UTF8')),'hex');
 IF r."state"='binding' AND r."claim_idempotency_hash"=idem_hash AND r."claim_binder_id"=p_binder_id AND r."claim_lease_seconds"=p_lease_seconds AND r."lease_expires_at">now_at THEN
   claim_token:='vault-claim:'||pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('pos-manual-claim-token-v1'||pg_catalog.jsonb_build_array(r."id",p_binder_id,p_claim_idempotency_key,r."fencing_token")::text,'UTF8')),'hex');
   claim_hash:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(claim_token,'UTF8')),'hex');
   IF claim_hash IS DISTINCT FROM r."lease_token_hash" THEN RAISE EXCEPTION 'manual vault claim replay integrity failure' USING ERRCODE='23514'; END IF;
   RETURN pg_catalog.jsonb_build_object('requestId',r."id",'claimToken',claim_token,'fencingToken',r."fencing_token",'leaseExpiresAt',r."lease_expires_at",'vaultIdempotencyKey',r."vault_idempotency_key",'provider',r."provider",'vaultAdapterId',r."vault_adapter_id",'requestedRetentionExpiresAt',LEAST((SELECT "expires_at"+interval '60 seconds' FROM public."pos_payment_plans" WHERE "id"=r."payment_plan_id"),r."binding_at"+interval '16 minutes'),'replayed',true);
 END IF;
 IF NOT ((r."state"='prepared' AND r."ticket_expires_at">now_at AND r."ticket_hash"=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_ticket,'UTF8')),'hex')) OR (r."state"='binding' AND r."lease_expires_at"<=now_at)) THEN RAISE EXCEPTION 'manual vault ticket or lease is not claimable' USING ERRCODE='23514'; END IF;
 claim_token:='vault-claim:'||pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('pos-manual-claim-token-v1'||pg_catalog.jsonb_build_array(r."id",p_binder_id,p_claim_idempotency_key,r."fencing_token"+1)::text,'UTF8')),'hex'); claim_hash:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(claim_token,'UTF8')),'hex');
 UPDATE public."pos_manual_open_requests" SET "state"='binding',"ticket_consumed_at"=COALESCE("ticket_consumed_at",now_at),"lease_token_hash"=claim_hash,"lease_expires_at"=now_at+pg_catalog.make_interval(secs=>p_lease_seconds),"fencing_token"="fencing_token"+1,"claim_idempotency_hash"=idem_hash,"claim_binder_id"=p_binder_id,"claim_lease_seconds"=p_lease_seconds,"binding_at"=now_at WHERE "id"=r."id" RETURNING * INTO r;
 RETURN pg_catalog.jsonb_build_object('requestId',r."id",'claimToken',claim_token,'fencingToken',r."fencing_token",'leaseExpiresAt',r."lease_expires_at",'vaultIdempotencyKey',r."vault_idempotency_key",'provider',r."provider",'vaultAdapterId',r."vault_adapter_id",'requestedRetentionExpiresAt',LEAST((SELECT "expires_at"+interval '60 seconds' FROM public."pos_payment_plans" WHERE "id"=r."payment_plan_id"),r."binding_at"+interval '16 minutes'),'replayed',false);
END $$;

CREATE FUNCTION public."pos_manual_open_case_v1"(p_request_id UUID,p_claim_token TEXT,p_fencing_token BIGINT,p_finalize_idempotency_key TEXT,p_external_proof_id TEXT,p_stable_reference_index TEXT,p_reference_hash TEXT,p_reference_key_id TEXT,p_reference_last_four TEXT,p_vault_key_id TEXT,p_binding_hash TEXT,p_proof_hash TEXT,p_signature_hash TEXT,p_issued_at TIMESTAMPTZ,p_retention_expires_at TIMESTAMPTZ,p_verifier_version TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r public."pos_manual_open_requests"%ROWTYPE; c public."pos_manual_payment_cases"%ROWTYPE; proof public."pos_manual_vault_proofs"%ROWTYPE; op_id BIGINT; now_at TIMESTAMPTZ; new_case_id UUID:=pg_catalog.gen_random_uuid(); tx NUMERIC:=pg_catalog.txid_current()::numeric; idem_hash TEXT; finalize_hash TEXT; expected_proof_hash TEXT; verifier_skew INTEGER;
BEGIN
 IF p_request_id IS NULL OR p_claim_token IS NULL OR length(p_claim_token) NOT BETWEEN 32 AND 160 OR p_fencing_token IS NULL OR p_fencing_token<=0 OR p_finalize_idempotency_key IS NULL OR length(p_finalize_idempotency_key) NOT BETWEEN 8 AND 160 OR p_external_proof_id IS NULL OR length(p_external_proof_id) NOT BETWEEN 8 AND 160 OR p_reference_key_id IS NULL OR p_reference_last_four IS NULL OR p_vault_key_id IS NULL OR p_issued_at IS NULL OR p_retention_expires_at IS NULL OR p_verifier_version IS NULL THEN RAISE EXCEPTION 'invalid closed manual finalize input' USING ERRCODE='22023'; END IF;
 idem_hash:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('pos-manual-finalize-idempotency-v1'||pg_catalog.jsonb_build_array(p_request_id,p_fencing_token,p_finalize_idempotency_key)::text,'UTF8')),'hex');
 finalize_hash:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('pos-manual-finalize-request-v1'||pg_catalog.jsonb_build_array(
   p_request_id,p_fencing_token,p_finalize_idempotency_key,p_external_proof_id,p_stable_reference_index,p_reference_hash,p_reference_key_id,p_reference_last_four,p_vault_key_id,
   p_binding_hash,p_proof_hash,p_signature_hash,extract(epoch FROM p_issued_at),extract(epoch FROM p_retention_expires_at),p_verifier_version
 )::text,'UTF8')),'hex');
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('pos_manual_open_321f'),pg_catalog.hashtext(p_request_id::text));
 r:=public."pos_manual_lock_open_graph_321f"(p_request_id); now_at:=pg_catalog.clock_timestamp();
 IF r."state"='finalized' THEN IF r."finalize_idempotency_hash" IS DISTINCT FROM idem_hash OR r."finalize_request_hash" IS DISTINCT FROM finalize_hash THEN RAISE EXCEPTION 'manual finalize idempotency conflict' USING ERRCODE='23505'; END IF; RETURN pg_catalog.jsonb_build_object('caseId',r."case_id",'state','review_pending','version',0,'replayed',true); END IF;
 -- Serialize every evidence uniqueness domain before the final clock capture.
 -- Operational roles cannot bypass these locks because they have no table DML.
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('pos-manual-proof-external-v1'),pg_catalog.hashtext(p_external_proof_id));
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('pos-manual-proof-blind-v1'),pg_catalog.hashtext(p_stable_reference_index));
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('pos-manual-proof-binding-v1'),pg_catalog.hashtext(p_binding_hash));
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('pos-manual-proof-provider-reference-v1'),pg_catalog.hashtext(pg_catalog.jsonb_build_array(r."provider",p_reference_hash)::text));
 SELECT "max_future_skew_seconds" INTO verifier_skew FROM public."pos_manual_payment_vault_verifiers" WHERE "verifier_version"=p_verifier_version AND "enabled" FOR SHARE;
 now_at:=pg_catalog.clock_timestamp();
 IF public."pos_manual_open_boundary_failure_321f"(r."id",now_at) IS NOT NULL THEN RAISE EXCEPTION 'manual vault finalize boundary diverged after locks' USING ERRCODE='23514'; END IF;
 expected_proof_hash:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('pos-manual-vault-proof-v1'||pg_catalog.jsonb_build_array(r."id",r."fencing_token",r."vault_idempotency_key",r."vault_adapter_id",r."provider",p_external_proof_id,p_stable_reference_index,p_reference_hash,p_reference_key_id,p_reference_last_four,p_vault_key_id,p_binding_hash,p_signature_hash,extract(epoch FROM p_issued_at),extract(epoch FROM p_retention_expires_at),p_verifier_version)::text,'UTF8')),'hex');
 IF r."state"<>'binding' OR r."fencing_token"<>p_fencing_token OR r."lease_expires_at"<=now_at OR r."lease_token_hash"<>pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_claim_token,'UTF8')),'hex') OR verifier_skew IS NULL OR p_reference_hash!~'^hmac-sha256:v[0-9]+:[0-9a-f]{64}$' OR p_stable_reference_index!~'^vault-blind:v[0-9]+:[0-9a-f]{64}$' OR p_binding_hash!~'^[0-9a-f]{64}$' OR p_proof_hash IS DISTINCT FROM expected_proof_hash OR p_signature_hash!~'^[0-9a-f]{64}$' OR p_issued_at<r."binding_at" OR p_issued_at>now_at+pg_catalog.make_interval(secs=>verifier_skew) OR p_retention_expires_at<=p_issued_at OR p_retention_expires_at<=LEAST((SELECT "expires_at" FROM public."pos_payment_plans" WHERE "id"=r."payment_plan_id"),now_at+interval '15 minutes') OR p_retention_expires_at>(SELECT "expires_at"+interval '60 seconds' FROM public."pos_payment_plans" WHERE "id"=r."payment_plan_id") THEN RAISE EXCEPTION 'manual vault finalize boundary diverged' USING ERRCODE='23514'; END IF;
 BEGIN
 INSERT INTO public."pos_manual_payment_cases"("id","branch_id","register_id","session_id","operator_profile_id","terminal_id","sale_draft_id","draft_revision","draft_request_hash","quote_hash","order_claim_id","payment_plan_id","payment_index","method","amount_cents","currency","installments","provider","connector_id","connector_revision","credential_ref","credential_revision","reference_hash","reference_key_id","reference_last_four","occurred_at","reason_code","maker_profile_id","maker_user_id","state","version","lifecycle_txid","idempotency_key","request_hash","expires_at") VALUES(new_case_id,r."branch_id",r."register_id",r."session_id",r."operator_profile_id",r."terminal_id",r."sale_draft_id",r."draft_revision",r."draft_request_hash",r."quote_hash",r."order_claim_id",r."payment_plan_id",0,r."method",r."amount_cents",r."currency",r."installments",r."provider",r."connector_id",r."connector_revision",r."credential_ref",r."credential_revision",p_reference_hash,p_reference_key_id,p_reference_last_four,r."occurred_at",r."reason_code",r."maker_profile_id",r."maker_user_id",'review_pending',0,tx,r."idempotency_key",r."intent_hash",LEAST((SELECT "expires_at" FROM public."pos_payment_plans" WHERE "id"=r."payment_plan_id"),now_at+interval '15 minutes')) RETURNING * INTO c;
 INSERT INTO public."pos_manual_vault_proofs"("open_request_id","case_id","vault_adapter_id","provider","external_proof_id","stable_reference_index","reference_hash","reference_key_id","reference_last_four","vault_key_id","binding_hash","proof_hash","signature_hash","issued_at","retention_expires_at","verifier_version","write_txid","created_at") VALUES(r."id",new_case_id,r."vault_adapter_id",r."provider",p_external_proof_id,p_stable_reference_index,p_reference_hash,p_reference_key_id,p_reference_last_four,p_vault_key_id,p_binding_hash,p_proof_hash,p_signature_hash,p_issued_at,p_retention_expires_at,p_verifier_version,tx,now_at) RETURNING * INTO proof;
 INSERT INTO public."pos_manual_payment_vault_bindings"("case_id","vault_provider","vault_reference","vault_key_id","binding_hash","stable_reference_index","retention_expires_at","vault_proof_id","binding_kind") VALUES(new_case_id,r."vault_adapter_id",'vault-proof:'||proof."id"::text,p_vault_key_id,p_binding_hash,p_stable_reference_index,p_retention_expires_at,proof."id",'proof_v1');
 INSERT INTO public."pos_manual_payment_operations"("case_id","action","expected_version","resulting_version","resulting_state","idempotency_key","request_hash","write_txid") VALUES(new_case_id,'open',-1,0,'review_pending','manual-open-321f:'||r."id"::text,r."intent_hash",tx) RETURNING "id" INTO op_id;
 INSERT INTO public."pos_manual_payment_state_events"("case_id","operation_id","from_state","to_state","resulting_version","source","source_id","write_txid") VALUES(new_case_id,op_id,NULL,'review_pending',0,'api',r."id"::text,tx);
 UPDATE public."pos_manual_open_requests" SET "state"='finalized',"case_id"=new_case_id,"vault_proof_id"=proof."id","finalize_idempotency_hash"=idem_hash,"finalize_request_hash"=finalize_hash,"lifecycle_txid"=tx,"finalized_at"=now_at,"lease_token_hash"=NULL,"lease_expires_at"=NULL WHERE "id"=r."id";
 EXCEPTION WHEN unique_violation THEN
   RAISE EXCEPTION 'manual vault evidence conflict' USING ERRCODE='23505';
 END;
 RETURN pg_catalog.jsonb_build_object('caseId',new_case_id,'state','review_pending','version',0,'replayed',false);
END $$;

CREATE FUNCTION public."pos_manual_open_status_v1"(p_request_id UUID,p_maker_profile_id INTEGER,p_maker_user_id TEXT,p_idempotency_key TEXT) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r public."pos_manual_open_requests"%ROWTYPE; now_at TIMESTAMPTZ;
BEGIN
 IF p_request_id IS NULL OR p_maker_profile_id IS NULL OR p_maker_profile_id<=0 OR p_maker_user_id IS NULL OR p_idempotency_key IS NULL THEN RAISE EXCEPTION 'invalid closed manual status input' USING ERRCODE='22023'; END IF;
 r:=public."pos_manual_lock_open_graph_321f"(p_request_id); now_at:=pg_catalog.clock_timestamp();
 IF r."maker_profile_id"<>p_maker_profile_id OR r."maker_user_id"<>p_maker_user_id OR r."idempotency_key"<>p_idempotency_key THEN RAISE EXCEPTION 'manual open status not found' USING ERRCODE='23503'; END IF;
 IF r."state"='prepared' AND r."ticket_expires_at"<=now_at THEN UPDATE public."pos_manual_open_requests" SET "state"='expired',"terminal_code"='ticket_expired',"abandoned_at"=now_at WHERE "id"=r."id" RETURNING * INTO r; END IF;
 IF r."state"='binding' AND r."lease_expires_at"<=now_at AND NOT EXISTS(SELECT 1 FROM public."pos_manual_vault_proofs" WHERE "open_request_id"=r."id") THEN UPDATE public."pos_manual_open_requests" SET "state"='expired',"terminal_code"='lease_expired',"abandoned_at"=now_at,"lease_token_hash"=NULL,"lease_expires_at"=NULL WHERE "id"=r."id" RETURNING * INTO r; END IF;
 RETURN pg_catalog.jsonb_build_object('requestId',r."id",'state',r."state",'caseId',r."case_id",'terminalCode',r."terminal_code",'preparedAt',r."prepared_at",'finalizedAt',r."finalized_at");
END $$;

CREATE FUNCTION public."pos_manual_abandon_open_v1"(p_request_id UUID,p_claim_token TEXT,p_fencing_token BIGINT,p_idempotency_key TEXT,p_reason_code TEXT) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r public."pos_manual_open_requests"%ROWTYPE; now_at TIMESTAMPTZ; idem_hash TEXT; request_hash TEXT;
BEGIN
 IF p_request_id IS NULL OR p_claim_token IS NULL OR length(p_claim_token) NOT BETWEEN 32 AND 160 OR p_fencing_token IS NULL OR p_fencing_token<=0 OR p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 8 AND 160 OR p_reason_code IS NULL OR p_reason_code!~'^[a-z][a-z0-9._:-]{2,79}$' THEN RAISE EXCEPTION 'invalid closed manual abandon input' USING ERRCODE='22023'; END IF;
 idem_hash:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('pos-manual-abandon-idempotency-v1'||pg_catalog.jsonb_build_array(p_request_id,p_fencing_token,p_idempotency_key)::text,'UTF8')),'hex'); request_hash:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('pos-manual-abandon-request-v1'||pg_catalog.jsonb_build_array(p_request_id,pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_claim_token,'UTF8')),'hex'),p_fencing_token,p_idempotency_key,p_reason_code)::text,'UTF8')),'hex');
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('pos_manual_open_321f'),pg_catalog.hashtext(p_request_id::text));
 r:=public."pos_manual_lock_open_graph_321f"(p_request_id); now_at:=pg_catalog.clock_timestamp();
 IF r."state"='rejected' THEN IF r."fencing_token" IS DISTINCT FROM p_fencing_token OR r."abandon_idempotency_hash" IS DISTINCT FROM idem_hash OR r."abandon_request_hash" IS DISTINCT FROM request_hash THEN RAISE EXCEPTION 'manual abandon idempotency conflict' USING ERRCODE='23505'; END IF; RETURN pg_catalog.jsonb_build_object('requestId',r."id",'state',r."state",'safeToCompensate',true,'vaultIdempotencyKey',r."vault_idempotency_key",'replayed',true); END IF;
 IF r."state"='expired' THEN RAISE EXCEPTION 'expired manual open requires probe' USING ERRCODE='55000'; END IF;
 IF public."pos_manual_open_boundary_failure_321f"(r."id",now_at) IS NOT NULL OR r."state"<>'binding' OR r."fencing_token"<>p_fencing_token OR r."lease_expires_at"<=now_at OR r."lease_token_hash"<>pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_claim_token,'UTF8')),'hex') OR EXISTS(SELECT 1 FROM public."pos_manual_vault_proofs" WHERE "open_request_id"=r."id") OR r."case_id" IS NOT NULL THEN RAISE EXCEPTION 'manual open cannot be safely abandoned' USING ERRCODE='23514'; END IF;
 UPDATE public."pos_manual_open_requests" SET "state"='rejected',"terminal_code"='binder_abandoned',"abandon_idempotency_hash"=idem_hash,"abandon_request_hash"=request_hash,"abandoned_at"=now_at,"lease_token_hash"=NULL,"lease_expires_at"=NULL WHERE "id"=r."id";
 RETURN pg_catalog.jsonb_build_object('requestId',r."id",'state','rejected','safeToCompensate',true,'vaultIdempotencyKey',r."vault_idempotency_key",'replayed',false);
END $$;

CREATE FUNCTION public."pos_manual_probe_open_v1"(p_request_id UUID,p_vault_idempotency_key TEXT) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r public."pos_manual_open_requests"%ROWTYPE; proof_ok BOOLEAN; binding_ok BOOLEAN; now_at TIMESTAMPTZ;
BEGIN
 IF p_request_id IS NULL OR p_vault_idempotency_key IS NULL OR length(p_vault_idempotency_key) NOT BETWEEN 16 AND 240 THEN RAISE EXCEPTION 'invalid closed manual probe input' USING ERRCODE='22023'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('pos_manual_open_321f'),pg_catalog.hashtext(p_request_id::text));
 r:=public."pos_manual_lock_open_graph_321f"(p_request_id);
 IF r."vault_idempotency_key"<>p_vault_idempotency_key THEN RAISE EXCEPTION 'manual open probe not found' USING ERRCODE='23503'; END IF;
 proof_ok:=EXISTS(SELECT 1 FROM public."pos_manual_vault_proofs" WHERE "open_request_id"=r."id" AND "id"=r."vault_proof_id"); binding_ok:=EXISTS(SELECT 1 FROM public."pos_manual_payment_vault_bindings" WHERE "case_id"=r."case_id" AND "vault_proof_id"=r."vault_proof_id");
 now_at:=pg_catalog.clock_timestamp();
 IF r."state"='binding' AND r."lease_expires_at"<=now_at AND NOT proof_ok AND NOT binding_ok THEN UPDATE public."pos_manual_open_requests" SET "state"='expired',"terminal_code"='lease_expired',"abandoned_at"=now_at,"lease_token_hash"=NULL,"lease_expires_at"=NULL WHERE "id"=r."id" RETURNING * INTO r; END IF;
 RETURN pg_catalog.jsonb_build_object('requestId',r."id",'state',r."state",'caseId',r."case_id",'proofAccepted',proof_ok,'bindingAccepted',binding_ok,'safeToCompensate',r."state" IN ('rejected','expired') AND NOT proof_ok AND NOT binding_ok,'fencingToken',r."fencing_token");
END $$;

REVOKE ALL ON FUNCTION public."pos_manual_prepare_open_v1"(TEXT,INTEGER,INTEGER,TEXT,TIMESTAMPTZ,TEXT,TEXT,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_manual_claim_open_for_vault_v1"(UUID,TEXT,TEXT,TEXT,INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_manual_open_case_v1"(UUID,TEXT,BIGINT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ,TIMESTAMPTZ,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_manual_open_status_v1"(UUID,INTEGER,TEXT,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_manual_abandon_open_v1"(UUID,TEXT,BIGINT,TEXT,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_manual_probe_open_v1"(UUID,TEXT) FROM PUBLIC;

DO $grant$ DECLARE runtime_role NAME:=(current_database()||'_runtime')::NAME; binder_role NAME:=(current_database()||'_mb')::NAME; BEGIN
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=runtime_role) THEN EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION public.pos_manual_prepare_open_v1(text,integer,integer,text,timestamptz,text,text,text), public.pos_manual_open_status_v1(uuid,integer,text,text) TO %I',runtime_role); END IF;
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=binder_role) THEN EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION public.pos_manual_claim_open_for_vault_v1(uuid,text,text,text,integer), public.pos_manual_open_case_v1(uuid,text,bigint,text,text,text,text,text,text,text,text,text,text,timestamptz,timestamptz,text), public.pos_manual_abandon_open_v1(uuid,text,bigint,text,text), public.pos_manual_probe_open_v1(uuid,text) TO %I',binder_role); END IF;
END $grant$;

-- Deliberately no mutation of pos_manual_payment_reconciliation_gates. The
-- historical hard-disable trigger remains the production authority.
