import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const schema = readFileSync(new URL("../prisma/tenant/schema.prisma", import.meta.url), "utf8");
const migration = readFileSync(new URL("../prisma/tenant/migrations/20260829310000_pos_authoritative_payment_plan/migration.sql", import.meta.url), "utf8");
const planService = readFileSync(new URL("../lib/erp/pos-payment-plan.ts", import.meta.url), "utf8");
const persistence = readFileSync(new URL("../lib/erp/pos-payment-persistence.ts", import.meta.url), "utf8");
const route = readFileSync(new URL("../app/api/erp/pdv/route.ts", import.meta.url), "utf8");
const planRoute = readFileSync(new URL("../app/api/erp/pdv/payment-plans/route.ts", import.meta.url), "utf8");
const intentRoute = readFileSync(new URL("../app/api/erp/pdv/payment-intents/route.ts", import.meta.url), "utf8");
const operationalPrelock = readFileSync(new URL("../lib/erp/pos-manual-operational-prelock.ts", import.meta.url), "utf8");

test("310000 persiste plano, slots, linhas e operações com prova composta", () => {
  for (const model of ["PosPaymentPlan", "PosPaymentPlanSlot", "PosPaymentPlanQuoteLine", "PosPaymentPlanOperation"]) {
    assert.match(schema, new RegExp(`model ${model} \\{`));
  }
  assert.match(schema, /@relation\(fields: \[paymentPlanId, paymentIndex\], references: \[planId, paymentIndex\], onDelete: Restrict\)/);
  assert.match(migration, /CREATE TABLE "pos_payment_plan_quote_lines"/);
  assert.match(migration, /FOREIGN KEY \("payment_plan_id", "payment_index", "method", "amount_cents", "installments"\)/);
  assert.match(migration, /CREATE CONSTRAINT TRIGGER "pos_payment_plan_quote_commit_guard"/);
  assert.match(migration, /CREATE CONSTRAINT TRIGGER "pos_payment_plan_operation_commit_guard"/);
  assert.match(migration, /CREATE CONSTRAINT TRIGGER "sales_authoritative_payment_plan_commit_guard"/);
  assert.match(migration, /CREATE CONSTRAINT TRIGGER "pos_sale_payments_authoritative_plan_commit_guard"/);
  assert.match(migration, /CREATE CONSTRAINT TRIGGER "pos_payment_intents_consumed_plan_commit_guard"/);
  assert.match(schema, /model PosPaymentStateEvent \{[\s\S]*writeTxid\s+Decimal[\s\S]*@map\("write_txid"\)/);
  assert.match(migration, /manual payment plan slots remain disabled until the reconciliation workflow is installed/);
});

test("cotação relacional e consumo recomputam rascunho, preço e venda", () => {
  assert.match(migration, /CREATE FUNCTION "validate_pos_payment_plan_activation"/);
  assert.match(migration, /CREATE FUNCTION "validate_consumed_pos_payment_plan"/);
  assert.match(migration, /pos_payment_plan_quote_lines[\s\S]*held_sale_item_id/);
  assert.match(migration, /EXCEPT ALL[\s\S]*UNION ALL[\s\S]*EXCEPT ALL/);
  assert.match(migration, /protect_pos_payment_plan_quote_line[\s\S]*initial quote transaction/);
  assert.match(migration, /pos_payment_plan_slots_phase_commit_guard/);
  assert.match(migration, /consumed pos payment plan does not exactly match sale payments/);
  assert.match(planService, /normalizeQuoteLines\(input\.quoteLines, draft\.items\)/);
  assert.match(planService, /assertDraftMatchesPlan\(draft, plan\)/);
});

test("intent e commit recebem identidade do plano, nunca valor autoritativo do terminal", () => {
  assert.match(persistence, /onlyKeys\(body, \["action", "sessionId", "paymentPlanId", "paymentIndex", "idempotencyKey"\]\)/);
  assert.match(persistence, /amountCents: slot\.amountCents/);
  assert.match(route, /const paymentPlanId = string\(body\.paymentPlanId/);
  assert.match(route, /const paymentPlanVersion = integerRange\(body\.paymentPlanVersion/);
  assert.match(route, /const paymentInputs = authoritativePayment\.paymentInputs/);
  assert.match(route, /payments: \{ create: settlement\.payments\.flatMap/);
  assert.match(planRoute, /parsePosPaymentPlanActivation\(body\)/);
  assert.match(intentRoute, /intentDtoWithPaymentPlanId/);
  assert.match(intentRoute, /paymentPlanId: binding\.paymentPlanId/);
});

test("dispatch create revalida a cadeia canônica e callbacks tardios continuam persistíveis", () => {
  assert.match(persistence, /lockPosPaymentIntentCanonical/);
  assert.match(persistence, /createDispatchBoundaryFailure\(authoritativeGraph, now\)/);
  assert.match(persistence, /FOR UPDATE OF session SKIP LOCKED/);
  for (const proof of ["plan.state !== \"active\"", "session.status !== \"open\"", "terminal.status !== \"online\"", "credential.enabled", "claim.leaseExpiresAt <= now"]) {
    assert.ok(persistence.includes(proof), `faltou boundary ${proof}`);
  }
  assert.match(persistence, /terminal_state_callback_conflict/);
  assert.match(migration, /terminal_state_callback_conflict/);
});

test("ativação e criação exigem grant operacional explícito, sem papel gerencial implícito", () => {
  for (const source of [planRoute, intentRoute]) {
    assert.match(source, /authorizePosOperationalAction/);
    assert.match(source, /action: "sale\.prepare"/);
    assert.match(source, /branchUserAccess\.findUnique/);
    assert.match(source, /posRegisterAccess\.findUnique/);
    assert.doesNotMatch(source, /privileged/);
  }
  assert.match(migration, /assert_pos_payment_plan_live_access/);
  assert.match(persistence, /authoritative_access_revoked/);
  assert.doesNotMatch(persistence, /context\.privileged/);
});

test("supersede e expire usam exclusivamente a capability do graph", () => {
  assert.doesNotMatch(operationalPrelock, /pos_manual_prepare_plan_release_v1/);
  assert.doesNotMatch(planService, /preparePosManualPlanRelease/);
  assert.doesNotMatch(persistence, /preparePosManualPlanRelease/);
  assert.match(planService, /preparePosPaymentPlanGraphWrite\(tx, \{[\s\S]*action: "supersede"[\s\S]*posPaymentPlanOperation\.create[\s\S]*posPaymentPlan\.updateMany/);
  assert.match(planService, /afterData: \{ state: "superseded", version: plan\.version \+ 1, cause, requestHash \}/);
  assert.match(persistence, /preparePosPaymentPlanGraphWrite\(tx, \{[\s\S]*action: "expire"[\s\S]*actorUserId: "system:pos-payment-maintenance"[\s\S]*posPaymentPlanOperation\.create/);
  assert.match(persistence, /SAVEPOINT pos_payment_plan_expire_candidate[\s\S]*ROLLBACK TO SAVEPOINT[\s\S]*blockedExpiredPaymentPlans \+= 1/);
});

test("writers do plano bloqueiam itens antes do plano e ativação bloqueia conectores antes da transição", () => {
  assert.match(planService, /async function lockPaymentDraftItems[\s\S]*pos_held_sale_items[\s\S]*ORDER BY "id"[\s\S]*FOR UPDATE/);
  assert.match(planService, /action: "quote"[\s\S]*const requestHash = await preparePosPaymentPlanGraphWrite\(tx, graphWrite\);[\s\S]*posPaymentPlan\.create/);
  assert.match(planService, /normalizedQuoteLines\.map\(\(line, lineIndex\) => jsonObject\(\{ planId: id, lineIndex, \.\.\.line \}\)\)/);
  assert.match(planService, /action: "activate"[\s\S]*const preparedRequestHash = await preparePosPaymentPlanGraphWrite\(tx, graphWrite\);[\s\S]*assertSlotConnectors[\s\S]*posPaymentPlanSlot\.createMany/);
  assert.match(planService, /input\.slots\.map\(slot => jsonObject\(\{ planId: input\.planId, \.\.\.slot \}\)\)/);
  assert.match(planService, /await lockPlanContext\(tx, locator\.saleDraftId\);\s*await lockPaymentDraftItems\(tx, locator\.saleDraftId\);[\s\S]*SELECT "id" FROM "pos_payment_plans"/);
  assert.match(planService, /const intentConnectorIds = \[\.\.\.new Set\([\s\S]*\)\]\s*\.sort\(\)/);
  assert.match(planService, /const credentialIds = \[\.\.\.new Set\(connectors\.flatMap[\s\S]*\)\]\s*\.sort\(\)/);
});

test("recotação falha fechada e maintenance delega locks e evidência à capability", () => {
  assert.match(planService, /const openPlans = await tx\.posPaymentPlan\.findMany\([\s\S]*orderBy: \[\{ createdAt: "asc" \}, \{ id: "asc" \}\]/);
  assert.match(planService, /if \(replay\) \{[\s\S]*databasePaymentDraftSnapshotHash[\s\S]*replay\.requestHash !== replayRequestHash[\s\S]*return \{ plan: replay, replayed: true \}/);
  assert.match(planService, /if \(openPlans\.length\) throw new PosPaymentPlanError\("Já existe um plano aberto/);
  const quoteWriter = planService.slice(planService.indexOf("export async function persistQuotedPosPaymentPlan"), planService.indexOf("function normalizeQuoteLines"));
  assert.doesNotMatch(quoteWriter, /supersedePlan\(/);
  assert.match(persistence, /const releaseLocator = await tx\.posPaymentPlan\.findUnique[\s\S]*preparePosPaymentPlanGraphWrite/);
  assert.doesNotMatch(persistence, /lockPosPaymentPlanCanonical/);
  assert.match(persistence, /action: "expire"[\s\S]*actorUserId: "system:pos-payment-maintenance"/);
});

test("cotação mantém o chamador read-only até a capability ordenar advisories e roots", () => {
  const quoteRoute = route.slice(route.indexOf("async function quotePromotion"), route.indexOf("function requestedSaleLines"));
  const capabilityCall = quoteRoute.indexOf("persistQuotedPosPaymentPlan(tx");
  assert.ok(capabilityCall > 0);
  assert.doesNotMatch(quoteRoute.slice(0, capabilityCall), /FOR (?:UPDATE|SHARE)/);
  assert.match(planService, /const requestHash = await preparePosPaymentPlanGraphWrite\(tx, graphWrite\);[\s\S]*posPaymentPlan\.create/);
});

test("consume abre o graph para o ID reservado e persiste o mesmo hash SQL", () => {
  assert.match(planService, /export async function preparePosPaymentPlanConsumption[\s\S]*action: "consume"[\s\S]*consumedSaleId: input\.saleId/);
  assert.match(planService, /preparedRequestHash \?\? await preparePosPaymentPlanConsumption/);
  assert.match(planService, /posPaymentPlanOperation\.create\([\s\S]*requestHash[\s\S]*posPaymentPlan\.updateMany/);
  const commitReader = planService.slice(planService.indexOf("export async function exactPosPaymentPlanForCommit"), planService.indexOf("export async function preparePosPaymentPlanConsumption"));
  assert.match(commitReader, /databasePaymentDraftSnapshotHash\(tx, plan\.saleDraftId\)[\s\S]*draftRequestHash !== plan\.draftRequestHash/);
  assert.doesNotMatch(commitReader, /assertDraftMatchesPlan/);
  assert.doesNotMatch(planService, /data: \{ state: "consumed"[\s\S]{0,120}consumedAt: new Date/);
});
