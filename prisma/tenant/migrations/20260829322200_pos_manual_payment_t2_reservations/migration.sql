BEGIN;

-- T2-02 reserve/reservations/release.  This migration deliberately leaves
-- every operational signature revoked.  Runtime grants are reconciled only
-- after the focused catalogue/ACL/concurrency gates have accepted this file.
DO $preflight$
DECLARE
  recorded_checksum text;
BEGIN
  IF pg_catalog.to_regprocedure('public.pos_manual_hash_canonical_json_v1(text,jsonb)') IS NULL
    OR pg_catalog.to_regprocedure('public.pos_manual_t2_open_write_root_v1(text,text,text,text,text,text,text,text[])') IS NULL
    OR pg_catalog.to_regprocedure('public.pos_manual_prepare_payment_plan_graph_write_v1(text,text,integer,text,text,text,jsonb,jsonb,jsonb)') IS NULL
  THEN
    RAISE EXCEPTION 'T2-02 requires the complete T2-01 catalogue'
      USING ERRCODE = '23514';
  END IF;

  IF pg_catalog.to_regclass('public._prisma_migrations') IS NOT NULL THEN
    SELECT migration."checksum"
      INTO recorded_checksum
      FROM public."_prisma_migrations" migration
     WHERE migration."migration_name" = '20260829322100_pos_manual_payment_t2_profile_lifecycle'
       AND migration."finished_at" IS NOT NULL
       AND migration."rolled_back_at" IS NULL;
    IF recorded_checksum IS DISTINCT FROM '4c239c899b6c7e498150ceee3c635c03eb1f432298994be7d12ac04896b5d388' THEN
      RAISE EXCEPTION 'T2-02 requires the accepted T2-01 checksum'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM public."pos_manual_payment_applications")
    OR EXISTS (SELECT 1 FROM public."pos_manual_payment_reconciliation_gates" WHERE "enabled")
    OR EXISTS (SELECT 1 FROM public."pos_manual_finalization_profiles" WHERE "state" = 'active')
    OR pg_catalog.to_regprocedure('public.pos_manual_reserve_application_v1(uuid,integer,integer,text,text,text)') IS NOT NULL
    OR pg_catalog.to_regprocedure('public.pos_manual_sweep_expired_applications_v1(text,integer,text,text)') IS NOT NULL
  THEN
    RAISE EXCEPTION 'T2-02 preflight requires an empty hard-off T2 database'
      USING ERRCODE = '23514';
  END IF;
END
$preflight$;

LOCK TABLE public."products" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public."product_variations" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public."pos_value_programs" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public."pos_accounting_periods" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public."pos_accounting_policy_mappings" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public."integration_webhook_endpoints" IN ACCESS EXCLUSIVE MODE;

ALTER TABLE public."pos_manual_t2_authorities"
  DROP CONSTRAINT "pos_manual_t2_authorities_shape_check",
  ADD CONSTRAINT "pos_manual_t2_authorities_shape_check" CHECK (
    "capability" IN ('profile_admin_issuer','profile_accounting_issuer','profile_fiscal_issuer','profile_homologator',
      'runtime','manual_callback','manual_worker','manual_vault_binder','manual_sweeper')
    AND "authority_hash" ~ '^[0-9a-f]{64}$'
  );

CREATE OR REPLACE FUNCTION public."pos_manual_t2_write_authority_capability_v1"(p_capability text)
RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
  IF p_capability LIKE 't2_reservation:sweep:%' THEN RETURN 'manual_sweeper'; END IF;
  IF p_capability LIKE 't2_reservation:reserve:%' THEN RETURN 'runtime'; END IF;
  IF p_capability LIKE 'legacy_manual:open_case:%' THEN RETURN 'manual_vault_binder'; END IF;
  IF p_capability LIKE 'legacy_manual:record_callback:%' THEN RETURN 'manual_callback'; END IF;
  IF p_capability LIKE 'legacy_manual:attest_query_response:%'
    OR p_capability LIKE 'legacy_manual:complete_delivery:%'
    OR p_capability LIKE 'legacy_manual:report_transport:%'
    OR p_capability LIKE 'legacy_manual:claim_queries:%' THEN RETURN 'manual_worker'; END IF;
  IF p_capability IN ('held_sale_items','payment_plan_graph:quote_lines','payment_plan_graph:slots',
      'payment_plan_graph:operation','payment_plan_graph:plan_transition','order_claim','order_claim:operation',
      'payment_artifact:intent','payment_artifact:manual_reference','payment_artifact:sale_payment') THEN RETURN 'runtime'; END IF;
  RAISE EXCEPTION 'unknown T2 write authority capability' USING ERRCODE='42501';
END
$function$;

-- Preserve the complete T2-01 write catalogue and add only the closed
-- same-transaction lifecycle producers used by reserve and sweep.  This is a
-- CREATE OR REPLACE so every pre-existing constraint/helper keeps the same
-- function OID and observes the expanded allowlist.
CREATE OR REPLACE FUNCTION public."pos_manual_t2_write_metadata_valid_v1"(
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
      OR (p_capability IN ('t2_reservation:reserve:case','t2_reservation:sweep:case')
        AND p_aggregate_kind='manual_case' AND p_trigger_identity='protect_pos_manual_case'
        AND p_action=CASE WHEN p_capability LIKE 't2_reservation:reserve:%' THEN 'reserve_application' ELSE 'sweep_expired_application' END
        AND p_dml_operation='UPDATE')
      OR (p_capability IN ('t2_reservation:reserve:operation','t2_reservation:sweep:operation')
        AND p_aggregate_kind='manual_case' AND p_trigger_identity='guard_pos_manual_operation'
        AND p_action=CASE WHEN p_capability LIKE 't2_reservation:reserve:%' THEN 'reserve_application' ELSE 'sweep_expired_application' END
        AND p_dml_operation='INSERT')
      OR (p_capability IN ('t2_reservation:reserve:state_event','t2_reservation:sweep:state_event')
        AND p_aggregate_kind='manual_case' AND p_trigger_identity='guard_pos_manual_state_event'
        AND p_action=CASE WHEN p_capability LIKE 't2_reservation:reserve:%' THEN 'reserve_application' ELSE 'sweep_expired_application' END
        AND p_dml_operation='INSERT')
    )
$function$;

-- The canonical byte stream is unchanged.  Only the document ceiling grows
-- from 64 KiB to the T2-02 bound of 4 MiB.
CREATE OR REPLACE FUNCTION public."pos_manual_canonical_json_v1"(p_value jsonb)
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
  IF pg_catalog.octet_length(canonical) > 4194304 THEN
    RAISE EXCEPTION 'T2 canonical JSON exceeds size limit' USING ERRCODE = '22023';
  END IF;
  RETURN canonical;
END
$function$;

CREATE OR REPLACE FUNCTION public."pos_manual_hash_canonical_json_v1"(
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
BEGIN
  IF p_domain NOT IN (
    't2-snapshot-component-v1','t2-snapshot-v1','t2-manifest-v1','t2-effect-v1','t2-profile-v1',
    't2-reserve-request-v1','t2-reserve-identity-v1','t2-reservation-id-v1',
    't2-reservation-event-id-v1','t2-stock-reservation-key-v1',
    't2-promotion-reservation-key-v1','t2-effect-key-v1','t2-sale-idempotency-v1',
    't2-sale-request-v1','t2-sale-payment-identity-v1','t2-sale-payment-idempotency-v1',
    't2-sweep-request-v1','t2-sweep-identity-v1','t2-sweep-receipt-id-v1',
    't2-sweeper-subject-v1','t2-sweep-result-v1','t2-promotion-policy-v1',
    't2-reservation-graph-v1','t2-release-result-v1','t2-customer-opaque-v1',
    't2-customer-eligibility-v1','t2-tracking-request-v1','t2-catalog-product-v1',
    't2-catalog-variation-v1','t2-value-program-v1','t2-value-account-identity-v1',
    't2-value-entry-key-v1','t2-value-ledger-request-v1','t2-accounting-period-v1',
    't2-accounting-mapping-v1','t2-accounting-journal-identity-v1',
    't2-accounting-journal-idempotency-v1','t2-accounting-journal-request-v1',
    't2-stock-multiset-v1','t2-promotion-multiset-v1','t2-stock-release-multiset-v1',
    't2-promotion-release-multiset-v1','t2-webhook-config-v1','t2-webhook-payload-v1',
    't2-fiscal-envelope-identity-v1','t2-fiscal-envelope-prepare-v1',
    't2-fiscal-envelope-binding-v1','t2-fiscal-document-identity-v1',
    't2-fiscal-document-idempotency-v1','t2-fiscal-document-request-v1',
    't2-fiscal-attempt-identity-v1','t2-fiscal-attempt-operation-v1',
    't2-fiscal-attempt-request-v1','t2-fiscal-provider-idempotency-v1',
    't2-fiscal-number-allocation-identity-v1','t2-webhook-event-identity-v1',
    't2-webhook-delivery-identity-v1','t2-boundary-operation-identity-v1',
    't2-catalog-boundary-request-v1','t2-value-program-boundary-request-v1',
    't2-accounting-period-put-request-v1','t2-accounting-period-boundary-request-v1','t2-webhook-boundary-request-v1'
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

CREATE FUNCTION public."pos_manual_uuid16_v1"(p_domain text, p_value jsonb)
RETURNS uuid
LANGUAGE plpgsql
IMMUTABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  digest bytea;
  hex text;
BEGIN
  -- Domain validation and canonicalization are delegated to the closed hash
  -- helper.  The version/variant bits are then applied byte-exactly.
  digest := pg_catalog.decode(public."pos_manual_hash_canonical_json_v1"(p_domain, p_value), 'hex');
  digest := pg_catalog.set_byte(digest, 6, (pg_catalog.get_byte(digest, 6) & 15) | 80);
  digest := pg_catalog.set_byte(digest, 8, (pg_catalog.get_byte(digest, 8) & 63) | 128);
  hex := pg_catalog.encode(pg_catalog.substring(digest, 1, 16), 'hex');
  RETURN (pg_catalog.substring(hex,1,8)||'-'||pg_catalog.substring(hex,9,4)||'-'||
          pg_catalog.substring(hex,13,4)||'-'||pg_catalog.substring(hex,17,4)||'-'||
          pg_catalog.substring(hex,21,12))::uuid;
END
$function$;

CREATE FUNCTION public."pos_manual_t2_json_array_objects_exact_v1"(
  p_value jsonb, p_keys text[], p_max integer
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT pg_catalog.jsonb_typeof(p_value) = 'array'
    AND pg_catalog.jsonb_array_length(p_value) <= p_max
    AND NOT EXISTS (
      SELECT 1
        FROM pg_catalog.jsonb_array_elements(p_value) item(value)
       WHERE NOT public."pos_manual_t2_json_keys_exact_v1"(item.value,p_keys)
    )
$function$;

-- Closed path validator for the ten T2 documents.  A field name admitted at
-- one path is not thereby admitted at any other path.
CREATE FUNCTION public."pos_manual_t2_document_shape_v1"(p_kind text,p jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  item jsonb;
BEGIN
  IF pg_catalog.jsonb_typeof(p)<>'object' OR p->'schemaVersion'<>'1'::jsonb THEN RETURN false; END IF;
  CASE p_kind
    WHEN 'operational_actor' THEN
      RETURN public."pos_manual_t2_json_keys_exact_v1"(p,ARRAY['actorProfileId','actorUserId','branchGrantId','branchId','branchTimezone','registerGrantId','registerId','schemaVersion','sessionId','terminalId']);
    WHEN 'case_evidence' THEN
      RETURN public."pos_manual_t2_json_keys_exact_v1"(p,ARRAY['amountCents','caseId','caseVersion','currency','evidenceHash','method','observationId','provider','referenceLastFour','schemaVersion'])
        AND pg_catalog.jsonb_typeof(p->'referenceLastFour')='string' AND p->>'referenceLastFour'~'^[A-Za-z0-9*#._:-]{4}$';
    WHEN 'draft_quote_slot' THEN
      RETURN public."pos_manual_t2_json_keys_exact_v1"(p,ARRAY['connectorId','connectorRevision','credentialRef','credentialRevision','draftId','draftRequestHash','draftRevision','planId','planVersion','quoteHash','quoteLines','schemaVersion','slot'])
        AND public."pos_manual_t2_json_keys_exact_v1"(p->'slot',ARRAY['amountCents','installments','method','paymentIndex','proofKind','provider'])
        AND public."pos_manual_t2_json_array_objects_exact_v1"(p->'quoteLines',ARRAY['baseDiscountCents','grossCents','heldSaleItemId','lineIndex','orderDiscountCents','productId','promotionDiscountCents','quantityMicros','surchargeCents','totalCents','unitPriceCents','variationId'],200);
    WHEN 'customer_sale_payment' THEN
      IF NOT public."pos_manual_t2_json_keys_exact_v1"(p,ARRAY['customerOpaqueId','eligibilityHash','payment','sale','saleItems','schemaVersion','value'])
        OR NOT public."pos_manual_t2_json_keys_exact_v1"(p->'sale',ARRAY['branchId','cashRegisterLegacyLabel','changeCents','currency','customerId','customerLegacyLabel','discountCents','draftId','idempotencyKey','occurredAt','operatorProfileId','paymentMethodLegacy','plannedSaleId','registerId','requestHash','saleNumber','sellerLegacyLabel','sessionId','sourceId','sourceType','status','subtotalCents','surchargeCents','terminalId','totalCents','warehouseId'])
        OR NOT public."pos_manual_t2_json_keys_exact_v1"(p->'payment',ARRAY['amountCents','changeCents','currency','evidenceHash','installments','method','observationId','paymentIdempotencyKey','paymentIndex','plannedPaymentId','provider','referenceLastFour','status','tenderedCents','type'])
        OR NOT public."pos_manual_t2_json_array_objects_exact_v1"(p->'saleItems',ARRAY['baseDiscountCents','grossCents','gtinSnapshot','lineIndex','orderDiscountCents','productId','productNameLabel','promotionDiscountCents','quantityMicros','skuSnapshot','surchargeCents','totalCents','unit','unitPriceCents','variationId'],200)
        OR NOT public."pos_manual_t2_json_keys_exact_v1"(p->'value',ARRAY['accounts','accruals','programs'])
        OR NOT public."pos_manual_t2_json_array_objects_exact_v1"(p->'value'->'programs',ARRAY['branchId','configHash','earnUnits','expiresAfterDays','kind','programId','revision','spendCents','status'],32)
        OR NOT public."pos_manual_t2_json_array_objects_exact_v1"(p->'value'->'accounts',ARRAY['accountId','accountVersion','balanceUnits','branchId','customerId','customerOpaqueId','exists','expiresAt','kind','planned','plannedAccountLabel','programId','reservedUnits','status','unit'],32)
        OR NOT public."pos_manual_t2_json_array_objects_exact_v1"(p->'value'->'accruals',ARRAY['accountId','amountUnits','direction','entryKey','expiresAt','ledger','programId'],32) THEN RETURN false; END IF;
      FOR item IN SELECT value FROM pg_catalog.jsonb_array_elements(p->'value'->'accruals') LOOP
        IF NOT public."pos_manual_t2_json_keys_exact_v1"(item->'ledger',ARRAY['accountId','actor','amountUnits','balanceAfterUnits','balanceBeforeUnits','balanceDeltaUnits','entryKey','metadata','operationKey','reason','referenceId','referenceType','requestHash','reservationId','reservedAfterUnits','reservedBeforeUnits','reservedDeltaUnits','reversalOfId','type']) THEN RETURN false; END IF;
      END LOOP;
      RETURN true;
    WHEN 'catalog_bom_tracking' THEN
      RETURN public."pos_manual_t2_json_keys_exact_v1"(p,ARRAY['bom','businessDate','products','schemaVersion','tracking','variations'])
        AND public."pos_manual_t2_json_array_objects_exact_v1"(p->'products',ARRAY['active','configHash','gtinSnapshot','manageStock','nameLabel','posRevision','productId','productType','skuSnapshot','status','unit'],400)
        AND public."pos_manual_t2_json_array_objects_exact_v1"(p->'variations',ARRAY['configHash','enabled','gtinSnapshot','manageStock','posRevision','productId','skuSnapshot','status','variationId'],400)
        AND public."pos_manual_t2_json_array_objects_exact_v1"(p->'bom',ARRAY['bomId','bomVersion','componentIndex','depth','productId','quantityMicros','rootLineIndex','scopeKey','unitQuantityMicros','variationId'],200)
        AND public."pos_manual_t2_json_array_objects_exact_v1"(p->'tracking',ARRAY['lotId','requestedLotCodeHash','requestedSerialHash','reservationKey','rootLineIndex','trackingKind'],400);
    WHEN 'inventory_promotion' THEN
      RETURN public."pos_manual_t2_json_keys_exact_v1"(p,ARRAY['inventoryReservations','promotionReservations','schemaVersion'])
        AND public."pos_manual_t2_json_array_objects_exact_v1"(p->'inventoryReservations',ARRAY['componentScopeKey','heldSaleItemId','lotId','lotReservedAfterMicros','lotReservedBeforeMicros','parentReservedAfterMicros','parentReservedBeforeMicros','productId','quantityMicros','quoteLineIndex','reservationId','reservationKey','stockMode','trackingKind','variationId','variationReservedAfterMicros','variationReservedBeforeMicros','warehouseId'],400)
        AND public."pos_manual_t2_json_array_objects_exact_v1"(p->'promotionReservations',ARRAY['couponId','couponLiveBefore','couponUsedBefore','customerLiveBefore','customerOpaqueId','customerUsedBefore','discountCents','expiresAt','globalLiveBefore','globalUsedBefore','policyHash','promotionId','reservationId','reservationKey'],1);
    WHEN 'fiscal' THEN
      RETURN public."pos_manual_t2_json_keys_exact_v1"(p,ARRAY['disposition','documentModel','envelopeBindingHash','envelopeHash','envelopeId','envelopeLocator','envelopePreparedHash','envelopeVersion','environment','expected','mode','number','numberingOwner','plannedSaleIdentityHash','policyHash','profileId','profileVersion','schemaVersion','series'])
        AND (p->'expected'='null'::jsonb OR public."pos_manual_t2_json_keys_exact_v1"(p->'expected',ARRAY['amountCents','currency','documentModel','environment','number','numberingOwner','plannedSaleId','plannedSaleNumber','plannedSaleOccurredAt','series']));
    WHEN 'accounting' THEN
      IF NOT public."pos_manual_t2_json_keys_exact_v1"(p,ARRAY['journal','mappings','period','postings','schemaVersion','source'])
        OR NOT public."pos_manual_t2_json_keys_exact_v1"(p->'period',ARRAY['endsOn','periodConfigHash','periodId','periodRevision','startsOn','status'])
        OR NOT public."pos_manual_t2_json_array_objects_exact_v1"(p->'mappings',ARRAY['accountCodeSnapshot','accountId','accountNameSnapshot','configHash','direction','entryKey','mappingId','sourceType'],4)
        OR NOT public."pos_manual_t2_json_array_objects_exact_v1"(p->'postings',ARRAY['accountCodeSnapshot','accountId','accountNameSnapshot','amountCents','amountDecimal','descriptionLabel','dimensions','direction','entryKey','mappingId','sequence'],4)
        OR NOT public."pos_manual_t2_json_keys_exact_v1"(p->'source',ARRAY['competenceDate','facts','factsHash','schemaVersion','sourceId','sourceType','sourceVersion'])
        OR NOT public."pos_manual_t2_json_keys_exact_v1"(p->'source'->'facts',ARRAY['discountCents','paymentIds','saleId','status','subtotalCents','surchargeCents','totalCents'])
        OR NOT public."pos_manual_t2_json_keys_exact_v1"(p->'journal',ARRAY['branchId','competenceDate','costCenterId','createdBy','currency','descriptionLabel','idempotencyKey','journalId','occurredAt','originId','originType','originVersion','periodId','plannedSaleId','policyHash','policyId','policyVersion','requestHash','sourceSnapshotHash','totalCreditCents','totalDebitCents']) THEN RETURN false; END IF;
      RETURN true;
    WHEN 'webhooks' THEN
      RETURN public."pos_manual_t2_json_keys_exact_v1"(p,ARRAY['endpoints','payloads','schemaVersion'])
        AND public."pos_manual_t2_json_array_objects_exact_v1"(p->'endpoints',ARRAY['apiVersion','configHash','endpointId','endpointRowId','endpointVersion','topic'],100)
        AND public."pos_manual_t2_json_array_objects_exact_v1"(p->'payloads',ARRAY['endpointId','endpointVersion','eventKind','payloadHash','topic'],100);
    WHEN 'manifest' THEN
      RETURN public."pos_manual_t2_json_keys_exact_v1"(p,ARRAY['entries','schemaVersion'])
        AND public."pos_manual_t2_json_array_objects_exact_v1"(p->'entries',ARRAY['effectKey','effectKind','expectedCardinality','expectedHash','required'],1812);
    ELSE RETURN false;
  END CASE;
END
$function$;

CREATE OR REPLACE FUNCTION public."pos_manual_t2_json_dlp_safe_v1"(p_document_kind text,p_value jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE canonical text;
BEGIN
  IF pg_catalog.jsonb_typeof(p_value)<>'object'
    OR pg_catalog.pg_column_size(p_value) NOT BETWEEN 2 AND 4194304
    OR NOT public."pos_manual_t2_document_shape_v1"(p_document_kind,p_value) THEN RETURN false; END IF;
  canonical:=public."pos_manual_canonical_json_v1"(p_value);
  RETURN pg_catalog.octet_length(canonical)<=4194304
    AND public."pos_manual_t2_canonical_text_dlp_safe_v1"(canonical);
END
$function$;

-- Boundary revisions/hashes are materialized under the locks above.  NULL is
-- explicit in every canonical object and updated_at is not a revision.
ALTER TABLE public."products"
  ADD COLUMN "pos_revision" integer,
  ADD COLUMN "pos_config_hash" text;
UPDATE public."products" product
   SET "pos_revision" = 1,
       "pos_config_hash" = public."pos_manual_hash_canonical_json_v1"(
         't2-catalog-product-v1',
         pg_catalog.jsonb_build_object(
           'active',product."active",'gtinSnapshot',product."gtin",'manageStock',product."manage_stock",
           'nameLabel',product."name",'posRevision',1,'productId',product."id",
           'productType',product."type",'schemaVersion',1,'skuSnapshot',product."sku",
           'status',product."status",'unit',product."unit"));
ALTER TABLE public."products"
  ALTER COLUMN "pos_revision" SET NOT NULL,
  ALTER COLUMN "pos_config_hash" SET NOT NULL,
  ADD CONSTRAINT "products_pos_revision_check" CHECK ("pos_revision" > 0),
  ADD CONSTRAINT "products_pos_config_hash_check" CHECK ("pos_config_hash" ~ '^[0-9a-f]{64}$');

ALTER TABLE public."product_variations"
  ADD COLUMN "pos_revision" integer,
  ADD COLUMN "pos_config_hash" text;
UPDATE public."product_variations" variation
   SET "pos_revision" = 1,
       "pos_config_hash" = public."pos_manual_hash_canonical_json_v1"(
         't2-catalog-variation-v1',
         pg_catalog.jsonb_build_object(
           'enabled',variation."enabled",'gtinSnapshot',variation."gtin",
           'manageStock',variation."manage_stock",'posRevision',1,
           'productId',variation."product_id",'schemaVersion',1,
           'skuSnapshot',variation."sku",'status',variation."status",
           'variationId',variation."id"));
ALTER TABLE public."product_variations"
  ALTER COLUMN "pos_revision" SET NOT NULL,
  ALTER COLUMN "pos_config_hash" SET NOT NULL,
  ADD CONSTRAINT "product_variations_pos_revision_check" CHECK ("pos_revision" > 0),
  ADD CONSTRAINT "product_variations_pos_config_hash_check" CHECK ("pos_config_hash" ~ '^[0-9a-f]{64}$');

ALTER TABLE public."pos_value_programs"
  ADD COLUMN "revision" integer,
  ADD COLUMN "config_hash" text;
UPDATE public."pos_value_programs" program
   SET "revision" = 1,
       "config_hash" = public."pos_manual_hash_canonical_json_v1"(
         't2-value-program-v1',
         pg_catalog.jsonb_build_object(
           'branchId',program."branch_id",'earnUnits',program."earn_units",
           'expiresAfterDays',program."expires_after_days",'kind',program."kind",
           'programId',program."id",'revision',1,'schemaVersion',1,
           'spendCents',program."spend_cents",'status',program."status"));
ALTER TABLE public."pos_value_programs"
  ALTER COLUMN "revision" SET NOT NULL,
  ALTER COLUMN "config_hash" SET NOT NULL,
  ADD CONSTRAINT "pos_value_programs_revision_check" CHECK ("revision" > 0),
  ADD CONSTRAINT "pos_value_programs_config_hash_check" CHECK ("config_hash" ~ '^[0-9a-f]{64}$');

ALTER TABLE public."pos_accounting_periods"
  ADD COLUMN "revision" integer,
  ADD COLUMN "config_hash" text;
UPDATE public."pos_accounting_periods" period
   SET "revision" = 1,
       "config_hash" = public."pos_manual_hash_canonical_json_v1"(
         't2-accounting-period-v1',
         pg_catalog.jsonb_build_object(
           'branchId',period."branch_id",'currency',period."currency",
           'endsOn',period."ends_at",'month',period."month",'periodId',period."id",
           'revision',1,'schemaVersion',1,'startsOn',period."starts_at",
           'status',period."status",'year',period."year"));
ALTER TABLE public."pos_accounting_periods"
  ALTER COLUMN "revision" SET NOT NULL,
  ALTER COLUMN "config_hash" SET NOT NULL,
  ADD CONSTRAINT "pos_accounting_periods_revision_check" CHECK ("revision" > 0),
  ADD CONSTRAINT "pos_accounting_periods_config_hash_check" CHECK ("config_hash" ~ '^[0-9a-f]{64}$');

ALTER TABLE public."pos_accounting_policy_mappings"
  ADD COLUMN "config_hash" text;
UPDATE public."pos_accounting_policy_mappings" mapping
   SET "config_hash" = public."pos_manual_hash_canonical_json_v1"(
     't2-accounting-mapping-v1',
     pg_catalog.jsonb_build_object(
       'accountId',mapping."account_id",'direction',mapping."direction",
       'entryKey',mapping."entry_key",'mappingId',mapping."id",
       'policyId',mapping."policy_id",'schemaVersion',1,
       'sourceType',mapping."source_type"));
ALTER TABLE public."pos_accounting_policy_mappings"
  ALTER COLUMN "config_hash" SET NOT NULL,
  ADD CONSTRAINT "pos_accounting_policy_mappings_config_hash_check"
    CHECK ("config_hash" ~ '^[0-9a-f]{64}$');

ALTER TABLE public."integration_webhook_endpoints"
  ADD COLUMN "logical_id" text,
  ADD COLUMN "version" integer,
  ADD COLUMN "config_hash" text,
  ADD COLUMN "superseded_at" timestamptz;
UPDATE public."integration_webhook_endpoints" endpoint
   SET "logical_id" = endpoint."id", "version" = 1,
       "config_hash" = public."pos_manual_hash_canonical_json_v1"(
         't2-webhook-config-v1',
         pg_catalog.jsonb_build_object(
           'apiVersion',endpoint."api_version",'deliveryUrl',endpoint."delivery_url",
           'endpointId',endpoint."id",'schemaVersion',1,
           'secretCipher',endpoint."secret_cipher",'status',endpoint."status",
           'topic',endpoint."topic",'version',1));
ALTER TABLE public."integration_webhook_endpoints"
  ALTER COLUMN "logical_id" SET NOT NULL,
  ALTER COLUMN "version" SET NOT NULL,
  ALTER COLUMN "config_hash" SET NOT NULL,
  ADD CONSTRAINT "integration_webhook_endpoints_version_check" CHECK ("version" > 0),
  ADD CONSTRAINT "integration_webhook_endpoints_config_hash_check" CHECK ("config_hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "integration_webhook_endpoints_logical_version_key" UNIQUE ("logical_id","version"),
  ADD CONSTRAINT "integration_webhook_endpoints_logical_version_hash_key" UNIQUE ("logical_id","version","config_hash");
CREATE UNIQUE INDEX "integration_webhook_endpoints_one_current_idx"
  ON public."integration_webhook_endpoints"("logical_id") WHERE "superseded_at" IS NULL;

CREATE TABLE public."pos_manual_application_stock_reservations" (
  "id" uuid NOT NULL,
  "application_id" uuid NOT NULL,
  "reservation_key" text NOT NULL,
  "quote_line_index" integer NOT NULL,
  "held_sale_item_id" integer NOT NULL,
  "component_scope_key" text,
  "warehouse_id" integer NOT NULL,
  "product_id" integer NOT NULL,
  "variation_id" integer,
  "lot_id" text,
  "stock_mode" text NOT NULL,
  "tracking_kind" text NOT NULL,
  "quantity_micros" bigint NOT NULL,
  "state" text NOT NULL,
  "version" integer NOT NULL DEFAULT 0,
  "parent_reserved_before_micros" bigint NOT NULL,
  "parent_reserved_after_micros" bigint NOT NULL,
  "variation_reserved_before_micros" bigint,
  "variation_reserved_after_micros" bigint,
  "lot_reserved_before_micros" bigint,
  "lot_reserved_after_micros" bigint,
  "reserved_at" timestamptz NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "reserve_txid" numeric(20,0) NOT NULL,
  "consumed_at" timestamptz,
  "consume_txid" numeric(20,0),
  "released_at" timestamptz,
  "release_txid" numeric(20,0),
  "release_reason" text,
  CONSTRAINT "pos_manual_app_stock_reservations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_manual_app_stock_reservations_application_key" UNIQUE ("application_id","reservation_key"),
  CONSTRAINT "pos_manual_app_stock_reservations_application_id_key" UNIQUE ("application_id","id"),
  CONSTRAINT "pos_manual_app_stock_reservations_application_fkey" FOREIGN KEY ("application_id")
    REFERENCES public."pos_manual_payment_applications"("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "pos_manual_app_stock_reservations_held_item_fkey" FOREIGN KEY ("held_sale_item_id")
    REFERENCES public."pos_held_sale_items"("id") ON DELETE RESTRICT,
  CONSTRAINT "pos_manual_app_stock_reservations_warehouse_fkey" FOREIGN KEY ("warehouse_id")
    REFERENCES public."warehouses"("id") ON DELETE RESTRICT,
  CONSTRAINT "pos_manual_app_stock_reservations_product_fkey" FOREIGN KEY ("product_id")
    REFERENCES public."products"("id") ON DELETE RESTRICT,
  CONSTRAINT "pos_manual_app_stock_reservations_variation_fkey" FOREIGN KEY ("variation_id")
    REFERENCES public."product_variations"("id") ON DELETE RESTRICT,
  CONSTRAINT "pos_manual_app_stock_reservations_lot_fkey" FOREIGN KEY ("lot_id")
    REFERENCES public."pos_inventory_lots"("id") ON DELETE RESTRICT,
  CONSTRAINT "pos_manual_app_stock_reservations_key_check" CHECK (
    "reservation_key" ~ '^stock:[0-9a-f]{64}$' AND pg_catalog.octet_length("reservation_key") = 70),
  CONSTRAINT "pos_manual_app_stock_reservations_quantity_check" CHECK (
    "quantity_micros" BETWEEN 1 AND 9007199254740991
    AND "parent_reserved_before_micros" BETWEEN 0 AND 9007199254740991
    AND "parent_reserved_after_micros" = "parent_reserved_before_micros" + "quantity_micros"
    AND ("variation_reserved_before_micros" IS NULL OR "variation_reserved_before_micros" BETWEEN 0 AND 9007199254740991)
    AND ("lot_reserved_before_micros" IS NULL OR "lot_reserved_before_micros" BETWEEN 0 AND 9007199254740991)),
  CONSTRAINT "pos_manual_app_stock_reservations_tracking_check" CHECK (
    "tracking_kind" IN ('none','lot','serial')
    AND (("tracking_kind"='none' AND "lot_id" IS NULL)
      OR ("tracking_kind"='lot' AND "lot_id" IS NOT NULL)
      OR ("tracking_kind"='serial' AND "lot_id" IS NOT NULL AND "quantity_micros"=1000000))
    AND (("lot_id" IS NULL AND "lot_reserved_before_micros" IS NULL AND "lot_reserved_after_micros" IS NULL)
      OR ("lot_id" IS NOT NULL AND "lot_reserved_before_micros" IS NOT NULL
        AND "lot_reserved_after_micros"="lot_reserved_before_micros"+"quantity_micros"))),
  CONSTRAINT "pos_manual_app_stock_reservations_mode_check" CHECK (
    ("stock_mode"='parent' AND "variation_reserved_before_micros" IS NULL AND "variation_reserved_after_micros" IS NULL)
    OR ("stock_mode"='variation' AND "variation_id" IS NOT NULL
      AND "variation_reserved_before_micros" IS NOT NULL
      AND "variation_reserved_after_micros"="variation_reserved_before_micros"+"quantity_micros")),
  CONSTRAINT "pos_manual_app_stock_reservations_state_check" CHECK (
    ("state"='reserved' AND "version"=0 AND "consumed_at" IS NULL AND "consume_txid" IS NULL
      AND "released_at" IS NULL AND "release_txid" IS NULL AND "release_reason" IS NULL)
    OR ("state"='consumed' AND "version"=1 AND "consumed_at" IS NOT NULL AND "consume_txid">0
      AND "released_at" IS NULL AND "release_txid" IS NULL AND "release_reason" IS NULL)
    OR ("state"='released' AND "version"=1 AND "consumed_at" IS NULL AND "consume_txid" IS NULL
      AND "released_at" IS NOT NULL AND "release_txid">0
      AND "release_reason" IN ('reservation_expired','boundary_changed'))),
  CONSTRAINT "pos_manual_app_stock_reservations_txid_check" CHECK ("reserve_txid">0 AND "expires_at">"reserved_at")
);
CREATE INDEX "pos_manual_app_stock_reservations_expiry_idx"
  ON public."pos_manual_application_stock_reservations"("state","expires_at","application_id");
CREATE INDEX "pos_manual_app_stock_reservations_lock_idx"
  ON public."pos_manual_application_stock_reservations"("warehouse_id","product_id","variation_id","lot_id","reservation_key");

CREATE TABLE public."pos_manual_application_stock_reservation_events" (
  "id" uuid NOT NULL,
  "reservation_id" uuid NOT NULL,
  "application_id" uuid NOT NULL,
  "sequence" integer NOT NULL,
  "action" text NOT NULL,
  "state_before" text NOT NULL,
  "state_after" text NOT NULL,
  "quantity_micros" bigint NOT NULL,
  "parent_reserved_before_micros" bigint NOT NULL,
  "parent_reserved_after_micros" bigint NOT NULL,
  "variation_reserved_before_micros" bigint,
  "variation_reserved_after_micros" bigint,
  "lot_reserved_before_micros" bigint,
  "lot_reserved_after_micros" bigint,
  "reason_code" text,
  "write_txid" numeric(20,0) NOT NULL,
  "occurred_at" timestamptz NOT NULL,
  CONSTRAINT "pos_manual_app_stock_reservation_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_manual_app_stock_reservation_events_sequence_key" UNIQUE ("reservation_id","sequence"),
  CONSTRAINT "pos_manual_app_stock_reservation_events_action_key" UNIQUE ("reservation_id","action"),
  CONSTRAINT "pos_manual_app_stock_reservation_events_reservation_fkey" FOREIGN KEY ("application_id","reservation_id")
    REFERENCES public."pos_manual_application_stock_reservations"("application_id","id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "pos_manual_app_stock_reservation_events_shape_check" CHECK (
    "quantity_micros" BETWEEN 1 AND 9007199254740991 AND "write_txid">0
    AND (("action"='reserve' AND "sequence"=0 AND "state_before"='none' AND "state_after"='reserved' AND "reason_code" IS NULL)
      OR ("action"='consume' AND "sequence"=1 AND "state_before"='reserved' AND "state_after"='consumed' AND "reason_code" IS NULL)
      OR ("action"='release' AND "sequence"=1 AND "state_before"='reserved' AND "state_after"='released'
        AND "reason_code" IN ('reservation_expired','boundary_changed')))
    AND (("variation_reserved_before_micros" IS NULL)=("variation_reserved_after_micros" IS NULL))
    AND (("lot_reserved_before_micros" IS NULL)=("lot_reserved_after_micros" IS NULL)))
);

CREATE TABLE public."pos_manual_application_promotion_reservations" (
  "id" uuid NOT NULL,
  "application_id" uuid NOT NULL,
  "reservation_key" text NOT NULL,
  "promotion_id" text NOT NULL,
  "coupon_id" text,
  "customer_id" integer,
  "customer_opaque_id" text,
  "discount_cents" integer NOT NULL,
  "policy_hash" text NOT NULL,
  "state" text NOT NULL,
  "version" integer NOT NULL DEFAULT 0,
  "global_used_before" integer NOT NULL,
  "customer_used_before" integer,
  "coupon_used_before" integer,
  "global_live_before" integer NOT NULL,
  "customer_live_before" integer,
  "coupon_live_before" integer,
  "reserved_at" timestamptz NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "reserve_txid" numeric(20,0) NOT NULL,
  "consumed_at" timestamptz,
  "consume_txid" numeric(20,0),
  "released_at" timestamptz,
  "release_txid" numeric(20,0),
  "release_reason" text,
  CONSTRAINT "pos_manual_app_promotion_reservations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_manual_app_promotion_reservations_application_key" UNIQUE ("application_id","reservation_key"),
  CONSTRAINT "pos_manual_app_promotion_reservations_one_per_application" UNIQUE ("application_id"),
  CONSTRAINT "pos_manual_app_promotion_reservations_application_id_key" UNIQUE ("application_id","id"),
  CONSTRAINT "pos_manual_app_promotion_reservations_application_fkey" FOREIGN KEY ("application_id")
    REFERENCES public."pos_manual_payment_applications"("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "pos_manual_app_promotion_reservations_promotion_fkey" FOREIGN KEY ("promotion_id")
    REFERENCES public."pos_promotions"("id") ON DELETE RESTRICT,
  CONSTRAINT "pos_manual_app_promotion_reservations_coupon_fkey" FOREIGN KEY ("coupon_id")
    REFERENCES public."pos_coupons"("id") ON DELETE RESTRICT,
  CONSTRAINT "pos_manual_app_promotion_reservations_customer_fkey" FOREIGN KEY ("customer_id")
    REFERENCES public."customers"("id") ON DELETE RESTRICT,
  CONSTRAINT "pos_manual_app_promotion_reservations_key_check" CHECK (
    "reservation_key" ~ '^promotion:[0-9a-f]{64}$' AND pg_catalog.octet_length("reservation_key")=74),
  CONSTRAINT "pos_manual_app_promotion_reservations_shape_check" CHECK (
    "discount_cents" BETWEEN 1 AND 2147483647
    AND "policy_hash" ~ '^[0-9a-f]{64}$'
    AND (("customer_id" IS NULL)=("customer_opaque_id" IS NULL))
    AND ("customer_opaque_id" IS NULL OR "customer_opaque_id" ~ '^[0-9a-f]{64}$')
    AND "global_used_before">=0 AND "global_live_before">=0
    AND ("customer_used_before" IS NULL OR "customer_used_before">=0)
    AND ("customer_live_before" IS NULL OR "customer_live_before">=0)
    AND ("coupon_used_before" IS NULL OR "coupon_used_before">=0)
    AND ("coupon_live_before" IS NULL OR "coupon_live_before">=0)
    AND (("customer_id" IS NULL AND "customer_used_before" IS NULL AND "customer_live_before" IS NULL)
      OR ("customer_id" IS NOT NULL AND "customer_used_before" IS NOT NULL AND "customer_live_before" IS NOT NULL))
    AND (("coupon_id" IS NULL AND "coupon_used_before" IS NULL AND "coupon_live_before" IS NULL)
      OR ("coupon_id" IS NOT NULL AND "coupon_used_before" IS NOT NULL AND "coupon_live_before" IS NOT NULL))),
  CONSTRAINT "pos_manual_app_promotion_reservations_state_check" CHECK (
    ("state"='reserved' AND "version"=0 AND "consumed_at" IS NULL AND "consume_txid" IS NULL
      AND "released_at" IS NULL AND "release_txid" IS NULL AND "release_reason" IS NULL)
    OR ("state"='consumed' AND "version"=1 AND "consumed_at" IS NOT NULL AND "consume_txid">0
      AND "released_at" IS NULL AND "release_txid" IS NULL AND "release_reason" IS NULL)
    OR ("state"='released' AND "version"=1 AND "consumed_at" IS NULL AND "consume_txid" IS NULL
      AND "released_at" IS NOT NULL AND "release_txid">0
      AND "release_reason" IN ('reservation_expired','boundary_changed'))),
  CONSTRAINT "pos_manual_app_promotion_reservations_txid_check" CHECK ("reserve_txid">0 AND "expires_at">"reserved_at")
);
CREATE INDEX "pos_manual_app_promotion_reservations_live_idx"
  ON public."pos_manual_application_promotion_reservations"("promotion_id","state","expires_at","application_id");
CREATE INDEX "pos_manual_app_promotion_reservations_customer_live_idx"
  ON public."pos_manual_application_promotion_reservations"("promotion_id","customer_id","state","expires_at");
CREATE INDEX "pos_manual_app_promotion_reservations_coupon_live_idx"
  ON public."pos_manual_application_promotion_reservations"("coupon_id","state","expires_at");

CREATE TABLE public."pos_manual_application_promotion_reservation_events" (
  "id" uuid NOT NULL,
  "reservation_id" uuid NOT NULL,
  "application_id" uuid NOT NULL,
  "sequence" integer NOT NULL,
  "action" text NOT NULL,
  "state_before" text NOT NULL,
  "state_after" text NOT NULL,
  "discount_cents" integer NOT NULL,
  "global_used_before" integer NOT NULL,
  "global_used_after" integer NOT NULL,
  "customer_used_before" integer,
  "customer_used_after" integer,
  "coupon_used_before" integer,
  "coupon_used_after" integer,
  "global_live_before" integer NOT NULL,
  "global_live_after" integer NOT NULL,
  "customer_live_before" integer,
  "customer_live_after" integer,
  "coupon_live_before" integer,
  "coupon_live_after" integer,
  "reason_code" text,
  "write_txid" numeric(20,0) NOT NULL,
  "occurred_at" timestamptz NOT NULL,
  CONSTRAINT "pos_manual_app_promotion_reservation_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_manual_app_promotion_reservation_events_sequence_key" UNIQUE ("reservation_id","sequence"),
  CONSTRAINT "pos_manual_app_promotion_reservation_events_action_key" UNIQUE ("reservation_id","action"),
  CONSTRAINT "pos_manual_app_promotion_reservation_events_reservation_fkey" FOREIGN KEY ("application_id","reservation_id")
    REFERENCES public."pos_manual_application_promotion_reservations"("application_id","id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "pos_manual_app_promotion_reservation_events_shape_check" CHECK (
    "discount_cents" BETWEEN 1 AND 2147483647 AND "write_txid">0
    AND "global_used_before">=0 AND "global_used_after">=0
    AND "global_live_before">=0 AND "global_live_after">=0
    AND (("customer_used_before" IS NULL AND "customer_used_after" IS NULL
      AND "customer_live_before" IS NULL AND "customer_live_after" IS NULL)
      OR ("customer_used_before">=0 AND "customer_used_after">=0
        AND "customer_live_before">=0 AND "customer_live_after">=0))
    AND (("coupon_used_before" IS NULL AND "coupon_used_after" IS NULL
      AND "coupon_live_before" IS NULL AND "coupon_live_after" IS NULL)
      OR ("coupon_used_before">=0 AND "coupon_used_after">=0
        AND "coupon_live_before">=0 AND "coupon_live_after">=0))
    AND (("action"='reserve' AND "sequence"=0 AND "state_before"='none' AND "state_after"='reserved'
      AND "reason_code" IS NULL
      AND "global_used_after"="global_used_before" AND "global_live_after"="global_live_before"+1
      AND ("customer_used_before" IS NULL OR "customer_used_after"="customer_used_before" AND "customer_live_after"="customer_live_before"+1)
      AND ("coupon_used_before" IS NULL OR "coupon_used_after"="coupon_used_before" AND "coupon_live_after"="coupon_live_before"+1))
    OR ("action"='consume' AND "sequence"=1 AND "state_before"='reserved' AND "state_after"='consumed'
      AND "reason_code" IS NULL
      AND "global_used_after"="global_used_before"+1 AND "global_live_after"="global_live_before"-1
      AND ("customer_used_before" IS NULL OR "customer_used_after"="customer_used_before"+1 AND "customer_live_after"="customer_live_before"-1)
      AND ("coupon_used_before" IS NULL OR "coupon_used_after"="coupon_used_before"+1 AND "coupon_live_after"="coupon_live_before"-1))
    OR ("action"='release' AND "sequence"=1 AND "state_before"='reserved' AND "state_after"='released'
      AND "reason_code" IN ('reservation_expired','boundary_changed')
      AND "global_used_after"="global_used_before" AND "global_live_after"="global_live_before"-1
      AND ("customer_used_before" IS NULL OR "customer_used_after"="customer_used_before" AND "customer_live_after"="customer_live_before"-1)
      AND ("coupon_used_before" IS NULL OR "coupon_used_after"="coupon_used_before" AND "coupon_live_after"="coupon_live_before"-1))))
);

CREATE TABLE public."pos_manual_application_reserve_assertions" (
  "application_id" uuid NOT NULL,
  "stock_reservation_count" integer NOT NULL,
  "stock_quantity_micros" bigint NOT NULL,
  "promotion_reservation_count" integer NOT NULL,
  "stock_multiset_hash" text NOT NULL,
  "promotion_multiset_hash" text NOT NULL,
  "reservation_graph_hash" text NOT NULL,
  "reserve_operation_id" bigint NOT NULL,
  "reserve_state_event_id" bigint NOT NULL,
  "reserve_txid" numeric(20,0) NOT NULL,
  "created_at" timestamptz NOT NULL,
  CONSTRAINT "pos_manual_application_reserve_assertions_pkey" PRIMARY KEY ("application_id"),
  CONSTRAINT "pos_manual_application_reserve_assertions_application_fkey" FOREIGN KEY ("application_id")
    REFERENCES public."pos_manual_payment_applications"("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "pos_manual_application_reserve_assertions_operation_fkey" FOREIGN KEY ("reserve_operation_id")
    REFERENCES public."pos_manual_payment_operations"("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "pos_manual_application_reserve_assertions_state_event_fkey" FOREIGN KEY ("reserve_state_event_id")
    REFERENCES public."pos_manual_payment_state_events"("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "pos_manual_application_reserve_assertions_shape_check" CHECK (
    "stock_reservation_count" BETWEEN 0 AND 400
    AND "stock_quantity_micros" BETWEEN 0 AND 9007199254740991
    AND "promotion_reservation_count" BETWEEN 0 AND 1
    AND "stock_multiset_hash" ~ '^[0-9a-f]{64}$'
    AND "promotion_multiset_hash" ~ '^[0-9a-f]{64}$'
    AND "reservation_graph_hash" ~ '^[0-9a-f]{64}$'
    AND "reserve_txid">0)
);

CREATE TABLE public."pos_manual_application_release_assertions" (
  "application_id" uuid NOT NULL,
  "release_source" text NOT NULL,
  "release_reason" text NOT NULL,
  "source_sweep_batch_id" uuid,
  "source_sweep_receipt_id" uuid,
  "source_failure_operation_id" bigint,
  "fencing_token_before" bigint NOT NULL,
  "stock_released_count" integer NOT NULL,
  "promotion_released_count" integer NOT NULL,
  "stock_release_multiset_hash" text NOT NULL,
  "promotion_release_multiset_hash" text NOT NULL,
  "release_graph_hash" text NOT NULL,
  "release_operation_id" bigint NOT NULL,
  "release_state_event_id" bigint NOT NULL,
  "release_incident_id" uuid NOT NULL,
  "release_txid" numeric(20,0) NOT NULL,
  "created_at" timestamptz NOT NULL,
  CONSTRAINT "pos_manual_application_release_assertions_pkey" PRIMARY KEY ("application_id"),
  CONSTRAINT "pos_manual_application_release_assertions_application_fkey" FOREIGN KEY ("application_id")
    REFERENCES public."pos_manual_payment_applications"("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "pos_manual_application_release_assertions_operation_fkey" FOREIGN KEY ("release_operation_id")
    REFERENCES public."pos_manual_payment_operations"("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "pos_manual_app_release_assert_failure_op_fkey" FOREIGN KEY ("source_failure_operation_id")
    REFERENCES public."pos_manual_payment_operations"("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "pos_manual_application_release_assertions_state_event_fkey" FOREIGN KEY ("release_state_event_id")
    REFERENCES public."pos_manual_payment_state_events"("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "pos_manual_application_release_assertions_incident_fkey" FOREIGN KEY ("release_incident_id")
    REFERENCES public."pos_manual_payment_incidents"("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "pos_manual_application_release_assertions_shape_check" CHECK (
    (("release_source"='sweep_expired' AND "release_reason"='reservation_expired'
      AND "source_sweep_batch_id" IS NOT NULL AND "source_sweep_receipt_id" IS NOT NULL
      AND "source_failure_operation_id" IS NULL)
    OR ("release_source"='report_boundary_changed' AND "release_reason"='boundary_changed'
      AND "source_sweep_batch_id" IS NULL AND "source_sweep_receipt_id" IS NULL
      AND "source_failure_operation_id"="release_operation_id"))
    AND "fencing_token_before">=0
    AND "stock_released_count" BETWEEN 0 AND 400
    AND "promotion_released_count" BETWEEN 0 AND 1
    AND "stock_release_multiset_hash" ~ '^[0-9a-f]{64}$'
    AND "promotion_release_multiset_hash" ~ '^[0-9a-f]{64}$'
    AND "release_graph_hash" ~ '^[0-9a-f]{64}$'
    AND "release_txid">0)
);

CREATE TABLE public."pos_manual_application_sweep_batches" (
  "id" uuid NOT NULL,
  "idempotency_key" text NOT NULL,
  "request_hash" text NOT NULL,
  "sweeper_id" text NOT NULL,
  "sweeper_hash" text NOT NULL,
  "requested_limit" integer NOT NULL,
  "caller_role" text NOT NULL,
  "application_count" integer NOT NULL,
  "case_count" integer NOT NULL,
  "stock_reservation_count" integer NOT NULL,
  "promotion_reservation_count" integer NOT NULL,
  "release_result_hash" text NOT NULL,
  "write_txid" numeric(20,0) NOT NULL,
  "created_at" timestamptz NOT NULL,
  CONSTRAINT "pos_manual_application_sweep_batches_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_manual_application_sweep_batches_idempotency_key" UNIQUE ("idempotency_key"),
  CONSTRAINT "pos_manual_application_sweep_batches_request_hash_key" UNIQUE ("request_hash"),
  CONSTRAINT "pos_manual_application_sweep_batches_shape_check" CHECK (
    "idempotency_key" ~ '^([0-9a-f]{64}|[A-Za-z0-9_-]{43})$'
    AND "request_hash" ~ '^[0-9a-f]{64}$' AND "sweeper_hash" ~ '^[0-9a-f]{64}$'
    AND "requested_limit" BETWEEN 1 AND 50
    AND pg_catalog.octet_length("sweeper_id") BETWEEN 1 AND 128
    AND pg_catalog.octet_length("caller_role") BETWEEN 1 AND 128
    AND "application_count" BETWEEN 0 AND "requested_limit"
    AND "case_count"="application_count"
    AND "stock_reservation_count" BETWEEN 0 AND 20000
    AND "promotion_reservation_count" BETWEEN 0 AND 50
    AND "release_result_hash" ~ '^[0-9a-f]{64}$' AND "write_txid">0)
);

CREATE TABLE public."pos_manual_application_sweep_receipts" (
  "id" uuid NOT NULL,
  "batch_id" uuid NOT NULL,
  "batch_index" integer NOT NULL,
  "application_id" uuid NOT NULL,
  "application_version_before" integer NOT NULL,
  "application_version_after" integer NOT NULL,
  "case_id" uuid NOT NULL,
  "case_version_before" integer NOT NULL,
  "case_version_after" integer NOT NULL,
  "fencing_token_before" bigint NOT NULL,
  "stock_reservation_count" integer NOT NULL,
  "promotion_reservation_count" integer NOT NULL,
  "release_graph_hash" text NOT NULL,
  "write_txid" numeric(20,0) NOT NULL,
  "created_at" timestamptz NOT NULL,
  CONSTRAINT "pos_manual_application_sweep_receipts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_manual_application_sweep_receipts_batch_index_key" UNIQUE ("batch_id","batch_index"),
  CONSTRAINT "pos_manual_application_sweep_receipts_batch_application_key" UNIQUE ("batch_id","application_id"),
  CONSTRAINT "pos_manual_application_sweep_receipts_batch_fkey" FOREIGN KEY ("batch_id")
    REFERENCES public."pos_manual_application_sweep_batches"("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "pos_manual_application_sweep_receipts_application_fkey" FOREIGN KEY ("application_id")
    REFERENCES public."pos_manual_payment_applications"("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "pos_manual_application_sweep_receipts_case_fkey" FOREIGN KEY ("case_id")
    REFERENCES public."pos_manual_payment_cases"("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "pos_manual_application_sweep_receipts_shape_check" CHECK (
    "batch_index" BETWEEN 0 AND 49
    AND "application_version_before">=0 AND "application_version_after"="application_version_before"+1
    AND "case_version_before">=0 AND "case_version_after"="case_version_before"+1
    AND "fencing_token_before">=0
    AND "stock_reservation_count" BETWEEN 0 AND 400
    AND "promotion_reservation_count" BETWEEN 0 AND 1
    AND "release_graph_hash" ~ '^[0-9a-f]{64}$' AND "write_txid">0)
);
CREATE INDEX "pos_manual_application_sweep_receipts_application_idx"
  ON public."pos_manual_application_sweep_receipts"("application_id","created_at");

-- Sweep causal FKs are added after both relations exist.
ALTER TABLE public."pos_manual_application_release_assertions"
  ADD CONSTRAINT "pos_manual_application_release_assertions_sweep_batch_fkey"
    FOREIGN KEY ("source_sweep_batch_id") REFERENCES public."pos_manual_application_sweep_batches"("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT "pos_manual_application_release_assertions_sweep_receipt_fkey"
    FOREIGN KEY ("source_sweep_receipt_id") REFERENCES public."pos_manual_application_sweep_receipts"("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public."pos_manual_payment_operations"
  DROP CONSTRAINT "pos_manual_payment_operations_action_check",
  ADD COLUMN "fencing_token_before" bigint,
  ADD COLUMN "source_sweep_receipt_id" uuid,
  ADD CONSTRAINT "pos_manual_payment_operations_action_check" CHECK (
    "action" IN ('open','authorize_query','reject','observe','reserve_application','apply','expire','block','sweep_expired_application')),
  ADD CONSTRAINT "pos_manual_payment_operations_sweep_shape_check" CHECK (
    ("action"='sweep_expired_application' AND "fencing_token_before">=0 AND "source_sweep_receipt_id" IS NOT NULL)
    OR ("action"<>'sweep_expired_application' AND "fencing_token_before" IS NULL AND "source_sweep_receipt_id" IS NULL)),
  ADD CONSTRAINT "pos_manual_payment_operations_sweep_receipt_fkey" FOREIGN KEY ("source_sweep_receipt_id")
    REFERENCES public."pos_manual_application_sweep_receipts"("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public."pos_manual_payment_state_events"
  ADD COLUMN "fencing_token_before" bigint,
  ADD COLUMN "source_sweep_receipt_id" uuid,
  ADD CONSTRAINT "pos_manual_payment_state_events_sweep_shape_check" CHECK (
    ("source"='maintenance' AND "source_sweep_receipt_id" IS NOT NULL AND "fencing_token_before">=0)
    OR ("source_sweep_receipt_id" IS NULL AND "fencing_token_before" IS NULL)),
  ADD CONSTRAINT "pos_manual_payment_state_events_sweep_receipt_fkey" FOREIGN KEY ("source_sweep_receipt_id")
    REFERENCES public."pos_manual_application_sweep_receipts"("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public."pos_manual_payment_incidents"
  ADD COLUMN "manual_application_id" uuid,
  ADD COLUMN "source_sweep_receipt_id" uuid,
  ADD COLUMN "fencing_token_before" bigint,
  ADD COLUMN "write_txid" numeric(20,0),
  ADD CONSTRAINT "pos_manual_payment_incidents_application_fkey" FOREIGN KEY ("manual_application_id")
    REFERENCES public."pos_manual_payment_applications"("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT "pos_manual_payment_incidents_sweep_receipt_fkey" FOREIGN KEY ("source_sweep_receipt_id")
    REFERENCES public."pos_manual_application_sweep_receipts"("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT "pos_manual_payment_incidents_sweep_shape_check" CHECK (
    ("source_sweep_receipt_id" IS NULL AND "manual_application_id" IS NULL AND "fencing_token_before" IS NULL AND "write_txid" IS NULL)
    OR ("source_sweep_receipt_id" IS NOT NULL AND "manual_application_id" IS NOT NULL
      AND "fencing_token_before">=0 AND "write_txid">0));

CREATE TABLE public."pos_manual_t2_boundary_operations" (
  "operation_id" uuid NOT NULL,
  "abi" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "request_hash" text NOT NULL,
  "actor_user_id" text NOT NULL,
  "request" jsonb NOT NULL,
  "result" jsonb NOT NULL,
  "write_txid" bigint NOT NULL,
  "created_at" timestamptz NOT NULL,
  CONSTRAINT "pos_manual_t2_boundary_operations_pkey" PRIMARY KEY ("operation_id"),
  CONSTRAINT "pos_manual_t2_boundary_operations_idempotency_key" UNIQUE ("abi","idempotency_key"),
  CONSTRAINT "pos_manual_t2_boundary_operations_shape_check" CHECK (
    "abi" IN ('catalog','value_program','accounting_period_put','accounting_period','webhook')
    AND "idempotency_key"~'^([0-9a-f]{64}|[A-Za-z0-9_-]{43})$'
    AND "request_hash"~'^[0-9a-f]{64}$' AND "write_txid">0
    AND pg_catalog.octet_length("actor_user_id") BETWEEN 1 AND 128
    AND "actor_user_id"=normalize("actor_user_id",NFC) AND "actor_user_id"!~'[[:cntrl:]]'
    AND pg_catalog.jsonb_typeof("request")='object' AND pg_catalog.jsonb_typeof("result")='object'
    AND pg_catalog.pg_column_size("request")<=4194304 AND pg_catalog.pg_column_size("result")<=4194304)
);

CREATE FUNCTION public."pos_manual_t2_stock_mode_v1"(
  p_product_type text,p_product_manage_stock boolean,p_variation_id integer,p_variation_manage_stock text
)
RETURNS text LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
  IF p_product_type='service' THEN RETURN 'none'; END IF;
  IF p_variation_id IS NOT NULL THEN
    IF p_variation_manage_stock='false' THEN RETURN 'none'; END IF;
    IF p_variation_manage_stock='true' THEN RETURN 'variation'; END IF;
    IF p_variation_manage_stock IS DISTINCT FROM 'parent' THEN
      RAISE EXCEPTION 'invalid T2 variation stock mode' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN CASE WHEN p_product_manage_stock THEN 'parent' ELSE 'none' END;
END
$function$;

CREATE FUNCTION public."pos_manual_t2_float_to_micros_v1"(p_value double precision)
RETURNS bigint LANGUAGE plpgsql IMMUTABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE scaled numeric;
BEGIN
  IF p_value::text IN ('Infinity','-Infinity','NaN') OR pg_catalog.abs(p_value)>9007199254.740991 THEN
    RAISE EXCEPTION 'T2 quantity is outside exact micros range' USING ERRCODE='22023'; END IF;
  scaled:=p_value::numeric*1000000;
  IF scaled<>pg_catalog.round(scaled) THEN
    RAISE EXCEPTION 'T2 quantity is not exact in micros' USING ERRCODE='22023'; END IF;
  RETURN scaled::bigint;
END
$function$;

-- Transaction-local causal roots for the new reservation graph.  They carry
-- only a digest of the OLD/NEW row projection and are deleted by the pure row
-- observer.  No trigger reads or locks a business root.
CREATE TABLE public."pos_manual_t2_reservation_write_roots" (
  "backend_pid" integer NOT NULL,
  "transaction_txid" numeric(20,0) NOT NULL,
  "authority_capability" text NOT NULL,
  "authority_hash" text NOT NULL,
  "relation_kind" text NOT NULL,
  "aggregate_id" text NOT NULL,
  "dml_operation" text NOT NULL,
  "projection_hash" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT "pos_manual_t2_reservation_write_roots_pkey" PRIMARY KEY
    ("backend_pid","transaction_txid","relation_kind","aggregate_id","dml_operation"),
  CONSTRAINT "pos_manual_t2_reservation_write_roots_shape_check" CHECK (
    "authority_capability" IN ('runtime','manual_sweeper')
    AND "authority_hash"~'^[0-9a-f]{64}$' AND "projection_hash"~'^[0-9a-f]{64}$'
    AND "dml_operation" IN ('INSERT','UPDATE','DELETE')
    AND pg_catalog.octet_length("aggregate_id") BETWEEN 1 AND 256
    AND "relation_kind" IN ('application','snapshot','manifest','stock_reservation','stock_event',
      'promotion_reservation','promotion_event','reserve_assertion','release_assertion','sweep_batch','sweep_receipt',
      'boundary_product','boundary_variation','boundary_value_program','boundary_period','boundary_mapping','boundary_webhook','boundary_operation'))
);

CREATE FUNCTION public."pos_manual_t2_boundary_row_projection_v1"(p_kind text,p_row jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
  RETURN CASE p_kind
    WHEN 'boundary_product' THEN pg_catalog.jsonb_build_object('id',p_row->'id','active',p_row->'active','gtin',p_row->'gtin','manage_stock',p_row->'manage_stock','name',p_row->'name','type',p_row->'type','sku',p_row->'sku','status',p_row->'status','unit',p_row->'unit','pos_revision',p_row->'pos_revision','pos_config_hash',p_row->'pos_config_hash')
    WHEN 'boundary_variation' THEN pg_catalog.jsonb_build_object('id',p_row->'id','product_id',p_row->'product_id','enabled',p_row->'enabled','gtin',p_row->'gtin','manage_stock',p_row->'manage_stock','menu_order',p_row->'menu_order','sku',p_row->'sku','status',p_row->'status','pos_revision',p_row->'pos_revision','pos_config_hash',p_row->'pos_config_hash')
    WHEN 'boundary_value_program' THEN pg_catalog.jsonb_build_object('id',p_row->'id','branch_id',p_row->'branch_id','name',p_row->'name','kind',p_row->'kind','status',p_row->'status','earn_units',p_row->'earn_units','spend_cents',p_row->'spend_cents','redeem_cents_per_unit',p_row->'redeem_cents_per_unit','expires_after_days',p_row->'expires_after_days','revision',p_row->'revision','config_hash',p_row->'config_hash')
    WHEN 'boundary_period' THEN pg_catalog.jsonb_build_object('id',p_row->'id','branch_id',p_row->'branch_id','year',p_row->'year','month',p_row->'month','starts_at',p_row->'starts_at','ends_at',p_row->'ends_at','status',p_row->'status','currency',p_row->'currency','closed_at',p_row->'closed_at','closed_by',p_row->'closed_by','close_reason',p_row->'close_reason','revision',p_row->'revision','config_hash',p_row->'config_hash')
    WHEN 'boundary_mapping' THEN pg_catalog.jsonb_build_object('id',p_row->'id','policy_id',p_row->'policy_id','source_type',p_row->'source_type','entry_key',p_row->'entry_key','account_id',p_row->'account_id','direction',p_row->'direction','config_hash',p_row->'config_hash')
    WHEN 'boundary_webhook' THEN pg_catalog.jsonb_build_object('id',p_row->'id','logical_id',p_row->'logical_id','version',p_row->'version','name',p_row->'name','topic',p_row->'topic','delivery_url',p_row->'delivery_url','secret_cipher',p_row->'secret_cipher','secret_preview',p_row->'secret_preview','status',p_row->'status','api_version',p_row->'api_version','config_hash',p_row->'config_hash','superseded_at',p_row->'superseded_at')
    WHEN 'boundary_operation' THEN p_row
    ELSE p_row
  END;
END
$function$;

CREATE FUNCTION public."pos_manual_t2_reservation_projection_hash_v1"(
  p_relation_kind text,p_aggregate_id text,p_dml_operation text,p_old jsonb,p_new jsonb
)
RETURNS text LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
  IF p_relation_kind NOT IN ('application','snapshot','manifest','stock_reservation','stock_event',
      'promotion_reservation','promotion_event','reserve_assertion','release_assertion','sweep_batch','sweep_receipt',
      'boundary_product','boundary_variation','boundary_value_program','boundary_period','boundary_mapping','boundary_webhook','boundary_operation')
    OR p_dml_operation NOT IN ('INSERT','UPDATE','DELETE')
    OR (p_dml_operation='INSERT' AND (p_old IS NOT NULL OR pg_catalog.jsonb_typeof(p_new)<>'object'))
    OR (p_dml_operation='UPDATE' AND (pg_catalog.jsonb_typeof(p_old)<>'object' OR pg_catalog.jsonb_typeof(p_new)<>'object'))
    OR (p_dml_operation='DELETE' AND (pg_catalog.jsonb_typeof(p_old)<>'object' OR p_new IS NOT NULL))
  THEN RAISE EXCEPTION 'invalid T2 reservation projection' USING ERRCODE='22023'; END IF;
  RETURN pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to('t2-reservation-write-v1','UTF8')||pg_catalog.decode('00','hex')||
    pg_catalog.convert_to(p_relation_kind,'UTF8')||pg_catalog.decode('00','hex')||
    pg_catalog.convert_to(p_aggregate_id,'UTF8')||pg_catalog.decode('00','hex')||
    pg_catalog.convert_to(p_dml_operation,'UTF8')||pg_catalog.decode('00','hex')||
    pg_catalog.convert_to(CASE WHEN p_old IS NULL THEN 'null' ELSE public."pos_manual_canonical_json_v1"(public."pos_manual_t2_boundary_row_projection_v1"(p_relation_kind,p_old)) END,'UTF8')||pg_catalog.decode('00','hex')||
    pg_catalog.convert_to(CASE WHEN p_new IS NULL THEN 'null' ELSE public."pos_manual_canonical_json_v1"(public."pos_manual_t2_boundary_row_projection_v1"(p_relation_kind,p_new)) END,'UTF8')),'hex');
END
$function$;

CREATE FUNCTION public."pos_manual_t2_open_reservation_write_root_v1"(
  p_authority_capability text,p_relation_kind text,p_aggregate_id text,p_dml_operation text,p_old jsonb,p_new jsonb
)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE authority text;
BEGIN
  IF p_authority_capability NOT IN ('runtime','manual_sweeper') THEN
    RAISE EXCEPTION 'invalid T2 reservation authority' USING ERRCODE='42501'; END IF;
  authority:=public."pos_manual_t2_authority_v1"(p_authority_capability);
  INSERT INTO public."pos_manual_t2_reservation_write_roots"(
    "backend_pid","transaction_txid","authority_capability","authority_hash","relation_kind","aggregate_id","dml_operation","projection_hash")
  VALUES(pg_catalog.pg_backend_pid(),pg_catalog.txid_current()::numeric,p_authority_capability,
    authority,p_relation_kind,p_aggregate_id,p_dml_operation,
    public."pos_manual_t2_reservation_projection_hash_v1"(p_relation_kind,p_aggregate_id,p_dml_operation,p_old,p_new));
END
$function$;

CREATE FUNCTION public."pos_manual_t2_observe_reservation_write_v1"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE old_doc jsonb; new_doc jsonb; v_aggregate_id text; root_row record; actual_hash text;
BEGIN
  IF TG_OP NOT IN ('INSERT','UPDATE','DELETE') THEN RAISE EXCEPTION 'invalid T2 DML verb' USING ERRCODE='23514'; END IF;
  old_doc:=CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN pg_catalog.to_jsonb(OLD) ELSE NULL END;
  new_doc:=CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN pg_catalog.to_jsonb(NEW) ELSE NULL END;
  v_aggregate_id:=COALESCE(new_doc->>'application_id',new_doc->>'operation_id',new_doc->>'id',new_doc->>'manifest_entry_id',
    old_doc->>'application_id',old_doc->>'operation_id',old_doc->>'id',old_doc->>'manifest_entry_id');
  IF v_aggregate_id IS NULL THEN RAISE EXCEPTION 'T2 reservation aggregate identity missing' USING ERRCODE='23514'; END IF;
  actual_hash:=public."pos_manual_t2_reservation_projection_hash_v1"(TG_ARGV[0],v_aggregate_id,TG_OP,old_doc,new_doc);
  DELETE FROM public."pos_manual_t2_reservation_write_roots" root
   WHERE root."backend_pid"=pg_catalog.pg_backend_pid()
     AND root."transaction_txid"=pg_catalog.txid_current()::numeric
     AND root."relation_kind"=TG_ARGV[0] AND root."aggregate_id"=v_aggregate_id
     AND root."dml_operation"=TG_OP
   RETURNING root.* INTO STRICT root_row;
  IF root_row."projection_hash" IS DISTINCT FROM actual_hash
    OR root_row."authority_hash" IS DISTINCT FROM public."pos_manual_t2_authority_v1"(root_row."authority_capability") THEN
    RAISE EXCEPTION 'T2 reservation write root mismatch' USING ERRCODE='42501'; END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
EXCEPTION WHEN no_data_found OR too_many_rows THEN
  RAISE EXCEPTION 'T2 reservation write requires one exact producer root' USING ERRCODE='42501';
END
$function$;

CREATE FUNCTION public."pos_manual_t2_reject_unconsumed_reservation_root_v1"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
  IF EXISTS (SELECT 1 FROM public."pos_manual_t2_reservation_write_roots" root
    WHERE ROW(root.backend_pid,root.transaction_txid,root.relation_kind,root.aggregate_id,root.dml_operation)
      =ROW(NEW.backend_pid,NEW.transaction_txid,NEW.relation_kind,NEW.aggregate_id,NEW.dml_operation)) THEN
    RAISE EXCEPTION 'T2 boundary producer left an unconsumed write root' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END
$function$;
CREATE CONSTRAINT TRIGGER "pos_manual_t2_reservation_root_commit"
  AFTER INSERT ON public."pos_manual_t2_reservation_write_roots"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public."pos_manual_t2_reject_unconsumed_reservation_root_v1"();

DROP TRIGGER "pos_manual_t2_application_inert_guard" ON public."pos_manual_payment_applications";
CREATE TRIGGER "pos_manual_t2_application_reservation_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON public."pos_manual_payment_applications"
  FOR EACH ROW EXECUTE FUNCTION public."pos_manual_t2_observe_reservation_write_v1"('application');
CREATE TRIGGER "pos_manual_t2_snapshot_insert_guard"
  BEFORE INSERT ON public."pos_manual_application_snapshots"
  FOR EACH ROW EXECUTE FUNCTION public."pos_manual_t2_observe_reservation_write_v1"('snapshot');
CREATE TRIGGER "pos_manual_t2_manifest_insert_guard"
  BEFORE INSERT ON public."pos_manual_application_manifest_entries"
  FOR EACH ROW EXECUTE FUNCTION public."pos_manual_t2_observe_reservation_write_v1"('manifest');
CREATE TRIGGER "pos_manual_t2_stock_reservation_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON public."pos_manual_application_stock_reservations"
  FOR EACH ROW EXECUTE FUNCTION public."pos_manual_t2_observe_reservation_write_v1"('stock_reservation');
CREATE TRIGGER "pos_manual_t2_stock_event_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON public."pos_manual_application_stock_reservation_events"
  FOR EACH ROW EXECUTE FUNCTION public."pos_manual_t2_observe_reservation_write_v1"('stock_event');
CREATE TRIGGER "pos_manual_t2_promotion_reservation_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON public."pos_manual_application_promotion_reservations"
  FOR EACH ROW EXECUTE FUNCTION public."pos_manual_t2_observe_reservation_write_v1"('promotion_reservation');
CREATE TRIGGER "pos_manual_t2_promotion_event_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON public."pos_manual_application_promotion_reservation_events"
  FOR EACH ROW EXECUTE FUNCTION public."pos_manual_t2_observe_reservation_write_v1"('promotion_event');
CREATE TRIGGER "pos_manual_t2_reserve_assertion_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON public."pos_manual_application_reserve_assertions"
  FOR EACH ROW EXECUTE FUNCTION public."pos_manual_t2_observe_reservation_write_v1"('reserve_assertion');
CREATE TRIGGER "pos_manual_t2_release_assertion_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON public."pos_manual_application_release_assertions"
  FOR EACH ROW EXECUTE FUNCTION public."pos_manual_t2_observe_reservation_write_v1"('release_assertion');
CREATE TRIGGER "pos_manual_t2_sweep_batch_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON public."pos_manual_application_sweep_batches"
  FOR EACH ROW EXECUTE FUNCTION public."pos_manual_t2_observe_reservation_write_v1"('sweep_batch');
CREATE TRIGGER "pos_manual_t2_sweep_receipt_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON public."pos_manual_application_sweep_receipts"
  FOR EACH ROW EXECUTE FUNCTION public."pos_manual_t2_observe_reservation_write_v1"('sweep_receipt');
CREATE TRIGGER "pos_manual_t2_boundary_operation_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON public."pos_manual_t2_boundary_operations"
  FOR EACH ROW EXECUTE FUNCTION public."pos_manual_t2_observe_reservation_write_v1"('boundary_operation');

CREATE FUNCTION public."pos_manual_t2_verify_reserve_graph_v1"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE app public."pos_manual_payment_applications"%ROWTYPE; assertion public."pos_manual_application_reserve_assertions"%ROWTYPE;
  snapshot public."pos_manual_application_snapshots"%ROWTYPE; stock_count integer; promo_count integer;
  stock_quantity bigint; reserve_event_count integer; operation_row public."pos_manual_payment_operations"%ROWTYPE;
  state_event_row public."pos_manual_payment_state_events"%ROWTYPE; case_row public."pos_manual_payment_cases"%ROWTYPE;
  target_application_id uuid;
BEGIN
  target_application_id:=CASE WHEN TG_TABLE_NAME='pos_manual_payment_applications' THEN NEW."id" ELSE NEW."application_id" END;
  SELECT * INTO app FROM public."pos_manual_payment_applications" WHERE "id"=target_application_id;
  IF app.id IS NULL OR app.state NOT IN ('pending','claimed') THEN RETURN NULL; END IF;
  SELECT * INTO assertion FROM public."pos_manual_application_reserve_assertions" WHERE "application_id"=app.id;
  SELECT * INTO snapshot FROM public."pos_manual_application_snapshots" WHERE "application_id"=app.id;
  IF assertion.application_id IS NULL OR snapshot.application_id IS NULL THEN
    RAISE EXCEPTION 'T2 reserve graph is incomplete' USING ERRCODE='23514'; END IF;
  SELECT pg_catalog.count(*)::integer,COALESCE(pg_catalog.sum("quantity_micros"),0)::bigint
    INTO stock_count,stock_quantity FROM public."pos_manual_application_stock_reservations" WHERE "application_id"=app.id;
  SELECT pg_catalog.count(*)::integer INTO promo_count FROM public."pos_manual_application_promotion_reservations" WHERE "application_id"=app.id;
  SELECT pg_catalog.count(*)::integer INTO reserve_event_count FROM (
    SELECT "id" FROM public."pos_manual_application_stock_reservation_events" WHERE "application_id"=app.id AND "action"='reserve' AND "sequence"=0
    UNION ALL SELECT "id" FROM public."pos_manual_application_promotion_reservation_events" WHERE "application_id"=app.id AND "action"='reserve' AND "sequence"=0) events;
  SELECT * INTO operation_row FROM public."pos_manual_payment_operations" WHERE "id"=assertion.reserve_operation_id;
  SELECT * INTO state_event_row FROM public."pos_manual_payment_state_events" WHERE "id"=assertion.reserve_state_event_id;
  SELECT * INTO case_row FROM public."pos_manual_payment_cases" WHERE "id"=app.case_id;
  IF stock_count<>assertion.stock_reservation_count OR stock_quantity<>assertion.stock_quantity_micros
    OR promo_count<>assertion.promotion_reservation_count OR reserve_event_count<>stock_count+promo_count
    OR assertion.stock_multiset_hash IS DISTINCT FROM public."pos_manual_hash_canonical_json_v1"('t2-stock-multiset-v1',pg_catalog.jsonb_build_object('reservations',snapshot.inventory_promotion->'inventoryReservations','schemaVersion',1))
    OR assertion.promotion_multiset_hash IS DISTINCT FROM public."pos_manual_hash_canonical_json_v1"('t2-promotion-multiset-v1',pg_catalog.jsonb_build_object('reservations',snapshot.inventory_promotion->'promotionReservations','schemaVersion',1))
    OR assertion.reservation_graph_hash IS DISTINCT FROM public."pos_manual_hash_canonical_json_v1"('t2-reservation-graph-v1',pg_catalog.jsonb_build_object('applicationId',app.id,'inventoryPromotionHash',snapshot.inventory_promotion_hash,'promotionMultisetHash',assertion.promotion_multiset_hash,'schemaVersion',1,'stockMultisetHash',assertion.stock_multiset_hash))
    OR assertion.reserve_txid<>app.reserve_txid OR snapshot.reserve_txid<>app.reserve_txid
    OR EXISTS (SELECT 1 FROM public."pos_manual_application_stock_reservations" WHERE "application_id"=app.id AND ("reserve_txid"<>app.reserve_txid OR "expires_at"<>app.reservation_expires_at OR "state"<>'reserved'))
    OR EXISTS (SELECT 1 FROM public."pos_manual_application_promotion_reservations" WHERE "application_id"=app.id AND ("reserve_txid"<>app.reserve_txid OR "expires_at"<>app.reservation_expires_at OR "state"<>'reserved'))
    OR operation_row.id IS NULL OR operation_row.action<>'reserve_application' OR operation_row.application_id<>app.id OR operation_row.write_txid<>app.reserve_txid
    OR state_event_row.id IS NULL OR state_event_row.operation_id<>operation_row.id OR state_event_row.to_state<>'application_pending' OR state_event_row.write_txid<>app.reserve_txid
    OR case_row.id IS NULL OR case_row.state<>'application_pending' OR case_row.version<>app.case_version_after_reserve
  THEN RAISE EXCEPTION 'T2 reserve graph assertion mismatch' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END
$function$;

CREATE CONSTRAINT TRIGGER "pos_manual_t2_reserve_graph_commit"
  AFTER INSERT OR UPDATE ON public."pos_manual_payment_applications"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public."pos_manual_t2_verify_reserve_graph_v1"();
CREATE CONSTRAINT TRIGGER "pos_manual_t2_reserve_assertion_commit"
  AFTER INSERT ON public."pos_manual_application_reserve_assertions"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public."pos_manual_t2_verify_reserve_graph_v1"();

CREATE FUNCTION public."pos_manual_t2_verify_release_graph_v1"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE app public."pos_manual_payment_applications"%ROWTYPE; manual_case public."pos_manual_payment_cases"%ROWTYPE;
  operation_row public."pos_manual_payment_operations"%ROWTYPE; event_row public."pos_manual_payment_state_events"%ROWTYPE;
  incident_row public."pos_manual_payment_incidents"%ROWTYPE; receipt public."pos_manual_application_sweep_receipts"%ROWTYPE;
  stock_rows jsonb; promotion_rows jsonb; stock_count integer; promotion_count integer;
BEGIN
  SELECT * INTO app FROM public."pos_manual_payment_applications" WHERE "id"=NEW."application_id";
  SELECT * INTO manual_case FROM public."pos_manual_payment_cases" WHERE "id"=app.case_id;
  SELECT * INTO operation_row FROM public."pos_manual_payment_operations" WHERE "id"=NEW."release_operation_id";
  SELECT * INTO event_row FROM public."pos_manual_payment_state_events" WHERE "id"=NEW."release_state_event_id";
  SELECT * INTO incident_row FROM public."pos_manual_payment_incidents" WHERE "id"=NEW."release_incident_id";
  SELECT pg_catalog.count(*)::integer,COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'eventId',event.id,'quantityMicros',reservation.quantity_micros,'releaseReason',event.reason_code,
      'reservationId',reservation.id,'reservationKey',reservation.reservation_key,'sequence',event.sequence,
      'stateAfter',event.state_after) ORDER BY reservation.id::text COLLATE "C"),'[]'::jsonb)
    INTO stock_count,stock_rows
    FROM public."pos_manual_application_stock_reservations" reservation
    JOIN public."pos_manual_application_stock_reservation_events" event
      ON event.reservation_id=reservation.id AND event.application_id=reservation.application_id
     AND event.action='release' AND event.sequence=1
   WHERE reservation.application_id=NEW.application_id AND reservation.state='released';
  SELECT pg_catalog.count(*)::integer,COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'couponLiveAfter',event.coupon_live_after,'couponLiveBefore',event.coupon_live_before,
      'couponUsedAfter',event.coupon_used_after,'couponUsedBefore',event.coupon_used_before,
      'customerLiveAfter',event.customer_live_after,'customerLiveBefore',event.customer_live_before,
      'customerUsedAfter',event.customer_used_after,'customerUsedBefore',event.customer_used_before,
      'discountCents',event.discount_cents,'eventId',event.id,'globalLiveAfter',event.global_live_after,
      'globalLiveBefore',event.global_live_before,'globalUsedAfter',event.global_used_after,
      'globalUsedBefore',event.global_used_before,'releaseReason',event.reason_code,
      'reservationId',reservation.id,'reservationKey',reservation.reservation_key,
      'sequence',event.sequence,'stateAfter',event.state_after) ORDER BY reservation.id::text COLLATE "C"),'[]'::jsonb)
    INTO promotion_count,promotion_rows
    FROM public."pos_manual_application_promotion_reservations" reservation
    JOIN public."pos_manual_application_promotion_reservation_events" event
      ON event.reservation_id=reservation.id AND event.application_id=reservation.application_id
     AND event.action='release' AND event.sequence=1
   WHERE reservation.application_id=NEW.application_id AND reservation.state='released';
  IF app.id IS NULL OR app.state<>'blocked' OR app.failure_class<>NEW.release_reason OR app.blocked_code<>NEW.release_reason
    OR manual_case.id IS NULL OR manual_case.state<>'blocked'
    OR EXISTS (SELECT 1 FROM public."pos_manual_application_stock_reservations" WHERE application_id=NEW.application_id AND state='reserved')
    OR EXISTS (SELECT 1 FROM public."pos_manual_application_promotion_reservations" WHERE application_id=NEW.application_id AND state='reserved')
    OR stock_count<>NEW.stock_released_count OR promotion_count<>NEW.promotion_released_count
    OR NEW.stock_release_multiset_hash IS DISTINCT FROM public."pos_manual_hash_canonical_json_v1"('t2-stock-release-multiset-v1',pg_catalog.jsonb_build_object('reservations',stock_rows,'schemaVersion',1))
    OR NEW.promotion_release_multiset_hash IS DISTINCT FROM public."pos_manual_hash_canonical_json_v1"('t2-promotion-release-multiset-v1',pg_catalog.jsonb_build_object('reservations',promotion_rows,'schemaVersion',1))
    OR operation_row.id IS NULL OR operation_row.application_id<>NEW.application_id
    OR operation_row.action IS DISTINCT FROM (CASE WHEN NEW.release_source='sweep_expired' THEN 'sweep_expired_application' ELSE 'block' END)
    OR operation_row.write_txid<>NEW.release_txid OR operation_row.fencing_token_before<>NEW.fencing_token_before
    OR event_row.id IS NULL OR event_row.operation_id<>operation_row.id OR event_row.write_txid<>NEW.release_txid
    OR incident_row.id IS NULL OR incident_row.manual_application_id<>NEW.application_id
    OR incident_row.write_txid<>NEW.release_txid OR incident_row.fencing_token_before<>NEW.fencing_token_before
  THEN RAISE EXCEPTION 'T2 release graph assertion mismatch' USING ERRCODE='23514'; END IF;
  IF NEW.release_source='sweep_expired' THEN
    SELECT * INTO receipt FROM public."pos_manual_application_sweep_receipts" WHERE id=NEW.source_sweep_receipt_id;
    IF receipt.id IS NULL OR receipt.batch_id<>NEW.source_sweep_batch_id OR receipt.application_id<>NEW.application_id
      OR receipt.fencing_token_before<>NEW.fencing_token_before OR receipt.stock_reservation_count<>stock_count
      OR receipt.promotion_reservation_count<>promotion_count OR receipt.release_graph_hash<>NEW.release_graph_hash
      OR operation_row.source_sweep_receipt_id<>receipt.id OR event_row.source_sweep_receipt_id<>receipt.id
      OR incident_row.source_sweep_receipt_id<>receipt.id THEN
      RAISE EXCEPTION 'T2 sweep receipt does not seal release graph' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NULL;
END
$function$;

CREATE CONSTRAINT TRIGGER "pos_manual_t2_release_assertion_commit"
  AFTER INSERT ON public."pos_manual_application_release_assertions"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public."pos_manual_t2_verify_release_graph_v1"();

CREATE FUNCTION public."pos_manual_t2_stamp_product_boundary_v1"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE changed boolean;
BEGIN
  changed:=TG_OP='INSERT' OR ROW(NEW.active,NEW.gtin,NEW.id,NEW.manage_stock,NEW.name,NEW.type,NEW.sku,NEW.status,NEW.unit)
    IS DISTINCT FROM ROW(OLD.active,OLD.gtin,OLD.id,OLD.manage_stock,OLD.name,OLD.type,OLD.sku,OLD.status,OLD.unit);
  IF TG_OP='INSERT' THEN NEW.pos_revision:=1;
  ELSIF changed THEN NEW.pos_revision:=OLD.pos_revision+1;
  ELSE NEW.pos_revision:=OLD.pos_revision; NEW.pos_config_hash:=OLD.pos_config_hash; RETURN NEW; END IF;
  NEW.pos_config_hash:=public."pos_manual_hash_canonical_json_v1"('t2-catalog-product-v1',pg_catalog.jsonb_build_object(
    'active',NEW.active,'gtinSnapshot',NEW.gtin,'manageStock',NEW.manage_stock,'nameLabel',NEW.name,
    'posRevision',NEW.pos_revision,'productId',NEW.id,'productType',NEW.type,'schemaVersion',1,
    'skuSnapshot',NEW.sku,'status',NEW.status,'unit',NEW.unit));
  RETURN NEW;
END
$function$;

CREATE FUNCTION public."pos_manual_t2_stamp_variation_boundary_v1"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE changed boolean;
BEGIN
  changed:=TG_OP='INSERT' OR ROW(NEW.enabled,NEW.gtin,NEW.id,NEW.manage_stock,NEW.menu_order,NEW.product_id,NEW.sku,NEW.status)
    IS DISTINCT FROM ROW(OLD.enabled,OLD.gtin,OLD.id,OLD.manage_stock,OLD.menu_order,OLD.product_id,OLD.sku,OLD.status);
  IF TG_OP='INSERT' THEN NEW.pos_revision:=1;
  ELSIF changed THEN NEW.pos_revision:=OLD.pos_revision+1;
  ELSE NEW.pos_revision:=OLD.pos_revision; NEW.pos_config_hash:=OLD.pos_config_hash; RETURN NEW; END IF;
  NEW.pos_config_hash:=public."pos_manual_hash_canonical_json_v1"('t2-catalog-variation-v1',pg_catalog.jsonb_build_object(
    'enabled',NEW.enabled,'gtinSnapshot',NEW.gtin,'manageStock',NEW.manage_stock,
    'posRevision',NEW.pos_revision,'productId',NEW.product_id,'schemaVersion',1,
    'skuSnapshot',NEW.sku,'status',NEW.status,'variationId',NEW.id));
  RETURN NEW;
END
$function$;

CREATE FUNCTION public."pos_manual_t2_stamp_value_program_boundary_v1"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE changed boolean;
BEGIN
  changed:=TG_OP='INSERT' OR ROW(NEW.branch_id,NEW.earn_units,NEW.expires_after_days,NEW.kind,NEW.id,NEW.name,
      NEW.redeem_cents_per_unit,NEW.spend_cents,NEW.status)
    IS DISTINCT FROM ROW(OLD.branch_id,OLD.earn_units,OLD.expires_after_days,OLD.kind,OLD.id,OLD.name,
      OLD.redeem_cents_per_unit,OLD.spend_cents,OLD.status);
  IF TG_OP='INSERT' THEN NEW.revision:=1;
  ELSIF changed THEN NEW.revision:=OLD.revision+1;
  ELSE NEW.revision:=OLD.revision; NEW.config_hash:=OLD.config_hash; RETURN NEW; END IF;
  NEW.config_hash:=public."pos_manual_hash_canonical_json_v1"('t2-value-program-v1',pg_catalog.jsonb_build_object(
    'branchId',NEW.branch_id,'earnUnits',NEW.earn_units,'expiresAfterDays',NEW.expires_after_days,
    'kind',NEW.kind,'programId',NEW.id,'revision',NEW.revision,'schemaVersion',1,
    'spendCents',NEW.spend_cents,'status',NEW.status));
  RETURN NEW;
END
$function$;

CREATE FUNCTION public."pos_manual_t2_stamp_accounting_period_boundary_v1"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE changed boolean;
BEGIN
  changed:=TG_OP='INSERT' OR ROW(NEW.branch_id,NEW.closed_at,NEW.closed_by,NEW.close_reason,NEW.currency,NEW.ends_at,
      NEW.month,NEW.id,NEW.starts_at,NEW.status,NEW.year)
    IS DISTINCT FROM ROW(OLD.branch_id,OLD.closed_at,OLD.closed_by,OLD.close_reason,OLD.currency,OLD.ends_at,
      OLD.month,OLD.id,OLD.starts_at,OLD.status,OLD.year);
  IF TG_OP='INSERT' THEN NEW.revision:=1;
  ELSIF changed THEN NEW.revision:=OLD.revision+1;
  ELSE NEW.revision:=OLD.revision; NEW.config_hash:=OLD.config_hash; RETURN NEW; END IF;
  NEW.config_hash:=public."pos_manual_hash_canonical_json_v1"('t2-accounting-period-v1',pg_catalog.jsonb_build_object(
    'branchId',NEW.branch_id,'currency',NEW.currency,'endsOn',NEW.ends_at,'month',NEW.month,
    'periodId',NEW.id,'revision',NEW.revision,'schemaVersion',1,'startsOn',NEW.starts_at,
    'status',NEW.status,'year',NEW.year));
  RETURN NEW;
END
$function$;

CREATE FUNCTION public."pos_manual_t2_stamp_accounting_mapping_boundary_v1"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
  NEW.config_hash:=public."pos_manual_hash_canonical_json_v1"('t2-accounting-mapping-v1',pg_catalog.jsonb_build_object(
    'accountId',NEW.account_id,'direction',NEW.direction,'entryKey',NEW.entry_key,
    'mappingId',NEW.id,'policyId',NEW.policy_id,'schemaVersion',1,'sourceType',NEW.source_type));
  RETURN NEW;
END
$function$;

CREATE FUNCTION public."pos_manual_t2_stamp_webhook_boundary_v1"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
  IF TG_OP='INSERT' THEN
    NEW.logical_id:=COALESCE(NEW.logical_id,NEW.id); NEW.version:=COALESCE(NEW.version,1);
    IF NEW.version<>1 AND NEW.logical_id=NEW.id THEN
      RAISE EXCEPTION 'versioned webhook endpoint requires its owner producer' USING ERRCODE='42501'; END IF;
  ELSIF ROW(NEW.logical_id,NEW.version,NEW.delivery_url,NEW.name,NEW.secret_cipher,NEW.secret_preview,NEW.status,NEW.topic,NEW.api_version)
    IS DISTINCT FROM ROW(OLD.logical_id,OLD.version,OLD.delivery_url,OLD.name,OLD.secret_cipher,OLD.secret_preview,OLD.status,OLD.topic,OLD.api_version) THEN
    RAISE EXCEPTION 'historical webhook endpoint configuration is immutable' USING ERRCODE='23514';
  ELSE NEW.config_hash:=OLD.config_hash; RETURN NEW; END IF;
  NEW.config_hash:=public."pos_manual_hash_canonical_json_v1"('t2-webhook-config-v1',pg_catalog.jsonb_build_object(
    'apiVersion',NEW.api_version,'deliveryUrl',NEW.delivery_url,'endpointId',NEW.logical_id,
    'schemaVersion',1,'secretCipher',NEW.secret_cipher,'status',NEW.status,'topic',NEW.topic,'version',NEW.version));
  RETURN NEW;
END
$function$;

CREATE TRIGGER "pos_manual_t2_a_product_boundary_stamp" BEFORE INSERT OR UPDATE ON public."products"
  FOR EACH ROW EXECUTE FUNCTION public."pos_manual_t2_stamp_product_boundary_v1"();
CREATE TRIGGER "pos_manual_t2_z_product_boundary_insert_guard" BEFORE INSERT ON public."products"
  FOR EACH ROW EXECUTE FUNCTION public."pos_manual_t2_observe_reservation_write_v1"('boundary_product');
CREATE TRIGGER "pos_manual_t2_z_product_boundary_update_guard" BEFORE UPDATE ON public."products"
  FOR EACH ROW WHEN (ROW(NEW.active,NEW.gtin,NEW.id,NEW.manage_stock,NEW.name,NEW.type,NEW.sku,NEW.status,NEW.unit)
    IS DISTINCT FROM ROW(OLD.active,OLD.gtin,OLD.id,OLD.manage_stock,OLD.name,OLD.type,OLD.sku,OLD.status,OLD.unit))
  EXECUTE FUNCTION public."pos_manual_t2_observe_reservation_write_v1"('boundary_product');
CREATE TRIGGER "pos_manual_t2_a_variation_boundary_stamp" BEFORE INSERT OR UPDATE ON public."product_variations"
  FOR EACH ROW EXECUTE FUNCTION public."pos_manual_t2_stamp_variation_boundary_v1"();
CREATE TRIGGER "pos_manual_t2_z_variation_boundary_insert_guard" BEFORE INSERT ON public."product_variations"
  FOR EACH ROW EXECUTE FUNCTION public."pos_manual_t2_observe_reservation_write_v1"('boundary_variation');
CREATE TRIGGER "pos_manual_t2_z_variation_boundary_update_guard" BEFORE UPDATE ON public."product_variations"
  FOR EACH ROW WHEN (ROW(NEW.enabled,NEW.gtin,NEW.id,NEW.manage_stock,NEW.menu_order,NEW.product_id,NEW.sku,NEW.status)
    IS DISTINCT FROM ROW(OLD.enabled,OLD.gtin,OLD.id,OLD.manage_stock,OLD.menu_order,OLD.product_id,OLD.sku,OLD.status))
  EXECUTE FUNCTION public."pos_manual_t2_observe_reservation_write_v1"('boundary_variation');
CREATE TRIGGER "pos_manual_t2_z_variation_boundary_delete_guard" BEFORE DELETE ON public."product_variations"
  FOR EACH ROW EXECUTE FUNCTION public."pos_manual_t2_observe_reservation_write_v1"('boundary_variation');
CREATE TRIGGER "pos_manual_t2_a_value_program_boundary_stamp" BEFORE INSERT OR UPDATE ON public."pos_value_programs"
  FOR EACH ROW EXECUTE FUNCTION public."pos_manual_t2_stamp_value_program_boundary_v1"();
CREATE TRIGGER "pos_manual_t2_z_value_program_boundary_insert_guard" BEFORE INSERT ON public."pos_value_programs"
  FOR EACH ROW EXECUTE FUNCTION public."pos_manual_t2_observe_reservation_write_v1"('boundary_value_program');
CREATE TRIGGER "pos_manual_t2_z_value_program_boundary_update_guard" BEFORE UPDATE ON public."pos_value_programs"
  FOR EACH ROW WHEN (ROW(NEW.branch_id,NEW.earn_units,NEW.expires_after_days,NEW.kind,NEW.id,NEW.name,
      NEW.redeem_cents_per_unit,NEW.spend_cents,NEW.status)
    IS DISTINCT FROM ROW(OLD.branch_id,OLD.earn_units,OLD.expires_after_days,OLD.kind,OLD.id,OLD.name,
      OLD.redeem_cents_per_unit,OLD.spend_cents,OLD.status))
  EXECUTE FUNCTION public."pos_manual_t2_observe_reservation_write_v1"('boundary_value_program');
CREATE TRIGGER "pos_manual_t2_a_accounting_period_boundary_stamp" BEFORE INSERT OR UPDATE ON public."pos_accounting_periods"
  FOR EACH ROW EXECUTE FUNCTION public."pos_manual_t2_stamp_accounting_period_boundary_v1"();
CREATE TRIGGER "pos_manual_t2_z_accounting_period_boundary_insert_guard" BEFORE INSERT ON public."pos_accounting_periods"
  FOR EACH ROW EXECUTE FUNCTION public."pos_manual_t2_observe_reservation_write_v1"('boundary_period');
CREATE TRIGGER "pos_manual_t2_z_accounting_period_boundary_update_guard" BEFORE UPDATE ON public."pos_accounting_periods"
  FOR EACH ROW WHEN (ROW(NEW.branch_id,NEW.closed_at,NEW.closed_by,NEW.close_reason,NEW.currency,NEW.ends_at,
      NEW.month,NEW.id,NEW.starts_at,NEW.status,NEW.year)
    IS DISTINCT FROM ROW(OLD.branch_id,OLD.closed_at,OLD.closed_by,OLD.close_reason,OLD.currency,OLD.ends_at,
      OLD.month,OLD.id,OLD.starts_at,OLD.status,OLD.year))
  EXECUTE FUNCTION public."pos_manual_t2_observe_reservation_write_v1"('boundary_period');
CREATE TRIGGER "pos_manual_t2_a_accounting_mapping_boundary_stamp" BEFORE INSERT OR UPDATE ON public."pos_accounting_policy_mappings"
  FOR EACH ROW EXECUTE FUNCTION public."pos_manual_t2_stamp_accounting_mapping_boundary_v1"();
CREATE TRIGGER "pos_manual_t2_z_accounting_mapping_boundary_insert_guard" BEFORE INSERT ON public."pos_accounting_policy_mappings"
  FOR EACH ROW EXECUTE FUNCTION public."pos_manual_t2_observe_reservation_write_v1"('boundary_mapping');
CREATE TRIGGER "pos_manual_t2_z_accounting_mapping_boundary_update_guard" BEFORE UPDATE ON public."pos_accounting_policy_mappings"
  FOR EACH ROW WHEN (ROW(NEW.account_id,NEW.direction,NEW.entry_key,NEW.id,NEW.policy_id,NEW.source_type)
    IS DISTINCT FROM ROW(OLD.account_id,OLD.direction,OLD.entry_key,OLD.id,OLD.policy_id,OLD.source_type))
  EXECUTE FUNCTION public."pos_manual_t2_observe_reservation_write_v1"('boundary_mapping');
CREATE TRIGGER "pos_manual_t2_a_webhook_boundary_stamp" BEFORE INSERT OR UPDATE OF "id","logical_id","version","delivery_url","name","secret_cipher","secret_preview","status","topic","api_version","config_hash","superseded_at" ON public."integration_webhook_endpoints"
  FOR EACH ROW EXECUTE FUNCTION public."pos_manual_t2_stamp_webhook_boundary_v1"();
CREATE TRIGGER "pos_manual_t2_z_webhook_boundary_guard" BEFORE INSERT OR UPDATE OF "id","logical_id","version","delivery_url","name","secret_cipher","secret_preview","status","topic","api_version","config_hash","superseded_at" ON public."integration_webhook_endpoints"
  FOR EACH ROW EXECUTE FUNCTION public."pos_manual_t2_observe_reservation_write_v1"('boundary_webhook');

CREATE TRIGGER "pos_manual_t2_stock_events_append_only" BEFORE UPDATE OR DELETE ON public."pos_manual_application_stock_reservation_events"
  FOR EACH ROW EXECUTE FUNCTION public."protect_pos_manual_append_only"();
CREATE TRIGGER "pos_manual_t2_promotion_events_append_only" BEFORE UPDATE OR DELETE ON public."pos_manual_application_promotion_reservation_events"
  FOR EACH ROW EXECUTE FUNCTION public."protect_pos_manual_append_only"();
CREATE TRIGGER "pos_manual_t2_reserve_assertions_append_only" BEFORE UPDATE OR DELETE ON public."pos_manual_application_reserve_assertions"
  FOR EACH ROW EXECUTE FUNCTION public."protect_pos_manual_append_only"();
CREATE TRIGGER "pos_manual_t2_release_assertions_append_only" BEFORE UPDATE OR DELETE ON public."pos_manual_application_release_assertions"
  FOR EACH ROW EXECUTE FUNCTION public."protect_pos_manual_append_only"();
CREATE TRIGGER "pos_manual_t2_sweep_batches_append_only" BEFORE UPDATE OR DELETE ON public."pos_manual_application_sweep_batches"
  FOR EACH ROW EXECUTE FUNCTION public."protect_pos_manual_append_only"();
CREATE TRIGGER "pos_manual_t2_sweep_receipts_append_only" BEFORE UPDATE OR DELETE ON public."pos_manual_application_sweep_receipts"
  FOR EACH ROW EXECUTE FUNCTION public."protect_pos_manual_append_only"();
CREATE TRIGGER "pos_manual_t2_boundary_operations_append_only" BEFORE UPDATE OR DELETE ON public."pos_manual_t2_boundary_operations"
  FOR EACH ROW EXECUTE FUNCTION public."protect_pos_manual_append_only"();
CREATE TRIGGER "pos_manual_t2_product_delete_forbidden" BEFORE DELETE ON public."products"
  FOR EACH ROW EXECUTE FUNCTION public."protect_pos_manual_append_only"();
CREATE TRIGGER "pos_manual_t2_value_program_delete_forbidden" BEFORE DELETE ON public."pos_value_programs"
  FOR EACH ROW EXECUTE FUNCTION public."protect_pos_manual_append_only"();
CREATE TRIGGER "pos_manual_t2_accounting_mapping_delete_forbidden" BEFORE DELETE ON public."pos_accounting_policy_mappings"
  FOR EACH ROW EXECUTE FUNCTION public."protect_pos_manual_append_only"();
CREATE TRIGGER "pos_manual_t2_webhook_delete_forbidden" BEFORE DELETE ON public."integration_webhook_endpoints"
  FOR EACH ROW EXECUTE FUNCTION public."protect_pos_manual_append_only"();

CREATE FUNCTION public."pos_manual_t2_effect_key_v1"(p_kind text,p_identity jsonb)
RETURNS text LANGUAGE sql IMMUTABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
  SELECT p_kind||':'||public."pos_manual_hash_canonical_json_v1"('t2-effect-key-v1',
    pg_catalog.jsonb_build_object('effectKind',p_kind,'identity',p_identity,'schemaVersion',1))
$function$;

CREATE FUNCTION public."pos_manual_t2_effect_manifest_v1"(
  p_kind text,p_key text,p_payload jsonb,p_cardinality integer,p_required boolean
)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE expected_hash text;
BEGIN
  IF p_cardinality NOT IN (0,1) OR p_required IS DISTINCT FROM (p_cardinality=1) THEN
    RAISE EXCEPTION 'invalid T2 effect cardinality' USING ERRCODE='22023'; END IF;
  expected_hash:=public."pos_manual_hash_canonical_json_v1"('t2-effect-v1',
    pg_catalog.jsonb_build_object('effectKey',p_key,'effectKind',p_kind,'payload',p_payload,'schemaVersion',1));
  RETURN pg_catalog.jsonb_build_object('effectKey',p_key,'effectKind',p_kind,
    'expectedCardinality',p_cardinality,'expectedHash',expected_hash,'required',p_required);
END
$function$;

CREATE FUNCTION public."pos_manual_t2_plain_canonical_sha256_v1"(p_value jsonb)
RETURNS text LANGUAGE sql IMMUTABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
  SELECT pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to(public."pos_manual_canonical_json_v1"(p_value),'UTF8')),'hex')
$function$;

CREATE FUNCTION public."pos_manual_t2_tracking_identity_v1"(p_value text)
RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE normalized text;
BEGIN
  IF pg_catalog.octet_length(p_value) NOT BETWEEN 1 AND 200 OR p_value<>normalize(p_value,NFC)
    OR p_value~'[[:cntrl:]]' THEN
    RAISE EXCEPTION 'invalid T2 tracking identity' USING ERRCODE='22023'; END IF;
  normalized:=pg_catalog.upper(pg_catalog.regexp_replace(normalize(p_value,NFKC),'[[:space:]]','','g'));
  IF normalized='' THEN RAISE EXCEPTION 'invalid T2 tracking identity' USING ERRCODE='22023'; END IF;
  RETURN normalized;
END
$function$;

-- Expand the immutable active BOM graph after the caller has locked all
-- active roots/components.  The result contains only integer-micros leaves
-- and the exact component projection consumed by catalog_bom_tracking.
CREATE FUNCTION public."pos_manual_t2_expand_bom_v1"(
  p_plan_id text,p_branch_id integer,p_decision_at timestamptz
)
RETURNS jsonb LANGUAGE plpgsql STABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE result_doc jsonb; ambiguous boolean; root_count integer; leaf_count integer;
BEGIN
  SELECT pg_catalog.count(*)::integer INTO root_count
    FROM public."pos_kit_boms" bom
   WHERE bom."branch_id"=p_branch_id AND bom."status"='active'
     AND (bom."effective_from" IS NULL OR bom."effective_from"<=p_decision_at);
  IF root_count>500 THEN RAISE EXCEPTION 'T2 reserve graph exceeds limit' USING ERRCODE='22023'; END IF;
  SELECT EXISTS (
    SELECT 1 FROM public."pos_kit_boms" bom
     WHERE bom."branch_id"=p_branch_id AND bom."status"='active'
       AND (bom."effective_from" IS NULL OR bom."effective_from"<=p_decision_at)
     GROUP BY bom."kit_product_id",bom."kit_variation_id" HAVING pg_catalog.count(*)<>1
  ) INTO ambiguous;
  IF ambiguous THEN RAISE EXCEPTION 'T2 snapshot multiset is ambiguous' USING ERRCODE='23514'; END IF;

  WITH RECURSIVE walk AS (
    SELECT line."line_index" AS root_line_index,line."held_sale_item_id",
      line."product_id",line."variation_id",
      public."pos_manual_t2_float_to_micros_v1"(line."quantity") AS quantity_micros,
      NULL::text AS component_scope_key,0 AS depth,
      ARRAY[line."product_id"::text||':'||COALESCE(line."variation_id"::text,'null')]::text[] AS path,
      NULL::text AS bom_id,NULL::integer AS bom_version,NULL::integer AS component_index,
      NULL::bigint AS unit_quantity_micros
      FROM public."pos_payment_plan_quote_lines" line WHERE line."plan_id"=p_plan_id
    UNION ALL
    SELECT parent.root_line_index,parent.held_sale_item_id,component."product_id",component."variation_id",
      ((parent.quantity_micros::numeric*component."quantity_micros"::numeric)/1000000)::bigint,
      component."component_scope_key",parent.depth+1,
      parent.path||(component."product_id"::text||':'||COALESCE(component."variation_id"::text,'null')),
      bom."id",bom."version",component."position",component."quantity_micros"
      FROM walk parent
      JOIN public."pos_kit_boms" bom
        ON bom."branch_id"=p_branch_id AND bom."kit_product_id"=parent.product_id
       AND bom."kit_variation_id" IS NOT DISTINCT FROM parent.variation_id
       AND bom."status"='active' AND (bom."effective_from" IS NULL OR bom."effective_from"<=p_decision_at)
      JOIN public."pos_kit_bom_components" component ON component."bom_id"=bom."id"
     WHERE parent.depth<8
       AND NOT (component."product_id"::text||':'||COALESCE(component."variation_id"::text,'null')=ANY(parent.path))
       AND (parent.quantity_micros::numeric*component."quantity_micros"::numeric)%1000000=0
  ), marked AS (
    SELECT node.*,EXISTS (
      SELECT 1 FROM public."pos_kit_boms" child
       WHERE child."branch_id"=p_branch_id AND child."kit_product_id"=node.product_id
         AND child."kit_variation_id" IS NOT DISTINCT FROM node.variation_id
         AND child."status"='active' AND (child."effective_from" IS NULL OR child."effective_from"<=p_decision_at)
    ) AS expands FROM walk node
  ), aggregates AS (
    SELECT
      COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'bomId',marked.bom_id,'bomVersion',marked.bom_version,'componentIndex',marked.component_index,
        'depth',marked.depth,'productId',marked.product_id,'quantityMicros',marked.quantity_micros,
        'rootLineIndex',marked.root_line_index,'scopeKey',marked.component_scope_key,
        'unitQuantityMicros',marked.unit_quantity_micros,'variationId',marked.variation_id)
        ORDER BY marked.root_line_index,marked.depth,marked.component_scope_key COLLATE "C",marked.component_index,
          marked.product_id,marked.variation_id NULLS LAST,marked.unit_quantity_micros,marked.quantity_micros)
        FILTER (WHERE marked.depth>0),'[]'::jsonb) AS bom,
      COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'componentScopeKey',marked.component_scope_key,'heldSaleItemId',marked.held_sale_item_id,
        'productId',marked.product_id,'quantityMicros',marked.quantity_micros,
        'quoteLineIndex',marked.root_line_index,'variationId',marked.variation_id)
        ORDER BY marked.root_line_index,marked.component_scope_key COLLATE "C",marked.product_id,
          marked.variation_id NULLS LAST) FILTER (WHERE NOT marked.expands),'[]'::jsonb) AS leaves,
      pg_catalog.count(*) FILTER (WHERE NOT marked.expands)::integer AS leaf_count,
      pg_catalog.bool_or(marked.depth=8 AND marked.expands) AS too_deep
      FROM marked
  ) SELECT pg_catalog.jsonb_build_object('bom',bom,'leaves',leaves),leaf_count,
      COALESCE(too_deep,false) INTO result_doc,leaf_count,ambiguous FROM aggregates;
  IF ambiguous THEN RAISE EXCEPTION 'T2 BOM depth exceeds limit' USING ERRCODE='22023'; END IF;
  IF leaf_count>200 THEN RAISE EXCEPTION 'T2 reserve graph exceeds limit' USING ERRCODE='22023'; END IF;
  IF EXISTS (
    WITH leaves AS (SELECT value item FROM pg_catalog.jsonb_array_elements(result_doc->'leaves'))
    SELECT 1 FROM leaves GROUP BY item->>'quoteLineIndex',item->>'componentScopeKey',item->>'productId',item->>'variationId'
    HAVING pg_catalog.count(*)<>1
  ) THEN RAISE EXCEPTION 'T2 snapshot multiset is ambiguous' USING ERRCODE='23514'; END IF;
  RETURN result_doc;
END
$function$;

-- Closed boundary-producer primitives.  The public ABIs below are the only
-- grantable entry points; these helpers remain owner-only.
CREATE FUNCTION public."pos_manual_t2_boundary_actor_v1"(
  p_actor_user_id text,p_permission text,p_require_admin boolean
)
RETURNS boolean LANGUAGE plpgsql VOLATILE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE authorized boolean:=false;
BEGIN
  IF NOT public."pos_manual_t2_subject_safe_v1"(p_actor_user_id)
    OR p_permission NOT IN ('products.write','pdv.write','accounting.write','integrations.write') THEN
    RETURN false; END IF;
  SELECT true INTO authorized
    FROM public."tenant_user_profiles" profile
    JOIN public."tenant_roles" role ON role."id"=profile."role_id"
   WHERE profile."user_id"=p_actor_user_id AND profile."status"='active' AND role."active"
     AND (role."permissions" ? p_permission OR role."permissions" ? '*')
     AND (NOT p_require_admin OR role."key" IN ('owner','admin'))
   ORDER BY profile."id"
   LIMIT 1
   FOR SHARE OF profile,role;
  RETURN COALESCE(authorized,false);
END
$function$;

CREATE FUNCTION public."pos_manual_t2_boundary_operation_id_v1"(p_abi text,p_idempotency_key text)
RETURNS uuid LANGUAGE sql IMMUTABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
  SELECT public."pos_manual_uuid16_v1"('t2-boundary-operation-identity-v1',
    pg_catalog.jsonb_build_object('abi',p_abi,'idempotencyKey',p_idempotency_key,'schemaVersion',1))
$function$;

CREATE FUNCTION public."pos_manual_t2_boundary_replay_v1"(
  p_abi text,p_operation_id uuid,p_idempotency_key text,p_request_hash text,
  p_actor_user_id text,p_request jsonb
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE existing public."pos_manual_t2_boundary_operations"%ROWTYPE;
BEGIN
  SELECT operation.* INTO existing FROM public."pos_manual_t2_boundary_operations" operation
   WHERE operation."abi"=p_abi AND operation."idempotency_key"=p_idempotency_key FOR UPDATE;
  IF existing.operation_id IS NULL THEN RETURN NULL; END IF;
  IF existing.operation_id<>p_operation_id OR existing.request_hash<>p_request_hash
    OR existing.actor_user_id<>p_actor_user_id OR existing.request IS DISTINCT FROM p_request THEN
    RAISE EXCEPTION 'T2 boundary idempotency conflict' USING ERRCODE='23505'; END IF;
  RETURN existing.result||pg_catalog.jsonb_build_object('replayed',true);
END
$function$;

CREATE FUNCTION public."pos_manual_t2_record_boundary_operation_v1"(
  p_operation_id uuid,p_abi text,p_idempotency_key text,p_request_hash text,
  p_actor_user_id text,p_request jsonb,p_result jsonb
)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE operation_row public."pos_manual_t2_boundary_operations"%ROWTYPE;
BEGIN
  operation_row.operation_id:=p_operation_id; operation_row.abi:=p_abi;
  operation_row.idempotency_key:=p_idempotency_key; operation_row.request_hash:=p_request_hash;
  operation_row.actor_user_id:=p_actor_user_id; operation_row.request:=p_request; operation_row.result:=p_result;
  operation_row.write_txid:=pg_catalog.txid_current(); operation_row.created_at:=pg_catalog.clock_timestamp();
  PERFORM public."pos_manual_t2_open_reservation_write_root_v1"('runtime','boundary_operation',
    p_operation_id::text,'INSERT',NULL,pg_catalog.to_jsonb(operation_row));
  INSERT INTO public."pos_manual_t2_boundary_operations" SELECT (operation_row).*;
END
$function$;

CREATE FUNCTION public."pos_manual_t2_assert_boundary_executor_v1"()
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
  PERFORM public."pos_manual_t2_authority_v1"('runtime');
  IF pg_catalog.current_setting('transaction_isolation')<>'serializable'
    OR pg_catalog.current_setting('transaction_read_only')<>'off'
    OR pg_catalog.pg_is_in_recovery() THEN
    RAISE EXCEPTION 'T2 boundary producer requires a primary read-write serializable transaction' USING ERRCODE='25001';
  END IF;
END
$function$;

CREATE FUNCTION public."pos_t2_catalog_boundary_v1_impl"(
  p_action text,p_product_id integer,p_expected_product_revision integer,p_expected_product_config_hash text,
  p_product_projection jsonb,p_variations jsonb,p_actor_user_id text,p_idempotency_key text,p_request_hash text
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE request_doc jsonb; operation_id uuid; replay_result jsonb; result_doc jsonb;
  product_row public."products"%ROWTYPE; product_new jsonb; variation_row public."product_variations"%ROWTYPE;
  variation_new jsonb; item jsonb; result_variations jsonb:='[]'::jsonb; supplied_ids integer[]:='{}';
  effective_product_id integer; variation_id integer; ordinal integer; expected_revision integer;
  expected_hash text; new_revision integer; new_hash text; item_action text; product_changed boolean;
BEGIN
  PERFORM public."pos_manual_t2_assert_shape_v1"(p_idempotency_key,p_request_hash);
  request_doc:=pg_catalog.jsonb_build_object('action',p_action,'actorUserId',p_actor_user_id,
    'expectedProductConfigHash',p_expected_product_config_hash,
    'expectedProductRevision',p_expected_product_revision,'idempotencyKey',p_idempotency_key,
    'productId',p_product_id,'productProjection',p_product_projection,'schemaVersion',1,'variations',p_variations);
  IF p_action NOT IN ('put_graph','set_active')
    OR NOT public."pos_manual_t2_json_keys_exact_v1"(p_product_projection,
      ARRAY['active','gtinSnapshot','manageStock','nameLabel','productType','skuSnapshot','status','unit'])
    OR pg_catalog.jsonb_typeof(p_product_projection->'active')<>'boolean'
    OR pg_catalog.jsonb_typeof(p_product_projection->'manageStock')<>'boolean'
    OR pg_catalog.jsonb_typeof(p_product_projection->'nameLabel')<>'string'
    OR pg_catalog.jsonb_typeof(p_product_projection->'productType')<>'string'
    OR pg_catalog.jsonb_typeof(p_product_projection->'status')<>'string'
    OR pg_catalog.jsonb_typeof(p_product_projection->'unit')<>'string'
    OR pg_catalog.jsonb_typeof(p_variations)<>'array'
    OR pg_catalog.jsonb_array_length(p_variations)>10000
    OR (p_product_id IS NULL AND (p_action<>'put_graph' OR p_expected_product_revision IS NOT NULL
      OR p_expected_product_config_hash IS NOT NULL))
    OR (p_product_id IS NOT NULL AND (p_product_id<=0 OR p_expected_product_revision IS NULL
      OR p_expected_product_revision<=0 OR p_expected_product_config_hash!~'^[0-9a-f]{64}$'))
    OR (p_action='set_active' AND pg_catalog.jsonb_array_length(p_variations)<>0) THEN
    RAISE EXCEPTION 'invalid T2 catalog boundary request' USING ERRCODE='22023'; END IF;
  IF p_request_hash<>public."pos_manual_hash_canonical_json_v1"('t2-catalog-boundary-request-v1',request_doc) THEN
    RAISE EXCEPTION 'T2 catalog request hash mismatch' USING ERRCODE='23514'; END IF;
  operation_id:=public."pos_manual_t2_boundary_operation_id_v1"('catalog',p_idempotency_key);
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    't2-boundary:catalog:'||COALESCE(p_product_id::text,operation_id::text),0));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('t2-boundary:catalog-key:'||p_idempotency_key,0));
  IF NOT public."pos_manual_t2_boundary_actor_v1"(p_actor_user_id,'products.write',false) THEN
    RAISE EXCEPTION 'T2 catalog actor denied' USING ERRCODE='42501'; END IF;
  replay_result:=public."pos_manual_t2_boundary_replay_v1"('catalog',operation_id,p_idempotency_key,
    p_request_hash,p_actor_user_id,request_doc);
  IF replay_result IS NOT NULL THEN RETURN replay_result; END IF;
  IF p_product_id IS NULL THEN
    effective_product_id:=pg_catalog.nextval(pg_catalog.pg_get_serial_sequence('public.products','id'))::integer;
    new_revision:=1; product_changed:=true;
  ELSE
    effective_product_id:=p_product_id;
    SELECT product.* INTO product_row FROM public."products" product WHERE product."id"=p_product_id FOR UPDATE;
    IF product_row.id IS NULL OR product_row.pos_revision<>p_expected_product_revision
      OR product_row.pos_config_hash<>p_expected_product_config_hash THEN
      RAISE EXCEPTION 'T2 catalog product boundary changed' USING ERRCODE='23514'; END IF;
    PERFORM 1 FROM public."product_variations" variation WHERE variation."product_id"=p_product_id
      ORDER BY variation."id" FOR UPDATE;
    IF p_action='set_active' AND (product_row.gtin IS DISTINCT FROM p_product_projection->>'gtinSnapshot'
      OR product_row.manage_stock IS DISTINCT FROM (p_product_projection->>'manageStock')::boolean
      OR product_row.name IS DISTINCT FROM p_product_projection->>'nameLabel'
      OR product_row.type IS DISTINCT FROM p_product_projection->>'productType'
      OR product_row.sku IS DISTINCT FROM p_product_projection->>'skuSnapshot'
      OR product_row.status IS DISTINCT FROM p_product_projection->>'status'
      OR product_row.unit IS DISTINCT FROM p_product_projection->>'unit') THEN
      RAISE EXCEPTION 'T2 set_active must repeat the current product projection' USING ERRCODE='23514'; END IF;
    product_changed:=ROW(product_row.active,product_row.gtin,product_row.manage_stock,product_row.name,
      product_row.type,product_row.sku,product_row.status,product_row.unit)
      IS DISTINCT FROM ROW((p_product_projection->>'active')::boolean,p_product_projection->>'gtinSnapshot',
        (p_product_projection->>'manageStock')::boolean,p_product_projection->>'nameLabel',
        p_product_projection->>'productType',p_product_projection->>'skuSnapshot',
        p_product_projection->>'status',p_product_projection->>'unit');
    new_revision:=product_row.pos_revision+CASE WHEN product_changed THEN 1 ELSE 0 END;
  END IF;
  new_hash:=public."pos_manual_hash_canonical_json_v1"('t2-catalog-product-v1',
    pg_catalog.jsonb_build_object('active',(p_product_projection->>'active')::boolean,
      'gtinSnapshot',p_product_projection->>'gtinSnapshot','manageStock',(p_product_projection->>'manageStock')::boolean,
      'nameLabel',p_product_projection->>'nameLabel','posRevision',new_revision,'productId',effective_product_id,
      'productType',p_product_projection->>'productType','schemaVersion',1,
      'skuSnapshot',p_product_projection->>'skuSnapshot','status',p_product_projection->>'status',
      'unit',p_product_projection->>'unit'));
  product_new:=pg_catalog.jsonb_build_object('id',effective_product_id,
    'active',(p_product_projection->>'active')::boolean,'gtin',p_product_projection->'gtinSnapshot',
    'manage_stock',(p_product_projection->>'manageStock')::boolean,'name',p_product_projection->>'nameLabel',
    'type',p_product_projection->>'productType','sku',p_product_projection->'skuSnapshot',
    'status',p_product_projection->>'status','unit',p_product_projection->>'unit',
    'pos_revision',new_revision,'pos_config_hash',new_hash);
  IF product_changed THEN
    PERFORM public."pos_manual_t2_open_reservation_write_root_v1"('runtime','boundary_product',
      effective_product_id::text,CASE WHEN p_product_id IS NULL THEN 'INSERT' ELSE 'UPDATE' END,
      CASE WHEN p_product_id IS NULL THEN NULL ELSE pg_catalog.to_jsonb(product_row) END,product_new);
  END IF;
  IF p_action='put_graph' THEN
    ordinal:=0;
    FOR item IN SELECT value FROM pg_catalog.jsonb_array_elements(p_variations) array_item(value) LOOP
      IF NOT public."pos_manual_t2_json_keys_exact_v1"(item,
          ARRAY['enabled','expectedConfigHash','expectedRevision','gtinSnapshot','manageStock','ordinal','skuSnapshot','status','variationId'])
        OR pg_catalog.jsonb_typeof(item->'enabled')<>'boolean'
        OR pg_catalog.jsonb_typeof(item->'manageStock')<>'string'
        OR pg_catalog.jsonb_typeof(item->'ordinal')<>'number'
        OR (item->>'ordinal')::integer<>ordinal
        OR (item->>'manageStock') NOT IN ('true','false','parent') THEN
        RAISE EXCEPTION 'invalid T2 catalog variation request' USING ERRCODE='22023'; END IF;
      variation_id:=(item->>'variationId')::integer;
      expected_revision:=(item->>'expectedRevision')::integer; expected_hash:=item->>'expectedConfigHash';
      IF variation_id IS NULL THEN
        IF expected_revision IS NOT NULL OR expected_hash IS NOT NULL THEN
          RAISE EXCEPTION 'invalid T2 catalog variation create CAS' USING ERRCODE='22023'; END IF;
        variation_id:=pg_catalog.nextval(pg_catalog.pg_get_serial_sequence('public.product_variations','id'))::integer;
        new_revision:=1; item_action:='create'; variation_row.id:=NULL;
      ELSE
        IF variation_id<=0 OR expected_revision IS NULL OR expected_revision<=0 OR expected_hash!~'^[0-9a-f]{64}$'
          OR variation_id=ANY(supplied_ids) THEN
          RAISE EXCEPTION 'invalid T2 catalog variation update CAS' USING ERRCODE='22023'; END IF;
        SELECT variation.* INTO variation_row FROM public."product_variations" variation
         WHERE variation."id"=variation_id AND variation."product_id"=effective_product_id FOR UPDATE;
        IF variation_row.id IS NULL OR variation_row.pos_revision<>expected_revision
          OR variation_row.pos_config_hash<>expected_hash THEN
          RAISE EXCEPTION 'T2 catalog variation boundary changed' USING ERRCODE='23514'; END IF;
        item_action:=CASE WHEN ROW(variation_row.enabled,variation_row.gtin,variation_row.manage_stock,
            variation_row.menu_order,variation_row.sku,variation_row.status)
          IS DISTINCT FROM ROW((item->>'enabled')::boolean,item->>'gtinSnapshot',item->>'manageStock',
            ordinal,item->>'skuSnapshot',item->>'status') THEN 'update' ELSE 'keep' END;
        new_revision:=variation_row.pos_revision+CASE WHEN item_action='update' THEN 1 ELSE 0 END;
      END IF;
      supplied_ids:=pg_catalog.array_append(supplied_ids,variation_id);
      new_hash:=CASE WHEN item_action='keep' THEN variation_row.pos_config_hash ELSE
        public."pos_manual_hash_canonical_json_v1"('t2-catalog-variation-v1',pg_catalog.jsonb_build_object(
          'enabled',(item->>'enabled')::boolean,'gtinSnapshot',item->>'gtinSnapshot',
          'manageStock',item->>'manageStock','posRevision',new_revision,'productId',effective_product_id,
          'schemaVersion',1,'skuSnapshot',item->>'skuSnapshot','status',item->>'status','variationId',variation_id)) END;
      variation_new:=pg_catalog.jsonb_build_object('id',variation_id,'product_id',effective_product_id,
        'enabled',(item->>'enabled')::boolean,'gtin',item->'gtinSnapshot','manage_stock',item->>'manageStock',
        'menu_order',ordinal,'sku',item->'skuSnapshot','status',item->>'status',
        'pos_revision',new_revision,'pos_config_hash',new_hash);
      IF item_action<>'keep' THEN
        PERFORM public."pos_manual_t2_open_reservation_write_root_v1"('runtime','boundary_variation',variation_id::text,
          CASE WHEN item_action='create' THEN 'INSERT' ELSE 'UPDATE' END,
          CASE WHEN item_action='create' THEN NULL ELSE pg_catalog.to_jsonb(variation_row) END,variation_new);
      END IF;
      result_variations:=result_variations||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'action',item_action,'configHash',new_hash,'ordinal',ordinal,'revision',new_revision,'variationId',variation_id));
      ordinal:=ordinal+1;
    END LOOP;
    FOR variation_row IN SELECT variation.* FROM public."product_variations" variation
      WHERE variation."product_id"=effective_product_id AND NOT (variation."id"=ANY(supplied_ids))
      ORDER BY variation."id" FOR UPDATE LOOP
      IF EXISTS (SELECT 1 FROM public."pos_held_sale_items" WHERE "variation_id"=variation_row.id)
        OR EXISTS (SELECT 1 FROM public."pos_inventory_lots" WHERE "variation_id"=variation_row.id)
        OR EXISTS (SELECT 1 FROM public."pos_kit_bom_components" WHERE "variation_id"=variation_row.id)
        OR EXISTS (SELECT 1 FROM public."pos_kit_boms" WHERE "kit_variation_id"=variation_row.id)
        OR EXISTS (SELECT 1 FROM public."pos_kit_sale_components" WHERE "variation_id"=variation_row.id)
        OR EXISTS (SELECT 1 FROM public."pos_manual_application_stock_reservations" WHERE "variation_id"=variation_row.id)
        OR EXISTS (SELECT 1 FROM public."pos_product_codes" WHERE "variation_id"=variation_row.id)
        OR EXISTS (SELECT 1 FROM public."product_variation_images" WHERE "variation_id"=variation_row.id)
        OR EXISTS (SELECT 1 FROM public."sale_items" WHERE "variation_id"=variation_row.id)
        OR EXISTS (SELECT 1 FROM public."sales_order_items" WHERE "variation_id"=variation_row.id)
        OR EXISTS (SELECT 1 FROM public."stock_movements" WHERE "variation_id"=variation_row.id)
        OR EXISTS (SELECT 1 FROM public."warehouse_ledger_entries" WHERE "variation_id"=variation_row.id)
        OR EXISTS (SELECT 1 FROM public."warehouse_variation_balances" WHERE "variation_id"=variation_row.id) THEN
        RAISE EXCEPTION 'T2 catalog variation is referenced' USING ERRCODE='23514'; END IF;
      PERFORM public."pos_manual_t2_open_reservation_write_root_v1"('runtime','boundary_variation',
        variation_row.id::text,'DELETE',pg_catalog.to_jsonb(variation_row),NULL);
      result_variations:=result_variations||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'action','delete','configHash',variation_row.pos_config_hash,'ordinal',variation_row.menu_order,
        'revision',variation_row.pos_revision,'variationId',variation_row.id));
    END LOOP;
    SELECT COALESCE(pg_catalog.jsonb_agg(value ORDER BY (value->>'ordinal')::integer,value->>'variationId'),'[]'::jsonb)
      INTO result_variations FROM pg_catalog.jsonb_array_elements(result_variations) array_item(value);
  END IF;
  result_doc:=pg_catalog.jsonb_build_object('operationId',operation_id,'productConfigHash',new_hash,
    'productId',effective_product_id,'productRevision',new_revision,'replayed',false,'variations',result_variations);
  -- The product hash/revision variables are restored because the variation loop
  -- intentionally reuses the local hash scratch variables.
  result_doc:=pg_catalog.jsonb_set(result_doc,'{productConfigHash}',pg_catalog.to_jsonb(
    public."pos_manual_hash_canonical_json_v1"('t2-catalog-product-v1',pg_catalog.jsonb_build_object(
      'active',(p_product_projection->>'active')::boolean,'gtinSnapshot',p_product_projection->>'gtinSnapshot',
      'manageStock',(p_product_projection->>'manageStock')::boolean,'nameLabel',p_product_projection->>'nameLabel',
      'posRevision',(product_new->>'pos_revision')::integer,'productId',effective_product_id,
      'productType',p_product_projection->>'productType','schemaVersion',1,
      'skuSnapshot',p_product_projection->>'skuSnapshot','status',p_product_projection->>'status','unit',p_product_projection->>'unit'))));
  result_doc:=pg_catalog.jsonb_set(result_doc,'{productRevision}',product_new->'pos_revision');
  PERFORM public."pos_manual_t2_record_boundary_operation_v1"(operation_id,'catalog',p_idempotency_key,
    p_request_hash,p_actor_user_id,request_doc,result_doc);
  RETURN result_doc;
END
$function$;

CREATE FUNCTION public."pos_t2_catalog_boundary_v1"(
  p_action text,p_product_id integer,p_expected_product_revision integer,p_expected_product_config_hash text,
  p_product_projection jsonb,p_variations jsonb,p_actor_user_id text,p_idempotency_key text,p_request_hash text
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
  PERFORM public."pos_manual_t2_assert_boundary_executor_v1"();
  RETURN public."pos_t2_catalog_boundary_v1_impl"(p_action,p_product_id,p_expected_product_revision,
    p_expected_product_config_hash,p_product_projection,p_variations,p_actor_user_id,p_idempotency_key,p_request_hash);
END
$function$;

CREATE FUNCTION public."pos_t2_value_program_boundary_v1_impl"(
  p_action text,p_program_id text,p_expected_revision integer,p_expected_config_hash text,
  p_branch_id integer,p_name text,p_kind text,p_status text,p_earn_units integer,p_spend_cents integer,
  p_redeem_cents_per_unit integer,p_expires_after_days integer,p_actor_user_id text,
  p_idempotency_key text,p_request_hash text
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE request_doc jsonb; operation_id uuid; replay_result jsonb; result_doc jsonb;
  program_row public."pos_value_programs"%ROWTYPE; new_row public."pos_value_programs"%ROWTYPE;
  effective_program_id text; now_at timestamptz;
BEGIN
  PERFORM public."pos_manual_t2_assert_shape_v1"(p_idempotency_key,p_request_hash);
  request_doc:=pg_catalog.jsonb_build_object(
    'action',p_action,'actorUserId',p_actor_user_id,'expectedConfigHash',p_expected_config_hash,
    'expectedRevision',p_expected_revision,'idempotencyKey',p_idempotency_key,'programId',p_program_id,
    'projection',pg_catalog.jsonb_build_object('branchId',p_branch_id,'earnUnits',p_earn_units,
      'expiresAfterDays',p_expires_after_days,'kind',p_kind,'name',p_name,
      'redeemCentsPerUnit',p_redeem_cents_per_unit,'spendCents',p_spend_cents,'status',p_status),
    'schemaVersion',1);
  IF p_action NOT IN ('put','deactivate') OR p_branch_id<=0
    OR p_kind NOT IN ('loyalty_points','cashback') OR p_status NOT IN ('active','inactive')
    OR pg_catalog.octet_length(p_name) NOT BETWEEN 2 AND 640
    OR p_earn_units NOT BETWEEN 1 AND 2147483647 OR p_spend_cents NOT BETWEEN 1 AND 2147483647
    OR p_redeem_cents_per_unit NOT BETWEEN 1 AND 2147483647
    OR (p_expires_after_days IS NOT NULL AND p_expires_after_days NOT BETWEEN 1 AND 36500)
    OR (p_program_id IS NULL AND (p_action<>'put' OR p_expected_revision IS NOT NULL
      OR p_expected_config_hash IS NOT NULL OR p_status<>'active'))
    OR (p_program_id IS NOT NULL AND (p_expected_revision IS NULL OR p_expected_revision<=0
      OR p_expected_config_hash!~'^[0-9a-f]{64}$'))
    OR (p_action='deactivate' AND (p_program_id IS NULL OR p_status<>'inactive')) THEN
    RAISE EXCEPTION 'invalid T2 value program boundary request' USING ERRCODE='22023'; END IF;
  IF p_request_hash<>public."pos_manual_hash_canonical_json_v1"('t2-value-program-boundary-request-v1',request_doc) THEN
    RAISE EXCEPTION 'T2 value program request hash mismatch' USING ERRCODE='23514'; END IF;
  operation_id:=public."pos_manual_t2_boundary_operation_id_v1"('value_program',p_idempotency_key);
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('t2-boundary:value-program:'||p_idempotency_key,0));
  IF NOT public."pos_manual_t2_boundary_actor_v1"(p_actor_user_id,'pdv.write',true) THEN
    RAISE EXCEPTION 'T2 value program actor denied' USING ERRCODE='42501'; END IF;
  replay_result:=public."pos_manual_t2_boundary_replay_v1"('value_program',operation_id,p_idempotency_key,
    p_request_hash,p_actor_user_id,request_doc);
  IF replay_result IS NOT NULL THEN RETURN replay_result; END IF;
  PERFORM 1 FROM public."branches" WHERE "id"=p_branch_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'T2 value program branch not found' USING ERRCODE='23514'; END IF;
  effective_program_id:=COALESCE(p_program_id,operation_id::text);
  SELECT program.* INTO program_row FROM public."pos_value_programs" program
   WHERE program."id"=effective_program_id FOR UPDATE;
  now_at:=pg_catalog.clock_timestamp();
  IF p_program_id IS NULL THEN
    IF program_row.id IS NOT NULL THEN RAISE EXCEPTION 'T2 value program identity conflict' USING ERRCODE='23505'; END IF;
    new_row.id:=effective_program_id; new_row.branch_id:=p_branch_id; new_row.name:=p_name;
    new_row.kind:=p_kind; new_row.status:=p_status; new_row.earn_units:=p_earn_units;
    new_row.spend_cents:=p_spend_cents; new_row.redeem_cents_per_unit:=p_redeem_cents_per_unit;
    new_row.expires_after_days:=p_expires_after_days; new_row.created_at:=now_at; new_row.updated_at:=now_at;
    new_row.revision:=1;
  ELSE
    IF program_row.id IS NULL OR program_row.revision<>p_expected_revision
      OR program_row.config_hash<>p_expected_config_hash THEN
      RAISE EXCEPTION 'T2 value program boundary changed' USING ERRCODE='23514'; END IF;
    IF p_action='deactivate' AND (program_row.branch_id<>p_branch_id OR program_row.name<>p_name
      OR program_row.kind<>p_kind OR program_row.earn_units<>p_earn_units
      OR program_row.spend_cents<>p_spend_cents OR program_row.redeem_cents_per_unit<>p_redeem_cents_per_unit
      OR program_row.expires_after_days IS DISTINCT FROM p_expires_after_days) THEN
      RAISE EXCEPTION 'T2 value program deactivate must repeat the current projection' USING ERRCODE='23514'; END IF;
    new_row:=program_row; new_row.branch_id:=p_branch_id; new_row.name:=p_name; new_row.kind:=p_kind;
    new_row.status:=p_status; new_row.earn_units:=p_earn_units; new_row.spend_cents:=p_spend_cents;
    new_row.redeem_cents_per_unit:=p_redeem_cents_per_unit; new_row.expires_after_days:=p_expires_after_days;
    new_row.updated_at:=now_at; new_row.revision:=program_row.revision+1;
  END IF;
  new_row.config_hash:=public."pos_manual_hash_canonical_json_v1"('t2-value-program-v1',
    pg_catalog.jsonb_build_object('branchId',new_row.branch_id,'earnUnits',new_row.earn_units,
      'expiresAfterDays',new_row.expires_after_days,'kind',new_row.kind,'programId',new_row.id,
      'revision',new_row.revision,'schemaVersion',1,'spendCents',new_row.spend_cents,'status',new_row.status));
  PERFORM 1 FROM public."pos_value_accounts" account WHERE account."program_id"=effective_program_id
    ORDER BY account."id" FOR SHARE;
  PERFORM 1 FROM public."pos_value_reservations" reservation
    JOIN public."pos_value_accounts" account ON account."id"=reservation."account_id"
   WHERE account."program_id"=effective_program_id ORDER BY reservation."id" FOR SHARE OF reservation;
  PERFORM public."pos_manual_t2_open_reservation_write_root_v1"('runtime','boundary_value_program',
    effective_program_id,CASE WHEN p_program_id IS NULL THEN 'INSERT' ELSE 'UPDATE' END,
    CASE WHEN p_program_id IS NULL THEN NULL ELSE pg_catalog.to_jsonb(program_row) END,pg_catalog.to_jsonb(new_row));
  IF p_program_id IS NULL THEN
    INSERT INTO public."pos_value_programs" SELECT (new_row).*;
  ELSE
    UPDATE public."pos_value_programs" SET "branch_id"=new_row.branch_id,"name"=new_row.name,
      "kind"=new_row.kind,"status"=new_row.status,"earn_units"=new_row.earn_units,
      "spend_cents"=new_row.spend_cents,"redeem_cents_per_unit"=new_row.redeem_cents_per_unit,
      "expires_after_days"=new_row.expires_after_days,"updated_at"=new_row.updated_at
     WHERE "id"=effective_program_id;
  END IF;
  result_doc:=pg_catalog.jsonb_build_object('configHash',new_row.config_hash,'operationId',operation_id,
    'programId',effective_program_id,'replayed',false,'revision',new_row.revision,'status',new_row.status);
  PERFORM public."pos_manual_t2_record_boundary_operation_v1"(operation_id,'value_program',p_idempotency_key,
    p_request_hash,p_actor_user_id,request_doc,result_doc);
  RETURN result_doc;
END
$function$;

CREATE FUNCTION public."pos_t2_value_program_boundary_v1"(
  p_action text,p_program_id text,p_expected_revision integer,p_expected_config_hash text,
  p_branch_id integer,p_name text,p_kind text,p_status text,p_earn_units integer,p_spend_cents integer,
  p_redeem_cents_per_unit integer,p_expires_after_days integer,p_actor_user_id text,
  p_idempotency_key text,p_request_hash text
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
  PERFORM public."pos_manual_t2_assert_boundary_executor_v1"();
  RETURN public."pos_t2_value_program_boundary_v1_impl"(p_action,p_program_id,p_expected_revision,
    p_expected_config_hash,p_branch_id,p_name,p_kind,p_status,p_earn_units,p_spend_cents,
    p_redeem_cents_per_unit,p_expires_after_days,p_actor_user_id,p_idempotency_key,p_request_hash);
END
$function$;

CREATE FUNCTION public."pos_t2_accounting_period_put_v1_impl"(
  p_branch_id integer,p_year integer,p_month integer,p_starts_on date,p_ends_on date,p_currency text,
  p_actor_user_id text,p_idempotency_key text,p_request_hash text
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE request_doc jsonb; operation_id uuid; replay_result jsonb; result_doc jsonb;
  period_row public."pos_accounting_periods"%ROWTYPE; competitor_id text; now_at timestamptz;
BEGIN
  PERFORM public."pos_manual_t2_assert_shape_v1"(p_idempotency_key,p_request_hash);
  request_doc:=pg_catalog.jsonb_build_object('actorUserId',p_actor_user_id,'branchId',p_branch_id,
    'currency',p_currency,'endsOn',p_ends_on,'idempotencyKey',p_idempotency_key,'month',p_month,
    'schemaVersion',1,'startsOn',p_starts_on,'year',p_year);
  IF p_branch_id<=0 OR p_year NOT BETWEEN 2000 AND 2200 OR p_month NOT BETWEEN 1 AND 12
    OR p_currency<>'BRL' OR p_starts_on<>pg_catalog.make_date(p_year,p_month,1)
    OR p_ends_on<>(p_starts_on+interval '1 month'-interval '1 day')::date THEN
    RAISE EXCEPTION 'invalid T2 accounting period put request' USING ERRCODE='22023'; END IF;
  IF p_request_hash<>public."pos_manual_hash_canonical_json_v1"('t2-accounting-period-put-request-v1',request_doc) THEN
    RAISE EXCEPTION 'T2 accounting period put request hash mismatch' USING ERRCODE='23514'; END IF;
  operation_id:=public."pos_manual_t2_boundary_operation_id_v1"('accounting_period_put',p_idempotency_key);
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    't2-boundary:accounting-period-put:'||p_branch_id::text||':'||p_year::text||':'||p_month::text,0));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    't2-boundary:accounting-period-put-key:'||p_idempotency_key,0));
  IF NOT public."pos_manual_t2_boundary_actor_v1"(p_actor_user_id,'accounting.write',true) THEN
    RAISE EXCEPTION 'T2 accounting period actor denied' USING ERRCODE='42501'; END IF;
  replay_result:=public."pos_manual_t2_boundary_replay_v1"('accounting_period_put',operation_id,
    p_idempotency_key,p_request_hash,p_actor_user_id,request_doc);
  IF replay_result IS NOT NULL THEN RETURN replay_result; END IF;
  PERFORM 1 FROM public."branches" branch WHERE branch."id"=p_branch_id AND branch."status"='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'T2 accounting period branch is not live' USING ERRCODE='23514'; END IF;
  SELECT period."id" INTO competitor_id FROM public."pos_accounting_periods" period
   WHERE period."branch_id"=p_branch_id AND period."year"=p_year AND period."month"=p_month FOR UPDATE;
  IF competitor_id IS NOT NULL THEN
    RAISE EXCEPTION 'T2 accounting period identity conflict' USING ERRCODE='23505'; END IF;
  now_at:=pg_catalog.clock_timestamp(); period_row.id:=operation_id::text; period_row.branch_id:=p_branch_id;
  period_row.year:=p_year; period_row.month:=p_month; period_row.starts_at:=p_starts_on;
  period_row.ends_at:=p_ends_on; period_row.status:='open'; period_row.currency:=p_currency;
  period_row.closed_at:=NULL; period_row.closed_by:=NULL; period_row.close_reason:=NULL;
  period_row.created_at:=now_at; period_row.updated_at:=now_at; period_row.revision:=1;
  period_row.config_hash:=public."pos_manual_hash_canonical_json_v1"('t2-accounting-period-v1',
    pg_catalog.jsonb_build_object('branchId',period_row.branch_id,'currency',period_row.currency,
      'endsOn',period_row.ends_at,'month',period_row.month,'periodId',period_row.id,'revision',1,
      'schemaVersion',1,'startsOn',period_row.starts_at,'status','open','year',period_row.year));
  PERFORM public."pos_manual_t2_open_reservation_write_root_v1"('runtime','boundary_period',period_row.id,
    'INSERT',NULL,pg_catalog.to_jsonb(period_row));
  INSERT INTO public."pos_accounting_periods" SELECT (period_row).*;
  result_doc:=pg_catalog.jsonb_build_object('configHash',period_row.config_hash,'operationId',operation_id,
    'periodId',period_row.id,'replayed',false,'revision',1,'status','open');
  PERFORM public."pos_manual_t2_record_boundary_operation_v1"(operation_id,'accounting_period_put',
    p_idempotency_key,p_request_hash,p_actor_user_id,request_doc,result_doc);
  RETURN result_doc;
END
$function$;

CREATE FUNCTION public."pos_t2_accounting_period_put_v1"(
  p_branch_id integer,p_year integer,p_month integer,p_starts_on date,p_ends_on date,p_currency text,
  p_actor_user_id text,p_idempotency_key text,p_request_hash text
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
  PERFORM public."pos_manual_t2_assert_boundary_executor_v1"();
  RETURN public."pos_t2_accounting_period_put_v1_impl"(p_branch_id,p_year,p_month,p_starts_on,p_ends_on,
    p_currency,p_actor_user_id,p_idempotency_key,p_request_hash);
END
$function$;

CREATE FUNCTION public."pos_t2_accounting_period_close_v1_impl"(
  p_period_id text,p_expected_revision integer,p_expected_config_hash text,p_closed_by text,
  p_reason text,p_idempotency_key text,p_request_hash text
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE request_doc jsonb; operation_id uuid; replay_result jsonb; result_doc jsonb;
  period_row public."pos_accounting_periods"%ROWTYPE; new_row public."pos_accounting_periods"%ROWTYPE;
  now_at timestamptz;
BEGIN
  PERFORM public."pos_manual_t2_assert_shape_v1"(p_idempotency_key,p_request_hash);
  request_doc:=pg_catalog.jsonb_build_object('closedBy',p_closed_by,
    'expectedConfigHash',p_expected_config_hash,'expectedRevision',p_expected_revision,
    'idempotencyKey',p_idempotency_key,'periodId',p_period_id,'reason',p_reason,'schemaVersion',1);
  IF pg_catalog.octet_length(p_period_id) NOT BETWEEN 8 AND 640 OR p_expected_revision<=0
    OR p_expected_config_hash!~'^[0-9a-f]{64}$' OR NOT public."pos_manual_t2_subject_safe_v1"(p_closed_by)
    OR pg_catalog.char_length(p_reason) NOT BETWEEN 3 AND 300 THEN
    RAISE EXCEPTION 'invalid T2 accounting period close request' USING ERRCODE='22023'; END IF;
  IF p_request_hash<>public."pos_manual_hash_canonical_json_v1"('t2-accounting-period-boundary-request-v1',request_doc) THEN
    RAISE EXCEPTION 'T2 accounting period request hash mismatch' USING ERRCODE='23514'; END IF;
  operation_id:=public."pos_manual_t2_boundary_operation_id_v1"('accounting_period',p_idempotency_key);
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('t2-boundary:accounting-period:'||p_idempotency_key,0));
  IF NOT public."pos_manual_t2_boundary_actor_v1"(p_closed_by,'accounting.write',true) THEN
    RAISE EXCEPTION 'T2 accounting period actor denied' USING ERRCODE='42501'; END IF;
  replay_result:=public."pos_manual_t2_boundary_replay_v1"('accounting_period',operation_id,p_idempotency_key,
    p_request_hash,p_closed_by,request_doc);
  IF replay_result IS NOT NULL THEN RETURN replay_result; END IF;
  SELECT period.* INTO period_row FROM public."pos_accounting_periods" period
   WHERE period."id"=p_period_id FOR UPDATE;
  IF period_row.id IS NULL OR period_row.status<>'open' OR period_row.revision<>p_expected_revision
    OR period_row.config_hash<>p_expected_config_hash THEN
    RAISE EXCEPTION 'T2 accounting period boundary changed' USING ERRCODE='23514'; END IF;
  PERFORM 1 FROM public."pos_accounting_journals" journal WHERE journal."period_id"=p_period_id
    ORDER BY journal."id" FOR SHARE;
  PERFORM 1 FROM public."pos_manual_application_snapshots" snapshot
   WHERE snapshot."accounting"->>'periodId'=p_period_id ORDER BY snapshot."application_id" FOR SHARE;
  now_at:=pg_catalog.clock_timestamp(); new_row:=period_row; new_row.status:='closed';
  new_row.closed_at:=now_at; new_row.closed_by:=p_closed_by; new_row.close_reason:=p_reason;
  new_row.updated_at:=now_at; new_row.revision:=period_row.revision+1;
  new_row.config_hash:=public."pos_manual_hash_canonical_json_v1"('t2-accounting-period-v1',
    pg_catalog.jsonb_build_object('branchId',new_row.branch_id,'currency',new_row.currency,
      'endsOn',new_row.ends_at,'month',new_row.month,'periodId',new_row.id,'revision',new_row.revision,
      'schemaVersion',1,'startsOn',new_row.starts_at,'status',new_row.status,'year',new_row.year));
  PERFORM public."pos_manual_t2_open_reservation_write_root_v1"('runtime','boundary_period',p_period_id,
    'UPDATE',pg_catalog.to_jsonb(period_row),pg_catalog.to_jsonb(new_row));
  UPDATE public."pos_accounting_periods" SET "status"='closed',"closed_at"=now_at,
    "closed_by"=p_closed_by,"close_reason"=p_reason,"updated_at"=now_at WHERE "id"=p_period_id;
  result_doc:=pg_catalog.jsonb_build_object('closedAt',public."pos_manual_utc_micros_v1"(now_at),
    'configHash',new_row.config_hash,'operationId',operation_id,'periodId',p_period_id,
    'replayed',false,'revision',new_row.revision,'status','closed');
  PERFORM public."pos_manual_t2_record_boundary_operation_v1"(operation_id,'accounting_period',p_idempotency_key,
    p_request_hash,p_closed_by,request_doc,result_doc);
  RETURN result_doc;
END
$function$;

CREATE FUNCTION public."pos_t2_accounting_period_close_v1"(
  p_period_id text,p_expected_revision integer,p_expected_config_hash text,p_closed_by text,
  p_reason text,p_idempotency_key text,p_request_hash text
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
  PERFORM public."pos_manual_t2_assert_boundary_executor_v1"();
  RETURN public."pos_t2_accounting_period_close_v1_impl"(p_period_id,p_expected_revision,
    p_expected_config_hash,p_closed_by,p_reason,p_idempotency_key,p_request_hash);
END
$function$;

CREATE FUNCTION public."pos_t2_webhook_boundary_v1_impl"(
  p_action text,p_logical_id text,p_expected_version integer,p_expected_config_hash text,
  p_name text,p_topic text,p_delivery_url text,p_secret_cipher text,p_secret_preview text,
  p_status text,p_api_version text,p_actor_user_id text,p_idempotency_key text,p_request_hash text
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE request_doc jsonb; operation_id uuid; replay_result jsonb; result_doc jsonb;
  endpoint_row public."integration_webhook_endpoints"%ROWTYPE;
  old_after public."integration_webhook_endpoints"%ROWTYPE;
  new_row public."integration_webhook_endpoints"%ROWTYPE;
  effective_logical_id text; endpoint_id text; now_at timestamptz;
BEGIN
  PERFORM public."pos_manual_t2_assert_shape_v1"(p_idempotency_key,p_request_hash);
  request_doc:=pg_catalog.jsonb_build_object('action',p_action,'actorUserId',p_actor_user_id,
    'expectedConfigHash',p_expected_config_hash,'expectedVersion',p_expected_version,
    'idempotencyKey',p_idempotency_key,'logicalId',p_logical_id,
    'projection',pg_catalog.jsonb_build_object('apiVersion',p_api_version,'deliveryUrl',p_delivery_url,
      'name',p_name,'secretCipher',p_secret_cipher,'secretPreview',p_secret_preview,
      'status',p_status,'topic',p_topic),'schemaVersion',1);
  IF p_action NOT IN ('create','update','revoke','rotate') OR p_status NOT IN ('active','paused','disabled')
    OR pg_catalog.octet_length(p_name) NOT BETWEEN 1 AND 1024
    OR pg_catalog.octet_length(p_topic) NOT BETWEEN 1 AND 1024
    OR pg_catalog.octet_length(p_delivery_url) NOT BETWEEN 1 AND 16384
    OR pg_catalog.octet_length(p_secret_cipher) NOT BETWEEN 1 AND 1048576
    OR pg_catalog.octet_length(p_secret_preview) NOT BETWEEN 1 AND 1024
    OR pg_catalog.octet_length(p_api_version) NOT BETWEEN 1 AND 256
    OR (p_action='create' AND (p_logical_id IS NOT NULL OR p_expected_version IS NOT NULL
      OR p_expected_config_hash IS NOT NULL))
    OR (p_action<>'create' AND (p_logical_id IS NULL OR p_expected_version IS NULL
      OR p_expected_version<=0 OR p_expected_config_hash!~'^[0-9a-f]{64}$')) THEN
    RAISE EXCEPTION 'invalid T2 webhook boundary request' USING ERRCODE='22023'; END IF;
  IF p_request_hash<>public."pos_manual_hash_canonical_json_v1"('t2-webhook-boundary-request-v1',request_doc) THEN
    RAISE EXCEPTION 'T2 webhook request hash mismatch' USING ERRCODE='23514'; END IF;
  operation_id:=public."pos_manual_t2_boundary_operation_id_v1"('webhook',p_idempotency_key);
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    't2-boundary:webhook:'||COALESCE(p_logical_id,operation_id::text),0));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('t2-boundary:webhook-key:'||p_idempotency_key,0));
  IF NOT public."pos_manual_t2_boundary_actor_v1"(p_actor_user_id,'integrations.write',false) THEN
    RAISE EXCEPTION 'T2 webhook actor denied' USING ERRCODE='42501'; END IF;
  replay_result:=public."pos_manual_t2_boundary_replay_v1"('webhook',operation_id,p_idempotency_key,
    p_request_hash,p_actor_user_id,request_doc);
  IF replay_result IS NOT NULL THEN RETURN replay_result; END IF;
  effective_logical_id:=COALESCE(p_logical_id,operation_id::text); now_at:=pg_catalog.clock_timestamp();
  IF p_action='create' THEN
    IF EXISTS (SELECT 1 FROM public."integration_webhook_endpoints" WHERE "logical_id"=effective_logical_id) THEN
      RAISE EXCEPTION 'T2 webhook identity conflict' USING ERRCODE='23505'; END IF;
    endpoint_id:=operation_id::text; new_row.version:=1;
  ELSE
    SELECT endpoint.* INTO endpoint_row FROM public."integration_webhook_endpoints" endpoint
     WHERE endpoint."logical_id"=effective_logical_id AND endpoint."superseded_at" IS NULL FOR UPDATE;
    IF endpoint_row.id IS NULL OR endpoint_row.version<>p_expected_version
      OR endpoint_row.config_hash<>p_expected_config_hash THEN
      RAISE EXCEPTION 'T2 webhook boundary changed' USING ERRCODE='23514'; END IF;
    IF p_action='update' AND (p_secret_cipher<>endpoint_row.secret_cipher
        OR p_secret_preview<>endpoint_row.secret_preview)
      OR p_action='rotate' AND (p_name<>endpoint_row.name OR p_topic<>endpoint_row.topic
        OR p_delivery_url<>endpoint_row.delivery_url OR p_status<>endpoint_row.status
        OR p_api_version<>endpoint_row.api_version)
      OR p_action='revoke' AND (p_name<>endpoint_row.name OR p_topic<>endpoint_row.topic
        OR p_delivery_url<>endpoint_row.delivery_url OR p_secret_cipher<>endpoint_row.secret_cipher
        OR p_secret_preview<>endpoint_row.secret_preview OR p_api_version<>endpoint_row.api_version
        OR p_status<>'disabled') THEN
      RAISE EXCEPTION 'T2 webhook action projection mismatch' USING ERRCODE='23514'; END IF;
    PERFORM 1 FROM public."integration_webhook_deliveries" delivery
     WHERE delivery."endpoint_id"=endpoint_row.id AND delivery."state"<>'delivered'
     ORDER BY delivery."id" FOR UPDATE;
    old_after:=endpoint_row; old_after.superseded_at:=now_at; old_after.updated_at:=now_at;
    PERFORM public."pos_manual_t2_open_reservation_write_root_v1"('runtime','boundary_webhook',endpoint_row.id,
      'UPDATE',pg_catalog.to_jsonb(endpoint_row),pg_catalog.to_jsonb(old_after));
    UPDATE public."integration_webhook_endpoints" SET "superseded_at"=now_at,"updated_at"=now_at
     WHERE "id"=endpoint_row.id;
    endpoint_id:=public."pos_manual_uuid16_v1"('t2-boundary-operation-identity-v1',
      pg_catalog.jsonb_build_object('abi','webhook-row','idempotencyKey',p_idempotency_key,'schemaVersion',1))::text;
    new_row.version:=endpoint_row.version+1;
  END IF;
  new_row.id:=endpoint_id; new_row.logical_id:=effective_logical_id; new_row.name:=p_name;
  new_row.topic:=p_topic; new_row.delivery_url:=p_delivery_url; new_row.secret_cipher:=p_secret_cipher;
  new_row.secret_preview:=p_secret_preview; new_row.status:=p_status; new_row.api_version:=p_api_version;
  new_row.failure_count:=0; new_row.created_at:=now_at; new_row.updated_at:=now_at; new_row.superseded_at:=NULL;
  new_row.config_hash:=public."pos_manual_hash_canonical_json_v1"('t2-webhook-config-v1',
    pg_catalog.jsonb_build_object('apiVersion',new_row.api_version,'deliveryUrl',new_row.delivery_url,
      'endpointId',new_row.logical_id,'schemaVersion',1,'secretCipher',new_row.secret_cipher,
      'status',new_row.status,'topic',new_row.topic,'version',new_row.version));
  PERFORM public."pos_manual_t2_open_reservation_write_root_v1"('runtime','boundary_webhook',endpoint_id,
    'INSERT',NULL,pg_catalog.to_jsonb(new_row));
  INSERT INTO public."integration_webhook_endpoints" SELECT (new_row).*;
  result_doc:=pg_catalog.jsonb_build_object('configHash',new_row.config_hash,'endpointId',endpoint_id,
    'logicalId',effective_logical_id,'operationId',operation_id,'replayed',false,
    'status',new_row.status,'version',new_row.version);
  PERFORM public."pos_manual_t2_record_boundary_operation_v1"(operation_id,'webhook',p_idempotency_key,
    p_request_hash,p_actor_user_id,request_doc,result_doc);
  RETURN result_doc;
END
$function$;

CREATE FUNCTION public."pos_t2_webhook_boundary_v1"(
  p_action text,p_logical_id text,p_expected_version integer,p_expected_config_hash text,
  p_name text,p_topic text,p_delivery_url text,p_secret_cipher text,p_secret_preview text,
  p_status text,p_api_version text,p_actor_user_id text,p_idempotency_key text,p_request_hash text
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
  PERFORM public."pos_manual_t2_assert_boundary_executor_v1"();
  RETURN public."pos_t2_webhook_boundary_v1_impl"(p_action,p_logical_id,p_expected_version,
    p_expected_config_hash,p_name,p_topic,p_delivery_url,p_secret_cipher,p_secret_preview,
    p_status,p_api_version,p_actor_user_id,p_idempotency_key,p_request_hash);
END
$function$;

CREATE FUNCTION public."pos_manual_t2_reserve_request_hash_v1"(
  p_case_id uuid,p_expected_case_version integer,p_actor_profile_id integer,
  p_actor_user_id text,p_idempotency_key text
)
RETURNS text LANGUAGE sql STABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
  SELECT public."pos_manual_hash_canonical_json_v1"('t2-reserve-request-v1',
    pg_catalog.jsonb_build_object(
      'actorProfileId',p_actor_profile_id,'actorUserId',p_actor_user_id,
      'capability','public.pos_manual_reserve_application_v1(uuid,integer,integer,text,text,text)',
      'caseId',p_case_id,'expectedCaseVersionBeforeReserve',p_expected_case_version,
      'idempotencyKey',p_idempotency_key,'schemaVersion',1,'sessionUser',session_user))
$function$;

CREATE FUNCTION public."pos_manual_t2_application_currently_applicable_v1"(
  p_application_id uuid,p_actor_user_id text
)
RETURNS boolean LANGUAGE sql STABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
  SELECT EXISTS (
    SELECT 1
      FROM public."pos_manual_payment_applications" app
      JOIN public."pos_manual_payment_cases" manual_case ON manual_case."id"=app."case_id"
      JOIN public."pos_manual_finalization_profiles" profile
        ON profile."id"=app."finalization_profile_id"
       AND profile."version"=app."finalization_profile_version"
       AND profile."config_hash"=app."finalization_profile_hash"
      JOIN public."pos_manual_payment_reconciliation_gates" gate
        ON gate."connector_id"=manual_case."connector_id"
       AND gate."finalization_profile_id"=profile."id"
       AND gate."finalization_profile_version"=profile."version"
       AND gate."finalization_profile_hash"=profile."config_hash"
      JOIN public."tenant_user_profiles" actor
        ON actor."id"=app."reserved_by_profile_id" AND actor."user_id"=p_actor_user_id AND actor."status"='active'
      JOIN public."branch_user_accesses" branch_grant
        ON branch_grant."branch_id"=manual_case."branch_id" AND branch_grant."user_profile_id"=actor."id" AND branch_grant."can_sell"
      JOIN public."pos_register_accesses" register_grant
        ON register_grant."register_id"=manual_case."register_id" AND register_grant."user_profile_id"=actor."id"
       AND register_grant."active" AND register_grant."can_sell"
     WHERE app."id"=p_application_id AND app."reserved_by_user_id"=p_actor_user_id
       AND app."state" IN ('pending','claimed') AND app."reservation_expires_at">pg_catalog.clock_timestamp()
       AND (app."state"='pending' OR app."claim_expires_at">pg_catalog.clock_timestamp())
       AND manual_case."state"='application_pending' AND manual_case."version"=app."case_version_after_reserve"
       AND profile."state"='active' AND gate."enabled"
       AND (register_grant."valid_from" IS NULL OR register_grant."valid_from"<=pg_catalog.clock_timestamp())
       AND (register_grant."valid_until" IS NULL OR register_grant."valid_until">pg_catalog.clock_timestamp())
       AND NOT EXISTS (SELECT 1 FROM public."pos_manual_application_stock_reservations" reservation
         WHERE reservation."application_id"=app."id" AND reservation."state"<>'reserved')
       AND NOT EXISTS (SELECT 1 FROM public."pos_manual_application_promotion_reservations" reservation
         WHERE reservation."application_id"=app."id" AND reservation."state"<>'reserved'))
$function$;

CREATE FUNCTION public."pos_manual_t2_actor_authorized_for_case_v1"(
  p_case_id uuid,p_actor_profile_id integer,p_actor_user_id text
)
RETURNS boolean LANGUAGE sql STABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public."pos_manual_payment_cases" manual_case
    JOIN public."tenant_user_profiles" actor
      ON actor."id"=p_actor_profile_id AND actor."user_id"=p_actor_user_id AND actor."status"='active'
    JOIN public."branch_user_accesses" branch_grant
      ON branch_grant."branch_id"=manual_case."branch_id" AND branch_grant."user_profile_id"=actor."id" AND branch_grant."can_sell"
    JOIN public."pos_register_accesses" register_grant
      ON register_grant."register_id"=manual_case."register_id" AND register_grant."user_profile_id"=actor."id"
     AND register_grant."active" AND register_grant."can_sell"
    WHERE manual_case."id"=p_case_id AND manual_case."operator_profile_id"=p_actor_profile_id
      AND (register_grant."valid_from" IS NULL OR register_grant."valid_from"<=pg_catalog.clock_timestamp())
      AND (register_grant."valid_until" IS NULL OR register_grant."valid_until">pg_catalog.clock_timestamp()))
$function$;

CREATE FUNCTION public."pos_manual_t2_status_object_v1"(
  p_application_id uuid,p_actor_user_id text
)
RETURNS jsonb LANGUAGE plpgsql STABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE app public."pos_manual_payment_applications"%ROWTYPE; applicable boolean;
BEGIN
  SELECT candidate.* INTO app
    FROM public."pos_manual_payment_applications" candidate
   WHERE candidate."id"=p_application_id AND candidate."reserved_by_user_id"=p_actor_user_id;
  IF app.id IS NULL OR NOT public."pos_manual_t2_actor_authorized_for_case_v1"(
      app.case_id,app.reserved_by_profile_id,p_actor_user_id) THEN
    RETURN pg_catalog.jsonb_build_object('status','not_found'); END IF;
  applicable:=public."pos_manual_t2_application_currently_applicable_v1"(app.id,p_actor_user_id);
  IF (app.state='applied' AND (app.sale_id IS NULL OR app.sale_payment_id IS NULL OR app.failure_class IS NOT NULL OR app.blocked_code IS NOT NULL))
    OR (app.state='blocked' AND (app.sale_id IS NOT NULL OR app.sale_payment_id IS NOT NULL
      OR app.failure_class NOT IN ('boundary_changed','reservation_expired') OR app.blocked_code IS NULL))
    OR (app.state IN ('pending','claimed') AND (app.sale_id IS NOT NULL OR app.sale_payment_id IS NOT NULL OR app.blocked_code IS NOT NULL))
  THEN RAISE EXCEPTION 'T2 application status shape is corrupt' USING ERRCODE='23514'; END IF;
  RETURN pg_catalog.jsonb_build_object(
    'applicationId',app.id,'applicationVersion',app.version,'blockedCode',app.blocked_code,
    'caseId',app.case_id,'caseVersionAfterReserve',app.case_version_after_reserve,
    'currentlyApplicable',CASE WHEN app.state IN ('pending','claimed') THEN applicable ELSE false END,
    'failureClass',app.failure_class,'paymentId',app.sale_payment_id,
    'reservationExpiresAt',public."pos_manual_utc_micros_v1"(app.reservation_expires_at),
    'saleId',app.sale_id,'state',app.state);
END
$function$;

CREATE FUNCTION public."pos_manual_t2_reserve_result_v1"(
  p_application_id uuid,p_actor_user_id text,p_replayed boolean
)
RETURNS jsonb LANGUAGE plpgsql STABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE app public."pos_manual_payment_applications"%ROWTYPE;
BEGIN
  SELECT * INTO STRICT app FROM public."pos_manual_payment_applications" WHERE "id"=p_application_id;
  RETURN pg_catalog.jsonb_build_object(
    'applicationId',app.id,'applicationVersion',0,'caseId',app.case_id,
    'caseVersionAfterReserve',app.case_version_after_reserve,
    'caseVersionBeforeReserve',app.case_version_before_reserve,
    'currentlyApplicable',public."pos_manual_t2_application_currently_applicable_v1"(app.id,p_actor_user_id),
    'manifestHash',app.manifest_hash,'replayed',p_replayed,
    'reservationExpiresAt',public."pos_manual_utc_micros_v1"(app.reservation_expires_at),
    'snapshotHash',app.snapshot_hash,'state','pending');
END
$function$;

-- The legacy guard used to replace reserved_at inside its BEFORE trigger.
-- T2 builders must commit the complete row projection before opening the
-- one-shot write root, so a supplied post-lock timestamp is now preserved.
CREATE OR REPLACE FUNCTION public."guard_pos_manual_application"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE case_record public."pos_manual_payment_cases"%ROWTYPE;
  plan_record public."pos_payment_plans"%ROWTYPE;
BEGIN
  IF TG_OP='INSERT' THEN
    SELECT * INTO case_record FROM public."pos_manual_payment_cases" WHERE "id"=NEW."case_id" FOR UPDATE;
    SELECT * INTO plan_record FROM public."pos_payment_plans" WHERE "id"=case_record."payment_plan_id" FOR UPDATE;
    IF case_record."state"<>'confirmed_paid' OR case_record."confirmation_expires_at"<=pg_catalog.clock_timestamp()
      OR EXISTS (SELECT 1 FROM public."pos_manual_payment_incidents" incident
                  WHERE incident."case_id"=case_record."id" AND incident."status"='open' AND incident."production_blocking")
      OR ROW(NEW."payment_plan_id",NEW."payment_index",NEW."sale_draft_id",NEW."quote_hash",NEW."expected_plan_version")
        IS DISTINCT FROM ROW(case_record."payment_plan_id",case_record."payment_index",case_record."sale_draft_id",case_record."quote_hash",plan_record."version")
      OR NEW."sale_id" IS NOT NULL OR NEW."sale_payment_id" IS NOT NULL OR NEW."state"<>'pending'
      OR NEW."reserved_at" IS NULL
    THEN RAISE EXCEPTION 'manual application reservation diverges from confirmed case' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW."case_id",NEW."payment_plan_id",NEW."payment_index",NEW."sale_draft_id",NEW."quote_hash",NEW."expected_plan_version",NEW."sale_idempotency_key",NEW."sale_request_hash",NEW."idempotency_key",NEW."request_hash",NEW."reserved_by_profile_id",NEW."reserved_at",NEW."created_at")
    IS DISTINCT FROM ROW(OLD."case_id",OLD."payment_plan_id",OLD."payment_index",OLD."sale_draft_id",OLD."quote_hash",OLD."expected_plan_version",OLD."sale_idempotency_key",OLD."sale_request_hash",OLD."idempotency_key",OLD."request_hash",OLD."reserved_by_profile_id",OLD."reserved_at",OLD."created_at")
  THEN RAISE EXCEPTION 'manual application reservation identity is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END
$function$;

CREATE FUNCTION public."pos_manual_reserve_application_v1_impl"(
  p_case_id uuid,p_expected_case_version_before_reserve integer,p_actor_profile_id integer,
  p_actor_user_id text,p_idempotency_key text,p_request_hash text
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE STRICT SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE expected_hash text; application_id uuid; existing public."pos_manual_payment_applications"%ROWTYPE;
  manual_case public."pos_manual_payment_cases"%ROWTYPE; target_case public."pos_manual_payment_cases"%ROWTYPE;
  profile public."pos_manual_finalization_profiles"%ROWTYPE; plan_row public."pos_payment_plans"%ROWTYPE;
  slot_row public."pos_payment_plan_slots"%ROWTYPE; draft_row public."pos_held_sales"%ROWTYPE;
  observation_row public."pos_manual_payment_observations"%ROWTYPE;
  application_row public."pos_manual_payment_applications"%ROWTYPE;
  snapshot_row public."pos_manual_application_snapshots"%ROWTYPE;
  manifest_row public."pos_manual_application_manifest_entries"%ROWTYPE;
  stock_row public."pos_manual_application_stock_reservations"%ROWTYPE;
  stock_event public."pos_manual_application_stock_reservation_events"%ROWTYPE;
  assertion_row public."pos_manual_application_reserve_assertions"%ROWTYPE;
  operation_row public."pos_manual_payment_operations"%ROWTYPE;
  event_row public."pos_manual_payment_state_events"%ROWTYPE;
  branch_row public."branches"%ROWTYPE; register_row public."pos_registers"%ROWTYPE;
  branch_grant public."branch_user_accesses"%ROWTYPE; register_grant public."pos_register_accesses"%ROWTYPE;
  period_row public."pos_accounting_periods"%ROWTYPE; policy_row public."pos_accounting_policies"%ROWTYPE;
  q record; accounting_row record; item jsonb; entry jsonb;
  request_at timestamptz; expires_at timestamptz; tx numeric(20,0); business_date date;
  planned_sale_id integer; planned_sale_number text; planned_payment_id text;
  sale_idempotency_key text; payment_idempotency_key text; sale_request_hash text;
  journal_id text; journal_idempotency_key text; journal_request_hash text;
  subtotal_cents bigint; discount_cents bigint; surcharge_cents bigint; total_cents bigint;
  quantity_micros bigint; parent_before bigint; parent_after bigint;
  variation_before bigint; variation_after bigint; stock_mode text; reservation_key text;
  reservation_id uuid; reservation_event_id uuid; operation_id bigint; state_event_id bigint;
  warehouse_quantity double precision; warehouse_reserved double precision;
  variation_quantity double precision; variation_reserved double precision;
  operational_actor jsonb; case_evidence jsonb; draft_quote_slot jsonb;
  customer_sale_payment jsonb; catalog_bom_tracking jsonb; inventory_promotion jsonb;
  fiscal_doc jsonb; accounting_doc jsonb; webhooks_doc jsonb; manifest_doc jsonb;
  quote_lines jsonb:='[]'::jsonb; sale_items jsonb:='[]'::jsonb;
  products_doc jsonb:='[]'::jsonb; variations_doc jsonb:='[]'::jsonb;
  inventory_rows jsonb:='[]'::jsonb; mappings_doc jsonb:='[]'::jsonb;
  postings_doc jsonb:='[]'::jsonb; manifest_entries jsonb:='[]'::jsonb;
  sale_doc jsonb; payment_doc jsonb; source_facts jsonb; source_doc jsonb; journal_doc jsonb;
  source_hash text; customer_opaque_id text; eligibility_hash text;
  stock_multiset_hash text; promotion_multiset_hash text; reservation_graph_hash text;
  stock_count integer; mapping_count integer; sequence_no integer; effect_key text; effect_payload jsonb;
BEGIN
  PERFORM public."pos_manual_t2_assert_shape_v1"(p_idempotency_key,p_request_hash);
  IF p_expected_case_version_before_reserve<0 OR p_actor_profile_id<=0
    OR NOT public."pos_manual_t2_subject_safe_v1"(p_actor_user_id) THEN
    RAISE EXCEPTION 'invalid T2 reserve request shape' USING ERRCODE='22023'; END IF;
  expected_hash:=public."pos_manual_t2_reserve_request_hash_v1"(p_case_id,p_expected_case_version_before_reserve,p_actor_profile_id,p_actor_user_id,p_idempotency_key);
  IF p_request_hash<>expected_hash THEN RAISE EXCEPTION 'T2 reserve request hash mismatch' USING ERRCODE='23514'; END IF;
  application_id:=public."pos_manual_uuid16_v1"('t2-reserve-identity-v1',pg_catalog.jsonb_build_object('caseId',p_case_id,'idempotencyKey',p_idempotency_key,'schemaVersion',1));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('t2-reserve:key:'||p_idempotency_key,0));
  SELECT * INTO existing FROM public."pos_manual_payment_applications" WHERE "idempotency_key"=p_idempotency_key FOR UPDATE;
  IF existing.id IS NOT NULL THEN
    IF existing.id<>application_id OR existing.case_id<>p_case_id OR existing.request_hash<>p_request_hash
      OR existing.reserved_by_profile_id<>p_actor_profile_id OR existing.reserved_by_user_id<>p_actor_user_id
      OR existing.case_version_before_reserve<>p_expected_case_version_before_reserve THEN
      RAISE EXCEPTION 'T2 reserve idempotency conflict' USING ERRCODE='23505'; END IF;
    RETURN public."pos_manual_t2_reserve_result_v1"(existing.id,p_actor_user_id,true);
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('t2-reserve:case:'||p_case_id::text,0));
  SELECT * INTO manual_case FROM public."pos_manual_payment_cases" WHERE "id"=p_case_id FOR UPDATE;
  IF manual_case.id IS NULL OR manual_case.version<>p_expected_case_version_before_reserve
    OR manual_case.state<>'confirmed_paid' OR manual_case.operator_profile_id<>p_actor_profile_id
    OR manual_case.confirmed_observation_id IS NULL OR manual_case.confirmation_expires_at<=pg_catalog.clock_timestamp()
  THEN RAISE EXCEPTION 'T2 reserve boundary changed' USING ERRCODE='23514'; END IF;
  SELECT final_profile.* INTO profile
    FROM public."pos_manual_finalization_profiles" final_profile
    JOIN public."pos_manual_payment_reconciliation_gates" gate
      ON gate."connector_id"=manual_case.connector_id AND gate."enabled"
     AND gate."finalization_profile_id"=final_profile.id
     AND gate."finalization_profile_version"=final_profile.version
     AND gate."finalization_profile_hash"=final_profile.config_hash
   WHERE final_profile."branch_id"=manual_case.branch_id AND final_profile."state"='active' FOR SHARE OF final_profile;
  IF profile.id IS NULL THEN RAISE EXCEPTION 'manual reconciliation remains hard-disabled' USING ERRCODE='42501'; END IF;
  IF profile.fiscal_mode='required_queue' THEN
    RAISE EXCEPTION 'T2 required fiscal envelope is unavailable' USING ERRCODE='23514'; END IF;

  -- Canonical lock order: session/terminal/actor grants, plan/draft/slot,
  -- catalogue, stock dimensions and finally accounting boundaries.
  SELECT * INTO STRICT branch_row FROM public."branches" WHERE "id"=manual_case.branch_id FOR SHARE;
  IF branch_row.status<>'active' OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names zone WHERE zone.name=branch_row.timezone)
  THEN RAISE EXCEPTION 'T2 reserve boundary changed' USING ERRCODE='23514'; END IF;
  SELECT * INTO STRICT register_row FROM public."pos_registers" WHERE "id"=manual_case.register_id FOR SHARE;
  IF register_row.branch_id<>manual_case.branch_id OR register_row.status<>'active' OR register_row.warehouse_id IS NULL
  THEN RAISE EXCEPTION 'T2 reserve boundary changed' USING ERRCODE='23514'; END IF;
  PERFORM 1 FROM public."cash_register_sessions" session
   WHERE session."id"=manual_case.session_id AND session."register_id"=manual_case.register_id
     AND session."status"='open' AND session."operator_profile_id"=p_actor_profile_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'T2 reserve boundary changed' USING ERRCODE='23514'; END IF;
  PERFORM 1 FROM public."pos_terminals" terminal
   WHERE terminal."id"=manual_case.terminal_id AND terminal."register_id"=manual_case.register_id
     AND terminal."status"='online' AND terminal."revoked_at" IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'T2 reserve boundary changed' USING ERRCODE='23514'; END IF;
  SELECT * INTO branch_grant FROM public."branch_user_accesses" grant_row
   WHERE grant_row."branch_id"=manual_case.branch_id AND grant_row."user_profile_id"=p_actor_profile_id
     AND grant_row."can_sell" FOR SHARE;
  SELECT * INTO register_grant FROM public."pos_register_accesses" grant_row
   WHERE grant_row."register_id"=manual_case.register_id AND grant_row."user_profile_id"=p_actor_profile_id
     AND grant_row."active" AND grant_row."can_sell" AND grant_row."can_manual_payment"
     AND (grant_row."valid_from" IS NULL OR grant_row."valid_from"<=pg_catalog.clock_timestamp())
     AND (grant_row."valid_until" IS NULL OR grant_row."valid_until">pg_catalog.clock_timestamp()) FOR SHARE;
  IF branch_grant.id IS NULL OR register_grant.id IS NULL
    OR NOT EXISTS (SELECT 1 FROM public."tenant_user_profiles" actor
                    WHERE actor."id"=p_actor_profile_id AND actor."user_id"=p_actor_user_id AND actor."status"='active' FOR SHARE)
  THEN RAISE EXCEPTION 'T2 reserve actor denied' USING ERRCODE='42501'; END IF;

  SELECT * INTO plan_row FROM public."pos_payment_plans" WHERE "id"=manual_case.payment_plan_id FOR UPDATE;
  SELECT * INTO slot_row FROM public."pos_payment_plan_slots"
   WHERE "plan_id"=manual_case.payment_plan_id AND "payment_index"=0 FOR SHARE;
  SELECT * INTO draft_row FROM public."pos_held_sales" WHERE "id"=manual_case.sale_draft_id FOR UPDATE;
  SELECT * INTO observation_row FROM public."pos_manual_payment_observations"
   WHERE "case_id"=manual_case.id AND "id"=manual_case.confirmed_observation_id FOR SHARE;
  PERFORM 1 FROM public."pos_connectors" connector
    JOIN public."integration_credentials" credential ON credential."id"=manual_case.credential_ref
   WHERE connector."id"=manual_case.connector_id AND connector."branch_id"=manual_case.branch_id
     AND connector."provider"=manual_case.provider AND connector."revision"=manual_case.connector_revision
     AND connector."status"='active' AND connector."credential_ref"=credential."id"
     AND credential."revision"=manual_case.credential_revision AND credential."enabled"
     AND connector."settings" @> '{"manualReconciliation":{"enabled":true,"vaultBindingRequired":true}}'::jsonb
     AND connector."settings"->'capabilities' ? 'manual_reference_query'
   FOR SHARE OF connector,credential;
  IF NOT FOUND THEN RAISE EXCEPTION 'T2 reserve connector boundary changed' USING ERRCODE='23514'; END IF;
  IF plan_row.id IS NULL OR slot_row.plan_id IS NULL OR draft_row.id IS NULL OR observation_row.id IS NULL
    OR plan_row.state<>'active' OR plan_row.expires_at<=pg_catalog.clock_timestamp()
    OR plan_row.version<0 OR plan_row.branch_id<>manual_case.branch_id OR plan_row.register_id<>manual_case.register_id
    OR plan_row.session_id<>manual_case.session_id OR plan_row.operator_profile_id<>p_actor_profile_id
    OR plan_row.terminal_id<>manual_case.terminal_id OR plan_row.sale_draft_id<>manual_case.sale_draft_id
    OR plan_row.draft_revision<>draft_row.revision OR plan_row.draft_revision<>manual_case.draft_revision
    OR plan_row.draft_request_hash<>manual_case.draft_request_hash OR plan_row.quote_hash<>manual_case.quote_hash
    OR plan_row.currency<>'BRL' OR plan_row.total_cents<>manual_case.amount_cents
    OR slot_row.proof_kind<>'manual' OR slot_row.amount_cents<>plan_row.total_cents
    OR slot_row.method<>manual_case.method OR slot_row.installments<>manual_case.installments
    OR slot_row.provider<>manual_case.provider OR slot_row.payment_index<>0
    OR (SELECT pg_catalog.count(*) FROM public."pos_payment_plan_slots" WHERE "plan_id"=plan_row.id)<>1
    OR draft_row.status NOT IN ('draft','held') OR draft_row.customer_id IS NOT NULL
    OR observation_row.outcome<>'confirmed_paid' OR observation_row.resulting_state<>'confirmed_paid'
    OR observation_row.resulting_version<>manual_case.version
    OR observation_row.reference_hash<>manual_case.reference_hash OR observation_row.method<>manual_case.method
    OR observation_row.amount_cents<>manual_case.amount_cents OR observation_row.currency<>manual_case.currency
  THEN RAISE EXCEPTION 'T2 reserve boundary changed' USING ERRCODE='23514'; END IF;
  PERFORM 1 FROM public."pos_manual_payment_incidents" incident
   WHERE incident."case_id"=manual_case.id AND incident."status"='open'
     AND incident."production_blocking" AND incident."resolved_at" IS NULL ORDER BY incident."id" FOR SHARE;
  IF FOUND THEN RAISE EXCEPTION 'T2 reserve has blocking evidence incident' USING ERRCODE='23514'; END IF;
  IF observation_row.source='worker' THEN
    PERFORM 1 FROM public."pos_manual_payment_delivery_results" delivery
      JOIN public."pos_manual_payment_provider_proofs" proof ON proof."id"=delivery."provider_proof_id"
      JOIN public."pos_manual_payment_proof_consumptions" consumption
        ON consumption."proof_id"=proof."id" AND consumption."delivery_result_id"=delivery."id"
     WHERE delivery."attempt_id"=observation_row.attempt_id AND proof."source_kind"='query_response'
       AND proof."case_id"=manual_case.id AND proof."attempt_id"=observation_row.attempt_id
       AND proof."disposition"='accepted' AND proof."event_owner" AND proof."nonce_owner"
       AND proof."outcome"='confirmed_paid' AND proof."provider"=manual_case.provider
       AND proof."reference_hash"=manual_case.reference_hash AND proof."method"=manual_case.method
       AND proof."amount_cents"=manual_case.amount_cents AND proof."currency"=manual_case.currency
       AND proof."evidence_hash"=observation_row.evidence_hash
     FOR SHARE OF delivery,proof,consumption;
  ELSE
    PERFORM 1 FROM public."pos_manual_payment_callbacks" callback
      JOIN public."pos_manual_payment_provider_proofs" proof ON proof."id"=callback."ingress_proof_id"
     WHERE callback."id"=observation_row.callback_id AND callback."case_id"=manual_case.id
       AND proof."source_kind"='callback' AND proof."disposition"='accepted'
       AND proof."event_owner" AND proof."nonce_owner" AND proof."outcome"='confirmed_paid'
       AND proof."provider"=manual_case.provider AND proof."reference_hash"=manual_case.reference_hash
       AND proof."method"=manual_case.method AND proof."amount_cents"=manual_case.amount_cents
       AND proof."currency"=manual_case.currency AND proof."evidence_hash"=observation_row.evidence_hash
       AND callback."evidence_hash"=observation_row.evidence_hash
     FOR SHARE OF callback,proof;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'T2 confirmation proof graph is incomplete' USING ERRCODE='23514'; END IF;
  IF plan_row.promotion_id IS NOT NULL OR plan_row.coupon_id IS NOT NULL OR plan_row.promotion_discount_cents<>0 THEN
    RAISE EXCEPTION 'T2 promotion reservation requires the promotion policy builder' USING ERRCODE='23514'; END IF;
  IF profile.webhook_mode<>'disabled' THEN
    RAISE EXCEPTION 'T2 required webhook graph is unavailable' USING ERRCODE='23514'; END IF;
  IF EXISTS (SELECT 1 FROM public."pos_value_programs" program
              WHERE program."branch_id"=manual_case.branch_id AND program."status"='active') AND draft_row.customer_id IS NOT NULL THEN
    RAISE EXCEPTION 'T2 customer value graph is unavailable' USING ERRCODE='23514'; END IF;
  IF (SELECT pg_catalog.count(*) FROM public."pos_payment_plan_quote_lines" WHERE "plan_id"=plan_row.id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'T2 reserve graph exceeds limit' USING ERRCODE='22023'; END IF;
  PERFORM 1 FROM public."product_variations" variation
    JOIN public."pos_payment_plan_quote_lines" line ON line."variation_id"=variation."id"
   WHERE line."plan_id"=plan_row.id ORDER BY variation."id" FOR SHARE OF variation;
  IF EXISTS (SELECT 1 FROM public."pos_payment_plan_quote_lines" line
              JOIN public."pos_held_sale_items" held ON held."id"=line."held_sale_item_id"
             WHERE line."plan_id"=plan_row.id AND (held."scan_data" IS NOT NULL OR held."notes" IS NOT NULL))
    OR EXISTS (SELECT 1 FROM public."pos_payment_plan_quote_lines" line
               JOIN public."pos_kit_boms" bom ON bom."branch_id"=manual_case.branch_id
                AND bom."status"='active' AND bom."kit_product_id"=line."product_id"
                AND bom."kit_variation_id" IS NOT DISTINCT FROM line."variation_id"
              WHERE line."plan_id"=plan_row.id)
    OR EXISTS (SELECT 1 FROM public."pos_payment_plan_quote_lines" line
               JOIN public."pos_inventory_lots" lot ON lot."warehouse_id"=register_row.warehouse_id
                AND lot."product_id"=line."product_id" AND lot."variation_id" IS NOT DISTINCT FROM line."variation_id"
              WHERE line."plan_id"=plan_row.id)
  THEN RAISE EXCEPTION 'T2 tracked/FEFO/BOM reservation graph is unavailable' USING ERRCODE='23514'; END IF;

  subtotal_cents:=0; discount_cents:=0; surcharge_cents:=0; total_cents:=0;
  FOR q IN
    SELECT line.*,product."name" AS product_name,product."sku" AS product_sku,product."gtin" AS product_gtin,
           product."unit",product."type" AS product_type,product."active" AS product_active,
           product."status" AS product_status,product."manage_stock" AS product_manage_stock,
           product."pos_revision" AS product_revision,product."pos_config_hash" AS product_config_hash,
           variation."sku" AS variation_sku,variation."gtin" AS variation_gtin,
           variation."enabled" AS variation_enabled,variation."status" AS variation_status,
           variation."manage_stock" AS variation_manage_stock,variation."pos_revision" AS variation_revision,
           variation."pos_config_hash" AS variation_config_hash
      FROM public."pos_payment_plan_quote_lines" line
      JOIN public."products" product ON product."id"=line."product_id"
      LEFT JOIN public."product_variations" variation ON variation."id"=line."variation_id" AND variation."product_id"=line."product_id"
      JOIN public."branch_products" branch_product ON branch_product."branch_id"=manual_case.branch_id
       AND branch_product."product_id"=line."product_id" AND branch_product."active" AND branch_product."sale_enabled"
     WHERE line."plan_id"=plan_row.id ORDER BY line."line_index",line."held_sale_item_id" FOR SHARE OF line,product,branch_product
  LOOP
    quantity_micros:=public."pos_manual_t2_float_to_micros_v1"(q.quantity);
    IF quantity_micros<=0 OR NOT q.product_active OR q.product_status<>'publish'
      OR (q.variation_id IS NOT NULL AND (q.variation_revision IS NULL OR NOT q.variation_enabled OR q.variation_status<>'publish'))
      OR pg_catalog.octet_length(q.product_name) NOT BETWEEN 1 AND 128
      OR q.product_name<>normalize(q.product_name,NFC) OR q.product_name~'[[:cntrl:]]'
    THEN RAISE EXCEPTION 'T2 catalogue boundary changed' USING ERRCODE='23514'; END IF;
    subtotal_cents:=subtotal_cents+q.gross_cents;
    discount_cents:=discount_cents+q.base_discount_cents+q.order_discount_cents+q.promotion_discount_cents;
    surcharge_cents:=surcharge_cents+q.surcharge_cents; total_cents:=total_cents+q.total_cents;
    quote_lines:=quote_lines||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'baseDiscountCents',q.base_discount_cents,'grossCents',q.gross_cents,'heldSaleItemId',q.held_sale_item_id,
      'lineIndex',q.line_index,'orderDiscountCents',q.order_discount_cents,'productId',q.product_id,
      'promotionDiscountCents',q.promotion_discount_cents,'quantityMicros',quantity_micros,
      'surchargeCents',q.surcharge_cents,'totalCents',q.total_cents,'unitPriceCents',q.unit_price_cents,'variationId',q.variation_id));
    sale_items:=sale_items||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'baseDiscountCents',q.base_discount_cents,'grossCents',q.gross_cents,
      'gtinSnapshot',COALESCE(q.variation_gtin,q.product_gtin),'lineIndex',q.line_index,
      'orderDiscountCents',q.order_discount_cents,'productId',q.product_id,'productNameLabel',q.product_name,
      'promotionDiscountCents',q.promotion_discount_cents,'quantityMicros',quantity_micros,
      'skuSnapshot',COALESCE(q.variation_sku,q.product_sku),'surchargeCents',q.surcharge_cents,
      'totalCents',q.total_cents,'unit',q.unit,'unitPriceCents',q.unit_price_cents,'variationId',q.variation_id));
    products_doc:=products_doc||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'active',q.product_active,'configHash',q.product_config_hash,'gtinSnapshot',q.product_gtin,
      'manageStock',q.product_manage_stock,'nameLabel',q.product_name,'posRevision',q.product_revision,
      'productId',q.product_id,'productType',q.product_type,'skuSnapshot',q.product_sku,
      'status',q.product_status,'unit',q.unit));
    IF q.variation_id IS NOT NULL THEN
      variations_doc:=variations_doc||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'configHash',q.variation_config_hash,'enabled',q.variation_enabled,'gtinSnapshot',q.variation_gtin,
        'manageStock',q.variation_manage_stock,'posRevision',q.variation_revision,'productId',q.product_id,
        'skuSnapshot',q.variation_sku,'status',q.variation_status,'variationId',q.variation_id));
    END IF;
    stock_mode:=public."pos_manual_t2_stock_mode_v1"(q.product_type,q.product_manage_stock,q.variation_id,q.variation_manage_stock);
    IF stock_mode<>'none' THEN
      IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(inventory_rows) prior
                  WHERE (prior->>'warehouseId')::integer=register_row.warehouse_id
                    AND (prior->>'productId')::integer=q.product_id
                    AND (prior->>'variationId') IS NOT DISTINCT FROM CASE WHEN q.variation_id IS NULL THEN NULL ELSE q.variation_id::text END)
      THEN RAISE EXCEPTION 'T2 snapshot multiset is ambiguous' USING ERRCODE='23514'; END IF;
      SELECT balance."quantity",balance."reserved_quantity" INTO STRICT warehouse_quantity,warehouse_reserved
        FROM public."warehouse_balances" balance
       WHERE balance."warehouse_id"=register_row.warehouse_id AND balance."product_id"=q.product_id FOR UPDATE;
      parent_before:=public."pos_manual_t2_float_to_micros_v1"(warehouse_reserved);
      IF public."pos_manual_t2_float_to_micros_v1"(warehouse_quantity)-parent_before<quantity_micros
      THEN RAISE EXCEPTION 'T2 insufficient stock' USING ERRCODE='23514'; END IF;
      parent_after:=parent_before+quantity_micros; variation_before:=NULL; variation_after:=NULL;
      IF stock_mode='variation' THEN
        SELECT balance."quantity",balance."reserved_quantity" INTO STRICT variation_quantity,variation_reserved
          FROM public."warehouse_variation_balances" balance
         WHERE balance."warehouse_id"=register_row.warehouse_id AND balance."product_id"=q.product_id
           AND balance."variation_id"=q.variation_id FOR UPDATE;
        variation_before:=public."pos_manual_t2_float_to_micros_v1"(variation_reserved);
        IF public."pos_manual_t2_float_to_micros_v1"(variation_quantity)-variation_before<quantity_micros
        THEN RAISE EXCEPTION 'T2 insufficient variation stock' USING ERRCODE='23514'; END IF;
        variation_after:=variation_before+quantity_micros;
      END IF;
      reservation_key:='stock:'||public."pos_manual_hash_canonical_json_v1"('t2-stock-reservation-key-v1',pg_catalog.jsonb_build_object(
        'applicationId',application_id,'componentScopeKey',NULL,'lotId',NULL,'productId',q.product_id,
        'quoteLineIndex',q.line_index,'schemaVersion',1,'stockMode',stock_mode,
        'variationId',q.variation_id,'warehouseId',register_row.warehouse_id));
      reservation_id:=public."pos_manual_uuid16_v1"('t2-reservation-id-v1',pg_catalog.jsonb_build_object(
        'applicationId',application_id,'reservationKind','stock','reservationKey',reservation_key,'schemaVersion',1));
      inventory_rows:=inventory_rows||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'componentScopeKey',NULL,'heldSaleItemId',q.held_sale_item_id,'lotId',NULL,
        'lotReservedAfterMicros',NULL,'lotReservedBeforeMicros',NULL,
        'parentReservedAfterMicros',parent_after,'parentReservedBeforeMicros',parent_before,
        'productId',q.product_id,'quantityMicros',quantity_micros,'quoteLineIndex',q.line_index,
        'reservationId',reservation_id,'reservationKey',reservation_key,'stockMode',stock_mode,
        'trackingKind','none','variationId',q.variation_id,'variationReservedAfterMicros',variation_after,
        'variationReservedBeforeMicros',variation_before,'warehouseId',register_row.warehouse_id));
    END IF;
  END LOOP;
  IF subtotal_cents NOT BETWEEN 0 AND 2147483647 OR discount_cents NOT BETWEEN 0 AND 2147483647
    OR surcharge_cents NOT BETWEEN 0 AND 2147483647 OR total_cents NOT BETWEEN 1 AND 2147483647
    OR total_cents+discount_cents<>subtotal_cents+surcharge_cents OR total_cents<>plan_row.total_cents
  THEN RAISE EXCEPTION 'T2 sale totals do not close' USING ERRCODE='23514'; END IF;

  -- Remove duplicate catalogue projections and preserve the byte-defined order.
  SELECT COALESCE(pg_catalog.jsonb_agg(value ORDER BY (value->>'productId')::integer),'[]'::jsonb) INTO products_doc
    FROM (SELECT DISTINCT ON ((value->>'productId')::integer) value
            FROM pg_catalog.jsonb_array_elements(products_doc) ORDER BY (value->>'productId')::integer) unique_products;
  SELECT COALESCE(pg_catalog.jsonb_agg(value ORDER BY (value->>'variationId')::integer),'[]'::jsonb) INTO variations_doc
    FROM (SELECT DISTINCT ON ((value->>'variationId')::integer) value
            FROM pg_catalog.jsonb_array_elements(variations_doc) ORDER BY (value->>'variationId')::integer) unique_variations;
  SELECT COALESCE(pg_catalog.jsonb_agg(value ORDER BY value->>'reservationKey'),'[]'::jsonb) INTO inventory_rows
    FROM pg_catalog.jsonb_array_elements(inventory_rows);

  request_at:=date_trunc('microseconds',pg_catalog.clock_timestamp()); tx:=pg_catalog.txid_current()::numeric;
  IF manual_case.confirmation_expires_at<=request_at OR plan_row.expires_at<=request_at THEN
    RAISE EXCEPTION 'T2 reserve boundary changed' USING ERRCODE='23514'; END IF;
  expires_at:=request_at+pg_catalog.make_interval(secs=>profile.reservation_ttl_seconds);
  planned_sale_id:=pg_catalog.nextval(pg_catalog.pg_get_serial_sequence('public.sales','id'))::integer;
  planned_sale_number:='PDV-'||pg_catalog.to_char(request_at AT TIME ZONE 'UTC','YYYYMMDD')||'-'||pg_catalog.lpad(planned_sale_id::text,10,'0');
  planned_payment_id:=public."pos_manual_uuid16_v1"('t2-sale-payment-identity-v1',pg_catalog.jsonb_build_object(
    'applicationId',application_id,'paymentIndex',0,'schemaVersion',1))::text;
  sale_idempotency_key:=public."pos_manual_hash_canonical_json_v1"('t2-sale-idempotency-v1',pg_catalog.jsonb_build_object(
    'applicationId',application_id,'schemaVersion',1));
  payment_idempotency_key:=public."pos_manual_hash_canonical_json_v1"('t2-sale-payment-idempotency-v1',pg_catalog.jsonb_build_object(
    'applicationId',application_id,'paymentIndex',0,'schemaVersion',1));
  business_date:=(request_at AT TIME ZONE branch_row.timezone)::date;
  customer_opaque_id:=public."pos_manual_hash_canonical_json_v1"('t2-customer-opaque-v1',pg_catalog.jsonb_build_object('customerId',NULL,'schemaVersion',1));
  eligibility_hash:=public."pos_manual_hash_canonical_json_v1"('t2-customer-eligibility-v1',pg_catalog.jsonb_build_object(
    'branchId',manual_case.branch_id,'customerOpaqueId',customer_opaque_id,'eligible',true,'schemaVersion',1));
  payment_doc:=pg_catalog.jsonb_build_object('amountCents',manual_case.amount_cents,'changeCents',0,'currency','BRL',
    'evidenceHash',observation_row.evidence_hash,'installments',manual_case.installments,'method',manual_case.method,
    'observationId',observation_row.id::text,'paymentIdempotencyKey',payment_idempotency_key,'paymentIndex',0,
    'plannedPaymentId',planned_payment_id,'provider',manual_case.provider,'referenceLastFour',manual_case.reference_last_four,
    'status','manual_confirmed','tenderedCents',manual_case.amount_cents,'type','payment');
  sale_doc:=pg_catalog.jsonb_build_object('branchId',manual_case.branch_id,'cashRegisterLegacyLabel','CAIXA:'||manual_case.register_id,
    'changeCents',0,'currency','BRL','customerId',NULL,'customerLegacyLabel','CONSUMIDOR','discountCents',discount_cents,
    'draftId',draft_row.id,'idempotencyKey',sale_idempotency_key,'occurredAt',public."pos_manual_utc_micros_v1"(request_at),
    'operatorProfileId',p_actor_profile_id,'paymentMethodLegacy',manual_case.method,'plannedSaleId',planned_sale_id,
    'registerId',manual_case.register_id,'saleNumber',planned_sale_number,'sellerLegacyLabel','OPERADOR:'||p_actor_profile_id,
    'sessionId',manual_case.session_id,'sourceId',application_id,'sourceType','manual_payment_application','status','completed',
    'subtotalCents',subtotal_cents,'surchargeCents',surcharge_cents,'terminalId',manual_case.terminal_id,
    'totalCents',total_cents,'warehouseId',register_row.warehouse_id);
  sale_request_hash:=public."pos_manual_hash_canonical_json_v1"('t2-sale-request-v1',sale_doc);
  sale_doc:=sale_doc||pg_catalog.jsonb_build_object('requestHash',sale_request_hash);

  operational_actor:=pg_catalog.jsonb_build_object('actorProfileId',p_actor_profile_id,'actorUserId',p_actor_user_id,
    'branchGrantId',branch_grant.id::text,'branchId',manual_case.branch_id,'branchTimezone',branch_row.timezone,
    'registerGrantId',register_grant.id::text,'registerId',manual_case.register_id,'schemaVersion',1,
    'sessionId',manual_case.session_id,'terminalId',manual_case.terminal_id);
  case_evidence:=pg_catalog.jsonb_build_object('amountCents',manual_case.amount_cents,'caseId',manual_case.id,
    'caseVersion',manual_case.version,'currency','BRL','evidenceHash',observation_row.evidence_hash,'method',manual_case.method,
    'observationId',observation_row.id::text,'provider',manual_case.provider,'referenceLastFour',manual_case.reference_last_four,'schemaVersion',1);
  draft_quote_slot:=pg_catalog.jsonb_build_object('connectorId',manual_case.connector_id,'connectorRevision',manual_case.connector_revision,
    'credentialRef',manual_case.credential_ref,'credentialRevision',manual_case.credential_revision,'draftId',draft_row.id,
    'draftRequestHash',manual_case.draft_request_hash,'draftRevision',draft_row.revision,'planId',plan_row.id,
    'planVersion',plan_row.version,'quoteHash',plan_row.quote_hash,'quoteLines',quote_lines,'schemaVersion',1,
    'slot',pg_catalog.jsonb_build_object('amountCents',slot_row.amount_cents,'installments',slot_row.installments,
      'method',slot_row.method,'paymentIndex',0,'proofKind','manual','provider',slot_row.provider));
  customer_sale_payment:=pg_catalog.jsonb_build_object('customerOpaqueId',customer_opaque_id,'eligibilityHash',eligibility_hash,
    'payment',payment_doc,'sale',sale_doc,'saleItems',sale_items,'schemaVersion',1,
    'value',pg_catalog.jsonb_build_object('accounts','[]'::jsonb,'accruals','[]'::jsonb,'programs','[]'::jsonb));
  catalog_bom_tracking:=pg_catalog.jsonb_build_object('bom','[]'::jsonb,'businessDate',business_date,
    'products',products_doc,'schemaVersion',1,'tracking','[]'::jsonb,'variations',variations_doc);
  inventory_promotion:=pg_catalog.jsonb_build_object('inventoryReservations',inventory_rows,
    'promotionReservations','[]'::jsonb,'schemaVersion',1);
  fiscal_doc:=pg_catalog.jsonb_build_object('disposition','not_applicable_homologated','documentModel',NULL,
    'envelopeBindingHash',NULL,'envelopeHash',NULL,'envelopeId',NULL,'envelopeLocator',NULL,
    'envelopePreparedHash',NULL,'envelopeVersion',NULL,'environment',NULL,'expected',NULL,
    'mode','not_applicable','number',NULL,'numberingOwner',NULL,'plannedSaleIdentityHash',NULL,
    'policyHash',profile.fiscal_policy_hash,'profileId',NULL,'profileVersion',NULL,'schemaVersion',1,'series',NULL);
  webhooks_doc:=pg_catalog.jsonb_build_object('endpoints','[]'::jsonb,'payloads','[]'::jsonb,'schemaVersion',1);

  SELECT * INTO policy_row FROM public."pos_accounting_policies" policy
   WHERE policy."id"=profile.accounting_policy_id AND policy."branch_id"=manual_case.branch_id
     AND policy."version"=profile.accounting_policy_version AND policy."mapping_hash"=profile.accounting_policy_hash
     AND policy."status"='active' AND policy."currency"='BRL' AND policy."effective_from"<=business_date
     AND (policy."effective_until" IS NULL OR policy."effective_until">=business_date) FOR SHARE;
  SELECT * INTO period_row FROM public."pos_accounting_periods" period
   WHERE period."branch_id"=manual_case.branch_id AND period."currency"='BRL' AND period."status"='open'
     AND business_date BETWEEN period."starts_at" AND period."ends_at" FOR UPDATE;
  IF policy_row.id IS NULL OR period_row.id IS NULL THEN
    RAISE EXCEPTION 'T2 accounting boundary changed' USING ERRCODE='23514'; END IF;
  IF EXISTS (SELECT 1 FROM public."pos_accounting_policy_mappings" mapping
              WHERE mapping."policy_id"=policy_row.id AND mapping."source_type"='sale'
                AND mapping."entry_key" NOT IN ('sale.tender','sale.revenue','sale.discount','sale.surcharge'))
  THEN RAISE EXCEPTION 'T2 accounting mapping set is not closed' USING ERRCODE='23514'; END IF;
  mapping_count:=0; sequence_no:=0;
  FOR accounting_row IN
    SELECT mapping.*,account."code" AS account_code,account."name" AS account_name,expected.amount_cents,
           expected.sequence_no,expected.description_label
      FROM (VALUES ('sale.tender'::text,'debit'::text,total_cents::bigint,1,'VENDA:TENDER'::text,true),
                   ('sale.revenue','credit',subtotal_cents::bigint,2,'VENDA:REVENUE',true),
                   ('sale.discount','debit',discount_cents::bigint,3,'VENDA:DESCONTO',discount_cents>0),
                   ('sale.surcharge','credit',surcharge_cents::bigint,4,'VENDA:ACRESCIMO',surcharge_cents>0))
           expected(entry_key,direction,amount_cents,sequence_no,description_label,present)
      JOIN public."pos_accounting_policy_mappings" mapping ON mapping."policy_id"=policy_row.id
       AND mapping."source_type"='sale' AND mapping."entry_key"=expected.entry_key AND mapping."direction"=expected.direction
      JOIN public."pos_accounting_accounts" account ON account."id"=mapping."account_id" AND account."status"='active'
     WHERE expected.present ORDER BY expected.sequence_no FOR SHARE OF mapping,account
  LOOP
    IF pg_catalog.octet_length(accounting_row.account_code) NOT BETWEEN 1 AND 128
      OR pg_catalog.octet_length(accounting_row.account_name) NOT BETWEEN 1 AND 128
      OR accounting_row.account_code<>normalize(accounting_row.account_code,NFC)
      OR accounting_row.account_name<>normalize(accounting_row.account_name,NFC)
      OR accounting_row.account_code~'[[:cntrl:]]' OR accounting_row.account_name~'[[:cntrl:]]'
    THEN RAISE EXCEPTION 'T2 accounting label is invalid' USING ERRCODE='23514'; END IF;
    mapping_count:=mapping_count+1;
    mappings_doc:=mappings_doc||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'accountCodeSnapshot',accounting_row.account_code,'accountId',accounting_row.account_id,
      'accountNameSnapshot',accounting_row.account_name,'configHash',accounting_row.config_hash,
      'direction',accounting_row.direction,'entryKey',accounting_row.entry_key,'mappingId',accounting_row.id,'sourceType','sale'));
    postings_doc:=postings_doc||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'accountCodeSnapshot',accounting_row.account_code,'accountId',accounting_row.account_id,
      'accountNameSnapshot',accounting_row.account_name,'amountCents',accounting_row.amount_cents,
      'amountDecimal',pg_catalog.to_char(accounting_row.amount_cents::numeric/100,'FM99999999999999999990.00'),
      'descriptionLabel',accounting_row.description_label,'dimensions',NULL,'direction',accounting_row.direction,
      'entryKey',accounting_row.entry_key,'mappingId',accounting_row.id,'sequence',accounting_row.sequence_no));
  END LOOP;
  IF mapping_count<>(2+(discount_cents>0)::integer+(surcharge_cents>0)::integer)
    OR (SELECT pg_catalog.count(*) FROM public."pos_accounting_policy_mappings" mapping
         WHERE mapping."policy_id"=policy_row.id AND mapping."source_type"='sale')<>mapping_count
  THEN RAISE EXCEPTION 'T2 accounting mapping set is incomplete' USING ERRCODE='23514'; END IF;
  journal_id:=public."pos_manual_uuid16_v1"('t2-accounting-journal-identity-v1',pg_catalog.jsonb_build_object(
    'applicationId',application_id,'schemaVersion',1))::text;
  journal_idempotency_key:=public."pos_manual_hash_canonical_json_v1"('t2-accounting-journal-idempotency-v1',pg_catalog.jsonb_build_object(
    'applicationId',application_id,'journalId',journal_id,'schemaVersion',1));
  source_facts:=pg_catalog.jsonb_build_object('discountCents',discount_cents,'paymentIds',pg_catalog.jsonb_build_array(planned_payment_id),
    'saleId',planned_sale_id,'status','completed','subtotalCents',subtotal_cents,'surchargeCents',surcharge_cents,'totalCents',total_cents);
  source_doc:=pg_catalog.jsonb_build_object('competenceDate',business_date,'facts',source_facts,
    'factsHash',pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(public."pos_manual_canonical_json_v1"(source_facts),'UTF8')),'hex'),
    'schemaVersion',1,'sourceId',planned_sale_id::text,'sourceType','sale','sourceVersion',1);
  source_hash:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(public."pos_manual_canonical_json_v1"(source_doc),'UTF8')),'hex');
  journal_request_hash:=public."pos_manual_hash_canonical_json_v1"('t2-accounting-journal-request-v1',pg_catalog.jsonb_build_object(
    'accountingSnapshotHash',source_hash,'applicationId',application_id,'journalId',journal_id,'schemaVersion',1));
  journal_doc:=pg_catalog.jsonb_build_object('branchId',manual_case.branch_id,'competenceDate',business_date,
    'costCenterId',profile.cost_center_id,'createdBy',p_actor_user_id,'currency','BRL',
    'descriptionLabel','VENDA PDV MANUAL:'||planned_sale_number,'idempotencyKey',journal_idempotency_key,
    'journalId',journal_id,'occurredAt',public."pos_manual_utc_micros_v1"(request_at),'originId',planned_sale_id::text,
    'originType','sale','originVersion',1,'periodId',period_row.id,'plannedSaleId',planned_sale_id,
    'policyHash',policy_row.mapping_hash,'policyId',policy_row.id,'policyVersion',policy_row.version,
    'requestHash',journal_request_hash,'sourceSnapshotHash',source_hash,
    'totalCreditCents',subtotal_cents+surcharge_cents,'totalDebitCents',total_cents+discount_cents);
  accounting_doc:=pg_catalog.jsonb_build_object('journal',journal_doc,'mappings',mappings_doc,
    'period',pg_catalog.jsonb_build_object('endsOn',period_row.ends_at,'periodConfigHash',period_row.config_hash,
      'periodId',period_row.id,'periodRevision',period_row.revision,'startsOn',period_row.starts_at,'status',period_row.status),
    'postings',postings_doc,'schemaVersion',1,'source',source_doc);

  -- Complete effect intent. Optional empty kinds are represented by one
  -- explicit sentinel, never by omission.
  effect_payload:=pg_catalog.jsonb_build_object('sale',sale_doc);
  manifest_entries:=manifest_entries||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('effectKey','sale','effectKind','sale',
    'expectedCardinality',1,'expectedHash',public."pos_manual_hash_canonical_json_v1"('t2-effect-v1',pg_catalog.jsonb_build_object('effectKey','sale','effectKind','sale','payload',effect_payload,'schemaVersion',1)),'required',true));
  sequence_no:=0;
  FOR item IN SELECT value FROM pg_catalog.jsonb_array_elements(sale_items) ORDER BY (value->>'lineIndex')::integer LOOP
    effect_key:='sale_item:'||pg_catalog.lpad(sequence_no::text,6,'0'); effect_payload:=pg_catalog.jsonb_build_object('item',item,'plannedSaleId',planned_sale_id);
    manifest_entries:=manifest_entries||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('effectKey',effect_key,'effectKind','sale_item','expectedCardinality',1,
      'expectedHash',public."pos_manual_hash_canonical_json_v1"('t2-effect-v1',pg_catalog.jsonb_build_object('effectKey',effect_key,'effectKind','sale_item','payload',effect_payload,'schemaVersion',1)),'required',true));
    sequence_no:=sequence_no+1;
  END LOOP;
  FOR entry IN SELECT * FROM (VALUES
      ('sale_payment'::text,'sale_payment:000000'::text,pg_catalog.jsonb_build_object('caseId',manual_case.id,'payment',payment_doc,'plannedSaleId',planned_sale_id)),
      ('plan_consume','plan_consume:plan',pg_catalog.jsonb_build_object('after',pg_catalog.jsonb_build_object('consumedAt',public."pos_manual_utc_micros_v1"(request_at),'consumedSaleId',planned_sale_id,'state','consumed','version',plan_row.version+1),'before',pg_catalog.jsonb_build_object('state','active','version',plan_row.version),'planId',plan_row.id)),
      ('draft_convert','draft_convert:draft',pg_catalog.jsonb_build_object('after',pg_catalog.jsonb_build_object('revision',draft_row.revision+1,'status','converted'),'before',pg_catalog.jsonb_build_object('revision',draft_row.revision,'status',draft_row.status),'consumedAt',public."pos_manual_utc_micros_v1"(request_at),'draftId',draft_row.id,'plannedSaleId',planned_sale_id)),
      ('accounting_journal','accounting_journal:journal',pg_catalog.jsonb_build_object('journal',journal_doc,'source',source_doc)),
      ('accounting_export_outbox','accounting_export_outbox:outbox',pg_catalog.jsonb_build_object('deliveryCount',0,'journalId',journal_id,'maxDeliveries',8,'nextAttemptAt',public."pos_manual_utc_micros_v1"(request_at),'state','pending')),
      ('sale_event','sale_event:completed',pg_catalog.jsonb_build_object('actorId',p_actor_user_id,'actorNameLabel','OPERADOR:'||p_actor_profile_id,'causationId',application_id,'correlationId',application_id,'data',pg_catalog.jsonb_build_object('applicationId',application_id,'caseId',manual_case.id),'eventKind','completed','occurredAt',public."pos_manual_utc_micros_v1"(request_at),'plannedSaleId',planned_sale_id)),
      ('audit_event','audit_event:manual-application-applied',pg_catalog.jsonb_build_object('action','manual_application_applied','actorProfileId',p_actor_profile_id,'actorUserId',p_actor_user_id,'after',pg_catalog.jsonb_build_object('applicationId',application_id,'caseId',manual_case.id,'plannedSaleId',planned_sale_id),'before',NULL,'correlationId',application_id,'entityId',planned_sale_id,'entityType','sale','eventKind','manual_application_applied'))
    ) required(effect_kind,effect_key,payload)
  LOOP
    manifest_entries:=manifest_entries||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('effectKey',entry.effect_key,'effectKind',entry.effect_kind,'expectedCardinality',1,
      'expectedHash',public."pos_manual_hash_canonical_json_v1"('t2-effect-v1',pg_catalog.jsonb_build_object('effectKey',entry.effect_key,'effectKind',entry.effect_kind,'payload',entry.payload,'schemaVersion',1)),'required',true));
  END LOOP;
  FOR item IN SELECT value FROM pg_catalog.jsonb_array_elements(postings_doc) ORDER BY (value->>'sequence')::integer LOOP
    effect_key:='accounting_posting:'||public."pos_manual_hash_canonical_json_v1"('t2-effect-key-v1',pg_catalog.jsonb_build_object(
      'effectKind','accounting_posting','identity',pg_catalog.jsonb_build_object('entryKey',item->>'entryKey','mappingId',item->>'mappingId'),'schemaVersion',1));
    effect_payload:=pg_catalog.jsonb_build_object('journalId',journal_id,'posting',item);
    manifest_entries:=manifest_entries||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('effectKey',effect_key,'effectKind','accounting_posting','expectedCardinality',1,
      'expectedHash',public."pos_manual_hash_canonical_json_v1"('t2-effect-v1',pg_catalog.jsonb_build_object('effectKey',effect_key,'effectKind','accounting_posting','payload',effect_payload,'schemaVersion',1)),'required',true));
  END LOOP;
  FOR item IN SELECT value FROM pg_catalog.jsonb_array_elements(inventory_rows) LOOP
    FOR entry IN SELECT * FROM (VALUES ('stock_movement'::text),('warehouse_ledger'::text)) kinds(effect_kind) LOOP
      effect_key:=entry.effect_kind||':'||public."pos_manual_hash_canonical_json_v1"('t2-effect-key-v1',pg_catalog.jsonb_build_object(
        'effectKind',entry.effect_kind,'identity',pg_catalog.jsonb_build_object('reservationKey',item->>'reservationKey'),'schemaVersion',1));
      effect_payload:=CASE WHEN entry.effect_kind='stock_movement'
        THEN pg_catalog.jsonb_build_object('deltaMicros',-(item->>'quantityMicros')::bigint,'plannedSaleId',planned_sale_id,'reservation',item)
        ELSE pg_catalog.jsonb_build_object('deltaMicros',-(item->>'quantityMicros')::bigint,'entryType','sale','plannedSaleId',planned_sale_id,'reservation',item) END;
      manifest_entries:=manifest_entries||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('effectKey',effect_key,'effectKind',entry.effect_kind,'expectedCardinality',1,
        'expectedHash',public."pos_manual_hash_canonical_json_v1"('t2-effect-v1',pg_catalog.jsonb_build_object('effectKey',effect_key,'effectKind',entry.effect_kind,'payload',effect_payload,'schemaVersion',1)),'required',true));
    END LOOP;
  END LOOP;
  FOR entry IN SELECT * FROM (VALUES
    ('promotion_redemption'::text),('kit_component'),('tracked_lot_movement'),('value_account'),('value_ledger_entry'),
    ('value_accrual'),('fiscal_document'),('fiscal_attempt'),('fiscal_outbox'),('webhook_delivery')) optional(effect_kind)
  LOOP
    effect_key:=entry.effect_kind||':none'; effect_payload:=pg_catalog.jsonb_build_object('present',false);
    manifest_entries:=manifest_entries||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('effectKey',effect_key,'effectKind',entry.effect_kind,'expectedCardinality',0,
      'expectedHash',public."pos_manual_hash_canonical_json_v1"('t2-effect-v1',pg_catalog.jsonb_build_object('effectKey',effect_key,'effectKind',entry.effect_kind,'payload',effect_payload,'schemaVersion',1)),'required',false));
  END LOOP;
  IF pg_catalog.jsonb_array_length(inventory_rows)=0 THEN
    FOR entry IN SELECT * FROM (VALUES ('stock_movement'::text),('warehouse_ledger'::text)) empty_stock(effect_kind) LOOP
      effect_key:=entry.effect_kind||':none'; effect_payload:=pg_catalog.jsonb_build_object('present',false);
      manifest_entries:=manifest_entries||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('effectKey',effect_key,'effectKind',entry.effect_kind,'expectedCardinality',0,
        'expectedHash',public."pos_manual_hash_canonical_json_v1"('t2-effect-v1',pg_catalog.jsonb_build_object('effectKey',effect_key,'effectKind',entry.effect_kind,'payload',effect_payload,'schemaVersion',1)),'required',false));
    END LOOP;
  END IF;
  SELECT pg_catalog.jsonb_agg(value ORDER BY value->>'effectKind',value->>'effectKey') INTO manifest_entries
    FROM pg_catalog.jsonb_array_elements(manifest_entries);
  IF pg_catalog.jsonb_array_length(manifest_entries)>1812 THEN RAISE EXCEPTION 'T2 snapshot exceeds bounded size' USING ERRCODE='22023'; END IF;
  manifest_doc:=pg_catalog.jsonb_build_object('entries',manifest_entries,'schemaVersion',1);
  IF NOT public."pos_manual_t2_json_dlp_safe_v1"('operational_actor',operational_actor)
    OR NOT public."pos_manual_t2_json_dlp_safe_v1"('case_evidence',case_evidence)
    OR NOT public."pos_manual_t2_json_dlp_safe_v1"('draft_quote_slot',draft_quote_slot)
    OR NOT public."pos_manual_t2_json_dlp_safe_v1"('customer_sale_payment',customer_sale_payment)
    OR NOT public."pos_manual_t2_json_dlp_safe_v1"('catalog_bom_tracking',catalog_bom_tracking)
    OR NOT public."pos_manual_t2_json_dlp_safe_v1"('inventory_promotion',inventory_promotion)
    OR NOT public."pos_manual_t2_json_dlp_safe_v1"('fiscal',fiscal_doc)
    OR NOT public."pos_manual_t2_json_dlp_safe_v1"('accounting',accounting_doc)
    OR NOT public."pos_manual_t2_json_dlp_safe_v1"('webhooks',webhooks_doc)
    OR NOT public."pos_manual_t2_json_dlp_safe_v1"('manifest',manifest_doc)
  THEN RAISE EXCEPTION 'T2 snapshot exceeds bounded size' USING ERRCODE='22023'; END IF;

  snapshot_row.application_id:=application_id; snapshot_row.schema_version:=1;
  snapshot_row.operational_actor:=operational_actor; snapshot_row.case_evidence:=case_evidence;
  snapshot_row.draft_quote_slot:=draft_quote_slot; snapshot_row.customer_sale_payment:=customer_sale_payment;
  snapshot_row.catalog_bom_tracking:=catalog_bom_tracking; snapshot_row.inventory_promotion:=inventory_promotion;
  snapshot_row.fiscal:=fiscal_doc; snapshot_row.accounting:=accounting_doc;
  snapshot_row.webhooks:=webhooks_doc; snapshot_row.manifest:=manifest_doc;
  snapshot_row.operational_actor_hash:=public."pos_manual_hash_canonical_json_v1"('t2-snapshot-component-v1',operational_actor);
  snapshot_row.case_evidence_hash:=public."pos_manual_hash_canonical_json_v1"('t2-snapshot-component-v1',case_evidence);
  snapshot_row.draft_quote_slot_hash:=public."pos_manual_hash_canonical_json_v1"('t2-snapshot-component-v1',draft_quote_slot);
  snapshot_row.customer_sale_payment_hash:=public."pos_manual_hash_canonical_json_v1"('t2-snapshot-component-v1',customer_sale_payment);
  snapshot_row.catalog_bom_tracking_hash:=public."pos_manual_hash_canonical_json_v1"('t2-snapshot-component-v1',catalog_bom_tracking);
  snapshot_row.inventory_promotion_hash:=public."pos_manual_hash_canonical_json_v1"('t2-snapshot-component-v1',inventory_promotion);
  snapshot_row.fiscal_hash:=public."pos_manual_hash_canonical_json_v1"('t2-snapshot-component-v1',fiscal_doc);
  snapshot_row.accounting_hash:=public."pos_manual_hash_canonical_json_v1"('t2-snapshot-component-v1',accounting_doc);
  snapshot_row.webhooks_hash:=public."pos_manual_hash_canonical_json_v1"('t2-snapshot-component-v1',webhooks_doc);
  snapshot_row.manifest_hash:=public."pos_manual_hash_canonical_json_v1"('t2-manifest-v1',manifest_doc);
  snapshot_row.snapshot_hash:=public."pos_manual_hash_canonical_json_v1"('t2-snapshot-v1',pg_catalog.jsonb_build_object(
    'accountingHash',snapshot_row.accounting_hash,'catalogBomTrackingHash',snapshot_row.catalog_bom_tracking_hash,
    'caseEvidenceHash',snapshot_row.case_evidence_hash,'customerSalePaymentHash',snapshot_row.customer_sale_payment_hash,
    'draftQuoteSlotHash',snapshot_row.draft_quote_slot_hash,'fiscalHash',snapshot_row.fiscal_hash,
    'inventoryPromotionHash',snapshot_row.inventory_promotion_hash,'manifestHash',snapshot_row.manifest_hash,
    'operationalActorHash',snapshot_row.operational_actor_hash,'schemaVersion',1,'webhooksHash',snapshot_row.webhooks_hash));
  snapshot_row.reserve_txid:=tx; snapshot_row.created_at:=request_at;

  application_row.id:=application_id; application_row.case_id:=manual_case.id;
  application_row.payment_plan_id:=plan_row.id; application_row.payment_index:=0;
  application_row.sale_draft_id:=draft_row.id; application_row.quote_hash:=plan_row.quote_hash;
  application_row.expected_plan_version:=plan_row.version; application_row.sale_idempotency_key:=sale_idempotency_key;
  application_row.sale_request_hash:=sale_request_hash; application_row.state:='pending';
  application_row.idempotency_key:=p_idempotency_key; application_row.request_hash:=p_request_hash;
  application_row.reserve_txid:=tx; application_row.reserved_by_profile_id:=p_actor_profile_id;
  application_row.reserved_at:=request_at; application_row.created_at:=request_at; application_row.version:=0;
  application_row.case_version_before_reserve:=manual_case.version; application_row.case_version_after_reserve:=manual_case.version+1;
  application_row.confirmed_observation_id:=observation_row.id; application_row.confirmation_evidence_hash:=observation_row.evidence_hash;
  application_row.reserved_by_user_id:=p_actor_user_id; application_row.reservation_expires_at:=expires_at;
  application_row.snapshot_hash:=snapshot_row.snapshot_hash; application_row.manifest_hash:=snapshot_row.manifest_hash;
  application_row.finalization_profile_id:=profile.id; application_row.finalization_profile_version:=profile.version;
  application_row.finalization_profile_hash:=profile.config_hash; application_row.fencing_token:=0;
  application_row.planned_sale_id:=planned_sale_id; application_row.planned_sale_number:=planned_sale_number;
  application_row.planned_sale_occurred_at:=request_at;
  PERFORM public."pos_manual_t2_open_reservation_write_root_v1"('runtime','application',application_id::text,'INSERT',NULL,pg_catalog.to_jsonb(application_row));
  INSERT INTO public."pos_manual_payment_applications" SELECT (application_row).*;

  PERFORM public."pos_manual_t2_open_reservation_write_root_v1"('runtime','snapshot',application_id::text,'INSERT',NULL,pg_catalog.to_jsonb(snapshot_row));
  INSERT INTO public."pos_manual_application_snapshots" SELECT (snapshot_row).*;
  FOR entry IN SELECT value FROM pg_catalog.jsonb_array_elements(manifest_entries) ORDER BY value->>'effectKind',value->>'effectKey' LOOP
    manifest_row.id:=pg_catalog.nextval(pg_catalog.pg_get_serial_sequence('public.pos_manual_application_manifest_entries','id'));
    manifest_row.application_id:=application_id; manifest_row.effect_kind:=entry->>'effectKind';
    manifest_row.effect_key:=entry->>'effectKey'; manifest_row.expected_hash:=entry->>'expectedHash';
    manifest_row.expected_cardinality:=(entry->>'expectedCardinality')::integer; manifest_row.required:=(entry->>'required')::boolean;
    manifest_row.reserve_txid:=tx; manifest_row.created_at:=request_at;
    PERFORM public."pos_manual_t2_open_reservation_write_root_v1"('runtime','manifest',application_id::text,'INSERT',NULL,pg_catalog.to_jsonb(manifest_row));
    INSERT INTO public."pos_manual_application_manifest_entries" SELECT (manifest_row).*;
  END LOOP;

  FOR item IN SELECT value FROM pg_catalog.jsonb_array_elements(inventory_rows) ORDER BY value->>'reservationKey' LOOP
    stock_row.id:=(item->>'reservationId')::uuid; stock_row.application_id:=application_id;
    stock_row.reservation_key:=item->>'reservationKey'; stock_row.quote_line_index:=(item->>'quoteLineIndex')::integer;
    stock_row.held_sale_item_id:=(item->>'heldSaleItemId')::integer; stock_row.component_scope_key:=NULL;
    stock_row.warehouse_id:=(item->>'warehouseId')::integer; stock_row.product_id:=(item->>'productId')::integer;
    stock_row.variation_id:=(item->>'variationId')::integer; stock_row.lot_id:=NULL;
    stock_row.stock_mode:=item->>'stockMode'; stock_row.tracking_kind:='none';
    stock_row.quantity_micros:=(item->>'quantityMicros')::bigint; stock_row.state:='reserved'; stock_row.version:=0;
    stock_row.parent_reserved_before_micros:=(item->>'parentReservedBeforeMicros')::bigint;
    stock_row.parent_reserved_after_micros:=(item->>'parentReservedAfterMicros')::bigint;
    stock_row.variation_reserved_before_micros:=(item->>'variationReservedBeforeMicros')::bigint;
    stock_row.variation_reserved_after_micros:=(item->>'variationReservedAfterMicros')::bigint;
    stock_row.lot_reserved_before_micros:=NULL; stock_row.lot_reserved_after_micros:=NULL;
    stock_row.reserved_at:=request_at; stock_row.expires_at:=expires_at; stock_row.reserve_txid:=tx;
    PERFORM public."pos_manual_t2_open_reservation_write_root_v1"('runtime','stock_reservation',application_id::text,'INSERT',NULL,pg_catalog.to_jsonb(stock_row));
    INSERT INTO public."pos_manual_application_stock_reservations" SELECT (stock_row).*;
    UPDATE public."warehouse_balances" SET "reserved_quantity"=(stock_row.parent_reserved_after_micros::numeric/1000000)::double precision,
      "updated_at"=request_at WHERE "warehouse_id"=stock_row.warehouse_id AND "product_id"=stock_row.product_id;
    IF stock_row.stock_mode='variation' THEN
      UPDATE public."warehouse_variation_balances" SET "reserved_quantity"=(stock_row.variation_reserved_after_micros::numeric/1000000)::double precision,
        "updated_at"=request_at WHERE "warehouse_id"=stock_row.warehouse_id AND "variation_id"=stock_row.variation_id;
    END IF;
    reservation_event_id:=public."pos_manual_uuid16_v1"('t2-reservation-event-id-v1',pg_catalog.jsonb_build_object(
      'action','reserve','applicationId',application_id,'reservationKind','stock','reservationKey',stock_row.reservation_key,'schemaVersion',1,'sequence',0));
    stock_event.id:=reservation_event_id; stock_event.reservation_id:=stock_row.id; stock_event.application_id:=application_id;
    stock_event.sequence:=0; stock_event.action:='reserve'; stock_event.state_before:='none'; stock_event.state_after:='reserved';
    stock_event.quantity_micros:=stock_row.quantity_micros; stock_event.parent_reserved_before_micros:=stock_row.parent_reserved_before_micros;
    stock_event.parent_reserved_after_micros:=stock_row.parent_reserved_after_micros;
    stock_event.variation_reserved_before_micros:=stock_row.variation_reserved_before_micros;
    stock_event.variation_reserved_after_micros:=stock_row.variation_reserved_after_micros;
    stock_event.lot_reserved_before_micros:=NULL; stock_event.lot_reserved_after_micros:=NULL;
    stock_event.reason_code:=NULL; stock_event.write_txid:=tx; stock_event.occurred_at:=request_at;
    PERFORM public."pos_manual_t2_open_reservation_write_root_v1"('runtime','stock_event',application_id::text,'INSERT',NULL,pg_catalog.to_jsonb(stock_event));
    INSERT INTO public."pos_manual_application_stock_reservation_events" SELECT (stock_event).*;
  END LOOP;

  operation_id:=pg_catalog.nextval(pg_catalog.pg_get_serial_sequence('public.pos_manual_payment_operations','id'));
  operation_row.id:=operation_id; operation_row.case_id:=manual_case.id; operation_row.action:='reserve_application';
  operation_row.expected_version:=manual_case.version; operation_row.resulting_version:=manual_case.version+1;
  operation_row.resulting_state:='application_pending'; operation_row.actor_profile_id:=p_actor_profile_id;
  operation_row.idempotency_key:=p_idempotency_key; operation_row.request_hash:=p_request_hash;
  operation_row.observation_id:=observation_row.id; operation_row.application_id:=application_id;
  operation_row.write_txid:=tx; operation_row.created_at:=request_at;
  PERFORM public."pos_manual_t2_open_legacy_operation_root_v1"('t2_reservation:reserve:operation','reserve_application',operation_row);
  INSERT INTO public."pos_manual_payment_operations" SELECT (operation_row).*;
  state_event_id:=pg_catalog.nextval(pg_catalog.pg_get_serial_sequence('public.pos_manual_payment_state_events','id'));
  event_row.id:=state_event_id; event_row.case_id:=manual_case.id; event_row.operation_id:=operation_id;
  event_row.from_state:='confirmed_paid'; event_row.to_state:='application_pending'; event_row.resulting_version:=manual_case.version+1;
  event_row.source:='application'; event_row.source_id:=application_id::text; event_row.write_txid:=tx; event_row.created_at:=request_at;
  PERFORM public."pos_manual_t2_open_legacy_state_event_root_v1"('t2_reservation:reserve:state_event','reserve_application',event_row);
  INSERT INTO public."pos_manual_payment_state_events" SELECT (event_row).*;
  target_case:=manual_case; target_case.state:='application_pending'; target_case.version:=manual_case.version+1;
  target_case.lifecycle_txid:=tx; target_case.updated_at:=request_at;
  PERFORM public."pos_manual_t2_open_legacy_case_root_v1"('t2_reservation:reserve:case','reserve_application','UPDATE',manual_case,target_case);
  UPDATE public."pos_manual_payment_cases" SET "state"='application_pending',"version"=manual_case.version+1,
    "lifecycle_txid"=tx,"updated_at"=request_at WHERE "id"=manual_case.id;

  stock_count:=pg_catalog.jsonb_array_length(inventory_rows);
  stock_multiset_hash:=public."pos_manual_hash_canonical_json_v1"('t2-stock-multiset-v1',pg_catalog.jsonb_build_object('reservations',inventory_rows,'schemaVersion',1));
  promotion_multiset_hash:=public."pos_manual_hash_canonical_json_v1"('t2-promotion-multiset-v1',pg_catalog.jsonb_build_object('reservations','[]'::jsonb,'schemaVersion',1));
  reservation_graph_hash:=public."pos_manual_hash_canonical_json_v1"('t2-reservation-graph-v1',pg_catalog.jsonb_build_object(
    'applicationId',application_id,'inventoryPromotionHash',snapshot_row.inventory_promotion_hash,
    'promotionMultisetHash',promotion_multiset_hash,'schemaVersion',1,'stockMultisetHash',stock_multiset_hash));
  assertion_row.application_id:=application_id; assertion_row.stock_reservation_count:=stock_count;
  SELECT COALESCE(pg_catalog.sum((value->>'quantityMicros')::bigint),0) INTO assertion_row.stock_quantity_micros
    FROM pg_catalog.jsonb_array_elements(inventory_rows);
  assertion_row.promotion_reservation_count:=0; assertion_row.stock_multiset_hash:=stock_multiset_hash;
  assertion_row.promotion_multiset_hash:=promotion_multiset_hash; assertion_row.reservation_graph_hash:=reservation_graph_hash;
  assertion_row.reserve_operation_id:=operation_id; assertion_row.reserve_state_event_id:=state_event_id;
  assertion_row.reserve_txid:=tx; assertion_row.created_at:=request_at;
  PERFORM public."pos_manual_t2_open_reservation_write_root_v1"('runtime','reserve_assertion',application_id::text,'INSERT',NULL,pg_catalog.to_jsonb(assertion_row));
  INSERT INTO public."pos_manual_application_reserve_assertions" SELECT (assertion_row).*;
  RETURN public."pos_manual_t2_reserve_result_v1"(application_id,p_actor_user_id,false);
END
$function$;

CREATE FUNCTION public."pos_manual_reserve_application_v1"(
  p_case_id uuid,p_expected_case_version_before_reserve integer,p_actor_profile_id integer,
  p_actor_user_id text,p_idempotency_key text,p_request_hash text
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
  PERFORM public."pos_manual_t2_authority_v1"('runtime');
  IF pg_catalog.current_setting('transaction_isolation')<>'serializable'
    OR pg_catalog.current_setting('transaction_read_only')<>'off'
    OR pg_catalog.current_setting('application_name')<>'nalven-pos-manual-reserve-v1' THEN
    RAISE EXCEPTION 'T2 reserve requires its dedicated serializable autocommit executor' USING ERRCODE='25001'; END IF;
  RETURN public."pos_manual_reserve_application_v1_impl"(p_case_id,p_expected_case_version_before_reserve,p_actor_profile_id,p_actor_user_id,p_idempotency_key,p_request_hash);
END
$function$;

CREATE FUNCTION public."pos_manual_application_status_v1"(p_application_id uuid,p_actor_user_id text)
RETURNS jsonb LANGUAGE plpgsql STABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
  PERFORM public."pos_manual_t2_authority_v1"('runtime');
  IF NOT public."pos_manual_t2_subject_safe_v1"(p_actor_user_id) THEN
    RAISE EXCEPTION 'invalid T2 status subject' USING ERRCODE='22023'; END IF;
  RETURN public."pos_manual_t2_status_object_v1"(p_application_id,p_actor_user_id);
END
$function$;

CREATE FUNCTION public."pos_manual_application_status_by_reservation_v1"(
  p_case_id uuid,p_reserve_idempotency_key text,p_reserve_request_hash text,
  p_actor_profile_id integer,p_actor_user_id text
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE winner public."pos_manual_payment_applications"%ROWTYPE;
  current_case_version integer;
BEGIN
  PERFORM public."pos_manual_t2_authority_v1"('runtime');
  PERFORM public."pos_manual_t2_assert_shape_v1"(p_reserve_idempotency_key,p_reserve_request_hash);
  IF pg_catalog.current_setting('transaction_isolation')<>'serializable'
    OR pg_catalog.current_setting('transaction_read_only')<>'off'
    OR pg_catalog.current_setting('application_name')<>'nalven-pos-manual-reserve-v1' THEN
    RETURN pg_catalog.jsonb_build_object('outcome','unknown','winner',NULL); END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('t2-reserve:key:'||p_reserve_idempotency_key,0));
  SELECT manual_case."version" INTO current_case_version
    FROM public."pos_manual_payment_cases" manual_case WHERE manual_case."id"=p_case_id FOR UPDATE;
  SELECT * INTO winner FROM public."pos_manual_payment_applications"
   WHERE "idempotency_key"=p_reserve_idempotency_key FOR UPDATE;
  IF winner.id IS NOT NULL THEN
    IF winner.case_id<>p_case_id OR winner.request_hash<>p_reserve_request_hash
      OR winner.reserved_by_profile_id<>p_actor_profile_id OR winner.reserved_by_user_id<>p_actor_user_id THEN
      RAISE EXCEPTION 'T2 reserve idempotency conflict' USING ERRCODE='23505'; END IF;
    IF p_reserve_request_hash IS DISTINCT FROM public."pos_manual_t2_reserve_request_hash_v1"(
      p_case_id,winner.case_version_before_reserve,p_actor_profile_id,p_actor_user_id,p_reserve_idempotency_key) THEN
      RAISE EXCEPTION 'T2 reserve idempotency conflict' USING ERRCODE='23505'; END IF;
    IF NOT public."pos_manual_t2_actor_authorized_for_case_v1"(winner.case_id,p_actor_profile_id,p_actor_user_id) THEN
      RETURN pg_catalog.jsonb_build_object('outcome','unknown','winner',NULL); END IF;
    RETURN pg_catalog.jsonb_build_object('outcome','committed_same_request','winner',public."pos_manual_t2_status_object_v1"(winner.id,p_actor_user_id));
  END IF;
  IF pg_catalog.pg_is_in_recovery() OR pg_catalog.current_setting('transaction_read_only')<>'off' THEN
    RETURN pg_catalog.jsonb_build_object('outcome','unknown','winner',NULL); END IF;
  IF NOT public."pos_manual_t2_actor_authorized_for_case_v1"(p_case_id,p_actor_profile_id,p_actor_user_id) THEN
    RETURN pg_catalog.jsonb_build_object('outcome','unknown','winner',NULL); END IF;
  IF current_case_version IS NULL OR p_reserve_request_hash IS DISTINCT FROM public."pos_manual_t2_reserve_request_hash_v1"(
      p_case_id,current_case_version,p_actor_profile_id,p_actor_user_id,p_reserve_idempotency_key) THEN
    RETURN pg_catalog.jsonb_build_object('outcome','unknown','winner',NULL); END IF;
  RETURN pg_catalog.jsonb_build_object('outcome','authoritatively_absent','winner',NULL);
END
$function$;

-- A blocked case becomes lifecycle-releasable only through a committed,
-- integral release graph.  Confirmed/application-pending and incomplete
-- blocked cases continue to hold the session, plan and handoff closed.
CREATE FUNCTION public."pos_manual_t2_case_blocks_lifecycle_v1"(p_case_id uuid)
RETURNS boolean LANGUAGE sql STABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
  SELECT CASE
    WHEN manual_case."state" IN ('review_pending','unknown','confirmed_paid','application_pending') THEN true
    WHEN manual_case."state"<>'blocked' THEN false
    ELSE NOT EXISTS (
      SELECT 1
        FROM public."pos_manual_payment_applications" app
        JOIN public."pos_manual_application_release_assertions" release
          ON release."application_id"=app."id"
        JOIN public."pos_manual_payment_operations" operation
          ON operation."id"=release."release_operation_id"
        JOIN public."pos_manual_payment_state_events" state_event
          ON state_event."id"=release."release_state_event_id"
        JOIN public."pos_manual_payment_incidents" incident
          ON incident."id"=release."release_incident_id"
       WHERE app."case_id"=manual_case."id" AND app."state"='blocked' AND app."fencing_token"=0
         AND app."failure_class"=release."release_reason" AND app."blocked_code"=release."release_reason"
         AND operation."application_id"=app."id" AND operation."write_txid"=release."release_txid"
         AND state_event."operation_id"=operation."id" AND state_event."write_txid"=release."release_txid"
         AND incident."manual_application_id"=app."id" AND incident."write_txid"=release."release_txid"
         AND NOT EXISTS (SELECT 1 FROM public."pos_manual_application_stock_reservations" stock
                          WHERE stock."application_id"=app."id" AND stock."state"='reserved')
         AND NOT EXISTS (SELECT 1 FROM public."pos_manual_application_promotion_reservations" promotion
                          WHERE promotion."application_id"=app."id" AND promotion."state"='reserved')
         AND release."stock_released_count"=(SELECT pg_catalog.count(*) FROM public."pos_manual_application_stock_reservations" stock
                                               WHERE stock."application_id"=app."id" AND stock."state"='released')
         AND release."promotion_released_count"=(SELECT pg_catalog.count(*) FROM public."pos_manual_application_promotion_reservations" promotion
                                                   WHERE promotion."application_id"=app."id" AND promotion."state"='released')
    )
  END
  FROM public."pos_manual_payment_cases" manual_case WHERE manual_case."id"=p_case_id
$function$;

CREATE OR REPLACE FUNCTION public."pos_manual_prepare_session_transition_v1"(p_action text,p_session_id integer,p_expected_version integer,p_actor_profile_id integer,p_actor_user_id text,p_idempotency_key text,p_request_hash text)
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
  IF role_row.key NOT IN ('owner','admin') AND session_branch IS NOT NULL THEN
    PERFORM 1 FROM public."branch_user_accesses" WHERE "branch_id"=session_branch AND "user_profile_id"=p_actor_profile_id AND "can_sell" FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'session actor grant denied' USING ERRCODE='42501'; END IF;
  END IF;
  PERFORM 1 FROM public."pos_manual_payment_cases" WHERE "session_id"=s.id ORDER BY "id" FOR SHARE;
  IF EXISTS (SELECT 1 FROM public."pos_manual_payment_cases" manual_case WHERE manual_case."session_id"=s.id
      AND public."pos_manual_t2_case_blocks_lifecycle_v1"(manual_case."id")) THEN
    RAISE EXCEPTION 'session has unresolved manual reconciliation' USING ERRCODE='23514'; END IF;
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

CREATE OR REPLACE FUNCTION public."pos_manual_prepare_plan_release_v1"(p_action text,p_plan_id text,p_expected_version integer,p_actor_user_id text,p_idempotency_key text,p_request_hash text)
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
  PERFORM 1 FROM public."tenant_user_profiles" profile
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
  IF EXISTS (SELECT 1 FROM public."pos_manual_payment_cases" manual_case WHERE manual_case."payment_plan_id"=p.id
      AND public."pos_manual_t2_case_blocks_lifecycle_v1"(manual_case."id")) THEN
    RAISE EXCEPTION 'plan has unresolved manual reconciliation' USING ERRCODE='23514'; END IF;
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

CREATE OR REPLACE FUNCTION public."pos_manual_prepare_handoff_transition_v1"(p_action text,p_handoff_id text,p_session_id integer,p_expected_session_version integer,p_expected_handoff_revision integer,p_target_operator_profile_id integer,p_actor_profile_id integer,p_actor_user_id text,p_idempotency_key text,p_request_hash text,p_reason text,p_expires_at timestamptz,p_held_sale_snapshot jsonb)
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
  IF role_row.key NOT IN ('owner','admin') AND session_branch IS NOT NULL THEN
    PERFORM 1 FROM public."branch_user_accesses" WHERE "branch_id"=session_branch AND "user_profile_id"=p_actor_profile_id AND "can_sell" FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'handoff actor grant denied' USING ERRCODE='42501'; END IF;
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
    IF p_action='accept' AND ROW(h.session_id,h.register_id,h.from_operator_profile_id,h.to_operator_profile_id,h.revision,h.state,h.held_sale_snapshot,h.request_hash)
      IS DISTINCT FROM ROW(h_locator.session_id,h_locator.register_id,h_locator.from_operator_profile_id,h_locator.to_operator_profile_id,h_locator.revision,h_locator.state,h_locator.held_sale_snapshot,h_locator.request_hash)
    THEN RAISE EXCEPTION 'handoff locator changed' USING ERRCODE='23514'; END IF;
    h_old:=pg_catalog.jsonb_build_object('id',h.id,'sessionId',h.session_id,'branchId',h.branch_id,'registerId',h.register_id,'fromOperatorProfileId',h.from_operator_profile_id,'toOperatorProfileId',h.to_operator_profile_id,'state',h.state,'reason',h.reason,'expiresAt',public."pos_manual_utc_micros_v1"(h.expires_at),'revision',h.revision,'requestIdempotencyKey',h.request_idempotency_key,'requestHash',h.request_hash,'heldSaleSnapshot',h.held_sale_snapshot,'requestedByActorId',h.requested_by_actor_id,'resolutionRequestHash',h.resolution_request_hash,'resolvedByActorId',h.resolved_by_actor_id);
    h_state:=CASE p_action WHEN 'accept' THEN 'accepted' WHEN 'cancel' THEN 'cancelled' ELSE 'expired' END; h_revision:=h.revision+1;
    s_status:='open'; s_operator:=CASE WHEN p_action='accept' THEN p_target_operator_profile_id ELSE s.operator_profile_id END;
  END IF;
  PERFORM 1 FROM public."pos_manual_payment_cases" WHERE "session_id"=s.id ORDER BY "id" FOR SHARE;
  IF EXISTS (SELECT 1 FROM public."pos_manual_payment_cases" manual_case WHERE manual_case."session_id"=s.id
      AND public."pos_manual_t2_case_blocks_lifecycle_v1"(manual_case."id")) THEN
    RAISE EXCEPTION 'handoff has unresolved manual reconciliation' USING ERRCODE='23514'; END IF;
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

-- Closed, owner-only sweep producer.  The public wrapper below is the only
-- grantable entry point.  One invocation releases exactly one expired
-- application and returns the immutable receipt summary consumed by its
-- enclosing batch.
CREATE FUNCTION public."pos_manual_t2_release_expired_application_v1"(
  p_application_id uuid,p_batch_id uuid,p_batch_index integer,
  p_sweeper_id text,p_idempotency_key text,p_decision_at timestamptz
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE STRICT SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE
  app public."pos_manual_payment_applications"%ROWTYPE;
  app_after public."pos_manual_payment_applications"%ROWTYPE;
  manual_case public."pos_manual_payment_cases"%ROWTYPE;
  case_after public."pos_manual_payment_cases"%ROWTYPE;
  stock public."pos_manual_application_stock_reservations"%ROWTYPE;
  stock_after public."pos_manual_application_stock_reservations"%ROWTYPE;
  promotion public."pos_manual_application_promotion_reservations"%ROWTYPE;
  promotion_after public."pos_manual_application_promotion_reservations"%ROWTYPE;
  reserve_assertion public."pos_manual_application_reserve_assertions"%ROWTYPE;
  snapshot_row public."pos_manual_application_snapshots"%ROWTYPE;
  receipt public."pos_manual_application_sweep_receipts"%ROWTYPE;
  release_assertion public."pos_manual_application_release_assertions"%ROWTYPE;
  operation_row public."pos_manual_payment_operations"%ROWTYPE;
  state_event_row public."pos_manual_payment_state_events"%ROWTYPE;
  parent_reserved double precision; variation_reserved double precision;
  parent_before bigint; parent_after bigint; variation_before bigint; variation_after bigint;
  lot_before bigint; lot_after bigint;
  global_used integer; customer_used integer; coupon_used integer;
  global_live integer; customer_live integer; coupon_live integer;
  stock_count integer; promotion_count integer; tx numeric(20,0);
  stock_ids jsonb; promotion_ids jsonb; stock_rows jsonb; promotion_rows jsonb;
  stock_hash text; promotion_hash text; release_graph_hash text;
  event_id uuid; incident_id uuid; operation_id bigint; state_event_id bigint;
  operation_key text; operation_hash text;
BEGIN
  PERFORM public."pos_manual_t2_authority_v1"('manual_sweeper');
  IF p_batch_index NOT BETWEEN 0 AND 49 OR NOT public."pos_manual_t2_subject_safe_v1"(p_sweeper_id) THEN
    RAISE EXCEPTION 'invalid T2 sweep release shape' USING ERRCODE='22023'; END IF;

  SELECT candidate.* INTO app
    FROM public."pos_manual_payment_applications" candidate
   WHERE candidate."id"=p_application_id FOR UPDATE;
  IF app.id IS NULL OR app.state NOT IN ('pending','claimed') OR app.reservation_expires_at>p_decision_at THEN
    RETURN NULL;
  END IF;
  SELECT case_row.* INTO manual_case FROM public."pos_manual_payment_cases" case_row
   WHERE case_row."id"=app.case_id FOR UPDATE;
  IF manual_case.id IS NULL OR manual_case.state<>'application_pending'
    OR manual_case.version<>app.case_version_after_reserve
    OR manual_case.session_id IS NULL THEN
    RAISE EXCEPTION 'T2 expired application causal boundary changed' USING ERRCODE='23514'; END IF;

  -- Immutable and operational roots are locked before any release write.
  PERFORM 1 FROM public."pos_payment_plans" plan WHERE plan."id"=app.payment_plan_id FOR UPDATE;
  PERFORM 1 FROM public."pos_payment_plan_slots" slot
    WHERE slot."plan_id"=app.payment_plan_id AND slot."payment_index"=app.payment_index FOR UPDATE;
  PERFORM 1 FROM public."pos_held_sales" draft WHERE draft."id"=app.sale_draft_id FOR UPDATE;
  SELECT snapshot.* INTO snapshot_row FROM public."pos_manual_application_snapshots" snapshot
    WHERE snapshot."application_id"=app.id FOR UPDATE;
  SELECT assertion.* INTO reserve_assertion FROM public."pos_manual_application_reserve_assertions" assertion
    WHERE assertion."application_id"=app.id FOR UPDATE;
  IF snapshot_row.application_id IS NULL OR reserve_assertion.application_id IS NULL
    OR snapshot_row.snapshot_hash<>app.snapshot_hash OR reserve_assertion.reserve_txid<>app.reserve_txid THEN
    RAISE EXCEPTION 'T2 expired application reserve graph is incomplete' USING ERRCODE='23514'; END IF;
  PERFORM 1 FROM public."pos_manual_application_stock_reservations" reservation
    WHERE reservation."application_id"=app.id ORDER BY reservation."id"::text COLLATE "C" FOR UPDATE;
  PERFORM 1 FROM public."pos_manual_application_promotion_reservations" reservation
    WHERE reservation."application_id"=app.id ORDER BY reservation."id"::text COLLATE "C" FOR UPDATE;

  -- Physical stock locks are globally ordered and complete before mutation.
  PERFORM 1 FROM public."warehouse_balances" balance
    JOIN (SELECT DISTINCT reservation."warehouse_id",reservation."product_id"
            FROM public."pos_manual_application_stock_reservations" reservation
           WHERE reservation."application_id"=app.id) key
      ON key."warehouse_id"=balance."warehouse_id" AND key."product_id"=balance."product_id"
   ORDER BY balance."warehouse_id",balance."product_id" FOR UPDATE OF balance;
  PERFORM 1 FROM public."warehouse_variation_balances" balance
    JOIN (SELECT DISTINCT reservation."warehouse_id",reservation."product_id",reservation."variation_id"
            FROM public."pos_manual_application_stock_reservations" reservation
           WHERE reservation."application_id"=app.id AND reservation."stock_mode"='variation') key
      ON key."warehouse_id"=balance."warehouse_id" AND key."product_id"=balance."product_id"
     AND key."variation_id"=balance."variation_id"
   ORDER BY balance."warehouse_id",balance."product_id",balance."variation_id" FOR UPDATE OF balance;
  PERFORM 1 FROM public."pos_inventory_lots" lot
    JOIN (SELECT DISTINCT reservation."lot_id" FROM public."pos_manual_application_stock_reservations" reservation
           WHERE reservation."application_id"=app.id AND reservation."lot_id" IS NOT NULL) key
      ON key."lot_id"=lot."id" ORDER BY lot."id" COLLATE "C" FOR UPDATE OF lot;
  PERFORM 1 FROM public."pos_promotions" promo
    JOIN public."pos_manual_application_promotion_reservations" reservation ON reservation."promotion_id"=promo."id"
   WHERE reservation."application_id"=app.id ORDER BY promo."id" COLLATE "C" FOR UPDATE OF promo;
  PERFORM 1 FROM public."pos_coupons" coupon
    JOIN public."pos_manual_application_promotion_reservations" reservation ON reservation."coupon_id"=coupon."id"
   WHERE reservation."application_id"=app.id ORDER BY coupon."id" COLLATE "C" FOR UPDATE OF coupon;

  p_decision_at:=pg_catalog.clock_timestamp();
  IF app.reservation_expires_at>p_decision_at THEN RETURN NULL; END IF;
  tx:=pg_catalog.txid_current()::numeric;
  SELECT pg_catalog.count(*)::integer,
         COALESCE(pg_catalog.jsonb_agg(reservation."id" ORDER BY reservation."id"::text COLLATE "C"),'[]'::jsonb)
    INTO stock_count,stock_ids
    FROM public."pos_manual_application_stock_reservations" reservation
   WHERE reservation."application_id"=app.id AND reservation."state"='reserved';
  SELECT pg_catalog.count(*)::integer,
         COALESCE(pg_catalog.jsonb_agg(reservation."id" ORDER BY reservation."id"::text COLLATE "C"),'[]'::jsonb)
    INTO promotion_count,promotion_ids
   FROM public."pos_manual_application_promotion_reservations" reservation
   WHERE reservation."application_id"=app.id AND reservation."state"='reserved';
  IF stock_count>400 OR promotion_count>1
    OR stock_count<>reserve_assertion.stock_reservation_count
    OR promotion_count<>reserve_assertion.promotion_reservation_count
    OR EXISTS (SELECT 1 FROM public."pos_manual_application_stock_reservations" reservation
                WHERE reservation."application_id"=app.id AND reservation."state"<>'reserved')
    OR EXISTS (SELECT 1 FROM public."pos_manual_application_promotion_reservations" reservation
                WHERE reservation."application_id"=app.id AND reservation."state"<>'reserved') THEN
    RAISE EXCEPTION 'T2 expired application reservation graph is not releasable' USING ERRCODE='23514'; END IF;

  release_graph_hash:=public."pos_manual_hash_canonical_json_v1"('t2-release-result-v1',pg_catalog.jsonb_build_object(
    'applicationId',app.id,'caseVersionAfter',manual_case.version+1,
    'promotionReservationIds',promotion_ids,'schemaVersion',1,'stockReservationIds',stock_ids));
  receipt.id:=public."pos_manual_uuid16_v1"('t2-sweep-receipt-id-v1',pg_catalog.jsonb_build_object(
    'applicationId',app.id,'batchIndex',p_batch_index,'idempotencyKey',p_idempotency_key,
    'schemaVersion',1,'sweeperId',p_sweeper_id));
  receipt.batch_id:=p_batch_id; receipt.batch_index:=p_batch_index;
  receipt.application_id:=app.id; receipt.application_version_before:=app.version;
  receipt.application_version_after:=app.version+1; receipt.case_id:=manual_case.id;
  receipt.case_version_before:=manual_case.version; receipt.case_version_after:=manual_case.version+1;
  receipt.fencing_token_before:=app.fencing_token; receipt.stock_reservation_count:=stock_count;
  receipt.promotion_reservation_count:=promotion_count; receipt.release_graph_hash:=release_graph_hash;
  receipt.write_txid:=tx; receipt.created_at:=p_decision_at;
  PERFORM public."pos_manual_t2_open_reservation_write_root_v1"(
    'manual_sweeper','sweep_receipt',app.id::text,'INSERT',NULL,pg_catalog.to_jsonb(receipt));
  INSERT INTO public."pos_manual_application_sweep_receipts" SELECT (receipt).*;

  FOR stock IN SELECT reservation.* FROM public."pos_manual_application_stock_reservations" reservation
    WHERE reservation."application_id"=app.id AND reservation."state"='reserved'
    ORDER BY reservation."id"::text COLLATE "C"
  LOOP
    SELECT balance."reserved_quantity" INTO STRICT parent_reserved FROM public."warehouse_balances" balance
     WHERE balance."warehouse_id"=stock.warehouse_id AND balance."product_id"=stock.product_id FOR UPDATE;
    parent_before:=public."pos_manual_t2_float_to_micros_v1"(parent_reserved);
    parent_after:=parent_before-stock.quantity_micros;
    IF parent_after<0 THEN RAISE EXCEPTION 'T2 stock release underflow' USING ERRCODE='23514'; END IF;
    UPDATE public."warehouse_balances" SET "reserved_quantity"=(parent_after::numeric/1000000)::double precision,
      "updated_at"=p_decision_at WHERE "warehouse_id"=stock.warehouse_id AND "product_id"=stock.product_id;

    variation_before:=NULL; variation_after:=NULL;
    IF stock.stock_mode='variation' THEN
      SELECT balance."reserved_quantity" INTO STRICT variation_reserved FROM public."warehouse_variation_balances" balance
       WHERE balance."warehouse_id"=stock.warehouse_id AND balance."product_id"=stock.product_id
         AND balance."variation_id"=stock.variation_id FOR UPDATE;
      variation_before:=public."pos_manual_t2_float_to_micros_v1"(variation_reserved);
      variation_after:=variation_before-stock.quantity_micros;
      IF variation_after<0 THEN RAISE EXCEPTION 'T2 variation stock release underflow' USING ERRCODE='23514'; END IF;
      UPDATE public."warehouse_variation_balances"
         SET "reserved_quantity"=(variation_after::numeric/1000000)::double precision,"updated_at"=p_decision_at
       WHERE "warehouse_id"=stock.warehouse_id AND "variation_id"=stock.variation_id;
    END IF;
    lot_before:=NULL; lot_after:=NULL;
    IF stock.lot_id IS NOT NULL THEN
      SELECT lot."reserved_micros" INTO STRICT lot_before FROM public."pos_inventory_lots" lot
       WHERE lot."id"=stock.lot_id FOR UPDATE;
      lot_after:=lot_before-stock.quantity_micros;
      IF lot_after<0 THEN RAISE EXCEPTION 'T2 lot release underflow' USING ERRCODE='23514'; END IF;
      UPDATE public."pos_inventory_lots" SET "reserved_micros"=lot_after,"updated_at"=p_decision_at
       WHERE "id"=stock.lot_id;
    END IF;

    stock_after:=stock; stock_after.state:='released'; stock_after.version:=1;
    stock_after.released_at:=p_decision_at; stock_after.release_txid:=tx;
    stock_after.release_reason:='reservation_expired';
    PERFORM public."pos_manual_t2_open_reservation_write_root_v1"('manual_sweeper','stock_reservation',app.id::text,
      'UPDATE',pg_catalog.to_jsonb(stock),pg_catalog.to_jsonb(stock_after));
    UPDATE public."pos_manual_application_stock_reservations" SET "state"='released',"version"=1,
      "released_at"=p_decision_at,"release_txid"=tx,"release_reason"='reservation_expired' WHERE "id"=stock.id;

    event_id:=public."pos_manual_uuid16_v1"('t2-reservation-event-id-v1',pg_catalog.jsonb_build_object(
      'action','release','applicationId',app.id,'reservationKind','stock',
      'reservationKey',stock.reservation_key,'schemaVersion',1,'sequence',1));
    PERFORM public."pos_manual_t2_open_reservation_write_root_v1"('manual_sweeper','stock_event',app.id::text,'INSERT',NULL,
      pg_catalog.jsonb_build_object('id',event_id,'reservation_id',stock.id,'application_id',app.id,'sequence',1,
        'action','release','state_before','reserved','state_after','released','quantity_micros',stock.quantity_micros,
        'parent_reserved_before_micros',parent_before,'parent_reserved_after_micros',parent_after,
        'variation_reserved_before_micros',variation_before,'variation_reserved_after_micros',variation_after,
        'lot_reserved_before_micros',lot_before,'lot_reserved_after_micros',lot_after,
        'reason_code','reservation_expired','write_txid',tx,'occurred_at',p_decision_at));
    INSERT INTO public."pos_manual_application_stock_reservation_events"(
      "id","reservation_id","application_id","sequence","action","state_before","state_after","quantity_micros",
      "parent_reserved_before_micros","parent_reserved_after_micros","variation_reserved_before_micros",
      "variation_reserved_after_micros","lot_reserved_before_micros","lot_reserved_after_micros",
      "reason_code","write_txid","occurred_at")
    VALUES(event_id,stock.id,app.id,1,'release','reserved','released',stock.quantity_micros,
      parent_before,parent_after,variation_before,variation_after,lot_before,lot_after,'reservation_expired',tx,p_decision_at);
  END LOOP;

  FOR promotion IN SELECT reservation.* FROM public."pos_manual_application_promotion_reservations" reservation
    WHERE reservation."application_id"=app.id AND reservation."state"='reserved'
    ORDER BY reservation."id"::text COLLATE "C"
  LOOP
    SELECT pg_catalog.count(*)::integer INTO global_used FROM public."pos_promotion_redemptions" redemption
     WHERE redemption."promotion_id"=promotion.promotion_id AND redemption."reversed_at" IS NULL;
    SELECT pg_catalog.count(*)::integer INTO global_live FROM public."pos_manual_application_promotion_reservations" active
     WHERE active."promotion_id"=promotion.promotion_id AND active."state"='reserved';
    customer_used:=NULL; customer_live:=NULL;
    IF promotion.customer_id IS NOT NULL THEN
      SELECT pg_catalog.count(*)::integer INTO customer_used FROM public."pos_promotion_redemptions" redemption
       WHERE redemption."promotion_id"=promotion.promotion_id AND redemption."customer_id"=promotion.customer_id
         AND redemption."reversed_at" IS NULL;
      SELECT pg_catalog.count(*)::integer INTO customer_live FROM public."pos_manual_application_promotion_reservations" active
       WHERE active."promotion_id"=promotion.promotion_id AND active."customer_id"=promotion.customer_id AND active."state"='reserved';
    END IF;
    coupon_used:=NULL; coupon_live:=NULL;
    IF promotion.coupon_id IS NOT NULL THEN
      SELECT coupon."used_count" INTO STRICT coupon_used FROM public."pos_coupons" coupon
       WHERE coupon."id"=promotion.coupon_id FOR UPDATE;
      SELECT pg_catalog.count(*)::integer INTO coupon_live FROM public."pos_manual_application_promotion_reservations" active
       WHERE active."coupon_id"=promotion.coupon_id AND active."state"='reserved';
    END IF;
    IF global_live<1 OR (customer_live IS NOT NULL AND customer_live<1) OR (coupon_live IS NOT NULL AND coupon_live<1) THEN
      RAISE EXCEPTION 'T2 promotion release underflow' USING ERRCODE='23514'; END IF;

    promotion_after:=promotion; promotion_after.state:='released'; promotion_after.version:=1;
    promotion_after.released_at:=p_decision_at; promotion_after.release_txid:=tx;
    promotion_after.release_reason:='reservation_expired';
    PERFORM public."pos_manual_t2_open_reservation_write_root_v1"('manual_sweeper','promotion_reservation',app.id::text,
      'UPDATE',pg_catalog.to_jsonb(promotion),pg_catalog.to_jsonb(promotion_after));
    UPDATE public."pos_manual_application_promotion_reservations" SET "state"='released',"version"=1,
      "released_at"=p_decision_at,"release_txid"=tx,"release_reason"='reservation_expired' WHERE "id"=promotion.id;
    event_id:=public."pos_manual_uuid16_v1"('t2-reservation-event-id-v1',pg_catalog.jsonb_build_object(
      'action','release','applicationId',app.id,'reservationKind','promotion',
      'reservationKey',promotion.reservation_key,'schemaVersion',1,'sequence',1));
    PERFORM public."pos_manual_t2_open_reservation_write_root_v1"('manual_sweeper','promotion_event',app.id::text,'INSERT',NULL,
      pg_catalog.jsonb_build_object('id',event_id,'reservation_id',promotion.id,'application_id',app.id,'sequence',1,
        'action','release','state_before','reserved','state_after','released','discount_cents',promotion.discount_cents,
        'global_used_before',global_used,'global_used_after',global_used,
        'customer_used_before',customer_used,'customer_used_after',customer_used,
        'coupon_used_before',coupon_used,'coupon_used_after',coupon_used,
        'global_live_before',global_live,'global_live_after',global_live-1,
        'customer_live_before',customer_live,'customer_live_after',CASE WHEN customer_live IS NULL THEN NULL ELSE customer_live-1 END,
        'coupon_live_before',coupon_live,'coupon_live_after',CASE WHEN coupon_live IS NULL THEN NULL ELSE coupon_live-1 END,
        'reason_code','reservation_expired','write_txid',tx,'occurred_at',p_decision_at));
    INSERT INTO public."pos_manual_application_promotion_reservation_events"(
      "id","reservation_id","application_id","sequence","action","state_before","state_after","discount_cents",
      "global_used_before","global_used_after","customer_used_before","customer_used_after","coupon_used_before","coupon_used_after",
      "global_live_before","global_live_after","customer_live_before","customer_live_after","coupon_live_before","coupon_live_after",
      "reason_code","write_txid","occurred_at")
    VALUES(event_id,promotion.id,app.id,1,'release','reserved','released',promotion.discount_cents,
      global_used,global_used,customer_used,customer_used,coupon_used,coupon_used,global_live,global_live-1,
      customer_live,CASE WHEN customer_live IS NULL THEN NULL ELSE customer_live-1 END,
      coupon_live,CASE WHEN coupon_live IS NULL THEN NULL ELSE coupon_live-1 END,
      'reservation_expired',tx,p_decision_at);
  END LOOP;

  -- The receipt identity is now bound into every aggregate transition.
  operation_id:=pg_catalog.nextval(pg_catalog.pg_get_serial_sequence('public.pos_manual_payment_operations','id'));
  state_event_id:=pg_catalog.nextval(pg_catalog.pg_get_serial_sequence('public.pos_manual_payment_state_events','id'));
  operation_key:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    't2-sweep-operation-v1:'||receipt.id::text,'UTF8')),'hex');
  operation_hash:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    't2-sweep-operation-request-v1:'||receipt.id::text||':'||release_graph_hash,'UTF8')),'hex');
  operation_row.id:=operation_id; operation_row.case_id:=manual_case.id;
  operation_row.action:='sweep_expired_application'; operation_row.expected_version:=manual_case.version;
  operation_row.resulting_version:=manual_case.version+1; operation_row.resulting_state:='blocked';
  operation_row.actor_profile_id:=NULL; operation_row.idempotency_key:=operation_key;
  operation_row.request_hash:=operation_hash; operation_row.review_id:=NULL; operation_row.observation_id:=NULL;
  operation_row.application_id:=app.id; operation_row.write_txid:=tx; operation_row.created_at:=p_decision_at;
  operation_row.fencing_token_before:=app.fencing_token; operation_row.source_sweep_receipt_id:=receipt.id;
  PERFORM public."pos_manual_t2_open_legacy_operation_root_v1"(
    't2_reservation:sweep:operation','sweep_expired_application',operation_row);
  INSERT INTO public."pos_manual_payment_operations" SELECT (operation_row).*;

  state_event_row.id:=state_event_id; state_event_row.case_id:=manual_case.id;
  state_event_row.operation_id:=operation_id; state_event_row.from_state:=manual_case.state;
  state_event_row.to_state:='blocked'; state_event_row.resulting_version:=manual_case.version+1;
  state_event_row.source:='maintenance'; state_event_row.source_id:=receipt.id::text;
  state_event_row.write_txid:=tx; state_event_row.created_at:=p_decision_at;
  state_event_row.fencing_token_before:=app.fencing_token; state_event_row.source_sweep_receipt_id:=receipt.id;
  PERFORM public."pos_manual_t2_open_legacy_state_event_root_v1"(
    't2_reservation:sweep:state_event','sweep_expired_application',state_event_row);
  INSERT INTO public."pos_manual_payment_state_events" SELECT (state_event_row).*;

  case_after:=manual_case; case_after.state:='blocked'; case_after.version:=manual_case.version+1;
  case_after.blocked_at:=p_decision_at; case_after.lifecycle_txid:=tx; case_after.updated_at:=p_decision_at;
  PERFORM public."pos_manual_t2_open_legacy_case_root_v1"(
    't2_reservation:sweep:case','sweep_expired_application','UPDATE',manual_case,case_after);
  UPDATE public."pos_manual_payment_cases" SET "state"='blocked',"version"=manual_case.version+1,
    "blocked_at"=p_decision_at,"lifecycle_txid"=tx,"updated_at"=p_decision_at WHERE "id"=manual_case.id;

  app_after:=app; app_after.state:='blocked'; app_after.version:=app.version+1;
  app_after.claim_token_hash:=NULL; app_after.claim_expires_at:=NULL; app_after.claimed_by_hash:=NULL;
  app_after.claimed_at:=NULL; app_after.fencing_token:=0; app_after.blocked_at:=p_decision_at;
  app_after.blocked_code:='reservation_expired'; app_after.failure_class:='reservation_expired';
  app_after.failure_at:=p_decision_at;
  PERFORM public."pos_manual_t2_open_reservation_write_root_v1"('manual_sweeper','application',app.id::text,
    'UPDATE',pg_catalog.to_jsonb(app),pg_catalog.to_jsonb(app_after));
  UPDATE public."pos_manual_payment_applications" SET "state"='blocked',"version"=app.version+1,
    "claim_token_hash"=NULL,"claim_expires_at"=NULL,"claimed_by_hash"=NULL,"claimed_at"=NULL,"fencing_token"=0,
    "blocked_at"=p_decision_at,"blocked_code"='reservation_expired',
    "failure_class"='reservation_expired',"failure_at"=p_decision_at WHERE "id"=app.id;

  incident_id:=pg_catalog.gen_random_uuid();
  INSERT INTO public."pos_manual_payment_incidents"(
    "id","case_id","code","status","production_blocking","expected_hash","reported_hash",
    "manual_application_id","source_sweep_receipt_id","fencing_token_before","write_txid","created_at")
  VALUES(incident_id,manual_case.id,'reservation_expired','open',false,app.snapshot_hash,release_graph_hash,
    app.id,receipt.id,app.fencing_token,tx,p_decision_at);

  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'eventId',event.id,'quantityMicros',reservation.quantity_micros,'releaseReason',event.reason_code,
      'reservationId',reservation.id,'reservationKey',reservation.reservation_key,'sequence',event.sequence,
      'stateAfter',event.state_after) ORDER BY reservation.id::text COLLATE "C"),'[]'::jsonb)
    INTO stock_rows FROM public."pos_manual_application_stock_reservations" reservation
    JOIN public."pos_manual_application_stock_reservation_events" event
      ON event."reservation_id"=reservation."id" AND event."application_id"=reservation."application_id"
     AND event."action"='release' AND event."sequence"=1 WHERE reservation."application_id"=app.id;
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'couponLiveAfter',event.coupon_live_after,'couponLiveBefore',event.coupon_live_before,
      'couponUsedAfter',event.coupon_used_after,'couponUsedBefore',event.coupon_used_before,
      'customerLiveAfter',event.customer_live_after,'customerLiveBefore',event.customer_live_before,
      'customerUsedAfter',event.customer_used_after,'customerUsedBefore',event.customer_used_before,
      'discountCents',event.discount_cents,'eventId',event.id,'globalLiveAfter',event.global_live_after,
      'globalLiveBefore',event.global_live_before,'globalUsedAfter',event.global_used_after,
      'globalUsedBefore',event.global_used_before,'releaseReason',event.reason_code,
      'reservationId',reservation.id,'reservationKey',reservation.reservation_key,'sequence',event.sequence,
      'stateAfter',event.state_after) ORDER BY reservation.id::text COLLATE "C"),'[]'::jsonb)
    INTO promotion_rows FROM public."pos_manual_application_promotion_reservations" reservation
    JOIN public."pos_manual_application_promotion_reservation_events" event
      ON event."reservation_id"=reservation."id" AND event."application_id"=reservation."application_id"
     AND event."action"='release' AND event."sequence"=1 WHERE reservation."application_id"=app.id;
  stock_hash:=public."pos_manual_hash_canonical_json_v1"('t2-stock-release-multiset-v1',
    pg_catalog.jsonb_build_object('reservations',stock_rows,'schemaVersion',1));
  promotion_hash:=public."pos_manual_hash_canonical_json_v1"('t2-promotion-release-multiset-v1',
    pg_catalog.jsonb_build_object('reservations',promotion_rows,'schemaVersion',1));
  release_assertion.application_id:=app.id; release_assertion.release_source:='sweep_expired';
  release_assertion.release_reason:='reservation_expired'; release_assertion.source_sweep_batch_id:=p_batch_id;
  release_assertion.source_sweep_receipt_id:=receipt.id; release_assertion.source_failure_operation_id:=NULL;
  release_assertion.fencing_token_before:=app.fencing_token; release_assertion.stock_released_count:=stock_count;
  release_assertion.promotion_released_count:=promotion_count;
  release_assertion.stock_release_multiset_hash:=stock_hash;
  release_assertion.promotion_release_multiset_hash:=promotion_hash;
  release_assertion.release_graph_hash:=release_graph_hash; release_assertion.release_operation_id:=operation_id;
  release_assertion.release_state_event_id:=state_event_id; release_assertion.release_incident_id:=incident_id;
  release_assertion.release_txid:=tx; release_assertion.created_at:=p_decision_at;
  PERFORM public."pos_manual_t2_open_reservation_write_root_v1"('manual_sweeper','release_assertion',app.id::text,
    'INSERT',NULL,pg_catalog.to_jsonb(release_assertion));
  INSERT INTO public."pos_manual_application_release_assertions" SELECT (release_assertion).*;

  RETURN pg_catalog.jsonb_build_object('applicationId',app.id,'batchIndex',p_batch_index,
    'caseId',manual_case.id,'fencingTokenBefore',app.fencing_token,'receiptId',receipt.id,
    'releaseGraphHash',release_graph_hash,'stockReservationCount',stock_count,
    'promotionReservationCount',promotion_count);
END
$function$;

CREATE FUNCTION public."pos_manual_t2_sweep_request_hash_v1"(
  p_sweeper_id text,p_limit integer,p_idempotency_key text
)
RETURNS text LANGUAGE sql STABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
  SELECT public."pos_manual_hash_canonical_json_v1"('t2-sweep-request-v1',pg_catalog.jsonb_build_object(
    'capability','public.pos_manual_sweep_expired_applications_v1(text,integer,text,text)',
    'idempotencyKey',p_idempotency_key,'limit',p_limit,'schemaVersion',1,
    'sessionUser',session_user,'sweeperId',p_sweeper_id))
$function$;

CREATE FUNCTION public."pos_manual_sweep_expired_applications_v1_impl"(
  p_sweeper_id text,p_limit integer,p_idempotency_key text,p_request_hash text
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE STRICT SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE existing public."pos_manual_application_sweep_batches"%ROWTYPE; batch_row public."pos_manual_application_sweep_batches"%ROWTYPE;
  expected_hash text; result_hash text; receipt_result jsonb; receipts jsonb:='[]'::jsonb;
  session_candidate record; application_id uuid; batch_index integer:=0;
  round_progress integer; stock_total integer:=0; promotion_total integer:=0; now_at timestamptz;
BEGIN
  PERFORM public."pos_manual_t2_assert_shape_v1"(p_idempotency_key,p_request_hash);
  IF p_limit NOT BETWEEN 1 AND 50 OR NOT public."pos_manual_t2_subject_safe_v1"(p_sweeper_id) THEN
    RAISE EXCEPTION 'invalid T2 sweep request shape' USING ERRCODE='22023'; END IF;
  expected_hash:=public."pos_manual_t2_sweep_request_hash_v1"(p_sweeper_id,p_limit,p_idempotency_key);
  IF p_request_hash<>expected_hash THEN RAISE EXCEPTION 'T2 sweep request hash mismatch' USING ERRCODE='23514'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('t2-sweep:key:'||p_idempotency_key,0));
  SELECT * INTO existing FROM public."pos_manual_application_sweep_batches" WHERE "idempotency_key"=p_idempotency_key FOR UPDATE;
  IF existing.id IS NOT NULL THEN
    IF existing.request_hash<>p_request_hash OR existing.sweeper_id<>p_sweeper_id OR existing.requested_limit<>p_limit THEN
      RAISE EXCEPTION 'T2 sweep idempotency conflict' USING ERRCODE='23505'; END IF;
    RETURN pg_catalog.jsonb_build_object('applicationCount',existing.application_count,'batchId',existing.id,
      'caseCount',existing.case_count,'promotionReservationCount',existing.promotion_reservation_count,
      'releaseResultHash',existing.release_result_hash,'replayed',true,'stockReservationCount',existing.stock_reservation_count);
  END IF;
  batch_row.id:=public."pos_manual_uuid16_v1"('t2-sweep-identity-v1',pg_catalog.jsonb_build_object(
    'idempotencyKey',p_idempotency_key,'requestHash',p_request_hash,'schemaVersion',1,'sweeperId',p_sweeper_id));

  -- Fair rounds: at most one application per cash-register session in each
  -- pass.  Session rows are the contention boundary; locked sessions are
  -- skipped without stalling unrelated stores/registers.
  LOOP
    EXIT WHEN batch_index>=p_limit;
    round_progress:=0; now_at:=pg_catalog.clock_timestamp();
    FOR session_candidate IN
      SELECT session_row."id",candidate."first_expiry"
        FROM public."cash_register_sessions" session_row
        JOIN (
          SELECT manual_case."session_id",pg_catalog.min(app."reservation_expires_at") AS "first_expiry"
            FROM public."pos_manual_payment_applications" app
            JOIN public."pos_manual_payment_cases" manual_case ON manual_case."id"=app."case_id"
           WHERE app."state" IN ('pending','claimed') AND app."reservation_expires_at"<=now_at
           GROUP BY manual_case."session_id"
        ) candidate ON candidate."session_id"=session_row."id"
       ORDER BY candidate."first_expiry",session_row."id"
       LIMIT (p_limit-batch_index)
       FOR UPDATE OF session_row SKIP LOCKED
    LOOP
      application_id:=NULL;
      SELECT app."id" INTO application_id
        FROM public."pos_manual_payment_applications" app
        JOIN public."pos_manual_payment_cases" manual_case ON manual_case."id"=app."case_id"
       WHERE manual_case."session_id"=session_candidate."id"
         AND app."state" IN ('pending','claimed') AND app."reservation_expires_at"<=now_at
       ORDER BY app."reservation_expires_at",app."id"::text COLLATE "C"
       LIMIT 1 FOR UPDATE OF app SKIP LOCKED;
      IF application_id IS NULL THEN CONTINUE; END IF;
      receipt_result:=public."pos_manual_t2_release_expired_application_v1"(
        application_id,batch_row.id,batch_index,p_sweeper_id,p_idempotency_key,pg_catalog.clock_timestamp());
      IF receipt_result IS NULL THEN CONTINUE; END IF;
      stock_total:=stock_total+(receipt_result->>'stockReservationCount')::integer;
      promotion_total:=promotion_total+(receipt_result->>'promotionReservationCount')::integer;
      receipts:=receipts||pg_catalog.jsonb_build_array(
        receipt_result-ARRAY['stockReservationCount','promotionReservationCount']);
      batch_index:=batch_index+1; round_progress:=round_progress+1;
      EXIT WHEN batch_index>=p_limit;
    END LOOP;
    EXIT WHEN round_progress=0;
  END LOOP;

  result_hash:=public."pos_manual_hash_canonical_json_v1"('t2-sweep-result-v1',pg_catalog.jsonb_build_object(
    'batchId',batch_row.id,'receipts',receipts,'schemaVersion',1));
  batch_row.idempotency_key:=p_idempotency_key; batch_row.request_hash:=p_request_hash;
  batch_row.sweeper_id:=p_sweeper_id;
  batch_row.sweeper_hash:=public."pos_manual_hash_canonical_json_v1"('t2-sweeper-subject-v1',pg_catalog.jsonb_build_object('schemaVersion',1,'sweeperId',p_sweeper_id));
  batch_row.requested_limit:=p_limit; batch_row.caller_role:=session_user;
  batch_row.application_count:=batch_index; batch_row.case_count:=batch_index;
  batch_row.stock_reservation_count:=stock_total;
  batch_row.promotion_reservation_count:=promotion_total; batch_row.release_result_hash:=result_hash;
  batch_row.write_txid:=pg_catalog.txid_current()::numeric; batch_row.created_at:=pg_catalog.clock_timestamp();
  PERFORM public."pos_manual_t2_open_reservation_write_root_v1"('manual_sweeper','sweep_batch',batch_row.id::text,'INSERT',NULL,pg_catalog.to_jsonb(batch_row));
  INSERT INTO public."pos_manual_application_sweep_batches" SELECT (batch_row).*;
  RETURN pg_catalog.jsonb_build_object('applicationCount',batch_index,'batchId',batch_row.id,'caseCount',batch_index,
    'promotionReservationCount',promotion_total,'releaseResultHash',result_hash,
    'replayed',false,'stockReservationCount',stock_total);
END
$function$;

CREATE FUNCTION public."pos_manual_sweep_expired_applications_v1"(
  p_sweeper_id text,p_limit integer,p_idempotency_key text,p_request_hash text
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
  PERFORM public."pos_manual_t2_authority_v1"('manual_sweeper');
  IF pg_catalog.current_setting('transaction_isolation')<>'serializable'
    OR pg_catalog.current_setting('transaction_read_only')<>'off'
    OR pg_catalog.current_setting('application_name')<>'nalven-pos-manual-sweep-v1' THEN
    RAISE EXCEPTION 'T2 sweep requires its dedicated serializable autocommit executor' USING ERRCODE='25001'; END IF;
  RETURN public."pos_manual_sweep_expired_applications_v1_impl"(p_sweeper_id,p_limit,p_idempotency_key,p_request_hash);
END
$function$;

-- All new data starts owner-only.  The dedicated reconcile publishes only
-- capability EXECUTE after the T2-02 exit gate; runtime/_ms never receive
-- relation or sequence privileges.
REVOKE ALL ON FUNCTION public."pos_manual_uuid16_v1"(text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_manual_t2_json_array_objects_exact_v1"(jsonb,text[],integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_manual_t2_document_shape_v1"(text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_manual_t2_stock_mode_v1"(text,boolean,integer,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_manual_t2_float_to_micros_v1"(double precision) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_manual_t2_boundary_row_projection_v1"(text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_manual_t2_reservation_projection_hash_v1"(text,text,text,jsonb,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_manual_t2_open_reservation_write_root_v1"(text,text,text,text,jsonb,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_manual_t2_observe_reservation_write_v1"() FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_manual_t2_reject_unconsumed_reservation_root_v1"() FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_manual_t2_verify_reserve_graph_v1"() FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_manual_t2_verify_release_graph_v1"() FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_manual_t2_stamp_product_boundary_v1"() FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_manual_t2_stamp_variation_boundary_v1"() FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_manual_t2_stamp_value_program_boundary_v1"() FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_manual_t2_stamp_accounting_period_boundary_v1"() FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_manual_t2_stamp_accounting_mapping_boundary_v1"() FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_manual_t2_stamp_webhook_boundary_v1"() FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_manual_t2_boundary_actor_v1"(text,text,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_manual_t2_boundary_operation_id_v1"(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_manual_t2_boundary_replay_v1"(text,uuid,text,text,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_manual_t2_record_boundary_operation_v1"(uuid,text,text,text,text,jsonb,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_manual_t2_assert_boundary_executor_v1"() FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_t2_catalog_boundary_v1_impl"(text,integer,integer,text,jsonb,jsonb,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_t2_catalog_boundary_v1"(text,integer,integer,text,jsonb,jsonb,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_t2_value_program_boundary_v1_impl"(text,text,integer,text,integer,text,text,text,integer,integer,integer,integer,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_t2_value_program_boundary_v1"(text,text,integer,text,integer,text,text,text,integer,integer,integer,integer,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_t2_accounting_period_put_v1_impl"(integer,integer,integer,date,date,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_t2_accounting_period_put_v1"(integer,integer,integer,date,date,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_t2_accounting_period_close_v1_impl"(text,integer,text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_t2_accounting_period_close_v1"(text,integer,text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_t2_webhook_boundary_v1_impl"(text,text,integer,text,text,text,text,text,text,text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_t2_webhook_boundary_v1"(text,text,integer,text,text,text,text,text,text,text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_manual_t2_reserve_request_hash_v1"(uuid,integer,integer,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_manual_t2_application_currently_applicable_v1"(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_manual_t2_actor_authorized_for_case_v1"(uuid,integer,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_manual_t2_status_object_v1"(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_manual_t2_reserve_result_v1"(uuid,text,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_manual_reserve_application_v1_impl"(uuid,integer,integer,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_manual_reserve_application_v1"(uuid,integer,integer,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_manual_application_status_v1"(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_manual_application_status_by_reservation_v1"(uuid,text,text,integer,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_manual_t2_sweep_request_hash_v1"(text,integer,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_manual_t2_case_blocks_lifecycle_v1"(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_manual_t2_release_expired_application_v1"(uuid,uuid,integer,text,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_manual_sweep_expired_applications_v1_impl"(text,integer,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public."pos_manual_sweep_expired_applications_v1"(text,integer,text,text) FROM PUBLIC;
REVOKE ALL ON TABLE public."pos_manual_t2_reservation_write_roots" FROM PUBLIC;
REVOKE ALL ON TABLE public."pos_manual_t2_boundary_operations" FROM PUBLIC;
REVOKE ALL ON TABLE public."pos_manual_application_stock_reservations" FROM PUBLIC;
REVOKE ALL ON TABLE public."pos_manual_application_stock_reservation_events" FROM PUBLIC;
REVOKE ALL ON TABLE public."pos_manual_application_promotion_reservations" FROM PUBLIC;
REVOKE ALL ON TABLE public."pos_manual_application_promotion_reservation_events" FROM PUBLIC;
REVOKE ALL ON TABLE public."pos_manual_application_reserve_assertions" FROM PUBLIC;
REVOKE ALL ON TABLE public."pos_manual_application_release_assertions" FROM PUBLIC;
REVOKE ALL ON TABLE public."pos_manual_application_sweep_batches" FROM PUBLIC;
REVOKE ALL ON TABLE public."pos_manual_application_sweep_receipts" FROM PUBLIC;

COMMIT;
