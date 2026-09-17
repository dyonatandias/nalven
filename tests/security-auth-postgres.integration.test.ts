import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";

const url = process.env.NALVEN_SECURITY_TEST_DATABASE_URL;

test("recuperação concorrente: um vencedor, sessões revogadas e token inutilizado", { skip: !url }, async () => {
  const parsed = new URL(url!);
  assert.equal(parsed.hostname, "127.0.0.1");
  assert.equal(parsed.pathname, "/nalven_security_test", "Use exclusivamente o banco descartável de segurança.");
  process.env.CONTROL_DATABASE_URL = url;
  const { controlDb } = await import("../db/control");
  const { POST } = await import("../app/api/auth/reset-password/route");
  const { resetTokenHash, createPasswordReset } = await import("../lib/auth-recovery");
  const { hashPassword, verifyPassword } = await import("../lib/password");
  const email = `security-${randomUUID()}@example.test`;
  const user = await controlDb.user.create({ data: { name: "Security test", email, passwordHash: await hashPassword("OriginalPassword123!") } });
  const token = randomBytes(32).toString("base64url");
  const request = (value: string, password: string) => new Request("https://nalven.com.br/api/auth/reset-password", {
    method: "POST", headers: { "content-type": "application/json", origin: "https://nalven.com.br", "x-real-ip": randomUUID() }, body: JSON.stringify({ token: value, password }),
  });
  try {
    await controlDb.passwordResetToken.create({ data: { userId: user.id, tokenHash: resetTokenHash(token), expiresAt: new Date(Date.now() + 60000) } });
    await controlDb.session.create({ data: { userId: user.id, tokenHash: randomUUID(), expiresAt: new Date(Date.now() + 60000) } });
    const passwords = ["FirstPassword123!", "SecondPassword123!"];
    const responses = await Promise.all(passwords.map(password => POST(request(token, password))));
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 400]);
    const winner = responses.findIndex(response => response.status === 200);
    const saved = await controlDb.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.equal(await verifyPassword(passwords[winner], saved.passwordHash), true);
    assert.equal(await controlDb.session.count({ where: { userId: user.id } }), 0);
    assert.equal(await controlDb.auditLog.count({ where: { userId: user.id, action: "auth.password_reset" } }), 1);
    assert.equal((await POST(request(token, "ReplayPassword123!"))).status, 400);

    await Promise.all([createPasswordReset(user, null), createPasswordReset(user, null)]);
    assert.equal(await controlDb.passwordResetToken.count({ where: { userId: user.id, usedAt: null } }), 1);
    const latest = await controlDb.passwordResetToken.findFirstOrThrow({ where: { userId: user.id, usedAt: null } });
    await controlDb.passwordResetToken.update({ where: { id: latest.id }, data: { expiresAt: new Date(0) } });
    const expiredToken = randomBytes(32).toString("base64url");
    await controlDb.passwordResetToken.create({ data: { userId: user.id, tokenHash: resetTokenHash(expiredToken), expiresAt: new Date(0) } });
    assert.equal((await POST(request(expiredToken, "ExpiredPassword123!"))).status, 400);
    const inactiveToken = randomBytes(32).toString("base64url");
    await controlDb.passwordResetToken.create({ data: { userId: user.id, tokenHash: resetTokenHash(inactiveToken), expiresAt: new Date(Date.now() + 60000) } });
    await controlDb.user.update({ where: { id: user.id }, data: { status: "suspended" } });
    assert.equal((await POST(request(inactiveToken, "InactivePassword123!"))).status, 400);
  } finally {
    await controlDb.auditLog.deleteMany({ where: { userId: user.id } });
    await controlDb.emailOutbox.deleteMany({ where: { recipient: email } });
    await controlDb.user.delete({ where: { id: user.id } });
    await controlDb.$disconnect();
  }
});

test("billing: HMAC inválido é rejeitado e troca de ID não permite replay", { skip: !url }, async () => {
  const parsed = new URL(url!);
  assert.equal(parsed.hostname, "127.0.0.1");
  assert.equal(parsed.pathname, "/nalven_security_test");
  process.env.CONTROL_DATABASE_URL = url;
  process.env.NALVEN_SECRETS_MASTER_KEY = randomBytes(32).toString("hex");
  const { controlDb } = await import("../db/control");
  const { POST } = await import("../app/api/webhooks/billing/route");
  const { setVaultSecret, VAULT_KEYS } = await import("../lib/vault");
  const { createHmac } = await import("node:crypto");
  const secret = randomBytes(32).toString("hex");
  const externalId = `security-${randomUUID()}`;
  const body = JSON.stringify({ event: "fatura.paga", instance_id: externalId, ocorrido_em: new Date().toISOString() });
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const request = (signatureValue = signature) => new Request("https://nalven.com.br/api/webhooks/billing", {
    method: "POST", headers: { "content-type": "application/json", "x-billing-signature": signatureValue, "x-webhook-id": randomUUID(), "x-real-ip": randomUUID() }, body,
  });
  try {
    await setVaultSecret(VAULT_KEYS.billingWebhook, secret, "security-test");
    assert.equal((await POST(request("sha256=" + "0".repeat(64)))).status, 401);
    const responses = await Promise.all([POST(request()), POST(request())]);
    assert.deepEqual(responses.map(response => response.status), [200, 200]);
    assert.equal(await controlDb.billingWebhookEvent.count({ where: { externalId } }), 1);
    assert.equal((await POST(request())).status, 200);
    assert.equal(await controlDb.billingWebhookEvent.count({ where: { externalId } }), 1);
  } finally {
    await controlDb.billingWebhookEvent.deleteMany({ where: { externalId } });
    await controlDb.vaultSecret.delete({ where: { key: VAULT_KEYS.billingWebhook } });
    await controlDb.$disconnect();
  }
});
