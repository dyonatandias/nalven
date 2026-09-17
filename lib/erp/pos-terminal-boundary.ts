import { createHash } from "node:crypto";
import { parseBearerToken, PosAgentError, verifyAgentToken } from "@/lib/erp/pos-agent-auth";
import { POS_OBSERVABILITY_THRESHOLDS } from "@/lib/erp/pos-observability";

export const POS_TERMINAL_ID_HEADER = "x-pos-terminal-id";
export const POS_TERMINAL_ID_COOKIE = "nalven_pos_terminal_id";
export const POS_TERMINAL_CREDENTIAL_COOKIE = "nalven_pos_terminal_credential";

export class PosTerminalBoundaryError extends Error {
  constructor(message: string, readonly status = 403) {
    super(message);
    this.name = "PosTerminalBoundaryError";
  }
}

export type PosOperationalTerminalRecord = {
  id: string;
  registerId: number;
  status: string;
  tokenHash: string | null;
  tokenExpiresAt: Date | null;
  credentialVersion: number;
  appVersion: string | null;
  lastSeenAt: Date | null;
  pairedAt: Date | null;
  revokedAt: Date | null;
  register: { id: number; branchId: number; status: string; branch: { id: number; status: string } };
};

export type PosOperationalTerminalProof = {
  terminalId: string;
  registerId: number;
  branchId: number;
  tokenHash: string;
  credentialVersion: number;
  authenticatedAt: Date;
};

export const posOperationalTerminalSelect = {
  id: true,
  registerId: true,
  status: true,
  tokenHash: true,
  tokenExpiresAt: true,
  credentialVersion: true,
  appVersion: true,
  lastSeenAt: true,
  pairedAt: true,
  revokedAt: true,
  register: { select: { id: true, branchId: true, status: true, branch: { select: { id: true, status: true } } } },
} as const;

export function readPosOperationalTerminalCredential(headers: Headers) {
  const cookies = parseCookies(headers.get("cookie"));
  const terminalId = headers.get(POS_TERMINAL_ID_HEADER)?.trim() || cookies[POS_TERMINAL_ID_COOKIE] || "";
  if (!terminalId || terminalId.length > 160 || !/^[A-Za-z0-9_-]+$/.test(terminalId)) {
    throw new PosTerminalBoundaryError("Identidade criptográfica do terminal ausente ou inválida.", 401);
  }
  try {
    const authorization = headers.get("authorization") || (cookies[POS_TERMINAL_CREDENTIAL_COOKIE] ? `Bearer ${cookies[POS_TERMINAL_CREDENTIAL_COOKIE]}` : null);
    if (authorization?.startsWith("Bearer posoff_v1_")) return { terminalId, token: authorization.slice(7) };
    return { terminalId, token: parseBearerToken(authorization) };
  } catch (error) {
    if (error instanceof PosAgentError) throw new PosTerminalBoundaryError("Credencial criptográfica do terminal ausente ou inválida.", error.status);
    throw error;
  }
}

function parseCookies(header: string | null) {
  const values: Record<string, string> = {};
  for (const item of header?.split(";") || []) {
    const separator = item.indexOf("=");
    if (separator < 1) continue;
    const key = item.slice(0, separator).trim(), raw = item.slice(separator + 1).trim();
    try { values[key] = decodeURIComponent(raw); } catch { values[key] = raw; }
  }
  return values;
}

export function authenticatePosOperationalTerminal(
  record: PosOperationalTerminalRecord | null,
  input: { organizationId: string; terminalId: string; token: string; now?: Date; expectedBranchId?: number; expectedRegisterId?: number },
): PosOperationalTerminalProof {
  const now = input.now ?? new Date();
  if (!record || record.id !== input.terminalId || !verifyAgentToken(record.tokenHash, input.organizationId, input.terminalId, input.token)) {
    throw unauthorized();
  }
  assertOperationalState(record, now, input.expectedBranchId, input.expectedRegisterId);
  return {
    terminalId: record.id,
    registerId: record.registerId,
    branchId: record.register.branchId,
    tokenHash: record.tokenHash!,
    credentialVersion: record.credentialVersion,
    authenticatedAt: now,
  };
}

export function assertPosOperationalTerminalProof(
  record: PosOperationalTerminalRecord | null,
  proof: PosOperationalTerminalProof,
  input: { now?: Date; expectedBranchId?: number; expectedRegisterId?: number } = {},
) {
  const now = input.now ?? new Date();
  if (!record || record.id !== proof.terminalId || record.tokenHash !== proof.tokenHash || record.credentialVersion !== proof.credentialVersion) throw unauthorized();
  assertOperationalState(record, now, input.expectedBranchId ?? proof.branchId, input.expectedRegisterId ?? proof.registerId);
}

export function posTerminalBoundOpenRequestHash(input: { registerId: number; openingAmountCents: number; terminalId: string }) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function assertPosSessionTerminalBinding(
  session: { registerId: number | null; openingAmountCents: number; openRequestHash: string | null },
  proof: PosOperationalTerminalProof,
) {
  if (session.registerId == null || session.registerId !== proof.registerId) throw new PosTerminalBoundaryError("O terminal autenticado não pertence ao caixa deste turno.", 403);
  const expected = posTerminalBoundOpenRequestHash({ registerId: session.registerId, openingAmountCents: session.openingAmountCents, terminalId: proof.terminalId });
  if (session.openRequestHash !== expected) {
    throw new PosTerminalBoundaryError("O turno não possui vínculo autoritativo com este terminal. Operações financeiras foram bloqueadas.", 409);
  }
}

function assertOperationalState(record: PosOperationalTerminalRecord, now: Date, expectedBranchId?: number, expectedRegisterId?: number) {
  if (!record.pairedAt || record.revokedAt || record.status === "revoked" || record.status === "unpaired") throw unauthorized();
  if (!record.tokenExpiresAt || record.tokenExpiresAt <= now) throw unauthorized();
  if (record.register.id !== record.registerId || record.register.status !== "active" || record.register.branch.status !== "active") {
    throw new PosTerminalBoundaryError("O caixa ou a filial do terminal não está ativo.", 403);
  }
  if (expectedBranchId != null && record.register.branchId !== expectedBranchId) throw new PosTerminalBoundaryError("O terminal autenticado pertence a outra filial.", 403);
  if (expectedRegisterId != null && record.registerId !== expectedRegisterId) throw new PosTerminalBoundaryError("O terminal autenticado pertence a outro caixa.", 403);
  const maximumAge = POS_OBSERVABILITY_THRESHOLDS.terminalStaleMinutes * 60_000;
  if (record.status !== "online" || !record.lastSeenAt || now.valueOf() - record.lastSeenAt.valueOf() >= maximumAge) {
    throw new PosTerminalBoundaryError("O agente do terminal não está online ou perdeu o heartbeat. Operações financeiras foram bloqueadas.", 409);
  }
  if (!record.appVersion?.trim()) throw new PosTerminalBoundaryError("O agente do terminal não declarou versão operacional compatível.", 409);
}

function unauthorized() {
  return new PosTerminalBoundaryError("Credencial do terminal inválida, expirada, revogada ou trocada.", 401);
}
