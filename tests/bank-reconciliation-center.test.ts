import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  operationHash,
  parseReconciliationQuery,
  parseStatementDocument,
  reconciliationCsv,
  reconciliationInput,
  reconciliationSummary,
  reconciliationTrend,
  resolutionInput,
  titleSuggestions,
} from "../lib/erp/reconciliation-control";

const ui = readFileSync("components/erp/bank-reconciliation-center.tsx", "utf8");
const css = readFileSync("components/erp/bank-reconciliation-center.module.css", "utf8");
const shell = readFileSync("app/erp/erp-client.tsx", "utf8");
const route = readFileSync("app/api/erp/reconciliation/route.ts", "utf8");
const schema = readFileSync("prisma/tenant/schema.prisma", "utf8");
const migration = readFileSync("prisma/tenant/migrations/20260903020000_bank_reconciliation_control_center/migration.sql", "utf8");
const seed = readFileSync("scripts/seed-demo-finance.ts", "utf8");

test("consulta limita período, filtros e paginação", () => {
  const query = parseReconciliationQuery(new URLSearchParams("from=2026-08-01&to=2026-09-03&status=ignored&direction=debit&accountId=4&page=2&pageSize=25&search=tarifa"), new Date("2026-09-03T12:00:00Z"));
  assert.equal(query.from.toISOString(), "2026-08-01T00:00:00.000Z");
  assert.equal(query.to.toISOString(), "2026-09-03T23:59:59.999Z");
  assert.equal(query.status, "ignored");
  assert.equal(query.direction, "debit");
  assert.equal(query.accountId, 4);
  assert.equal(query.page, 2);
  assert.throws(() => parseReconciliationQuery(new URLSearchParams("from=2024-01-01&to=2026-09-03")), /732 dias/);
  assert.throws(() => parseReconciliationQuery(new URLSearchParams("pageSize=40")), /25, 50 ou 100/);
});

test("CSV aceita aspas, formato brasileiro, IDs gerados e duplicidade idêntica", () => {
  const parsed = parseStatementDocument("data;descrição;valor;id externo;documento\n03/09/2026;\"Recebimento; contrato\";1.234,56;PIX-001;DOC-10\n2026-09-02;Tarifa;-10,50;;TAR-01\n2026-09-02;Tarifa;-10,50;;TAR-01", "extrato.csv");
  assert.equal(parsed.format, "csv");
  assert.equal(parsed.rowCount, 3);
  assert.equal(parsed.rows.length, 3);
  assert.equal(parsed.totalCreditCents, 123_456);
  assert.equal(parsed.totalDebitCents, 2_100);
  assert.match(parsed.rows[1].externalId, /^AUTO-/);
  assert.notEqual(parsed.rows[1].externalId, parsed.rows[2].externalId);
  assert.throws(() => parseStatementDocument("date;description;amount;external_id\n2026-09-01;Alpha;10;SAME\n2026-09-02;Beta;20;SAME", "bad.csv"), /dados diferentes/);
});

test("OFX é interpretado sem depender de tags de fechamento", () => {
  const ofx = "OFXHEADER:100\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST><STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260903120000[-3:BRT]<TRNAMT>42.35<FITID>OFX-1<MEMO>Crédito do cliente<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260902120000[-3:BRT]<TRNAMT>-12.10<FITID>OFX-2<MEMO>Tarifa bancária</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>";
  const parsed = parseStatementDocument(ofx, "conta.ofx");
  assert.equal(parsed.format, "ofx");
  assert.deepEqual(parsed.rows.map((row) => row.amountCents), [4_235, -1_210]);
});

test("conciliação valida justificativa, categoria, rateio e idempotência canônica", () => {
  const input = reconciliationInput({ transactionId: 7, requestId: "request-123", reason: "Conferido com o banco.", allocations: [{ titleId: 4, amount: "1.210,25" }] });
  assert.equal(input.allocations[0].amountCents, 121_025);
  assert.throws(() => reconciliationInput({ transactionId: 7, requestId: "request-123", reason: "Curto", allocations: [] }), /Justificativa/);
  assert.throws(() => reconciliationInput({ transactionId: 7, requestId: "request-123", reason: "Classificado manualmente", category: "Inválida", allocations: [] }), /categoria/);
  assert.throws(() => resolutionInput({ transactionId: 7, requestId: "request-123", reason: "não" }, "Motivo"), /Motivo/);
  assert.equal(operationHash("ignore", 7, { b: 2, a: 1 }), operationHash("ignore", 7, { a: 1, b: 2 }));
});

test("motor sugere apenas correspondência exata, forte e inequívoca", () => {
  const transaction = { amountCents: 63_500, occurredAt: new Date("2026-09-03T00:00:00Z"), description: "Contrato DOC-77", documentNumber: "DOC-77" };
  const base = { type: "receivable", status: "open", amount: 635, paidAmount: 0, dueAt: new Date("2026-09-04T00:00:00Z"), customer: { name: "Cliente", tradeName: null }, supplier: null };
  const unique = titleSuggestions(transaction, [{ id: 1, ...base, description: "Contrato mensal", documentNumber: "DOC-77" }]);
  assert.equal(unique[0].recommended, true);
  const ambiguous = titleSuggestions(transaction, [
    { id: 1, ...base, description: "Contrato mensal", documentNumber: "DOC-77" },
    { id: 2, ...base, description: "Contrato mensal", documentNumber: "DOC-77" },
  ]);
  assert.equal(ambiguous.some((item) => item.recommended), false);
});

test("indicadores, tendência e CSV preservam centavos e neutralizam fórmulas", () => {
  const rows = [
    { status: "pending", amountCents: 10_000, occurredAt: new Date("2026-09-01T00:00:00Z") },
    { status: "reconciled", amountCents: -2_500, occurredAt: new Date("2026-09-01T00:00:00Z") },
    { status: "ignored", amountCents: -100, occurredAt: new Date("2026-09-02T00:00:00Z") },
  ];
  assert.deepEqual(reconciliationSummary(rows, 1), { pending: 1, pendingCents: 10_000, pendingCreditsCents: 10_000, pendingDebitsCents: 0, reconciled: 1, reconciledCents: 2_500, ignored: 1, automation: 1, rate: 33.33, creditsCents: 10_000, debitsCents: 2_600 });
  assert.deepEqual(reconciliationTrend(rows), [
    { date: "2026-09-01", creditsCents: 10_000, debitsCents: 2_500, pending: 1, reconciled: 1, ignored: 0 },
    { date: "2026-09-02", creditsCents: 0, debitsCents: 100, pending: 0, reconciled: 0, ignored: 1 },
  ]);
  const csv = reconciliationCsv([{ occurredAt: new Date("2026-09-03T00:00:00Z"), accountCode: "B1", accountName: "Banco", description: "=CMD", externalId: "+PIX", documentNumber: null, amountCents: -1_050, status: "pending", resolutionType: null, category: null, matchedDocuments: "", reconciledBy: null, reconciledAt: null }]);
  assert.match(csv, /"'=CMD"/); assert.match(csv, /"'\+PIX"/); assert.match(csv, /"-10,50"/);
});

test("API protege escrita, dinheiro, concorrência, estorno e respostas", () => {
  for (const marker of ["reconciliation.read", "reconciliation.write", "assertSameOrigin", "readPosJson", "4_194_304", "assertTenantWriteAccess", "amountCents", "operationReplay", "existingById", "dados diferentes", "tenantAuditEvent", "private, no-store", "auto_reconcile", "reopen"])
    assert.match(route, new RegExp(marker.replace(".", "\\.")));
  assert.match(route, /isolationLevel: "Serializable"/);
  assert.match(route, /FOR UPDATE/);
  assert.match(route, /reversalOfId/);
  assert.match(route, /10_001/);
  assert.doesNotMatch(route, /error instanceof Error \? error\.message/);
});

test("persistência mantém fonte imutável, rateios, operações e compatibilidade de deploy", () => {
  for (const marker of ["amount_cents", "bank_reconciliation_allocations", "bank_reconciliation_operations", "bank_transactions_source_guard", "bank_statement_imports_history_guard", "sync_bank_statement_import_compat", "bank_reconciliation_allocations_source_guard"])
    assert.match(migration, new RegExp(marker));
  assert.match(schema, /model BankReconciliationAllocation/);
  assert.match(schema, /model BankReconciliationOperation/);
  assert.match(schema, /reconciliationAllocations/);
});

test("interface substitui o legado e cobre operação completa, mobile e acessibilidade", () => {
  assert.match(shell, /if \(page === "reconciliation"\) return <BankReconciliationCenter \/>/);
  for (const label of ["Fila de conciliação", "Resolvidos", "Importações", "Análises", "Exportar CSV", "Importar extrato", "Sugestões explicáveis", "Classificar sem título", "Reabrir e estornar", "Automação conservadora"])
    assert.match(ui, new RegExp(label, "i"));
  assert.match(css, /@media\(max-width:430px\)/);
  assert.match(css, /@media\(pointer:coarse\)/);
  assert.doesNotMatch(css, /font-size:\s*[4-9](?:\.\d+)?px/);
  assert.match(css, /min-height:43px/);
});

test("seed demo é protegido, idempotente e cobre múltiplos cenários bancários", () => {
  assert.match(seed, /NALVEN_ALLOW_DEMO_FINANCE_SEED/);
  assert.match(seed, /nalven_t_demo_runtime/);
  for (const marker of ["DEMO-BANK-001", "DEMO-BANK-019", "bankStatementImport", "bankTransaction", "reconciled", "ignored", "pending"])
    assert.match(seed, new RegExp(marker));
});
