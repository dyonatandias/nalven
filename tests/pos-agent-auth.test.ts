import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createAgentToken, createPairingCode, hashAgentToken, hashPairingCode, normalizePairingCode, parseBearerToken, PosAgentError, verifyAgentToken } from "../lib/erp/pos-agent-auth";

const pepper = "test-only-pepper-with-more-than-32-bytes-000001";
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

test("código de pareamento possui 128 bits, formato estrito e normalização", () => {
  const code = createPairingCode();
  assert.match(code, /^[0-9A-F]{8}(?:-[0-9A-F]{8}){3}$/);
  assert.equal(normalizePairingCode(code.toLowerCase()), code.replaceAll("-", ""));
  assert.throws(() => normalizePairingCode("1234-5678"), (error) => error instanceof PosAgentError && error.status === 401);
});

test("hash HMAC vincula propósito, organização e terminal sem guardar segredo", () => {
  const code = createPairingCode(), first = hashPairingCode("org-a", "terminal-a", code, pepper);
  assert.match(first, /^hmac-sha256:v1:[0-9a-f]{64}$/);
  assert.ok(!first.includes(normalizePairingCode(code)));
  assert.notEqual(first, hashPairingCode("org-b", "terminal-a", code, pepper));
  assert.notEqual(first, hashPairingCode("org-a", "terminal-b", code, pepper));
});

test("token forte é aceito somente no contexto e formato corretos", () => {
  const token = createAgentToken(), stored = hashAgentToken("org-a", "terminal-a", token, pepper);
  assert.match(token, /^posagt_v1_[A-Za-z0-9_-]{64}$/);
  assert.equal(parseBearerToken(`Bearer ${token}`), token);
  assert.equal(verifyAgentToken(stored, "org-a", "terminal-a", token, pepper), true);
  assert.equal(verifyAgentToken(stored, "org-b", "terminal-a", token, pepper), false);
  assert.equal(verifyAgentToken(stored, "org-a", "terminal-b", token, pepper), false);
  const tampered = `${token.slice(0, -1)}${token.endsWith("x") ? "y" : "x"}`;
  assert.equal(verifyAgentToken(stored, "org-a", "terminal-a", tampered, pepper), false);
  assert.throws(() => parseBearerToken(token), (error) => error instanceof PosAgentError && error.status === 401);
});

test("pepper curto falha fechado", () => {
  const token = createAgentToken();
  assert.throws(() => hashAgentToken("org", "terminal", token, "short"), (error) => error instanceof PosAgentError && error.status === 503);
  assert.equal(verifyAgentToken("hmac-sha256:v1:" + "a".repeat(64), "org", "terminal", token, "short"), false);
});

test("migration garante uso único, expiração de token e lease de impressão", () => {
  const migration = readFileSync(join(projectRoot, "prisma/tenant/migrations/20260828120000_pos_terminal_agent_lifecycle/migration.sql"), "utf8");
  for (const invariant of ["pos_terminal_pairings_code_hash_key", "pos_terminal_pairings_idempotency_key_key", "pos_terminal_pairings_state_time_check", "pos_terminals_token_lifecycle_check", "pos_print_jobs_claim_id_key", "pos_print_jobs_claim_check"]) assert.match(migration, new RegExp(invariant));
  assert.match(migration, /terminal\.pairing\.issue/);
  assert.match(migration, /terminal\.token\.rotate/);
  assert.match(migration, /terminal\.revoke/);
});

test("canal do agente limita mutações e usa claim concorrente", () => {
  const route = readFileSync(join(projectRoot, "app/api/pos-agent/[organizationId]/[terminalId]/route.ts"), "utf8");
  assert.match(route, /FOR UPDATE SKIP LOCKED/);
  assert.match(route, /\["online", "offline", "error", "unknown"\]/);
  assert.match(route, /onlyKeys\(value, \["deviceId", "status", "lastError"\]\)/);
  assert.match(route, /claimId:\s*input\.claimId/);
  assert.match(route, /posPrintAcknowledgement\.findUnique/);
  assert.doesNotMatch(route, /credentialRef/);
});

test("respostas públicas não serializam material persistido de autenticação", () => {
  const admin = readFileSync(join(projectRoot, "app/api/erp/pdv/terminals/route.ts"), "utf8");
  const agent = readFileSync(join(projectRoot, "app/api/pos-agent/[organizationId]/[terminalId]/route.ts"), "utf8");
  const publicDto = admin.slice(admin.indexOf("function terminalPublic"), admin.indexOf("function text", admin.indexOf("function terminalPublic")));
  assert.doesNotMatch(publicDto, /tokenHash|certificateFingerprint|credentialRef/);
  assert.doesNotMatch(agent, /tokenHash:\s*terminal\.tokenHash|certificateFingerprint:\s*terminal/);
});
