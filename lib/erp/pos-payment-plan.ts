import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@/generated/tenant/client";
import { assertPosOperationalTerminalProof, posOperationalTerminalSelect, type PosOperationalTerminalProof } from "@/lib/erp/pos-terminal-boundary";
import { preparePosPaymentPlanGraphWrite, previewPosPaymentPlanGraphWriteHash, type PosPaymentPlanGraphWrite } from "@/lib/erp/pos-payment-plan-capability";

export const POS_PAYMENT_PLAN_TTL_MS = 120_000;
export const POS_PAYMENT_PLAN_METHODS = ["cash", "pix", "credit", "debit", "voucher", "store_credit"] as const;
export const POS_PAYMENT_PLAN_PROOF_KINDS = ["cash", "value", "intent", "manual"] as const;

type RootDb = PrismaClient;
type PlanMethod = typeof POS_PAYMENT_PLAN_METHODS[number];
type ProofKind = typeof POS_PAYMENT_PLAN_PROOF_KINDS[number];

export type PosPaymentPlanContext = {
  branchId: number;
  registerId: number;
  sessionId: number;
  operatorProfileId: number;
  terminalId: string;
  actorUserId: string;
};

export type PosPaymentPlanSlotInput = {
  paymentIndex: number;
  method: PlanMethod;
  amountCents: number;
  installments: number;
  proofKind: ProofKind;
  connectorId: string | null;
  provider: string | null;
};

export type PosPaymentPlanQuoteLineInput = {
  productId: number;
  variationId: number | null;
  quantity: number;
  unitPriceCents: number;
  grossCents: number;
  baseDiscountCents: number;
  orderDiscountCents: number;
  promotionDiscountCents: number;
  surchargeCents: number;
  totalCents: number;
};

export type PosPaymentPlanActivationInput = {
  action: "plan.activate";
  sessionId: number;
  planId: string;
  expectedVersion: number;
  slots: PosPaymentPlanSlotInput[];
  idempotencyKey: string;
};

export type PosPaymentPlanExecutionInput = {
  paymentIntentId?: string;
  manualReferenceId?: string;
  tenderedCents?: number;
  valueAccountId?: string;
  valueUnits?: number;
  giftCode?: string;
  giftPin?: string;
  giftQrToken?: string;
};

export type AuthoritativePosPaymentInput = PosPaymentPlanExecutionInput & {
  method: PlanMethod;
  amountCents: number;
  installments: number;
};

export class PosPaymentPlanError extends Error {
  constructor(message: string, public readonly status = 409) {
    super(message);
    this.name = "PosPaymentPlanError";
  }
}

export function parsePosPaymentPlanActivation(body: Record<string, unknown>): PosPaymentPlanActivationInput {
  onlyKeys(body, ["action", "sessionId", "planId", "expectedVersion", "slots", "idempotencyKey"]);
  if (body.action !== "plan.activate") throw new PosPaymentPlanError("Ação de plano de pagamento inválida.", 400);
  const rawSlots = Array.isArray(body.slots) ? body.slots : [];
  if (!rawSlots.length || rawSlots.length > 10) throw new PosPaymentPlanError("O plano exige entre 1 e 10 divisões.", 422);
  return {
    action: "plan.activate",
    sessionId: integer(body.sessionId, "Turno", 1, 2_147_483_647),
    planId: identifier(body.planId, "Plano", 8, 160),
    expectedVersion: integer(body.expectedVersion, "Versão esperada", 0, 2_147_483_646),
    slots: normalizePosPaymentPlanSlots(rawSlots),
    idempotencyKey: identifier(body.idempotencyKey, "Chave idempotente", 16, 160),
  };
}

export function normalizePosPaymentPlanSlots(rawSlots: unknown[]): PosPaymentPlanSlotInput[] {
  const slots = rawSlots.map((raw, position) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PosPaymentPlanError(`Divisão ${position + 1} inválida.`, 422);
    const value = raw as Record<string, unknown>;
    onlyKeys(value, ["paymentIndex", "method", "amountCents", "installments", "proofKind", "connectorId", "provider"]);
    const method = choice(value.method, POS_PAYMENT_PLAN_METHODS, "Método");
    const proofKind = choice(value.proofKind, POS_PAYMENT_PLAN_PROOF_KINDS, "Tipo de prova");
    const installments = integer(value.installments ?? 1, "Parcelas", 1, 24);
    const connectorId = nullableIdentifier(value.connectorId, "Conector", 160);
    const provider = nullableIdentifier(value.provider, "Provedor", 160)?.toLocaleLowerCase("en-US") ?? null;
    if (method !== "credit" && installments !== 1) throw new PosPaymentPlanError("Parcelamento só é permitido no crédito.", 422);
    if (proofKind === "cash" && (method !== "cash" || connectorId || provider)) throw new PosPaymentPlanError("Divisão em dinheiro não aceita conector ou provedor.", 422);
    if (proofKind === "value" && (method !== "store_credit" || connectorId || provider)) throw new PosPaymentPlanError("Divisão de saldo local deve usar crédito da loja sem conector externo.", 422);
    if (proofKind === "intent" && (!externalMethod(method) || !connectorId || !provider)) throw new PosPaymentPlanError("Intent eletrônico exige método externo, conector e provedor.", 422);
    if (proofKind === "manual") throw new PosPaymentPlanError("Novas referências manuais permanecem desabilitadas até a reconciliação 320000.", 409);
    return {
      paymentIndex: integer(value.paymentIndex, "Índice do pagamento", 0, 9),
      method,
      amountCents: integer(value.amountCents, "Valor", 1, 2_147_483_647),
      installments,
      proofKind,
      connectorId,
      provider,
    };
  }).sort((left, right) => left.paymentIndex - right.paymentIndex);
  if (slots.some((slot, index) => slot.paymentIndex !== index)) throw new PosPaymentPlanError("As divisões devem usar índices contíguos iniciando em zero.", 422);
  return slots;
}

export async function persistQuotedPosPaymentPlan(
  tx: Prisma.TransactionClient,
  input: PosPaymentPlanContext & {
    saleDraftId: string;
    orderClaimId: string | null;
    quoteHash: string;
    totalCents: number;
    evaluatedAt: Date;
    promotionId: string | null;
    couponId: string | null;
    promotionDiscountCents: number;
    quoteLines: PosPaymentPlanQuoteLineInput[];
  },
) {
  // These are locator reads only. The graph capability acquires every advisory
  // namespace and canonical business lock before protected DML starts.
  const draft = await paymentDraft(tx, input.saleDraftId);
  assertDraftContext(draft, input);
  validDate(input.evaluatedAt, "Data da cotação");
  const normalizedQuoteLines = normalizeQuoteLines(input.quoteLines, draft.items);
  const quoteTargetWithoutId = {
    branchId: input.branchId,
    registerId: input.registerId,
    sessionId: input.sessionId,
    operatorProfileId: input.operatorProfileId,
    terminalId: input.terminalId,
    saleDraftId: input.saleDraftId,
    draftRevision: draft.revision,
    draftStatus: draft.status,
    orderClaimId: input.orderClaimId,
    quoteHash: hash(input.quoteHash, "Hash da cotação"),
    promotionId: input.promotionId,
    couponId: input.couponId,
    promotionDiscountCents: integer(input.promotionDiscountCents, "Desconto promocional", 0, 2_147_483_647),
    currency: "BRL",
    totalCents: integer(input.totalCents, "Total", 1, 2_147_483_647),
    state: "quoted",
    version: 0,
  };
  const quoteIdentityHash = hashPosPaymentPlanPayload({ action: "quote", ...quoteTargetWithoutId, quoteLines: normalizedQuoteLines });
  const idempotencyKey = `payment-plan-quote:${quoteIdentityHash}`;
  const id = stablePaymentPlanUuid(quoteIdentityHash);
  const openPlans = await tx.posPaymentPlan.findMany({
    where: { saleDraftId: input.saleDraftId, state: { in: ["quoted", "active"] } },
    include: { slots: { orderBy: { paymentIndex: "asc" } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const replay = openPlans.find(plan => plan.id === id && plan.idempotencyKey === idempotencyKey && plan.expiresAt > new Date()) ?? null;
  const targetPlan = jsonObject({ id, ...quoteTargetWithoutId });
  const quoteLines = normalizedQuoteLines.map((line, lineIndex) => jsonObject({ planId: id, lineIndex, ...line }));
  const graphWrite: PosPaymentPlanGraphWrite = {
    action: "quote", planId: id, expectedVersion: 0, actorUserId: input.actorUserId,
    idempotencyKey, targetPlan, quoteLines, slots: [],
  };
  if (replay) {
    const [draftRequestHash, replayRequestHash] = await Promise.all([
      databasePaymentDraftSnapshotHash(tx, input.saleDraftId),
      previewPosPaymentPlanGraphWriteHash(tx, graphWrite),
    ]);
    if (replay.branchId !== input.branchId || replay.registerId !== input.registerId || replay.sessionId !== input.sessionId
      || replay.operatorProfileId !== input.operatorProfileId || replay.terminalId !== input.terminalId || replay.saleDraftId !== input.saleDraftId
      || replay.draftRevision !== draft.revision || replay.draftStatus !== draft.status || replay.draftRequestHash !== draftRequestHash
      || replay.orderClaimId !== input.orderClaimId || replay.quoteHash !== quoteTargetWithoutId.quoteHash
      || replay.promotionId !== input.promotionId || replay.couponId !== input.couponId
      || replay.promotionDiscountCents !== quoteTargetWithoutId.promotionDiscountCents || replay.totalCents !== quoteTargetWithoutId.totalCents
      || replay.currency !== "BRL" || replay.requestHash !== replayRequestHash) {
      throw new PosPaymentPlanError("A cotação idempotente diverge do contexto ou do rascunho autoritativo.");
    }
    return { plan: replay, replayed: true };
  }
  if (openPlans.length) throw new PosPaymentPlanError("Já existe um plano aberto para este rascunho; substitua-o pela transição autoritativa antes de recotar.");
  const requestHash = await preparePosPaymentPlanGraphWrite(tx, graphWrite);
  const [derived] = await tx.$queryRaw<Array<{ evaluatedAt: Date; expiresAt: Date; draftRequestHash: string }>>(Prisma.sql`
    SELECT pg_catalog.transaction_timestamp()::timestamp(3) AS "evaluatedAt",
      LEAST(
        pg_catalog.transaction_timestamp()::timestamp(3) + interval '120 seconds',
        COALESCE(
          (SELECT "lease_expires_at"::timestamp(3) FROM "pos_order_claims" WHERE "id" = ${input.orderClaimId}),
          pg_catalog.transaction_timestamp()::timestamp(3) + interval '120 seconds'
        )
      ) AS "expiresAt",
      public."pos_manual_t2_payment_plan_draft_snapshot_hash_v1"(${input.saleDraftId}) AS "draftRequestHash"
  `);
  if (!derived) throw new PosPaymentPlanError("A capability não retornou os valores derivados da cotação.");
  if (derived.expiresAt.valueOf() <= derived.evaluatedAt.valueOf()
    || derived.expiresAt.valueOf() > derived.evaluatedAt.valueOf() + POS_PAYMENT_PLAN_TTL_MS) {
    throw new PosPaymentPlanError("O lease do claim não comporta a janela autoritativa da cotação.");
  }
  const plan = await tx.posPaymentPlan.create({ data: {
    id, ...quoteTargetWithoutId, draftRequestHash: derived.draftRequestHash,
    evaluatedAt: derived.evaluatedAt, expiresAt: derived.expiresAt, idempotencyKey, requestHash,
  } });
  await tx.posPaymentPlanQuoteLine.createMany({ data: normalizedQuoteLines.map((line, lineIndex) => ({ planId: id, lineIndex, ...line })) });
  await tx.posPaymentPlanOperation.create({ data: { planId: id, action: "quote", expectedVersion: -1, resultingVersion: 0, resultingState: "quoted", idempotencyKey, requestHash, actorUserId: input.actorUserId } });
  await tx.tenantAuditEvent.create({ data: { actorId: input.actorUserId, action: "pos.payment.plan.quoted", entityType: "pos_payment_plan", entityId: id, correlationId: randomUUID(), afterData: { saleDraftId: input.saleDraftId, draftRevision: draft.revision, quoteHash: quoteTargetWithoutId.quoteHash, totalCents: quoteTargetWithoutId.totalCents, expiresAt: derived.expiresAt.toISOString(), requestHash } } });
  return { plan: { ...plan, slots: [] }, replayed: false };
}

function normalizeQuoteLines(lines: PosPaymentPlanQuoteLineInput[], draftItems: Array<{ id: number; productId: number; variationId: number | null; quantity: number; unitPriceCents: number; discountCents: number }>) {
  if (!Array.isArray(lines) || lines.length !== draftItems.length || lines.length < 1 || lines.length > 200) throw new PosPaymentPlanError("As linhas da cotação devem corresponder exatamente ao rascunho persistido.");
  const unmatched = [...draftItems].sort((left, right) => left.id - right.id);
  return lines.map(line => {
    const matchIndex = unmatched.findIndex(item => item.productId === line.productId && item.variationId === line.variationId
      && item.quantity === line.quantity && item.unitPriceCents === line.unitPriceCents && item.discountCents === line.baseDiscountCents);
    if (matchIndex < 0) throw new PosPaymentPlanError("Uma linha da cotação diverge do multiset congelado no rascunho.");
    const [draft] = unmatched.splice(matchIndex, 1);
    const normalized = {
      heldSaleItemId: draft.id,
      productId: integer(line.productId, "Produto cotado", 1, 2_147_483_647),
      variationId: line.variationId == null ? null : integer(line.variationId, "Variação cotada", 1, 2_147_483_647),
      quantity: line.quantity,
      unitPriceCents: integer(line.unitPriceCents, "Preço cotado", 0, 2_147_483_647),
      grossCents: integer(line.grossCents, "Bruto cotado", 0, 2_147_483_647),
      baseDiscountCents: integer(line.baseDiscountCents, "Desconto base cotado", 0, 2_147_483_647),
      orderDiscountCents: integer(line.orderDiscountCents, "Rateio de desconto cotado", 0, 2_147_483_647),
      promotionDiscountCents: integer(line.promotionDiscountCents, "Rateio promocional cotado", 0, 2_147_483_647),
      surchargeCents: integer(line.surchargeCents, "Rateio de acréscimo cotado", 0, 2_147_483_647),
      totalCents: integer(line.totalCents, "Total da linha cotada", 0, 2_147_483_647),
    };
    if (!Number.isFinite(normalized.quantity) || normalized.quantity <= 0 || Math.round(normalized.quantity * normalized.unitPriceCents) !== normalized.grossCents
      || normalized.grossCents - normalized.baseDiscountCents - normalized.orderDiscountCents - normalized.promotionDiscountCents + normalized.surchargeCents !== normalized.totalCents) {
      throw new PosPaymentPlanError("A aritmética da linha cotada é inválida.");
    }
    return normalized;
  });
}

export async function activatePosPaymentPlan(db: RootDb, context: PosPaymentPlanContext, input: PosPaymentPlanActivationInput, terminalProof: PosOperationalTerminalProof) {
  const targetPlan = jsonObject({ id: input.planId, state: "active", version: input.expectedVersion + 1, consumedSaleId: null });
  const slots = input.slots.map(slot => jsonObject({ planId: input.planId, ...slot }));
  const graphWrite: PosPaymentPlanGraphWrite = {
    action: "activate", planId: input.planId, expectedVersion: input.expectedVersion,
    actorUserId: context.actorUserId, idempotencyKey: input.idempotencyKey,
    targetPlan, quoteLines: [], slots,
  };
  const requestHash = await previewPosPaymentPlanGraphWriteHash(db, graphWrite);
  const replay = await db.posPaymentPlanOperation.findUnique({ where: { idempotencyKey: input.idempotencyKey }, include: { plan: { include: { slots: { orderBy: { paymentIndex: "asc" } } } } } });
  if (replay) return activationReplay(replay, context, input.planId, requestHash);
  try {
    return await db.$transaction(async tx => {
      const preparedRequestHash = await preparePosPaymentPlanGraphWrite(tx, graphWrite);
      const session = await tx.cashRegisterSession.findFirst({ where: { id: input.sessionId, registerId: context.registerId, operatorProfileId: context.operatorProfileId, status: "open" } });
      if (!session) throw new PosPaymentPlanError("Turno aberto não encontrado no contexto do plano.", 404);
      const terminal = await tx.posTerminal.findUnique({ where: { id: terminalProof.terminalId }, select: posOperationalTerminalSelect });
      assertPosOperationalTerminalProof(terminal, terminalProof, { expectedBranchId: context.branchId, expectedRegisterId: context.registerId });
      const plan = await tx.posPaymentPlan.findUnique({ where: { id: input.planId } });
      if (!plan) throw new PosPaymentPlanError("Plano de pagamento não encontrado.", 404);
      assertPlanContext(plan, context);
      if (plan.version !== input.expectedVersion || plan.state !== "quoted") throw new PosPaymentPlanError("O plano mudou ou não está mais cotado. Recalcule antes de cobrar.");
      if (plan.expiresAt <= new Date()) throw new PosPaymentPlanError("A cotação do plano expirou antes da autorização.");
      const draft = await paymentDraft(tx, plan.saleDraftId);
      assertDraftContext(draft, plan);
      const draftRequestHash = await databasePaymentDraftSnapshotHash(tx, plan.saleDraftId);
      if (draft.revision !== plan.draftRevision || draft.status !== plan.draftStatus || draftRequestHash !== plan.draftRequestHash) throw new PosPaymentPlanError("O rascunho divergiu da revisão e do hash autorizados pelo plano.");
      const slotCredentials = await assertSlotConnectors(tx, context, input.slots);
      const slotTotal = input.slots.reduce((sum, slot) => sum + slot.amountCents, 0);
      if (!Number.isSafeInteger(slotTotal) || slotTotal !== plan.totalCents) throw new PosPaymentPlanError(`As divisões devem totalizar exatamente ${plan.totalCents} centavos.`, 422);
      if (plan.orderClaimId) await assertOrderClaimPlan(tx, plan, input.slots, context);
      await tx.posPaymentPlanSlot.createMany({ data: input.slots.map(slot => ({ planId: plan.id, ...slot, credentialRef: slotCredentials.get(slot.paymentIndex) ?? null })) });
      await tx.posPaymentPlanOperation.create({ data: { planId: plan.id, action: "activate", expectedVersion: plan.version, resultingVersion: plan.version + 1, resultingState: "active", idempotencyKey: input.idempotencyKey, requestHash: preparedRequestHash, actorUserId: context.actorUserId } });
      const changed = await tx.posPaymentPlan.updateMany({ where: { id: plan.id, state: "quoted", version: plan.version }, data: { state: "active", version: { increment: 1 } } });
      if (changed.count !== 1) throw new PosPaymentPlanError("O plano foi ativado por outra operação.");
      await tx.tenantAuditEvent.create({ data: { actorId: context.actorUserId, action: "pos.payment.plan.activated", entityType: "pos_payment_plan", entityId: plan.id, correlationId: randomUUID(), beforeData: { state: "quoted", version: plan.version }, afterData: { state: "active", version: plan.version + 1, slots: input.slots.map(slot => ({ paymentIndex: slot.paymentIndex, method: slot.method, amountCents: slot.amountCents, installments: slot.installments, proofKind: slot.proofKind, connectorId: slot.connectorId, provider: slot.provider })), totalCents: slotTotal, requestHash: preparedRequestHash } } });
      const active = await tx.posPaymentPlan.findUniqueOrThrow({ where: { id: plan.id }, include: { slots: { orderBy: { paymentIndex: "asc" } } } });
      return { plan: active, replayed: false };
    }, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 });
  } catch (error) {
    const winner = await db.posPaymentPlanOperation.findUnique({ where: { idempotencyKey: input.idempotencyKey }, include: { plan: { include: { slots: { orderBy: { paymentIndex: "asc" } } } } } });
    if (winner) return activationReplay(winner, context, input.planId, requestHash);
    throw error;
  }
}

export async function lockedAuthoritativePosPaymentPlanSlot(
  tx: Prisma.TransactionClient,
  expected: PosPaymentPlanContext & { planId: string; paymentIndex: number; proofKind: "intent" | "manual" },
) {
  const locator = await tx.posPaymentPlan.findUnique({ where: { id: expected.planId }, select: { saleDraftId: true, sessionId: true, terminalId: true } });
  if (!locator) throw new PosPaymentPlanError("Plano de pagamento não encontrado.", 404);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "cash_register_sessions" WHERE "id" = ${locator.sessionId} FOR UPDATE`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_terminals" WHERE "id" = ${locator.terminalId} FOR UPDATE`);
  await assertLivePlanAccess(tx, expected);
  await lockPlanContext(tx, locator.saleDraftId);
  await lockPaymentDraftItems(tx, locator.saleDraftId);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_payment_plans" WHERE "id" = ${expected.planId} FOR UPDATE`);
  const plan = await tx.posPaymentPlan.findUnique({ where: { id: expected.planId }, include: { slots: { where: { paymentIndex: expected.paymentIndex } } } });
  if (!plan) throw new PosPaymentPlanError("Plano de pagamento não encontrado.", 404);
  assertPlanContext(plan, expected);
  if (plan.state !== "active" || plan.expiresAt <= new Date()) throw new PosPaymentPlanError("O plano está inativo ou expirou; nenhuma nova prova financeira pode ser criada.");
  const draft = await paymentDraft(tx, plan.saleDraftId);
  assertDraftMatchesPlan(draft, plan);
  const slot = plan.slots[0];
  if (!slot || slot.proofKind !== expected.proofKind) throw new PosPaymentPlanError("A divisão não autoriza este tipo de prova financeira.");
  return { plan, slot, draft };
}

export async function exactPosPaymentPlanForCommit(
  tx: Prisma.TransactionClient,
  context: PosPaymentPlanContext,
  planId: string,
  expectedVersion: number,
  executions: PosPaymentPlanExecutionInput[],
) {
  const locator = await tx.posPaymentPlan.findUnique({ where: { id: planId }, select: { saleDraftId: true, sessionId: true, terminalId: true } });
  if (!locator) throw new PosPaymentPlanError("Plano de pagamento não encontrado.", 404);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "cash_register_sessions" WHERE "id" = ${locator.sessionId} FOR UPDATE`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_terminals" WHERE "id" = ${locator.terminalId} FOR UPDATE`);
  await assertLivePlanAccess(tx, context);
  await lockPlanContext(tx, locator.saleDraftId);
  await lockPaymentDraftItems(tx, locator.saleDraftId);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_payment_plans" WHERE "id" = ${planId} FOR UPDATE`);
  const plan = await tx.posPaymentPlan.findUnique({ where: { id: planId }, include: { slots: { orderBy: { paymentIndex: "asc" } } } });
  if (!plan) throw new PosPaymentPlanError("Plano de pagamento não encontrado.", 404);
  assertPlanContext(plan, context);
  if (plan.state !== "active" || plan.version !== expectedVersion) throw new PosPaymentPlanError("O plano mudou ou não está ativo para consumo.");
  if (plan.expiresAt <= new Date()) throw new PosPaymentPlanError("O plano expirou antes do commit; reconcilie qualquer prova antes de recotar.");
  const draft = await paymentDraft(tx, plan.saleDraftId);
  assertDraftContext(draft, plan);
  const draftRequestHash = await databasePaymentDraftSnapshotHash(tx, plan.saleDraftId);
  if (draft.revision !== plan.draftRevision || draft.status !== plan.draftStatus || draftRequestHash !== plan.draftRequestHash) {
    throw new PosPaymentPlanError("O rascunho divergiu da revisão e do hash autorizados pelo plano.");
  }
  if (executions.length !== plan.slots.length) throw new PosPaymentPlanError("O número de execuções diverge das divisões imutáveis do plano.");
  const paymentInputs = plan.slots.map((slot, paymentIndex): AuthoritativePosPaymentInput => {
    if (slot.paymentIndex !== paymentIndex) throw new PosPaymentPlanError("As divisões persistidas do plano não são contíguas.");
    const execution = executions[paymentIndex] ?? {};
    const externalProofs = Number(Boolean(execution.paymentIntentId)) + Number(Boolean(execution.manualReferenceId));
    const valueModes = Number(Boolean(execution.valueAccountId)) + Number(Boolean(execution.giftCode)) + Number(Boolean(execution.giftQrToken));
    if (slot.proofKind === "intent" && (externalProofs !== 1 || !execution.paymentIntentId || valueModes || execution.giftPin || execution.valueUnits != null || execution.tenderedCents != null)) {
      throw new PosPaymentPlanError(`A divisão ${paymentIndex + 1} exige exclusivamente uma intent capturada.`);
    }
    if (slot.proofKind === "manual" && (externalProofs !== 1 || !execution.manualReferenceId || valueModes || execution.giftPin || execution.valueUnits != null || execution.tenderedCents != null)) {
      throw new PosPaymentPlanError(`A divisão ${paymentIndex + 1} exige exclusivamente uma referência manual aprovada.`);
    }
    if (slot.proofKind === "cash" && (externalProofs || valueModes || execution.giftPin || execution.valueUnits != null)) {
      throw new PosPaymentPlanError(`A divisão ${paymentIndex + 1} em dinheiro só aceita o valor efetivamente entregue.`);
    }
    if (slot.proofKind === "value" && (externalProofs || valueModes !== 1 || Boolean(execution.valueAccountId) === Boolean(execution.giftPin)
      || Boolean(execution.giftCode || execution.giftQrToken) !== Boolean(execution.giftPin))) {
      throw new PosPaymentPlanError(`A divisão ${paymentIndex + 1} exige conta vinculada sem PIN ou gift/QR com PIN.`);
    }
    return {
      ...execution,
      method: slot.method as PlanMethod,
      amountCents: slot.amountCents,
      installments: slot.installments,
      ...(slot.proofKind === "cash" ? { tenderedCents: execution.tenderedCents ?? slot.amountCents } : {}),
    };
  });
  return { plan, paymentInputs, draft };
}

export async function preparePosPaymentPlanConsumption(
  tx: Prisma.TransactionClient,
  input: { planId: string; expectedVersion: number; saleId: number; actorUserId: string; idempotencyKey: string },
) {
  return preparePosPaymentPlanGraphWrite(tx, {
    action: "consume", planId: input.planId, expectedVersion: input.expectedVersion,
    actorUserId: input.actorUserId, idempotencyKey: input.idempotencyKey,
    targetPlan: jsonObject({ id: input.planId, state: "consumed", version: input.expectedVersion + 1, consumedSaleId: input.saleId }),
    quoteLines: [], slots: [],
  });
}

export async function consumePosPaymentPlan(tx: Prisma.TransactionClient, plan: { id: string; version: number; state: string }, saleId: number, actorUserId: string, operationKey: string, preparedRequestHash?: string) {
  const requestHash = preparedRequestHash ?? await preparePosPaymentPlanConsumption(tx, { planId: plan.id, expectedVersion: plan.version, saleId, actorUserId, idempotencyKey: operationKey });
  await tx.posPaymentPlanOperation.create({ data: { planId: plan.id, action: "consume", expectedVersion: plan.version, resultingVersion: plan.version + 1, resultingState: "consumed", idempotencyKey: operationKey, requestHash, actorUserId, saleId } });
  const changed = await tx.posPaymentPlan.updateMany({ where: { id: plan.id, state: "active", version: plan.version, consumedSaleId: null }, data: { state: "consumed", version: { increment: 1 }, consumedSaleId: saleId } });
  if (changed.count !== 1) throw new PosPaymentPlanError("O plano foi consumido ou alterado por outra venda.");
}

export async function supersedeOpenPosPaymentPlansForDraft(tx: Prisma.TransactionClient, saleDraftId: string, actorUserId: string, cause: string) {
  const plans = await tx.posPaymentPlan.findMany({ where: { saleDraftId, state: { in: ["quoted", "active"] } }, orderBy: { createdAt: "asc" } });
  for (const plan of plans) await supersedePlan(tx, plan, actorUserId, cause);
  return plans.length;
}

export function posPaymentPlanDto(plan: { id: string; saleDraftId: string; draftRevision: number; quoteHash: string; totalCents: number; currency: string; state: string; version: number; evaluatedAt: Date; expiresAt: Date; activatedAt: Date | null; consumedAt: Date | null; slots?: Array<{ paymentIndex: number; method: string; amountCents: number; installments: number; proofKind: string; connectorId: string | null; provider: string | null }> }) {
  return { id: plan.id, saleDraftId: plan.saleDraftId, draftRevision: plan.draftRevision, quoteHash: plan.quoteHash, totalCents: plan.totalCents, currency: plan.currency, state: plan.state, version: plan.version, evaluatedAt: plan.evaluatedAt, expiresAt: plan.expiresAt, activatedAt: plan.activatedAt, consumedAt: plan.consumedAt, slots: plan.slots ?? [] };
}

export function hashPosPaymentPlanPayload(value: unknown) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function stablePaymentPlanUuid(identityHash: string) {
  const hex = createHash("sha256").update(`pos-payment-plan:v1:${identityHash}`, "utf8").digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function jsonObject(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
}

async function databasePaymentDraftSnapshotHash(tx: Prisma.TransactionClient, saleDraftId: string) {
  const [result] = await tx.$queryRaw<Array<{ draftRequestHash: string }>>(Prisma.sql`
    SELECT public."pos_manual_t2_payment_plan_draft_snapshot_hash_v1"(${saleDraftId}) AS "draftRequestHash"
  `);
  if (!result?.draftRequestHash) throw new PosPaymentPlanError("O hash SQL do rascunho não foi encontrado.");
  return result.draftRequestHash;
}

async function supersedePlan(tx: Prisma.TransactionClient, plan: { id: string; state: string; version: number }, actorUserId: string, cause: string) {
  const idempotencyKey = paymentPlanSupersedeIdempotencyKey(plan);
  const targetPlan = jsonObject({ id: plan.id, state: "superseded", version: plan.version + 1, consumedSaleId: null });
  const requestHash = await preparePosPaymentPlanGraphWrite(tx, {
    action: "supersede", planId: plan.id, expectedVersion: plan.version, actorUserId,
    idempotencyKey, targetPlan, quoteLines: [], slots: [],
  });
  await tx.posPaymentPlanOperation.create({ data: { planId: plan.id, action: "supersede", expectedVersion: plan.version, resultingVersion: plan.version + 1, resultingState: "superseded", idempotencyKey, requestHash, actorUserId } });
  const changed = await tx.posPaymentPlan.updateMany({ where: { id: plan.id, state: plan.state, version: plan.version }, data: { state: "superseded", version: { increment: 1 } } });
  if (changed.count !== 1) throw new PosPaymentPlanError("O plano mudou durante a substituição.");
  await tx.tenantAuditEvent.create({ data: {
    actorId: actorUserId, action: "pos.payment.plan.superseded", entityType: "pos_payment_plan", entityId: plan.id,
    correlationId: randomUUID(), beforeData: { state: plan.state, version: plan.version },
    afterData: { state: "superseded", version: plan.version + 1, cause, requestHash },
  } });
}

export function paymentPlanSupersedeIdempotencyKey(plan: { id: string; version: number }) {
  return `payment-plan-supersede:${hashPosPaymentPlanPayload({ planId: plan.id, expectedVersion: plan.version })}`;
}

async function paymentDraft(tx: Prisma.TransactionClient, saleDraftId: string) {
  const draft = await tx.posHeldSale.findUnique({ where: { id: saleDraftId }, include: { items: { orderBy: { id: "asc" } } } });
  if (!draft || !["draft", "held"].includes(draft.status)) throw new PosPaymentPlanError("O plano exige rascunho server-side ativo ou venda suspensa explícita.", 404);
  return draft;
}

async function lockPaymentDraftItems(tx: Prisma.TransactionClient, saleDraftId: string) {
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "pos_held_sale_items"
    WHERE "held_sale_id" = ${saleDraftId}
    ORDER BY "id"
    FOR UPDATE
  `);
}

function paymentDraftSnapshot(draft: Awaited<ReturnType<typeof paymentDraft>>) {
  return { id: draft.id, registerId: draft.registerId, sessionId: draft.sessionId, operatorProfileId: draft.operatorProfileId, customerId: draft.customerId, notes: draft.notes, discountCents: draft.discountCents, surchargeCents: draft.surchargeCents, revision: draft.revision, status: draft.status, items: draft.items.map(item => ({ productId: item.productId, variationId: item.variationId, quantity: item.quantity, unitPriceCents: item.unitPriceCents, discountCents: item.discountCents, scanData: item.scanData ?? null })) };
}

function assertDraftContext(draft: Awaited<ReturnType<typeof paymentDraft>>, context: Pick<PosPaymentPlanContext, "registerId" | "sessionId" | "operatorProfileId">) {
  if (draft.registerId !== context.registerId || draft.sessionId !== context.sessionId || draft.operatorProfileId !== context.operatorProfileId) throw new PosPaymentPlanError("O rascunho pertence a outro turno, caixa ou operador.", 403);
}

function assertDraftMatchesPlan(draft: Awaited<ReturnType<typeof paymentDraft>>, plan: { registerId: number; sessionId: number; operatorProfileId: number; draftRevision: number; draftStatus: string; draftRequestHash: string }) {
  assertDraftContext(draft, plan);
  if (draft.revision !== plan.draftRevision || draft.status !== plan.draftStatus || hashPosPaymentPlanPayload(paymentDraftSnapshot(draft)) !== plan.draftRequestHash) throw new PosPaymentPlanError("O rascunho divergiu da revisão e do hash autorizados pelo plano.");
}

function assertPlanContext(plan: { branchId: number; registerId: number; sessionId: number; operatorProfileId: number; terminalId: string }, context: PosPaymentPlanContext) {
  if (plan.branchId !== context.branchId || plan.registerId !== context.registerId || plan.sessionId !== context.sessionId || plan.operatorProfileId !== context.operatorProfileId || plan.terminalId !== context.terminalId) throw new PosPaymentPlanError("O plano pertence a outro contexto operacional.", 403);
}

async function assertSlotConnectors(tx: Prisma.TransactionClient, context: PosPaymentPlanContext, slots: PosPaymentPlanSlotInput[]) {
  const credentialBySlot = new Map<number, string>();
  const intentConnectorIds = [...new Set(slots.filter(slot => slot.proofKind === "intent").map(slot => slot.connectorId!))].sort();
  for (const connectorId of intentConnectorIds) {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_connectors" WHERE "id" = ${connectorId} FOR SHARE`);
  }
  const connectors = intentConnectorIds.length ? await tx.posConnector.findMany({
    where: { id: { in: intentConnectorIds }, branchId: context.branchId, status: "active", type: { startsWith: "payment" }, OR: [{ registerId: null }, { registerId: context.registerId }] },
    select: { id: true, provider: true, credentialRef: true, settings: true },
  }) : [];
  const connectorById = new Map(connectors.map(connector => [connector.id, connector]));
  const credentialIds = [...new Set(connectors.flatMap(connector => connector.credentialRef ? [connector.credentialRef] : []))].sort();
  for (const credentialId of credentialIds) {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "integration_credentials" WHERE "id" = ${credentialId} FOR SHARE`);
  }
  const credentials = credentialIds.length ? await tx.integrationCredential.findMany({
    where: { id: { in: credentialIds }, enabled: true, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }], provider: { family: "payment" } },
    select: { id: true, providerId: true },
  }) : [];
  const credentialById = new Map(credentials.map(credential => [credential.id, credential]));
  for (const slot of slots) {
    if (slot.proofKind === "intent") {
      const connector = connectorById.get(slot.connectorId!);
      const credential = connector?.credentialRef ? credentialById.get(connector.credentialRef) : null;
      if (!connector || connector.provider !== slot.provider || connector.provider === "manual_pos" || !credential || credential.providerId !== connector.provider || !connectorAllowsMethod(connector.settings, slot.method)) throw new PosPaymentPlanError(`O conector da divisão ${slot.paymentIndex + 1} não está homologado para o método informado.`);
      credentialBySlot.set(slot.paymentIndex, credential.id);
    } else if (slot.proofKind === "manual") {
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "pos_connectors"
        WHERE "branch_id" = ${context.branchId} AND "provider" = ${slot.provider!}
          AND "status" = 'active' AND "type" LIKE 'payment%'
          AND ("register_id" IS NULL OR "register_id" = ${context.registerId})
        ORDER BY "id"
        FOR SHARE
      `);
      const connectors = await tx.posConnector.findMany({ where: { branchId: context.branchId, provider: slot.provider!, status: "active", type: { startsWith: "payment" }, OR: [{ registerId: null }, { registerId: context.registerId }] }, select: { settings: true } });
      if (!connectors.some(connector => connectorAllowsMethod(connector.settings, slot.method))) throw new PosPaymentPlanError(`O provedor manual da divisão ${slot.paymentIndex + 1} não está habilitado para o método.`);
    }
  }
  return credentialBySlot;
}

async function assertOrderClaimPlan(tx: Prisma.TransactionClient, plan: { orderClaimId: string | null; saleDraftId: string; branchId: number; registerId: number; sessionId: number; operatorProfileId: number; terminalId: string }, slots: PosPaymentPlanSlotInput[], context: PosPaymentPlanContext) {
  const { lockedPosPaymentDraftIssue } = await import("@/lib/erp/pos-order-claim");
  if (slots.length !== 1) throw new PosPaymentPlanError("Pedido reivindicado exige uma única divisão de pagamento.");
  const slot = slots[0];
  const issue = await lockedPosPaymentDraftIssue(tx, { saleDraftId: plan.saleDraftId, branchId: plan.branchId, registerId: plan.registerId, sessionId: plan.sessionId, operatorProfileId: plan.operatorProfileId, terminalId: plan.terminalId, paymentIndex: 0, payment: { method: slot.method, amountCents: slot.amountCents, installments: slot.installments } });
  if (issue) throw new PosPaymentPlanError(issue);
  if (context.terminalId !== plan.terminalId || plan.orderClaimId !== plan.saleDraftId) throw new PosPaymentPlanError("O claim do plano não corresponde ao rascunho autorizado.");
}

async function lockPlanContext(tx: Prisma.TransactionClient, identity: string, identityIsPlan = false) {
  let saleDraftId = identity;
  if (identityIsPlan) {
    const locator = await tx.posPaymentPlan.findUnique({ where: { id: identity }, select: { saleDraftId: true } });
    if (!locator) throw new PosPaymentPlanError("Plano de pagamento não encontrado.", 404);
    saleDraftId = locator.saleDraftId;
  }
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_order_claims" WHERE "id" = ${saleDraftId} FOR UPDATE`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_held_sales" WHERE "id" = ${saleDraftId} FOR UPDATE`);
  return saleDraftId;
}

function activationReplay(replay: Prisma.PosPaymentPlanOperationGetPayload<{ include: { plan: { include: { slots: true } } } }>, context: PosPaymentPlanContext, planId: string, requestHash: string) {
  if (replay.planId !== planId || replay.action !== "activate" || replay.requestHash !== requestHash) throw new PosPaymentPlanError("A chave idempotente já foi usada com outro plano ou conteúdo.");
  assertPlanContext(replay.plan, context);
  return { plan: replay.plan, replayed: true };
}

function connectorAllowsMethod(settings: Prisma.JsonValue | null, method: string) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return true;
  const methods = (settings as Record<string, unknown>).methods;
  if (methods == null) return true;
  if (!Array.isArray(methods) || methods.some(value => typeof value !== "string" || !externalMethod(value))) return false;
  return (methods as string[]).includes(method);
}

async function assertLivePlanAccess(tx: Prisma.TransactionClient, context: Pick<PosPaymentPlanContext, "branchId" | "registerId" | "operatorProfileId">) {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "tenant_user_profiles" WHERE "id" = ${context.operatorProfileId} FOR SHARE`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "branches" WHERE "id" = ${context.branchId} FOR SHARE`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_registers" WHERE "id" = ${context.registerId} FOR SHARE`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "branch_user_accesses" WHERE "branch_id" = ${context.branchId} AND "user_profile_id" = ${context.operatorProfileId} FOR SHARE`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_register_accesses" WHERE "register_id" = ${context.registerId} AND "user_profile_id" = ${context.operatorProfileId} FOR SHARE`);
  const now = new Date();
  const [profile, branch, register, branchAccess, registerAccess] = await Promise.all([
    tx.tenantUserProfile.findUnique({ where: { id: context.operatorProfileId }, select: { status: true } }),
    tx.branch.findUnique({ where: { id: context.branchId }, select: { status: true } }),
    tx.posRegister.findUnique({ where: { id: context.registerId }, select: { branchId: true, status: true } }),
    tx.branchUserAccess.findUnique({ where: { branchId_userProfileId: { branchId: context.branchId, userProfileId: context.operatorProfileId } }, select: { canSell: true } }),
    tx.posRegisterAccess.findUnique({ where: { registerId_userProfileId: { registerId: context.registerId, userProfileId: context.operatorProfileId } }, select: { active: true, canSell: true, validFrom: true, validUntil: true } }),
  ]);
  if (profile?.status !== "active" || branch?.status !== "active" || register?.status !== "active" || register.branchId !== context.branchId
    || branchAccess?.canSell !== true || registerAccess?.active !== true || registerAccess.canSell !== true
    || registerAccess.validFrom && registerAccess.validFrom > now || registerAccess.validUntil && registerAccess.validUntil < now) {
    throw new PosPaymentPlanError("O acesso explícito de venda ao caixa foi revogado ou expirou.", 403);
  }
}

function externalMethod(value: string): value is "pix" | "credit" | "debit" | "voucher" { return ["pix", "credit", "debit", "voucher"].includes(value); }
function validDate(value: Date, label: string) { if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) throw new PosPaymentPlanError(`${label} inválida.`, 422); return value; }
function hash(value: unknown, label: string) { const result = String(value ?? "").toLowerCase(); if (!/^[0-9a-f]{64}$/.test(result)) throw new PosPaymentPlanError(`${label} inválido.`, 422); return result; }
function identifier(value: unknown, label: string, minimum: number, maximum: number) { const result = typeof value === "string" ? value.normalize("NFKC").trim() : ""; if (result.length < minimum || result.length > maximum || !/^[A-Za-z0-9._:-]+$/.test(result)) throw new PosPaymentPlanError(`${label} inválido.`, 400); return result; }
function nullableIdentifier(value: unknown, label: string, maximum: number) { return value == null || value === "" ? null : identifier(value, label, 1, maximum); }
function integer(value: unknown, label: string, minimum: number, maximum: number) { const result = Number(value); if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new PosPaymentPlanError(`${label} inválido.`, 422); return result; }
function choice<const T extends readonly string[]>(value: unknown, choices: T, label: string): T[number] { const result = String(value ?? ""); if (!choices.includes(result as never)) throw new PosPaymentPlanError(`${label} inválido.`, 422); return result as T[number]; }
function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]) { const extra = Object.keys(value).find(key => !allowed.includes(key)); if (extra) throw new PosPaymentPlanError(`Campo não permitido: ${extra}.`, 400); }
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new PosPaymentPlanError("Número não finito no plano."); return JSON.stringify(value); }
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") throw new PosPaymentPlanError("Valor não canônico no plano.");
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
