import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const persistence = readFileSync(`${root}/lib/erp/pos-payment-compensation-persistence.ts`, "utf8");
const http = readFileSync(`${root}/lib/erp/pos-payment-compensation-http.ts`, "utf8");
const outboxRoute = readFileSync(`${root}/app/api/internal/pdv/payment-compensations/outbox/[organizationId]/route.ts`, "utf8");
const callbackRoute = readFileSync(`${root}/app/api/webhooks/pos-payment-compensations/[organizationId]/[provider]/route.ts`, "utf8");

test("worker compensatório usa lease, SKIP LOCKED, completion idempotente e query após incerteza", () => {
  assert.match(persistence, /FOR UPDATE OF c SKIP LOCKED/);
  assert.match(persistence, /claimExpiresAt/);
  assert.match(persistence, /claimTokenHash/);
  assert.match(persistence, /posPaymentCompensationDeliveryResult\.findUnique/);
  assert.match(persistence, /state: "unknown", outcomeUnknown: true/);
  assert.match(persistence, /ensureQueryAttempt/);
  assert.match(persistence, /operation: "query"/);
  assert.match(outboxRoute, /assertPosPaymentJobAuthorization/);
  assert.doesNotMatch(outboxRoute, /fetch\s*\(/, "a rota boundary não pode fingir um adapter/provider");
});

test("T1 não cria refund; T2 cria um refund vinculado e atualiza o original na mesma transação", () => {
  const t1 = functionSlice("completePosPaymentCompensationOutbox", "applyPosPaymentCompensation");
  const t2 = functionSlice("applyPosPaymentCompensation", "maintainPosPaymentCompensations");
  assert.doesNotMatch(t1, /posSalePayment\.create/);
  assert.match(t1, /status: "application_pending"/);
  assert.match(t1, /providerResultPersistedAt/);
  assert.match(t2, /prelockPosSalePaymentWriteGraph/);
  assert.match(t2, /existingPaymentIds: \[locator\.originalPaymentId\]/);
  assert.match(t2, /posSalePayment\.create/);
  assert.match(t2, /type: "refund"/);
  assert.match(t2, /compensationId: compensation\.id/);
  assert.match(t2, /posSalePayment\.update/);
  assert.match(t2, /refundedAt: originalStatus === "refunded" \? now : null/);
  assert.match(t2, /status: "applied", applicationState: "applied"/);
});

test("callback compensatório é HMAC sobre corpo bruto, anti-replay e idempotente no banco", () => {
  assert.match(http, /createHmac\("sha256"/);
  assert.match(http, /pos-compensation\.v1\.\$\{timestamp\}\.\$\{eventId\}\.\$\{raw\}/);
  assert.match(http, /MAX_AGE_SECONDS/);
  assert.match(http, /timingSafeEqual/);
  assert.match(http, /containsPosPaymentPanInIdentifier/);
  assert.match(callbackRoute, /payment_compensation_callback_secret/);
  assert.doesNotMatch(callbackRoute, /secrets\.payment_callback_secret|secrets\.webhook_secret/);
  assert.match(callbackRoute, /payment_callback_grace_until/);
  assert.match(persistence, /provider_eventId/);
  assert.match(persistence, /payloadHash !== payloadHash/);
});

test("callback registra fromState anterior e incidentes bloqueiam T2", () => {
  assert.match(persistence, /const beforeStatus = compensation\.status/);
  assert.match(persistence, /beforeStatus, compensation\.status/);
  assert.match(persistence, /productionBlocking: true/);
  assert.match(persistence, /blockingIncident/);
  assert.match(persistence, /applicationState: compensation\.providerState === "succeeded" \? "blocked"/);
});

function functionSlice(start: string, end: string) {
  const first = persistence.indexOf(`export async function ${start}`);
  const last = persistence.indexOf(`export async function ${end}`, first + 1);
  assert.notEqual(first, -1, `${start} ausente`);
  assert.notEqual(last, -1, `${end} ausente`);
  return persistence.slice(first, last);
}
