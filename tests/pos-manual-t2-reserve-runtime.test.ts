import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { QueryResultRow } from "pg";
import {
  POS_MANUAL_T2_RESERVE_APPLICATION_NAME,
  POS_MANUAL_T2_RESERVE_CAPABILITY,
  PosManualT2ReserveClient,
  dedicatedPoolConfig,
  reserveRequestHash,
  type PosManualT2AutocommitExecutor,
  type PosManualT2ReserveInput,
} from "../lib/erp/pos-manual-t2-reserve";

const input: PosManualT2ReserveInput = {
  caseId: "00000000-0000-4000-8000-000000000001",
  expectedCaseVersionBeforeReserve: 3,
  actorProfileId: 7,
  actorUserId: "operator-opaque",
  idempotencyKey: "a".repeat(64),
};

const status = {
  applicationId: "00000000-0000-5000-8000-000000000002",
  applicationVersion: 0,
  blockedCode: null,
  caseId: input.caseId,
  caseVersionAfterReserve: 4,
  currentlyApplicable: true,
  failureClass: null,
  paymentId: null,
  reservationExpiresAt: "2026-08-31T12:00:00.000000Z",
  saleId: null,
  state: "pending",
};

const reserve = {
  applicationId: status.applicationId,
  caseId: input.caseId,
  caseVersionBeforeReserve: 3,
  caseVersionAfterReserve: 4,
  applicationVersion: 0,
  state: "pending",
  reservationExpiresAt: status.reservationExpiresAt,
  snapshotHash: "b".repeat(64),
  manifestHash: "c".repeat(64),
  replayed: false,
  currentlyApplicable: true,
};

class SequenceExecutor implements PosManualT2AutocommitExecutor {
  readonly calls: Array<{ statement: string; values: readonly unknown[] }> = [];
  constructor(private readonly outcomes: Array<unknown | Error>) {}

  async query<R extends QueryResultRow>(statement: string, values: readonly unknown[]): Promise<{ rows: R[] }> {
    this.calls.push({ statement, values });
    const outcome = this.outcomes.shift();
    if (outcome instanceof Error) throw outcome;
    return { rows: [{ result: outcome } as unknown as R] };
  }
}

test("hash de reserve é byte-exato e incorpora capability/session_user confiáveis", () => {
  const canonical = `{"actorProfileId":7,"actorUserId":"operator-opaque","capability":"${POS_MANUAL_T2_RESERVE_CAPABILITY}","caseId":"${input.caseId}","expectedCaseVersionBeforeReserve":3,"idempotencyKey":"${input.idempotencyKey}","schemaVersion":1,"sessionUser":"tenant_runtime"}`;
  const expected = createHash("sha256").update("t2-reserve-request-v1\0", "utf8").update(canonical, "utf8").digest("hex");
  assert.equal(reserveRequestHash(input, "tenant_runtime"), expected);
  assert.throws(() => reserveRequestHash({ ...input, idempotencyKey: "short" }, "tenant_runtime"), /IDEMPOTENCY_KEY_INVALID/);
  assert.throws(() => reserveRequestHash({ ...input, actorUserId: "operator\nopaque" }, "tenant_runtime"), /ACTORUSERID_INVALID/);
});

test("pool dedicado nasce SERIALIZABLE com application_name e limites próprios", () => {
  const config = dedicatedPoolConfig({
    connectionString: "postgresql://tenant_runtime:secret@127.0.0.1:5432/tenant",
    sessionUser: "tenant_runtime",
    maximumPoolSize: 3,
  });
  assert.equal(config.options, `-c default_transaction_isolation=serializable -c application_name=${POS_MANUAL_T2_RESERVE_APPLICATION_NAME}`);
  assert.equal(config.max, 3);
  assert.equal(config.allowExitOnIdle, true);
  assert.throws(() => dedicatedPoolConfig({ connectionString: "postgresql://tenant_runtime@127.0.0.1:5432/tenant?application_name=wrong" }), /CONNECTION_STRING_INVALID/);
  assert.throws(() => dedicatedPoolConfig({ connectionString: "postgresql://tenant_runtime@127.0.0.1:5432/tenant", sessionUser: "other" }), /SESSION_USER_MISMATCH/);
});

test("reserve executa um único SELECT autocommit e valida o ACK persistido", async () => {
  const executor = new SequenceExecutor([reserve]);
  const client = PosManualT2ReserveClient.withExecutor(executor, "tenant_runtime");
  assert.deepEqual(await client.reserve(input), reserve);
  assert.equal(executor.calls.length, 1);
  assert.match(executor.calls[0]!.statement, /^SELECT public\.pos_manual_reserve_application_v1\(/u);
  assert.doesNotMatch(executor.calls[0]!.statement, /\bBEGIN\b|\bCOMMIT\b|;/iu);
  assert.equal(executor.calls[0]!.values.length, 6);
  assert.equal(executor.calls[0]!.values[5], reserveRequestHash(input, "tenant_runtime"));
});

test("lost ACK usa probe por identidade e preserva as três saídas", async () => {
  const reset = Object.assign(new Error("socket reset after commit"), { code: "ECONNRESET" });
  const committedExecutor = new SequenceExecutor([reset, { outcome: "committed_same_request", winner: status }]);
  const committed = await PosManualT2ReserveClient.withExecutor(committedExecutor, "tenant_runtime").reserveWithLostCommitProbe(input);
  assert.deepEqual(committed, { outcome: "committed_same_request", winner: status });
  assert.equal(committedExecutor.calls.length, 2);
  assert.match(committedExecutor.calls[1]!.statement, /^SELECT public\.pos_manual_application_status_by_reservation_v1\(/u);

  const absentExecutor = new SequenceExecutor([reset, { outcome: "authoritatively_absent", winner: null }]);
  assert.deepEqual(await PosManualT2ReserveClient.withExecutor(absentExecutor, "tenant_runtime").reserveWithLostCommitProbe(input), { outcome: "authoritatively_absent", winner: null });

  const unknownExecutor = new SequenceExecutor([reset, Object.assign(new Error("primary unavailable"), { code: "57P03" })]);
  assert.deepEqual(await PosManualT2ReserveClient.withExecutor(unknownExecutor, "tenant_runtime").reserveWithLostCommitProbe(input), { outcome: "unknown", winner: null });
});

test("serialization/deadlock repetem a mesma key e propagam após limite", async () => {
  const first = Object.assign(new Error("serialization"), { code: "40001" });
  const retryExecutor = new SequenceExecutor([first, reserve]);
  assert.deepEqual(await PosManualT2ReserveClient.withExecutor(retryExecutor, "tenant_runtime").reserveWithLostCommitProbe(input), { outcome: "committed", winner: reserve });
  assert.equal(retryExecutor.calls.length, 2);
  assert.deepEqual(retryExecutor.calls[0]!.values, retryExecutor.calls[1]!.values);

  for (const code of ["40001", "40P01"]) {
    const error = Object.assign(new Error(code), { code });
    const executor = new SequenceExecutor([error, error, error]);
    await assert.rejects(PosManualT2ReserveClient.withExecutor(executor, "tenant_runtime").reserveWithLostCommitProbe(input), (caught: unknown) => (caught as { code?: string }).code === code);
    assert.equal(executor.calls.length, 3);
    assert.deepEqual(executor.calls[0]!.values, executor.calls[2]!.values);
  }
});

test("timeout/cancel não viram sucesso", async () => {
  const timeout = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
  const executor = new SequenceExecutor([timeout]);
  assert.deepEqual(await PosManualT2ReserveClient.withExecutor(executor, "tenant_runtime").reserveWithLostCommitProbe(input), { outcome: "unknown", winner: null });
  assert.equal(executor.calls.length, 1);
});

test("shape inválido falha antes de conexão e nunca é sondado", async () => {
  const executor = new SequenceExecutor([]);
  await assert.rejects(
    PosManualT2ReserveClient.withExecutor(executor, "tenant_runtime").reserveWithLostCommitProbe({ ...input, idempotencyKey: "invalid" }),
    /IDEMPOTENCY_KEY_INVALID/,
  );
  assert.equal(executor.calls.length, 0);
});

test("status não vaza application alheia e rejeita combinações fora da máquina", async () => {
  const notFound = new SequenceExecutor([{ status: "not_found" }]);
  assert.deepEqual(await PosManualT2ReserveClient.withExecutor(notFound, "tenant_runtime").status(status.applicationId, input.actorUserId), { status: "not_found" });

  const invalid = new SequenceExecutor([{ ...status, state: "applied", currentlyApplicable: false }]);
  await assert.rejects(PosManualT2ReserveClient.withExecutor(invalid, "tenant_runtime").status(status.applicationId, input.actorUserId), /STATUS_MACHINE_INVALID/);

  const extra = new SequenceExecutor([{ ...status, snapshotHash: "d".repeat(64) }]);
  await assert.rejects(PosManualT2ReserveClient.withExecutor(extra, "tenant_runtime").status(status.applicationId, input.actorUserId), /RESULT_SHAPE_INVALID/);
});
