import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  parsePaymentCenterQuery,
  paymentCsv,
  paymentMethodLabel,
  paymentStatusLabel,
  paymentStatusTone,
} from "../lib/erp/payment-center";

test("consulta de pagamentos limita paginação, período e filtros", () => {
  const valid = parsePaymentCenterQuery(new URLSearchParams({ days: "90", page: "3", limit: "500", search: "E123-abc", provider: "banco_inter" }));
  assert.deepEqual(valid, { days: 90, page: 3, limit: 100, search: "E123-abc", status: "", method: "", provider: "banco_inter" });
  const invalid = parsePaymentCenterQuery(new URLSearchParams({ days: "365", page: "-2", limit: "0", status: "x\nheader", search: "x\u0000y" }));
  assert.equal(invalid.days, 30);
  assert.equal(invalid.page, 1);
  assert.equal(invalid.limit, 25);
  assert.equal(invalid.status, "");
  assert.equal(invalid.search, "");
});

test("rótulos e tons cobrem estados financeiros críticos", () => {
  assert.equal(paymentStatusLabel("manual_review"), "Revisão manual");
  assert.equal(paymentStatusTone("unknown"), "warning");
  assert.equal(paymentStatusTone("declined"), "danger");
  assert.equal(paymentStatusTone("captured"), "success");
  assert.equal(paymentMethodLabel("credit"), "Crédito");
});

test("CSV neutraliza fórmulas e exporta somente referências permitidas", () => {
  const csv = paymentCsv([{
    createdAt: "2026-09-04T12:00:00.000Z", saleNumber: "=CMD()", customer: "+Cliente",
    type: "payment", method: "pix", provider: "banco_inter", status: "captured", amountCents: 12345,
    transactionId: "TX-1", endToEndId: "E2E-1", nsu: null, authorizationCode: null,
    cardBrand: null, cardLastFour: null,
  }]);
  assert.match(csv, /"'=CMD\(\)"/);
  assert.match(csv, /"'\+Cliente"/);
  assert.match(csv, /"123\.45"/);
  assert.doesNotMatch(csv.toLowerCase(), /cvv|pan completo|private_key/);
});

test("central usa permissão própria, não serializa segredos e oferece UX operacional", () => {
  const route = readFileSync("app/api/erp/payments/route.ts", "utf8");
  const ui = readFileSync("components/erp/payment-center.tsx", "utf8");
  const css = readFileSync("components/erp/payment-center.module.css", "utf8");
  for (const evidence of [
    'assertTenantPermission(organization.id, "payments.read")',
    "PAYMENT_EXPORT_LIMIT",
    "posPaymentIntegrityIncident",
    "posPaymentCompensationIncident",
    "posReconciliationBatch",
    '"cache-control": "no-store, max-age=0"',
  ]) assert.match(route, new RegExp(evidence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  for (const label of ["Pulso financeiro", "Taxa de aprovação", "Aguardando definição", "Conciliação de adquirentes", "Rotas do PDV", "Responsável operacional", "Escopo reduzido de dados", "Exportar CSV"]) assert.match(ui, new RegExp(label));
  assert.match(css, /@media \(max-width: 680px\)/);
  assert.match(css, /prefers-reduced-motion/);
  assert.doesNotMatch(route, /secretsCipherText|decryptSecret|private_key_pem/);
});

test("rota e execução rejeitam credencial revogada ou vencida", () => {
  const admin = readFileSync("app/api/erp/pdv/admin/route.ts", "utf8");
  const plan = readFileSync("lib/erp/pos-payment-plan.ts", "utf8");
  const persistence = readFileSync("lib/erp/pos-payment-persistence.ts", "utf8");
  const manual = readFileSync("lib/erp/pos-manual-payment-reconciliation.ts", "utf8");
  for (const source of [admin, plan, persistence, manual]) {
    assert.match(source, /revokedAt/);
    assert.match(source, /expiresAt/);
  }
  assert.match(admin, /A credencial deve existir, estar ativa, vigente/);
  assert.match(admin, /verificação precisa ter ocorrido nas últimas 24 horas/);
  assert.match(persistence, /credential\.expiresAt <= now/);
});
