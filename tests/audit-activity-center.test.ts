import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { auditChanges, auditCsv, auditFilterSnapshot, AuditInputError, eventKey, investigationCreateInput, investigationStatusInput, parseAuditQuery, redactAuditPayload, savedViewInput } from "../lib/erp/audit-center";

const file = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("consulta normaliza filtros, datas, limites e ordenação", () => {
  const parsed = parseAuditQuery(new URLSearchParams("page=2&limit=100&severity=critical&category=finance&source=pos&onlyChanges=true&from=2026-08-01&to=2026-08-31&sort=oldest"));
  assert.equal(parsed.page, 2); assert.equal(parsed.limit, 100); assert.equal(parsed.severity, "critical"); assert.equal(parsed.category, "finance"); assert.equal(parsed.source, "pos"); assert.equal(parsed.onlyChanges, true); assert.equal(parsed.sort, "oldest"); assert.equal(parsed.to?.toISOString(), "2026-08-31T23:59:59.999Z");
  assert.throws(() => parseAuditQuery(new URLSearchParams("from=2026-09-01&to=2026-08-01")), AuditInputError);
  assert.throws(() => parseAuditQuery(new URLSearchParams("page=201")), AuditInputError);
});

test("payloads sensíveis são minimizados sem destruir a leitura da alteração", () => {
  const protectedValue = redactAuditPayload({ password: "123", accessToken: "abc", email: "cliente@example.com", document: "11444777000161", phone: "49999990000", safe: "visível" }) as Record<string, unknown>;
  assert.equal(protectedValue.password, "[conteúdo protegido]"); assert.equal(protectedValue.accessToken, "[conteúdo protegido]"); assert.equal(protectedValue.email, "cl***@example.com"); assert.equal(protectedValue.document, "********0161"); assert.equal(protectedValue.phone, "(**) *****-0000"); assert.equal(protectedValue.safe, "visível");
  const changes = auditChanges({ profile: { b: 2, a: 1 }, unchanged: true }, { profile: { a: 1, b: 2 }, unchanged: true, status: "active" });
  assert.deepEqual(changes.map((item) => item.key), ["status"]);
});

test("exportação neutraliza fórmulas e inclui metadados de integridade", () => {
  const csv = auditCsv([{ id: "erp:1", createdAt: "2026-09-03", actor: { name: "=CMD()", email: "demo@example.com" }, action: "customer.updated", entityType: "customer", entityId: "1", correlationId: "corr", severity: "warning", category: "commercial", source: "erp", fingerprint: "a".repeat(64), changedFields: ["email"] }]);
  assert.ok(csv.startsWith("\uFEFF")); assert.match(csv, /Fingerprint/); assert.match(csv, /"'=CMD\(\)"/); assert.match(csv, /customer\.updated/);
});

test("investigações, chaves e visões exigem entradas limitadas", () => {
  assert.deepEqual(eventKey("erp:123"), { key: "erp:123", source: "erp", id: "123" });
  assert.throws(() => eventKey("foreign:1"), AuditInputError);
  const created = investigationCreateInput({ title: "Falha fiscal", severity: "high", eventKeys: ["erp:1", "erp:1", "integration:abc"] });
  assert.deepEqual(created.eventKeys, ["erp:1", "integration:abc"]); assert.equal(created.severity, "high");
  assert.throws(() => investigationStatusInput({ investigationId: "audit-case-1", expectedVersion: 1, status: "resolved", resolution: "não" }), /conclusão/);
  const saved = savedViewInput({ name: "Críticos", visibility: "shared", filters: { severity: "critical", onlyChanges: true } }); assert.equal(saved.filters.severity, "critical"); assert.equal(saved.visibility, "shared");
  assert.deepEqual(auditFilterSnapshot({ category: "finance", source: "pos" }).category, "finance");
});

test("persistência classifica, assina e protege a trilha no banco", async () => {
  const [schema, migration, hardening, grants] = await Promise.all([file("prisma/tenant/schema.prisma"), file("prisma/tenant/migrations/20260903210000_audit_governance_center/migration.sql"), file("prisma/tenant/migrations/20260903211000_audit_crypto_ownership_hardening/migration.sql"), file("deploy/reconcile-tenant-runtime-grants.sql")]);
  for (const token of ["fingerprint", "schemaVersion", "AuditInvestigation", "AuditInvestigationEvent", "AuditInvestigationNote", "AuditSavedView", "AuditExportEvent", "correlationId"]) assert.match(schema, new RegExp(token));
  for (const token of ["pgcrypto", "nalven_audit_fingerprint", "nalven_audit_severity", "nalven_audit_category", "audit_events_immutable_guard", "integration_audit_log_immutable_guard", "append-only and immutable", "audit_investigations_resolution_check"]) assert.match(migration, new RegExp(token));
  for (const token of ["DROP EXTENSION", "pg_catalog.sha256", "SECURITY DEFINER", "SET search_path = pg_catalog", "REVOKE ALL ON FUNCTION"]) assert.match(hardening, new RegExp(token));
  assert.match(grants, /'audit_events'/); assert.match(grants, /'integration_audit_log'/);
});

test("API protege leitura, mutações, exportação e concorrência", async () => {
  const route = await file("app/api/erp/activities/route.ts"), get = route.slice(route.indexOf("export async function GET"), route.indexOf("export async function POST"));
  for (const token of ["activities.read", "activities.write", "assertSameOrigin", "CustomerInputError", "assertPosMutationRequest", "readPosJson", "enforcePosRateLimit", "assertTenantWriteAccess", "Serializable", "expectedVersion", "export.record", "requestedBy: access.user.id", "private, no-store", "redactAuditPayload", "integrityData"]) assert.match(route, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(get, /auditInvestigation\.create|auditSavedView\.create|auditExportEvent\.create/);
  assert.doesNotMatch(route, /error instanceof Error\s*\?\s*error\.message/);
});

test("interface oferece governança completa, menu de ações e mobile legível", async () => {
  const [ui, css, shell, seed, pkg] = await Promise.all([file("components/erp/audit-activity-center.tsx"), file("components/erp/audit-activity-center.module.css"), file("app/erp/erp-client.tsx"), file("scripts/seed-demo-audit.ts"), file("package.json")]);
  for (const token of ["Atividades e auditoria", "Visão geral", "Eventos", "Investigações", "Busca inteligente", "Somente com antes/depois", "CSV", "JSONL", "Ver evidência completa", "Adicionar à investigação", "Antes e depois", "Evidência técnica", "Correlação", "Salvar filtros atuais", "Ao vivo"]) assert.ok(ui.includes(token), token);
  assert.match(ui, /role="tablist"/); assert.match(ui, /aria-selected/); assert.match(ui, /aria-label/); assert.match(css, /@media\(max-width:700px\)/); assert.doesNotMatch(css, /font-size:[0-9](?:\.|)px/);
  assert.match(shell, /<AuditActivityCenter \/>/); assert.match(seed, /NALVEN_ALLOW_DEMO_AUDIT_SEED/); assert.match(seed, /nalven_t_demo_runtime/); assert.match(pkg, /test:audit/); assert.match(pkg, /db:seed:demo-audit/);
});
