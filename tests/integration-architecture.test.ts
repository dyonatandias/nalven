import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { PROVIDERS } from "../lib/integrations/catalog";
import { TRANSACTIONAL_EMAIL_CATALOG } from "../lib/integrations/transactional-email-catalog";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");

test("catálogo separa pagamentos, SMTP e OpenAI sem providers internos de WhatsApp", () => {
  const ids = new Set(PROVIDERS.map((item) => item.id));
  for (const provider of [
    "smtp",
    "openai",
    "mercado_pago",
    "banco_inter",
    "cielo",
    "stone",
    "pagbank",
  ])
    assert.equal(ids.has(provider), true, provider);
  for (const removed of [
    "whatsapp_api",
    "whatsapp_official",
    "evolution_api",
    "twilio_whatsapp",
  ])
    assert.equal(ids.has(removed), false, removed);
  assert.equal(
    PROVIDERS.find((item) => item.id === "openai")?.capabilities.responsesApi,
    true,
  );
  assert.equal(
    PROVIDERS.filter((item) => item.family === "payment").every((item) =>
      item.fields.some((field) => field.secret),
    ),
    true,
  );
});

test("central transacional possui catálogo amplo, único e versionado", () => {
  assert.ok(TRANSACTIONAL_EMAIL_CATALOG.length >= 50);
  assert.equal(
    new Set(TRANSACTIONAL_EMAIL_CATALOG.map((item) => item.eventKey)).size,
    TRANSACTIONAL_EMAIL_CATALOG.length,
  );
  for (const event of [
    "auth.otp",
    "auth.password_reset",
    "payment.approved",
    "fiscal.nfe_authorized",
    "shipment.delivered",
    "privacy.request_completed",
  ])
    assert.ok(
      TRANSACTIONAL_EMAIL_CATALOG.some((item) => item.eventKey === event),
      event,
    );
  const schema = read("prisma/tenant/schema.prisma"),
    route = read("app/api/erp/transactional-email/route.ts"),
    queue = read("lib/integrations/transactional-email.ts"),
    worker = read("scripts/process-integrations.ts");
  for (const model of [
    "TransactionalEmailDefinition",
    "TransactionalEmailVersion",
    "TransactionalEmailDelivery",
  ])
    assert.match(schema, new RegExp(`model ${model}\\b`));
  assert.match(route, /status: "archived"/);
  assert.match(route, /providerId: "smtp"/);
  assert.match(schema, /recipientCipher\s+String/);
  assert.match(schema, /variablesCipher\s+String/);
  assert.match(queue, /export async function enqueueTransactionalEmail/);
  assert.match(queue, /contactHash\(recipient\)/);
  assert.match(queue, /encryptSecrets\(\{ recipient \}\)/);
  assert.match(queue, /status: "processing"/);
  assert.match(worker, /processTransactionalEmailQueue/);
});

test("OpenAI usa Responses API no servidor com retenção desligada, orçamento e observabilidade", () => {
  const source = read("lib/integrations/openai.ts"),
    schema = read("prisma/tenant/schema.prisma");
  assert.match(source, /https:\/\/api\.openai\.com\/v1\/responses/);
  assert.match(source, /store: false/);
  assert.match(source, /safety_identifier/);
  assert.match(source, /monthly_budget/);
  assert.match(source, /redactInput/);
  for (const field of [
    "inputTokens",
    "outputTokens",
    "latencyMs",
    "keySource",
    "status",
  ])
    assert.match(schema, new RegExp(`${field}\\s+`));
});

test("PDV persiste artefatos cifrados e só expõe QR ou link ao operador autenticado", () => {
  const schema = read("prisma/tenant/schema.prisma"),
    persistence = read("lib/erp/pos-payment-persistence.ts"),
    route = read("app/api/erp/pdv/payment-intents/route.ts"),
    component = read("components/erp/pdv-payment-intent-control.tsx");
  assert.match(schema, /model PosPaymentArtifact\b/);
  assert.match(persistence, /encryptSecret\(artifact\.value\)/);
  assert.match(route, /decryptSecret\(\s*item\.valueCipher\s*\)/);
  assert.match(component, /pix_copy_paste/);
  assert.match(component, /pix_qr_url/);
  assert.match(component, /payment_link/);
});
