import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { agingBuckets, cashForecast, financeSummary, settlementCashAmount } from "../lib/erp/finance-control";
import { addFrequency, financialSeriesInput, financialTitleInput, settlementInput, splitAmount } from "../lib/erp/finance-input";

const ui = readFileSync("components/erp/finance-control-center.tsx", "utf8");
const css = readFileSync("components/erp/finance-control-center.module.css", "utf8");
const route = readFileSync("app/api/erp/finance/route.ts", "utf8");
const itemRoute = readFileSync("app/api/erp/finance/[id]/route.ts", "utf8");
const batchRoute = readFileSync("app/api/erp/finance/batch/route.ts", "utf8");
const schema = readFileSync("prisma/tenant/schema.prisma", "utf8");
const migration = readFileSync("prisma/tenant/migrations/20260902234000_finance_control_center/migration.sql", "utf8");
const seed = readFileSync("scripts/seed-demo-finance.ts", "utf8");

test("entrada financeira valida partes, classificação e série", () => {
  const input = financialTitleInput({ type: "receivable", description: "Contrato mensal", amount: "1250.45", dueAt: "2026-09-30", customerId: "2", priority: "high", paymentMethod: "pix" });
  assert.equal(input.amount, 1250.45);
  assert.equal(input.customerId, 2);
  assert.equal(financialSeriesInput({ seriesMode: "recurring", installmentCount: 12, frequency: "monthly" }).count, 12);
  assert.throws(() => financialTitleInput({ type: "payable", description: "Conta inválida", amount: 10, dueAt: "2026-09-30", customerId: 2 }), /cliente/i);
  assert.throws(() => settlementInput({ amount: 90, discount: 20, method: "pix" }, 100), /superam/);
});

test("parcelamento preserva centavos e datas de fim do mês", () => {
  const amounts = splitAmount(100, 3);
  assert.deepEqual(amounts, [33.34, 33.33, 33.33]);
  assert.equal(addFrequency(new Date("2026-01-31T00:00:00Z"), "monthly", 1).toISOString().slice(0, 10), "2026-02-28");
});

test("indicadores, aging e projeção usam apenas saldos abertos", () => {
  const titles = [
    { type: "receivable", status: "open", amount: 1000, paidAmount: 200, dueAt: new Date("2026-08-20") },
    { type: "payable", status: "open", amount: 300, paidAmount: 0, dueAt: new Date("2026-09-05") },
    { type: "receivable", status: "paid", amount: 500, paidAmount: 500, dueAt: new Date("2026-08-01") },
    { type: "payable", status: "cancelled", amount: 900, paidAmount: 0, dueAt: new Date("2026-08-01") },
  ];
  const summary = financeSummary(titles, 2500, new Date("2026-09-02"));
  assert.equal(summary.receivable, 800);
  assert.equal(summary.payable, 300);
  assert.equal(summary.overdue, 800);
  assert.equal(agingBuckets(titles, new Date("2026-09-02")).find((row) => row.key === "8_30")?.receivable, 800);
  assert.equal(cashForecast(titles, 2500, new Date("2026-09-02"), 1)[0].balance, 2200);
  assert.equal(settlementCashAmount("receivable", 100, 10, 3), 107);
  assert.equal(settlementCashAmount("payable", 100, 10, 3), 113);
});

test("API oferece filtros, paginação, CSV seguro e análises", () => {
  for (const marker of ["pagination", "agingBuckets", "cashForecast", "format", "csvCell", "branchId", "costCenterId", "accountBalance"])
    assert.match(route, new RegExp(marker));
  assert.match(route, /take: 10_000/);
  assert.match(route, /private, no-store/);
  assert.doesNotMatch(route, /error instanceof Error \? error\.message/);
});

test("baixa, estorno e lote são transacionais, bloqueados e auditados", () => {
  for (const source of [itemRoute, batchRoute]) {
    assert.match(source, /Serializable/);
    assert.match(source, /FOR UPDATE/);
    assert.match(source, /tenantAuditEvent/);
  }
  for (const marker of ["reverse_settlement", "financial_settlement_reversal", "accountEntry.create", "currentBalance"])
    assert.match(itemRoute, new RegExp(marker.replace(".", "\\.")));
  assert.match(batchRoute, /Prisma\.join/);
});

test("modelo persiste classificação, parcelas, conta e estorno", () => {
  for (const marker of ["competenceAt", "recurrenceKey", "installmentNumber", "costCenter", "reversalReason", "occurredAt"])
    assert.match(schema, new RegExp(marker));
  assert.match(migration, /financial_titles_priority_check/);
  assert.match(migration, /financial_settlements_status_check/);
});

test("interface cobre carteira, fluxo, aging, ações e mobile sem microtexto", () => {
  for (const label of ["Fluxo de caixa", "Aging e concentração", "Índice de recebimento", "Dar baixa", "Estornar", "Duplicar", "Reagendar", "Exportar CSV", "Forma do lançamento", "Conta financeira"])
    assert.match(ui, new RegExp(label));
  assert.match(css, /@media\(max-width:430px\)/);
  assert.doesNotMatch(css, /font-size:\s*[4-9](?:\.\d+)?px/);
  assert.match(css, /min-height:43px/);
});

test("seed demonstrativo é idempotente, protegido e diversificado", () => {
  assert.match(seed, /NALVEN_ALLOW_DEMO_FINANCE_SEED/);
  assert.match(seed, /nalven_t_demo_runtime/);
  assert.match(seed, /upsert/);
  for (const value of ["paid", "partial", "open", "cancelled", "urgent", "recurrenceKey"])
    assert.match(seed, new RegExp(value));
});
