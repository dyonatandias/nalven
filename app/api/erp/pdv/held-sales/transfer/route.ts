import { currentOrganization, tenantDb } from "@/db";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import { assertSameOrigin, CustomerInputError } from "@/lib/erp/customer-input";
import {
  executePosHeldCartTransfer,
  listPosHeldCartTransferTargets,
  parsePosHeldCartTransferInput,
  PosHeldCartTransferError,
  type PosHeldCartTransferContext,
} from "@/lib/erp/pos-held-cart-transfer";
import { assertPosMutationRequest, enforcePosRateLimit, PosHttpError, readPosJson } from "@/lib/erp/pos-http";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { assertTenantWriteAccess } from "@/lib/tenant-access";

type Db = Awaited<ReturnType<typeof tenantDb>>;
type Permission = Awaited<ReturnType<typeof assertTenantPermission>>;

export async function GET(request: Request) {
  try {
    assertSameOrigin(request);
    const organization = await currentOrganization();
    const permission = await assertTenantPermission(organization.id, "pdv.write");
    const db = await tenantDb(organization.id);
    const context = await transferContext(db, permission);
    const query = new URL(request.url).searchParams;
    const heldSaleId = requiredText(query.get("heldSaleId"), "Carrinho suspenso", 80);
    const sourceSessionId = positiveId(query.get("sourceSessionId"), "Turno de origem");
    const result = await listPosHeldCartTransferTargets(db, context, heldSaleId, sourceSessionId);
    return Response.json(result, { headers: noStoreHeaders() });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    assertPosMutationRequest(request);
    const organization = await currentOrganization();
    const permission = await assertTenantPermission(organization.id, "pdv.write");
    const db = await tenantDb(organization.id);
    const input = parsePosHeldCartTransferInput(await readPosJson(request, 16_384));
    await enforcePosRateLimit(db, permission.user.id, "cart.transfer");
    const context = await transferContext(db, permission);
    await assertTenantWriteAccess(organization.id);
    const completed = await executePosHeldCartTransfer(db, context, input);
    return Response.json(completed, { headers: { ...noStoreHeaders(), ...(completed.replayed ? { "idempotency-replayed": "true" } : {}) } });
  } catch (error) {
    return failure(error);
  }
}

async function transferContext(db: Db, permission: Permission): Promise<PosHeldCartTransferContext> {
  const profile = await db.tenantUserProfile.findUnique({
    where: { userId: permission.user.id },
    select: { id: true, displayName: true, status: true, activeBranch: { select: { id: true, status: true } } },
  });
  if (!profile || profile.status !== "active") throw new PosHeldCartTransferError("Perfil operacional ativo não configurado.", 403);
  const branch = profile.activeBranch?.status === "active"
    ? profile.activeBranch
    : await db.branch.findFirst({ where: { status: "active" }, select: { id: true }, orderBy: [{ primary: "desc" }, { id: "asc" }] });
  if (!branch) throw new PosHeldCartTransferError("Filial operacional ativa não encontrada.", 404);
  return {
    branchId: branch.id,
    actorUserId: permission.user.id,
    actorProfileId: profile.id,
    actorName: profile.displayName,
    privileged: ["owner", "admin"].includes(permission.membership.role),
  };
}

function requiredText(value: unknown, label: string, maximum: number) {
  const result = typeof value === "string" ? value.normalize("NFKC").trim() : "";
  if (!result || result.length > maximum) throw new PosHeldCartTransferError(`${label} inválido.`);
  return result;
}

function positiveId(value: unknown, label: string) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) throw new PosHeldCartTransferError(`${label} inválido.`);
  return result;
}

function noStoreHeaders() { return { "cache-control": "no-store", pragma: "no-cache" }; }

function failure(error: unknown) {
  if (error instanceof PosHeldCartTransferError || error instanceof PosHttpError) return Response.json({ error: error.message }, { status: error.status, headers: noStoreHeaders() });
  if (error instanceof CustomerInputError) return Response.json({ error: error.message }, { status: error.message.includes("Origem") ? 403 : 422, headers: noStoreHeaders() });
  if (error instanceof LicenseDeniedError) return Response.json({ error: error.message }, { status: error.status, headers: noStoreHeaders() });
  if (error instanceof AuthError) return authErrorResponse(error);
  console.error("POS held cart transfer failed", { error: error instanceof Error ? error.name : typeof error });
  return Response.json({ error: "Não foi possível transferir o carrinho suspenso." }, { status: 500, headers: noStoreHeaders() });
}
