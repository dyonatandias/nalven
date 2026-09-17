import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { decryptSecret } from "../lib/secrets";
import {
  addBusinessDays,
  allowedIncidentTransition,
  allowedRequestTransition,
  impactAssessmentInput,
  incidentCreateInput,
  incidentTransitionInput,
  legalBasisInput,
  parsePrivacyQuery,
  privacyCsv,
  PrivacyGovernanceError,
  privacyRequestCreateInput,
  privacyRequestTransitionInput,
  privacySettingsInput,
  protectPrivacySubject,
  treatmentInput,
} from "../lib/erp/privacy-governance";

const file = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("consulta limita paginação, busca, filtros e formato de exportação", () => {
  const parsed = parsePrivacyQuery(new URLSearchParams("page=2&limit=100&search=LGPD-2026&status=in_progress&type=access&priority=urgent&sort=oldest&format=csv"));
  assert.deepEqual(parsed, { page: 2, limit: 100, search: "LGPD-2026", status: "in_progress", type: "access", priority: "urgent", sort: "oldest", format: "csv" });
  assert.throws(() => parsePrivacyQuery(new URLSearchParams("page=201")), PrivacyGovernanceError);
  assert.throws(() => parsePrivacyQuery(new URLSearchParams(`search=${"x".repeat(121)}`)), PrivacyGovernanceError);
});

test("solicitações validam titular, identidade, decisão e transições", () => {
  const created = privacyRequestCreateInput({ type: "access", subjectName: "Ana Martins", subjectDocument: "529.982.247-25", contact: "ana@example.com", channel: "email" });
  assert.equal(created.document, "52998224725"); assert.equal(created.contactType, "email"); assert.equal(created.requesterRelation, "self");
  assert.throws(() => privacyRequestCreateInput({ type: "access", subjectName: "Ana", subjectDocument: "111.111.111-11", contact: "ana@example.com" }), /CPF ou CNPJ/);
  assert.throws(() => privacyRequestTransitionInput({ requestId: 1, expectedVersion: 1, status: "verified" }), /método/);
  assert.throws(() => privacyRequestTransitionInput({ requestId: 1, expectedVersion: 1, status: "completed", evidence: "arquivo-1" }), /resumo/);
  assert.equal(allowedRequestTransition("received", "identity_pending"), true); assert.equal(allowedRequestTransition("completed", "in_progress"), false);
});

test("dados de identificação recebem criptografia autenticada, token estável e máscara", () => {
  const previous = process.env.NALVEN_SECRETS_MASTER_KEY;
  process.env.NALVEN_SECRETS_MASTER_KEY = "privacy-test-master-key-with-sufficient-entropy";
  try {
    const first = protectPrivacySubject("52998224725", "ana@example.com"), second = protectPrivacySubject("52998224725", "ana@example.com");
    assert.notEqual(first.subjectDocument, "52998224725"); assert.notEqual(first.contact, "ana@example.com");
    assert.notEqual(first.subjectDocument, second.subjectDocument); assert.equal(first.subjectDocumentHash, second.subjectDocumentHash);
    assert.equal(first.subjectDocumentLast4, "4725"); assert.equal(first.contactPreview, "an***@example.com");
    assert.equal(decryptSecret(first.subjectDocument), "52998224725"); assert.equal(decryptSecret(first.contact), "ana@example.com");
  } finally {
    if (previous == null) delete process.env.NALVEN_SECRETS_MASTER_KEY; else process.env.NALVEN_SECRETS_MASTER_KEY = previous;
  }
});

test("ROPA, bases legais e RIPD exigem salvaguardas e prestação de contas", () => {
  assert.throws(() => legalBasisInput({ name: "Marketing", basis: "consent", purpose: "Comunicação promocional", dataCategory: "Contato", internationalTransfer: true }), /salvaguardas/);
  assert.throws(() => treatmentInput({ name: "Campanhas", department: "Marketing", purpose: "Comunicação promocional", legalBasis: "consent", dataCategories: "contato", dataSubjects: "clientes", operations: "envio", owner: "Marketing", internationalTransfer: true }), /salvaguardas/);
  const treatment = treatmentInput({ name: "Campanhas", department: "Marketing", purpose: "Comunicação promocional", legalBasis: "consent", dataCategories: "contato; preferências", dataSubjects: "clientes", operations: "segmentação, envio", owner: "Marketing", internationalTransfer: true, transferSafeguards: "Cláusulas e avaliação do operador", riskLevel: "high" });
  assert.deepEqual(treatment.dataCategories, ["contato", "preferências"]); assert.equal(treatment.riskLevel, "high");
  assert.throws(() => impactAssessmentInput({ title: "RIPD Campanhas", reason: "Perfilamento em escala", status: "approved", risks: "uso incompatível", safeguards: "minimização" }), /parecer/);
  const ripd = impactAssessmentInput({ title: "RIPD Campanhas", reason: "Perfilamento em escala", status: "approved", risks: "uso incompatível", safeguards: "minimização", dpoOpinion: "Aprovado com revisão semestral" });
  assert.equal(ripd.status, "approved");
});

test("incidentes relevantes recebem relógio de três dias úteis e gates de encerramento", () => {
  const detectedAt = new Date("2026-09-04T15:00:00.000Z");
  assert.equal(addBusinessDays(detectedAt, 3).toISOString(), "2026-09-09T15:00:00.000Z");
  const incident = incidentCreateInput({ title: "Exposição indevida", severity: "high", description: "Arquivo enviado ao destinatário incorreto.", affectedSubjects: 12, riskRelevant: true, dataCategories: "identificação, contato", detectedAt });
  assert.equal(incident.riskRelevant, true); assert.deepEqual(incident.dataCategories, ["identificação", "contato"]);
  assert.throws(() => incidentCreateInput({ title: "Evento sem risco", description: "Evento contido sem acesso confirmado.", riskRelevant: false, dataCategories: "log" }), /por que/);
  assert.throws(() => incidentTransitionInput({ incidentId: 1, expectedVersion: 1, status: "resolved", riskRelevant: true, containmentMeasures: "Acesso removido" }), /causa raiz/);
  assert.equal(allowedIncidentTransition("notifying", "resolved"), true); assert.equal(allowedIncidentTransition("resolved", "open"), false);
});

test("configuração do encarregado e CSV têm limites e proteção contra fórmula", () => {
  const settings = privacySettingsInput({ dataProtectionOfficerName: "Marina Lopes", dataProtectionEmail: "privacidade@example.com", privacyDefaultRequestDays: 15, privacySmallAgent: false });
  assert.equal(settings.privacyDefaultRequestDays, 15); assert.throws(() => privacySettingsInput({ dataProtectionEmail: "invalido" }), /E-mail/);
  const csv = privacyCsv([{ number: "=CMD()", type: "access", subjectName: "+Titular", subjectDocument: "••••••••4725", contact: "an***@example.com", status: "received", priority: "normal", assignedTo: null, dueAt: "2026-09-18", createdAt: "2026-09-03" }]);
  assert.ok(csv.startsWith("\uFEFF")); assert.match(csv, /"'=CMD\(\)"/); assert.match(csv, /"'\+Titular"/);
});

test("persistência cria governança, histórico imutável e privilégios mínimos", async () => {
  const [schema, migration, grants] = await Promise.all([file("prisma/tenant/schema.prisma"), file("prisma/tenant/migrations/20260903230000_privacy_governance_center/migration.sql"), file("deploy/reconcile-tenant-runtime-grants.sql")]);
  for (const token of ["PrivacyRequestEvent", "PrivacyIncidentEvent", "PrivacyTreatmentActivity", "PrivacyImpactAssessment", "subjectDocumentHash", "notificationDueAt", "dataProtectionOfficerName", "privacyDefaultRequestDays"]) assert.match(schema, new RegExp(token));
  for (const token of ["reject_immutable_privacy_history", "SECURITY DEFINER", "SET search_path = pg_catalog", "privacy_request_events_immutable_guard", "privacy_incident_events_immutable_guard", "privacy_requests_status_check", "privacy_assessments_residual_risk_check"]) assert.match(migration, new RegExp(token));
  assert.match(grants, /'privacy_request_events'/); assert.match(grants, /'privacy_incident_events'/);
});

test("API aplica RBAC, licença, origem, rate limit, concorrência e minimização", async () => {
  const route = await file("app/api/erp/privacy/route.ts"), get = route.slice(route.indexOf("export async function GET"), route.indexOf("export async function POST"));
  for (const token of ["privacy.read", "privacy.write", "assertSameOrigin", "assertPosMutationRequest", "readPosJson", "enforcePosRateLimit", "assertTenantWriteAccess", "Serializable", "expectedVersion", "export.record", "requestedBy: access.user.id", "private, no-store", "protectPrivacySubject", "publicRequest", "maskDocument", "maskContact", "P2034"]) assert.match(route, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(get, /privacyRequest\.create|privacyIncident\.create|privacyTreatmentActivity\.create/);
  assert.doesNotMatch(route, /subjectDocument:\s*item\.subjectDocument/);
  assert.doesNotMatch(route, /error instanceof Error\s*\?\s*error\.message/);
});

test("interface cobre operação, governança, acessibilidade e responsividade", async () => {
  const [ui, css, shell, seed, backfill, pkg] = await Promise.all([file("components/erp/privacy-governance-center.tsx"), file("components/erp/privacy-governance-center.module.css"), file("app/erp/erp-client.tsx"), file("scripts/seed-demo-privacy.ts"), file("scripts/backfill-privacy-secrets.ts"), file("package.json")]);
  for (const token of ["Central de privacidade", "Visão geral", "Fila de solicitações", "Inventário de tratamentos", "Hipóteses legais", "Retenção e descarte", "Relógio regulatório", "Relatórios de impacto", "Linha do tempo imutável", "Exportar CSV", "Prontidão", "Configurar programa", "dados pessoais minimizados"] ) assert.ok(ui.includes(token), token);
  assert.match(ui, /role="tablist"/); assert.match(ui, /role="tab"/); assert.match(ui, /aria-selected/); assert.match(ui, /aria-label/);
  assert.match(css, /@media\(max-width:700px\)/); assert.match(css, /@media\(max-width:980px\)/); assert.doesNotMatch(css, /font-size:[0-9](?:\.|)px/);
  assert.match(shell, /<PrivacyGovernanceCenter \/>/); assert.match(seed, /NALVEN_ALLOW_DEMO_PRIVACY_SEED/); assert.match(seed, /nalven_t_demo_runtime/); assert.match(backfill, /NALVEN_ALLOW_PRIVACY_BACKFILL/); assert.match(pkg, /test:privacy/); assert.match(pkg, /db:seed:demo-privacy/);
});
