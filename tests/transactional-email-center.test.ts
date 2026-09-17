import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  analyzeTransactionalTemplate,
  isPermanentDeliveryError,
  parseTransactionalEmailQuery,
  publicDeliveryError,
  renderTransactionalTemplate,
  transactionalDeliveryCsv,
} from "../lib/erp/transactional-email-center";
import { TRANSACTIONAL_EMAIL_CATALOG } from "../lib/integrations/transactional-email-catalog";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");

test("consulta limita período, página e volume exportável", () => {
  const parsed = parseTransactionalEmailQuery(
    new URLSearchParams({
      days: "999",
      status: "unknown",
      page: "9999",
      limit: "9999",
      search: " x ".repeat(100),
      format: "csv",
    }),
  );
  assert.equal(parsed.days, 30);
  assert.equal(parsed.status, "");
  assert.equal(parsed.page, 400);
  assert.equal(parsed.limit, 100);
  assert.equal(parsed.search.length, 120);
  assert.equal(parsed.csv, true);
});

test("validador rejeita HTML executável, variáveis desconhecidas e injeção em assunto", () => {
  const issues = analyzeTransactionalTemplate({
    subject: "Aviso\r\nBcc: atacante@example.com",
    htmlBody:
      '<script>alert(1)</script><a href="javascript:alert(1)">{{unknown.value}}</a>',
    textBody: "Sem link",
    allowedVariables: ["organization.name", "action.url"],
  });
  const codes = new Set(issues.map((item) => item.code));
  assert.equal(codes.has("subject.control"), true);
  assert.equal(codes.has("html.executable"), true);
  assert.equal(codes.has("variable.unknown.unknown.value"), true);
  assert.equal(codes.has("action.missing"), true);
  assert.equal(codes.has("text.action.missing"), true);
});

test("renderização HTML escapa valores variáveis sem alterar estrutura do template", () => {
  assert.equal(
    renderTransactionalTemplate(
      "<strong>{{recipient.name}}</strong>",
      { "recipient.name": '<img src=x onerror="alert(1)">' },
      true,
    ),
    "<strong>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</strong>",
  );
});

test("exportação CSV neutraliza fórmulas e usa apenas diagnóstico público", () => {
  const csv = transactionalDeliveryCsv([
    {
      eventId: "=cmd|' /C calc'!A0",
      eventKey: "payment.approved",
      recipientMasked: "jo***com",
      status: "failed",
      attempts: 2,
      version: 1,
      createdAt: "2026-09-04T00:00:00.000Z",
      sentAt: null,
      error: publicDeliveryError("socket ECONNREFUSED 10.0.0.1"),
    },
  ]);
  assert.match(csv, /"'=cmd/);
  assert.doesNotMatch(csv, /ECONNREFUSED|10\.0\.0\.1/);
  assert.match(csv, /transporte SMTP/);
});

test("falhas permanentes não podem ser reenfileiradas", () => {
  assert.equal(isPermanentDeliveryError("Envio bloqueado por opt-out."), true);
  assert.equal(isPermanentDeliveryError("Destinatário protegido inválido."), true);
  assert.equal(isPermanentDeliveryError("timeout SMTP"), false);
});

test("API expõe DTO mínimo, filtros, BI, retry e teste explícito de versão", () => {
  const route = read("app/api/erp/transactional-email/route.ts");
  assert.match(route, /parseTransactionalEmailQuery/);
  assert.match(route, /transactionalDeliveryCsv/);
  assert.match(route, /action === "retry-all"/);
  for (const action of [
    "saveVersion",
    "publishVersion",
    "archiveVersion",
    "testVersion",
    "retryDelivery",
    "retryAll",
  ])
    assert.match(route, new RegExp(`return await ${action}\\(`));
  assert.match(route, /requestedVersionId/);
  assert.match(route, /recipientMasked: row\.recipientMasked/);
  assert.doesNotMatch(route, /\.\.\.row/);
  assert.doesNotMatch(route, /recipientCipher: row\./);
  assert.doesNotMatch(route, /variablesCipher: row\./);
  assert.match(route, /private, no-store/);
});

test("migration repara instalações antigas sem inventar destinatários", () => {
  const migration = read(
    "prisma/tenant/migrations/20260904103000_transactional_email_cipher_drift_repair/migration.sql",
  );
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "recipient_cipher" TEXT/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "variables_cipher" TEXT/);
  assert.match(migration, /legacy\.unavailable/);
  assert.match(migration, /ALTER COLUMN "recipient_cipher" SET NOT NULL/);
});

test("fila troca automaticamente credencial revogada por uma conta válida", () => {
  const queue = read("lib/integrations/transactional-email.ts");
  assert.match(queue, /if \(!credential\)/);
  assert.match(queue, /activeCredentialFilter\(\)/);
  assert.match(queue, /orderBy: \[\{ isDefault: "desc" \}/);
  assert.match(queue, /Object\.hasOwn\(variables, "organization\.name"\)/);
  assert.match(queue, /actionUrl\.protocol !== "https:"/);
});

test("catálogo oferece variáveis específicas por domínio", () => {
  const order = TRANSACTIONAL_EMAIL_CATALOG.find(
    (item) => item.eventKey === "order.confirmed",
  );
  const fiscal = TRANSACTIONAL_EMAIL_CATALOG.find(
    (item) => item.eventKey === "fiscal.nfe_authorized",
  );
  assert.equal(order?.variables.includes("order.number"), true);
  assert.equal(order?.variables.includes("order.total"), true);
  assert.equal(fiscal?.variables.includes("fiscal.access_key"), true);
});

test("interface possui áreas completas, prévia isolada e cartões móveis", () => {
  const component = read("components/erp/transactional-email-center.tsx");
  const css = read("components/erp/transactional-email-center.module.css");
  for (const label of [
    "Visão geral",
    "Catálogo",
    "Entregas",
    "Contas SMTP",
    "Exportar CSV",
    "Histórico de versões",
  ])
    assert.match(component, new RegExp(label));
  assert.match(component, /sandbox=""/);
  assert.match(component, /recipientMasked/);
  assert.match(css, /\.mobileCards/);
  assert.match(css, /min-height: 44px/);
  assert.match(css, /prefers-reduced-motion/);
});

test("seed publica defaults sem sobrescrever versões e libera leitura operacional", () => {
  const seed = read("prisma/tenant/seed.ts");
  const bundle = read("deploy/install-tenant-migration-bundle.sh");
  assert.match(seed, /TRANSACTIONAL_EMAIL_CATALOG/);
  assert.match(seed, /if \(!hasVersion\)/);
  assert.match(seed, /status: "published"/);
  assert.match(seed, /"transactional-email\.read"/);
  assert.match(
    bundle,
    /lib\/integrations\/transactional-email-catalog\.ts/,
  );
});
