import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@/generated/tenant/client";
import {
  posPaymentIntentWriteTarget,
  posSalePaymentWriteTarget,
  preparePosPaymentIntentWrite,
  preparePosSalePaymentWrite,
  type PosPaymentIntentWriteAction,
} from "@/lib/erp/pos-payment-artifact-capability";
import { preparePosPaymentPlanGraphWrite } from "@/lib/erp/pos-payment-plan-capability";
import { prelockPosSalePaymentWriteGraph } from "@/lib/erp/pos-sale-payment-prelock";
import {
  assertPosOperationalTerminalProof,
  assertPosSessionTerminalBinding,
  posOperationalTerminalSelect,
  type PosOperationalTerminalProof,
} from "@/lib/erp/pos-terminal-boundary";
import { encryptSecret } from "@/lib/secrets";

export const POS_PAYMENT_STATES = [
  "created",
  "processing",
  "authorized",
  "captured",
  "declined",
  "unknown",
  "manual_review",
  "cancelled",
  "partially_refunded",
  "refunded",
] as const;
export const POS_PAYMENT_UNCERTAIN_STATES = [
  "processing",
  "authorized",
  "unknown",
  "manual_review",
] as const;
export const POS_PAYMENT_WORK_LIMITS = Object.freeze({
  defaultBatchSize: 25,
  maximumBatchSize: 100,
  defaultLeaseSeconds: 60,
  maximumLeaseSeconds: 300,
  serializationRetries: 3,
});

export type PosPersistedPaymentState = (typeof POS_PAYMENT_STATES)[number];
export type PosPersistedPaymentMethod = "pix" | "credit" | "debit" | "voucher";

export type PosPaymentPersistenceContext = {
  branchId: number;
  actorUserId: string;
  actorProfileId: number;
  actorName: string;
};

export type PosPaymentIntentCommand =
  | {
      action: "intent.create";
      sessionId: number;
      paymentPlanId: string;
      paymentIndex: number;
      idempotencyKey: string;
    }
  | {
      action: "intent.retry";
      intentId: string;
      expectedVersion: number;
      idempotencyKey: string;
    };

export type PosPaymentObservation = {
  provider: string;
  providerReference: string | null;
  state: PosPersistedPaymentState;
  amountCents: number;
  currency: string;
  providerSequence: bigint | null;
  occurredAt: Date | null;
  evidenceId: string | null;
  transactionId: string | null;
  endToEndId: string | null;
  nsu: string | null;
  authorizationCode: string | null;
  cardBrand: string | null;
  cardLastFour: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  artifacts?: Array<{
    kind:
      "pix_copy_paste" | "pix_qr_url" | "payment_link" | "terminal_instruction";
    value: string;
    displayText: string | null;
    expiresAt: Date | null;
  }>;
};

export type PosProviderPaymentObservation = PosPaymentObservation & {
  providerReference: string;
  occurredAt: Date;
};

export type PosPaymentOutboxCompletion = {
  attemptId: string;
  claimToken: string;
  result:
    | ({ kind: "result" } & PosProviderPaymentObservation)
    | { kind: "unknown"; failureCode: string; failureMessage: string | null }
    | {
        kind: "known_failure";
        retryable: boolean;
        failureCode: string;
        failureMessage: string | null;
      };
};

export class PosPaymentPersistenceError extends Error {
  constructor(
    message: string,
    public readonly status = 422,
  ) {
    super(message);
    this.name = "PosPaymentPersistenceError";
  }
}

type RootDb = PrismaClient;

export function parsePosPaymentIntentCommand(
  body: Record<string, unknown>,
): PosPaymentIntentCommand {
  rejectSensitiveData(body);
  const action = choice(
    body.action,
    ["intent.create", "intent.retry"] as const,
    "Ação",
  );
  if (action === "intent.create") {
    onlyKeys(body, [
      "action",
      "sessionId",
      "paymentPlanId",
      "paymentIndex",
      "idempotencyKey",
    ]);
    return {
      action,
      sessionId: integer(body.sessionId, "Turno", 1, 2_147_483_647),
      paymentPlanId: key(body.paymentPlanId, "Plano de pagamento"),
      paymentIndex: integer(body.paymentIndex, "Índice do pagamento", 0, 9),
      idempotencyKey: key(body.idempotencyKey, "Chave idempotente"),
    };
  }
  onlyKeys(body, ["action", "intentId", "expectedVersion", "idempotencyKey"]);
  return {
    action,
    intentId: identifier(body.intentId, "Intenção", 1, 160),
    expectedVersion: integer(
      body.expectedVersion,
      "Versão esperada",
      0,
      2_147_483_646,
    ),
    idempotencyKey: key(body.idempotencyKey, "Chave idempotente"),
  };
}

export function parsePosPaymentCallbackPayload(
  body: Record<string, unknown>,
): { intentId: string } & PosProviderPaymentObservation {
  rejectSensitiveData(body);
  onlyKeys(body, [
    "intentId",
    "reference",
    "state",
    "amountCents",
    "currency",
    "sequence",
    "occurredAt",
    "evidenceId",
    "transactionId",
    "endToEndId",
    "nsu",
    "authorizationCode",
    "brand",
    "lastFour",
    "failureCode",
    "failureMessage",
  ]);
  return {
    intentId: identifier(body.intentId, "Intenção", 1, 160),
    provider: "",
    providerReference: identifier(
      body.reference,
      "Referência do provedor",
      1,
      160,
    ),
    state: choice(body.state, POS_PAYMENT_STATES, "Estado"),
    amountCents: integer(body.amountCents, "Valor", 1, 2_147_483_647),
    currency: currencyCode(body.currency),
    providerSequence:
      body.sequence == null
        ? null
        : BigInt(
            integer(
              body.sequence,
              "Sequência do provedor",
              1,
              Number.MAX_SAFE_INTEGER,
            ),
          ),
    occurredAt: date(body.occurredAt, "Data do provedor"),
    evidenceId: nullableIdentifier(body.evidenceId, "Evidência", 160),
    transactionId: nullableIdentifier(body.transactionId, "Transação", 160),
    endToEndId: nullableIdentifier(body.endToEndId, "End-to-end", 160),
    nsu: nullableIdentifier(body.nsu, "NSU", 80),
    authorizationCode: nullableIdentifier(
      body.authorizationCode,
      "Autorização",
      80,
    ),
    cardBrand: nullableIdentifier(body.brand, "Bandeira", 40),
    cardLastFour: cardLastFour(body.lastFour),
    failureCode: nullableCode(body.failureCode, "Falha", 80),
    failureMessage: nullableText(
      body.failureMessage,
      "Descrição da falha",
      300,
    ),
  };
}

export function parsePosPaymentOutboxCompletion(
  body: Record<string, unknown>,
): PosPaymentOutboxCompletion {
  rejectSensitiveData(body);
  onlyKeys(body, ["action", "attemptId", "claimToken", "result"]);
  if (body.action !== "outbox.complete")
    throw new PosPaymentPersistenceError("Ação do worker inválida.", 400);
  const value = record(body.result, "Resultado"),
    kind = choice(
      value.kind,
      ["result", "unknown", "known_failure"] as const,
      "Tipo de resultado",
    );
  if (kind === "result") {
    onlyKeys(value, [
      "kind",
      "provider",
      "reference",
      "state",
      "amountCents",
      "currency",
      "sequence",
      "occurredAt",
      "evidenceId",
      "transactionId",
      "endToEndId",
      "nsu",
      "authorizationCode",
      "brand",
      "lastFour",
      "failureCode",
      "failureMessage",
      "artifacts",
    ]);
    const parsed = parsePosPaymentCallbackPayload({
      intentId: "worker-result",
      reference: value.reference,
      state: value.state,
      amountCents: value.amountCents,
      currency: value.currency,
      sequence: value.sequence,
      occurredAt: value.occurredAt,
      evidenceId: value.evidenceId,
      transactionId: value.transactionId,
      endToEndId: value.endToEndId,
      nsu: value.nsu,
      authorizationCode: value.authorizationCode,
      brand: value.brand,
      lastFour: value.lastFour,
      failureCode: value.failureCode,
      failureMessage: value.failureMessage,
    });
    return {
      attemptId: identifier(body.attemptId, "Tentativa", 1, 160),
      claimToken: key(body.claimToken, "Token de claim"),
      result: {
        kind,
        ...parsed,
        provider: providerKey(value.provider),
        artifacts: paymentArtifacts(value.artifacts),
      },
    };
  }
  onlyKeys(
    value,
    kind === "known_failure"
      ? ["kind", "retryable", "failureCode", "failureMessage"]
      : ["kind", "failureCode", "failureMessage"],
  );
  return {
    attemptId: identifier(body.attemptId, "Tentativa", 1, 160),
    claimToken: key(body.claimToken, "Token de claim"),
    result: {
      kind,
      ...(kind === "known_failure"
        ? { retryable: value.retryable === true }
        : {}),
      failureCode: code(value.failureCode, "Falha", 80),
      failureMessage: nullableText(
        value.failureMessage,
        "Descrição da falha",
        300,
      ),
    } as PosPaymentOutboxCompletion["result"],
  };
}

export function hashPosPaymentPayload(value: unknown) {
  return createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

export function assertPosPaymentTransition(
  current: PosPersistedPaymentState,
  next: PosPersistedPaymentState,
) {
  const transitions: Record<
    PosPersistedPaymentState,
    readonly PosPersistedPaymentState[]
  > = {
    created: [
      "created",
      "processing",
      "authorized",
      "captured",
      "declined",
      "unknown",
      "manual_review",
      "cancelled",
    ],
    processing: [
      "processing",
      "authorized",
      "captured",
      "declined",
      "unknown",
      "manual_review",
      "cancelled",
    ],
    authorized: [
      "authorized",
      "captured",
      "unknown",
      "manual_review",
      "cancelled",
    ],
    // prettier-ignore
    unknown: ["unknown", "processing", "authorized", "captured", "declined", "manual_review", "cancelled"],
    manual_review: [
      "manual_review",
      "processing",
      "authorized",
      "captured",
      "declined",
      "cancelled",
    ],
    captured: ["captured", "partially_refunded", "refunded"],
    partially_refunded: ["partially_refunded", "refunded"],
    declined: ["declined"],
    cancelled: ["cancelled"],
    refunded: ["refunded"],
  };
  if (!transitions[current]?.includes(next))
    throw new PosPaymentPersistenceError(
      `Transição de pagamento inválida: ${current} → ${next}.`,
      409,
    );
  return next;
}

export function assertPosPaymentMethodEvidence(
  method: PosPersistedPaymentMethod,
  state: PosPersistedPaymentState,
  evidence: Pick<
    PosPaymentObservation,
    | "transactionId"
    | "endToEndId"
    | "nsu"
    | "authorizationCode"
    | "cardBrand"
    | "cardLastFour"
  >,
) {
  const confirmed =
    state === "authorized" ||
    state === "captured" ||
    state === "partially_refunded" ||
    state === "refunded";
  if (evidence.endToEndId && !isCanonicalPixEndToEndId(evidence.endToEndId))
    throw new PosPaymentPersistenceError("EndToEndId Pix inválido.");
  if (method === "pix") {
    if (
      evidence.nsu ||
      evidence.authorizationCode ||
      evidence.cardBrand ||
      evidence.cardLastFour
    )
      throw new PosPaymentPersistenceError(
        "Evidência Pix contém dados exclusivos de cartão.",
      );
    if (confirmed && !evidence.endToEndId)
      throw new PosPaymentPersistenceError(
        "Pagamento Pix confirmado sem EndToEndId.",
      );
  } else {
    if (evidence.endToEndId)
      throw new PosPaymentPersistenceError(
        "Pagamento de cartão contém evidência Pix indevida.",
      );
    if (
      confirmed &&
      (!evidence.transactionId ||
        !evidence.authorizationCode ||
        !evidence.cardLastFour)
    )
      throw new PosPaymentPersistenceError(
        "Pagamento de cartão confirmado sem evidência obrigatória.",
      );
  }
  return evidence;
}

export async function createPosPaymentIntent(
  db: RootDb,
  context: PosPaymentPersistenceContext,
  input: Extract<PosPaymentIntentCommand, { action: "intent.create" }>,
  terminalProof: PosOperationalTerminalProof,
) {
  const requestHash = hashPosPaymentPayload(input);
  const replay = await db.posPaymentIntent.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    include: { attempts: { orderBy: { sequence: "asc" } } },
  });
  if (replay)
    return replayIntent(
      replay,
      context,
      requestHash,
      input,
      terminalProof.terminalId,
    );
  const intentId = randomUUID(),
    attemptId = randomUUID();
  try {
    return await serializableRetry(db, async (tx) => {
      const { plan, slot, session, connector } =
        await lockPosPaymentIntentCreateCanonical(tx, {
          intentId,
          idempotencyKey: input.idempotencyKey,
          planId: input.paymentPlanId,
          paymentIndex: input.paymentIndex,
          sessionId: input.sessionId,
          context,
          terminalProof,
        });
      if (
        !slot.connectorId ||
        !["pix", "credit", "debit", "voucher"].includes(slot.method)
      )
        throw new PosPaymentPersistenceError(
          "A divisão autoritativa não possui conector eletrônico válido.",
          409,
        );
      if (!connector || !connector.type.startsWith("payment"))
        throw new PosPaymentPersistenceError(
          "Conector de pagamento ativo não encontrado para este caixa.",
          404,
        );
      assertConnectorMethod(
        connector.settings,
        slot.method as PosPersistedPaymentMethod,
      );
      const now = new Date();
      await preparePosPaymentIntentWrite(tx, {
        action: "create",
        id: intentId,
        expectedVersion: 0,
        actorUserId: context.actorUserId,
        idempotencyKey: input.idempotencyKey,
        target: posPaymentIntentWriteTarget({
          id: intentId,
          branchId: context.branchId,
          registerId: session.registerId!,
          sessionId: session.id,
          operatorProfileId: context.actorProfileId,
          terminalId: terminalProof.terminalId,
          connectorId: connector.id,
          credentialRef: slot.credentialRef!,
          saleDraftId: plan.saleDraftId,
          paymentPlanId: plan.id,
          paymentIndex: slot.paymentIndex,
          status: "created",
          version: 0,
          amountCents: slot.amountCents,
          currency: plan.currency,
          method: slot.method,
          installments: slot.installments,
          provider: connector.provider,
          providerReference: null,
          transactionId: null,
          endToEndId: null,
          nsu: null,
          authorizationCode: null,
          cardBrand: null,
          cardLastFour: null,
          evidenceId: null,
          failureCode: null,
          failureMessage: null,
          providerSequence: null,
          providerOccurredAt: null,
          unknownSince: null,
          nextReconcileAt: null,
          expiresAt: plan.expiresAt,
          idempotencyKey: input.idempotencyKey,
          requestHash,
          consumedAt: null,
        }),
      });
      const intent = await tx.posPaymentIntent.create({
        data: {
          id: intentId,
          branchId: context.branchId,
          registerId: session.registerId,
          sessionId: session.id,
          operatorProfileId: context.actorProfileId,
          terminalId: terminalProof.terminalId,
          connectorId: connector.id,
          credentialRef: slot.credentialRef!,
          saleDraftId: plan.saleDraftId,
          paymentPlanId: plan.id,
          paymentIndex: slot.paymentIndex,
          amountCents: slot.amountCents,
          currency: plan.currency,
          method: slot.method,
          installments: slot.installments,
          provider: connector.provider,
          expiresAt: plan.expiresAt,
          idempotencyKey: input.idempotencyKey,
          requestHash,
          attempts: {
            create: {
              id: attemptId,
              sequence: 1,
              operation: "create",
              operationKey: input.idempotencyKey,
              requestHash,
              providerIdempotencyKey: input.idempotencyKey,
              outbox: { create: { nextAttemptAt: now } },
            },
          },
          stateEvents: {
            create: {
              eventKey: `payment-intent:${intentId}:0`,
              source: "api",
              sourceId: input.idempotencyKey,
              fromState: null,
              toState: "created",
              resultingVersion: 0,
            },
          },
        },
        include: { attempts: { orderBy: { sequence: "asc" } } },
      });
      await tx.tenantAuditEvent.create({
        data: {
          actorId: context.actorUserId,
          action: "pos.payment.intent.created",
          entityType: "pos_payment_intent",
          entityId: intent.id,
          correlationId: randomUUID(),
          afterData: {
            branchId: context.branchId,
            registerId: session.registerId,
            sessionId: session.id,
            paymentPlanId: plan.id,
            paymentIndex: slot.paymentIndex,
            connectorId: connector.id,
            provider: connector.provider,
            method: slot.method,
            amountCents: slot.amountCents,
            currency: plan.currency,
            expiresAt: intent.expiresAt.toISOString(),
            requestHash,
          },
        },
      });
      return { intent: posPaymentIntentDto(intent), replayed: false };
    });
  } catch (error) {
    if (isSerializationConflict(error) || prismaCode(error) === "P2002") {
      const concurrent = await db.posPaymentIntent.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        include: { attempts: { orderBy: { sequence: "asc" } } },
      });
      if (concurrent)
        return replayIntent(
          concurrent,
          context,
          requestHash,
          input,
          terminalProof.terminalId,
        );
    }
    throw error;
  }
}

export async function retryPosPaymentIntent(
  db: RootDb,
  context: PosPaymentPersistenceContext,
  input: Extract<PosPaymentIntentCommand, { action: "intent.retry" }>,
  terminalProof: PosOperationalTerminalProof,
) {
  const requestHash = hashPosPaymentPayload(input);
  const replay = await db.posPaymentAttempt.findUnique({
    where: { operationKey: input.idempotencyKey },
    include: { intent: true },
  });
  if (replay)
    return replayAttempt(
      replay,
      context,
      requestHash,
      terminalProof.terminalId,
    );
  return serializableRetry(db, async (tx) => {
    const graph = await lockPosPaymentIntentCanonical(tx, input.intentId);
    const intent = await ownedIntent(tx, context, input.intentId);
    const session = await tx.cashRegisterSession.findUnique({
      where: { id: intent.sessionId },
    });
    if (!session)
      throw new PosPaymentPersistenceError(
        "Turno da intenção não encontrado.",
        404,
      );
    await assertLivePaymentTerminal(tx, context, terminalProof, session);
    await assertLivePaymentAccess(tx, context, intent.registerId);
    if (intent.version !== input.expectedVersion)
      throw new PosPaymentPersistenceError(
        "A versão da intenção mudou. Consulte novamente antes do retry.",
        409,
      );
    if (
      [
        "captured",
        "declined",
        "cancelled",
        "partially_refunded",
        "refunded",
      ].includes(intent.status)
    )
      throw new PosPaymentPersistenceError(
        "A intenção já possui resultado final e não pode ser reenviada.",
        409,
      );
    if (intent.expiresAt <= new Date() && intent.status === "created")
      throw new PosPaymentPersistenceError(
        "A intenção expirou antes de ser enviada.",
        409,
      );
    const operation = intent.status === "created" ? "create" : "query";
    if (operation === "create") {
      const boundaryFailure = createDispatchBoundaryFailure(graph, new Date());
      if (boundaryFailure)
        throw new PosPaymentPersistenceError(
          `A intenção não pode ser reenviada: ${boundaryFailure}.`,
          409,
        );
    }
    const latest = await tx.posPaymentAttempt.findFirst({
      where: { intentId: intent.id },
      orderBy: { sequence: "desc" },
      select: { sequence: true },
    });
    const resultingVersion = intent.version + 1,
      attemptId = randomUUID(),
      now = new Date();
    await prepareIntentTransition(
      tx,
      "retry",
      intent,
      input.idempotencyKey,
      context.actorUserId,
      { version: resultingVersion },
    );
    const changed = await tx.posPaymentIntent.updateMany({
      where: {
        id: intent.id,
        version: input.expectedVersion,
        status: intent.status,
      },
      data: { version: { increment: 1 }, updatedAt: now },
    });
    if (changed.count !== 1)
      throw new PosPaymentPersistenceError(
        "A intenção foi alterada por callback ou worker concorrente.",
        409,
      );
    const attempt = await tx.posPaymentAttempt.create({
      data: {
        id: attemptId,
        intentId: intent.id,
        sequence: (latest?.sequence ?? 0) + 1,
        operation,
        operationKey: input.idempotencyKey,
        requestHash,
        // prettier-ignore
        providerIdempotencyKey: operation === "create" ? intent.idempotencyKey : input.idempotencyKey,
        outbox: { create: { nextAttemptAt: now } },
      },
    });
    await tx.posPaymentStateEvent.create({
      data: {
        intentId: intent.id,
        attemptId: attempt.id,
        eventKey: `payment-retry:${input.idempotencyKey}`,
        source: "api",
        sourceId: input.idempotencyKey,
        fromState: intent.status,
        toState: intent.status,
        resultingVersion,
      },
    });
    await tx.tenantAuditEvent.create({
      data: {
        actorId: context.actorUserId,
        action: "pos.payment.intent.retry_requested",
        entityType: "pos_payment_intent",
        entityId: intent.id,
        correlationId: randomUUID(),
        beforeData: { status: intent.status, version: intent.version },
        afterData: {
          status: intent.status,
          version: resultingVersion,
          attemptId: attempt.id,
          operation,
        },
      },
    });
    return {
      intent: posPaymentIntentDto({
        ...intent,
        version: resultingVersion,
        updatedAt: now,
      }),
      attempt: posPaymentAttemptDto(attempt),
      replayed: false,
    };
  }).catch(async (error) => {
    if (isSerializationConflict(error) || prismaCode(error) === "P2002") {
      const concurrent = await db.posPaymentAttempt.findUnique({
        where: { operationKey: input.idempotencyKey },
        include: { intent: true },
      });
      if (concurrent)
        return replayAttempt(
          concurrent,
          context,
          requestHash,
          terminalProof.terminalId,
        );
    }
    throw error;
  });
}

export async function getOwnedPosPaymentIntent(
  db: RootDb,
  context: PosPaymentPersistenceContext,
  intentId: string,
) {
  const intent = await db.posPaymentIntent.findFirst({
    where: {
      id: intentId,
      branchId: context.branchId,
      operatorProfileId: context.actorProfileId,
    },
    include: {
      attempts: { orderBy: { sequence: "desc" }, take: 10 },
      stateEvents: { orderBy: { resultingVersion: "desc" }, take: 20 },
    },
  });
  if (!intent)
    throw new PosPaymentPersistenceError(
      "Intenção de pagamento não encontrada.",
      404,
    );
  return posPaymentIntentDto(intent);
}

export async function consumeCapturedPosPaymentIntent(
  tx: Prisma.TransactionClient,
  input: {
    intentId: string;
    branchId: number;
    registerId: number;
    terminalId: string;
    sessionId: number;
    operatorProfileId: number;
    saleDraftId: string;
    paymentPlanId: string;
    paymentIndex: number;
    amountCents: number;
    method: PosPersistedPaymentMethod;
    installments: number;
    saleId: number;
    paymentIdempotencyKey: string;
    paymentId?: string;
  },
) {
  const paymentId = input.paymentId ?? randomUUID();
  const planLocator = await paymentPlanIntentLocator(tx, input.paymentPlanId);
  if (!planLocator || planLocator.saleDraftId !== input.saleDraftId)
    throw new PosPaymentPersistenceError(
      "O plano autoritativo da intenção mudou antes do pré-lock de consumo.",
      409,
    );
  const claimLocator = planLocator.orderClaimId
    ? await tx.posOrderClaim.findUnique({
        where: { id: planLocator.orderClaimId },
        select: { id: true, salesOrderId: true },
      })
    : null;
  if (planLocator.orderClaimId && !claimLocator)
    throw new PosPaymentPersistenceError(
      "A posse autoritativa da intenção não foi encontrada.",
      409,
    );
  const paymentPrelock = await prelockPosSalePaymentWriteGraph(tx, {
    mode: "operational",
    preRootAdvisoryNamespaces: [
      `pos-payment-intent-graph:existing:${input.intentId}`,
      ...paymentPlanSharedNamespaces(
        planLocator,
        claimLocator?.salesOrderId ?? null,
      ),
    ],
    paymentPlanIds: [input.paymentPlanId],
    insertIdempotencyKeys: [input.paymentIdempotencyKey],
    saleIds: [input.saleId],
  });
  await lockPosPaymentIntentCanonical(tx, input.intentId);
  const intent = await tx.posPaymentIntent.findUnique({
    where: { id: input.intentId },
  });
  if (
    !intent ||
    intent.branchId !== input.branchId ||
    intent.registerId !== input.registerId ||
    intent.terminalId !== input.terminalId ||
    intent.sessionId !== input.sessionId ||
    intent.operatorProfileId !== input.operatorProfileId ||
    intent.saleDraftId !== input.saleDraftId ||
    intent.paymentPlanId !== input.paymentPlanId ||
    intent.paymentIndex !== input.paymentIndex ||
    intent.amountCents !== input.amountCents ||
    intent.currency !== "BRL" ||
    intent.method !== input.method ||
    intent.installments !== input.installments
  )
    throw new PosPaymentPersistenceError(
      "A intenção capturada diverge do contexto ou da divisão de pagamento da venda.",
      409,
    );
  assertPersistedPaymentEvidence(
    intent,
    intent.status as PosPersistedPaymentState,
  );
  if (
    intent.status !== "captured" ||
    !intent.providerReference ||
    !intent.providerOccurredAt
  )
    throw new PosPaymentPersistenceError(
      "A venda só aceita intenção eletrônica capturada por evidência do provider.",
      409,
    );
  const existing = await tx.posSalePayment.findUnique({
    where: { paymentIntentId: intent.id },
  });
  if (existing) {
    if (
      existing.saleId !== input.saleId ||
      existing.idempotencyKey !== input.paymentIdempotencyKey
    )
      throw new PosPaymentPersistenceError(
        "A intenção de pagamento já foi consumida por outra venda.",
        409,
      );
    return { payment: existing, intent, replayed: true };
  }
  if (intent.consumedAt)
    throw new PosPaymentPersistenceError(
      "A intenção de pagamento já foi consumida.",
      409,
    );
  const consumedAt = new Date();
  const paymentMetadata = json({
    paymentIntentId: intent.id,
    evidenceId: intent.evidenceId,
    providerSequence: intent.providerSequence?.toString() ?? null,
    providerOccurredAt: intent.providerOccurredAt.toISOString(),
  });
  const lockedPlan = paymentPrelock.plans.find(
    (plan) => plan.id === input.paymentPlanId,
  );
  if (!lockedPlan)
    throw new PosPaymentPersistenceError(
      "O plano autoritativo do pagamento desapareceu durante o pré-lock.",
      409,
    );
  await preparePosSalePaymentWrite(tx, {
    action: "create_intent_consumption",
    id: paymentId,
    expectedVersion: lockedPlan.version,
    actorUserId: "system:pos-sale-commit",
    idempotencyKey: input.paymentIdempotencyKey,
    target: posSalePaymentWriteTarget({
      id: paymentId,
      saleId: input.saleId,
      connectorId: intent.connectorId,
      processingSessionId: input.sessionId,
      type: "payment",
      method: intent.method,
      status: "captured",
      amountCents: intent.amountCents,
      tenderedCents: intent.amountCents,
      changeCents: 0,
      provider: intent.provider,
      transactionId: intent.transactionId || intent.providerReference,
      endToEndId: intent.endToEndId,
      nsu: intent.nsu,
      authorizationCode: intent.authorizationCode,
      cardBrand: intent.cardBrand,
      cardLastFour: intent.cardLastFour,
      installments: intent.installments,
      idempotencyKey: input.paymentIdempotencyKey,
      paymentIntentId: intent.id,
      paymentPlanId: input.paymentPlanId,
      paymentIndex: input.paymentIndex,
      metadata: paymentMetadata,
      authorizedAt: intent.providerOccurredAt,
      capturedAt: intent.providerOccurredAt,
    }),
  });
  const payment = await tx.posSalePayment.create({ data: {
      id: paymentId,
      saleId: input.saleId,
      connectorId: intent.connectorId,
      paymentIntentId: intent.id,
      paymentPlanId: input.paymentPlanId,
      paymentIndex: input.paymentIndex,
      processingSessionId: input.sessionId,
      type: "payment",
      method: intent.method,
      status: "captured",
      amountCents: intent.amountCents,
      tenderedCents: intent.amountCents,
      changeCents: 0,
      provider: intent.provider,
      transactionId: intent.transactionId || intent.providerReference,
      endToEndId: intent.endToEndId,
      nsu: intent.nsu,
      authorizationCode: intent.authorizationCode,
      cardBrand: intent.cardBrand,
      cardLastFour: intent.cardLastFour,
      installments: intent.installments,
      idempotencyKey: input.paymentIdempotencyKey,
      authorizedAt: intent.providerOccurredAt,
      capturedAt: intent.providerOccurredAt,
      metadata: paymentMetadata,
    },
  });
  await prepareIntentTransition(
    tx,
    "consume",
    intent,
    `payment-consumed:${intent.id}:${input.saleId}`,
    "system:pos-sale-commit",
    { consumedAt: null, version: intent.version + 1 },
  );
  const changed = await tx.posPaymentIntent.updateMany({
    where: {
      id: intent.id,
      version: intent.version,
      status: "captured",
      consumedAt: null,
    },
    data: { consumedAt, version: { increment: 1 }, updatedAt: consumedAt },
  });
  if (changed.count !== 1)
    throw new PosPaymentPersistenceError(
      "A intenção foi consumida por outra venda.",
      409,
    );
  await tx.posPaymentStateEvent.create({
    data: {
      intentId: intent.id,
      eventKey: `payment-consumed:${intent.id}:${input.saleId}`,
      source: "sale_commit",
      sourceId: String(input.saleId),
      fromState: "captured",
      toState: "captured",
      resultingVersion: intent.version + 1,
      providerOccurredAt: intent.providerOccurredAt,
      evidenceHash: intent.evidenceId
        ? hashPosPaymentPayload({ evidenceId: intent.evidenceId })
        : null,
    },
  });
  return {
    payment,
    intent: await tx.posPaymentIntent.findUniqueOrThrow({
      where: { id: intent.id },
    }),
    replayed: false,
  };
}

export async function acceptPosPaymentCallback(
  db: RootDb,
  providerValue: string,
  eventIdValue: string,
  signatureKeyIdValue: string,
  payloadHash: string,
  input: { intentId: string } & PosProviderPaymentObservation,
) {
  const provider = providerKey(providerValue),
    eventId = pciSafeIdentifier(eventIdValue, "Evento", 8, 160),
    signatureKeyId = pciSafeIdentifier(
      signatureKeyIdValue,
      "Chave de assinatura",
      1,
      160,
    );
  const existing = await db.posPaymentCallback.findUnique({
    where: { provider_eventId: { provider, eventId } },
    include: { integrityIncident: true },
  });
  if (existing) return replayCallback(existing, payloadHash);
  return serializableRetry(db, async (tx) => {
    await lockPosPaymentIntentCanonical(tx, input.intentId);
    const concurrent = await tx.posPaymentCallback.findUnique({
      where: { provider_eventId: { provider, eventId } },
      include: { integrityIncident: true },
    });
    if (concurrent) return replayCallback(concurrent, payloadHash);
    const intent = await tx.posPaymentIntent.findUnique({
      where: { id: input.intentId },
    });
    if (!intent)
      throw new PosPaymentPersistenceError(
        "Intenção de pagamento não encontrada.",
        404,
      );
    const observation = { ...input, provider };
    let application: ObservationApplication;
    let incidentKind:
      | "callback_monetary_mismatch"
      | "consumed_evidence_mismatch"
      | "terminal_state_callback_conflict"
      | null = null;
    const monetaryMismatch =
      intent.amountCents !== input.amountCents ||
      intent.currency !== input.currency;
    const payment = intent.consumedAt
      ? await tx.posSalePayment.findUnique({
          where: { paymentIntentId: intent.id },
        })
      : null;
    if (intent.consumedAt) {
      application = {
        result: "supplemental_after_consumption",
        version: intent.version,
        state: intent.status as PosPersistedPaymentState,
        applied: false,
      };
      if (monetaryMismatch) incidentKind = "callback_monetary_mismatch";
      else if (
        !isObservationStale(intent, observation) &&
        consumedEvidenceDiverges(intent, payment, observation)
      )
        incidentKind = "consumed_evidence_mismatch";
    } else if (
      intent.provider !== provider ||
      monetaryMismatch ||
      (intent.providerReference &&
        intent.providerReference !== input.providerReference)
    ) {
      application = {
        result: "rejected_context",
        version: intent.version,
        state: intent.status as PosPersistedPaymentState,
        applied: false,
      };
      if (monetaryMismatch) incidentKind = "callback_monetary_mismatch";
    } else if (
      ["declined", "cancelled", "refunded"].includes(intent.status) &&
      input.state !== intent.status
    ) {
      application = {
        result: "rejected_transition",
        version: intent.version,
        state: intent.status as PosPersistedPaymentState,
        applied: false,
      };
      incidentKind = "terminal_state_callback_conflict";
    } else {
      assertObservationPaymentEvidence(intent, observation);
      application = await applyObservation(tx, intent, observation, {
        source: "callback",
        sourceId: eventId,
        eventKey: `payment-callback:${provider}:${eventId}`,
        evidenceHash: payloadHash,
      });
    }
    const evidence = observationEvidence(observation);
    const callback = await tx.posPaymentCallback.create({
      data: {
        intentId: intent.id,
        provider,
        eventId,
        payloadHash,
        signatureKeyId,
        providerReference: input.providerReference,
        reportedState: input.state,
        providerSequence: input.providerSequence,
        providerOccurredAt: input.occurredAt,
        amountCents: input.amountCents,
        currency: input.currency,
        evidence: json(evidence),
        processingResult: application.result,
        resultingState: application.state,
        resultingVersion: application.version,
      },
    });
    const incident = incidentKind
      ? await tx.posPaymentIntegrityIncident.create({
          data: {
            intentId: intent.id,
            callbackId: callback.id,
            kind: incidentKind,
            status: "open",
            productionBlocking: true,
            expectedAmountCents: intent.amountCents,
            reportedAmountCents: input.amountCents,
            expectedCurrency: intent.currency,
            reportedCurrency: input.currency,
            expectedEvidenceHash: hashPosPaymentPayload(
              authoritativePaymentEvidence(intent, payment),
            ),
            reportedEvidenceHash: hashPosPaymentPayload(evidence),
            details: json(
              paymentIntegrityIncidentDetails(intent, payment, observation),
            ),
          },
        })
      : null;
    await tx.tenantAuditEvent.create({
      data: {
        actorId: null,
        action: `pos.payment.callback.${application.result}`,
        entityType: "pos_payment_intent",
        entityId: intent.id,
        correlationId: randomUUID(),
        beforeData: { status: intent.status, version: intent.version },
        afterData: {
          provider,
          eventId,
          reportedState: input.state,
          resultingState: application.state,
          resultingVersion: application.version,
          payloadHash,
          providerSequence: input.providerSequence?.toString() ?? null,
          incidentId: incident?.id ?? null,
          productionBlocking: incident?.productionBlocking ?? false,
        },
      },
    });
    return {
      accepted: true,
      duplicate: false,
      applied: application.applied,
      result: application.result,
      intentId: intent.id,
      state: application.state,
      version: application.version,
      callbackId: callback.id.toString(),
      incident: incident
        ? {
            id: incident.id,
            kind: incident.kind,
            productionBlocking: incident.productionBlocking,
          }
        : null,
    };
  }).catch(async (error) => {
    if (isSerializationConflict(error) || prismaCode(error) === "P2002") {
      const concurrent = await db.posPaymentCallback.findUnique({
        where: { provider_eventId: { provider, eventId } },
        include: { integrityIncident: true },
      });
      if (concurrent) return replayCallback(concurrent, payloadHash);
    }
    if (prismaCode(error) === "P2002")
      throw new PosPaymentPersistenceError(
        "A evidência do provedor já foi vinculada a outra intenção de pagamento.",
        409,
      );
    throw error;
  });
}

export async function claimPosPaymentOutbox(
  db: RootDb,
  options: {
    workerId: string;
    limit?: number;
    leaseSeconds?: number;
    now?: Date;
  },
) {
  const workerId = pciSafeIdentifier(options.workerId, "Worker", 3, 120),
    limit = bounded(
      options.limit ?? POS_PAYMENT_WORK_LIMITS.defaultBatchSize,
      1,
      POS_PAYMENT_WORK_LIMITS.maximumBatchSize,
      "Lote",
    ),
    leaseSeconds = bounded(
      options.leaseSeconds ?? POS_PAYMENT_WORK_LIMITS.defaultLeaseSeconds,
      15,
      POS_PAYMENT_WORK_LIMITS.maximumLeaseSeconds,
      "Lease",
    ),
    now = validDate(options.now ?? new Date());
  return db.$transaction(
    async (tx) => {
      // The first lock is the aggregate's session (the canonical root). SKIP
      // LOCKED therefore avoids head-of-line blocking without ever claiming an
      // outbox/intent leaf before its parents. Dispatches in one session are
      // intentionally serialized; a second worker can claim another session.
      const candidateLimit = Math.min(1_000, Math.max(limit * 8, limit + 16));
      const rows = await tx.$queryRaw<
        Array<{ intentId: string; attemptId: string; outboxId: bigint }>
      >(Prisma.sql`
      WITH due_sessions AS MATERIALIZED (
        SELECT session."id", MIN(o."next_attempt_at") AS first_due, MIN(o."id") AS first_outbox
        FROM "cash_register_sessions" session
        JOIN "pos_payment_intents" i ON i."session_id" = session."id"
        JOIN "pos_payment_attempts" a ON a."intent_id" = i."id"
        JOIN "pos_payment_outbox" o ON o."attempt_id" = a."id"
        WHERE o."state" IN ('pending', 'retry') AND o."next_attempt_at" <= ${now}
          AND a."state" IN ('queued', 'retry')
          AND (
            (a."operation" = 'create' AND i."status" = 'created')
            OR (a."operation" = 'query' AND i."status" IN ('processing', 'authorized', 'unknown', 'manual_review'))
            OR (a."operation" = 'cancel' AND i."status" IN ('processing', 'authorized', 'unknown', 'manual_review'))
            OR (a."operation" = 'refund' AND i."status" IN ('captured', 'partially_refunded'))
          )
        GROUP BY session."id"
      ), locked_sessions AS MATERIALIZED (
        SELECT session."id"
        FROM "cash_register_sessions" session
        JOIN due_sessions due ON due."id" = session."id"
        ORDER BY due.first_due, due.first_outbox, session."id"
        FOR UPDATE OF session SKIP LOCKED
        LIMIT ${limit}
      )
      SELECT i."id" AS "intentId", a."id" AS "attemptId", o."id" AS "outboxId" FROM "pos_payment_outbox" o
      JOIN "pos_payment_attempts" a ON a."id" = o."attempt_id"
      JOIN "pos_payment_intents" i ON i."id" = a."intent_id"
      JOIN locked_sessions locked_session ON locked_session."id" = i."session_id"
      WHERE o."state" IN ('pending', 'retry') AND o."next_attempt_at" <= ${now}
        AND a."state" IN ('queued', 'retry')
        AND (
          (a."operation" = 'create' AND i."status" = 'created')
          OR (a."operation" = 'query' AND i."status" IN ('processing', 'authorized', 'unknown', 'manual_review'))
          OR (a."operation" = 'cancel' AND i."status" IN ('processing', 'authorized', 'unknown', 'manual_review'))
          OR (a."operation" = 'refund' AND i."status" IN ('captured', 'partially_refunded'))
      )
      ORDER BY o."next_attempt_at", o."id"
      LIMIT ${candidateLimit}
    `);
      const claimed: Array<ReturnType<typeof posPaymentOutboxCommand>> = [];
      for (const row of rows) {
        if (claimed.length >= limit) break;
        const authoritativeGraph = await lockPosPaymentIntentCanonical(
          tx,
          row.intentId,
        );
        await lockAttempt(tx, row.attemptId);
        await lockOutbox(tx, row.outboxId);
        const claimToken = `${workerId}:${randomUUID()}`,
          claimExpiresAt = new Date(now.valueOf() + leaseSeconds * 1_000);
        const outbox = await tx.posPaymentOutbox.findUniqueOrThrow({
          where: { id: row.outboxId },
          include: { attempt: { include: { intent: true } } },
        });
        if (
          (outbox.state !== "pending" && outbox.state !== "retry") ||
          outbox.nextAttemptAt > now ||
          !["queued", "retry"].includes(outbox.attempt.state) ||
          !operationStatusEligible(
            outbox.attempt.operation,
            outbox.attempt.intent.status,
          )
        )
          continue;
        if (outbox.attempt.operation === "create") {
          const boundaryFailure = createDispatchBoundaryFailure(
            authoritativeGraph,
            now,
          );
          if (boundaryFailure) {
            await refuseCreateDispatch(
              tx,
              outbox.attempt,
              outbox,
              boundaryFailure,
              now,
            );
            continue;
          }
        }
        const deliveryCount = outbox.deliveryCount + 1;
        if (deliveryCount > outbox.maxDeliveries) continue;
        await tx.posPaymentAttempt.update({
          where: { id: outbox.attempt.id },
          data: {
            state: "claimed",
            dispatchCount: { increment: 1 },
            startedAt: now,
            failureCode: null,
          },
        });
        await tx.posPaymentOutbox.update({
          where: { id: outbox.id },
          data: {
            state: "claimed",
            deliveryCount,
            claimToken,
            claimExpiresAt,
            lastErrorCode: null,
          },
        });
        claimed.push(
          posPaymentOutboxCommand(outbox, claimToken, claimExpiresAt),
        );
      }
      return { workerId, claimed, claimedCount: claimed.length };
    },
    { isolationLevel: "ReadCommitted", maxWait: 10_000, timeout: 30_000 },
  );
}

export async function completePosPaymentOutbox(
  db: RootDb,
  input: PosPaymentOutboxCompletion,
  nowValue = new Date(),
) {
  const now = validDate(nowValue),
    responseHash = hashPosPaymentPayload(input.result),
    claimTokenHash = hashPosPaymentPayload(input.claimToken);
  return serializableRetry(db, async (tx) => {
    const attempt = await lockPaymentGraph(tx, input.attemptId);
    const outbox = attempt.outbox;
    if (!outbox)
      throw new PosPaymentPersistenceError(
        "Tentativa do worker sem outbox.",
        409,
      );
    const deliveryReplay = await tx.posPaymentDeliveryResult.findUnique({
      where: { claimTokenHash },
    });
    if (deliveryReplay) {
      if (
        deliveryReplay.attemptId !== input.attemptId ||
        deliveryReplay.responseHash !== responseHash
      )
        throw new PosPaymentPersistenceError(
          "O claim desta entrega já foi concluído com outro conteúdo.",
          409,
        );
      return {
        replayed: true,
        retryScheduled: deliveryReplay.retryScheduled,
        superseded: deliveryReplay.superseded,
        deliveryNumber: deliveryReplay.deliveryNumber,
        intent: posPaymentIntentDto(attempt.intent),
        attempt: posPaymentAttemptDto(attempt),
      };
    }
    if (["succeeded", "unknown", "failed"].includes(attempt.state)) {
      if (attempt.responseHash !== responseHash)
        throw new PosPaymentPersistenceError(
          "A conclusão da tentativa já foi registrada com outro conteúdo.",
          409,
        );
      return {
        replayed: true,
        intent: posPaymentIntentDto(attempt.intent),
        attempt: posPaymentAttemptDto(attempt),
      };
    }
    if (
      attempt.state !== "claimed" ||
      outbox.state !== "claimed" ||
      outbox.claimToken !== input.claimToken ||
      !outbox.claimExpiresAt ||
      outbox.claimExpiresAt <= now
    )
      throw new PosPaymentPersistenceError(
        "O claim expirou ou pertence a outro worker.",
        409,
      );
    const intent = attempt.intent;
    if (!operationStatusEligible(attempt.operation, intent.status)) {
      await tx.posPaymentAttempt.update({
        where: { id: attempt.id },
        data: {
          state: "failed",
          responseHash,
          failureCode: "intent_state_advanced",
          finishedAt: now,
        },
      });
      await tx.posPaymentOutbox.update({
        where: { id: outbox.id },
        data: {
          state: "completed",
          claimToken: null,
          claimExpiresAt: null,
          completedAt: now,
          lastErrorCode: "intent_state_advanced",
        },
      });
      await recordPosPaymentDeliveryResult(
        tx,
        attempt,
        input,
        claimTokenHash,
        responseHash,
        {
          retryScheduled: false,
          superseded: true,
          attemptState: "failed",
          intent,
        },
      );
      return {
        replayed: false,
        retryScheduled: false,
        superseded: true,
        deliveryNumber: outbox.deliveryCount,
        intent: posPaymentIntentDto(intent),
        attempt: posPaymentAttemptDto({
          ...attempt,
          state: "failed",
          failureCode: "intent_state_advanced",
          finishedAt: now,
        }),
      };
    }
    if (input.result.kind === "known_failure") {
      const retry =
        input.result.retryable && outbox.deliveryCount < outbox.maxDeliveries;
      await tx.posPaymentAttempt.update({
        where: { id: attempt.id },
        data: retry
          ? {
              state: "retry",
              failureCode: input.result.failureCode,
              startedAt: null,
            }
          : {
              state: "failed",
              failureCode: input.result.failureCode,
              responseHash,
              finishedAt: now,
            },
      });
      await tx.posPaymentOutbox.update({
        where: { id: outbox.id },
        data: retry
          ? {
              state: "retry",
              claimToken: null,
              claimExpiresAt: null,
              nextAttemptAt: new Date(
                now.valueOf() + retryDelayMs(outbox.deliveryCount),
              ),
              lastErrorCode: input.result.failureCode,
            }
          : {
              state: "dead",
              claimToken: null,
              claimExpiresAt: null,
              completedAt: now,
              lastErrorCode: input.result.failureCode,
            },
      });
      let current = intent;
      if (
        !retry &&
        ![
          "captured",
          "declined",
          "cancelled",
          "partially_refunded",
          "refunded",
        ].includes(intent.status)
      )
        current = await forceManualReview(
          tx,
          intent,
          attempt.id,
          input.result.failureCode,
          now,
        );
      await recordPosPaymentDeliveryResult(
        tx,
        attempt,
        input,
        claimTokenHash,
        responseHash,
        {
          retryScheduled: retry,
          superseded: false,
          attemptState: retry ? "retry" : "failed",
          intent: current,
        },
      );
      return {
        replayed: false,
        retryScheduled: retry,
        deliveryNumber: outbox.deliveryCount,
        intent: posPaymentIntentDto(current),
        attempt: posPaymentAttemptDto({
          ...attempt,
          state: retry ? "retry" : "failed",
          failureCode: input.result.failureCode,
          finishedAt: retry ? null : now,
        }),
      };
    }
    if (input.result.kind === "unknown") {
      await tx.posPaymentAttempt.update({
        where: { id: attempt.id },
        data: {
          state: "unknown",
          outcomeUnknown: true,
          responseHash,
          failureCode: input.result.failureCode,
          finishedAt: now,
        },
      });
      await tx.posPaymentOutbox.update({
        where: { id: outbox.id },
        data: {
          state: "completed",
          claimToken: null,
          claimExpiresAt: null,
          completedAt: now,
          lastErrorCode: input.result.failureCode,
        },
      });
      const observation: PosPaymentObservation = {
        provider: intent.provider,
        providerReference: null,
        state: "unknown",
        amountCents: intent.amountCents,
        currency: "BRL",
        providerSequence: null,
        occurredAt: null,
        evidenceId: null,
        transactionId: intent.transactionId,
        endToEndId: intent.endToEndId,
        nsu: intent.nsu,
        authorizationCode: intent.authorizationCode,
        cardBrand: intent.cardBrand,
        cardLastFour: intent.cardLastFour,
        failureCode: input.result.failureCode,
        failureMessage: input.result.failureMessage,
      };
      await applyObservation(tx, intent, observation, {
        source: "worker",
        sourceId: attempt.id,
        eventKey: `payment-attempt:${attempt.id}`,
        attemptId: attempt.id,
        evidenceHash: responseHash,
      });
      const current = await tx.posPaymentIntent.findUniqueOrThrow({
        where: { id: intent.id },
      });
      await recordPosPaymentDeliveryResult(
        tx,
        attempt,
        input,
        claimTokenHash,
        responseHash,
        {
          retryScheduled: false,
          superseded: false,
          attemptState: "unknown",
          intent: current,
        },
      );
      return {
        replayed: false,
        retryScheduled: false,
        deliveryNumber: outbox.deliveryCount,
        intent: posPaymentIntentDto(current),
        attempt: posPaymentAttemptDto({
          ...attempt,
          state: "unknown",
          outcomeUnknown: true,
          failureCode: input.result.failureCode,
          finishedAt: now,
        }),
      };
    }
    const observation = input.result;
    if (
      observation.provider !== intent.provider ||
      observation.amountCents !== intent.amountCents ||
      observation.currency !== intent.currency ||
      (intent.providerReference &&
        intent.providerReference !== observation.providerReference)
    )
      throw new PosPaymentPersistenceError(
        "O resultado do boundary diverge da intenção persistida.",
        409,
      );
    await tx.posPaymentAttempt.update({
      where: { id: attempt.id },
      data: { state: "succeeded", responseHash, finishedAt: now },
    });
    await tx.posPaymentOutbox.update({
      where: { id: outbox.id },
      data: {
        state: "completed",
        claimToken: null,
        claimExpiresAt: null,
        completedAt: now,
      },
    });
    const applied = await applyObservation(tx, intent, observation, {
      source: "worker",
      sourceId: attempt.id,
      eventKey: `payment-attempt:${attempt.id}`,
      attemptId: attempt.id,
      evidenceHash: responseHash,
    });
    await persistPaymentArtifacts(tx, intent.id, observation.artifacts || []);
    const current = applied.applied
      ? await tx.posPaymentIntent.findUniqueOrThrow({
          where: { id: intent.id },
        })
      : intent;
    await recordPosPaymentDeliveryResult(
      tx,
      attempt,
      input,
      claimTokenHash,
      responseHash,
      {
        retryScheduled: false,
        superseded: false,
        attemptState: "succeeded",
        intent: current,
      },
    );
    return {
      replayed: false,
      retryScheduled: false,
      deliveryNumber: outbox.deliveryCount,
      intent: posPaymentIntentDto(current),
      attempt: posPaymentAttemptDto({
        ...attempt,
        state: "succeeded",
        finishedAt: now,
      }),
    };
  }).catch((error) => {
    if (prismaCode(error) === "P2002")
      throw new PosPaymentPersistenceError(
        "A evidência do provedor já foi vinculada a outra intenção de pagamento.",
        409,
      );
    throw error;
  });
}

async function persistPaymentArtifacts(
  tx: Prisma.TransactionClient,
  intentId: string,
  artifacts: NonNullable<PosPaymentObservation["artifacts"]>,
) {
  for (const artifact of artifacts)
    await tx.posPaymentArtifact.upsert({
      where: { intentId_kind: { intentId, kind: artifact.kind } },
      update: {
        valueCipher: encryptSecret(artifact.value),
        displayText: artifact.displayText,
        expiresAt: artifact.expiresAt,
        status: "active",
      },
      create: {
        intentId,
        kind: artifact.kind,
        valueCipher: encryptSecret(artifact.value),
        displayText: artifact.displayText,
        expiresAt: artifact.expiresAt,
      },
    });
}

function paymentArtifacts(
  value: unknown,
): NonNullable<PosPaymentObservation["artifacts"]> {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 4)
    throw new PosPaymentPersistenceError(
      "Artefatos de pagamento inválidos.",
      400,
    );
  return value.map((raw) => {
    const item = record(raw, "Artefato"),
      kind = choice(
        item.kind,
        [
          "pix_copy_paste",
          "pix_qr_url",
          "payment_link",
          "terminal_instruction",
        ] as const,
        "Tipo do artefato",
      ),
      content = String(item.value || "").trim();
    onlyKeys(item, ["kind", "value", "displayText", "expiresAt"]);
    if (
      !content ||
      content.length > 8192 ||
      (["pix_qr_url", "payment_link"].includes(kind) &&
        !/^https:\/\//i.test(content))
    )
      throw new PosPaymentPersistenceError(
        "Conteúdo do artefato de pagamento inválido.",
        400,
      );
    return {
      kind,
      value: content,
      displayText:
        item.displayText == null
          ? null
          : nullableText(item.displayText, "Descrição do artefato", 160),
      expiresAt:
        item.expiresAt == null
          ? null
          : futureDate(item.expiresAt, "Expiração do artefato"),
    };
  });
}

async function refuseCreateDispatch(
  tx: Prisma.TransactionClient,
  attempt: Prisma.PosPaymentAttemptGetPayload<{ include: { intent: true } }>,
  outbox: Prisma.PosPaymentOutboxGetPayload<object>,
  boundaryFailure: string,
  now: Date,
) {
  if (attempt.operation !== "create" || attempt.intent.status !== "created")
    return;
  const evidenceHash = hashPosPaymentPayload({
    intentId: attempt.intent.id,
    attemptId: attempt.id,
    boundaryFailure,
    evaluatedAt: now.toISOString(),
  });
  if (
    attempt.dispatchCount === 0 &&
    !attempt.outcomeUnknown &&
    !attempt.startedAt
  ) {
    await tx.posPaymentAttempt.update({
      where: { id: attempt.id },
      data: {
        state: "failed",
        failureCode: "expired_before_dispatch",
        responseHash: evidenceHash,
        finishedAt: now,
      },
    });
    await tx.posPaymentOutbox.update({
      where: { id: outbox.id },
      data: {
        state: "dead",
        claimToken: null,
        claimExpiresAt: null,
        completedAt: now,
        lastErrorCode: "expired_before_dispatch",
      },
    });
    const failureMessage = `Dispatch recusado pelo boundary autoritativo: ${boundaryFailure}.`;
    await prepareIntentTransition(
      tx,
      "expire_before_dispatch",
      attempt.intent,
      `payment-dispatch-refused:${attempt.id}`,
      "system:pos-payment-worker",
      {
        status: "cancelled",
        version: attempt.intent.version + 1,
        failureCode: "expired_before_dispatch",
        failureMessage,
      },
    );
    const changed = await tx.posPaymentIntent.updateMany({
      where: {
        id: attempt.intent.id,
        version: attempt.intent.version,
        status: "created",
      },
      data: {
        status: "cancelled",
        version: { increment: 1 },
        failureCode: "expired_before_dispatch",
        failureMessage,
      },
    });
    if (changed.count !== 1)
      throw new PosPaymentPersistenceError(
        "A intenção mudou durante a recusa segura de dispatch.",
        409,
      );
    await tx.posPaymentStateEvent.create({
      data: {
        intentId: attempt.intent.id,
        attemptId: attempt.id,
        eventKey: `payment-dispatch-refused:${attempt.id}`,
        source: "maintenance",
        sourceId: boundaryFailure,
        fromState: "created",
        toState: "cancelled",
        resultingVersion: attempt.intent.version + 1,
        evidenceHash,
      },
    });
    return;
  }
  await tx.posPaymentAttempt.update({
    where: { id: attempt.id },
    data: {
      state: "unknown",
      outcomeUnknown: true,
      failureCode: "boundary_invalid_after_dispatch",
      responseHash: evidenceHash,
      finishedAt: now,
    },
  });
  await tx.posPaymentOutbox.update({
    where: { id: outbox.id },
    data: {
      state: "dead",
      claimToken: null,
      claimExpiresAt: null,
      completedAt: now,
      lastErrorCode: "boundary_invalid_after_dispatch",
    },
  });
  await applyObservation(
    tx,
    attempt.intent,
    {
      provider: attempt.intent.provider,
      providerReference: attempt.intent.providerReference,
      state: "unknown",
      amountCents: attempt.intent.amountCents,
      currency: attempt.intent.currency,
      providerSequence: attempt.intent.providerSequence,
      occurredAt: attempt.intent.providerOccurredAt,
      evidenceId: attempt.intent.evidenceId,
      transactionId: attempt.intent.transactionId,
      endToEndId: attempt.intent.endToEndId,
      nsu: attempt.intent.nsu,
      authorizationCode: attempt.intent.authorizationCode,
      cardBrand: attempt.intent.cardBrand,
      cardLastFour: attempt.intent.cardLastFour,
      failureCode: "boundary_invalid_after_dispatch",
      failureMessage: `Novo dispatch recusado após tentativa anterior: ${boundaryFailure}.`,
    },
    {
      source: "worker",
      sourceId: attempt.id,
      eventKey: `payment-dispatch-unknown:${attempt.id}`,
      attemptId: attempt.id,
      evidenceHash,
    },
  );
}

export async function maintainPosPaymentPersistence(
  db: RootDb,
  options: { now?: Date; batchSize?: number; correlationId?: string } = {},
) {
  const now = validDate(options.now ?? new Date()),
    batchSize = bounded(
      options.batchSize ?? POS_PAYMENT_WORK_LIMITS.defaultBatchSize,
      1,
      POS_PAYMENT_WORK_LIMITS.maximumBatchSize,
      "Lote",
    ),
    correlationId = options.correlationId
      ? pciSafeIdentifier(options.correlationId, "Correlação", 1, 160)
      : randomUUID();
  return serializableRetry(db, async (tx) => {
    const [lock] = await tx.$queryRaw<Array<{ acquired: boolean }>>(
      Prisma.sql`SELECT pg_try_advisory_xact_lock(hashtextextended('nalven:pos-payment-maintenance', 0)) AS "acquired"`,
    );
    if (!lock?.acquired)
      return {
        correlationId,
        obsoleteOutboxes: 0,
        expiredBeforeDispatch: 0,
        recoveredLeases: 0,
        uncertainLeases: 0,
        supersededLeases: 0,
        scheduledQueries: 0,
        expiredPaymentPlans: 0,
        blockedExpiredPaymentPlans: 0,
        skippedConcurrent: 1,
        remainingObsoleteOutboxes: 0,
        remainingExpiredCreates: 0,
        remainingExpiredClaims: 0,
        remainingDueIntents: 0,
        remainingExpiredPaymentPlans: 0,
        remainingBlockedExpiredPaymentPlans: 0,
        hasMore: true,
      };
    const changedIntentIds = new Set<string>();
    const obsoleteRows = await tx.$queryRaw<
      Array<{ attemptId: string }>
    >(Prisma.sql`
      SELECT a."id" AS "attemptId" FROM "pos_payment_outbox" o
      JOIN "pos_payment_attempts" a ON a."id" = o."attempt_id"
      JOIN "pos_payment_intents" i ON i."id" = a."intent_id"
      WHERE o."state" IN ('pending', 'retry') AND NOT (
        (a."operation" = 'create' AND i."status" = 'created')
        OR (a."operation" = 'query' AND i."status" IN ('processing', 'authorized', 'unknown', 'manual_review'))
        OR (a."operation" = 'cancel' AND i."status" IN ('processing', 'authorized', 'unknown', 'manual_review'))
        OR (a."operation" = 'refund' AND i."status" IN ('captured', 'partially_refunded'))
      )
      ORDER BY o."id" LIMIT ${batchSize}
    `);
    let obsoleteOutboxes = 0;
    for (const row of obsoleteRows) {
      const attempt = await lockPaymentGraph(tx, row.attemptId),
        outbox = attempt.outbox!;
      if (
        !["pending", "retry"].includes(outbox.state) ||
        operationStatusEligible(attempt.operation, attempt.intent.status)
      )
        continue;
      await tx.posPaymentAttempt.update({
        where: { id: attempt.id },
        data: {
          state: "failed",
          failureCode: "intent_state_advanced",
          finishedAt: now,
        },
      });
      await tx.posPaymentOutbox.update({
        where: { id: outbox.id },
        data: {
          state: "dead",
          completedAt: now,
          lastErrorCode: "intent_state_advanced",
        },
      });
      obsoleteOutboxes += 1;
    }
    const expiredCreates = await tx.posPaymentOutbox.findMany({
      where: {
        state: { in: ["pending", "retry"] },
        attempt: {
          operation: "create",
          state: { in: ["queued", "retry"] },
          intent: { status: "created", expiresAt: { lte: now } },
        },
      },
      include: { attempt: { include: { intent: true } } },
      orderBy: { id: "asc" },
      take: batchSize,
    });
    let expiredBeforeDispatch = 0;
    for (const candidate of expiredCreates) {
      const attempt = await lockPaymentGraph(tx, candidate.attemptId),
        outbox = attempt.outbox!,
        intent = attempt.intent;
      if (
        (outbox.state !== "pending" && outbox.state !== "retry") ||
        attempt.operation !== "create" ||
        !["queued", "retry"].includes(attempt.state) ||
        intent.status !== "created" ||
        intent.expiresAt > now
      )
        continue;
      await tx.posPaymentAttempt.update({
        where: { id: attempt.id },
        data: {
          state: "failed",
          failureCode: "expired_before_dispatch",
          finishedAt: now,
        },
      });
      await tx.posPaymentOutbox.update({
        where: { id: outbox.id },
        data: {
          state: "dead",
          completedAt: now,
          lastErrorCode: "expired_before_dispatch",
        },
      });
      await prepareIntentTransition(
        tx,
        "expire_before_dispatch",
        intent,
        `payment-expired:${attempt.id}`,
        "system:pos-payment-maintenance",
        {
          status: "cancelled",
          version: intent.version + 1,
          failureCode: "expired_before_dispatch",
          failureMessage: "A intenção expirou antes do primeiro dispatch.",
        },
      );
      const changed = await tx.posPaymentIntent.updateMany({
        where: { id: intent.id, version: intent.version, status: "created" },
        data: {
          status: "cancelled",
          version: { increment: 1 },
          failureCode: "expired_before_dispatch",
          failureMessage: "A intenção expirou antes do primeiro dispatch.",
        },
      });
      if (changed.count !== 1)
        throw new PosPaymentPersistenceError(
          "A intenção expirou durante outra operação.",
          409,
        );
      await tx.posPaymentStateEvent.create({
        data: {
          intentId: intent.id,
          attemptId: attempt.id,
          eventKey: `payment-expired:${attempt.id}`,
          source: "maintenance",
          sourceId: correlationId,
          fromState: "created",
          toState: "cancelled",
          resultingVersion: intent.version + 1,
        },
      });
      expiredBeforeDispatch += 1;
    }
    const expiredClaims = await tx.posPaymentOutbox.findMany({
      where: { state: "claimed", claimExpiresAt: { lte: now } },
      include: { attempt: { include: { intent: true } } },
      orderBy: { claimExpiresAt: "asc" },
      take: batchSize,
    });
    let recoveredLeases = 0,
      uncertainLeases = 0,
      supersededLeases = 0;
    for (const candidate of expiredClaims) {
      const attempt = await lockPaymentGraph(tx, candidate.attemptId),
        outbox = attempt.outbox!,
        intent = attempt.intent;
      if (
        outbox.state !== "claimed" ||
        attempt.state !== "claimed" ||
        !outbox.claimExpiresAt ||
        outbox.claimExpiresAt > now
      )
        continue;
      const superseded = !operationStatusEligible(
        attempt.operation,
        intent.status,
      );
      const dead =
        outbox.deliveryCount >= outbox.maxDeliveries ||
        (attempt.operation === "create" && intent.expiresAt <= now);
      if (superseded) {
        await tx.posPaymentAttempt.update({
          where: { id: attempt.id },
          data: {
            state: "failed",
            failureCode: "intent_state_advanced",
            finishedAt: now,
          },
        });
        await tx.posPaymentOutbox.update({
          where: { id: outbox.id },
          data: {
            state: "completed",
            claimToken: null,
            claimExpiresAt: null,
            completedAt: now,
            lastErrorCode: "intent_state_advanced",
          },
        });
        supersededLeases += 1;
      } else if (dead) {
        await tx.posPaymentAttempt.update({
          where: { id: attempt.id },
          data: {
            state: "unknown",
            outcomeUnknown: true,
            failureCode: "lease_outcome_unknown",
            finishedAt: now,
          },
        });
        await tx.posPaymentOutbox.update({
          where: { id: outbox.id },
          data: {
            state: "dead",
            claimToken: null,
            claimExpiresAt: null,
            completedAt: now,
            lastErrorCode: "lease_outcome_unknown",
          },
        });
        const observation: PosPaymentObservation = {
          provider: intent.provider,
          providerReference: null,
          state: "unknown",
          amountCents: intent.amountCents,
          currency: "BRL",
          providerSequence: null,
          occurredAt: null,
          evidenceId: null,
          transactionId: intent.transactionId,
          endToEndId: intent.endToEndId,
          nsu: intent.nsu,
          authorizationCode: intent.authorizationCode,
          cardBrand: intent.cardBrand,
          cardLastFour: intent.cardLastFour,
          failureCode: "lease_outcome_unknown",
          failureMessage: "O worker perdeu o lease sem resultado conclusivo.",
        };
        await applyObservation(tx, intent, observation, {
          source: "worker",
          sourceId: attempt.id,
          eventKey: `payment-lease-unknown:${attempt.id}`,
          attemptId: attempt.id,
          evidenceHash: hashPosPaymentPayload({
            attemptId: attempt.id,
            result: "lease_outcome_unknown",
          }),
        });
        changedIntentIds.add(intent.id);
        uncertainLeases += 1;
      } else {
        await tx.posPaymentAttempt.update({
          where: { id: attempt.id },
          data: {
            state: "retry",
            failureCode: "lease_expired",
            startedAt: null,
          },
        });
        await tx.posPaymentOutbox.update({
          where: { id: outbox.id },
          data: {
            state: "retry",
            claimToken: null,
            claimExpiresAt: null,
            nextAttemptAt: now,
            lastErrorCode: "lease_expired",
          },
        });
      }
      recoveredLeases += 1;
    }
    const due = await tx.posPaymentIntent.findMany({
      where: {
        status: { in: [...POS_PAYMENT_UNCERTAIN_STATES] },
        nextReconcileAt: { lte: now },
        attempts: {
          none: {
            operation: "query",
            outbox: { state: { in: ["pending", "claimed", "retry"] } },
          },
        },
      },
      orderBy: [{ nextReconcileAt: "asc" }, { id: "asc" }],
      take: batchSize,
    });
    let scheduledQueries = 0;
    for (const intent of due) {
      if (changedIntentIds.has(intent.id)) continue;
      await lockPosPaymentIntentCanonical(tx, intent.id);
      const current = await tx.posPaymentIntent.findUniqueOrThrow({
        where: { id: intent.id },
      });
      if (
        !POS_PAYMENT_UNCERTAIN_STATES.includes(current.status as never) ||
        !current.nextReconcileAt ||
        current.nextReconcileAt > now
      )
        continue;
      const latest = await tx.posPaymentAttempt.findFirst({
        where: { intentId: current.id },
        orderBy: { sequence: "desc" },
        select: { sequence: true },
      });
      const sequence = (latest?.sequence ?? 0) + 1,
        attemptId = randomUUID(),
        operationKey = `payment-query:${createHash("sha256").update(`${current.id}:${current.version}:${sequence}`).digest("hex").slice(0, 48)}`;
      const nextReconcileAt = new Date(now.valueOf() + retryDelayMs(sequence));
      await prepareIntentTransition(
        tx,
        "schedule_reconcile",
        current,
        operationKey,
        "system:pos-payment-maintenance",
        { version: current.version + 1, nextReconcileAt },
      );
      const changed = await tx.posPaymentIntent.updateMany({
        where: {
          id: current.id,
          version: current.version,
          status: current.status,
        },
        data: { version: { increment: 1 }, nextReconcileAt },
      });
      if (changed.count !== 1) continue;
      await tx.posPaymentAttempt.create({
        data: {
          id: attemptId,
          intentId: current.id,
          sequence,
          operation: "query",
          operationKey,
          requestHash: hashPosPaymentPayload({
            intentId: current.id,
            version: current.version,
            sequence,
            operation: "query",
          }),
          providerIdempotencyKey: operationKey,
          outbox: { create: { nextAttemptAt: now } },
        },
      });
      await tx.posPaymentStateEvent.create({
        data: {
          intentId: current.id,
          attemptId,
          eventKey: `payment-maintenance:${current.id}:${current.version + 1}`,
          source: "maintenance",
          sourceId: correlationId,
          fromState: current.status,
          toState: current.status,
          resultingVersion: current.version + 1,
        },
      });
      scheduledQueries += 1;
    }
    const [databaseClock] = await tx.$queryRaw<Array<{ now: Date }>>(
      Prisma.sql`SELECT clock_timestamp() AS "now"`,
    );
    const paymentPlanNow = databaseClock?.now ?? new Date();
    // Blocked evidence must not consume the bounded batch window: otherwise the
    // same oldest plans can starve every safely releasable plan behind them.
    // The canonical lock plus releasableExpiredPlanIntent below remains the
    // final authority against changes after this candidate snapshot.
    const releasableExpiredPlanFilter = Prisma.sql`
      plan."state" IN ('quoted', 'active') AND plan."expires_at" <= ${paymentPlanNow}
        AND NOT EXISTS (SELECT 1 FROM "pos_manual_payment_references" manual WHERE manual."payment_plan_id" = plan."id")
        AND NOT EXISTS (SELECT 1 FROM "pos_sale_payments" payment WHERE payment."payment_plan_id" = plan."id")
        AND NOT EXISTS (
          SELECT 1 FROM "pos_payment_intents" intent
          WHERE intent."payment_plan_id" = plan."id" AND NOT (
            (
              intent."status" = 'cancelled' AND intent."provider_reference" IS NULL
              AND intent."provider_occurred_at" IS NULL AND intent."unknown_since" IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM "pos_payment_attempts" attempt
                LEFT JOIN "pos_payment_outbox" outbox ON outbox."attempt_id" = attempt."id"
                WHERE attempt."intent_id" = intent."id" AND (
                  outbox."id" IS NULL OR NOT COALESCE((
                    attempt."state" = 'failed' AND attempt."dispatch_count" = 0 AND attempt."started_at" IS NULL
                    AND attempt."finished_at" IS NOT NULL AND attempt."outcome_unknown" = false
                    AND attempt."failure_code" IN ('operator_cancelled_before_dispatch', 'expired_before_dispatch')
                    AND outbox."state" IN ('dead', 'completed') AND outbox."delivery_count" = 0 AND outbox."claim_token" IS NULL
                  ), false)
                )
              )
              AND NOT EXISTS (
                SELECT 1 FROM "pos_payment_callbacks" callback WHERE callback."intent_id" = intent."id"
                  AND callback."reported_state" IN ('authorized', 'captured', 'unknown', 'manual_review', 'partially_refunded', 'refunded')
              )
            ) OR (
              intent."status" = 'declined' AND intent."consumed_at" IS NULL AND intent."unknown_since" IS NULL
              AND (
                EXISTS (
                  SELECT 1 FROM "pos_payment_attempts" attempt
                  JOIN "pos_payment_outbox" outbox ON outbox."attempt_id" = attempt."id"
                  JOIN "pos_payment_delivery_results" delivery ON delivery."attempt_id" = attempt."id" AND delivery."intent_id" = intent."id"
                  WHERE attempt."intent_id" = intent."id" AND attempt."state" = 'succeeded' AND attempt."outcome_unknown" = false
                    AND outbox."state" = 'completed' AND outbox."claim_token" IS NULL AND delivery."result_kind" = 'result'
                    AND delivery."resulting_intent_state" = 'declined' AND delivery."superseded" = false
                ) OR EXISTS (
                  SELECT 1 FROM "pos_payment_callbacks" callback
                  WHERE callback."intent_id" = intent."id" AND callback."provider" = intent."provider"
                    AND callback."reported_state" = 'declined' AND callback."resulting_state" = 'declined'
                    AND callback."resulting_version" = intent."version" AND callback."processing_result" = 'applied'
                    AND callback."amount_cents" = intent."amount_cents" AND callback."currency" = intent."currency"
                    AND NOT EXISTS (
                      SELECT 1 FROM "pos_payment_integrity_incidents" incident
                      WHERE incident."callback_id" = callback."id" AND incident."production_blocking" = true
                    )
                )
              )
              AND NOT EXISTS (
                SELECT 1 FROM "pos_payment_attempts" attempt
                LEFT JOIN "pos_payment_outbox" outbox ON outbox."attempt_id" = attempt."id"
                WHERE attempt."intent_id" = intent."id" AND (
                  attempt."outcome_unknown" IS DISTINCT FROM false OR attempt."state" NOT IN ('succeeded', 'failed')
                  OR outbox."id" IS NULL OR outbox."state" NOT IN ('completed', 'dead') OR outbox."claim_token" IS NOT NULL
                )
              )
              AND NOT EXISTS (
                SELECT 1 FROM "pos_payment_callbacks" callback WHERE callback."intent_id" = intent."id"
                  AND callback."reported_state" IN ('authorized', 'captured', 'unknown', 'manual_review', 'partially_refunded', 'refunded')
              )
            )
          )
        )
    `;
    const expiredPlanCandidates = await tx.$queryRaw<
      Array<{ id: string }>
    >(Prisma.sql`
      SELECT plan."id"
      FROM "pos_payment_plans" plan
      WHERE ${releasableExpiredPlanFilter}
      ORDER BY plan."expires_at", plan."id"
      LIMIT ${batchSize}
    `);
    let expiredPaymentPlans = 0,
      blockedExpiredPaymentPlans = 0;
    for (const candidate of expiredPlanCandidates) {
      const releaseLocator = await tx.posPaymentPlan.findUnique({
        where: { id: candidate.id },
        select: { id: true, state: true, version: true, expiresAt: true },
      });
      if (
        !releaseLocator ||
        !["quoted", "active"].includes(releaseLocator.state) ||
        releaseLocator.expiresAt > paymentPlanNow
      )
        continue;
      const idempotencyKey = `payment-plan-expire:${hashPosPaymentPayload({ planId: releaseLocator.id, expectedVersion: releaseLocator.version })}`;
      await tx.$executeRawUnsafe("SAVEPOINT pos_payment_plan_expire_candidate");
      let requestHash: string;
      try {
        requestHash = await preparePosPaymentPlanGraphWrite(tx, {
          action: "expire",
          planId: releaseLocator.id,
          expectedVersion: releaseLocator.version,
          actorUserId: "system:pos-payment-maintenance",
          idempotencyKey,
          targetPlan: JSON.parse(
            JSON.stringify({
              id: releaseLocator.id,
              state: "expired",
              version: releaseLocator.version + 1,
              consumedSaleId: null,
            }),
          ) as Prisma.InputJsonObject,
          quoteLines: [],
          slots: [],
        });
      } catch (error) {
        await tx.$executeRawUnsafe(
          "ROLLBACK TO SAVEPOINT pos_payment_plan_expire_candidate",
        );
        await tx.$executeRawUnsafe(
          "RELEASE SAVEPOINT pos_payment_plan_expire_candidate",
        );
        if (postgresErrorCode(error) === "23514") {
          blockedExpiredPaymentPlans += 1;
          continue;
        }
        throw error;
      }
      await tx.posPaymentPlanOperation.create({
        data: {
          planId: releaseLocator.id,
          action: "expire",
          expectedVersion: releaseLocator.version,
          resultingVersion: releaseLocator.version + 1,
          resultingState: "expired",
          idempotencyKey,
          requestHash,
          actorUserId: "system:pos-payment-maintenance",
        },
      });
      const changed = await tx.posPaymentPlan.updateMany({
        where: {
          id: releaseLocator.id,
          state: releaseLocator.state,
          version: releaseLocator.version,
        },
        data: { state: "expired", version: { increment: 1 } },
      });
      if (changed.count !== 1)
        throw new PosPaymentPersistenceError(
          "O plano mudou durante a expiração segura.",
          409,
        );
      await tx.$executeRawUnsafe(
        "RELEASE SAVEPOINT pos_payment_plan_expire_candidate",
      );
      expiredPaymentPlans += 1;
    }
    const [
      remainingClaims,
      remainingDue,
      remainingExpiredCreates,
      [remainingExpiredPlanWork],
      remainingExpiredPlanTotal,
      [remainingObsolete],
    ] = await Promise.all([
      tx.posPaymentOutbox.count({
        where: { state: "claimed", claimExpiresAt: { lte: now } },
      }),
      tx.posPaymentIntent.count({
        where: {
          status: { in: [...POS_PAYMENT_UNCERTAIN_STATES] },
          nextReconcileAt: { lte: now },
        },
      }),
      tx.posPaymentOutbox.count({
        where: {
          state: { in: ["pending", "retry"] },
          attempt: {
            operation: "create",
            state: { in: ["queued", "retry"] },
            intent: { status: "created", expiresAt: { lte: now } },
          },
        },
      }),
      tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
        SELECT COUNT(*)::int AS "count" FROM "pos_payment_plans" plan WHERE ${releasableExpiredPlanFilter}
      `),
      tx.posPaymentPlan.count({
        where: {
          state: { in: ["quoted", "active"] },
          expiresAt: { lte: paymentPlanNow },
        },
      }),
      tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
        SELECT COUNT(*)::int AS "count" FROM "pos_payment_outbox" o
        JOIN "pos_payment_attempts" a ON a."id" = o."attempt_id"
        JOIN "pos_payment_intents" i ON i."id" = a."intent_id"
        WHERE o."state" IN ('pending', 'retry') AND NOT (
          (a."operation" = 'create' AND i."status" = 'created')
          OR (a."operation" = 'query' AND i."status" IN ('processing', 'authorized', 'unknown', 'manual_review'))
          OR (a."operation" = 'cancel' AND i."status" IN ('processing', 'authorized', 'unknown', 'manual_review'))
          OR (a."operation" = 'refund' AND i."status" IN ('captured', 'partially_refunded'))
        )
      `),
    ]);
    const remainingExpiredPaymentPlans = remainingExpiredPlanWork?.count ?? 0;
    const result = {
      correlationId,
      obsoleteOutboxes,
      expiredBeforeDispatch,
      recoveredLeases,
      uncertainLeases,
      supersededLeases,
      scheduledQueries,
      expiredPaymentPlans,
      blockedExpiredPaymentPlans,
      skippedConcurrent: 0,
      remainingObsoleteOutboxes: remainingObsolete?.count ?? 0,
      remainingExpiredCreates,
      remainingExpiredClaims: remainingClaims,
      remainingDueIntents: remainingDue,
      remainingExpiredPaymentPlans,
      remainingBlockedExpiredPaymentPlans: Math.max(
        0,
        remainingExpiredPlanTotal - remainingExpiredPaymentPlans,
      ),
      hasMore:
        (remainingObsolete?.count ?? 0) > 0 ||
        remainingExpiredCreates > 0 ||
        remainingClaims > 0 ||
        remainingDue > 0 ||
        remainingExpiredPaymentPlans > 0,
    };
    await tx.tenantAuditEvent.create({
      data: {
        actorId: null,
        action: "pos.payment.persistence.maintenance",
        entityType: "pos_payment_worker",
        entityId: correlationId,
        correlationId,
        afterData: result,
      },
    });
    return result;
  });
}

export function posPaymentIntentDto(intent: {
  id: string;
  branchId: number;
  registerId: number;
  sessionId: number;
  operatorProfileId: number;
  terminalId: string | null;
  connectorId: string;
  saleDraftId: string;
  paymentIndex: number;
  status: string;
  version: number;
  amountCents: number;
  currency: string;
  method: string;
  installments: number;
  provider: string;
  providerReference: string | null;
  transactionId: string | null;
  endToEndId: string | null;
  nsu: string | null;
  authorizationCode: string | null;
  cardBrand: string | null;
  cardLastFour: string | null;
  evidenceId: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  providerSequence: bigint | null;
  providerOccurredAt: Date | null;
  unknownSince: Date | null;
  nextReconcileAt: Date | null;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  attempts?: Array<{
    id: string;
    sequence: number;
    operation: string;
    state: string;
    outcomeUnknown: boolean;
    failureCode: string | null;
    createdAt: Date;
    finishedAt: Date | null;
  }>;
  stateEvents?: Array<{
    id: bigint;
    fromState: string | null;
    toState: string;
    source: string;
    resultingVersion: number;
    providerOccurredAt: Date | null;
    createdAt: Date;
  }>;
}) {
  return {
    id: intent.id,
    branchId: intent.branchId,
    registerId: intent.registerId,
    sessionId: intent.sessionId,
    operatorProfileId: intent.operatorProfileId,
    terminalId: intent.terminalId,
    connectorId: intent.connectorId,
    saleDraftId: intent.saleDraftId,
    paymentIndex: intent.paymentIndex,
    status: intent.status,
    version: intent.version,
    amountCents: intent.amountCents,
    currency: intent.currency,
    method: intent.method,
    installments: intent.installments,
    provider: intent.provider,
    providerReference: intent.providerReference,
    transactionId: intent.transactionId,
    endToEndId: intent.endToEndId,
    nsu: intent.nsu,
    authorizationCode: intent.authorizationCode,
    cardBrand: intent.cardBrand,
    cardLastFour: intent.cardLastFour,
    evidenceId: intent.evidenceId,
    failureCode: intent.failureCode,
    failureMessage: intent.failureMessage,
    providerSequence: intent.providerSequence?.toString() ?? null,
    providerOccurredAt: intent.providerOccurredAt,
    unknownSince: intent.unknownSince,
    nextReconcileAt: intent.nextReconcileAt,
    expiresAt: intent.expiresAt,
    consumedAt: intent.consumedAt,
    createdAt: intent.createdAt,
    updatedAt: intent.updatedAt,
    ...(intent.attempts
      ? { attempts: intent.attempts.map(posPaymentAttemptDto) }
      : {}),
    ...(intent.stateEvents
      ? {
          stateEvents: intent.stateEvents.map((event) => ({
            ...event,
            id: event.id.toString(),
          })),
        }
      : {}),
  };
}

function posPaymentAttemptDto(attempt: {
  id: string;
  sequence: number;
  operation: string;
  state: string;
  outcomeUnknown: boolean;
  failureCode: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}) {
  return {
    id: attempt.id,
    sequence: attempt.sequence,
    operation: attempt.operation,
    state: attempt.state,
    outcomeUnknown: attempt.outcomeUnknown,
    failureCode: attempt.failureCode,
    createdAt: attempt.createdAt,
    finishedAt: attempt.finishedAt,
  };
}

function posPaymentOutboxCommand(
  outbox: {
    id: bigint;
    attempt: {
      id: string;
      operation: string;
      providerIdempotencyKey: string;
      intent: {
        id: string;
        saleDraftId: string;
        paymentIndex: number;
        provider: string;
        providerReference: string | null;
        amountCents: number;
        currency: string;
        method: string;
        installments: number;
        expiresAt: Date;
        branchId: number;
        registerId: number;
        sessionId: number;
        terminalId: string | null;
        connectorId: string;
        credentialRef: string;
      };
    };
  },
  claimToken: string,
  claimExpiresAt: Date,
) {
  const intent = outbox.attempt.intent;
  return {
    outboxId: outbox.id.toString(),
    attemptId: outbox.attempt.id,
    operation: outbox.attempt.operation,
    claimToken,
    claimExpiresAt,
    providerIdempotencyKey: outbox.attempt.providerIdempotencyKey,
    intent: {
      id: intent.id,
      saleDraftId: intent.saleDraftId,
      paymentIndex: intent.paymentIndex,
      provider: intent.provider,
      providerReference: intent.providerReference,
      amountCents: intent.amountCents,
      currency: intent.currency,
      method: intent.method,
      installments: intent.installments,
      expiresAt: intent.expiresAt,
      branchId: intent.branchId,
      registerId: intent.registerId,
      sessionId: intent.sessionId,
      terminalId: intent.terminalId,
      connectorId: intent.connectorId,
      credentialRef: intent.credentialRef,
    },
  };
}

type ObservationApplication = {
  result:
    | "applied"
    | "no_change"
    | "ignored_stale"
    | "rejected_context"
    | "rejected_transition"
    | "supplemental_after_consumption";
  version: number;
  state: PosPersistedPaymentState;
  applied: boolean;
};

async function prepareIntentTransition(
  tx: Prisma.TransactionClient,
  action: Exclude<PosPaymentIntentWriteAction, "create">,
  intent: Prisma.PosPaymentIntentGetPayload<object>,
  idempotencyKey: string,
  actorUserId: string,
  overrides: Partial<Parameters<typeof posPaymentIntentWriteTarget>[0]>,
) {
  return preparePosPaymentIntentWrite(tx, {
    action,
    id: intent.id,
    expectedVersion: intent.version,
    actorUserId,
    idempotencyKey: intentCapabilityOperationKey(action, idempotencyKey),
    target: posPaymentIntentWriteTarget({ ...intent, ...overrides }),
  });
}

function intentCapabilityOperationKey(
  action: PosPaymentIntentWriteAction,
  value: string,
) {
  if (
    value.length >= 16 &&
    value.length <= 160 &&
    /^[A-Za-z0-9._:-]+$/.test(value)
  )
    return value;
  return `intent-${action}:${createHash("sha256").update(value).digest("hex")}`;
}

async function applyObservation(
  tx: Prisma.TransactionClient,
  intent: Prisma.PosPaymentIntentGetPayload<object>,
  observation: PosPaymentObservation,
  source: {
    source: "worker" | "callback";
    sourceId: string;
    eventKey: string;
    attemptId?: string;
    evidenceHash: string;
  },
): Promise<ObservationApplication> {
  const currentState = intent.status as PosPersistedPaymentState;
  assertObservationPaymentEvidence(intent, observation);
  if (["partially_refunded", "refunded"].includes(observation.state))
    return {
      result: "rejected_transition",
      version: intent.version,
      state: currentState,
      applied: false,
    };
  if (isObservationStale(intent, observation))
    return {
      result: "ignored_stale",
      version: intent.version,
      state: currentState,
      applied: false,
    };
  try {
    assertPosPaymentTransition(currentState, observation.state);
  } catch {
    return {
      result: "rejected_transition",
      version: intent.version,
      state: currentState,
      applied: false,
    };
  }
  const evidence = observationEvidence(observation),
    evidenceHash = source.evidenceHash || hashPosPaymentPayload(evidence);
  const resultingVersion = intent.version + 1,
    nextReconcileAt = reconcileAt(observation.state, new Date());
  const unknownSince =
    observation.state === "unknown"
      ? (intent.unknownSince ?? new Date())
      : null;
  await prepareIntentTransition(
    tx,
    source.source === "callback" ? "apply_callback" : "apply_delivery",
    intent,
    source.eventKey,
    source.source === "callback"
      ? `provider:${intent.provider}`
      : "system:pos-payment-worker",
    {
      status: observation.state,
      version: resultingVersion,
      // prettier-ignore
      providerReference: observation.providerReference ?? intent.providerReference,
      transactionId: observation.transactionId ?? intent.transactionId,
      endToEndId: observation.endToEndId ?? intent.endToEndId,
      nsu: observation.nsu ?? intent.nsu,
      authorizationCode:
        observation.authorizationCode ?? intent.authorizationCode,
      cardBrand: observation.cardBrand ?? intent.cardBrand,
      cardLastFour: observation.cardLastFour ?? intent.cardLastFour,
      evidenceId: observation.evidenceId ?? intent.evidenceId,
      failureCode: observation.failureCode,
      failureMessage: observation.failureMessage,
      // prettier-ignore
      providerSequence: observation.providerSequence ?? intent.providerSequence,
      providerOccurredAt: observation.occurredAt ?? intent.providerOccurredAt,
      unknownSince,
      nextReconcileAt,
    },
  );
  const changed = await tx.posPaymentIntent.updateMany({
    where: { id: intent.id, version: intent.version, status: intent.status },
    data: {
      status: observation.state,
      version: { increment: 1 },
      providerReference:
        observation.providerReference ?? intent.providerReference,
      transactionId: observation.transactionId ?? intent.transactionId,
      endToEndId: observation.endToEndId ?? intent.endToEndId,
      nsu: observation.nsu ?? intent.nsu,
      authorizationCode:
        observation.authorizationCode ?? intent.authorizationCode,
      cardBrand: observation.cardBrand ?? intent.cardBrand,
      cardLastFour: observation.cardLastFour ?? intent.cardLastFour,
      evidenceId: observation.evidenceId ?? intent.evidenceId,
      failureCode: observation.failureCode,
      failureMessage: observation.failureMessage,
      providerSequence: observation.providerSequence ?? intent.providerSequence,
      providerOccurredAt: observation.occurredAt ?? intent.providerOccurredAt,
      unknownSince,
      nextReconcileAt,
    },
  });
  if (changed.count !== 1)
    throw new PosPaymentPersistenceError(
      "A intenção mudou durante a aplicação do resultado.",
      409,
    );
  await tx.posPaymentStateEvent.create({
    data: {
      intentId: intent.id,
      attemptId: source.attemptId,
      eventKey: source.eventKey,
      source: source.source,
      sourceId: source.sourceId,
      fromState: currentState,
      toState: observation.state,
      resultingVersion,
      providerOccurredAt: observation.occurredAt,
      evidenceHash,
    },
  });
  return {
    result: observation.state === currentState ? "no_change" : "applied",
    version: resultingVersion,
    state: observation.state,
    applied: true,
  };
}

function assertObservationPaymentEvidence(
  intent: Prisma.PosPaymentIntentGetPayload<object>,
  observation: PosPaymentObservation,
) {
  return assertPosPaymentMethodEvidence(
    intent.method as PosPersistedPaymentMethod,
    observation.state,
    {
      transactionId: observation.transactionId ?? intent.transactionId,
      endToEndId: observation.endToEndId ?? intent.endToEndId,
      nsu: observation.nsu ?? intent.nsu,
      authorizationCode:
        observation.authorizationCode ?? intent.authorizationCode,
      cardBrand: observation.cardBrand ?? intent.cardBrand,
      cardLastFour: observation.cardLastFour ?? intent.cardLastFour,
    },
  );
}

function assertPersistedPaymentEvidence(
  intent: Prisma.PosPaymentIntentGetPayload<object>,
  state: PosPersistedPaymentState,
) {
  return assertPosPaymentMethodEvidence(
    intent.method as PosPersistedPaymentMethod,
    state,
    intent,
  );
}

async function forceManualReview(
  tx: Prisma.TransactionClient,
  intent: Prisma.PosPaymentIntentGetPayload<object>,
  attemptId: string,
  failureCode: string,
  now: Date,
) {
  const state = intent.status as PosPersistedPaymentState;
  assertPosPaymentTransition(state, "manual_review");
  const nextReconcileAt = new Date(now.valueOf() + retryDelayMs(8));
  await prepareIntentTransition(
    tx,
    "force_manual_review",
    intent,
    `payment-attempt-dead:${attemptId}`,
    "system:pos-payment-worker",
    {
      status: "manual_review",
      version: intent.version + 1,
      failureCode,
      failureMessage: null,
      nextReconcileAt,
    },
  );
  const changed = await tx.posPaymentIntent.updateMany({
    where: { id: intent.id, version: intent.version, status: intent.status },
    data: {
      status: "manual_review",
      version: { increment: 1 },
      failureCode,
      failureMessage: null,
      nextReconcileAt,
    },
  });
  if (changed.count !== 1)
    throw new PosPaymentPersistenceError(
      "A intenção mudou durante o encerramento do retry.",
      409,
    );
  await tx.posPaymentStateEvent.create({
    data: {
      intentId: intent.id,
      attemptId,
      eventKey: `payment-attempt-dead:${attemptId}`,
      source: "worker",
      sourceId: attemptId,
      fromState: state,
      toState: "manual_review",
      resultingVersion: intent.version + 1,
    },
  });
  return {
    ...intent,
    status: "manual_review",
    version: intent.version + 1,
    failureCode,
    failureMessage: null,
    nextReconcileAt,
    updatedAt: now,
  };
}

async function recordPosPaymentDeliveryResult(
  tx: Prisma.TransactionClient,
  attempt: Prisma.PosPaymentAttemptGetPayload<{
    include: { outbox: true; intent: true };
  }>,
  input: PosPaymentOutboxCompletion,
  claimTokenHash: string,
  responseHash: string,
  outcome: {
    retryScheduled: boolean;
    superseded: boolean;
    attemptState: string;
    intent: { id: string; status: string; version: number };
  },
) {
  if (!attempt.outbox)
    throw new PosPaymentPersistenceError(
      "Outbox ausente durante o registro da entrega.",
      409,
    );
  await tx.posPaymentDeliveryResult.create({
    data: {
      intentId: outcome.intent.id,
      attemptId: attempt.id,
      outboxId: attempt.outbox.id,
      deliveryNumber: attempt.outbox.deliveryCount,
      claimTokenHash,
      responseHash,
      resultKind: input.result.kind,
      retryScheduled: outcome.retryScheduled,
      superseded: outcome.superseded,
      resultingAttemptState: outcome.attemptState,
      resultingIntentState: outcome.intent.status,
      resultingIntentVersion: outcome.intent.version,
    },
  });
}

async function ownedIntent(
  tx: Prisma.TransactionClient,
  context: PosPaymentPersistenceContext,
  intentId: string,
) {
  const intent = await tx.posPaymentIntent.findFirst({
    where: {
      id: intentId,
      branchId: context.branchId,
      operatorProfileId: context.actorProfileId,
      session: {
        status: "open",
        operatorProfileId: context.actorProfileId,
        registerId: { not: null },
      },
    },
  });
  if (!intent)
    throw new PosPaymentPersistenceError(
      "Intenção de pagamento não encontrada no turno do operador.",
      404,
    );
  return intent;
}

async function assertLivePaymentAccess(
  tx: Prisma.TransactionClient,
  context: PosPaymentPersistenceContext,
  registerId: number,
) {
  const access = await lockPaymentAccessRows(
    tx,
    context.branchId,
    registerId,
    context.actorProfileId,
  );
  if (!livePaymentAccess(access, new Date(), context.branchId))
    throw new PosPaymentPersistenceError(
      "Acesso de venda ao caixa foi revogado ou expirou.",
      403,
    );
}

async function assertLivePaymentTerminal(
  tx: Prisma.TransactionClient,
  context: PosPaymentPersistenceContext,
  proof: PosOperationalTerminalProof,
  session: {
    registerId: number | null;
    openingAmountCents: number;
    openRequestHash: string | null;
  },
) {
  if (!session.registerId)
    throw new PosPaymentPersistenceError(
      "O turno não possui caixa íntegro.",
      409,
    );
  const terminal = await tx.posTerminal.findUnique({
    where: { id: proof.terminalId },
    select: posOperationalTerminalSelect,
  });
  assertPosOperationalTerminalProof(terminal, proof, {
    expectedBranchId: context.branchId,
    expectedRegisterId: session.registerId,
  });
  assertPosSessionTerminalBinding(session, proof);
}

async function lockIntent(tx: Prisma.TransactionClient, intentId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT "id" FROM "pos_payment_intents" WHERE "id" = ${intentId} FOR UPDATE`,
  );
  if (rows.length !== 1)
    throw new PosPaymentPersistenceError(
      "A intenção mudou durante o pré-lock.",
      409,
    );
}

async function lockPosPaymentIntentCreateCanonical(
  tx: Prisma.TransactionClient,
  input: {
    intentId: string;
    idempotencyKey: string;
    planId: string;
    paymentIndex: number;
    sessionId: number;
    context: PosPaymentPersistenceContext;
    terminalProof: PosOperationalTerminalProof;
  },
) {
  const planLocator = await paymentPlanIntentLocator(tx, input.planId);
  if (!planLocator)
    throw new PosPaymentPersistenceError(
      "Plano autoritativo da intenção não foi encontrado.",
      409,
    );
  const slotLocator = await tx.posPaymentPlanSlot.findUnique({
    where: {
      planId_paymentIndex: {
        planId: input.planId,
        paymentIndex: input.paymentIndex,
      },
    },
  });
  if (!slotLocator?.connectorId || !slotLocator.credentialRef)
    throw new PosPaymentPersistenceError(
      "A divisão autoritativa não possui conector e credencial eletrônicos.",
      409,
    );
  const claimLocator = planLocator.orderClaimId
    ? await tx.posOrderClaim.findUnique({
        where: { id: planLocator.orderClaimId },
        select: { id: true, salesOrderId: true },
      })
    : null;
  if (planLocator.orderClaimId && !claimLocator)
    throw new PosPaymentPersistenceError(
      "A posse autoritativa do plano não foi encontrada.",
      409,
    );
  const itemIds = await heldSaleItemLocatorIds(tx, planLocator.saleDraftId);

  await lockIntentGraphNamespaces(tx, [
    `pos-payment-intent-graph:create:${input.idempotencyKey}`,
    ...paymentPlanSharedNamespaces(
      planLocator,
      claimLocator?.salesOrderId ?? null,
    ),
  ]);

  await lockIntentPlanRoots(
    tx,
    planLocator,
    claimLocator?.salesOrderId ?? null,
    itemIds,
  );
  await lockExactStringRoot(
    tx,
    "pos_connectors",
    slotLocator.connectorId,
    "SHARE",
  );
  await lockExactStringRoot(
    tx,
    "integration_credentials",
    slotLocator.credentialRef,
    "SHARE",
  );
  await lockExactStringRoot(tx, "pos_payment_plans", input.planId, "UPDATE");

  const [
    plan,
    slot,
    session,
    draft,
    connector,
    credential,
    lockedClaim,
    lockedItemIds,
  ] = await Promise.all([
    tx.posPaymentPlan.findUnique({ where: { id: input.planId } }),
    tx.posPaymentPlanSlot.findUnique({
      where: {
        planId_paymentIndex: {
          planId: input.planId,
          paymentIndex: input.paymentIndex,
        },
      },
    }),
    tx.cashRegisterSession.findUnique({ where: { id: planLocator.sessionId } }),
    tx.posHeldSale.findUnique({ where: { id: planLocator.saleDraftId } }),
    tx.posConnector.findUnique({ where: { id: slotLocator.connectorId } }),
    tx.integrationCredential.findUnique({
      where: { id: slotLocator.credentialRef },
      include: { provider: true },
    }),
    planLocator.orderClaimId
      ? tx.posOrderClaim.findUnique({ where: { id: planLocator.orderClaimId } })
      : Promise.resolve(null),
    heldSaleItemLocatorIds(tx, planLocator.saleDraftId),
  ]);
  if (
    !plan ||
    !slot ||
    !session ||
    session.registerId == null ||
    !draft ||
    !connector ||
    !credential
  )
    throw new PosPaymentPersistenceError(
      "O grafo autoritativo da intenção mudou durante o pré-lock.",
      409,
    );
  const registerId = session.registerId;
  assertPaymentPlanIntentLocatorUnchanged(planLocator, plan);
  assertExactNumberSet(
    itemIds,
    lockedItemIds,
    "Os itens do rascunho mudaram durante o pré-lock da intenção.",
  );
  if (
    slot.connectorId !== slotLocator.connectorId ||
    slot.credentialRef !== slotLocator.credentialRef ||
    slot.proofKind !== "intent"
  )
    throw new PosPaymentPersistenceError(
      "A divisão eletrônica mudou durante o pré-lock.",
      409,
    );
  if (
    plan.orderClaimId &&
    (!lockedClaim || lockedClaim.salesOrderId !== claimLocator?.salesOrderId)
  )
    throw new PosPaymentPersistenceError(
      "A posse autoritativa mudou durante o pré-lock.",
      409,
    );
  if (
    plan.branchId !== input.context.branchId ||
    plan.sessionId !== input.sessionId ||
    plan.sessionId !== session.id ||
    plan.operatorProfileId !== input.context.actorProfileId ||
    plan.terminalId !== input.terminalProof.terminalId ||
    plan.state !== "active" ||
    plan.expiresAt <= new Date()
  )
    throw new PosPaymentPersistenceError(
      "O plano não está ativo no contexto operacional da intenção.",
      409,
    );
  if (
    session.registerId !== plan.registerId ||
    session.operatorProfileId !== plan.operatorProfileId ||
    session.status !== "open"
  )
    throw new PosPaymentPersistenceError(
      "O turno autoritativo do plano mudou.",
      409,
    );
  if (
    draft.registerId !== plan.registerId ||
    draft.sessionId !== plan.sessionId ||
    draft.operatorProfileId !== plan.operatorProfileId ||
    draft.revision !== plan.draftRevision ||
    draft.status !== plan.draftStatus ||
    !["draft", "held"].includes(draft.status)
  )
    throw new PosPaymentPersistenceError(
      "O rascunho autoritativo do plano mudou.",
      409,
    );
  if (
    lockedClaim &&
    (lockedClaim.id !== plan.orderClaimId ||
      lockedClaim.branchId !== plan.branchId ||
      lockedClaim.registerId !== plan.registerId ||
      lockedClaim.sessionId !== plan.sessionId ||
      lockedClaim.operatorProfileId !== plan.operatorProfileId ||
      lockedClaim.terminalId !== plan.terminalId ||
      lockedClaim.id !== plan.saleDraftId ||
      lockedClaim.state !== "active" ||
      lockedClaim.leaseExpiresAt <= new Date())
  )
    throw new PosPaymentPersistenceError(
      "A posse autoritativa não está vigente para a intenção.",
      409,
    );
  if (
    connector.id !== slot.connectorId ||
    connector.credentialRef !== slot.credentialRef ||
    connector.branchId !== plan.branchId ||
    connector.provider !== slot.provider ||
    connector.status !== "active" ||
    (connector.registerId != null && connector.registerId !== plan.registerId)
  )
    throw new PosPaymentPersistenceError(
      "O conector autoritativo da divisão mudou.",
      409,
    );
  if (
    credential.id !== slot.credentialRef ||
    !credential.enabled ||
    credential.revokedAt !== null ||
    (credential.expiresAt !== null && credential.expiresAt <= new Date()) ||
    credential.providerId !== connector.provider ||
    credential.provider.family !== "payment"
  )
    throw new PosPaymentPersistenceError(
      "A credencial autoritativa da divisão mudou.",
      409,
    );
  await assertLivePaymentTerminal(
    tx,
    input.context,
    input.terminalProof,
    session,
  );
  await assertLivePaymentAccess(tx, input.context, registerId);
  return { plan, slot, session: { ...session, registerId }, connector };
}

/**
 * Locks the immutable payment aggregate in the global order used by quote,
 * activation and sale commit: advisory -> session -> terminal -> live-access
 * rows -> sales order -> claim -> draft -> items -> connector -> credential ->
 * plan -> intent. Late callbacks still
 * use this ordering, but deliberately do not require any parent to remain
 * operational; only a first create dispatch evaluates the live boundary.
 */
export async function lockPosPaymentIntentCanonical(
  tx: Prisma.TransactionClient,
  intentId: string,
  preRootAdvisoryNamespaces: readonly string[] = [],
) {
  const locator = await tx.posPaymentIntent.findUnique({
    where: { id: intentId },
    select: {
      paymentPlanId: true,
      connectorId: true,
      credentialRef: true,
      saleDraftId: true,
    },
  });
  if (!locator)
    throw new PosPaymentPersistenceError(
      "Intenção de pagamento não encontrada.",
      404,
    );
  if (!locator.paymentPlanId) {
    await lockIntentGraphNamespaces(tx, [
      ...preRootAdvisoryNamespaces,
      `pos-payment-intent-graph:existing:${intentId}`,
    ]);
    await lockIntent(tx, intentId);
    const intent = await tx.posPaymentIntent.findUniqueOrThrow({
      where: { id: intentId },
    });
    if (
      intent.paymentPlanId !== null ||
      intent.connectorId !== locator.connectorId ||
      intent.credentialRef !== locator.credentialRef
    )
      throw new PosPaymentPersistenceError(
        "Os bindings da intenção legada mudaram durante o pré-lock.",
        409,
      );
    return {
      intent,
      plan: null,
      slot: null,
      session: null,
      terminal: null,
      draft: null,
      claim: null,
      connector: null,
      credential: null,
      profileStatus: null,
      branchStatus: null,
      registerStatus: null,
      registerBranchId: null,
      branchCanSell: null,
      registerAccessActive: null,
      registerCanSell: null,
      registerValidFrom: null,
      registerValidUntil: null,
    };
  }
  const planLocator = await paymentPlanIntentLocator(tx, locator.paymentPlanId);
  if (!planLocator)
    throw new PosPaymentPersistenceError(
      "Plano autoritativo da intenção não foi encontrado.",
      409,
    );
  const claimLocator = planLocator.orderClaimId
    ? await tx.posOrderClaim.findUnique({
        where: { id: planLocator.orderClaimId },
        select: { id: true, salesOrderId: true },
      })
    : null;
  if (planLocator.orderClaimId && !claimLocator)
    throw new PosPaymentPersistenceError(
      "A posse autoritativa da intenção não foi encontrada.",
      409,
    );
  const itemIds = await heldSaleItemLocatorIds(tx, planLocator.saleDraftId);
  await lockIntentGraphNamespaces(tx, [
    ...preRootAdvisoryNamespaces,
    `pos-payment-intent-graph:existing:${intentId}`,
    ...paymentPlanSharedNamespaces(
      planLocator,
      claimLocator?.salesOrderId ?? null,
    ),
  ]);
  const access = await lockIntentPlanRoots(
    tx,
    planLocator,
    claimLocator?.salesOrderId ?? null,
    itemIds,
  );
  await lockExactStringRoot(tx, "pos_connectors", locator.connectorId, "SHARE");
  await lockExactStringRoot(
    tx,
    "integration_credentials",
    locator.credentialRef,
    "SHARE",
  );
  await lockExactStringRoot(
    tx,
    "pos_payment_plans",
    locator.paymentPlanId,
    "UPDATE",
  );
  await lockIntent(tx, intentId);
  const intent = await tx.posPaymentIntent.findUniqueOrThrow({
    where: { id: intentId },
  });
  const plan = await tx.posPaymentPlan.findUniqueOrThrow({
    where: { id: locator.paymentPlanId },
  });
  const [
    slot,
    session,
    terminal,
    draft,
    claim,
    connector,
    credential,
    lockedItemIds,
  ] = await Promise.all([
    tx.posPaymentPlanSlot.findUnique({
      where: {
        planId_paymentIndex: {
          planId: locator.paymentPlanId,
          paymentIndex: intent.paymentIndex,
        },
      },
    }),
    tx.cashRegisterSession.findUnique({ where: { id: plan.sessionId } }),
    tx.posTerminal.findUnique({
      where: { id: plan.terminalId },
      include: { register: { include: { branch: true } } },
    }),
    tx.posHeldSale.findUnique({ where: { id: plan.saleDraftId } }),
    plan.orderClaimId
      ? tx.posOrderClaim.findUnique({ where: { id: plan.orderClaimId } })
      : Promise.resolve(null),
    tx.posConnector.findUnique({ where: { id: intent.connectorId } }),
    tx.integrationCredential.findUnique({
      where: { id: intent.credentialRef },
      include: { provider: true },
    }),
    heldSaleItemLocatorIds(tx, planLocator.saleDraftId),
  ]);
  if (
    intent.paymentPlanId !== locator.paymentPlanId ||
    intent.connectorId !== locator.connectorId ||
    intent.credentialRef !== locator.credentialRef
  )
    throw new PosPaymentPersistenceError(
      "Os bindings da intenção mudaram durante o pré-lock.",
      409,
    );
  assertPaymentPlanIntentLocatorUnchanged(planLocator, plan);
  assertExactNumberSet(
    itemIds,
    lockedItemIds,
    "Os itens do rascunho mudaram durante o pré-lock da intenção.",
  );
  if (
    plan.orderClaimId &&
    (!claim || claim.salesOrderId !== claimLocator?.salesOrderId)
  )
    throw new PosPaymentPersistenceError(
      "A posse autoritativa mudou durante o pré-lock da intenção.",
      409,
    );
  if (
    !connector ||
    connector.id !== locator.connectorId ||
    !credential ||
    credential.id !== locator.credentialRef
  )
    throw new PosPaymentPersistenceError(
      "Conector ou credencial da intenção mudaram durante o pré-lock.",
      409,
    );
  assertLockedIntentGraphBindings({
    intent,
    plan,
    slot,
    session,
    terminal,
    draft,
    claim,
    connector,
    credential,
  });
  return {
    intent,
    plan,
    slot,
    session,
    terminal,
    draft,
    claim,
    connector,
    credential,
    ...access,
  };
}

type PaymentPlanIntentLocator = {
  id: string;
  branchId: number;
  registerId: number;
  sessionId: number;
  operatorProfileId: number;
  terminalId: string;
  orderClaimId: string | null;
  saleDraftId: string;
};

function paymentPlanIntentLocator(
  tx: Prisma.TransactionClient,
  planId: string,
) {
  return tx.posPaymentPlan.findUnique({
    where: { id: planId },
    select: {
      id: true,
      branchId: true,
      registerId: true,
      sessionId: true,
      operatorProfileId: true,
      terminalId: true,
      orderClaimId: true,
      saleDraftId: true,
    },
  });
}

async function lockIntentGraphNamespaces(
  tx: Prisma.TransactionClient,
  namespaces: readonly string[],
) {
  // Namespaces are ASCII-only by construction; default lexical sort is the
  // same byte order as PostgreSQL COLLATE "C" used by the SQL capabilities.
  for (const namespace of [...new Set(namespaces)].sort()) {
    await tx.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${namespace}, 0))`,
    );
  }
}

function paymentPlanSharedNamespaces(
  plan: PaymentPlanIntentLocator,
  salesOrderId: number | null,
) {
  return [
    `t2-payment-plan:aggregate:${plan.id}`,
    `t2-payment-plan:draft:${plan.saleDraftId}`,
    `pos-held-sale-items:v1:held-sale:${plan.saleDraftId}`,
    ...(plan.orderClaimId
      ? [
          `pos-order-claim:v1:claim:${plan.orderClaimId}`,
          `pos-order-claim:v1:artifacts:${plan.orderClaimId}`,
        ]
      : []),
    ...(salesOrderId != null
      ? [`pos-order-claim:v1:order:${salesOrderId}`]
      : []),
  ];
}

async function heldSaleItemLocatorIds(
  tx: Prisma.TransactionClient,
  heldSaleId: string,
) {
  const rows = await tx.posHeldSaleItem.findMany({
    where: { heldSaleId },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  return rows.map((row) => row.id);
}

async function lockIntentPlanRoots(
  tx: Prisma.TransactionClient,
  plan: PaymentPlanIntentLocator,
  salesOrderId: number | null,
  itemIds: readonly number[],
) {
  await lockExactNumberRoot(
    tx,
    "cash_register_sessions",
    plan.sessionId,
    "UPDATE",
  );
  await lockExactStringRoot(tx, "pos_terminals", plan.terminalId, "UPDATE");
  const access = await lockPaymentAccessRows(
    tx,
    plan.branchId,
    plan.registerId,
    plan.operatorProfileId,
  );
  if (salesOrderId != null)
    await lockExactNumberRoot(tx, "sales_orders", salesOrderId, "UPDATE");
  if (plan.orderClaimId)
    await lockExactStringRoot(
      tx,
      "pos_order_claims",
      plan.orderClaimId,
      "UPDATE",
    );
  await lockExactStringRoot(tx, "pos_held_sales", plan.saleDraftId, "UPDATE");
  if (itemIds.length) {
    const rows = await tx.$queryRaw<Array<{ id: number }>>(
      Prisma.sql`SELECT "id" FROM "pos_held_sale_items" WHERE "id" IN (${Prisma.join(itemIds)}) ORDER BY "id" FOR UPDATE`,
    );
    if (rows.length !== itemIds.length)
      throw new PosPaymentPersistenceError(
        "Os itens do rascunho mudaram durante o pré-lock da intenção.",
        409,
      );
  }
  return access;
}

async function lockExactNumberRoot(
  tx: Prisma.TransactionClient,
  table: "cash_register_sessions" | "sales_orders",
  id: number,
  mode: "UPDATE" | "SHARE",
) {
  const rows = await tx.$queryRaw<Array<{ id: number }>>(
    Prisma.sql`SELECT "id" FROM ${Prisma.raw(`"${table}"`)} WHERE "id" = ${id} FOR ${Prisma.raw(mode)}`,
  );
  if (rows.length !== 1)
    throw new PosPaymentPersistenceError(
      `Root ${table} mudou durante o pré-lock da intenção.`,
      409,
    );
}

async function lockExactStringRoot(
  tx: Prisma.TransactionClient,
  table:
    | "pos_terminals"
    | "pos_order_claims"
    | "pos_held_sales"
    | "pos_connectors"
    | "integration_credentials"
    | "pos_payment_plans",
  id: string,
  mode: "UPDATE" | "SHARE",
) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT "id" FROM ${Prisma.raw(`"${table}"`)} WHERE "id" = ${id} FOR ${Prisma.raw(mode)}`,
  );
  if (rows.length !== 1)
    throw new PosPaymentPersistenceError(
      `Root ${table} mudou durante o pré-lock da intenção.`,
      409,
    );
}

function assertPaymentPlanIntentLocatorUnchanged(
  before: PaymentPlanIntentLocator,
  after: PaymentPlanIntentLocator,
) {
  if (
    before.id !== after.id ||
    before.branchId !== after.branchId ||
    before.registerId !== after.registerId ||
    before.sessionId !== after.sessionId ||
    before.operatorProfileId !== after.operatorProfileId ||
    before.terminalId !== after.terminalId ||
    before.orderClaimId !== after.orderClaimId ||
    before.saleDraftId !== after.saleDraftId
  )
    throw new PosPaymentPersistenceError(
      "Os bindings do plano mudaram durante o pré-lock da intenção.",
      409,
    );
}

function assertExactNumberSet(
  before: readonly number[],
  after: readonly number[],
  message: string,
) {
  if (
    before.length !== after.length ||
    before.some((id, index) => id !== after[index])
  )
    throw new PosPaymentPersistenceError(message, 409);
}

function assertLockedIntentGraphBindings(graph: {
  intent: Prisma.PosPaymentIntentGetPayload<object>;
  plan: Prisma.PosPaymentPlanGetPayload<object>;
  slot: Prisma.PosPaymentPlanSlotGetPayload<object> | null;
  session: Prisma.CashRegisterSessionGetPayload<object> | null;
  terminal: Prisma.PosTerminalGetPayload<object> | null;
  draft: Prisma.PosHeldSaleGetPayload<object> | null;
  claim: Prisma.PosOrderClaimGetPayload<object> | null;
  connector: Prisma.PosConnectorGetPayload<object>;
  credential: Prisma.IntegrationCredentialGetPayload<{
    include: { provider: true };
  }>;
}) {
  const {
    intent,
    plan,
    slot,
    session,
    terminal,
    draft,
    claim,
    connector,
    credential,
  } = graph;
  if (!slot || !session || !terminal || !draft)
    throw new PosPaymentPersistenceError(
      "O grafo autoritativo da intenção ficou incompleto durante o pré-lock.",
      409,
    );
  if (
    intent.paymentPlanId !== plan.id ||
    intent.paymentIndex !== slot.paymentIndex ||
    intent.branchId !== plan.branchId ||
    intent.registerId !== plan.registerId ||
    intent.sessionId !== plan.sessionId ||
    intent.operatorProfileId !== plan.operatorProfileId ||
    intent.terminalId !== plan.terminalId ||
    intent.saleDraftId !== plan.saleDraftId ||
    intent.method !== slot.method ||
    intent.amountCents !== slot.amountCents ||
    intent.installments !== slot.installments
  )
    throw new PosPaymentPersistenceError(
      "A intenção divergiu do plano ou da divisão autoritativa.",
      409,
    );
  if (
    session.id !== plan.sessionId ||
    session.registerId !== plan.registerId ||
    session.operatorProfileId !== plan.operatorProfileId ||
    terminal.id !== plan.terminalId ||
    terminal.registerId !== plan.registerId ||
    draft.id !== plan.saleDraftId ||
    draft.registerId !== plan.registerId ||
    draft.sessionId !== plan.sessionId ||
    draft.operatorProfileId !== plan.operatorProfileId ||
    draft.revision !== plan.draftRevision ||
    draft.status !== plan.draftStatus
  )
    throw new PosPaymentPersistenceError(
      "As roots operacionais divergiram do plano da intenção.",
      409,
    );
  if (
    plan.orderClaimId
      ? !claim ||
        claim.id !== plan.orderClaimId ||
        claim.id !== plan.saleDraftId ||
        claim.salesOrderId == null ||
        claim.branchId !== plan.branchId ||
        claim.registerId !== plan.registerId ||
        claim.sessionId !== plan.sessionId ||
        claim.operatorProfileId !== plan.operatorProfileId ||
        claim.terminalId !== plan.terminalId
      : claim !== null
  )
    throw new PosPaymentPersistenceError(
      "A posse divergiu do plano da intenção.",
      409,
    );
  if (
    slot.connectorId !== intent.connectorId ||
    slot.credentialRef !== intent.credentialRef ||
    slot.provider !== intent.provider ||
    connector.id !== intent.connectorId ||
    connector.branchId !== plan.branchId ||
    connector.provider !== intent.provider ||
    connector.credentialRef !== intent.credentialRef ||
    (connector.registerId != null &&
      connector.registerId !== plan.registerId) ||
    credential.id !== intent.credentialRef ||
    !credential.enabled ||
    credential.revokedAt !== null ||
    (credential.expiresAt !== null && credential.expiresAt <= new Date()) ||
    credential.providerId !== intent.provider ||
    credential.provider.family !== "payment"
  )
    throw new PosPaymentPersistenceError(
      "Conector ou credencial divergiram da intenção autoritativa.",
      409,
    );
}

function createDispatchBoundaryFailure(
  graph: Awaited<ReturnType<typeof lockPosPaymentIntentCanonical>>,
  now: Date,
) {
  const {
    intent,
    plan,
    slot,
    session,
    terminal,
    draft,
    claim,
    connector,
    credential,
  } = graph;
  if (
    !plan ||
    !slot ||
    !session ||
    !terminal ||
    !draft ||
    !connector ||
    !credential
  )
    return "authoritative_graph_missing";
  if (!livePaymentAccess(graph, now, plan.branchId))
    return "authoritative_access_revoked";
  if (
    plan.state !== "active" ||
    plan.expiresAt <= now ||
    intent.expiresAt <= now ||
    intent.expiresAt > plan.expiresAt
  )
    return "authoritative_plan_expired";
  if (
    session.id !== plan.sessionId ||
    session.registerId !== plan.registerId ||
    session.operatorProfileId !== plan.operatorProfileId ||
    session.status !== "open"
  )
    return "authoritative_session_changed";
  if (
    terminal.id !== plan.terminalId ||
    terminal.registerId !== plan.registerId ||
    terminal.status !== "online" ||
    !terminal.pairedAt ||
    terminal.revokedAt ||
    !terminal.tokenHash ||
    !terminal.tokenExpiresAt ||
    terminal.tokenExpiresAt <= now ||
    !terminal.lastSeenAt ||
    terminal.lastSeenAt <= new Date(now.valueOf() - 5 * 60_000) ||
    !terminal.appVersion?.trim() ||
    terminal.register.status !== "active" ||
    terminal.register.branchId !== plan.branchId ||
    terminal.register.branch.status !== "active"
  )
    return "authoritative_terminal_changed";
  if (
    draft.id !== plan.saleDraftId ||
    draft.registerId !== plan.registerId ||
    draft.sessionId !== plan.sessionId ||
    draft.operatorProfileId !== plan.operatorProfileId ||
    draft.revision !== plan.draftRevision ||
    draft.status !== plan.draftStatus ||
    !["draft", "held"].includes(draft.status)
  )
    return "authoritative_draft_changed";
  if (
    plan.orderClaimId &&
    (!claim ||
      claim.id !== plan.orderClaimId ||
      claim.id !== plan.saleDraftId ||
      claim.branchId !== plan.branchId ||
      claim.registerId !== plan.registerId ||
      claim.sessionId !== plan.sessionId ||
      claim.operatorProfileId !== plan.operatorProfileId ||
      claim.terminalId !== plan.terminalId ||
      claim.state !== "active" ||
      claim.leaseExpiresAt <= now)
  )
    return "authoritative_claim_expired";
  if (
    intent.paymentPlanId !== plan.id ||
    intent.paymentIndex !== slot.paymentIndex ||
    intent.branchId !== plan.branchId ||
    intent.registerId !== plan.registerId ||
    intent.sessionId !== plan.sessionId ||
    intent.operatorProfileId !== plan.operatorProfileId ||
    intent.terminalId !== plan.terminalId ||
    intent.saleDraftId !== plan.saleDraftId ||
    intent.method !== slot.method ||
    intent.amountCents !== slot.amountCents ||
    intent.installments !== slot.installments ||
    slot.proofKind !== "intent"
  )
    return "authoritative_intent_changed";
  if (
    connector.id !== slot.connectorId ||
    connector.id !== intent.connectorId ||
    connector.branchId !== plan.branchId ||
    connector.provider !== slot.provider ||
    connector.provider !== intent.provider ||
    connector.credentialRef !== slot.credentialRef ||
    connector.credentialRef !== intent.credentialRef ||
    connector.status !== "active" ||
    !connector.type.startsWith("payment") ||
    (connector.registerId != null &&
      connector.registerId !== plan.registerId) ||
    posConnectorAllowsPaymentMethod(
      connector.settings,
      intent.method as PosPersistedPaymentMethod,
    ) !== true
  )
    return "authoritative_connector_changed";
  if (
    credential.id !== slot.credentialRef ||
    credential.id !== intent.credentialRef ||
    !credential.enabled ||
    credential.revokedAt !== null ||
    (credential.expiresAt !== null && credential.expiresAt <= now) ||
    credential.providerId !== intent.provider ||
    credential.provider.family !== "payment"
  )
    return "authoritative_credential_changed";
  return null;
}

type LockedPaymentAccess = {
  profileStatus: string | null;
  branchStatus: string | null;
  registerStatus: string | null;
  registerBranchId: number | null;
  branchCanSell: boolean | null;
  registerAccessActive: boolean | null;
  registerCanSell: boolean | null;
  registerValidFrom: Date | null;
  registerValidUntil: Date | null;
};

async function lockPaymentAccessRows(
  tx: Prisma.TransactionClient,
  branchId: number,
  registerId: number,
  profileId: number,
): Promise<LockedPaymentAccess> {
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "tenant_user_profiles" WHERE "id" = ${profileId} FOR SHARE`,
  );
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "branches" WHERE "id" = ${branchId} FOR SHARE`,
  );
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "pos_registers" WHERE "id" = ${registerId} FOR SHARE`,
  );
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "branch_user_accesses" WHERE "branch_id" = ${branchId} AND "user_profile_id" = ${profileId} FOR SHARE`,
  );
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "pos_register_accesses" WHERE "register_id" = ${registerId} AND "user_profile_id" = ${profileId} FOR SHARE`,
  );
  const [profile, branch, register, branchAccess, registerAccess] =
    await Promise.all([
      tx.tenantUserProfile.findUnique({
        where: { id: profileId },
        select: { status: true },
      }),
      tx.branch.findUnique({
        where: { id: branchId },
        select: { status: true },
      }),
      tx.posRegister.findUnique({
        where: { id: registerId },
        select: { status: true, branchId: true },
      }),
      tx.branchUserAccess.findUnique({
        where: {
          branchId_userProfileId: { branchId, userProfileId: profileId },
        },
        select: { canSell: true },
      }),
      tx.posRegisterAccess.findUnique({
        where: {
          registerId_userProfileId: { registerId, userProfileId: profileId },
        },
        select: {
          active: true,
          canSell: true,
          validFrom: true,
          validUntil: true,
        },
      }),
    ]);
  return {
    profileStatus: profile?.status ?? null,
    branchStatus: branch?.status ?? null,
    registerStatus: register?.status ?? null,
    registerBranchId: register?.branchId ?? null,
    branchCanSell: branchAccess?.canSell ?? null,
    registerAccessActive: registerAccess?.active ?? null,
    registerCanSell: registerAccess?.canSell ?? null,
    registerValidFrom: registerAccess?.validFrom ?? null,
    registerValidUntil: registerAccess?.validUntil ?? null,
  };
}

function livePaymentAccess(
  access: LockedPaymentAccess,
  now: Date,
  expectedBranchId?: number,
) {
  return (
    access.profileStatus === "active" &&
    access.branchStatus === "active" &&
    access.registerStatus === "active" &&
    access.registerBranchId != null &&
    (expectedBranchId == null ||
      access.registerBranchId === expectedBranchId) &&
    access.branchCanSell === true &&
    access.registerAccessActive === true &&
    access.registerCanSell === true &&
    (!access.registerValidFrom || access.registerValidFrom <= now) &&
    (!access.registerValidUntil || access.registerValidUntil >= now)
  );
}

async function lockAttempt(tx: Prisma.TransactionClient, attemptId: string) {
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "pos_payment_attempts" WHERE "id" = ${attemptId} FOR UPDATE`,
  );
}

async function lockOutbox(tx: Prisma.TransactionClient, outboxId: bigint) {
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "pos_payment_outbox" WHERE "id" = ${outboxId} FOR UPDATE`,
  );
}

async function lockPaymentGraph(
  tx: Prisma.TransactionClient,
  attemptId: string,
) {
  const locator = await tx.posPaymentAttempt.findUnique({
    where: { id: attemptId },
    select: { intentId: true, outbox: { select: { id: true } } },
  });
  if (!locator?.outbox)
    throw new PosPaymentPersistenceError(
      "Tentativa do worker não encontrada.",
      404,
    );
  await lockPosPaymentIntentCanonical(tx, locator.intentId);
  await lockAttempt(tx, attemptId);
  await lockOutbox(tx, locator.outbox.id);
  const attempt = await tx.posPaymentAttempt.findUnique({
    where: { id: attemptId },
    include: { outbox: true, intent: true },
  });
  if (!attempt?.outbox)
    throw new PosPaymentPersistenceError(
      "Tentativa do worker não encontrada.",
      404,
    );
  return attempt;
}

function replayIntent(
  intent: Prisma.PosPaymentIntentGetPayload<{ include: { attempts: true } }>,
  context: PosPaymentPersistenceContext,
  requestHash: string,
  input: Extract<PosPaymentIntentCommand, { action: "intent.create" }>,
  terminalId: string,
) {
  if (
    intent.branchId !== context.branchId ||
    intent.operatorProfileId !== context.actorProfileId ||
    intent.requestHash !== requestHash ||
    intent.sessionId !== input.sessionId ||
    intent.paymentPlanId !== input.paymentPlanId ||
    intent.paymentIndex !== input.paymentIndex ||
    intent.terminalId !== terminalId
  ) {
    throw new PosPaymentPersistenceError(
      "A chave idempotente já foi usada em outro plano, turno, terminal ou conteúdo.",
      409,
    );
  }
  return { intent: posPaymentIntentDto(intent), replayed: true };
}

function replayAttempt(
  attempt: Prisma.PosPaymentAttemptGetPayload<{ include: { intent: true } }>,
  context: PosPaymentPersistenceContext,
  requestHash: string,
  terminalId: string,
) {
  if (
    attempt.intent.branchId !== context.branchId ||
    attempt.intent.operatorProfileId !== context.actorProfileId ||
    attempt.intent.terminalId !== terminalId ||
    attempt.requestHash !== requestHash
  )
    throw new PosPaymentPersistenceError(
      "A chave idempotente do retry já foi usada em outro contexto, terminal ou conteúdo.",
      409,
    );
  return {
    intent: posPaymentIntentDto(attempt.intent),
    attempt: posPaymentAttemptDto(attempt),
    replayed: true,
  };
}

function replayCallback(
  callback: {
    id: bigint;
    intentId: string;
    payloadHash: string;
    processingResult: string;
    resultingState: string;
    resultingVersion: number;
    integrityIncident?: {
      id: string;
      kind: string;
      productionBlocking: boolean;
    } | null;
  },
  payloadHash: string,
) {
  if (callback.payloadHash !== payloadHash)
    throw new PosPaymentPersistenceError(
      "O evento do callback já foi usado com outro conteúdo.",
      409,
    );
  return {
    accepted: true,
    duplicate: true,
    applied: false,
    result: callback.processingResult,
    intentId: callback.intentId,
    state: callback.resultingState,
    version: callback.resultingVersion,
    callbackId: callback.id.toString(),
    incident: callback.integrityIncident
      ? {
          id: callback.integrityIncident.id,
          kind: callback.integrityIncident.kind,
          productionBlocking: callback.integrityIncident.productionBlocking,
        }
      : null,
  };
}

function observationEvidence(value: PosPaymentObservation) {
  return {
    providerReference: value.providerReference,
    state: value.state,
    amountCents: value.amountCents,
    currency: value.currency,
    providerSequence: value.providerSequence?.toString() ?? null,
    occurredAt: value.occurredAt?.toISOString() ?? null,
    evidenceId: value.evidenceId,
    transactionId: value.transactionId,
    endToEndId: value.endToEndId,
    nsu: value.nsu,
    authorizationCode: value.authorizationCode,
    cardBrand: value.cardBrand,
    cardLastFour: value.cardLastFour,
    failureCode: value.failureCode,
  };
}

function isObservationStale(
  intent: Prisma.PosPaymentIntentGetPayload<object>,
  observation: PosPaymentObservation,
) {
  return observation.providerSequence != null && intent.providerSequence != null
    ? observation.providerSequence <= intent.providerSequence
    : observation.occurredAt != null &&
        intent.providerOccurredAt != null &&
        observation.occurredAt <= intent.providerOccurredAt;
}

function authoritativePaymentEvidence(
  intent: Prisma.PosPaymentIntentGetPayload<object>,
  payment: Prisma.PosSalePaymentGetPayload<object> | null,
) {
  return {
    intentId: intent.id,
    status: intent.status,
    amountCents: intent.amountCents,
    currency: intent.currency,
    method: intent.method,
    installments: intent.installments,
    provider: intent.provider,
    providerReference: intent.providerReference,
    transactionId: intent.transactionId,
    endToEndId: intent.endToEndId,
    nsu: intent.nsu,
    authorizationCode: intent.authorizationCode,
    cardBrand: intent.cardBrand,
    cardLastFour: intent.cardLastFour,
    evidenceId: intent.evidenceId,
    providerSequence: intent.providerSequence?.toString() ?? null,
    providerOccurredAt: intent.providerOccurredAt?.toISOString() ?? null,
    salePayment: payment
      ? {
          id: payment.id,
          saleId: payment.saleId,
          status: payment.status,
          amountCents: payment.amountCents,
          method: payment.method,
          installments: payment.installments,
          provider: payment.provider,
          transactionId: payment.transactionId,
          endToEndId: payment.endToEndId,
          nsu: payment.nsu,
          authorizationCode: payment.authorizationCode,
          cardBrand: payment.cardBrand,
          cardLastFour: payment.cardLastFour,
          capturedAt: payment.capturedAt?.toISOString() ?? null,
        }
      : null,
  };
}

function consumedEvidenceDiverges(
  intent: Prisma.PosPaymentIntentGetPayload<object>,
  payment: Prisma.PosSalePaymentGetPayload<object> | null,
  observation: PosPaymentObservation,
) {
  if (
    !payment ||
    payment.paymentIntentId !== intent.id ||
    payment.amountCents !== intent.amountCents ||
    payment.method !== intent.method ||
    payment.installments !== intent.installments ||
    payment.provider !== intent.provider
  )
    return true;
  const conflicts = (authoritative: string | null, reported: string | null) =>
    authoritative != null && reported != null && authoritative !== reported;
  return (
    observation.provider !== intent.provider ||
    conflicts(intent.providerReference, observation.providerReference) ||
    conflicts(intent.transactionId, observation.transactionId) ||
    conflicts(intent.endToEndId, observation.endToEndId) ||
    conflicts(intent.nsu, observation.nsu) ||
    conflicts(intent.authorizationCode, observation.authorizationCode) ||
    conflicts(intent.cardBrand, observation.cardBrand) ||
    conflicts(intent.cardLastFour, observation.cardLastFour) ||
    !["captured", "partially_refunded", "refunded"].includes(observation.state)
  );
}

function paymentIntegrityIncidentDetails(
  intent: Prisma.PosPaymentIntentGetPayload<object>,
  payment: Prisma.PosSalePaymentGetPayload<object> | null,
  observation: PosPaymentObservation,
) {
  const differs = (left: string | null, right: string | null) =>
    left != null && right != null && left !== right;
  return {
    sessionId: intent.sessionId,
    registerId: intent.registerId,
    consumed: Boolean(intent.consumedAt),
    salePaymentPresent: Boolean(payment),
    amountMismatch: intent.amountCents !== observation.amountCents,
    currencyMismatch: intent.currency !== observation.currency,
    providerMismatch: intent.provider !== observation.provider,
    providerReferenceMismatch: differs(
      intent.providerReference,
      observation.providerReference,
    ),
    transactionMismatch: differs(
      intent.transactionId,
      observation.transactionId,
    ),
    endToEndMismatch: differs(intent.endToEndId, observation.endToEndId),
    nsuMismatch: differs(intent.nsu, observation.nsu),
    authorizationMismatch: differs(
      intent.authorizationCode,
      observation.authorizationCode,
    ),
    cardBrandMismatch: differs(intent.cardBrand, observation.cardBrand),
    cardLastFourMismatch: differs(
      intent.cardLastFour,
      observation.cardLastFour,
    ),
    reportedStateConflict:
      Boolean(intent.consumedAt) &&
      !["captured", "partially_refunded", "refunded"].includes(
        observation.state,
      ),
  };
}

function assertConnectorMethod(
  settings: Prisma.JsonValue,
  method: PosPersistedPaymentMethod,
) {
  const allowed = posConnectorAllowsPaymentMethod(settings, method);
  if (allowed === "invalid")
    throw new PosPaymentPersistenceError(
      "A allowlist de métodos do conector é inválida.",
      409,
    );
  if (!allowed)
    throw new PosPaymentPersistenceError(
      "O método não está habilitado neste conector.",
      409,
    );
}

export function posConnectorAllowsPaymentMethod(
  settings: Prisma.JsonValue,
  method: PosPersistedPaymentMethod,
): boolean | "invalid" {
  if (!settings || typeof settings !== "object" || Array.isArray(settings))
    return true;
  const methods = (settings as Record<string, unknown>).methods;
  if (methods == null) return true;
  if (
    !Array.isArray(methods) ||
    methods.some(
      (value) =>
        typeof value !== "string" ||
        !["pix", "credit", "debit", "voucher"].includes(value),
    )
  )
    return "invalid";
  return methods.includes(method);
}

function reconcileAt(state: PosPersistedPaymentState, now: Date) {
  if (["processing", "authorized"].includes(state))
    return new Date(now.valueOf() + 30_000);
  if (["unknown", "manual_review"].includes(state))
    return new Date(now.valueOf() + 60_000);
  return null;
}

function operationStatusEligible(operation: string, status: string) {
  if (operation === "create") return status === "created";
  if (operation === "query" || operation === "cancel")
    return ["processing", "authorized", "unknown", "manual_review"].includes(
      status,
    );
  if (operation === "refund")
    return ["captured", "partially_refunded"].includes(status);
  return false;
}

async function serializableRetry<T>(
  db: RootDb,
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (
    let attempt = 1;
    attempt <= POS_PAYMENT_WORK_LIMITS.serializationRetries;
    attempt += 1
  ) {
    try {
      return await db.$transaction(operation, {
        isolationLevel: "Serializable",
        maxWait: 10_000,
        timeout: 30_000,
      });
    } catch (error) {
      if (
        !isSerializationConflict(error) ||
        attempt === POS_PAYMENT_WORK_LIMITS.serializationRetries
      )
        throw error;
    }
  }
  throw new Error("Retry serializável de pagamentos esgotado.");
}

function retryDelayMs(attempt: number) {
  return Math.min(
    30 * 60_000,
    15_000 * 2 ** Math.min(Math.max(0, attempt - 1), 7),
  );
}
function isSerializationConflict(error: unknown) {
  const code = prismaCode(error),
    nested =
      error && typeof error === "object"
        ? (error as {
            originalCode?: unknown;
            meta?: { code?: unknown; originalCode?: unknown };
            cause?: { code?: unknown; originalCode?: unknown };
          })
        : {};
  return (
    code === "P2034" ||
    [
      nested.originalCode,
      nested.meta?.code,
      nested.meta?.originalCode,
      nested.cause?.code,
      nested.cause?.originalCode,
    ].some((value) => ["40001", "40P01"].includes(String(value || "")))
  );
}
function prismaCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code || "")
    : "";
}
function postgresErrorCode(error: unknown) {
  if (!error || typeof error !== "object") return "";
  const direct =
    "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  const meta =
    "meta" in error &&
    (error as { meta?: unknown }).meta &&
    typeof (error as { meta?: unknown }).meta === "object"
      ? (error as { meta: { code?: unknown } }).meta
      : null;
  return direct === "P2010" ? String(meta?.code ?? "") : direct;
}
function validDate(value: Date) {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf()))
    throw new PosPaymentPersistenceError("Data inválida.");
  return new Date(value);
}
function date(value: unknown, label: string) {
  if (typeof value !== "string" || value.length > 40)
    throw new PosPaymentPersistenceError(`${label} inválida.`);
  const result = new Date(value);
  if (
    Number.isNaN(result.valueOf()) ||
    result.valueOf() > Date.now() + 5 * 60_000 ||
    result.valueOf() < Date.now() - 90 * 86400_000
  )
    throw new PosPaymentPersistenceError(`${label} inválida.`);
  return result;
}
function futureDate(value: unknown, label: string) {
  if (typeof value !== "string" || value.length > 40)
    throw new PosPaymentPersistenceError(`${label} inválida.`);
  const result = new Date(value);
  if (
    Number.isNaN(result.valueOf()) ||
    result.valueOf() < Date.now() - 5 * 60_000 ||
    result.valueOf() > Date.now() + 7 * 86400_000
  )
    throw new PosPaymentPersistenceError(`${label} inválida.`);
  return result;
}
function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  const extra = Object.keys(value).find((item) => !allowed.includes(item));
  if (extra)
    throw new PosPaymentPersistenceError(`Campo não permitido: ${extra}.`, 400);
}
function record(value: unknown, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new PosPaymentPersistenceError(`${label} inválido.`, 400);
  return value as Record<string, unknown>;
}
function bounded(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new PosPaymentPersistenceError(
      `${label} deve estar entre ${minimum} e ${maximum}.`,
    );
  return value;
}
function integer(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
) {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    throw new PosPaymentPersistenceError(`${label} inválido.`);
  return value;
}
function choice<const T extends readonly string[]>(
  value: unknown,
  values: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !values.includes(value))
    throw new PosPaymentPersistenceError(`${label} inválido.`);
  return value as T[number];
}
function identifier(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
) {
  if (typeof value !== "string")
    throw new PosPaymentPersistenceError(`${label} inválido.`);
  const result = value.normalize("NFKC").trim();
  if (
    result.length < minimum ||
    result.length > maximum ||
    /[\u0000-\u001f]/.test(result)
  )
    throw new PosPaymentPersistenceError(`${label} inválido.`);
  return result;
}
function pciSafeIdentifier(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
) {
  const result = identifier(value, label, minimum, maximum);
  if (containsPosPaymentPanInIdentifier(result))
    throw new PosPaymentPersistenceError(
      `${label} contém dados de cartão proibidos.`,
      400,
    );
  return result;
}
function nullableIdentifier(value: unknown, label: string, maximum: number) {
  return value == null || value === ""
    ? null
    : identifier(value, label, 1, maximum);
}
function nullableText(value: unknown, label: string, maximum: number) {
  return value == null || value === ""
    ? null
    : identifier(value, label, 1, maximum);
}
function code(value: unknown, label: string, maximum: number) {
  const result = identifier(value, label, 1, maximum).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._:-]*$/.test(result))
    throw new PosPaymentPersistenceError(`${label} inválido.`);
  return result;
}
function nullableCode(value: unknown, label: string, maximum: number) {
  return value == null || value === "" ? null : code(value, label, maximum);
}
function key(value: unknown, label: string) {
  const result = pciSafeIdentifier(value, label, 16, 160);
  if (!/^[A-Za-z0-9._:-]+$/.test(result))
    throw new PosPaymentPersistenceError(`${label} inválido.`);
  return result;
}
function providerKey(value: unknown) {
  const result = code(value, "Provider", 80);
  if (result.length < 2)
    throw new PosPaymentPersistenceError("Provider inválido.");
  return result;
}
function cardLastFour(value: unknown) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !/^[0-9]{4}$/.test(value))
    throw new PosPaymentPersistenceError("Últimos quatro dígitos inválidos.");
  return value;
}
function currencyCode(value: unknown) {
  if (typeof value !== "string" || !/^[A-Z]{3}$/.test(value))
    throw new PosPaymentPersistenceError("Moeda inválida.");
  return value;
}
function rejectSensitiveData(value: unknown, depth = 0, fieldName = "") {
  if (depth > 8)
    throw new PosPaymentPersistenceError(
      "Payload excede a profundidade permitida.",
      400,
    );
  const endToEnd = /^endtoendid$/i.test(fieldName);
  const strictEvidence =
    /(?:reference|transactionid|authorizationcode|nsu|evidenceid|failurecode|failuremessage|brand|endtoendid)/i.test(
      fieldName,
    );
  if (
    typeof value === "string" &&
    (containsPosPaymentPan(value) ||
      (strictEvidence &&
        !(endToEnd && isCanonicalPixEndToEndId(value)) &&
        containsPosPaymentPanInIdentifier(value)))
  )
    throw new PosPaymentPersistenceError(
      "Dados sensíveis de cartão não são aceitos.",
      400,
    );
  if (Array.isArray(value)) {
    for (const item of value) rejectSensitiveData(item, depth + 1, fieldName);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [field, item] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (
      /(?:pan|cvv|cvc|track|magnetic|pin_?block|card_?number|numero_?cartao|full_?card)/i.test(
        field,
      )
    )
      throw new PosPaymentPersistenceError(
        "Dados sensíveis de cartão não são aceitos.",
        400,
      );
    rejectSensitiveData(item, depth + 1, field);
  }
}
export function containsPosPaymentPan(value: string) {
  const normalized = value.normalize("NFKC"),
    matches = normalized.matchAll(/[0-9\s./_-]+/g);
  for (const match of matches) {
    const candidate = match[0],
      firstDigit = candidate.search(/[0-9]/),
      lastDigit = Math.max(
        ...[...candidate.matchAll(/[0-9]/g)].map((item) => item.index),
      );
    if (firstDigit < 0 || lastDigit < 0) continue;
    const start = (match.index ?? 0) + firstDigit,
      end = (match.index ?? 0) + lastDigit;
    if (
      /[A-Za-z0-9]/.test(normalized[start - 1] || "") ||
      /[A-Za-z0-9]/.test(normalized[end + 1] || "")
    )
      continue;
    const digits = candidate
      .slice(firstDigit, lastDigit + 1)
      .replace(/[^0-9]/g, "");
    if (digits.length < 12 || digits.length > 19) continue;
    let sum = 0,
      alternate = false;
    for (let index = digits.length - 1; index >= 0; index -= 1) {
      let digit = Number(digits[index]);
      if (alternate) {
        digit *= 2;
        if (digit > 9) digit -= 9;
      }
      sum += digit;
      alternate = !alternate;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}
export function containsPosPaymentPanInIdentifier(value: string) {
  const normalized = value.normalize("NFKC");
  return (
    containsPosPaymentPan(normalized) ||
    containsPosPaymentPan(normalized.replace(/[^0-9\s./_-]/g, " "))
  );
}
function isCanonicalPixEndToEndId(value: string) {
  return /^E[0-9]{16}[A-Z0-9]{15}$/.test(value.normalize("NFKC").trim());
}
function canonicalJson(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((field) => record[field] !== undefined)
    .sort()
    .map((field) => `${JSON.stringify(field)}:${canonicalJson(record[field])}`)
    .join(",")}}`;
}
function json(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
}
