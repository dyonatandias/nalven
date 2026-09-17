import assert from "node:assert/strict";
import test from "node:test";
import { constantTimeEqual, decryptSecrets, encryptSecrets, generateOtp, redact, serializeCredential, splitCredential } from "../lib/integrations/core";
import { isPublicIp, sanitizeRedirectHeaders } from "../lib/integrations/security";

process.env.NALVEN_SECRETS_MASTER_KEY = "integration-tests-only";

test("segredos são cifrados, mascarados e preservados quando o formulário volta vazio", () => {
  const first = splitCredential("openai", {
    project_id: "project-demo",
    organization_id: "org-demo",
    api_key: "secret-12345678",
  });
  assert.notEqual(first.secretsCipherText, "secret-12345678");
  assert.equal(decryptSecrets(first.secretsCipherText).api_key, "secret-12345678");
  const masked = serializeCredential({
    providerId: "openai",
    secretsCipherText: first.secretsCipherText,
    config: first.config,
  });
  assert.equal(masked.secretMetadata.api_key, "");
  assert.equal(masked.secretMetadata.api_key_preview, "***5678");
  const second = splitCredential(
    "openai",
    { project_id: "project-new", organization_id: "org-demo", api_key: "" },
    first.secretsCipherText,
  );
  assert.equal(decryptSecrets(second.secretsCipherText).api_key, "secret-12345678");
});

test("redaction é recursiva e remove padrões de autorização", () => {
  assert.deepEqual(redact({ nested: { access_token: "abc", normal: "ok" }, log: "Bearer super-secret" }), { nested: { access_token: "[REDIGIDO]", normal: "ok" }, log: "[REDIGIDO]" });
});

test("validação de rede bloqueia endereços internos e de metadata", () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "192.0.2.1", "198.51.100.1", "203.0.113.1", "::1", "fd00::1", "fe80::1", "ff02::1"]) assert.equal(isPublicIp(address), false, address);
  assert.equal(isPublicIp("1.1.1.1"), true);
  assert.equal(isPublicIp("2606:4700:4700::1111"), true);
});

test("OTP respeita tamanho e proibição de zero inicial", () => {
  for (let index = 0; index < 100; index++) { const code = generateOtp(6, false, false); assert.match(code, /^\d{6}$/); assert.notEqual(code[0], "0"); }
});

test("comparação constante valida apenas valores idênticos", () => {
  assert.equal(constantTimeEqual("sha256=abc", "sha256=abc"), true);
  assert.equal(constantTimeEqual("sha256=abc", "sha256=abd"), false);
  assert.equal(constantTimeEqual("short", "longer"), false);
});

test("payload de segredos usa formato versionado autenticado", () => {
  const cipher = encryptSecrets({ password: "strong-value" });
  assert.match(cipher || "", /^v1\./);
  assert.deepEqual(decryptSecrets(cipher), { password: "strong-value" });
});

test("redirect para outra origem não encaminha credenciais", () => {
  const headers = sanitizeRedirectHeaders({ Authorization: "Bearer secret", "X-API-Key": "secret", Cookie: "session=x", Accept: "application/json", "Content-Type": "application/json" }, true, true);
  assert.deepEqual(headers, { Accept: "application/json" });
  assert.equal(sanitizeRedirectHeaders({ Authorization: "Bearer secret" }, false, false).Authorization, "Bearer secret");
});
