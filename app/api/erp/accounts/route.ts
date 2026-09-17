import { randomUUID } from "node:crypto";
import { Prisma } from "@/generated/tenant/client";
import { currentOrganization, tenantDb } from "@/db";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import {
  accountInput,
  accountStateInput,
  AccountsControlError,
  accountsCsv,
  accountsSummary,
  accountTrend,
  centsToAmount,
  manualEntryInput,
  parseAccountsQuery,
  reversalInput,
  transferInput,
  transferReversalInput,
} from "@/lib/erp/accounts-control";
import { assertSameOrigin, CustomerInputError } from "@/lib/erp/customer-input";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { PosHttpError, readPosJson } from "@/lib/erp/pos-http";
import { assertTenantWriteAccess } from "@/lib/tenant-access";

type Db = Awaited<ReturnType<typeof tenantDb>>;
type Tx = Prisma.TransactionClient;
const noStore = { "cache-control": "private, no-store, max-age=0", expires: "0", pragma: "no-cache" };

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const organization = await currentOrganization();
    await assertTenantPermission(organization.id, "accounts.read");
    const query = parseAccountsQuery(new URL(request.url).searchParams);
    const db = await tenantDb(organization.id);
    const baseAccountWhere: Prisma.FinancialAccountWhereInput = {
      ...(query.status === "active" ? { active: true } : query.status === "inactive" ? { active: false } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.accountId ? { id: query.accountId } : {}),
    };
    const accounts = await db.financialAccount.findMany({
      where: baseAccountWhere,
      select: { id: true, code: true, name: true, type: true, currency: true, branchId: true, description: true,
        institutionName: true, bankCode: true, agency: true, accountNumberLast4: true, color: true,
        openingBalanceCents: true, currentBalanceCents: true, creditLimitCents: true, version: true, active: true,
        archivedAt: true, createdAt: true, updatedAt: true, branch: { select: { id: true, code: true, name: true } } },
      orderBy: [{ active: "desc" }, { name: "asc" }],
    });
    const accountIds = accounts.map((account) => account.id);
    const entryWhere: Prisma.AccountEntryWhereInput = {
      accountId: { in: accountIds }, occurredAt: { gte: query.from, lte: query.to },
      ...(query.search ? { OR: [
        { description: { contains: query.search, mode: "insensitive" } }, { reference: { contains: query.search, mode: "insensitive" } },
        { createdBy: { contains: query.search, mode: "insensitive" } }, { account: { name: { contains: query.search, mode: "insensitive" } } },
        { account: { code: { contains: query.search, mode: "insensitive" } } },
        { account: { institutionName: { contains: query.search, mode: "insensitive" } } },
        { account: { description: { contains: query.search, mode: "insensitive" } } },
      ] } : {}),
    };
    const [entryTotal, periodEntries, entries, transfers, ledgerGroups, pendingGroups, titleGroups, branches, accountOptions] = await Promise.all([
      db.accountEntry.count({ where: entryWhere }),
      db.accountEntry.findMany({ where: entryWhere, select: { accountId: true, occurredAt: true, type: true, amountCents: true, sourceType: true } }),
      db.accountEntry.findMany({ where: entryWhere, select: entrySelect, orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        skip: query.format === "csv" ? 0 : (query.page - 1) * query.pageSize, take: query.format === "csv" ? 10_001 : query.pageSize }),
      accountIds.length ? db.accountTransfer.findMany({ where: { createdAt: { gte: query.from, lte: query.to }, OR: [{ fromAccountId: { in: accountIds } }, { toAccountId: { in: accountIds } }] }, select: transferSelect, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 250 }) : [],
      accountIds.length ? db.accountEntry.groupBy({ by: ["accountId", "type"], where: { accountId: { in: accountIds } }, _sum: { amountCents: true }, _count: { _all: true } }) : [],
      accountIds.length ? db.bankTransaction.groupBy({ by: ["accountId"], where: { accountId: { in: accountIds }, status: "pending" }, _count: { _all: true } }) : [],
      accountIds.length ? db.financialTitle.groupBy({ by: ["accountId"], where: { accountId: { in: accountIds }, status: { in: ["open", "partial"] } }, _sum: { amount: true, paidAmount: true }, _count: { _all: true } }) : [],
      db.branch.findMany({ where: { status: "active" }, select: { id: true, code: true, name: true }, orderBy: [{ primary: "desc" }, { name: "asc" }] }),
      db.financialAccount.findMany({ where: { active: true }, select: { id: true, code: true, name: true, type: true,
        currentBalanceCents: true, creditLimitCents: true, color: true }, orderBy: { name: "asc" } }),
    ]);
    if (query.format === "csv") {
      if (entries.length > 10_000) throw new AccountsControlError("O extrato excede 10.000 linhas. Reduza o período ou aplique mais filtros.", 413);
      return new Response(accountsCsv(entries.map((entry) => ({ occurredAt: entry.occurredAt, accountCode: entry.account.code,
        accountName: entry.account.name, type: entry.type, description: entry.description, reference: entry.reference,
        sourceType: entry.sourceType, amountCents: entry.amountCents, balanceAfterCents: entry.balanceAfterCents, createdBy: entry.createdBy }))),
      { headers: { ...noStore, "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="extrato-contas-${query.from.toISOString().slice(0, 10)}-${query.to.toISOString().slice(0, 10)}.csv"` } });
    }
    const ledger = new Map<number, { credits: number; debits: number; count: number }>();
    for (const group of ledgerGroups) {
      const item = ledger.get(group.accountId) || { credits: 0, debits: 0, count: 0 };
      if (group.type === "credit") item.credits = group._sum.amountCents || 0; else item.debits = group._sum.amountCents || 0;
      item.count += group._count._all; ledger.set(group.accountId, item);
    }
    const pending = new Map(pendingGroups.map((group) => [group.accountId, group._count._all]));
    const titles = new Map(titleGroups.map((group) => [group.accountId, { count: group._count._all,
      amountCents: Math.round(((group._sum.amount || 0) - (group._sum.paidAmount || 0)) * 100) }]));
    const matchedEntryAccounts = new Set(periodEntries.map((entry) => entry.accountId));
    const normalizedSearch = query.search.toLocaleLowerCase("pt-BR");
    const visibleAccounts = query.search ? accounts.filter((account) => matchedEntryAccounts.has(account.id) ||
      [account.code, account.name, account.institutionName, account.description, account.agency, account.accountNumberLast4]
        .some((value) => value?.toLocaleLowerCase("pt-BR").includes(normalizedSearch))) : accounts;
    const accountDtos = visibleAccounts.map((account) => {
      const movement = ledger.get(account.id) || { credits: 0, debits: 0, count: 0 };
      const ledgerBalanceCents = account.openingBalanceCents + movement.credits - movement.debits;
      return { ...account, ledgerBalanceCents, driftCents: account.currentBalanceCents - ledgerBalanceCents,
        availableBalanceCents: account.currentBalanceCents + account.creditLimitCents, entryCount: movement.count,
        pendingReconciliation: pending.get(account.id) || 0, plannedTitles: titles.get(account.id) || { count: 0, amountCents: 0 } };
    });
    const sourceMap = new Map<string, { sourceType: string; inflowCents: number; outflowCents: number; count: number }>();
    for (const entry of periodEntries) {
      const item = sourceMap.get(entry.sourceType) || { sourceType: entry.sourceType, inflowCents: 0, outflowCents: 0, count: 0 };
      if (entry.type === "credit") item.inflowCents += entry.amountCents; else item.outflowCents += entry.amountCents;
      item.count += 1; sourceMap.set(entry.sourceType, item);
    }
    return Response.json({
      generatedAt: new Date(), window: { from: query.from, to: query.to }, accounts: accountDtos, entries,
      transfers, branches, accountOptions: accountOptions.map((account) => ({ ...account,
        availableBalanceCents: account.currentBalanceCents + account.creditLimitCents })),
      summary: accountsSummary(accountDtos, periodEntries), trend: accountTrend(periodEntries),
      sources: [...sourceMap.values()].sort((left, right) => right.count - left.count),
      pagination: { page: query.page, pageSize: query.pageSize, total: entryTotal, pages: Math.max(1, Math.ceil(entryTotal / query.pageSize)) },
    }, { headers: noStore });
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const organization = await currentOrganization();
    const access = await assertTenantPermission(organization.id, "accounts.write");
    await assertTenantWriteAccess(organization.id);
    const body = await readPosJson(request, 65_536) as Record<string, unknown>;
    const action = String(body.action || "");
    const db = await tenantDb(organization.id);
    const correlationId = randomUUID();
    if (action === "create") {
      const input = accountInput(body);
      await assertBranch(db, input.branchId);
      const openingBalanceCents = input.openingBalanceCents ?? 0;
      const account = await db.financialAccount.create({ data: { ...input, openingBalanceCents,
        openingBalance: centsToAmount(openingBalanceCents), currentBalance: centsToAmount(openingBalanceCents),
        creditLimit: centsToAmount(input.creditLimitCents), currentBalanceCents: openingBalanceCents }, select: accountMutationSelect });
      await audit(db, access.user.id, "financial_account.created", account.id, correlationId, null, safeAccount(account));
      return Response.json({ account, correlationId }, { status: 201, headers: noStore });
    }
    if (action === "update") {
      const id = positiveId(body.id);
      const input = accountInput(body, true);
      await assertBranch(db, input.branchId);
      const account = await db.$transaction(async (tx) => {
        await lockAccounts(tx, [id]);
        const before = await tx.financialAccount.findUnique({ where: { id }, select: accountMutationSelect });
        if (!before) throw new AccountsControlError("Conta não encontrada.", 404);
        const updated = await tx.financialAccount.update({ where: { id }, data: { ...input,
          creditLimit: centsToAmount(input.creditLimitCents), version: { increment: 1 } }, select: accountMutationSelect });
        await audit(tx, access.user.id, "financial_account.updated", id, correlationId, safeAccount(before), safeAccount(updated));
        return updated;
      }, { isolationLevel: "Serializable" });
      return Response.json({ account, correlationId }, { headers: noStore });
    }
    if (action === "entry") {
      const input = manualEntryInput(body);
      const result = await db.$transaction(async (tx) => {
        await lockAccounts(tx, [input.accountId]);
        const account = await activeAccount(tx, input.accountId);
        const replay = await tx.accountEntry.findUnique({ where: { sourceType_sourceId_accountId: { sourceType: "manual", sourceId: input.requestId, accountId: input.accountId } }, select: entrySelect });
        if (replay) {
          if (replay.type !== input.type || replay.amountCents !== input.amountCents || replay.description !== input.description)
            throw new AccountsControlError("Este identificador já foi usado com dados diferentes.", 409);
          return { entry: replay, replayed: true };
        }
        assertFunds(account, input.type, input.amountCents);
        const entry = await appendEntry(tx, account, { type: input.type, amountCents: input.amountCents, description: input.description,
          reference: input.reference, sourceType: "manual", sourceId: input.requestId, occurredAt: input.occurredAt,
          createdBy: access.user.name, correlationId });
        await audit(tx, access.user.id, "account_entry.created", entry.id, correlationId, null,
          { accountId: account.id, type: input.type, amountCents: input.amountCents, sourceType: "manual" }, "account_entry");
        return { entry, replayed: false };
      }, { isolationLevel: "Serializable" });
      return Response.json({ ...result, correlationId }, { status: result.replayed ? 200 : 201, headers: noStore });
    }
    if (action === "entry.reverse") {
      const input = reversalInput(body);
      const originalLocator = await db.accountEntry.findUnique({ where: { id: input.id }, select: { accountId: true } });
      if (!originalLocator) throw new AccountsControlError("Lançamento não encontrado.", 404);
      const result = await db.$transaction(async (tx) => {
        await lockAccounts(tx, [originalLocator.accountId]);
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "account_entries" WHERE "id"=${input.id} FOR UPDATE`);
        const original = await tx.accountEntry.findUnique({ where: { id: input.id }, include: { reversedBy: true } });
        if (!original || original.sourceType !== "manual") throw new AccountsControlError("Somente lançamentos manuais podem ser estornados aqui.");
        if (original.reversedBy) {
          if (original.reversedBy.sourceId === input.requestId) return { entry: original.reversedBy, replayed: true };
          throw new AccountsControlError("Este lançamento já foi estornado.", 409);
        }
        const account = await activeAccount(tx, original.accountId);
        const reverseType = original.type === "credit" ? "debit" : "credit";
        assertFunds(account, reverseType, original.amountCents);
        const entry = await appendEntry(tx, account, { type: reverseType, amountCents: original.amountCents,
          description: `Estorno: ${original.description}`, reference: input.reason, sourceType: "manual_reversal",
          sourceId: input.requestId, occurredAt: new Date(), createdBy: access.user.name, correlationId, reversalOfId: original.id });
        await audit(tx, access.user.id, "account_entry.reversed", original.id, correlationId,
          { type: original.type, amountCents: original.amountCents }, { reversalEntryId: entry.id, reason: input.reason }, "account_entry");
        return { entry, replayed: false };
      }, { isolationLevel: "Serializable" });
      return Response.json({ ...result, correlationId }, { status: result.replayed ? 200 : 201, headers: noStore });
    }
    if (action === "transfer") {
      const input = transferInput(body);
      const result = await db.$transaction(async (tx) => {
        await lockAccounts(tx, [input.fromAccountId, input.toAccountId]);
        const replay = await tx.accountTransfer.findUnique({ where: { idempotencyKey: input.requestId }, select: transferInternalSelect });
        if (replay) {
          if (replay.fromAccountId !== input.fromAccountId || replay.toAccountId !== input.toAccountId || replay.amountCents !== input.amountCents)
            throw new AccountsControlError("Este identificador já foi usado com dados diferentes.", 409);
          return { transfer: publicTransfer(replay), replayed: true };
        }
        const [from, to] = await Promise.all([activeAccount(tx, input.fromAccountId), activeAccount(tx, input.toAccountId)]);
        assertFunds(from, "debit", input.amountCents);
        const transfer = await tx.accountTransfer.create({ data: { fromAccountId: from.id, toAccountId: to.id,
          amount: centsToAmount(input.amountCents), amountCents: input.amountCents, description: input.description,
          idempotencyKey: input.requestId, correlationId, transferredBy: access.user.name }, select: transferSelect });
        await appendEntry(tx, from, { type: "debit", amountCents: input.amountCents, description: `Transferência para ${to.name}`,
          reference: input.description, sourceType: "transfer", sourceId: `${transfer.id}:out`, occurredAt: input.occurredAt,
          createdBy: access.user.name, correlationId });
        await appendEntry(tx, to, { type: "credit", amountCents: input.amountCents, description: `Transferência de ${from.name}`,
          reference: input.description, sourceType: "transfer", sourceId: `${transfer.id}:in`, occurredAt: input.occurredAt,
          createdBy: access.user.name, correlationId });
        await audit(tx, access.user.id, "account_transfer.created", transfer.id, correlationId, null,
          { fromAccountId: from.id, toAccountId: to.id, amountCents: input.amountCents }, "account_transfer");
        return { transfer, replayed: false };
      }, { isolationLevel: "Serializable" });
      return Response.json({ ...result, correlationId }, { status: result.replayed ? 200 : 201, headers: noStore });
    }
    if (action === "transfer.reverse") {
      const input = transferReversalInput(body);
      const locator = await db.accountTransfer.findUnique({ where: { id: input.id }, select: { fromAccountId: true, toAccountId: true } });
      if (!locator) throw new AccountsControlError("Transferência não encontrada.", 404);
      const result = await db.$transaction(async (tx) => {
        await lockAccounts(tx, [locator.fromAccountId, locator.toAccountId]);
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "account_transfers" WHERE "id"=${input.id} FOR UPDATE`);
        const transfer = await tx.accountTransfer.findUnique({ where: { id: input.id }, select: transferInternalSelect });
        if (!transfer) throw new AccountsControlError("Transferência não encontrada.", 404);
        if (transfer.status === "reversed") {
          if (transfer.reversalIdempotencyKey === input.requestId) return { transfer: publicTransfer(transfer), replayed: true };
          throw new AccountsControlError("Esta transferência já foi estornada.", 409);
        }
        const [from, to] = await Promise.all([activeAccount(tx, transfer.fromAccountId), activeAccount(tx, transfer.toAccountId)]);
        assertFunds(to, "debit", transfer.amountCents);
        await appendEntry(tx, to, { type: "debit", amountCents: transfer.amountCents,
          description: `Estorno de transferência para ${from.name}`, reference: input.reason, sourceType: "transfer_reversal",
          sourceId: `${transfer.id}:reversal:out`, occurredAt: new Date(), createdBy: access.user.name, correlationId });
        await appendEntry(tx, from, { type: "credit", amountCents: transfer.amountCents,
          description: `Estorno de transferência de ${to.name}`, reference: input.reason, sourceType: "transfer_reversal",
          sourceId: `${transfer.id}:reversal:in`, occurredAt: new Date(), createdBy: access.user.name, correlationId });
        const updated = await tx.accountTransfer.update({ where: { id: transfer.id }, data: { status: "reversed",
          reversalIdempotencyKey: input.requestId, reversedAt: new Date(), reversedBy: access.user.name, reversalReason: input.reason }, select: transferSelect });
        await audit(tx, access.user.id, "account_transfer.reversed", transfer.id, correlationId,
          { status: "posted" }, { status: "reversed", reason: input.reason }, "account_transfer");
        return { transfer: updated, replayed: false };
      }, { isolationLevel: "Serializable" });
      return Response.json({ ...result, correlationId }, { headers: noStore });
    }
    if (action === "archive" || action === "reactivate") {
      const input = accountStateInput(body);
      const account = await db.$transaction(async (tx) => {
        await lockAccounts(tx, [input.id]);
        const before = await tx.financialAccount.findUnique({ where: { id: input.id }, select: accountMutationSelect });
        if (!before) throw new AccountsControlError("Conta não encontrada.", 404);
        if (action === "archive") {
          if (!before.active) return before;
          if (before.currentBalanceCents !== 0) throw new AccountsControlError("Zere o saldo antes de inativar a conta.");
          const [pendingBank, openTitles] = await Promise.all([
            tx.bankTransaction.count({ where: { accountId: before.id, status: "pending" } }),
            tx.financialTitle.count({ where: { accountId: before.id, status: { in: ["open", "partial"] } } }),
          ]);
          if (pendingBank || openTitles) throw new AccountsControlError("Resolva conciliações e títulos abertos antes de inativar a conta.");
        } else if (before.active) return before;
        const updated = await tx.financialAccount.update({ where: { id: before.id }, data: {
          active: action === "reactivate", archivedAt: action === "archive" ? new Date() : null, version: { increment: 1 } }, select: accountMutationSelect });
        await audit(tx, access.user.id, `financial_account.${action === "archive" ? "archived" : "reactivated"}`, before.id,
          correlationId, { active: before.active }, { active: updated.active, reason: input.reason });
        return updated;
      }, { isolationLevel: "Serializable" });
      return Response.json({ account, correlationId }, { headers: noStore });
    }
    throw new AccountsControlError("Ação de conta inválida.");
  } catch (error) { return failure(error); }
}

const accountMutationSelect = { id: true, code: true, name: true, type: true, branchId: true, description: true,
  institutionName: true, bankCode: true, agency: true, accountNumberLast4: true, color: true, currency: true,
  openingBalanceCents: true, currentBalanceCents: true, creditLimitCents: true, version: true, active: true,
  archivedAt: true, createdAt: true, updatedAt: true } satisfies Prisma.FinancialAccountSelect;
const entrySelect = { id: true, accountId: true, type: true, amountCents: true, balanceAfterCents: true, description: true,
  reference: true, sourceType: true, reversalOfId: true, occurredAt: true, createdAt: true,
  createdBy: true, account: { select: { id: true, code: true, name: true, type: true, color: true } },
  reversalOf: { select: { id: true } }, reversedBy: { select: { id: true } } } satisfies Prisma.AccountEntrySelect;
const transferSelect = { id: true, fromAccountId: true, toAccountId: true, amountCents: true, description: true, status: true,
  reversedAt: true, reversedBy: true, reversalReason: true, transferredBy: true, createdAt: true,
  fromAccount: { select: { id: true, code: true, name: true, color: true } },
  toAccount: { select: { id: true, code: true, name: true, color: true } } } satisfies Prisma.AccountTransferSelect;
const transferInternalSelect = { ...transferSelect, idempotencyKey: true, reversalIdempotencyKey: true } satisfies Prisma.AccountTransferSelect;

async function lockAccounts(tx: Tx, ids: number[]) {
  const ordered = [...new Set(ids)].sort((left, right) => left - right);
  if (!ordered.length) throw new AccountsControlError("Conta inválida.");
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "financial_accounts" WHERE "id" IN (${Prisma.join(ordered)}) ORDER BY "id" FOR UPDATE`);
}
async function activeAccount(tx: Tx, id: number) {
  const account = await tx.financialAccount.findFirst({ where: { id, active: true }, select: { id: true, name: true,
    currentBalanceCents: true, creditLimitCents: true } });
  if (!account) throw new AccountsControlError("Conta financeira ativa não encontrada.", 404);
  return account;
}
function assertFunds(account: { currentBalanceCents: number; creditLimitCents: number }, type: string, amountCents: number) {
  if (type === "debit" && account.currentBalanceCents - amountCents < -account.creditLimitCents)
    throw new AccountsControlError("Saldo disponível insuficiente para a operação.");
}
async function appendEntry(tx: Tx, account: { id: number; currentBalanceCents: number }, data: {
  type: "credit" | "debit"; amountCents: number; description: string; reference: string | null; sourceType: string;
  sourceId: string; occurredAt: Date; createdBy: string; correlationId: string; reversalOfId?: number;
}) {
  const delta = data.type === "credit" ? data.amountCents : -data.amountCents;
  const balanceAfterCents = account.currentBalanceCents + delta;
  const entry = await tx.accountEntry.create({ data: { accountId: account.id, ...data,
    amount: centsToAmount(data.amountCents), balanceAfterCents }, select: entrySelect });
  await tx.financialAccount.update({ where: { id: account.id }, data: { currentBalanceCents: { increment: delta },
    currentBalance: { increment: centsToAmount(delta) }, version: { increment: 1 } } });
  account.currentBalanceCents = balanceAfterCents;
  return entry;
}
async function assertBranch(db: Db, branchId: number | null) {
  if (branchId && !await db.branch.findFirst({ where: { id: branchId, status: "active" }, select: { id: true } }))
    throw new AccountsControlError("Filial ativa não encontrada.");
}
function positiveId(value: unknown) { const id = Number(value); if (!Number.isInteger(id) || id <= 0) throw new AccountsControlError("Conta inválida."); return id; }
function safeAccount(value: Prisma.FinancialAccountGetPayload<{ select: typeof accountMutationSelect }>) {
  return { id: value.id, code: value.code, name: value.name, type: value.type, branchId: value.branchId,
    openingBalanceCents: value.openingBalanceCents, currentBalanceCents: value.currentBalanceCents,
    creditLimitCents: value.creditLimitCents, active: value.active, version: value.version };
}
function publicTransfer(value: Prisma.AccountTransferGetPayload<{ select: typeof transferInternalSelect }>) {
  return { id: value.id, fromAccountId: value.fromAccountId, toAccountId: value.toAccountId,
    amountCents: value.amountCents, description: value.description, status: value.status, reversedAt: value.reversedAt,
    reversedBy: value.reversedBy, reversalReason: value.reversalReason, transferredBy: value.transferredBy,
    createdAt: value.createdAt, fromAccount: value.fromAccount, toAccount: value.toAccount };
}
async function audit(db: Db | Tx, actorId: string, action: string, id: number, correlationId: string,
  beforeData: object | null, afterData: object, entityType = "financial_account") {
  await db.tenantAuditEvent.create({ data: { actorId, action, entityType, entityId: String(id), correlationId,
    beforeData: beforeData ? beforeData as Prisma.InputJsonObject : undefined, afterData: afterData as Prisma.InputJsonObject } });
}
function failure(error: unknown) {
  if (error instanceof AccountsControlError) return Response.json({ error: error.message }, { status: error.status, headers: noStore });
  if (error instanceof CustomerInputError) return Response.json({ error: error.message }, { status: error.message.includes("Origem") ? 403 : 400, headers: noStore });
  if (error instanceof PosHttpError) return Response.json({ error: error.message }, { status: error.status, headers: noStore });
  if (error instanceof LicenseDeniedError) return Response.json({ error: error.message }, { status: error.status, headers: noStore });
  if (error instanceof AuthError) return authErrorResponse(error);
  if (error && typeof error === "object" && "code" in error && error.code === "P2002")
    return Response.json({ error: "Já existe uma conta ou operação com esse identificador." }, { status: 409, headers: noStore });
  if (error && typeof error === "object" && "code" in error && error.code === "P2034")
    return Response.json({ error: "A conta foi alterada por outra operação. Atualize e tente novamente." }, { status: 409, headers: noStore });
  console.error("Financial accounts control failed", { error: error instanceof Error ? error.name : typeof error });
  return Response.json({ error: "Não foi possível processar a operação financeira." }, { status: 500, headers: noStore });
}
