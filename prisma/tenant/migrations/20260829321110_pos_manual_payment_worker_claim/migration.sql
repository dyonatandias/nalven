-- Worker-only claim/lease capability. This slice deliberately returns only a
-- non-bearer vault binding id; opening the vault remains blocked until 321f.

CREATE TABLE public."pos_manual_payment_claim_batches" (
  "id" UUID PRIMARY KEY,
  "request_key_hash" TEXT NOT NULL UNIQUE CHECK ("request_key_hash" ~ '^[0-9a-f]{64}$'),
  "request_hash" TEXT NOT NULL CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  "worker_id_hash" TEXT NOT NULL CHECK ("worker_id_hash" ~ '^[0-9a-f]{64}$'),
  "requested_limit" INTEGER NOT NULL CHECK ("requested_limit" BETWEEN 1 AND 50),
  "lease_seconds" INTEGER NOT NULL CHECK ("lease_seconds" BETWEEN 15 AND 300),
  "claimed_count" INTEGER NOT NULL CHECK ("claimed_count">=0),
  "blocked_count" INTEGER NOT NULL CHECK ("blocked_count">=0),
  "caller_role" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL
);

CREATE TABLE public."pos_manual_payment_claim_receipts" (
  "id" UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  "batch_id" UUID NOT NULL REFERENCES public."pos_manual_payment_claim_batches"("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  "batch_index" INTEGER NOT NULL CHECK ("batch_index">0),
  "attempt_id" UUID NOT NULL REFERENCES public."pos_manual_payment_attempts"("id") ON DELETE RESTRICT,
  "delivery_number" INTEGER NOT NULL CHECK ("delivery_number">0),
  "worker_id_hash" TEXT NOT NULL CHECK ("worker_id_hash" ~ '^[0-9a-f]{64}$'),
  "claim_token_hash" TEXT NOT NULL UNIQUE CHECK ("claim_token_hash" ~ '^[0-9a-f]{64}$'),
  "claim_expires_at" TIMESTAMPTZ NOT NULL,
  "reclaimed_expired_lease" BOOLEAN NOT NULL,
  "caller_role" TEXT NOT NULL,
  "claimed_at" TIMESTAMPTZ NOT NULL,
  UNIQUE ("attempt_id","delivery_number"),
  UNIQUE ("batch_id","batch_index"),
  CHECK ("claim_expires_at">"claimed_at")
);

CREATE TRIGGER "pos_manual_claim_receipts_append_only" BEFORE UPDATE OR DELETE
  ON public."pos_manual_payment_claim_receipts" FOR EACH ROW
  EXECUTE FUNCTION public."protect_pos_manual_append_only"();
CREATE TRIGGER "pos_manual_claim_batches_append_only" BEFORE UPDATE OR DELETE
  ON public."pos_manual_payment_claim_batches" FOR EACH ROW
  EXECUTE FUNCTION public."protect_pos_manual_append_only"();

-- The claim entrypoint itself resolves only pg_catalog. Historical deferred
-- trigger functions touched by this transaction used invoker search_path, so
-- pin them to the two trusted schemas before invoking them from the entrypoint.
ALTER FUNCTION public."guard_pos_manual_state_event"() SET search_path = pg_catalog, public;
ALTER FUNCTION public."validate_pos_manual_transition_commit"() SET search_path = pg_catalog, public;
ALTER FUNCTION public."validate_pos_manual_case_open_commit"() SET search_path = pg_catalog, public;

CREATE FUNCTION public."pos_manual_claim_queries_v1"(
  p_worker_id TEXT, p_limit INTEGER, p_lease_seconds INTEGER, p_request_idempotency_key TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
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
      WITH operation AS (
        INSERT INTO public."pos_manual_payment_operations"(
          "case_id","action","expected_version","resulting_version","resulting_state","idempotency_key","request_hash","write_txid"
        ) VALUES (case_record."id",'block',case_record."version",next_version,'blocked',
          'manual-claim-block:'||attempt_record."id"::text||':'||outbox_record."delivery_count"::text||':'||block_reason,
          block_hash,pg_catalog.txid_current()::numeric) RETURNING "id"
      ) INSERT INTO public."pos_manual_payment_state_events"(
        "case_id","operation_id","from_state","to_state","resulting_version","source","source_id","write_txid"
      ) SELECT case_record."id",operation."id",case_record."state",'blocked',next_version,'worker',attempt_record."id"::text,
        pg_catalog.txid_current()::numeric FROM operation;
      UPDATE public."pos_manual_payment_cases" SET "state"='blocked',"version"=next_version,"blocked_at"=now_at,
        "next_reconcile_at"=NULL WHERE "id"=case_record."id";
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

REVOKE ALL ON FUNCTION public."pos_manual_claim_queries_v1"(TEXT,INTEGER,INTEGER,TEXT) FROM PUBLIC;

DO $grant$
DECLARE worker_role NAME := (current_database()||'_mw')::NAME;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=worker_role) THEN
    EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION public.pos_manual_claim_queries_v1(text,integer,integer,text) TO %I',worker_role);
  END IF;
END;
$grant$;
