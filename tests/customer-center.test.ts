import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { customerCsv, customerHealth, duplicateCustomerGroups, parseCustomerCsv, parseCustomerQuery } from "../lib/erp/customer-control";
import { customerConsentInput, customerInput } from "../lib/erp/customer-input";

const ui = readFileSync("components/erp/customer-center.tsx", "utf8");
const css = readFileSync("components/erp/customer-center.module.css", "utf8");
const listRoute = readFileSync("app/api/erp/customers/route.ts", "utf8");
const detailRoute = readFileSync("app/api/erp/customers/[id]/route.ts", "utf8");
const schema = readFileSync("prisma/tenant/schema.prisma", "utf8");
const migration = readFileSync("prisma/tenant/migrations/20260903140000_customer_360_control_center/migration.sql", "utf8");
const seed = readFileSync("scripts/seed-demo-customers.ts", "utf8");

test("entrada normaliza cadastro, carteira e política de crédito", () => {
  const input = customerInput({ name: "Cliente Teste", document: "529.982.247-25", email: "CLIENTE@EXAMPLE.COM", phone: "(49) 99999-0000", creditLimit: "1234.567", segment: "vip", origin: "referral", salesperson: "Ana", paymentTermsDays: "28", riskRating: "low", preferredChannel: "whatsapp", state: "sc" });
  assert.equal(input.document, "52998224725"); assert.equal(input.email, "cliente@example.com"); assert.equal(input.creditLimit, 1234.57); assert.equal(input.segment, "vip"); assert.equal(input.address.state, "SC");
  assert.throws(() => customerInput({ name: "Inválido", document: "111.111.111-11" }), /CPF ou CNPJ/);
  assert.throws(() => customerInput({ name: "Cliente", document: "52998224725", riskRating: "arbitrary" }), /risco/i);
});

test("consentimento exige evidência e permanece como evento", () => {
  assert.throws(() => customerConsentInput({ purpose: "marketing_email", status: "granted", legalBasis: "consent", source: "Site" }), /evidência/i);
  assert.equal(customerConsentInput({ purpose: "marketing_email", status: "revoked", legalBasis: "consent", source: "Atendimento", proofReference: "PROTOCOLO-123" }).status, "revoked");
});

test("saúde, duplicidades e CSV produzem sinais seguros", () => {
  const health = customerHealth({ email: null, phone: null, document: "123", addresses: [], riskRating: "high", status: "active", overdueBalance: 100, pendingTasks: 1 });
  assert.equal(health.score, 10); assert.match(health.issues.join(" "), /vencidos/);
  const duplicates = duplicateCustomerGroups([{ id: 1, name: "A", email: "same@example.com", phone: null }, { id: 2, name: "B", email: "SAME@example.com", phone: null }]);
  assert.equal(duplicates.length, 1); assert.doesNotMatch(duplicates[0].value, /^same/);
  assert.match(customerCsv([{ name: "=IMPORT(1)" }]), /'=/);
});

test("consulta valida filtros e paginação", () => {
  const query = parseCustomerQuery(new URLSearchParams("segment=vip&risk=low&page=2&limit=50&sort=credit"));
  assert.equal(query.segment, "vip"); assert.equal(query.page, 2); assert.equal(query.limit, 50); assert.equal(query.sort, "credit");
  assert.throws(() => parseCustomerQuery(new URLSearchParams("segment=inventado")), /Filtro/);
});

test("importador aceita delimitadores, aspas e limita lotes", () => {
  const rows = parseCustomerCsv('nome;cpf_cnpj;cidade\r\n"Empresa; Exemplo";45874206000189;Chapecó');
  assert.equal(rows.length, 1); assert.equal(rows[0].value.name, "Empresa; Exemplo"); assert.equal(rows[0].value.document, "45874206000189");
  assert.throws(() => parseCustomerCsv("email;telefone\na@b.com;49999999999"), /nome e cpf_cnpj/);
});

test("API entrega visão 360, CSV, cache privado e mutações protegidas", () => {
  for (const marker of ["enrichCustomers", "availableCredit", "duplicateCustomerGroups", "growthSeries", "customerCsv", "pagination", "matches(access.permissions", 'body.action === "import"']) assert.match(listRoute, new RegExp(marker.replace(/[()]/g, "\\$&")));
  for (const route of [listRoute, detailRoute]) { assert.match(route, /private, no-store/); assert.match(route, /assertTenantPermission/); assert.doesNotMatch(route, /error instanceof Error \? error\.message/); }
  for (const marker of ["Serializable", "FOR UPDATE", "version", "customer.consent_recorded", "customer.interaction_created", "customer.contact_created"]) assert.match(detailRoute, new RegExp(marker.replace(".", "\\.")));
  assert.match(listRoute, /readPosJson/); assert.match(listRoute, /enforcePosRateLimit/);
});

test("persistência possui contatos, etiquetas, interações, consentimentos e restrições", () => {
  for (const model of ["CustomerContact", "CustomerTag", "CustomerTagLink", "CustomerInteraction", "CustomerConsent"]) assert.match(schema, new RegExp(`model ${model}`));
  for (const marker of ["customers_segment_check", "one_active_primary", "customer_consents_status_check", "customer_interactions_type_check"]) assert.match(migration, new RegExp(marker));
});

test("interface cobre BI, operação, acessibilidade e responsividade sem microtexto", () => {
  for (const label of ["Central de clientes", "Receita identificada", "Qualidade cadastral", "Duplicidades prováveis", "Perfil 360", "Registrar interação", "Novo contato", "Adicionar endereço", "Registrar manifestação", "Exportar CSV", "Importar CSV", "Aplicar etiqueta"]) assert.match(ui, new RegExp(label, "i"));
  assert.match(ui, /aria-label/); assert.match(ui, /role="alert"/); assert.match(css, /@media\(max-width:650px\)/); assert.doesNotMatch(css, /font-size:\s*[4-9](?:\.\d+)?px/);
});

test("seed demo é protegido, idempotente e cobre cenários variados", () => {
  assert.match(seed, /NALVEN_ALLOW_DEMO_CUSTOMER_SEED/); assert.match(seed, /nalven_t_demo_runtime/); assert.match(seed, /upsert/);
  for (const marker of ["blocked", "customerConsent", "customerInteraction", "salesOrder", "crmOpportunity", "contato.compartilhado"]) assert.match(seed, new RegExp(marker));
  assert.match(seed, /deliveryType: "carrier"/); assert.doesNotMatch(seed, /deliveryType: "shipping"/);
});
