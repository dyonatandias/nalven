import { controlDb } from "@/db/control";
import { tenantDb } from "@/db/tenant";
import { maintainPosFiscalPersistence } from "@/lib/erp/pos-fiscal-persistence";
import { assertPosFiscalJobAuthorization, fiscalHttpFailure, parsePosFiscalMaintenanceJobInput } from "@/lib/erp/pos-fiscal-http";
import { assertPosMutationRequest, enforcePosRateLimit, readPosJson } from "@/lib/erp/pos-http";

const noStoreHeaders = { "cache-control": "no-store, max-age=0", expires: "0", pragma: "no-cache" };

export async function POST(request: Request) {
  try {
    assertPosFiscalJobAuthorization(request);
    assertPosMutationRequest(request);
    const input = parsePosFiscalMaintenanceJobInput(await readPosJson(request, 4_096));
    const organizations = await controlDb.organization.findMany({
      where: {
        status: { in: ["active", "trial"] },
        database: { status: "active" },
        ...(input.afterOrganizationId ? { id: { gt: input.afterOrganizationId } } : {}),
      },
      select: { id: true },
      orderBy: { id: "asc" },
      take: input.organizationLimit + 1,
    });
    const hasMoreOrganizations = organizations.length > input.organizationLimit;
    const selected = organizations.slice(0, input.organizationLimit);
    const results: Array<Record<string, unknown>> = [];
    let failed = false;
    for (const organization of selected) {
      try {
        const db = await tenantDb(organization.id);
        await enforcePosRateLimit(db, "system:pos-fiscal-maintenance", "fiscal.maintenance");
        results.push({ organizationId: organization.id, status: "completed", ...await maintainPosFiscalPersistence(db, { batchSize: input.itemLimit }) });
      } catch (error) {
        failed = true;
        results.push({ organizationId: organization.id, status: "failed", errorCode: safeErrorCode(error) });
      }
    }
    const nextCursor = !failed && hasMoreOrganizations && selected.length ? selected.at(-1)!.id : null;
    return Response.json({ ok: !failed, processedOrganizations: selected.length, hasMoreOrganizations, nextCursor, results }, { status: failed ? 503 : 200, headers: noStoreHeaders });
  } catch (error) {
    return fiscalHttpFailure(error);
  }
}

function safeErrorCode(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code || "") : "";
  if (["P2034", "40001", "40P01"].includes(code)) return "SERIALIZATION_CONFLICT";
  return code.startsWith("P") ? "DATABASE_ERROR" : "TENANT_JOB_FAILED";
}
