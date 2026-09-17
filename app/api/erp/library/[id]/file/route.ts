import { currentOrganization, tenantDb } from "@/db";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { storedMediaResponse } from "@/lib/erp/media-response";
import { assertTenantPermission } from "@/lib/erp/permissions";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const organization = await currentOrganization();
    let pdvProductImageOnly = false;
    try {
      await assertTenantPermission(organization.id, "library.read");
    } catch {
      await assertTenantPermission(organization.id, "pdv.write");
      pdvProductImageOnly = true;
    }
    const { id } = await params;
    const db = await tenantDb(organization.id);
    if (
      pdvProductImageOnly &&
      !(await db.product.count({ where: { imageMediaId: id, active: true } }))
    )
      return new Response("Arquivo não encontrado", { status: 404 });
    const asset = await db.tenantMediaAsset.findFirst({
      where: { id, ...(pdvProductImageOnly ? { deletedAt: null } : {}) },
    });
    if (!asset) return new Response("Arquivo não encontrado", { status: 404 });
    return storedMediaResponse(request, organization.id, asset);
  } catch (error) {
    if (error instanceof AuthError) return authErrorResponse(error);
    console.error("media-file-read-failed", { error: error instanceof Error ? error.name : typeof error });
    return new Response("Arquivo indisponível", { status: 404 });
  }
}
