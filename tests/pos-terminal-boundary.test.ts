import assert from "node:assert/strict";
import test from "node:test";
import { createAgentToken, hashAgentToken } from "../lib/erp/pos-agent-auth";
import {
  assertPosOperationalTerminalProof,
  assertPosSessionTerminalBinding,
  authenticatePosOperationalTerminal,
  posTerminalBoundOpenRequestHash,
  PosTerminalBoundaryError,
  readPosOperationalTerminalCredential,
  type PosOperationalTerminalRecord,
} from "../lib/erp/pos-terminal-boundary";

process.env.POS_AGENT_TOKEN_PEPPER = "test-only-terminal-boundary-pepper-at-least-32-bytes";
const organizationId = "org-terminal-boundary";

function fixture(overrides: Partial<PosOperationalTerminalRecord> = {}) {
  const token = createAgentToken();
  const now = new Date("2026-08-29T12:00:00.000Z");
  const record: PosOperationalTerminalRecord = {
    id: "terminal-a",
    registerId: 10,
    status: "online",
    tokenHash: hashAgentToken(organizationId, "terminal-a", token),
    tokenExpiresAt: new Date(now.valueOf() + 60_000),
    credentialVersion: 3,
    appVersion: "1.0.0",
    lastSeenAt: new Date(now.valueOf() - 30_000),
    pairedAt: new Date(now.valueOf() - 86_400_000),
    revokedAt: null,
    register: { id: 10, branchId: 20, status: "active", branch: { id: 20, status: "active" } },
    ...overrides,
  };
  return { token, now, record };
}

test("terminal ausente falha fechado antes de qualquer ID fornecido pelo corpo", () => {
  assert.throws(
    () => readPosOperationalTerminalCredential(new Headers()),
    (error) => error instanceof PosTerminalBoundaryError && error.status === 401,
  );
});

test("terminal pareado, online e vivo produz prova contextual", () => {
  const { token, now, record } = fixture();
  const proof = authenticatePosOperationalTerminal(record, { organizationId, terminalId: record.id, token, now, expectedBranchId: 20, expectedRegisterId: 10 });
  assert.deepEqual({ terminalId: proof.terminalId, registerId: proof.registerId, branchId: proof.branchId }, { terminalId: "terminal-a", registerId: 10, branchId: 20 });
});

test("terminal revogado e heartbeat vencido são recusados", () => {
  const revoked = fixture({ status: "revoked", revokedAt: new Date("2026-08-29T11:59:00.000Z") });
  assert.throws(() => authenticatePosOperationalTerminal(revoked.record, { organizationId, terminalId: revoked.record.id, token: revoked.token, now: revoked.now }), PosTerminalBoundaryError);
  const stale = fixture({ lastSeenAt: new Date("2026-08-29T11:55:00.000Z") });
  assert.throws(() => authenticatePosOperationalTerminal(stale.record, { organizationId, terminalId: stale.record.id, token: stale.token, now: stale.now }), (error) => error instanceof PosTerminalBoundaryError && error.status === 409);
});

test("token e prova não podem ser trocados entre terminais ou caixas", () => {
  const { token, now, record } = fixture();
  assert.throws(() => authenticatePosOperationalTerminal({ ...record, id: "terminal-b" }, { organizationId, terminalId: "terminal-b", token, now }), PosTerminalBoundaryError);
  const proof = authenticatePosOperationalTerminal(record, { organizationId, terminalId: record.id, token, now });
  assert.throws(() => assertPosOperationalTerminalProof({ ...record, registerId: 11, register: { ...record.register, id: 11 } }, proof, { now }), PosTerminalBoundaryError);
});

test("turno fica vinculado ao terminal autenticado no hash de abertura", () => {
  const { token, now, record } = fixture();
  const proof = authenticatePosOperationalTerminal(record, { organizationId, terminalId: record.id, token, now });
  const session = { registerId: 10, openingAmountCents: 5000, openRequestHash: posTerminalBoundOpenRequestHash({ registerId: 10, openingAmountCents: 5000, terminalId: "terminal-a" }) };
  assert.doesNotThrow(() => assertPosSessionTerminalBinding(session, proof));
  assert.throws(() => assertPosSessionTerminalBinding({ ...session, openRequestHash: posTerminalBoundOpenRequestHash({ registerId: 10, openingAmountCents: 5000, terminalId: "terminal-b" }) }, proof), PosTerminalBoundaryError);
  assert.throws(() => assertPosSessionTerminalBinding({ ...session, openRequestHash: null }, proof), PosTerminalBoundaryError);
});
