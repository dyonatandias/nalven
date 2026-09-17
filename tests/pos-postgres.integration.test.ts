import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/tenant/client";
import { applyPosInventoryAdminMutation, type PosInventoryAdminInput } from "../lib/erp/pos-inventory-admin";
import { allocatePosTrackedSaleItem, restorePosTrackedSaleItem } from "../lib/erp/pos-inventory-operations";
import { hashPosPrintAck } from "../lib/erp/pos-print-ack";
import { assertPosDiscountApprovalContext } from "../lib/erp/pos-discount-approval";
import { applyPosCommonStockChange } from "../lib/erp/pos-common-stock";
import { applyPosValueCommand, hashPosValueCommand, issuePosValueAccount, type PosValueCommand } from "../lib/erp/pos-value-accounts";
import { accruePosSaleValues, reversePosSaleAccruals } from "../lib/erp/pos-value-sale";
import { executePosHeldCartTransfer, type PosHeldCartTransferContext, type PosHeldCartTransferInput } from "../lib/erp/pos-held-cart-transfer";
import { consumePosPaymentPlan } from "../lib/erp/pos-payment-plan";

const connectionString = process.env.POS_TEST_DATABASE_URL;

test("PostgreSQL disputa abertura por caixa e preserva somente um vencedor", { skip: !connectionString }, async () => {
  const first = client(), second = client();
  const token = randomUUID(), prefix = `PG-OPEN-${token}`;
  try {
    const register = await first.posRegister.findFirst({ where: { status: "active" }, select: { id: true, name: true } });
    assert.ok(register, "a base descartável deve ser migrada e semeada");
    const input = (suffix: string) => ({ number: `${prefix}-${suffix}`, registerName: register.name, status: "open", openingAmount: 0, openingAmountCents: 0, openedBy: "Teste PostgreSQL", registerId: register.id, openIdempotencyKey: `${token}-${suffix}`, openRequestHash: `hash-${suffix}` });
    const results = await Promise.allSettled([
      first.cashRegisterSession.create({ data: input("A") }),
      second.cashRegisterSession.create({ data: input("B") }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.equal(await first.cashRegisterSession.count({ where: { number: { startsWith: prefix } } }), 1);
  } finally {
    await first.cashRegisterSession.deleteMany({ where: { number: { startsWith: prefix } } }).catch(() => undefined);
    await Promise.all([first.$disconnect(), second.$disconnect()]);
  }
});

test("PostgreSQL deduplica evento financeiro sob escrita concorrente", { skip: !connectionString }, async () => {
  const first = client(), second = client();
  const token = randomUUID(), number = `PG-EVENT-${token}`, idempotencyKey = `event-${token}`;
  try {
    const session = await first.cashRegisterSession.create({ data: { number, registerName: "Caixa de teste", status: "closed", openingAmount: 0, openingAmountCents: 0, openedBy: "Teste PostgreSQL" } });
    const data = { sessionId: session.id, type: "supply", amount: 10, amountCents: 1000, description: "Teste concorrente", actor: "Teste PostgreSQL", idempotencyKey, requestHash: "same-hash" };
    const results = await Promise.allSettled([
      first.cashRegisterEvent.create({ data }),
      second.cashRegisterEvent.create({ data }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.equal(await first.cashRegisterEvent.count({ where: { idempotencyKey } }), 1);
  } finally {
    await first.cashRegisterSession.deleteMany({ where: { number } }).catch(() => undefined);
    await Promise.all([first.$disconnect(), second.$disconnect()]);
  }
});

test("PostgreSQL recusa equação monetária inválida", { skip: !connectionString }, async () => {
  const db = client(), saleNumber = `PG-BAD-MONEY-${randomUUID()}`;
  try {
    await assert.rejects(db.$executeRaw`
      INSERT INTO "sales" ("sale_number", "customer", "seller", "cash_register", "payment_method", "total", "status", "subtotal_cents", "discount_cents", "surcharge_cents", "total_cents", "change_cents")
      VALUES (${saleNumber}, 'Teste', 'Teste', 'Caixa', 'cash', 1.00, 'completed', 100, 0, 0, 99, 0)
    `);
    assert.equal(await db.sale.count({ where: { saleNumber } }), 0);
  } finally {
    await db.sale.deleteMany({ where: { saleNumber } }).catch(() => undefined);
    await db.$disconnect();
  }
});

test("PostgreSQL impede que o mesmo código aponte para produtos diferentes", { skip: !connectionString }, async () => {
  const first = client(), second = client();
  const token = randomUUID().replaceAll("-", "").toUpperCase();
  try {
    const products = await first.product.findMany({ where: { active: true }, select: { id: true }, take: 2, orderBy: { id: "asc" } });
    assert.equal(products.length, 2, "a base descartável deve possuir dois produtos ativos");
    const data = (productId: number, suffix: string) => ({ code: token, normalizedCode: token, symbology: "internal", scopeKey: "global", productId, metadata: { source: `postgres-test-${suffix}` } });
    const results = await Promise.allSettled([
      first.posProductCode.create({ data: data(products[0].id, "A") }),
      second.posProductCode.create({ data: data(products[1].id, "B") }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.equal(await first.posProductCode.count({ where: { normalizedCode: token, scopeKey: "global" } }), 1);
  } finally {
    await first.posProductCode.deleteMany({ where: { normalizedCode: token, scopeKey: "global" } }).catch(() => undefined);
    await Promise.all([first.$disconnect(), second.$disconnect()]);
  }
});

test("PostgreSQL reconhece uma única Sale por origem operacional", { skip: !connectionString }, async () => {
  const first = client(), second = client();
  const token = randomUUID(), sourceId = `order-${token}`;
  const data = (suffix: string) => ({ saleNumber: `PG-SOURCE-${token}-${suffix}`, customer: "Teste", seller: "Teste", cashRegister: "Caixa", paymentMethod: "cash", total: 1, status: "completed", subtotalCents: 100, discountCents: 0, surchargeCents: 0, totalCents: 100, changeCents: 0, sourceType: "sales_order", sourceId });
  try {
    const results = await Promise.allSettled([
      first.sale.create({ data: data("A") }),
      second.sale.create({ data: data("B") }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.equal(await first.sale.count({ where: { sourceType: "sales_order", sourceId } }), 1);
  } finally {
    await first.sale.deleteMany({ where: { sourceType: "sales_order", sourceId } }).catch(() => undefined);
    await Promise.all([first.$disconnect(), second.$disconnect()]);
  }
});

test("PostgreSQL deduplica mutação administrativa e exige resposta completa", { skip: !connectionString }, async () => {
  const first = client(), second = client();
  const key = `admin-${randomUUID()}`;
  const data = { key, actorId: "postgres-admin-test", action: "register.update", requestHash: "a".repeat(64), expiresAt: new Date(Date.now() + 60_000) };
  try {
    const results = await Promise.allSettled([
      first.pdvAdminMutation.create({ data }),
      second.pdvAdminMutation.create({ data }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.equal(await first.pdvAdminMutation.count({ where: { key } }), 1);
    await assert.rejects(first.pdvAdminMutation.update({ where: { key }, data: { state: "completed" } }));
    const completed = await first.pdvAdminMutation.update({ where: { key }, data: { state: "completed", responseStatus: 200, responseBody: { ok: true } } });
    assert.equal(completed.state, "completed");
  } finally {
    await first.pdvAdminMutation.deleteMany({ where: { key } }).catch(() => undefined);
    await Promise.all([first.$disconnect(), second.$disconnect()]);
  }
});

test("PostgreSQL aceita ações administrativas de promoção e impede código de cupom duplicado", { skip: !connectionString }, async () => {
  const first = client(), second = client();
  const token = randomUUID(), promotionId = `admin-promo-${token}`, codeHash = `sha256:${token.replaceAll("-", "")}`;
  const actions = ["promotion.create", "promotion.update", "promotion.deactivate", "coupon.create", "coupon.update", "coupon.rotate", "coupon.deactivate"];
  const keys = actions.map((action) => `promo-admin-${action}-${token}`);
  try {
    await first.pdvAdminMutation.createMany({ data: actions.map((action, index) => ({ key: keys[index], actorId: "postgres-promotion-admin", action, requestHash: String(index).padStart(64, "a").slice(-64), expiresAt: new Date(Date.now() + 60_000) })) });
    assert.equal(await first.pdvAdminMutation.count({ where: { key: { in: keys } } }), actions.length);
    await assert.rejects(first.pdvAdminMutation.create({ data: { key: `promo-admin-invalid-${token}`, actorId: "postgres-promotion-admin", action: "coupon.delete", requestHash: "f".repeat(64), expiresAt: new Date(Date.now() + 60_000) } }));
    await first.posPromotion.create({ data: { id: promotionId, name: "Admin cupom concorrente", status: "draft", conditions: { couponRequired: true }, effects: { type: "fixed", discountCents: 100 }, startsAt: new Date() } });
    const results = await Promise.allSettled([
      first.posCoupon.create({ data: { promotionId, codeHash, codeLastFour: "A001" } }),
      second.posCoupon.create({ data: { promotionId, codeHash, codeLastFour: "B002" } }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.equal(await first.posCoupon.count({ where: { codeHash } }), 1);
  } finally {
    await first.posCoupon.deleteMany({ where: { promotionId } }).catch(() => undefined);
    await first.posPromotion.deleteMany({ where: { id: promotionId } }).catch(() => undefined);
    await first.pdvAdminMutation.deleteMany({ where: { key: { in: [...keys, `promo-admin-invalid-${token}`] } } }).catch(() => undefined);
    await Promise.all([first.$disconnect(), second.$disconnect()]);
  }
});

test("PostgreSQL consome pareamento uma vez e protege lifecycle/claim do agente", { skip: !connectionString }, async () => {
  const first = client(), second = client();
  const token = randomUUID(), idempotencyKey = `pairing-${token}`, claimId = randomUUID();
  let terminalId: string | null = null;
  try {
    const register = await first.posRegister.findFirst({ where: { status: "active" }, select: { id: true } });
    assert.ok(register);
    const terminal = await first.posTerminal.create({ data: { registerId: register.id, code: `PG-${token}`, name: "Terminal PostgreSQL" } });
    terminalId = terminal.id;
    const pairing = await first.pdvTerminalPairing.create({ data: { terminalId, codeHash: `hmac-sha256:v1:${"a".repeat(64)}`, codeLastFour: "ABCD", idempotencyKey, requestHash: "b".repeat(64), correlationId: token, createdBy: "postgres-test", expiresAt: new Date(Date.now() + 60_000) } });
    const consumedAt = new Date();
    const results = await Promise.all([
      first.pdvTerminalPairing.updateMany({ where: { id: pairing.id, state: "pending" }, data: { state: "consumed", consumedAt, attempts: { increment: 1 } } }),
      second.pdvTerminalPairing.updateMany({ where: { id: pairing.id, state: "pending" }, data: { state: "consumed", consumedAt, attempts: { increment: 1 } } }),
    ]);
    assert.deepEqual(results.map(result => result.count).sort(), [0, 1]);
    await assert.rejects(first.posTerminal.update({ where: { id: terminalId }, data: { tokenHash: `hmac-sha256:v1:${"c".repeat(64)}` } }));
    const jobData = (suffix: string) => ({ terminalId: terminalId!, type: "receipt", referenceType: "test", referenceId: `${token}-${suffix}`, templateVersion: "v1", payload: { test: true }, requestedBy: "postgres-test", status: "processing", attempts: 1, claimId, claimedAt: new Date(), claimExpiresAt: new Date(Date.now() + 60_000) });
    const claims = await Promise.allSettled([first.posPrintJob.create({ data: jobData("A") }), second.posPrintJob.create({ data: jobData("B") })]);
    assert.equal(claims.filter(result => result.status === "fulfilled").length, 1);
  } finally {
    if (terminalId) {
      await first.posPrintJob.deleteMany({ where: { terminalId } }).catch(() => undefined);
      await first.posTerminal.delete({ where: { id: terminalId } }).catch(() => undefined);
    }
    await Promise.all([first.$disconnect(), second.$disconnect()]);
  }
});

test("PostgreSQL deduplica ACK e preserva claim histórico contra outro lease", { skip: !connectionString }, async () => {
  const first = client(), second = client();
  const token = randomUUID(), claimId = randomUUID();
  let terminalId: string | null = null;
  try {
    const register = await first.posRegister.findFirst({ where: { status: "active" }, select: { id: true } });
    assert.ok(register);
    const terminal = await first.posTerminal.create({ data: { registerId: register.id, code: `PG-ACK-${token}`, name: "Terminal ACK PostgreSQL" } });
    terminalId = terminal.id;
    const firstJob = await first.posPrintJob.create({ data: { terminalId, type: "receipt", referenceType: "test", referenceId: `${token}-A`, templateVersion: "v1", payload: { test: true }, requestedBy: "postgres-test", status: "printed", attempts: 1, printedAt: new Date() } });
    const secondJob = await first.posPrintJob.create({ data: { terminalId, type: "receipt", referenceType: "test", referenceId: `${token}-B`, templateVersion: "v1", payload: { test: true }, requestedBy: "postgres-test" } });
    const input = { terminalId, jobId: firstJob.id, claimId, state: "printed" as const, error: null };
    const data = { terminalId, jobId: firstJob.id, claimId, requestHash: hashPosPrintAck(input), state: input.state, resultStatus: "printed", attempt: 1, acknowledgedAt: new Date() };
    const created = await Promise.allSettled([first.posPrintAcknowledgement.create({ data }), second.posPrintAcknowledgement.create({ data })]);
    assert.equal(created.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(created.filter(result => result.status === "rejected").length, 1);
    assert.equal(await first.posPrintAcknowledgement.count({ where: { terminalId, jobId: firstJob.id, claimId } }), 1);
    await assert.rejects(first.posPrintAcknowledgement.create({ data: { ...data, jobId: secondJob.id } }), "claim antigo não pode ser associado a outro job/lease");
    await assert.rejects(first.posPrintAcknowledgement.create({ data: { ...data, claimId: randomUUID(), state: "printed", resultStatus: "queued" } }), "estado e resultado divergentes devem violar o CHECK");
  } finally {
    if (terminalId) {
      await first.posPrintAcknowledgement.deleteMany({ where: { terminalId } }).catch(() => undefined);
      await first.posPrintJob.deleteMany({ where: { terminalId } }).catch(() => undefined);
      await first.posTerminal.delete({ where: { id: terminalId } }).catch(() => undefined);
    }
    await Promise.all([first.$disconnect(), second.$disconnect()]);
  }
});

test("PostgreSQL enfileira uma única via original e permite reimpressões auditáveis", { skip: !connectionString }, async () => {
  const first = client(), second = client();
  const token = randomUUID(), saleNumber = `PG-PRINT-${token}`;
  let terminalId: string | null = null;
  try {
    const register = await first.posRegister.findFirst({ where: { status: "active" }, select: { id: true } });
    assert.ok(register);
    const terminal = await first.posTerminal.create({ data: { registerId: register.id, code: `PG-PRINT-${token}`, name: "Terminal produtor PostgreSQL" } });
    terminalId = terminal.id;
    const sale = await first.sale.create({ data: { saleNumber, customer: "Teste", seller: "Teste", cashRegister: "Caixa", paymentMethod: "cash", total: 1, status: "completed", subtotalCents: 100, discountCents: 0, surchargeCents: 0, totalCents: 100, changeCents: 0 } });
    const original = (suffix: string) => ({ terminalId: terminal.id, type: "receipt.original", referenceType: "sale", referenceId: String(sale.id), templateVersion: "receipt.v1", payload: { test: true }, requestedBy: "Teste", requestedById: "postgres-test", idempotencyKey: `print-original-${token}-${suffix}`, requestHash: suffix.repeat(64).slice(0, 64) });
    const originals = await Promise.allSettled([first.posPrintJob.create({ data: original("a") }), second.posPrintJob.create({ data: original("b") })]);
    assert.equal(originals.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(await first.posPrintJob.count({ where: { referenceType: "sale", referenceId: String(sale.id), type: "receipt.original" } }), 1);
    await first.posPrintJob.createMany({ data: ["a", "b"].map(suffix => ({ ...original(suffix), type: "receipt.reprint", idempotencyKey: `print-reprint-${token}-${suffix}` })) });
    assert.equal(await first.posPrintJob.count({ where: { referenceType: "sale", referenceId: String(sale.id), type: "receipt.reprint" } }), 2);
    await assert.rejects(first.posPrintJob.create({ data: { ...original("c"), type: "receipt.reprint", idempotencyKey: "curta" } }));
  } finally {
    if (terminalId) {
      await first.posPrintJob.deleteMany({ where: { terminalId } }).catch(() => undefined);
      await first.posTerminal.delete({ where: { id: terminalId } }).catch(() => undefined);
    }
    await first.sale.deleteMany({ where: { saleNumber } }).catch(() => undefined);
    await Promise.all([first.$disconnect(), second.$disconnect()]);
  }
});

test("PostgreSQL deduplica pedido de aprovação e permite um único consumo", { skip: !connectionString }, async () => {
  const first = client(), second = client();
  const token = randomUUID(), idempotencyKey = `approval-${token}`, requesterId = `requester-${token}`;
  try {
    const branch = await first.branch.findFirst({ where: { status: "active" }, select: { id: true } });
    assert.ok(branch, "a base descartável deve possuir filial ativa");
    const data = {
      branchId: branch.id,
      action: "cash.withdrawal",
      entityType: "cash_register_session",
      entityId: "1",
      status: "approved",
      requesterId,
      requesterName: "Operador",
      approverId: `approver-${token}`,
      approverName: "Supervisor",
      reason: "Sangria extraordinária autorizada no teste.",
      context: { amountCents: 1000 },
      correlationId: token,
      idempotencyKey,
      requestHash: "b".repeat(64),
      expiresAt: new Date(Date.now() + 60_000),
      decidedAt: new Date(),
    };
    const created = await Promise.allSettled([
      first.posApproval.create({ data }),
      second.posApproval.create({ data }),
    ]);
    assert.equal(created.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(created.filter((result) => result.status === "rejected").length, 1);
    const approval = await first.posApproval.findFirstOrThrow({ where: { branchId: branch.id, requesterId, idempotencyKey } });
    const consumedAt = new Date();
    const consumed = await Promise.all([
      first.posApproval.updateMany({ where: { id: approval.id, status: "approved", consumedAt: null }, data: { consumedAt, consumedBy: requesterId, consumptionRef: "operation-a" } }),
      second.posApproval.updateMany({ where: { id: approval.id, status: "approved", consumedAt: null }, data: { consumedAt, consumedBy: requesterId, consumptionRef: "operation-b" } }),
    ]);
    assert.deepEqual(consumed.map((result) => result.count).sort(), [0, 1]);
  } finally {
    await first.posApproval.deleteMany({ where: { requesterId } }).catch(() => undefined);
    await Promise.all([first.$disconnect(), second.$disconnect()]);
  }
});

test("PostgreSQL vincula divergência de fechamento à aprovação e protege os valores", { skip: !connectionString }, async () => {
  const db = client(), token = randomUUID(), requesterId = `close-requester-${token}`;
  const numbers = [`PG-CLOSE-${token}-OK`, `PG-CLOSE-${token}-BAD`];
  try {
    const branch = await db.branch.findFirst({ where: { status: "active" }, select: { id: true } });
    assert.ok(branch);
    const valid = await db.cashRegisterSession.create({ data: { number: numbers[0], registerName: "Caixa de teste", status: "closed", openingAmount: 0, openingAmountCents: 0, openedBy: "Teste PostgreSQL" } });
    const approval = await db.posApproval.create({ data: {
      branchId: branch.id, action: "session.close.divergence", entityType: "cash_register_session", entityId: String(valid.id), status: "approved",
      requesterId, requesterName: "Operador", approverId: `supervisor-${token}`, approverName: "Supervisor", reason: "Divergência de fechamento autorizada.", context: {},
      correlationId: token, idempotencyKey: `close-approval-${token}`, requestHash: "d".repeat(64), expiresAt: new Date(Date.now() + 60_000), decidedAt: new Date(),
    } });
    const closed = await db.cashRegisterSession.update({ where: { id: valid.id }, data: { status: "closed", differenceCents: -100, absoluteDifferenceCents: 100, closeApprovalId: approval.id } });
    assert.equal(closed.closeApprovalId, approval.id);
    const invalid = await db.cashRegisterSession.create({ data: { number: numbers[1], registerName: "Caixa de teste", status: "closed", openingAmount: 0, openingAmountCents: 0, openedBy: "Teste PostgreSQL" } });
    await assert.rejects(db.cashRegisterSession.update({ where: { id: invalid.id }, data: { differenceCents: -100, absoluteDifferenceCents: 99 } }));
    await assert.rejects(db.tenantSettings.update({ where: { id: 1 }, data: { posCloseToleranceCents: -1 } }));
  } finally {
    await db.cashRegisterSession.deleteMany({ where: { number: { in: numbers } } }).catch(() => undefined);
    await db.posApproval.deleteMany({ where: { requesterId } }).catch(() => undefined);
    await db.$disconnect();
  }
});

test("PostgreSQL concede uma única promoção/cupom no limite sob concorrência", { skip: !connectionString }, async () => {
  const first = client(), second = client();
  const token = randomUUID(), promotionId = `promo-${token}`, couponId = `coupon-${token}`;
  const saleNumbers = [`PG-PROMO-${token}-A`, `PG-PROMO-${token}-B`];
  try {
    const sales = await Promise.all(saleNumbers.map((saleNumber) => first.sale.create({ data: { saleNumber, customer: "Teste", seller: "Teste", cashRegister: "Caixa", paymentMethod: "cash", total: 1, status: "completed", subtotalCents: 100, discountCents: 0, surchargeCents: 0, totalCents: 100, changeCents: 0 } })));
    await first.posPromotion.create({ data: { id: promotionId, name: "Limite concorrente", priority: 1, status: "active", stackMode: "exclusive", conditions: { couponRequired: true }, effects: { type: "fixed", discountCents: 10 }, startsAt: new Date(Date.now() - 60_000), usageLimit: 1 } });
    await first.posCoupon.create({ data: { id: couponId, promotionId, codeHash: `sha256:${token.replaceAll("-", "")}`, codeLastFour: token.slice(-4), status: "active", usageLimit: 1 } });
    const redeem = (db: ReturnType<typeof client>, saleId: number) => db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "pos_promotions" WHERE "id" = ${promotionId} FOR UPDATE`;
      const used = await tx.posPromotionRedemption.count({ where: { promotionId, reversedAt: null } });
      if (used >= 1) throw new Error("promotion exhausted");
      const coupon = await tx.posCoupon.findUniqueOrThrow({ where: { id: couponId } });
      const claimed = await tx.posCoupon.updateMany({ where: { id: couponId, usedCount: coupon.usedCount }, data: { usedCount: { increment: 1 } } });
      if (claimed.count !== 1 || coupon.usedCount >= 1) throw new Error("coupon exhausted");
      return tx.posPromotionRedemption.create({ data: { promotionId, couponId, saleId, discountCents: 10, snapshot: { test: token } } });
    }, { isolationLevel: "Serializable" });
    const results = await Promise.allSettled([redeem(first, sales[0].id), redeem(second, sales[1].id)]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.equal(await first.posPromotionRedemption.count({ where: { promotionId } }), 1);
    assert.equal((await first.posCoupon.findUniqueOrThrow({ where: { id: couponId } })).usedCount, 1);
  } finally {
    await first.posPromotionRedemption.deleteMany({ where: { promotionId } }).catch(() => undefined);
    await first.posCoupon.deleteMany({ where: { id: couponId } }).catch(() => undefined);
    await first.posPromotion.deleteMany({ where: { id: promotionId } }).catch(() => undefined);
    await first.sale.deleteMany({ where: { saleNumber: { in: saleNumbers } } }).catch(() => undefined);
    await Promise.all([first.$disconnect(), second.$disconnect()]);
  }
});

test("PostgreSQL serializa o limite global de promoção automática", { skip: !connectionString }, async () => {
  const first = client(), second = client();
  const token = randomUUID(), promotionId = `auto-promo-${token}`;
  const saleNumbers = [`PG-AUTO-PROMO-${token}-A`, `PG-AUTO-PROMO-${token}-B`];
  try {
    const sales = await Promise.all(saleNumbers.map((saleNumber) => first.sale.create({ data: { saleNumber, customer: "Teste", seller: "Teste", cashRegister: "Caixa", paymentMethod: "cash", total: 1, status: "completed", subtotalCents: 100, discountCents: 0, surchargeCents: 0, totalCents: 100, changeCents: 0 } })));
    await first.posPromotion.create({ data: { id: promotionId, name: "Limite global concorrente", status: "active", conditions: {}, effects: { type: "fixed", discountCents: 10 }, startsAt: new Date(Date.now() - 60_000), usageLimit: 1 } });
    const redeem = (db: ReturnType<typeof client>, saleId: number) => db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "pos_promotions" WHERE "id" = ${promotionId} FOR UPDATE`;
      const used = await tx.posPromotionRedemption.count({ where: { promotionId, reversedAt: null } });
      if (used >= 1) throw new Error("promotion exhausted");
      return tx.posPromotionRedemption.create({ data: { promotionId, saleId, discountCents: 10, snapshot: { test: token } } });
    }, { isolationLevel: "Serializable" });
    const results = await Promise.allSettled([redeem(first, sales[0].id), redeem(second, sales[1].id)]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.equal(await first.posPromotionRedemption.count({ where: { promotionId } }), 1);
  } finally {
    await first.posPromotionRedemption.deleteMany({ where: { promotionId } }).catch(() => undefined);
    await first.posPromotion.deleteMany({ where: { id: promotionId } }).catch(() => undefined);
    await first.sale.deleteMany({ where: { saleNumber: { in: saleNumbers } } }).catch(() => undefined);
    await Promise.all([first.$disconnect(), second.$disconnect()]);
  }
});

test("PostgreSQL serializa o limite de promoção por cliente", { skip: !connectionString }, async () => {
  const first = client(), second = client();
  const token = randomUUID(), promotionId = `customer-promo-${token}`;
  const saleNumbers = [`PG-CUSTOMER-PROMO-${token}-A`, `PG-CUSTOMER-PROMO-${token}-B`];
  try {
    const customer = await first.customer.findFirst({ where: { status: "active" }, select: { id: true } });
    assert.ok(customer, "a base descartável deve possuir cliente ativo");
    const sales = await Promise.all(saleNumbers.map((saleNumber) => first.sale.create({ data: { saleNumber, customerId: customer.id, customer: "Teste", seller: "Teste", cashRegister: "Caixa", paymentMethod: "cash", total: 1, status: "completed", subtotalCents: 100, discountCents: 0, surchargeCents: 0, totalCents: 100, changeCents: 0 } })));
    await first.posPromotion.create({ data: { id: promotionId, name: "Limite por cliente", status: "active", conditions: {}, effects: { type: "fixed", discountCents: 10 }, startsAt: new Date(Date.now() - 60_000), usageLimit: 10, perCustomerLimit: 1 } });
    const redeem = (db: ReturnType<typeof client>, saleId: number) => db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "pos_promotions" WHERE "id" = ${promotionId} FOR UPDATE`;
      const used = await tx.posPromotionRedemption.count({ where: { promotionId, customerId: customer.id, reversedAt: null } });
      if (used >= 1) throw new Error("customer promotion exhausted");
      return tx.posPromotionRedemption.create({ data: { promotionId, saleId, customerId: customer.id, discountCents: 10, snapshot: { test: token } } });
    }, { isolationLevel: "Serializable" });
    const results = await Promise.allSettled([redeem(first, sales[0].id), redeem(second, sales[1].id)]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.equal(await first.posPromotionRedemption.count({ where: { promotionId, customerId: customer.id } }), 1);
  } finally {
    await first.posPromotionRedemption.deleteMany({ where: { promotionId } }).catch(() => undefined);
    await first.posPromotion.deleteMany({ where: { id: promotionId } }).catch(() => undefined);
    await first.sale.deleteMany({ where: { saleNumber: { in: saleNumbers } } }).catch(() => undefined);
    await Promise.all([first.$disconnect(), second.$disconnect()]);
  }
});

test("PostgreSQL reverte resgate/cupom uma vez sob replay e concorrência sem contador negativo", { skip: !connectionString }, async () => {
  const first = client(), second = client();
  const token = randomUUID(), promotionId = `reverse-promo-${token}`, couponId = `reverse-coupon-${token}`, brokenCouponId = `reverse-broken-${token}`;
  const saleNumbers = [`PG-REVERSE-${token}-A`, `PG-REVERSE-${token}-B`];
  const auditEntityType = `pg_promotion_reversal_${token}`;
  try {
    const sales = await Promise.all(saleNumbers.map((saleNumber) => first.sale.create({ data: { saleNumber, customer: "Teste", seller: "Teste", cashRegister: "Caixa", paymentMethod: "cash", total: 1, status: "completed", subtotalCents: 100, discountCents: 0, surchargeCents: 0, totalCents: 100, changeCents: 0 } })));
    await first.posPromotion.create({ data: { id: promotionId, name: "Reversão concorrente", status: "active", conditions: { couponRequired: true }, effects: { type: "fixed", discountCents: 10 }, startsAt: new Date(Date.now() - 60_000), usageLimit: 1 } });
    await first.posCoupon.createMany({ data: [
      { id: couponId, promotionId, codeHash: `sha256:${token.replaceAll("-", "")}a`, codeLastFour: "GOOD", usedCount: 1 },
      { id: brokenCouponId, promotionId, codeHash: `sha256:${token.replaceAll("-", "")}b`, codeLastFour: "ZERO", usedCount: 0 },
    ] });
    const redemption = await first.posPromotionRedemption.create({ data: { promotionId, couponId, saleId: sales[0].id, discountCents: 10, snapshot: { test: token } } });
    const broken = await first.posPromotionRedemption.create({ data: { promotionId, couponId: brokenCouponId, saleId: sales[1].id, discountCents: 10, snapshot: { test: token } } });
    const reverse = (db: ReturnType<typeof client>, redemptionId: bigint, expectedCouponId: string) => db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "pos_promotion_redemptions" WHERE "id" = ${redemptionId} FOR UPDATE`;
      const current = await tx.posPromotionRedemption.findUniqueOrThrow({ where: { id: redemptionId } });
      if (current.reversedAt) return false;
      await tx.$queryRaw`SELECT "id" FROM "pos_coupons" WHERE "id" = ${expectedCouponId} FOR UPDATE`;
      const coupon = await tx.posCoupon.findUniqueOrThrow({ where: { id: expectedCouponId } });
      if (coupon.usedCount < 1) throw new Error("coupon counter would become negative");
      const couponChanged = await tx.posCoupon.updateMany({ where: { id: coupon.id, usedCount: coupon.usedCount }, data: { usedCount: { decrement: 1 } } });
      if (couponChanged.count !== 1) throw new Error("coupon CAS failed");
      const reversedAt = new Date();
      const changed = await tx.posPromotionRedemption.updateMany({ where: { id: redemptionId, reversedAt: null }, data: { reversedAt, reversedBy: "postgres-test", reversalReason: "sale_cancel:postgres concurrency" } });
      if (changed.count !== 1) throw new Error("redemption CAS failed");
      await tx.tenantAuditEvent.create({ data: { action: "pos.promotion.redemption.reversed", entityType: auditEntityType, entityId: redemptionId.toString(), afterData: { couponId: expectedCouponId } } });
      return true;
    }, { isolationLevel: "Serializable" });
    const concurrent = await Promise.allSettled([reverse(first, redemption.id, couponId), reverse(second, redemption.id, couponId)]);
    assert.equal(concurrent.filter((result) => result.status === "fulfilled" && result.value === true).length, 1);
    assert.equal(await reverse(first, redemption.id, couponId), false, "replay deve ser no-op");
    assert.equal((await first.posCoupon.findUniqueOrThrow({ where: { id: couponId } })).usedCount, 0);
    assert.equal(await first.posPromotionRedemption.count({ where: { promotionId, reversedAt: null } }), 1, "somente o resgate não revertido permanece ativo");
    assert.equal(await first.tenantAuditEvent.count({ where: { entityType: auditEntityType } }), 1, "auditoria deve nascer uma única vez");
    await assert.rejects(reverse(first, broken.id, brokenCouponId), /negative/);
    assert.equal((await first.posCoupon.findUniqueOrThrow({ where: { id: brokenCouponId } })).usedCount, 0);
    assert.equal((await first.posPromotionRedemption.findUniqueOrThrow({ where: { id: broken.id } })).reversedAt, null);
    await assert.rejects(first.$executeRaw`UPDATE "pos_promotion_redemptions" SET "reversed_at" = now() WHERE "id" = ${broken.id}`);
    await assert.rejects(first.$executeRaw`UPDATE "pos_coupons" SET "used_count" = -1 WHERE "id" = ${brokenCouponId}`);
  } finally {
    await first.tenantAuditEvent.deleteMany({ where: { entityType: auditEntityType } }).catch(() => undefined);
    await first.posPromotionRedemption.deleteMany({ where: { promotionId } }).catch(() => undefined);
    await first.posCoupon.deleteMany({ where: { id: { in: [couponId, brokenCouponId] } } }).catch(() => undefined);
    await first.posPromotion.deleteMany({ where: { id: promotionId } }).catch(() => undefined);
    await first.sale.deleteMany({ where: { saleNumber: { in: saleNumbers } } }).catch(() => undefined);
    await Promise.all([first.$disconnect(), second.$disconnect()]);
  }
});

test("PostgreSQL impede série duplicada e movimento rastreado inconsistente", { skip: !connectionString }, async () => {
  const first = client(), second = client();
  const token = randomUUID().replaceAll("-", "").toUpperCase(), serial = `PGSERIAL${token}`;
  try {
    const balance = await first.warehouseBalance.findFirst({ select: { warehouseId: true, productId: true } });
    assert.ok(balance, "a base descartável deve possuir saldo de depósito");
    const lot = (suffix: string) => ({
      id: `pg-lot-${token}-${suffix}`,
      warehouseId: balance.warehouseId,
      productId: balance.productId,
      serialNumber: serial,
      normalizedSerialNumber: serial,
      status: "available",
      quantityMicros: BigInt(1_000_000),
      reservedMicros: BigInt(0),
    });
    const created = await Promise.allSettled([
      first.posInventoryLot.create({ data: lot("A") }),
      second.posInventoryLot.create({ data: lot("B") }),
    ]);
    assert.equal(created.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(created.filter((result) => result.status === "rejected").length, 1);
    const winner = await first.posInventoryLot.findFirstOrThrow({ where: { normalizedSerialNumber: serial } });
    await assert.rejects(first.$transaction((tx) => allocatePosTrackedSaleItem(tx, {
      warehouseId: winner.warehouseId,
      productId: winner.productId,
      variationId: winner.variationId,
      saleItemId: 2_147_483_647,
      quantity: 1,
      businessDate: "2026-08-29",
      idempotencyKey: `pg-serial-unread-${token}`,
      actor: "postgres-test",
      referenceId: `unread-${token}`,
    }), { isolationLevel: "Serializable" }), /série exato de cada unidade/);
    assert.equal((await first.posInventoryLot.findUniqueOrThrow({ where: { id: winner.id } })).quantityMicros, BigInt(1_000_000));
    await assert.rejects(first.posInventoryLotMovement.create({ data: {
      lotId: winner.id,
      type: "sale",
      quantityMicros: BigInt(-1_000_000),
      balanceBeforeMicros: BigInt(1_000_000),
      balanceAfterMicros: BigInt(1),
      actor: "postgres-test",
    } }));
    assert.equal(await first.posInventoryLotMovement.count({ where: { lotId: winner.id } }), 0);
  } finally {
    await first.posInventoryLotMovement.deleteMany({ where: { lot: { normalizedSerialNumber: serial } } }).catch(() => undefined);
    await first.posInventoryLot.deleteMany({ where: { normalizedSerialNumber: serial } }).catch(() => undefined);
    await Promise.all([first.$disconnect(), second.$disconnect()]);
  }
});

test("PostgreSQL baixa FEFO e segrega devolução batch parcial em quarentena", { skip: !connectionString }, async () => {
  const db = client(), token = randomUUID().replaceAll("-", "").toUpperCase(), saleNumber = `PG-TRACK-${token}`;
  let saleId: number | null = null;
  const lotCode = `LOT${token}`;
  try {
    const balance = await db.warehouseBalance.findFirst({ select: { warehouseId: true, productId: true } });
    assert.ok(balance, "a base descartável deve possuir saldo de depósito");
    const sale = await db.sale.create({ data: {
      saleNumber, warehouseId: balance.warehouseId, customer: "Teste", seller: "Teste", cashRegister: "Caixa", paymentMethod: "cash",
      total: 2, status: "completed", subtotalCents: 200, discountCents: 0, surchargeCents: 0, totalCents: 200, changeCents: 0,
      items: { create: { productId: balance.productId, productName: "Produto rastreado", quantity: 2, unitPrice: 1, total: 2, unitPriceCents: 100, grossCents: 200, discountCents: 0, surchargeCents: 0, totalCents: 200 } },
    }, include: { items: true } });
    saleId = sale.id;
    const lot = await db.posInventoryLot.create({ data: {
      id: `pg-track-${token}`, warehouseId: balance.warehouseId, productId: balance.productId, lotCode, normalizedLotCode: lotCode,
      bucketKey: "sellable", status: "available", quantityMicros: BigInt(3_000_000), reservedMicros: BigInt(0), expiresOn: new Date("2027-12-31T00:00:00Z"),
    } });
    const allocated = await db.$transaction((tx) => allocatePosTrackedSaleItem(tx, {
      warehouseId: balance.warehouseId, productId: balance.productId, variationId: null, saleItemId: sale.items[0].id, quantity: 2,
      scanData: { lot: lotCode }, businessDate: "2026-08-28", idempotencyKey: `pg-sale-${token}`, actor: "postgres-test", referenceId: String(sale.id),
    }), { isolationLevel: "Serializable" });
    assert.equal(allocated.tracked, true);
    assert.equal((await db.posInventoryLot.findUniqueOrThrow({ where: { id: lot.id } })).quantityMicros, BigInt(1_000_000));

    const restored = await db.$transaction((tx) => restorePosTrackedSaleItem(tx, {
      saleItemId: sale.items[0].id, quantity: 0.5, disposition: "quarantine", businessDate: "2026-08-28",
      idempotencyKey: `pg-return-${token}`, actor: "postgres-test", referenceType: "sale_cancel", referenceId: String(sale.id),
    }), { isolationLevel: "Serializable" });
    assert.equal(restored.aggregateQuantityDelta, 0);
    const [sellable, quarantine] = await Promise.all([
      db.posInventoryLot.findUniqueOrThrow({ where: { id: lot.id } }),
      db.posInventoryLot.findFirstOrThrow({ where: { warehouseId: balance.warehouseId, productId: balance.productId, normalizedLotCode: lotCode, bucketKey: "quarantine" } }),
    ]);
    assert.equal(sellable.quantityMicros, BigInt(1_000_000));
    assert.equal(sellable.status, "available");
    assert.equal(quarantine.quantityMicros, BigInt(500_000));
    assert.equal(quarantine.status, "quarantine");
    assert.deepEqual((await db.posInventoryLotMovement.findMany({ where: { referenceId: String(sale.id) }, orderBy: { id: "asc" } })).map((movement) => movement.type), ["sale", "return", "transfer_out", "transfer_in"]);
    await assert.rejects(db.$transaction((tx) => restorePosTrackedSaleItem(tx, {
      saleItemId: sale.items[0].id, quantity: 2, disposition: "restock", businessDate: "2026-08-28",
      idempotencyKey: `pg-return-over-${token}`, actor: "postgres-test", referenceType: "sale_cancel", referenceId: String(sale.id),
    }), { isolationLevel: "Serializable" }), /supera o saldo rastreado/);
  } finally {
    if (saleId) await db.posInventoryLotMovement.deleteMany({ where: { referenceId: String(saleId) } }).catch(() => undefined);
    await db.posInventoryLot.deleteMany({ where: { normalizedLotCode: lotCode } }).catch(() => undefined);
    await db.sale.deleteMany({ where: { saleNumber } }).catch(() => undefined);
    await db.$disconnect();
  }
});

test("PostgreSQL administra recebimento e buckets com saldo agregado, isolamento e concorrência", { skip: !connectionString }, async () => {
  const first = client(), second = client();
  const token = randomUUID().replaceAll("-", "").toUpperCase();
  const lotCode = `ADMINLOT${token}`, normalizedLotCode = lotCode;
  const slug = `pg-inventory-admin-${token.toLowerCase()}`, sku = `PGIA${token}`;
  const referencePrefix = `pg-inventory-admin:${token}`;
  let productId: number | null = null;
  try {
    const warehouse = await first.warehouse.findFirst({
      where: { active: true, branch: { status: "active" } },
      select: { id: true, branchId: true },
      orderBy: [{ primary: "desc" }, { id: "asc" }],
    });
    assert.ok(warehouse?.branchId, "a base descartável deve possuir depósito ativo vinculado a filial ativa");
    const product = await first.product.create({ data: { name: "Produto rastreado administrativo", slug, sku, category: "Teste", stock: 0, manageStock: true, active: true } });
    productId = product.id;
    await first.branchProduct.create({ data: { branchId: warehouse.branchId, productId, active: true, saleEnabled: true, purchaseEnabled: true, preferredWarehouseId: warehouse.id } });

    const mutate = (db: ReturnType<typeof client>, input: PosInventoryAdminInput) => db.$transaction(
      tx => applyPosInventoryAdminMutation(tx, input, { actor: "postgres-test", businessDate: "2026-08-29" }),
      { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 },
    );
    const receiveKey = `${referencePrefix}:receive:00000000`;
    const received = await mutate(first, {
      action: "inventory.receive", idempotencyKey: receiveKey, branchId: warehouse.branchId, warehouseId: warehouse.id, productId,
      variationId: null, lotCode, serialNumber: null, manufacturedOn: "2026-08-01", expiresOn: "2027-12-31", quantity: 3, note: "Recebimento PostgreSQL",
    });
    assert.equal(received.status, 201);
    let sellable = await first.posInventoryLot.findFirstOrThrow({ where: { productId, normalizedLotCode, bucketKey: "sellable" } });
    assert.equal(sellable.quantityMicros, BigInt(3_000_000));
    await assert.rejects(mutate(first, {
      action: "inventory.receive", idempotencyKey: `${referencePrefix}:rewrite-history:00000000`, branchId: warehouse.branchId, warehouseId: warehouse.id, productId,
      variationId: null, lotCode, serialNumber: null, manufacturedOn: "2026-08-01", expiresOn: "2028-12-31", quantity: 1, note: "Tentativa de alterar validade",
    }), /histórico não pode ser editado/);
    assert.equal((await first.posInventoryLot.findUniqueOrThrow({ where: { id: sellable.id } })).quantityMicros, BigInt(3_000_000));

    await assert.rejects(mutate(first, {
      action: "inventory.release", idempotencyKey: `${referencePrefix}:bad-release:00000000`, branchId: warehouse.branchId,
      lotId: sellable.id, quantity: 0.25, reason: "Não está em quarentena",
    }), /Somente bucket de quarentena/);
    await assert.rejects(mutate(first, {
      action: "inventory.discard", idempotencyKey: `${referencePrefix}:wrong-branch:00000000`, branchId: 2_147_483_647,
      lotId: sellable.id, quantity: 0.25, reason: "Escopo de filial divergente",
    }), /Filial ativa não encontrada/);
    assert.equal((await first.posInventoryLot.findUniqueOrThrow({ where: { id: sellable.id } })).quantityMicros, BigInt(3_000_000));

    await mutate(first, {
      action: "inventory.quarantine", idempotencyKey: `${referencePrefix}:quarantine:00000000`, branchId: warehouse.branchId,
      lotId: sellable.id, quantity: 1, reason: "Inspeção de qualidade",
    });
    sellable = await first.posInventoryLot.findUniqueOrThrow({ where: { id: sellable.id } });
    let quarantine = await first.posInventoryLot.findFirstOrThrow({ where: { productId, normalizedLotCode, bucketKey: "quarantine" } });
    assert.equal(sellable.quantityMicros, BigInt(2_000_000));
    assert.equal(sellable.status, "available");
    assert.equal(quarantine.quantityMicros, BigInt(1_000_000));

    await mutate(first, {
      action: "inventory.release", idempotencyKey: `${referencePrefix}:release:00000000`, branchId: warehouse.branchId,
      lotId: quarantine.id, quantity: 0.25, reason: "Inspeção aprovada",
    });
    quarantine = await first.posInventoryLot.findUniqueOrThrow({ where: { id: quarantine.id } });
    sellable = await first.posInventoryLot.findUniqueOrThrow({ where: { id: sellable.id } });
    assert.equal(quarantine.quantityMicros, BigInt(750_000));
    assert.equal(sellable.quantityMicros, BigInt(2_250_000));

    await mutate(first, {
      action: "inventory.discard", idempotencyKey: `${referencePrefix}:discard:00000000`, branchId: warehouse.branchId,
      lotId: quarantine.id, quantity: 0.25, reason: "Amostra destruída",
    });
    const concurrent = await Promise.allSettled([
      mutate(first, { action: "inventory.discard", idempotencyKey: `${referencePrefix}:race-a:00000000`, branchId: warehouse.branchId, lotId: quarantine.id, quantity: 0.5, reason: "Descarte concorrente A" }),
      mutate(second, { action: "inventory.discard", idempotencyKey: `${referencePrefix}:race-b:00000000`, branchId: warehouse.branchId, lotId: quarantine.id, quantity: 0.5, reason: "Descarte concorrente B" }),
    ]);
    assert.equal(concurrent.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(concurrent.filter(result => result.status === "rejected").length, 1);
    quarantine = await first.posInventoryLot.findUniqueOrThrow({ where: { id: quarantine.id } });
    assert.equal(quarantine.quantityMicros, BigInt(0));
    assert.equal(quarantine.status, "quarantine", "descarte em quarentena não altera o bucket vendável");
    sellable = await first.posInventoryLot.findUniqueOrThrow({ where: { id: sellable.id } });
    assert.equal(sellable.quantityMicros, BigInt(2_250_000));
    assert.equal(sellable.status, "available");

    const [balance, savedProduct] = await Promise.all([
      first.warehouseBalance.findUniqueOrThrow({ where: { warehouseId_productId: { warehouseId: warehouse.id, productId } } }),
      first.product.findUniqueOrThrow({ where: { id: productId } }),
    ]);
    assert.equal(balance.quantity, 2.25);
    assert.equal(savedProduct.stock, 2.25);
    assert.equal(await first.posInventoryLotMovement.count({ where: { lot: { productId }, referenceType: "pos_inventory_admin" } }), 7);
    assert.equal(await first.warehouseLedgerEntry.count({ where: { productId, referenceId: { startsWith: referencePrefix } } }), 3);
  } finally {
    if (productId) {
      await first.posInventoryLotMovement.deleteMany({ where: { lot: { productId } } }).catch(() => undefined);
      await first.posInventoryLot.deleteMany({ where: { productId } }).catch(() => undefined);
      await first.warehouseLedgerEntry.deleteMany({ where: { productId } }).catch(() => undefined);
      await first.stockMovement.deleteMany({ where: { productId, note: { contains: referencePrefix } } }).catch(() => undefined);
      await first.warehouseBalance.deleteMany({ where: { productId } }).catch(() => undefined);
      await first.branchProduct.deleteMany({ where: { productId } }).catch(() => undefined);
      await first.product.delete({ where: { id: productId } }).catch(() => undefined);
    }
    await Promise.all([first.$disconnect(), second.$disconnect()]);
  }
});

test("PostgreSQL serializa cursor offline e aceita um único dono para a próxima sequência", { skip: !connectionString }, async () => {
  const first = client(), second = client();
  const token = randomUUID(), terminalId = `pg-sync-${token}`;
  try {
    const register = await first.posRegister.findFirst({ where: { status: "active" }, select: { id: true } });
    assert.ok(register, "a base descartável deve possuir caixa ativo");
    await first.posTerminal.create({ data: { id: terminalId, registerId: register.id, code: `PG-SYNC-${token}`, name: "Terminal sync PostgreSQL", status: "online" } });
    const push = (db: ReturnType<typeof client>, operationId: string) => db.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "pos_terminals" WHERE "id" = ${terminalId} FOR UPDATE`;
      const terminal = await tx.posTerminal.findUniqueOrThrow({ where: { id: terminalId }, select: { lastSyncCursor: true } });
      if (terminal.lastSyncCursor !== BigInt(0)) throw new Error("cursor avançou");
      const created = await tx.posSyncOperation.create({ data: {
        terminalId, operationId, sequence: BigInt(1), type: "terminal.heartbeat", state: "applied", requestHash: "a".repeat(64), payload: {}, response: { accepted: true }, occurredAt: new Date(), processedAt: new Date(),
      } });
      await tx.posTerminal.update({ where: { id: terminalId }, data: { lastSyncCursor: BigInt(1) } });
      return created;
    }, { isolationLevel: "Serializable" });
    const results = await Promise.allSettled([push(first, randomUUID()), push(second, randomUUID())]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results.filter(result => result.status === "rejected").length, 1);
    assert.equal(await first.posSyncOperation.count({ where: { terminalId } }), 1);
    assert.equal((await first.posTerminal.findUniqueOrThrow({ where: { id: terminalId } })).lastSyncCursor, BigInt(1));
  } finally {
    await first.posSyncOperation.deleteMany({ where: { terminalId } }).catch(() => undefined);
    await first.posTerminal.deleteMany({ where: { id: terminalId } }).catch(() => undefined);
    await Promise.all([first.$disconnect(), second.$disconnect()]);
  }
});

test("PostgreSQL recusa estado, ciclo, payload e cursor offline inválidos", { skip: !connectionString }, async () => {
  const db = client(), token = randomUUID(), terminalId = `pg-sync-check-${token}`;
  try {
    const register = await db.posRegister.findFirst({ where: { status: "active" }, select: { id: true } });
    assert.ok(register);
    await db.posTerminal.create({ data: { id: terminalId, registerId: register.id, code: `PG-SYNC-CHECK-${token}`, name: "Terminal checks offline" } });
    await assert.rejects(db.posTerminal.update({ where: { id: terminalId }, data: { lastSyncCursor: BigInt(-1) } }));
    await assert.rejects(db.$executeRaw`
      INSERT INTO "pos_sync_operations" ("terminal_id", "operation_id", "sequence", "type", "state", "request_hash", "payload", "occurred_at")
      VALUES (${terminalId}, ${randomUUID()}, 1, 'terminal.heartbeat', 'paid', ${"b".repeat(64)}, '{}'::jsonb, NOW())
    `);
    await assert.rejects(db.$executeRaw`
      INSERT INTO "pos_sync_operations" ("terminal_id", "operation_id", "sequence", "type", "state", "request_hash", "payload", "occurred_at", "processed_at")
      VALUES (${terminalId}, ${randomUUID()}, 2, 'terminal.heartbeat', 'applied', ${"c".repeat(64)}, '[]'::jsonb, NOW(), NOW())
    `);
    assert.equal(await db.posSyncOperation.count({ where: { terminalId } }), 0);
  } finally {
    await db.posSyncOperation.deleteMany({ where: { terminalId } }).catch(() => undefined);
    await db.posTerminal.deleteMany({ where: { id: terminalId } }).catch(() => undefined);
    await db.$disconnect();
  }
});

test("PostgreSQL consome aprovação de desconto uma vez sob concorrência e preserva contexto exato", { skip: !connectionString }, async () => {
  const first = client(), second = client();
  const token = randomUUID(), requesterId = `discount-requester-${token}`, saleDraftId = `sale-draft-${token}`;
  const context = { saleDraftId, sessionId: 9, grossCents: 10_000, manualDiscountCents: 1_001, basisPoints: 1_001 };
  try {
    const branch = await first.branch.findFirst({ where: { status: "active" }, select: { id: true } });
    assert.ok(branch);
    const approval = await first.posApproval.create({ data: {
      branchId: branch.id,
      action: "discount.override",
      entityType: "sale_draft",
      entityId: saleDraftId,
      status: "approved",
      requesterId,
      requesterName: "Operador",
      approverId: `supervisor-${token}`,
      approverName: "Supervisor",
      reason: "Desconto excepcional autorizado no teste.",
      context,
      correlationId: token,
      idempotencyKey: `discount:${token}`,
      requestHash: "e".repeat(64),
      expiresAt: new Date(Date.now() + 60_000),
      decidedAt: new Date(),
    } });
    const persisted = await first.posApproval.findUniqueOrThrow({ where: { id: approval.id }, select: { context: true } });
    assert.doesNotThrow(() => assertPosDiscountApprovalContext(persisted.context, context));
    assert.throws(() => assertPosDiscountApprovalContext(persisted.context, { ...context, manualDiscountCents: 1_002, basisPoints: 1_002 }), /não corresponde/);
    const consumedAt = new Date();
    const consumed = await Promise.all([
      first.posApproval.updateMany({ where: { id: approval.id, status: "approved", consumedAt: null, expiresAt: { gt: consumedAt } }, data: { consumedAt, consumedBy: requesterId, consumptionRef: saleDraftId } }),
      second.posApproval.updateMany({ where: { id: approval.id, status: "approved", consumedAt: null, expiresAt: { gt: consumedAt } }, data: { consumedAt, consumedBy: requesterId, consumptionRef: `${saleDraftId}:other` } }),
    ]);
    assert.deepEqual(consumed.map(result => result.count).sort(), [0, 1]);
    const final = await first.posApproval.findUniqueOrThrow({ where: { id: approval.id } });
    assert.equal(final.consumedBy, requesterId);
    assert.ok([saleDraftId, `${saleDraftId}:other`].includes(final.consumptionRef || ""));
  } finally {
    await first.posApproval.deleteMany({ where: { requesterId } }).catch(() => undefined);
    await Promise.all([first.$disconnect(), second.$disconnect()]);
  }
});

test("PostgreSQL serializa conta de valor, permite nova reserva após liberação e bloqueia mutação do ledger", { skip: !connectionString }, async () => {
  const first = client(), second = client();
  const token = randomUUID();
  const now = new Date("2026-08-29T12:00:00.000Z"), expiresAt = new Date("2026-08-30T12:00:00.000Z");
  const context = { actor: "postgres-value-test", now };
  const referenceType = "postgres_value_test", referenceId = `value-${token}`;
  const operation = (name: string) => ({
    operationKey: `value:${name}:${token}`,
    requestHash: hashPosValueCommand({ token, name }),
    referenceType,
    referenceId,
    reason: `Movimentação PostgreSQL ${name}`,
  });
  const run = (db: ReturnType<typeof client>, command: PosValueCommand, commandNow = now) => db.$transaction(
    tx => applyPosValueCommand(tx, command, { actor: context.actor, now: commandNow }),
    { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 },
  );
  try {
    const branch = await first.branch.findFirst({ where: { status: "active" }, select: { id: true } });
    assert.ok(branch, "a base descartável deve possuir filial ativa");
    const customer = await first.customer.create({ data: {
      name: `Cliente valor ${token}`,
      document: `PGVALUE${token.replaceAll("-", "")}`,
      status: "active",
    } });
    const program = await first.posValueProgram.create({ data: {
      branchId: branch.id,
      name: `Programa PostgreSQL ${token}`,
      kind: "loyalty_points",
      earnUnits: 1,
      spendCents: 100,
      redeemCentsPerUnit: 1,
    } });
    const issueProgramAccount = (db: ReturnType<typeof client>, name: string) => db.$transaction(tx => issuePosValueAccount(tx, {
      ...operation(name),
      branchId: branch.id,
      customerId: customer.id,
      programId: program.id,
      kind: "loyalty_points",
      label: `Pontos PostgreSQL ${name}`,
      initialUnits: 0,
      expiresAt: null,
    }, context), { isolationLevel: "Serializable" });
    const programRace = await Promise.allSettled([
      issueProgramAccount(first, "program-race-a"),
      issueProgramAccount(second, "program-race-b"),
    ]);
    assert.equal(programRace.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(programRace.filter(result => result.status === "rejected").length, 1);
    assert.equal(await first.posValueAccount.count({ where: { programId: program.id, customerId: customer.id } }), 1);
    const syntheticSaleId = 1_500_000_000 + customer.id;
    const accrued = await first.$transaction(tx => accruePosSaleValues(tx, { branchId: branch.id, customerId: customer.id, customerName: customer.name, saleId: syntheticSaleId, saleKey: `sale-accrual-${token}`, totalCents: 999, actor: context.actor, now: context.now }), { isolationLevel: "Serializable" });
    const programAccrual = accrued.find(entry => entry.programId === program.id);
    assert.ok(programAccrual);
    assert.equal(programAccrual.units, 9);
    await first.$transaction(tx => reversePosSaleAccruals(tx, { branchId: branch.id, saleId: syntheticSaleId, saleTotalCents: 999, returnedCents: 333, operationKeyRoot: `return-partial-${token}`, reason: "Devolução parcial PostgreSQL", actor: context.actor, now: context.now }), { isolationLevel: "Serializable" });
    assert.equal((await first.posValueAccount.findUniqueOrThrow({ where: { id: programAccrual.accountId } })).balanceUnits, BigInt(6));
    await first.$transaction(tx => reversePosSaleAccruals(tx, { branchId: branch.id, saleId: syntheticSaleId, saleTotalCents: 999, returnedCents: 999, operationKeyRoot: `return-full-${token}`, reason: "Devolução integral PostgreSQL", actor: context.actor, now: context.now }), { isolationLevel: "Serializable" });
    assert.equal((await first.posValueAccount.findUniqueOrThrow({ where: { id: programAccrual.accountId } })).balanceUnits, BigInt(0));

    const issued = await first.$transaction(tx => issuePosValueAccount(tx, {
      ...operation("issue"),
      branchId: branch.id,
      customerId: customer.id,
      programId: null,
      kind: "store_credit",
      label: "Crédito-loja PostgreSQL",
      initialUnits: 0,
      expiresAt,
    }, context), { isolationLevel: "Serializable" });
    assert.equal(issued.account.balanceUnits, "0");
    assert.equal(issued.entry.type, "issue");
    assert.equal(issued.entry.amountUnits, "0", "emissão zerada deve ter replay coerente com o CHECK do ledger");

    const credited = await run(first, { ...operation("credit"), type: "credit", accountId: issued.account.id, branchId: branch.id, amountUnits: 1_000 });
    assert.equal(credited.account.balanceUnits, "1000");
    const raced = await Promise.allSettled([
      run(first, { ...operation("debit-a"), type: "debit", accountId: issued.account.id, branchId: branch.id, amountUnits: 800 }),
      run(second, { ...operation("debit-b"), type: "debit", accountId: issued.account.id, branchId: branch.id, amountUnits: 800 }),
    ]);
    assert.equal(raced.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(raced.filter(result => result.status === "rejected").length, 1);
    assert.equal((await first.posValueAccount.findUniqueOrThrow({ where: { id: issued.account.id } })).balanceUnits, BigInt(200));

    await run(first, { ...operation("restore-credit"), type: "credit", accountId: issued.account.id, branchId: branch.id, amountUnits: 800 });
    const firstReserve = await run(first, {
      ...operation("reserve-first"), type: "reserve", accountId: issued.account.id, branchId: branch.id, amountUnits: 700,
      expiresAt: new Date("2026-08-29T13:00:00.000Z"),
    });
    assert.ok(firstReserve.reservation);
    const releaseCommand = {
      ...operation("release-first"), type: "release" as const, reservationId: firstReserve.reservation.id, branchId: branch.id,
    };
    const released = await run(first, releaseCommand);
    assert.equal(released.reservation?.state, "released");
    const replayedRelease = await run(first, releaseCommand);
    assert.equal(replayedRelease.replayed, true);
    assert.equal(replayedRelease.reservation?.state, "released", "retry idempotente não pode reativar uma reserva finalizada");

    const freshReserve = await run(first, {
      ...operation("reserve-fresh"), type: "reserve", accountId: issued.account.id, branchId: branch.id, amountUnits: 700,
      expiresAt: new Date("2026-08-29T14:00:00.000Z"),
    });
    assert.ok(freshReserve.reservation);
    assert.notEqual(freshReserve.reservation.id, firstReserve.reservation.id);
    assert.equal(freshReserve.reservation.referenceType, firstReserve.reservation.referenceType);
    assert.equal(freshReserve.reservation.referenceId, firstReserve.reservation.referenceId);
    const captured = await run(first, {
      ...operation("capture-fresh"), type: "capture", reservationId: freshReserve.reservation.id, branchId: branch.id,
    });
    assert.equal(captured.account.balanceUnits, "300");
    assert.equal(captured.account.reservedUnits, "0");
    const reversed = await run(first, {
      ...operation("reverse-capture"), type: "reverse", entryId: BigInt(captured.entry.id), branchId: branch.id,
    });
    assert.equal(reversed.account.balanceUnits, "1000");
    await assert.rejects(run(first, {
      ...operation("reverse-capture-again"), type: "reverse", entryId: BigInt(captured.entry.id), branchId: branch.id,
    }), /já estornado/);

    const expired = await run(first, {
      ...operation("expire"), type: "expire", accountId: issued.account.id, branchId: branch.id,
    }, new Date("2026-08-31T12:00:00.000Z"));
    assert.equal(expired.account.balanceUnits, "0");
    assert.equal(expired.account.status, "expired");
    await assert.rejects(first.$executeRaw`UPDATE "pos_value_ledger_entries" SET "reason" = 'Histórico alterado' WHERE "id" = ${BigInt(expired.entry.id)}`);
    await assert.rejects(first.$executeRaw`DELETE FROM "pos_value_ledger_entries" WHERE "id" = ${BigInt(expired.entry.id)}`);
    const entries = await first.posValueLedgerEntry.findMany({ where: { accountId: issued.account.id }, orderBy: { id: "asc" } });
    assert.equal(entries.length, 10);
    for (const entry of entries) {
      assert.equal(entry.balanceAfterUnits, entry.balanceBeforeUnits + entry.balanceDeltaUnits);
      assert.equal(entry.reservedAfterUnits, entry.reservedBeforeUnits + entry.reservedDeltaUnits);
      assert.ok(entry.balanceAfterUnits >= BigInt(0));
      assert.ok(entry.reservedAfterUnits >= BigInt(0) && entry.reservedAfterUnits <= entry.balanceAfterUnits);
    }
  } finally {
    await Promise.all([first.$disconnect(), second.$disconnect()]);
  }
});

test("PostgreSQL protege ACK monotônico, revisão de rascunho e credencial curta ativa única", { skip: !connectionString }, async () => {
  const db = client(), token = randomUUID(), terminalId = `pg-offline-client-${token}`;
  let createdProfileId: number | null = null;
  try {
    const [register, existingProfile] = await Promise.all([
      db.posRegister.findFirst({ where: { status: "active" }, select: { id: true } }),
      db.tenantUserProfile.findFirst({ where: { status: "active" }, select: { id: true, userId: true } }),
    ]);
    let profile = existingProfile;
    if (!profile) {
      const role = await db.tenantRole.findFirst({ where: { active: true }, select: { id: true } });
      assert.ok(role, "a base descartável deve possuir papel ativo");
      profile = await db.tenantUserProfile.create({ data: { userId: `pg-offline-user-${token}`, roleId: role.id, displayName: "Teste offline PostgreSQL", email: `pg-offline-${token}@example.test` }, select: { id: true, userId: true } });
      createdProfileId = profile.id;
    }
    assert.ok(register && profile, "a base descartável deve possuir caixa e perfil ativos");
    await db.posTerminal.create({ data: { id: terminalId, registerId: register.id, code: `PG-OFFLINE-${token}`, name: "Terminal offline client", status: "online", lastSyncCursor: BigInt(2), lastSyncAckCursor: BigInt(1) } });
    await assert.rejects(db.posTerminal.update({ where: { id: terminalId }, data: { lastSyncAckCursor: BigInt(3) } }));
    await assert.rejects(db.posTerminal.update({ where: { id: terminalId }, data: { lastSyncCursor: BigInt(0) } }));

    const draftId = randomUUID();
    await db.posOfflineDraft.create({ data: { terminalId, draftId, revision: 1, state: "active", payload: { draftId, revision: 1 }, lastOperationId: randomUUID() } });
    await assert.rejects(db.posOfflineDraft.create({ data: { terminalId, draftId, revision: 2, state: "active", payload: {}, lastOperationId: randomUUID() } }));
    await assert.rejects(db.posOfflineDraft.create({ data: { terminalId, draftId: randomUUID(), revision: 0, state: "active", payload: {}, lastOperationId: randomUUID() } }));

    const expiresAt = new Date(Date.now() + 60_000);
    const first = await db.posOfflineCredential.create({ data: { terminalId, userProfileId: profile.id, userId: profile.userId, tokenHash: `hmac-sha256:v1:${"a".repeat(64)}`, credentialVersion: 0, idempotencyKey: `offline.issue:${token}`, requestHash: "b".repeat(64), expiresAt } });
    await assert.rejects(db.posOfflineCredential.create({ data: { terminalId, userProfileId: profile.id, userId: profile.userId, tokenHash: `hmac-sha256:v1:${"c".repeat(64)}`, credentialVersion: 0, idempotencyKey: `offline.issue.other:${token}`, requestHash: "d".repeat(64), expiresAt } }));
    await db.posOfflineCredential.update({ where: { id: first.id }, data: { state: "revoked", revokedAt: new Date(), revocationKey: `offline.revoke:${token}`, revocationRequestHash: "e".repeat(64) } });
    await db.posOfflineCredential.create({ data: { terminalId, userProfileId: profile.id, userId: profile.userId, tokenHash: `hmac-sha256:v1:${"f".repeat(64)}`, credentialVersion: 0, idempotencyKey: `offline.issue.replacement:${token}`, requestHash: "1".repeat(64), expiresAt } });
    assert.equal(await db.posOfflineCredential.count({ where: { terminalId, state: "active" } }), 1);
  } finally {
    await db.posOfflineCredential.deleteMany({ where: { terminalId } }).catch(() => undefined);
    await db.posOfflineDraft.deleteMany({ where: { terminalId } }).catch(() => undefined);
    await db.posTerminal.deleteMany({ where: { id: terminalId } }).catch(() => undefined);
    if (createdProfileId) await db.tenantUserProfile.deleteMany({ where: { id: createdProfileId } }).catch(() => undefined);
    await db.$disconnect();
  }
});

test("PostgreSQL conclui uma troca vinculada uma única vez sob concorrência", { skip: !connectionString }, async () => {
  const first = client(), second = client();
  const token = randomUUID();
  let createdProfileId: number | null = null;
  let returnId: string | null = null;
  let heldSaleId: string | null = null;
  let sessionId: number | null = null;
  const saleNumbers = [`PG-EXCHANGE-ORIGIN-${token}`, `PG-EXCHANGE-A-${token}`, `PG-EXCHANGE-B-${token}`];
  try {
    const [register, existingProfile] = await Promise.all([
      first.posRegister.findFirst({ where: { status: "active" }, select: { id: true, name: true, branchId: true } }),
      first.tenantUserProfile.findFirst({ where: { status: "active" }, select: { id: true } }),
    ]);
    assert.ok(register?.branchId, "a base descartável deve possuir caixa em filial");
    let profile = existingProfile;
    if (!profile) {
      const role = await first.tenantRole.findFirst({ where: { active: true }, select: { id: true } });
      assert.ok(role);
      profile = await first.tenantUserProfile.create({ data: { userId: `pg-exchange-user-${token}`, roleId: role.id, displayName: "Teste troca PostgreSQL", email: `pg-exchange-${token}@example.test` }, select: { id: true } });
      createdProfileId = profile.id;
    }
    const session = await first.cashRegisterSession.create({ data: { number: `PG-EXCHANGE-SESSION-${token}`, registerName: register.name, status: "closed", openingAmount: 0, openingAmountCents: 0, openedBy: "Teste PostgreSQL", registerId: register.id, operatorProfileId: profile.id } });
    sessionId = session.id;
    const origin = await first.sale.create({ data: { saleNumber: saleNumbers[0], branchId: register.branchId, sessionId: session.id, operatorProfileId: profile.id, customer: "Teste", seller: "Teste", cashRegister: register.name, paymentMethod: "cash", total: 1, status: "partially_returned", subtotalCents: 100, discountCents: 0, surchargeCents: 0, totalCents: 100, changeCents: 0 } });
    const held = await first.posHeldSale.create({ data: { registerId: register.id, sessionId: session.id, operatorProfileId: profile.id, idempotencyKey: `pg-exchange-held-${token}`, requestHash: "a".repeat(64), label: "Troca PostgreSQL", status: "held" } });
    heldSaleId = held.id;
    const returned = await first.posReturn.create({ data: { number: `PG-EXCHANGE-RETURN-${token}`, idempotencyKey: `pg-exchange-return-${token}`, requestHash: "b".repeat(64), saleId: origin.id, processingSessionId: session.id, registerId: register.id, status: "completed", reasonCode: "customer_return", description: "Teste concorrente de troca", disposition: "restock", refundMethod: "cash", totalRefundCents: 100, requestedBy: "Teste", approvedBy: "Teste", completedAt: new Date(), exchangeStatus: "draft", exchangeHeldSaleId: held.id, exchangeStartedAt: new Date() } });
    returnId = returned.id;
    const replacements = await Promise.all(saleNumbers.slice(1).map((saleNumber, index) => first.sale.create({ data: { saleNumber, branchId: register.branchId, sessionId: session.id, operatorProfileId: profile.id, customer: "Teste", seller: "Teste", cashRegister: register.name, paymentMethod: "cash", total: index + 1, status: "completed", subtotalCents: (index + 1) * 100, discountCents: 0, surchargeCents: 0, totalCents: (index + 1) * 100, changeCents: 0 } })));
    const complete = (db: ReturnType<typeof client>, exchangeSaleId: number) => db.posReturn.updateMany({ where: { id: returned.id, exchangeStatus: "draft", exchangeSaleId: null }, data: { exchangeStatus: "completed", exchangeSaleId, exchangeCompletedAt: new Date() } });
    const completed = await Promise.all([complete(first, replacements[0].id), complete(second, replacements[1].id)]);
    assert.deepEqual(completed.map((result) => result.count).sort(), [0, 1]);
    const final = await first.posReturn.findUniqueOrThrow({ where: { id: returned.id } });
    assert.equal(final.exchangeStatus, "completed");
    assert.ok(replacements.some((sale) => sale.id === final.exchangeSaleId));
    await assert.rejects(first.posReturn.update({ where: { id: returned.id }, data: { exchangeStatus: "draft", exchangeCompletedAt: null } }));
    await assert.rejects(first.posReturn.create({ data: { number: `PG-EXCHANGE-DUPLICATE-${token}`, idempotencyKey: `pg-exchange-duplicate-${token}`, requestHash: "c".repeat(64), saleId: origin.id, processingSessionId: session.id, registerId: register.id, status: "completed", reasonCode: "customer_return", description: "Vínculo duplicado", disposition: "restock", refundMethod: "cash", totalRefundCents: 0, requestedBy: "Teste", completedAt: new Date(), exchangeStatus: "draft", exchangeHeldSaleId: held.id, exchangeStartedAt: new Date() } }));
  } finally {
    if (returnId) await first.posReturn.deleteMany({ where: { id: returnId } }).catch(() => undefined);
    if (heldSaleId) await first.posHeldSale.deleteMany({ where: { id: heldSaleId } }).catch(() => undefined);
    await first.sale.deleteMany({ where: { saleNumber: { in: saleNumbers } } }).catch(() => undefined);
    if (sessionId) await first.cashRegisterSession.deleteMany({ where: { id: sessionId } }).catch(() => undefined);
    if (createdProfileId) await first.tenantUserProfile.deleteMany({ where: { id: createdProfileId } }).catch(() => undefined);
    await Promise.all([first.$disconnect(), second.$disconnect()]);
  }
});

test("PostgreSQL impede oversell de variação por depósito e reverte venda/pagamento perdedores", { skip: !connectionString }, async () => {
  const first = client(), second = client();
  const token = randomUUID().replaceAll("-", "");
  const salePrefix = `PG-STOCK-${token}`;
  let productId: number | null = null;
  let secondaryWarehouseId: number | null = null;
  try {
    const primaryWarehouse = await first.warehouse.findFirst({ where: { active: true, branchId: { not: null } }, select: { id: true, branchId: true, name: true } });
    assert.ok(primaryWarehouse?.branchId, "a base descartável deve possuir depósito ativo em filial");
    const secondaryWarehouse = await first.warehouse.create({ data: { code: `PG-STOCK-${token}`, name: "Depósito isolado PostgreSQL", branchId: primaryWarehouse.branchId, active: true } });
    secondaryWarehouseId = secondaryWarehouse.id;
    const product = await first.product.create({ data: { name: "Produto concorrente por variação", slug: `pg-stock-${token}`, sku: `PGS${token}`, category: "Teste", stock: 2, manageStock: true, active: true } });
    productId = product.id;
    const variation = await first.productVariation.create({ data: { productId, sku: `PGSV${token}`, attributes: {}, manageStock: "true", stock: 1, enabled: true } });
    await first.branchProduct.create({ data: { branchId: primaryWarehouse.branchId, productId, active: true, saleEnabled: true, purchaseEnabled: true, preferredWarehouseId: primaryWarehouse.id } });
    await Promise.all([
      first.warehouseBalance.create({ data: { warehouseId: primaryWarehouse.id, productId, quantity: 1, reservedQuantity: 0 } }),
      first.warehouseBalance.create({ data: { warehouseId: secondaryWarehouse.id, productId, quantity: 1, reservedQuantity: 0 } }),
      first.warehouseVariationBalance.create({ data: { warehouseId: primaryWarehouse.id, productId, variationId: variation.id, quantity: 1, reservedQuantity: 0 } }),
      first.warehouseVariationBalance.create({ data: { warehouseId: secondaryWarehouse.id, productId, variationId: variation.id, quantity: 0, reservedQuantity: 0 } }),
    ]);
    const role = await first.tenantRole.findFirstOrThrow({ where: { active: true } });
    const profile = await first.tenantUserProfile.create({ data: { userId: `pg-stock-${token}`, roleId: role.id, displayName: "Operador stock PG", email: `pg-stock-${token}@example.invalid`, activeBranchId: primaryWarehouse.branchId } });
    const register = await first.posRegister.create({ data: { branchId: primaryWarehouse.branchId, warehouseId: primaryWarehouse.id, code: `PGSTOCK${token.slice(0, 12)}`, name: "Caixa stock PG" } });
    await first.branchUserAccess.create({ data: { branchId: primaryWarehouse.branchId, userProfileId: profile.id, canSell: true } });
    await first.posRegisterAccess.create({ data: { registerId: register.id, userProfileId: profile.id, active: true, canSell: true } });
    const session = await first.cashRegisterSession.create({ data: { number: `PG-STOCK-${token}`, registerName: register.name, status: "open", openingAmount: 0, openingAmountCents: 0, openedBy: profile.displayName, registerId: register.id, operatorProfileId: profile.id } });
    const terminalNow = new Date();
    const terminal = await first.posTerminal.create({ data: { id: `pg-stock-terminal-${token}`, registerId: register.id, code: `PGSTOCKTERM${token.slice(0, 8)}`, name: "Terminal stock PG", status: "online", tokenHash: `hmac-sha256:v1:${token.repeat(2)}`, tokenIssuedAt: terminalNow, tokenExpiresAt: new Date(terminalNow.valueOf() + 3_600_000), credentialVersion: 1, pairedAt: terminalNow, lastSeenAt: terminalNow, appVersion: "test" } });
    const prepareCashPlan = async (saleDraftId: string, suffix: string) => {
      const planId = `pg-stock-plan-${suffix}-${token}`, requestHash = token.repeat(2), evaluatedAt = new Date(), expiresAt = new Date(evaluatedAt.valueOf() + 300_000);
      await first.$transaction(async tx => {
        const draft = await tx.posHeldSale.create({ data: { id: saleDraftId, registerId: register.id, sessionId: session.id, operatorProfileId: profile.id, status: "draft", idempotencyKey: `pg-stock-draft-${suffix}-${token}`, requestHash, items: { create: { productId: product.id, variationId: variation.id, quantity: 1, unitPriceCents: 100, discountCents: 0 } } }, include: { items: true } });
        await tx.posPaymentPlan.create({ data: { id: planId, branchId: primaryWarehouse.branchId!, registerId: register.id, sessionId: session.id, operatorProfileId: profile.id, terminalId: terminal.id, saleDraftId, draftRevision: draft.revision, draftRequestHash: requestHash, draftStatus: "draft", quoteHash: requestHash, evaluatedAt, expiresAt, totalCents: 100, idempotencyKey: `pg-stock-quote-${suffix}-${token}`, requestHash } });
        await tx.posPaymentPlanQuoteLine.create({ data: { planId, lineIndex: 0, heldSaleItemId: draft.items[0].id, productId: product.id, variationId: variation.id, quantity: 1, unitPriceCents: 100, grossCents: 100, baseDiscountCents: 0, orderDiscountCents: 0, promotionDiscountCents: 0, surchargeCents: 0, totalCents: 100 } });
        await tx.posPaymentPlanOperation.create({ data: { planId, action: "quote", expectedVersion: -1, resultingVersion: 0, resultingState: "quoted", idempotencyKey: `pg-stock-quote-${suffix}-${token}`, requestHash } });
      });
      await first.$transaction(async tx => {
        await tx.posPaymentPlanSlot.create({ data: { planId, paymentIndex: 0, method: "cash", amountCents: 100, installments: 1, proofKind: "cash" } });
        await tx.posPaymentPlanOperation.create({ data: { planId, action: "activate", expectedVersion: 0, resultingVersion: 1, resultingState: "active", idempotencyKey: `pg-stock-activate-${suffix}-${token}`, requestHash } });
        await tx.posPaymentPlan.update({ where: { id: planId }, data: { state: "active", version: 1 } });
      });
      return planId;
    };
    const saleKeys = [`pg-stock-a-${token}`, `pg-stock-b-${token}`] as const;
    const planBySaleKey = new Map<string, string>([
      [saleKeys[0], await prepareCashPlan(saleKeys[0], "a")],
      [saleKeys[1], await prepareCashPlan(saleKeys[1], "b")],
    ]);

    const stockInput = (warehouseId: number, referenceId: string) => ({
      warehouseId,
      product: { id: product.id, name: product.name, type: product.type, manageStock: product.manageStock },
      variation: { id: variation.id, manageStock: variation.manageStock },
      delta: -1,
      allowNegative: false,
      movementType: "exit" as const,
      ledgerType: "sale",
      referenceType: "sale",
      referenceId,
      actor: "postgres-test",
      note: `Venda concorrente ${referenceId}`,
    });
    await assert.rejects(first.$transaction(tx => applyPosCommonStockChange(tx, stockInput(secondaryWarehouse.id, `${salePrefix}-WRONG-WAREHOUSE`)), { isolationLevel: "Serializable" }), /Estoque insuficiente para a variação/);
    assert.equal((await first.warehouseBalance.findUniqueOrThrow({ where: { warehouseId_productId: { warehouseId: secondaryWarehouse.id, productId } } })).quantity, 1, "falha da variação deve reverter CAS do saldo pai");
    assert.equal(await first.warehouseLedgerEntry.count({ where: { productId } }), 0);

    const sell = async (db: ReturnType<typeof client>, suffix: string, idempotencyKey: string) => {
      const requestHash = token.repeat(2), paymentPlanId = planBySaleKey.get(idempotencyKey)!;
      const replay = await db.sale.findUnique({ where: { idempotencyKey } });
      if (replay) {
        assert.equal(replay.requestHash, requestHash);
        return { sale: replay, replayed: true };
      }
      try {
        const sale = await db.$transaction(async tx => {
          const created = await tx.sale.create({ data: {
            saleNumber: `${salePrefix}-${suffix}`, branchId: primaryWarehouse.branchId, warehouseId: primaryWarehouse.id,
            sessionId: session.id, operatorProfileId: profile.id, customer: "Teste", seller: "Teste", cashRegister: register.name, paymentMethod: "cash", total: 1,
            status: "completed", subtotalCents: 100, discountCents: 0, surchargeCents: 0, totalCents: 100, changeCents: 0,
            idempotencyKey, requestHash,
            items: { create: { productId: product.id, variationId: variation.id, productName: product.name, quantity: 1, unitPrice: 1, total: 1, unitPriceCents: 100, grossCents: 100, discountCents: 0, surchargeCents: 0, totalCents: 100 } },
          } });
          await tx.posSalePayment.create({ data: { saleId: created.id, processingSessionId: session.id, type: "payment", method: "cash", status: "captured", amountCents: 100, tenderedCents: 100, changeCents: 0, provider: "cash", installments: 1, paymentPlanId, paymentIndex: 0, idempotencyKey: `${idempotencyKey}:payment`, capturedAt: new Date() } });
          await consumePosPaymentPlan(tx, { id: paymentPlanId, state: "active", version: 1 }, created.id, profile.userId, `pg-stock-consume-${idempotencyKey}`);
          await applyPosCommonStockChange(tx, stockInput(primaryWarehouse.id, String(created.id)));
          return created;
        }, { isolationLevel: "Serializable" });
        return { sale, replayed: false };
      } catch (error) {
        if (["P2002", "P2034"].includes(String((error as { code?: string })?.code || ""))) {
          const concurrent = await db.sale.findUnique({ where: { idempotencyKey } });
          if (concurrent?.requestHash === requestHash) return { sale: concurrent, replayed: true };
        }
        throw error;
      }
    };

    const race = await Promise.allSettled([
      sell(first, "A", saleKeys[0]),
      sell(second, "B", saleKeys[1]),
    ]);
    assert.equal(race.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(race.filter(result => result.status === "rejected").length, 1);
    const winner = race.find((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof sell>>> => result.status === "fulfilled")!.value;
    assert.equal(await first.sale.count({ where: { saleNumber: { startsWith: salePrefix } } }), 1, "a venda perdedora deve sofrer rollback");
    assert.equal(await first.posSalePayment.count({ where: { sale: { saleNumber: { startsWith: salePrefix } } } }), 1, "o pagamento perdedor deve sofrer rollback");
    assert.equal((await first.warehouseBalance.findUniqueOrThrow({ where: { warehouseId_productId: { warehouseId: primaryWarehouse.id, productId } } })).quantity, 0);
    assert.equal((await first.warehouseVariationBalance.findUniqueOrThrow({ where: { warehouseId_variationId: { warehouseId: primaryWarehouse.id, variationId: variation.id } } })).quantity, 0);
    assert.equal((await first.productVariation.findUniqueOrThrow({ where: { id: variation.id } })).stock, 0);
    assert.equal(await first.warehouseLedgerEntry.count({ where: { productId, type: "sale" } }), 1);
    assert.equal(await first.stockMovement.count({ where: { productId, type: "exit" } }), 1);

    const replay = await sell(first, "REPLAY", winner.sale.idempotencyKey!);
    assert.equal(replay.replayed, true);
    assert.equal(replay.sale.id, winner.sale.id);
    assert.equal(await first.warehouseLedgerEntry.count({ where: { productId, type: "sale" } }), 1, "replay idempotente não pode repetir a baixa");
  } finally {
    if (productId) {
      await first.warehouseLedgerEntry.deleteMany({ where: { productId } }).catch(() => undefined);
      await first.stockMovement.deleteMany({ where: { productId } }).catch(() => undefined);
      await first.sale.deleteMany({ where: { saleNumber: { startsWith: salePrefix } } }).catch(() => undefined);
      await first.warehouseVariationBalance.deleteMany({ where: { productId } }).catch(() => undefined);
      await first.warehouseBalance.deleteMany({ where: { productId } }).catch(() => undefined);
      await first.branchProduct.deleteMany({ where: { productId } }).catch(() => undefined);
      await first.product.deleteMany({ where: { id: productId } }).catch(() => undefined);
    }
    if (secondaryWarehouseId) await first.warehouse.deleteMany({ where: { id: secondaryWarehouseId } }).catch(() => undefined);
    await Promise.all([first.$disconnect(), second.$disconnect()]);
  }
});

test("PostgreSQL transfere carrinho uma vez por revisão e preserva ledger imutável", { skip: !connectionString }, async () => {
  const first = client(), second = client(), token = randomUUID();
  try {
    const [branch, role] = await Promise.all([
      first.branch.findFirst({ where: { status: "active" }, select: { id: true }, orderBy: [{ primary: "desc" }, { id: "asc" }] }),
      first.tenantRole.findFirst({ where: { active: true }, select: { id: true } }),
    ]);
    assert.ok(branch && role, "a base descartável deve possuir filial e perfil ativos");
    const registers = await Promise.all(["A", "B", "C"].map(suffix => first.posRegister.create({ data: {
      branchId: branch.id, code: `PG-HCT-${suffix}-${token}`, name: `Caixa transferência ${suffix}`,
    } })));
    const profiles = await Promise.all(["A", "B", "C"].map(suffix => first.tenantUserProfile.create({ data: {
      userId: `pg-held-transfer-${suffix}-${token}`,
      roleId: role.id,
      displayName: `Operador transferência ${suffix}`,
      email: `pg-held-transfer-${suffix}-${token}@example.test`,
      activeBranchId: branch.id,
    } })));
    await first.branchUserAccess.createMany({ data: profiles.map(profile => ({ branchId: branch.id, userProfileId: profile.id, canSell: true })) });
    await first.posRegisterAccess.createMany({ data: [
      { registerId: registers[0].id, userProfileId: profiles[0].id, active: true, canSell: true, canTransferHeld: true },
      { registerId: registers[1].id, userProfileId: profiles[1].id, active: true, canSell: true },
      { registerId: registers[2].id, userProfileId: profiles[2].id, active: true, canSell: true },
    ] });
    const sessions = await Promise.all(registers.map((register, index) => first.cashRegisterSession.create({ data: {
      number: `PG-HCT-SESSION-${index}-${token}`,
      registerName: register.name,
      status: "open",
      openingAmount: 0,
      openingAmountCents: 0,
      openedBy: profiles[index].displayName,
      registerId: register.id,
      operatorProfileId: profiles[index].id,
    } })));
    const held = await first.posHeldSale.create({ data: {
      registerId: registers[0].id,
      sessionId: sessions[0].id,
      operatorProfileId: profiles[0].id,
      label: "Carrinho concorrente PostgreSQL",
      status: "held",
      revision: 0,
    } });
    const context: PosHeldCartTransferContext = {
      branchId: branch.id,
      actorUserId: profiles[0].userId,
      actorProfileId: profiles[0].id,
      actorName: profiles[0].displayName,
      privileged: false,
    };
    const command = (targetIndex: 1 | 2): PosHeldCartTransferInput => ({
      heldSaleId: held.id,
      sourceSessionId: sessions[0].id,
      targetSessionId: sessions[targetIndex].id,
      expectedRevision: 0,
      idempotencyKey: `pg-held-transfer:${targetIndex}:${token}`,
      reason: `Continuidade no operador ${targetIndex}`,
    });
    const attempts = await Promise.allSettled([
      executePosHeldCartTransfer(first, context, command(1)),
      executePosHeldCartTransfer(second, context, command(2)),
    ]);
    assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(attempts.filter(result => result.status === "rejected").length, 1);
    const [saved, transfers] = await Promise.all([
      first.posHeldSale.findUniqueOrThrow({ where: { id: held.id } }),
      first.posHeldSaleTransfer.findMany({ where: { heldSaleId: held.id } }),
    ]);
    assert.equal(saved.revision, 1);
    assert.equal(transfers.length, 1);
    assert.equal(saved.sessionId, transfers[0].toSessionId);
    assert.equal(saved.operatorProfileId, transfers[0].toOperatorProfileId);
    const winningCommand = transfers[0].toSessionId === sessions[1].id ? command(1) : command(2);
    const replay = await executePosHeldCartTransfer(first, context, winningCommand);
    assert.equal(replay.replayed, true);
    await assert.rejects(executePosHeldCartTransfer(first, context, { ...winningCommand, targetSessionId: winningCommand.targetSessionId === sessions[1].id ? sessions[2].id : sessions[1].id }), /outro destino/);
    await assert.rejects(first.posHeldSaleTransfer.create({ data: {
      heldSaleId: held.id,
      branchId: branch.id,
      fromRegisterId: registers[0].id,
      fromSessionId: sessions[1].id,
      fromOperatorProfileId: profiles[1].id,
      toRegisterId: registers[2].id,
      toSessionId: sessions[2].id,
      toOperatorProfileId: profiles[2].id,
      actorProfileId: profiles[0].id,
      actorUserId: profiles[0].userId,
      expectedRevision: 1,
      resultingRevision: 2,
      idempotencyKey: `pg-held-transfer-invalid-context:${token}`,
      requestHash: "a".repeat(64),
      reason: "Tentativa de gravar sessão e caixa divergentes",
    } }), "o banco deve rejeitar snapshot com sessão e caixa divergentes");
    await assert.rejects(first.posHeldSaleTransfer.update({ where: { id: transfers[0].id }, data: { reason: "Tentativa de reescrever histórico" } }));
    await assert.rejects(first.posHeldSaleTransfer.delete({ where: { id: transfers[0].id } }));
  } finally {
    await Promise.all([first.$disconnect(), second.$disconnect()]);
  }
});

function client() {
  if (!connectionString) throw new Error("POS_TEST_DATABASE_URL não definida");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}
