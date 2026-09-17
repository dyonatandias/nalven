import { randomUUID } from "node:crypto";
import { currentOrganization, tenantDb } from "@/db";
import type { Prisma } from "@/generated/tenant/client";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import { assertSameOrigin, CustomerInputError } from "@/lib/erp/customer-input";
import { assertTenantPermission, matches } from "@/lib/erp/permissions";
import {
  buildSettingsReadiness,
  readSettingsJson,
  settingsChangedFields,
  settingsExport,
  settingsInput,
  SettingsInputError,
  settingsSnapshot,
  type SettingsFacts,
} from "@/lib/erp/settings-input";
import { persistentRateLimit } from "@/lib/integrations/core";
import { assertTenantWriteAccess } from "@/lib/tenant-access";

const NO_STORE = {
  "cache-control": "private, no-store, max-age=0",
  expires: "0",
  pragma: "no-cache",
};
const mediaSelect = {
  id: true,
  name: true,
  originalName: true,
  mimeType: true,
  kind: true,
  sizeBytes: true,
  altText: true,
  folder: true,
  uploadedByName: true,
  createdAt: true,
  deletedAt: true,
} as const;

export async function GET(request: Request) {
  try {
    const organization = await currentOrganization();
    const access = await assertTenantPermission(organization.id, "settings.read");
    const db = await tenantDb(organization.id);
    const settings = await db.tenantSettings.findUnique({
      where: { id: 1 },
      include: { logoMedia: { select: mediaSelect } },
    });
    if (!settings)
      return Response.json(
        { error: "Configurações da organização ainda não foram inicializadas." },
        { status: 404, headers: NO_STORE },
      );
    const format = new URL(request.url).searchParams.get("format");
    if (format && format !== "json")
      throw new SettingsInputError("Formato de exportação inválido.");
    if (format === "json")
      return new Response(
        settingsExport(
          settings as unknown as Record<string, unknown>,
          organization.id,
        ),
        {
          headers: {
            ...NO_STORE,
            "content-type": "application/json; charset=utf-8",
            "content-disposition": `attachment; filename="configuracoes-${safeFilename(settings.tradeName || settings.organizationName)}-${new Date().toISOString().slice(0, 10)}.json"`,
            "x-content-type-options": "nosniff",
          },
        },
      );

    const now = new Date();
    const activeCredentialWhere = {
      enabled: true,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    };
    const [
      branches,
      activeProfiles,
      expiredProfiles,
      activeRoles,
      integrations,
      activeFiscalCertificates,
      reportSettings,
      history,
      recentChangeCount,
    ] = await Promise.all([
      db.branch.findMany({
        where: { status: "active" },
        select: {
          id: true,
          defaultWarehouseId: true,
          settings: { select: { fiscalEnvironment: true } },
        },
      }),
      db.tenantUserProfile.count({
        where: {
          status: "active",
          OR: [{ accessExpiresAt: null }, { accessExpiresAt: { gt: now } }],
        },
      }),
      db.tenantUserProfile.count({
        where: { status: "active", accessExpiresAt: { lte: now } },
      }),
      db.tenantRole.count({ where: { active: true } }),
      db.integrationCredential.findMany({
        where: activeCredentialWhere,
        select: { providerId: true, lastTestOk: true },
      }),
      db.fiscalCertificate.count({
        where: { active: true, expiresAt: { gt: now } },
      }),
      db.reportSettings.findUnique({ where: { id: 1 }, select: { id: true } }),
      db.tenantAuditEvent.findMany({
        where: {
          entityType: "tenant_settings",
          entityId: "1",
          action: { in: ["tenant_settings.updated", "tenant_settings.restored"] },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 20,
        select: {
          id: true,
          actorId: true,
          action: true,
          correlationId: true,
          beforeData: true,
          afterData: true,
          createdAt: true,
        },
      }),
      db.tenantAuditEvent.count({
        where: {
          entityType: "tenant_settings",
          entityId: "1",
          createdAt: { gte: new Date(now.valueOf() - 30 * 86_400_000) },
        },
      }),
    ]);
    const actorIds = [...new Set(history.map((item) => item.actorId).filter(Boolean))] as string[];
    const actors = actorIds.length
      ? await db.tenantUserProfile.findMany({
          where: { userId: { in: actorIds } },
          select: { userId: true, displayName: true },
        })
      : [];
    const actorNames = new Map(actors.map((item) => [item.userId, item.displayName]));
    const facts: SettingsFacts = {
      activeBranches: branches.length,
      branchesWithWarehouse: branches.filter((item) => item.defaultWarehouseId).length,
      branchesWithFiscalSettings: branches.filter((item) => item.settings).length,
      productionFiscalBranches: branches.filter(
        (item) => item.settings?.fiscalEnvironment === "production",
      ).length,
      activeFiscalCertificates,
      activeProfiles,
      expiredProfiles,
      activeRoles,
      activeIntegrations: integrations.length,
      healthyIntegrations: integrations.filter((item) => item.lastTestOk).length,
      activeSmtpCredentials: integrations.filter((item) => item.providerId === "smtp").length,
      healthySmtpCredentials: integrations.filter(
        (item) => item.providerId === "smtp" && item.lastTestOk,
      ).length,
      reportSettingsConfigured: Boolean(reportSettings),
    };
    const normalized = settingsInput(settings as unknown as Record<string, unknown>);
    return Response.json(
      {
        generatedAt: now.toISOString(),
        settings: serializeSettings(settings),
        permissions: { canWrite: matches(access.permissions, "settings.write") },
        readiness: buildSettingsReadiness(normalized, facts),
        summary: {
          activeBranches: branches.length,
          activeProfiles,
          activeIntegrations: integrations.length,
          healthyIntegrations: integrations.filter((item) => item.lastTestOk).length,
          recentChanges: recentChangeCount,
          reportSettingsConfigured: Boolean(reportSettings),
        },
        history: history.map((item) => ({
          id: String(item.id),
          action: item.action,
          version: record(item.afterData)?.version ?? null,
          actor: item.actorId ? actorNames.get(item.actorId) || "Usuário da organização" : "Sistema",
          correlationId: item.correlationId,
          changedFields: settingsChangedFields(
            record(item.beforeData),
            record(item.afterData),
          ),
          createdAt: item.createdAt.toISOString(),
        })),
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    return failure(error, "consultar");
  }
}

export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request);
    const organization = await currentOrganization();
    const access = await assertTenantPermission(organization.id, "settings.write");
    await assertTenantWriteAccess(organization.id);
    const db = await tenantDb(organization.id);
    await persistentRateLimit(db, `settings:${access.user.id}:write`, 20, 60);
    const body = await readSettingsJson(request);
    const input = settingsInput(body);
    const expectedVersion = expectedSettingsVersion(body.version);
    if (
      input.logoMediaId &&
      !(await db.tenantMediaAsset.findFirst({
        where: { id: input.logoMediaId, kind: "image", deletedAt: null },
        select: { id: true },
      }))
    )
      throw new SettingsInputError("O logotipo selecionado não está disponível.");
    const correlationId = randomUUID();
    const settings = await db.$transaction(
      async (tx) => {
        const before = await tx.tenantSettings.findUnique({ where: { id: 1 } });
        if (!before) throw new SettingsNotFoundError();
        const changed = await tx.tenantSettings.updateMany({
          where: { id: 1, version: expectedVersion },
          data: {
            ...input,
            version: { increment: 1 },
            updatedBy: access.user.id,
          },
        });
        if (changed.count !== 1) throw new SettingsConflictError();
        const updated = await tx.tenantSettings.findUniqueOrThrow({
          where: { id: 1 },
          include: { logoMedia: { select: mediaSelect } },
        });
        await tx.tenantAuditEvent.create({
          data: {
            actorId: access.user.id,
            action: "tenant_settings.updated",
            entityType: "tenant_settings",
            entityId: "1",
            correlationId,
            category: "governance",
            beforeData: auditSnapshot(before),
            afterData: auditSnapshot(updated),
          },
        });
        return updated;
      },
      { isolationLevel: "Serializable", maxWait: 10_000, timeout: 20_000 },
    );
    return Response.json(
      { settings: serializeSettings(settings), correlationId },
      { headers: NO_STORE },
    );
  } catch (error) {
    return failure(error, "salvar");
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const organization = await currentOrganization();
    const access = await assertTenantPermission(organization.id, "settings.write");
    await assertTenantWriteAccess(organization.id);
    const db = await tenantDb(organization.id);
    await persistentRateLimit(db, `settings:${access.user.id}:restore`, 6, 300);
    const body = await readSettingsJson(request, 8_192);
    if (body.action !== "restore")
      throw new SettingsInputError("Ação de configuração inválida.");
    if (body.confirmation !== "RESTAURAR")
      throw new SettingsInputError("Digite RESTAURAR para confirmar a reversão.", 422);
    const expectedVersion = expectedSettingsVersion(body.version);
    const eventId = String(body.eventId || "");
    if (!/^[1-9]\d{0,18}$/.test(eventId))
      throw new SettingsInputError("Versão histórica inválida.");
    const correlationId = randomUUID();
    const settings = await db.$transaction(
      async (tx) => {
        const before = await tx.tenantSettings.findUnique({ where: { id: 1 } });
        if (!before) throw new SettingsNotFoundError();
        if (before.version !== expectedVersion) throw new SettingsConflictError();
        const source = await tx.tenantAuditEvent.findFirst({
          where: {
            id: BigInt(eventId),
            entityType: "tenant_settings",
            entityId: "1",
            action: { in: ["tenant_settings.updated", "tenant_settings.restored"] },
          },
          select: { id: true, afterData: true },
        });
        const sourceData = record(source?.afterData);
        if (!source || !sourceData)
          throw new SettingsInputError("A versão histórica não está disponível.", 404);
        const restored = settingsInput({
          ...settingsSnapshot(before as unknown as Record<string, unknown>),
          ...sourceData,
        });
        if (
          restored.logoMediaId &&
          !(await tx.tenantMediaAsset.findFirst({
            where: { id: restored.logoMediaId, kind: "image", deletedAt: null },
            select: { id: true },
          }))
        )
          restored.logoMediaId = null;
        const updated = await tx.tenantSettings.update({
          where: { id: 1 },
          data: {
            ...restored,
            version: { increment: 1 },
            updatedBy: access.user.id,
          },
          include: { logoMedia: { select: mediaSelect } },
        });
        await tx.tenantAuditEvent.create({
          data: {
            actorId: access.user.id,
            action: "tenant_settings.restored",
            entityType: "tenant_settings",
            entityId: "1",
            correlationId,
            category: "governance",
            beforeData: auditSnapshot(before),
            afterData: {
              ...auditSnapshot(updated),
              restoredFromEventId: String(source.id),
            },
          },
        });
        return updated;
      },
      { isolationLevel: "Serializable", maxWait: 10_000, timeout: 20_000 },
    );
    return Response.json(
      { settings: serializeSettings(settings), correlationId },
      { headers: NO_STORE },
    );
  } catch (error) {
    return failure(error, "restaurar");
  }
}

class SettingsConflictError extends Error {}
class SettingsNotFoundError extends Error {}

function serializeSettings<T extends { logoMedia?: null | { id: string } }>(settings: T) {
  return {
    ...settings,
    logoMedia: settings.logoMedia
      ? {
          ...settings.logoMedia,
          url: `/api/erp/library/${settings.logoMedia.id}/file`,
        }
      : null,
  };
}

function auditSnapshot(value: { version: number } & object): Prisma.InputJsonObject {
  return JSON.parse(JSON.stringify({
    ...settingsSnapshot(value as unknown as Record<string, unknown>),
    version: value.version,
  })) as Prisma.InputJsonObject;
}

function expectedSettingsVersion(value: unknown) {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1)
    throw new SettingsInputError("Versão das configurações inválida.");
  return version;
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeFilename(value: string) {
  return (
    value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "organizacao"
  );
}

function failure(error: unknown, operation: string) {
  if (error instanceof SettingsConflictError)
    return Response.json(
      {
        error:
          "As configurações foram alteradas por outro usuário. Recarregue antes de salvar novamente.",
      },
      { status: 409, headers: NO_STORE },
    );
  if (error instanceof SettingsNotFoundError)
    return Response.json(
      { error: "Configurações da organização não encontradas." },
      { status: 404, headers: NO_STORE },
    );
  if (error instanceof SettingsInputError)
    return Response.json(
      { error: error.message },
      { status: error.status, headers: NO_STORE },
    );
  if (error instanceof CustomerInputError)
    return Response.json(
      { error: error.message },
      { status: 403, headers: NO_STORE },
    );
  if (error instanceof LicenseDeniedError)
    return Response.json(
      { error: error.message },
      { status: error.status, headers: NO_STORE },
    );
  if (error instanceof AuthError) return authErrorResponse(error);
  console.error(
    `settings center failed to ${operation}`,
    error instanceof Error ? error.name : "unknown",
  );
  return Response.json(
    { error: `Não foi possível ${operation} as configurações.` },
    { status: 500, headers: NO_STORE },
  );
}
