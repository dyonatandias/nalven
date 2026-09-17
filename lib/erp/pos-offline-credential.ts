import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { agentPepper, PosAgentError } from "@/lib/erp/pos-agent-auth";

const TOKEN_PREFIX = "posoff_v1_";
const HASH_PREFIX = "hmac-sha256:v1:";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type PosOfflineCredentialToken = { id: string; token: string };

export function createPosOfflineCredentialToken(id = randomUUID()): PosOfflineCredentialToken {
  const credentialId = String(id).toLowerCase();
  if (!UUID_V4.test(credentialId)) throw new PosAgentError("Identificador da credencial offline inválido.", 500);
  return { id: credentialId, token: `${TOKEN_PREFIX}${credentialId}.${randomBytes(48).toString("base64url")}` };
}

export function parsePosOfflineBearerToken(header: string | null) {
  if (!header?.startsWith("Bearer ")) throw new PosAgentError("Credencial offline ausente.", 401);
  return parsePosOfflineToken(header.slice(7));
}

export function parsePosOfflineToken(token: string) {
  const match = token.match(/^posoff_v1_([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{64})$/);
  if (!match) throw new PosAgentError("Credencial offline inválida.", 401);
  return { id: match[1], token };
}

export function hashPosOfflineCredential(
  organizationId: string,
  terminalId: string,
  credentialId: string,
  token: string,
  pepper = agentPepper(),
) {
  const parsed = parsePosOfflineToken(token);
  if (parsed.id !== credentialId || !organizationId || organizationId.length > 160 || !terminalId || terminalId.length > 160) {
    throw new PosAgentError("Contexto da credencial offline inválido.", 401);
  }
  const values = ["offline-browser-token", organizationId, terminalId, credentialId, token];
  const framed = values.map(value => `${Buffer.byteLength(value, "utf8")}:${value}`).join("|");
  return `${HASH_PREFIX}${createHmac("sha256", pepper).update(framed, "utf8").digest("hex")}`;
}

export function verifyPosOfflineCredential(
  storedHash: string,
  organizationId: string,
  terminalId: string,
  credentialId: string,
  token: string,
  pepper = agentPepper(),
) {
  if (!storedHash.startsWith(HASH_PREFIX)) return false;
  let computed: string;
  try { computed = hashPosOfflineCredential(organizationId, terminalId, credentialId, token, pepper); } catch { return false; }
  const expected = Buffer.from(storedHash, "utf8"), actual = Buffer.from(computed, "utf8");
  return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
}

export function posOfflineCredentialTtlMinutes(value: unknown, env: Record<string, string | undefined> = process.env) {
  const configuredMaximum = configuredInteger(env.POS_OFFLINE_CREDENTIAL_MAX_MINUTES, 480, 15, 720, "POS_OFFLINE_CREDENTIAL_MAX_MINUTES");
  const requested = value == null ? Math.min(240, configuredMaximum) : Number(value);
  if (!Number.isSafeInteger(requested) || requested < 15 || requested > configuredMaximum) throw new PosAgentError(`Validade offline deve ficar entre 15 e ${configuredMaximum} minutos.`);
  return requested;
}

export function posOfflineCredentialRequestHash(input: { action: string; terminalId: string; userId: string; ttlMinutes?: number; credentialId?: string }) {
  return createHash("sha256").update(JSON.stringify({
    purpose: "pos.offline.credential",
    version: 1,
    action: input.action,
    terminalId: input.terminalId,
    userId: input.userId,
    ttlMinutes: input.ttlMinutes ?? null,
    credentialId: input.credentialId ?? null,
  })).digest("hex");
}

function configuredInteger(value: string | undefined, fallback: number, minimum: number, maximum: number, name: string) {
  if (value == null || value === "") return fallback;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new PosAgentError(`${name} possui configuração inválida.`, 500);
  return result;
}
