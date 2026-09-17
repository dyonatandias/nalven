import { randomUUID } from "node:crypto";
import type { Prisma } from "@/generated/tenant/client";
import { currentOrganization, tenantDb } from "@/db";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import { assertSameOrigin, CustomerInputError } from "@/lib/erp/customer-input";
import { applyPosInventoryAdminMutation, hashPosInventoryAdminInput, parsePosInventoryAdminInput, posInventoryLotDto, PosInventoryAdminError, type PosInventoryAdminInput } from "@/lib/erp/pos-inventory-admin";
import { posBusinessDate } from "@/lib/erp/pos-inventory-operations";
import { PosInventoryTrackingError } from "@/lib/erp/pos-inventory-tracking";
import { assertPosMutationRequest, enforcePosRateLimit, PosHttpError, readPosJson } from "@/lib/erp/pos-http";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { assertTenantWriteAccess } from "@/lib/tenant-access";

type Db = Awaited<ReturnType<typeof tenantDb>>;
type AdminAccess = Awaited<ReturnType<typeof adminAccess>>;

const lotInclude = {
  warehouse: { select: { id: true, code: true, name: true, branchId: true } },
  product: { select: { id: true, sku: true, name: true } },
  variation: { select: { id: true, sku: true, attributes: true } },
  _count: { select: { movements: true } },
} satisfies Prisma.PosInventoryLotInclude;

export async function GET(request: Request) {
  try {
    const access = await adminAccess(), url = new URL(request.url);
    const branch = await selectedBranch(access.db, access.actor.user.id, url.searchParams.get("branchId"));
    const warehouseId = optionalId(url.searchParams.get("warehouseId"), "Depósito");
    const status = optionalChoice(url.searchParams.get("status"), ["available", "quarantine", "expired", "depleted", "blocked"] as const, "Status");
    const query = (url.searchParams.get("q") || "").trim().slice(0, 100);
    if (warehouseId && !await access.db.warehouse.findFirst({ where: { id: warehouseId, branchId: branch.id, active: true } })) throw new PosInventoryAdminError("Depósito ativo não pertence à filial.", 404);
    const [warehouses, products, lots] = await Promise.all([
      access.db.warehouse.findMany({ where: { branchId: branch.id, active: true }, select: { id: true, code: true, name: true, primary: true }, orderBy: [{ primary: "desc" }, { name: "asc" }] }),
      access.db.product.findMany({
        where: { active: true, type: { not: "service" }, branchConfigurations: { some: { branchId: branch.id, active: true } } },
        select: { id: true, sku: true, name: true, manageStock: true, variations: { where: { enabled: true }, select: { id: true, sku: true, manageStock: true, attributes: true }, orderBy: { id: "asc" } } },
        orderBy: { name: "asc" }, take: 500,
      }),
      access.db.posInventoryLot.findMany({
        where: {
          warehouse: { branchId: branch.id }, ...(warehouseId ? { warehouseId } : {}), ...(status ? { status } : {}),
          ...(query ? { OR: [
            { lotCode: { contains: query, mode: "insensitive" } }, { serialNumber: { contains: query, mode: "insensitive" } },
            { product: { name: { contains: query, mode: "insensitive" } } }, { product: { sku: { contains: query, mode: "insensitive" } } },
            { variation: { sku: { contains: query, mode: "insensitive" } } },
          ] } : {}),
        },
        include: lotInclude, orderBy: [{ status: "asc" }, { expiresOn: "asc" }, { receivedAt: "desc" }], take: 250,
      }),
    ]);
    return Response.json({ branch, warehouses, products, lots: lots.map(posInventoryLotDto) }, { headers: { "cache-control": "no-store" } });
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
    const input = parsePosInventoryAdminInput(await readPosJson(request, 32_768));
    await enforcePosRateLimit(access.db, access.actor.user.id, `admin:${input.action}`);
    return executeIdempotent(access, input);
  } catch (error) {
    return failure(error);
  }
}

async function adminAccess() {
  const organization = await currentOrganization();
  const actor = await assertTenantPermission(organization.id, "pdv.write");
  if (!["owner", "admin"].includes(actor.membership.role)) throw new PosInventoryAdminError("Somente proprietários e administradores podem gerir lotes e séries.", 403);
  const db = await tenantDb(organization.id);
  const profile = await db.tenantUserProfile.findUnique({ where: { userId: actor.user.id }, select: { displayName: true } });
  return { organizationId: organization.id, actor, actorName: profile?.displayName || actor.user.email || actor.user.id, db };
}

async function selectedBranch(db: Db, actorId: string, rawBranchId: string | null) {
  const branchId = optionalId(rawBranchId, "Filial");
  if (branchId) {
    const branch = await db.branch.findFirst({ where: { id: branchId, status: "active" }, select: { id: true, code: true, name: true, status: true, timezone: true } });
    if (!branch) throw new PosInventoryAdminError("Filial ativa não encontrada.", 404);
    return branch;
  }
  const profile = await db.tenantUserProfile.findUnique({ where: { userId: actorId }, select: { activeBranch: { select: { id: true, code: true, name: true, status: true, timezone: true } } } });
  const branch = profile?.activeBranch?.status === "active" ? profile.activeBranch : await db.branch.findFirst({ where: { status: "active" }, orderBy: [{ primary: "desc" }, { id: "asc" }], select: { id: true, code: true, name: true, status: true, timezone: true } });
  if (!branch) throw new PosInventoryAdminError("Cadastre uma filial antes de gerir o estoque rastreado.", 409);
  return branch;
}

async function executeIdempotent(access: AdminAccess, input: PosInventoryAdminInput) {
  const requestHash = hashPosInventoryAdminInput(input);
  const existing = await access.db.pdvAdminMutation.findUnique({ where: { key: input.idempotencyKey } });
  if (existing) return replay(existing, access.actor.user.id, input.action, requestHash);
  const correlationId = randomUUID();
  try {
    const completed = await access.db.$transaction(async tx => {
      await tx.pdvAdminMutation.create({ data: { key: input.idempotencyKey, actorId: access.actor.user.id, action: input.action, requestHash, expiresAt: new Date(Date.now() + 30 * 86400000) } });
      const branch = await tx.branch.findFirst({ where: { id: input.branchId, status: "active" }, select: { timezone: true } });
      if (!branch) throw new PosInventoryAdminError("Filial ativa não encontrada.", 404);
      const result = await applyPosInventoryAdminMutation(tx, input, { actor: access.actorName, businessDate: posBusinessDate(branch.timezone) });
      const responseBody = jsonObject({ ...result.body, correlationId, replayed: false });
      await tx.tenantAuditEvent.create({ data: {
        actorId: access.actor.user.id, action: `pos.admin.${input.action}`, entityType: result.entityType, entityId: result.entityId, correlationId,
        beforeData: result.beforeData ? jsonObject(result.beforeData) : undefined,
        afterData: jsonObject({ ...result.body, idempotencyKey: input.idempotencyKey, requestHash }),
      } });
      await tx.pdvAdminMutation.update({ where: { key: input.idempotencyKey }, data: { state: "completed", entityType: result.entityType, entityId: result.entityId, responseStatus: result.status, responseBody } });
      return { status: result.status, body: responseBody };
    }, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 });
    return Response.json(completed.body, { status: completed.status });
  } catch (error) {
    if (new Set(["P2002", "P2034"]).has(prismaCode(error))) {
      const concurrent = await access.db.pdvAdminMutation.findUnique({ where: { key: input.idempotencyKey } });
      if (concurrent) return replay(concurrent, access.actor.user.id, input.action, requestHash);
    }
    throw error;
  }
}

function replay(record: { actorId: string; action: string; requestHash: string; state: string; responseStatus: number | null; responseBody: Prisma.JsonValue | null }, actorId: string, action: string, requestHash: string) {
  if (record.actorId !== actorId || record.action !== action || record.requestHash !== requestHash) throw new PosInventoryAdminError("A chave de idempotência já foi usada com outro contexto ou payload.", 409);
  if (record.state !== "completed" || record.responseStatus == null || !record.responseBody || typeof record.responseBody !== "object" || Array.isArray(record.responseBody)) throw new PosInventoryAdminError("A operação com esta chave ainda está em processamento.", 409);
  return Response.json({ ...(record.responseBody as Record<string, unknown>), replayed: true }, { status: record.responseStatus, headers: { "idempotency-replayed": "true" } });
}

function optionalId(value: unknown, label: string) { if (value == null || value === "") return null; const result = Number(value); if (!Number.isSafeInteger(result) || result <= 0) throw new PosInventoryAdminError(`${label} inválido.`); return result; }
function optionalChoice<const T extends readonly string[]>(value: unknown, choices: T, label: string) { if (value == null || value === "") return null; const result = String(value); if (!choices.includes(result)) throw new PosInventoryAdminError(`${label} inválido.`); return result as T[number]; }
function jsonObject(value: Record<string, unknown>) { return JSON.parse(JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item)) as Prisma.InputJsonObject; }
function prismaCode(error: unknown) { return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code || "") : ""; }
function failure(error: unknown) {
  if (error instanceof PosInventoryAdminError || error instanceof PosInventoryTrackingError || error instanceof PosHttpError || error instanceof CustomerInputError) return Response.json({ error: error.message }, { status: "status" in error && typeof error.status === "number" ? error.status : 422 });
  if (error instanceof LicenseDeniedError) return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof AuthError) return authErrorResponse(error);
  if (prismaCode(error) === "P2002") return Response.json({ error: "A identidade, série ou chave já está cadastrada." }, { status: 409 });
  if (prismaCode(error) === "P2034") return Response.json({ error: "Conflito concorrente no estoque rastreado. Atualize e tente novamente." }, { status: 409 });
  console.error("POS inventory admin failed", { error: error instanceof Error ? error.name : typeof error });
  return Response.json({ error: "Não foi possível concluir a gestão do estoque rastreado." }, { status: 500 });
}
