BEGIN;

-- T2-00 is deliberately inert. Refuse both legacy application backfill and a
-- deployment in which any manual reconciliation gate is already enabled.
DO $preflight$
BEGIN
  IF EXISTS (SELECT 1 FROM public."pos_manual_payment_applications") THEN
    RAISE EXCEPTION 'T2-00 requires an empty legacy application table'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public."pos_manual_payment_reconciliation_gates"
    WHERE "enabled" = true
  ) THEN
    RAISE EXCEPTION 'T2-00 requires every manual reconciliation gate disabled'
      USING ERRCODE = '23514';
  END IF;
END
$preflight$;

-- Remove the legacy application writers/validators. The shared ledger stamp
-- function remains because reviews, observations and state events still use it.
DROP TRIGGER "pos_manual_application_stamp"
  ON public."pos_manual_payment_applications";
DROP TRIGGER "pos_manual_application_guard"
  ON public."pos_manual_payment_applications";
DROP TRIGGER "pos_manual_application_graph_guard"
  ON public."pos_manual_payment_applications";
DROP FUNCTION public."guard_pos_manual_application"();
DROP FUNCTION public."validate_pos_manual_application_commit"();

CREATE FUNCTION public."pos_manual_canonical_json_impl_v1"(p_value jsonb, p_depth integer)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  value_type text := pg_catalog.jsonb_typeof(p_value);
  scalar_text text;
  result text;
BEGIN
  IF p_depth > 32 THEN
    RAISE EXCEPTION 'T2 canonical JSON exceeds depth limit' USING ERRCODE = '22023';
  END IF;
  IF value_type = 'object' THEN
    IF EXISTS (
      SELECT 1 FROM pg_catalog.jsonb_object_keys(p_value) AS object_key
      WHERE object_key IS DISTINCT FROM normalize(object_key, NFC)
        OR object_key ~ '[[:cntrl:]]'
        OR pg_catalog.octet_length(object_key) NOT BETWEEN 1 AND 128
    ) THEN
      RAISE EXCEPTION 'non-canonical T2 object key' USING ERRCODE = '22023';
    END IF;
    SELECT '{' || coalesce(pg_catalog.string_agg(
      pg_catalog.to_json(entry.key)::text || ':' ||
      public."pos_manual_canonical_json_impl_v1"(entry.value, p_depth + 1),
      ',' ORDER BY pg_catalog.convert_to(entry.key, 'UTF8')
    ), '') || '}'
    INTO result
    FROM pg_catalog.jsonb_each(p_value) AS entry(key, value);
    RETURN result;
  ELSIF value_type = 'array' THEN
    SELECT '[' || coalesce(pg_catalog.string_agg(
      public."pos_manual_canonical_json_impl_v1"(entry.value, p_depth + 1),
      ',' ORDER BY entry.ordinality
    ), '') || ']'
    INTO result
    FROM pg_catalog.jsonb_array_elements(p_value) WITH ORDINALITY AS entry(value, ordinality);
    RETURN result;
  ELSIF value_type = 'string' THEN
    scalar_text := p_value #>> '{}';
    IF scalar_text IS DISTINCT FROM normalize(scalar_text, NFC)
      OR scalar_text ~ '[[:cntrl:]]'
      OR pg_catalog.octet_length(scalar_text) > 65536 THEN
      RAISE EXCEPTION 'non-canonical T2 string' USING ERRCODE = '22023';
    END IF;
    RETURN pg_catalog.to_json(scalar_text)::text;
  ELSIF value_type = 'number' THEN
    scalar_text := p_value #>> '{}';
    IF scalar_text !~ '^-?(0|[1-9][0-9]*)$'
      OR scalar_text::numeric < -9007199254740991
      OR scalar_text::numeric > 9007199254740991 THEN
      RAISE EXCEPTION 'T2 canonical JSON accepts safe integers only' USING ERRCODE = '22023';
    END IF;
    RETURN scalar_text;
  ELSIF value_type = 'boolean' THEN
    RETURN CASE WHEN p_value = 'true'::jsonb THEN 'true' ELSE 'false' END;
  ELSIF value_type = 'null' THEN
    RETURN 'null';
  END IF;
  RAISE EXCEPTION 'unsupported T2 JSON type' USING ERRCODE = '22023';
END
$function$;

CREATE FUNCTION public."pos_manual_canonical_json_v1"(p_value jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  canonical text;
BEGIN
  canonical := public."pos_manual_canonical_json_impl_v1"(p_value, 0);
  IF pg_catalog.octet_length(canonical) > 65536 THEN
    RAISE EXCEPTION 'T2 canonical JSON exceeds size limit' USING ERRCODE = '22023';
  END IF;
  RETURN canonical;
END
$function$;

CREATE FUNCTION public."pos_manual_hash_canonical_json_v1"(
  p_domain text,
  p_value jsonb
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  canonical text;
BEGIN
  IF p_domain NOT IN (
    't2-snapshot-component-v1', 't2-snapshot-v1', 't2-manifest-v1',
    't2-effect-v1', 't2-profile-v1'
  ) THEN
    RAISE EXCEPTION 'unsupported T2 hash domain' USING ERRCODE = '22023';
  END IF;
  RETURN pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(p_domain, 'UTF8') || pg_catalog.decode('00', 'hex') ||
      pg_catalog.convert_to(public."pos_manual_canonical_json_v1"(p_value), 'UTF8')
    ),
    'hex'
  );
END
$function$;

CREATE FUNCTION public."pos_manual_utc_micros_v1"(p_value timestamptz)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT pg_catalog.to_char(p_value AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
$function$;

CREATE FUNCTION public."pos_manual_t2_dlp_walk_impl_v1"(
  p_document_kind text, p_value jsonb, p_depth integer
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  allowed_keys text[];
  entry record;
BEGIN
  IF p_depth > 32 THEN RETURN false; END IF;
  allowed_keys := CASE p_document_kind
    WHEN 'operational_actor' THEN ARRAY['schemaVersion','branchId','registerId','sessionId','terminalId','actorProfileId','actorUserId','branchGrantId','registerGrantId']
    WHEN 'case_evidence' THEN ARRAY['schemaVersion','caseId','caseVersion','observationId','evidenceHash','provider','method','amountCents','currency','referenceLastFour']
    WHEN 'draft_quote_slot' THEN ARRAY['schemaVersion','draftId','draftRevision','draftRequestHash','quoteHash','planId','planVersion','paymentIndex','slot','method','amountCents','installments','proofKind','provider','connectorId','connectorRevision','credentialRef','credentialRevision']
    WHEN 'customer_sale_payment' THEN ARRAY['schemaVersion','customerOpaqueId','eligibilityHash','sale','payment','plannedSaleId','saleNumber','occurredAt','saleIdempotencyKey','saleRequestHash','method','amountCents','currency','installments','provider']
    WHEN 'catalog_bom_tracking' THEN ARRAY['schemaVersion','products','variations','kits','bom','tracking','id','version','productId','variationId','kitId','componentId','quantityMicros','unit','lotId','serialId','expiry','hash']
    WHEN 'inventory_promotion' THEN ARRAY['schemaVersion','inventoryReservations','lotReservations','promotionReservations','id','scopeKey','productId','variationId','warehouseId','lotId','quantityMicros','promotionId','couponId','policyHash','expiresAt']
    WHEN 'fiscal' THEN ARRAY['schemaVersion','mode','profileId','profileVersion','policyHash','envelopeLocator','envelopeVersion','envelopeHash','expected','documentModel','environment','series','amountCents','currency','disposition']
    WHEN 'accounting' THEN ARRAY['schemaVersion','period','policyId','policyVersion','policyHash','mappings','postings','periodId','periodVersion','mappingId','mappingHash','accountId','costCenterId','direction','amountCents','currency','entryKey']
    WHEN 'webhooks' THEN ARRAY['schemaVersion','endpoints','payloads','endpointId','endpointVersion','topic','apiVersion','configHash','payloadHash','eventKind']
    WHEN 'manifest' THEN ARRAY['schemaVersion','entries','manifestHash','effectKind','effectKey','expectedHash','expectedCardinality','required']
    ELSE NULL
  END;
  IF allowed_keys IS NULL OR pg_catalog.pg_column_size(p_value) > 65536 THEN RETURN false; END IF;
  IF pg_catalog.jsonb_typeof(p_value) = 'object' THEN
    FOR entry IN SELECT key, value FROM pg_catalog.jsonb_each(p_value) LOOP
      IF NOT (entry.key = ANY (allowed_keys))
        OR NOT public."pos_manual_t2_dlp_walk_impl_v1"(p_document_kind, entry.value, p_depth + 1) THEN
        RETURN false;
      END IF;
    END LOOP;
  ELSIF pg_catalog.jsonb_typeof(p_value) = 'array' THEN
    FOR entry IN SELECT value FROM pg_catalog.jsonb_array_elements(p_value) LOOP
      IF NOT public."pos_manual_t2_dlp_walk_impl_v1"(p_document_kind, entry.value, p_depth + 1) THEN
        RETURN false;
      END IF;
    END LOOP;
  ELSIF pg_catalog.jsonb_typeof(p_value) = 'string' THEN
    PERFORM public."pos_manual_canonical_json_impl_v1"(p_value, p_depth);
  END IF;
  RETURN true;
END
$function$;

CREATE FUNCTION public."pos_manual_t2_json_dlp_safe_v1"(
  p_document_kind text, p_value jsonb
)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  canonical text;
BEGIN
  IF pg_catalog.jsonb_typeof(p_value) <> 'object'
    OR pg_catalog.pg_column_size(p_value) NOT BETWEEN 2 AND 65536
    OR NOT (p_value ? 'schemaVersion')
    OR p_value->'schemaVersion' <> '1'::jsonb THEN
    RETURN false;
  END IF;
  IF p_document_kind = 'case_evidence' AND (
    NOT (p_value ? 'referenceLastFour')
    OR pg_catalog.jsonb_typeof(p_value->'referenceLastFour') <> 'string'
    OR p_value->>'referenceLastFour' !~ '^[A-Za-z0-9*#._:-]{4}$'
  ) THEN
    RETURN false;
  END IF;
  canonical := public."pos_manual_canonical_json_v1"(p_value);
  -- Class A PAN is exclusively the shared 12..19 digit Luhn detector. Class B
  -- is a closed union of explicit identity/contact/address markers plus
  -- unambiguous value shapes; opaque homologated locators are intentionally
  -- absent from this union.
  IF public."pos_manual_identifier_contains_pan_321f"(canonical)
    OR canonical ~* '(cvv|cvc|pin|track[12]|vault[_ -]?token|open[_ -]?reference|authorization[_ -]?code|(^|[^a-z])nsu([^a-z]|$)|end[_ -]?to[_ -]?end|e2e)'
    OR canonical ~* '(^|[^A-Za-z0-9_])(customer[_ -]?(name|email|phone|address)|name|nome|e-?mail|telefone|phone|street|avenue|address|logradouro|postal[_ -]?code|cep|cpf|cnpj)([^A-Za-z0-9_]|$)'
    OR canonical ~* '[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}'
    OR canonical ~ '(^|[^0-9])([0-9]{3}[.]?[0-9]{3}[.]?[0-9]{3}-?[0-9]{2}|[0-9]{2}[.]?[0-9]{3}[.]?[0-9]{3}[/]?[0-9]{4}-?[0-9]{2})([^0-9]|$)'
    OR canonical ~* '(\+55[[:space:]]?)?[(][0-9]{2}[)][[:space:]]?[0-9]{4,5}-[0-9]{4}'
    OR canonical ~ '"[0-9]{5}-[0-9]{3}"'
    OR canonical ~* '"(rua|avenida|av[.]|travessa|street|avenue)[[:space:]][^"[:cntrl:]]{2,160}"'
  THEN
    RETURN false;
  END IF;
  RETURN public."pos_manual_t2_dlp_walk_impl_v1"(p_document_kind, p_value, 0);
END
$function$;

REVOKE ALL ON FUNCTION public."pos_manual_canonical_json_v1"(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_manual_canonical_json_impl_v1"(jsonb, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_manual_hash_canonical_json_v1"(text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_manual_utc_micros_v1"(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_manual_t2_json_dlp_safe_v1"(text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_manual_t2_dlp_walk_impl_v1"(text, jsonb, integer) FROM PUBLIC;

CREATE UNIQUE INDEX "pos_accounting_policies_id_branch_version_key"
  ON public."pos_accounting_policies"("id", "branch_id", "version");
CREATE UNIQUE INDEX "pos_accounting_policies_t2_identity_key"
  ON public."pos_accounting_policies"("id", "branch_id", "version", "mapping_hash");
CREATE UNIQUE INDEX "pos_fiscal_profiles_id_version_branch_key"
  ON public."pos_fiscal_profiles"("id", "version", "branch_id");
CREATE UNIQUE INDEX "pos_fiscal_profiles_t2_identity_key"
  ON public."pos_fiscal_profiles"("id", "version", "branch_id", "policy_digest");

CREATE TABLE public."pos_manual_finalization_profiles" (
  "id" uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  "branch_id" integer NOT NULL,
  "version" integer NOT NULL,
  "state" text NOT NULL DEFAULT 'draft',
  "cost_center_id" integer NOT NULL,
  "accounting_policy_id" text NOT NULL,
  "accounting_policy_version" integer NOT NULL,
  "accounting_policy_hash" text NOT NULL,
  "fiscal_mode" text NOT NULL,
  "fiscal_profile_id" text,
  "fiscal_profile_version" integer,
  "fiscal_policy_hash" text,
  "not_applicable_reason" text,
  "webhook_mode" text NOT NULL,
  "stock_mode" text NOT NULL DEFAULT 'reserve_exact',
  "reservation_ttl_seconds" integer NOT NULL,
  "config_hash" text NOT NULL,
  "created_by" text NOT NULL,
  "homologated_by" text,
  "homologated_at" timestamptz,
  "accounting_approved_by" text,
  "accounting_approved_at" timestamptz,
  "fiscal_approved_by" text,
  "fiscal_approved_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  "updated_at" timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  "activated_at" timestamptz,
  "retired_at" timestamptz,
  CONSTRAINT "pos_manual_fin_profiles_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_manual_fin_profiles_branch_version_key"
    UNIQUE ("branch_id", "version"),
  CONSTRAINT "pos_manual_fin_profiles_id_version_hash_key"
    UNIQUE ("id", "version", "config_hash"),
  CONSTRAINT "pos_manual_fin_profiles_branch_fkey"
    FOREIGN KEY ("branch_id") REFERENCES public."branches"("id") ON DELETE RESTRICT,
  CONSTRAINT "pos_manual_fin_profiles_cost_center_fkey"
    FOREIGN KEY ("cost_center_id") REFERENCES public."cost_centers"("id") ON DELETE RESTRICT,
  CONSTRAINT "pos_manual_fin_profiles_accounting_fkey"
    FOREIGN KEY ("accounting_policy_id", "branch_id", "accounting_policy_version", "accounting_policy_hash")
    REFERENCES public."pos_accounting_policies"("id", "branch_id", "version", "mapping_hash") ON DELETE RESTRICT,
  CONSTRAINT "pos_manual_fin_profiles_fiscal_fkey"
    FOREIGN KEY ("fiscal_profile_id", "fiscal_profile_version", "branch_id", "fiscal_policy_hash")
    REFERENCES public."pos_fiscal_profiles"("id", "version", "branch_id", "policy_digest") ON DELETE RESTRICT,
  CONSTRAINT "pos_manual_fin_profiles_shape_check" CHECK (
    "version" > 0
    AND "accounting_policy_version" > 0
    AND "state" IN ('draft', 'active', 'retired')
    AND "fiscal_mode" IN ('required_queue', 'not_applicable')
    AND "webhook_mode" IN ('required', 'disabled')
    AND "stock_mode" = 'reserve_exact'
    AND "reservation_ttl_seconds" BETWEEN 15 AND 300
    AND "accounting_policy_hash" ~ '^[0-9a-f]{64}$'
    AND ("fiscal_policy_hash" IS NULL OR "fiscal_policy_hash" ~ '^[0-9a-f]{64}$')
    AND "config_hash" ~ '^[0-9a-f]{64}$'
    AND "config_hash" = public."pos_manual_hash_canonical_json_v1"(
      't2-profile-v1', pg_catalog.jsonb_build_object(
        'schemaVersion', 1, 'branchId', "branch_id", 'version', "version",
        'costCenterId', "cost_center_id",
        'accountingPolicyId', "accounting_policy_id",
        'accountingPolicyVersion', "accounting_policy_version",
        'accountingPolicyHash', "accounting_policy_hash",
        'fiscalMode', "fiscal_mode", 'fiscalProfileId', "fiscal_profile_id",
        'fiscalProfileVersion', "fiscal_profile_version",
        'fiscalPolicyHash', "fiscal_policy_hash",
        'notApplicableReason', "not_applicable_reason",
        'webhookMode', "webhook_mode", 'stockMode', "stock_mode",
        'reservationTtlSeconds', "reservation_ttl_seconds"
      )
    )
    AND pg_catalog.octet_length("created_by") BETWEEN 1 AND 128
    AND ("homologated_by" IS NULL OR pg_catalog.octet_length("homologated_by") BETWEEN 1 AND 128)
    AND ("accounting_approved_by" IS NULL OR pg_catalog.octet_length("accounting_approved_by") BETWEEN 1 AND 128)
    AND ("fiscal_approved_by" IS NULL OR pg_catalog.octet_length("fiscal_approved_by") BETWEEN 1 AND 128)
  ),
  CONSTRAINT "pos_manual_fin_profiles_fiscal_mode_check" CHECK (
    ("fiscal_mode" = 'required_queue'
      AND "fiscal_profile_id" IS NOT NULL
      AND "fiscal_profile_version" IS NOT NULL
      AND "fiscal_policy_hash" IS NOT NULL
      AND "not_applicable_reason" IS NULL)
    OR
    ("fiscal_mode" = 'not_applicable'
      AND "fiscal_profile_id" IS NULL
      AND "fiscal_profile_version" IS NULL
      AND "fiscal_policy_hash" IS NOT NULL
      AND pg_catalog.octet_length("not_applicable_reason") BETWEEN 1 AND 128)
  ),
  CONSTRAINT "pos_manual_fin_profiles_lifecycle_check" CHECK (
    ("state" = 'draft' AND "activated_at" IS NULL AND "retired_at" IS NULL)
    OR
    ("state" = 'active' AND "activated_at" IS NOT NULL AND "retired_at" IS NULL
      AND "homologated_by" IS NOT NULL
      AND "homologated_at" IS NOT NULL
      AND "accounting_approved_by" IS NOT NULL
      AND "accounting_approved_at" IS NOT NULL
      AND "fiscal_approved_by" IS NOT NULL
      AND "fiscal_approved_at" IS NOT NULL
      AND "homologated_by" <> "accounting_approved_by"
      AND "homologated_by" <> "fiscal_approved_by"
      AND "accounting_approved_by" <> "fiscal_approved_by")
    OR
    ("state" = 'retired' AND "activated_at" IS NOT NULL AND "retired_at" IS NOT NULL
      AND "homologated_by" IS NOT NULL AND "homologated_at" IS NOT NULL
      AND "accounting_approved_by" IS NOT NULL AND "accounting_approved_at" IS NOT NULL
      AND "fiscal_approved_by" IS NOT NULL AND "fiscal_approved_at" IS NOT NULL
      AND "homologated_by" <> "accounting_approved_by"
      AND "homologated_by" <> "fiscal_approved_by"
      AND "accounting_approved_by" <> "fiscal_approved_by")
  )
);

CREATE UNIQUE INDEX "pos_manual_fin_profiles_one_active_idx"
  ON public."pos_manual_finalization_profiles"("branch_id")
  WHERE "state" = 'active';

CREATE FUNCTION public."guard_pos_manual_t2_profile_inert"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'T2-00 profile writers are not installed' USING ERRCODE = '0A000';
END
$function$;
CREATE TRIGGER "pos_manual_fin_profiles_inert_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON public."pos_manual_finalization_profiles"
  FOR EACH ROW EXECUTE FUNCTION public."guard_pos_manual_t2_profile_inert"();
REVOKE ALL ON FUNCTION public."guard_pos_manual_t2_profile_inert"() FROM PUBLIC;

ALTER TABLE public."pos_manual_payment_reconciliation_gates"
  ADD COLUMN "finalization_profile_id" uuid,
  ADD COLUMN "finalization_profile_version" integer,
  ADD COLUMN "finalization_profile_hash" text,
  ADD CONSTRAINT "pos_manual_gate_fin_profile_fkey"
    FOREIGN KEY ("finalization_profile_id", "finalization_profile_version", "finalization_profile_hash")
    REFERENCES public."pos_manual_finalization_profiles"("id", "version", "config_hash")
    ON DELETE RESTRICT,
  ADD CONSTRAINT "pos_manual_gate_fin_profile_shape_check" CHECK (
    (("finalization_profile_id" IS NULL)
      = ("finalization_profile_version" IS NULL))
    AND (("finalization_profile_id" IS NULL)
      = ("finalization_profile_hash" IS NULL))
    AND ("finalization_profile_version" IS NULL OR "finalization_profile_version" > 0)
    AND ("finalization_profile_hash" IS NULL OR "finalization_profile_hash" ~ '^[0-9a-f]{64}$')
    AND ("enabled" = false OR "finalization_profile_id" IS NOT NULL)
  );

ALTER TABLE public."pos_manual_payment_applications"
  RENAME COLUMN "write_txid" TO "reserve_txid";

CREATE UNIQUE INDEX "pos_manual_observations_case_id_id_key"
  ON public."pos_manual_payment_observations"("case_id", "id");

ALTER TABLE public."pos_manual_payment_applications"
  DROP CONSTRAINT "pos_manual_payment_applications_state_check",
  ADD COLUMN "version" integer NOT NULL DEFAULT 0,
  ADD COLUMN "case_version_before_reserve" integer NOT NULL,
  ADD COLUMN "case_version_after_reserve" integer NOT NULL,
  ADD COLUMN "confirmed_observation_id" bigint NOT NULL,
  ADD COLUMN "confirmation_evidence_hash" text NOT NULL,
  ADD COLUMN "reserved_by_user_id" text NOT NULL,
  ADD COLUMN "reservation_expires_at" timestamptz NOT NULL,
  ADD COLUMN "snapshot_hash" text NOT NULL,
  ADD COLUMN "manifest_hash" text NOT NULL,
  ADD COLUMN "finalization_profile_id" uuid NOT NULL,
  ADD COLUMN "finalization_profile_version" integer NOT NULL,
  ADD COLUMN "finalization_profile_hash" text NOT NULL,
  ADD COLUMN "claim_token_hash" text,
  ADD COLUMN "claim_expires_at" timestamptz,
  ADD COLUMN "fencing_token" bigint NOT NULL DEFAULT 0,
  ADD COLUMN "claimed_by_hash" text,
  ADD COLUMN "claimed_at" timestamptz,
  ADD COLUMN "apply_idempotency_key" text,
  ADD COLUMN "apply_request_hash" text,
  ADD COLUMN "apply_txid" numeric(20,0),
  ADD COLUMN "planned_sale_id" integer NOT NULL,
  ADD COLUMN "planned_sale_number" text NOT NULL,
  ADD COLUMN "planned_sale_occurred_at" timestamptz NOT NULL,
  ADD COLUMN "failure_class" text,
  ADD COLUMN "failure_at" timestamptz,
  ADD CONSTRAINT "pos_manual_apps_state_check"
    CHECK ("state" IN ('pending', 'claimed', 'applied', 'blocked')),
  ADD CONSTRAINT "pos_manual_apps_versions_check" CHECK (
    "version" >= 0
    AND "case_version_before_reserve" >= 0
    AND "case_version_after_reserve" = "case_version_before_reserve" + 1
    AND "fencing_token" >= 0
  ),
  ADD CONSTRAINT "pos_manual_apps_hashes_check" CHECK (
    "quote_hash" ~ '^[0-9a-f]{64}$'
    AND "sale_request_hash" ~ '^[0-9a-f]{64}$'
    AND "request_hash" ~ '^[0-9a-f]{64}$'
    AND "confirmation_evidence_hash" ~ '^[0-9a-f]{64}$'
    AND "snapshot_hash" ~ '^[0-9a-f]{64}$'
    AND "manifest_hash" ~ '^[0-9a-f]{64}$'
    AND "finalization_profile_hash" ~ '^[0-9a-f]{64}$'
    AND ("claim_token_hash" IS NULL OR "claim_token_hash" ~ '^[0-9a-f]{64}$')
    AND ("claimed_by_hash" IS NULL OR "claimed_by_hash" ~ '^[0-9a-f]{64}$')
    AND ("apply_request_hash" IS NULL OR "apply_request_hash" ~ '^[0-9a-f]{64}$')
  ),
  ADD CONSTRAINT "pos_manual_apps_identity_shape_check" CHECK (
    pg_catalog.octet_length("reserved_by_user_id") BETWEEN 1 AND 128
    AND pg_catalog.octet_length("planned_sale_number") BETWEEN 1 AND 128
    AND "reservation_expires_at" BETWEEN
      "reserved_at" + interval '15 seconds' AND "reserved_at" + interval '300 seconds'
    AND "planned_sale_occurred_at" >= "reserved_at"
    AND ("claim_expires_at" IS NULL OR
      "claim_expires_at" <= "reservation_expires_at" - interval '2 seconds')
  ),
  ADD CONSTRAINT "pos_manual_apps_claim_shape_check" CHECK (
    ("state" NOT IN ('claimed', 'applied') OR
      ("claim_token_hash" IS NOT NULL
        AND "claim_expires_at" IS NOT NULL
        AND "claimed_by_hash" IS NOT NULL
        AND "claimed_at" IS NOT NULL
        AND "fencing_token" > 0))
    AND ("state" <> 'pending' OR
      ("claim_token_hash" IS NULL
        AND "claim_expires_at" IS NULL
        AND "claimed_by_hash" IS NULL
        AND "claimed_at" IS NULL
        AND "fencing_token" = 0))
    AND ("state" <> 'blocked' OR
      (("claim_token_hash" IS NULL AND "claim_expires_at" IS NULL
        AND "claimed_by_hash" IS NULL AND "claimed_at" IS NULL
        AND "fencing_token" = 0)
      OR
       ("claim_token_hash" IS NOT NULL AND "claim_expires_at" IS NOT NULL
        AND "claimed_by_hash" IS NOT NULL AND "claimed_at" IS NOT NULL
        AND "fencing_token" > 0)))
  ),
  ADD CONSTRAINT "pos_manual_apps_apply_shape_check" CHECK (
    (("state" = 'applied')
      = ("sale_id" IS NOT NULL
        AND "sale_payment_id" IS NOT NULL
        AND "apply_idempotency_key" IS NOT NULL
        AND "apply_request_hash" IS NOT NULL
        AND "apply_txid" IS NOT NULL
        AND "applied_at" IS NOT NULL))
    AND ("state" = 'applied' OR
      ("sale_id" IS NULL AND "sale_payment_id" IS NULL
        AND "apply_idempotency_key" IS NULL AND "apply_request_hash" IS NULL
        AND "apply_txid" IS NULL AND "applied_at" IS NULL))
    AND ("sale_id" IS NULL OR "sale_id" = "planned_sale_id")
  ),
  ADD CONSTRAINT "pos_manual_apps_block_shape_check" CHECK (
    (("state" = 'blocked') = ("blocked_at" IS NOT NULL
      AND "blocked_code" IS NOT NULL AND "failure_at" IS NOT NULL
      AND "failure_class" IN ('boundary_changed', 'reservation_expired')))
    AND ("state" = 'blocked' OR
      ("blocked_at" IS NULL AND "blocked_code" IS NULL
        AND (("failure_at" IS NULL AND "failure_class" IS NULL)
          OR ("state" = 'pending' AND "failure_at" IS NOT NULL
            AND "failure_class" = 'retryable_internal'))))
  ),
  ADD CONSTRAINT "pos_manual_apps_observation_fkey"
    FOREIGN KEY ("case_id", "confirmed_observation_id")
    REFERENCES public."pos_manual_payment_observations"("case_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "pos_manual_apps_fin_profile_fkey"
    FOREIGN KEY ("finalization_profile_id", "finalization_profile_version", "finalization_profile_hash")
    REFERENCES public."pos_manual_finalization_profiles"("id", "version", "config_hash")
    ON DELETE RESTRICT;

CREATE UNIQUE INDEX "pos_manual_apps_planned_sale_key"
  ON public."pos_manual_payment_applications"("planned_sale_id");
CREATE UNIQUE INDEX "pos_manual_apps_planned_number_key"
  ON public."pos_manual_payment_applications"("planned_sale_number");
CREATE UNIQUE INDEX "pos_manual_apps_sale_id_key"
  ON public."pos_manual_payment_applications"("sale_id") WHERE "sale_id" IS NOT NULL;
CREATE UNIQUE INDEX "pos_manual_apps_sale_idempotency_key"
  ON public."pos_manual_payment_applications"("sale_idempotency_key");
CREATE UNIQUE INDEX "pos_manual_apps_confirmed_observation_key"
  ON public."pos_manual_payment_applications"("confirmed_observation_id");
CREATE UNIQUE INDEX "pos_manual_apps_apply_idem_key"
  ON public."pos_manual_payment_applications"("apply_idempotency_key")
  WHERE "apply_idempotency_key" IS NOT NULL;

CREATE TABLE public."pos_manual_application_snapshots" (
  "application_id" uuid NOT NULL,
  "schema_version" integer NOT NULL DEFAULT 1,
  "operational_actor" jsonb NOT NULL,
  "case_evidence" jsonb NOT NULL,
  "draft_quote_slot" jsonb NOT NULL,
  "customer_sale_payment" jsonb NOT NULL,
  "catalog_bom_tracking" jsonb NOT NULL,
  "inventory_promotion" jsonb NOT NULL,
  "fiscal" jsonb NOT NULL,
  "accounting" jsonb NOT NULL,
  "webhooks" jsonb NOT NULL,
  "manifest" jsonb NOT NULL,
  "operational_actor_hash" text NOT NULL,
  "case_evidence_hash" text NOT NULL,
  "draft_quote_slot_hash" text NOT NULL,
  "customer_sale_payment_hash" text NOT NULL,
  "catalog_bom_tracking_hash" text NOT NULL,
  "inventory_promotion_hash" text NOT NULL,
  "fiscal_hash" text NOT NULL,
  "accounting_hash" text NOT NULL,
  "webhooks_hash" text NOT NULL,
  "manifest_hash" text NOT NULL,
  "snapshot_hash" text NOT NULL,
  "reserve_txid" numeric(20,0) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT "pos_manual_app_snapshots_pkey" PRIMARY KEY ("application_id"),
  CONSTRAINT "pos_manual_app_snapshots_identity_key"
    UNIQUE ("application_id", "snapshot_hash", "manifest_hash"),
  CONSTRAINT "pos_manual_app_snapshots_application_fkey"
    FOREIGN KEY ("application_id") REFERENCES public."pos_manual_payment_applications"("id")
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "pos_manual_app_snapshots_json_check" CHECK (
    "schema_version" = 1
    AND public."pos_manual_t2_json_dlp_safe_v1"('operational_actor', "operational_actor")
    AND public."pos_manual_t2_json_dlp_safe_v1"('case_evidence', "case_evidence")
    AND public."pos_manual_t2_json_dlp_safe_v1"('draft_quote_slot', "draft_quote_slot")
    AND public."pos_manual_t2_json_dlp_safe_v1"('customer_sale_payment', "customer_sale_payment")
    AND public."pos_manual_t2_json_dlp_safe_v1"('catalog_bom_tracking', "catalog_bom_tracking")
    AND public."pos_manual_t2_json_dlp_safe_v1"('inventory_promotion', "inventory_promotion")
    AND public."pos_manual_t2_json_dlp_safe_v1"('fiscal', "fiscal")
    AND public."pos_manual_t2_json_dlp_safe_v1"('accounting', "accounting")
    AND public."pos_manual_t2_json_dlp_safe_v1"('webhooks', "webhooks")
    AND public."pos_manual_t2_json_dlp_safe_v1"('manifest', "manifest")
  ),
  CONSTRAINT "pos_manual_app_snapshots_hash_check" CHECK (
    "operational_actor_hash" = public."pos_manual_hash_canonical_json_v1"('t2-snapshot-component-v1', "operational_actor")
    AND "case_evidence_hash" = public."pos_manual_hash_canonical_json_v1"('t2-snapshot-component-v1', "case_evidence")
    AND "draft_quote_slot_hash" = public."pos_manual_hash_canonical_json_v1"('t2-snapshot-component-v1', "draft_quote_slot")
    AND "customer_sale_payment_hash" = public."pos_manual_hash_canonical_json_v1"('t2-snapshot-component-v1', "customer_sale_payment")
    AND "catalog_bom_tracking_hash" = public."pos_manual_hash_canonical_json_v1"('t2-snapshot-component-v1', "catalog_bom_tracking")
    AND "inventory_promotion_hash" = public."pos_manual_hash_canonical_json_v1"('t2-snapshot-component-v1', "inventory_promotion")
    AND "fiscal_hash" = public."pos_manual_hash_canonical_json_v1"('t2-snapshot-component-v1', "fiscal")
    AND "accounting_hash" = public."pos_manual_hash_canonical_json_v1"('t2-snapshot-component-v1', "accounting")
    AND "webhooks_hash" = public."pos_manual_hash_canonical_json_v1"('t2-snapshot-component-v1', "webhooks")
    AND "manifest_hash" = public."pos_manual_hash_canonical_json_v1"('t2-manifest-v1', "manifest")
    AND "snapshot_hash" = public."pos_manual_hash_canonical_json_v1"(
      't2-snapshot-v1',
      pg_catalog.jsonb_build_object(
        'schemaVersion', 1,
        'operationalActorHash', "operational_actor_hash",
        'caseEvidenceHash', "case_evidence_hash",
        'draftQuoteSlotHash', "draft_quote_slot_hash",
        'customerSalePaymentHash', "customer_sale_payment_hash",
        'catalogBomTrackingHash', "catalog_bom_tracking_hash",
        'inventoryPromotionHash', "inventory_promotion_hash",
        'fiscalHash', "fiscal_hash", 'accountingHash', "accounting_hash",
        'webhooksHash', "webhooks_hash", 'manifestHash', "manifest_hash"
      )
    )
  )
);

ALTER TABLE public."pos_manual_payment_applications"
  ADD CONSTRAINT "pos_manual_apps_snapshot_fkey"
  FOREIGN KEY ("id", "snapshot_hash", "manifest_hash")
  REFERENCES public."pos_manual_application_snapshots"("application_id", "snapshot_hash", "manifest_hash")
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE public."pos_manual_application_manifest_entries" (
  "id" bigserial NOT NULL,
  "application_id" uuid NOT NULL,
  "effect_kind" text NOT NULL,
  "effect_key" text NOT NULL,
  "expected_hash" text NOT NULL,
  "expected_cardinality" integer NOT NULL,
  "required" boolean NOT NULL,
  "reserve_txid" numeric(20,0) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT "pos_manual_app_manifest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_manual_app_manifest_application_fkey"
    FOREIGN KEY ("application_id") REFERENCES public."pos_manual_payment_applications"("id") ON DELETE RESTRICT,
  CONSTRAINT "pos_manual_app_manifest_identity_key"
    UNIQUE ("application_id", "effect_kind", "effect_key"),
  CONSTRAINT "pos_manual_app_manifest_id_application_key"
    UNIQUE ("id", "application_id"),
  CONSTRAINT "pos_manual_app_manifest_shape_check" CHECK (
    "effect_kind" IN (
      'sale', 'sale_item', 'sale_payment', 'plan_consume', 'draft_convert',
      'promotion_redemption', 'kit_component', 'tracked_lot_movement',
      'stock_movement', 'warehouse_ledger', 'value_account',
      'value_ledger_entry', 'value_accrual', 'fiscal_document',
      'fiscal_attempt', 'fiscal_outbox', 'accounting_journal',
      'accounting_posting', 'accounting_export_outbox', 'sale_event',
      'audit_event', 'webhook_delivery'
    )
    AND pg_catalog.octet_length("effect_key") BETWEEN 1 AND 256
    AND "expected_hash" ~ '^[0-9a-f]{64}$'
    AND "expected_cardinality" IN (0, 1)
    AND "required" = ("expected_cardinality" = 1)
  )
);

CREATE TABLE public."pos_manual_application_effects" (
  "id" bigserial NOT NULL,
  "application_id" uuid NOT NULL,
  "manifest_entry_id" bigint NOT NULL,
  "effect_kind" text NOT NULL,
  "effect_key" text NOT NULL,
  "entity_type" text NOT NULL,
  "entity_id" text NOT NULL,
  "actual_hash" text NOT NULL,
  "write_txid" numeric(20,0) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT "pos_manual_app_effects_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_manual_app_effects_application_fkey"
    FOREIGN KEY ("application_id") REFERENCES public."pos_manual_payment_applications"("id") ON DELETE RESTRICT,
  CONSTRAINT "pos_manual_app_effects_manifest_fkey"
    FOREIGN KEY ("manifest_entry_id", "application_id")
    REFERENCES public."pos_manual_application_manifest_entries"("id", "application_id") ON DELETE RESTRICT,
  CONSTRAINT "pos_manual_app_effects_manifest_entry_key"
    UNIQUE ("manifest_entry_id"),
  CONSTRAINT "pos_manual_app_effects_identity_key"
    UNIQUE ("application_id", "effect_kind", "effect_key"),
  CONSTRAINT "pos_manual_app_effects_shape_check" CHECK (
    "effect_kind" IN (
      'sale', 'sale_item', 'sale_payment', 'plan_consume', 'draft_convert',
      'promotion_redemption', 'kit_component', 'tracked_lot_movement',
      'stock_movement', 'warehouse_ledger', 'value_account',
      'value_ledger_entry', 'value_accrual', 'fiscal_document',
      'fiscal_attempt', 'fiscal_outbox', 'accounting_journal',
      'accounting_posting', 'accounting_export_outbox', 'sale_event',
      'audit_event', 'webhook_delivery'
    )
    AND pg_catalog.octet_length("effect_key") BETWEEN 1 AND 256
    AND pg_catalog.octet_length("entity_type") BETWEEN 1 AND 64
    AND pg_catalog.octet_length("entity_id") BETWEEN 1 AND 256
    AND "actual_hash" ~ '^[0-9a-f]{64}$'
  )
);

CREATE TRIGGER "pos_manual_app_snapshots_append_only"
  BEFORE UPDATE OR DELETE ON public."pos_manual_application_snapshots"
  FOR EACH ROW EXECUTE FUNCTION public."protect_pos_manual_append_only"();
CREATE TRIGGER "pos_manual_app_manifest_append_only"
  BEFORE UPDATE OR DELETE ON public."pos_manual_application_manifest_entries"
  FOR EACH ROW EXECUTE FUNCTION public."protect_pos_manual_append_only"();
CREATE TRIGGER "pos_manual_app_effects_append_only"
  BEFORE UPDATE OR DELETE ON public."pos_manual_application_effects"
  FOR EACH ROW EXECUTE FUNCTION public."protect_pos_manual_append_only"();

CREATE FUNCTION public."guard_pos_manual_t2_application_inert"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'T2-00 application writers are not installed'
    USING ERRCODE = '0A000';
END
$function$;

CREATE TRIGGER "pos_manual_t2_application_inert_guard"
  BEFORE INSERT OR UPDATE OR DELETE
  ON public."pos_manual_payment_applications"
  FOR EACH ROW EXECUTE FUNCTION public."guard_pos_manual_t2_application_inert"();

ALTER TABLE public."pos_manual_payment_applications"
  DROP CONSTRAINT "pos_manual_payment_applications_sale_id_fkey",
  DROP CONSTRAINT "pos_manual_payment_applications_sale_payment_id_fkey",
  ADD CONSTRAINT "pos_manual_apps_sale_fkey" FOREIGN KEY ("sale_id")
    REFERENCES public."sales"("id") ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT "pos_manual_apps_sale_payment_fkey" FOREIGN KEY ("sale_payment_id")
    REFERENCES public."pos_sale_payments"("id") ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public."sales"
  ADD COLUMN "manual_payment_application_id" uuid,
  ADD CONSTRAINT "sales_manual_payment_application_fkey"
    FOREIGN KEY ("manual_payment_application_id")
    REFERENCES public."pos_manual_payment_applications"("id") ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT "sales_manual_payment_source_check" CHECK (
    ("manual_payment_application_id" IS NULL)
    OR ("source_type" = 'manual_payment_application'
      AND "source_id" = "manual_payment_application_id"::text
      AND "source_creation_txid" IS NOT NULL)
  );
CREATE UNIQUE INDEX "sales_manual_payment_application_key"
  ON public."sales"("manual_payment_application_id")
  WHERE "manual_payment_application_id" IS NOT NULL;

ALTER TABLE public."pos_sale_payments"
  ADD COLUMN "manual_payment_case_id" uuid,
  ADD CONSTRAINT "pos_sale_payments_manual_case_fkey"
    FOREIGN KEY ("manual_payment_case_id")
    REFERENCES public."pos_manual_payment_cases"("id") ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT "pos_sale_payments_manual_branch_check" CHECK (
    "manual_payment_case_id" IS NULL OR (
      "type" = 'payment' AND "status" = 'manual_confirmed'
      AND "payment_intent_id" IS NULL AND "compensation_id" IS NULL
      AND "value_reservation_id" IS NULL AND "value_capture_entry_id" IS NULL
      AND "value_amount_units" IS NULL AND "original_payment_id" IS NULL
      AND "transaction_id" IS NULL AND "end_to_end_id" IS NULL
      AND "nsu" IS NULL AND "authorization_code" IS NULL
      AND "card_brand" IS NULL AND "card_last_four" IS NULL
      AND "tendered_cents" = "amount_cents" AND "change_cents" = 0
      AND "payment_plan_id" IS NOT NULL AND "payment_index" = 0
      AND "provider" IS NOT NULL
      AND pg_catalog.jsonb_typeof("metadata") = 'object'
      AND "metadata" ?& ARRAY['evidenceHash','manualPaymentCaseId','observationId','provider','referenceLastFour','schemaVersion']
      AND ("metadata" - ARRAY['evidenceHash','manualPaymentCaseId','observationId','provider','referenceLastFour','schemaVersion']) = '{}'::jsonb
      AND "metadata"->'schemaVersion' = '1'::jsonb
      AND "metadata"->>'manualPaymentCaseId' = "manual_payment_case_id"::text
      AND "metadata"->>'evidenceHash' ~ '^[0-9a-f]{64}$'
      AND "metadata"->'observationId' IS NOT NULL
      AND pg_catalog.jsonb_typeof("metadata"->'observationId') = 'number'
      AND "metadata"->>'observationId' ~ '^[1-9][0-9]*$'
      AND "metadata"->>'provider' = "provider"
      AND "provider" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      AND "metadata"->>'referenceLastFour' ~ '^[A-Za-z0-9*#._:-]{4}$'
    )
  );
CREATE UNIQUE INDEX "pos_sale_payments_manual_case_key"
  ON public."pos_sale_payments"("manual_payment_case_id")
  WHERE "manual_payment_case_id" IS NOT NULL;

CREATE FUNCTION public."guard_pos_manual_t2_sale_link_inert"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF NEW."manual_payment_application_id" IS NOT NULL
    OR NEW."source_type" = 'manual_payment_application' THEN
    RAISE EXCEPTION 'T2-00 manual sale links are not writable'
      USING ERRCODE = '0A000';
  END IF;
  RETURN NEW;
END
$function$;

CREATE FUNCTION public."guard_pos_manual_t2_payment_link_inert"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF NEW."manual_payment_case_id" IS NOT NULL
    OR (NEW."metadata" IS NOT NULL AND NEW."metadata" ? 'manualPaymentCaseId') THEN
    RAISE EXCEPTION 'T2-00 manual payment links are not writable'
      USING ERRCODE = '0A000';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER "sales_manual_payment_inert_guard"
  BEFORE INSERT OR UPDATE OF "manual_payment_application_id", "source_type", "source_id", "source_creation_txid"
  ON public."sales"
  FOR EACH ROW EXECUTE FUNCTION public."guard_pos_manual_t2_sale_link_inert"();
CREATE TRIGGER "pos_sale_payments_manual_inert_guard"
  BEFORE INSERT OR UPDATE
  ON public."pos_sale_payments"
  FOR EACH ROW EXECUTE FUNCTION public."guard_pos_manual_t2_payment_link_inert"();

REVOKE ALL ON FUNCTION public."guard_pos_manual_t2_application_inert"() FROM PUBLIC;
REVOKE ALL ON FUNCTION public."guard_pos_manual_t2_sale_link_inert"() FROM PUBLIC;
REVOKE ALL ON FUNCTION public."guard_pos_manual_t2_payment_link_inert"() FROM PUBLIC;

REVOKE ALL ON TABLE public."pos_manual_finalization_profiles" FROM PUBLIC;
REVOKE ALL ON TABLE public."pos_manual_application_snapshots" FROM PUBLIC;
REVOKE ALL ON TABLE public."pos_manual_application_manifest_entries" FROM PUBLIC;
REVOKE ALL ON TABLE public."pos_manual_application_effects" FROM PUBLIC;
REVOKE ALL ON SEQUENCE public."pos_manual_application_manifest_entries_id_seq" FROM PUBLIC;
REVOKE ALL ON SEQUENCE public."pos_manual_application_effects_id_seq" FROM PUBLIC;

COMMIT;
