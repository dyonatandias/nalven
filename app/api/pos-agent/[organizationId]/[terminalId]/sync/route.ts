import { Prisma, type PrismaClient } from "@/generated/tenant/client";
import { tenantDb } from "@/db";
import { parseBearerToken, PosAgentError, verifyAgentToken } from "@/lib/erp/pos-agent-auth";
import { parsePosOfflineBearerToken, verifyPosOfflineCredential } from "@/lib/erp/pos-offline-credential";
import { assertPosMutationRequest, PosHttpError, readPosJson } from "@/lib/erp/pos-http";
import {
  finalizePosOfflineOperation,
  hashPosOfflineSnapshot,
  normalizePosOfflineAck,
  normalizePosOfflinePull,
  normalizePosOfflineSyncBatch,
  planPosOfflineDraftMutation,
  PosOfflineSyncError,
  replayPosOfflineOperation,
  type PosOfflineSyncOperation,
} from "@/lib/erp/pos-offline-sync";
import { contactHash, IntegrationError, persistentRateLimit } from "@/lib/integrations/core";

type Context = { params: Promise<{ organizationId: string; terminalId: string }> };
type Db = PrismaClient;
type AgentContext = Awaited<ReturnType<typeof authenticate>>;
type SyncResult = ReturnType<typeof replayPosOfflineOperation>;

class PosSyncConcurrentError extends Error {}

export async function POST(request: Request, route: Context) {
  try {
    assertPosMutationRequest(request);
    const { organizationId, terminalId } = await route.params;
    if (!organizationId || organizationId.length > 160 || !terminalId || terminalId.length > 160) throw unauthorized();
    const db = await agentDb(organizationId);
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    await persistentRateLimit(db, `pos-agent:sync-auth:${terminalId}:${contactHash(ip)}`, 90, 60);
    const context = await authenticate(db, organizationId, terminalId, request.headers.get("authorization"));
    const body = await readPosJson(request, 262_144);
    const action = String(body.action || "");
    await persistentRateLimit(db, `pos-agent:${terminalId}:${action}`, action === "sync.pull" ? 120 : 30, 60);
    if (action === "sync.pull") return pull(context, normalizePosOfflinePull(body));
    if (action === "sync.ack") return acknowledge(context, normalizePosOfflineAck(body));
    const operations = normalizePosOfflineSyncBatch(body, { organizationId, terminalId }, { now: context.now });
    let outcome: { operations: SyncResult[]; cursor: bigint };
    try {
      outcome = await applySyncBatch(context, operations);
    } catch (error) {
      if (!(error instanceof PosSyncConcurrentError) && !new Set(["P2002", "P2034"]).has(prismaCode(error))) throw error;
      const concurrent = await replaySyncBatch(context, operations);
      if (!concurrent) throw new PosOfflineSyncError("Conflito concorrente na sequência offline; reenvie o lote.", 409);
      outcome = concurrent;
    }
    const replayed = outcome.operations.every(operation => operation.replayed);
    return Response.json({ accepted: true, terminalId, cursor: outcome.cursor.toString(), operations: outcome.operations, replayed }, {
      headers: { "cache-control": "no-store", ...(replayed ? { "idempotency-replayed": "true" } : {}) },
    });
  } catch (error) {
    return failure(error);
  }
}

async function applySyncBatch(context: AgentContext, operations: PosOfflineSyncOperation[]) {
  return context.db.$transaction(async tx => {
    await lockTerminal(tx, context.terminal.id);
    await assertLiveCredential(tx, context);
    const terminal = await tx.posTerminal.findUniqueOrThrow({ where: { id: context.terminal.id }, select: { lastSyncCursor: true } });
    let cursor = terminal.lastSyncCursor;
    const results: SyncResult[] = [];
    for (const operation of operations) {
      const existing = await tx.posSyncOperation.findUnique({ where: { terminalId_operationId: { terminalId: context.terminal.id, operationId: operation.operationId } } });
      if (existing) {
        if (existing.sequence > cursor) throw new PosOfflineSyncError("Cursor offline inconsistente com a operação persistida.", 409);
        results.push(replayPosOfflineOperation(existing, operation, context.terminal.id));
        continue;
      }
      const sequenceOwner = await tx.posSyncOperation.findUnique({ where: { terminalId_sequence: { terminalId: context.terminal.id, sequence: operation.sequence } }, select: { operationId: true } });
      if (sequenceOwner) throw new PosOfflineSyncError("A sequência offline já pertence a outro operationId.", 409);
      const expected = cursor + BigInt(1);
      if (operation.sequence !== expected) throw new PosOfflineSyncError(`Sequência offline inválida; esperado ${expected}.`, 409);
      const created = await tx.posSyncOperation.create({ data: {
        terminalId: context.terminal.id,
        operationId: operation.operationId,
        sequence: operation.sequence,
        type: operation.type,
        state: "received",
        requestHash: operation.requestHash,
        payload: json(operation.payload),
        occurredAt: operation.occurredAt,
      } });
      await tx.posSyncOperation.update({ where: { id: created.id }, data: { state: "processing" } });
      let final: { state: "applied" | "rejected" | "conflict"; response?: Record<string, unknown>; conflict?: Record<string, unknown> };
      if (operation.type === "cart.draft.upsert" || operation.type === "cart.draft.discard") {
        const current = await tx.posOfflineDraft.findUnique({ where: { terminalId_draftId: { terminalId: context.terminal.id, draftId: String(operation.payload.draftId) } } });
        const planned = planPosOfflineDraftMutation(operation, current);
        final = planned;
        if (planned.projection) await tx.posOfflineDraft.upsert({
          where: { terminalId_draftId: { terminalId: context.terminal.id, draftId: planned.projection.draftId } },
          create: { terminalId: context.terminal.id, ...planned.projection, payload: json(planned.projection.payload), lastOperationId: operation.operationId },
          update: { revision: planned.projection.revision, state: planned.projection.state, payload: json(planned.projection.payload), lastOperationId: operation.operationId },
        });
      } else {
        final = finalizePosOfflineOperation(operation);
      }
      if (operation.type === "terminal.heartbeat" && final.state === "applied") await tx.posTerminal.update({ where: { id: context.terminal.id }, data: { appVersion: String(operation.payload.appVersion) } });
      const completed = await tx.posSyncOperation.update({
        where: { id: created.id },
        data: { state: final.state, ...(final.response ? { response: json(final.response) } : {}), ...(final.conflict ? { conflict: json(final.conflict) } : {}), processedAt: new Date() },
      });
      await tx.tenantAuditEvent.create({ data: {
        action: final.state === "applied" ? "pos.sync.applied" : final.state === "conflict" ? "pos.sync.conflict" : "pos.sync.rejected",
        entityType: "pos_sync_operation",
        entityId: String(created.id),
        afterData: { terminalId: context.terminal.id, operationId: operation.operationId, sequence: operation.sequence.toString(), type: operation.type, state: final.state, requestHash: operation.requestHash },
      } });
      cursor = operation.sequence;
      results.push({ ...replayPosOfflineOperation(completed, operation, context.terminal.id), replayed: false });
    }
    const changed = await tx.posTerminal.updateMany({ where: liveTerminalWhere(context), data: { lastSyncCursor: cursor, status: "online", lastSeenAt: new Date() } });
    if (changed.count !== 1) throw new PosSyncConcurrentError();
    await touchOfflineCredential(tx, context);
    return { operations: results, cursor };
  }, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 });
}

async function replaySyncBatch(context: AgentContext, operations: PosOfflineSyncOperation[]) {
  return context.db.$transaction(async tx => {
    await lockTerminal(tx, context.terminal.id);
    await assertLiveCredential(tx, context);
    const [records, terminal] = await Promise.all([
      tx.posSyncOperation.findMany({ where: { terminalId: context.terminal.id, operationId: { in: operations.map(operation => operation.operationId) } } }),
      tx.posTerminal.findUniqueOrThrow({ where: { id: context.terminal.id }, select: { lastSyncCursor: true } }),
    ]);
    if (records.length !== operations.length) return null;
    const byOperation = new Map(records.map(record => [record.operationId, record]));
    await touchOfflineCredential(tx, context);
    return { operations: operations.map(operation => replayPosOfflineOperation(byOperation.get(operation.operationId)!, operation, context.terminal.id)), cursor: terminal.lastSyncCursor };
  }, { isolationLevel: "Serializable" });
}

async function pull(context: AgentContext, input: ReturnType<typeof normalizePosOfflinePull>) {
  assertBrowserCredential(context);
  const result = await context.db.$transaction(async tx => {
    await lockTerminal(tx, context.terminal.id);
    await assertLiveCredential(tx, context);
    const terminal = await tx.posTerminal.findUniqueOrThrow({ where: { id: context.terminal.id }, select: { lastSyncCursor: true, lastSyncAckCursor: true } });
    if (input.afterSequence > terminal.lastSyncCursor) throw new PosOfflineSyncError("Cursor de pull está à frente do servidor.", 409);
    const records = await tx.posSyncOperation.findMany({
      where: { terminalId: context.terminal.id, sequence: { gt: input.afterSequence }, state: { in: ["applied", "rejected", "conflict"] } },
      select: { operationId: true, sequence: true, type: true, state: true, response: true, conflict: true, processedAt: true }, orderBy: { sequence: "asc" }, take: 101,
    });
    const [catalog, permissions, drafts] = await Promise.all([
      catalogSnapshot(context, tx), permissionSnapshot(context, tx),
      tx.posOfflineDraft.findMany({ where: { terminalId: context.terminal.id }, select: { draftId: true, revision: true, state: true, payload: true, updatedAt: true }, orderBy: { updatedAt: "desc" }, take: 250 }),
    ]);
    await touchOfflineCredential(tx, context);
    return { terminal, records, catalog, permissions, drafts };
  }, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 });
  const hasMore = result.records.length > 100, operations = result.records.slice(0, 100);
  const catalogVersion = hashPosOfflineSnapshot("catalog", result.catalog), permissionVersion = hashPosOfflineSnapshot("permissions", result.permissions);
  return Response.json({
    accepted: true, terminalId: context.terminal.id, cursor: result.terminal.lastSyncCursor.toString(), acknowledgedCursor: result.terminal.lastSyncAckCursor.toString(),
    nextCursor: (operations.at(-1)?.sequence ?? input.afterSequence).toString(), hasMore,
    operations: operations.map(record => ({ ...record, sequence: record.sequence.toString() })),
    catalog: input.catalogVersion === catalogVersion ? null : { version: catalogVersion, data: result.catalog },
    permissions: input.permissionVersion === permissionVersion ? null : { version: permissionVersion, data: result.permissions }, drafts: result.drafts, serverTime: new Date(),
  }, { headers: { "cache-control": "no-store" } });
}

async function acknowledge(context: AgentContext, input: ReturnType<typeof normalizePosOfflineAck>) {
  assertBrowserCredential(context);
  const result = await context.db.$transaction(async tx => {
    await lockTerminal(tx, context.terminal.id);
    await assertLiveCredential(tx, context);
    const terminal = await tx.posTerminal.findUniqueOrThrow({ where: { id: context.terminal.id }, select: { lastSyncCursor: true, lastSyncAckCursor: true } });
    if (input.throughSequence > terminal.lastSyncCursor) throw new PosOfflineSyncError("ACK está à frente do cursor do servidor.", 409);
    if (input.throughSequence <= terminal.lastSyncAckCursor) { await touchOfflineCredential(tx, context); return { cursor: terminal.lastSyncAckCursor, replayed: true }; }
    const boundary = await tx.posSyncOperation.findUnique({ where: { terminalId_sequence: { terminalId: context.terminal.id, sequence: input.throughSequence } }, select: { state: true } });
    if (!boundary || !["applied", "rejected", "conflict"].includes(boundary.state)) throw new PosOfflineSyncError("ACK não aponta para uma operação finalizada.", 409);
    const changed = await tx.posTerminal.updateMany({ where: { ...liveTerminalWhere(context), lastSyncAckCursor: terminal.lastSyncAckCursor, lastSyncCursor: { gte: input.throughSequence } }, data: { lastSyncAckCursor: input.throughSequence, lastSeenAt: new Date() } });
    if (changed.count !== 1) throw new PosSyncConcurrentError();
    await touchOfflineCredential(tx, context);
    await tx.tenantAuditEvent.create({ data: { actorId: context.offlineCredential?.userId, action: "pos.sync.acknowledged", entityType: "pos_terminal", entityId: context.terminal.id, afterData: { previousCursor: terminal.lastSyncAckCursor.toString(), acknowledgedCursor: input.throughSequence.toString() } } });
    return { cursor: input.throughSequence, replayed: false };
  }, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 20_000 });
  return Response.json({ accepted: true, terminalId: context.terminal.id, acknowledgedCursor: result.cursor.toString(), replayed: result.replayed }, { headers: { "cache-control": "no-store", ...(result.replayed ? { "idempotency-replayed": "true" } : {}) } });
}

async function catalogSnapshot(context: AgentContext, db: Prisma.TransactionClient) {
  const branchId = context.terminal.register.branch.id;
  const products = await db.product.findMany({
    where: { active: true, branchConfigurations: { some: { branchId, active: true, saleEnabled: true } } },
    select: {
      id: true, name: true, sku: true, barcode: true, gtin: true, unit: true, soldIndividually: true, price: true, salePrice: true, saleStartsAt: true, saleEndsAt: true, updatedAt: true,
      branchConfigurations: { where: { branchId }, select: { priceOverride: true } },
      variations: { where: { enabled: true }, select: { id: true, sku: true, gtin: true, attributes: true, regularPrice: true, salePrice: true, saleStartsAt: true, saleEndsAt: true, updatedAt: true } },
      posCodes: { where: { active: true, OR: [{ branchId }, { branchId: null }] }, select: { code: true, normalizedCode: true, symbology: true, packageQuantity: true, variationId: true, branchId: true, priority: true } },
    }, orderBy: { id: "asc" }, take: 2_001,
  });
  if (products.length > 2_000) throw new PosOfflineSyncError("Catálogo offline excede o limite seguro de 2.000 produtos.", 409);
  return products.map(product => {
    const configuration = product.branchConfigurations[0], now = Date.now();
    const promotional = product.salePrice != null && (!product.saleStartsAt || product.saleStartsAt.valueOf() <= now) && (!product.saleEndsAt || product.saleEndsAt.valueOf() >= now);
    return {
      id: product.id, name: product.name, sku: product.sku, barcode: product.barcode, gtin: product.gtin, unit: product.unit, soldIndividually: product.soldIndividually,
      referencePriceCents: Math.round((configuration?.priceOverride ?? (promotional ? product.salePrice! : product.price)) * 100), updatedAt: product.updatedAt,
      variations: product.variations.map(variation => ({ id: variation.id, sku: variation.sku, gtin: variation.gtin, attributes: variation.attributes, referenceRegularPriceCents: variation.regularPrice == null ? null : Math.round(variation.regularPrice * 100), referenceSalePriceCents: variation.salePrice == null ? null : Math.round(variation.salePrice * 100), saleStartsAt: variation.saleStartsAt, saleEndsAt: variation.saleEndsAt, updatedAt: variation.updatedAt })),
      codes: product.posCodes.map(code => ({ code: code.code, normalizedCode: code.normalizedCode, symbology: code.symbology, packageQuantityMicros: String(Math.round(code.packageQuantity * 1_000_000)), variationId: code.variationId, branchId: code.branchId, priority: code.priority })),
    };
  });
}

async function permissionSnapshot(context: AgentContext, db: Prisma.TransactionClient) {
  assertBrowserCredential(context);
  const credential = context.offlineCredential!, now = new Date();
  const access = await db.posRegisterAccess.findFirst({ where: { registerId: context.terminal.registerId, userProfileId: credential.userProfileId, ...activeAccess(now) }, select: { canSell: true, maxDiscountBasisPoints: true, validFrom: true, validUntil: true } });
  if (!access && !credential.privileged) throw unauthorized();
  return {
    userProfileId: credential.userProfileId,
    terminal: { id: context.terminal.id, registerId: context.terminal.registerId, branchId: context.terminal.register.branch.id }, credentialExpiresAt: credential.expiresAt,
    allowedOfflineOperations: ["terminal.heartbeat", "cart.draft.upsert", "cart.draft.discard"], capabilities: { draft: true, saleCommit: false, payment: false, cash: false, fiscal: false },
    access: { canPrepareDraft: credential.privileged || Boolean(access?.canSell), maxDiscountBasisPoints: credential.privileged ? 10_000 : access?.maxDiscountBasisPoints ?? 0, validFrom: access?.validFrom ?? null, validUntil: access?.validUntil ?? null },
  };
}

async function authenticate(db: Db, organizationId: string, terminalId: string, authorization: string | null) {
  const terminal = await db.posTerminal.findFirst({ where: { id: terminalId }, include: { register: { include: { branch: { select: { id: true, status: true } } } } } });
  const now = new Date();
  if (!terminal || ["unpaired", "revoked"].includes(terminal.status) || terminal.register.status !== "active" || terminal.register.branch.status !== "active") throw unauthorized();
  if (authorization?.startsWith("Bearer posoff_v1_")) {
    const parsed = parsePosOfflineBearerToken(authorization);
    const credential = await db.posOfflineCredential.findUnique({ where: { id: parsed.id }, include: { userProfile: true } });
    if (!credential || credential.terminalId !== terminalId || credential.state !== "active" || credential.expiresAt <= now || credential.credentialVersion !== terminal.credentialVersion || credential.userProfile.status !== "active" || credential.userId !== credential.userProfile.userId || !verifyPosOfflineCredential(credential.tokenHash, organizationId, terminalId, credential.id, parsed.token)) throw unauthorized();
    const privileged = await isPrivilegedProfile(db, credential.userProfile.roleId);
    if (!privileged) {
      const [branchAccess, registerAccess] = await Promise.all([
        db.branchUserAccess.findFirst({ where: { branchId: terminal.register.branch.id, userProfileId: credential.userProfileId, canSell: true }, select: { id: true } }),
        db.posRegisterAccess.findFirst({ where: { registerId: terminal.registerId, userProfileId: credential.userProfileId, ...activeAccess(now) }, select: { id: true } }),
      ]);
      if (!branchAccess || !registerAccess) throw unauthorized();
    }
    return { db, organizationId, terminal, now, offlineCredential: { ...credential, privileged }, authKind: "offline" as const };
  }
  const token = parseBearerToken(authorization);
  if (!verifyAgentToken(terminal.tokenHash, organizationId, terminalId, token) || !terminal.tokenExpiresAt || terminal.tokenExpiresAt <= now) throw unauthorized();
  return { db, organizationId, terminal, now, offlineCredential: null, authKind: "agent" as const };
}

function liveTerminalWhere(context: AgentContext): Prisma.PosTerminalWhereInput {
  const shared: Prisma.PosTerminalWhereInput = { id: context.terminal.id, credentialVersion: context.terminal.credentialVersion, status: { notIn: ["unpaired", "revoked"] }, register: { status: "active", branch: { status: "active" } } };
  return context.authKind === "agent" ? { ...shared, tokenHash: context.terminal.tokenHash, tokenExpiresAt: { gt: new Date() } } : shared;
}

function liveOfflineCredentialWhere(context: AgentContext): Prisma.PosOfflineCredentialWhereInput {
  const credential = context.offlineCredential;
  if (!credential) return { id: "__agent_has_no_offline_credential__" };
  return {
    id: credential.id, terminalId: context.terminal.id, userProfileId: credential.userProfileId, userId: credential.userId, tokenHash: credential.tokenHash,
    credentialVersion: context.terminal.credentialVersion, state: "active", expiresAt: { gt: new Date() },
    userProfile: { status: "active", ...(!credential.privileged ? {
      branchAccesses: { some: { branchId: context.terminal.register.branch.id, canSell: true } },
      posRegisterAccesses: { some: { registerId: context.terminal.registerId, ...activeAccess(new Date()) } },
    } : {}) }, terminal: liveTerminalWhere(context),
  };
}

async function assertLiveCredential(tx: Prisma.TransactionClient, context: AgentContext) {
  if (!await tx.posTerminal.findFirst({ where: liveTerminalWhere(context), select: { id: true } })) throw unauthorized();
  if (context.authKind === "offline" && !await tx.posOfflineCredential.findFirst({ where: liveOfflineCredentialWhere(context), select: { id: true } })) throw unauthorized();
}

async function touchOfflineCredential(tx: Prisma.TransactionClient, context: AgentContext) {
  if (context.authKind === "offline") {
    const changed = await tx.posOfflineCredential.updateMany({ where: liveOfflineCredentialWhere(context), data: { lastUsedAt: new Date() } });
    if (changed.count !== 1) throw unauthorized();
  }
}

function activeAccess(now: Date) { return { active: true, canSell: true, AND: [{ OR: [{ validFrom: null }, { validFrom: { lte: now } }] }, { OR: [{ validUntil: null }, { validUntil: { gte: now } }] }] }; }
async function isPrivilegedProfile(db: Db, roleId: number) { const role = await db.tenantRole.findUnique({ where: { id: roleId }, select: { key: true, active: true } }); return Boolean(role?.active && ["owner", "admin"].includes(role.key)); }
function assertBrowserCredential(context: AgentContext) { if (context.authKind !== "offline") throw new PosOfflineSyncError("Pull e ACK exigem credencial offline curta vinculada ao operador.", 403); }
async function lockTerminal(tx: Prisma.TransactionClient, terminalId: string) { const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "pos_terminals" WHERE "id" = ${terminalId} FOR UPDATE`); if (locked.length !== 1) throw unauthorized(); }
async function agentDb(organizationId: string) { try { return await tenantDb(organizationId); } catch { throw unauthorized(); } }
function unauthorized() { return new PosAgentError("Credencial offline ou do agente inválida, expirada ou revogada.", 401); }
function prismaCode(error: unknown) { return error && typeof error === "object" && "code" in error ? String(error.code) : ""; }
function json(value: Record<string, unknown>) { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject; }

function failure(error: unknown) {
  if (error instanceof IntegrationError || error instanceof PosHttpError || error instanceof PosAgentError || error instanceof PosOfflineSyncError) return syncError(error.message, error.status);
  if (new Set(["P2002", "P2034"]).has(prismaCode(error))) return syncError("Conflito concorrente na sincronização offline; tente novamente.", 409);
  console.error("POS offline synchronization failed", { error: error instanceof Error ? error.name : typeof error });
  return syncError("Não foi possível sincronizar as operações offline.", 500);
}
function syncError(message: string, status: number) { return Response.json({ error: message }, { status, headers: { "cache-control": "no-store", pragma: "no-cache" } }); }
