import { currentOrganization, tenantDb } from "@/db";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { storedMediaResponse } from "@/lib/erp/media-response";
import { assertTenantPermission } from "@/lib/erp/permissions";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; versionId: string }> },
) {
  try {
    const organization = await currentOrganization();
    await assertTenantPermission(organization.id, "library.read");
    const { id, versionId } = await params;
    const parsedId = Number(versionId);
    if (!Number.isInteger(parsedId))
      return new Response("Arquivo não encontrado", { status: 404 });
    const db = await tenantDb(organization.id);
    const version = await db.mediaAssetVersion.findFirst({
      where: { id: parsedId, assetId: id },
    });
    if (!version)
      return new Response("Arquivo não encontrado", { status: 404 });
    return storedMediaResponse(request, organization.id, version);
  } catch (error) {
    if (error instanceof AuthError) return authErrorResponse(error);
    console.error("media-version-file-read-failed", { error: error instanceof Error ? error.name : typeof error });
    return new Response("Arquivo indisponível", { status: 404 });
  }
}
