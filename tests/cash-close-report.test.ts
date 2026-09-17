import assert from "node:assert/strict";
import test from "node:test";
import {
  cashCloseCsv,
  cashCloseRanking,
  CashCloseReportError,
  type CashCloseReportRow,
  cashCloseSummary,
  cashCloseTrend,
  parseCashCloseQuery,
  signedCashMovement,
} from "../lib/erp/cash-close-report";

const rows: CashCloseReportRow[] = [
  { id: 1, status: "closed", businessDate: new Date("2026-08-01T00:00:00Z"), openedAt: new Date("2026-08-01T10:00:00Z"), closedAt: new Date("2026-08-01T18:00:00Z"), registerId: 1, registerName: "Caixa 01", branchId: 1, branchName: "Matriz", operatorProfileId: 10, operatorName: "Ana", salesCents: 125_000, salesCount: 12, suppliesCents: 10_000, withdrawalsCents: 20_000, expectedAmountCents: 120_000, closingAmountCents: 119_500, differenceCents: -500 },
  { id: 2, status: "closed", businessDate: new Date("2026-08-01T00:00:00Z"), openedAt: new Date("2026-08-01T11:00:00Z"), closedAt: new Date("2026-08-01T17:00:00Z"), registerId: 2, registerName: "Caixa 02", branchId: 1, branchName: "Matriz", operatorProfileId: 11, operatorName: "Bia", salesCents: 80_000, salesCount: 8, suppliesCents: 0, withdrawalsCents: 5_000, expectedAmountCents: 75_000, closingAmountCents: 75_000, differenceCents: 0 },
  { id: 3, status: "open", businessDate: new Date("2026-08-02T00:00:00Z"), openedAt: new Date("2026-08-02T10:00:00Z"), closedAt: null, registerId: 1, registerName: "Caixa 01", branchId: 1, branchName: "Matriz", operatorProfileId: 10, operatorName: "Ana", salesCents: 30_000, salesCount: 3, suppliesCents: 2_000, withdrawalsCents: 0, expectedAmountCents: null, closingAmountCents: null, differenceCents: null },
];

test("valida filtros, período, paginação e formato do relatório", () => {
  const query = parseCashCloseQuery(new URLSearchParams("from=2026-08-01&to=2026-08-31&status=closed&page=2&pageSize=50&divergentOnly=true&sort=difference_desc"), new Date("2026-09-03T10:00:00Z"));
  assert.equal(query.status, "closed"); assert.equal(query.page, 2); assert.equal(query.pageSize, 50); assert.equal(query.divergentOnly, true); assert.equal(query.to.toISOString(), "2026-08-31T23:59:59.999Z");
  assert.throws(() => parseCashCloseQuery(new URLSearchParams("from=2025-01-01&to=2026-09-01")), CashCloseReportError);
  assert.throws(() => parseCashCloseQuery(new URLSearchParams("status=invalid")), CashCloseReportError);
  assert.throws(() => parseCashCloseQuery(new URLSearchParams("pageSize=20")), CashCloseReportError);
});

test("movimentos de numerário preservam o sinal operacional", () => {
  assert.equal(signedCashMovement("supply", -1_000), 1_000);
  assert.equal(signedCashMovement("withdrawal", 1_000), -1_000);
  assert.equal(signedCashMovement("adjustment", -250), -250);
});

test("resumo não permite que sobras e faltas escondam a diferença absoluta", () => {
  const summary = cashCloseSummary(rows, 100);
  assert.deepEqual({ open: summary.open, closed: summary.closed, divergent: summary.divergent }, { open: 1, closed: 2, divergent: 1 });
  assert.equal(summary.salesCents, 235_000); assert.equal(summary.differenceCents, -500); assert.equal(summary.absoluteDifferenceCents, 500);
  assert.equal(summary.exactRate, 50); assert.equal(summary.averageDurationMinutes, 420);
});

test("tendência e ranking usam data de negócio e vendas vinculadas ao turno", () => {
  const trend = cashCloseTrend(rows);
  assert.deepEqual(trend.map((item) => [item.date, item.salesCents, item.closed]), [["2026-08-01", 205_000, 2], ["2026-08-02", 30_000, 0]]);
  const ranking = cashCloseRanking(rows, "register");
  assert.equal(ranking[0].name, "Caixa 01"); assert.equal(ranking[0].salesCents, 155_000); assert.equal(ranking[0].differenceCents, 500);
});

test("CSV protege fórmulas e nunca revela esperado de turno aberto", () => {
  const csv = cashCloseCsv([{ ...rows[2], registerName: "=CMD()" }]);
  assert.match(csv, /'\=CMD\(\)/); assert.match(csv, /Oculto até o fechamento/); assert.doesNotMatch(csv, /undefined|null/);
});
