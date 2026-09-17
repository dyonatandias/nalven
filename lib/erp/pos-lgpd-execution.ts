import { createHash, createHmac, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@/generated/tenant/client";
import { containsPosPaymentPanInIdentifier } from "@/lib/erp/pos-payment-persistence";

export const POS_LGPD_REQUEST_TYPES = ["access", "export", "portability", "correction", "restriction", "objection", "anonymization", "deletion"] as const;
export const POS_LGPD_DESTRUCTIVE_REQUEST_TYPES = ["anonymization", "deletion"] as const;
export const POS_LGPD_JOB_ACTIONS = ["export", "anonymize", "delete"] as const;

export type PosLgpdRequestType = typeof POS_LGPD_REQUEST_TYPES[number];
export type PosLgpdJobAction = typeof POS_LGPD_JOB_ACTIONS[number];

export class PosLgpdError extends Error {
  constructor(message: string, public readonly status = 422) {
    super(message);
    this.name = "PosLgpdError";
  }
}

type RootDb = PrismaClient;
type Tx = Prisma.TransactionClient;

export function hashPosLgpdPayload(value: unknown) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/**
 * Derives a lookup digest with a dedicated mandatory pepper and domain
 * separation. The normalized input is never returned or persisted.
 */
export type PosLgpdTokenDomain = "subject" | "contact" | "object-key" | "request-idempotency" | "hold-idempotency" | "job-idempotency";

export function derivePosLgpdTokenHash(value: string, domain: PosLgpdTokenDomain, label = "Token") {
  const token = String(value ?? "").trim();
  if (token.length < 16 || token.length > 512 || /[\x00-\x1f\x7f]/.test(token)) throw new PosLgpdError(`${label} de entrada inválido.`, 400);
  if (containsPosPaymentPanInIdentifier(token)) throw new PosLgpdError(`PAN não permitido em ${label}.`, 400);
  const context = posLgpdTokenContext();
  const digest = createHmac("sha256", context.pepper).update(`nalven:pos-lgpd:v${context.version}:${domain}\0`, "utf8").update(token, "utf8").digest("hex");
  return { digest, keyId: context.keyId, version: context.version };
}

function posLgpdTokenContext() {
  const pepper = process.env.POS_LGPD_TOKEN_PEPPER;
  const keyIdValue = process.env.POS_LGPD_TOKEN_KEY_ID;
  if (!pepper || Buffer.byteLength(pepper, "utf8") < 32) throw new PosLgpdError("POS_LGPD_TOKEN_PEPPER obrigatório e deve possuir ao menos 32 bytes.", 500);
  if (!keyIdValue) throw new PosLgpdError("POS_LGPD_TOKEN_KEY_ID obrigatório.", 500);
  return { pepper, keyId: safeCode(keyIdValue, "Key ID do token"), version: 1 } as const;
}

function sha256Digest(value: string, label: string) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new PosLgpdError(`${label} deve ser um hash SHA-256.`, 400);
  return normalized;
}

export async function createPosLgpdSubjectRequest(db: RootDb, inputValue: {
  idempotencyKeyHash: string;
  subjectTokenHash: string;
  contactTokenHash?: string | null;
  requestType: PosLgpdRequestType;
  scope: Record<string, unknown>;
  dueAt: Date;
  createdBy: string;
  now?: Date;
  correlationId?: string;
}) {
  const input = normalizeSubjectRequest(inputValue);
  const existing = await db.posLgpdSubjectRequest.findUnique({ where: { idempotencyKeyHash: input.idempotencyKeyHash }, include: { stateLedger: { orderBy: { sequence: "asc" } } } });
  if (existing) return replaySubjectRequest(existing, input);
  return serializableRetry(db, async (tx) => {
    const concurrent = await tx.posLgpdSubjectRequest.findUnique({ where: { idempotencyKeyHash: input.idempotencyKeyHash }, include: { stateLedger: { orderBy: { sequence: "asc" } } } });
    if (concurrent) return replaySubjectRequest(concurrent, input);
    const id = randomUUID();
    const request = await tx.posLgpdSubjectRequest.create({ data: {
      id,
      idempotencyKeyHash: input.idempotencyKeyHash,
      subjectTokenHash: input.subjectTokenHash,
      contactTokenHash: input.contactTokenHash,
      tokenKeyId: input.tokenKeyId,
      tokenVersion: input.tokenVersion,
      requestType: input.requestType,
      scopeHash: input.scopeHash,
      dueAt: input.dueAt,
      createdBy: input.createdBy,
      createdAt: input.now,
      updatedAt: input.now,
    } });
    await appendRequestLedger(tx, { requestId: id, sequence: 1, fromState: null, toState: "received", actorId: input.createdBy, reasonCode: "request.received", correlationId: input.correlationId, occurredAt: input.now });
    await appendEvidence(tx, { aggregateType: "request", aggregateId: id, evidenceType: "request.received", manifestHash: hashPosLgpdPayload({ requestType: input.requestType, subjectTokenHash: input.subjectTokenHash, scopeHash: input.scopeHash, dueAt: input.dueAt.toISOString() }), actorId: input.createdBy, correlationId: input.correlationId });
    await audit(tx, input.createdBy, "pos.lgpd.request.received", "pos_lgpd_subject_request", id, input.correlationId, { requestType: input.requestType, state: "received", scopeHash: input.scopeHash, dueAt: input.dueAt.toISOString() });
    return { request, replayed: false };
  }).catch(async (error) => {
    if (isUniqueOrSerialization(error)) {
      const replay = await db.posLgpdSubjectRequest.findUnique({ where: { idempotencyKeyHash: input.idempotencyKeyHash }, include: { stateLedger: { orderBy: { sequence: "asc" } } } });
      if (replay) return replaySubjectRequest(replay, input);
    }
    throw error;
  });
}

export async function advancePosLgpdSubjectRequest(db: RootDb, inputValue: {
  requestId: string;
  expectedVersion: number;
  toState: "identity_pending" | "verified" | "scoping" | "cancelled";
  actorId: string;
  reasonCode: string;
  now?: Date;
  correlationId?: string;
}) {
  const input = normalizeTransition(inputValue);
  return serializableRetry(db, async (tx) => {
    const current = await lockRequest(tx, input.requestId);
    if (current.version !== input.expectedVersion) throw new PosLgpdError("A solicitação LGPD mudou; recarregue antes de continuar.", 409);
    const allowed = new Map<string, string[]>([
      ["received", ["identity_pending", "cancelled"]],
      ["identity_pending", ["verified", "cancelled"]],
      ["verified", ["scoping", "cancelled"]],
      ["scoping", ["cancelled"]],
      ["decision_pending", ["cancelled"]],
      ["approved", ["cancelled"]],
      ["queued", ["cancelled"]],
    ]);
    if (!allowed.get(current.state)?.includes(input.toState)) throw new PosLgpdError("Transição LGPD não permitida.", 409);
    const nextVersion = current.version + 1;
    const updated = await tx.posLgpdSubjectRequest.update({ where: { id: current.id }, data: {
      state: input.toState,
      version: nextVersion,
      verifiedAt: input.toState === "verified" ? input.now : undefined,
      updatedAt: input.now,
    } });
    await appendRequestLedger(tx, { requestId: current.id, sequence: nextVersion, fromState: current.state, toState: input.toState, actorId: input.actorId, reasonCode: input.reasonCode, correlationId: input.correlationId, occurredAt: input.now });
    await audit(tx, input.actorId, "pos.lgpd.request.transitioned", "pos_lgpd_subject_request", current.id, input.correlationId, { fromState: current.state, toState: input.toState, version: nextVersion });
    return updated;
  });
}

export async function proposePosLgpdDecision(db: RootDb, inputValue: {
  requestId: string;
  expectedVersion: number;
  proposedBy: string;
  reasonCode: string;
  now?: Date;
  correlationId?: string;
}) {
  const input = normalizeDecision(inputValue);
  return serializableRetry(db, async (tx) => {
    const current = await lockRequest(tx, input.requestId);
    if (current.version !== input.expectedVersion) throw new PosLgpdError("A solicitação LGPD mudou; recarregue antes de decidir.", 409);
    if (current.state !== "scoping") throw new PosLgpdError("A solicitação precisa estar em escopo antes da proposta.", 409);
    const nextVersion = current.version + 1;
    const updated = await tx.posLgpdSubjectRequest.update({ where: { id: current.id }, data: { state: "decision_pending", version: nextVersion, decisionProposedBy: input.actorId, decisionReasonCode: input.reasonCode, updatedAt: input.now } });
    await appendRequestLedger(tx, { requestId: current.id, sequence: nextVersion, fromState: current.state, toState: "decision_pending", actorId: input.actorId, reasonCode: input.reasonCode, correlationId: input.correlationId, occurredAt: input.now });
    await audit(tx, input.actorId, "pos.lgpd.request.decision_proposed", "pos_lgpd_subject_request", current.id, input.correlationId, { requestType: current.requestType, reasonCode: input.reasonCode, version: nextVersion });
    return updated;
  });
}

export async function decidePosLgpdSubjectRequest(db: RootDb, inputValue: {
  requestId: string;
  expectedVersion: number;
  decision: "approved" | "rejected";
  approvedBy: string;
  reasonCode: string;
  stepUpProofHash?: string | null;
  now?: Date;
  correlationId?: string;
}) {
  const input = normalizeDecision({ ...inputValue, proposedBy: inputValue.approvedBy });
  const decision = inputValue.decision;
  if (!(["approved", "rejected"] as const).includes(decision)) throw new PosLgpdError("Decisão LGPD inválida.", 400);
  const stepUpProofHash = inputValue.stepUpProofHash == null ? null : sha256Digest(inputValue.stepUpProofHash, "Prova de step-up");
  return serializableRetry(db, async (tx) => {
    const current = await lockRequest(tx, input.requestId);
    if (current.version !== input.expectedVersion) throw new PosLgpdError("A solicitação LGPD mudou; recarregue antes de decidir.", 409);
    if (current.state !== "decision_pending" || !current.decisionProposedBy) throw new PosLgpdError("Não existe proposta pendente para decisão.", 409);
    const destructive = POS_LGPD_DESTRUCTIVE_REQUEST_TYPES.includes(current.requestType as typeof POS_LGPD_DESTRUCTIVE_REQUEST_TYPES[number]);
    if (destructive && (current.decisionProposedBy === input.actorId || !stepUpProofHash)) throw new PosLgpdError("Decisão destrutiva exige checker distinto e prova de step-up.", 403);
    const nextVersion = current.version + 1;
    const updated = await tx.posLgpdSubjectRequest.update({ where: { id: current.id }, data: {
      state: decision,
      version: nextVersion,
      decisionApprovedBy: input.actorId,
      decisionReasonCode: input.reasonCode,
      decisionStepUpHash: stepUpProofHash,
      decidedAt: input.now,
      updatedAt: input.now,
    } });
    await appendRequestLedger(tx, { requestId: current.id, sequence: nextVersion, fromState: current.state, toState: decision, actorId: input.actorId, reasonCode: input.reasonCode, correlationId: input.correlationId, occurredAt: input.now });
    await appendEvidence(tx, { aggregateType: "request", aggregateId: current.id, evidenceType: `decision.${decision}`, manifestHash: hashPosLgpdPayload({ requestType: current.requestType, decision, reasonCode: input.reasonCode, maker: current.decisionProposedBy, checker: input.actorId, stepUpProofHash }), actorId: input.actorId, correlationId: input.correlationId });
    await audit(tx, input.actorId, `pos.lgpd.request.${decision}`, "pos_lgpd_subject_request", current.id, input.correlationId, { requestType: current.requestType, reasonCode: input.reasonCode, maker: current.decisionProposedBy, checker: input.actorId, stepUp: Boolean(stepUpProofHash), version: nextVersion });
    return updated;
  });
}

export async function activatePosLgpdRetentionPolicy(db: RootDb, inputValue: {
  policyId: string;
  legalApprovalRef: string;
  homologatedBy: string;
  stepUpProofHash: string;
  now?: Date;
  correlationId?: string;
}) {
  const policyId = safeIdentifier(inputValue.policyId, "Política", 8, 160);
  const legalApprovalRef = safeIdentifier(inputValue.legalApprovalRef, "Referência jurídica", 8, 160);
  const homologatedBy = safeActor(inputValue.homologatedBy, "Homologador");
  const stepUpProofHash = sha256Digest(inputValue.stepUpProofHash, "Prova de step-up");
  const now = validDate(inputValue.now ?? new Date(), "Data de homologação");
  const correlationId = safeCorrelation(inputValue.correlationId ?? randomUUID());
  return serializableRetry(db, async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_lgpd_retention_policies" WHERE "id" = ${policyId} FOR UPDATE`);
    const policy = await tx.posLgpdRetentionPolicy.findUnique({ where: { id: policyId } });
    if (!policy) throw new PosLgpdError("Política de retenção não encontrada.", 404);
    if (policy.status === "active") {
      if (policy.legalApprovalRef !== legalApprovalRef || policy.homologatedBy !== homologatedBy || policy.stepUpProofHash !== stepUpProofHash) throw new PosLgpdError("A política já foi homologada com outra aprovação.", 409);
      return { policy, replayed: true };
    }
    if (policy.status !== "draft") throw new PosLgpdError("A política não pode ser homologada neste estado.", 409);
    if (policy.proposedBy === homologatedBy) throw new PosLgpdError("Homologação de retenção exige checker distinto do proponente.", 403);
    const activated = await tx.posLgpdRetentionPolicy.update({ where: { id: policy.id }, data: { status: "active", legalApprovalRef, homologatedBy, homologatedAt: now, stepUpProofHash, updatedAt: now } });
    await appendEvidence(tx, { aggregateType: "policy", aggregateId: policy.id, evidenceType: "policy.homologated", manifestHash: hashPosLgpdPayload({ version: policy.version, policyHash: policy.policyHash, effectiveFrom: policy.effectiveFrom.toISOString(), effectiveUntil: policy.effectiveUntil?.toISOString() ?? null, legalApprovalRef, proposedBy: policy.proposedBy, homologatedBy, stepUpProofHash }), actorId: homologatedBy, correlationId });
    await audit(tx, homologatedBy, "pos.lgpd.policy.homologated", "pos_lgpd_retention_policy", policy.id, correlationId, { version: policy.version, policyHash: policy.policyHash, legalApprovalRef });
    return { policy: activated, replayed: false };
  });
}

export async function registerPosLgpdInventoryObject(db: RootDb, inputValue: {
  objectType: string;
  objectKeyHash: string;
  subjectTokenHash: string;
  dataCategory: string;
  sourceVersion: number;
  manifest: Record<string, unknown>;
  retentionPolicyId?: string | null;
  actorId: string;
  now?: Date;
  correlationId?: string;
}) {
  const input = normalizeInventory(inputValue);
  return serializableRetry(db, async (tx) => {
    const existing = await tx.posLgpdInventoryObject.findUnique({ where: { objectType_objectKeyHash: { objectType: input.objectType, objectKeyHash: input.objectKeyHash } } });
    if (existing) {
      if (existing.subjectTokenHash !== input.subjectTokenHash || existing.dataCategory !== input.dataCategory || existing.retentionPolicyId !== input.retentionPolicyId) throw new PosLgpdError("O objeto LGPD já existe com outra identidade ou política.", 409);
      if (input.sourceVersion < existing.sourceVersion) throw new PosLgpdError("A versão do inventário não pode regredir.", 409);
      if (input.sourceVersion === existing.sourceVersion && existing.manifestHash !== input.manifestHash) throw new PosLgpdError("A mesma versão do inventário possui manifesto divergente.", 409);
      if (input.sourceVersion === existing.sourceVersion) return { inventoryObject: existing, replayed: true };
      const updated = await tx.posLgpdInventoryObject.update({ where: { id: existing.id }, data: { sourceVersion: input.sourceVersion, manifestHash: input.manifestHash, lastObservedAt: input.now, updatedAt: input.now } });
      await appendEvidence(tx, { aggregateType: "inventory", aggregateId: existing.id, evidenceType: "inventory.observed", manifestHash: input.manifestHash, matchedCount: BigInt(1), plannedCount: BigInt(1), actorId: input.actorId, correlationId: input.correlationId });
      return { inventoryObject: updated, replayed: false };
    }
    const id = randomUUID();
    const created = await tx.posLgpdInventoryObject.create({ data: { id, objectType: input.objectType, objectKeyHash: input.objectKeyHash, subjectTokenHash: input.subjectTokenHash, tokenKeyId: input.tokenKeyId, tokenVersion: input.tokenVersion, dataCategory: input.dataCategory, sourceVersion: input.sourceVersion, manifestHash: input.manifestHash, retentionPolicyId: input.retentionPolicyId, discoveredAt: input.now, lastObservedAt: input.now, createdAt: input.now, updatedAt: input.now } });
    await appendEvidence(tx, { aggregateType: "inventory", aggregateId: id, evidenceType: "inventory.discovered", manifestHash: input.manifestHash, matchedCount: BigInt(1), plannedCount: BigInt(1), actorId: input.actorId, correlationId: input.correlationId });
    await audit(tx, input.actorId, "pos.lgpd.inventory.discovered", "pos_lgpd_inventory_object", id, input.correlationId, { objectType: input.objectType, objectKeyHash: input.objectKeyHash, subjectTokenHash: input.subjectTokenHash, dataCategory: input.dataCategory, sourceVersion: input.sourceVersion, manifestHash: input.manifestHash, retentionPolicyId: input.retentionPolicyId });
    return { inventoryObject: created, replayed: false };
  });
}

export async function createPosLgpdLegalHold(db: RootDb, inputValue: {
  idempotencyKeyHash: string;
  subjectTokenHash: string;
  objectType?: string | null;
  objectKeyHash?: string | null;
  dataCategory?: string | null;
  reasonCode: string;
  legalReferenceHash: string;
  proposedBy: string;
  approvedBy: string;
  stepUpProofHash: string;
  startsAt?: Date;
  expiresAt?: Date | null;
  correlationId?: string;
}) {
  const input = normalizeHold(inputValue);
  const replay = await db.posLgpdLegalHold.findUnique({ where: { idempotencyKeyHash: input.idempotencyKeyHash } });
  if (replay) return replayHold(replay, input);
  return serializableRetry(db, async (tx) => {
    const concurrent = await tx.posLgpdLegalHold.findUnique({ where: { idempotencyKeyHash: input.idempotencyKeyHash } });
    if (concurrent) return replayHold(concurrent, input);
    const id = randomUUID();
    const hold = await tx.posLgpdLegalHold.create({ data: { id, ...input.persisted } });
    await appendEvidence(tx, { aggregateType: "hold", aggregateId: id, evidenceType: "hold.activated", manifestHash: input.manifestHash, matchedCount: BigInt(0), plannedCount: BigInt(0), actorId: input.approvedBy, correlationId: input.correlationId });
    await audit(tx, input.approvedBy, "pos.lgpd.hold.activated", "pos_lgpd_legal_hold", id, input.correlationId, { subjectTokenHash: input.subjectTokenHash, objectType: input.objectType, objectKeyHash: input.objectKeyHash, dataCategory: input.dataCategory, reasonCode: input.reasonCode, legalReferenceHash: input.legalReferenceHash, proposedBy: input.proposedBy, approvedBy: input.approvedBy });
    return { hold, replayed: false };
  });
}

export async function releasePosLgpdLegalHold(db: RootDb, inputValue: {
  holdId: string;
  proposedBy: string;
  releasedBy: string;
  stepUpProofHash: string;
  reasonCode: string;
  now?: Date;
  correlationId?: string;
}) {
  const holdId = safeIdentifier(inputValue.holdId, "Legal hold", 8, 160);
  const proposedBy = safeActor(inputValue.proposedBy, "Proponente da liberação");
  const releasedBy = safeActor(inputValue.releasedBy, "Aprovador da liberação");
  if (proposedBy === releasedBy) throw new PosLgpdError("Liberação de legal hold exige maker e checker distintos.", 403);
  const releaseStepUpHash = sha256Digest(inputValue.stepUpProofHash, "Prova de step-up");
  const releaseReasonCode = safeCode(inputValue.reasonCode, "Motivo da liberação");
  const now = validDate(inputValue.now ?? new Date(), "Data de liberação");
  const correlationId = safeCorrelation(inputValue.correlationId ?? randomUUID());
  return serializableRetry(db, async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_lgpd_legal_holds" WHERE "id" = ${holdId} FOR UPDATE`);
    const current = await tx.posLgpdLegalHold.findUnique({ where: { id: holdId } });
    if (!current) throw new PosLgpdError("Legal hold não encontrado.", 404);
    if (current.state === "released") {
      if (current.releaseProposedBy !== proposedBy || current.releasedBy !== releasedBy || current.releaseStepUpHash !== releaseStepUpHash || current.releaseReasonCode !== releaseReasonCode) throw new PosLgpdError("Legal hold já liberado com outro conteúdo.", 409);
      return { hold: current, replayed: true };
    }
    const released = await tx.posLgpdLegalHold.update({ where: { id: current.id }, data: { state: "released", releaseProposedBy: proposedBy, releasedBy, releaseStepUpHash, releaseReasonCode, releasedAt: now, updatedAt: now } });
    const manifestHash = hashPosLgpdPayload({ holdId, proposedBy, releasedBy, releaseStepUpHash, releaseReasonCode, releasedAt: now.toISOString() });
    await appendEvidence(tx, { aggregateType: "hold", aggregateId: holdId, evidenceType: "hold.released", manifestHash, actorId: releasedBy, correlationId });
    await audit(tx, releasedBy, "pos.lgpd.hold.released", "pos_lgpd_legal_hold", holdId, correlationId, { proposedBy, releasedBy, releaseReasonCode, releasedAt: now.toISOString() });
    return { hold: released, replayed: false };
  });
}

/**
 * Plans work only. The job and outbox are always persisted as `blocked`.
 * This module intentionally exposes no claim/execute/delete/anonymize method:
 * a reviewed adapter must be implemented explicitly in a later integration.
 */
export async function planPosLgpdExecution(db: RootDb, inputValue: {
  requestId: string;
  expectedVersion: number;
  action: PosLgpdJobAction;
  inventoryObjectId?: string | null;
  retentionPolicyId?: string | null;
  idempotencyKeyHash: string;
  actorId: string;
  now?: Date;
  correlationId?: string;
}) {
  const input = normalizeExecutionPlan(inputValue);
  const replay = await db.posLgpdExecutionJob.findUnique({ where: { idempotencyKeyHash: input.idempotencyKeyHash }, include: { outbox: true } });
  if (replay) return replayExecutionJob(replay, input);
  return serializableRetry(db, async (tx) => {
    const concurrent = await tx.posLgpdExecutionJob.findUnique({ where: { idempotencyKeyHash: input.idempotencyKeyHash }, include: { outbox: true } });
    if (concurrent) return replayExecutionJob(concurrent, input);
    const request = await lockRequest(tx, input.requestId);
    if (request.version !== input.expectedVersion) throw new PosLgpdError("A solicitação LGPD mudou; recarregue antes de planejar.", 409);
    if (request.state !== "approved") throw new PosLgpdError("Somente solicitação aprovada pode gerar plano de execução.", 409);
    enforceActionMatchesRequest(input.action, request.requestType);
    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`SELECT CURRENT_TIMESTAMP AS "now"`);
    if (!clock) throw new PosLgpdError("Relógio transacional LGPD indisponível.", 500);
    const gateNow = validDate(clock.now, "Relógio transacional");
    let inventoryObject: Awaited<ReturnType<Tx["posLgpdInventoryObject"]["findUnique"]>> = null;
    let policy: Awaited<ReturnType<Tx["posLgpdRetentionPolicy"]["findUnique"]>> = null;
    let blockReason = "adapter_not_configured";
    let matchedCount = BigInt(0);
    if (input.action === "export") {
      if (input.inventoryObjectId || input.retentionPolicyId) throw new PosLgpdError("Exportação DSAR é planejada pelo token do titular, sem acoplar política destrutiva.", 400);
      matchedCount = BigInt(await tx.posLgpdInventoryObject.count({ where: { subjectTokenHash: request.subjectTokenHash } }));
    } else {
      if (!input.inventoryObjectId || !input.retentionPolicyId) throw new PosLgpdError("Ação destrutiva exige objeto inventariado e política de retenção homologada.", 400);
      inventoryObject = await tx.posLgpdInventoryObject.findUnique({ where: { id: input.inventoryObjectId } });
      if (!inventoryObject || inventoryObject.subjectTokenHash !== request.subjectTokenHash) throw new PosLgpdError("Objeto inventariado não pertence ao token do titular.", 409);
      policy = await tx.posLgpdRetentionPolicy.findUnique({ where: { id: input.retentionPolicyId } });
      if (!policy || policy.status !== "active" || !policy.legalApprovalRef || !policy.homologatedAt || policy.effectiveFrom > gateNow || policy.effectiveUntil && policy.effectiveUntil < gateNow || inventoryObject.retentionPolicyId !== policy.id) throw new PosLgpdError("Política de retenção ativa, vigente e homologada não corresponde ao objeto.", 409);
      const hold = await tx.posLgpdLegalHold.findFirst({ where: {
        subjectTokenHash: request.subjectTokenHash,
        state: "active",
        startsAt: { lte: gateNow },
        OR: [{ expiresAt: null }, { expiresAt: { gt: gateNow } }],
        AND: [
          { OR: [{ objectType: null }, { objectType: inventoryObject.objectType, objectKeyHash: inventoryObject.objectKeyHash }] },
          { OR: [{ dataCategory: null }, { dataCategory: inventoryObject.dataCategory }] },
        ],
      } });
      if (hold) blockReason = "legal_hold";
      matchedCount = BigInt(1);
    }
    const requestHash = hashPosLgpdPayload({ requestId: request.id, requestVersion: request.version, requestType: request.requestType, subjectTokenHash: request.subjectTokenHash, action: input.action, inventoryObjectId: input.inventoryObjectId, retentionPolicyId: input.retentionPolicyId, policyHash: policy?.policyHash ?? null });
    const jobId = randomUUID();
    const nextVersion = request.version + 1;
    await tx.posLgpdSubjectRequest.update({ where: { id: request.id }, data: { state: "queued", version: nextVersion, updatedAt: input.now } });
    await appendRequestLedger(tx, { requestId: request.id, sequence: nextVersion, fromState: request.state, toState: "queued", actorId: input.actorId, reasonCode: "execution.planned", correlationId: input.correlationId, occurredAt: input.now });
    const job = await tx.posLgpdExecutionJob.create({ data: {
      id: jobId,
      requestId: request.id,
      inventoryObjectId: input.inventoryObjectId,
      retentionPolicyId: input.retentionPolicyId,
      action: input.action,
      state: "blocked",
      blockReason,
      idempotencyKeyHash: input.idempotencyKeyHash,
      tokenKeyId: input.tokenKeyId,
      tokenVersion: input.tokenVersion,
      requestHash,
      policyHash: policy?.policyHash ?? null,
      matchedCount,
      createdBy: input.actorId,
      createdAt: input.now,
      updatedAt: input.now,
      outbox: { create: { state: "blocked", payloadHash: requestHash, createdAt: input.now, updatedAt: input.now } },
    }, include: { outbox: true } });
    await appendEvidence(tx, { aggregateType: "job", aggregateId: jobId, evidenceType: "execution.planned_blocked", manifestHash: requestHash, matchedCount, plannedCount: matchedCount, actorId: input.actorId, correlationId: input.correlationId });
    await audit(tx, input.actorId, "pos.lgpd.execution.planned_blocked", "pos_lgpd_execution_job", jobId, input.correlationId, { requestId: request.id, requestVersion: request.version, action: input.action, inventoryObjectId: input.inventoryObjectId, retentionPolicyId: input.retentionPolicyId, policyHash: policy?.policyHash ?? null, requestHash, blockReason, matchedCount: matchedCount.toString() });
    return { job, replayed: false };
  }).catch(async (error) => {
    if (isUniqueOrSerialization(error)) {
      const found = await db.posLgpdExecutionJob.findUnique({ where: { idempotencyKeyHash: input.idempotencyKeyHash }, include: { outbox: true } });
      if (found) return replayExecutionJob(found, input);
    }
    throw error;
  });
}

async function lockRequest(tx: Tx, requestId: string) {
  const id = safeIdentifier(requestId, "Solicitação", 8, 160);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_lgpd_subject_requests" WHERE "id" = ${id} FOR UPDATE`);
  const request = await tx.posLgpdSubjectRequest.findUnique({ where: { id } });
  if (!request) throw new PosLgpdError("Solicitação LGPD não encontrada.", 404);
  return request;
}

async function appendRequestLedger(tx: Tx, input: { requestId: string; sequence: number; fromState: string | null; toState: string; actorId: string; reasonCode: string; correlationId: string; occurredAt: Date }) {
  const prior = input.sequence === 1 ? null : await tx.posLgpdRequestStateLedger.findUnique({ where: { requestId_sequence: { requestId: input.requestId, sequence: input.sequence - 1 } } });
  if (input.sequence > 1 && !prior) throw new PosLgpdError("Cadeia de estados LGPD incompleta.", 409);
  const eventHash = hashPosLgpdPayload({ requestId: input.requestId, sequence: input.sequence, fromState: input.fromState, toState: input.toState, actorId: input.actorId, reasonCode: input.reasonCode, correlationId: input.correlationId, priorHash: prior?.eventHash ?? null, occurredAt: input.occurredAt.toISOString() });
  return tx.posLgpdRequestStateLedger.create({ data: { requestId: input.requestId, sequence: input.sequence, fromState: input.fromState, toState: input.toState, actorId: input.actorId, reasonCode: input.reasonCode, correlationId: input.correlationId, priorHash: prior?.eventHash ?? null, eventHash, occurredAt: input.occurredAt } });
}

async function appendEvidence(tx: Tx, input: { aggregateType: "request" | "job" | "hold" | "policy" | "inventory"; aggregateId: string; evidenceType: string; manifestHash: string; matchedCount?: bigint; plannedCount?: bigint; processedCount?: bigint; failedCount?: bigint; actorId: string; correlationId: string }) {
  const prior = await tx.posLgpdEvidence.findFirst({ where: { aggregateType: input.aggregateType, aggregateId: input.aggregateId }, orderBy: { id: "desc" } });
  const counts = { matchedCount: input.matchedCount ?? BigInt(0), plannedCount: input.plannedCount ?? BigInt(0), processedCount: input.processedCount ?? BigInt(0), failedCount: input.failedCount ?? BigInt(0) };
  const evidenceHash = hashPosLgpdPayload({ ...input, ...Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, value.toString()])), priorEvidenceHash: prior?.evidenceHash ?? null });
  return tx.posLgpdEvidence.create({ data: { aggregateType: input.aggregateType, aggregateId: input.aggregateId, evidenceType: input.evidenceType, manifestHash: sha256Digest(input.manifestHash, "Hash do manifesto"), priorEvidenceHash: prior?.evidenceHash ?? null, evidenceHash, ...counts, actorId: input.actorId, correlationId: input.correlationId } });
}

async function audit(tx: Tx, actorId: string, action: string, entityType: string, entityId: string, correlationId: string, afterData: Record<string, unknown>) {
  await tx.tenantAuditEvent.create({ data: { actorId, action, entityType, entityId, correlationId, afterData: canonicalClone(afterData) as Prisma.InputJsonValue } });
}

function normalizeSubjectRequest(input: Parameters<typeof createPosLgpdSubjectRequest>[1]) {
  if (!POS_LGPD_REQUEST_TYPES.includes(input.requestType)) throw new PosLgpdError("Tipo de solicitação LGPD inválido.", 400);
  rejectSensitiveData(input.scope);
  const now = validDate(input.now ?? new Date(), "Data de recebimento");
  const dueAt = validDate(input.dueAt, "Prazo");
  if (dueAt < now) throw new PosLgpdError("O prazo da solicitação não pode estar vencido no recebimento.", 400);
  const idempotency = derivePosLgpdTokenHash(input.idempotencyKeyHash, "request-idempotency", "Chave idempotente");
  const subject = derivePosLgpdTokenHash(input.subjectTokenHash, "subject", "Token do titular");
  const contact = input.contactTokenHash == null ? null : derivePosLgpdTokenHash(input.contactTokenHash, "contact", "Token de contato");
  if (subject.keyId !== idempotency.keyId || subject.version !== idempotency.version || contact && (contact.keyId !== subject.keyId || contact.version !== subject.version)) throw new PosLgpdError("Contexto de token LGPD inconsistente.", 500);
  return { idempotencyKeyHash: idempotency.digest, subjectTokenHash: subject.digest, contactTokenHash: contact?.digest ?? null, tokenKeyId: subject.keyId, tokenVersion: subject.version, requestType: input.requestType, scopeHash: hashPosLgpdPayload(canonicalClone(input.scope)), dueAt, createdBy: safeActor(input.createdBy, "Ator"), now, correlationId: safeCorrelation(input.correlationId ?? randomUUID()) };
}

function normalizeTransition(input: Parameters<typeof advancePosLgpdSubjectRequest>[1]) {
  return { requestId: safeIdentifier(input.requestId, "Solicitação", 8, 160), expectedVersion: integer(input.expectedVersion, "Versão", 1), toState: input.toState, actorId: safeActor(input.actorId, "Ator"), reasonCode: safeCode(input.reasonCode, "Motivo"), now: validDate(input.now ?? new Date(), "Data"), correlationId: safeCorrelation(input.correlationId ?? randomUUID()) };
}

function normalizeDecision(input: { requestId: string; expectedVersion: number; proposedBy: string; reasonCode: string; now?: Date; correlationId?: string }) {
  return { requestId: safeIdentifier(input.requestId, "Solicitação", 8, 160), expectedVersion: integer(input.expectedVersion, "Versão", 1), actorId: safeActor(input.proposedBy, "Ator"), reasonCode: safeCode(input.reasonCode, "Motivo"), now: validDate(input.now ?? new Date(), "Data"), correlationId: safeCorrelation(input.correlationId ?? randomUUID()) };
}

function normalizeInventory(input: Parameters<typeof registerPosLgpdInventoryObject>[1]) {
  rejectSensitiveData(input.manifest);
  const objectKey = derivePosLgpdTokenHash(input.objectKeyHash, "object-key", "Chave do objeto");
  const subject = derivePosLgpdTokenHash(input.subjectTokenHash, "subject", "Token do titular");
  if (objectKey.keyId !== subject.keyId || objectKey.version !== subject.version) throw new PosLgpdError("Contexto de token LGPD inconsistente.", 500);
  return { objectType: safeCode(input.objectType, "Tipo do objeto"), objectKeyHash: objectKey.digest, subjectTokenHash: subject.digest, tokenKeyId: subject.keyId, tokenVersion: subject.version, dataCategory: safeCode(input.dataCategory, "Categoria"), sourceVersion: integer(input.sourceVersion, "Versão da origem", 0), manifestHash: hashPosLgpdPayload(canonicalClone(input.manifest)), retentionPolicyId: input.retentionPolicyId == null ? null : safeIdentifier(input.retentionPolicyId, "Política", 8, 160), actorId: safeActor(input.actorId, "Ator"), now: validDate(input.now ?? new Date(), "Data da observação"), correlationId: safeCorrelation(input.correlationId ?? randomUUID()) };
}

function normalizeHold(input: Parameters<typeof createPosLgpdLegalHold>[1]) {
  const proposedBy = safeActor(input.proposedBy, "Proponente");
  const approvedBy = safeActor(input.approvedBy, "Aprovador");
  if (proposedBy === approvedBy) throw new PosLgpdError("Legal hold exige maker e checker distintos.", 403);
  const objectType = input.objectType == null ? null : safeCode(input.objectType, "Tipo do objeto");
  const objectKey = input.objectKeyHash == null ? null : derivePosLgpdTokenHash(input.objectKeyHash, "object-key", "Chave do objeto");
  const objectKeyHash = objectKey?.digest ?? null;
  if ((objectType == null) !== (objectKey == null)) throw new PosLgpdError("Escopo por objeto exige tipo e chave juntos.", 400);
  const startsAt = validDate(input.startsAt ?? new Date(), "Início do hold");
  const expiresAt = input.expiresAt == null ? null : validDate(input.expiresAt, "Fim do hold");
  if (expiresAt && expiresAt <= startsAt) throw new PosLgpdError("Fim do hold deve ser posterior ao início.", 400);
  const idempotency = derivePosLgpdTokenHash(input.idempotencyKeyHash, "hold-idempotency", "Chave idempotente");
  const subject = derivePosLgpdTokenHash(input.subjectTokenHash, "subject", "Token do titular");
  if (subject.keyId !== idempotency.keyId || subject.version !== idempotency.version || objectKey && (objectKey.keyId !== subject.keyId || objectKey.version !== subject.version)) throw new PosLgpdError("Contexto de token LGPD inconsistente.", 500);
  const base = { idempotencyKeyHash: idempotency.digest, subjectTokenHash: subject.digest, tokenKeyId: subject.keyId, tokenVersion: subject.version, objectType, objectKeyHash, dataCategory: input.dataCategory == null ? null : safeCode(input.dataCategory, "Categoria"), reasonCode: safeCode(input.reasonCode, "Motivo"), legalReferenceHash: sha256Digest(input.legalReferenceHash, "Referência legal"), proposedBy, approvedBy, stepUpProofHash: sha256Digest(input.stepUpProofHash, "Prova de step-up"), startsAt, expiresAt, correlationId: safeCorrelation(input.correlationId ?? randomUUID()) };
  return { ...base, manifestHash: hashPosLgpdPayload(base), persisted: { idempotencyKeyHash: base.idempotencyKeyHash, subjectTokenHash: base.subjectTokenHash, tokenKeyId: base.tokenKeyId, tokenVersion: base.tokenVersion, objectType, objectKeyHash, dataCategory: base.dataCategory, reasonCode: base.reasonCode, legalReferenceHash: base.legalReferenceHash, proposedBy, approvedBy, stepUpProofHash: base.stepUpProofHash, startsAt, expiresAt } };
}

function normalizeExecutionPlan(input: Parameters<typeof planPosLgpdExecution>[1]) {
  if (!POS_LGPD_JOB_ACTIONS.includes(input.action)) throw new PosLgpdError("Ação LGPD inválida.", 400);
  const idempotency = derivePosLgpdTokenHash(input.idempotencyKeyHash, "job-idempotency", "Chave idempotente");
  return { requestId: safeIdentifier(input.requestId, "Solicitação", 8, 160), expectedVersion: integer(input.expectedVersion, "Versão", 1), action: input.action, inventoryObjectId: input.inventoryObjectId == null ? null : safeIdentifier(input.inventoryObjectId, "Objeto", 8, 160), retentionPolicyId: input.retentionPolicyId == null ? null : safeIdentifier(input.retentionPolicyId, "Política", 8, 160), idempotencyKeyHash: idempotency.digest, tokenKeyId: idempotency.keyId, tokenVersion: idempotency.version, actorId: safeActor(input.actorId, "Ator"), now: validDate(input.now ?? new Date(), "Data do plano"), correlationId: safeCorrelation(input.correlationId ?? randomUUID()) };
}

function enforceActionMatchesRequest(action: PosLgpdJobAction, requestType: string) {
  if (action === "export" && !["access", "export", "portability"].includes(requestType) || action === "anonymize" && !["anonymization", "deletion"].includes(requestType) || action === "delete" && requestType !== "deletion") throw new PosLgpdError("Ação planejada não corresponde ao tipo da solicitação.", 409);
}

function replaySubjectRequest<T extends { subjectTokenHash: string; contactTokenHash: string | null; tokenKeyId: string; tokenVersion: number; requestType: string; scopeHash: string; dueAt: Date; createdBy: string }>(request: T, input: ReturnType<typeof normalizeSubjectRequest>) {
  if (request.subjectTokenHash !== input.subjectTokenHash || request.contactTokenHash !== input.contactTokenHash || request.tokenKeyId !== input.tokenKeyId || request.tokenVersion !== input.tokenVersion || request.requestType !== input.requestType || request.scopeHash !== input.scopeHash || request.dueAt.getTime() !== input.dueAt.getTime() || request.createdBy !== input.createdBy) throw new PosLgpdError("Chave idempotente LGPD reutilizada com outro conteúdo.", 409);
  return { request, replayed: true };
}

function replayHold<T extends { subjectTokenHash: string; tokenKeyId: string; tokenVersion: number; objectType: string | null; objectKeyHash: string | null; dataCategory: string | null; reasonCode: string; legalReferenceHash: string; proposedBy: string; approvedBy: string; stepUpProofHash: string; startsAt: Date; expiresAt: Date | null }>(hold: T, input: ReturnType<typeof normalizeHold>) {
  if (hold.subjectTokenHash !== input.subjectTokenHash || hold.tokenKeyId !== input.tokenKeyId || hold.tokenVersion !== input.tokenVersion || hold.objectType !== input.objectType || hold.objectKeyHash !== input.objectKeyHash || hold.dataCategory !== input.dataCategory || hold.reasonCode !== input.reasonCode || hold.legalReferenceHash !== input.legalReferenceHash || hold.proposedBy !== input.proposedBy || hold.approvedBy !== input.approvedBy || hold.stepUpProofHash !== input.stepUpProofHash || hold.startsAt.getTime() !== input.startsAt.getTime() || hold.expiresAt?.getTime() !== input.expiresAt?.getTime()) throw new PosLgpdError("Chave idempotente do legal hold reutilizada com outro conteúdo.", 409);
  return { hold, replayed: true };
}

function replayExecutionJob<T extends { requestId: string; action: string; inventoryObjectId: string | null; retentionPolicyId: string | null; tokenKeyId: string; tokenVersion: number; createdBy: string }>(job: T, input: ReturnType<typeof normalizeExecutionPlan>) {
  if (job.requestId !== input.requestId || job.action !== input.action || job.inventoryObjectId !== input.inventoryObjectId || job.retentionPolicyId !== input.retentionPolicyId || job.tokenKeyId !== input.tokenKeyId || job.tokenVersion !== input.tokenVersion || job.createdBy !== input.actorId) throw new PosLgpdError("Chave idempotente do job LGPD reutilizada com outro conteúdo.", 409);
  return { job, replayed: true };
}

function safeIdentifier(value: string, label: string, min: number, max: number) {
  const result = String(value ?? "").trim();
  if (result.length < min || result.length > max || /[\x00-\x1f\x7f]/.test(result)) throw new PosLgpdError(`${label} inválido.`, 400);
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result)) return result;
  rejectPiiText(result);
  return result;
}

function safeActor(value: string, label: string) {
  return safeIdentifier(value, label, 1, 160);
}

function safeCode(value: string, label: string) {
  const result = String(value ?? "").trim().toLowerCase();
  if (!/^[a-z][a-z0-9._-]{2,79}$/.test(result)) throw new PosLgpdError(`${label} deve ser um código opaco.`, 400);
  return result;
}

function safeCorrelation(value: string) {
  return safeIdentifier(value, "Correlation ID", 8, 160);
}

function integer(value: number, label: string, minimum: number) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new PosLgpdError(`${label} inválida.`, 400);
  return value;
}

function validDate(value: Date, label: string) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(Number.NaN);
  if (Number.isNaN(date.getTime())) throw new PosLgpdError(`${label} inválida.`, 400);
  return date;
}

function rejectSensitiveData(value: unknown, path = "payload") {
  if (typeof value === "string") {
    rejectPiiText(value, path);
    return;
  }
  if (Array.isArray(value)) return value.forEach((item, index) => rejectSensitiveData(item, `${path}[${index}]`));
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (/(^|_)(name|nome|email|mail|phone|telefone|cpf|cnpj|document|documento|address|endereco|pan|card|cartao|token|secret|password|senha|cvv|cvc)(_|$)/i.test(key)) throw new PosLgpdError(`PII/PCI não permitida em ${path}.${key}.`, 400);
      rejectSensitiveData(item, `${path}.${key}`);
    }
  }
}

function rejectPiiText(value: string, path = "texto") {
  if (containsPosPaymentPanInIdentifier(value)
    || /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(value)
    || /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/.test(value)
    || /\b\d{2}\.?\d{3}\.?\d{3}[\/]?\d{4}-?\d{2}\b/.test(value)
    || /(?:\+?55[\s.-]*)?\(?\d{2}\)?[\s.-]+9?\d{4}[-\s.]\d{4}/.test(value)
    || /^(?:55)?\d{10,11}$/.test(value.trim())) throw new PosLgpdError(`PII/PCI em claro não permitida em ${path}.`, 400);
}

function canonicalJson(value: unknown) {
  return JSON.stringify(canonicalClone(value));
}

function canonicalClone(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new PosLgpdError("JSON LGPD contém data inválida.", 400);
    return value.toISOString();
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new PosLgpdError("JSON LGPD contém número não finito.", 400);
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => {
    if (item === undefined) throw new PosLgpdError("JSON LGPD contém undefined.", 400);
    return canonicalClone(item);
  });
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined || typeof item === "function" || typeof item === "symbol" || typeof item === "bigint") throw new PosLgpdError("JSON LGPD contém valor não serializável.", 400);
      output[key] = canonicalClone(item);
    }
    return output;
  }
  throw new PosLgpdError("JSON LGPD contém tipo não suportado.", 400);
}

async function serializableRetry<T>(db: RootDb, work: (tx: Tx) => Promise<T>) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await db.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (attempt < 2 && isSerialization(error)) continue;
      throw error;
    }
  }
  throw new PosLgpdError("Falha de serialização LGPD.", 409);
}

function isSerialization(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2034" || (error.meta as { code?: string } | undefined)?.code === "40001");
}

function isUniqueOrSerialization(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2002" || error.code === "P2034");
}
