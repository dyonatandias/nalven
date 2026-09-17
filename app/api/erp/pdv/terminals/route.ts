import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@/generated/tenant/client";
import { currentOrganization, tenantDb } from "@/db";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import { assertSameOrigin, CustomerInputError } from "@/lib/erp/customer-input";
import { createAgentToken, createPairingCode, hashAgentToken, hashPairingCode, PosAgentError } from "@/lib/erp/pos-agent-auth";
import { assertPosMutationRequest, enforcePosRateLimit, PosHttpError, readPosJson } from "@/lib/erp/pos-http";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { assertTenantWriteAccess } from "@/lib/tenant-access";

type Db = Awaited<ReturnType<typeof tenantDb>>;
type Tx = Prisma.TransactionClient;
type Action = "terminal.pairing.issue" | "terminal.token.rotate" | "terminal.revoke";
type AdminInput = { action: Action; terminalId: string; idempotencyKey: string; confirm: true };

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    assertPosMutationRequest(request);
    const organization = await currentOrganization();
    const actor = await assertTenantPermission(organization.id, "pdv.write");
    if (!["owner", "admin"].includes(actor.membership.role)) throw new PosAgentError("Somente proprietários e administradores podem gerir credenciais de terminais.", 403);
    await assertTenantWriteAccess(organization.id);
    const db = await tenantDb(organization.id), input = adminInput(await readPosJson(request, 32_768));
    await enforcePosRateLimit(db, actor.user.id, `admin:${input.action}`);
    return execute(db, organization.id, actor.user.id, input);
  } catch (error) {
    return failure(error);
  }
}

async function execute(db: Db, organizationId: string, actorId: string, input: AdminInput) {
  const requestHash = createHash("sha256").update(JSON.stringify({ action: input.action, terminalId: input.terminalId, confirm: true })).digest("hex");
  const existing = await db.pdvAdminMutation.findUnique({ where: { key: input.idempotencyKey } });
  if (existing) return replay(existing, actorId, input, requestHash);
  const correlationId = randomUUID(), pairingCode = input.action === "terminal.pairing.issue" ? createPairingCode() : null, agentToken = input.action === "terminal.token.rotate" ? createAgentToken() : null;
  try {
    const result = await db.$transaction(async tx => {
      await tx.pdvAdminMutation.create({ data: { key: input.idempotencyKey, actorId, action: input.action, requestHash, expiresAt: new Date(Date.now() + 30 * 86400000) } });
      const terminal = await scopedTerminal(tx, input.terminalId);
      let publicBody: Prisma.InputJsonObject;
      if (input.action === "terminal.pairing.issue") {
        if (!pairingCode) throw new PosAgentError("Código de pareamento indisponível.", 500);
        if (!["unpaired", "revoked"].includes(terminal.status)) throw new PosAgentError("Revogue o terminal antes de emitir um novo pareamento.", 409);
        const expiresAt = new Date(Date.now() + 10 * 60_000), normalized = pairingCode.replaceAll("-", "");
        await tx.pdvTerminalPairing.updateMany({ where: { terminalId: terminal.id, state: "pending" }, data: { state: "revoked", revokedAt: new Date() } });
        const pairing = await tx.pdvTerminalPairing.create({ data: { terminalId: terminal.id, codeHash: hashPairingCode(organizationId, terminal.id, pairingCode), codeLastFour: normalized.slice(-4), idempotencyKey: input.idempotencyKey, requestHash, correlationId, createdBy: actorId, expiresAt } });
        await tx.posTerminal.update({ where: { id: terminal.id }, data: { status: "unpaired", tokenHash: null, tokenIssuedAt: null, tokenExpiresAt: null, certificateFingerprint: null, offlineAllowedUntil: null, pairedAt: null, revokedAt: null } });
        publicBody = json({ terminal: terminalPublic(terminal, "unpaired"), pairing: { id: pairing.id, codeLastFour: pairing.codeLastFour, expiresAt, revealed: false }, correlationId, replayed: false });
      } else if (input.action === "terminal.token.rotate") {
        if (!agentToken) throw new PosAgentError("Credencial do agente indisponível.", 500);
        if (["unpaired", "revoked"].includes(terminal.status)) throw new PosAgentError("O terminal precisa estar pareado e não revogado para rotacionar a credencial.", 409);
        const issuedAt = new Date(), expiresAt = new Date(issuedAt.valueOf() + 90 * 86400000);
        const updated = await tx.posTerminal.update({ where: { id: terminal.id }, data: { tokenHash: hashAgentToken(organizationId, terminal.id, agentToken), tokenIssuedAt: issuedAt, tokenExpiresAt: expiresAt, credentialVersion: { increment: 1 }, status: "paired" } });
        publicBody = json({ terminal: terminalPublic(updated), credential: { issuedAt, expiresAt, version: updated.credentialVersion, revealed: false }, correlationId, replayed: false });
      } else {
        await tx.pdvTerminalPairing.updateMany({ where: { terminalId: terminal.id, state: "pending" }, data: { state: "revoked", revokedAt: new Date() } });
        await tx.posDevice.updateMany({ where: { terminalId: terminal.id }, data: { status: "disabled" } });
        const updated = await tx.posTerminal.update({ where: { id: terminal.id }, data: { status: "revoked", tokenHash: null, tokenIssuedAt: null, tokenExpiresAt: null, certificateFingerprint: null, offlineAllowedUntil: null, revokedAt: terminal.revokedAt || new Date() } });
        publicBody = json({ terminal: terminalPublic(updated), correlationId, replayed: false });
      }
      await tx.tenantAuditEvent.create({ data: { actorId, action: `pos.admin.${input.action}`, entityType: "pos_terminal", entityId: terminal.id, correlationId, beforeData: json({ terminal: terminalPublic(terminal) }), afterData: publicBody } });
      await tx.pdvAdminMutation.update({ where: { key: input.idempotencyKey }, data: { state: "completed", entityType: "pos_terminal", entityId: terminal.id, responseStatus: 200, responseBody: publicBody } });
      return publicBody;
    }, { isolationLevel: "Serializable" });
    return Response.json({ ...result, ...(pairingCode ? { pairingCode } : {}), ...(agentToken ? { agentToken, tokenType: "Bearer" } : {}), replayed: false }, { headers: { "cache-control": "no-store", pragma: "no-cache" } });
  } catch (error) {
    if (["P2002", "P2034"].includes(prismaCode(error))) {
      const concurrent = await db.pdvAdminMutation.findUnique({ where: { key: input.idempotencyKey } });
      if (concurrent) return replay(concurrent, actorId, input, requestHash);
    }
    throw error;
  }
}

function replay(record: { actorId: string; action: string; requestHash: string; state: string; responseBody: Prisma.JsonValue | null }, actorId: string, input: AdminInput, requestHash: string) {
  if (record.actorId !== actorId || record.action !== input.action || record.requestHash !== requestHash) throw new PosAgentError("A chave idempotente já foi usada com outro contexto.", 409);
  if (record.state !== "completed" || !record.responseBody || typeof record.responseBody !== "object" || Array.isArray(record.responseBody)) throw new PosAgentError("A operação ainda está em processamento.", 409);
  return Response.json({ ...(record.responseBody as Record<string, unknown>), replayed: true, secretAvailable: false }, { headers: { "idempotency-replayed": "true", "cache-control": "no-store", pragma: "no-cache" } });
}

async function scopedTerminal(tx: Tx, id: string) {
  const terminal = await tx.posTerminal.findFirst({ where: { id, register: { branch: { status: "active" } } }, include: { register: { select: { id: true, branchId: true, status: true } } } });
  if (!terminal) throw new PosAgentError("Terminal não encontrado.", 404);
  return terminal;
}

function adminInput(body: Record<string, unknown>): AdminInput {
  const allowed = new Set(["action", "terminalId", "idempotencyKey", "confirm"]), extra = Object.keys(body).find(field => !allowed.has(field));
  if (extra) throw new PosAgentError(`Campo não permitido: ${extra}.`);
  const action = String(body.action || "") as Action;
  if (!new Set<Action>(["terminal.pairing.issue", "terminal.token.rotate", "terminal.revoke"]).has(action)) throw new PosAgentError("Ação de terminal inválida.");
  const terminalId = text(body.terminalId, 100, "Terminal"), idempotencyKey = text(body.idempotencyKey, 160, "Chave idempotente");
  if (idempotencyKey.length < 16 || !/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)) throw new PosAgentError("Chave idempotente inválida.");
  if (body.confirm !== true) throw new PosAgentError("Confirme explicitamente a operação de credencial.");
  return { action, terminalId, idempotencyKey, confirm: true };
}

function terminalPublic(value: { id: string; registerId: number; code: string; name: string; status: string; credentialVersion: number; pairedAt: Date | null; revokedAt: Date | null }, status = value.status) { return { id: value.id, registerId: value.registerId, code: value.code, name: value.name, status, credentialVersion: value.credentialVersion, pairedAt: value.pairedAt, revokedAt: value.revokedAt }; }
function text(value: unknown, maximum: number, label: string) { const result = String(value ?? "").trim(); if (!result || result.length > maximum) throw new PosAgentError(`${label} inválido.`); return result; }
function json(value: Record<string, unknown>) { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject; }
function prismaCode(error: unknown) { return error && typeof error === "object" && "code" in error ? String(error.code) : ""; }
function failure(error: unknown) {
  if (error instanceof PosHttpError || error instanceof PosAgentError) return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof CustomerInputError) return Response.json({ error: error.message }, { status: error.message.includes("Origem") ? 403 : 422 });
  if (error instanceof LicenseDeniedError) return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof AuthError) return authErrorResponse(error);
  if (["P2002", "P2034"].includes(prismaCode(error))) return Response.json({ error: "Conflito concorrente na credencial do terminal." }, { status: 409 });
  console.error("POS terminal credential operation failed", { error: error instanceof Error ? error.name : typeof error });
  return Response.json({ error: "Não foi possível concluir a operação do terminal." }, { status: 500 });
}
