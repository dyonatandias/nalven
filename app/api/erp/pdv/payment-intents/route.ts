import { randomUUID } from "node:crypto";
import { currentOrganization, tenantDb } from "@/db";
import { Prisma } from "@/generated/tenant/client";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import { assertSameOrigin, CustomerInputError } from "@/lib/erp/customer-input";
import {
  posPaymentIntentWriteTarget,
  preparePosPaymentIntentWrite,
} from "@/lib/erp/pos-payment-artifact-capability";
import {
  createPosPaymentIntent,
  getOwnedPosPaymentIntent,
  hashPosPaymentPayload,
  lockPosPaymentIntentCanonical,
  parsePosPaymentIntentCommand,
  posPaymentIntentDto,
  PosPaymentPersistenceError,
  retryPosPaymentIntent,
  type PosPaymentPersistenceContext,
} from "@/lib/erp/pos-payment-persistence";
import {
  assertPosMutationRequest,
  enforcePosRateLimit,
  PosHttpError,
  readPosJson,
} from "@/lib/erp/pos-http";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { publicPosCustomer } from "@/lib/erp/pos-customer-privacy";
import {
  planPosDraftRecoveryWithManualReferences,
  POS_DRAFT_RECOVERY_INTENT_STATES,
} from "@/lib/erp/pos-draft-recovery";
import { posPaymentPlanDto } from "@/lib/erp/pos-payment-plan";
import {
  authorizePosOperationalAction,
  PosOperationalAccessError,
} from "@/lib/erp/pos-operational-access";
import {
  assertPosOperationalTerminalProof,
  assertPosSessionTerminalBinding,
  authenticatePosOperationalTerminal,
  posOperationalTerminalSelect,
  PosTerminalBoundaryError,
  readPosOperationalTerminalCredential,
  type PosOperationalTerminalProof,
} from "@/lib/erp/pos-terminal-boundary";
import { assertTenantWriteAccess } from "@/lib/tenant-access";
import { decryptSecret } from "@/lib/secrets";

type Db = Awaited<ReturnType<typeof tenantDb>>;
type Permission = Awaited<ReturnType<typeof assertTenantPermission>>;
const noStoreHeaders = {
  "cache-control": "no-store, max-age=0",
  expires: "0",
  pragma: "no-cache",
};

export async function GET(request: Request) {
  try {
    assertSameOrigin(request);
    const organization = await currentOrganization(),
      permission = await assertTenantPermission(organization.id, "pdv.read"),
      db = await tenantDb(organization.id);
    const context = await paymentContext(db, permission),
      params = new URL(request.url).searchParams;
    if (params.get("recovery") === "1")
      return paymentDraftRecovery(
        db,
        context,
        queryPositiveInteger(params.get("sessionId"), "Turno"),
      );
    const intentId = queryIdentifier(params.get("intentId"));
    const intent = await getOwnedPosPaymentIntent(db, context, intentId);
    return Response.json(
      { intent: await intentDtoWithPaymentPlanId(db, intent) },
      { headers: noStoreHeaders },
    );
  } catch (error) {
    return failure(error);
  }
}

async function paymentDraftRecovery(
  db: Db,
  context: PosPaymentPersistenceContext,
  sessionId: number,
) {
  const session = await db.cashRegisterSession.findFirst({
    where: {
      id: sessionId,
      operatorProfileId: context.actorProfileId,
      status: "open",
      register: { branchId: context.branchId, status: "active" },
    },
    select: { id: true, registerId: true },
  });
  if (!session?.registerId)
    throw new PosPaymentPersistenceError(
      "Turno aberto do operador não encontrado para recuperação.",
      404,
    );
  const [drafts, intents, manualReferences, paymentPlans] = await Promise.all([
    db.posHeldSale.findMany({
      where: {
        sessionId,
        registerId: session.registerId,
        operatorProfileId: context.actorProfileId,
        status: "draft",
      },
      include: {
        items: {
          include: {
            product: {
              select: {
                id: true,
                name: true,
                sku: true,
                barcode: true,
                gtin: true,
                type: true,
                unit: true,
                soldIndividually: true,
              },
            },
          },
          orderBy: { id: "asc" },
        },
        customer: {
          select: { id: true, name: true, tradeName: true, document: true },
        },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      take: 21,
    }),
    db.posPaymentIntent.findMany({
      where: {
        branchId: context.branchId,
        registerId: session.registerId,
        sessionId,
        operatorProfileId: context.actorProfileId,
        consumedAt: null,
        status: { in: [...POS_DRAFT_RECOVERY_INTENT_STATES] },
      },
      orderBy: [
        { saleDraftId: "asc" },
        { paymentIndex: "asc" },
        { createdAt: "asc" },
      ],
      take: 101,
    }),
    db.posManualPaymentReference.findMany({
      where: {
        branchId: context.branchId,
        registerId: session.registerId,
        sessionId,
        requesterProfileId: context.actorProfileId,
        consumedSalePaymentId: null,
        status: "pending",
      },
      include: { approval: true },
      orderBy: [
        { saleDraftId: "asc" },
        { paymentIndex: "asc" },
        { createdAt: "asc" },
      ],
      take: 101,
    }),
    db.posPaymentPlan.findMany({
      where: {
        branchId: context.branchId,
        registerId: session.registerId,
        sessionId,
        operatorProfileId: context.actorProfileId,
        state: { in: ["quoted", "active", "expired", "superseded"] },
      },
      include: { slots: { orderBy: { paymentIndex: "asc" } } },
      orderBy: [{ saleDraftId: "asc" }, { createdAt: "desc" }],
      take: 101,
    }),
  ]);
  if (
    drafts.length > 20 ||
    intents.length > 100 ||
    manualReferences.length > 100 ||
    paymentPlans.length > 100
  )
    throw new PosPaymentPersistenceError(
      "A recuperação excedeu o limite seguro. Concilie os rascunhos e pagamentos antes de continuar.",
      409,
    );
  const plan = planPosDraftRecoveryWithManualReferences(
    drafts,
    intents,
    manualReferences.map((reference) => ({
      id: reference.id,
      saleDraftId: reference.saleDraftId,
      paymentIndex: reference.paymentIndex,
      status: reference.status,
      approvalStatus: reference.approval.status,
      approvalExpiresAt: reference.approval.expiresAt,
      consumedSalePaymentId: reference.consumedSalePaymentId,
    })),
  );
  return Response.json(
    {
      recovery: plan,
      drafts: drafts.map((draft) => ({
        id: draft.id,
        revision: draft.revision,
        status: draft.status,
        customerId: draft.customerId,
        customer: draft.customer ? publicPosCustomer(draft.customer) : null,
        notes: draft.notes,
        discountCents: draft.discountCents,
        surchargeCents: draft.surchargeCents,
        updatedAt: draft.updatedAt,
        items: draft.items.map((item) => ({
          productId: item.productId,
          variationId: item.variationId,
          quantity: item.quantity,
          unitPriceCents: item.unitPriceCents,
          discountCents: item.discountCents,
          scanData: item.scanData,
          product: item.product,
        })),
      })),
      intents: intents.map(recoveryIntentDto),
      manualReferences: manualReferences.map(recoveryManualReferenceDto),
      paymentPlans: paymentPlans.map(posPaymentPlanDto),
    },
    { headers: noStoreHeaders },
  );
}

function effectiveManualApprovalStatus(
  reference: Prisma.PosManualPaymentReferenceGetPayload<{
    include: { approval: true };
  }>,
) {
  if (reference.approval.expiresAt <= new Date()) {
    if (reference.approval.status === "pending") return "expired";
    if (reference.approval.status === "approved") return "approved_expired";
  }
  return reference.approval.status;
}

function recoveryManualReferenceDto(
  reference: Prisma.PosManualPaymentReferenceGetPayload<{
    include: { approval: true };
  }>,
) {
  return {
    id: reference.id,
    paymentPlanId: reference.paymentPlanId,
    saleDraftId: reference.saleDraftId,
    quoteHash: reference.quoteHash,
    paymentIndex: reference.paymentIndex,
    method: reference.method,
    amountCents: reference.amountCents,
    installments: reference.installments,
    provider: reference.provider,
    referenceLastFour: reference.referenceLastFour,
    occurredAt: reference.occurredAt,
    status: effectiveManualApprovalStatus(reference),
    approvalId: reference.approvalId,
    expiresAt: reference.approval.expiresAt,
  };
}

function recoveryIntentDto(intent: Prisma.PosPaymentIntentGetPayload<object>) {
  return {
    id: intent.id,
    branchId: intent.branchId,
    registerId: intent.registerId,
    sessionId: intent.sessionId,
    operatorProfileId: intent.operatorProfileId,
    terminalId: intent.terminalId,
    connectorId: intent.connectorId,
    saleDraftId: intent.saleDraftId,
    paymentPlanId: intent.paymentPlanId,
    paymentIndex: intent.paymentIndex,
    status: intent.status,
    version: intent.version,
    amountCents: intent.amountCents,
    currency: intent.currency,
    method: intent.method,
    installments: intent.installments,
    provider: intent.provider,
    providerReference: null,
    failureCode: intent.failureCode,
    failureMessage: intent.failureMessage,
    unknownSince: intent.unknownSince,
    nextReconcileAt: intent.nextReconcileAt,
    expiresAt: intent.expiresAt,
    consumedAt: intent.consumedAt,
  };
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    assertPosMutationRequest(request);
    const organization = await currentOrganization(),
      permission = await assertTenantPermission(organization.id, "pdv.write"),
      db = await tenantDb(organization.id);
    const body = await readPosJson(request, 32_768);
    const cancelInput =
      body.action === "intent.cancel" ? parseCancelInput(body) : null;
    const input = cancelInput ? null : parsePosPaymentIntentCommand(body);
    await enforcePosRateLimit(
      db,
      permission.user.id,
      cancelInput
        ? "payment.intent.cancel"
        : input!.action === "intent.create"
          ? "payment.intent.create"
          : "payment.intent.retry",
    );
    const terminalProof = await paymentTerminalProof(
      db,
      organization.id,
      request,
    );
    const context = await paymentContext(
      db,
      permission,
      terminalProof.branchId,
    );
    await assertPaymentTerminalContext(
      db,
      context,
      terminalProof,
      cancelInput,
      input,
    );
    await assertExplicitPaymentPreparationAccess(
      db,
      permission.user.id,
      context,
      terminalProof.registerId,
    );
    await assertTenantWriteAccess(organization.id);
    const result = cancelInput
      ? await cancelCreatedPosPaymentIntent(
          db,
          context,
          cancelInput,
          terminalProof,
        )
      : input!.action === "intent.create"
        ? await createPosPaymentIntent(db, context, input!, terminalProof)
        : await retryPosPaymentIntent(db, context, input!, terminalProof);
    return Response.json(
      {
        ...result,
        intent: await intentDtoWithPaymentPlanId(db, result.intent),
      },
      {
        status: result.replayed
          ? 200
          : cancelInput
            ? 200
            : input!.action === "intent.create"
              ? 201
              : 202,
        headers: {
          ...noStoreHeaders,
          ...(result.replayed ? { "idempotency-replayed": "true" } : {}),
        },
      },
    );
  } catch (error) {
    return failure(error);
  }
}

async function intentDtoWithPaymentPlanId(
  db: Db,
  intent: { id: string } & Record<string, unknown>,
) {
  const binding = await db.posPaymentIntent.findUnique({
    where: { id: intent.id },
    select: {
      paymentPlanId: true,
      artifacts: {
        where: {
          status: "active",
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!binding?.paymentPlanId)
    throw new PosPaymentPersistenceError(
      "A intenção não possui plano autoritativo recuperável.",
      409,
    );
  return {
    ...intent,
    paymentPlanId: binding.paymentPlanId,
    artifacts: binding.artifacts.map((item) => ({
      kind: item.kind,
      value: decryptSecret(item.valueCipher),
      displayText: item.displayText,
      expiresAt: item.expiresAt,
    })),
  };
}

async function paymentTerminalProof(
  db: Db,
  organizationId: string,
  request: Request,
) {
  const credential = readPosOperationalTerminalCredential(request.headers);
  const terminal = await db.posTerminal.findUnique({
    where: { id: credential.terminalId },
    select: posOperationalTerminalSelect,
  });
  return authenticatePosOperationalTerminal(terminal, {
    organizationId,
    ...credential,
  });
}

async function assertExplicitPaymentPreparationAccess(
  db: Db,
  actorUserId: string,
  context: PosPaymentPersistenceContext,
  registerId: number,
) {
  const [profile, branch, branchAccess, register, registerAccess] =
    await Promise.all([
      db.tenantUserProfile.findUnique({
        where: { id: context.actorProfileId },
        select: { status: true },
      }),
      db.branch.findUnique({
        where: { id: context.branchId },
        select: { status: true },
      }),
      db.branchUserAccess.findUnique({
        where: {
          branchId_userProfileId: {
            branchId: context.branchId,
            userProfileId: context.actorProfileId,
          },
        },
        select: { canSell: true },
      }),
      db.posRegister.findUnique({
        where: { id: registerId },
        select: { branchId: true, status: true },
      }),
      db.posRegisterAccess.findUnique({
        where: {
          registerId_userProfileId: {
            registerId,
            userProfileId: context.actorProfileId,
          },
        },
      }),
    ]);
  authorizePosOperationalAction({
    action: "sale.prepare",
    actorUserId,
    actorProfileId: context.actorProfileId,
    actorProfileActive: profile?.status === "active",
    branchId: context.branchId,
    branchActive: branch?.status === "active",
    registerId,
    registerActive:
      register?.branchId === context.branchId && register.status === "active",
    branchCanSell: branchAccess?.canSell === true,
    registerAccess: registerAccess
      ? { ...registerAccess, branchId: context.branchId }
      : null,
  });
}

async function assertPaymentTerminalContext(
  db: Db,
  context: PosPaymentPersistenceContext,
  proof: PosOperationalTerminalProof,
  cancelInput: CancelInput | null,
  input: ReturnType<typeof parsePosPaymentIntentCommand> | null,
) {
  const sessionId = input?.action === "intent.create" ? input.sessionId : null;
  const intentId =
    cancelInput?.intentId ??
    (input?.action === "intent.retry" ? input.intentId : null);
  const intent = intentId
    ? await db.posPaymentIntent.findFirst({
        where: {
          id: intentId,
          branchId: context.branchId,
          operatorProfileId: context.actorProfileId,
        },
        select: { terminalId: true, sessionId: true, registerId: true },
      })
    : null;
  if (intentId && (!intent || intent.terminalId !== proof.terminalId))
    throw new PosTerminalBoundaryError(
      "A intenção não pertence ao terminal autenticado.",
      403,
    );
  const effectiveSessionId = sessionId ?? intent?.sessionId;
  const session = effectiveSessionId
    ? await db.cashRegisterSession.findFirst({
        where: {
          id: effectiveSessionId,
          operatorProfileId: context.actorProfileId,
          status: "open",
          register: { branchId: context.branchId, status: "active" },
        },
        select: {
          registerId: true,
          openingAmountCents: true,
          openRequestHash: true,
        },
      })
    : null;
  if (!session)
    throw new PosTerminalBoundaryError(
      "A intenção exige turno aberto vinculado ao terminal autenticado.",
      409,
    );
  assertPosSessionTerminalBinding(session, proof);
  if (intent && intent.registerId !== proof.registerId)
    throw new PosTerminalBoundaryError(
      "A intenção pertence a outro caixa.",
      403,
    );
}

type CancelInput = {
  action: "intent.cancel";
  intentId: string;
  expectedVersion: number;
  idempotencyKey: string;
};

function parseCancelInput(body: Record<string, unknown>): CancelInput {
  const allowed = new Set([
      "action",
      "intentId",
      "expectedVersion",
      "idempotencyKey",
    ]),
    extra = Object.keys(body).find((key) => !allowed.has(key));
  if (extra)
    throw new PosPaymentPersistenceError(`Campo não permitido: ${extra}.`, 400);
  const intentId = strictIdentifier(body.intentId, "Intenção", 1, 160),
    idempotencyKey = strictIdentifier(
      body.idempotencyKey,
      "Chave idempotente",
      16,
      160,
    );
  if (!/^[A-Za-z0-9._:-]+$/.test(idempotencyKey))
    throw new PosPaymentPersistenceError("Chave idempotente inválida.", 400);
  if (
    typeof body.expectedVersion !== "number" ||
    !Number.isSafeInteger(body.expectedVersion) ||
    body.expectedVersion < 0 ||
    body.expectedVersion > 2_147_483_646
  )
    throw new PosPaymentPersistenceError("Versão esperada inválida.", 400);
  return {
    action: "intent.cancel",
    intentId,
    expectedVersion: body.expectedVersion,
    idempotencyKey,
  };
}

async function cancelCreatedPosPaymentIntent(
  db: Db,
  context: PosPaymentPersistenceContext,
  input: CancelInput,
  terminalProof: PosOperationalTerminalProof,
) {
  const requestHash = hashPosPaymentPayload(input),
    eventKey = `payment-operator-cancel:${input.idempotencyKey}`;
  const replay = await db.posPaymentStateEvent.findUnique({
    where: { eventKey },
    include: { intent: true },
  });
  if (replay) return cancelReplay(replay, context, requestHash);
  return serializableCancellation(db, async (tx) => {
    const liveTerminal = await tx.posTerminal.findUnique({
      where: { id: terminalProof.terminalId },
      select: posOperationalTerminalSelect,
    });
    assertPosOperationalTerminalProof(liveTerminal, terminalProof, {
      expectedBranchId: context.branchId,
      expectedRegisterId: terminalProof.registerId,
    });
    await lockPosPaymentIntentCanonical(tx, input.intentId, [eventKey]);
    const concurrent = await tx.posPaymentStateEvent.findUnique({
      where: { eventKey },
      include: { intent: true },
    });
    if (concurrent) return cancelReplay(concurrent, context, requestHash);
    const intent = await tx.posPaymentIntent.findFirst({
      where: {
        id: input.intentId,
        branchId: context.branchId,
        operatorProfileId: context.actorProfileId,
        session: { status: "open", operatorProfileId: context.actorProfileId },
      },
    });
    if (!intent)
      throw new PosPaymentPersistenceError(
        "Intenção de pagamento não encontrada no turno aberto do operador.",
        404,
      );
    if (intent.version !== input.expectedVersion)
      throw new PosPaymentPersistenceError(
        "A intenção mudou. Atualize o estado antes de cancelar.",
        409,
      );
    if (
      intent.status !== "created" ||
      intent.providerReference ||
      intent.providerOccurredAt
    )
      throw new PosPaymentPersistenceError(
        "Somente uma intenção ainda não enviada pode ser cancelada localmente. Consulte ou reconcilie o pagamento.",
        409,
      );
    const attempts = await tx.posPaymentAttempt.findMany({
      where: {
        intentId: intent.id,
        state: { in: ["queued", "retry", "claimed"] },
      },
      include: { outbox: true },
    });
    if (
      attempts.some(
        (attempt) =>
          attempt.state === "claimed" ||
          attempt.outbox?.state === "claimed" ||
          attempt.dispatchCount > 0,
      )
    )
      throw new PosPaymentPersistenceError(
        "A intenção já entrou em dispatch e não pode ser cancelada sem confirmação do provider.",
        409,
      );
    const now = new Date();
    for (const attempt of attempts) {
      if (attempt.outbox) {
        const stoppedOutbox = await tx.posPaymentOutbox.updateMany({
          where: {
            id: attempt.outbox.id,
            state: { in: ["pending", "retry"] },
            deliveryCount: 0,
            claimToken: null,
          },
          data: {
            state: "dead",
            completedAt: now,
            lastErrorCode: "operator_cancelled_before_dispatch",
          },
        });
        if (stoppedOutbox.count !== 1)
          throw new PosPaymentPersistenceError(
            "O worker reivindicou a intenção durante o cancelamento.",
            409,
          );
      }
      const stoppedAttempt = await tx.posPaymentAttempt.updateMany({
        where: {
          id: attempt.id,
          state: { in: ["queued", "retry"] },
          dispatchCount: 0,
        },
        data: {
          state: "failed",
          failureCode: "operator_cancelled_before_dispatch",
          finishedAt: now,
        },
      });
      if (stoppedAttempt.count !== 1)
        throw new PosPaymentPersistenceError(
          "A tentativa entrou em dispatch durante o cancelamento.",
          409,
        );
    }
    await preparePosPaymentIntentWrite(tx, {
      action: "cancel_before_dispatch",
      id: intent.id,
      expectedVersion: intent.version,
      actorUserId: context.actorUserId,
      idempotencyKey: input.idempotencyKey,
      target: posPaymentIntentWriteTarget({
        ...intent,
        status: "cancelled",
        version: intent.version + 1,
        failureCode: "operator_cancelled_before_dispatch",
        failureMessage: null,
        nextReconcileAt: null,
      }),
    });
    const changed = await tx.posPaymentIntent.updateMany({
      where: {
        id: intent.id,
        status: "created",
        version: input.expectedVersion,
        providerReference: null, providerOccurredAt: null,
      },
      data: {
        status: "cancelled",
        version: { increment: 1 },
        failureCode: "operator_cancelled_before_dispatch",
        failureMessage: null,
        nextReconcileAt: null,
      },
    });
    if (changed.count !== 1)
      throw new PosPaymentPersistenceError(
        "A intenção entrou em dispatch ou recebeu callback durante o cancelamento.",
        409,
      );
    await tx.posPaymentStateEvent.create({
      data: {
        intentId: intent.id,
        eventKey,
        source: "api",
        sourceId: input.idempotencyKey,
        fromState: "created",
        toState: "cancelled",
        resultingVersion: intent.version + 1,
        evidenceHash: requestHash,
      },
    });
    await tx.tenantAuditEvent.create({
      data: {
        actorId: context.actorUserId,
        action: "pos.payment.intent.cancelled_before_dispatch",
        entityType: "pos_payment_intent",
        entityId: intent.id,
        correlationId: randomUUID(),
        beforeData: { status: intent.status, version: intent.version },
        afterData: {
          status: "cancelled",
          version: intent.version + 1,
          idempotencyKey: input.idempotencyKey,
          requestHash,
        },
      },
    });
    return {
      intent: posPaymentIntentDto(
        await tx.posPaymentIntent.findUniqueOrThrow({
          where: { id: intent.id },
        }),
      ),
      replayed: false,
    };
  });
}

async function serializableCancellation<T>(
  db: Db,
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await db.$transaction(operation, {
        isolationLevel: "Serializable",
        maxWait: 10_000,
        timeout: 30_000,
      });
    } catch (error) {
      if (
        !(
          error &&
          typeof error === "object" &&
          "code" in error &&
          String((error as { code?: unknown }).code) === "P2034"
        ) ||
        attempt === 3
      )
        throw error;
    }
  }
  throw new PosPaymentPersistenceError(
    "O cancelamento serializável não pôde ser concluído.",
    409,
  );
}

function cancelReplay(
  event: {
    evidenceHash: string | null;
    intent: Parameters<typeof posPaymentIntentDto>[0];
  },
  context: PosPaymentPersistenceContext,
  requestHash: string,
) {
  if (
    event.evidenceHash !== requestHash ||
    event.intent.branchId !== context.branchId ||
    event.intent.operatorProfileId !== context.actorProfileId
  )
    throw new PosPaymentPersistenceError(
      "A chave idempotente do cancelamento já foi usada em outro contexto ou conteúdo.",
      409,
    );
  return { intent: posPaymentIntentDto(event.intent), replayed: true };
}

async function paymentContext(
  db: Db,
  permission: Permission,
  terminalBranchId?: number,
): Promise<PosPaymentPersistenceContext> {
  const profile = await db.tenantUserProfile.findUnique({
    where: { userId: permission.user.id },
    select: {
      id: true,
      displayName: true,
      status: true,
      activeBranch: { select: { id: true, status: true } },
    },
  });
  if (!profile || profile.status !== "active")
    throw new PosPaymentPersistenceError(
      "Perfil operacional ativo não configurado.",
      403,
    );
  const branch =
    terminalBranchId != null
      ? await db.branch.findFirst({
          where: { id: terminalBranchId, status: "active" },
          select: { id: true },
        })
      : profile.activeBranch?.status === "active"
        ? profile.activeBranch
        : await db.branch.findFirst({
            where: { status: "active" },
            select: { id: true },
            orderBy: [{ primary: "desc" }, { id: "asc" }],
          });
  if (!branch)
    throw new PosPaymentPersistenceError(
      "Filial operacional ativa não encontrada.",
      404,
    );
  return {
    branchId: branch.id,
    actorUserId: permission.user.id,
    actorProfileId: profile.id,
    actorName: profile.displayName,
  };
}

function queryIdentifier(value: string | null) {
  const result = value?.trim() || "";
  if (!result || result.length > 160 || /[\u0000-\u001f]/.test(result))
    throw new PosPaymentPersistenceError("Intenção inválida.", 400);
  return result;
}
function queryPositiveInteger(value: string | null, label: string) {
  const result = Number(value);
  if (
    !value ||
    !Number.isSafeInteger(result) ||
    result < 1 ||
    result > 2_147_483_647
  )
    throw new PosPaymentPersistenceError(`${label} inválido.`, 400);
  return result;
}
function strictIdentifier(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
) {
  if (typeof value !== "string")
    throw new PosPaymentPersistenceError(`${label} inválida.`, 400);
  const result = value.normalize("NFKC").trim();
  if (
    result.length < minimum ||
    result.length > maximum ||
    /[\u0000-\u001f]/.test(result)
  )
    throw new PosPaymentPersistenceError(`${label} inválida.`, 400);
  return result;
}
function failure(error: unknown) {
  if (
    error instanceof PosTerminalBoundaryError ||
    error instanceof PosOperationalAccessError
  )
    return Response.json(
      { error: error.message },
      { status: error.status, headers: noStoreHeaders },
    );
  if (
    error instanceof PosPaymentPersistenceError ||
    error instanceof PosHttpError
  )
    return Response.json(
      { error: error.message },
      { status: error.status, headers: noStoreHeaders },
    );
  if (error instanceof CustomerInputError)
    return Response.json(
      { error: error.message },
      {
        status: error.message.includes("Origem") ? 403 : 422,
        headers: noStoreHeaders,
      },
    );
  if (error instanceof LicenseDeniedError)
    return Response.json(
      { error: error.message },
      { status: error.status, headers: noStoreHeaders },
    );
  if (error instanceof AuthError) return authErrorResponse(error);
  console.error("POS payment intent failed", { error: error instanceof Error ? error.name : typeof error });
  return Response.json(
    { error: "Não foi possível processar a intenção de pagamento." },
    { status: 500, headers: noStoreHeaders },
  );
}
