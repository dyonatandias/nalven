import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { activeCredentialFilter } from "../lib/integrations/core";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");

test("credenciais ativas excluem registros revogados e vencidos", () => {
  const now = new Date("2026-09-04T12:00:00.000Z");
  assert.deepEqual(activeCredentialFilter(now), {
    enabled: true,
    revokedAt: null,
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
  });
});

test("central separa leitura de diagnóstico e mantém GET sem efeitos externos", () => {
  const route = read("app/api/erp/integrations/[...path]/route.ts");
  assert.match(route, /permission === "integrations\.write"\) await ensureIntegrationSeed/);
  assert.match(route, /path\[0\] === "health" && path\[1\] === "all"\)\s*return await healthLast\(db\)/);
  assert.match(route, /path\[0\] === "health" && path\[1\] === "all"\)\s*return await healthAll\(ctx\.db, "manual", true\)/);
  assert.match(route, /async function overview\(/);
  assert.match(route, /async function queueBatch\(/);
  assert.match(route, /"batch_retry"/);
  assert.match(route, /processing_p95_ms/);
  assert.match(route, /provider_p95_ms/);
});

test("ciclo de vida e concorrência das configurações são persistidos", () => {
  const schema = read("prisma/tenant/schema.prisma"),
    migration = read("prisma/tenant/migrations/20260904093000_integration_operations_center/migration.sql"),
    route = read("app/api/erp/integrations/[...path]/route.ts");
  for (const field of ["ownerLabel", "expiresAt", "lastRotatedAt", "revokedAt", "createdBy", "updatedBy"])
    assert.match(schema, new RegExp(`${field}\\s+`));
  assert.match(migration, /integration_credentials_revoked_at_expires_at_idx/);
  assert.match(route, /revision: \{ increment: 1 \}/);
  assert.match(route, /A credencial mudou em outra sessão/);
  assert.match(route, /As configurações mudaram em outra sessão/);
  assert.doesNotMatch(route, /integrationCredential\.delete\(/);
});

test("interface oferece prontidão, inventário, operações em lote e confirmações acessíveis", () => {
  const component = read("components/erp/integration-center.tsx"),
    styles = read("components/erp/integration-center.module.css");
  for (const label of ["Visão geral", "Conexões", "Roteamento", "Webhooks", "Operações", "Governança"])
    assert.match(component, new RegExp(label));
  assert.match(component, /Promise\.allSettled/);
  assert.match(component, /Checklist de produção/);
  assert.match(component, /Inventário de conexões/);
  assert.match(component, /queue\/batch/);
  assert.match(component, /<ErpModal/);
  assert.doesNotMatch(component, /window\.confirm/);
  assert.match(styles, /@media \(max-width: 700px\)/);
  assert.match(styles, /prefers-reduced-motion/);
  assert.match(styles, /font-size: 14px/);
});

test("webhooks limitam JSON e redigem entregas antes de responder", () => {
  const http = read("lib/integrations/http.ts"),
    webhook = read("lib/integrations/webhooks.ts"),
    route = read("app/api/erp/webhooks/route.ts");
  assert.match(http, /MAX_JSON_BYTES = 256 \* 1024/);
  assert.match(http, /private, no-store/);
  assert.match(webhook, /serializeDelivery/);
  assert.match(route, /readIntegrationJson\(request\)/);
  assert.match(route, /map\(serializeDelivery\)/);
});

test("seed demonstrativo cobre saúde, fila, callbacks e webhooks sem ativar conectores fictícios", () => {
  const seed = read("scripts/seed-demo-integrations.ts");
  assert.match(seed, /for \(let index = 0; index < 32; index\+\+\)/);
  assert.match(seed, /integrationHealthState\.upsert/);
  assert.match(seed, /integrationInboundEvent\.upsert/);
  assert.match(seed, /integrationWebhookDelivery\.upsert/);
  assert.match(seed, /enabled: false/);
  assert.doesNotMatch(seed, /enabled: true/);
});
