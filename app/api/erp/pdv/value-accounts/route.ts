import { randomUUID } from "node:crypto";
import { Prisma } from "@/generated/tenant/client";
import { currentOrganization, tenantDb } from "@/db";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import { assertSameOrigin, CustomerInputError } from "@/lib/erp/customer-input";
import { assertPosMutationRequest, enforcePosRateLimit, PosHttpError, readPosJson } from "@/lib/erp/pos-http";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { toPosT2BoundaryIdempotencyKey, writePosT2ValueProgramBoundary } from "@/lib/erp/pos-t2-boundary";
import { hashPosValueAdminInput, parsePosValueAdminInput, PosValueAdminError, type PosValueAdminInput } from "@/lib/erp/pos-value-admin";
import { applyPosValueCommand, issuePosValueAccount, posValueAccountDto, posValueEntryDto, posValueReservationDto, PosValueError } from "@/lib/erp/pos-value-accounts";
import { generatePosGiftCode, hashPosGiftCode, hashPosGiftPin, posGiftCodeLastFour, PosValueSecretError } from "@/lib/erp/pos-value-secrets";
import { assertTenantWriteAccess } from "@/lib/tenant-access";

type Db = Awaited<ReturnType<typeof tenantDb>>;
type Tx = Prisma.TransactionClient;
type AdminAccess = Awaited<ReturnType<typeof adminAccess>>;
type MutationResult = { entityType: string; entityId: string; status: number; body: Record<string, unknown>; beforeData?: Record<string, unknown> };

export async function GET(request: Request) {
  try {
    assertSameOrigin(request);
    const access = await adminAccess(), url = new URL(request.url);
    const branches = await access.db.branch.findMany({ where: { status: "active" }, select: { id: true, code: true, name: true }, orderBy: [{ primary: "desc" }, { name: "asc" }] });
    if (!branches.length) throw new PosValueAdminError("Cadastre uma filial ativa antes de gerir valores.", 409);
    const branchId = url.searchParams.get("branchId") ? positiveId(url.searchParams.get("branchId"), "Filial") : await activeBranchId(access.db, access.actor.user.id, branches[0].id);
    if (!branches.some(branch => branch.id === branchId)) throw new PosValueAdminError("Filial ativa não encontrada.", 404);
    const [customers, programs, accounts] = await Promise.all([
      access.db.customer.findMany({ where: { status: "active" }, select: { id: true, name: true }, orderBy: { name: "asc" }, take: 500 }),
      access.db.posValueProgram.findMany({ where: { branchId }, orderBy: [{ status: "asc" }, { name: "asc" }] }),
      access.db.posValueAccount.findMany({
        where: { branchId },
        include: {
          customer: { select: { id: true, name: true } }, program: { select: { id: true, name: true, kind: true, status: true } },
          entries: { orderBy: { id: "desc" }, take: 12, include: { reversedBy: { select: { id: true } } } },
          reservations: { orderBy: { createdAt: "desc" }, take: 12 },
        },
        orderBy: [{ status: "asc" }, { updatedAt: "desc" }], take: 250,
      }),
    ]);
    return Response.json({ branchId, branches, customers, programs: programs.map(programDto), accounts: accounts.map(accountAdminDto) }, { headers: noStoreHeaders() });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    assertPosMutationRequest(request);
    const access = await adminAccess();
    await assertTenantWriteAccess(access.organizationId);
    const input = parsePosValueAdminInput(await readPosJson(request, 32_768));
    await enforcePosRateLimit(access.db, access.actor.user.id, `admin:${input.action}`);
    return executeIdempotent(access, input);
  } catch (error) {
    return failure(error);
  }
}

async function adminAccess() {
  const organization = await currentOrganization();
  const actor = await assertTenantPermission(organization.id, "pdv.write");
  if (!["owner", "admin"].includes(actor.membership.role)) throw new PosValueAdminError("Somente proprietários e administradores podem gerir fidelidade e valores.", 403);
  const db = await tenantDb(organization.id);
  const profile = await db.tenantUserProfile.findUnique({ where: { userId: actor.user.id }, select: { displayName: true } });
  return { organizationId: organization.id, actor, actorName: profile?.displayName || actor.user.email || actor.user.id, db };
}

async function executeIdempotent(access: AdminAccess, input: PosValueAdminInput) {
  const requestHash = hashPosValueAdminInput(input);
  const existing = await access.db.pdvAdminMutation.findUnique({ where: { key: input.idempotencyKey } });
  if (existing) return replay(existing, access.actor.user.id, input.action, requestHash);
  const giftCode = input.action === "value.account.issue" && input.kind === "gift_card" ? generatePosGiftCode() : null;
  const giftCredential = giftCode && input.action === "value.account.issue" && input.pin ? {
    codeHash: hashPosGiftCode(giftCode), codeLastFour: posGiftCodeLastFour(giftCode), pinHash: await hashPosGiftPin(input.pin),
  } : null;
  const correlationId = randomUUID();
  try {
    const completed = await access.db.$transaction(async tx => {
      await tx.pdvAdminMutation.create({ data: { key: input.idempotencyKey, actorId: access.actor.user.id, action: input.action, requestHash, expiresAt: new Date(Date.now() + 30 * 86_400_000) } });
      const result = await mutate(tx, input, requestHash, access.actorName, access.actor.user.id, giftCredential);
      const responseBody = jsonObject({ ...result.body, correlationId, replayed: false, secretAvailable: false });
      await tx.tenantAuditEvent.create({ data: {
        actorId: access.actor.user.id, action: `pos.admin.${input.action}`, entityType: result.entityType, entityId: result.entityId, correlationId,
        beforeData: result.beforeData ? jsonObject(result.beforeData) : undefined,
        afterData: jsonObject({ ...result.body, idempotencyKey: input.idempotencyKey, requestHash }),
      } });
      await tx.pdvAdminMutation.update({ where: { key: input.idempotencyKey }, data: { state: "completed", entityType: result.entityType, entityId: result.entityId, responseStatus: result.status, responseBody } });
      return { status: result.status, body: responseBody };
    }, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 });
    return Response.json({ ...completed.body, ...(giftCode ? { giftCode, secretAvailable: true } : {}) }, { status: completed.status, headers: noStoreHeaders() });
  } catch (error) {
    if (new Set(["P2002", "P2034"]).has(prismaCode(error))) {
      const concurrent = await access.db.pdvAdminMutation.findUnique({ where: { key: input.idempotencyKey } });
      if (concurrent) return replay(concurrent, access.actor.user.id, input.action, requestHash);
    }
    throw error;
  }
}

async function mutate(tx: Tx, input: PosValueAdminInput, requestHash: string, actor: string, actorUserId: string, giftCredential: { codeHash: string; codeLastFour: string; pinHash: string } | null): Promise<MutationResult> {
  const now = new Date(), referenceType = "pos_value_admin", referenceId = input.idempotencyKey;
  if (input.action === "value.program.create") {
    await assertActiveBranch(tx, input.branchId);
    const boundary = await writePosT2ValueProgramBoundary(tx, {
      action: "put", programId: null, expectedRevision: null, expectedConfigHash: null,
      projection: { branchId: input.branchId, name: input.name, kind: input.kind, status: "active", earnUnits: input.earnUnits, spendCents: input.spendCents, redeemCentsPerUnit: input.redeemCentsPerUnit, expiresAfterDays: input.expiresAfterDays },
      actorUserId, idempotencyKey: toPosT2BoundaryIdempotencyKey(input.idempotencyKey),
    });
    const program = await tx.posValueProgram.findUniqueOrThrow({ where: { id: boundary.programId } });
    return { entityType: "pos_value_program", entityId: program.id, status: 201, body: { program: programDto(program) } };
  }
  if (input.action === "value.program.deactivate") {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_value_programs" WHERE "id" = ${input.programId} FOR UPDATE`);
    const program = await tx.posValueProgram.findUnique({ where: { id: input.programId } });
    if (!program) throw new PosValueAdminError("Programa não encontrado.", 404);
    const boundary = await writePosT2ValueProgramBoundary(tx, {
      action: "deactivate", programId: program.id, expectedRevision: program.revision, expectedConfigHash: program.configHash,
      projection: { branchId: program.branchId, name: program.name, kind: program.kind, status: "inactive", earnUnits: program.earnUnits, spendCents: program.spendCents, redeemCentsPerUnit: program.redeemCentsPerUnit, expiresAfterDays: program.expiresAfterDays },
      actorUserId, idempotencyKey: toPosT2BoundaryIdempotencyKey(input.idempotencyKey),
    });
    const saved = await tx.posValueProgram.findUniqueOrThrow({ where: { id: boundary.programId } });
    return { entityType: "pos_value_program", entityId: program.id, status: 200, beforeData: programDto(program), body: { program: programDto(saved) } };
  }
  if (input.action === "value.account.issue") {
    const result = await issuePosValueAccount(tx, {
      operationKey: input.idempotencyKey, requestHash, referenceType, referenceId, reason: "Emissão administrativa",
      branchId: input.branchId, customerId: input.customerId, programId: input.programId, kind: input.kind, label: input.label,
      initialUnits: input.initialUnits, expiresAt: input.expiresAt, giftCredential,
    }, { actor, now });
    return valueResult(result, 201);
  }
  const reason = input.reason;
  if (input.action === "value.account.credit" || input.action === "value.account.debit") {
    const result = await applyPosValueCommand(tx, {
      type: input.action === "value.account.credit" ? "credit" : "debit", operationKey: input.idempotencyKey, requestHash,
      referenceType, referenceId, reason, accountId: input.accountId, branchId: input.branchId, amountUnits: input.amountUnits,
    }, { actor, now });
    return valueResult(result, 200);
  }
  if (input.action === "value.account.expire") {
    const result = await applyPosValueCommand(tx, { type: "expire", operationKey: input.idempotencyKey, requestHash, referenceType, referenceId, reason, accountId: input.accountId, branchId: input.branchId }, { actor, now });
    return valueResult(result, 200);
  }
  if (input.action === "value.reservation.create") {
    const result = await applyPosValueCommand(tx, {
      type: "reserve", operationKey: input.idempotencyKey, requestHash, referenceType: input.referenceType, referenceId: input.referenceId,
      reason, accountId: input.accountId, branchId: input.branchId, amountUnits: input.amountUnits, expiresAt: input.expiresAt,
    }, { actor, now });
    return valueResult(result, 201);
  }
  if (input.action === "value.reservation.capture" || input.action === "value.reservation.release") {
    const result = await applyPosValueCommand(tx, {
      type: input.action === "value.reservation.capture" ? "capture" : "release", operationKey: input.idempotencyKey, requestHash,
      referenceType: input.referenceType, referenceId: input.referenceId, reason, reservationId: input.reservationId, branchId: input.branchId,
    }, { actor, now });
    return valueResult(result, 200);
  }
  if (input.action !== "value.entry.reverse") throw new PosValueAdminError("Ação de valor não suportada.");
  const result = await applyPosValueCommand(tx, {
    type: "reverse", operationKey: input.idempotencyKey, requestHash, referenceType, referenceId, reason,
    entryId: input.entryId, branchId: input.branchId,
  }, { actor, now });
  return valueResult(result, 200);
}

function valueResult(result: Awaited<ReturnType<typeof applyPosValueCommand>>, status: number): MutationResult {
  return {
    entityType: "pos_value_account", entityId: result.account.id, status,
    beforeData: { balanceUnits: result.entry.balanceBeforeUnits, reservedUnits: result.entry.reservedBeforeUnits },
    body: { account: result.account, entry: result.entry, reservation: result.reservation },
  };
}

function accountAdminDto(value: Prisma.PosValueAccountGetPayload<{ include: { customer: { select: { id: true; name: true } }; program: { select: { id: true; name: true; kind: true; status: true } }; entries: { include: { reversedBy: { select: { id: true } } } }; reservations: true } }>) {
  return {
    ...posValueAccountDto(value), customer: value.customer, program: value.program,
    entries: value.entries.map(entry => ({ ...posValueEntryDto(entry), reversed: entry.reversedBy.length > 0 })),
    reservations: value.reservations.map(posValueReservationDto),
  };
}

function programDto(value: { id: string; branchId: number; name: string; kind: string; status: string; earnUnits: number; spendCents: number; redeemCentsPerUnit: number; expiresAfterDays: number | null; createdAt: Date; updatedAt: Date }) {
  return { id: value.id, branchId: value.branchId, name: value.name, kind: value.kind, status: value.status, earnUnits: value.earnUnits, spendCents: value.spendCents, redeemCentsPerUnit: value.redeemCentsPerUnit, expiresAfterDays: value.expiresAfterDays, createdAt: value.createdAt, updatedAt: value.updatedAt };
}

async function activeBranchId(db: Db, actorId: string, fallback: number) { const profile = await db.tenantUserProfile.findUnique({ where: { userId: actorId }, select: { activeBranchId: true } }); return profile?.activeBranchId || fallback; }
async function assertActiveBranch(tx: Tx, branchId: number) { if (!await tx.branch.findFirst({ where: { id: branchId, status: "active" }, select: { id: true } })) throw new PosValueAdminError("Filial ativa não encontrada.", 404); }
function positiveId(value: unknown, label: string) { const result = Number(value); if (!Number.isSafeInteger(result) || result <= 0) throw new PosValueAdminError(`${label} inválida.`); return result; }
function replay(record: { actorId: string; action: string; requestHash: string; state: string; responseStatus: number | null; responseBody: Prisma.JsonValue | null }, actorId: string, action: string, requestHash: string) {
  if (record.actorId !== actorId || record.action !== action || record.requestHash !== requestHash) throw new PosValueAdminError("A chave de idempotência já foi usada com outro contexto ou payload.", 409);
  if (record.state !== "completed" || record.responseStatus == null || !record.responseBody || typeof record.responseBody !== "object" || Array.isArray(record.responseBody)) throw new PosValueAdminError("A operação com esta chave ainda está em processamento.", 409);
  return Response.json({ ...(record.responseBody as Record<string, unknown>), replayed: true, secretAvailable: false }, { status: record.responseStatus, headers: { ...noStoreHeaders(), "idempotency-replayed": "true" } });
}
function jsonObject(value: object) { return JSON.parse(JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item)) as Prisma.InputJsonObject; }
function prismaCode(error: unknown) { return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code || "") : ""; }
function noStoreHeaders() { return { "cache-control": "no-store", pragma: "no-cache" }; }
function failure(error: unknown) {
  if (error instanceof PosValueAdminError || error instanceof PosValueError || error instanceof PosValueSecretError || error instanceof PosHttpError) return Response.json({ error: error.message }, { status: error.status, headers: noStoreHeaders() });
  if (error instanceof CustomerInputError) return Response.json({ error: error.message }, { status: error.message.includes("Origem") ? 403 : 422, headers: noStoreHeaders() });
  if (error instanceof LicenseDeniedError) return Response.json({ error: error.message }, { status: error.status, headers: noStoreHeaders() });
  if (error instanceof AuthError) return authErrorResponse(error);
  if (prismaCode(error) === "P2002") return Response.json({ error: "Conta, código, referência ou operação já cadastrada." }, { status: 409, headers: noStoreHeaders() });
  if (prismaCode(error) === "P2034") return Response.json({ error: "Conflito concorrente no saldo. Repita com a mesma chave." }, { status: 409, headers: noStoreHeaders() });
  console.error("POS value account administration failed", { error: error instanceof Error ? error.name : typeof error });
  return Response.json({ error: "Não foi possível concluir a gestão de fidelidade e valores." }, { status: 500, headers: noStoreHeaders() });
}
