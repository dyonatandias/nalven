import { Prisma } from "@/generated/tenant/client";
import { currentOrganization, tenantDb } from "@/db";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import { assertSameOrigin, CustomerInputError } from "@/lib/erp/customer-input";
import { PosAgentError } from "@/lib/erp/pos-agent-auth";
import {
  createPosOfflineCredentialToken,
  hashPosOfflineCredential,
  posOfflineCredentialRequestHash,
  posOfflineCredentialTtlMinutes,
} from "@/lib/erp/pos-offline-credential";
import { assertPosMutationRequest, enforcePosRateLimit, PosHttpError, readPosJson } from "@/lib/erp/pos-http";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { POS_TERMINAL_CREDENTIAL_COOKIE, POS_TERMINAL_ID_COOKIE } from "@/lib/erp/pos-terminal-boundary";
import { assertTenantWriteAccess } from "@/lib/tenant-access";

type Db = Awaited<ReturnType<typeof tenantDb>>;
type Tx = Prisma.TransactionClient;
type Permission = Awaited<ReturnType<typeof assertTenantPermission>>;
type IssueInput = { action: "credential.issue"; terminalId: string; ttlMinutes: number; idempotencyKey: string };
type RevokeInput = { action: "credential.revoke"; terminalId: string; credentialId: string; idempotencyKey: string };
type HeartbeatInput = { action: "terminal.heartbeat"; terminalId: string };

export async function GET() {
  try {
    const organization = await currentOrganization();
    const permission = await assertTenantPermission(organization.id, "pdv.read");
    const db = await tenantDb(organization.id);
    const context = await userContext(db, permission);
    const terminals = await authorizedTerminals(db, context);
    const credentials = await db.posOfflineCredential.findMany({
      where: { userProfileId: context.profile.id, terminalId: { in: terminals.map(terminal => terminal.id) } },
      select: { id: true, terminalId: true, state: true, expiresAt: true, lastUsedAt: true, revokedAt: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: 30,
    });
    return Response.json({ organizationId: organization.id, terminals, credentials, serverTime: new Date() }, { headers: noStore() });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    assertPosMutationRequest(request);
    const organization = await currentOrganization();
    const permission = await assertTenantPermission(organization.id, "pdv.write");
    await assertTenantWriteAccess(organization.id);
    const db = await tenantDb(organization.id);
    const body = await readPosJson(request, 32_768);
    const action = String(body.action || "");
    await enforcePosRateLimit(db, permission.user.id, action);
    const context = await userContext(db, permission);
    if (action === "credential.issue") return issue(db, organization.id, context, issueInput(body));
    if (action === "credential.revoke") return revoke(db, context, revokeInput(body));
    if (action === "terminal.heartbeat") return heartbeat(db, context, heartbeatInput(body));
    throw new PosAgentError("Ação de credencial offline inválida.");
  } catch (error) {
    return failure(error);
  }
}

async function heartbeat(db: Db, context: UserContext, input: HeartbeatInput) {
  const result = await db.$transaction(async tx => {
    const terminal = await lockedAuthorizedTerminal(tx, context, input.terminalId);
    const credential = await tx.posOfflineCredential.findFirst({
      where: {
        terminalId: terminal.id,
        userProfileId: context.profile.id,
        userId: context.permission.user.id,
        state: "active",
        credentialVersion: terminal.credentialVersion,
        expiresAt: { gt: new Date() },
      },
      select: { expiresAt: true },
      orderBy: { expiresAt: "desc" },
    });
    return { terminal, credentialExpiresAt: credential?.expiresAt ?? null };
  }, {
    isolationLevel: "Serializable",
    maxWait: 10_000,
    timeout: 20_000,
  });
  const { terminal, credentialExpiresAt } = result;
  const settings = terminal.settings && typeof terminal.settings === "object" && !Array.isArray(terminal.settings)
    ? terminal.settings as Record<string, unknown>
    : {};
  if (settings.terminalKind !== "browser") throw new PosAgentError("Este terminal exige heartbeat do agente local.", 409);
  return Response.json({ accepted: true, serverTime: new Date(), credentialExpiresAt, terminal: { id: terminal.id, status: terminal.status, lastSeenAt: terminal.lastSeenAt } }, { headers: noStore() });
}

async function issue(db: Db, organizationId: string, context: Awaited<ReturnType<typeof userContext>>, input: IssueInput) {
  const requestHash = posOfflineCredentialRequestHash({ ...input, userId: context.permission.user.id });
  const existing = await db.posOfflineCredential.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (existing) return replayIssue(existing, context, input, requestHash);
  const generated = createPosOfflineCredentialToken();
  try {
    const result = await db.$transaction(async tx => {
      const terminal = await lockedAuthorizedTerminal(tx, context, input.terminalId);
      const now = new Date(), expiresAt = new Date(now.valueOf() + input.ttlMinutes * 60_000);
      await tx.posOfflineCredential.updateMany({
        where: { terminalId: terminal.id, userProfileId: context.profile.id, state: "active" },
        data: { state: "revoked", revokedAt: now },
      });
      const credential = await tx.posOfflineCredential.create({ data: {
        id: generated.id,
        terminalId: terminal.id,
        userProfileId: context.profile.id,
        userId: context.permission.user.id,
        tokenHash: hashPosOfflineCredential(organizationId, terminal.id, generated.id, generated.token),
        credentialVersion: terminal.credentialVersion,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        expiresAt,
      } });
      const activeWindow = await tx.posOfflineCredential.aggregate({ where: { terminalId: terminal.id, state: "active", expiresAt: { gt: now } }, _max: { expiresAt: true } });
      await tx.posTerminal.update({ where: { id: terminal.id }, data: { offlineAllowedUntil: activeWindow._max.expiresAt } });
      await tx.tenantAuditEvent.create({ data: {
        actorId: context.permission.user.id,
        action: "pos.offline.credential.issued",
        entityType: "pos_offline_credential",
        entityId: credential.id,
        afterData: json({ terminalId: terminal.id, userProfileId: context.profile.id, credentialVersion: terminal.credentialVersion, expiresAt }),
      } });
      return publicCredential(credential);
    }, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 20_000 });
    return Response.json({ credential: result, token: generated.token, tokenType: "Bearer", replayed: false }, { headers: browserCredentialHeaders(input.terminalId, generated.token, input.ttlMinutes) });
  } catch (error) {
    if (["P2002", "P2034"].includes(prismaCode(error))) {
      const concurrent = await db.posOfflineCredential.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (concurrent) return replayIssue(concurrent, context, input, requestHash);
    }
    throw error;
  }
}

async function revoke(db: Db, context: Awaited<ReturnType<typeof userContext>>, input: RevokeInput) {
  const requestHash = posOfflineCredentialRequestHash({ ...input, userId: context.permission.user.id });
  const result = await db.$transaction(async tx => {
    await lockedAuthorizedTerminal(tx, context, input.terminalId);
    const credential = await tx.posOfflineCredential.findFirst({ where: { id: input.credentialId, terminalId: input.terminalId, userProfileId: context.profile.id } });
    if (!credential) throw new PosAgentError("Credencial offline não encontrada.", 404);
    if (credential.state !== "active") {
      if (credential.revocationKey !== input.idempotencyKey || credential.revocationRequestHash !== requestHash) throw new PosAgentError("A credencial já foi revogada por outro contexto.", 409);
      return { credential: publicCredential(credential), replayed: true };
    }
    const revokedAt = new Date();
    const changed = await tx.posOfflineCredential.updateMany({ where: { id: credential.id, state: "active" }, data: { state: "revoked", revokedAt, revocationKey: input.idempotencyKey, revocationRequestHash: requestHash } });
    if (changed.count !== 1) throw new PosAgentError("Credencial offline mudou durante a revogação; repita a consulta.", 409);
    const revoked = await tx.posOfflineCredential.findUniqueOrThrow({ where: { id: credential.id } });
    const remaining = await tx.posOfflineCredential.aggregate({ where: { terminalId: input.terminalId, state: "active", expiresAt: { gt: revokedAt } }, _max: { expiresAt: true } });
    await tx.posTerminal.update({ where: { id: input.terminalId }, data: { offlineAllowedUntil: remaining._max.expiresAt } });
    await tx.tenantAuditEvent.create({ data: {
      actorId: context.permission.user.id,
      action: "pos.offline.credential.revoked",
      entityType: "pos_offline_credential",
      entityId: credential.id,
      afterData: json({ terminalId: input.terminalId, userProfileId: context.profile.id, revokedAt }),
    } });
    return { credential: publicCredential(revoked), replayed: false };
  }, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 20_000 });
  const headers = new Headers({ ...noStore(), ...(result.replayed ? { "idempotency-replayed": "true" } : {}) });
  clearBrowserCredential(headers);
  return Response.json(result, { headers });
}

type UserContext = Awaited<ReturnType<typeof userContext>>;

async function userContext(db: Db, permission: Permission) {
  const profile = await db.tenantUserProfile.findUnique({ where: { userId: permission.user.id }, include: { activeBranch: { select: { id: true, status: true } } } });
  if (!profile || profile.status !== "active") throw new PosAgentError("Perfil operacional ativo não configurado.", 403);
  const branchId = profile.activeBranch?.status === "active" ? profile.activeBranch.id : (await db.branch.findFirst({ where: { status: "active" }, orderBy: [{ primary: "desc" }, { id: "asc" }], select: { id: true } }))?.id;
  if (!branchId) throw new PosAgentError("Filial ativa não configurada.", 409);
  const privileged = ["owner", "admin"].includes(permission.membership.role);
  if (!privileged && !await db.branchUserAccess.findFirst({ where: { branchId, userProfileId: profile.id, canSell: true }, select: { id: true } })) throw new PosAgentError("Seu usuário não está autorizado a vender nesta filial.", 403);
  return { permission, profile, branchId, privileged };
}

async function authorizedTerminals(db: Db, context: UserContext) {
  const now = new Date();
  return db.posTerminal.findMany({
    where: {
      status: { notIn: ["unpaired", "revoked"] },
      register: {
        branchId: context.branchId,
        status: "active",
        ...(!context.privileged ? { accesses: { some: activeRegisterAccess(context.profile.id, now) } } : {}),
      },
    },
    select: { id: true, code: true, name: true, status: true, registerId: true, credentialVersion: true, offlineAllowedUntil: true },
    orderBy: [{ registerId: "asc" }, { name: "asc" }],
  });
}

async function lockedAuthorizedTerminal(tx: Tx, context: UserContext, terminalId: string) {
  const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "pos_terminals" WHERE "id" = ${terminalId} FOR UPDATE`);
  if (locked.length !== 1) throw new PosAgentError("Terminal não encontrado.", 404);
  const now = new Date();
  const terminal = await tx.posTerminal.findFirst({ where: {
    id: terminalId,
    status: { notIn: ["unpaired", "revoked"] },
    register: {
      branchId: context.branchId,
      status: "active",
      branch: { status: "active" },
      ...(!context.privileged ? { accesses: { some: activeRegisterAccess(context.profile.id, now) } } : {}),
    },
  } });
  const liveProfile = await tx.tenantUserProfile.findFirst({ where: { id: context.profile.id, userId: context.permission.user.id, status: "active" }, select: { id: true } });
  const liveBranchAccess = context.privileged || Boolean(await tx.branchUserAccess.findFirst({ where: { branchId: context.branchId, userProfileId: context.profile.id, canSell: true }, select: { id: true } }));
  if (!terminal || !liveProfile || !liveBranchAccess) throw new PosAgentError("Acesso offline ao terminal não está mais vigente.", 403);
  const settings = terminal.settings && typeof terminal.settings === "object" && !Array.isArray(terminal.settings)
    ? terminal.settings as Record<string, unknown>
    : {};
  if (settings.terminalKind !== "browser") return terminal;
  return tx.posTerminal.update({
    where: { id: terminal.id },
    data: { status: "online", lastSeenAt: now, appVersion: "web-pdv/1" },
  });
}

function activeRegisterAccess(userProfileId: number, now: Date) {
  return {
    userProfileId,
    active: true,
    canSell: true,
    AND: [
      { OR: [{ validFrom: null }, { validFrom: { lte: now } }] },
      { OR: [{ validUntil: null }, { validUntil: { gte: now } }] },
    ],
  };
}

function issueInput(body: Record<string, unknown>): IssueInput {
  onlyKeys(body, ["action", "terminalId", "ttlMinutes", "idempotencyKey"]);
  const terminalId = text(body.terminalId, 160, "Terminal"), idempotencyKey = text(body.idempotencyKey, 160, "Chave idempotente");
  if (idempotencyKey.length < 16 || !/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)) throw new PosAgentError("Chave idempotente inválida.");
  return { action: "credential.issue", terminalId, ttlMinutes: posOfflineCredentialTtlMinutes(body.ttlMinutes), idempotencyKey };
}

function revokeInput(body: Record<string, unknown>): RevokeInput {
  onlyKeys(body, ["action", "terminalId", "credentialId", "idempotencyKey"]);
  const credentialId = text(body.credentialId, 36, "Credencial").toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(credentialId)) throw new PosAgentError("Credencial inválida.");
  const idempotencyKey = text(body.idempotencyKey, 160, "Chave idempotente");
  if (idempotencyKey.length < 16 || !/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)) throw new PosAgentError("Chave idempotente inválida.");
  return { action: "credential.revoke", terminalId: text(body.terminalId, 160, "Terminal"), credentialId, idempotencyKey };
}

function heartbeatInput(body: Record<string, unknown>): HeartbeatInput {
  onlyKeys(body, ["action", "terminalId"]);
  return { action: "terminal.heartbeat", terminalId: text(body.terminalId, 160, "Terminal") };
}

function replayIssue(record: { terminalId: string; userId: string; requestHash: string; state: string; expiresAt: Date; id: string; lastUsedAt: Date | null; revokedAt: Date | null; createdAt: Date }, context: UserContext, input: IssueInput, requestHash: string) {
  if (record.terminalId !== input.terminalId || record.userId !== context.permission.user.id || record.requestHash !== requestHash) throw new PosAgentError("A chave idempotente já foi usada com outro contexto.", 409);
  return Response.json({ credential: publicCredential(record), replayed: true, secretAvailable: false }, { headers: { ...noStore(), "idempotency-replayed": "true" } });
}

function publicCredential(value: { id: string; terminalId: string; state: string; expiresAt: Date; lastUsedAt: Date | null; revokedAt: Date | null; createdAt: Date }) {
  return { id: value.id, terminalId: value.terminalId, state: value.state, expiresAt: value.expiresAt, lastUsedAt: value.lastUsedAt, revokedAt: value.revokedAt, createdAt: value.createdAt };
}
function noStore() { return { "cache-control": "no-store", pragma: "no-cache" }; }
function browserCredentialHeaders(terminalId: string, token: string, ttlMinutes: number) {
  const headers = new Headers(noStore());
  const attributes = `Max-Age=${ttlMinutes * 60}; Path=/; HttpOnly; Secure; SameSite=Strict`;
  headers.append("set-cookie", `${POS_TERMINAL_ID_COOKIE}=${encodeURIComponent(terminalId)}; ${attributes}`);
  headers.append("set-cookie", `${POS_TERMINAL_CREDENTIAL_COOKIE}=${encodeURIComponent(token)}; ${attributes}`);
  return headers;
}
function clearBrowserCredential(headers: Headers) {
  const attributes = "Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict";
  headers.append("set-cookie", `${POS_TERMINAL_ID_COOKIE}=; ${attributes}`);
  headers.append("set-cookie", `${POS_TERMINAL_CREDENTIAL_COOKIE}=; ${attributes}`);
}
function onlyKeys(body: Record<string, unknown>, allowed: string[]) { const extra = Object.keys(body).find(key => !allowed.includes(key)); if (extra) throw new PosAgentError(`Campo não permitido: ${extra}.`); }
function text(value: unknown, maximum: number, label: string) { const result = String(value ?? "").trim(); if (!result || result.length > maximum) throw new PosAgentError(`${label} inválido.`); return result; }
function json(value: Record<string, unknown>) { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject; }
function prismaCode(error: unknown) { return error && typeof error === "object" && "code" in error ? String(error.code) : ""; }
function failure(error: unknown) {
  if (error instanceof PosHttpError || error instanceof PosAgentError) return errorResponse(error.message, error.status);
  if (error instanceof CustomerInputError) return errorResponse(error.message, error.message.includes("Origem") ? 403 : 422);
  if (error instanceof LicenseDeniedError) return errorResponse(error.message, error.status);
  if (error instanceof AuthError) { const response = authErrorResponse(error); response.headers.set("cache-control", "no-store"); response.headers.set("pragma", "no-cache"); return response; }
  if (["P2002", "P2034"].includes(prismaCode(error))) return errorResponse("Conflito concorrente na credencial offline.", 409);
  console.error("POS offline credential operation failed", { error: error instanceof Error ? error.name : typeof error });
  return errorResponse("Não foi possível gerir a credencial offline.", 500);
}
function errorResponse(message: string, status: number) { return Response.json({ error: message }, { status, headers: noStore() }); }
