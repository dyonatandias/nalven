import { randomUUID } from "node:crypto";
import type { Prisma } from "@/generated/tenant/client";
import { currentOrganization, tenantDb } from "@/db";
import { AuthError, authErrorResponse, currentUser } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import { assertSameOrigin, CustomerInputError } from "@/lib/erp/customer-input";
import { countInput, entityId, finalizedCountInput, InventoryInputError, transferInput, warehouseInput } from "@/lib/erp/inventory-input";
import { assertLegacySimpleInventoryOperation } from "@/lib/erp/inventory-legacy-safety";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { readPosJson } from "@/lib/erp/pos-http";
import { assertTenantWriteAccess } from "@/lib/tenant-access";

export const dynamic = "force-dynamic";
const NO_STORE = { "cache-control": "no-store" };
const productSelect = { id: true, name: true, sku: true, unit: true, cost: true, stock: true, minStock: true };

export async function GET(request: Request) {
  try {
    const organization = await currentOrganization();
    await assertTenantPermission(organization.id, "inventory.read");
    const db = await tenantDb(organization.id), parameters = new URL(request.url).searchParams;
    const ledgerPage = positive(parameters.get("ledgerPage"), 1, 100_000), ledgerLimit = positive(parameters.get("ledgerLimit"), 50, 200), ledgerSearch = (parameters.get("ledgerSearch") || "").trim().slice(0, 100);
    const ledgerWhere: Prisma.WarehouseLedgerEntryWhereInput = ledgerSearch ? { OR: [{ product: { name: { contains: ledgerSearch, mode: "insensitive" } } }, { product: { sku: { contains: ledgerSearch, mode: "insensitive" } } }, { warehouse: { name: { contains: ledgerSearch, mode: "insensitive" } } }, { type: { contains: ledgerSearch, mode: "insensitive" } }] } : {};
    const [warehouses, counts, countTotal, transfers, transferTotal, products, ledger, ledgerTotal, divergences, openCounts] = await Promise.all([
      db.warehouse.findMany({ include: { balances: { include: { product: { select: productSelect } }, orderBy: { product: { name: "asc" } } } }, orderBy: [{ primary: "desc" }, { active: "desc" }, { name: "asc" }] }),
      db.inventoryCount.findMany({ include: { warehouse: { select: { id: true, code: true, name: true } }, items: { include: { product: { select: productSelect } }, orderBy: { product: { name: "asc" } } } }, orderBy: { createdAt: "desc" }, take: 100 }),
      db.inventoryCount.count(),
      db.stockTransfer.findMany({ include: { fromWarehouse: { select: { id: true, code: true, name: true } }, toWarehouse: { select: { id: true, code: true, name: true } }, items: { include: { product: { select: productSelect } } } }, orderBy: { createdAt: "desc" }, take: 100 }),
      db.stockTransfer.count(),
      db.product.findMany({ where: { active: true, type: "product" }, select: productSelect, orderBy: { name: "asc" } }),
      db.warehouseLedgerEntry.findMany({ where: ledgerWhere, include: { warehouse: { select: { code: true, name: true } }, product: { select: { name: true, sku: true, unit: true } } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (ledgerPage - 1) * ledgerLimit, take: ledgerLimit }),
      db.warehouseLedgerEntry.count({ where: ledgerWhere }),
      db.inventoryCountItem.count({ where: { difference: { not: 0 } } }),
      db.inventoryCount.count({ where: { status: "draft" } }),
    ]);
    const activeWarehouses = warehouses.filter((warehouse) => warehouse.active), balances = activeWarehouses.flatMap((warehouse) => warehouse.balances.map((balance) => ({ ...balance, warehouse: { id: warehouse.id, code: warehouse.code, name: warehouse.name } })));
    const positions = products.map((product) => {
      const productBalances = balances.filter((balance) => balance.productId === product.id), physical = sum(productBalances.map((balance) => balance.quantity)), reserved = sum(productBalances.map((balance) => balance.reservedQuantity)), available = round4(physical - reserved);
      return { ...product, physical, reserved, available, value: round(physical * product.cost), belowMinimum: available < product.minStock, warehouses: productBalances.map((balance) => ({ ...balance.warehouse, quantity: balance.quantity, reservedQuantity: balance.reservedQuantity, available: round4(balance.quantity - balance.reservedQuantity) })) };
    });
    const physical = sum(positions.map((position) => position.physical)), reserved = sum(positions.map((position) => position.reserved)), available = round4(physical - reserved), stockValue = round(positions.reduce((total, position) => total + position.value, 0));
    return Response.json({
      warehouses,
      counts,
      transfers,
      products,
      positions,
      ledger: ledger.map(({ id, ...entry }) => ({ ...entry, id: String(id) })),
      pagination: { counts: { total: countTotal, shown: counts.length }, transfers: { total: transferTotal, shown: transfers.length }, ledger: { page: ledgerPage, limit: ledgerLimit, total: ledgerTotal, pages: Math.max(1, Math.ceil(ledgerTotal / ledgerLimit)) } },
      summary: { warehouses: activeWarehouses.length, products: products.length, stockValue, physical, reserved, available, reservedProducts: positions.filter((position) => position.reserved > 0).length, lowStock: positions.filter((position) => position.belowMinimum).length, negative: positions.filter((position) => position.available < 0).length, openCounts, divergences },
    }, { headers: NO_STORE });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const organization = await currentOrganization();
    await assertTenantPermission(organization.id, "inventory.write");
    await assertTenantWriteAccess(organization.id);
    const user = await currentUser(), db = await tenantDb(organization.id), body = await readPosJson(request, 1_000_000) as Record<string, unknown>, correlationId = randomUUID();
    if (body.action === "create_warehouse") {
      const input = warehouseInput(body);
      const warehouse = await db.$transaction(async (tx) => {
        const created = await tx.warehouse.create({ data: input });
        await tx.tenantAuditEvent.create({ data: { actorId: user?.id, action: "warehouse.created", entityType: "warehouse", entityId: String(created.id), correlationId, afterData: { code: created.code, name: created.name, active: true } } });
        return created;
      }, { isolationLevel: "Serializable" });
      return Response.json({ warehouse, correlationId }, { status: 201, headers: NO_STORE });
    }
    if (body.action === "toggle_warehouse") {
      const id = entityId(body.warehouseId, "Depósito inválido.");
      const warehouse = await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM warehouses WHERE id = ${id} FOR UPDATE`;
        const current = await tx.warehouse.findUnique({ where: { id }, include: { balances: true } });
        if (!current) throw new InventoryInputError("Depósito não encontrado.");
        if (current.primary) throw new InventoryInputError("O depósito principal não pode ser inativado.");
        if (current.active && current.balances.some((balance) => Math.abs(balance.quantity) > 0.000001 || balance.reservedQuantity > 0.000001)) throw new InventoryInputError("Transfira ou zere os saldos e reservas antes de inativar o depósito.");
        const changed = await tx.warehouse.updateMany({ where: { id, active: current.active }, data: { active: !current.active } });
        if (changed.count !== 1) throw new InventoryInputError("O depósito foi alterado por outro usuário. Atualize a página.");
        const updated = await tx.warehouse.findUniqueOrThrow({ where: { id } });
        await tx.tenantAuditEvent.create({ data: { actorId: user?.id, action: "warehouse.status_changed", entityType: "warehouse", entityId: String(id), correlationId, beforeData: { active: current.active }, afterData: { active: updated.active } } });
        return updated;
      }, { isolationLevel: "Serializable" });
      return Response.json({ warehouse, correlationId }, { headers: NO_STORE });
    }
    if (body.action === "create_count") {
      const input = countInput(body);
      const count = await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM warehouses WHERE id = ${input.warehouseId} FOR UPDATE`;
        const warehouse = await tx.warehouse.findFirst({ where: { id: input.warehouseId, active: true }, include: { balances: true } });
        if (!warehouse) throw new InventoryInputError("Depósito ativo não encontrado.");
        if (await tx.inventoryCount.count({ where: { warehouseId: input.warehouseId, status: "draft" } })) throw new InventoryInputError("Já existe uma contagem aberta neste depósito.");
        const products = await tx.product.findMany({ where: { active: true, type: "product" }, select: { id: true }, orderBy: { id: "asc" } });
        if (!products.length) throw new InventoryInputError("Não há produtos para contar.");
        const balances = new Map(warehouse.balances.map((balance) => [balance.productId, balance.quantity]));
        const created = await tx.inventoryCount.create({ data: { number: `INV-${new Date().getUTCFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`, warehouseId: warehouse.id, blind: input.blind, notes: input.notes, createdBy: user?.name || "Usuário NALVEN", items: { create: products.map((product) => ({ productId: product.id, systemQuantity: balances.get(product.id) || 0 })) } }, include: { warehouse: true, items: { include: { product: { select: productSelect } } } } });
        await tx.tenantAuditEvent.create({ data: { actorId: user?.id, action: "inventory_count.created", entityType: "inventory_count", entityId: String(created.id), correlationId, afterData: { number: created.number, warehouseId: warehouse.id, itemCount: products.length, blind: input.blind } } });
        return created;
      }, { isolationLevel: "Serializable" });
      return Response.json({ count, correlationId }, { status: 201, headers: NO_STORE });
    }
    if (body.action === "finalize_count") return finalizeCount(db, body, user, correlationId);
    if (body.action === "cancel_count") {
      const id = entityId(body.countId, "Contagem inválida.");
      const cancelled = await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM inventory_counts WHERE id = ${id} FOR UPDATE`;
        const current = await tx.inventoryCount.findUnique({ where: { id } });
        if (!current) throw new InventoryInputError("Contagem não encontrada.");
        if (current.status !== "draft") throw new InventoryInputError("Somente uma contagem em andamento pode ser cancelada.");
        const changed = await tx.inventoryCount.updateMany({ where: { id, status: "draft" }, data: { status: "cancelled" } });
        if (changed.count !== 1) throw new InventoryInputError("A contagem foi alterada por outro usuário.");
        const result = await tx.inventoryCount.findUniqueOrThrow({ where: { id } });
        await tx.tenantAuditEvent.create({ data: { actorId: user?.id, action: "inventory_count.cancelled", entityType: "inventory_count", entityId: String(id), correlationId, beforeData: { status: "draft" }, afterData: { status: "cancelled" } } });
        return result;
      }, { isolationLevel: "Serializable" });
      return Response.json({ count: cancelled, correlationId }, { headers: NO_STORE });
    }
    if (body.action === "transfer") return transfer(db, body, user, correlationId);
    throw new InventoryInputError("Ação de inventário inválida.");
  } catch (error) {
    return failure(error);
  }
}

async function finalizeCount(db: Awaited<ReturnType<typeof tenantDb>>, body: unknown, user: Awaited<ReturnType<typeof currentUser>>, correlationId: string) {
  const input = finalizedCountInput(body);
  const completed = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM inventory_counts WHERE id = ${input.countId} FOR UPDATE`;
    const count = await tx.inventoryCount.findUnique({ where: { id: input.countId }, include: { warehouse: true, items: { include: { product: true }, orderBy: { productId: "asc" } } } });
    if (!count) throw new InventoryInputError("Contagem não encontrada.");
    if (count.status !== "draft") throw new InventoryInputError("Esta contagem já foi finalizada.");
    if (input.items.length !== count.items.length) throw new InventoryInputError("Todos os produtos da contagem precisam ser informados.");
    const indexed = new Map(input.items.map((item) => [item.itemId, item.countedQuantity]));
    if (count.items.some((item) => !indexed.has(item.id))) throw new InventoryInputError("A contagem contém itens inválidos ou ausentes.");
    await assertLegacySimpleInventoryOperation(tx, { operation: "finalize_count", productIds: count.items.map((item) => item.productId), warehouseIds: [count.warehouseId] });
    for (const item of count.items) {
      const counted = indexed.get(item.id)!;
      const balance = await tx.warehouseBalance.upsert({ where: { warehouseId_productId: { warehouseId: count.warehouseId, productId: item.productId } }, update: {}, create: { warehouseId: count.warehouseId, productId: item.productId, quantity: 0 } });
      if (counted + 0.000001 < balance.reservedQuantity) throw new InventoryInputError("A contagem não pode deixar o saldo físico menor que o saldo reservado.");
      const difference = round4(counted - balance.quantity), changed = await tx.warehouseBalance.updateMany({ where: { id: balance.id, quantity: balance.quantity, reservedQuantity: balance.reservedQuantity }, data: { quantity: counted } });
      if (changed.count !== 1) throw new InventoryInputError("O saldo mudou durante a contagem. Recarregue e abra uma nova contagem.");
      await tx.inventoryCountItem.update({ where: { id: item.id }, data: { systemQuantity: balance.quantity, countedQuantity: counted, difference } });
      if (Math.abs(difference) <= 0.000001) continue;
      await tx.product.update({ where: { id: item.productId }, data: { stock: { increment: difference } } });
      await tx.stockMovement.create({ data: { productId: item.productId, warehouseId: count.warehouseId, type: difference > 0 ? "entry" : "exit", quantity: Math.abs(difference), previousStock: balance.quantity, currentStock: counted, note: `Ajuste da contagem ${count.number} · ${count.warehouse.name}`, userName: user?.name || "Usuário NALVEN" } });
      await tx.warehouseLedgerEntry.create({ data: { warehouseId: count.warehouseId, productId: item.productId, type: "count_adjustment", quantity: difference, balanceBefore: balance.quantity, balanceAfter: counted, referenceType: "inventory_count", referenceId: String(count.id), actor: user?.name || "Usuário NALVEN" } });
    }
    const changed = await tx.inventoryCount.updateMany({ where: { id: count.id, status: "draft" }, data: { status: "completed", countedBy: user?.name || "Usuário NALVEN", completedAt: new Date() } });
    if (changed.count !== 1) throw new InventoryInputError("A contagem foi alterada por outro usuário.");
    const result = await tx.inventoryCount.findUniqueOrThrow({ where: { id: count.id }, include: { warehouse: true, items: { include: { product: { select: productSelect } } } } });
    await tx.tenantAuditEvent.create({ data: { actorId: user?.id, action: "inventory_count.completed", entityType: "inventory_count", entityId: String(count.id), correlationId, beforeData: { status: "draft" }, afterData: { status: "completed", adjustments: result.items.filter((item) => Math.abs(item.difference || 0) > 0.000001).length } } });
    return result;
  }, { isolationLevel: "Serializable" });
  return Response.json({ count: completed, correlationId }, { headers: NO_STORE });
}

async function transfer(db: Awaited<ReturnType<typeof tenantDb>>, body: unknown, user: Awaited<ReturnType<typeof currentUser>>, correlationId: string) {
  const input = transferInput(body);
  const created = await db.$transaction(async (tx) => {
    const warehouseIds = [input.fromWarehouseId, input.toWarehouseId].sort((left, right) => left - right);
    await tx.$queryRaw`SELECT id FROM warehouses WHERE id IN (${warehouseIds[0]}, ${warehouseIds[1]}) ORDER BY id FOR UPDATE`;
    const warehouses = await tx.warehouse.findMany({ where: { id: { in: warehouseIds }, active: true } });
    if (warehouses.length !== 2) throw new InventoryInputError("Origem ou destino não está ativo.");
    const rows = [...input.items].sort((left, right) => left.productId - right.productId);
    await assertLegacySimpleInventoryOperation(tx, { operation: "transfer", productIds: rows.map((item) => item.productId), warehouseIds });
    const balances = await tx.warehouseBalance.findMany({ where: { warehouseId: input.fromWarehouseId, productId: { in: rows.map((item) => item.productId) } }, include: { product: true } }), indexed = new Map(balances.map((balance) => [balance.productId, balance]));
    for (const row of rows) { const balance = indexed.get(row.productId); if (!balance || balance.quantity - balance.reservedQuantity + 0.000001 < row.quantity) throw new InventoryInputError(`Saldo disponível insuficiente para ${balance?.product.name || "o produto selecionado"}.`); }
    const number = `TRF-${new Date().getUTCFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`;
    const transfer = await tx.stockTransfer.create({ data: { number, fromWarehouseId: input.fromWarehouseId, toWarehouseId: input.toWarehouseId, notes: input.notes, transferredBy: user?.name || "Usuário NALVEN", items: { create: rows } }, include: { fromWarehouse: true, toWarehouse: true, items: { include: { product: { select: productSelect } } } } });
    for (const row of rows) {
      const source = indexed.get(row.productId)!;
      const changed = await tx.warehouseBalance.updateMany({ where: { id: source.id, quantity: source.quantity, reservedQuantity: source.reservedQuantity }, data: { quantity: { decrement: row.quantity } } });
      if (changed.count !== 1) throw new InventoryInputError("O saldo de origem foi alterado. Tente novamente.");
      const destinationBefore = await tx.warehouseBalance.findUnique({ where: { warehouseId_productId: { warehouseId: input.toWarehouseId, productId: row.productId } } });
      const destination = await tx.warehouseBalance.upsert({ where: { warehouseId_productId: { warehouseId: input.toWarehouseId, productId: row.productId } }, update: { quantity: { increment: row.quantity } }, create: { warehouseId: input.toWarehouseId, productId: row.productId, quantity: row.quantity } });
      await tx.warehouseLedgerEntry.createMany({ data: [{ warehouseId: input.fromWarehouseId, productId: row.productId, type: "transfer_out", quantity: -row.quantity, balanceBefore: source.quantity, balanceAfter: source.quantity - row.quantity, referenceType: "stock_transfer", referenceId: String(transfer.id), actor: user?.name || "Usuário NALVEN" }, { warehouseId: input.toWarehouseId, productId: row.productId, type: "transfer_in", quantity: row.quantity, balanceBefore: destinationBefore?.quantity || 0, balanceAfter: destination.quantity, referenceType: "stock_transfer", referenceId: String(transfer.id), actor: user?.name || "Usuário NALVEN" }] });
    }
    await tx.tenantAuditEvent.create({ data: { actorId: user?.id, action: "stock_transfer.completed", entityType: "stock_transfer", entityId: String(transfer.id), correlationId, afterData: { number, fromWarehouseId: input.fromWarehouseId, toWarehouseId: input.toWarehouseId, items: rows } } });
    return transfer;
  }, { isolationLevel: "Serializable" });
  return Response.json({ transfer: created, correlationId }, { status: 201, headers: NO_STORE });
}

function positive(value: string | null, fallback: number, maximum: number) { const parsed = Number(value || fallback); return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback; }
function sum(values: number[]) { return round4(values.reduce((total, value) => total + value, 0)); }
function round(value: number) { return Math.round(value * 100) / 100; }
function round4(value: number) { return Math.round(value * 10_000) / 10_000; }
function failure(error: unknown) {
  if (error instanceof InventoryInputError || error instanceof CustomerInputError) return Response.json({ error: error.message }, { status: error.message.includes("Origem") ? 403 : 400, headers: NO_STORE });
  if (error instanceof LicenseDeniedError) return Response.json({ error: error.message }, { status: error.status, headers: NO_STORE });
  if (error && typeof error === "object" && "code" in error && (error.code === "P2002" || error.code === "P2034")) return Response.json({ error: error.code === "P2002" ? "Já existe um depósito ou uma contagem aberta para este local." : "O inventário foi alterado simultaneamente. Atualize e tente novamente." }, { status: 409, headers: NO_STORE });
  if (error instanceof AuthError) return authErrorResponse(error);
  console.error("inventory request failed", error instanceof Error ? error.name : "unknown");
  return Response.json({ error: "Não foi possível operar o inventário." }, { status: 500, headers: NO_STORE });
}
