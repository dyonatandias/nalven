import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPosHandoffPending,
  assertPosSessionTransition,
  hashPosSessionLifecycleInput,
  parsePosSessionLifecycleInput,
  PosSessionLifecycleError,
  posSessionHandoffExpiresAt,
} from "../lib/erp/pos-session-lifecycle";

const key = (suffix: string) => `session-lifecycle-${suffix}-0001`;

test("parser de ciclo do turno fecha campos, CAS e identidade", () => {
  const suspend = parsePosSessionLifecycleInput({ action: "session.suspend", sessionId: 7, expectedVersion: 2, reason: "Pausa operacional", idempotencyKey: key("suspend") });
  assert.equal(suspend.action, "session.suspend");
  assert.equal(suspend.reason, "Pausa operacional");
  assert.throws(() => parsePosSessionLifecycleInput({ ...suspend, injected: true }), PosSessionLifecycleError);
  assert.throws(() => parsePosSessionLifecycleInput({ ...suspend, expectedVersion: "2" }), PosSessionLifecycleError);
  assert.throws(() => parsePosSessionLifecycleInput({ ...suspend, reason: "curto" }), PosSessionLifecycleError);

  const request = parsePosSessionLifecycleInput({ action: "session.handoff.request", sessionId: 7, expectedVersion: 2, targetProfileId: 9, reason: "Troca programada", idempotencyKey: key("request") });
  if (request.action !== "session.handoff.request") assert.fail("A ação normalizada deveria ser uma solicitação de passagem.");
  assert.notEqual(hashPosSessionLifecycleInput(request), hashPosSessionLifecycleInput({ ...request, targetProfileId: 10 }));
  assert.throws(() => parsePosSessionLifecycleInput({ action: "session.handoff.accept", sessionId: 7, handoffId: "handoff_1234", expectedSessionVersion: 3, expectedHandoffRevision: 1, idempotencyKey: "curta" }), /idempotência/);
});

test("máquina do turno permite apenas pausa, retomada e fechamento válidos", () => {
  assert.doesNotThrow(() => assertPosSessionTransition("open", "suspended"));
  assert.doesNotThrow(() => assertPosSessionTransition("suspended", "open"));
  assert.doesNotThrow(() => assertPosSessionTransition("open", "closing"));
  assert.doesNotThrow(() => assertPosSessionTransition("closing", "closed"));
  assert.throws(() => assertPosSessionTransition("suspended", "closed"), /inválida/);
  assert.throws(() => assertPosSessionTransition("closed", "open"), /inválida/);
  assert.throws(() => assertPosSessionTransition("unknown", "open"), /inválida/);
});

test("passagem exige estado, revisão e validade correntes", () => {
  const now = new Date("2026-08-29T12:00:00.000Z");
  const expiresAt = posSessionHandoffExpiresAt(now);
  assert.equal(expiresAt.toISOString(), "2026-08-29T12:10:00.000Z");
  assert.doesNotThrow(() => assertPosHandoffPending({ state: "requested", expiresAt, revision: 3 }, 3, now));
  assert.throws(() => assertPosHandoffPending({ state: "accepted", expiresAt, revision: 3 }, 3, now), /resolvida/);
  assert.throws(() => assertPosHandoffPending({ state: "requested", expiresAt, revision: 4 }, 3, now), /alterada/);
  assert.throws(() => assertPosHandoffPending({ state: "requested", expiresAt: now, revision: 3 }, 3, now), /expirou/);
  assert.throws(() => posSessionHandoffExpiresAt(now, 31), /Validade/);
});
