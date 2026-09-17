import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

const decisionsPath = "docs/erp/pdv/DECISOES-EXECUTAVEIS-T2-02.md";
const decisions = readFileSync(decisionsPath, "utf8");

function requireLiteral(value: string) {
  assert.ok(decisions.includes(value), `literal ausente no addendum: ${value}`);
}

test("gate documental bloqueia migration até T2-01 SAFE", () => {
  requireLiteral("Status: **CONTRATO NORMATIVO / IMPLEMENTAÇÃO BLOQUEADA**");
  requireLiteral("T2-01 precisa estar `SAFE`");
  requireLiteral("é proibido criar a migration T2-02");
  requireLiteral("`required_queue` permanece\nfail-closed até T2-06");
});

test("allowlist de domínios é fechada e ordenada pelo contrato", () => {
  const match = decisions.match(/A T2-02 estende a allowlist do helper T2-00 somente com:\n\n```text\n([\s\S]*?)\n```/);
  assert.ok(match);
  assert.deepEqual(match[1].split("\n"), [
    "t2-reserve-request-v1", "t2-reserve-identity-v1",
    "t2-reservation-id-v1", "t2-reservation-event-id-v1",
    "t2-stock-reservation-key-v1", "t2-promotion-reservation-key-v1",
    "t2-effect-key-v1", "t2-sale-idempotency-v1", "t2-sale-request-v1",
    "t2-sale-payment-identity-v1", "t2-sale-payment-idempotency-v1",
    "t2-sweep-request-v1", "t2-sweep-identity-v1",
    "t2-sweep-receipt-id-v1", "t2-sweeper-subject-v1",
    "t2-sweep-result-v1", "t2-promotion-policy-v1",
    "t2-reservation-graph-v1", "t2-release-result-v1",
    "t2-customer-opaque-v1", "t2-customer-eligibility-v1",
    "t2-tracking-request-v1", "t2-catalog-product-v1",
    "t2-catalog-variation-v1", "t2-value-program-v1",
    "t2-value-account-identity-v1", "t2-value-entry-key-v1",
    "t2-value-ledger-request-v1",
    "t2-accounting-period-v1", "t2-accounting-mapping-v1",
    "t2-accounting-journal-identity-v1",
    "t2-accounting-journal-idempotency-v1",
    "t2-accounting-journal-request-v1",
    "t2-stock-multiset-v1", "t2-promotion-multiset-v1",
    "t2-stock-release-multiset-v1", "t2-promotion-release-multiset-v1",
    "t2-webhook-config-v1", "t2-webhook-payload-v1",
    "t2-fiscal-envelope-identity-v1",
    "t2-fiscal-envelope-prepare-v1", "t2-fiscal-envelope-binding-v1",
    "t2-fiscal-document-identity-v1", "t2-fiscal-document-idempotency-v1",
    "t2-fiscal-document-request-v1", "t2-fiscal-attempt-identity-v1",
    "t2-fiscal-attempt-operation-v1", "t2-fiscal-attempt-request-v1",
    "t2-fiscal-provider-idempotency-v1", "t2-fiscal-number-allocation-identity-v1",
    "t2-webhook-event-identity-v1",
    "t2-webhook-delivery-identity-v1",
    "t2-boundary-operation-identity-v1",
    "t2-catalog-boundary-request-v1",
    "t2-value-program-boundary-request-v1",
    "t2-accounting-period-boundary-request-v1",
    "t2-accounting-period-put-request-v1",
    "t2-webhook-boundary-request-v1",
  ]);
});

test("v12 fecha cinco boundary writers sem ampliar authority", () => {
  requireLiteral("Esta v12 substitui e invalida formalmente o freeze anterior");
  for (const signature of [
    "public.pos_t2_catalog_boundary_v1(text,integer,integer,text,jsonb,jsonb,text,text,text) returns jsonb",
    "public.pos_t2_value_program_boundary_v1(text,text,integer,text,integer,text,text,text,integer,integer,integer,integer,text,text,text) returns jsonb",
    "public.pos_t2_accounting_period_put_v1(integer,integer,integer,date,date,text,text,text,text) returns jsonb",
    "public.pos_t2_accounting_period_close_v1(text,integer,text,text,text,text,text) returns jsonb",
    "public.pos_t2_webhook_boundary_v1(text,text,integer,text,text,text,text,text,text,text,text,text,text,text) returns jsonb",
  ]) requireLiteral(signature);
  requireLiteral("wrappers `SECURITY DEFINER`, `SET search_path=pg_catalog`");
  requireLiteral("Não existe requisito de `application_name` para estas cinco ABIs");
  requireLiteral("root faltante/sobrando ou DML após\nreplay aborta tudo");
  requireLiteral("UPDATE somente\nde stock, cost, métricas, `failure_count`");
  requireLiteral("DELETE de product é proibido");
  requireLiteral("Historical UPDATE/DELETE e DELETE lógico/físico são proibidos");
  requireLiteral("`pos_accounting_policy_mappings` fica congelada para runtime");
  requireLiteral("zero ACL nas relações e\nsequences **novas de T2-02**");
  requireLiteral("ACL legado reconciliado que o runtime\njá possui em `products`, `product_variations`");
  requireLiteral("qualquer INSERT/UPDATE/DELETE boundary sem root exato falha\n`42501`");
  requireLiteral("replay retorna o plano persistido e o wrapper não executa DML");
});

test("vetores byte-exatos publicados produzem hashes fixos", () => {
  const vectors = [
    ["t2-effect-v1", "{\"effectKey\":\"promotion_redemption:none\",\"effectKind\":\"promotion_redemption\",\"payload\":{\"present\":false},\"schemaVersion\":1}", "c7b67df259d3212ce82868f720e8024a1f84c15bae0114c42aeb2bf9846e7c3f"],
    ["t2-stock-multiset-v1", "{\"reservations\":[],\"schemaVersion\":1}", "4d3b679caff5499d47ec8c9d24de641d783e47f576e49b28711989a18720f00e"],
    ["t2-promotion-multiset-v1", "{\"reservations\":[],\"schemaVersion\":1}", "2ecf821974593e457a99f0274a17885d3826f5e8cedcb5ab9567c460e940f0d4"],
    ["t2-stock-release-multiset-v1", "{\"reservations\":[],\"schemaVersion\":1}", "2736e34b7094bf9840398d20d754e85a379a71a1f9018a4edbcbe39426b6381e"],
    ["t2-promotion-release-multiset-v1", "{\"reservations\":[],\"schemaVersion\":1}", "8069cb2d52eaa03c676415cda09f88cc7426e4f7d3351bdf8fb19953795f106a"],
    ["t2-customer-opaque-v1", "{\"customerId\":null,\"schemaVersion\":1}", "9460e8138b8585ab1aa527a26dde5aa0950dd21e890f298bad08e81654fdcd62"],
  ] as const;
  for (const [domain, canonical, expected] of vectors) {
    const actual = createHash("sha256").update(domain).update(Buffer.from([0])).update(canonical).digest("hex");
    assert.equal(actual, expected);
    requireLiteral(expected);
  }
});

test("ABI pública está congelada por assinatura completa", () => {
  requireLiteral(`public.pos_manual_reserve_application_v1(
  p_case_id uuid,
  p_expected_case_version_before_reserve integer,
  p_actor_profile_id integer,
  p_actor_user_id text,
  p_idempotency_key text,
  p_request_hash text
) returns jsonb`);
  requireLiteral(`public.pos_manual_application_status_v1(
  p_application_id uuid,
  p_actor_user_id text
) returns jsonb`);
  requireLiteral("public.pos_manual_application_status_by_reservation_v1(");
  requireLiteral("public.pos_manual_sweep_expired_applications_v1(");
  requireLiteral("**exatamente** `SET search_path=pg_catalog`");
  requireLiteral("falham se wrapper público contiver `public` no `proconfig`");
});

test("dez snapshots incluem comercial completo e value no doc existente", () => {
  for (const snapshot of [
    "operational_actor", "case_evidence", "draft_quote_slot",
    "customer_sale_payment", "catalog_bom_tracking", "inventory_promotion",
    "fiscal", "accounting", "webhooks", "manifest",
  ]) requireLiteral(`\`${snapshot}\``);
  requireLiteral("payment,sale,saleItems,schemaVersion,value");
  requireLiteral("`value` tem exatamente `accounts,accruals,programs`");
  requireLiteral("accountId = UUID16('t2-value-account-identity-v1'");
  requireLiteral("entryKey = H('t2-value-entry-key-v1'");
  requireLiteral("`programs` ordena por `programId`; `accounts` por\n`(programId,accountId)`; `accruals` por `(programId,entryKey,accountId)`");
  requireLiteral("T2-05 insere `pos_value_accounts` com esses valores e ID exato");
  requireLiteral("mais de 32 programas active na branch\nfalha `22023 T2 value program graph exceeds limit`");
  requireLiteral("é proibido escolher os primeiros 32");
  requireLiteral("cashRegisterLegacyLabel=\"CAIXA:\"||registerId");
  requireLiteral("plannedPaymentId = UUID16('t2-sale-payment-identity-v1'");
  requireLiteral("T2b\ninsere `pos_sale_payments.id` com esse texto exato");
  requireLiteral("paymentIdempotencyKey = H('t2-sale-payment-idempotency-v1'");
  requireLiteral("`card_last_four=null`");
  requireLiteral('`{"evidenceHash":<Hash64>,"manualPaymentCaseId":<uuid>');
  requireLiteral("metadata converte-o para JSON number sem aspas");
  requireLiteral("`connector_id,original_payment_id,transaction_id,");
  requireLiteral("plannedAccountLabel");
  requireLiteral("label, code/pin e metadata\nlivres **não entram** em snapshot/hash");
  requireLiteral("`discount_cents = baseDiscountCents + orderDiscountCents +\npromotionDiscountCents`");
  requireLiteral("`base_discount_cents`, `order_discount_cents` e\n`promotion_discount_cents`");
});

test("fontes inexistentes têm migration/backfill/hash e timezone normativos", () => {
  for (const column of [
    "products.pos_revision integer NOT NULL", "product_variations.pos_revision integer NOT NULL",
    "pos_value_programs.revision integer NOT NULL", "pos_accounting_periods.revision integer NOT NULL",
    "pos_accounting_policy_mappings.config_hash Hash64",
  ]) requireLiteral(column);
  requireLiteral("todas as revisions\ncomeçam em 1");
  requireLiteral("mudança só de `updated_at`\nnão incrementa");
  requireLiteral("`branch.timezone` é validado por match exato em `pg_timezone_names`");
  requireLiteral("businessDate =\n(planned_sale_occurred_at AT TIME ZONE branchTimezone)::date");
  requireLiteral("O `pos_accounting_policies.mapping_hash` **não muda de fórmula**");
  requireLiteral("Reserve não tenta\nreimplementar `localeCompare` em SQL nem recalcula o aggregate");
  requireLiteral("| 1 | `sale.tender` | debit | `totalCents` | sempre |");
  requireLiteral("| 4 | `sale.surcharge` | credit | `surchargeCents` | somente se >0 |");
  requireLiteral("`totalCents + discountCents = subtotalCents + surchargeCents`");
  requireLiteral("`accountCodeSnapshot` e `accountNameSnapshot`");
  requireLiteral("journalId = UUID16('t2-accounting-journal-identity-v1'");
  requireLiteral("idempotencyKey = H('t2-accounting-journal-idempotency-v1'");
  requireLiteral("requestHash = H('t2-accounting-journal-request-v1'");
  requireLiteral("`sourceSnapshot` é exatamente `source` e\n`sourceSnapshotHash=SHA256(C(source))`");
  requireLiteral('`{"journal":<journal>,"source":<source>}`');
  requireLiteral('`{"journalId":<OpaqueId>,"posting":<postings[i]>}`');
  requireLiteral('`{"deliveryCount":0,"journalId":<OpaqueId>,"maxDeliveries":8,"nextAttemptAt":<Instant>,"state":"pending"}`');
});

test("limites cabem no canonical e dinheiro cabe nos alvos", () => {
  requireLiteral("`MoneyCents`: integer entre `0` e `2147483647`");
  requireLiteral("**4.194.304 bytes**");
  requireLiteral("no máximo **1.812 entries**");
  requireLiteral("O builder calcula cardinalidade e tamanho\nantes da primeira escrita");
});

test("projeções fecham 22 kinds e cardinalidade zero tem sentinel", () => {
  const kinds = [
    "sale", "sale_item", "sale_payment", "plan_consume", "draft_convert",
    "promotion_redemption", "kit_component", "tracked_lot_movement",
    "stock_movement", "warehouse_ledger", "value_account",
    "value_ledger_entry", "value_accrual", "fiscal_document",
    "fiscal_attempt", "fiscal_outbox", "accounting_journal",
    "accounting_posting", "accounting_export_outbox", "sale_event",
    "audit_event", "webhook_delivery",
  ];
  for (const kind of kinds) requireLiteral(`| \`${kind}\` /`);
  requireLiteral("`effect_key='<kind>:none'`, `P={\"present\":false}`");
  requireLiteral("`expected_cardinality=0`, `required=false`");
  requireLiteral("Não existe percent-encoding nem marcador nullable textual");
});

test("promoção fecha schemas, hash e doze contadores", () => {
  requireLiteral("`productIds,categoryIds,minimumQuantity,couponRequired`");
  requireLiteral("minimumQuantityMicros");
  requireLiteral('{"discountCents":null,"maximumDiscountCents":1000,"percentageBasisPoints":500,"type":"percentage"}');
  requireLiteral('{"discountCents":<MoneyCents positivo>,"type":"fixed"}');
  requireLiteral('{"maximumDiscountCents":<MoneyCents positivo|null>,"percentageBasisPoints":<integer 1..10000>,"type":"percentage"}');
  requireLiteral("Os três placeholders são JSON numbers");
  for (const counter of [
    "global_used_before", "global_used_after", "customer_used_before", "customer_used_after",
    "coupon_used_before", "coupon_used_after", "global_live_before", "global_live_after",
    "customer_live_before", "customer_live_after", "coupon_live_before", "coupon_live_after",
  ]) requireLiteral(counter);
  requireLiteral("release exige live\nafter=before-1 e used after=before");
});

test("webhook define version/backfill/config/payload/FK", () => {
  requireLiteral("`logical_id=id,version=1,superseded_at=NULL`");
  requireLiteral("config_hash = H('t2-webhook-config-v1'");
  requireLiteral("`payload_hash = H('t2-webhook-payload-v1', payload)`");
  requireLiteral("FK RESTRICT exata para\n`(logical_id,version,config_hash)`");
  requireLiteral("muda a FK física de `ON DELETE CASCADE`\npara `RESTRICT`");
  requireLiteral("unique parcial `(logical_id) WHERE\nsuperseded_at IS NULL`");
  requireLiteral("exige `p_expected_version` e `p_expected_config_hash`");
});

test("status, IDs, SERIALIZABLE e sweep fecham máquinas críticas", () => {
  for (const state of ["pending", "claimed", "applied", "blocked"]) requireLiteral(`| \`${state}\` |`);
  requireLiteral("t2-reservation-event-id-v1");
  requireLiteral("t2-sweep-receipt-id-v1");
  requireLiteral("{applicationId,batchIndex,idempotencyKey,schemaVersion:1,sweeperId}");
  requireLiteral("pool/DSN **dedicado ao reserve/sweep**");
  requireLiteral("É proibido `ALTER ROLE runtime SET\ndefault_transaction_isolation`");
  requireLiteral("`fencing_token=0`");
  requireLiteral("fencing_token_before");
  requireLiteral('"fencingTokenBefore":<integer>,"receiptId":<uuid>');
});

test("required_queue usa prepare/bind sem prever sequence ou relógio", () => {
  requireLiteral("o serviço externo nunca prevê\nsequence nem relógio da sale");
  requireLiteral("prepared_hash = H('t2-fiscal-envelope-prepare-v1'");
  requireLiteral("binding_hash = H('t2-fiscal-envelope-binding-v1'");
  requireLiteral("O ABI reserve não recebe locator/ID do caller");
  requireLiteral("Rollback de reserve desfaz o bind");
  requireLiteral("bound→released causalmente");
  requireLiteral("envelopePreparedHash,plannedSaleIdentityHash,envelopeBindingHash");
  requireLiteral("`disposition=\"required_queue_bound\"`");
  requireLiteral('{"amountCents":<MoneyCents>,"currency":"BRL","documentModel":"<Code>","environment":"<Code>","number":<positive integer|null>');
  requireLiteral("JSON **numbers**, sem aspas");
  requireLiteral('"envelopeLocator":<OpaqueId>,"envelopeVersion":<integer>');
  requireLiteral('"expiresAt":<Instant>,"fiscalPolicyHash":<Hash64>');
  requireLiteral("por `envelope_id+prepared_hash` detecta qualquer diferença de locator ou TTL");
  requireLiteral("association_txid NULL");
  requireLiteral("consumed_at NULL,consume_txid NULL,released_at NULL");
  requireLiteral("release_txid NULL,release_reason NULL,creation_txid,created_at");
  requireLiteral("consume e release são mutuamente exclusivos");
  requireLiteral("**A mesma transação T2a**, depois do\nbind, materializa o documento fiscal append-only completo");
  requireLiteral("T2b T2-06 apenas relê/revalida a row bound contra o snapshot");
  assert.ok(decisions.indexOf("t2-fiscal-envelope-prepare-v1") < decisions.indexOf("Os cinco domínios T2-00"));
  assert.ok(decisions.indexOf("t2-fiscal-envelope-binding-v1") < decisions.indexOf("Os cinco domínios T2-00"));
});

test("stockMode segue parent|true|false e controla dimensões CAS", () => {
  requireLiteral("stock_mode text NOT NULL             -- parent|variation");
  requireLiteral("`stock_mode=variation` exige variation_id");
  requireLiteral("`variation.manage_stock='true'` → `variation`, mesmo se\n   `product.manage_stock=false`");
  requireLiteral("`variation.manage_stock='false'` → `none`");
  requireLiteral("`parent` faz CAS somente na dimensão\nparent");
  requireLiteral('"stockMode":"parent"|"variation"');
});

test("close/handoff exige bloqueio e release assertion", () => {
  requireLiteral("case `confirmed_paid` **sempre bloqueia**, exista application ou não");
  requireLiteral("case `application_pending` bloqueia se falta assertion integral");
  requireLiteral("`pos_manual_application_release_assertions`");
  requireLiteral("zero stock/promotion reservations em state reserved");
  requireLiteral("`report_boundary_changed` T2-03");
  requireLiteral("t2-stock-release-multiset-v1");
  requireLiteral("t2-promotion-release-multiset-v1");
  requireLiteral("source_sweep_batch_id uuid NULL; source_sweep_receipt_id uuid NULL");
  requireLiteral("release_state_event_id bigint; release_incident_id uuid");
  requireLiteral("`source_failure_operation_id = release_operation_id`");
});

test("efeitos físicos têm vínculo causal reconstruível e journal completo", () => {
  requireLiteral("manual_stock_reservation_id uuid,creation_txid");
  requireLiteral("FK composta RESTRICT\n`(manual_application_id,manual_stock_reservation_id)`");
  requireLiteral("join apenas por application, product, lot,\nscopeKey ou posição é proibido");
  requireLiteral("`sourceSnapshot` é exatamente `source`");
  requireLiteral("`currency=\"BRL\"`");
  requireLiteral("`occurredAt=plannedSaleOccurredAt`");
  requireLiteral("`pos_value_accrual_effects(effect_key text PRIMARY KEY, application_id uuid");
  requireLiteral("`pos_kit_sale_components.unit_quantity_micros`");
});

test("matriz física fecha identidade, constraints e actual P dos 22 effects", () => {
  requireLiteral("`actual_hash` serializa **exatamente o mesmo P**");
  requireLiteral("`manual_manifest_entry_id bigint NOT NULL UNIQUE`");
  requireLiteral("before é `state='active',version=planVersion`");
  requireLiteral("`status=draft_quote_slot.draftStatus`");
  requireLiteral("`type='credit'` (o `entryType='earn'`");
  requireLiteral("CHECK `amount_units>0`");
  requireLiteral("`sourceSnapshotHash=SHA256(C(source))`");
  requireLiteral("documentId=UUID16('t2-fiscal-document-identity-v1'");
  requireLiteral("attemptId=UUID16('t2-fiscal-attempt-identity-v1'");
  requireLiteral("`purpose='issue',revision=1,status='queued',version=0`");
  requireLiteral("sequence 1, operation issue, state queued");
  requireLiteral("Se owner é `local`, T2a usa o ledger/counter");
  requireLiteral("Se owner é `provider`, ambos são null");
  requireLiteral("`pos_fiscal_number_counters(profile_id text,profile_version integer,series");
  requireLiteral("não há backfill de profile active local");
  requireLiteral("Rollback desfaz ambos (sem gap)");
  requireLiteral("eventId=UUID16('t2-webhook-event-identity-v1'");
  requireLiteral("deliveryId=UUID16('t2-webhook-delivery-identity-v1'");
  requireLiteral("`endpoint_id=endpointRowId`");
  requireLiteral("`actual_hash` reconstrói somente o P registrado");
});

test("índices mutáveis apontam para o addendum", () => {
  const readme = readFileSync("docs/erp/pdv/README.md", "utf8");
  const plan = readFileSync("docs/erp/pdv/PLANO-E-RASTREABILIDADE.md", "utf8");
  assert.match(readme, /DECISOES-EXECUTAVEIS-T2-02\.md/);
  assert.match(plan, /addendum T2-02 fecha ABIs/);
});
