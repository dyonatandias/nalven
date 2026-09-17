import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { branchCsv, branchReadiness, DEFAULT_BUSINESS_HOURS, parseBranchQuery, validateBusinessHours } from "../lib/erp/branch-control";
import { branchInput, BranchInputError } from "../lib/erp/branch-input";

const root = process.cwd();
const read = (path: string) => readFileSync(`${root}/${path}`, "utf8");

test("prontidão diferencia unidade operacional completa de implantação crítica", () => {
  const ready = branchReadiness({ legalName: "Auto Mais Ltda.", document: "11444777000161", activityCode: "4530703", stateRegistration: "257445890", stateRegistrationExempt: false, zip: "89801001", street: "Av. Brasil", number: "100", city: "Chapecó", state: "SC", email: "filial@example.com", managerName: "Maria", managerEmail: "maria@example.com", defaultWarehouseId: 1, warehouseCount: 2, userCount: 4, productCount: 20, validCertificateCount: 0, settings: { fiscalEnabled: true, fiscalEnvironment: "homologation", salesEnabled: true, purchasesEnabled: true, stockEnabled: true, servicesEnabled: true, businessHours: DEFAULT_BUSINESS_HOURS } });
  assert.equal(ready.score, 100); assert.equal(ready.status, "ready"); assert.equal(ready.canActivate, true);
  const critical = branchReadiness({ legalName: "Unidade futura", document: "11444777000161", warehouseCount: 0, userCount: 0, productCount: 0, validCertificateCount: 0, settings: { salesEnabled: true, businessHours: DEFAULT_BUSINESS_HOURS } });
  assert.equal(critical.status, "critical"); assert.equal(critical.canActivate, false); assert.ok(critical.issues.some((item) => item.key === "warehouse" && item.critical));
  const highScoreButBlocked = branchReadiness({ legalName: "Unidade pausada", document: "11444777000161", activityCode: "4530703", stateRegistrationExempt: true, zip: "89801001", street: "Av. Brasil", number: "100", city: "Chapecó", state: "SC", email: "filial@example.com", managerName: "Maria", managerEmail: "maria@example.com", defaultWarehouseId: 1, warehouseCount: 1, userCount: 1, productCount: 1, validCertificateCount: 0, settings: { salesEnabled: false, purchasesEnabled: false, stockEnabled: false, fiscalEnabled: false, servicesEnabled: false, businessHours: DEFAULT_BUSINESS_HOURS } });
  assert.equal(highScoreButBlocked.score, 95); assert.equal(highScoreButBlocked.status, "critical"); assert.equal(highScoreButBlocked.canActivate, false);
});

test("horários exigem sete dias únicos e fechamento posterior", () => {
  assert.equal(validateBusinessHours(DEFAULT_BUSINESS_HOURS).length, 7);
  assert.throws(() => validateBusinessHours(DEFAULT_BUSINESS_HOURS.slice(0, 6)), /sete dias/);
  assert.throws(() => validateBusinessHours(DEFAULT_BUSINESS_HOURS.map((item) => item.day === 1 ? { ...item, opensAt: "18:00", closesAt: "08:00" } : item)), /posterior/);
});

test("entrada da filial normaliza cadastro, capacidades, agenda e concorrência", () => {
  const input = branchInput({ code: "filial sul", name: "Filial Sul", legalName: "Auto Mais Peças Ltda.", document: "11.444.777/0001-61", type: "branch", status: "planned", parentBranchId: 3, openingDate: "2026-11-01", activityCode: "4530-7/03", stateRegistrationExempt: true, email: "FILIAL@EXAMPLE.COM", zip: "89801-001", state: "sc", timezone: "America/Sao_Paulo", businessHours: DEFAULT_BUSINESS_HOURS, salesEnabled: true, purchasesEnabled: false, stockEnabled: true, fiscalEnabled: false, servicesEnabled: true, warehouseIds: [2], defaultWarehouseId: 2, productConfigurations: [], userAccesses: [], expectedVersion: 4 });
  assert.equal(input.branch.code, "FILIAL-SUL"); assert.equal(input.branch.document, "11444777000161"); assert.equal(input.branch.activityCode, "4530703"); assert.equal(input.branch.state, "SC"); assert.equal(input.branch.zip, "89801001"); assert.equal(input.branch.parentBranchId, 3); assert.equal(input.settings.purchasesEnabled, false); assert.equal(input.expectedVersion, 4);
  assert.throws(() => branchInput({ name: "Inválida", legalName: "Inválida Ltda.", document: "00000000000000" }), BranchInputError);
});

test("consulta e CSV possuem filtros e campos executivos", () => {
  const query = parseBranchQuery(new URLSearchParams("page=2&limit=25&status=active&type=branch&state=sc&readiness=attention&sort=stock"));
  assert.deepEqual(query, { page: 2, limit: 25, status: "active", type: "branch", state: "SC", readiness: "attention", sort: "stock", search: "", format: "json" });
  const csv = branchCsv([{ code: "SUL", name: "Filial Sul", legalName: "Auto Mais", document: "11444777000161", type: "branch", status: "active", city: "Chapecó", state: "SC", readiness: { score: 92 }, metrics: { warehouseCount: 2, userCount: 3, productCount: 80, availableStock: 120, financialAccountCount: 1 } }]);
  assert.match(csv, /Prontidão/); assert.match(csv, /Filial Sul/); assert.ok(csv.startsWith("\uFEFF"));
});

test("persistência inclui hierarquia, ciclo, capacidades e restrições", () => {
  const schema = read("prisma/tenant/schema.prisma"), migration = read("prisma/tenant/migrations/20260903200000_company_branch_control_center/migration.sql");
  for (const token of ["parentBranchId", "openingDate", "activityCode", "stateRegistrationExempt", "businessHours", "salesEnabled", "purchasesEnabled", "stockEnabled", "fiscalEnabled", "servicesEnabled"]) assert.match(schema, new RegExp(token));
  for (const token of ["branches_status_check", "branches_parent_not_self_check", "branches_activity_code_check", "branches_parent_branch_id_fkey", "branch_settings_operational_capabilities_idx"]) assert.match(migration, new RegExp(token));
});

test("APIs protegem leitura, mutações, versão, origem, limites e inativação", () => {
  const collection = read("app/api/erp/branches/route.ts"), detail = read("app/api/erp/branches/[id]/route.ts");
  for (const token of ["force-dynamic", "private, no-store", "assertTenantPermission", "assertSameOrigin", "assertPosMutationRequest", "readPosJson", "enforcePosRateLimit", "assertTenantWriteAccess", "Serializable", "branchCsv"]) assert.ok(collection.includes(token), token);
  for (const token of ["expectedVersion", "branch.set_primary", "branch.status", "branchDependencies", "validateRemovedWarehouses", "openCashSessions", "activeReservations", "activePickingWaves", "openManifests", "tenantAuditEvent", "Serializable"]) assert.ok(detail.includes(token), token);
  assert.doesNotMatch(collection, /error instanceof Error \? error\.message : `Não foi possível/);
});

test("interface entrega visão 360, ações, filtros, prontidão e responsividade legível", () => {
  const ui = read("components/erp/company-branch-center.tsx"), css = read("components/erp/company-branch-center.module.css"), shell = read("app/erp/erp-client.tsx");
  for (const token of ["Empresas e filiais", "Estrutura", "Prontidão", "Governança", "Exportar CSV", "Duplicar configuração", "Tornar matriz principal", "Visão 360", "Horário semanal", "Catálogo local", "Equipe e escopo local"]) assert.ok(ui.includes(token), token);
  assert.ok(shell.includes("<CompanyBranchCenter />")); assert.match(css, /@media\(max-width:680px\)/); assert.doesNotMatch(css, /font-size:(?:[0-9]|10)px/);
});

test("seed demo é protegido, idempotente e cobre cenários do ciclo", () => {
  const seed = read("scripts/seed-demo-branches.ts"), pkg = read("package.json");
  for (const token of ["NALVEN_ALLOW_DEMO_BRANCH_SEED", "nalven_t_demo", "nalven_t_demo_runtime", "branch.upsert", "warehouse.upsert", "branchProduct.upsert", "branchUserAccess.upsert", "financialAccount.upsert", "financialTitle.upsert", "dfeSyncCursor.upsert", "NOVA-UNIDADE", "LOJA-OESTE", "CD-SUL"]) assert.ok(seed.includes(token), token);
  assert.ok(pkg.includes("test:branches")); assert.ok(pkg.includes("db:seed:demo-branches"));
});
