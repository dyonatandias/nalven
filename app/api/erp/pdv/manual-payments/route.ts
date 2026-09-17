import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@/generated/tenant/client";
import { currentOrganization, tenantDb } from "@/db";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import { assertSameOrigin, CustomerInputError } from "@/lib/erp/customer-input";
import { normalizePosApprovalRequest } from "@/lib/erp/pos-approvals";
import { PosDomainError } from "@/lib/erp/pos-domain";
import { assertPosMutationRequest, enforcePosRateLimit, PosHttpError, readPosJson } from "@/lib/erp/pos-http";
import {
  assertPosManualPaymentReplay,
  normalizePosManualPaymentRequest,
  posManualPaymentApprovalContext,
} from "@/lib/erp/pos-manual-payment";
import { posManualPaymentReferenceWriteTarget, preparePosManualPaymentReferenceWrite } from "@/lib/erp/pos-payment-artifact-capability";
import { prelockPosManualReferenceWrite } from "@/lib/erp/pos-manual-payment-reference-prelock";
import { lockedPosPaymentDraftIssue, PosOrderClaimError } from "@/lib/erp/pos-order-claim";
import { posConnectorAllowsPaymentMethod } from "@/lib/erp/pos-payment-persistence";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { assertPosOperationalTerminalProof, assertPosSessionTerminalBinding, authenticatePosOperationalTerminal, posOperationalTerminalSelect, PosTerminalBoundaryError, readPosOperationalTerminalCredential } from "@/lib/erp/pos-terminal-boundary";
import { assertTenantWriteAccess } from "@/lib/tenant-access";

type Db = Awaited<ReturnType<typeof tenantDb>>;
type Permission = Awaited<ReturnType<typeof assertTenantPermission>>;

const includeApproval = { approval: true } as const;

export async function GET(request: Request) {
  try {
    const organization = await currentOrganization();
    const permission = await assertTenantPermission(organization.id, "pdv.read");
    const id = new URL(request.url).searchParams.get("id") || "";
    if (!/^[A-Za-z0-9_-]{8,120}$/.test(id)) throw new PosDomainError("Referência manual inválida.");
    const db = await tenantDb(organization.id);
    const profile = await activeProfile(db, permission);
    const privileged = ["owner", "admin"].includes(permission.membership.role);
    const value = await db.posManualPaymentReference.findFirst({
      where: { id, ...(privileged ? {} : { requesterUserId: permission.user.id, requesterProfileId: profile.id }) },
      include: includeApproval,
    });
    if (!value) throw new PosDomainError("Referência manual não encontrada neste contexto.");
    return json({ manualReference: dto(value) });
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
    await enforcePosRateLimit(db, permission.user.id, "manual-payment.request");
    const body = await readPosJson(request, 16_384);
    const revokeInput = body.action === "manual-payment.revoke" ? parseManualPaymentRevoke(body) : null;
    if (!revokeInput) throw new PosOrderClaimError("Novas referências manuais permanecem desabilitadas até o workflow de reconciliação autoritativa 320000.", 409);
    onlyKeys(body, revokeInput ? ["action", "sessionId", "id", "reason", "idempotencyKey"] : ["sessionId", "saleDraftId", "quoteHash", "paymentIndex", "method", "amountCents", "installments", "provider", "reference", "occurredAt", "reason", "idempotencyKey"]);
    const profile = await activeProfile(db, permission);
    const privilegedResolver = Boolean(revokeInput && ["owner", "admin"].includes(permission.membership.role));
    const sessionId = positiveInt(body.sessionId, "Turno");
    const session = await db.cashRegisterSession.findFirst({
      where: { id: sessionId, ...(privilegedResolver ? {} : { operatorProfileId: profile.id }), status: "open", register: { status: "active", branch: { status: "active" } } },
      select: { id: true, registerId: true, register: { select: { branchId: true } } },
    });
    if (!session?.registerId || !session.register) throw new PosDomainError("A referência manual exige um turno aberto no contexto autorizado.");
    const credential = readPosOperationalTerminalCredential(request.headers);
    const terminal = await db.posTerminal.findUnique({ where: { id: credential.terminalId }, select: posOperationalTerminalSelect });
    const terminalProof = authenticatePosOperationalTerminal(terminal, { organizationId: organization.id, ...credential, expectedBranchId: session.register.branchId, expectedRegisterId: session.registerId });
    const boundSession = await db.cashRegisterSession.findUnique({ where: { id: session.id }, select: { registerId: true, openingAmountCents: true, openRequestHash: true } });
    if (!boundSession) throw new PosTerminalBoundaryError("O turno vinculado ao terminal não foi encontrado.", 409);
    assertPosSessionTerminalBinding(boundSession, terminalProof);
    if (revokeInput) return revokeManualPaymentReference(db, permission, profile, { id: session.id, registerId: session.registerId, register: session.register }, terminalProof, revokeInput);
    const manualId = randomUUID();
    const normalized = normalizePosManualPaymentRequest(body, {
      id: manualId,
      branchId: session.register.branchId,
      registerId: session.registerId,
      requesterUserId: permission.user.id,
    });
    const unique = { branchId_requesterUserId_idempotencyKey: { branchId: session.register.branchId, requesterUserId: permission.user.id, idempotencyKey: normalized.idempotencyKey } } as const;
    const existing = await db.posManualPaymentReference.findUnique({ where: unique, include: includeApproval });
    if (existing) {
      assertPosManualPaymentReplay(existing.requestHash, normalized.requestHash);
      return json({ manualReference: dto(existing), replayed: true });
    }
    const privileged = ["owner", "admin"].includes(permission.membership.role);
    // Read-only locator. The complete plan/claim/draft binding is reread after
    // the canonical prelock inside the transaction.
    const paymentPlanLocator = await db.posPaymentPlan.findFirst({
      where: {
        saleDraftId: normalized.saleDraftId,
        quoteHash: normalized.quoteHash,
        state: "active",
        slots: { some: { paymentIndex: normalized.paymentIndex, method: normalized.method, amountCents: normalized.amountCents, installments: normalized.installments, proofKind: "manual" } },
      },
      select: { id: true },
    });
    if (!paymentPlanLocator) throw new PosDomainError("A referência manual exige o slot exato de um plano ativo.");
    const correlationId = randomUUID();
    try {
      const created = await db.$transaction(async (tx) => {
        const prelocked = await prelockPosManualReferenceWrite(tx, {
          planIds: [paymentPlanLocator.id],
          reservedReferenceIds: [manualId],
          slotCoordinates: [{ planId: paymentPlanLocator.id, paymentIndex: normalized.paymentIndex }],
          operationIdempotencyKeys: [normalized.idempotencyKey],
        });
        const liveTerminal = await tx.posTerminal.findUnique({ where: { id: terminalProof.terminalId }, select: posOperationalTerminalSelect });
        assertPosOperationalTerminalProof(liveTerminal, terminalProof, { expectedBranchId: session.register!.branchId, expectedRegisterId: session.registerId! });
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "cash_register_sessions" WHERE "id" = ${session.id} FOR UPDATE`);
        const liveSession = await tx.cashRegisterSession.findFirst({
          where: { id: session.id, registerId: session.registerId, operatorProfileId: profile.id, status: "open", register: { branchId: session.register!.branchId, status: "active" } },
          select: { id: true },
        });
        if (!liveSession) throw new PosDomainError("O turno foi fechado ou alterado antes da solicitação.");
        if (!privileged) await assertLiveManualPaymentAccess(tx, session.register!.branchId, session.registerId!, profile.id);
        const draftIssue = await lockedPosPaymentDraftIssue(tx, { saleDraftId: normalized.saleDraftId, branchId: session.register!.branchId, registerId: session.registerId!, sessionId: session.id, operatorProfileId: profile.id, terminalId: terminalProof.terminalId, paymentIndex: normalized.paymentIndex, payment: { method: normalized.method, amountCents: normalized.amountCents, installments: normalized.installments } });
        if (draftIssue) throw new PosOrderClaimError(draftIssue);
        const registeredProvider = await tx.posConnector.findFirst({ where: {
          branchId: session.register!.branchId,
          provider: normalized.provider,
          status: "active",
          type: { startsWith: "payment" },
          OR: [{ registerId: null }, { registerId: session.registerId! }],
        }, select: { id: true, settings: true } });
        if (!registeredProvider) throw new PosDomainError("A instituição do comprovante não está cadastrada como conector de pagamento ativo neste caixa.");
        const methodAllowed = posConnectorAllowsPaymentMethod(registeredProvider.settings, normalized.method);
        if (methodAllowed === "invalid") throw new PosDomainError("A allowlist de métodos do conector é inválida.");
        if (!methodAllowed) throw new PosDomainError("Este método não está habilitado no conector da instituição.");
        const context = posManualPaymentApprovalContext(normalized, session.registerId!);
        const approvalInput = normalizePosApprovalRequest({
          approvalAction: "payment.manual_reference",
          entityId: normalized.saleDraftId,
          reason: normalized.reason,
          expiryMinutes: 10,
          context,
          idempotencyKey: normalized.idempotencyKey,
        }, { branchId: session.register!.branchId, requesterId: permission.user.id });
        const approval = await tx.posApproval.create({ data: {
          branchId: session.register!.branchId,
          action: approvalInput.action,
          entityType: approvalInput.entityType,
          entityId: approvalInput.entityId,
          requesterId: permission.user.id,
          requesterName: profile.displayName,
          reason: approvalInput.reason,
          context: approvalInput.context as Prisma.InputJsonObject,
          correlationId,
          idempotencyKey: approvalInput.idempotencyKey,
          requestHash: approvalInput.requestHash,
          expiresAt: approvalInput.expiresAt,
        } });
        const lockedPlan = prelocked.plans.find(plan => plan.id === paymentPlanLocator.id);
        if (!lockedPlan) throw new PosDomainError("O plano da referência manual desapareceu durante o pré-lock.");
        await preparePosManualPaymentReferenceWrite(tx, {
          action: "create", id: normalized.id, expectedVersion: lockedPlan.version,
          actorUserId: permission.user.id, idempotencyKey: normalized.idempotencyKey,
          target: posManualPaymentReferenceWriteTarget({
            id: normalized.id, branchId: session.register!.branchId, registerId: session.registerId!, sessionId: session.id,
            requesterProfileId: profile.id, requesterUserId: permission.user.id, saleDraftId: normalized.saleDraftId,
            paymentPlanId: lockedPlan.id, quoteHash: normalized.quoteHash, paymentIndex: normalized.paymentIndex,
            method: normalized.method, amountCents: normalized.amountCents, installments: normalized.installments,
            provider: normalized.provider, reference: normalized.reference, referenceHash: normalized.referenceHash,
            referenceLastFour: normalized.referenceLastFour, occurredAt: normalized.occurredAt, status: "pending",
            approvalId: approval.id, idempotencyKey: normalized.idempotencyKey, requestHash: normalized.requestHash,
            consumedSalePaymentId: null, consumedAt: null, revokedAt: null, revokedBy: null, revokeReason: null,
            revokeIdempotencyKey: null, revokeRequestHash: null,
          }),
        });
        const manualReference = await tx.posManualPaymentReference.create({ data: {
          id: normalized.id,
          branchId: session.register!.branchId,
          registerId: session.registerId!,
          sessionId: session.id,
          requesterProfileId: profile.id,
          requesterUserId: permission.user.id,
          saleDraftId: normalized.saleDraftId,
          paymentPlanId: paymentPlanLocator.id,
          quoteHash: normalized.quoteHash,
          paymentIndex: normalized.paymentIndex,
          method: normalized.method,
          amountCents: normalized.amountCents,
          installments: normalized.installments,
          provider: normalized.provider,
          reference: normalized.reference,
          referenceHash: normalized.referenceHash,
          referenceLastFour: normalized.referenceLastFour,
          occurredAt: normalized.occurredAt,
          approvalId: approval.id,
          idempotencyKey: normalized.idempotencyKey,
          requestHash: normalized.requestHash,
        }, include: includeApproval });
        await tx.tenantAuditEvent.create({ data: {
          actorId: permission.user.id,
          action: "pos.payment.manual_reference.requested",
          entityType: "pos_manual_payment_reference",
          entityId: manualReference.id,
          correlationId,
          afterData: { branchId: manualReference.branchId, registerId: manualReference.registerId, sessionId: manualReference.sessionId, saleDraftId: manualReference.saleDraftId, quoteHash: manualReference.quoteHash, paymentIndex: manualReference.paymentIndex, method: manualReference.method, amountCents: manualReference.amountCents, provider: manualReference.provider, referenceHash: manualReference.referenceHash, referenceLastFour: manualReference.referenceLastFour, occurredAt: manualReference.occurredAt.toISOString(), approvalId: approval.id },
        } });
        await tx.tenantAuditEvent.create({ data: {
          actorId: permission.user.id,
          action: "pos.approval.requested",
          entityType: "pos_approval",
          entityId: approval.id,
          correlationId,
          afterData: { action: approval.action, entityType: approval.entityType, entityId: approval.entityId, requesterId: approval.requesterId, expiresAt: approval.expiresAt.toISOString(), context },
        } });
        return manualReference;
      }, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 });
      return json({ manualReference: dto(created), replayed: false }, 201);
    } catch (error) {
      if (!["P2002", "P2034"].includes(prismaCode(error))) throw error;
      const winner = await db.posManualPaymentReference.findUnique({ where: unique, include: includeApproval });
      if (winner) {
        assertPosManualPaymentReplay(winner.requestHash, normalized.requestHash);
        return json({ manualReference: dto(winner), replayed: true });
      }
      if (prismaCode(error) === "P2002") throw new PosDomainError("Esta referência externa já foi vinculada a outro pagamento.");
      throw error;
    }
  } catch (error) {
    return failure(error);
  }
}

async function activeProfile(db: Db, permission: Permission) {
  const profile = await db.tenantUserProfile.findUnique({ where: { userId: permission.user.id }, select: { id: true, displayName: true, status: true } });
  if (!profile || profile.status !== "active") throw new PosDomainError("Perfil operacional ativo não configurado.");
  return profile;
}

type ManualPaymentRevokeInput = { sessionId: number; id: string; reason: string; idempotencyKey: string };

function parseManualPaymentRevoke(body: Record<string, unknown>): ManualPaymentRevokeInput {
  const id = typeof body.id === "string" ? body.id.normalize("NFKC").trim() : "";
  const reason = typeof body.reason === "string" ? body.reason.normalize("NFKC").trim() : "";
  const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.normalize("NFKC").trim() : "";
  if (!/^[A-Za-z0-9_-]{8,120}$/.test(id)) throw new PosDomainError("Referência manual inválida.");
  if (reason.length < 8 || reason.length > 500) throw new PosDomainError("A revogação exige justificativa entre 8 e 500 caracteres.");
  if (!/^[A-Za-z0-9._:-]{16,120}$/.test(idempotencyKey)) throw new PosDomainError("Chave idempotente de revogação inválida.");
  return { sessionId: positiveInt(body.sessionId, "Turno"), id, reason, idempotencyKey };
}

async function revokeManualPaymentReference(
  db: Db,
  permission: Permission,
  profile: { id: number; displayName: string; status: string },
  session: { id: number; registerId: number; register: { branchId: number } },
  terminalProof: ReturnType<typeof authenticatePosOperationalTerminal>,
  input: ManualPaymentRevokeInput,
) {
  if (input.sessionId !== session.id) throw new PosOrderClaimError("A revogação pertence a outro turno.", 403);
  const requestHash = createHash("sha256").update(JSON.stringify({ action: "manual-payment.revoke", branchId: session.register.branchId, id: input.id, reason: input.reason, sessionId: input.sessionId, actorId: permission.user.id })).digest("hex");
  const replay = await db.posManualPaymentReference.findUnique({ where: { revokeIdempotencyKey: input.idempotencyKey }, include: includeApproval });
  if (replay) return json({ manualReference: dto(assertManualPaymentRevokeReplay(replay, { id: input.id, branchId: session.register.branchId, actorId: permission.user.id, requestHash })), replayed: true });
  const referenceLocator = await db.posManualPaymentReference.findFirst({ where: { id: input.id, branchId: session.register.branchId }, select: { saleDraftId: true, paymentPlanId: true } });
  if (!referenceLocator) throw new PosOrderClaimError("Referência manual não encontrada neste contexto.", 404);
  let value: { current: Prisma.PosManualPaymentReferenceGetPayload<{ include: typeof includeApproval }>; replayed: boolean };
  try {
    value = await db.$transaction(async tx => {
    const prelocked = await prelockPosManualReferenceWrite(tx, {
      planIds: referenceLocator.paymentPlanId ? [referenceLocator.paymentPlanId] : [],
      referenceIds: [input.id],
      operationIdempotencyKeys: [input.idempotencyKey],
    });
    const liveTerminal = await tx.posTerminal.findUnique({ where: { id: terminalProof.terminalId }, select: posOperationalTerminalSelect });
    assertPosOperationalTerminalProof(liveTerminal, terminalProof, { expectedBranchId: session.register.branchId, expectedRegisterId: session.registerId });
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "cash_register_sessions" WHERE "id" = ${session.id} FOR UPDATE`);
    if (!await tx.cashRegisterSession.findFirst({ where: { id: session.id, registerId: session.registerId, ...(["owner", "admin"].includes(permission.membership.role) ? {} : { operatorProfileId: profile.id }), status: "open" }, select: { id: true } })) throw new PosOrderClaimError("O turno foi fechado ou alterado antes da revogação.");
    const current = await tx.posManualPaymentReference.findUnique({ where: { id: input.id }, include: includeApproval });
    if (!current) throw new PosOrderClaimError("Referência manual não encontrada.", 404);
    if (current.saleDraftId !== referenceLocator.saleDraftId) throw new PosOrderClaimError("A referência manual mudou de rascunho durante o pré-lock.");
    if (current.sessionId !== session.id || current.registerId !== session.registerId) throw new PosOrderClaimError("A referência manual pertence a outro turno ou caixa.", 403);
    if (current.status === "revoked") {
      return { current: assertManualPaymentRevokeReplay(current, { id: input.id, branchId: session.register.branchId, actorId: permission.user.id, requestHash, idempotencyKey: input.idempotencyKey }), replayed: true };
    }
    if (current.status !== "pending" || current.consumedSalePaymentId) throw new PosOrderClaimError("A referência já foi consumida e não pode ser revogada.");
    if (current.idempotencyKey === input.idempotencyKey) throw new PosOrderClaimError("A revogação exige chave operacional distinta da criação.");
    const independentlyRejected = current.approval.status === "rejected" && current.approval.approverId && current.approval.approverId !== current.requesterUserId;
    if (!independentlyRejected) throw new PosOrderClaimError("Somente uma rejeição independente vigente pode revogar esta referência. Estados pendente, aprovado ou expirado exigem reconciliação financeira contextual futura e continuam bloqueando o slot.");
    const now = new Date();
    const lockedPlan = prelocked.plans.find(plan => plan.id === current.paymentPlanId);
    if (!lockedPlan) throw new PosOrderClaimError("O plano da referência manual não está disponível para revogação.");
    await preparePosManualPaymentReferenceWrite(tx, {
      action: "revoke", id: current.id, expectedVersion: lockedPlan.version,
      actorUserId: permission.user.id, idempotencyKey: input.idempotencyKey,
      target: posManualPaymentReferenceWriteTarget({ ...current, status: "revoked", revokedAt: null,
        revokedBy: permission.user.id, revokeReason: input.reason, revokeIdempotencyKey: input.idempotencyKey,
        revokeRequestHash: requestHash }),
    });
    const changed = await tx.posManualPaymentReference.updateMany({ where: { id: current.id, status: "pending", consumedSalePaymentId: null, revokeIdempotencyKey: null }, data: { status: "revoked", revokedAt: now, revokedBy: permission.user.id, revokeReason: input.reason, revokeIdempotencyKey: input.idempotencyKey, revokeRequestHash: requestHash } });
    if (changed.count !== 1) throw new PosOrderClaimError("A referência mudou durante a revogação.");
    const updated = await tx.posManualPaymentReference.findUniqueOrThrow({ where: { id: current.id }, include: includeApproval });
    await tx.tenantAuditEvent.create({ data: { actorId: permission.user.id, action: "pos.payment.manual_reference.revoked", entityType: "pos_manual_payment_reference", entityId: current.id, correlationId: randomUUID(), beforeData: { status: current.status, approvalId: current.approvalId, approvalStatus: current.approval.status }, afterData: { status: "revoked", approvalId: current.approvalId, approvalStatus: current.approval.status, reason: input.reason, idempotencyKey: input.idempotencyKey, saleDraftId: current.saleDraftId, resolutionMode: "independent_rejection", resolvedByDifferentActor: permission.user.id !== current.requesterUserId } } });
    return { current: updated, replayed: false };
    }, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 });
  } catch (error) {
    if (prismaCode(error) !== "P2002") throw error;
    const concurrent = await db.posManualPaymentReference.findUnique({ where: { revokeIdempotencyKey: input.idempotencyKey }, include: includeApproval });
    if (!concurrent) throw new PosOrderClaimError("A referência mudou concorrentemente. Consulte-a antes de repetir.");
    value = { current: assertManualPaymentRevokeReplay(concurrent, { id: input.id, branchId: session.register.branchId, actorId: permission.user.id, requestHash }), replayed: true };
  }
  return json({ manualReference: dto(value.current), replayed: value.replayed }, 200);
}

function assertManualPaymentRevokeReplay(
  value: Prisma.PosManualPaymentReferenceGetPayload<{ include: typeof includeApproval }>,
  expected: { id: string; branchId: number; actorId: string; requestHash: string; idempotencyKey?: string },
) {
  if (value.id !== expected.id || value.branchId !== expected.branchId || value.status !== "revoked" || value.revokedBy !== expected.actorId || value.revokeRequestHash !== expected.requestHash || expected.idempotencyKey && value.revokeIdempotencyKey !== expected.idempotencyKey) {
    throw new PosOrderClaimError("A chave idempotente da revogação já foi usada em outro contexto ou conteúdo.");
  }
  return value;
}

async function assertLiveManualPaymentAccess(tx: Prisma.TransactionClient, branchId: number, registerId: number, profileId: number) {
  const now = new Date();
  const [branchAccess, registerAccess] = await Promise.all([
    tx.branchUserAccess.findUnique({ where: { branchId_userProfileId: { branchId, userProfileId: profileId } }, select: { canSell: true } }),
    tx.posRegisterAccess.findFirst({ where: { registerId, userProfileId: profileId, active: true, canSell: true, canManualPayment: true, AND: [{ OR: [{ validFrom: null }, { validFrom: { lte: now } }] }, { OR: [{ validUntil: null }, { validUntil: { gte: now } }] }] }, select: { id: true } }),
  ]);
  if (!branchAccess?.canSell || !registerAccess) throw new PosDomainError("Seu acesso para solicitar confirmação manual foi revogado ou expirou.");
}

function dto(value: Prisma.PosManualPaymentReferenceGetPayload<{ include: typeof includeApproval }>) {
  const effectiveApproval = value.approval.expiresAt <= new Date()
    ? value.approval.status === "pending" ? "expired" : value.approval.status === "approved" ? "approved_expired" : value.approval.status
    : value.approval.status;
  return {
    id: value.id,
    saleDraftId: value.saleDraftId,
    quoteHash: value.quoteHash,
    sessionId: value.sessionId,
    registerId: value.registerId,
    paymentIndex: value.paymentIndex,
    method: value.method,
    amountCents: value.amountCents,
    installments: value.installments,
    provider: value.provider,
    referenceLastFour: value.referenceLastFour,
    occurredAt: value.occurredAt,
    status: value.status === "pending" ? effectiveApproval : value.status,
    approvalId: value.approvalId,
    expiresAt: value.approval.expiresAt,
    consumedAt: value.consumedAt,
    revokedAt: value.revokedAt,
    revokedBy: value.revokedBy,
    createdAt: value.createdAt,
  };
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra) throw new PosDomainError(`Campo não permitido: ${extra}.`);
}

function positiveInt(value: unknown, label: string) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) throw new PosDomainError(`${label} inválido.`);
  return result;
}

function prismaCode(error: unknown) {
  return error && typeof error === "object" && "code" in error ? String(error.code) : "";
}

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function failure(error: unknown) {
  if (error instanceof PosOrderClaimError) return json({ error: error.message }, error.status);
  if (error instanceof PosTerminalBoundaryError) return json({ error: error.message }, error.status);
  if (error instanceof PosHttpError) return json({ error: error.message }, error.status);
  if (error instanceof PosDomainError || error instanceof CustomerInputError) return json({ error: error.message }, error.message.includes("acesso") || error.message.includes("turno") ? 403 : 422);
  if (error instanceof LicenseDeniedError) return json({ error: error.message }, error.status);
  if (error instanceof AuthError) {
    const response = authErrorResponse(error);
    response.headers.set("cache-control", "no-store");
    return response;
  }
  if (prismaCode(error) === "P2034") return json({ error: "A referência foi alterada concorrentemente. Consulte o pedido antes de repetir." }, 409);
  console.error("POS manual payment reference failed", { error: error instanceof Error ? error.name : typeof error });
  return json({ error: "Não foi possível registrar a referência manual de pagamento." }, 500);
}
