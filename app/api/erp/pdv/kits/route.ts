import { randomUUID } from "node:crypto";
import { Prisma } from "@/generated/tenant/client";
import { currentOrganization, tenantDb } from "@/db";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import { assertSameOrigin, CustomerInputError } from "@/lib/erp/customer-input";
import { assertPosMutationRequest, enforcePosRateLimit, PosHttpError, readPosJson } from "@/lib/erp/pos-http";
import { applyPosKitAdminMutation, hashPosKitAdminInput, parsePosKitAdminInput, posKitBomDto, PosKitAdminError, type PosKitAdminInput } from "@/lib/erp/pos-kit-admin";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { assertTenantWriteAccess } from "@/lib/tenant-access";

type Access = Awaited<ReturnType<typeof adminAccess>>;

export async function GET(request: Request) {
  try {
    assertSameOrigin(request);
    const access = await adminAccess();
    const branchId = positiveId(new URL(request.url).searchParams.get("branchId"), "Filial");
    if (!await access.db.branch.findFirst({ where: { id: branchId, status: "active" }, select: { id: true } })) throw new PosKitAdminError("Filial ativa não encontrada.", 404);
    const [products, boms] = await Promise.all([
      access.db.product.findMany({
        where: { active: true, branchConfigurations: { some: { branchId, active: true, saleEnabled: true } } },
        select: { id: true, name: true, sku: true, type: true, unit: true, variations: { where: { enabled: true }, select: { id: true, sku: true, attributes: true }, orderBy: { id: "asc" } } },
        orderBy: [{ name: "asc" }, { id: "asc" }], take: 1_000,
      }),
      access.db.posKitBom.findMany({
        where: { branchId }, include: { components: { include: { product: { select: { name: true, sku: true, unit: true } }, variation: { select: { sku: true, attributes: true } } }, orderBy: { position: "asc" } } },
        orderBy: [{ scopeKey: "asc" }, { version: "desc" }], take: 500,
      }),
    ]);
    return Response.json({ branchId, products, boms: boms.map(bom => ({ ...posKitBomDto(bom), components: posKitBomDto(bom).components.map((component, index) => ({ ...component, product: bom.components[index].product, variation: bom.components[index].variation })) })) }, { headers: noStoreHeaders() });
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
    const input = parsePosKitAdminInput(await readPosJson(request, 32_768));
    await enforcePosRateLimit(access.db, access.actor.user.id, `admin:${input.action}`);
    return executeIdempotent(access, input);
  } catch (error) {
    return failure(error);
  }
}

async function adminAccess() {
  const organization = await currentOrganization();
  const actor = await assertTenantPermission(organization.id, "pdv.write");
  if (!["owner", "admin"].includes(actor.membership.role)) throw new PosKitAdminError("Somente proprietários e administradores podem gerir composições de kits.", 403);
  return { organizationId: organization.id, actor, db: await tenantDb(organization.id) };
}

async function executeIdempotent(access: Access, input: PosKitAdminInput) {
  const requestHash = hashPosKitAdminInput(input), existing = await access.db.pdvAdminMutation.findUnique({ where: { key: input.idempotencyKey } });
  if (existing) return replay(existing, access.actor.user.id, input.action, requestHash);
  const correlationId = randomUUID();
  try {
    const completed = await access.db.$transaction(async tx => {
      await tx.pdvAdminMutation.create({ data: { key: input.idempotencyKey, actorId: access.actor.user.id, action: input.action, requestHash, expiresAt: new Date(Date.now() + 30 * 86_400_000) } });
      const result = await applyPosKitAdminMutation(tx, input, access.actor.user.id);
      const responseBody = jsonObject({ ...result.body, correlationId, replayed: false });
      await tx.tenantAuditEvent.create({ data: {
        actorId: access.actor.user.id, action: `pos.admin.${input.action}`, entityType: result.entityType, entityId: result.entityId, correlationId,
        beforeData: result.before ? jsonObject(result.before) : undefined,
        afterData: jsonObject({ ...result.body, branchId: input.branchId, idempotencyKey: input.idempotencyKey, requestHash }),
      } });
      await tx.pdvAdminMutation.update({ where: { key: input.idempotencyKey }, data: { state: "completed", entityType: result.entityType, entityId: result.entityId, responseStatus: result.status, responseBody } });
      return { status: result.status, body: responseBody };
    }, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 });
    return Response.json(completed.body, { status: completed.status, headers: noStoreHeaders() });
  } catch (error) {
    if (["P2002", "P2034"].includes(prismaCode(error))) {
      const concurrent = await access.db.pdvAdminMutation.findUnique({ where: { key: input.idempotencyKey } });
      if (concurrent) return replay(concurrent, access.actor.user.id, input.action, requestHash);
    }
    throw error;
  }
}

function replay(record: { actorId: string; action: string; requestHash: string; state: string; responseStatus: number | null; responseBody: Prisma.JsonValue | null }, actorId: string, action: string, requestHash: string) {
  if (record.actorId !== actorId || record.action !== action || record.requestHash !== requestHash) throw new PosKitAdminError("A chave idempotente já foi usada com outro ator, ação ou payload.", 409);
  if (record.state !== "completed" || record.responseStatus == null || !record.responseBody || typeof record.responseBody !== "object" || Array.isArray(record.responseBody)) throw new PosKitAdminError("A operação com esta chave ainda está em processamento.", 409);
  return Response.json({ ...(record.responseBody as Record<string, unknown>), replayed: true }, { status: record.responseStatus, headers: { ...noStoreHeaders(), "idempotency-replayed": "true" } });
}

function positiveId(value: unknown, label: string) { const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new PosKitAdminError(`${label} inválida.`); return parsed; }
function jsonObject(value: object) { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject; }
function prismaCode(error: unknown) { return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code || "") : ""; }
function noStoreHeaders() { return { "cache-control": "no-store", pragma: "no-cache" }; }
function failure(error: unknown) {
  if (error instanceof PosKitAdminError || error instanceof PosHttpError) return Response.json({ error: error.message }, { status: error.status, headers: noStoreHeaders() });
  if (error instanceof CustomerInputError) return Response.json({ error: error.message }, { status: error.message.includes("Origem") ? 403 : 422, headers: noStoreHeaders() });
  if (error instanceof LicenseDeniedError) return Response.json({ error: error.message }, { status: error.status, headers: noStoreHeaders() });
  if (error instanceof AuthError) return authErrorResponse(error);
  if (["P2002", "P2034"].includes(prismaCode(error))) return Response.json({ error: prismaCode(error) === "P2034" ? "Composição alterada concorrentemente. Repita com a mesma chave." : "Já existe uma versão ou composição conflitante neste escopo." }, { status: 409, headers: noStoreHeaders() });
  console.error("POS kit administration failed", { error: error instanceof Error ? error.name : typeof error });
  return Response.json({ error: "Não foi possível concluir a gestão de kits." }, { status: 500, headers: noStoreHeaders() });
}
