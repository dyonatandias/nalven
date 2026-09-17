import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { duplicateSupplierGroups, parseSupplierCsv, parseSupplierQuery, supplierCsv, supplierHealth, supplierPerformance } from "../lib/erp/supplier-control";
import { supplierDocumentInput, supplierEvaluationInput, supplierInput, SupplierInputError } from "../lib/erp/supplier-input";

const migration = readFileSync("prisma/tenant/migrations/20260903160000_supplier_360_control_center/migration.sql", "utf8"), schema = readFileSync("prisma/tenant/schema.prisma", "utf8"), listRoute = readFileSync("app/api/erp/suppliers/route.ts", "utf8"), detailRoute = readFileSync("app/api/erp/suppliers/[id]/route.ts", "utf8"), ui = readFileSync("components/erp/supplier-center.tsx", "utf8"), css = readFileSync("components/erp/supplier-center.module.css", "utf8"), shell = readFileSync("app/erp/erp-client.tsx", "utf8"), seed = readFileSync("scripts/seed-demo-suppliers.ts", "utf8");

test("normaliza e valida perfil comercial, fiscal e logístico", () => {
  const value = supplierInput({ name: "Fornecedor Exemplo Ltda.", document: "11.222.333/0001-81", email: "COMPRAS@EXAMPLE.COM", phone: "(49) 3333-9999", category: "services", origin: "referral", riskRating: "medium", homologationStatus: "conditional", taxRegime: "simples", website: "https://example.com", paymentTermsDays: "28", deliveryLeadTimeDays: "5", minimumOrder: "450.557", state: "sc" });
  assert.equal(value.document, "11222333000181"); assert.equal(value.email, "compras@example.com"); assert.equal(value.type, "PJ"); assert.equal(value.minimumOrder, 450.56); assert.equal(value.address.state, "SC");
  assert.throws(() => supplierInput({ name: "Fornecedor", document: "11111111111111" }), SupplierInputError);
  assert.throws(() => supplierInput({ name: "Fornecedor", document: "11222333000181", website: "javascript:alert(1)" }), /Site inválido/);
});

test("valida documentos e avaliações de homologação", () => {
  assert.equal(supplierDocumentInput({ documentType: "certificate", name: "ISO 9001", status: "valid", issuedAt: "2026-01-01", expiresAt: "2027-01-01" }).type, "certificate");
  assert.throws(() => supplierDocumentInput({ documentType: "tax", name: "Certidão", issuedAt: "2027-01-01", expiresAt: "2026-01-01" }), /validade/);
  assert.equal(supplierEvaluationInput({ qualityScore: 90, deliveryScore: 80, commercialScore: 70, complianceScore: 100 }).complianceScore, 100);
  assert.throws(() => supplierEvaluationInput({ qualityScore: 101, deliveryScore: 80, commercialScore: 70, complianceScore: 90 }), /qualidade/);
});

test("calcula performance ponderada e saúde acionável", () => {
  assert.equal(supplierPerformance({ qualityScore: 90, deliveryScore: 80, commercialScore: 70, complianceScore: 100 }), 87);
  const result = supplierHealth({ email: null, phone: null, document: "11222333000181", addresses: [], homologationStatus: "pending", riskRating: "high", status: "active", expiringDocuments: 1, pendingTasks: 1, performanceScore: 50 });
  assert.ok(result.score < 30); assert.ok(result.issues.includes("documentos vencidos ou próximos"));
});

test("detecta duplicidades sem expor contato completo e protege CSV", () => {
  const groups = duplicateSupplierGroups([{ id: 1, name: "A", email: "same@example.com", phone: null }, { id: 2, name: "B", email: "same@example.com", phone: null }]);
  assert.equal(groups.length, 1); assert.match(groups[0].value, /\*\*\*@/); assert.doesNotMatch(groups[0].value, /^same@/);
  assert.match(supplierCsv([{ name: "=HYPERLINK('x')" }]), /'=HYPERLINK/);
});

test("parâmetros e importador CSV são estritos e limitados", () => {
  const query = parseSupplierQuery(new URLSearchParams("category=goods&homologation=approved&sort=spend&page=2&limit=50"));
  assert.equal(query.page, 2); assert.equal(query.sort, "spend"); assert.equal(query.homologation, "approved");
  assert.throws(() => parseSupplierQuery(new URLSearchParams("risk=critical")), /Filtro/);
  const rows = parseSupplierCsv('nome;cpf_cnpj;categoria;cidade\n"Fornecedor; Sul";11222333000181;goods;Chapecó');
  assert.equal(rows[0].value.name, "Fornecedor; Sul"); assert.equal(rows[0].value.document, "11222333000181");
});

test("APIs aplicam segurança, paginação, visão 360 e mutações completas", () => {
  for (const source of [listRoute, detailRoute]) { assert.match(source, /assertTenantPermission/); assert.match(source, /NO_STORE/); assert.match(source, /console\.error/); }
  assert.match(listRoute, /assertPosMutationRequest/); assert.match(listRoute, /readPosJson/); assert.match(listRoute, /enforcePosRateLimit/); assert.match(listRoute, /batch\.homologation/); assert.match(listRoute, /supplierCsv/); assert.match(listRoute, /10_000/);
  for (const action of ["contact.create", "address.upsert", "interaction.create", "document.create", "evaluation.create", "product.upsert", "tag.add"]) assert.ok(detailRoute.includes(action), action);
  assert.match(detailRoute, /FOR UPDATE/); assert.match(detailRoute, /Serializable/); assert.match(detailRoute, /supplier\.updated/);
});

test("persistência possui integridade, histórico e índices operacionais", () => {
  for (const table of ["supplier_addresses", "supplier_tags", "supplier_tag_links", "supplier_interactions", "supplier_documents", "supplier_evaluations"]) assert.ok(migration.includes(`\"${table}\"`), table);
  assert.match(migration, /supplier_contacts_one_active_primary_idx/); assert.match(migration, /supplier_evaluations_scores_check/); assert.match(migration, /supplier_documents_status_check/); assert.match(migration, /suppliers_homologation_status_check/);
  for (const model of ["SupplierAddress", "SupplierTag", "SupplierInteraction", "SupplierDocument", "SupplierEvaluation"]) assert.match(schema, new RegExp(`model ${model}`));
});

test("interface substitui legado e cobre BI, ações, responsividade e acessibilidade", () => {
  assert.match(shell, /<SupplierCenter \/>/); assert.match(ui, /Central de fornecedores/); assert.match(ui, /Visão executiva/); assert.match(ui, /Carteira/); assert.match(ui, /Homologação/); assert.match(ui, /Importar/); assert.match(ui, /Exportar CSV/); assert.match(ui, /Visão 360/); assert.match(ui, /role="tablist"/); assert.match(ui, /aria-label/); assert.match(ui, /ErpModal/); assert.match(css, /@media\(max-width:650px\)/); assert.doesNotMatch(css, /font-size:(?:[0-9]|10)px/);
});

test("seed demonstrativo é protegido, idempotente e rico", () => {
  assert.match(seed, /NALVEN_ALLOW_DEMO_SUPPLIER_SEED/); assert.match(seed, /nalven_t_demo_runtime/); assert.match(seed, /upsert/); assert.match(seed, /names\.length/); assert.match(seed, /supplierDocument/); assert.match(seed, /supplierEvaluation/); assert.match(seed, /purchaseOrder/); assert.match(seed, /financialTitle/);
});
