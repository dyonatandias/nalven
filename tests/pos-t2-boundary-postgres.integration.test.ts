import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "../generated/tenant/client";
import {
  closePosT2AccountingPeriodBoundary,
  preparePosT2CatalogBoundary,
  putPosT2AccountingPeriodBoundary,
  writePosT2ValueProgramBoundary,
  writePosT2WebhookBoundary,
} from "../lib/erp/pos-t2-boundary";

const connectionString = process.env.POS_T2_BOUNDARY_DATABASE_URL;
const actorUserId = process.env.POS_T2_BOUNDARY_ACTOR_USER_ID || "actor-t2";
const branchId = Number(process.env.POS_T2_BOUNDARY_BRANCH_ID || 1);

test("Prisma consome as boundary ABIs self-DML e replaya o retorno persistido", { skip: !connectionString, timeout: 30_000 }, async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) });
  const token = randomBytes(12).toString("hex");
  const periodYear = 2101 + Number.parseInt(token.slice(0, 3), 16) % 100;
  const periodMonth = 1 + Number.parseInt(token.slice(3, 5), 16) % 12;
  const startsOn = `${periodYear}-${String(periodMonth).padStart(2, "0")}-01`;
  const endsOn = new Date(Date.UTC(periodYear, periodMonth, 0)).toISOString().slice(0, 10);
  try {
    const catalogInput = { action: "put_graph" as const, productId: null, expectedProductRevision: null, expectedProductConfigHash: null, productProjection: { active: true, gtinSnapshot: null, manageStock: true, nameLabel: `Product ${token}`, productType: "product", skuSnapshot: `SKU-${token}`, status: "publish", unit: "UN" }, variations: [{ enabled: true, expectedConfigHash: null, expectedRevision: null, gtinSnapshot: null, manageStock: "parent", ordinal: 0, skuSnapshot: `VAR-${token}`, status: "publish", variationId: null }], actorUserId, idempotencyKey: randomBytes(32).toString("hex") };
    const catalog = await serializable(db, async tx => {
      const plan = await preparePosT2CatalogBoundary(tx, catalogInput);
      const variation = plan.variations[0]!;
      await tx.product.create({ data: { id: plan.productId, name: catalogInput.productProjection.nameLabel, slug: `product-${token}`, sku: catalogInput.productProjection.skuSnapshot, category: "Boundary", active: true, manageStock: true, type: "product", status: "publish", unit: "UN", posRevision: plan.productRevision, posConfigHash: plan.productConfigHash } });
      await tx.productVariation.create({ data: { id: variation.variationId, productId: plan.productId, sku: catalogInput.variations[0]!.skuSnapshot, status: "publish", attributes: [], manageStock: "parent", enabled: true, menuOrder: 0, posRevision: variation.revision, posConfigHash: variation.configHash } });
      return plan;
    });
    assert.equal((await serializable(db, tx => preparePosT2CatalogBoundary(tx, catalogInput))).replayed, true);
    await assert.rejects(serializable(db, tx => tx.product.update({ where: { id: catalog.productId }, data: { active: false } })), /exact producer root|42501/u);

    const programInput = { action: "put" as const, programId: null, expectedRevision: null, expectedConfigHash: null, projection: { branchId, earnUnits: 1, expiresAfterDays: null, kind: "loyalty_points", name: `Program ${token}`, redeemCentsPerUnit: 100, spendCents: 1000, status: "active" as const }, actorUserId, idempotencyKey: randomBytes(32).toString("hex") };
    const program = await serializable(db, tx => writePosT2ValueProgramBoundary(tx, programInput));
    assert.equal(program.status, "active");
    assert.equal((await serializable(db, tx => writePosT2ValueProgramBoundary(tx, programInput))).replayed, true);

    const periodInput = { branchId, year: periodYear, month: periodMonth, startsOn, endsOn, currency: "BRL" as const, actorUserId, idempotencyKey: randomBytes(32).toString("hex") };
    const period = await serializable(db, tx => putPosT2AccountingPeriodBoundary(tx, periodInput));
    const closeInput = { periodId: period.periodId, expectedRevision: period.revision, expectedConfigHash: period.configHash, closedBy: actorUserId, reason: `Close ${token}`, idempotencyKey: randomBytes(32).toString("hex") };
    assert.equal((await serializable(db, tx => closePosT2AccountingPeriodBoundary(tx, closeInput))).status, "closed");

    const secret = `cipher-${token}`;
    const webhookInput = { action: "create" as const, logicalId: null, expectedVersion: null, expectedConfigHash: null, projection: { apiVersion: "v1", deliveryUrl: `https://example.test/${token}`, name: `Webhook ${token}`, secretCipher: secret, secretPreview: "***test", status: "active" as const, topic: "sale.completed" }, actorUserId, idempotencyKey: randomBytes(32).toString("hex") };
    const webhook = await serializable(db, tx => writePosT2WebhookBoundary(tx, webhookInput));
    const updated = await serializable(db, tx => writePosT2WebhookBoundary(tx, { ...webhookInput, action: "update", logicalId: webhook.logicalId, expectedVersion: webhook.version, expectedConfigHash: webhook.configHash, projection: { ...webhookInput.projection, name: `Webhook updated ${token}` }, idempotencyKey: randomBytes(32).toString("hex") }));
    assert.equal(updated.version, 2);
  } finally {
    await db.$disconnect();
  }
});

function serializable<T>(db: PrismaClient, operation: (tx: Prisma.TransactionClient) => Promise<T>) {
  return db.$transaction(operation, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 });
}
