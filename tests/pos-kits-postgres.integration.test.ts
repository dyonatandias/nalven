import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/tenant/client";
import { applyPosCommonStockChange } from "../lib/erp/pos-common-stock";

const connectionString = process.env.POS_TEST_DATABASE_URL;

test("PostgreSQL confirma somente uma venda concorrente quando o componente do kit tem uma unidade", { skip: !connectionString }, async () => {
  const first = client(), second = client(), token = randomUUID(), compact = token.replaceAll("-", ""), salePrefix = `PG-KIT-SALE-${token}`;
  try {
    const branch = await first.branch.create({ data: { code: `PGKIT${compact}`, name: "Filial kit concorrente", legalName: "Filial kit concorrente Ltda", document: `PGKITDOC${compact}` } });
    const warehouse = await first.warehouse.create({ data: { code: `PGKITWH${compact}`, name: "Depósito kit", branchId: branch.id } });
    const [kit, component] = await Promise.all([
      first.product.create({ data: { name: "Kit concorrente", slug: `kit-${compact}`, sku: `KIT-${compact}`, category: "Teste", type: "kit", manageStock: false } }),
      first.product.create({ data: { name: "Componente escasso", slug: `component-${compact}`, sku: `COMP-${compact}`, category: "Teste", type: "product", manageStock: true } }),
    ]);
    await first.branchProduct.createMany({ data: [{ branchId: branch.id, productId: kit.id }, { branchId: branch.id, productId: component.id }] });
    await first.warehouseBalance.create({ data: { warehouseId: warehouse.id, productId: component.id, quantity: 1, reservedQuantity: 0 } });
    const bom = await first.posKitBom.create({ data: {
      id: `kit_bom_${compact}`, branchId: branch.id, kitProductId: kit.id, scopeKey: `product:${kit.id}`, version: 1, name: "BOM concorrente", status: "draft",
      createdBy: "postgres-test",
      components: { create: { id: `kit_component_${compact}`, productId: component.id, componentScopeKey: `product:${component.id}`, quantityMicros: BigInt(1_000_000), position: 0 } },
    } });
    await first.posKitBom.update({ where: { id: bom.id }, data: { status: "active", activatedBy: "postgres-test", activatedAt: new Date() } });
    const targetDraft = await first.posKitBom.create({ data: {
      id: `kit_bom_draft_${compact}`, branchId: branch.id, kitProductId: kit.id, scopeKey: `product:${kit.id}`, version: 2,
      name: "BOM rascunho protegido", status: "draft", createdBy: "postgres-test",
    } });
    await assert.rejects(
      first.posKitBomComponent.update({ where: { id: `kit_component_${compact}` }, data: { bomId: targetDraft.id } }),
      /cannot move between versions/,
    );

    const attempt = (db: PrismaClient, suffix: string) => db.$transaction(async tx => {
      const sale = await tx.sale.create({ data: {
        saleNumber: `${salePrefix}-${suffix}`, customer: "Teste", seller: "Teste", cashRegister: "Caixa", paymentMethod: "cash", total: 1,
        branchId: branch.id, warehouseId: warehouse.id, status: "completed", subtotalCents: 100, discountCents: 0, surchargeCents: 0, totalCents: 100, changeCents: 0,
        idempotencyKey: `pg-kit-${token}-${suffix}`, requestHash: suffix.repeat(64),
        items: { create: { productId: kit.id, productName: kit.name, unit: "UN", quantity: 1, unitPrice: 1, total: 1, unitPriceCents: 100, grossCents: 100, discountCents: 0, surchargeCents: 0, totalCents: 100 } },
      }, include: { items: true } });
      await tx.posKitSaleComponent.create({ data: { id: `kit_sale_component_${compact}_${suffix}`, saleItemId: sale.items[0].id, bomId: bom.id, bomVersion: 1, productId: component.id, componentScopeKey: `product:${component.id}`, unitQuantityMicros: BigInt(1_000_000), quantityMicros: BigInt(1_000_000), snapshot: { bomId: bom.id, version: 1 } } });
      await applyPosCommonStockChange(tx, { warehouseId: warehouse.id, product: component, variation: null, delta: -1, allowNegative: false, movementType: "exit", ledgerType: "kit_sale", referenceType: "pos_kit_sale_component", referenceId: `kit_sale_component_${compact}_${suffix}`, actor: "postgres-test", note: "Disputa de componente" });
    }, { isolationLevel: "Serializable" });

    const outcomes = await Promise.allSettled([attempt(first, "A"), attempt(second, "B")]);
    assert.equal(outcomes.filter(outcome => outcome.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter(outcome => outcome.status === "rejected").length, 1);
    assert.equal((await first.warehouseBalance.findUniqueOrThrow({ where: { warehouseId_productId: { warehouseId: warehouse.id, productId: component.id } } })).quantity, 0);
    assert.equal(await first.sale.count({ where: { saleNumber: { startsWith: salePrefix } } }), 1, "a venda perdedora deve ser revertida junto com seu snapshot");
    assert.equal(await first.posKitSaleComponent.count({ where: { bomId: bom.id } }), 1);
    assert.equal(await first.warehouseLedgerEntry.count({ where: { warehouseId: warehouse.id, productId: component.id, type: "kit_sale" } }), 1);
    const soldComponent = await first.posKitSaleComponent.findFirstOrThrow({ where: { bomId: bom.id } });
    await assert.rejects(
      first.$transaction(tx => tx.posKitSaleComponent.update({ where: { id: soldComponent.id }, data: { returnedMicros: BigInt(1_000_000) } })),
      /returned balance does not match immutable movement ledger/,
    );
    await first.$transaction(async tx => {
      await tx.posKitSaleComponent.update({ where: { id: soldComponent.id }, data: { returnedMicros: BigInt(1_000_000) } });
      await tx.posKitComponentReturnMovement.create({ data: {
        saleComponentId: soldComponent.id, quantityMicros: BigInt(1_000_000), disposition: "discard", referenceType: "sale_cancel",
        referenceId: soldComponent.id, operationKey: `pg-kit-return-${token}`, actor: "postgres-test",
      } });
    });
    const movement = await first.posKitComponentReturnMovement.findFirstOrThrow({ where: { saleComponentId: soldComponent.id } });
    assert.equal((await first.posKitSaleComponent.findUniqueOrThrow({ where: { id: soldComponent.id } })).returnedMicros, BigInt(1_000_000));
    await assert.rejects(first.posKitComponentReturnMovement.delete({ where: { id: movement.id } }), /immutable/);
  } finally {
    // Evidências de BOM e venda são deliberadamente imutáveis; a suíte PostgreSQL usa banco descartável.
    await Promise.all([first.$disconnect(), second.$disconnect()]);
  }
});

function client() {
  if (!connectionString) throw new Error("POS_TEST_DATABASE_URL não definida");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}
