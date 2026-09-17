import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "../generated/tenant/client";
import { lockedPosPaymentDraftIssue } from "../lib/erp/pos-order-claim";

const connectionString = process.env.POS_TEST_DATABASE_URL;

test("PostgreSQL concede um único claim, uma única conversão e preserva histórico append-only", { skip: !connectionString }, async () => {
  const first = client(), second = client(), token = randomUUID();
  try {
    const compact = token.replaceAll("-", ""), role = await first.tenantRole.findFirst({ where: { active: true }, select: { id: true } });
    assert.ok(role, "a base descartável deve possuir papel ativo");
    const branch = await first.branch.create({ data: { code: `PGORD${compact}`, name: "Filial order claim isolada", legalName: "Filial order claim isolada Ltda", document: `PGORDDOC${compact}` } });
    const warehouse = await first.warehouse.create({ data: { code: `PGORDWH${compact}`, name: "Depósito order claim", branchId: branch.id } });
    const register = await first.posRegister.create({ data: { branchId: branch.id, warehouseId: warehouse.id, code: `PGORDREG${compact}`, name: "Caixa order claim" } });
    const profile = await first.tenantUserProfile.create({ data: { userId: `pg-order-${token}`, roleId: role.id, displayName: "Operador order claim", email: `pg-order-${compact}@example.invalid`, activeBranchId: branch.id } });
    const [terminalA, terminalB] = await Promise.all([
      first.posTerminal.create({ data: { registerId: register.id, code: `ORDER-A-${token}`, name: "Terminal A" } }),
      first.posTerminal.create({ data: { registerId: register.id, code: `ORDER-B-${token}`, name: "Terminal B" } }),
    ]);
    const session = await first.cashRegisterSession.create({ data: { number: `ORDER-SESSION-${token}`, registerName: register.name, status: "open", openingAmount: 0, openingAmountCents: 0, openedBy: "Teste", registerId: register.id, operatorProfileId: profile.id } });
    const product = await first.product.create({ data: { name: "Produto order claim", slug: `pg-order-product-${compact}`, sku: `PG-ORDER-${compact}`, category: "Teste", price: 1, regularPrice: 1, manageStock: false } });
    const order = await first.salesOrder.create({ data: { number: `PG-POS-ORDER-${token}`, kind: "order", status: "approved", currency: "BRL", branchId: register.branchId, customerName: "Cliente teste", createdBy: "postgres-test", paymentMethod: "Pix", paymentInstallments: 1, total: 1, subtotal: 1, items: { create: { productId: product.id, nameSnapshot: product.name, skuSnapshot: product.sku, quantity: 1, listPrice: 1, unitPrice: 1, total: 1 } } } });
    const orderItem = await first.salesOrderItem.findFirstOrThrow({ where: { salesOrderId: order.id } });
    const reservation = await first.stockReservation.create({ data: { salesOrderId: order.id, orderItemId: orderItem.id, branchId: branch.id, warehouseId: warehouse.id, productId: product.id, quantity: 1 } });
    const leaseExpiresAt = new Date(Date.now() + 120_000);
    const claimData = (suffix: string, terminalId: string) => ({ salesOrderId: order.id, branchId: register.branchId, registerId: register.id, sessionId: session.id, operatorProfileId: profile.id, terminalId, leaseExpiresAt, idempotencyKey: `pg-order-claim-${suffix}-${token}`, requestHash: suffix.repeat(64).slice(0, 64), lifecycleTxid: new Prisma.Decimal(1) });
    const createClaim = (db: PrismaClient, suffix: string, terminalId: string) => db.$transaction(async tx => {
      const created = await tx.posOrderClaim.create({ data: claimData(suffix, terminalId) });
      await tx.posOrderClaimOperation.create({ data: { claimId: created.id, action: "claim", expectedVersion: 0, resultingVersion: 0, resultingState: "active", idempotencyKey: `pg-order-operation-claim-${suffix}-${token}`, requestHash: suffix.repeat(64).slice(0, 64), leaseExpiresAt, writeTxid: new Prisma.Decimal(2) } });
      return created;
    });
    const claims = await Promise.allSettled([
      createClaim(first, "a", terminalA.id),
      createClaim(second, "b", terminalB.id),
    ]);
    const claimFailures = claims.filter((result): result is PromiseRejectedResult => result.status === "rejected").map(result => String(result.reason?.message || result.reason));
    assert.equal(claims.filter(result => result.status === "fulfilled").length, 1, `somente um terminal pode possuir o pedido; falhas: ${claimFailures.join(" | ")}`);
    assert.equal(claims.filter(result => result.status === "rejected").length, 1);
    const claim = await first.posOrderClaim.findFirstOrThrow({ where: { salesOrderId: order.id, state: "active" } });
    const claimOperation = await first.posOrderClaimOperation.findFirstOrThrow({ where: { claimId: claim.id, resultingVersion: 0 } });
    assert.notEqual(claim.lifecycleTxid.toString(), "1", "trigger sobrescreve marcador de lifecycle fornecido pelo cliente");
    assert.notEqual(claimOperation.writeTxid.toString(), "2", "trigger sobrescreve marcador de operação fornecido pelo cliente");
    assert.equal(claim.lifecycleTxid.toString(), claimOperation.writeTxid.toString(), "claim inicial e ledger persistem o mesmo full-XID");
    const ledgerlessOrder = await first.salesOrder.create({ data: { number: `PG-POS-LEDGERLESS-${token}`, kind: "order", status: "approved", currency: "BRL", branchId: register.branchId, customerName: "Cliente teste", createdBy: "postgres-test", paymentMethod: "Pix", paymentInstallments: 1, total: 1, subtotal: 1 } });
    await assert.rejects(first.posOrderClaim.create({ data: { ...claimData("c", terminalA.id), salesOrderId: ledgerlessOrder.id, idempotencyKey: `pg-order-ledgerless-${token}` } }), /operation ledger|23514/i, "claim sem operação append-only na mesma transação é recusado");
    await assert.rejects(first.salesOrderItem.update({ where: { id: orderItem.id }, data: { salesOrderId: ledgerlessOrder.id } }), /POS claim|converted sale|child mutation/i, "filho não pode escapar por reparenting a partir de pedido claimed");
    await assert.rejects(first.stockReservation.update({ where: { id: reservation.id }, data: { salesOrderId: ledgerlessOrder.id } }), /POS claim|converted sale|stock reservation/i, "reserva não pode escapar por reparenting a partir de pedido claimed");
    await first.posHeldSale.create({ data: { id: claim.id, registerId: register.id, sessionId: claim.sessionId, operatorProfileId: profile.id, status: "draft", idempotencyKey: `pg-order-draft-${token}`, requestHash: "e".repeat(64) } });
    const draftIssue = await first.$transaction(tx => lockedPosPaymentDraftIssue(tx, { saleDraftId: claim.id, branchId: register.branchId, registerId: register.id, sessionId: claim.sessionId, operatorProfileId: profile.id, terminalId: claim.terminalId, paymentIndex: 0, payment: { method: "pix", amountCents: 100, installments: 1 }, now: new Date(leaseExpiresAt.valueOf() - 1) }));
    assert.equal(draftIssue, null);
    const wrongSettlement = await first.$transaction(tx => lockedPosPaymentDraftIssue(tx, { saleDraftId: claim.id, branchId: register.branchId, registerId: register.id, sessionId: claim.sessionId, operatorProfileId: profile.id, terminalId: claim.terminalId, paymentIndex: 0, payment: { method: "pix", amountCents: 1, installments: 1 }, now: new Date(leaseExpiresAt.valueOf() - 1) }));
    assert.match(wrongSettlement || "", /corresponder exatamente/);
    const operation = await first.posOrderClaimOperation.findFirstOrThrow({ where: { claimId: claim.id } });
    await assert.rejects(first.posOrderClaim.update({ where: { id: claim.id }, data: { state: "released", version: { increment: 1 }, releasedAt: new Date() } }), /operation ledger|23514/i, "transição sem operação append-only correspondente falha no commit");
    const renewedLeaseExpiresAt = new Date(leaseExpiresAt.valueOf() + 60_000);
    await assert.rejects(first.$transaction(async tx => {
      await tx.posOrderClaim.update({ where: { id: claim.id }, data: { version: { increment: 1 }, renewedAt: new Date(), leaseExpiresAt: renewedLeaseExpiresAt } });
      await tx.posOrderClaimOperation.create({ data: { claimId: claim.id, action: "renew", expectedVersion: 0, resultingVersion: 1, resultingState: "active", idempotencyKey: `pg-order-operation-renew-rogue-base-${token}`, requestHash: "2".repeat(64), leaseExpiresAt: renewedLeaseExpiresAt } });
      await tx.posOrderClaimOperation.create({ data: { claimId: claim.id, action: "release", expectedVersion: 1, resultingVersion: 2, resultingState: "released", idempotencyKey: `pg-order-operation-renew-rogue-future-${token}`, requestHash: "3".repeat(64), leaseExpiresAt: renewedLeaseExpiresAt } });
    }), /does not exactly match|operation ledger|23514/i, "operação futura rogue não pode ser pré-injetada junto de uma transição legítima");
    await first.$transaction(async tx => {
      await tx.posOrderClaim.update({ where: { id: claim.id }, data: { version: { increment: 1 }, renewedAt: new Date(), leaseExpiresAt: renewedLeaseExpiresAt } });
      await tx.posOrderClaimOperation.create({ data: { claimId: claim.id, action: "renew", expectedVersion: 0, resultingVersion: 1, resultingState: "active", idempotencyKey: `pg-order-operation-renew-${token}`, requestHash: "4".repeat(64), leaseExpiresAt: renewedLeaseExpiresAt } });
    });
    const [atomicRenew] = await first.$queryRaw<Array<{ sameTransaction: boolean }>>(Prisma.sql`SELECT c."lifecycle_txid" = o."write_txid" AS "sameTransaction" FROM "pos_order_claims" c JOIN "pos_order_claim_operations" o ON o."claim_id" = c."id" AND o."resulting_version" = c."version" WHERE c."id" = ${claim.id}`);
    assert.equal(atomicRenew?.sameTransaction, true, "claim e operação legítima compartilham a transação física");
    await assert.rejects(first.posOrderClaimOperation.create({ data: { claimId: claim.id, action: "release", expectedVersion: 1, resultingVersion: 2, resultingState: "released", idempotencyKey: `pg-order-operation-preinjected-future-${token}`, requestHash: "5".repeat(64), leaseExpiresAt: renewedLeaseExpiresAt } }), /does not exactly match|same database transaction|operation ledger|23514/i, "operação futura não pode ser pré-injetada em transação separada");
    await assert.rejects(first.posOrderClaimOperation.update({ where: { id: operation.id }, data: { resultingVersion: 99 } }), /append-only|operation/i);
    await assert.rejects(first.posOrderClaimOperation.delete({ where: { id: operation.id } }), /append-only|operation/i);
    await assert.rejects(first.posOrderClaim.delete({ where: { id: claim.id } }), /constraint|Foreign key|operation/i);
    await assert.rejects(first.cashRegisterSession.update({ where: { id: claim.sessionId }, data: { operatorProfileId: null } }), /constraint|Foreign key|operator_profile/i, "handoff não pode reatribuir silenciosamente o claim");
    await assert.rejects(first.salesOrder.update({ where: { id: order.id }, data: { customerName: "Mutação concorrente proibida" } }), /active pos_order_claim|commercial order transition|POS claim or converted sale blocks commercial order mutation/i, "pedido comercial fica congelado enquanto o claim está ativo");
    await assert.rejects(first.shipment.create({ data: { number: `PG-POS-SHIP-${token}`, salesOrderId: order.id, warehouseId: warehouse.id, createdBy: "postgres-test" } }), /claimed|converted|POS/i, "expedição não pode correr contra claim ativo");

    assert.equal(await first.posManualPaymentReference.count({ where: { saleDraftId: claim.id } }), 0, "310000 mantém novas referências manuais fora do fluxo de claim até 320000");

    const saleData = (suffix: string) => ({ saleNumber: `PG-POS-CONVERT-${suffix}-${token}`, customer: "Cliente teste", seller: "Teste", cashRegister: register.name, paymentMethod: "pix", total: 1, branchId: register.branchId, sessionId: claim.sessionId, operatorProfileId: profile.id, subtotalCents: 100, discountCents: 0, surchargeCents: 0, totalCents: 100, changeCents: 0, sourceType: "sales_order", sourceId: String(order.id), sourceCreationTxid: new Prisma.Decimal(3) });
    const sale = await first.$transaction(async tx => {
      const convertedSale = await tx.sale.create({ data: saleData("a") });
      const converted = await tx.posOrderClaim.updateMany({ where: { id: claim.id, state: "active", version: 1, convertedSaleId: null }, data: { state: "converted", version: { increment: 1 }, convertedSaleId: convertedSale.id, convertedAt: new Date() } });
      assert.equal(converted.count, 1);
      await tx.posOrderClaimOperation.create({ data: { claimId: claim.id, action: "convert", expectedVersion: 1, resultingVersion: 2, resultingState: "converted", idempotencyKey: `pg-order-operation-convert-${token}`, requestHash: "d".repeat(64), leaseExpiresAt: renewedLeaseExpiresAt } });
      await tx.stockReservation.update({ where: { id: reservation.id }, data: { status: "consumed", consumedAt: new Date() } });
      await tx.salesOrder.update({ where: { id: order.id }, data: { status: "completed", completedAt: new Date() } });
      await tx.salesOrderHistory.create({ data: { salesOrderId: order.id, fromStatus: "approved", toStatus: "completed", actor: "postgres-test" } });
      return convertedSale;
    }, { isolationLevel: "Serializable" });
    await assert.rejects(second.sale.create({ data: saleData("b") }), /unique|source/i, "a origem do pedido aceita somente uma venda");
    assert.equal(await first.sale.count({ where: { sourceType: "sales_order", sourceId: String(order.id) } }), 1);
    assert.equal((await first.posOrderClaim.findUniqueOrThrow({ where: { id: claim.id } })).convertedSaleId, sale.id);
    assert.equal(await first.posOrderClaimOperation.count({ where: { claimId: claim.id } }), 3);
    const [conversionMarkers] = await first.$queryRaw<Array<{ claimTxid: string; operationTxid: string; saleTxid: string }>>(Prisma.sql`
      SELECT c."lifecycle_txid"::text AS "claimTxid", o."write_txid"::text AS "operationTxid", s."source_creation_txid"::text AS "saleTxid"
      FROM "pos_order_claims" c
      JOIN "pos_order_claim_operations" o ON o."claim_id" = c."id" AND o."resulting_version" = c."version" AND o."action" = 'convert'
      JOIN "sales" s ON s."id" = c."converted_sale_id"
      WHERE c."id" = ${claim.id}
    `);
    assert.ok(conversionMarkers);
    assert.notEqual(conversionMarkers.saleTxid, "3", "trigger sobrescreve marcador da Sale fornecido pelo cliente");
    assert.equal(conversionMarkers.claimTxid, conversionMarkers.operationTxid);
    assert.equal(conversionMarkers.claimTxid, conversionMarkers.saleTxid, "claim, operação convert e Sale persistem o mesmo full-XID");
    await assert.rejects(first.salesOrderItem.update({ where: { id: orderItem.id }, data: { salesOrderId: ledgerlessOrder.id } }), /POS claim|converted sale|child mutation/i, "filho não pode escapar por reparenting a partir de pedido convertido");
    await assert.rejects(first.stockReservation.update({ where: { id: reservation.id }, data: { salesOrderId: ledgerlessOrder.id } }), /POS claim|converted sale|stock reservation/i, "reserva consumida não pode escapar por reparenting a partir de pedido convertido");
    await assert.rejects(first.orderPayment.create({ data: { salesOrderId: order.id, method: "pix", status: "pending", amount: 1 } }), /POS claim|converted sale|child mutation/i, "venda convertida impede nova cobrança no pedido original");
    await assert.rejects(first.shipment.create({ data: { number: `PG-POS-SHIP-AFTER-${token}`, salesOrderId: order.id, warehouseId: warehouse.id, createdBy: "postgres-test" } }), /claimed|converted|POS/i, "expedição não nasce depois da conversão");
    await first.cashRegisterSession.update({ where: { id: claim.sessionId }, data: { operatorProfileId: null } });
    assert.equal((await first.posOrderClaim.findUniqueOrThrow({ where: { id: claim.id } })).operatorProfileId, profile.id, "handoff posterior não reatribui a identidade histórica");
    const convertedIssue = await first.$transaction(tx => lockedPosPaymentDraftIssue(tx, { saleDraftId: claim.id, branchId: register.branchId, registerId: register.id, sessionId: claim.sessionId, operatorProfileId: profile.id, terminalId: claim.terminalId, paymentIndex: 0, payment: { method: "pix", amountCents: 100, installments: 1 } }));
    assert.match(convertedIssue || "", /não está ativa/);
  } finally {
    await Promise.all([first.$disconnect(), second.$disconnect()]);
  }
});

function client() {
  if (!connectionString) throw new Error("POS_TEST_DATABASE_URL não definida");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}
