import { randomUUID } from "node:crypto";
import type { Prisma } from "@/generated/tenant/client";
import { currentOrganization, tenantDb } from "@/db";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import { assertSameOrigin, CustomerInputError } from "@/lib/erp/customer-input";
import {
  couponCodeMetadata,
  hashPosPromotionAdminInput,
  parsePosPromotionAdminInput,
  PosPromotionAdminError,
  type PosPromotionAdminInput,
} from "@/lib/erp/pos-promotion-admin";
import { buildPosPromotionRule, PosPromotionDomainError } from "@/lib/erp/pos-promotions";
import { assertPosMutationRequest, enforcePosRateLimit, PosHttpError, readPosJson } from "@/lib/erp/pos-http";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { assertTenantWriteAccess } from "@/lib/tenant-access";

type Db = Awaited<ReturnType<typeof tenantDb>>;
type Tx = Prisma.TransactionClient;
type AdminAccess = Awaited<ReturnType<typeof adminAccess>>;
type MutationResult = { entityType: string; entityId: string; status: number; body: Record<string, unknown>; beforeData?: Record<string, unknown> };

const promotionInclude = {
  branch: { select: { id: true, code: true, name: true, status: true } },
  coupons: { orderBy: { createdAt: "desc" as const } },
  _count: { select: { redemptions: { where: { reversedAt: null } } } },
} satisfies Prisma.PosPromotionInclude;

export async function GET(request: Request) {
  try {
    assertSameOrigin(request);
    const access = await adminAccess();
    const branches = await access.db.branch.findMany({ where: { status: "active" }, select: { id: true, code: true, name: true, status: true }, orderBy: [{ primary: "desc" }, { name: "asc" }] });
    if (!branches.length) throw new PosPromotionAdminError("Cadastre uma filial ativa antes de configurar promoções.", 409);
    const requested = new URL(request.url).searchParams.get("branchId");
    const branchId = requested ? positiveId(requested, "Filial") : await activeBranchId(access.db, access.actor.user.id, branches[0].id);
    if (!branches.some((branch) => branch.id === branchId)) throw new PosPromotionAdminError("Filial ativa não encontrada.", 404);
    const promotions = await access.db.posPromotion.findMany({
      where: { OR: [{ branchId }, { branchId: null }] },
      include: promotionInclude,
      orderBy: [{ status: "asc" }, { priority: "desc" }, { startsAt: "desc" }, { name: "asc" }],
    });
    return Response.json({ branchId, branches, promotions: promotions.map(promotionDto) }, { headers: noStoreHeaders() });
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
    const input = parsePosPromotionAdminInput(await readPosJson(request, 32_768));
    await enforcePosRateLimit(access.db, access.actor.user.id, `admin:${input.action}`);
    return executeIdempotent(access, input);
  } catch (error) {
    return failure(error);
  }
}

async function adminAccess() {
  const organization = await currentOrganization();
  const actor = await assertTenantPermission(organization.id, "pdv.write");
  if (!["owner", "admin"].includes(actor.membership.role)) throw new PosPromotionAdminError("Somente proprietários e administradores podem gerir promoções e cupons.", 403);
  return { organizationId: organization.id, actor, db: await tenantDb(organization.id) };
}

async function executeIdempotent(access: AdminAccess, input: PosPromotionAdminInput) {
  const requestHash = hashPosPromotionAdminInput(input);
  const existing = await access.db.pdvAdminMutation.findUnique({ where: { key: input.idempotencyKey } });
  if (existing) return replay(existing, access.actor.user.id, input.action, requestHash);
  const correlationId = randomUUID();
  try {
    const completed = await access.db.$transaction(async tx => {
      await tx.pdvAdminMutation.create({ data: { key: input.idempotencyKey, actorId: access.actor.user.id, action: input.action, requestHash, expiresAt: new Date(Date.now() + 30 * 86_400_000) } });
      const result = await mutate(tx, input);
      // This is deliberately the only body persisted for replay: coupon plaintext is never included.
      const responseBody = jsonObject({ ...result.body, correlationId, replayed: false, secretAvailable: false });
      await tx.tenantAuditEvent.create({ data: {
        actorId: access.actor.user.id,
        action: `pos.admin.${input.action}`,
        entityType: result.entityType,
        entityId: result.entityId,
        correlationId,
        beforeData: result.beforeData ? jsonObject(result.beforeData) : undefined,
        afterData: jsonObject({ ...result.body, idempotencyKey: input.idempotencyKey, requestHash }),
      } });
      await tx.pdvAdminMutation.update({ where: { key: input.idempotencyKey }, data: { state: "completed", entityType: result.entityType, entityId: result.entityId, responseStatus: result.status, responseBody } });
      return { status: result.status, body: responseBody };
    }, { isolationLevel: "Serializable" });
    const couponCode = input.action === "coupon.create" || input.action === "coupon.rotate" ? input.code : null;
    return Response.json({ ...completed.body, ...(couponCode ? { couponCode, secretAvailable: true } : {}) }, { status: completed.status, headers: noStoreHeaders() });
  } catch (error) {
    if (["P2002", "P2034"].includes(prismaCode(error))) {
      const concurrent = await access.db.pdvAdminMutation.findUnique({ where: { key: input.idempotencyKey } });
      if (concurrent) return replay(concurrent, access.actor.user.id, input.action, requestHash);
    }
    throw error;
  }
}

function replay(record: { actorId: string; action: string; requestHash: string; state: string; responseStatus: number | null; responseBody: Prisma.JsonValue | null }, actorId: string, action: string, requestHash: string) {
  if (record.actorId !== actorId || record.action !== action || record.requestHash !== requestHash) throw new PosPromotionAdminError("A chave de idempotência já foi usada com outro contexto ou payload.", 409);
  if (record.state !== "completed" || record.responseStatus == null || !record.responseBody || typeof record.responseBody !== "object" || Array.isArray(record.responseBody)) throw new PosPromotionAdminError("A operação com esta chave ainda está em processamento.", 409);
  return Response.json({ ...(record.responseBody as Record<string, unknown>), replayed: true, secretAvailable: false }, { status: record.responseStatus, headers: { ...noStoreHeaders(), "idempotency-replayed": "true" } });
}

async function mutate(tx: Tx, input: PosPromotionAdminInput): Promise<MutationResult> {
  if (input.action === "promotion.create") {
    await validatePromotionReferences(tx, input.branchId, input.conditions);
    const created = await tx.posPromotion.create({ data: {
      branchId: input.branchId, name: input.name, description: input.description, priority: input.priority, status: input.status, stackMode: "exclusive",
      conditions: jsonObject(input.conditions), effects: jsonObject(input.effect), startsAt: input.startsAt, endsAt: input.endsAt,
      usageLimit: input.usageLimit, perCustomerLimit: input.perCustomerLimit,
    }, include: promotionInclude });
    return { entityType: "pos_promotion", entityId: created.id, status: 201, body: { promotion: promotionDto(created) } };
  }
  if (input.action === "promotion.update") {
    const before = await lockedPromotion(tx, input.promotionId);
    const rule = buildPosPromotionRule({
      id: before.id,
      name: input.name ?? before.name,
      priority: input.priority ?? before.priority,
      status: input.status ?? before.status,
      stackMode: before.stackMode,
      branchId: "branchId" in input ? input.branchId ?? null : before.branchId,
      conditions: input.conditions ?? before.conditions,
      effects: input.effect ?? before.effects,
      startsAt: input.startsAt ?? before.startsAt,
      endsAt: "endsAt" in input ? input.endsAt ?? null : before.endsAt,
      usageLimit: "usageLimit" in input ? input.usageLimit ?? null : before.usageLimit,
      perCustomerLimit: "perCustomerLimit" in input ? input.perCustomerLimit ?? null : before.perCustomerLimit,
    });
    await validatePromotionReferences(tx, rule.branchId, rule.conditions);
    if (rule.usageLimit != null && rule.usageLimit < before._count.redemptions) throw new PosPromotionAdminError("O limite global não pode ser menor que o total já resgatado.", 409);
    const updated = await tx.posPromotion.update({ where: { id: before.id }, data: {
      ...defined(input, ["name", "description", "priority", "status", "startsAt", "endsAt", "usageLimit", "perCustomerLimit", "branchId"]),
      ...(input.conditions ? { conditions: jsonObject(rule.conditions) } : {}),
      ...(input.effect ? { effects: jsonObject(rule.effect) } : {}),
    }, include: promotionInclude });
    return { entityType: "pos_promotion", entityId: updated.id, status: 200, beforeData: { promotion: promotionDto(before) }, body: { promotion: promotionDto(updated) } };
  }
  if (input.action === "promotion.deactivate") {
    const before = await lockedPromotion(tx, input.promotionId);
    const updated = await tx.posPromotion.update({ where: { id: before.id }, data: { status: "inactive" }, include: promotionInclude });
    return { entityType: "pos_promotion", entityId: updated.id, status: 200, beforeData: { promotion: promotionDto(before) }, body: { promotion: promotionDto(updated) } };
  }
  if (input.action === "coupon.create") {
    const promotion = await lockedPromotion(tx, input.promotionId);
    const metadata = couponCodeMetadata(input.code);
    const created = await tx.posCoupon.create({ data: { promotionId: promotion.id, ...metadata, status: input.status, usageLimit: input.usageLimit, expiresAt: input.expiresAt } });
    return { entityType: "pos_coupon", entityId: created.id, status: 201, body: { coupon: couponDto(created), promotionId: promotion.id } };
  }
  if (input.action === "coupon.update") {
    const before = await lockedCoupon(tx, input.couponId);
    if (input.usageLimit != null && input.usageLimit < before.usedCount) throw new PosPromotionAdminError("O limite do cupom não pode ser menor que o total já utilizado.", 409);
    const updated = await tx.posCoupon.update({ where: { id: before.id }, data: defined(input, ["status", "usageLimit", "expiresAt"]) });
    return { entityType: "pos_coupon", entityId: updated.id, status: 200, beforeData: { coupon: couponDto(before) }, body: { coupon: couponDto(updated) } };
  }
  if (input.action === "coupon.rotate") {
    const before = await lockedCoupon(tx, input.couponId);
    const metadata = couponCodeMetadata(input.code);
    if (metadata.codeHash === before.codeHash) throw new PosPromotionAdminError("Informe um novo código para rotacionar o cupom.", 409);
    const updated = await tx.posCoupon.update({ where: { id: before.id }, data: metadata });
    return { entityType: "pos_coupon", entityId: updated.id, status: 200, beforeData: { coupon: couponDto(before) }, body: { coupon: couponDto(updated) } };
  }
  const before = await lockedCoupon(tx, input.couponId);
  const updated = await tx.posCoupon.update({ where: { id: before.id }, data: { status: "inactive" } });
  return { entityType: "pos_coupon", entityId: updated.id, status: 200, beforeData: { coupon: couponDto(before) }, body: { coupon: couponDto(updated) } };
}

async function lockedPromotion(tx: Tx, id: string) {
  await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "pos_promotions" WHERE "id" = ${id} FOR UPDATE`;
  const value = await tx.posPromotion.findUnique({ where: { id }, include: promotionInclude });
  if (!value) throw new PosPromotionAdminError("Promoção não encontrada.", 404);
  return value;
}

async function lockedCoupon(tx: Tx, id: string) {
  await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "pos_coupons" WHERE "id" = ${id} FOR UPDATE`;
  const value = await tx.posCoupon.findUnique({ where: { id } });
  if (!value) throw new PosPromotionAdminError("Cupom não encontrado.", 404);
  return value;
}

async function validatePromotionReferences(tx: Tx, branchId: number | null, conditions: { productIds?: readonly number[]; categoryIds?: readonly number[] }) {
  if (branchId != null && !await tx.branch.findFirst({ where: { id: branchId, status: "active" }, select: { id: true } })) throw new PosPromotionAdminError("A filial da promoção deve existir e estar ativa.");
  if (conditions.productIds?.length) {
    const count = await tx.product.count({ where: { id: { in: [...conditions.productIds] }, active: true } });
    if (count !== conditions.productIds.length) throw new PosPromotionAdminError("Todos os produtos da promoção devem existir e estar ativos.");
  }
  if (conditions.categoryIds?.length) {
    const count = await tx.category.count({ where: { id: { in: [...conditions.categoryIds] }, active: true } });
    if (count !== conditions.categoryIds.length) throw new PosPromotionAdminError("Todas as categorias da promoção devem existir e estar ativas.");
  }
}

async function activeBranchId(db: Db, actorId: string, fallback: number) {
  const profile = await db.tenantUserProfile.findUnique({ where: { userId: actorId }, select: { activeBranchId: true } });
  return profile?.activeBranchId ?? fallback;
}

function promotionDto(value: Record<string, unknown>) {
  return {
    id: value.id, branchId: value.branchId, branch: value.branch, name: value.name, description: value.description, priority: value.priority,
    status: value.status, stackMode: value.stackMode, conditions: value.conditions, effect: value.effects, startsAt: value.startsAt, endsAt: value.endsAt,
    usageLimit: value.usageLimit, perCustomerLimit: value.perCustomerLimit, redemptionCount: (value._count as { redemptions?: number } | undefined)?.redemptions ?? 0,
    coupons: Array.isArray(value.coupons) ? value.coupons.map((coupon) => couponDto(coupon as Record<string, unknown>)) : undefined,
    createdAt: value.createdAt, updatedAt: value.updatedAt,
  };
}

function couponDto(value: Record<string, unknown>) {
  return { id: value.id, promotionId: value.promotionId, codeLastFour: value.codeLastFour, status: value.status, usageLimit: value.usageLimit, usedCount: value.usedCount, expiresAt: value.expiresAt, createdAt: value.createdAt };
}

function positiveId(value: unknown, label: string) { const result = Number(value); if (!Number.isSafeInteger(result) || result <= 0) throw new PosPromotionAdminError(`${label} inválida.`); return result; }
function defined(input: object, fields: readonly string[]) { const value = input as Record<string, unknown>; return Object.fromEntries(fields.filter((field) => Object.prototype.hasOwnProperty.call(value, field)).map((field) => [field, value[field]])); }
function jsonObject(value: object) { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject; }
function prismaCode(error: unknown) { return error && typeof error === "object" && "code" in error ? String(error.code) : ""; }
function noStoreHeaders() { return { "cache-control": "no-store", pragma: "no-cache" }; }

function failure(error: unknown) {
  if (error instanceof PosHttpError || error instanceof PosPromotionAdminError) return Response.json({ error: error.message }, { status: error.status, headers: noStoreHeaders() });
  if (error instanceof PosPromotionDomainError) return Response.json({ error: error.message }, { status: 422, headers: noStoreHeaders() });
  if (error instanceof CustomerInputError) return Response.json({ error: error.message }, { status: error.message.includes("Origem") ? 403 : 422, headers: noStoreHeaders() });
  if (error instanceof LicenseDeniedError) return Response.json({ error: error.message }, { status: error.status, headers: noStoreHeaders() });
  if (error instanceof AuthError) return authErrorResponse(error);
  if (prismaCode(error) === "P2002") return Response.json({ error: "O código de cupom já está em uso." }, { status: 409, headers: noStoreHeaders() });
  if (prismaCode(error) === "P2034") return Response.json({ error: "Conflito concorrente ao salvar a promoção; tente novamente." }, { status: 409, headers: noStoreHeaders() });
  console.error("POS promotion administration failed", { error: error instanceof Error ? error.name : typeof error });
  return Response.json({ error: "Não foi possível concluir a gestão da promoção." }, { status: 500, headers: noStoreHeaders() });
}
