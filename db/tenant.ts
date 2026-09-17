import { readFile } from "node:fs/promises";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/tenant/client";
import { controlDb } from "./control";

type TenantAuthority = "runtime" | "manualWorker" | "manualCallback" | "stepupIssuer" | "manualHomologator" | "manualVaultBinder";

const clients = new Map<string, PrismaClient>();

const authorityConfig: Record<TenantAuthority, { directory: string; variable: string; roleSuffix: string | null }> = {
  runtime: { directory: "/etc/nalven/tenants", variable: "TENANT_DATABASE_URL", roleSuffix: "_runtime" },
  manualWorker: { directory: "/etc/nalven/tenant-manual-workers", variable: "TENANT_MANUAL_WORKER_DATABASE_URL", roleSuffix: "_mw" },
  manualCallback: { directory: "/etc/nalven/tenant-manual-callbacks", variable: "TENANT_MANUAL_CALLBACK_DATABASE_URL", roleSuffix: "_mc" },
  stepupIssuer: { directory: "/etc/nalven/tenant-stepup-issuers", variable: "TENANT_STEPUP_ISSUER_DATABASE_URL", roleSuffix: "_si" },
  manualHomologator: { directory: "/etc/nalven/tenant-manual-homologators", variable: "TENANT_MANUAL_HOMOLOGATOR_DATABASE_URL", roleSuffix: "_mh" },
  manualVaultBinder: { directory: "/etc/nalven/tenant-manual-vault-binders", variable: "TENANT_MANUAL_VAULT_BINDER_DATABASE_URL", roleSuffix: "_mb" },
};

export async function tenantDb(organizationId: string) {
  return tenantAuthorityDb(organizationId, "runtime");
}

/** Server-only DSN handoff for the isolated T2 reserve executor. */
export async function tenantRuntimeDatabaseConnectionString(organizationId: string) {
  return tenantAuthorityConnectionString(organizationId, "runtime");
}

export async function tenantManualPaymentWorkerDb(organizationId: string) {
  return tenantAuthorityDb(organizationId, "manualWorker");
}

export async function tenantManualPaymentCallbackDb(organizationId: string) {
  return tenantAuthorityDb(organizationId, "manualCallback");
}

export async function tenantManualPaymentStepUpIssuerDb(organizationId: string) {
  return tenantAuthorityDb(organizationId, "stepupIssuer");
}

export async function tenantManualPaymentHomologatorDb(organizationId: string) {
  return tenantAuthorityDb(organizationId, "manualHomologator");
}

export async function tenantManualPaymentVaultBinderDb(organizationId: string) {
  return tenantAuthorityDb(organizationId, "manualVaultBinder");
}

async function tenantAuthorityDb(organizationId: string, authority: TenantAuthority) {
  const cacheKey = `${authority}:${organizationId}`;
  const cached = clients.get(cacheKey);
  if (cached) return cached;
  const connectionString = await tenantAuthorityConnectionString(organizationId, authority);
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  clients.set(cacheKey, client);
  return client;
}

async function tenantAuthorityConnectionString(organizationId: string, authority: TenantAuthority) {
  const record = await controlDb.tenantDatabase.findUnique({ where: { organizationId } });
  if (!record || record.status !== "active") throw new Error("Banco da organização indisponível");
  if (!/^[a-z0-9-]+$/.test(record.configKey)) throw new Error("Configuração de banco inválida");
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(record.databaseName)) throw new Error("Banco da organização inválido");
  const config = authorityConfig[authority];
  const content = await readFile(`${config.directory}/${record.configKey}.env`, "utf8");
  const prefix = `${config.variable}=`;
  const values = content.split("\n").filter((item) => item.startsWith(prefix));
  if (values.length !== 1) throw new Error(`Credencial ${authority} da organização não encontrada`);
  const connectionString = values[0]!.slice(prefix.length);
  assertAuthorityConnectionString(connectionString, record.databaseName, config.roleSuffix);
  return connectionString;
}

function assertAuthorityConnectionString(connectionString: string, databaseName: string, roleSuffix: string | null) {
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error("Credencial de banco da organização inválida");
  }
  const username = decodeURIComponent(parsed.username);
  const expectedRole = roleSuffix ? `${databaseName}${roleSuffix}` : null;
  if (!/^postgres(?:ql)?:$/.test(parsed.protocol)
      || parsed.hostname !== "127.0.0.1"
      || parsed.port !== "5432"
      || decodeURIComponent(parsed.pathname) !== `/${databaseName}`
      || !/^[a-z][a-z0-9_]{0,62}$/.test(username)
      || (expectedRole !== null && username !== expectedRole)
      || parsed.search !== ""
      || parsed.hash !== "") {
    throw new Error("Credencial de banco da organização não corresponde à autoridade esperada");
  }
}
