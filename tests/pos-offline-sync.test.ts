import assert from "node:assert/strict";
import test from "node:test";
import {
  finalizePosOfflineOperation,
  hashPosOfflineOperation,
  normalizePosOfflineSyncBatch,
  normalizePosOfflineAck,
  normalizePosOfflinePull,
  planPosOfflineDraftMutation,
  PosOfflineSyncError,
  posOfflineSyncWindow,
  replayPosOfflineOperation,
} from "../lib/erp/pos-offline-sync";

const scope = { organizationId: "org-a", terminalId: "terminal-a" };
const now = new Date("2026-08-29T12:00:00.000Z");

function operation(overrides: Record<string, unknown> = {}) {
  return {
    operationId: "74d4699d-3434-42db-8130-a38bbbd00001",
    sequence: "1",
    type: "terminal.heartbeat",
    occurredAt: "2026-08-29T11:59:00.000Z",
    payload: { appVersion: "1.2.3", queueDepth: 2 },
    ...overrides,
  };
}

function normalize(raw = operation()) {
  return normalizePosOfflineSyncBatch({ action: "sync.push", operations: [raw] }, scope, { now, maxPastMs: 3_600_000, maxFutureMs: 60_000 })[0];
}

test("normalização limita lote, sequência e janela temporal", () => {
  const normalized = normalize();
  assert.equal(normalized.sequence, BigInt(1));
  assert.equal(normalized.supported, true);
  assert.match(normalized.requestHash, /^[0-9a-f]{64}$/);
  assert.throws(() => normalizePosOfflineSyncBatch({ action: "sync.push", operations: [] }, scope, { now }), PosOfflineSyncError);
  assert.throws(() => normalize(operation({ sequence: "0" })), /Sequência offline inválida/);
  assert.throws(() => normalize(operation({ occurredAt: "2026-08-29T10:00:00.000Z" })), /fora da janela/);
  assert.throws(() => normalize(operation({ occurredAt: "2026-08-29T12:02:00.000Z" })), /fora da janela/);
});

test("lote exige sequência estritamente crescente e IDs únicos", () => {
  const second = operation({ operationId: "74d4699d-3434-42db-8130-a38bbbd00002", sequence: "2" });
  assert.equal(normalizePosOfflineSyncBatch({ action: "sync.push", operations: [operation(), second] }, scope, { now }).length, 2);
  assert.throws(() => normalizePosOfflineSyncBatch({ action: "sync.push", operations: [second, operation()] }, scope, { now }), /estritamente crescente/);
  assert.throws(() => normalizePosOfflineSyncBatch({ action: "sync.push", operations: [operation(), operation({ sequence: "2" })] }, scope, { now }), /operationIds repetidos/);
});

test("hash é canônico e vinculado ao tenant, terminal, operação, sequência e payload", () => {
  const input = {
    ...scope,
    operationId: "74d4699d-3434-42db-8130-a38bbbd00001",
    sequence: BigInt(1),
    type: "terminal.heartbeat",
    occurredAt: now,
    payload: { queueDepth: 2, appVersion: "1.2.3" },
  };
  const hash = hashPosOfflineOperation(input);
  assert.equal(hash, hashPosOfflineOperation({ ...input, payload: { appVersion: "1.2.3", queueDepth: 2 } }));
  for (const changed of [
    { ...input, organizationId: "org-b" },
    { ...input, terminalId: "terminal-b" },
    { ...input, sequence: BigInt(2) },
    { ...input, payload: { appVersion: "1.2.4", queueDepth: 2 } },
  ]) assert.notEqual(hash, hashPosOfflineOperation(changed));
});

test("allowlist de rascunho não aceita preço, pagamento, texto livre ou mass assignment", () => {
  const draft = normalize(operation({
    type: "cart.draft.upsert",
    payload: {
      draftId: "74d4699d-3434-42db-8130-a38bbbd00100",
      baseRevision: 0,
      revision: 1,
      customerId: 12,
      items: [{ lineId: "74d4699d-3434-42db-8130-a38bbbd00200", productId: 34, variationId: null, quantityMicros: "1500000" }],
    },
  }));
  assert.deepEqual(draft.payload, {
    draftId: "74d4699d-3434-42db-8130-a38bbbd00100",
    baseRevision: 0,
    revision: 1,
    customerId: 12,
    items: [{ lineId: "74d4699d-3434-42db-8130-a38bbbd00200", productId: 34, variationId: null, quantityMicros: "1500000" }],
  });
  for (const forbidden of [
    { totalCents: 100 },
    { paymentStatus: "captured" },
    { note: "texto livre" },
    { status: "paid" },
  ]) assert.throws(() => normalize(operation({ type: "cart.draft.upsert", payload: { ...draft.payload, ...forbidden } })), /campo não permitido/);
});

test("pull e ACK aceitam apenas cursor não negativo e versões SHA-256", () => {
  assert.deepEqual(normalizePosOfflinePull({ action: "sync.pull", afterSequence: "0", catalogVersion: "a".repeat(64), permissionVersion: null }), { afterSequence: BigInt(0), catalogVersion: "a".repeat(64), permissionVersion: null });
  assert.deepEqual(normalizePosOfflineAck({ action: "sync.ack", throughSequence: "9" }), { throughSequence: BigInt(9) });
  assert.throws(() => normalizePosOfflinePull({ action: "sync.pull", afterSequence: "-1" }), /Cursor de pull inválido/);
  assert.throws(() => normalizePosOfflineAck({ action: "sync.ack", throughSequence: "1", extra: true }), /campo não permitido/);
});

test("rascunho aplica somente a próxima revisão e produz conflito determinístico sem payload", () => {
  const first = normalize(operation({ type: "cart.draft.upsert", payload: { draftId: "74d4699d-3434-42db-8130-a38bbbd00100", baseRevision: 0, revision: 1, customerId: null, items: [{ lineId: "74d4699d-3434-42db-8130-a38bbbd00200", productId: 34, variationId: null, quantityMicros: "1000000" }] } }));
  const applied = planPosOfflineDraftMutation(first, null);
  assert.equal(applied.state, "applied");
  assert.equal(applied.projection?.revision, 1);
  const conflict = planPosOfflineDraftMutation(first, { draftId: String(first.payload.draftId), revision: 2, state: "active", payload: {} });
  assert.deepEqual(conflict.conflict, { code: "draft_revision_conflict", draftId: first.payload.draftId, clientBaseRevision: 0, clientRevision: 1, serverRevision: 2, serverState: "active", requiresResolution: true });
  assert.equal(conflict.response, undefined);
});

test("payload genérico rejeita PCI, trilha e campos de segredo antes de registrar rejeição", () => {
  for (const payload of [
    { cardNumber: "4111111111111111" },
    { reference: "4111 1111 1111 1111" },
    { track2: ";4111111111111111=29121010000000000000?" },
    { authorization: "Bearer segredo" },
  ]) assert.throws(() => normalize(operation({ type: "sale.commit", payload })), /sensível|cartão|trilha/);
});

test("pagamento, fiscal e venda offline são rejeitados de modo determinístico e sem payload persistível", () => {
  for (const type of ["sale.commit", "payment.confirm", "fiscal.authorize", "session.open"]) {
    const normalized = normalize(operation({ type, payload: { localReference: "safe-reference" } }));
    assert.equal(normalized.supported, false);
    assert.deepEqual(normalized.payload, {});
    assert.deepEqual(finalizePosOfflineOperation(normalized), {
      state: "rejected",
      response: {
        accepted: false,
        code: "offline_operation_not_supported",
        requiresOnline: true,
        message: "Esta operação exige processamento online autoritativo.",
      },
    });
  }
});

test("replay só devolve resposta final persistida quando todo o contexto coincide", () => {
  const normalized = normalize();
  const record = {
    terminalId: scope.terminalId,
    operationId: normalized.operationId,
    sequence: normalized.sequence,
    type: normalized.type,
    state: "applied",
    requestHash: normalized.requestHash,
    response: { accepted: true },
    conflict: null,
    processedAt: now,
  };
  assert.equal(replayPosOfflineOperation(record, normalized, scope.terminalId).replayed, true);
  assert.throws(() => replayPosOfflineOperation({ ...record, requestHash: "0".repeat(64) }, normalized, scope.terminalId), (error) => error instanceof PosOfflineSyncError && error.status === 409);
  assert.throws(() => replayPosOfflineOperation({ ...record, sequence: BigInt(2) }, normalized, scope.terminalId), /outro contexto/);
  assert.throws(() => replayPosOfflineOperation({ ...record, state: "processing", processedAt: null }, normalized, scope.terminalId), /processamento/);
});

test("janela configurável falha fechada quando variável é inválida", () => {
  assert.deepEqual(posOfflineSyncWindow({}), { maxPastMs: 168 * 3_600_000, maxFutureMs: 300_000 });
  assert.throws(() => posOfflineSyncWindow({ POS_OFFLINE_SYNC_MAX_AGE_HOURS: "0" }), (error) => error instanceof PosOfflineSyncError && error.status === 500);
  assert.throws(() => posOfflineSyncWindow({ POS_OFFLINE_SYNC_MAX_FUTURE_SECONDS: "não-numérico" }), (error) => error instanceof PosOfflineSyncError && error.status === 500);
});
