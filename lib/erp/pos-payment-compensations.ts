import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@/generated/tenant/client";

export const POS_PAYMENT_COMPENSATION_STATES = [
  "requested",
  "processing",
  "unknown",
  "provider_succeeded",
  "application_pending",
  "applied",
  "declined",
  "manual_review",
  "cancelled",
] as const;

export const POS_PAYMENT_COMPENSATION_PROVIDER_STATES = ["pending", "processing", "unknown", "succeeded", "declined", "manual_review", "cancelled"] as const;
export const POS_PAYMENT_COMPENSATION_APPLICATION_STATES = ["not_ready", "pending", "applying", "applied", "blocked"] as const;

export type PosPaymentCompensationState = typeof POS_PAYMENT_COMPENSATION_STATES[number];
export type PosPaymentCompensationProviderState = typeof POS_PAYMENT_COMPENSATION_PROVIDER_STATES[number];
export type PosPaymentCompensationApplicationState = typeof POS_PAYMENT_COMPENSATION_APPLICATION_STATES[number];

export type PosPaymentCompensationRequest = {
  action: "compensation.request";
  sessionId: number;
  terminalId: string;
  originalPaymentId: string;
  returnId: string | null;
  approvalId: string;
  kind: "void" | "refund";
  amountCents: number;
  currency: "BRL";
  idempotencyKey: string;
};

export type PosPaymentCompensationObservation = {
  compensationId: string;
  provider: string;
  originalProviderReference: string;
  providerOperationReference: string;
  state: "processing" | "unknown" | "succeeded" | "declined";
  requestedAmountCents: number;
  confirmedAmountCents: number;
  currency: "BRL";
  providerSequence: bigint | null;
  occurredAt: Date;
  evidenceHash: string;
  failureCode: string | null;
  failureMessage: string | null;
};

export class PosPaymentCompensationError extends Error {
  constructor(message: string, public readonly status = 422) {
    super(message);
    this.name = "PosPaymentCompensationError";
  }
}

export type PosPaymentCompensationContext = {
  branchId: number;
  actorUserId: string;
  actorProfileId: number;
  actorName: string;
  privileged: boolean;
};

export function parsePosPaymentCompensationRequest(body: Record<string, unknown>): PosPaymentCompensationRequest {
  rejectSensitiveData(body);
  onlyKeys(body, ["action", "sessionId", "terminalId", "originalPaymentId", "returnId", "approvalId", "kind", "amountCents", "currency", "idempotencyKey"]);
  if (body.action !== "compensation.request") throw new PosPaymentCompensationError("Ação compensatória inválida.", 400);
  return {
    action: "compensation.request",
    sessionId: integer(body.sessionId, "Turno", 1, 2_147_483_647),
    terminalId: identifier(body.terminalId, "Terminal", 1, 160),
    originalPaymentId: identifier(body.originalPaymentId, "Pagamento original", 1, 160),
    returnId: nullableIdentifier(body.returnId, "Devolução", 160),
    approvalId: identifier(body.approvalId, "Aprovação", 1, 160),
    kind: choice(body.kind, ["void", "refund"] as const, "Tipo de compensação"),
    amountCents: integer(body.amountCents, "Valor", 1, 2_147_483_647),
    currency: choice(body.currency ?? "BRL", ["BRL"] as const, "Moeda"),
    idempotencyKey: idempotencyKey(body.idempotencyKey),
  };
}

export function parsePosPaymentCompensationObservation(body: Record<string, unknown>): PosPaymentCompensationObservation {
  rejectSensitiveData(body);
  onlyKeys(body, ["compensationId", "provider", "originalReference", "operationReference", "state", "requestedAmountCents", "confirmedAmountCents", "currency", "sequence", "occurredAt", "evidenceHash", "failureCode", "failureMessage"]);
  const state = choice(body.state, ["processing", "unknown", "succeeded", "declined"] as const, "Estado do provedor");
  const requestedAmountCents = integer(body.requestedAmountCents, "Valor solicitado", 1, 2_147_483_647);
  const confirmedAmountCents = integer(body.confirmedAmountCents, "Valor confirmado", 1, 2_147_483_647);
  if (state === "succeeded" && confirmedAmountCents !== requestedAmountCents) {
    throw new PosPaymentCompensationError("O provedor reportou sucesso com valor diferente; encaminhe para revisão manual.", 409);
  }
  return {
    compensationId: identifier(body.compensationId, "Compensação", 1, 160),
    provider: providerKey(body.provider),
    originalProviderReference: identifier(body.originalReference, "Referência original", 1, 160),
    providerOperationReference: identifier(body.operationReference, "Referência da compensação", 1, 160),
    state,
    requestedAmountCents,
    confirmedAmountCents,
    currency: choice(body.currency, ["BRL"] as const, "Moeda"),
    providerSequence: body.sequence == null ? null : BigInt(integer(body.sequence, "Sequência", 1, Number.MAX_SAFE_INTEGER)),
    occurredAt: date(body.occurredAt, "Data do provedor"),
    evidenceHash: sha256(body.evidenceHash, "Hash de evidência"),
    failureCode: nullableCode(body.failureCode, "Falha", 80),
    failureMessage: nullableText(body.failureMessage, "Descrição da falha", 300),
  };
}

export function assertPosPaymentCompensationTransition(current: PosPaymentCompensationState, next: PosPaymentCompensationState) {
  const transitions: Record<PosPaymentCompensationState, readonly PosPaymentCompensationState[]> = {
    requested: ["requested", "processing", "unknown", "provider_succeeded", "declined", "manual_review", "cancelled"],
    processing: ["processing", "unknown", "provider_succeeded", "declined", "manual_review"],
    unknown: ["unknown", "processing", "provider_succeeded", "declined", "manual_review"],
    provider_succeeded: ["provider_succeeded", "application_pending", "manual_review"],
    application_pending: ["application_pending", "applied", "manual_review"],
    manual_review: ["manual_review", "processing", "application_pending", "declined", "cancelled"],
    applied: ["applied"],
    declined: ["declined"],
    cancelled: ["cancelled"],
  };
  if (!transitions[current]?.includes(next)) {
    throw new PosPaymentCompensationError(`Transição compensatória inválida: ${current} → ${next}.`, 409);
  }
  return next;
}

export function assertPosPaymentCompensationStateTuple(input: {
  status: PosPaymentCompensationState;
  providerState: PosPaymentCompensationProviderState;
  applicationState: PosPaymentCompensationApplicationState;
}) {
  if (input.status === "applied" && (input.providerState !== "succeeded" || input.applicationState !== "applied")) {
    throw new PosPaymentCompensationError("Compensação aplicada exige sucesso imutável do provedor e aplicação local concluída.", 409);
  }
  if (["pending", "applying", "blocked"].includes(input.applicationState) && input.providerState !== "succeeded") {
    throw new PosPaymentCompensationError("A aplicação local só pode começar após o resultado do provedor ser persistido.", 409);
  }
  if (input.providerState !== "succeeded" && ["provider_succeeded", "application_pending", "applied"].includes(input.status)) {
    throw new PosPaymentCompensationError("O estado comercial contradiz o resultado do provedor.", 409);
  }
  return input;
}

export function hashPosPaymentCompensationPayload(value: unknown) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/**
 * Reserves one exact electronic compensation and its first outbox delivery.
 * Provider dispatch and local refund application intentionally happen in
 * later transactions and are not implemented by this producer.
 */
export async function requestPosPaymentCompensation(
  db: PrismaClient,
  context: PosPaymentCompensationContext,
  input: PosPaymentCompensationRequest,
) {
  const requestHash = hashPosPaymentCompensationPayload(input);
  const replay = await db.posPaymentCompensation.findUnique({ where: { idempotencyKey: input.idempotencyKey }, include: { attempts: { include: { outbox: true }, orderBy: { sequence: "asc" } } } });
  if (replay) {
    if (replay.branchId !== context.branchId || replay.requesterProfileId !== context.actorProfileId || replay.requestHash !== requestHash) {
      throw new PosPaymentCompensationError("A chave idempotente já pertence a outro pedido compensatório.", 409);
    }
    return { compensation: replay, replayed: true };
  }

  return db.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_sale_payments" WHERE "id" = ${input.originalPaymentId} FOR UPDATE`);
    const original = await tx.posSalePayment.findUnique({
      where: { id: input.originalPaymentId },
      include: { sale: true, paymentIntent: true, refunds: { select: { amountCents: true, status: true } } },
    });
    if (!original || original.type !== "payment" || !["pix", "credit", "debit", "voucher"].includes(original.method)) {
      throw new PosPaymentCompensationError("Pagamento eletrônico original não encontrado.", 404);
    }
    if (!original.paymentIntent || !original.paymentIntent.consumedAt || !["captured", "partially_refunded"].includes(original.status)) {
      throw new PosPaymentCompensationError("O pagamento original não está elegível para compensação.", 409);
    }
    if (original.sale.branchId !== context.branchId || !original.connectorId || !original.provider || !original.paymentIntent.providerReference) {
      throw new PosPaymentCompensationError("A evidência original está incompleta ou fora da filial.", 409);
    }
    const now = new Date();
    const session = await tx.cashRegisterSession.findFirst({ where: {
      id: input.sessionId,
      operatorProfileId: context.actorProfileId,
      status: "open",
      register: { branchId: context.branchId, status: "active" },
    }, select: { id: true, registerId: true } });
    if (!session?.registerId) throw new PosPaymentCompensationError("Turno aberto do solicitante não encontrado.", 404);
    const terminal = await tx.posTerminal.findFirst({ where: {
      id: input.terminalId,
      registerId: session.registerId,
      status: "online",
      pairedAt: { not: null },
      revokedAt: null,
      tokenHash: { not: null },
      tokenExpiresAt: { gt: now },
      appVersion: { not: null },
      lastSeenAt: { gte: new Date(now.valueOf() - 5 * 60_000) },
    }, select: { id: true } });
    if (!terminal) throw new PosPaymentCompensationError("Terminal autenticado, pareado e vigente não encontrado neste caixa.", 401);
    if (!context.privileged) {
      const access = await tx.posRegisterAccess.findFirst({ where: {
        registerId: session.registerId,
        userProfileId: context.actorProfileId,
        active: true,
        canRefund: true,
        AND: [
          { OR: [{ validFrom: null }, { validFrom: { lte: now } }] },
          { OR: [{ validUntil: null }, { validUntil: { gte: now } }] },
        ],
      }, select: { id: true } });
      if (!access) throw new PosPaymentCompensationError("O solicitante não possui alçada viva de estorno neste caixa.", 403);
    }
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_approvals" WHERE "id" = ${input.approvalId} FOR UPDATE`);
    const approval = await tx.posApproval.findFirst({ where: {
      id: input.approvalId,
      branchId: context.branchId,
      entityType: "sale",
      entityId: String(original.saleId),
      action: input.returnId ? "return.create" : "sale.cancel",
      status: "approved",
      requesterId: context.actorUserId,
      approverId: { not: null },
      expiresAt: { gt: now },
    } });
    if (!approval || approval.approverId === approval.requesterId) {
      throw new PosPaymentCompensationError("Aprovação independente vigente não encontrada para esta operação.", 409);
    }
    assertApprovedCompensationAllocation(approval.context, {
      action: approval.action as "sale.cancel" | "return.create",
      saleId: original.saleId,
      branchId: context.branchId,
      sessionId: session.id,
      registerId: session.registerId,
      paymentId: original.id,
      amountCents: input.amountCents,
    });
    if (input.returnId) {
      const returned = await tx.posReturn.findFirst({ where: { id: input.returnId, saleId: original.saleId, totalRefundCents: { gte: input.amountCents } }, select: { id: true } });
      if (!returned) throw new PosPaymentCompensationError("A devolução aprovada não está reservada para esta venda.", 409);
    }
    const rejectedRefundStates = ["failed", "cancelled", "declined"];
    const materializedCents = original.refunds.filter((refund) => !rejectedRefundStates.includes(refund.status)).reduce((sum, refund) => sum + refund.amountCents, 0);
    const reserved = await tx.posPaymentCompensation.aggregate({ where: { originalPaymentId: original.id, status: { notIn: ["declined", "cancelled"] } }, _sum: { requestedAmountCents: true } });
    if (materializedCents + (reserved._sum.requestedAmountCents ?? 0) + input.amountCents > original.amountCents) {
      throw new PosPaymentCompensationError("A compensação supera o saldo disponível do pagamento original.", 409);
    }

    const compensationId = randomUUID(), attemptId = randomUUID();
    const compensation = await tx.posPaymentCompensation.create({ data: {
      id: compensationId,
      branchId: context.branchId,
      registerId: session.registerId,
      sessionId: session.id,
      requesterProfileId: context.actorProfileId,
      terminalId: terminal.id,
      connectorId: original.paymentIntent.connectorId,
      credentialRef: original.paymentIntent.credentialRef,
      originalIntentId: original.paymentIntent.id,
      originalPaymentId: original.id,
      saleId: original.saleId,
      returnId: input.returnId,
      approvalId: approval.id,
      kind: input.kind,
      requestedAmountCents: input.amountCents,
      currency: input.currency,
      method: original.method,
      provider: original.provider,
      originalProviderReference: original.paymentIntent.providerReference,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      attempts: { create: {
        id: attemptId,
        sequence: 1,
        operation: input.kind,
        operationKey: input.idempotencyKey,
        requestHash,
        providerIdempotencyKey: input.idempotencyKey,
        outbox: { create: { nextAttemptAt: now } },
      } },
      stateEvents: { create: {
        eventKey: `payment-compensation:${compensationId}:0`,
        source: "api",
        sourceId: input.idempotencyKey,
        fromState: null,
        toState: "requested",
        resultingVersion: 0,
      } },
    }, include: { attempts: { include: { outbox: true }, orderBy: { sequence: "asc" } } } });
    await tx.tenantAuditEvent.create({ data: {
      actorId: context.actorUserId,
      action: "pos.payment.compensation.requested",
      entityType: "pos_payment_compensation",
      entityId: compensation.id,
      correlationId: randomUUID(),
      afterData: {
        branchId: context.branchId,
        registerId: session.registerId,
        sessionId: session.id,
        terminalId: terminal.id,
        saleId: original.saleId,
        returnId: input.returnId,
        originalPaymentId: original.id,
        approvalId: approval.id,
        kind: input.kind,
        amountCents: input.amountCents,
        provider: original.provider,
        requestHash,
      },
    } });
    return { compensation, replayed: false };
  }, { isolationLevel: "Serializable" }).catch(async (error) => {
    if ((error as { code?: string }).code === "P2002" || (error as { code?: string }).code === "P2034") {
      const concurrent = await db.posPaymentCompensation.findUnique({ where: { idempotencyKey: input.idempotencyKey }, include: { attempts: { include: { outbox: true }, orderBy: { sequence: "asc" } } } });
      if (concurrent && concurrent.branchId === context.branchId && concurrent.requesterProfileId === context.actorProfileId && concurrent.requestHash === requestHash) {
        return { compensation: concurrent, replayed: true };
      }
    }
    throw error;
  });
}

function assertApprovedCompensationAllocation(context: unknown, expected: {
  action: "sale.cancel" | "return.create";
  saleId: number;
  branchId: number;
  sessionId: number;
  registerId: number;
  paymentId: string;
  amountCents: number;
}) {
  if (!context || typeof context !== "object" || Array.isArray(context)) throw new PosPaymentCompensationError("A aprovação não possui snapshot financeiro autoritativo.", 409);
  const record = context as Record<string, unknown>;
  const sale = record.sale as Record<string, unknown> | undefined;
  const operation = record.operation as Record<string, unknown> | undefined;
  const { contentHash, ...payload } = record;
  if (record.schemaVersion !== 1 || record.action !== expected.action || typeof contentHash !== "string" || contentHash !== hashPosPaymentCompensationPayload(payload)
    || !sale || !operation || sale.id !== expected.saleId || sale.branchId !== expected.branchId
    || operation.processingSessionId !== expected.sessionId || operation.registerId !== expected.registerId) {
    throw new PosPaymentCompensationError("A aprovação não corresponde ao snapshot financeiro desta compensação.", 409);
  }
  if (expected.action === "return.create") {
    const allocations = Array.isArray(operation.allocations) ? operation.allocations : [];
    if (!allocations.some((entry) => entry && typeof entry === "object" && !Array.isArray(entry)
      && (entry as Record<string, unknown>).paymentId === expected.paymentId
      && (entry as Record<string, unknown>).amountCents === expected.amountCents)) {
      throw new PosPaymentCompensationError("A alocação aprovada não corresponde ao pagamento e valor da compensação.", 409);
    }
    return;
  }
  const payments = Array.isArray(sale.payments) ? sale.payments : [];
  if (!payments.some((entry) => entry && typeof entry === "object" && !Array.isArray(entry)
    && (entry as Record<string, unknown>).paymentId === expected.paymentId
    && (entry as Record<string, unknown>).availableRefundCents === expected.amountCents)) {
    throw new PosPaymentCompensationError("O cancelamento aprovado não corresponde ao pagamento e valor da compensação.", 409);
  }
}

function rejectSensitiveData(value: unknown, depth = 0): void {
  if (depth > 6) throw new PosPaymentCompensationError("Payload compensatório muito profundo.", 400);
  if (Array.isArray(value)) {
    if (value.length > 200) throw new PosPaymentCompensationError("Payload compensatório excede o limite.", 400);
    for (const item of value) rejectSensitiveData(item, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (["pan", "cardnumber", "cvv", "cvc", "track1", "track2", "password", "secret", "pin"].some((forbidden) => normalized.includes(forbidden))) {
      throw new PosPaymentCompensationError("Payload compensatório contém dado sensível proibido.", 400);
    }
    rejectSensitiveData(item, depth + 1);
  }
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra) throw new PosPaymentCompensationError(`Campo compensatório não permitido: ${extra}.`, 400);
}

function identifier(value: unknown, label: string, minimum: number, maximum: number) {
  const result = String(value ?? "").normalize("NFKC").trim();
  if (result.length < minimum || result.length > maximum || /[\u0000-\u001f\u007f]/.test(result)) throw new PosPaymentCompensationError(`${label} inválido.`);
  return result;
}

function nullableIdentifier(value: unknown, label: string, maximum: number) {
  if (value == null || String(value).trim() === "") return null;
  return identifier(value, label, 1, maximum);
}

function integer(value: unknown, label: string, minimum: number, maximum: number) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new PosPaymentCompensationError(`${label} inválido.`);
  return result;
}

function choice<const T extends readonly string[]>(value: unknown, choices: T, label: string): T[number] {
  const result = String(value ?? "") as T[number];
  if (!choices.includes(result)) throw new PosPaymentCompensationError(`${label} inválido.`);
  return result;
}

function idempotencyKey(value: unknown) {
  const result = identifier(value, "Chave idempotente", 16, 160);
  if (!/^[A-Za-z0-9._:-]+$/.test(result)) throw new PosPaymentCompensationError("Chave idempotente inválida.");
  return result;
}

function providerKey(value: unknown) {
  const result = identifier(value, "Provedor", 2, 80).toLocaleLowerCase("en-US");
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(result)) throw new PosPaymentCompensationError("Provedor inválido.");
  return result;
}

function sha256(value: unknown, label: string) {
  const result = String(value ?? "").toLocaleLowerCase("en-US");
  if (!/^[0-9a-f]{64}$/.test(result)) throw new PosPaymentCompensationError(`${label} inválido.`);
  return result;
}

function date(value: unknown, label: string) {
  const result = new Date(String(value ?? ""));
  if (!Number.isFinite(result.valueOf())) throw new PosPaymentCompensationError(`${label} inválida.`);
  return result;
}

function nullableCode(value: unknown, label: string, maximum: number) {
  const result = nullableIdentifier(value, label, maximum);
  if (result && !/^[A-Za-z0-9._:-]+$/.test(result)) throw new PosPaymentCompensationError(`${label} inválida.`);
  return result;
}

function nullableText(value: unknown, label: string, maximum: number) {
  const result = value == null ? "" : String(value).normalize("NFKC").trim();
  if (!result) return null;
  if (result.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(result)) throw new PosPaymentCompensationError(`${label} inválida.`);
  return result;
}

function canonicalJson(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
