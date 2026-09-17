import { currentOrganization, tenantDb } from "@/db";
import { AuthError, authErrorResponse } from "@/lib/auth";
import {
  mediaUsageSelect,
  publicMediaAsset,
} from "@/lib/erp/media-library-server";
import { assertTenantPermission } from "@/lib/erp/permissions";

export async function GET(
  _: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const organization = await currentOrganization();
    const access = await assertTenantPermission(
      organization.id,
      "library.read",
    );
    const { id } = await params;
    const db = await tenantDb(organization.id);
    const asset = await db.tenantMediaAsset.findUnique({
      where: { id },
      include: {
        _count: { select: { ...mediaUsageSelect, versions: true } },
        favorites: {
          where: { userId: access.user.id },
          select: { userId: true },
        },
        versions: { orderBy: { version: "desc" }, take: 30 },
      },
    });
    if (!asset)
      return Response.json(
        { error: "Arquivo não encontrado." },
        { status: 404 },
      );
    const audit = await db.tenantAuditEvent.findMany({
      where: { entityType: "media_asset", entityId: id },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: { id: true, actorId: true, action: true, createdAt: true },
    });
    return Response.json(
      {
        asset: publicMediaAsset(asset),
        usage: usageBreakdown(asset._count),
        versions: [
          {
            id: null,
            version: asset.version,
            originalName: asset.originalName,
            mimeType: asset.mimeType,
            sizeBytes: asset.sizeBytes,
            uploadedByName: asset.uploadedByName,
            createdAt: asset.updatedAt,
            current: true,
            url: `/api/erp/library/${asset.id}/file`,
          },
          ...asset.versions.map((version) => ({
            id: version.id,
            version: version.version,
            originalName: version.originalName,
            mimeType: version.mimeType,
            sizeBytes: version.sizeBytes,
            uploadedByName: version.uploadedByName,
            changeNote: version.changeNote,
            createdAt: version.createdAt,
            current: false,
            url: `/api/erp/library/${asset.id}/versions/${version.id}/file`,
          })),
        ],
        audit: audit.map((event) => ({ ...event, id: String(event.id) })),
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    if (error instanceof AuthError) return authErrorResponse(error);
    console.error("media-library-detail-failed", { error: error instanceof Error ? error.name : typeof error });
    return Response.json(
      { error: "Não foi possível carregar os detalhes do arquivo." },
      { status: 500 },
    );
  }
}

function usageBreakdown(counts: Record<string, number>) {
  const labels: Record<string, string> = {
    products: "Imagem principal de produtos",
    productSeoImages: "SEO de produtos",
    productVideos: "Vídeos de produtos",
    productVideoThumbnails: "Capas de vídeos",
    productBrandLogos: "Logos de marcas",
    productGallery: "Galerias de produtos",
    productAttributeOptions: "Opções de atributos",
    productVariationImages: "Imagens de variações",
    productVariationGallery: "Galerias de variações",
    productDownloads: "Downloads de produtos",
    logoSettings: "Identidade da organização",
  };
  return Object.entries(labels)
    .map(([key, label]) => ({ key, label, count: counts[key] || 0 }))
    .filter((item) => item.count > 0);
}
