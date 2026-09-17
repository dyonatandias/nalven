import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyPosCouponCounter,
  classifyPosDevice,
  classifyPosLot,
  classifyPosPayment,
  classifyPosPrintJob,
  classifyPosPromotionUsage,
  classifyPosSession,
  classifyPosSync,
  classifyPosTerminal,
  parsePosObservabilityQuery,
  POS_OBSERVABILITY_DEFAULTS,
  PosObservabilityError,
} from "../lib/erp/pos-observability";

const now = new Date("2026-08-29T12:00:00.000Z");
const ago = (minutes: number) => new Date(now.valueOf() - minutes * 60_000);

test("query de observabilidade aplica defaults e limites estritos", () => {
  assert.deepEqual(parsePosObservabilityQuery(new URLSearchParams()), { branchId: null, windowHours: POS_OBSERVABILITY_DEFAULTS.windowHours, limit: POS_OBSERVABILITY_DEFAULTS.detailLimit });
  assert.deepEqual(parsePosObservabilityQuery(new URLSearchParams("branchId=7&windowHours=24&limit=50")), { branchId: 7, windowHours: 24, limit: 50 });
  for (const query of ["limit=0", "limit=51", "windowHours=721", "branchId=-1", "limit=1.5", "extra=x", "limit=1&limit=2"]) {
    assert.throws(() => parsePosObservabilityQuery(new URLSearchParams(query)), PosObservabilityError);
  }
});

test("sessões e pagamentos só sinalizam estados persistidos acionáveis", () => {
  assert.equal(classifyPosSession("open", ago(720), now), "open_stale");
  assert.equal(classifyPosSession("closing", ago(900), now), "closing_stale");
  assert.equal(classifyPosSession("open", ago(719), now), null);
  assert.equal(classifyPosSession("closed", ago(10_000), now), null);
  assert.equal(classifyPosPayment("unknown", now, now), "unknown");
  assert.equal(classifyPosPayment("manual_review", now, now), "manual_review");
  assert.equal(classifyPosPayment("pending", now, now), "pending");
  assert.equal(classifyPosPayment("processing", ago(15), now), "pending");
  assert.equal(classifyPosPayment("processing", ago(14), now), null);
  assert.equal(classifyPosPayment("captured", ago(1_000), now), null);
});

test("fila de impressão distingue lease expirado sem mascarar falha", () => {
  assert.equal(classifyPosPrintJob({ status: "processing", createdAt: ago(10), claimedAt: ago(3), claimExpiresAt: ago(1) }, now), "lease_expired");
  assert.equal(classifyPosPrintJob({ status: "processing", createdAt: ago(10), claimedAt: ago(1), claimExpiresAt: new Date(now.valueOf() + 60_000) }, now), "processing");
  assert.equal(classifyPosPrintJob({ status: "failed", createdAt: ago(10), claimedAt: null, claimExpiresAt: null }, now), "failed");
  assert.equal(classifyPosPrintJob({ status: "printed", createdAt: ago(10), claimedAt: null, claimExpiresAt: null }, now), null);
});

test("heartbeat separa terminal stale, offline e revogado; dispositivo usa estado real", () => {
  assert.equal(classifyPosTerminal({ status: "online", lastSeenAt: ago(5) }, now), "stale");
  assert.equal(classifyPosTerminal({ status: "online", lastSeenAt: ago(15) }, now), "offline");
  assert.equal(classifyPosTerminal({ status: "online", lastSeenAt: ago(4) }, now), null);
  assert.equal(classifyPosTerminal({ status: "unpaired", lastSeenAt: null }, now), null);
  assert.equal(classifyPosTerminal({ status: "revoked", lastSeenAt: now, revokedAt: now }, now), "revoked");
  assert.equal(classifyPosDevice("error"), "error");
  assert.equal(classifyPosDevice("offline"), "offline");
  assert.equal(classifyPosDevice("unknown"), null);
});

test("sync final respeita janela e processamento só alerta após limiar", () => {
  const windowStart = ago(24 * 60);
  assert.equal(classifyPosSync({ state: "rejected", receivedAt: ago(60) }, now, windowStart), "rejected");
  assert.equal(classifyPosSync({ state: "conflict", receivedAt: ago(24 * 60 + 1) }, now, windowStart), null);
  assert.equal(classifyPosSync({ state: "processing", receivedAt: ago(5) }, now, windowStart), "processing_stale");
  assert.equal(classifyPosSync({ state: "received", receivedAt: ago(4) }, now, windowStart), null);
  assert.equal(classifyPosSync({ state: "applied", receivedAt: ago(5) }, now, windowStart), null);
});

test("lotes sem saldo não geram incidente e vencimento pode coexistir com quarentena", () => {
  const businessDate = new Date("2026-08-29T00:00:00.000Z");
  assert.deepEqual(classifyPosLot({ status: "quarantine", bucketKey: "quarantine", quantityMicros: BigInt(1), expiresOn: new Date("2026-08-28T00:00:00.000Z") }, businessDate), ["quarantine", "expired"]);
  assert.deepEqual(classifyPosLot({ status: "expired", bucketKey: "sellable", quantityMicros: BigInt(0), expiresOn: new Date("2026-08-28T00:00:00.000Z") }, businessDate), []);
  assert.deepEqual(classifyPosLot({ status: "available", bucketKey: "sellable", quantityMicros: BigInt(1), expiresOn: businessDate }, businessDate), []);
});

test("diagnóstico promocional compara somente contagens fornecidas pelo banco", () => {
  assert.deepEqual(classifyPosCouponCounter({ usedCount: 3, activeRedemptions: 2, usageLimit: 2 }), ["counter_mismatch", "limit_exceeded"]);
  assert.deepEqual(classifyPosCouponCounter({ usedCount: 2, activeRedemptions: 2, usageLimit: 2 }), []);
  assert.deepEqual(classifyPosPromotionUsage({ activeRedemptions: 6, usageLimit: 5, exceededCustomerGroups: 2 }), ["limit_exceeded", "per_customer_limit_exceeded"]);
});
