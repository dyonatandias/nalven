import { randomUUID } from "node:crypto";
import { Prisma } from "@/generated/tenant/client";
import { currentOrganization, tenantDb } from "@/db";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import { branchReadiness } from "@/lib/erp/branch-control";
import { branchId, branchInput, BranchInputError } from "@/lib/erp/branch-input";
import { assertSameOrigin } from "@/lib/erp/customer-input";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { assertPosMutationRequest, enforcePosRateLimit, PosHttpError, readPosJson } from "@/lib/erp/pos-http";
import { assertTenantWriteAccess } from "@/lib/tenant-access";

export const dynamic = "force-dynamic";
const NO_STORE = { "cache-control": "private, no-store, max-age=0", expires: "0", pragma: "no-cache" };
const detailInclude = {
  settings: true,
  parentBranch: { select: { id: true, code: true, name: true, status: true } },
  childBranches: { select: { id: true, code: true, name: true, status: true }, orderBy: { name: "asc" as const } },
  warehouses: { include: { balances: { select: { productId: true, quantity: true, reservedQuantity: true } } }, orderBy: [{ primary: "desc" as const }, { name: "asc" as const }] },
  defaultWarehouse: { select: { id: true, code: true, name: true } },
  productConfigurations: { orderBy: { productId: "asc" as const } },
  userAccesses: { include: { userProfile: { select: { id: true, displayName: true, email: true, jobTitle: true, department: true, status: true } } }, orderBy: { userProfile: { displayName: "asc" as const } } },
  fiscalCertificates: { select: { id: true, name: true, fingerprint: true, expiresAt: true, active: true, updatedAt: true }, orderBy: { expiresAt: "desc" as const } },
  dfeSyncCursors: { select: { id: true, source: true, environment: true, enabled: true, status: true, lastSuccessAt: true, nextSyncAt: true, consecutiveFailures: true, lastError: true } },
  financialAccounts: { select: { id: true, code: true, name: true, type: true, currentBalance: true, active: true }, orderBy: { name: "asc" as const } },
  financialTitles: { select: { id: true, type: true, description: true, amount: true, paidAmount: true, dueAt: true, status: true }, orderBy: { dueAt: "desc" as const }, take: 12 },
  salesOrders: { select: { id: true, number: true, customerName: true, total: true, status: true, placedAt: true }, orderBy: { placedAt: "desc" as const }, take: 8 },
  purchaseInvoices: { select: { id: true, number: true, supplierName: true, total: true, status: true, issueDate: true }, orderBy: { issueDate: "desc" as const }, take: 8 },
  posRegisters: { select: { id: true, code: true, name: true, status: true, warehouseId: true, sessions: { where: { status: { in: ["open", "suspended"] } }, select: { id: true, number: true, status: true, openedAt: true } } }, orderBy: { name: "asc" as const } },
} satisfies Prisma.BranchInclude;
type Db = Awaited<ReturnType<typeof tenantDb>>;
class BranchConflictError extends Error {}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const organization = await currentOrganization(); await assertTenantPermission(organization.id, "branches.read"); const db = await tenantDb(organization.id), id = branchId((await params).id), now = new Date();
    const branch = await db.branch.findUnique({ where: { id }, include: detailInclude });
    if (!branch) return Response.json({ error: "Unidade não encontrada." }, { status: 404, headers: NO_STORE });
    const [dependencies, audit] = await Promise.all([branchDependencies(db, id), db.tenantAuditEvent.findMany({ where: { entityType: "branch", entityId: String(id) }, select: { id: true, action: true, actorId: true, correlationId: true, beforeData: true, afterData: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: 80 })]);
    const availableStock = branch.warehouses.reduce((total, warehouse) => total + warehouse.balances.reduce((sum, balance) => sum + balance.quantity - balance.reservedQuantity, 0), 0), validCertificateCount = branch.fiscalCertificates.filter((item) => item.active && item.expiresAt >= now).length;
    const readiness = branchReadiness({ ...branch, warehouseCount: branch.warehouses.length, userCount: branch.userAccesses.length, productCount: branch.productConfigurations.filter((item) => item.active).length, validCertificateCount, settings: branch.settings });
    return Response.json({ branch: { ...branch, readiness, metrics: { availableStock, warehouseCount: branch.warehouses.length, userCount: branch.userAccesses.length, productCount: branch.productConfigurations.length, financialAccountCount: branch.financialAccounts.length, openTitleCount: branch.financialTitles.filter((item) => ["open", "partial", "overdue"].includes(item.status)).length, registerCount: branch.posRegisters.length }, blockers: dependencies }, audit: audit.map((item) => ({ ...item, id: item.id.toString() })) }, { headers: NO_STORE });
  } catch (error) { return failure(error, "consultar"); }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request); assertPosMutationRequest(request);
    const organization = await currentOrganization(), access = await assertTenantPermission(organization.id, "branches.write"); await assertTenantWriteAccess(organization.id);
    const db = await tenantDb(organization.id), id = branchId((await params).id), body = await readPosJson(request, 2_097_152); await enforcePosRateLimit(db, access.user.id, "branches.mutation");
    const before = await db.branch.findUnique({ where: { id }, include: detailInclude });
    if (!before) return Response.json({ error: "Unidade não encontrada." }, { status: 404, headers: NO_STORE });
    const expectedVersion = positiveVersion(body.expectedVersion); if (expectedVersion !== before.version) throw new BranchConflictError("A unidade foi alterada por outra pessoa. Recarregue antes de continuar.");
    const correlationId = randomUUID();
    if (body.action === "branch.status" || body.action === "status") {
      const reason = actionReason(body.reason);
      const status = body.status === "active" ? "active" : body.status === "inactive" ? "inactive" : ""; if (!status) throw new BranchInputError("Situação da unidade inválida.");
      if (status === before.status) return Response.json({ branch: before, correlationId, unchanged: true }, { headers: NO_STORE });
      if (status === "inactive" && before.primary) throw new BranchInputError("Transfira a matriz principal antes de inativar esta unidade.");
      const dependencies = await branchDependencies(db, id); if (status === "inactive" && dependencies.total > 0) throw new BranchConflictError(`Conclua as operações abertas antes de inativar: ${dependencySummary(dependencies)}.`);
      if (status === "active") assertCurrentReadiness(before, new Date());
      const branch = await db.$transaction(async (tx) => { const changed = await tx.branch.updateMany({ where: { id, version: expectedVersion }, data: { status, version: { increment: 1 } } }); if (!changed.count) throw new BranchConflictError("A unidade foi alterada durante a operação."); if (status === "inactive") { await tx.tenantUserProfile.updateMany({ where: { activeBranchId: id }, data: { activeBranchId: null } }); await tx.dfeSyncCursor.updateMany({ where: { branchId: id }, data: { enabled: false } }); } await tx.tenantAuditEvent.create({ data: { actorId: access.user.id, action: status === "active" ? "branch.activated" : "branch.inactivated", entityType: "branch", entityId: String(id), correlationId, beforeData: { status: before.status, version: before.version }, afterData: { status, version: before.version + 1, reason } } }); return tx.branch.findUniqueOrThrow({ where: { id }, include: detailInclude }); }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return Response.json({ branch, correlationId }, { headers: NO_STORE });
    }
    if (body.action === "branch.set_primary") {
      const reason = actionReason(body.reason);
      if (before.type !== "headquarters" || before.status !== "active") throw new BranchInputError("Somente uma matriz ativa pode se tornar a principal.");
      if (before.primary) return Response.json({ branch: before, correlationId, unchanged: true }, { headers: NO_STORE });
      const branch = await db.$transaction(async (tx) => { await tx.branch.updateMany({ where: { primary: true }, data: { primary: false, version: { increment: 1 } } }); const changed = await tx.branch.updateMany({ where: { id, version: expectedVersion }, data: { primary: true, version: { increment: 1 } } }); if (!changed.count) throw new BranchConflictError("A unidade foi alterada durante a operação."); await tx.tenantAuditEvent.create({ data: { actorId: access.user.id, action: "branch.primary_changed", entityType: "branch", entityId: String(id), correlationId, beforeData: { primary: false }, afterData: { primary: true, reason } } }); return tx.branch.findUniqueOrThrow({ where: { id }, include: detailInclude }); }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return Response.json({ branch, correlationId }, { headers: NO_STORE });
    }
    const input = branchInput(body); if (input.expectedVersion !== expectedVersion) throw new BranchInputError("Versão da filial inválida.");
    if (before.primary && input.branch.type !== "headquarters") throw new BranchInputError("A matriz principal não pode ser convertida em filial.");
    if (before.childBranches.length && input.branch.type !== "headquarters") throw new BranchInputError("Uma matriz com filiais vinculadas não pode mudar de tipo.");
    await validateParent(db, input.branch.parentBranchId, id); await validateRelations(db, input, id); await validateRemovedWarehouses(db, before.warehouses.map((item) => item.id), input.warehouseIds);
    const nextBranch = { ...input.branch, status: before.status }, validCertificateCount = before.fiscalCertificates.filter((item) => item.active && item.expiresAt >= new Date()).length;
    if (before.status === "active") { const readiness = branchReadiness({ ...nextBranch, warehouseCount: input.warehouseIds.length, userCount: input.userAccesses.length, productCount: input.productConfigurations.filter((item) => item.active).length, validCertificateCount, settings: input.settings }); if (!readiness.canActivate) throw new BranchInputError(`A alteração deixaria uma unidade ativa incompleta: ${readiness.issues.filter((item) => item.critical).map((item) => item.label).join(", ")}.`); }
    const branch = await db.$transaction(async (tx) => {
      const { status: _ignoredStatus, ...branchData } = input.branch; void _ignoredStatus;
      const changed = await tx.branch.updateMany({ where: { id, version: expectedVersion }, data: { ...branchData, defaultWarehouseId: input.defaultWarehouseId, version: { increment: 1 } } }); if (!changed.count) throw new BranchConflictError("A unidade foi alterada durante a operação.");
      await tx.branchSettings.upsert({ where: { branchId: id }, update: input.settings, create: { ...input.settings, branchId: id } });
      await tx.warehouse.updateMany({ where: { branchId: id, id: { notIn: input.warehouseIds.length ? input.warehouseIds : [-1] } }, data: { branchId: null } }); if (input.warehouseIds.length) await tx.warehouse.updateMany({ where: { id: { in: input.warehouseIds } }, data: { branchId: id } });
      await tx.branchProduct.deleteMany({ where: { branchId: id } }); if (input.productConfigurations.length) await tx.branchProduct.createMany({ data: input.productConfigurations.map((item) => ({ ...item, branchId: id })) });
      await tx.branchUserAccess.deleteMany({ where: { branchId: id } }); const primaryIds = input.userAccesses.filter((item) => item.primary).map((item) => item.userProfileId); if (primaryIds.length) await tx.branchUserAccess.updateMany({ where: { userProfileId: { in: primaryIds } }, data: { primary: false } }); if (input.userAccesses.length) await tx.branchUserAccess.createMany({ data: input.userAccesses.map((item) => ({ ...item, branchId: id })) });
      await tx.tenantAuditEvent.create({ data: { actorId: access.user.id, action: "branch.updated", entityType: "branch", entityId: String(id), correlationId, beforeData: auditSnapshot(before), afterData: { ...auditSnapshot({ ...before, ...nextBranch, version: before.version + 1 }), reason: "Atualização cadastral" } } });
      return tx.branch.findUniqueOrThrow({ where: { id }, include: detailInclude });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return Response.json({ branch, correlationId }, { headers: NO_STORE });
  } catch (error) { return failure(error, "atualizar"); }
}

async function branchDependencies(db: Db, id: number) {
  const [openCashSessions, openOrders, activeReservations, activePickingWaves, openManifests] = await Promise.all([
    db.cashRegisterSession.count({ where: { status: { in: ["open", "suspended"] }, register: { branchId: id } } }), db.salesOrder.count({ where: { branchId: id, status: { notIn: ["draft", "completed", "cancelled", "refunded"] } } }), db.stockReservation.count({ where: { branchId: id, status: "active" } }), db.pickingWave.count({ where: { branchId: id, status: { notIn: ["completed", "cancelled"] } } }), db.shippingManifest.count({ where: { branchId: id, status: { notIn: ["handed_off", "cancelled"] } } }),
  ]); return { openCashSessions, openOrders, activeReservations, activePickingWaves, openManifests, total: openCashSessions + openOrders + activeReservations + activePickingWaves + openManifests };
}
function dependencySummary(value: Awaited<ReturnType<typeof branchDependencies>>) { return [[value.openCashSessions, "caixa(s)"], [value.openOrders, "pedido(s)"], [value.activeReservations, "reserva(s)"], [value.activePickingWaves, "onda(s) de separação"], [value.openManifests, "manifesto(s)"]].filter(([count]) => Number(count) > 0).map(([count, label]) => `${count} ${label}`).join(", "); }
function assertCurrentReadiness(branch: Prisma.BranchGetPayload<{ include: typeof detailInclude }>, now: Date) { const readiness = branchReadiness({ ...branch, warehouseCount: branch.warehouses.length, userCount: branch.userAccesses.length, productCount: branch.productConfigurations.filter((item) => item.active).length, validCertificateCount: branch.fiscalCertificates.filter((item) => item.active && item.expiresAt >= now).length, settings: branch.settings }); if (!readiness.canActivate) throw new BranchInputError(`Complete os itens críticos antes de ativar: ${readiness.issues.filter((item) => item.critical).map((item) => item.label).join(", ")}.`); }
async function validateParent(db: Db, parentBranchId: number | null, ownId: number) { if (!parentBranchId) return; if (parentBranchId === ownId) throw new BranchInputError("Uma filial não pode ser vinculada a ela mesma."); const parent = await db.branch.findFirst({ where: { id: parentBranchId, type: "headquarters", status: { not: "inactive" } }, select: { id: true, parentBranchId: true } }); if (!parent || parent.parentBranchId === ownId) throw new BranchInputError("Selecione uma matriz válida para a filial."); }
async function validateRelations(db: Db, input: ReturnType<typeof branchInput>, ownId: number) { const [warehouses, products, profiles] = await Promise.all([input.warehouseIds.length ? db.warehouse.count({ where: { id: { in: input.warehouseIds }, active: true, OR: [{ branchId: null }, { branchId: ownId }] } }) : 0, input.productConfigurations.length ? db.product.count({ where: { id: { in: input.productConfigurations.map((item) => item.productId) } } }) : 0, input.userAccesses.length ? db.tenantUserProfile.count({ where: { id: { in: input.userAccesses.map((item) => item.userProfileId) }, status: "active" } }) : 0]); if (warehouses !== input.warehouseIds.length) throw new BranchInputError("Um dos depósitos está inativo ou pertence a outra filial."); if (products !== input.productConfigurations.length) throw new BranchInputError("Um dos produtos ou serviços não existe."); if (profiles !== input.userAccesses.length) throw new BranchInputError("Um dos usuários não está ativo."); }
async function validateRemovedWarehouses(db: Db, current: number[], next: number[]) { const removed = current.filter((id) => !next.includes(id)); if (!removed.length) return; const [balances, variationBalances, registers, operations] = await Promise.all([db.warehouseBalance.count({ where: { warehouseId: { in: removed }, OR: [{ quantity: { not: 0 } }, { reservedQuantity: { not: 0 } }] } }), db.warehouseVariationBalance.count({ where: { warehouseId: { in: removed }, OR: [{ quantity: { not: 0 } }, { reservedQuantity: { not: 0 } }] } }), db.posRegister.count({ where: { warehouseId: { in: removed }, status: "active" } }), db.stockReservation.count({ where: { warehouseId: { in: removed }, status: "active" } })]); if (balances || variationBalances || registers || operations) throw new BranchConflictError("Não é possível desvincular depósito com saldo, reserva ou caixa ativo. Transfira a operação primeiro."); }
function positiveVersion(value: unknown) { const parsed = Number(value); if (!Number.isInteger(parsed) || parsed < 1) throw new BranchInputError("Informe a versão atual da unidade."); return parsed; }
function actionReason(value: unknown) { const reason = String(value || "").trim(); if (reason.length < 4 || reason.length > 500) throw new BranchInputError("Informe um motivo entre 4 e 500 caracteres."); return reason; }
function auditSnapshot(branch: { code: string; name: string; legalName: string; document: string; type: string; status: string; parentBranchId: number | null; defaultWarehouseId: number | null; version: number }) { return { code: branch.code, name: branch.name, legalName: branch.legalName, document: branch.document, type: branch.type, status: branch.status, parentBranchId: branch.parentBranchId, defaultWarehouseId: branch.defaultWarehouseId, version: branch.version }; }
function failure(error: unknown, operation: string) { if (error instanceof BranchConflictError) return Response.json({ error: error.message }, { status: 409, headers: NO_STORE }); if (error instanceof BranchInputError) return Response.json({ error: error.message }, { status: 400, headers: NO_STORE }); if (error instanceof PosHttpError) return Response.json({ error: error.message.replaceAll("PDV", "módulo de empresas e filiais") }, { status: error.status, headers: NO_STORE }); if (error instanceof LicenseDeniedError) return Response.json({ error: error.message }, { status: error.status, headers: NO_STORE }); if (error && typeof error === "object" && "code" in error && error.code === "P2002") return Response.json({ error: "Já existe uma unidade com este código, CNPJ ou depósito padrão." }, { status: 409, headers: NO_STORE }); if (error instanceof AuthError) return authErrorResponse(error); console.error(`branch ${operation} request failed`, error instanceof Error ? error.name : "unknown"); return Response.json({ error: `Não foi possível ${operation} a unidade.` }, { status: 500, headers: NO_STORE }); }
