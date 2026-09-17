import assert from "node:assert/strict";
import test from "node:test";
import {
  createPosOfflineCredentialToken,
  hashPosOfflineCredential,
  parsePosOfflineBearerToken,
  posOfflineCredentialRequestHash,
  posOfflineCredentialTtlMinutes,
  verifyPosOfflineCredential,
} from "../lib/erp/pos-offline-credential";

const pepper = "p".repeat(64), organizationId = "org-a", terminalId = "terminal-a";

test("credencial offline é opaca, contextual e comparada em tempo constante", () => {
  const issued = createPosOfflineCredentialToken("74d4699d-3434-42db-8130-a38bbbd00001");
  assert.deepEqual(parsePosOfflineBearerToken(`Bearer ${issued.token}`), issued);
  const hash = hashPosOfflineCredential(organizationId, terminalId, issued.id, issued.token, pepper);
  assert.match(hash, /^hmac-sha256:v1:[0-9a-f]{64}$/);
  assert.equal(verifyPosOfflineCredential(hash, organizationId, terminalId, issued.id, issued.token, pepper), true);
  assert.equal(verifyPosOfflineCredential(hash, "org-b", terminalId, issued.id, issued.token, pepper), false);
  assert.equal(verifyPosOfflineCredential(hash, organizationId, "terminal-b", issued.id, issued.token, pepper), false);
});

test("TTL falha fechado e hashes de emissão/revogação vinculam o contexto", () => {
  assert.equal(posOfflineCredentialTtlMinutes(undefined, {}), 240);
  assert.equal(posOfflineCredentialTtlMinutes(60, { POS_OFFLINE_CREDENTIAL_MAX_MINUTES: "60" }), 60);
  assert.throws(() => posOfflineCredentialTtlMinutes(61, { POS_OFFLINE_CREDENTIAL_MAX_MINUTES: "60" }), /entre 15 e 60/);
  const issue = posOfflineCredentialRequestHash({ action: "credential.issue", terminalId, userId: "user-a", ttlMinutes: 60 });
  const revoke = posOfflineCredentialRequestHash({ action: "credential.revoke", terminalId, userId: "user-a", credentialId: "74d4699d-3434-42db-8130-a38bbbd00001" });
  assert.notEqual(issue, revoke);
  assert.notEqual(revoke, posOfflineCredentialRequestHash({ action: "credential.revoke", terminalId, userId: "user-b", credentialId: "74d4699d-3434-42db-8130-a38bbbd00001" }));
});
