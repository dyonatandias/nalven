import { currentOrganization, tenantDb } from "@/db";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { assertSameOrigin, CustomerInputError } from "@/lib/erp/customer-input";
import { MediaInputError, safeMediaFolder } from "@/lib/erp/media";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { assertTenantWriteAccess } from "@/lib/tenant-access";
import { HttpSecurityError, readJsonObject } from "@/lib/http-security";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const organization = await currentOrganization(),
      access = await assertTenantPermission(organization.id, "library.write");
    await assertTenantWriteAccess(organization.id);
    const body = await readJsonObject(request, 32_768),
      name = safeMediaFolder(body.name),
      color = colorValue(body.color),
      slug = slugify(name);
    const db = await tenantDb(organization.id);
    const folder = await db.$transaction(async (tx) => {
      const created = await tx.mediaFolder.create({
        data: {
          name,
          slug: uniqueSlug(slug),
          color,
          createdBy: access.user.name,
        },
      });
      await tx.tenantAuditEvent.create({
        data: {
          actorId: access.user.id,
          action: "media_folder.created",
          entityType: "media_folder",
          entityId: String(created.id),
          afterData: { name, color },
        },
      });
      return created;
    });
    return Response.json(folder, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request);
    const organization = await currentOrganization(),
      access = await assertTenantPermission(organization.id, "library.write");
    await assertTenantWriteAccess(organization.id);
    const body = await readJsonObject(request, 32_768),
      id = Number(body.id);
    if (!Number.isInteger(id)) throw new MediaInputError("Pasta inválida.");
    const db = await tenantDb(organization.id),
      before = await db.mediaFolder.findUnique({ where: { id } });
    if (!before)
      return Response.json({ error: "Pasta não encontrada." }, { status: 404 });
    const name = before.system ? before.name : safeMediaFolder(body.name),
      color = colorValue(body.color);
    const folder = await db.$transaction(async (tx) => {
      if (name !== before.name)
        await tx.tenantMediaAsset.updateMany({
          where: { folder: before.name },
          data: { folder: name },
        });
      const updated = await tx.mediaFolder.update({
        where: { id },
        data: {
          name,
          slug: name === before.name ? before.slug : uniqueSlug(slugify(name)),
          color,
        },
      });
      await tx.tenantAuditEvent.create({
        data: {
          actorId: access.user.id,
          action: "media_folder.updated",
          entityType: "media_folder",
          entityId: String(id),
          beforeData: { name: before.name, color: before.color },
          afterData: { name, color },
        },
      });
      return updated;
    });
    return Response.json(folder);
  } catch (error) {
    return fail(error);
  }
}
export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    const organization = await currentOrganization(),
      access = await assertTenantPermission(organization.id, "library.write");
    await assertTenantWriteAccess(organization.id);
    const id = Number(new URL(request.url).searchParams.get("id"));
    if (!Number.isInteger(id)) throw new MediaInputError("Pasta inválida.");
    const db = await tenantDb(organization.id),
      folder = await db.mediaFolder.findUnique({ where: { id } });
    if (!folder)
      return Response.json({ error: "Pasta não encontrada." }, { status: 404 });
    if (folder.system)
      throw new MediaInputError("Pastas padrão não podem ser excluídas.");
    await db.$transaction([
      db.tenantMediaAsset.updateMany({
        where: { folder: folder.name },
        data: { folder: "Geral" },
      }),
      db.mediaFolder.delete({ where: { id } }),
      db.tenantAuditEvent.create({
        data: {
          actorId: access.user.id,
          action: "media_folder.deleted",
          entityType: "media_folder",
          entityId: String(id),
          beforeData: { name: folder.name },
        },
      }),
    ]);
    return Response.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
function slugify(value: string) {
  return (
    value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 50) || "pasta"
  );
}
function uniqueSlug(value: string) {
  return `${value}-${Date.now().toString(36).slice(-5)}`;
}
function colorValue(value: unknown) {
  const color = String(value || "#168151").toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(color))
    throw new MediaInputError("Cor da pasta inválida.");
  return color;
}
function fail(error: unknown) {
  if (error instanceof HttpSecurityError) return authErrorResponse(error);
  if (error instanceof MediaInputError || error instanceof CustomerInputError)
    return Response.json(
      { error: error.message },
      {
        status: error.message.includes("Origem")
          ? 403
          : error instanceof MediaInputError
            ? error.status
            : 400,
      },
    );
  if (error instanceof AuthError) return authErrorResponse(error);
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "P2002"
  )
    return Response.json(
      { error: "Já existe uma pasta com esse nome." },
      { status: 409 },
    );
  console.error("media-folder-request-failed", {
    error: error instanceof Error ? error.name : typeof error,
  });
  return Response.json(
    { error: "Não foi possível alterar a pasta. Tente novamente." },
    { status: 500 },
  );
}
