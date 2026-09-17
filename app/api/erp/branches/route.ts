import { randomUUID } from "node:crypto";
import { Prisma } from "@/generated/tenant/client";
import { currentOrganization, tenantDb } from "@/db";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import { branchCsv, BranchControlError, branchReadiness, parseBranchQuery } from "@/lib/erp/branch-control";
import { branchId, branchInput, BranchInputError } from "@/lib/erp/branch-input";
import { assertSameOrigin } from "@/lib/erp/customer-input";
import { assertTenantPermission, matches } from "@/lib/erp/permissions";
import { assertPosMutationRequest, enforcePosRateLimit, PosHttpError, readPosJson } from "@/lib/erp/pos-http";
import { assertTenantWriteAccess } from "@/lib/tenant-access";

export const dynamic = "force-dynamic";
const NO_STORE = { "cache-control": "private, no-store, max-age=0", expires: "0", pragma: "no-cache" };
const branchListInclude = {
  settings: true,
  parentBranch: { select: { id: true, code: true, name: true, status: true } },
  childBranches: { select: { id: true, code: true, name: true, status: true }, orderBy: { name: "asc" as const } },
  warehouses: { include: { balances: { select: { quantity: true, reservedQuantity: true } } }, orderBy: [{ primary: "desc" as const }, { name: "asc" as const }] },
  defaultWarehouse: { select: { id: true, code: true, name: true } },
  fiscalCertificates: { where: { active: true }, select: { id: true, name: true, expiresAt: true } },
  dfeSyncCursors: { select: { enabled: true, status: true, lastSuccessAt: true, consecutiveFailures: true } },
  _count: { select: { userAccesses: true, productConfigurations: true, financialAccounts: true, financialTitles: true, salesOrders: true, purchaseInvoices: true, posRegisters: true } },
} satisfies Prisma.BranchInclude;
type Db = Awaited<ReturnType<typeof tenantDb>>;
type ListedBranch = Prisma.BranchGetPayload<{ include: typeof branchListInclude }>;

export async function GET(request: Request) {
  try {
    const organization = await currentOrganization(), access = await assertTenantPermission(organization.id, "branches.read"), db = await tenantDb(organization.id), query = parseBranchQuery(new URL(request.url).searchParams), now = new Date();
    const where: Prisma.BranchWhereInput = {
      ...(query.status ? { status: query.status } : {}), ...(query.type ? { type: query.type } : {}), ...(query.state ? { state: query.state } : {}),
      ...(query.search ? { OR: [{ code: { contains: query.search, mode: "insensitive" } }, { name: { contains: query.search, mode: "insensitive" } }, { legalName: { contains: query.search, mode: "insensitive" } }, { document: { contains: query.search.replace(/\D/g, "") } }, { city: { contains: query.search, mode: "insensitive" } }, { managerName: { contains: query.search, mode: "insensitive" } }] } : {}),
    };
    const branches = await db.branch.findMany({ where, include: branchListInclude, orderBy: [{ primary: "desc" }, { name: "asc" }], take: 1001 });
    if (branches.length > 1000) throw new BranchInputError("A consulta excede 1.000 unidades. Aplique mais filtros.");
    let enriched = await enrichBranches(db, branches, now);
    if (query.readiness) enriched = enriched.filter((item) => item.readiness.status === query.readiness);
    sortBranches(enriched, query.sort);
    if (query.format === "csv") return new Response(branchCsv(enriched), { headers: { ...NO_STORE, "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="empresas-filiais-${now.toISOString().slice(0, 10)}.csv"` } });
    const total = enriched.length, pages = Math.max(1, Math.ceil(total / query.limit)), start = (query.page - 1) * query.limit, items = enriched.slice(start, start + query.limit);
    const [warehouses, products, profiles, allBranches, unassignedWarehouses, profile, tenantSettings] = await Promise.all([
      db.warehouse.findMany({ include: { branch: { select: { id: true, code: true, name: true } }, balances: { select: { quantity: true, reservedQuantity: true } } }, orderBy: [{ primary: "desc" }, { name: "asc" }] }),
      db.product.findMany({ select: { id: true, name: true, sku: true, type: true, active: true, price: true, cost: true, minStock: true, unit: true }, orderBy: [{ type: "asc" }, { name: "asc" }], take: 10_000 }),
      db.tenantUserProfile.findMany({ where: { status: "active" }, select: { id: true, displayName: true, email: true, jobTitle: true, department: true }, orderBy: { displayName: "asc" } }),
      db.branch.findMany({ select: { id: true, code: true, name: true, type: true, status: true, state: true, primary: true }, orderBy: [{ primary: "desc" }, { name: "asc" }] }),
      db.warehouse.count({ where: { branchId: null, active: true } }),
      db.tenantUserProfile.findUnique({ where: { userId: access.user.id }, select: { activeBranchId: true } }),
      db.tenantSettings.findUnique({ where: { id: 1 }, select: { timezone: true } }),
    ]);
    return Response.json({ items, branches: items, warehouses, products, profiles, hierarchy: allBranches, activeBranchId: profile?.activeBranchId || allBranches.find((item) => item.primary)?.id || null, defaultTimezone: tenantSettings?.timezone || "America/Sao_Paulo", generatedAt: now.toISOString(), capabilities: { canWrite: matches(access.permissions, "branches.write") }, pagination: { page: query.page, limit: query.limit, total, pages }, summary: summarize(enriched, unassignedWarehouses) }, { headers: NO_STORE });
  } catch (error) { return failure(error, "consultar"); }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request); assertPosMutationRequest(request);
    const organization = await currentOrganization(), db = await tenantDb(organization.id), body = await readPosJson(request, 2_097_152);
    if (body.action === "branch.select") {
      const access = await assertTenantPermission(organization.id, "branches.read"), id = branchId(body.branchId), branch = await db.branch.findFirst({ where: { id, status: "active" }, select: { id: true, code: true, name: true } });
      if (!branch) throw new BranchInputError("Filial ativa não encontrada.");
      const role = await db.tenantRole.findFirst({ where: { key: access.membership.role, active: true } }), profile = await db.tenantUserProfile.findUnique({ where: { userId: access.user.id }, select: { id: true, activeBranchId: true } });
      if (!role || !profile) throw new BranchInputError("Seu perfil operacional ainda não foi sincronizado.");
      if (access.membership.role !== "owner" && !await db.branchUserAccess.findUnique({ where: { branchId_userProfileId: { branchId: id, userProfileId: profile.id } } })) throw new BranchInputError("Você não possui acesso a esta filial.");
      const correlationId = randomUUID();
      await db.$transaction(async (tx) => { await tx.tenantUserProfile.update({ where: { id: profile.id }, data: { activeBranchId: id, roleId: role.id, displayName: access.user.name, email: access.user.email, status: "active", lastSyncedAt: new Date() } }); await tx.tenantAuditEvent.create({ data: { actorId: access.user.id, action: "branch.selected", entityType: "branch", entityId: String(id), correlationId, beforeData: { activeBranchId: profile.activeBranchId }, afterData: { activeBranchId: id } } }); });
      return Response.json({ activeBranchId: id, branch, correlationId }, { headers: NO_STORE });
    }
    const access = await assertTenantPermission(organization.id, "branches.write"); await assertTenantWriteAccess(organization.id); await enforcePosRateLimit(db, access.user.id, "branches.mutation");
    const input = branchInput(body); await validateRelations(db, input, null); await validateParent(db, input.branch.parentBranchId, null); assertActivationReadiness(input);
    const correlationId = randomUUID(), existingCount = await db.branch.count();
    const branch = await db.$transaction(async (tx) => {
      const created = await tx.branch.create({ data: { ...input.branch, primary: existingCount === 0 && input.branch.type === "headquarters" && input.branch.status === "active", defaultWarehouseId: input.defaultWarehouseId, settings: { create: input.settings } } });
      if (input.warehouseIds.length) await tx.warehouse.updateMany({ where: { id: { in: input.warehouseIds } }, data: { branchId: created.id } });
      if (input.productConfigurations.length) await tx.branchProduct.createMany({ data: input.productConfigurations.map((item) => ({ ...item, branchId: created.id })) });
      if (input.userAccesses.length) { await clearOtherPrimaryAccesses(tx, input.userAccesses); await tx.branchUserAccess.createMany({ data: input.userAccesses.map((item) => ({ ...item, branchId: created.id })) }); }
      await tx.tenantAuditEvent.create({ data: { actorId: access.user.id, action: "branch.created", entityType: "branch", entityId: String(created.id), correlationId, afterData: { code: created.code, name: created.name, document: created.document, type: created.type, status: created.status, parentBranchId: created.parentBranchId, warehouseIds: input.warehouseIds, readiness: readinessForInput(input).score } } });
      return tx.branch.findUniqueOrThrow({ where: { id: created.id }, include: branchListInclude });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return Response.json({ branch: (await enrichBranches(db, [branch], new Date()))[0], correlationId }, { status: 201, headers: NO_STORE });
  } catch (error) { return failure(error, "salvar"); }
}

export async function enrichBranches(db: Db, branches: ListedBranch[], now: Date) {
  const ids = branches.map((item) => item.id); if (!ids.length) return [];
  const [sessions, orders, reservations, waves, manifests, openTitles] = await Promise.all([
    db.cashRegisterSession.findMany({ where: { status: { in: ["open", "suspended"] }, register: { branchId: { in: ids } } }, select: { register: { select: { branchId: true } } } }),
    db.salesOrder.groupBy({ by: ["branchId"], where: { branchId: { in: ids }, status: { notIn: ["draft", "completed", "cancelled", "refunded"] } }, _count: { _all: true } }),
    db.stockReservation.groupBy({ by: ["branchId"], where: { branchId: { in: ids }, status: "active" }, _count: { _all: true } }),
    db.pickingWave.groupBy({ by: ["branchId"], where: { branchId: { in: ids }, status: { notIn: ["completed", "cancelled"] } }, _count: { _all: true } }),
    db.shippingManifest.groupBy({ by: ["branchId"], where: { branchId: { in: ids }, status: { notIn: ["handed_off", "cancelled"] } }, _count: { _all: true } }),
    db.financialTitle.groupBy({ by: ["branchId"], where: { branchId: { in: ids }, status: { in: ["open", "partial", "overdue"] } }, _count: { _all: true }, _sum: { amount: true, paidAmount: true } }),
  ]);
  const sessionsByBranch = new Map<number, number>(); for (const item of sessions) if (item.register) sessionsByBranch.set(item.register.branchId, (sessionsByBranch.get(item.register.branchId) || 0) + 1);
  const counts = <T extends { branchId: number | null; _count: { _all: number } }>(items: T[]) => new Map(items.flatMap((item) => item.branchId == null ? [] : [[item.branchId, item._count._all] as const]));
  const orderMap = counts(orders), reservationMap = counts(reservations), waveMap = counts(waves), manifestMap = counts(manifests), titleMap = new Map(openTitles.flatMap((item) => item.branchId == null ? [] : [[item.branchId, item] as const]));
  return branches.map((branch) => {
    const availableStock = branch.warehouses.reduce((total, warehouse) => total + warehouse.balances.reduce((sum, balance) => sum + balance.quantity - balance.reservedQuantity, 0), 0), validCertificateCount = branch.fiscalCertificates.filter((item) => item.expiresAt >= now).length;
    const blockers = { openCashSessions: sessionsByBranch.get(branch.id) || 0, openOrders: orderMap.get(branch.id) || 0, activeReservations: reservationMap.get(branch.id) || 0, activePickingWaves: waveMap.get(branch.id) || 0, openManifests: manifestMap.get(branch.id) || 0 };
    const open = titleMap.get(branch.id), metrics = { warehouseCount: branch.warehouses.length, userCount: branch._count.userAccesses, productCount: branch._count.productConfigurations, availableStock, financialAccountCount: branch._count.financialAccounts, openTitleCount: open?._count._all || 0, openTitleAmount: (open?._sum.amount || 0) - (open?._sum.paidAmount || 0), orderCount: branch._count.salesOrders, invoiceCount: branch._count.purchaseInvoices, registerCount: branch._count.posRegisters };
    const readiness = branchReadiness({ ...branch, warehouseCount: metrics.warehouseCount, userCount: metrics.userCount, productCount: metrics.productCount, validCertificateCount, settings: branch.settings });
    return { ...branch, metrics, blockers: { ...blockers, total: Object.values(blockers).reduce((sum, value) => sum + value, 0) }, readiness };
  });
}

function summarize(items: Awaited<ReturnType<typeof enrichBranches>>, unassignedWarehouses: number) { return { total: items.length, active: items.filter((item) => item.status === "active").length, planned: items.filter((item) => item.status === "planned").length, inactive: items.filter((item) => item.status === "inactive").length, headquarters: items.filter((item) => item.type === "headquarters").length, ready: items.filter((item) => item.readiness.status === "ready").length, critical: items.filter((item) => item.readiness.status === "critical").length, states: new Set(items.map((item) => item.state).filter(Boolean)).size, availableStock: items.reduce((sum, item) => sum + item.metrics.availableStock, 0), userAccesses: items.reduce((sum, item) => sum + item.metrics.userCount, 0), blockers: items.reduce((sum, item) => sum + item.blockers.total, 0), unassignedWarehouses }; }
function sortBranches(items: Awaited<ReturnType<typeof enrichBranches>>, sort: string) { items.sort((a, b) => sort === "readiness" ? a.readiness.score - b.readiness.score || a.name.localeCompare(b.name) : sort === "recent" ? b.updatedAt.valueOf() - a.updatedAt.valueOf() : sort === "stock" ? b.metrics.availableStock - a.metrics.availableStock : sort === "team" ? b.metrics.userCount - a.metrics.userCount : Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name, "pt-BR")); }
function readinessForInput(input: ReturnType<typeof branchInput>) { return branchReadiness({ ...input.branch, warehouseCount: input.warehouseIds.length, userCount: input.userAccesses.length, productCount: input.productConfigurations.filter((item) => item.active).length, validCertificateCount: 0, settings: input.settings }); }
function assertActivationReadiness(input: ReturnType<typeof branchInput>) { const readiness = readinessForInput(input); if (input.branch.status === "active" && !readiness.canActivate) throw new BranchInputError(`A unidade não pode ser ativada: ${readiness.issues.filter((item) => item.critical).map((item) => item.label).join(", ")}. Salve como planejada ou complete os itens críticos.`); }
async function validateParent(db: Db, parentBranchId: number | null, ownId: number | null) { if (!parentBranchId) return; if (parentBranchId === ownId) throw new BranchInputError("Uma filial não pode ser vinculada a ela mesma."); const parent = await db.branch.findFirst({ where: { id: parentBranchId, type: "headquarters", status: { not: "inactive" } }, select: { id: true, parentBranchId: true } }); if (!parent || parent.parentBranchId === ownId) throw new BranchInputError("Selecione uma matriz válida para a filial."); }
async function validateRelations(db: Db, input: ReturnType<typeof branchInput>, ownId: number | null) { const [warehouses, products, profiles] = await Promise.all([input.warehouseIds.length ? db.warehouse.count({ where: { id: { in: input.warehouseIds }, active: true, OR: [{ branchId: null }, ...(ownId ? [{ branchId: ownId }] : [])] } }) : 0, input.productConfigurations.length ? db.product.count({ where: { id: { in: input.productConfigurations.map((item) => item.productId) } } }) : 0, input.userAccesses.length ? db.tenantUserProfile.count({ where: { id: { in: input.userAccesses.map((item) => item.userProfileId) }, status: "active" } }) : 0]); if (warehouses !== input.warehouseIds.length) throw new BranchInputError("Um dos depósitos está inativo ou pertence a outra filial."); if (products !== input.productConfigurations.length) throw new BranchInputError("Um dos produtos ou serviços não existe."); if (profiles !== input.userAccesses.length) throw new BranchInputError("Um dos usuários não está ativo."); }
async function clearOtherPrimaryAccesses(tx: Prisma.TransactionClient, accesses: ReturnType<typeof branchInput>["userAccesses"]) { const primaryIds = accesses.filter((item) => item.primary).map((item) => item.userProfileId); if (primaryIds.length) await tx.branchUserAccess.updateMany({ where: { userProfileId: { in: primaryIds } }, data: { primary: false } }); }
function failure(error: unknown, operation: string) { if (error instanceof BranchInputError || error instanceof BranchControlError) return Response.json({ error: error.message }, { status: 400, headers: NO_STORE }); if (error instanceof PosHttpError) return Response.json({ error: error.message.replaceAll("PDV", "módulo de empresas e filiais") }, { status: error.status, headers: NO_STORE }); if (error instanceof LicenseDeniedError) return Response.json({ error: error.message }, { status: error.status, headers: NO_STORE }); if (error && typeof error === "object" && "code" in error && error.code === "P2002") return Response.json({ error: "Já existe uma unidade com este código, CNPJ ou depósito padrão." }, { status: 409, headers: NO_STORE }); if (error instanceof AuthError) return authErrorResponse(error); console.error(`branch ${operation} request failed`, error instanceof Error ? error.name : "unknown"); return Response.json({ error: `Não foi possível ${operation} as empresas e filiais.` }, { status: 500, headers: NO_STORE }); }
