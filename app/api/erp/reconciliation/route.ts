import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@/generated/tenant/client";
import { currentOrganization, tenantDb } from "@/db";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import { assertSameOrigin, CustomerInputError } from "@/lib/erp/customer-input";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { PosHttpError, readPosJson } from "@/lib/erp/pos-http";
import {
  autoReconciliationInput,
  centsAmount,
  operationHash,
  parseReconciliationQuery,
  parseStatementDocument,
  reconciliationCsv,
  reconciliationInput,
  ReconciliationControlError,
  reconciliationSummary,
  reconciliationTrend,
  resolutionInput,
  titleSuggestions,
} from "@/lib/erp/reconciliation-control";
import { assertTenantWriteAccess } from "@/lib/tenant-access";

type Db = Awaited<ReturnType<typeof tenantDb>>;
type Tx = Prisma.TransactionClient;
type Actor = { id: string; name: string };
const noStore = { "cache-control": "private, no-store, max-age=0", expires: "0", pragma: "no-cache" };

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const organization = await currentOrganization();
    await assertTenantPermission(organization.id, "reconciliation.read");
    const query = parseReconciliationQuery(new URL(request.url).searchParams);
    const db = await tenantDb(organization.id);
    const scopeWhere: Prisma.BankTransactionWhereInput = {
      occurredAt: { gte: query.from, lte: query.to },
      ...(query.accountId ? { accountId: query.accountId } : {}),
      ...(query.direction === "credit" ? { amountCents: { gt: 0 } } : query.direction === "debit" ? { amountCents: { lt: 0 } } : {}),
      ...(query.search ? { OR: [
        { description: { contains: query.search, mode: "insensitive" } },
        { externalId: { contains: query.search, mode: "insensitive" } },
        { documentNumber: { contains: query.search, mode: "insensitive" } },
        { bankReference: { contains: query.search, mode: "insensitive" } },
        { category: { contains: query.search, mode: "insensitive" } },
        { account: { name: { contains: query.search, mode: "insensitive" } } },
        { account: { code: { contains: query.search, mode: "insensitive" } } },
      ] } : {}),
    };
    const transactionWhere: Prisma.BankTransactionWhereInput = { ...scopeWhere,
      ...(query.status === "all" ? {} : { status: query.status }) };
    const [total, transactions, scopeTransactions, accounts, imports, titles] = await Promise.all([
      db.bankTransaction.count({ where: transactionWhere }),
      db.bankTransaction.findMany({ where: transactionWhere, select: transactionSelect,
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }], skip: query.format === "csv" ? 0 : (query.page - 1) * query.pageSize,
        take: query.format === "csv" ? 10_001 : query.pageSize }),
      db.bankTransaction.findMany({ where: scopeWhere, select: { id: true, status: true, amountCents: true,
        occurredAt: true, description: true, documentNumber: true } }),
      db.financialAccount.findMany({ where: { active: true, type: "bank" }, select: { id: true, code: true, name: true,
        institutionName: true, agency: true, accountNumberLast4: true, currentBalanceCents: true, color: true }, orderBy: { name: "asc" } }),
      db.bankStatementImport.findMany({ where: query.accountId ? { accountId: query.accountId } : {}, select: importSelect,
        orderBy: [{ importedAt: "desc" }, { id: "desc" }], take: 100 }),
      db.financialTitle.findMany({ where: { status: { in: ["open", "partial", "overdue"] } }, select: titleSelect,
        orderBy: [{ dueAt: "asc" }, { id: "asc" }], take: 1_000 }),
    ]);
    if (query.format === "csv") {
      if (transactions.length > 10_000) throw new ReconciliationControlError("O relatório excede 10.000 linhas. Reduza o período ou aplique mais filtros.", 413);
      return new Response(reconciliationCsv(transactions.map((transaction) => ({ occurredAt: transaction.occurredAt,
        accountCode: transaction.account.code, accountName: transaction.account.name, description: transaction.description,
        externalId: transaction.externalId, documentNumber: transaction.documentNumber, amountCents: transaction.amountCents,
        status: transaction.status, resolutionType: transaction.resolutionType, category: transaction.category,
        matchedDocuments: transaction.allocations.map((item) => item.title.documentNumber || item.title.description).join(" | "),
        reconciledBy: transaction.reconciledBy, reconciledAt: transaction.reconciledAt }))), { headers: { ...noStore,
          "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="conciliacao-${query.from.toISOString().slice(0, 10)}-${query.to.toISOString().slice(0, 10)}.csv"` } });
    }
    const suggestionMap = new Map<number, ReturnType<typeof titleSuggestions>>();
    for (const transaction of scopeTransactions.filter((item) => item.status === "pending"))
      suggestionMap.set(transaction.id, titleSuggestions(transaction, titles));
    const automatable = [...suggestionMap.values()].filter((items) => items.some((item) => item.recommended)).length;
    return Response.json({ generatedAt: new Date(), window: { from: query.from, to: query.to }, accounts, imports,
      titles: titles.map(publicTitle), transactions: transactions.map((transaction) => ({ ...transaction,
        suggestions: transaction.status === "pending" ? (suggestionMap.get(transaction.id) || []).map(publicSuggestion) : [] })),
      summary: reconciliationSummary(scopeTransactions, automatable), trend: reconciliationTrend(scopeTransactions),
      importSummary: { files: imports.length, rows: imports.reduce((sum, item) => sum + item.importedRowCount, 0),
        duplicates: imports.reduce((sum, item) => sum + item.duplicateRowCount, 0) },
      pagination: { page: query.page, pageSize: query.pageSize, total, pages: Math.max(1, Math.ceil(total / query.pageSize)) },
    }, { headers: noStore });
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const organization = await currentOrganization();
    const access = await assertTenantPermission(organization.id, "reconciliation.write");
    await assertTenantWriteAccess(organization.id);
    const body = await readPosJson(request, 4_194_304) as Record<string, unknown>;
    const action = String(body.action || "");
    const db = await tenantDb(organization.id);
    const actor = { id: access.user.id, name: access.user.name };
    if (action === "preview") {
      const parsed = parseStatementDocument(body.content ?? body.csv, body.fileName);
      return Response.json({ preview: statementPreview(parsed) }, { headers: noStore });
    }
    if (action === "import") return importStatement(db, actor, body);
    if (action === "reconcile") {
      const result = await reconcileOne(db, actor, reconciliationInput(body));
      return Response.json(result, { status: result.replayed ? 200 : 201, headers: noStore });
    }
    if (action === "ignore") {
      const result = await ignoreOne(db, actor, resolutionInput(body, "Motivo para ignorar"));
      return Response.json(result, { headers: noStore });
    }
    if (action === "reopen") {
      const result = await reopenOne(db, actor, resolutionInput(body, "Motivo da reabertura"));
      return Response.json(result, { headers: noStore });
    }
    if (action === "auto_reconcile") {
      const input = autoReconciliationInput(body);
      const pending = await db.bankTransaction.findMany({ where: { status: "pending", ...(input.accountId ? { accountId: input.accountId } : {}) },
        select: { id: true, amountCents: true, occurredAt: true, description: true, documentNumber: true }, orderBy: [{ occurredAt: "asc" }, { id: "asc" }], take: input.limit * 4 });
      const titles = await db.financialTitle.findMany({ where: { status: { in: ["open", "partial", "overdue"] } }, select: titleSelect, take: 1_000 });
      let processed = 0; const skipped: Array<{ transactionId: number; reason: string }> = [];
      for (const transaction of pending) {
        if (processed >= input.limit) break;
        const match = titleSuggestions(transaction, titles).find((item) => item.recommended);
        if (!match) continue;
        try {
          const requestId = `AUTO-${createHash("sha256").update(`${input.requestId}:${transaction.id}`).digest("hex")}`;
          const result = await reconcileOne(db, actor, { transactionId: transaction.id, requestId,
            reason: "Correspondência automática de valor, data e referência.", category: null,
            allocations: [{ titleId: match.title.id, amountCents: Math.abs(transaction.amountCents) }], automated: true });
          if (!result.replayed) processed += 1;
        } catch (error) { skipped.push({ transactionId: transaction.id, reason: safeAutomationReason(error) }); }
      }
      return Response.json({ processed, skipped, correlationId: randomUUID() }, { headers: noStore });
    }
    throw new ReconciliationControlError("Ação de conciliação inválida.");
  } catch (error) { return failure(error); }
}

async function importStatement(db: Db, actor: Actor, body: Record<string, unknown>) {
  const accountId = positiveId(body.accountId, "Conta bancária inválida.");
  const fileName = String(body.fileName || "");
  const content = String(body.content ?? body.csv ?? "");
  const parsed = parseStatementDocument(content, fileName);
  const digest = createHash("sha256").update(content.replace(/^\uFEFF/, "")).digest("hex");
  const correlationId = randomUUID();
  const result = await db.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "financial_accounts" WHERE "id"=${accountId} FOR UPDATE`);
    const account = await tx.financialAccount.findFirst({ where: { id: accountId, active: true, type: "bank" }, select: { id: true } });
    if (!account) throw new ReconciliationControlError("Conta bancária ativa não encontrada.", 404);
    const replay = await tx.bankStatementImport.findUnique({ where: { digest }, select: importSelect });
    if (replay) {
      if (replay.accountId !== accountId) throw new ReconciliationControlError("Este arquivo já foi associado a outra conta.", 409);
      return { statementImport: replay, replayed: true };
    }
    const existing = await tx.bankTransaction.findMany({ where: { accountId,
      externalId: { in: parsed.rows.map((row) => row.externalId) } }, select: { externalId: true, occurredAt: true,
        description: true, amountCents: true, bankReference: true, documentNumber: true } });
    const existingById = new Map(existing.map((item) => [item.externalId, item]));
    for (const row of parsed.rows) {
      const prior = existingById.get(row.externalId);
      if (prior && (prior.occurredAt.toISOString() !== row.occurredAt.toISOString() || prior.description !== row.description ||
        prior.amountCents !== row.amountCents || prior.bankReference !== row.bankReference || prior.documentNumber !== row.documentNumber))
        throw new ReconciliationControlError(`O identificador ${row.externalId} já existe nesta conta com dados diferentes.`, 409);
    }
    const existingIds = new Set(existing.map((item) => item.externalId));
    const newRows = parsed.rows.filter((row) => !existingIds.has(row.externalId));
    const duplicateRowCount = parsed.internalDuplicates + existingIds.size;
    const statementImport = await tx.bankStatementImport.create({ data: { accountId, fileName, format: parsed.format, digest,
      fileSize: parsed.fileSize, rowCount: parsed.rowCount, importedRowCount: newRows.length, duplicateRowCount,
      totalCreditCents: newRows.reduce((sum, row) => sum + Math.max(row.amountCents, 0), 0),
      totalDebitCents: newRows.reduce((sum, row) => sum + Math.max(-row.amountCents, 0), 0), periodStart: parsed.periodStart,
      periodEnd: parsed.periodEnd, correlationId, importedBy: actor.name }, select: importSelect });
    if (newRows.length) await tx.bankTransaction.createMany({ data: newRows.map((row) => ({ ...row, importId: statementImport.id,
      accountId, amount: centsAmount(row.amountCents) })) });
    await audit(tx, actor.id, "bank_statement.imported", "bank_statement_import", statementImport.id, correlationId, null,
      { accountId, fileName, format: parsed.format, rowCount: parsed.rowCount, importedRowCount: newRows.length, duplicateRowCount, digest });
    return { statementImport, replayed: false };
  }, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 });
  return Response.json({ ...result, preview: statementPreview(parsed), correlationId }, { status: result.replayed ? 200 : 201, headers: noStore });
}

type ReconcileCommand = ReturnType<typeof reconciliationInput> & { automated?: boolean };
async function reconcileOne(db: Db, actor: Actor, input: ReconcileCommand) {
  const requestHash = operationHash("reconcile", input.transactionId, { reason: input.reason, category: input.category,
    allocations: input.allocations.map((item) => ({ titleId: item.titleId, amountCents: item.amountCents })).sort((left, right) => left.titleId - right.titleId), automated: !!input.automated });
  return db.$transaction(async (tx) => {
    const replay = await operationReplay(tx, input.requestId, "reconcile", input.transactionId, requestHash);
    if (replay) return { transaction: await transactionById(tx, input.transactionId), replayed: true, correlationId: replay.correlationId };
    await lockTransaction(tx, input.transactionId);
    const replayAfterLock = await operationReplay(tx, input.requestId, "reconcile", input.transactionId, requestHash);
    if (replayAfterLock) return { transaction: await transactionById(tx, input.transactionId), replayed: true, correlationId: replayAfterLock.correlationId };
    const transaction = await tx.bankTransaction.findUnique({ where: { id: input.transactionId }, select: transactionStateSelect });
    if (!transaction || transaction.status !== "pending") throw new ReconciliationControlError("Movimento pendente não encontrado.", 409);
    await lockAccounts(tx, [transaction.accountId]);
    const account = await tx.financialAccount.findFirst({ where: { id: transaction.accountId, active: true },
      select: { id: true, currentBalanceCents: true } });
    if (!account) throw new ReconciliationControlError("Conta financeira ativa não encontrada.", 409);
    const targetCents = Math.abs(transaction.amountCents);
    const allocationInputs = input.allocations.map((allocation) => ({ ...allocation,
      amountCents: allocation.amountCents ?? (input.allocations.length === 1 ? targetCents : 0) }));
    if (allocationInputs.length && (allocationInputs.some((item) => !item.amountCents) ||
      allocationInputs.reduce((sum, item) => sum + item.amountCents, 0) !== targetCents))
      throw new ReconciliationControlError("A soma alocada deve corresponder exatamente ao valor do movimento.");
    const titleIds = allocationInputs.map((item) => item.titleId).sort((left, right) => left - right);
    if (titleIds.length) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "financial_titles" WHERE "id" IN (${Prisma.join(titleIds)}) ORDER BY "id" FOR UPDATE`);
    const titles = titleIds.length ? await tx.financialTitle.findMany({ where: { id: { in: titleIds } },
      select: { id: true, type: true, amount: true, paidAmount: true, status: true } }) : [];
    if (titles.length !== titleIds.length) throw new ReconciliationControlError("Um dos títulos não foi encontrado.", 404);
    const requiredType = transaction.amountCents > 0 ? "receivable" : "payable";
    const correlationId = randomUUID(); const sequence = transaction.reconciliationSequence + 1;
    for (const allocation of allocationInputs) {
      const title = titles.find((item) => item.id === allocation.titleId)!;
      const remainingCents = Math.round((title.amount - title.paidAmount) * 100);
      if (!new Set(["open", "partial", "overdue"]).has(title.status) || title.type !== requiredType)
        throw new ReconciliationControlError("Título incompatível com a direção do movimento.");
      if (allocation.amountCents > remainingCents) throw new ReconciliationControlError("A alocação supera o saldo do título.");
      const newPaidCents = Math.round(title.paidAmount * 100) + allocation.amountCents;
      const settlement = await tx.financialSettlement.create({ data: { titleId: title.id, accountId: account.id,
        amount: centsAmount(allocation.amountCents), method: "bank_reconciliation", notes: input.reason,
        status: "posted", occurredAt: transaction.occurredAt, settledBy: actor.name } });
      await tx.bankReconciliationAllocation.create({ data: { transactionId: transaction.id, titleId: title.id,
        settlementId: settlement.id, sequence, amountCents: allocation.amountCents, createdBy: actor.name } });
      await tx.financialTitle.update({ where: { id: title.id }, data: { paidAmount: centsAmount(newPaidCents),
        status: newPaidCents >= Math.round(title.amount * 100) ? "paid" : "partial",
        paidAt: newPaidCents >= Math.round(title.amount * 100) ? transaction.occurredAt : null } });
    }
    const entryType = transaction.amountCents > 0 ? "credit" : "debit";
    await appendAccountEntry(tx, account, { type: entryType, amountCents: targetCents, description: transaction.description,
      reference: transaction.externalId, sourceType: "bank_transaction", sourceId: `${transaction.id}:${sequence}`,
      occurredAt: transaction.occurredAt, createdBy: actor.name, correlationId });
    const resolutionType = input.automated ? "automatic" : allocationInputs.length > 1 ? "split" : allocationInputs.length === 1 ? "title" : "manual";
    const updated = await tx.bankTransaction.update({ where: { id: transaction.id }, data: { status: "reconciled",
      resolutionType, resolutionReason: input.reason, category: input.category,
      matchedTitleId: allocationInputs.length === 1 ? allocationInputs[0].titleId : null,
      reconciliationSequence: sequence, correlationId, reconciledBy: actor.name, reconciledAt: new Date(), version: { increment: 1 } },
      select: transactionSelect });
    await tx.bankReconciliationOperation.create({ data: { transactionId: transaction.id, action: "reconcile",
      idempotencyKey: input.requestId, requestHash, sequence, actorId: actor.id, correlationId } });
    await audit(tx, actor.id, "bank_transaction.reconciled", "bank_transaction", transaction.id, correlationId,
      { status: transaction.status, version: transaction.version }, { status: "reconciled", resolutionType,
        amountCents: transaction.amountCents, allocations: allocationInputs, sequence });
    return { transaction: updated, replayed: false, correlationId };
  }, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 });
}

async function ignoreOne(db: Db, actor: Actor, input: ReturnType<typeof resolutionInput>) {
  const requestHash = operationHash("ignore", input.transactionId, { reason: input.reason });
  return db.$transaction(async (tx) => {
    const replay = await operationReplay(tx, input.requestId, "ignore", input.transactionId, requestHash);
    if (replay) return { transaction: await transactionById(tx, input.transactionId), replayed: true, correlationId: replay.correlationId };
    await lockTransaction(tx, input.transactionId);
    const replayAfterLock = await operationReplay(tx, input.requestId, "ignore", input.transactionId, requestHash);
    if (replayAfterLock) return { transaction: await transactionById(tx, input.transactionId), replayed: true, correlationId: replayAfterLock.correlationId };
    const transaction = await tx.bankTransaction.findUnique({ where: { id: input.transactionId }, select: transactionStateSelect });
    if (!transaction || transaction.status !== "pending") throw new ReconciliationControlError("Movimento pendente não encontrado.", 409);
    const correlationId = randomUUID();
    const updated = await tx.bankTransaction.update({ where: { id: transaction.id }, data: { status: "ignored",
      resolutionType: "ignored", resolutionReason: input.reason, correlationId, reconciledBy: actor.name,
      reconciledAt: new Date(), version: { increment: 1 } }, select: transactionSelect });
    await tx.bankReconciliationOperation.create({ data: { transactionId: transaction.id, action: "ignore",
      idempotencyKey: input.requestId, requestHash, sequence: transaction.reconciliationSequence, actorId: actor.id, correlationId } });
    await audit(tx, actor.id, "bank_transaction.ignored", "bank_transaction", transaction.id, correlationId,
      { status: "pending", version: transaction.version }, { status: "ignored", reason: input.reason });
    return { transaction: updated, replayed: false, correlationId };
  }, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 });
}

async function reopenOne(db: Db, actor: Actor, input: ReturnType<typeof resolutionInput>) {
  const requestHash = operationHash("reopen", input.transactionId, { reason: input.reason });
  return db.$transaction(async (tx) => {
    const replay = await operationReplay(tx, input.requestId, "reopen", input.transactionId, requestHash);
    if (replay) return { transaction: await transactionById(tx, input.transactionId), replayed: true, correlationId: replay.correlationId };
    await lockTransaction(tx, input.transactionId);
    const replayAfterLock = await operationReplay(tx, input.requestId, "reopen", input.transactionId, requestHash);
    if (replayAfterLock) return { transaction: await transactionById(tx, input.transactionId), replayed: true, correlationId: replayAfterLock.correlationId };
    const transaction = await tx.bankTransaction.findUnique({ where: { id: input.transactionId }, select: transactionStateSelect });
    if (!transaction || !new Set(["reconciled", "ignored"]).has(transaction.status))
      throw new ReconciliationControlError("Somente movimentos resolvidos podem ser reabertos.", 409);
    const correlationId = randomUUID();
    if (transaction.status === "reconciled") {
      await lockAccounts(tx, [transaction.accountId]);
      const account = await tx.financialAccount.findUnique({ where: { id: transaction.accountId }, select: { id: true, currentBalanceCents: true } });
      if (!account) throw new ReconciliationControlError("Conta financeira não encontrada.", 409);
      const sourceIds = [`${transaction.id}:${transaction.reconciliationSequence}`, String(transaction.id)];
      const entry = await tx.accountEntry.findFirst({ where: { accountId: transaction.accountId, sourceType: "bank_transaction",
        sourceId: { in: sourceIds } }, include: { reversedBy: { select: { id: true } } }, orderBy: { id: "desc" } });
      if (!entry || entry.reversedBy) throw new ReconciliationControlError("O lançamento financeiro desta conciliação não pode ser estornado automaticamente.", 409);
      const reverseType = entry.type === "credit" ? "debit" : "credit";
      await appendAccountEntry(tx, account, { type: reverseType, amountCents: entry.amountCents,
        description: `Estorno de conciliação: ${transaction.description}`, reference: input.reason,
        sourceType: "bank_transaction_reversal", sourceId: `${transaction.id}:${transaction.reconciliationSequence}`,
        occurredAt: new Date(), createdBy: actor.name, correlationId, reversalOfId: entry.id });
      const allocations = await tx.bankReconciliationAllocation.findMany({ where: { transactionId: transaction.id,
        sequence: transaction.reconciliationSequence, status: "posted" }, select: { id: true, titleId: true,
          settlementId: true, amountCents: true } });
      if (transaction.matchedTitleId && !allocations.length)
        throw new ReconciliationControlError("Esta conciliação legada exige revisão financeira assistida antes de reabrir.", 409);
      const titleIds = allocations.map((item) => item.titleId).sort((left, right) => left - right);
      if (titleIds.length) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "financial_titles" WHERE "id" IN (${Prisma.join(titleIds)}) ORDER BY "id" FOR UPDATE`);
      for (const allocation of allocations) {
        const title = await tx.financialTitle.findUniqueOrThrow({ where: { id: allocation.titleId }, select: { amount: true, paidAmount: true } });
        const newPaidCents = Math.max(0, Math.round(title.paidAmount * 100) - allocation.amountCents);
        await tx.financialSettlement.update({ where: { id: allocation.settlementId }, data: { status: "reversed",
          reversedAt: new Date(), reversedBy: actor.name, reversalReason: input.reason } });
        await tx.bankReconciliationAllocation.update({ where: { id: allocation.id }, data: { status: "reversed",
          reversedAt: new Date(), reversedBy: actor.name, reversalReason: input.reason } });
        await tx.financialTitle.update({ where: { id: allocation.titleId }, data: { paidAmount: centsAmount(newPaidCents),
          status: newPaidCents ? "partial" : "open", paidAt: null } });
      }
    }
    const updated = await tx.bankTransaction.update({ where: { id: transaction.id }, data: { status: "pending",
      resolutionType: null, resolutionReason: null, category: null, matchedTitleId: null, correlationId,
      reconciledBy: null, reconciledAt: null, version: { increment: 1 } }, select: transactionSelect });
    await tx.bankReconciliationOperation.create({ data: { transactionId: transaction.id, action: "reopen",
      idempotencyKey: input.requestId, requestHash, sequence: transaction.reconciliationSequence, actorId: actor.id, correlationId } });
    await audit(tx, actor.id, "bank_transaction.reopened", "bank_transaction", transaction.id, correlationId,
      { status: transaction.status, version: transaction.version }, { status: "pending", reason: input.reason });
    return { transaction: updated, replayed: false, correlationId };
  }, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 });
}

async function appendAccountEntry(tx: Tx, account: { id: number; currentBalanceCents: number }, data: {
  type: "credit" | "debit"; amountCents: number; description: string; reference: string; sourceType: string;
  sourceId: string; occurredAt: Date; createdBy: string; correlationId: string; reversalOfId?: number;
}) {
  const delta = data.type === "credit" ? data.amountCents : -data.amountCents;
  await tx.accountEntry.create({ data: { accountId: account.id, ...data, amount: centsAmount(data.amountCents),
    balanceAfterCents: account.currentBalanceCents + delta } });
  await tx.financialAccount.update({ where: { id: account.id }, data: { currentBalance: { increment: centsAmount(delta) },
    currentBalanceCents: { increment: delta }, version: { increment: 1 } } });
  account.currentBalanceCents += delta;
}

async function operationReplay(tx: Tx, idempotencyKey: string, action: string, transactionId: number, requestHash: string) {
  const operation = await tx.bankReconciliationOperation.findUnique({ where: { idempotencyKey },
    select: { action: true, transactionId: true, requestHash: true, correlationId: true } });
  if (operation && (operation.action !== action || operation.transactionId !== transactionId || operation.requestHash !== requestHash))
    throw new ReconciliationControlError("Este identificador já foi utilizado com dados diferentes.", 409);
  return operation;
}
async function lockTransaction(tx: Tx, id: number) { await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "bank_transactions" WHERE "id"=${id} FOR UPDATE`); }
async function lockAccounts(tx: Tx, ids: number[]) { await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "financial_accounts" WHERE "id" IN (${Prisma.join([...new Set(ids)].sort((a, b) => a - b))}) ORDER BY "id" FOR UPDATE`); }
async function transactionById(tx: Tx, id: number) { const value = await tx.bankTransaction.findUnique({ where: { id }, select: transactionSelect }); if (!value) throw new ReconciliationControlError("Movimento não encontrado.", 404); return value; }
async function audit(tx: Tx, actorId: string, action: string, entityType: string, id: number, correlationId: string,
  beforeData: object | null, afterData: object) { await tx.tenantAuditEvent.create({ data: { actorId, action, entityType,
    entityId: String(id), correlationId, beforeData: beforeData ? beforeData as Prisma.InputJsonObject : undefined,
    afterData: afterData as Prisma.InputJsonObject } }); }

const titleSelect = { id: true, type: true, description: true, documentNumber: true, amount: true, paidAmount: true,
  dueAt: true, status: true, customer: { select: { name: true, tradeName: true } },
  supplier: { select: { name: true, tradeName: true } } } satisfies Prisma.FinancialTitleSelect;
const transactionSelect = { id: true, importId: true, accountId: true, externalId: true, occurredAt: true,
  description: true, amountCents: true, bankReference: true, documentNumber: true, category: true, status: true,
  resolutionType: true, resolutionReason: true, reconciliationSequence: true, version: true, reconciledBy: true,
  reconciledAt: true, account: { select: { id: true, code: true, name: true, color: true } },
  statementImport: { select: { id: true, fileName: true, format: true, importedAt: true } },
  matchedTitle: { select: titleSelect }, allocations: { where: { status: "posted" }, select: { id: true,
    amountCents: true, status: true, title: { select: titleSelect } }, orderBy: { id: "asc" } } } satisfies Prisma.BankTransactionSelect;
const transactionStateSelect = { id: true, accountId: true, externalId: true, occurredAt: true, description: true,
  amountCents: true, status: true, matchedTitleId: true, reconciliationSequence: true, version: true } satisfies Prisma.BankTransactionSelect;
const importSelect = { id: true, accountId: true, fileName: true, format: true, fileSize: true, rowCount: true,
  importedRowCount: true, duplicateRowCount: true, totalCreditCents: true, totalDebitCents: true, periodStart: true,
  periodEnd: true, status: true, importedBy: true, importedAt: true,
  account: { select: { id: true, code: true, name: true, color: true } } } satisfies Prisma.BankStatementImportSelect;

function publicTitle(title: Prisma.FinancialTitleGetPayload<{ select: typeof titleSelect }>) { return { ...title,
  remainingCents: Math.round((title.amount - title.paidAmount) * 100), party: title.customer?.tradeName || title.customer?.name || title.supplier?.tradeName || title.supplier?.name || null };
}
function publicSuggestion(item: ReturnType<typeof titleSuggestions>[number]) { return { ...publicTitle(item.title),
  confidence: item.confidence, exact: item.exact, recommended: item.recommended, days: item.days, reasons: item.reasons };
}
function statementPreview(parsed: ReturnType<typeof parseStatementDocument>) { return { format: parsed.format, fileSize: parsed.fileSize,
  rowCount: parsed.rowCount, uniqueRows: parsed.rows.length, internalDuplicates: parsed.internalDuplicates,
  periodStart: parsed.periodStart, periodEnd: parsed.periodEnd, totalCreditCents: parsed.totalCreditCents,
  totalDebitCents: parsed.totalDebitCents, sample: parsed.rows.slice(0, 12) };
}
function positiveId(value: unknown, message: string) { const id = Number(value); if (!Number.isInteger(id) || id <= 0) throw new ReconciliationControlError(message); return id; }
function safeAutomationReason(error: unknown) { return error instanceof ReconciliationControlError ? error.message : "Conflito concorrente; movimento preservado como pendente."; }
function failure(error: unknown) {
  if (error instanceof ReconciliationControlError) return Response.json({ error: error.message }, { status: error.status, headers: noStore });
  if (error instanceof CustomerInputError) return Response.json({ error: error.message }, { status: error.message.includes("Origem") ? 403 : 400, headers: noStore });
  if (error instanceof PosHttpError) return Response.json({ error: error.message }, { status: error.status, headers: noStore });
  if (error instanceof LicenseDeniedError) return Response.json({ error: error.message }, { status: error.status, headers: noStore });
  if (error instanceof AuthError) return authErrorResponse(error);
  if (error && typeof error === "object" && "code" in error && error.code === "P2002")
    return Response.json({ error: "Este arquivo ou movimento já foi processado." }, { status: 409, headers: noStore });
  if (error && typeof error === "object" && "code" in error && error.code === "P2034")
    return Response.json({ error: "A conciliação foi alterada por outra operação. Atualize e tente novamente." }, { status: 409, headers: noStore });
  console.error("Bank reconciliation control failed", error instanceof Error ? error.name : "unknown");
  return Response.json({ error: "Não foi possível processar a conciliação bancária." }, { status: 500, headers: noStore });
}
