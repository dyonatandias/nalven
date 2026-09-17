import { currentOrganization, tenantDb } from "@/db";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { assertRequestOrigin, HttpSecurityError, readJsonObject } from "@/lib/http-security";
import { ProductionInputError } from "@/lib/erp/production-input";
import { PosInventoryTrackingError } from "@/lib/erp/pos-inventory-tracking";
import { PosCommonStockError } from "@/lib/erp/pos-common-stock";
import { executeProductionCommand } from "@/lib/erp/production-service";
import { productionRead } from "@/lib/erp/production-query";
import { object, safeJson } from "@/lib/erp/production-domain";
import { assertTenantWriteAccess } from "@/lib/tenant-access";

export const dynamic = "force-dynamic";
const headers = { "cache-control": "private, no-store" };
export async function GET(request: Request) {
  try {
    const organization = await currentOrganization();
    await assertTenantPermission(organization.id, "production.read");
    const db = await tenantDb(organization.id);
    return Response.json(
      safeJson(await productionRead(db, new URL(request.url).searchParams)),
      { headers },
    );
  } catch (error) {
    return fail(error);
  }
}
export async function POST(request: Request) {
  try {
    assertRequestOrigin(request);
    const organization = await currentOrganization();
    const actor = await assertTenantPermission(
      organization.id,
      "production.write",
    );
    await assertTenantWriteAccess(organization.id);
    const body = object(await readJsonObject(request, 1_000_000));
    if (body.action === "mrp.purchase")
      await assertTenantPermission(organization.id, "purchases.write");
    if (body.action === "mrp.transfer")
      await assertTenantPermission(organization.id, "inventory.write");
    const db = await tenantDb(organization.id);
    const result = await executeProductionCommand(db, body, {
      id: actor.user.id,
      name: actor.user.name,
    });
    return Response.json(result, { headers });
  } catch (error) {
    return fail(error);
  }
}
function fail(error: unknown) {
  if (error instanceof HttpSecurityError) return authErrorResponse(error);
  if (error instanceof AuthError) return authErrorResponse(error);
  if (error instanceof LicenseDeniedError)
    return Response.json(
      { error: error.message },
      { status: error.status, headers },
    );
  if (
    error instanceof ProductionInputError ||
    error instanceof PosInventoryTrackingError ||
    error instanceof PosCommonStockError
  )
    return Response.json({ error: error.message }, { status: 400, headers });
  if (error && typeof error === "object" && "code" in error) {
    if (error.code === "P2002")
      return Response.json(
        {
          error:
            "Código, série ou operação já cadastrados. Atualize antes de tentar novamente.",
        },
        { status: 409, headers },
      );
    if (error.code === "P2034")
      return Response.json(
        {
          error:
            "Uma operação simultânea alterou o estoque. Tente novamente com a mesma operação.",
        },
        { status: 409, headers },
      );
    if (error.code === "P2025")
      return Response.json(
        { error: "Registro não encontrado." },
        { status: 404, headers },
      );
  }
  console.error(
    "production operations failed",
    error instanceof Error ? error.name : "unknown",
  );
  return Response.json(
    { error: "Não foi possível concluir a operação de produção." },
    { status: 500, headers },
  );
}
