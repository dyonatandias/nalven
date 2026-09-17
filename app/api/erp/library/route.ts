import { unlink } from "node:fs/promises";
import { currentOrganization, tenantDb } from "@/db";
import type { Prisma } from "@/generated/tenant/client";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { assertSameOrigin, CustomerInputError } from "@/lib/erp/customer-input";
import {
  MEDIA_TENANT_QUOTA_BYTES,
  mediaIds,
  mediaMetadata,
  parseMediaLibraryQuery,
} from "@/lib/erp/media-library";
import {
  mediaUsageCount,
  mediaUsageSelect,
  publicMediaAsset,
} from "@/lib/erp/media-library-server";
import {
  mediaRoot,
  MediaInputError,
  safeMediaFolder,
  safeMediaName,
  storeTenantMedia,
} from "@/lib/erp/media";
import { assertTenantPermission, matches } from "@/lib/erp/permissions";
import { assertTenantWriteAccess } from "@/lib/tenant-access";
import { readMultipartForm, assertTrustedMutation, HttpSecurityError, readJsonObject } from "@/lib/http-security";
import { persistentRateLimit } from "@/lib/integrations/core";

const unusedRelations: Prisma.TenantMediaAssetWhereInput = {
  products: { none: {} },
  productSeoImages: { none: {} },
  productVideos: { none: {} },
  productVideoThumbnails: { none: {} },
  productBrandLogos: { none: {} },
  productGallery: { none: {} },
  productAttributeOptions: { none: {} },
  productVariationImages: { none: {} },
  productVariationGallery: { none: {} },
  productDownloads: { none: {} },
  logoSettings: { none: {} },
};

export async function GET(request: Request) {
  try {
    const organization = await currentOrganization();
    const access = await assertTenantPermission(
      organization.id,
      "library.read",
    );
    const filters = parseMediaLibraryQuery(new URL(request.url));
    const db = await tenantDb(organization.id);
    const where: Prisma.TenantMediaAssetWhereInput = {
      deletedAt: filters.trash ? { not: null } : null,
      ...(filters.kind ? { kind: filters.kind } : {}),
      ...(filters.folder ? { folder: filters.folder } : {}),
      ...(filters.favorite
        ? { favorites: { some: { userId: access.user.id } } }
        : {}),
      ...(filters.tag ? { tags: { has: filters.tag } } : {}),
      ...(filters.unused ? unusedRelations : {}),
      ...(filters.missingAlt ? { kind: "image", altText: "" } : {}),
      ...(filters.query
        ? {
            OR: [
              { name: { contains: filters.query, mode: "insensitive" } },
              {
                originalName: { contains: filters.query, mode: "insensitive" },
              },
              { altText: { contains: filters.query, mode: "insensitive" } },
              { description: { contains: filters.query, mode: "insensitive" } },
            ],
          }
        : {}),
    };
    const orderBy: Prisma.TenantMediaAssetOrderByWithRelationInput =
      filters.sort === "name"
        ? { name: "asc" }
        : filters.sort === "size"
          ? { sizeBytes: "desc" }
          : filters.sort === "updated"
            ? { updatedAt: "desc" }
            : { createdAt: "desc" };
    const [
      items,
      filteredTotal,
      folderRows,
      folderCounts,
      totals,
      trashTotal,
      unusedTotal,
      missingAlt,
      favoriteTotal,
      versionStorage,
    ] = await Promise.all([
      db.tenantMediaAsset.findMany({
        where,
        include: {
          _count: { select: { ...mediaUsageSelect, versions: true } },
          favorites: {
            where: { userId: access.user.id },
            select: { userId: true },
          },
        },
        orderBy,
        skip: (filters.page - 1) * filters.perPage,
        take: filters.perPage,
      }),
      db.tenantMediaAsset.count({ where }),
      db.mediaFolder.findMany({
        orderBy: [{ system: "desc" }, { name: "asc" }],
      }),
      db.tenantMediaAsset.groupBy({
        by: ["folder"],
        where: { deletedAt: null },
        _count: true,
      }),
      db.tenantMediaAsset.groupBy({
        by: ["kind"],
        where: { deletedAt: null },
        _count: true,
        _sum: { sizeBytes: true },
      }),
      db.tenantMediaAsset.count({ where: { deletedAt: { not: null } } }),
      db.tenantMediaAsset.count({
        where: { deletedAt: null, ...unusedRelations },
      }),
      db.tenantMediaAsset.count({
        where: { deletedAt: null, kind: "image", altText: "" },
      }),
      db.mediaAssetFavorite.count({
        where: { userId: access.user.id, asset: { deletedAt: null } },
      }),
      db.mediaAssetVersion.aggregate({ _sum: { sizeBytes: true } }),
    ]);
    const checksums = Array.from(new Set(items.map((item) => item.checksum)));
    const duplicateGroups = checksums.length
      ? await db.tenantMediaAsset.groupBy({
          by: ["checksum"],
          where: { deletedAt: null, checksum: { in: checksums } },
          _count: true,
        })
      : [];
    const duplicates = new Map(
      duplicateGroups.map((item) => [
        item.checksum,
        Math.max(item._count - 1, 0),
      ]),
    );
    const countByFolder = new Map(
      folderCounts.map((item) => [item.folder, item._count]),
    );
    const activeTotal = totals.reduce((sum, item) => sum + item._count, 0);
    return Response.json(
      {
        items: items.map((item) =>
          publicMediaAsset(item, duplicates.get(item.checksum) || 0),
        ),
        folders: folderRows.map((item) => ({
          ...item,
          count: countByFolder.get(item.name) || 0,
        })),
        tags: await popularTags(db),
        summary: {
          total: activeTotal,
          images: totals.find((item) => item.kind === "image")?._count || 0,
          videos: totals.find((item) => item.kind === "video")?._count || 0,
          documents:
            totals.find((item) => item.kind === "document")?._count || 0,
          sizeBytes:
            totals.reduce((sum, item) => sum + (item._sum.sizeBytes || 0), 0) +
            (versionStorage._sum.sizeBytes || 0),
          trash: trashTotal,
          unused: unusedTotal,
          missingAlt,
          favorites: favoriteTotal,
          quotaBytes: MEDIA_TENANT_QUOTA_BYTES,
        },
        pagination: {
          page: filters.page,
          perPage: filters.perPage,
          total: filteredTotal,
          pages: Math.max(Math.ceil(filteredTotal / filters.perPage), 1),
        },
        capabilities: {
          canWrite: matches(access.permissions, "library.write"),
        },
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    assertTrustedMutation(request, { contentType: "multipart", maximumBytes: 101 * 1024 * 1024 });
    const organization = await currentOrganization();
    const access = await assertTenantPermission(
      organization.id,
      "library.write",
    );
    await assertTenantWriteAccess(organization.id);
    const db = await tenantDb(organization.id);
    await persistentRateLimit(db, `${access.user.id}:library-upload`, 20, 60);
    const form = await readMultipartForm(request, 101 * 1024 * 1024);
    const file = form.get("file");
    if (!(file instanceof File))
      throw new MediaInputError("Selecione um arquivo.");
    const metadata = mediaMetadata(Object.fromEntries(form.entries()), {
      name: safeMediaName(file.name),
      folder: "Geral",
    });
    if (
      !(await db.mediaFolder.findUnique({ where: { name: metadata.folder } }))
    )
      throw new MediaInputError("Selecione uma pasta válida.");
    const storage = await db.tenantMediaAsset.aggregate({
      where: { deletedAt: null },
      _sum: { sizeBytes: true },
    });
    const versionStorage = await db.mediaAssetVersion.aggregate({
      _sum: { sizeBytes: true },
    });
    if (
      (storage._sum.sizeBytes || 0) +
        (versionStorage._sum.sizeBytes || 0) +
        file.size >
      MEDIA_TENANT_QUOTA_BYTES
    )
      throw new MediaInputError(
        "O limite de armazenamento da organização seria excedido.",
        413,
      );
    const stored = await storeTenantMedia(organization.id, file);
    const duplicate = await db.tenantMediaAsset.findFirst({
      where: { checksum: stored.checksum, deletedAt: null },
      include: {
        _count: { select: { ...mediaUsageSelect, versions: true } },
        favorites: {
          where: { userId: access.user.id },
          select: { userId: true },
        },
      },
    });
    if (duplicate) {
      await unlink(`${mediaRoot(organization.id)}/${stored.storageKey}`).catch(
        () => undefined,
      );
      return Response.json({
        ...publicMediaAsset(duplicate),
        deduplicated: true,
      });
    }
    try {
      const asset = await db.$transaction(async (tx) => {
        const created = await tx.tenantMediaAsset.create({
          data: {
            ...stored,
            ...metadata,
            originalName: safeMediaName(file.name),
            uploadedById: access.user.id,
            uploadedByName: access.user.name,
          },
        });
        await tx.tenantAuditEvent.create({
          data: {
            actorId: access.user.id,
            action: "media.uploaded",
            entityType: "media_asset",
            entityId: created.id,
            afterData: {
              name: created.name,
              mimeType: created.mimeType,
              sizeBytes: created.sizeBytes,
              checksum: created.checksum,
              folder: created.folder,
              tags: created.tags,
            },
          },
        });
        return created;
      });
      return Response.json(publicMediaAsset(asset), { status: 201 });
    } catch (error) {
      await unlink(`${mediaRoot(organization.id)}/${stored.storageKey}`).catch(
        () => undefined,
      );
      throw error;
    }
  } catch (error) {
    return fail(error);
  }
}

export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request);
    const organization = await currentOrganization();
    const access = await assertTenantPermission(
      organization.id,
      "library.write",
    );
    await assertTenantWriteAccess(organization.id);
    const body = await readJsonObject(request, 524_288);
    const action = String(body.action || "update");
    const db = await tenantDb(organization.id);
    if (action.startsWith("bulk.")) {
      const ids = mediaIds(body.ids);
      const assets = await db.tenantMediaAsset.findMany({
        where: { id: { in: ids } },
        include: { _count: { select: mediaUsageSelect } },
      });
      if (assets.length !== ids.length)
        throw new MediaInputError("Um ou mais arquivos não existem.", 404);
      if (
        action === "bulk.delete" &&
        assets.some((item) => mediaUsageCount(item._count) > 0)
      )
        throw new MediaInputError(
          "A seleção contém arquivos em uso. Remova os vínculos antes de enviá-los à lixeira.",
          409,
        );
      const data: Prisma.TenantMediaAssetUpdateManyMutationInput =
        action === "bulk.delete"
          ? { deletedAt: new Date() }
          : action === "bulk.restore"
            ? { deletedAt: null }
            : action === "bulk.move"
              ? { folder: await validFolder(db, body.folder) }
              : invalidBulkAction();
      await db.$transaction([
        db.tenantMediaAsset.updateMany({ where: { id: { in: ids } }, data }),
        db.tenantAuditEvent.create({
          data: {
            actorId: access.user.id,
            action,
            entityType: "media_asset_batch",
            entityId: ids.join(",").slice(0, 500),
            afterData: { ids, ...data },
          },
        }),
      ]);
      return Response.json({ ok: true, count: ids.length });
    }
    const id = String(body.id || "");
    if (!id) throw new MediaInputError("Arquivo inválido.");
    const before = await db.tenantMediaAsset.findUnique({
      where: { id },
      include: { _count: { select: mediaUsageSelect } },
    });
    if (!before)
      return Response.json(
        { error: "Arquivo não encontrado." },
        { status: 404 },
      );
    if (action === "favorite") {
      const favorite = Boolean(body.favorite);
      if (favorite)
        await db.mediaAssetFavorite.upsert({
          where: { assetId_userId: { assetId: id, userId: access.user.id } },
          create: { assetId: id, userId: access.user.id },
          update: {},
        });
      else
        await db.mediaAssetFavorite.deleteMany({
          where: { assetId: id, userId: access.user.id },
        });
      return Response.json({ ok: true, favorite });
    }
    if (action === "delete" && mediaUsageCount(before._count) > 0)
      throw new MediaInputError(
        "Esta mídia está em uso. Remova os vínculos antes de enviá-la para a lixeira.",
        409,
      );
    if (action === "purge") {
      if (!before.deletedAt)
        throw new MediaInputError(
          "Envie o arquivo à lixeira antes de excluí-lo definitivamente.",
        );
      if (mediaUsageCount(before._count) > 0)
        throw new MediaInputError(
          "Arquivos em uso não podem ser excluídos definitivamente.",
          409,
        );
      const versions = await db.mediaAssetVersion.findMany({
        where: { assetId: id },
      });
      await db.$transaction([
        db.tenantAuditEvent.create({
          data: {
            actorId: access.user.id,
            action: "media.purged",
            entityType: "media_asset",
            entityId: id,
            beforeData: {
              name: before.name,
              folder: before.folder,
              version: before.version,
            },
          },
        }),
        db.tenantMediaAsset.delete({ where: { id } }),
      ]);
      await Promise.all(
        [before, ...versions]
          .filter((item) => item.localAvailable)
          .map((item) =>
            unlink(`${mediaRoot(organization.id)}/${item.storageKey}`).catch(
              () => undefined,
            ),
          ),
      );
      return Response.json({ ok: true });
    }
    let update: Prisma.TenantMediaAssetUpdateInput;
    if (action === "update") {
      const metadata = mediaMetadata(body, {
        name: before.name,
        folder: before.folder,
      });
      await validFolder(db, metadata.folder);
      update = metadata;
    } else if (action === "delete") update = { deletedAt: new Date() };
    else if (action === "restore") update = { deletedAt: null };
    else throw new MediaInputError("Ação inválida.");
    const asset = await db.$transaction(async (tx) => {
      const updated = await tx.tenantMediaAsset.update({
        where: { id },
        data: update,
      });
      await tx.tenantAuditEvent.create({
        data: {
          actorId: access.user.id,
          action: `media.${action}`,
          entityType: "media_asset",
          entityId: id,
          beforeData: {
            name: before.name,
            folder: before.folder,
            deletedAt: before.deletedAt,
            tags: before.tags,
          },
          afterData: {
            name: updated.name,
            folder: updated.folder,
            deletedAt: updated.deletedAt,
            tags: updated.tags,
          },
        },
      });
      return updated;
    });
    return Response.json(publicMediaAsset(asset));
  } catch (error) {
    return fail(error);
  }
}

async function validFolder(
  db: Awaited<ReturnType<typeof tenantDb>>,
  value: unknown,
) {
  const folder = safeMediaFolder(value);
  if (!(await db.mediaFolder.findUnique({ where: { name: folder } })))
    throw new MediaInputError("Selecione uma pasta válida.");
  return folder;
}
function invalidBulkAction(): never {
  throw new MediaInputError("Ação em lote inválida.");
}
async function popularTags(db: Awaited<ReturnType<typeof tenantDb>>) {
  const rows = await db.tenantMediaAsset.findMany({
    where: { deletedAt: null },
    select: { tags: true },
    take: 1000,
  });
  const counts = new Map<string, number>();
  for (const tag of rows.flatMap((row) => row.tags))
    counts.set(tag, (counts.get(tag) || 0) + 1);
  return Array.from(counts, ([name, count]) => ({ name, count }))
    .sort(
      (left, right) =>
        right.count - left.count || left.name.localeCompare(right.name),
    )
    .slice(0, 20);
}
function fail(error: unknown) {
  if (error instanceof HttpSecurityError) return authErrorResponse(error);
  if (error instanceof MediaInputError)
    return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof CustomerInputError)
    return Response.json(
      { error: error.message },
      { status: error.message.includes("Origem") ? 403 : 400 },
    );
  if (error instanceof AuthError) return authErrorResponse(error);
  console.error("media-library-request-failed", {
    error: error instanceof Error ? error.name : typeof error,
  });
  return Response.json(
    { error: "Não foi possível processar a mídia. Tente novamente." },
    { status: 500 },
  );
}
