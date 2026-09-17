import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export class PosAgentError extends Error {
  constructor(message: string, public readonly status = 422) {
    super(message);
    this.name = "PosAgentError";
  }
}

const HASH_PREFIX = "hmac-sha256:v1:";
const TOKEN_PREFIX = "posagt_v1_";

export function createPairingCode() {
  return randomBytes(16).toString("hex").toUpperCase().match(/.{1,8}/g)!.join("-");
}

export function normalizePairingCode(value: unknown) {
  const code = String(value ?? "").trim().replaceAll("-", "").toUpperCase();
  if (!/^[0-9A-F]{32}$/.test(code)) throw new PosAgentError("Código de pareamento inválido.", 401);
  return code;
}

export function createAgentToken() {
  return `${TOKEN_PREFIX}${randomBytes(48).toString("base64url")}`;
}

export function parseBearerToken(header: string | null) {
  if (!header?.startsWith("Bearer ")) throw new PosAgentError("Credencial do agente ausente.", 401);
  const token = header.slice(7);
  if (!new RegExp(`^${TOKEN_PREFIX}[A-Za-z0-9_-]{64}$`).test(token)) throw new PosAgentError("Credencial do agente inválida.", 401);
  return token;
}

export function hashPairingCode(organizationId: string, terminalId: string, code: string, pepper = agentPepper()) {
  return contextualHash("pairing-code", organizationId, terminalId, normalizePairingCode(code), pepper);
}

export function hashAgentToken(organizationId: string, terminalId: string, token: string, pepper = agentPepper()) {
  if (!new RegExp(`^${TOKEN_PREFIX}[A-Za-z0-9_-]{64}$`).test(token)) throw new PosAgentError("Credencial do agente inválida.", 401);
  return contextualHash("agent-token", organizationId, terminalId, token, pepper);
}

export function verifyAgentToken(storedHash: string | null, organizationId: string, terminalId: string, token: string, pepper = agentPepper()) {
  if (!storedHash?.startsWith(HASH_PREFIX)) return false;
  let computed: string;
  try { computed = hashAgentToken(organizationId, terminalId, token, pepper); } catch { return false; }
  const expected = Buffer.from(storedHash, "utf8"), actual = Buffer.from(computed, "utf8");
  return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
}

export function pairingRequestHash(terminalId: string) {
  return createHash("sha256").update(JSON.stringify({ action: "terminal.pairing.issue", terminalId })).digest("hex");
}

export function agentPepper() {
  const value = process.env.POS_AGENT_TOKEN_PEPPER || "";
  if (Buffer.byteLength(value, "utf8") < 32) throw new PosAgentError("POS_AGENT_TOKEN_PEPPER deve possuir ao menos 32 bytes.", 503);
  return value;
}

function contextualHash(purpose: string, organizationId: string, terminalId: string, secret: string, pepper: string) {
  if (!organizationId || organizationId.length > 160 || !terminalId || terminalId.length > 160) throw new PosAgentError("Contexto da credencial inválido.", 401);
  if (Buffer.byteLength(pepper, "utf8") < 32) throw new PosAgentError("Segredo criptográfico do agente inválido.", 503);
  const framed = [purpose, organizationId, terminalId, secret].map(value => `${Buffer.byteLength(value, "utf8")}:${value}`).join("|");
  return `${HASH_PREFIX}${createHmac("sha256", pepper).update(framed, "utf8").digest("hex")}`;
}
