import { randomUUID } from "node:crypto";
import type { Prisma } from "@/generated/tenant/client";
import { currentOrganization, tenantDb } from "@/db";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import { assertSameOrigin, CustomerInputError } from "@/lib/erp/customer-input";
import {
  hashPosAdminInput,
  parsePosAdminInput,
  PosAdminError,
  type PosAdminInput,
  type PosAdminJson,
} from "@/lib/erp/pos-admin";
import {
  assertPosMutationRequest,
  enforcePosRateLimit,
  PosHttpError,
  readPosJson,
} from "@/lib/erp/pos-http";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { posAdminCapabilities } from "@/lib/erp/pos-admin-capabilities";
import { assertTenantWriteAccess } from "@/lib/tenant-access";

type Db = Awaited<ReturnType<typeof tenantDb>>;
type Tx = Prisma.TransactionClient;
type AdminAccess = Awaited<ReturnType<typeof adminAccess>>;
type MutationResult = {
  entityType: string;
  entityId: string;
  status: number;
  body: Record<string, unknown>;
  beforeData?: Record<string, unknown>;
};

const registerInclude = {
  terminals: {
    include: {
      devices: {
        orderBy: [{ type: "asc" as const }, { name: "asc" as const }],
      },
    },
    orderBy: { name: "asc" as const },
  },
  connectors: {
    orderBy: [{ type: "asc" as const }, { provider: "asc" as const }],
  },
  _count: { select: { accesses: true, sessions: true } },
} satisfies Prisma.PosRegisterInclude;

export async function GET(request: Request) {
  try {
    const access = await adminAccess();
    const branch = await selectedBranch(
      access.db,
      access.actor.user.id,
      new URL(request.url).searchParams.get("branchId"),
    );
    const [registers, branchConnectors, warehouses] = await Promise.all([
      access.db.posRegister.findMany({
        where: { branchId: branch.id },
        include: registerInclude,
        orderBy: [{ status: "asc" }, { name: "asc" }],
      }),
      access.db.posConnector.findMany({
        where: { branchId: branch.id, registerId: null },
        orderBy: [{ type: "asc" }, { provider: "asc" }],
      }),
      access.db.warehouse.findMany({
        where: { branchId: branch.id, active: true },
        select: { id: true, code: true, name: true, primary: true },
        orderBy: [{ primary: "desc" }, { name: "asc" }],
      }),
    ]);
    const operationalProfile = await access.db.tenantUserProfile.findUnique({
      where: { userId: access.actor.user.id },
      select: { status: true },
    });
    const capabilities = posAdminCapabilities({
      modules: access.actor.membership.organization.modules,
      role: access.actor.membership.role,
      permissions: access.actor.permissions,
      activeOperationalProfile: operationalProfile?.status === "active",
    });
    return Response.json(
      {
        branch: {
          id: branch.id,
          code: branch.code,
          name: branch.name,
          status: branch.status,
        },
        capabilities,
        warehouses,
        registers: registers.map(registerDto),
        branchConnectors: branchConnectors.map(connectorDto),
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    assertPosMutationRequest(request);
    const access = await adminAccess();
    await assertTenantWriteAccess(access.organizationId);
    const input = parsePosAdminInput(await readPosJson(request, 65_536));
    await enforcePosRateLimit(
      access.db,
      access.actor.user.id,
      `admin:${input.action}`,
    );
    return executeIdempotent(access, input);
  } catch (error) {
    return failure(error);
  }
}

async function adminAccess() {
  const organization = await currentOrganization();
  const actor = await assertTenantPermission(organization.id, "pdv.write");
  if (!["owner", "admin"].includes(actor.membership.role))
    throw new PosAdminError(
      "Somente proprietários e administradores podem configurar caixas e terminais.",
      403,
    );
  return {
    organizationId: organization.id,
    actor,
    db: await tenantDb(organization.id),
  };
}

async function selectedBranch(
  db: Db,
  actorId: string,
  rawBranchId: string | null,
) {
  const branchId =
    rawBranchId == null || rawBranchId === ""
      ? null
      : positiveId(rawBranchId, "Filial");
  if (branchId) {
    const branch = await db.branch.findUnique({
      where: { id: branchId },
      select: { id: true, code: true, name: true, status: true },
    });
    if (!branch) throw new PosAdminError("Filial não encontrada.", 404);
    return branch;
  }
  const profile = await db.tenantUserProfile.findUnique({
    where: { userId: actorId },
    select: {
      activeBranch: {
        select: { id: true, code: true, name: true, status: true },
      },
    },
  });
  const branch =
    profile?.activeBranch ||
    (await db.branch.findFirst({
      orderBy: [{ primary: "desc" }, { id: "asc" }],
      select: { id: true, code: true, name: true, status: true },
    }));
  if (!branch)
    throw new PosAdminError(
      "Cadastre uma filial antes de configurar o PDV.",
      409,
    );
  return branch;
}

async function executeIdempotent(access: AdminAccess, input: PosAdminInput) {
  const requestHash = hashPosAdminInput(input);
  const existing = await access.db.pdvAdminMutation.findUnique({
    where: { key: input.idempotencyKey },
  });
  if (existing)
    return replay(existing, access.actor.user.id, input.action, requestHash);
  const correlationId = randomUUID();
  try {
    const completed = await access.db.$transaction(
      async (tx) => {
        await tx.pdvAdminMutation.create({
          data: {
            key: input.idempotencyKey,
            actorId: access.actor.user.id,
            action: input.action,
            requestHash,
            expiresAt: new Date(Date.now() + 30 * 86400000),
          },
        });
        const result = await mutate(tx, input);
        const responseBody = jsonObject({
          ...result.body,
          correlationId,
          replayed: false,
        });
        await tx.tenantAuditEvent.create({
          data: {
            actorId: access.actor.user.id,
            action: `pos.admin.${input.action}`,
            entityType: result.entityType,
            entityId: result.entityId,
            correlationId,
            beforeData: result.beforeData
              ? jsonObject(result.beforeData)
              : undefined,
            afterData: jsonObject({
              ...result.body,
              idempotencyKey: input.idempotencyKey,
              requestHash,
            }),
          },
        });
        await tx.pdvAdminMutation.update({
          where: { key: input.idempotencyKey },
          data: {
            state: "completed",
            entityType: result.entityType,
            entityId: result.entityId,
            responseStatus: result.status,
            responseBody,
          },
        });
        return { status: result.status, body: responseBody };
      },
      { isolationLevel: "Serializable" },
    );
    return Response.json(completed.body, { status: completed.status });
  } catch (error) {
    if (prismaCode(error) === "P2002" || prismaCode(error) === "P2034") {
      const concurrent = await access.db.pdvAdminMutation.findUnique({
        where: { key: input.idempotencyKey },
      });
      if (concurrent)
        return replay(
          concurrent,
          access.actor.user.id,
          input.action,
          requestHash,
        );
    }
    throw error;
  }
}

function replay(
  record: {
    actorId: string;
    action: string;
    requestHash: string;
    state: string;
    responseStatus: number | null;
    responseBody: Prisma.JsonValue | null;
  },
  actorId: string,
  action: string,
  requestHash: string,
) {
  // prettier-ignore
  if (record.actorId !== actorId || record.action !== action || record.requestHash !== requestHash)
    throw new PosAdminError(
      "A chave de idempotência já foi usada com outro contexto ou payload.",
      409,
    );
  if (
    record.state !== "completed" ||
    record.responseStatus == null ||
    !record.responseBody ||
    typeof record.responseBody !== "object" ||
    Array.isArray(record.responseBody)
  )
    throw new PosAdminError(
      "A operação com esta chave ainda está em processamento.",
      409,
    );
  return Response.json(
    { ...(record.responseBody as Record<string, unknown>), replayed: true },
    {
      status: record.responseStatus,
      headers: { "idempotency-replayed": "true" },
    },
  );
}

async function mutate(tx: Tx, input: PosAdminInput): Promise<MutationResult> {
  if (input.action === "register.create") {
    await activeBranch(tx, input.branchId);
    await validWarehouse(tx, input.branchId, input.warehouseId);
    const created = await tx.posRegister.create({
      data: {
        branchId: input.branchId,
        warehouseId: input.warehouseId,
        code: input.code,
        name: input.name,
        settings: prismaJson(input.settings),
      },
      include: registerInclude,
    });
    return {
      entityType: "pos_register",
      entityId: String(created.id),
      status: 201,
      body: { register: registerDto(created) },
    };
  }
  if (input.action === "register.update") {
    const before = await register(tx, input.registerId);
    if ("warehouseId" in input)
      await validWarehouse(tx, before.branchId, input.warehouseId ?? null);
    const updated = await tx.posRegister.update({
      where: { id: before.id },
      data: {
        ...defined(input, ["warehouseId", "code", "name"]),
        ...(input.settings ? { settings: prismaJson(input.settings) } : {}),
      },
      include: registerInclude,
    });
    return {
      entityType: "pos_register",
      entityId: String(updated.id),
      status: 200,
      beforeData: { register: registerDto(before) },
      body: { register: registerDto(updated) },
    };
  }
  if (input.action === "register.deactivate") {
    const before = await register(tx, input.registerId);
    const activeSessions = await tx.cashRegisterSession.count({
      where: { registerId: before.id, status: { in: ["open", "closing"] } },
    });
    if (activeSessions)
      throw new PosAdminError(
        "Feche o turno deste caixa antes de desativá-lo.",
        409,
      );
    await tx.posRegisterAccess.updateMany({
      where: { registerId: before.id, active: true },
      data: { active: false },
    });
    const terminalIds = (
      await tx.posTerminal.findMany({
        where: { registerId: before.id },
        select: { id: true },
      })
    ).map((item) => item.id);
    if (terminalIds.length)
      await tx.posDevice.updateMany({
        where: { terminalId: { in: terminalIds } },
        data: { status: "disabled" },
      });
    await tx.posTerminal.updateMany({
      where: { registerId: before.id },
      data: {
        status: "revoked",
        tokenHash: null,
        tokenIssuedAt: null,
        tokenExpiresAt: null,
        certificateFingerprint: null,
        offlineAllowedUntil: null,
        revokedAt: new Date(),
      },
    });
    await tx.posConnector.updateMany({
      where: { registerId: before.id },
      data: { status: "inactive" },
    });
    const updated = await tx.posRegister.update({
      where: { id: before.id },
      data: { status: "inactive" },
      include: registerInclude,
    });
    return {
      entityType: "pos_register",
      entityId: String(updated.id),
      status: 200,
      beforeData: { register: registerDto(before) },
      body: {
        register: registerDto(updated),
        cascaded: {
          accessesDisabled: true,
          terminalsRevoked: terminalIds.length,
          connectorsDisabled: true,
        },
      },
    };
  }
  if (input.action === "terminal.create") {
    await activeRegister(tx, input.registerId);
    const created = await tx.posTerminal.create({
      data: {
        registerId: input.registerId,
        code: input.code,
        name: input.name,
        status: "unpaired",
        settings: prismaJson(input.settings),
      },
      include: { devices: true },
    });
    return {
      entityType: "pos_terminal",
      entityId: created.id,
      status: 201,
      body: { terminal: terminalDto(created) },
    };
  }
  if (input.action === "terminal.update") {
    const before = await terminal(tx, input.terminalId);
    if (input.registerId != null && input.registerId !== before.registerId) {
      if (before.status !== "unpaired")
        throw new PosAdminError(
          "Revogue o terminal pareado antes de alterar seu vínculo de caixa.",
          409,
        );
      await activeRegister(tx, input.registerId);
    }
    const updated = await tx.posTerminal.update({
      where: { id: before.id },
      data: {
        ...defined(input, ["registerId", "code", "name"]),
        ...(input.settings ? { settings: prismaJson(input.settings) } : {}),
      },
      include: { devices: true },
    });
    return {
      entityType: "pos_terminal",
      entityId: updated.id,
      status: 200,
      beforeData: { terminal: terminalDto(before) },
      body: { terminal: terminalDto(updated) },
    };
  }
  if (input.action === "terminal.deactivate") {
    const before = await terminal(tx, input.terminalId);
    await tx.posDevice.updateMany({
      where: { terminalId: before.id },
      data: { status: "disabled" },
    });
    const updated = await tx.posTerminal.update({
      where: { id: before.id },
      data: {
        status: "revoked",
        tokenHash: null,
        tokenIssuedAt: null,
        tokenExpiresAt: null,
        certificateFingerprint: null,
        offlineAllowedUntil: null,
        revokedAt: before.revokedAt || new Date(),
      },
      include: { devices: true },
    });
    return {
      entityType: "pos_terminal",
      entityId: updated.id,
      status: 200,
      beforeData: { terminal: terminalDto(before) },
      body: { terminal: terminalDto(updated) },
    };
  }
  if (input.action === "device.create") {
    await usableTerminal(tx, input.terminalId);
    const created = await tx.posDevice.create({
      data: {
        terminalId: input.terminalId,
        type: input.type,
        name: input.name,
        provider: input.provider,
        vendorId: input.vendorId,
        productId: input.productId,
        serialNumber: input.serialNumber,
        status: "unknown",
        capabilities: prismaJson(input.capabilities),
        settings: prismaJson(input.settings),
      },
    });
    return {
      entityType: "pos_device",
      entityId: created.id,
      status: 201,
      body: { device: deviceDto(created) },
    };
  }
  if (input.action === "device.update") {
    const before = await device(tx, input.deviceId);
    if (input.terminalId && input.terminalId !== before.terminalId) {
      if (!["unknown", "disabled"].includes(before.status))
        throw new PosAdminError(
          "Desative o dispositivo antes de alterar seu terminal.",
          409,
        );
      await usableTerminal(tx, input.terminalId);
    }
    const updated = await tx.posDevice.update({
      where: { id: before.id },
      data: {
        ...defined(input, [
          "terminalId",
          "type",
          "name",
          "provider",
          "vendorId",
          "productId",
          "serialNumber",
        ]),
        ...(input.capabilities
          ? { capabilities: prismaJson(input.capabilities) }
          : {}),
        ...(input.settings ? { settings: prismaJson(input.settings) } : {}),
      },
    });
    return {
      entityType: "pos_device",
      entityId: updated.id,
      status: 200,
      beforeData: { device: deviceDto(before) },
      body: { device: deviceDto(updated) },
    };
  }
  if (input.action === "device.deactivate") {
    const before = await device(tx, input.deviceId);
    const updated = await tx.posDevice.update({
      where: { id: before.id },
      data: { status: "disabled", lastError: null },
    });
    return {
      entityType: "pos_device",
      entityId: updated.id,
      status: 200,
      beforeData: { device: deviceDto(before) },
      body: { device: deviceDto(updated) },
    };
  }
  if (input.action === "connector.create") {
    await activeBranch(tx, input.branchId);
    await connectorRegister(tx, input.branchId, input.registerId);
    await connectorCredential(tx, input.provider, input.credentialRef);
    await uniqueConnectorLink(
      tx,
      input.branchId,
      input.registerId,
      input.type,
      input.provider,
    );
    const created = await tx.posConnector.create({
      data: {
        branchId: input.branchId,
        registerId: input.registerId,
        type: input.type,
        provider: input.provider,
        mode: input.mode,
        credentialRef: input.credentialRef,
        status: "inactive",
        settings: prismaJson(input.settings),
      },
    });
    return {
      entityType: "pos_connector",
      entityId: created.id,
      status: 201,
      body: { connector: connectorDto(created) },
    };
  }
  if (input.action === "connector.update") {
    const before = await connector(tx, input.connectorId);
    if (before.status !== "inactive")
      throw new PosAdminError(
        "Desative o conector antes de alterar sua configuração.",
        409,
      );
    const nextRegisterId =
      "registerId" in input ? (input.registerId ?? null) : before.registerId;
    const nextProvider = input.provider ?? before.provider;
    const nextCredentialRef =
      "credentialRef" in input
        ? (input.credentialRef ?? null)
        : before.credentialRef;
    await connectorRegister(tx, before.branchId, nextRegisterId);
    await connectorCredential(tx, nextProvider, nextCredentialRef);
    await uniqueConnectorLink(
      tx,
      before.branchId,
      nextRegisterId,
      input.type ?? before.type,
      nextProvider,
      before.id,
    );
    const updated = await tx.posConnector.update({
      where: { id: before.id },
      data: {
        ...defined(input, [
          "registerId",
          "type",
          "provider",
          "mode",
          "credentialRef",
        ]),
        ...(input.settings ? { settings: prismaJson(input.settings) } : {}),
      },
    });
    return {
      entityType: "pos_connector",
      entityId: updated.id,
      status: 200,
      beforeData: { connector: connectorDto(before) },
      body: { connector: connectorDto(updated) },
    };
  }
  const before = await connector(tx, input.connectorId);
  if (input.action === "connector.activate") {
    if (before.status === "active")
      return {
        entityType: "pos_connector",
        entityId: before.id,
        status: 200,
        body: { connector: connectorDto(before) },
      };
    if (!before.credentialRef)
      throw new PosAdminError(
        "Vincule uma conta de pagamento antes de ativar a rota.",
        422,
      );
    const credential = await tx.integrationCredential.findFirst({
      where: {
        id: before.credentialRef,
        providerId: before.provider,
        enabled: true,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      include: { provider: { select: { family: true } } },
    });
    if (!credential || credential.provider.family !== "payment")
      throw new PosAdminError(
        "A conta de pagamento vinculada está inativa ou incompatível.",
        422,
      );
    if (credential.lastTestOk !== true)
      throw new PosAdminError(
        "Teste a conta de pagamento com sucesso antes de ativar a rota.",
        422,
      );
    if (
      !credential.lastTestAt ||
      credential.lastTestAt < new Date(Date.now() - 24 * 60 * 60 * 1000)
    )
      throw new PosAdminError(
        "Refaça o teste da conta: a verificação precisa ter ocorrido nas últimas 24 horas.",
        422,
      );
    const updated = await tx.posConnector.update({
      where: { id: before.id },
      data: {
        status: "active",
        lastHealthOk: true,
        lastCheckedAt: credential.lastTestAt || new Date(),
      },
    });
    return {
      entityType: "pos_connector",
      entityId: updated.id,
      status: 200,
      beforeData: { connector: connectorDto(before) },
      body: { connector: connectorDto(updated) },
    };
  }
  const updated = await tx.posConnector.update({
    where: { id: before.id },
    data: { status: "inactive" },
  });
  return {
    entityType: "pos_connector",
    entityId: updated.id,
    status: 200,
    beforeData: { connector: connectorDto(before) },
    body: { connector: connectorDto(updated) },
  };
}

async function activeBranch(tx: Tx, id: number) {
  const value = await tx.branch.findFirst({ where: { id, status: "active" } });
  if (!value) throw new PosAdminError("Filial ativa não encontrada.", 404);
  return value;
}
async function register(tx: Tx, id: number) {
  const value = await tx.posRegister.findUnique({
    where: { id },
    include: registerInclude,
  });
  if (!value) throw new PosAdminError("Caixa não encontrado.", 404);
  return value;
}
async function activeRegister(tx: Tx, id: number) {
  const value = await tx.posRegister.findFirst({
    where: { id, status: "active", branch: { status: "active" } },
  });
  if (!value) throw new PosAdminError("Caixa ativo não encontrado.", 404);
  return value;
}
async function terminal(tx: Tx, id: string) {
  const value = await tx.posTerminal.findUnique({
    where: { id },
    include: { devices: true },
  });
  if (!value) throw new PosAdminError("Terminal não encontrado.", 404);
  return value;
}
async function usableTerminal(tx: Tx, id: string) {
  const value = await tx.posTerminal.findFirst({
    where: {
      id,
      status: { not: "revoked" },
      register: { status: "active", branch: { status: "active" } },
    },
  });
  if (!value)
    throw new PosAdminError("Terminal disponível não encontrado.", 404);
  return value;
}
async function device(tx: Tx, id: string) {
  const value = await tx.posDevice.findUnique({ where: { id } });
  if (!value) throw new PosAdminError("Dispositivo não encontrado.", 404);
  return value;
}
async function connector(tx: Tx, id: string) {
  const value = await tx.posConnector.findUnique({ where: { id } });
  if (!value) throw new PosAdminError("Conector não encontrado.", 404);
  return value;
}

async function validWarehouse(
  tx: Tx,
  branchId: number,
  warehouseId: number | null,
) {
  if (warehouseId == null) return;
  if (
    !(await tx.warehouse.findFirst({
      where: { id: warehouseId, branchId, active: true },
    }))
  )
    throw new PosAdminError(
      "O depósito deve estar ativo e vinculado à mesma filial.",
    );
}

async function connectorRegister(
  tx: Tx,
  branchId: number,
  registerId: number | null,
) {
  if (registerId == null) return;
  if (
    !(await tx.posRegister.findFirst({
      where: { id: registerId, branchId, status: "active" },
    }))
  )
    throw new PosAdminError(
      "O caixa do conector deve estar ativo e pertencer à mesma filial.",
    );
}

async function connectorCredential(
  tx: Tx,
  provider: string,
  credentialRef: string | null,
) {
  if (!credentialRef) return;
  if (
    !(await tx.integrationCredential.findFirst({
      where: {
        id: credentialRef,
        providerId: provider,
        enabled: true,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    }))
  )
    throw new PosAdminError(
      "A credencial deve existir, estar ativa, vigente e pertencer ao mesmo provider.",
    );
}

async function uniqueConnectorLink(
  tx: Tx,
  branchId: number,
  registerId: number | null,
  type: string,
  provider: string,
  excludeId?: string,
) {
  const duplicate = await tx.posConnector.findFirst({
    where: {
      branchId,
      registerId,
      type,
      provider,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true },
  });
  if (duplicate)
    throw new PosAdminError(
      "Já existe um conector deste tipo e provider para o mesmo escopo.",
      409,
    );
}

function registerDto(value: Record<string, unknown>) {
  return {
    id: value.id,
    branchId: value.branchId,
    warehouseId: value.warehouseId,
    code: value.code,
    name: value.name,
    status: value.status,
    settings: value.settings,
    terminals: Array.isArray(value.terminals)
      ? value.terminals.map((item) =>
          terminalDto(item as Record<string, unknown>),
        )
      : undefined,
    connectors: Array.isArray(value.connectors)
      ? value.connectors.map((item) =>
          connectorDto(item as Record<string, unknown>),
        )
      : undefined,
    counts: value._count,
  };
}

function terminalDto(value: Record<string, unknown>) {
  return {
    id: value.id,
    registerId: value.registerId,
    code: value.code,
    name: value.name,
    status: value.status,
    settings: value.settings,
    appVersion: value.appVersion,
    lastSeenAt: value.lastSeenAt,
    offlineAllowedUntil: value.offlineAllowedUntil,
    pairedAt: value.pairedAt,
    revokedAt: value.revokedAt,
    credentialVersion: value.credentialVersion,
    tokenExpiresAt: value.tokenExpiresAt,
    paired: Boolean(value.pairedAt) && value.status !== "revoked",
    devices: Array.isArray(value.devices)
      ? value.devices.map((item) => deviceDto(item as Record<string, unknown>))
      : undefined,
  };
}

function deviceDto(value: Record<string, unknown>) {
  return {
    id: value.id,
    terminalId: value.terminalId,
    type: value.type,
    name: value.name,
    provider: value.provider,
    vendorId: value.vendorId,
    productId: value.productId,
    serialNumber: value.serialNumber,
    status: value.status,
    capabilities: value.capabilities,
    settings: value.settings,
    lastError: value.lastError,
    lastSeenAt: value.lastSeenAt,
  };
}

function connectorDto(value: Record<string, unknown>) {
  return {
    id: value.id,
    branchId: value.branchId,
    registerId: value.registerId,
    type: value.type,
    provider: value.provider,
    mode: value.mode,
    status: value.status,
    credentialConfigured: Boolean(value.credentialRef),
    settings: value.settings,
    lastHealthOk: value.lastHealthOk,
    lastCheckedAt: value.lastCheckedAt,
  };
}

function defined(input: Record<string, unknown>, fields: string[]) {
  return Object.fromEntries(
    fields
      .filter((field) => Object.prototype.hasOwnProperty.call(input, field))
      .map((field) => [field, input[field]]),
  );
}
function prismaJson(value: PosAdminJson | undefined) {
  return value as Prisma.InputJsonObject | undefined;
}
function jsonObject(value: Record<string, unknown>) {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
}
function positiveId(value: unknown, label: string) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0)
    throw new PosAdminError(`${label} inválida.`);
  return result;
}
function prismaCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : "";
}

function failure(error: unknown) {
  if (error instanceof PosHttpError || error instanceof PosAdminError)
    return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof CustomerInputError)
    return Response.json(
      { error: error.message },
      { status: error.message.includes("Origem") ? 403 : 422 },
    );
  if (error instanceof LicenseDeniedError)
    return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof AuthError) return authErrorResponse(error);
  if (prismaCode(error) === "P2002")
    return Response.json(
      { error: "Já existe um recurso com esta identificação ou vínculo." },
      { status: 409 },
    );
  if (prismaCode(error) === "P2034")
    return Response.json(
      {
        error:
          "Conflito concorrente. Atualize a configuração e tente novamente.",
      },
      { status: 409 },
    );
  console.error("POS admin operation failed", { error: error instanceof Error ? error.name : typeof error });
  return Response.json(
    { error: "Não foi possível concluir a configuração do PDV." },
    { status: 500 },
  );
}
