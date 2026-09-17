import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/tenant/client";
import { executeProductionCommand } from "../lib/erp/production-service";
import {
  productionRead,
  productionRequirements,
} from "../lib/erp/production-query";
import { applyPosInventoryAdminMutation } from "../lib/erp/pos-inventory-admin";
import { receivePurchaseOrder } from "../lib/erp/purchase-receiving";

const socket = process.env.PRODUCTION_TEST_SOCKET;
const actor = { id: "production-test", name: "Operador teste" };
const weeklyShifts = Array.from({ length: 7 }, (_, day) => ({
  day,
  start: "08:00",
  end: "18:00",
}));

test("permissões de suprimentos são ampliadas com auditoria sem alterar perfis personalizados", { skip: !socket }, async () => {
  const db = client();
  const rollback = new Error("rollback fixture de permissões");
  try {
    const migration = await readFile("prisma/tenant/migrations/20260908130000_supply_operations_permissions/migration.sql", "utf8");
    await assert.rejects(db.$transaction(async tx => {
      const role = await tx.tenantRole.upsert({ where: { key: "stock" }, create: { key: "stock", name: "Estoque", permissions: ["inventory.write","purchases.write"], system: true }, update: { permissions: ["inventory.write","purchases.write"], system: true } });
      const custom = await tx.tenantRole.create({ data: { key: `custom-${randomUUID()}`, name: "Consulta personalizada", permissions: ["production.read"], system: false } });
      const before = await tx.tenantAuditEvent.count({ where: { action: "tenant_role.permissions_extended", entityId: String(role.id) } });
      await tx.$executeRawUnsafe(migration);
      const permissions = (await tx.tenantRole.findUniqueOrThrow({ where: { id: role.id } })).permissions as string[];
      assert.deepEqual(permissions.sort(), ["inventory.write","purchases.write","production.read","production.write","logistics.read","logistics.write"].sort());
      assert.deepEqual((await tx.tenantRole.findUniqueOrThrow({ where: { id: custom.id } })).permissions,["production.read"]);
      await tx.$executeRawUnsafe(migration);
      assert.equal(await tx.tenantAuditEvent.count({ where: { action: "tenant_role.permissions_extended", entityId: String(role.id) } }),before+1);
      throw rollback;
    }), error => error === rollback);
  } finally { await db.$disconnect(); }
});

test("MRP compra a variação e recebimento parcial entra no depósito da produção sem duplicar estoque ou financeiro", { skip: !socket }, async () => {
  const db = client();
  try {
    const f = await fixture(db, 0);
    await db.product.update({ where: { id: f.material.id }, data: { catalogType: "variable" } });
    const variation = await db.productVariation.create({ data: { productId: f.material.id, sku: `MAT-P-${randomUUID()}`, attributes: { Tamanho: "P" }, manageStock: "true", stock: 0 } });
    const revised = await command(db, { action: "bom.revise", bomId: f.bomId, snapshot: { ...f.snapshot, items: [{ productId: f.material.id, variationId: variation.id, quantity: 2 }] } });
    await command(db, { action: "bom.approve", revisionId: revised.revisionId });
    const supplier = await db.supplier.create({ data: { name: "Fornecedor de variações", document: randomUUID() } });
    const other = await db.warehouse.create({ data: { code: `WRONG-${randomUUID()}`, name: "Outro depósito", branchId: f.branch.id } });
    const id = Number((await command(db, { action: "order.create", bomId: f.bomId, warehouseId: f.warehouse.id, plannedQuantity: 3 })).orderId);
    const purchase = await orderCommand(db, id, { action: "mrp.purchase", productId: f.material.id, variationId: variation.id, supplierId: supplier.id, quantity: 6, unitCostCents: 350 });
    const purchaseId = Number(purchase.purchaseOrderId);
    const item = await db.purchaseOrderItem.findFirstOrThrow({ where: { purchaseOrderId: purchaseId } });
    assert.equal(item.variationId, variation.id);
    assert.equal((await productionRequirements(db,id))[0].incomingQuantity, 6);
    await db.purchaseOrder.update({ where: { id: purchaseId }, data: { status: "ordered" } });
    const payload = { idempotencyKey: randomUUID(), notes: "Primeira entrega", items: [{ itemId: item.id, quantity: 2, lotCode: "TEC-P" }] };
    await assert.rejects(receivePurchaseOrder(db,purchaseId,{ ...payload, warehouseId: other.id },actor,other.id), /depósito vinculado/);
    const received = await receivePurchaseOrder(db,purchaseId,payload,actor,other.id);
    assert.equal(received.receipt.warehouseId, f.warehouse.id);
    assert.equal(received.order.status,"partially_received");
    assert.deepEqual(await receivePurchaseOrder(db,purchaseId,payload,actor,other.id),received);
    await assert.rejects(receivePurchaseOrder(db,purchaseId,payload,{ ...actor, id: "other-user" },other.id), /outro conteúdo ou usuário/);
    await assert.rejects(db.goodsReceipt.update({ where: { id: received.receipt.id }, data: { receivedBy: "Alterado" } }), /immutable/);
    const evidence = await db.goodsReceiptItem.findFirstOrThrow({ where: { goodsReceiptId: received.receipt.id } });
    await assert.rejects(db.goodsReceiptItem.update({ where: { id: evidence.id }, data: { quantity: 10 } }), /immutable/);
    await assert.rejects(receivePurchaseOrder(db,purchaseId,{ idempotencyKey: randomUUID(), items: [{ itemId: item.id, quantity: 4.000001 }] },actor,null), /acima do saldo/);
    assert.equal(await db.goodsReceipt.count({ where: { purchaseOrderId: purchaseId } }),1);
    assert.equal(await db.financialTitle.count({ where: { sourceType: "purchase_order", sourceId: String(purchaseId) } }),1);
    assert.equal((await db.productVariation.findUniqueOrThrow({ where: { id: variation.id } })).stock,2);
    const partial = (await productionRequirements(db,id))[0]; assert.equal(partial.available,2); assert.equal(partial.incomingQuantity,4); assert.equal(partial.netShortage,0);
    const second = { idempotencyKey: randomUUID(), items: [{ itemId: item.id, quantity: 4, lotCode: "TEC-P" }] };
    await receivePurchaseOrder(db,purchaseId,second,actor,null);
    assert.equal((await db.purchaseOrder.findUniqueOrThrow({ where: { id: purchaseId } })).status,"received");
    assert.equal((await db.productVariation.findUniqueOrThrow({ where: { id: variation.id } })).stock,6);
    const receiptItems = await db.goodsReceiptItem.findMany({ where: { purchaseOrderItemId: item.id } });
    assert.ok(receiptItems.every(row => row.variationId === variation.id && Array.isArray(row.tracking) && row.tracking.length === 1));
    await orderCommand(db,id,{ action:"order.transition",status:"in_progress" });
    const report = await orderCommand(db,id,{ action:"order.report",producedQuantity:1 });
    const consumption = await db.productionConsumption.findFirstOrThrow({ where: { reportId: String(report.reportId) }, include: { reservation: true } });
    assert.equal(consumption.reservation.variationId,variation.id); assert.equal(consumption.totalCostCents,700);
    assert.equal((await db.productVariation.findUniqueOrThrow({ where: { id: variation.id } })).stock,4);
    assert.equal(await db.warehouseBalance.count({ where: { warehouseId: other.id, productId: f.material.id } }),0);
  } finally { await db.$disconnect(); }
});

test("recebimentos concorrentes respeitam o saldo e não deixam série duplicada nem recebimento sem estoque", { skip: !socket }, async () => {
  const db = client();
  try {
    const f = await fixture(db, 0);
    const supplier = await db.supplier.create({ data: { name: "Fornecedor serial", document: randomUUID() } });
    const orderId = Number((await command(db, { action: "order.create", bomId: f.bomId, warehouseId: f.warehouse.id, plannedQuantity: 3 })).orderId);
    const result = await orderCommand(db, orderId, { action: "mrp.purchase", productId: f.material.id, supplierId: supplier.id, quantity: 3, unitCostCents: 100 });
    const purchaseId = Number(result.purchaseOrderId);
    await db.purchaseOrder.update({ where: { id: purchaseId }, data: { status: "ordered" } });
    const item = await db.purchaseOrderItem.findFirstOrThrow({ where: { purchaseOrderId: purchaseId } });
    const payload = (serials: string[]) => ({ idempotencyKey: randomUUID(), items: [{ itemId: item.id, quantity: serials.length, serialNumbers: serials, lotCode: "SERIAL-RECEIPT" }] });
    await assert.rejects(receivePurchaseOrder(db,purchaseId,payload([" S-1 ","s-1"]),actor,null), /Série repetida/);
    assert.equal(await db.goodsReceipt.count({ where: { purchaseOrderId: purchaseId } }),0);
    const outcomes = await Promise.allSettled([
      receivePurchaseOrder(db,purchaseId,payload(["S-1","S-2"]),actor,null),
      receivePurchaseOrder(db,purchaseId,payload(["S-3","S-4"]),actor,null),
    ]);
    assert.equal(outcomes.filter(row => row.status === "fulfilled").length,1);
    assert.equal((await db.purchaseOrderItem.findUniqueOrThrow({ where: { id: item.id } })).receivedQuantity,2);
    assert.equal((await db.product.findUniqueOrThrow({ where: { id: f.material.id } })).stock,2);
    const existing = await db.posInventoryLot.findFirstOrThrow({ where: { productId: f.material.id, normalizedSerialNumber: { not: null } } });
    await assert.rejects(receivePurchaseOrder(db,purchaseId,payload([existing.serialNumber!]),actor,null), /já está cadastrada/);
    assert.equal(await db.goodsReceipt.count({ where: { purchaseOrderId: purchaseId } }),1);
    await receivePurchaseOrder(db,purchaseId,payload(["S-FINAL"]),actor,null);
    assert.equal((await db.purchaseOrder.findUniqueOrThrow({ where: { id: purchaseId } })).status,"received");
    assert.equal((await db.product.findUniqueOrThrow({ where: { id: f.material.id } })).stock,3);
    assert.equal(await db.financialTitle.count({ where: { sourceType: "purchase_order", sourceId: String(purchaseId) } }),1);
  } finally { await db.$disconnect(); }
});

test("um milionésimo pendente continua recebível e só encerra com o saldo exato", { skip: !socket }, async () => {
  const db = client();
  try {
    const f = await fixture(db, 0);
    const supplier = await db.supplier.create({ data: { name: "Fornecedor fracionário", document: randomUUID() } });
    const orderId = Number((await command(db, { action: "order.create", bomId: f.bomId, warehouseId: f.warehouse.id, plannedQuantity: 1 })).orderId);
    const result = await orderCommand(db, orderId, { action: "mrp.purchase", productId: f.material.id, supplierId: supplier.id, quantity: 1, unitCostCents: 100 });
    const purchaseId = Number(result.purchaseOrderId);
    await db.purchaseOrder.update({ where: { id: purchaseId }, data: { status: "ordered" } });
    const item = await db.purchaseOrderItem.findFirstOrThrow({ where: { purchaseOrderId: purchaseId } });
    const receive = (amount: number) => receivePurchaseOrder(db,purchaseId,{ idempotencyKey: randomUUID(), items: [{ itemId: item.id, quantity: amount, lotCode: "FRAC" }] },actor,null);
    assert.equal((await receive(0.999999)).order.status,"partially_received");
    assert.equal((await receive(0.000001)).order.status,"received");
    assert.equal((await db.product.findUniqueOrThrow({ where: { id: f.material.id } })).stock,1);
  } finally { await db.$disconnect(); }
});

test("reprovação e consumo divergente exigem justificativa e geram retrabalho rastreado uma única vez", { skip: !socket }, async () => {
  const db = client();
  try {
    const f = await fixture(db, 10);
    const id = Number((await command(db, { action: "order.create", bomId: f.bomId, warehouseId: f.warehouse.id, plannedQuantity: 2 })).orderId);
    await orderCommand(db, id, { action: "order.transition", status: "in_progress" });
    const input = { action: "order.report", producedQuantity: 1, reworkQuantity: 1, materials: [{ productId: f.material.id, quantity: 3 }] };
    await assert.rejects(orderCommand(db, id, input), /Observações|Justifique/);
    const reported = await orderCommand(db, id, { ...input, notes: "Consumo menor após ajuste do corte; uma unidade precisa ser refeita." });
    await orderCommand(db, id, { action: "report.inspect", reportId: reported.reportId, decision: "rejected", notes: "Acabamento fora do padrão", checklist: [{ name: "Quantidade", passed: true }, { name: "Integridade", passed: false }] });
    assert.equal((await db.product.findUniqueOrThrow({ where: { id: f.output.id } })).stock, 0);
    const rework = await orderCommand(db, id, { action: "order.rework", reportId: reported.reportId, reason: "Refazer as duas unidades" });
    await assert.rejects(orderCommand(db, id, { action: "order.rework", reportId: reported.reportId, reason: "Repetição indevida" }), /já gerou/);
    const replacement = await db.productionOrder.findUniqueOrThrow({ where: { id: Number(rework.newOrderId) } });
    assert.equal(replacement.plannedQuantity, 2); assert.deepEqual(replacement.tags, ["retrabalho"]);
    const original = await db.productionOrder.findUniqueOrThrow({ where: { id } });
    assert.deepEqual(replacement.snapshot, original.snapshot); assert.equal(original.actualCost, 6);
    await orderCommand(db, id, { action: "order.close", reason: "Reposição transferida à ordem vinculada" });
    const balance = await db.warehouseBalance.findUniqueOrThrow({ where: { warehouseId_productId: { warehouseId: f.warehouse.id, productId: f.material.id } } });
    assert.equal(balance.quantity, 7); assert.equal(balance.reservedQuantity, 0);
  } finally { await db.$disconnect(); }
});

test("série duplicada reverte consumo e não cria um segundo apontamento", { skip: !socket }, async () => {
  const db = client();
  try {
    const f = await fixture(db, 10);
    const id = Number((await command(db, { action: "order.create", bomId: f.bomId, warehouseId: f.warehouse.id, plannedQuantity: 2 })).orderId);
    await orderCommand(db, id, { action: "order.transition", status: "in_progress" });
    await orderCommand(db, id, { action: "order.report", producedQuantity: 1, output: { lotCode: "FIRST", serialNumbers: ["FIN-001"] } });
    await assert.rejects(orderCommand(db, id, { action: "order.report", producedQuantity: 1, output: { lotCode: "SECOND", serialNumbers: ["fin-001"] } }), /séries já/);
    assert.equal(await db.productionReport.count({ where: { orderId: id } }), 1);
    const balance = await db.warehouseBalance.findUniqueOrThrow({ where: { warehouseId_productId: { warehouseId: f.warehouse.id, productId: f.material.id } } });
    assert.equal(balance.quantity, 8); assert.equal(balance.reservedQuantity, 2);
    await orderCommand(db, id, { action: "order.report", producedQuantity: 1, output: { lotCode: "SECOND", serialNumbers: ["FIN-002"] } });
    assert.equal(await db.productionReport.count({ where: { orderId: id } }), 2);
  } finally { await db.$disconnect(); }
});

test("banco rejeita alteração da ficha da ordem e aprovação sem evidência de inspeção", { skip: !socket }, async () => {
  const db = client();
  try {
    const f = await fixture(db);
    const id = Number((await command(db, { action: "order.create", bomId: f.bomId, warehouseId: f.warehouse.id, plannedQuantity: 1 })).orderId);
    await assert.rejects(db.productionOrder.update({ where: { id }, data: { plannedQuantity: 100 } }), /basis is immutable/);
    await assert.rejects(db.productionOrder.update({ where: { id }, data: { snapshot: {} } }), /basis is immutable/);
    await orderCommand(db, id, { action: "order.transition", status: "in_progress" });
    const report = await orderCommand(db, id, { action: "order.report", producedQuantity: 1 });
    await assert.rejects(db.productionReport.update({ where: { id: String(report.reportId) }, data: { status: "approved" } }), /inspection evidence/);
    assert.equal((await db.productionReport.findUniqueOrThrow({ where: { id: String(report.reportId) } })).status, "quarantine");
    const reservation = await db.productionMaterialReservation.findFirstOrThrow({ where: { orderId: id } });
    await assert.rejects(db.productionMaterialReservation.update({ where: { id: reservation.id }, data: { consumedMicros: BigInt(0) } }), /immutable/);
  } finally { await db.$disconnect(); }
});

test("paginação ordena a fila inteira por posição, prioridade e prazo sem repetir ordens", { skip: !socket }, async () => {
  const db = client();
  try {
    const f = await fixture(db);
    const search = `QUEUE-${randomUUID()}`;
    const ids: number[] = [];
    for (const priority of ["low", "urgent", "normal", "high"]) ids.push(Number((await command(db, { action: "order.create", bomId: f.bomId, warehouseId: f.warehouse.id, plannedQuantity: 1, assignedTo: search, priority })).orderId));
    await orderCommand(db, ids[1], { action: "order.update", position: 4 });
    const first = await productionRead(db, new URLSearchParams({ resource: "orders", search, limit: "2" }));
    assert.ok("items" in first && "total" in first && "nextCursor" in first);
    assert.deepEqual((first.items as { id: number }[]).map(row => row.id), [ids[3], ids[2]]);
    assert.equal(first.total, 4);
    const second = await productionRead(db, new URLSearchParams({ resource: "orders", search, limit: "2", after: String(first.nextCursor) }));
    assert.ok("items" in second && "total" in second);
    assert.deepEqual((second.items as { id: number }[]).map(row => row.id), [ids[0], ids[1]]);
    assert.equal(second.total, 4);
    assert.equal(second.nextCursor, null);
    const filtered = await productionRead(db, new URLSearchParams({ resource: "orders", search, priority: "urgent" }));
    assert.ok("items" in filtered);
    assert.deepEqual((filtered.items as { id: number }[]).map(row => row.id), [ids[1]]);
  } finally { await db.$disconnect(); }
});

test("mais de cem apontamentos mantêm totais exatos, histórico paginado e inspeção dos mais antigos", { skip: !socket }, async () => {
  const db = client();
  try {
    const f = await fixture(db, 202);
    const created = await command(db, { action: "order.create", bomId: f.bomId, warehouseId: f.warehouse.id, plannedQuantity: 101 });
    const id = Number(created.orderId), reportIds: string[] = [];
    await orderCommand(db, id, { action: "order.transition", status: "in_progress" });
    for (let i = 0; i < 101; i++) reportIds.push(String((await orderCommand(db, id, { action: "order.report", producedQuantity: 1 })).reportId));
    const detail = await productionRead(db, new URLSearchParams({ resource: "detail", id: String(id) }));
    assert.ok("order" in detail && detail.order);
    assert.equal(detail.order.reports.length, 100); assert.equal(detail.reportsHaveMore, true);
    assert.ok(!detail.order.reports.some(report => report.id === reportIds[0]));
    assert.equal(detail.materials[0].required, 0, "a necessidade usa todos os apontamentos, não apenas a página");
    const collected: string[] = []; let reportAfter: string | null = null;
    do {
      const result = await productionRead(db, new URLSearchParams({ resource: "reports", orderId: String(id), limit: "30", ...(reportAfter ? { reportAfter } : {}) }));
      assert.ok("items" in result && "nextCursor" in result);
      collected.push(...(result.items as { id: string }[]).map(report => report.id));
      reportAfter = result.nextCursor ? String(result.nextCursor) : null;
    } while (reportAfter);
    assert.equal(collected.length, 101); assert.equal(new Set(collected).size, 101); assert.equal(collected.at(-1), reportIds[0]);
    await orderCommand(db, id, { action: "report.inspect", reportId: reportIds[0], decision: "approved", notes: "Inspeção do apontamento mais antigo", checklist: [{ name: "Quantidade", passed: true }, { name: "Integridade", passed: true }] });
    const order = await db.productionOrder.findUniqueOrThrow({ where: { id } });
    assert.equal(order.producedQuantity, 1); assert.equal(order.qualityStatus, "quarantine");
    const events = await productionRead(db, new URLSearchParams({ resource: "events", orderId: String(id), limit: "100" }));
    assert.ok("items" in events && events.items && "nextCursor" in events); assert.equal(events.items.length, 100); assert.ok(events.nextCursor);
    const older = await productionRead(db, new URLSearchParams({ resource: "events", orderId: String(id), after: String(events.nextCursor) }));
    assert.ok("items" in older); assert.ok((older.items as { action: string }[]).some(event => event.action === "order.created"));
  } finally { await db.$disconnect(); }
});
function client() {
  if (!socket?.startsWith("/tmp/nalven-production-pg."))
    throw new Error("Use the isolated production test cluster.");
  return new PrismaClient({
    adapter: new PrismaPg({
      host: socket,
      port: 55439,
      database: "production_test",
      user: "nalven",
    }),
  });
}
async function fixture(db: PrismaClient, stock = 20) {
  const token = randomUUID();
  const branch = await db.branch.create({
    data: {
      code: `P${token}`,
      name: "Filial de teste",
      legalName: "Produção teste",
      document: token,
    },
  });
  const warehouse = await db.warehouse.create({
    data: { code: `P${token}`, name: "Produção teste", branchId: branch.id },
  });
  const material = await db.product.create({
    data: {
      name: "Matéria-prima",
      slug: `mat-${token}`,
      sku: `MAT-${token}`,
      category: "Teste",
      type: "product",
      manageStock: true,
      stock,
      cost: 2,
    },
  });
  const output = await db.product.create({
    data: {
      name: "Produto acabado",
      slug: `out-${token}`,
      sku: `OUT-${token}`,
      category: "Teste",
      type: "product",
      manageStock: true,
      stock: 0,
      cost: 8,
    },
  });
  await db.warehouseBalance.create({
    data: {
      warehouseId: warehouse.id,
      productId: material.id,
      quantity: stock,
    },
  });
  await db.warehouseBalance.create({
    data: { warehouseId: warehouse.id, productId: output.id, quantity: 0 },
  });
  const snapshot = {
    name: "Ficha teste",
    code: `T-${token.slice(0, 8)}`,
    outputProductId: output.id,
    yieldQuantity: 1,
    items: [{ productId: material.id, quantity: 2, wastePercent: 0 }],
    laborHourlyCents: 600,
    machineHourlyCents: 1200,
    checklist: ["Quantidade", "Integridade"],
  };
  const bom = await command(db, { action: "bom.create", snapshot });
  await command(db, { action: "bom.approve", revisionId: bom.revisionId });
  return {
    warehouse,
    branch,
    material,
    output,
    snapshot,
    bomId: Number(bom.bomId),
  };
}
async function command(db: PrismaClient, body: Record<string, unknown>) {
  return (await executeProductionCommand(
    db,
    { idempotencyKey: randomUUID(), ...body },
    actor,
  )) as Record<string, unknown>;
}
async function orderCommand(
  db: PrismaClient,
  orderId: number,
  body: Record<string, unknown>,
) {
  const current = await db.productionOrder.findUniqueOrThrow({
    where: { id: orderId },
  });
  return command(db, { orderId, version: current.version, ...body });
}

test(
  "planejamento preserva precedências, bloqueia ciclos e redução de capacidade ocupada",
  { skip: !socket },
  async () => {
    const db = client();
    try {
      const f = await fixture(db);
      const centerData = {
        name: `Linha ${randomUUID()}`,
        timeZone: "UTC",
        shifts: weeklyShifts,
        wipLimit: 2,
        hourlyCostCents: 3000,
      };
      const center = await command(db, {
        action: "center.save",
        ...centerData,
      });
      const create = async () =>
        Number(
          (
            await command(db, {
              action: "order.create",
              bomId: f.bomId,
              warehouseId: f.warehouse.id,
              plannedQuantity: 1,
            })
          ).orderId,
        );
      const a = await create(),
        b = await create(),
        c = await create();
      const schedule = (
        id: number,
        start: string,
        end: string,
        predecessorIds?: number[],
      ) =>
        orderCommand(db, id, {
          action: "order.schedule",
          workCenterId: center.id,
          scheduledStart: `2090-01-02T${start}:00Z`,
          scheduledEnd: `2090-01-02T${end}:00Z`,
          ...(predecessorIds ? { predecessorIds } : {}),
        });
      await schedule(a, "08:00", "10:00");
      await schedule(b, "10:00", "12:00", [a]);
      await schedule(b, "11:00", "13:00");
      assert.equal(
        await db.productionDependency.count({
          where: { orderId: b, predecessorId: a },
        }),
        1,
        "omitir campo não apaga a dependência",
      );
      await assert.rejects(schedule(a, "10:00", "12:00"), /dependente/);
      await assert.rejects(schedule(a, "08:00", "10:00", [b]), /ciclo/);
      await schedule(c, "08:00", "10:00");
      const d = await create();
      await assert.rejects(schedule(d, "08:00", "09:00"), /capacidade/);
      await assert.rejects(
        command(db, {
          action: "center.save",
          ...centerData,
          centerId: center.id,
          version: 0,
          wipLimit: 1,
        }),
        /agendadas/,
      );
      await assert.rejects(
        orderCommand(db, b, {
          action: "order.transition",
          status: "in_progress",
        }),
        /anterior|dependência|predecessora/i,
      );
      const unchanged = await db.productionOrder.findUniqueOrThrow({
        where: { id: a },
      });
      assert.equal(
        unchanged.scheduledStart?.toISOString(),
        "2090-01-02T08:00:00.000Z",
      );
    } finally {
      await db.$disconnect();
    }
  },
);

test(
  "apontamento utiliza tarifa do recurso, audita a base e preserva estoque anterior sem lote",
  { skip: !socket },
  async () => {
    const db = client();
    try {
      const f = await fixture(db);
      await db.product.update({
        where: { id: f.output.id },
        data: { stock: 3 },
      });
      await db.warehouseBalance.update({
        where: {
          warehouseId_productId: {
            warehouseId: f.warehouse.id,
            productId: f.output.id,
          },
        },
        data: { quantity: 3 },
      });
      const center = await command(db, {
        action: "center.save",
        name: `Máquina ${randomUUID()}`,
        timeZone: "UTC",
        shifts: weeklyShifts,
        hourlyCostCents: 3000,
      });
      const created = await command(db, {
        action: "order.create",
        bomId: f.bomId,
        warehouseId: f.warehouse.id,
        plannedQuantity: 1,
      });
      const id = Number(created.orderId);
      await orderCommand(db, id, {
        action: "order.schedule",
        workCenterId: center.id,
        scheduledStart: "2090-01-02T08:00:00Z",
        scheduledEnd: "2090-01-02T09:00:00Z",
      });
      await orderCommand(db, id, {
        action: "order.transition",
        status: "in_progress",
      });
      const reported = await orderCommand(db, id, {
        action: "order.report",
        producedQuantity: 1,
        machineMinutes: 30,
      });
      const report = await db.productionReport.findUniqueOrThrow({
        where: { id: String(reported.reportId) },
      });
      assert.equal(
        report.machineCostCents,
        1500,
        "30 minutos na máquina de R$30/h, não R$12/h da ficha",
      );
      assert.equal(report.materialCostCents, 400);
      assert.deepEqual(reported.costBasis, {
        workCenterId: center.id,
        workCenterVersion: 0,
        machineHourlyCents: 3000,
        laborHourlyCents: 600,
        energyBatchCents: 0,
        overheadBatchCents: 0,
      });
      await orderCommand(db, id, {
        action: "report.inspect",
        reportId: report.id,
        decision: "approved",
        notes: "Conforme",
        checklist: [
          { name: "Quantidade", passed: true },
          { name: "Integridade", passed: true },
        ],
      });
      const output = await db.product.findUniqueOrThrow({
        where: { id: f.output.id },
      });
      assert.equal(output.stock, 4);
      assert.equal(
        output.cost,
        10.75,
        "R$24 de saldo anterior + R$19 de produção, divididos por quatro",
      );
      const lots = await db.posInventoryLot.findMany({
        where: {
          productId: f.output.id,
          warehouseId: f.warehouse.id,
          status: "available",
        },
      });
      assert.equal(
        lots.reduce((sum, lot) => sum + lot.quantityMicros, BigInt(0)),
        BigInt(4000000),
      );
    } finally {
      await db.$disconnect();
    }
  },
);

test(
  "ação em lote é atômica quando uma ordem não tem estoque suficiente",
  { skip: !socket },
  async () => {
    const db = client();
    try {
      const f = await fixture(db, 2);
      const orders = [];
      for (let i = 0; i < 2; i++) {
        const created = await command(db, {
          action: "order.create",
          bomId: f.bomId,
          warehouseId: f.warehouse.id,
          plannedQuantity: 1,
        });
        orders.push({ orderId: Number(created.orderId), version: 0 });
      }
      await assert.rejects(
        command(db, {
          action: "order.bulk",
          operation: "order.transition",
          orders,
          changes: { status: "in_progress" },
        }),
        /insuficiente/,
      );
      const unchanged = await db.productionOrder.findMany({
        where: { id: { in: orders.map((order) => order.orderId) } },
      });
      assert.ok(
        unchanged.every(
          (order) => order.status === "planned" && order.version === 0,
        ),
      );
      assert.equal(
        await db.productionMaterialReservation.count({
          where: { orderId: { in: orders.map((order) => order.orderId) } },
        }),
        0,
      );
      const balance = await db.warehouseBalance.findUniqueOrThrow({
        where: {
          warehouseId_productId: {
            warehouseId: f.warehouse.id,
            productId: f.material.id,
          },
        },
      });
      assert.equal(balance.reservedQuantity, 0);
    } finally {
      await db.$disconnect();
    }
  },
);

test(
  "MRP gera compra real sem duplicação, contabiliza pendências e reabre demanda cancelada",
  { skip: !socket },
  async () => {
    const db = client();
    try {
      const f = await fixture(db, 0);
      const supplier = await db.supplier.create({
        data: { name: "Fornecedor MRP", document: randomUUID() },
      });
      const created = await command(db, {
        action: "order.create",
        bomId: f.bomId,
        warehouseId: f.warehouse.id,
        plannedQuantity: 3,
      });
      const id = Number(created.orderId);
      const purchaseRequest = {
        action: "mrp.purchase",
        orderId: id,
        version: 0,
        productId: f.material.id,
        supplierId: supplier.id,
        quantity: 6,
        unitCostCents: 200,
        idempotencyKey: randomUUID(),
      };
      const bought = await command(db, purchaseRequest);
      assert.deepEqual(
        await command(db, purchaseRequest),
        bought,
        "repetição retorna a mesma compra",
      );
      const purchase = await db.purchaseOrder.findUniqueOrThrow({
        where: { id: Number(bought.purchaseOrderId) },
        include: { items: true },
      });
      assert.equal(purchase.status, "draft");
      assert.equal(purchase.total, 12);
      assert.equal(purchase.items[0].quantity, 6);
      assert.equal((await productionRequirements(db, id))[0].netShortage, 0);
      await assert.rejects(
        orderCommand(db, id, {
          ...purchaseRequest,
          idempotencyKey: randomUUID(),
          version: 1,
        }),
        /necessidade líquida/,
      );
      assert.equal(
        await db.productionProcurement.count({ where: { orderId: id } }),
        1,
      );
      await db.purchaseOrder.update({
        where: { id: purchase.id },
        data: { status: "cancelled" },
      });
      assert.equal((await productionRequirements(db, id))[0].netShortage, 6);
    } finally {
      await db.$disconnect();
    }
  },
);

test(
  "transferência MRP preserva identidade serial e permite consumo rastreado no destino",
  { skip: !socket },
  async () => {
    const db = client();
    try {
      const f = await fixture(db, 0);
      const source = await db.warehouse.create({
        data: {
          code: `SOURCE-${randomUUID()}`,
          name: "Origem serial",
          branchId: f.branch.id,
        },
      });
      await db.product.update({
        where: { id: f.material.id },
        data: { stock: 2 },
      });
      await db.warehouseBalance.create({
        data: { warehouseId: source.id, productId: f.material.id, quantity: 2 },
      });
    const serialLots: { id: string }[] = [];
      for (const serialNumber of ["PART-001", "PART-002"])
        serialLots.push(
          await db.posInventoryLot.create({
            data: {
              warehouseId: source.id,
              productId: f.material.id,
              lotCode: "PARTS",
              normalizedLotCode: "PARTS",
              serialNumber,
              normalizedSerialNumber: serialNumber,
              quantityMicros: BigInt(1000000),
            },
          }),
        );
      const created = await command(db, {
        action: "order.create",
        bomId: f.bomId,
        warehouseId: f.warehouse.id,
        plannedQuantity: 1,
      });
      const id = Number(created.orderId);
      const requirements = (await productionRequirements(db, id))[0];
      assert.deepEqual(requirements.sources, [
        { warehouseId: source.id, name: source.name, available: 2 },
      ]);
      const transfer = await orderCommand(db, id, {
        action: "mrp.transfer",
        productId: f.material.id,
        fromWarehouseId: source.id,
        quantity: 2,
      });
      assert.ok(transfer.transferId);
      const lots = await db.posInventoryLot.findMany({
        where: { productId: f.material.id },
      });
      assert.equal(lots.length, 2);
      assert.ok(
        lots.every(
          (lot) =>
            lot.warehouseId === f.warehouse.id &&
            serialLots.some((before) => before.id === lot.id),
        ),
      );
      assert.equal(
        (await db.product.findUniqueOrThrow({ where: { id: f.material.id } }))
          .stock,
        2,
        "transferência não altera saldo global",
      );
      await orderCommand(db, id, {
        action: "order.transition",
        status: "in_progress",
      });
      const report = await orderCommand(db, id, {
        action: "order.report",
        producedQuantity: 1,
        output: { lotCode: "FINISHED", serialNumbers: ["FIN-001"] },
      });
      const consumptions = await db.productionConsumption.findMany({
        where: { reportId: String(report.reportId) },
        include: { reservation: true },
      });
      assert.equal(consumptions.length, 2);
      assert.ok(
        consumptions.every((line) =>
          serialLots.some((lot) => lot.id === line.reservation.lotId),
        ),
      );
      const outputLot = await db.posInventoryLot.findFirstOrThrow({
        where: { productId: f.output.id },
      });
      await assert.rejects(
        db.$transaction((tx) =>
          applyPosInventoryAdminMutation(
            tx,
            {
              action: "inventory.release",
              idempotencyKey: randomUUID(),
              branchId: f.branch.id,
              lotId: outputLot.id,
              quantity: 1,
              reason: "Tentativa de liberação direta",
            },
            { actor: actor.name, businessDate: "2026-09-07" },
          ),
        ),
        /inspeção|produção/i,
      );
      assert.equal(
        (await db.product.findUniqueOrThrow({ where: { id: f.output.id } }))
          .stock,
        0,
      );
      await orderCommand(db, id, {
        action: "report.inspect",
        reportId: report.reportId,
        decision: "approved",
        notes: "Série conferida",
        checklist: [
          { name: "Quantidade", passed: true },
          { name: "Integridade", passed: true },
        ],
      });
      assert.equal(
        (
          await db.posInventoryLot.findUniqueOrThrow({
            where: { id: outputLot.id },
          })
        ).status,
        "available",
      );
    } finally {
      await db.$disconnect();
    }
  },
);

test(
  "produção reserva, aponta parcialmente, mantém quarentena, libera após inspeção e encerra com saldo correto",
  { skip: !socket },
  async () => {
    const db = client();
    try {
      const f = await fixture(db);
      const created = await command(db, {
        action: "order.create",
        bomId: f.bomId,
        warehouseId: f.warehouse.id,
        plannedQuantity: 4,
      });
      const id = Number(created.orderId);
      const startKey = randomUUID(),
        start = {
          idempotencyKey: startKey,
          action: "order.transition",
          orderId: id,
          version: 0,
          status: "in_progress",
        };
      assert.deepEqual(
        await executeProductionCommand(db, start, actor),
        await executeProductionCommand(db, start, actor),
      );
      let balance = await db.warehouseBalance.findUniqueOrThrow({
        where: {
          warehouseId_productId: {
            warehouseId: f.warehouse.id,
            productId: f.material.id,
          },
        },
      });
      assert.equal(balance.quantity, 20);
      assert.equal(balance.reservedQuantity, 8);
      const first = await orderCommand(db, id, {
        action: "order.report",
        producedQuantity: 2,
        laborMinutes: 60,
        machineMinutes: 30,
      });
      balance = await db.warehouseBalance.findUniqueOrThrow({
        where: { id: balance.id },
      });
      assert.equal(balance.quantity, 16);
      assert.equal(balance.reservedQuantity, 4);
      assert.equal(
        (await db.product.findUniqueOrThrow({ where: { id: f.output.id } }))
          .stock,
        0,
        "quarentena não pode ser vendida",
      );
      await assert.rejects(
        orderCommand(db, id, { action: "order.close", reason: "Teste" }),
        /inspeções/,
      );
      await assert.rejects(
        orderCommand(db, id, {
          action: "report.inspect",
          reportId: first.reportId,
          decision: "approved",
          notes: "Teste",
          checklist: [
            { name: "Quantidade", passed: true },
            { name: "Integridade", passed: false },
          ],
        }),
        /conformes/,
      );
      await orderCommand(db, id, {
        action: "report.inspect",
        reportId: first.reportId,
        decision: "approved",
        notes: "Conforme",
        checklist: [
          { name: "Quantidade", passed: true },
          { name: "Integridade", passed: true },
        ],
      });
      const product = await db.product.findUniqueOrThrow({
        where: { id: f.output.id },
      });
      assert.equal(product.stock, 2);
      assert.equal(
        product.cost,
        10,
        "R$8 de material + R$6 mão de obra + R$6 máquina divididos por duas unidades",
      );
      const second = await orderCommand(db, id, {
        action: "order.report",
        producedQuantity: 1,
        scrapQuantity: 1,
        notes: "Uma unidade danificada",
      });
      await orderCommand(db, id, {
        action: "report.inspect",
        reportId: second.reportId,
        decision: "approved",
        notes: "Unidade boa conferida",
        checklist: [
          { name: "Quantidade", passed: true },
          { name: "Integridade", passed: true },
        ],
      });
      await orderCommand(db, id, {
        action: "order.close",
        reason: "Concluída com um refugo registrado",
      });
      balance = await db.warehouseBalance.findUniqueOrThrow({
        where: { id: balance.id },
      });
      assert.equal(balance.quantity, 12);
      assert.equal(balance.reservedQuantity, 0);
      const final = await db.productionOrder.findUniqueOrThrow({
        where: { id },
      });
      assert.equal(final.producedQuantity, 3);
      assert.equal(final.actualCost, 28);
      assert.equal(final.status, "completed");
      assert.equal(
        (await db.product.findUniqueOrThrow({ where: { id: f.output.id } }))
          .cost,
        9.33,
      );
      await assert.rejects(
        db.productionReport.update({
          where: { id: String(first.reportId) },
          data: { producedMicros: BigInt(9000000) },
        }),
        /immutable|quality decision/,
      );
      await assert.rejects(
        executeProductionCommand(db, { ...start, status: "paused" }, actor),
        /outro conteúdo/,
      );
      const result = await productionRead(
        db,
        new URLSearchParams({ resource: "detail", id: String(id) }),
      );
      assert.ok("order" in result);
    } finally {
      await db.$disconnect();
    }
  },
);

test(
  "duas ordens concorrentes não reservam a mesma matéria-prima e cancelamento libera a reserva",
  { skip: !socket },
  async () => {
    const db = client(),
      other = client();
    try {
      const f = await fixture(db, 2);
      const one = await command(db, {
        action: "order.create",
        bomId: f.bomId,
        warehouseId: f.warehouse.id,
        plannedQuantity: 1,
      });
      const two = await command(db, {
        action: "order.create",
        bomId: f.bomId,
        warehouseId: f.warehouse.id,
        plannedQuantity: 1,
      });
      const outcomes = await Promise.allSettled([
        orderCommand(db, Number(one.orderId), {
          action: "order.transition",
          status: "in_progress",
        }),
        orderCommand(other, Number(two.orderId), {
          action: "order.transition",
          status: "in_progress",
        }),
      ]);
      assert.equal(
        outcomes.filter((item) => item.status === "fulfilled").length,
        1,
      );
      const started = await db.productionOrder.findFirstOrThrow({
        where: { bomId: f.bomId, status: "in_progress" },
      });
      await orderCommand(db, started.id, {
        action: "order.cancel",
        reason: "Demanda cancelada",
      });
      const balance = await db.warehouseBalance.findUniqueOrThrow({
        where: {
          warehouseId_productId: {
            warehouseId: f.warehouse.id,
            productId: f.material.id,
          },
        },
      });
      assert.equal(balance.quantity, 2);
      assert.equal(balance.reservedQuantity, 0);
    } finally {
      await Promise.all([db.$disconnect(), other.$disconnect()]);
    }
  },
);

test(
  "FEFO ignora lote vencido, reserva o mais próximo e preserva rastreabilidade do consumo",
  { skip: !socket },
  async () => {
    const db = client();
    try {
      const f = await fixture(db, 10);
      const old = await db.posInventoryLot.create({
        data: {
          warehouseId: f.warehouse.id,
          productId: f.material.id,
          lotCode: "OLD",
          normalizedLotCode: "OLD",
          expiresOn: new Date("2020-01-01"),
          quantityMicros: BigInt(2000000),
        },
      });
      const near = await db.posInventoryLot.create({
        data: {
          warehouseId: f.warehouse.id,
          productId: f.material.id,
          lotCode: "NEAR",
          normalizedLotCode: "NEAR",
          expiresOn: new Date("2090-01-01"),
          quantityMicros: BigInt(4000000),
        },
      });
      await db.posInventoryLot.create({
        data: {
          warehouseId: f.warehouse.id,
          productId: f.material.id,
          lotCode: "FAR",
          normalizedLotCode: "FAR",
          expiresOn: new Date("2091-01-01"),
          quantityMicros: BigInt(4000000),
        },
      });
      const created = await command(db, {
        action: "order.create",
        bomId: f.bomId,
        warehouseId: f.warehouse.id,
        plannedQuantity: 1,
      });
      const id = Number(created.orderId);
      const requirementsBefore = await productionRequirements(db, id);
      assert.equal(
        requirementsBefore[0].available,
        8,
        "MRP exclui as duas unidades vencidas do saldo agregado de dez",
      );
      await orderCommand(db, id, {
        action: "order.transition",
        status: "in_progress",
      });
      const reservation =
        await db.productionMaterialReservation.findFirstOrThrow({
          where: { orderId: id },
        });
      assert.equal(reservation.lotId, near.id);
      await orderCommand(db, id, {
        action: "order.report",
        producedQuantity: 1,
      });
      assert.equal(
        (await db.posInventoryLot.findUniqueOrThrow({ where: { id: near.id } }))
          .quantityMicros,
        BigInt(2000000),
      );
      assert.equal(
        (await db.posInventoryLot.findUniqueOrThrow({ where: { id: old.id } }))
          .quantityMicros,
        BigInt(2000000),
      );
      const line = await db.productionConsumption.findFirstOrThrow({
        where: { reservationId: reservation.id },
      });
      assert.equal(line.quantityMicros, BigInt(2000000));
    } finally {
      await db.$disconnect();
    }
  },
);

test(
  "revisão aprovada não altera ordens anteriores e versão futura não entra antes da vigência",
  { skip: !socket },
  async () => {
    const db = client();
    try {
      const f = await fixture(db);
      const order = await command(db, {
        action: "order.create",
        bomId: f.bomId,
        warehouseId: f.warehouse.id,
        plannedQuantity: 1,
      });
      const before = await db.productionOrder.findUniqueOrThrow({
        where: { id: Number(order.orderId) },
      });
      const revision = await command(db, {
        action: "bom.revise",
        bomId: f.bomId,
        snapshot: {
          ...f.snapshot,
          items: [{ productId: f.material.id, quantity: 3 }],
        },
      });
      await command(db, {
        action: "bom.approve",
        revisionId: revision.revisionId,
        effectiveAt: "2090-01-01T00:00:00Z",
      });
      const later = await command(db, {
        action: "order.create",
        bomId: f.bomId,
        warehouseId: f.warehouse.id,
        plannedQuantity: 1,
      });
      assert.equal(
        (
          await db.productionOrder.findUniqueOrThrow({
            where: { id: Number(later.orderId) },
          })
        ).revisionId,
        before.revisionId,
      );
      await assert.rejects(
        db.productionBomRevision.update({
          where: { id: before.revisionId! },
          data: { snapshot: {} },
        }),
        /immutable/,
      );
    } finally {
      await db.$disconnect();
    }
  },
);
