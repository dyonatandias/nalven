import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@/generated/tenant/client";
import { currentOrganization, tenantDb } from "@/db";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import { assertSameOrigin, CustomerInputError } from "@/lib/erp/customer-input";
import { PosDomainError } from "@/lib/erp/pos-domain";
import { assertPosMutationRequest, enforcePosRateLimit, PosHttpError, readPosJson } from "@/lib/erp/pos-http";
import { assertTenantPermission } from "@/lib/erp/permissions";
import {
  assertPosHandoffPending,
  assertPosSessionTransition,
  hashPosSessionLifecycleInput,
  parsePosSessionLifecycleInput,
  PosSessionLifecycleError,
  posSessionHandoffExpiresAt,
  type PosSessionLifecycleInput,
} from "@/lib/erp/pos-session-lifecycle";
import { assertPosSessionTerminalBinding, authenticatePosOperationalTerminal, posOperationalTerminalSelect, PosTerminalBoundaryError, readPosOperationalTerminalCredential } from "@/lib/erp/pos-terminal-boundary";
import { preparePosManualHandoffTransition, preparePosManualSessionTransition } from "@/lib/erp/pos-manual-operational-prelock";
import { assertTenantWriteAccess } from "@/lib/tenant-access";

type Db = Awaited<ReturnType<typeof tenantDb>>;
type Permission = Awaited<ReturnType<typeof assertTenantPermission>>;
type Context = Awaited<ReturnType<typeof lifecycleContext>>;

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].length) throw new PosSessionLifecycleError("A consulta do ciclo do turno não aceita parâmetros.");
    const organization = await currentOrganization();
    const permission = await assertTenantPermission(organization.id, "pdv.read");
    const db = await tenantDb(organization.id);
    const context = await lifecycleContext(db, permission);
    const now = new Date();
    const [session, incoming] = await Promise.all([
      db.cashRegisterSession.findFirst({
        where: { operatorProfileId: context.profile.id, status: { in: ["open", "suspended", "closing"] }, register: { branchId: context.branchId } },
        include: {
          register: { select: { id: true, code: true, name: true } },
          handoffs: { where: { state: "requested", expiresAt: { gt: now } }, select: handoffSelect, take: 1 },
        },
        orderBy: { openedAt: "desc" },
      }),
      db.posSessionHandoff.findMany({
        where: { branchId: context.branchId, toOperatorProfileId: context.profile.id, state: "requested", expiresAt: { gt: now }, session: { status: "suspended" } },
        select: { ...handoffSelect, session: { select: { id: true, number: true, version: true, status: true } }, register: { select: { id: true, code: true, name: true } }, fromOperatorProfile: { select: { id: true, displayName: true } } },
        orderBy: { createdAt: "asc" },
        take: 20,
      }),
    ]);
    const targets = session?.registerId ? await db.tenantUserProfile.findMany({
      where: {
        id: { not: context.profile.id }, status: "active",
        branchAccesses: { some: { branchId: context.branchId, canSell: true } },
        posRegisterAccesses: { some: { registerId: session.registerId, active: true, canOpen: true, canSell: true, AND: [{ OR: [{ validFrom: null }, { validFrom: { lte: now } }] }, { OR: [{ validUntil: null }, { validUntil: { gte: now } }] }] } },
      },
      select: { id: true, displayName: true }, orderBy: [{ displayName: "asc" }, { id: "asc" }], take: 100,
    }) : [];
    return Response.json({ session: jsonSafe(session), incoming: jsonSafe(incoming), targets }, { headers: { "cache-control": "no-store" } });
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
    const db = await tenantDb(organization.id);
    const input = parsePosSessionLifecycleInput(await readPosJson(request, 32_768));
    await enforcePosRateLimit(db, permission.user.id, input.action);
    const context = await lifecycleContext(db, permission);
    const credential = readPosOperationalTerminalCredential(request.headers);
    const terminal = await db.posTerminal.findUnique({ where: { id: credential.terminalId }, select: posOperationalTerminalSelect });
    const terminalProof = authenticatePosOperationalTerminal(terminal, { organizationId: organization.id, ...credential, expectedBranchId: context.branchId });
    const boundSession = await db.cashRegisterSession.findFirst({
      where: { id: input.sessionId, register: { branchId: context.branchId } },
      select: { registerId: true, openingAmountCents: true, openRequestHash: true },
    });
    if (!boundSession) throw new PosTerminalBoundaryError("O turno vinculado ao terminal não foi encontrado.", 404);
    assertPosSessionTerminalBinding(boundSession, terminalProof);
    await assertTenantWriteAccess(organization.id);
    if (input.action === "session.suspend") return suspendSession(db, permission, context, input);
    if (input.action === "session.resume") return resumeSession(db, permission, context, input);
    if (input.action === "session.handoff.request") return requestHandoff(db, permission, context, input);
    if (input.action === "session.handoff.accept") return acceptHandoff(db, permission, context, input);
    return cancelHandoff(db, permission, context, input);
  } catch (error) {
    return failure(error);
  }
}

async function lifecycleContext(db: Db, permission: Permission) {
  const profile = await db.tenantUserProfile.findUnique({
    where: { userId: permission.user.id },
    select: { id: true, displayName: true, status: true, activeBranch: { select: { id: true, status: true } } },
  });
  if (!profile || profile.status !== "active") throw new PosSessionLifecycleError("Perfil operacional ativo não configurado.", 403);
  const branch = profile.activeBranch?.status === "active"
    ? profile.activeBranch
    : await db.branch.findFirst({ where: { status: "active" }, select: { id: true }, orderBy: [{ primary: "desc" }, { id: "asc" }] });
  if (!branch) throw new PosSessionLifecycleError("Cadastre uma filial ativa antes de operar o turno.", 409);
  const privileged = permission.membership.role === "owner" || permission.membership.role === "admin";
  if (!privileged) {
    const branchAccess = await db.branchUserAccess.findUnique({ where: { branchId_userProfileId: { branchId: branch.id, userProfileId: profile.id } }, select: { canSell: true } });
    if (!branchAccess?.canSell) throw new PosSessionLifecycleError("Seu usuário não está autorizado a operar caixas nesta filial.", 403);
  }
  return { branchId: branch.id, profile, privileged };
}

async function suspendSession(db: Db, permission: Permission, context: Context, input: Extract<PosSessionLifecycleInput, { action: "session.suspend" }>) {
  const hash = hashPosSessionLifecycleInput(input);
  const replay = await replaySessionEvent(db, context, input.sessionId, input.idempotencyKey, hash, "session_suspended");
  if (replay) return Response.json(replay);
  const correlationId = randomUUID();
  const session = await db.$transaction(async (tx) => {
    const current = await ownedSession(tx, context, input.sessionId, "open");
    await preparePosManualSessionTransition(tx, { action: "suspend", sessionId: current.id, expectedVersion: input.expectedVersion, actorProfileId: context.profile.id, actorUserId: permission.user.id, idempotencyKey: input.idempotencyKey, requestHash: hash });
    assertPosSessionTransition(current.status, "suspended");
    await assertNoUncertainPayment(tx, current.id);
    await assertNoActivePosOrderClaim(tx, current.id, "pausar");
    const changed = await tx.cashRegisterSession.updateMany({
      where: { id: current.id, operatorProfileId: context.profile.id, status: "open", version: input.expectedVersion },
      data: { status: "suspended", suspendedAt: new Date(), suspendedBy: context.profile.displayName, suspendedReason: input.reason, version: { increment: 1 } },
    });
    if (changed.count !== 1) throw new PosSessionLifecycleError("O turno foi alterado por outra operação.", 409);
    await recordSessionEvent(tx, permission, context, current.id, "session_suspended", input.reason, input.idempotencyKey, hash, correlationId, { from: "open", to: "suspended", expectedVersion: input.expectedVersion });
    return tx.cashRegisterSession.findUniqueOrThrow({ where: { id: current.id } });
  }, serializable);
  return Response.json({ session: jsonSafe(session), correlationId, replayed: false });
}

async function resumeSession(db: Db, permission: Permission, context: Context, input: Extract<PosSessionLifecycleInput, { action: "session.resume" }>) {
  const hash = hashPosSessionLifecycleInput(input);
  const replay = await replaySessionEvent(db, context, input.sessionId, input.idempotencyKey, hash, "session_resumed");
  if (replay) return Response.json(replay);
  const correlationId = randomUUID(), now = new Date();
  const session = await db.$transaction(async (tx) => {
    const current = await ownedSession(tx, context, input.sessionId, "suspended");
    assertPosSessionTransition(current.status, "open");
    await expireStaleHandoff(tx, current.id, input.expectedVersion, context.profile.id, permission.user.id, now);
    if (await tx.posSessionHandoff.count({ where: { sessionId: current.id, state: "requested", expiresAt: { gt: now } } })) throw new PosSessionLifecycleError("Cancele a passagem pendente antes de retomar o turno.", 409);
    await preparePosManualSessionTransition(tx, { action: "resume", sessionId: current.id, expectedVersion: input.expectedVersion, actorProfileId: context.profile.id, actorUserId: permission.user.id, idempotencyKey: input.idempotencyKey, requestHash: hash });
    const changed = await tx.cashRegisterSession.updateMany({
      where: { id: current.id, operatorProfileId: context.profile.id, status: "suspended", version: input.expectedVersion },
      data: { status: "open", suspendedAt: null, suspendedBy: null, suspendedReason: null, version: { increment: 1 } },
    });
    if (changed.count !== 1) throw new PosSessionLifecycleError("O turno foi alterado por outra operação.", 409);
    await recordSessionEvent(tx, permission, context, current.id, "session_resumed", "Retomada pelo operador", input.idempotencyKey, hash, correlationId, { from: "suspended", to: "open", expectedVersion: input.expectedVersion });
    return tx.cashRegisterSession.findUniqueOrThrow({ where: { id: current.id } });
  }, serializable);
  return Response.json({ session: jsonSafe(session), correlationId, replayed: false });
}

async function requestHandoff(db: Db, permission: Permission, context: Context, input: Extract<PosSessionLifecycleInput, { action: "session.handoff.request" }>) {
  const hash = hashPosSessionLifecycleInput(input);
  const replay = await db.posSessionHandoff.findUnique({ where: { requestIdempotencyKey: input.idempotencyKey } });
  if (replay) {
    assertHandoffReplay(replay, hash, input.sessionId, context.profile.id);
    return Response.json({ handoff: handoffDto(replay), replayed: true });
  }
  if (input.targetProfileId === context.profile.id) throw new PosSessionLifecycleError("Escolha outro operador para receber o turno.");
  const correlationId = randomUUID(), now = new Date(), expiresAt = posSessionHandoffExpiresAt(now);
  const handoffId = randomUUID();
  const handoff = await db.$transaction(async (tx) => {
    const current = await ownedSession(tx, context, input.sessionId, "open");
    if (!current.registerId) throw new PosSessionLifecycleError("O turno não possui caixa íntegro.", 409);
    await expireStaleHandoff(tx, current.id, input.expectedVersion, context.profile.id, permission.user.id, now);
    await assertNoOpenPaymentPlan(tx, current.id, "solicitar a passagem");
    await assertNoUncertainPayment(tx, current.id);
    await assertNoActivePosOrderClaim(tx, current.id, "transferir");
    await assertTargetAccess(tx, context.branchId, current.registerId, input.targetProfileId, now);
    if (await tx.cashRegisterSession.count({ where: { operatorProfileId: input.targetProfileId, status: { in: ["open", "suspended", "closing"] } } })) throw new PosSessionLifecycleError("O operador de destino já possui outro turno ativo.", 409);
    if (await tx.posSessionHandoff.count({ where: { sessionId: current.id, state: "requested" } })) throw new PosSessionLifecycleError("Já existe uma passagem pendente para este turno.", 409);
    const heldSales = await tx.posHeldSale.findMany({
      where: { sessionId: current.id, registerId: current.registerId, operatorProfileId: context.profile.id, status: "held" },
      select: { id: true, revision: true }, orderBy: { id: "asc" },
    });
    await preparePosManualHandoffTransition(tx, { action: "request", handoffId, sessionId: current.id, expectedSessionVersion: input.expectedVersion, expectedHandoffRevision: 0, targetOperatorProfileId: input.targetProfileId, actorProfileId: context.profile.id, actorUserId: permission.user.id, idempotencyKey: input.idempotencyKey, requestHash: hash, reason: input.reason, expiresAt, heldSaleSnapshot: heldSales });
    const changed = await tx.cashRegisterSession.updateMany({
      where: { id: current.id, operatorProfileId: context.profile.id, status: "open", version: input.expectedVersion },
      data: { status: "suspended", suspendedAt: now, suspendedBy: context.profile.displayName, suspendedReason: input.reason, version: { increment: 1 } },
    });
    if (changed.count !== 1) throw new PosSessionLifecycleError("O turno foi alterado por outra operação.", 409);
    const created = await tx.posSessionHandoff.create({ data: {
      id: handoffId,
      sessionId: current.id, branchId: context.branchId, registerId: current.registerId,
      fromOperatorProfileId: context.profile.id, toOperatorProfileId: input.targetProfileId,
      reason: input.reason, expiresAt, requestIdempotencyKey: input.idempotencyKey, requestHash: hash,
      heldSaleSnapshot: heldSales,
      requestedByActorId: permission.user.id,
    } });
    await recordSessionEvent(tx, permission, context, current.id, "session_handoff_requested", input.reason, null, null, correlationId, { handoffId: created.id, targetProfileId: input.targetProfileId, expiresAt: expiresAt.toISOString(), expectedVersion: input.expectedVersion });
    await tx.tenantAuditEvent.create({ data: { actorId: permission.user.id, action: "pos.session.handoff.requested", entityType: "pos_session_handoff", entityId: created.id, correlationId, afterData: auditJson(handoffDto(created)) } });
    return created;
  }, serializable);
  return Response.json({ handoff: handoffDto(handoff), correlationId, replayed: false }, { status: 201 });
}

async function acceptHandoff(db: Db, permission: Permission, context: Context, input: Extract<PosSessionLifecycleInput, { action: "session.handoff.accept" }>) {
  const hash = hashPosSessionLifecycleInput(input);
  const replay = await resolvedHandoffReplay(db, context, input, hash, "accepted");
  if (replay) return Response.json(replay);
  const correlationId = randomUUID(), now = new Date();
  const result = await db.$transaction(async (tx) => {
    const handoff = await tx.posSessionHandoff.findFirst({ where: { id: input.handoffId, sessionId: input.sessionId, branchId: context.branchId, toOperatorProfileId: context.profile.id } });
    if (!handoff) throw new PosSessionLifecycleError("Passagem de turno não encontrada para este operador.", 404);
    assertPosHandoffPending(handoff, input.expectedHandoffRevision, now);
    await preparePosManualHandoffTransition(tx, { action: "accept", handoffId: handoff.id, sessionId: input.sessionId, expectedSessionVersion: input.expectedSessionVersion, expectedHandoffRevision: input.expectedHandoffRevision, targetOperatorProfileId: context.profile.id, actorProfileId: context.profile.id, actorUserId: permission.user.id, idempotencyKey: input.idempotencyKey, requestHash: hash, reason: null, expiresAt: null, heldSaleSnapshot: null });
    const session = await tx.cashRegisterSession.findFirst({ where: { id: input.sessionId, registerId: handoff.registerId, operatorProfileId: handoff.fromOperatorProfileId, status: "suspended" } });
    if (!session || session.version !== input.expectedSessionVersion) throw new PosSessionLifecycleError("O turno foi alterado por outra operação.", 409);
    await assertNoOpenPaymentPlan(tx, session.id, "aceitar a passagem");
    await assertNoUncertainPayment(tx, session.id);
    await assertNoActivePosOrderClaim(tx, session.id, "aceitar a transferência de");
    await assertTargetAccess(tx, context.branchId, handoff.registerId, context.profile.id, now);
    if (await tx.cashRegisterSession.count({ where: { operatorProfileId: context.profile.id, status: { in: ["open", "suspended", "closing"] }, id: { not: session.id } } })) throw new PosSessionLifecycleError("Você já possui outro turno ativo.", 409);
    const heldSnapshot = parseHeldSaleSnapshot(handoff.heldSaleSnapshot);
    const currentHeldSales = await tx.posHeldSale.findMany({
      where: { sessionId: session.id, registerId: handoff.registerId, operatorProfileId: handoff.fromOperatorProfileId, status: "held" },
      select: { id: true, revision: true }, orderBy: { id: "asc" },
    });
    if (JSON.stringify(currentHeldSales) !== JSON.stringify(heldSnapshot)) throw new PosSessionLifecycleError("Os carrinhos suspensos do turno mudaram depois da solicitação. Cancele a passagem e revise os carrinhos.", 409);
    const changedHandoff = await tx.posSessionHandoff.updateMany({
      where: { id: handoff.id, state: "requested", revision: input.expectedHandoffRevision },
      data: { state: "accepted", revision: { increment: 1 }, transferredHeldSaleCount: heldSnapshot.length, resolvedAt: now, resolvedByActorId: permission.user.id, resolutionIdempotencyKey: input.idempotencyKey, resolutionRequestHash: hash },
    });
    if (changedHandoff.count !== 1) throw new PosSessionLifecycleError("A passagem foi resolvida por outra operação.", 409);
    for (const held of heldSnapshot) {
      const moved = await tx.posHeldSale.updateMany({ where: { id: held.id, sessionId: session.id, registerId: handoff.registerId, operatorProfileId: handoff.fromOperatorProfileId, status: "held", revision: held.revision }, data: { operatorProfileId: context.profile.id, revision: { increment: 1 } } });
      if (moved.count !== 1) throw new PosSessionLifecycleError("Um carrinho suspenso mudou durante a passagem do turno.", 409);
      await tx.tenantAuditEvent.create({ data: { actorId: permission.user.id, action: "pos.held_cart.session_handoff_transferred", entityType: "pos_held_sale", entityId: held.id, correlationId, beforeData: { sessionId: session.id, registerId: handoff.registerId, operatorProfileId: handoff.fromOperatorProfileId, revision: held.revision }, afterData: { sessionId: session.id, registerId: handoff.registerId, operatorProfileId: context.profile.id, revision: held.revision + 1, handoffId: handoff.id } } });
    }
    const changedSession = await tx.cashRegisterSession.updateMany({
      where: { id: session.id, operatorProfileId: handoff.fromOperatorProfileId, status: "suspended", version: input.expectedSessionVersion },
      data: { operatorProfileId: context.profile.id, status: "open", suspendedAt: null, suspendedBy: null, suspendedReason: null, version: { increment: 1 } },
    });
    if (changedSession.count !== 1) throw new PosSessionLifecycleError("O turno foi alterado por outra operação.", 409);
    await recordSessionEvent(tx, permission, context, session.id, "session_handoff_accepted", handoff.reason, null, null, correlationId, { handoffId: handoff.id, fromOperatorProfileId: handoff.fromOperatorProfileId, toOperatorProfileId: context.profile.id });
    const updated = await tx.posSessionHandoff.findUniqueOrThrow({ where: { id: handoff.id } });
    await tx.tenantAuditEvent.create({ data: { actorId: permission.user.id, action: "pos.session.handoff.accepted", entityType: "pos_session_handoff", entityId: handoff.id, correlationId, beforeData: auditJson(handoffDto(handoff)), afterData: auditJson(handoffDto(updated)) } });
    return { handoff: updated, session: await tx.cashRegisterSession.findUniqueOrThrow({ where: { id: session.id } }) };
  }, serializable);
  return Response.json({ handoff: handoffDto(result.handoff), session: jsonSafe(result.session), correlationId, replayed: false });
}

async function cancelHandoff(db: Db, permission: Permission, context: Context, input: Extract<PosSessionLifecycleInput, { action: "session.handoff.cancel" }>) {
  const hash = hashPosSessionLifecycleInput(input);
  const replay = await resolvedHandoffReplay(db, context, input, hash, "cancelled");
  if (replay) return Response.json(replay);
  const correlationId = randomUUID(), now = new Date();
  const result = await db.$transaction(async (tx) => {
    const handoff = await tx.posSessionHandoff.findFirst({ where: { id: input.handoffId, sessionId: input.sessionId, branchId: context.branchId } });
    if (!handoff || (!context.privileged && handoff.fromOperatorProfileId !== context.profile.id)) throw new PosSessionLifecycleError("Somente o operador de origem pode cancelar esta passagem.", 403);
    assertPosHandoffPending(handoff, input.expectedHandoffRevision, now);
    await preparePosManualHandoffTransition(tx, { action: "cancel", handoffId: handoff.id, sessionId: input.sessionId, expectedSessionVersion: input.expectedSessionVersion, expectedHandoffRevision: input.expectedHandoffRevision, targetOperatorProfileId: null, actorProfileId: context.profile.id, actorUserId: permission.user.id, idempotencyKey: input.idempotencyKey, requestHash: hash, reason: null, expiresAt: null, heldSaleSnapshot: null });
    const session = await tx.cashRegisterSession.findFirst({ where: { id: input.sessionId, registerId: handoff.registerId, operatorProfileId: handoff.fromOperatorProfileId, status: "suspended" } });
    if (!session || session.version !== input.expectedSessionVersion) throw new PosSessionLifecycleError("O turno foi alterado por outra operação.", 409);
    const changedHandoff = await tx.posSessionHandoff.updateMany({ where: { id: handoff.id, state: "requested", revision: input.expectedHandoffRevision }, data: { state: "cancelled", revision: { increment: 1 }, resolvedAt: now, resolvedByActorId: permission.user.id, resolutionIdempotencyKey: input.idempotencyKey, resolutionRequestHash: hash } });
    if (changedHandoff.count !== 1) throw new PosSessionLifecycleError("A passagem foi resolvida por outra operação.", 409);
    const changedSession = await tx.cashRegisterSession.updateMany({ where: { id: session.id, operatorProfileId: handoff.fromOperatorProfileId, status: "suspended", version: input.expectedSessionVersion }, data: { status: "open", suspendedAt: null, suspendedBy: null, suspendedReason: null, version: { increment: 1 } } });
    if (changedSession.count !== 1) throw new PosSessionLifecycleError("O turno foi alterado por outra operação.", 409);
    await recordSessionEvent(tx, permission, context, session.id, "session_handoff_cancelled", input.reason, null, null, correlationId, { handoffId: handoff.id });
    const updated = await tx.posSessionHandoff.findUniqueOrThrow({ where: { id: handoff.id } });
    await tx.tenantAuditEvent.create({ data: { actorId: permission.user.id, action: "pos.session.handoff.cancelled", entityType: "pos_session_handoff", entityId: handoff.id, correlationId, beforeData: auditJson(handoffDto(handoff)), afterData: auditJson(handoffDto(updated)) } });
    return { handoff: updated, session: await tx.cashRegisterSession.findUniqueOrThrow({ where: { id: session.id } }) };
  }, serializable);
  return Response.json({ handoff: handoffDto(result.handoff), session: jsonSafe(result.session), correlationId, replayed: false });
}

async function ownedSession(tx: Prisma.TransactionClient, context: Context, sessionId: number, status: "open" | "suspended") {
  const session = await tx.cashRegisterSession.findFirst({ where: { id: sessionId, operatorProfileId: context.profile.id, status, register: { branchId: context.branchId } } });
  if (!session) throw new PosSessionLifecycleError(`Turno ${status === "open" ? "aberto" : "suspenso"} não encontrado para este operador.`, 404);
  return session;
}

async function assertNoUncertainPayment(tx: Prisma.TransactionClient, sessionId: number) {
  if (await tx.posSalePayment.count({ where: { processingSessionId: sessionId, status: { in: ["created", "processing", "pending", "unknown", "manual_review"] } } })) throw new PosSessionLifecycleError("Resolva pagamentos ou reembolsos pendentes antes de pausar ou transferir o turno.", 409);
  if (await tx.posPaymentIntent.count({ where: { sessionId, consumedAt: null, status: { in: ["created", "processing", "authorized", "captured", "unknown", "manual_review"] } } })) throw new PosSessionLifecycleError("Resolva intenções eletrônicas pendentes ou capturadas ainda não vinculadas antes de pausar ou transferir o turno.", 409);
  if (await tx.posPaymentIntegrityIncident.count({ where: { status: "open", productionBlocking: true, intent: { sessionId } } })) throw new PosSessionLifecycleError("Resolva os incidentes bloqueantes de integridade de pagamento antes de pausar ou transferir o turno.", 409);
}

async function assertNoOpenPaymentPlan(tx: Prisma.TransactionClient, sessionId: number, operation: string) {
  if (await tx.posPaymentPlan.count({ where: { sessionId, state: { in: ["quoted", "active"] } } })) {
    throw new PosSessionLifecycleError(`Recote, cancele com segurança ou reconcilie o plano de pagamento antes de ${operation} do turno.`, 409);
  }
  if (await tx.posManualPaymentReference.count({ where: { sessionId, consumedSalePaymentId: null } })) {
    throw new PosSessionLifecycleError(`Reconcilie toda prova manual antes de ${operation} do turno.`, 409);
  }
}

async function assertNoActivePosOrderClaim(tx: Prisma.TransactionClient, sessionId: number, operation: string) {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_order_claims" WHERE "session_id" = ${sessionId} AND "state" = 'active' FOR UPDATE`);
  const active = await tx.posOrderClaim.findFirst({ where: { sessionId, state: "active" }, select: { id: true, salesOrderId: true } });
  if (active) throw new PosSessionLifecycleError(`Conclua ou libere o pedido reivindicado antes de ${operation} o turno.`, 409);
}

async function assertTargetAccess(tx: Prisma.TransactionClient, branchId: number, registerId: number, profileId: number, now: Date) {
  const [profile, branchAccess, registerAccess] = await Promise.all([
    tx.tenantUserProfile.findFirst({ where: { id: profileId, status: "active" }, select: { id: true } }),
    tx.branchUserAccess.findUnique({ where: { branchId_userProfileId: { branchId, userProfileId: profileId } }, select: { canSell: true } }),
    tx.posRegisterAccess.findFirst({ where: { registerId, userProfileId: profileId, active: true, canOpen: true, canSell: true, register: { branchId, status: "active" }, AND: [{ OR: [{ validFrom: null }, { validFrom: { lte: now } }] }, { OR: [{ validUntil: null }, { validUntil: { gte: now } }] }] }, select: { id: true } }),
  ]);
  if (!profile || !branchAccess?.canSell || !registerAccess) throw new PosSessionLifecycleError("O operador de destino não possui acesso vigente para abrir e vender neste caixa.", 403);
}

async function expireStaleHandoff(tx: Prisma.TransactionClient, sessionId: number, expectedSessionVersion: number, actorProfileId: number, actorId: string, now: Date) {
  const stale = await tx.posSessionHandoff.findFirst({ where: { sessionId, state: "requested", expiresAt: { lte: now } } });
  if (!stale) return;
  const resolutionKey = `session-handoff-expired:${stale.id}`;
  const requestHash = hashInternal({ handoffId: stale.id, state: "expired", expiresAt: stale.expiresAt.toISOString() });
  await preparePosManualHandoffTransition(tx, { action: "expire", handoffId: stale.id, sessionId, expectedSessionVersion, expectedHandoffRevision: stale.revision, targetOperatorProfileId: null, actorProfileId, actorUserId: actorId, idempotencyKey: resolutionKey, requestHash, reason: null, expiresAt: null, heldSaleSnapshot: null });
  const changed = await tx.posSessionHandoff.updateMany({ where: { id: stale.id, state: "requested", revision: stale.revision }, data: { state: "expired", revision: { increment: 1 }, resolvedAt: now, resolvedByActorId: actorId, resolutionIdempotencyKey: resolutionKey, resolutionRequestHash: requestHash } });
  if (changed.count !== 1) throw new PosSessionLifecycleError("A passagem expirada foi alterada por outra operação.", 409);
}

async function recordSessionEvent(tx: Prisma.TransactionClient, permission: Permission, context: Context, sessionId: number, type: string, description: string, idempotencyKey: string | null, requestHash: string | null, correlationId: string, data: Prisma.InputJsonObject) {
  await tx.cashRegisterEvent.create({ data: { sessionId, type, amount: 0, amountCents: 0, description, actor: context.profile.displayName, reasonCode: type, correlationId, idempotencyKey, requestHash } });
  await tx.tenantAuditEvent.create({ data: { actorId: permission.user.id, action: `pos.${type.replaceAll("_", ".")}`, entityType: "cash_register_session", entityId: String(sessionId), correlationId, afterData: data } });
}

async function replaySessionEvent(db: Db, context: Context, sessionId: number, idempotencyKey: string, hash: string, type: string) {
  const event = await db.cashRegisterEvent.findUnique({ where: { idempotencyKey }, include: { session: { include: { register: { select: { branchId: true } } } } } });
  if (!event) return null;
  if (event.type !== type || event.sessionId !== sessionId || event.requestHash !== hash || event.session.operatorProfileId !== context.profile.id || event.session.register?.branchId !== context.branchId) throw new PosSessionLifecycleError("A chave de idempotência já foi usada em outro contexto.", 409);
  return { session: jsonSafe(event.session), correlationId: event.correlationId, replayed: true };
}

async function resolvedHandoffReplay(db: Db, context: Context, input: Extract<PosSessionLifecycleInput, { action: "session.handoff.accept" | "session.handoff.cancel" }>, hash: string, state: "accepted" | "cancelled") {
  const handoff = await db.posSessionHandoff.findUnique({ where: { resolutionIdempotencyKey: input.idempotencyKey }, include: { session: true } });
  if (!handoff) return null;
  if (handoff.id !== input.handoffId || handoff.sessionId !== input.sessionId || handoff.branchId !== context.branchId || handoff.state !== state || handoff.resolutionRequestHash !== hash) throw new PosSessionLifecycleError("A chave de idempotência já foi usada em outra resolução.", 409);
  if (state === "accepted" && handoff.toOperatorProfileId !== context.profile.id) throw new PosSessionLifecycleError("A passagem pertence a outro operador.", 403);
  if (state === "cancelled" && !context.privileged && handoff.fromOperatorProfileId !== context.profile.id) throw new PosSessionLifecycleError("A passagem pertence a outro operador.", 403);
  return { handoff: handoffDto(handoff), session: jsonSafe(handoff.session), replayed: true };
}

function assertHandoffReplay(handoff: { requestHash: string; sessionId: number; fromOperatorProfileId: number }, hash: string, sessionId: number, profileId: number) {
  if (handoff.requestHash !== hash || handoff.sessionId !== sessionId || handoff.fromOperatorProfileId !== profileId) throw new PosSessionLifecycleError("A chave de idempotência já foi usada em outra passagem.", 409);
}

const handoffSelect = { id: true, sessionId: true, branchId: true, registerId: true, fromOperatorProfileId: true, toOperatorProfileId: true, state: true, reason: true, expiresAt: true, revision: true, transferredHeldSaleCount: true, createdAt: true, resolvedAt: true } as const;

function handoffDto(handoff: { id: string; sessionId: number; branchId: number; registerId: number; fromOperatorProfileId: number; toOperatorProfileId: number; state: string; reason: string; expiresAt: Date; revision: number; transferredHeldSaleCount: number; createdAt: Date; resolvedAt: Date | null }) {
  return { id: handoff.id, sessionId: handoff.sessionId, branchId: handoff.branchId, registerId: handoff.registerId, fromOperatorProfileId: handoff.fromOperatorProfileId, toOperatorProfileId: handoff.toOperatorProfileId, state: handoff.state, reason: handoff.reason, expiresAt: handoff.expiresAt, revision: handoff.revision, transferredHeldSaleCount: handoff.transferredHeldSaleCount, createdAt: handoff.createdAt, resolvedAt: handoff.resolvedAt };
}

function parseHeldSaleSnapshot(value: Prisma.JsonValue): Array<{ id: string; revision: number }> {
  if (!Array.isArray(value)) throw new PosSessionLifecycleError("Snapshot dos carrinhos suspensos inválido.", 409);
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || Object.keys(entry).some((key) => key !== "id" && key !== "revision")) throw new PosSessionLifecycleError("Snapshot dos carrinhos suspensos inválido.", 409);
    const id = typeof entry.id === "string" ? entry.id : "", revision = entry.revision;
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(id) || typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) throw new PosSessionLifecycleError("Snapshot dos carrinhos suspensos inválido.", 409);
    return { id, revision };
  }).sort((left, right) => left.id.localeCompare(right.id));
}

function auditJson(value: unknown): Prisma.InputJsonObject { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject; }
function jsonSafe<T>(value: T): T { return JSON.parse(JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item)) as T; }
function hashInternal(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
const serializable = { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 } as const;

function failure(error: unknown) {
  if (error instanceof PosHttpError) return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof PosTerminalBoundaryError) return Response.json({ error: error.message }, { status: error.status, headers: { "cache-control": "no-store" } });
  if (error instanceof PosSessionLifecycleError) return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof PosDomainError || error instanceof CustomerInputError) return Response.json({ error: error.message }, { status: error.message.includes("Origem") ? 403 : 422 });
  if (error instanceof LicenseDeniedError) return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof AuthError) return authErrorResponse(error);
  if ((error as { code?: string })?.code === "P2002") return Response.json({ error: "A operação conflita com outro turno ou já foi registrada." }, { status: 409 });
  if ((error as { code?: string })?.code === "P2034") return Response.json({ error: "Conflito concorrente. Atualize e tente novamente." }, { status: 409 });
  if ((error as { code?: string })?.code === "55000" && String((error as { message?: string }).message || "").includes("order_claim")) return Response.json({ error: "Conclua ou libere o pedido reivindicado antes de transferir o turno." }, { status: 409 });
  console.error("POS session lifecycle failed", { error: error instanceof Error ? error.name : typeof error });
  return Response.json({ error: "Não foi possível atualizar o ciclo do turno." }, { status: 500 });
}
