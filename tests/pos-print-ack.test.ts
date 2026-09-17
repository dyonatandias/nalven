import assert from "node:assert/strict";
import test from "node:test";
import { PosAgentError } from "../lib/erp/pos-agent-auth";
import { hashPosPrintAck, replayPosPrintAck, type PosPrintAckInput } from "../lib/erp/pos-print-ack";

const base: PosPrintAckInput = {
  terminalId: "terminal-a",
  jobId: "job-a",
  claimId: "74d4699d-3434-42db-8130-a38bbbd00001",
  state: "failed",
  error: "Impressora sem papel",
};

test("hash de ACK é canônico, contextual e não persiste o erro aberto", () => {
  const reordered: PosPrintAckInput = { error: base.error, state: base.state, claimId: base.claimId, jobId: base.jobId, terminalId: base.terminalId };
  const hash = hashPosPrintAck(base);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash, hashPosPrintAck(reordered));
  assert.ok(!hash.includes(base.error!));
  for (const changed of [
    { ...base, terminalId: "terminal-b" },
    { ...base, jobId: "job-b" },
    { ...base, claimId: "74d4699d-3434-42db-8130-a38bbbd00002" },
    { ...base, state: "printed" as const, error: null },
    { ...base, error: "Falha de comunicação" },
  ]) assert.notEqual(hash, hashPosPrintAck(changed));
});

test("replay idêntico devolve o resultado original", () => {
  const record = { terminalId: base.terminalId, jobId: base.jobId, claimId: base.claimId, requestHash: hashPosPrintAck(base), resultStatus: "queued" };
  assert.deepEqual(replayPosPrintAck(record, base), { id: "job-a", status: "queued", replayed: true });
});

test("mesmo claim rejeita estado, erro ou contexto divergente", () => {
  const record = { terminalId: base.terminalId, jobId: base.jobId, claimId: base.claimId, requestHash: hashPosPrintAck(base), resultStatus: "queued" };
  for (const changed of [
    { ...base, state: "printed" as const, error: null },
    { ...base, error: "Outro erro" },
    { ...base, jobId: "job-b" },
    { ...base, terminalId: "terminal-b" },
  ]) {
    assert.throws(() => replayPosPrintAck(record, changed), (error) => error instanceof PosAgentError && error.status === 409);
  }
});
