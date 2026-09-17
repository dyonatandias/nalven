import { currentOrganization, tenantDb } from "@/db";
import { AuthError } from "@/lib/auth";
import { assertSameOrigin, CustomerInputError } from "@/lib/erp/customer-input";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { posValueLiabilityReport } from "@/lib/erp/pos-value-liability";

const noStoreHeaders = { "cache-control": "no-store, max-age=0", expires: "0", pragma: "no-cache" };

export async function GET(request: Request) {
  try {
    assertSameOrigin(request);
    const organization = await currentOrganization();
    const actor = await assertTenantPermission(organization.id, "pdv.read");
    if (!["owner", "admin"].includes(actor.membership.role)) throw new PosValueLiabilityRouteError("Somente proprietários e administradores podem consultar o passivo de valores.", 403);
    const branchId = parseBranchQuery(new URL(request.url).searchParams);
    const db = await tenantDb(organization.id);
    // Owner/admin is tenant-wide; the active-branch check prevents stale or cross-resource IDs.
    const branch = await db.branch.findFirst({ where: { id: branchId, status: "active" }, select: { id: true, code: true, name: true } });
    if (!branch) throw new PosValueLiabilityRouteError("Filial ativa não encontrada.", 404);
    return Response.json({ branch, report: await posValueLiabilityReport(db, branch.id) }, { headers: noStoreHeaders });
  } catch (error) {
    return failure(error);
  }
}

function parseBranchQuery(parameters: URLSearchParams) {
  for (const key of parameters.keys()) {
    if (key !== "branchId") throw new PosValueLiabilityRouteError(`Parâmetro não permitido: ${key}.`, 400);
    if (parameters.getAll(key).length !== 1) throw new PosValueLiabilityRouteError("Parâmetro de filial repetido.", 400);
  }
  const value = parameters.get("branchId");
  if (!value || !/^\d{1,10}$/.test(value)) throw new PosValueLiabilityRouteError("Filial inválida.", 400);
  const branchId = Number(value);
  if (!Number.isSafeInteger(branchId) || branchId <= 0 || branchId > 2_147_483_647) throw new PosValueLiabilityRouteError("Filial inválida.", 400);
  return branchId;
}

class PosValueLiabilityRouteError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "PosValueLiabilityRouteError";
  }
}

function failure(error: unknown) {
  if (error instanceof PosValueLiabilityRouteError || error instanceof AuthError) return Response.json({ error: error.message }, { status: error.status, headers: noStoreHeaders });
  if (error instanceof CustomerInputError) return Response.json({ error: error.message }, { status: error.message.includes("Origem") ? 403 : 422, headers: noStoreHeaders });
  return Response.json({ error: "Não foi possível consultar o passivo de valores." }, { status: 500, headers: noStoreHeaders });
}
