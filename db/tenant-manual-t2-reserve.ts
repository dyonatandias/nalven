import { PosManualT2ReserveClient } from "@/lib/erp/pos-manual-t2-reserve";
import { tenantRuntimeDatabaseConnectionString } from "@/db/tenant";

const reserveClients = new Map<string, Promise<PosManualT2ReserveClient>>();

/**
 * Isolated from the general Prisma pool: every checkout starts with the
 * SERIALIZABLE reserve startup options and executes only a single capability
 * SELECT in autocommit.
 */
export function tenantManualT2ReserveClient(organizationId: string): Promise<PosManualT2ReserveClient> {
  const organization = normalizedOrganizationId(organizationId);
  const cached = reserveClients.get(organization);
  if (cached) return cached;
  const created = tenantRuntimeDatabaseConnectionString(organization)
    .then((connectionString) => PosManualT2ReserveClient.dedicated({ connectionString }))
    .catch((error) => {
      reserveClients.delete(organization);
      throw error;
    });
  reserveClients.set(organization, created);
  return created;
}

export async function closeTenantManualT2ReserveClient(organizationId: string): Promise<void> {
  const organization = normalizedOrganizationId(organizationId);
  const client = reserveClients.get(organization);
  reserveClients.delete(organization);
  if (client) await (await client).close();
}

function normalizedOrganizationId(value: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(value)) throw new Error("T2_RESERVE_ORGANIZATION_INVALID");
  return value;
}
