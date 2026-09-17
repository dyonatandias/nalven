import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  accountInput,
  accountsCsv,
  accountsSummary,
  accountTrend,
  manualEntryInput,
  parseAccountsQuery,
  transferInput,
} from "../lib/erp/accounts-control";

const ui = readFileSync("components/erp/accounts-control-center.tsx", "utf8");
const css = readFileSync("components/erp/accounts-control-center.module.css", "utf8");
const shell = readFileSync("app/erp/erp-client.tsx", "utf8");
const route = readFileSync("app/api/erp/accounts/route.ts", "utf8");
const schema = readFileSync("prisma/tenant/schema.prisma", "utf8");
const migration = readFileSync("prisma/tenant/migrations/20260903010000_financial_accounts_control_center/migration.sql", "utf8");
const seed = readFileSync("scripts/seed-demo-finance.ts", "utf8");

test("consulta aplica janela inclusiva, filtros e paginação limitada", () => {
  const result = parseAccountsQuery(new URLSearchParams("from=2026-08-01&to=2026-09-03&type=bank&status=all&page=2&pageSize=25&search=PIX"), new Date("2026-09-03T13:00:00Z"));
  assert.equal(result.from.toISOString(), "2026-08-01T00:00:00.000Z");
  assert.equal(result.to.toISOString(), "2026-09-03T23:59:59.999Z");
  assert.equal(result.type, "bank");
  assert.equal(result.page, 2);
  assert.equal(result.pageSize, 25);
  assert.throws(() => parseAccountsQuery(new URLSearchParams("from=2024-01-01&to=2026-09-03")), /732 dias/);
  assert.throws(() => parseAccountsQuery(new URLSearchParams("type=crypto")), /Tipo de conta/);
  assert.throws(() => parseAccountsQuery(new URLSearchParams("pageSize=40")), /25, 50 ou 100/);
});

test("entradas de conta normalizam centavos e bloqueiam operações ambíguas", () => {
  const account = accountInput({ code: " banco matriz ", name: "Conta operacional", type: "bank", creditLimit: "1250,90", openingBalance: "-35.20", color: "#168151" });
  assert.equal(account.code, "BANCO-MATRIZ");
  assert.equal(account.creditLimitCents, 125_090);
  assert.equal(account.openingBalanceCents, -3_520);
  const entry = manualEntryInput({ accountId: 4, type: "credit", amount: "18,37", description: "Recebimento PIX", occurredAt: "2026-09-03", requestId: "request-123" });
  assert.equal(entry.amountCents, 1_837);
  assert.throws(() => manualEntryInput({ accountId: 4, type: "debit", amount: "1.999", description: "Inválido", requestId: "request-123" }), /monetário/);
  assert.throws(() => transferInput({ fromAccountId: 2, toAccountId: 2, amount: 10, requestId: "request-123" }), /diferentes/);
});

test("indicadores e série preservam saldo, disponibilidade e fluxo", () => {
  const accounts = [
    { id: 1, type: "bank", active: true, currentBalanceCents: 10_000, creditLimitCents: 2_000, ledgerBalanceCents: 10_000, pendingReconciliation: 2 },
    { id: 2, type: "cash", active: true, currentBalanceCents: 3_500, creditLimitCents: 0, ledgerBalanceCents: 3_400, pendingReconciliation: 0 },
    { id: 3, type: "wallet", active: false, currentBalanceCents: 9_000, creditLimitCents: 0, ledgerBalanceCents: 9_000, pendingReconciliation: 0 },
  ];
  const entries = [
    { occurredAt: new Date("2026-09-01T12:00:00Z"), type: "credit", amountCents: 5_000 },
    { occurredAt: new Date("2026-09-01T14:00:00Z"), type: "debit", amountCents: 1_200 },
    { occurredAt: new Date("2026-09-02T12:00:00Z"), type: "debit", amountCents: 800 },
  ];
  const summary = accountsSummary(accounts, entries);
  assert.equal(summary.balanceCents, 13_500);
  assert.equal(summary.availableCents, 15_500);
  assert.equal(summary.cashCents, 3_500);
  assert.equal(summary.inactive, 1);
  assert.equal(summary.pendingReconciliation, 2);
  assert.equal(summary.drifted, 1);
  assert.deepEqual(accountTrend(entries), [
    { date: "2026-09-01", inflowCents: 5_000, outflowCents: 1_200, netCents: 3_800, count: 2 },
    { date: "2026-09-02", inflowCents: 0, outflowCents: 800, netCents: -800, count: 1 },
  ]);
});

test("CSV neutraliza fórmula e conserva formato brasileiro", () => {
  const csv = accountsCsv([{ occurredAt: new Date("2026-09-03T00:00:00Z"), accountCode: "CX-01", accountName: "Caixa",
    type: "credit", description: "=HYPERLINK(\"https://invalid\")", reference: "+CMD", sourceType: "manual",
    amountCents: 1_050, balanceAfterCents: 2_500, createdBy: "Operador" }]);
  assert.ok(csv.startsWith("\uFEFF"));
  assert.match(csv, /"'=HYPERLINK/);
  assert.match(csv, /"'\+CMD"/);
  assert.match(csv, /"10,50"/);
});

test("API usa autorização, limites, centavos, idempotência, bloqueio e auditoria", () => {
  for (const marker of ["accounts.read", "accounts.write", "assertSameOrigin", "readPosJson", "assertTenantWriteAccess", "amountCents", "idempotencyKey", "tenantAuditEvent", "private, no-store"])
    assert.match(route, new RegExp(marker.replace(".", "\\.")));
  assert.match(route, /isolationLevel: "Serializable"/);
  assert.match(route, /FOR UPDATE/);
  assert.match(route, /sourceType_sourceId_accountId/);
  assert.match(route, /action === "entry\.reverse"/);
  assert.match(route, /action === "transfer\.reverse"/);
  assert.doesNotMatch(route, /error instanceof Error \? error\.message/);
  const publicTransferSelect = route.match(/const transferSelect = \{[\s\S]+?\} satisfies Prisma\.AccountTransferSelect;/)?.[0] || "";
  assert.ok(publicTransferSelect);
  assert.doesNotMatch(publicTransferSelect, /idempotencyKey|correlationId/);
});

test("migração protege razão imutável e compatibilidade monetária", () => {
  for (const marker of ["opening_balance_cents", "balance_after_cents", "prepare_account_entry_append", "FOR UPDATE", "account_entries_history_guard", "account_transfers_reversal_check", "financial_accounts_money_sync"])
    assert.match(migration, new RegExp(marker));
  assert.match(schema, /model FinancialAccount[\s\S]+creditLimitCents/);
  assert.match(schema, /model AccountEntry[\s\S]+reversalOfId/);
  assert.match(schema, /model AccountTransfer[\s\S]+reversalIdempotencyKey/);
});

test("interface substitui legado e cobre operação completa, responsiva e sem microtexto", () => {
  assert.match(shell, /if \(page === "accounts"\) return <AccountsControlCenter \/>/);
  for (const label of ["Contas e caixas", "Visão geral", "Extrato", "Transferências", "Saúde e conciliação", "Exportar CSV", "Estornar lançamento", "Estornar transferência", "Limite disponível", "A conciliar"])
    assert.match(ui, new RegExp(label));
  assert.match(ui, /modal\.mode === "edit" \? "update"/);
  assert.match(css, /@media\(max-width:430px\)/);
  assert.match(css, /@media\(pointer:coarse\)/);
  assert.doesNotMatch(css, /font-size:\s*[4-9](?:\.\d+)?px/);
});

test("seed demonstrativo é restrito, idempotente e inclui cenários de tesouraria", () => {
  assert.match(seed, /NALVEN_ALLOW_DEMO_FINANCE_SEED/);
  assert.match(seed, /nalven_t_demo_runtime/);
  for (const marker of ["BANCO-NALVEN", "CAIXA-MATRIZ", "WALLET-MARKET", "upsert", "accountEntry", "accountTransfer"])
    assert.match(seed, new RegExp(marker));
});
