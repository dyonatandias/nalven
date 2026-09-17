import { unlink } from "node:fs/promises";
import { currentOrganization, tenantDb } from "@/db";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { assertSameOrigin, CustomerInputError } from "@/lib/erp/customer-input";
import { MEDIA_TENANT_QUOTA_BYTES } from "@/lib/erp/media-library";
import { publicMediaAsset } from "@/lib/erp/media-library-server";
import {
  mediaRoot,
  MediaInputError,
  safeMediaName,
  storeTenantMedia,
} from "@/lib/erp/media";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { assertTenantWriteAccess } from "@/lib/tenant-access";
import { readMultipartForm, HttpSecurityError, assertTrustedMutation } from "@/lib/http-security";
import { persistentRateLimit } from "@/lib/integrations/core";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let pendingStorageKey = "";
  let organizationId = "";
  try {
    assertSameOrigin(request);
    assertTrustedMutation(request, { contentType: "multipart", maximumBytes: 101 * 1024 * 1024 });
    const organization = await currentOrganization();
    organizationId = organization.id;
    const access = await assertTenantPermission(
      organization.id,
      "library.write",
    );
    await assertTenantWriteAccess(organization.id);
    const { id } = await params;
    const db = await tenantDb(organization.id);
    await persistentRateLimit(db, `${access.user.id}:library-version-upload`, 20, 60);
    const form = await readMultipartForm(request, 101 * 1024 * 1024);
    const file = form.get("file");
    if (!(file instanceof File))
      throw new MediaInputError("Selecione a nova versão do arquivo.");
    const changeNote = safeMediaName(
      form.get("changeNote"),
      "Nova versão",
    ).slice(0, 300);
    const before = await db.tenantMediaAsset.findFirst({
      where: { id, deletedAt: null },
    });
    if (!before)
      return Response.json(
        { error: "Arquivo não encontrado." },
        { status: 404 },
      );
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
    pendingStorageKey = stored.storageKey;
    if (stored.kind !== before.kind)
      throw new MediaInputError(
        "A nova versão deve manter o mesmo tipo do arquivo original.",
        415,
      );
    if (stored.checksum === before.checksum)
      throw new MediaInputError(
        "Esta versão é idêntica ao arquivo atual.",
        409,
      );
    const asset = await db.$transaction(async (tx) => {
      await tx.mediaAssetVersion.create({
        data: {
          assetId: before.id,
          version: before.version,
          storageKey: before.storageKey,
          originalName: before.originalName,
          mimeType: before.mimeType,
          kind: before.kind,
          sizeBytes: before.sizeBytes,
          checksum: before.checksum,
          remoteKey: before.remoteKey,
          remoteUrl: before.remoteUrl,
          localAvailable: before.localAvailable,
          changeNote,
          uploadedById: before.uploadedById,
          uploadedByName: before.uploadedByName,
        },
      });
      const updated = await tx.tenantMediaAsset.update({
        where: { id },
        data: {
          ...stored,
          originalName: safeMediaName(file.name),
          version: { increment: 1 },
          remoteKey: null,
          remoteUrl: null,
          offloadedAt: null,
          localDeleteAfter: null,
          localAvailable: true,
          uploadedById: access.user.id,
          uploadedByName: access.user.name,
        },
      });
      await tx.tenantAuditEvent.create({
        data: {
          actorId: access.user.id,
          action: "media.version_uploaded",
          entityType: "media_asset",
          entityId: id,
          beforeData: { version: before.version, checksum: before.checksum },
          afterData: {
            version: updated.version,
            checksum: updated.checksum,
            changeNote,
          },
        },
      });
      return updated;
    });
    pendingStorageKey = "";
    return Response.json(publicMediaAsset(asset), { status: 201 });
  } catch (error) {
    if (pendingStorageKey && organizationId)
      await unlink(`${mediaRoot(organizationId)}/${pendingStorageKey}`).catch(
        () => undefined,
      );
    if (error instanceof MediaInputError)
      return Response.json({ error: error.message }, { status: error.status });
    if (error instanceof CustomerInputError)
      return Response.json(
        { error: error.message },
        { status: error.message.includes("Origem") ? 403 : 400 },
      );
    if (error instanceof AuthError || error instanceof HttpSecurityError) return authErrorResponse(error);
    console.error("media-library-version-upload-failed", { error: error instanceof Error ? error.name : typeof error });
    return Response.json(
      { error: "Não foi possível salvar a nova versão." },
      { status: 500 },
    );
  }
}
