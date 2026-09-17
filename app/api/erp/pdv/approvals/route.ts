import { randomUUID } from "node:crypto";
import { Prisma } from "@/generated/tenant/client";
import { controlDb, currentOrganization, tenantDb } from "@/db";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import { assertSameOrigin, CustomerInputError } from "@/lib/erp/customer-input";
import {
  assertApprovalReplay,
  bindAuthoritativePosApprovalContext,
  effectivePosApprovalStatus,
  normalizePosApprovalDecision,
  normalizePosApprovalRequest,
  type NormalizedPosApprovalRequest,
} from "@/lib/erp/pos-approvals";
import { PosDomainError } from "@/lib/erp/pos-domain";
import { normalizePosApprovalStepUpInput, posApprovalStepUpTargetKey } from "@/lib/erp/pos-approval-step-up";
import {
  assertPosPostSaleApprovalReplay,
  buildPosCancelApprovalContext,
  buildPosReturnApprovalContext,
  isPosPostSaleApprovalAction,
  normalizePosPostSaleApprovalIntent,
  type PosReturnApprovalIntent,
} from "@/lib/erp/pos-post-sale-approval";
import { assertPosMutationRequest, enforcePosRateLimit, PosHttpError, readPosJson } from "@/lib/erp/pos-http";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { verifyPassword } from "@/lib/password";
import { assertTenantWriteAccess } from "@/lib/tenant-access";

type Db = Awaited<ReturnType<typeof tenantDb>>;
type Permission = Awaited<ReturnType<typeof assertTenantPermission>>;

const STEP_UP_DUMMY_PASSWORD_HASH = "scrypt:7HHeHm1jAqAw7PDUQ1N3rg==:kJyevirbT8B2KYh9sLyLK0omrb6e+XM4E6ymxR5H4CHk24SAqa0jWCvZKtvShvG9sWu8vM5MGlVZEUcI2bB8gA==";
const MANDATORY_STEP_UP_ACTIONS = new Set(["payment.manual_reference", "sale.cancel", "return.create"]);

export async function GET(request: Request) {
  try {
    const organization = await currentOrganization();
    const permission = await assertTenantPermission(organization.id, "pdv.read");
    const db = await tenantDb(organization.id);
    const context = await approvalContext(db, permission);
    const requestedStatus = new URL(request.url).searchParams.get("status") || "pending";
    if (!["pending", "approved", "rejected", "expired", "all"].includes(requestedStatus)) throw new PosDomainError("Estado de aprovação inválido.");
    const now = new Date();
    const statusWhere = requestedStatus === "all" || requestedStatus === "expired"
      ? {}
      : requestedStatus === "pending"
        ? { status: "pending", expiresAt: { gt: now } }
        : { status: requestedStatus };
    const approvals = await db.posApproval.findMany({
      where: {
        branchId: context.branchId,
        ...statusWhere,
        ...(context.privileged ? {} : { requesterId: permission.user.id }),
      },
      select: {
        id: true, action: true, entityType: true, entityId: true, status: true,
        requesterId: true, requesterName: true, approverId: true, approverName: true,
        reason: true, context: true, correlationId: true, decisionReason: true,
        expiresAt: true, decidedAt: true, consumedAt: true, consumedBy: true, consumptionRef: true, createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    const visible = approvals
      .map((approval) => ({ ...approval, status: effectivePosApprovalStatus(approval.status, approval.expiresAt, now) }))
      .filter((approval) => requestedStatus !== "expired" || approval.status === "expired");
    return Response.json({ approvals: jsonSafe(visible), canApprove: context.privileged });
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
    const body = await readPosJson(request, 32_768);
    const command = String(body.action ?? "");
    if (!new Set(["approval.request", "approval.decide", "approval.step-up.decide"]).has(command)) throw new PosDomainError("Ação de aprovação inválida.");
    await enforcePosRateLimit(db, permission.user.id, command);
    const context = await approvalContext(db, permission);
    await assertTenantWriteAccess(organization.id);
    if (command === "approval.request") return requestApproval(db, permission, context, body);
    if (command === "approval.decide") return decideApproval(db, permission, context, body);
    return decideApprovalWithStepUp(db, organization.id, permission, context, body);
  } catch (error) {
    return failure(error);
  }
}

async function approvalContext(db: Db, permission: Permission) {
  const profile = await db.tenantUserProfile.findUnique({
    where: { userId: permission.user.id },
    select: { id: true, displayName: true, status: true, activeBranch: { select: { id: true, status: true } } },
  });
  if (!profile || profile.status !== "active") throw new PosDomainError("Perfil operacional ativo não configurado.");
  const branch = profile.activeBranch?.status === "active"
    ? profile.activeBranch
    : await db.branch.findFirst({ where: { status: "active" }, select: { id: true }, orderBy: [{ primary: "desc" }, { id: "asc" }] });
  if (!branch) throw new PosDomainError("Cadastre uma filial ativa antes de usar aprovações do PDV.");
  const privileged = permission.membership.role === "owner" || permission.membership.role === "admin";
  if (!privileged) {
    const now = new Date();
    const [branchAccess, registerAccess] = await Promise.all([
      db.branchUserAccess.findUnique({
        where: { branchId_userProfileId: { branchId: branch.id, userProfileId: profile.id } },
        select: { canSell: true },
      }),
      db.posRegisterAccess.findFirst({
        where: {
          userProfileId: profile.id,
          active: true,
          register: { branchId: branch.id, status: "active" },
          AND: [
            { OR: [{ validFrom: null }, { validFrom: { lte: now } }] },
            { OR: [{ validUntil: null }, { validUntil: { gte: now } }] },
          ],
        },
        select: { id: true },
      }),
    ]);
    if (!branchAccess?.canSell || !registerAccess) throw new PosDomainError("Seu usuário não está autorizado a operar caixas nesta filial.");
  }
  return {
    branchId: branch.id,
    profile,
    privileged,
  };
}

async function requestApproval(db: Db, permission: Permission, context: Awaited<ReturnType<typeof approvalContext>>, body: Record<string, unknown>) {
  const scope = { branchId: context.branchId, requesterId: permission.user.id };
  const normalized = normalizePosApprovalRequest(body, scope);
  const unique = {
    branchId_requesterId_idempotencyKey: {
      branchId: context.branchId,
      requesterId: permission.user.id,
      idempotencyKey: normalized.idempotencyKey,
    },
  } as const;
  const existing = await db.posApproval.findUnique({ where: unique });
  if (existing) {
    assertPosApprovalRequestReplay(existing, normalized, scope);
    return Response.json({ approval: approvalDto(existing), replayed: true });
  }
  const correlationId = randomUUID();
  try {
    const result = await db.$transaction(async (tx) => {
      const concurrent = await tx.posApproval.findUnique({ where: unique });
      if (concurrent) {
        assertPosApprovalRequestReplay(concurrent, normalized, scope);
        return { approval: concurrent, replayed: true };
      }
      const authoritative = await authoritativePosApprovalRequest(tx, normalized, scope, context);
      const created = await tx.posApproval.create({
        data: {
          branchId: context.branchId,
          action: authoritative.action,
          entityType: authoritative.entityType,
          entityId: authoritative.entityId,
          requesterId: permission.user.id,
          requesterName: context.profile.displayName,
          reason: authoritative.reason,
          context: authoritative.context as Prisma.InputJsonObject,
          correlationId,
          idempotencyKey: authoritative.idempotencyKey,
          requestHash: authoritative.requestHash,
          expiresAt: authoritative.expiresAt,
        },
      });
      await tx.tenantAuditEvent.create({
        data: {
          actorId: permission.user.id,
          action: "pos.approval.requested",
          entityType: "pos_approval",
          entityId: created.id,
          correlationId,
          afterData: auditJson(created),
        },
      });
      return { approval: created, replayed: false };
    }, { isolationLevel: "Serializable" });
    return Response.json({ approval: approvalDto(result.approval), replayed: result.replayed }, { status: result.replayed ? 200 : 201 });
  } catch (error) {
    if ((error as { code?: string })?.code !== "P2002") throw error;
    const winner = await db.posApproval.findUnique({ where: unique });
    if (!winner) throw error;
    assertPosApprovalRequestReplay(winner, normalized, scope);
    return Response.json({ approval: approvalDto(winner), replayed: true });
  }
}

async function authoritativePosApprovalRequest(
  tx: Prisma.TransactionClient,
  request: NormalizedPosApprovalRequest,
  scope: { branchId: number; requesterId: string },
  context: Awaited<ReturnType<typeof approvalContext>>,
) {
  if (!isPosPostSaleApprovalAction(request.action)) return request;
  const intent = normalizePosPostSaleApprovalIntent(request.action, request.context, request.entityId, request.reason);
  const session = await tx.cashRegisterSession.findFirst({
    where: {
      id: intent.sessionId,
      operatorProfileId: context.profile.id,
      status: "open",
      register: { branchId: context.branchId, status: "active" },
    },
    select: { id: true, registerId: true },
  });
  if (!session?.registerId) throw new PosDomainError("Turno aberto não encontrado para o solicitante desta aprovação.");
  if (!context.privileged) {
    const now = new Date();
    const access = await tx.posRegisterAccess.findFirst({
      where: {
        registerId: session.registerId,
        userProfileId: context.profile.id,
        active: true,
        canSell: true,
        AND: [
          { OR: [{ validFrom: null }, { validFrom: { lte: now } }] },
          { OR: [{ validUntil: null }, { validUntil: { gte: now } }] },
        ],
      },
      select: { id: true },
    });
    if (!access) throw new PosDomainError("O solicitante não está autorizado no caixa deste turno.");
  }
  const saleId = Number(request.entityId);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "sales" WHERE "id" = ${saleId} FOR UPDATE`);
  const sale = await tx.sale.findFirst({
    where: { id: saleId, branchId: context.branchId },
    include: {
      items: { include: { kitComponents: true } },
      payments: {
        where: { type: "payment" },
        include: { refunds: { select: { id: true, status: true, amountCents: true } } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      },
    },
  });
  if (!sale) throw new PosDomainError("Venda não encontrada nesta filial.");
  const authoritativeContext = request.action === "sale.cancel"
    ? buildPosCancelApprovalContext({
      sale,
      branchId: context.branchId,
      processingSessionId: session.id,
      registerId: session.registerId,
      reason: request.reason,
    })
    : buildPosReturnApprovalContext({
      sale,
      branchId: context.branchId,
      processingSessionId: session.id,
      registerId: session.registerId,
      intent: intent as PosReturnApprovalIntent,
    });
  return bindAuthoritativePosApprovalContext(request, scope, authoritativeContext as unknown as Record<string, unknown>);
}

function assertPosApprovalRequestReplay(
  existing: { requestHash: string | null; context: Prisma.JsonValue },
  normalized: NormalizedPosApprovalRequest,
  scope: { branchId: number; requesterId: string },
) {
  if (!isPosPostSaleApprovalAction(normalized.action)) {
    assertApprovalReplay(existing.requestHash, normalized.requestHash);
    return;
  }
  const intent = normalizePosPostSaleApprovalIntent(normalized.action, normalized.context, normalized.entityId, normalized.reason);
  assertPosPostSaleApprovalReplay(normalized.action, intent, existing.context);
  if (!existing.context || typeof existing.context !== "object" || Array.isArray(existing.context)) {
    throw new PosDomainError("A aprovação idempotente não possui contexto autoritativo.");
  }
  const rebound = bindAuthoritativePosApprovalContext(normalized, scope, existing.context as Record<string, unknown>);
  assertApprovalReplay(existing.requestHash, rebound.requestHash);
}

async function decideApproval(db: Db, permission: Permission, context: Awaited<ReturnType<typeof approvalContext>>, body: Record<string, unknown>) {
  if (!context.privileged) throw new PosDomainError("Somente administradores podem decidir aprovações do PDV.");
  const approvalId = requiredText(body.approvalId, 120, "Aprovação");
  const { decision, decisionReason } = normalizePosApprovalDecision(body);
  return decideApprovalAs(db, context.branchId, { id: permission.user.id, name: context.profile.displayName }, { approvalId, decision, decisionReason }, "session");
}

async function decideApprovalWithStepUp(db: Db, organizationId: string, permission: Permission, context: Awaited<ReturnType<typeof approvalContext>>, body: Record<string, unknown>) {
  const input = normalizePosApprovalStepUpInput(body);
  const targetKey = posApprovalStepUpTargetKey(input.email);
  await enforcePosRateLimit(db, targetKey, input.action);
  const supervisor = await controlDb.user.findUnique({
    where: { email: input.email },
    include: { memberships: { where: { organizationId, status: "active" }, take: 1 } },
  });
  const passwordMatches = await verifyPassword(input.password, supervisor?.passwordHash || STEP_UP_DUMMY_PASSWORD_HASH);
  const membership = supervisor?.memberships[0];
  const eligible = Boolean(supervisor && supervisor.status === "active" && membership && ["owner", "admin"].includes(membership.role));
  const supervisorProfile = supervisor && eligible ? await db.tenantUserProfile.findUnique({
    where: { userId: supervisor.id },
    select: { id: true, displayName: true, status: true },
  }) : null;
  if (!passwordMatches || !eligible || !supervisor || !supervisorProfile || supervisorProfile.status !== "active") {
    await db.tenantAuditEvent.create({ data: {
      actorId: permission.user.id,
      action: "pos.approval.step_up.failed",
      entityType: "pos_approval",
      entityId: input.approvalId,
      correlationId: randomUUID(),
      afterData: { reasonCode: "invalid_supervisor_credential", targetKey },
    } });
    throw new PosHttpError("Credencial do supervisor inválida.", 401);
  }
  return decideApprovalAs(db, context.branchId, { id: supervisor.id, name: supervisorProfile.displayName }, input, "password_step_up");
}

async function decideApprovalAs(
  db: Db,
  branchId: number,
  approver: { id: string; name: string },
  input: { approvalId: string; decision: "approved" | "rejected"; decisionReason: string | null },
  authenticationMode: "session" | "password_step_up",
) {
  const now = new Date();
  const approval = await db.$transaction(async (tx) => {
    const current = await tx.posApproval.findFirst({ where: { id: input.approvalId, branchId } });
    if (!current) throw new PosDomainError("Pedido de aprovação não encontrado nesta filial.");
    if (MANDATORY_STEP_UP_ACTIONS.has(current.action) && authenticationMode !== "password_step_up") throw new PosDomainError("Esta operação financeira exige reautenticação específica do supervisor.");
    const effectiveStatus = effectivePosApprovalStatus(current.status, current.expiresAt, now);
    if (effectiveStatus === "expired") throw new PosDomainError("O pedido de aprovação expirou.");
    if (current.requesterId === approver.id) throw new PosDomainError("O solicitante não pode aprovar a própria operação.");
    if (current.status !== "pending") {
      if (current.status === input.decision && current.approverId === approver.id) return current;
      throw new PosDomainError("O pedido de aprovação já foi decidido.");
    }
    const changed = await tx.posApproval.updateMany({
      where: { id: current.id, branchId, status: "pending", approverId: null, expiresAt: { gt: now } },
      data: {
        status: input.decision,
        approverId: approver.id,
        approverName: approver.name,
        decisionReason: input.decisionReason,
        decidedAt: now,
      },
    });
    if (changed.count !== 1) throw new PosDomainError("A aprovação foi decidida ou expirou em outra sessão.");
    const updated = await tx.posApproval.findUniqueOrThrow({ where: { id: current.id } });
    await tx.tenantAuditEvent.create({
      data: {
        actorId: approver.id,
        action: `pos.approval.${input.decision}`,
        entityType: "pos_approval",
        entityId: updated.id,
        correlationId: updated.correlationId,
        beforeData: auditJson(current),
        afterData: auditJson({ ...updated, authenticationMode }),
      },
    });
    return updated;
  }, { isolationLevel: "Serializable" });
  return Response.json({ approval: approvalDto(approval) });
}

function approvalDto<T extends {
  id: string; action: string; entityType: string; entityId: string | null; status: string;
  requesterId: string; requesterName: string; approverId: string | null; approverName: string | null;
  reason: string; context: unknown; correlationId: string; decisionReason: string | null;
  expiresAt: Date; decidedAt: Date | null; consumedAt: Date | null; consumedBy: string | null;
  consumptionRef: string | null; createdAt: Date;
}>(approval: T) {
  return {
    id: approval.id,
    action: approval.action,
    entityType: approval.entityType,
    entityId: approval.entityId,
    status: effectivePosApprovalStatus(approval.status, approval.expiresAt),
    requesterId: approval.requesterId,
    requesterName: approval.requesterName,
    approverId: approval.approverId,
    approverName: approval.approverName,
    reason: approval.reason,
    context: approval.context,
    correlationId: approval.correlationId,
    decisionReason: approval.decisionReason,
    expiresAt: approval.expiresAt,
    decidedAt: approval.decidedAt,
    consumedAt: approval.consumedAt,
    consumedBy: approval.consumedBy,
    consumptionRef: approval.consumptionRef,
    createdAt: approval.createdAt,
  };
}

function auditJson(value: unknown): Prisma.InputJsonObject {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
}

function jsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item)) as T;
}

function requiredText(value: unknown, maximum: number, label: string) {
  const result = String(value ?? "").trim();
  if (!result || result.length > maximum) throw new PosDomainError(`${label} inválida.`);
  return result;
}

function failure(error: unknown) {
  if (error instanceof PosHttpError) return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof PosDomainError || error instanceof CustomerInputError) return Response.json({ error: error.message }, { status: error.message.includes("Origem") ? 403 : 422 });
  if (error instanceof LicenseDeniedError) return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof AuthError) return authErrorResponse(error);
  if ((error as { code?: string })?.code === "P2002") return Response.json({ error: "A operação já foi registrada." }, { status: 409 });
  if ((error as { code?: string })?.code === "P2034") return Response.json({ error: "Conflito concorrente. Atualize e tente novamente." }, { status: 409 });
  console.error("POS approval operation failed", { error: error instanceof Error ? error.name : typeof error });
  return Response.json({ error: "Não foi possível concluir a aprovação do PDV." }, { status: 500 });
}
