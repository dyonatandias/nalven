import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@/generated/tenant/client";

export type PosHeldCartTransferContext = {
  branchId: number;
  actorUserId: string;
  actorProfileId: number;
  actorName: string;
  privileged: boolean;
};

export type PosHeldCartTransferInput = {
  heldSaleId: string;
  sourceSessionId: number;
  targetSessionId: number;
  expectedRevision: number;
  idempotencyKey: string;
  reason: string;
};

export class PosHeldCartTransferError extends Error {
  constructor(message: string, public readonly status = 422) {
    super(message);
    this.name = "PosHeldCartTransferError";
  }
}

type ReadDb = Pick<Prisma.TransactionClient, "posHeldSale" | "posHeldSaleTransfer" | "cashRegisterSession" | "branchUserAccess" | "posRegisterAccess">;
type RootDb = Pick<PrismaClient, "posHeldSaleTransfer" | "$transaction">;

export function parsePosHeldCartTransferInput(body: Record<string, unknown>): PosHeldCartTransferInput {
  onlyKeys(body, ["heldSaleId", "sourceSessionId", "targetSessionId", "expectedRevision", "idempotencyKey", "reason"]);
  const input = {
    heldSaleId: text(body.heldSaleId, "Carrinho suspenso", 1, 80),
    sourceSessionId: integer(body.sourceSessionId, "Turno de origem", 1, 2_147_483_647),
    targetSessionId: integer(body.targetSessionId, "Turno de destino", 1, 2_147_483_647),
    expectedRevision: integer(body.expectedRevision, "Revisão esperada", 0, 2_147_483_646),
    idempotencyKey: token(body.idempotencyKey),
    reason: text(body.reason, "Motivo", 4, 300),
  };
  if (input.sourceSessionId === input.targetSessionId) throw new PosHeldCartTransferError("O turno de destino deve ser diferente do turno de origem.");
  return input;
}

export function hashPosHeldCartTransfer(input: PosHeldCartTransferInput) {
  return createHash("sha256").update(canonicalJson({ ...input, idempotencyKey: undefined })).digest("hex");
}

export function assertPosHeldCartTransferReplay(
  transfer: { actorUserId: string; actorProfileId: number; branchId: number; requestHash: string },
  context: PosHeldCartTransferContext,
  requestHash: string,
) {
  if (transfer.actorUserId !== context.actorUserId || transfer.actorProfileId !== context.actorProfileId || transfer.branchId !== context.branchId) {
    throw new PosHeldCartTransferError("A chave idempotente pertence a outro contexto operacional.", 409);
  }
  if (transfer.requestHash !== requestHash) throw new PosHeldCartTransferError("A chave idempotente já foi usada com outro destino, revisão ou motivo.", 409);
}

export async function listPosHeldCartTransferTargets(
  db: ReadDb,
  context: PosHeldCartTransferContext,
  heldSaleId: string,
  sourceSessionId: number,
) {
  const now = new Date();
  const held = await db.posHeldSale.findFirst({
    where: {
      id: heldSaleId,
      sessionId: sourceSessionId,
      operatorProfileId: context.actorProfileId,
      status: "held",
      register: { branchId: context.branchId, status: "active" },
    },
    select: { id: true, registerId: true, sessionId: true, revision: true, expiresAt: true },
  });
  if (!held) throw new PosHeldCartTransferError("Carrinho suspenso não encontrado no seu turno.", 404);
  if (held.expiresAt && held.expiresAt <= now) throw new PosHeldCartTransferError("O carrinho suspenso expirou e não pode ser transferido.", 409);
  await assertSourceAuthority(db, context, held.registerId, now);
  const sessions = await db.cashRegisterSession.findMany({
    where: {
      id: { not: sourceSessionId },
      status: "open",
      registerId: { not: null },
      operatorProfileId: { not: context.actorProfileId },
      register: { branchId: context.branchId, status: "active" },
      operatorProfile: { status: "active" },
    },
    select: targetSessionSelect(context.branchId, now),
    orderBy: [{ registerName: "asc" }, { id: "asc" }],
    take: 100,
  });
  return {
    heldSaleId: held.id,
    revision: held.revision,
    targets: sessions.filter(targetAuthorized).map(targetDto),
  };
}

export async function executePosHeldCartTransfer(db: RootDb, context: PosHeldCartTransferContext, input: PosHeldCartTransferInput) {
  const requestHash = hashPosHeldCartTransfer(input);
  const replay = await db.posHeldSaleTransfer.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (replay) {
    assertPosHeldCartTransferReplay(replay, context, requestHash);
    return { transfer: posHeldCartTransferDto(replay), replayed: true };
  }
  try {
    const transfer = await db.$transaction(
      tx => applyPosHeldCartTransfer(tx, context, input, requestHash),
      { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 },
    );
    return { transfer: posHeldCartTransferDto(transfer), replayed: false };
  } catch (error) {
    if (["P2002", "P2034"].includes(prismaCode(error))) {
      const concurrent = await db.posHeldSaleTransfer.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (concurrent) {
        assertPosHeldCartTransferReplay(concurrent, context, requestHash);
        return { transfer: posHeldCartTransferDto(concurrent), replayed: true };
      }
      throw new PosHeldCartTransferError("O carrinho foi transferido ou alterado concorrentemente. Atualize o PDV.", 409);
    }
    throw error;
  }
}

export async function applyPosHeldCartTransfer(
  tx: Prisma.TransactionClient,
  context: PosHeldCartTransferContext,
  input: PosHeldCartTransferInput,
  requestHash = hashPosHeldCartTransfer(input),
) {
  // Locator reads never authorize the mutation. They only discover the roots
  // that must be locked in the global order: sessions first, held sale next.
  // The authoritative row is re-read after both locks and must still match the
  // locator, otherwise this transaction fails closed instead of inverting the
  // handoff lock order (session -> held sale).
  const locator = await tx.posHeldSale.findUnique({
    where: { id: input.heldSaleId },
    select: { id: true, registerId: true, sessionId: true, operatorProfileId: true },
  });
  if (!locator || locator.operatorProfileId !== context.actorProfileId || locator.sessionId !== input.sourceSessionId) {
    throw new PosHeldCartTransferError("Carrinho suspenso não encontrado no seu turno.", 404);
  }
  const sessionIds = [locator.sessionId, input.targetSessionId].sort((left, right) => left - right);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "cash_register_sessions" WHERE "id" IN (${Prisma.join(sessionIds)}) ORDER BY "id" FOR UPDATE`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_held_sales" WHERE "id" = ${input.heldSaleId} FOR UPDATE`);
  const held = await tx.posHeldSale.findUnique({
    where: { id: input.heldSaleId },
    select: { id: true, registerId: true, sessionId: true, operatorProfileId: true, status: true, revision: true, expiresAt: true },
  });
  if (!held || held.registerId !== locator.registerId || held.operatorProfileId !== locator.operatorProfileId
    || held.sessionId !== locator.sessionId || held.operatorProfileId !== context.actorProfileId || held.sessionId !== input.sourceSessionId) {
    throw new PosHeldCartTransferError("Carrinho suspenso não encontrado no seu turno.", 404);
  }
  if (held.status !== "held") throw new PosHeldCartTransferError("O carrinho já foi descartado, convertido ou transferido.", 409);
  if (held.revision !== input.expectedRevision) throw new PosHeldCartTransferError("A revisão do carrinho está desatualizada. Recarregue antes de transferir.", 409);
  const now = new Date();
  if (held.expiresAt && held.expiresAt <= now) throw new PosHeldCartTransferError("O carrinho suspenso expirou e não pode ser transferido.", 409);
  const sourceSession = await tx.cashRegisterSession.findFirst({
    where: {
      id: held.sessionId,
      registerId: held.registerId,
      operatorProfileId: context.actorProfileId,
      status: "open",
      register: { branchId: context.branchId, status: "active" },
    },
    select: { id: true },
  });
  if (!sourceSession) throw new PosHeldCartTransferError("O turno de origem foi encerrado ou saiu da filial ativa.", 409);
  await assertSourceAuthority(tx, context, held.registerId, now);
  const target = await tx.cashRegisterSession.findFirst({
    where: {
      id: input.targetSessionId,
      status: "open",
      registerId: { not: null },
      operatorProfileId: { not: null },
      register: { branchId: context.branchId, status: "active" },
      operatorProfile: { status: "active" },
    },
    select: targetSessionSelect(context.branchId, now),
  });
  if (!target || !target.registerId || !target.operatorProfileId || !target.operatorProfile) throw new PosHeldCartTransferError("Turno receptor ativo não encontrado nesta filial.", 404);
  if (target.operatorProfileId === context.actorProfileId || target.id === held.sessionId || target.registerId === held.registerId) {
    throw new PosHeldCartTransferError("Não é permitido transferir o carrinho para si mesmo ou para o mesmo caixa.");
  }
  if (!targetAuthorized(target)) throw new PosHeldCartTransferError("O operador receptor não possui acesso de venda vigente neste caixa.", 403);
  const resultingRevision = held.revision + 1;
  const changed = await tx.posHeldSale.updateMany({
    where: {
      id: held.id,
      status: "held",
      revision: input.expectedRevision,
      registerId: held.registerId,
      sessionId: held.sessionId,
      operatorProfileId: held.operatorProfileId,
    },
    data: {
      registerId: target.registerId,
      sessionId: target.id,
      operatorProfileId: target.operatorProfileId,
      revision: { increment: 1 },
    },
  });
  if (changed.count !== 1) throw new PosHeldCartTransferError("O carrinho foi alterado concorrentemente. Recarregue antes de transferir.", 409);
  const transfer = await tx.posHeldSaleTransfer.create({ data: {
    heldSaleId: held.id,
    branchId: context.branchId,
    fromRegisterId: held.registerId,
    fromSessionId: held.sessionId,
    fromOperatorProfileId: held.operatorProfileId,
    toRegisterId: target.registerId,
    toSessionId: target.id,
    toOperatorProfileId: target.operatorProfileId,
    actorProfileId: context.actorProfileId,
    actorUserId: context.actorUserId,
    expectedRevision: input.expectedRevision,
    resultingRevision,
    idempotencyKey: input.idempotencyKey,
    requestHash,
    reason: input.reason,
  } });
  const correlationId = randomUUID();
  await tx.tenantAuditEvent.create({ data: {
    actorId: context.actorUserId,
    action: "pos.held_cart.transferred",
    entityType: "pos_held_sale",
    entityId: held.id,
    correlationId,
    beforeData: { registerId: held.registerId, sessionId: held.sessionId, operatorProfileId: held.operatorProfileId, revision: held.revision },
    afterData: { registerId: target.registerId, sessionId: target.id, operatorProfileId: target.operatorProfileId, revision: resultingRevision, transferId: transfer.id.toString(), reason: input.reason, idempotencyKey: input.idempotencyKey },
  } });
  return transfer;
}

export function posHeldCartTransferDto(transfer: {
  id: bigint;
  heldSaleId: string;
  branchId: number;
  fromRegisterId: number;
  fromSessionId: number;
  fromOperatorProfileId: number;
  toRegisterId: number;
  toSessionId: number;
  toOperatorProfileId: number;
  actorProfileId: number;
  expectedRevision: number;
  resultingRevision: number;
  reason: string;
  createdAt: Date;
}) {
  return {
    id: transfer.id.toString(),
    heldSaleId: transfer.heldSaleId,
    branchId: transfer.branchId,
    fromRegisterId: transfer.fromRegisterId,
    fromSessionId: transfer.fromSessionId,
    fromOperatorProfileId: transfer.fromOperatorProfileId,
    toRegisterId: transfer.toRegisterId,
    toSessionId: transfer.toSessionId,
    toOperatorProfileId: transfer.toOperatorProfileId,
    actorProfileId: transfer.actorProfileId,
    expectedRevision: transfer.expectedRevision,
    resultingRevision: transfer.resultingRevision,
    reason: transfer.reason,
    createdAt: transfer.createdAt.toISOString(),
  };
}

function targetSessionSelect(branchId: number, now: Date) {
  return {
    id: true,
    number: true,
    registerId: true,
    operatorProfileId: true,
    register: { select: { id: true, name: true, code: true, branchId: true, status: true } },
    operatorProfile: { select: {
      id: true,
      displayName: true,
      status: true,
      role: { select: { key: true, active: true } },
      branchAccesses: { where: { branchId }, select: { canSell: true } },
      posRegisterAccesses: {
        where: {
          active: true,
          canSell: true,
          register: { branchId, status: "active" },
          AND: [
            { OR: [{ validFrom: null }, { validFrom: { lte: now } }] },
            { OR: [{ validUntil: null }, { validUntil: { gte: now } }] },
          ],
        },
        select: { registerId: true, canSell: true },
      },
    } },
  } satisfies Prisma.CashRegisterSessionSelect;
}

type TargetSession = Prisma.CashRegisterSessionGetPayload<{ select: ReturnType<typeof targetSessionSelect> }>;

function targetAuthorized(target: TargetSession) {
  const profile = target.operatorProfile;
  if (!profile || !target.registerId) return false;
  const privileged = profile.role.active && ["owner", "admin"].includes(profile.role.key);
  return privileged || Boolean(profile.branchAccesses[0]?.canSell && profile.posRegisterAccesses.some((access: { registerId: number; canSell: boolean }) => access.registerId === target.registerId && access.canSell));
}

function targetDto(target: TargetSession) {
  return {
    sessionId: target.id,
    sessionNumber: target.number,
    registerId: target.registerId!,
    registerCode: target.register!.code,
    registerName: target.register!.name,
    operatorProfileId: target.operatorProfileId!,
    operatorName: target.operatorProfile!.displayName,
  };
}

async function assertSourceAuthority(db: ReadDb, context: PosHeldCartTransferContext, registerId: number, now: Date) {
  if (context.privileged) return;
  const [branchAccess, registerAccess] = await Promise.all([
    db.branchUserAccess.findUnique({
      where: { branchId_userProfileId: { branchId: context.branchId, userProfileId: context.actorProfileId } },
      select: { canSell: true },
    }),
    db.posRegisterAccess.findFirst({
      where: {
        registerId,
        userProfileId: context.actorProfileId,
        active: true,
        canSell: true,
        canTransferHeld: true,
        register: { branchId: context.branchId, status: "active" },
        AND: [
          { OR: [{ validFrom: null }, { validFrom: { lte: now } }] },
          { OR: [{ validUntil: null }, { validUntil: { gte: now } }] },
        ],
      },
      select: { id: true },
    }),
  ]);
  if (!branchAccess?.canSell || !registerAccess) throw new PosHeldCartTransferError("Sua alçada para transferir carrinhos neste caixa foi revogada ou expirou.", 403);
}

function onlyKeys(body: Record<string, unknown>, allowed: readonly string[]) {
  const extra = Object.keys(body).find(field => !allowed.includes(field));
  if (extra) throw new PosHeldCartTransferError(`Campo não permitido: ${extra}.`);
}

function text(value: unknown, label: string, minimum: number, maximum: number) {
  if (typeof value !== "string") throw new PosHeldCartTransferError(`${label} inválido.`);
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length < minimum || normalized.length > maximum) throw new PosHeldCartTransferError(`${label} inválido.`);
  return normalized;
}

function token(value: unknown) {
  const result = text(value, "Chave idempotente", 16, 160);
  if (!/^[A-Za-z0-9._:-]+$/.test(result)) throw new PosHeldCartTransferError("Chave idempotente inválida.");
  return result;
}

function integer(value: unknown, label: string, minimum: number, maximum: number) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new PosHeldCartTransferError(`${label} inválida.`);
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter(key => record[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function prismaCode(error: unknown) {
  return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code || "") : "";
}
