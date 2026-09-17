import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { userInfo } from "node:os";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/control/client";
import { setVaultSecret } from "../lib/vault";
import { decryptSecret } from "../lib/secrets";

test("cofre participa da transação Prisma real sem gravar segredo em texto", async () => {
  const socket = process.env.CONTROL_AUDIT_SOCKET;
  assert.match(socket || "", /^\/tmp\/nalven-control-audit\.[A-Za-z0-9]+$/);
  const db = new PrismaClient({ adapter: new PrismaPg({ host: socket, port: 55442, user: userInfo().username, database: "control_migration_audit" }) });
  const previousMaster = process.env.NALVEN_SECRETS_MASTER_KEY;
  process.env.NALVEN_SECRETS_MASTER_KEY = randomBytes(32).toString("hex");
  const secret = `skp_nalven_${randomBytes(32).toString("hex")}`;
  const key = "test.transaction.secret";
  try {
    await db.user.create({ data: { id: "vault-test-user", name: "Teste", email: "vault@example.invalid", passwordHash: "not-a-login-hash" } });
    await assert.rejects(db.$transaction(async tx => {
      await tx.systemSetting.create({ data: { key: "vault-test-setting", value: { changed: true } } });
      await setVaultSecret(key, secret, "billing", "vault-test-user", tx);
      throw new Error("rollback-test");
    }), /rollback-test/);
    assert.equal(await db.systemSetting.findUnique({ where: { key: "vault-test-setting" } }), null);
    assert.equal(await db.vaultSecret.findUnique({ where: { key } }), null);
    const metadata = await db.$transaction(async tx => {
      await tx.systemSetting.create({ data: { key: "vault-test-setting", value: { changed: true } } });
      const result = await setVaultSecret(key, secret, "billing", "vault-test-user", tx);
      await tx.auditLog.create({ data: { userId: "vault-test-user", action: "test.vault_saved", entityType: "billing" } });
      return result;
    });
    const stored = await db.vaultSecret.findUniqueOrThrow({ where: { key } });
    assert.equal(decryptSecret(stored.cipherText), secret);
    assert.ok(!JSON.stringify(stored).includes(secret));
    assert.ok(!JSON.stringify(metadata).includes(secret));
    assert.equal(await db.auditLog.count({ where: { action: "test.vault_saved" } }), 1);
  } finally {
    if (previousMaster === undefined) delete process.env.NALVEN_SECRETS_MASTER_KEY;
    else process.env.NALVEN_SECRETS_MASTER_KEY = previousMaster;
    await db.$disconnect();
  }
});
