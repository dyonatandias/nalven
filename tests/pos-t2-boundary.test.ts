import assert from "node:assert/strict";
import test from "node:test";
import type { Prisma } from "../generated/tenant/client";
import {
  closePosT2AccountingPeriodBoundary,
  preparePosT2CatalogBoundary,
  putPosT2AccountingPeriodBoundary,
  writePosT2ValueProgramBoundary,
  writePosT2WebhookBoundary,
  toPosT2BoundaryIdempotencyKey,
} from "../lib/erp/pos-t2-boundary";
import { hashPosManualT2Domain } from "../lib/erp/pos-manual-t2-canonical";

function txReturning(result: Record<string, unknown>, seen: Prisma.Sql[]) {
  return { $queryRaw: async (query: Prisma.Sql) => { seen.push(query); return [{ result }]; } } as unknown as Prisma.TransactionClient;
}

test("catalog boundary mantém request/hash byte-exatos e valida plano", async () => {
  const seen: Prisma.Sql[] = [];
  const input = {
    action: "put_graph" as const, productId: 7, expectedProductRevision: 2, expectedProductConfigHash: "a".repeat(64),
    productProjection: { active: true, gtinSnapshot: null, manageStock: true, nameLabel: "Produto", productType: "product", skuSnapshot: "SKU-7", status: "publish", unit: "UN" },
    variations: [{ enabled: true, expectedConfigHash: "b".repeat(64), expectedRevision: 1, gtinSnapshot: null, manageStock: "parent", ordinal: 0, skuSnapshot: "SKU-7-A", status: "publish", variationId: 9 }],
    actorUserId: "actor-7", idempotencyKey: "c".repeat(64),
  };
  const result = await preparePosT2CatalogBoundary(txReturning({ operationId: "00000000-0000-4000-8000-000000000001", productConfigHash: "d".repeat(64), productId: 7, productRevision: 3, replayed: false, variations: [{ action: "update", configHash: "e".repeat(64), ordinal: 0, revision: 2, variationId: 9 }] }, seen), input);
  assert.equal(result.productRevision, 3);
  const request = { action: input.action, actorUserId: input.actorUserId, expectedProductConfigHash: input.expectedProductConfigHash, expectedProductRevision: input.expectedProductRevision, idempotencyKey: input.idempotencyKey, productId: input.productId, productProjection: input.productProjection, schemaVersion: 1, variations: input.variations };
  assert.ok(seen[0]!.values.includes(hashPosManualT2Domain("t2-catalog-boundary-request-v1", request)));
});

test("value, accounting e webhook usam somente as ABIs tipadas e rejeitam retorno aberto", async () => {
  assert.equal(toPosT2BoundaryIdempotencyKey("legacy-admin-key-1234"), toPosT2BoundaryIdempotencyKey("legacy-admin-key-1234"));
  assert.match(toPosT2BoundaryIdempotencyKey("legacy-admin-key-1234"), /^[0-9a-f]{64}$/u);
  const valueSeen: Prisma.Sql[] = [];
  const value = await writePosT2ValueProgramBoundary(txReturning({ configHash: "1".repeat(64), operationId: "00000000-0000-4000-8000-000000000002", programId: "program-1", replayed: false, revision: 1, status: "active" }, valueSeen), {
    action: "put", programId: null, expectedRevision: null, expectedConfigHash: null,
    projection: { branchId: 1, earnUnits: 1, expiresAfterDays: null, kind: "loyalty", name: "Pontos", redeemCentsPerUnit: 100, spendCents: 1000, status: "active" },
    actorUserId: "actor-1", idempotencyKey: "2".repeat(64),
  });
  assert.equal(value.revision, 1);

  const accounting = await closePosT2AccountingPeriodBoundary(txReturning({ closedAt: "2026-08-31T12:00:00.000000Z", configHash: "3".repeat(64), operationId: "00000000-0000-4000-8000-000000000003", periodId: "period-2026-08", replayed: false, revision: 2, status: "closed" }, []), {
    periodId: "period-2026-08", expectedRevision: 1, expectedConfigHash: "4".repeat(64), closedBy: "actor-1", reason: "Fechamento homologado", idempotencyKey: "5".repeat(64),
  });
  assert.equal(accounting.status, "closed");
  const period = await putPosT2AccountingPeriodBoundary(txReturning({ configHash: "8".repeat(64), operationId: "00000000-0000-4000-8000-000000000008", periodId: "00000000-0000-4000-8000-000000000008", replayed: false, revision: 1, status: "open" }, []), {
    branchId: 1, year: 2026, month: 8, startsOn: "2026-08-01", endsOn: "2026-08-31", currency: "BRL", actorUserId: "actor-1", idempotencyKey: "8".repeat(64),
  });
  assert.equal(period.status, "open");

  const webhookInput = {
    action: "create" as const, logicalId: null, expectedVersion: null, expectedConfigHash: null,
    projection: { apiVersion: "v1", deliveryUrl: "https://example.test/hook", name: "ERP", secretCipher: "cipher", secretPreview: "***1234", status: "active" as const, topic: "sale.completed" },
    actorUserId: "actor-1", idempotencyKey: "6".repeat(64),
  };
  const webhook = await writePosT2WebhookBoundary(txReturning({ configHash: "7".repeat(64), endpointId: "00000000-0000-4000-8000-000000000004", logicalId: "00000000-0000-4000-8000-000000000004", operationId: "00000000-0000-4000-8000-000000000004", replayed: false, status: "active", version: 1 }, []), webhookInput);
  assert.equal(webhook.version, 1);

  await assert.rejects(writePosT2WebhookBoundary(txReturning({ configHash: "7".repeat(64), endpointId: "endpoint", logicalId: "logical", operationId: "00000000-0000-4000-8000-000000000004", replayed: false, status: "active", version: 1, extra: true }, []), webhookInput), /T2_BOUNDARY_RESULT_INVALID/);
});
