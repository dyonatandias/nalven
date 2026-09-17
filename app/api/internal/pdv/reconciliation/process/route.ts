import { controlDb } from "@/db/control";
import { tenantDb } from "@/db/tenant";
import { assertPosMutationRequest, enforcePosRateLimit, PosHttpError, readPosJson } from "@/lib/erp/pos-http";
import { POS_RECONCILIATION_JOB_ACTOR, processPendingPosReconciliationBatches } from "@/lib/erp/pos-reconciliation-persistence";
import { assertPosReconciliationJobAuthorization, parsePosReconciliationJobInput, PosReconciliationHttpError } from "@/lib/erp/pos-reconciliation-http";

const noStoreHeaders = { "cache-control": "no-store, max-age=0", expires: "0", pragma: "no-cache" };

export async function POST(request: Request) {
  try {
    assertPosReconciliationJobAuthorization(request);
    assertPosMutationRequest(request);
    const input = parsePosReconciliationJobInput(await readPosJson(request, 4_096));
    const organizations = await controlDb.organization.findMany({
      where: {
        status: { in: ["active", "trial"] }, database: { status: "active" },
        ...(input.afterOrganizationId ? { id: { gt: input.afterOrganizationId } } : {}),
      },
      select: { id: true }, orderBy: { id: "asc" }, take: input.organizationLimit + 1,
    });
    const hasMoreOrganizations = organizations.length > input.organizationLimit, selected = organizations.slice(0, input.organizationLimit);
    const results: Array<Record<string, unknown>> = [];
    let failed = false;
    for (const organization of selected) {
      try {
        const db = await tenantDb(organization.id);
        // Reconciliation of already captured money remains available during a write-license incident.
        await enforcePosRateLimit(db, POS_RECONCILIATION_JOB_ACTOR, "reconciliation.process");
        results.push({ organizationId: organization.id, status: "completed", ...await processPendingPosReconciliationBatches(db, { batchSize: input.batchLimit }) });
      } catch (error) {
        failed = true;
        results.push({ organizationId: organization.id, status: "failed", errorCode: safeErrorCode(error) });
      }
    }
    const nextCursor = !failed && hasMoreOrganizations && selected.length ? selected.at(-1)!.id : null;
    return Response.json({ ok: !failed, processedOrganizations: selected.length, hasMoreOrganizations, nextCursor, results }, { status: failed ? 503 : 200, headers: noStoreHeaders });
  } catch (error) {
    if (error instanceof PosReconciliationHttpError || error instanceof PosHttpError) return Response.json({ error: error.message }, { status: error.status, headers: noStoreHeaders });
    return Response.json({ error: "Não foi possível processar a conciliação interna." }, { status: 500, headers: noStoreHeaders });
  }
}

function safeErrorCode(error: unknown) {
  if (error instanceof PosHttpError && error.status === 429) return "RATE_LIMITED";
  const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code || "") : "";
  if (code === "P2034") return "SERIALIZATION_CONFLICT";
  return code.startsWith("P") ? "DATABASE_ERROR" : "TENANT_JOB_FAILED";
}
