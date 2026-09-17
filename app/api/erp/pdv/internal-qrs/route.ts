import { randomUUID } from "node:crypto";
import { Prisma } from "@/generated/tenant/client";
import { currentOrganization, tenantDb } from "@/db";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import { assertSameOrigin, CustomerInputError } from "@/lib/erp/customer-input";
import { hashPosInternalQrMutation, parsePosInternalQrAdminInput, type PosInternalQrIssueInput, type PosInternalQrRevokeInput } from "@/lib/erp/pos-internal-qr-admin";
import { hashPosInternalQr, issuePosInternalQr, loadPosInternalQrKeyring, PosInternalQrError, verifyPosInternalQr } from "@/lib/erp/pos-internal-qr";
import { assertPosMutationRequest, enforcePosRateLimit, PosHttpError, readPosJson } from "@/lib/erp/pos-http";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { assertTenantWriteAccess } from "@/lib/tenant-access";
import { publicPosCustomer } from "@/lib/erp/pos-customer-privacy";

type Db = Awaited<ReturnType<typeof tenantDb>>;
type Tx = Prisma.TransactionClient;
type BaseAccess = Awaited<ReturnType<typeof baseAccess>>;

class PosInternalQrRouteError extends Error {
  constructor(message: string, readonly status = 422) {
    super(message);
  }
}

export async function GET(request: Request) {
  try {
    assertSameOrigin(request);
    const access = await adminAccess("pdv.read");
    const url = new URL(request.url);
    const branches = await access.db.branch.findMany({ where: { status: "active" }, select: { id: true, code: true, name: true }, orderBy: [{ primary: "desc" }, { name: "asc" }] });
    if (!branches.length) throw new PosInternalQrRouteError("Cadastre uma filial ativa antes de gerir QR internos.", 409);
    const branchId = url.searchParams.get("branchId") ? positiveId(url.searchParams.get("branchId"), "Filial") : await activeBranchId(access.db, access.actor.user.id, branches[0].id);
    if (!branches.some(branch => branch.id === branchId)) throw new PosInternalQrRouteError("Filial ativa não encontrada.", 404);
    const now = new Date();
    const [issuances, customers, heldCarts, coupons, giftCards, orders, receipts] = await Promise.all([
      access.db.posInternalQrIssuance.findMany({ where: { branchId }, orderBy: { createdAt: "desc" }, take: 250 }),
      access.db.customer.findMany({ where: { status: "active" }, select: { id: true, name: true }, orderBy: { name: "asc" }, take: 250 }),
      access.db.posHeldSale.findMany({ where: { status: "held", register: { branchId } }, select: { id: true, label: true, updatedAt: true }, orderBy: { updatedAt: "desc" }, take: 100 }),
      access.db.posCoupon.findMany({ where: { status: "active", AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }], promotion: { status: "active", startsAt: { lte: now }, AND: [{ OR: [{ branchId: null }, { branchId }] }, { OR: [{ endsAt: null }, { endsAt: { gt: now } }] }] } }, select: { id: true, codeLastFour: true, promotion: { select: { name: true } } }, orderBy: { createdAt: "desc" }, take: 100 }),
      access.db.posValueAccount.findMany({ where: { branchId, kind: "gift_card", status: "active", AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }] }, select: { id: true, label: true, codeLastFour: true }, orderBy: { updatedAt: "desc" }, take: 100 }),
      access.db.salesOrder.findMany({ where: { branchId, kind: "order", status: "approved", deletedAt: null }, select: { id: true, number: true, customerName: true, status: true }, orderBy: { updatedAt: "desc" }, take: 100 }),
      access.db.sale.findMany({ where: { branchId }, select: { id: true, saleNumber: true, customer: true, status: true }, orderBy: { createdAt: "desc" }, take: 100 }),
    ]);
    return Response.json({
      branchId,
      branches,
      issuances: issuances.map(qrDto),
      targets: {
        customer: customers.map(item => ({ id: String(item.id), label: item.name })),
        held_cart: heldCarts.map(item => ({ id: item.id, label: item.label || `Carrinho ${item.id.slice(-8)}` })),
        coupon: coupons.map(item => ({ id: item.id, label: `${item.promotion.name} · •••• ${item.codeLastFour}` })),
        gift_card: giftCards.map(item => ({ id: item.id, label: `${item.label}${item.codeLastFour ? ` · •••• ${item.codeLastFour}` : ""}` })),
        order: orders.map(item => ({ id: String(item.id), label: `${item.number} · ${item.customerName} · ${item.status}` })),
        receipt: receipts.map(item => ({ id: String(item.id), label: `${item.saleNumber} · ${item.customer} · ${item.status}` })),
      },
    }, { headers: noStoreHeaders() });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    assertPosMutationRequest(request);
    const access = await baseAccess("pdv.write");
    const input = parsePosInternalQrAdminInput(await readPosJson(request, 8_192));
    await enforcePosRateLimit(access.db, access.actor.user.id, input.action);
    if (input.action === "qr.resolve") return resolveQr(access, input.sessionId, input.token);
    assertAdministrator(access);
    await assertTenantWriteAccess(access.organizationId);
    return input.action === "qr.issue" ? issueQr(access, input) : revokeQr(access, input);
  } catch (error) {
    return failure(error);
  }
}

async function baseAccess(permission: "pdv.read" | "pdv.write") {
  const organization = await currentOrganization();
  const actor = await assertTenantPermission(organization.id, permission);
  return { organizationId: organization.id, actor, db: await tenantDb(organization.id) };
}

async function adminAccess(permission: "pdv.read" | "pdv.write") {
  const access = await baseAccess(permission);
  assertAdministrator(access);
  return access;
}

function assertAdministrator(access: BaseAccess) {
  if (!["owner", "admin"].includes(access.actor.membership.role)) throw new PosInternalQrRouteError("Somente proprietários e administradores podem emitir ou revogar QR internos.", 403);
}

async function issueQr(access: BaseAccess, input: PosInternalQrIssueInput) {
  const requestHash = hashPosInternalQrMutation(input, { organizationId: access.organizationId, actorId: access.actor.user.id });
  const replayed = await access.db.posInternalQrIssuance.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (replayed) return replayIssue(replayed, access.actor.user.id, requestHash);
  const keyring = loadPosInternalQrKeyring();
  const now = new Date();
  const issued = issuePosInternalQr({ organizationId: access.organizationId, branchId: input.branchId, kind: input.kind, reference: input.reference, expiresAt: input.expiresAt, now }, keyring.active);
  const correlationId = randomUUID();
  try {
    const record = await access.db.$transaction(async tx => {
      await assertActiveBranch(tx, input.branchId);
      await resolveTarget(tx, input.kind, input.entityId, input.branchId);
      const created = await tx.posInternalQrIssuance.create({ data: {
        branchId: input.branchId,
        kind: input.kind,
        reference: input.reference,
        keyId: keyring.active.id,
        nonce: issued.payload.nonce,
        tokenHash: hashPosInternalQr(issued.token),
        issuedBy: access.actor.user.id,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        expiresAt: input.expiresAt,
      } });
      await tx.tenantAuditEvent.create({ data: {
        actorId: access.actor.user.id,
        action: "pos.internal_qr.issued",
        entityType: "pos_internal_qr_issuance",
        entityId: created.id,
        correlationId,
        afterData: jsonObject({ branchId: created.branchId, kind: created.kind, reference: created.reference, keyId: created.keyId, nonce: created.nonce, expiresAt: created.expiresAt.toISOString(), tokenHash: created.tokenHash, idempotencyKey: created.idempotencyKey, requestHash }),
      } });
      return created;
    }, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 });
    return Response.json({ qr: qrDto(record), token: issued.token, correlationId, replayed: false, secretAvailable: true }, { status: 201, headers: noStoreHeaders() });
  } catch (error) {
    if (["P2002", "P2034"].includes(prismaCode(error))) {
      const concurrent = await access.db.posInternalQrIssuance.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (concurrent) return replayIssue(concurrent, access.actor.user.id, requestHash);
    }
    throw error;
  }
}

function replayIssue(record: Prisma.PosInternalQrIssuanceGetPayload<Record<string, never>>, actorId: string, requestHash: string) {
  if (record.issuedBy !== actorId || record.requestHash !== requestHash) throw new PosInternalQrRouteError("A chave de idempotência já foi usada em outro contexto ou payload.", 409);
  return Response.json({ qr: qrDto(record), replayed: true, secretAvailable: false }, { status: 200, headers: { ...noStoreHeaders(), "idempotency-replayed": "true" } });
}

async function revokeQr(access: BaseAccess, input: PosInternalQrRevokeInput) {
  const requestHash = hashPosInternalQrMutation(input, { organizationId: access.organizationId, actorId: access.actor.user.id });
  const replayed = await access.db.posInternalQrIssuance.findUnique({ where: { revokeIdempotencyKey: input.idempotencyKey } });
  if (replayed) return replayRevoke(replayed, input.qrId, access.actor.user.id, requestHash);
  const correlationId = randomUUID();
  try {
    const record = await access.db.$transaction(async tx => {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "pos_internal_qr_issuances" WHERE "id" = ${input.qrId} FOR UPDATE`);
      const current = await tx.posInternalQrIssuance.findUnique({ where: { id: input.qrId } });
      if (!current) throw new PosInternalQrRouteError("QR interno não encontrado.", 404);
      if (current.status === "revoked") throw new PosInternalQrRouteError("QR interno já foi revogado com outra operação.", 409);
      const now = new Date();
      const changed = await tx.posInternalQrIssuance.updateMany({ where: { id: current.id, status: current.status, revokedAt: null }, data: { status: "revoked", revokedAt: now, revokedBy: access.actor.user.id, revokeReason: input.reason, revokeIdempotencyKey: input.idempotencyKey, revokeRequestHash: requestHash } });
      if (changed.count !== 1) throw new PosInternalQrRouteError("O QR interno mudou durante a revogação.", 409);
      const saved = await tx.posInternalQrIssuance.findUniqueOrThrow({ where: { id: current.id } });
      await tx.tenantAuditEvent.create({ data: {
        actorId: access.actor.user.id,
        action: "pos.internal_qr.revoked",
        entityType: "pos_internal_qr_issuance",
        entityId: current.id,
        correlationId,
        beforeData: jsonObject({ status: current.status, expiresAt: current.expiresAt.toISOString() }),
        afterData: jsonObject({ status: saved.status, revokedAt: saved.revokedAt?.toISOString(), revokedBy: saved.revokedBy, revokeReason: saved.revokeReason, revokeIdempotencyKey: input.idempotencyKey, requestHash }),
      } });
      return saved;
    }, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 });
    return Response.json({ qr: qrDto(record), correlationId, replayed: false }, { headers: noStoreHeaders() });
  } catch (error) {
    if (["P2002", "P2034"].includes(prismaCode(error))) {
      const concurrent = await access.db.posInternalQrIssuance.findUnique({ where: { revokeIdempotencyKey: input.idempotencyKey } });
      if (concurrent) return replayRevoke(concurrent, input.qrId, access.actor.user.id, requestHash);
    }
    throw error;
  }
}

function replayRevoke(record: Prisma.PosInternalQrIssuanceGetPayload<Record<string, never>>, qrId: string, actorId: string, requestHash: string) {
  if (record.id !== qrId || record.revokedBy !== actorId || record.revokeRequestHash !== requestHash) throw new PosInternalQrRouteError("A chave de idempotência da revogação já foi usada em outro contexto ou payload.", 409);
  return Response.json({ qr: qrDto(record), replayed: true }, { headers: { ...noStoreHeaders(), "idempotency-replayed": "true" } });
}

async function resolveQr(access: BaseAccess, sessionId: number, token: string) {
  const session = await activeOperatorSession(access, sessionId);
  const keyring = loadPosInternalQrKeyring();
  const payload = verifyPosInternalQr(token, { organizationId: access.organizationId, branchId: session.branchId, keys: keyring.keys });
  const record = await access.db.posInternalQrIssuance.findFirst({ where: {
    branchId: session.branchId,
    kind: payload.kind,
    reference: payload.reference,
    keyId: payloadKeyId(token),
    nonce: payload.nonce,
    tokenHash: hashPosInternalQr(token),
    status: "active",
    expiresAt: { gt: new Date() },
  } });
  if (!record) throw new PosInternalQrRouteError("QR interno não está ativo, foi revogado ou não pertence a esta filial.", 410);
  const entityId = payload.reference.slice(payload.reference.indexOf(":") + 1);
  const target = await resolveTarget(access.db, payload.kind, entityId, session.branchId, { sessionId: session.id, operatorProfileId: session.operatorProfileId! });
  return Response.json({ qr: qrDto(record), target }, { headers: noStoreHeaders() });
}

async function activeOperatorSession(access: BaseAccess, sessionId: number) {
  const profile = await access.db.tenantUserProfile.findUnique({ where: { userId: access.actor.user.id }, select: { id: true, status: true } });
  if (!profile || profile.status !== "active") throw new PosInternalQrRouteError("Perfil operacional ativo não configurado.", 403);
  const session = await access.db.cashRegisterSession.findFirst({ where: { id: sessionId, operatorProfileId: profile.id, status: "open", register: { status: "active", branch: { status: "active" } } }, select: { id: true, registerId: true, operatorProfileId: true, register: { select: { branchId: true } } } });
  if (!session?.registerId || !session.register) throw new PosInternalQrRouteError("A leitura de QR interno exige turno aberto do próprio operador.", 403);
  if (!["owner", "admin"].includes(access.actor.membership.role)) {
    const now = new Date();
    const [branchAccess, registerAccess] = await Promise.all([
      access.db.branchUserAccess.findFirst({ where: { branchId: session.register.branchId, userProfileId: profile.id, canSell: true }, select: { id: true } }),
      access.db.posRegisterAccess.findFirst({ where: { registerId: session.registerId, userProfileId: profile.id, active: true, canSell: true, AND: [{ OR: [{ validFrom: null }, { validFrom: { lte: now } }] }, { OR: [{ validUntil: null }, { validUntil: { gte: now } }] }] }, select: { id: true } }),
    ]);
    if (!branchAccess || !registerAccess) throw new PosInternalQrRouteError("Seu acesso de venda neste caixa não está vigente.", 403);
  }
  return { ...session, branchId: session.register.branchId };
}

async function resolveTarget(db: Db | Tx, kind: string, entityId: string, branchId: number, operational?: { sessionId: number; operatorProfileId: number }) {
  if (kind === "customer") {
    const customer = await db.customer.findFirst({ where: { id: positiveId(entityId, "Cliente"), status: "active" }, select: { id: true, name: true, tradeName: true, document: true, phone: true } });
    if (!customer) throw new PosInternalQrRouteError("Cliente do QR não está ativo.", 404);
    return { kind, action: "select_customer", customer: publicPosCustomer(customer) };
  }
  if (kind === "held_cart") {
    const held = await db.posHeldSale.findFirst({ where: { id: entityId, status: "held", register: { branchId }, ...(operational ? { sessionId: operational.sessionId, operatorProfileId: operational.operatorProfileId } : {}) }, include: { items: true, customer: { select: { id: true, name: true } } } });
    if (!held) throw new PosInternalQrRouteError(operational ? "Carrinho suspenso não pertence a este turno do operador." : "Carrinho suspenso não está disponível nesta filial.", 404);
    return { kind, action: "resume_held_cart", held };
  }
  if (kind === "coupon") {
    const now = new Date();
    const coupon = await db.posCoupon.findFirst({ where: { id: entityId, status: "active", AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }], promotion: { status: "active", startsAt: { lte: now }, AND: [{ OR: [{ branchId: null }, { branchId }] }, { OR: [{ endsAt: null }, { endsAt: { gt: now } }] }] } }, select: { id: true, promotionId: true, codeLastFour: true, expiresAt: true } });
    if (!coupon) throw new PosInternalQrRouteError("Cupom do QR está expirado ou indisponível nesta filial.", 404);
    return { kind, action: "apply_coupon_qr", coupon };
  }
  if (kind === "gift_card") {
    const account = await db.posValueAccount.findFirst({ where: { id: entityId, branchId, kind: "gift_card", status: "active", AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }] }, select: { id: true, kind: true, unit: true, label: true, codeLastFour: true, balanceUnits: true, reservedUnits: true, expiresAt: true } });
    if (!account) throw new PosInternalQrRouteError("Vale do QR está expirado ou indisponível nesta filial.", 404);
    return { kind, action: "select_gift_card", account: jsonSafe(account) };
  }
  if (kind === "order") {
    const order = await db.salesOrder.findFirst({ where: { id: positiveId(entityId, "Pedido"), branchId, kind: "order", deletedAt: null }, select: { id: true, number: true, status: true } });
    if (!order) throw new PosInternalQrRouteError("Pedido do QR não foi encontrado nesta filial.", 404);
    return { kind, action: "lookup_order", order };
  }
  const sale = await db.sale.findFirst({ where: { id: positiveId(entityId, "Recibo"), branchId }, select: { id: true, saleNumber: true, customer: true, status: true, totalCents: true, changeCents: true, createdAt: true, payments: { select: { id: true, method: true, status: true, amountCents: true } }, items: { select: { id: true, productName: true, quantity: true, returnedQuantity: true, unitPriceCents: true, discountCents: true, totalCents: true } } } });
  if (!sale) throw new PosInternalQrRouteError("Recibo do QR não foi encontrado nesta filial.", 404);
  return { kind: "receipt", action: "open_receipt", sale };
}

function qrDto(value: Prisma.PosInternalQrIssuanceGetPayload<Record<string, never>>) {
  const effectiveStatus = value.status === "active" && value.expiresAt <= new Date() ? "expired" : value.status;
  return { id: value.id, branchId: value.branchId, kind: value.kind, reference: value.reference, keyId: value.keyId, status: effectiveStatus, expiresAt: value.expiresAt, revokedAt: value.revokedAt, revokeReason: value.revokeReason, createdAt: value.createdAt, updatedAt: value.updatedAt };
}

function payloadKeyId(token: string) {
  const result = token.split(".")[2] || "";
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(result)) throw new PosInternalQrRouteError("Identificador da chave do QR inválido.");
  return result;
}

async function assertActiveBranch(tx: Tx, branchId: number) {
  if (!await tx.branch.findFirst({ where: { id: branchId, status: "active" }, select: { id: true } })) throw new PosInternalQrRouteError("Filial ativa não encontrada.", 404);
}

async function activeBranchId(db: Db, actorId: string, fallback: number) {
  const profile = await db.tenantUserProfile.findUnique({ where: { userId: actorId }, select: { activeBranchId: true } });
  return profile?.activeBranchId || fallback;
}

function positiveId(value: unknown, label: string) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0 || result > 2_147_483_647) throw new PosInternalQrRouteError(`${label} inválido.`);
  return result;
}


function jsonObject(value: object) {
  return JSON.parse(JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item)) as Prisma.InputJsonObject;
}

function jsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item)) as T;
}

function prismaCode(error: unknown) {
  return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code || "") : "";
}

function noStoreHeaders() {
  return { "cache-control": "no-store", pragma: "no-cache" };
}

function withNoStore(response: Response) {
  const headers = new Headers(response.headers);
  Object.entries(noStoreHeaders()).forEach(([key, value]) => headers.set(key, value));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function failure(error: unknown) {
  if (error instanceof PosInternalQrRouteError || error instanceof PosHttpError) return Response.json({ error: error.message }, { status: error.status, headers: noStoreHeaders() });
  if (error instanceof PosInternalQrError) return Response.json({ error: error.message }, { status: error.code === "scope" ? 403 : error.code === "expired" ? 410 : error.code === "key" ? 503 : 422, headers: noStoreHeaders() });
  if (error instanceof CustomerInputError) return Response.json({ error: error.message }, { status: error.message.includes("Origem") ? 403 : 422, headers: noStoreHeaders() });
  if (error instanceof LicenseDeniedError) return Response.json({ error: error.message }, { status: error.status, headers: noStoreHeaders() });
  if (error instanceof AuthError) return withNoStore(authErrorResponse(error));
  if (prismaCode(error) === "P2002") return Response.json({ error: "QR interno ou chave idempotente já cadastrados." }, { status: 409, headers: noStoreHeaders() });
  if (prismaCode(error) === "P2034") return Response.json({ error: "Conflito concorrente no QR interno; repita com a mesma chave." }, { status: 409, headers: noStoreHeaders() });
  console.error("POS internal QR failed", { error: error instanceof Error ? error.name : typeof error });
  return Response.json({ error: "Não foi possível concluir a operação de QR interno." }, { status: 500, headers: noStoreHeaders() });
}
