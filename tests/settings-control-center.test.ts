import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildSettingsReadiness,
  settingsChangedFields,
  settingsExport,
  settingsInput,
} from "../lib/erp/settings-input";

const root = process.cwd();
const valid = {
  organizationName: "Auto Mais Peças",
  tradeName: "Auto Mais",
  timezone: "America/Sao_Paulo",
  defaultPaymentMethod: "Pix",
  defaultCustomerName: "Consumidor final",
  requireCustomer: false,
  lowStockAlerts: true,
  operationalEmail: "operacao@example.com",
  dailySummary: true,
  notifyLowStock: true,
  auditRetentionDays: 1825,
  logoMediaId: "cm1234567890",
  accentColor: "#168151",
  interfaceDensity: "comfortable",
  defaultSidebarMode: "expanded",
  operationalPhone: "(49) 3333-0100",
  autoGenerateSku: true,
  allowNegativeStock: false,
  quoteValidityDays: 10,
  maxDiscountPercent: 12.5,
  posCloseToleranceCents: 500,
  dailySummaryTime: "18:00",
  notifyOverdueTitles: true,
  notifyNewSales: false,
  quoteFooter: "Proposta válida.",
  receiptFooter: "Obrigado.",
  termsAndConditions: "Condições comerciais.",
  dataProtectionEmail: "privacidade@example.com",
};
const facts = {
  activeBranches: 2,
  branchesWithWarehouse: 2,
  branchesWithFiscalSettings: 2,
  productionFiscalBranches: 1,
  activeFiscalCertificates: 1,
  activeProfiles: 5,
  expiredProfiles: 0,
  activeRoles: 4,
  activeIntegrations: 2,
  healthyIntegrations: 2,
  activeSmtpCredentials: 1,
  healthySmtpCredentials: 1,
  reportSettingsConfigured: true,
};

test("entrada normaliza políticas e mantém domínios fechados", () => {
  const result = settingsInput(valid);
  assert.equal(result.locale, "pt-BR");
  assert.equal(result.currency, "BRL");
  assert.equal(result.operationalEmail, "operacao@example.com");
  assert.equal(result.maxDiscountPercent, 12.5);
  assert.throws(() => settingsInput({ ...valid, timezone: "Europe/London" }));
  assert.throws(() => settingsInput({ ...valid, maxDiscountPercent: 12.555 }));
  assert.throws(() => settingsInput({ ...valid, organizationName: "A\u0000B" }));
});

test("prontidão cruza configuração com dependências operacionais reais", () => {
  const ready = buildSettingsReadiness(settingsInput(valid), facts);
  assert.equal(ready.blocked, 0);
  assert.ok(ready.score >= 90);
  const blocked = buildSettingsReadiness(settingsInput(valid), {
    ...facts,
    activeBranches: 0,
    branchesWithWarehouse: 0,
    activeSmtpCredentials: 0,
    healthySmtpCredentials: 0,
  });
  assert.equal(blocked.state, "blocked");
  assert.ok(blocked.items.some((item) => item.id === "notifications" && item.state === "blocked"));
});

test("histórico descreve apenas campos conhecidos", () => {
  const changed = settingsChangedFields(
    { ...valid, internalSecret: "before" },
    { ...valid, accentColor: "#123456", internalSecret: "after" },
  );
  assert.deepEqual(changed, [{ field: "accentColor", label: "Cor principal" }]);
});

test("exportação é versionada e nunca incorpora propriedades estranhas", () => {
  const exported = settingsExport(
    { ...valid, version: 7, secretsCipherText: "never", updatedBy: "user" },
    "organization-demo",
    new Date("2026-09-04T12:00:00.000Z"),
  );
  const parsed = JSON.parse(exported);
  assert.equal(parsed.schema, "nalven.tenant-settings.v1");
  assert.equal(parsed.version, 7);
  assert.equal(parsed.settings.organizationName, valid.organizationName);
  assert.equal("secretsCipherText" in parsed.settings, false);
  assert.equal("updatedBy" in parsed.settings, false);
});

test("API aplica RBAC, limites, concorrência, auditoria e restauração explícita", async () => {
  const source = await readFile(`${root}/app/api/erp/settings/route.ts`, "utf8");
  for (const contract of [
    '"settings.read"',
    '"settings.write"',
    "assertTenantWriteAccess",
    "assertSameOrigin",
    "persistentRateLimit",
    "readSettingsJson",
    'confirmation !== "RESTAURAR"',
    'action: "tenant_settings.updated"',
    'action: "tenant_settings.restored"',
    'isolationLevel: "Serializable"',
    '"x-content-type-options": "nosniff"',
    "NO_STORE",
  ]) assert.match(source, new RegExp(contract.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(source, /error instanceof Error \? error\.message : `Não foi possível/);
});

test("interface oferece diagnóstico, ações, previews e mobile legível", async () => {
  const [component, css] = await Promise.all([
    readFile(`${root}/components/erp/settings-control-center.tsx`, "utf8"),
    readFile(`${root}/components/erp/settings-control-center.module.css`, "utf8"),
  ]);
  for (const contract of [
    "Central de configurações",
    "Exportar configuração",
    "Mapa de prontidão",
    "Prévia do documento",
    "Histórico de versões",
    "Restaurar como nova versão",
    "Alterações ainda não salvas",
    "beforeunload",
    "MediaPicker",
  ]) assert.match(component, new RegExp(contract));
  assert.match(css, /font-size: 14px/);
  assert.match(css, /min-height: 43px/);
  assert.match(css, /@media \(max-width: 700px\)/);
  assert.match(css, /prefers-reduced-motion/);
  assert.doesNotMatch(component, /<main(?:\s|>)/);
});

test("workspaces internas preservam um único landmark principal no shell", async () => {
  const childWorkspaces = [
    "accounts-control-center.tsx",
    "audit-activity-center.tsx",
    "bank-reconciliation-center.tsx",
    "business-intelligence-dashboard.tsx",
    "cash-close-control-center.tsx",
    "category-center.tsx",
    "customer-center.tsx",
    "finance-control-center.tsx",
    "fiscal-center.tsx",
    "media-library.tsx",
    "planning-control-center.tsx",
    "privacy-governance-center.tsx",
    "settings-control-center.tsx",
    "user-access-center.tsx",
  ];
  const sources = await Promise.all(
    childWorkspaces.map((file) => readFile(`${root}/components/erp/${file}`, "utf8")),
  );
  for (const source of sources) assert.doesNotMatch(source, /<main(?:\s|>)/);
  const shell = await readFile(`${root}/app/erp/erp-client.tsx`, "utf8");
  assert.equal(shell.match(/<main(?:\s|>)/g)?.length, 1);
});

test("seed demo é idempotente, amplo e não cria segredos", async () => {
  const source = await readFile(`${root}/scripts/seed-demo-settings.ts`, "utf8");
  assert.match(source, /settings-demo-history-/);
  assert.match(source, /findFirst/);
  assert.match(source, /revisions\.length/);
  assert.match(source, /secretValues: false/);
  assert.doesNotMatch(source, /api[_-]?key|password|secretsCipherText/i);
});
