import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  AI_FEATURE_CATALOG,
  aiUsageCsv,
  normalizeAiPolicy,
  parseAiUsageQuery,
  publicAiError,
} from "../lib/erp/ai-control-center";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");

test("consulta de uso limita período, paginação, filtros e exportação", () => {
  const query = parseAiUsageQuery(
    new URLSearchParams({
      days: "365",
      page: "9999",
      limit: "999",
      status: "inventado",
      keySource: "secret",
      search: "x".repeat(500),
      format: "csv",
    }),
  );
  assert.equal(query.days, 30);
  assert.equal(query.page, 400);
  assert.equal(query.limit, 100);
  assert.equal(query.status, "");
  assert.equal(query.keySource, "");
  assert.equal(query.search.length, 120);
  assert.equal(query.csv, true);
});

test("política exige modelo permitido e normaliza limites por recurso", () => {
  const fallback = {
    enabled: false,
    routing_mode: "platform",
    default_model: "gpt-5-mini",
    allowed_models: ["gpt-5-mini"],
    redact_pii: true,
    max_tokens: 1000,
    reasoning_effort: "medium",
    monthly_budget: 0,
    monthly_request_limit: 0,
    alert_threshold_pct: 80,
    per_feature_limits: {},
    consumers: {},
  };
  const policy = normalizeAiPolicy(
    {
      ...fallback,
      consumers: { "ai.playground": false },
      per_feature_limits: { "ai.playground": 25 },
    },
    fallback,
  );
  assert.equal(policy.log_prompts, false);
  assert.equal(policy.consumers["ai.playground"], false);
  assert.equal(policy.per_feature_limits["ai.playground"], 25);
  assert.equal(Object.keys(policy.consumers).length, AI_FEATURE_CATALOG.length);
  assert.throws(
    () =>
      normalizeAiPolicy(
        { ...fallback, default_model: "gpt-5", allowed_models: ["gpt-5-mini"] },
        fallback,
      ),
    /modelo padrão/i,
  );
});

test("exportação CSV neutraliza fórmulas e não possui prompt ou segredo", () => {
  const csv = aiUsageCsv([
    {
      id: "=cmd|' /C calc'!A0",
      feature: "ai.playground",
      model: "gpt-5-mini",
      status: "completed",
      keySource: "byok",
      units: 1,
      inputTokens: 100,
      outputTokens: 20,
      latencyMs: 800,
      cost: 0.01,
      createdAt: "2026-09-04T00:00:00Z",
    },
  ]);
  assert.match(csv, /"'=cmd/);
  assert.doesNotMatch(csv, /prompt|api.?key|secret/i);
});

test("erros do provedor são convertidos em mensagens públicas", () => {
  assert.match(publicAiError(401), /credencial/i);
  assert.match(publicAiError(404), /modelo/i);
  assert.match(publicAiError(429), /limitou/i);
  assert.doesNotMatch(publicAiError(500), /HTTP|stack|Bearer/i);
});

test("API oferece BI, prontidão, filtros, CSV e ações protegidas", () => {
  const route = read("app/api/erp/ai/usage/route.ts");
  for (const contract of [
    "parseAiUsageQuery",
    "aiUsageCsv",
    "dailySeries",
    "credential.default",
    "credential.revoke",
    "playground",
    "monthly_request_limit",
    "private, no-store",
  ])
    assert.match(route, new RegExp(contract.replace(".", "\\.")));
  assert.match(route, /ai-integrations\.read/);
  assert.match(route, /ai-integrations\.write/);
  assert.match(route, /secretsCipherText: true/);
  assert.match(route, /apiKeyConfigured: Boolean\(item\.secretsCipherText\)/);
  assert.doesNotMatch(route, /secretsCipherText: item\.secretsCipherText/);
});

test("execução usa Responses API sem retenção e reserva orçamento atomicamente", () => {
  const source = read("lib/integrations/openai.ts");
  assert.match(source, /api\.openai\.com\/v1\/responses/);
  assert.match(source, /store: false/);
  assert.match(source, /safety_identifier/);
  assert.match(source, /prompt_cache_key/);
  assert.match(source, /reasoning: \{ effort:/);
  assert.match(source, /pg_advisory_xact_lock/);
  assert.match(source, /status: "in_progress"/);
  assert.match(source, /monthly_request_limit/);
  assert.match(source, /publicAiError\(response\.status\)/);
  assert.doesNotMatch(source, /body\.error\?\.message \|\|/);
});

test("permissões dedicadas alcançam configuração, chave e teste OpenAI", () => {
  const route = read("app/api/erp/integrations/[...path]/route.ts");
  assert.match(route, /function routePermission/);
  assert.match(route, /path\[1\] === "openai"/);
  assert.match(route, /path\[1\] === "ai"/);
  assert.match(route, /"ai-integrations\.write"/);
  assert.match(route, /normalizeAiPolicy/);
  assert.match(route, /return await settingsSave\(ctx, path\[1\], body\)/);
  assert.match(route, /return await healthOne\(/);
});

test("interface cobre governança, recursos, chaves, uso e laboratório responsivo", () => {
  const component = read("components/erp/ai-integration-center.tsx");
  const css = read("components/erp/ai-integration-center.module.css");
  for (const label of [
    "Visão geral",
    "Política e limites",
    "Recursos",
    "Chaves OpenAI",
    "Uso e auditoria",
    "Laboratório",
    "Exportar CSV",
    "Checklist de governança",
  ])
    assert.match(component, new RegExp(label));
  assert.match(component, /<ErpModal/);
  assert.doesNotMatch(component, /window\.confirm/);
  assert.match(css, /\.mobileCards/);
  assert.match(css, /min-height: 44px/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /font-size: 14px/);
});

test("seed oferece telemetria demo ampla sem ativar chave fictícia", () => {
  const seed = read("scripts/seed-demo-integrations.ts");
  assert.match(seed, /for \(let index = 0; index < 72; index\+\+\)/);
  assert.match(seed, /demo-ai-usage-/);
  assert.match(seed, /demo-int-openai/);
  assert.match(seed, /providerId: "openai"/);
  assert.match(seed, /enabled: false/);
});

test("migração adiciona índices de BI e integridade de custo/status", () => {
  const migration = read(
    "prisma/tenant/migrations/20260904130000_ai_control_center_observability/migration.sql",
  );
  assert.match(migration, /created_at_status_idx/);
  assert.match(migration, /created_at_model_idx/);
  assert.match(migration, /created_at_key_source_idx/);
  assert.match(migration, /units_cost_check/);
  assert.match(migration, /status_check/);
});
