import type { PrismaClient } from "@/generated/tenant/client";
import { decryptSecrets, encryptSecrets, IntegrationError, objectValue } from "./core";
import { safeRequest } from "./security";

export async function refreshOAuthToken(db: PrismaClient, credentialId: string) {
  const lockKey = `integration_oauth_refresh:${credentialId}`;
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL lock_timeout = '40s'`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
    const credential = await tx.integrationCredential.findUnique({ where: { id: credentialId } });
    if (!credential) throw new IntegrationError("Credencial OAuth não encontrada.", 404);
    if (credential.revokedAt || (credential.expiresAt && credential.expiresAt <= new Date()))
      throw new IntegrationError("Credencial OAuth revogada ou expirada.", 422);
    const config = objectValue(credential.config), secrets = decryptSecrets(credential.secretsCipherText), expiry = new Date(String(config.token_expires_at || 0));
    if (expiry.getTime() > Date.now() + 60000 && secrets.access_token) return secrets.access_token;
    if (!config.token_url || !config.client_id || !secrets.client_secret || !secrets.refresh_token) throw new IntegrationError("Credencial OAuth não pode ser renovada: configuração incompleta.", 422);
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: secrets.refresh_token, client_id: String(config.client_id), client_secret: secrets.client_secret }).toString();
    const response = await safeRequest(String(config.token_url), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body, timeoutMs: 10000 });
    if (response.status < 200 || response.status >= 300) throw new IntegrationError("O provedor recusou a renovação OAuth.", 502);
    const token = objectValue(JSON.parse(response.body)), accessToken = String(token.access_token || ""), refreshToken = String(token.refresh_token || secrets.refresh_token);
    if (!accessToken) throw new IntegrationError("Resposta de renovação sem access token.", 502);
    await tx.integrationCredential.update({ where: { id: credentialId }, data: { secretsCipherText: encryptSecrets({ ...secrets, access_token: accessToken, refresh_token: refreshToken }), config: { ...config, token_expires_at: token.expires_in ? new Date(Date.now() + Number(token.expires_in) * 1000).toISOString() : null }, lastRotatedAt: refreshToken !== secrets.refresh_token ? new Date() : credential.lastRotatedAt, revision: { increment: 1 } } });
    return accessToken;
  }, { maxWait: 40000, timeout: 55000 });
}
