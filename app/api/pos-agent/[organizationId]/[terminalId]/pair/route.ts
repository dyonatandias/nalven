import type { Prisma } from "@/generated/tenant/client";
import { tenantDb } from "@/db";
import { createAgentToken, hashAgentToken, hashPairingCode, normalizePairingCode, PosAgentError } from "@/lib/erp/pos-agent-auth";
import { assertPosMutationRequest, PosHttpError, readPosJson } from "@/lib/erp/pos-http";
import { contactHash, IntegrationError, persistentRateLimit } from "@/lib/integrations/core";

type Context = { params: Promise<{ organizationId: string; terminalId: string }> };

export async function POST(request: Request, route: Context) {
  try {
    assertPosMutationRequest(request);
    const { organizationId, terminalId } = await route.params;
    if (!organizationId || organizationId.length > 160 || !terminalId || terminalId.length > 160) throw unauthorized();
    const db = await agentDb(organizationId), ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    await persistentRateLimit(db, `pos-agent:pair:${terminalId}:${contactHash(ip)}`, 20, 600);
    const body = await readPosJson(request, 16_384);
    onlyKeys(body, ["action", "pairingCode", "certificateFingerprint"]);
    if (body.action !== "pair.exchange") throw new PosAgentError("Ação de pareamento inválida.");
    const code = normalizePairingCode(body.pairingCode), codeHash = hashPairingCode(organizationId, terminalId, code), fingerprint = certificateFingerprint(body.certificateFingerprint);
    const pairing = await db.pdvTerminalPairing.findFirst({ where: { terminalId, codeHash }, include: { terminal: { include: { register: { include: { branch: { select: { id: true, status: true } } } } } } } });
    const now = new Date();
    if (!pairing || pairing.state !== "pending" || pairing.attempts >= pairing.maxAttempts) throw unauthorized();
    if (pairing.expiresAt <= now) {
      await db.pdvTerminalPairing.updateMany({ where: { id: pairing.id, state: "pending" }, data: { state: "expired" } });
      throw unauthorized();
    }
    if (pairing.terminal.status !== "unpaired" || pairing.terminal.register.status !== "active" || pairing.terminal.register.branch.status !== "active") throw unauthorized();
    const token = createAgentToken(), issuedAt = new Date(), expiresAt = new Date(issuedAt.valueOf() + 90 * 86400000);
    const result = await db.$transaction(async tx => {
      const consumed = await tx.pdvTerminalPairing.updateMany({ where: { id: pairing.id, terminalId, state: "pending", consumedAt: null, expiresAt: { gt: issuedAt } }, data: { state: "consumed", consumedAt: issuedAt, attempts: { increment: 1 } } });
      if (consumed.count !== 1) throw unauthorized();
      const terminal = await tx.posTerminal.update({ where: { id: terminalId }, data: { status: "paired", tokenHash: hashAgentToken(organizationId, terminalId, token), tokenIssuedAt: issuedAt, tokenExpiresAt: expiresAt, credentialVersion: { increment: 1 }, certificateFingerprint: fingerprint, pairedAt: issuedAt, revokedAt: null, lastSeenAt: issuedAt } });
      await tx.tenantAuditEvent.create({ data: { action: "pos.terminal.paired", entityType: "pos_terminal", entityId: terminal.id, correlationId: pairing.correlationId, afterData: json({ registerId: terminal.registerId, credentialVersion: terminal.credentialVersion, tokenExpiresAt: expiresAt, certificateConfigured: Boolean(fingerprint), pairingId: pairing.id }) } });
      return { terminal: { id: terminal.id, code: terminal.code, name: terminal.name, registerId: terminal.registerId, status: terminal.status, credentialVersion: terminal.credentialVersion }, branchId: pairing.terminal.register.branch.id };
    }, { isolationLevel: "Serializable" });
    return Response.json({ ...result, organizationId, token, tokenType: "Bearer", issuedAt, expiresAt }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return failure(error);
  }
}

async function agentDb(organizationId: string) { try { return await tenantDb(organizationId); } catch { throw unauthorized(); } }
function certificateFingerprint(value: unknown) { if (value == null || value === "") return null; const result = String(value).replaceAll(":", "").toLowerCase(); if (!/^[0-9a-f]{64}$/.test(result)) throw new PosAgentError("Fingerprint de certificado inválido."); return result; }
function onlyKeys(value: Record<string, unknown>, allowed: string[]) { const extra = Object.keys(value).find(field => !allowed.includes(field)); if (extra) throw new PosAgentError(`Campo não permitido: ${extra}.`); }
function unauthorized() { return new PosAgentError("Pareamento inválido ou expirado.", 401); }
function json(value: Record<string, unknown>) { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject; }
function failure(error: unknown) {
  if (error instanceof IntegrationError || error instanceof PosHttpError || error instanceof PosAgentError) return Response.json({ error: error.message }, { status: error.status });
  if ((error as { code?: string })?.code === "P2034") return Response.json({ error: "Conflito no pareamento; tente novamente." }, { status: 409 });
  console.error("POS agent pairing failed", { error: error instanceof Error ? error.name : typeof error });
  return Response.json({ error: "Não foi possível parear o terminal." }, { status: 500 });
}
