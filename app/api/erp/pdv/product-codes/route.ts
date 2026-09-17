import { randomUUID } from "node:crypto";
import { Prisma } from "@/generated/tenant/client";
import { currentOrganization, tenantDb } from "@/db";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import { assertSameOrigin, CustomerInputError } from "@/lib/erp/customer-input";
import { assertPosMutationRequest, enforcePosRateLimit, PosHttpError, readPosJson } from "@/lib/erp/pos-http";
import {
  applyPosProductCodeAdminMutation,
  hashPosProductCodeAdminInput,
  parsePosProductCodeAdminInput,
  posProductCodeDto,
  posVariableCodeRuleDto,
  PosProductCodeAdminError,
  type PosProductCodeAdminInput,
} from "@/lib/erp/pos-product-code-admin";
import { PosDomainError } from "@/lib/erp/pos-domain";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { assertTenantWriteAccess } from "@/lib/tenant-access";

type Access = Awaited<ReturnType<typeof adminAccess>>;

export async function GET(request: Request) {
  try {
    assertSameOrigin(request);
    const access = await adminAccess();
    const branchId = positiveId(new URL(request.url).searchParams.get("branchId"), "Filial");
    if (!await access.db.branch.findFirst({ where: { id: branchId, status: "active" }, select: { id: true } })) throw new PosProductCodeAdminError("Filial ativa não encontrada.", 404);
    const [products, codes, rules] = await Promise.all([
      access.db.product.findMany({
        where: { active: true, branchConfigurations: { some: { branchId, active: true, saleEnabled: true } } },
        select: { id: true, name: true, sku: true, unit: true, variations: { where: { enabled: true }, select: { id: true, sku: true, gtin: true, attributes: true }, orderBy: { id: "asc" } } },
        orderBy: { name: "asc" }, take: 1_000,
      }),
      access.db.posProductCode.findMany({
        where: { scopeKey: { in: ["global", `branch:${branchId}`] } },
        include: { product: { select: { name: true, sku: true, unit: true } }, variation: { select: { sku: true, attributes: true } } },
        orderBy: [{ active: "desc" }, { priority: "desc" }, { id: "desc" }], take: 2_000,
      }),
      access.db.posVariableCodeRule.findMany({ where: { branchId }, orderBy: [{ status: "asc" }, { priority: "desc" }, { name: "asc" }], take: 200 }),
    ]);
    return Response.json({
      branchId,
      products,
      codes: codes.map(code => ({ ...posProductCodeDto(code), product: code.product, variation: code.variation })),
      rules: rules.map(posVariableCodeRuleDto),
    }, { headers: noStoreHeaders() });
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
    const input = parsePosProductCodeAdminInput(await readPosJson(request, 32_768));
    await enforcePosRateLimit(access.db, access.actor.user.id, `admin:${input.action}`);
    return executeIdempotent(access, input);
  } catch (error) {
    return failure(error);
  }
}

async function adminAccess() {
  const organization = await currentOrganization();
  const actor = await assertTenantPermission(organization.id, "pdv.write");
  if (!["owner", "admin"].includes(actor.membership.role)) throw new PosProductCodeAdminError("Somente proprietários e administradores podem gerir códigos do PDV.", 403);
  return { organizationId: organization.id, actor, db: await tenantDb(organization.id) };
}

async function executeIdempotent(access: Access, input: PosProductCodeAdminInput) {
  const requestHash = hashPosProductCodeAdminInput(input);
  const existing = await access.db.pdvAdminMutation.findUnique({ where: { key: input.idempotencyKey } });
  if (existing) return replay(existing, access.actor.user.id, input.action, requestHash);
  const correlationId = randomUUID();
  try {
    const completed = await access.db.$transaction(async tx => {
      await tx.pdvAdminMutation.create({ data: { key: input.idempotencyKey, actorId: access.actor.user.id, action: input.action, requestHash, expiresAt: new Date(Date.now() + 30 * 86_400_000) } });
      const result = await applyPosProductCodeAdminMutation(tx, input);
      const responseBody = jsonObject({ ...result.body, correlationId, replayed: false });
      await tx.tenantAuditEvent.create({ data: {
        actorId: access.actor.user.id,
        action: `pos.admin.${input.action}`,
        entityType: result.entityType,
        entityId: result.entityId,
        correlationId,
        beforeData: result.before ? jsonObject(result.before) : undefined,
        afterData: jsonObject({ ...result.body, branchId: input.branchId, idempotencyKey: input.idempotencyKey, requestHash }),
      } });
      await tx.pdvAdminMutation.update({ where: { key: input.idempotencyKey }, data: { state: "completed", entityType: result.entityType, entityId: result.entityId, responseStatus: result.status, responseBody } });
      return { status: result.status, body: responseBody };
    }, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 });
    return Response.json(completed.body, { status: completed.status, headers: noStoreHeaders() });
  } catch (error) {
    if (new Set(["P2002", "P2034"]).has(prismaCode(error))) {
      const concurrent = await access.db.pdvAdminMutation.findUnique({ where: { key: input.idempotencyKey } });
      if (concurrent) return replay(concurrent, access.actor.user.id, input.action, requestHash);
    }
    throw error;
  }
}

function replay(record: { actorId: string; action: string; requestHash: string; state: string; responseStatus: number | null; responseBody: Prisma.JsonValue | null }, actorId: string, action: string, requestHash: string) {
  if (record.actorId !== actorId || record.action !== action || record.requestHash !== requestHash) throw new PosProductCodeAdminError("A chave idempotente já foi usada com outro ator, ação ou payload.", 409);
  if (record.state !== "completed" || record.responseStatus == null || !record.responseBody || typeof record.responseBody !== "object" || Array.isArray(record.responseBody)) throw new PosProductCodeAdminError("A operação com esta chave ainda está em processamento.", 409);
  return Response.json({ ...(record.responseBody as Record<string, unknown>), replayed: true }, { status: record.responseStatus, headers: { ...noStoreHeaders(), "idempotency-replayed": "true" } });
}

function positiveId(value: unknown, label: string) { const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new PosProductCodeAdminError(`${label} inválida.`); return parsed; }
function jsonObject(value: object) { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject; }
function prismaCode(error: unknown) { return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code || "") : ""; }
function noStoreHeaders() { return { "cache-control": "no-store", pragma: "no-cache" }; }
function failure(error: unknown) {
  if (error instanceof PosProductCodeAdminError || error instanceof PosDomainError || error instanceof PosHttpError) return Response.json({ error: error.message }, { status: error instanceof PosProductCodeAdminError || error instanceof PosHttpError ? error.status : 422, headers: noStoreHeaders() });
  if (error instanceof CustomerInputError) return Response.json({ error: error.message }, { status: error.message.includes("Origem") ? 403 : 422, headers: noStoreHeaders() });
  if (error instanceof LicenseDeniedError) return Response.json({ error: error.message }, { status: error.status, headers: noStoreHeaders() });
  if (error instanceof AuthError) return authErrorResponse(error);
  if (prismaCode(error) === "P2002") return Response.json({ error: "Código, nome de regra ou chave idempotente já cadastrado neste escopo." }, { status: 409, headers: noStoreHeaders() });
  if (prismaCode(error) === "P2034") return Response.json({ error: "Cadastro alterado concorrentemente. Repita com a mesma chave." }, { status: 409, headers: noStoreHeaders() });
  console.error("POS product code administration failed", { error: error instanceof Error ? error.name : typeof error });
  return Response.json({ error: "Não foi possível concluir a gestão de códigos do PDV." }, { status: 500, headers: noStoreHeaders() });
}
