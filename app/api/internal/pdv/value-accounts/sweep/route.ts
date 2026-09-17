import { controlDb } from "@/db/control";
import { tenantDb } from "@/db/tenant";
import { enforcePosRateLimit, assertPosMutationRequest, PosHttpError, readPosJson } from "@/lib/erp/pos-http";
import { POS_VALUE_LIFECYCLE_ACTOR, sweepPosValueLifecycle } from "@/lib/erp/pos-value-lifecycle";
import { assertPosValueLifecycleJobAuthorization, parsePosValueLifecycleJobInput, PosValueLifecycleHttpError } from "@/lib/erp/pos-value-lifecycle-http";

const noStoreHeaders = { "cache-control": "no-store, max-age=0", expires: "0", pragma: "no-cache" };

export async function POST(request: Request) {
  try {
    assertPosValueLifecycleJobAuthorization(request);
    assertPosMutationRequest(request);
    const input = parsePosValueLifecycleJobInput(await readPosJson(request, 4_096));
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
    const selected = organizations.slice(0, input.organizationLimit), now = new Date();
    const results: Array<Record<string, unknown>> = [];
    let failed = false;
    for (const organization of selected) {
      try {
        const db = await tenantDb(organization.id);
        // Maintenance of an existing financial liability must continue even when
        // interactive writes are unavailable; authentication and rate limiting stay mandatory.
        await enforcePosRateLimit(db, POS_VALUE_LIFECYCLE_ACTOR, "value.lifecycle.sweep");
        const result = await sweepPosValueLifecycle(db, { now, batchSize: input.itemLimit });
        results.push({ organizationId: organization.id, status: "completed", ...result });
      } catch (error) {
        failed = true;
        results.push({ organizationId: organization.id, status: "failed", errorCode: safeJobErrorCode(error) });
      }
    }
    const nextCursor = !failed && hasMoreOrganizations && selected.length ? selected[selected.length - 1].id : null;
    return Response.json({
      ok: !failed,
      processedOrganizations: selected.length,
      hasMoreOrganizations,
      nextCursor,
      results,
    }, { status: failed ? 503 : 200, headers: noStoreHeaders });
  } catch (error) {
    return failure(error);
  }
}

function safeJobErrorCode(error: unknown) {
  if (error instanceof PosHttpError && error.status === 429) return "RATE_LIMITED";
  const code = prismaCode(error);
  if (code === "P2034") return "SERIALIZATION_CONFLICT";
  if (code.startsWith("P")) return "DATABASE_ERROR";
  return "TENANT_JOB_FAILED";
}

function failure(error: unknown) {
  if (error instanceof PosValueLifecycleHttpError || error instanceof PosHttpError) return Response.json({ error: error.message }, { status: error.status, headers: noStoreHeaders });
  return Response.json({ error: "Não foi possível executar o ciclo interno de valores." }, { status: 500, headers: noStoreHeaders });
}

function prismaCode(error: unknown) {
  return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code || "") : "";
}
