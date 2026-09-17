import { currentOrganization, tenantDb } from "@/db";
import { AuthError } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import { assertSameOrigin, CustomerInputError } from "@/lib/erp/customer-input";
import { assertPosMutationRequest, enforcePosRateLimit, PosHttpError, readPosJson } from "@/lib/erp/pos-http";
import { parsePosReconciliationAdminInput, PosReconciliationAdminError } from "@/lib/erp/pos-reconciliation-admin";
import { createPosReconciliationLayout, deactivatePosReconciliationLayout, importPosReconciliationBatch, posReconciliationReport, reprocessPosReconciliationBatch, updatePosReconciliationLayout } from "@/lib/erp/pos-reconciliation-persistence";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { csvFile } from "@/lib/erp/report-domain";
import { assertTenantWriteAccess } from "@/lib/tenant-access";

const noStoreHeaders = { "cache-control": "no-store, max-age=0", expires: "0", pragma: "no-cache" };

export async function GET(request: Request) {
  try {
    assertSameOrigin(request);
    const organization = await currentOrganization(), actor = await assertTenantPermission(organization.id, "reconciliation.read");
    assertAdmin(actor.membership.role);
    const query = parseQuery(new URL(request.url).searchParams), db = await tenantDb(organization.id);
    const branch = await db.branch.findFirst({ where: { id: query.branchId, status: "active" }, select: { id: true, code: true, name: true } });
    if (!branch) throw new PosReconciliationAdminError("Filial ativa não encontrada.", 404);
    await enforcePosRateLimit(db, actor.user.id, query.format === "csv" ? "reconciliation.export" : "reconciliation.report");
    const report = await posReconciliationReport(db, branch.id, query.limit);
    if (query.format === "csv") {
      const rows = report.batches.map(batch => [batch.id, batch.provider, batch.status, batch.version, batch.rowCount, batch.matchedCount, batch.issueCount, batch.productionBlocking ? "yes" : "no", batch.totals.grossCents, batch.totals.feeCents, batch.totals.netCents, batch.periodStart.toISOString(), batch.periodEnd.toISOString(), batch.createdAt.toISOString()]);
      return new Response(csvFile(["batch_id", "provider", "status", "version", "rows", "matched", "issues", "blocking", "gross_cents", "fee_cents", "net_cents", "period_start", "period_end", "created_at"], rows), { headers: { ...noStoreHeaders, "content-type": "text/csv; charset=utf-8", "content-disposition": "attachment; filename=pos-reconciliation-report.csv" } });
    }
    return Response.json({ branch, report }, { headers: noStoreHeaders });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    assertPosMutationRequest(request);
    const organization = await currentOrganization(), actor = await assertTenantPermission(organization.id, "reconciliation.write");
    assertAdmin(actor.membership.role);
    await assertTenantWriteAccess(organization.id);
    const db = await tenantDb(organization.id), input = parsePosReconciliationAdminInput(await readPosJson(request, 1_048_576));
    const rateAction = input.action.startsWith("layout.") ? "reconciliation.layout" : input.action === "batch.import" ? "reconciliation.import" : "reconciliation.reprocess";
    await enforcePosRateLimit(db, actor.user.id, rateAction);
    if (input.action === "layout.create") return Response.json(await createPosReconciliationLayout(db, input, actor.user.id), { status: 201, headers: noStoreHeaders });
    if (input.action === "layout.update") return Response.json(await updatePosReconciliationLayout(db, input, actor.user.id), { headers: noStoreHeaders });
    if (input.action === "layout.deactivate") return Response.json(await deactivatePosReconciliationLayout(db, input, actor.user.id), { headers: noStoreHeaders });
    if (input.action === "batch.import") return Response.json(await importPosReconciliationBatch(db, input, actor.user.id), { status: 201, headers: noStoreHeaders });
    return Response.json(await reprocessPosReconciliationBatch(db, input, actor.user.id), { headers: noStoreHeaders });
  } catch (error) {
    return failure(error);
  }
}

function parseQuery(parameters: URLSearchParams) {
  const allowed = new Set(["branchId", "limit", "format"]);
  for (const key of parameters.keys()) {
    if (!allowed.has(key)) throw new PosReconciliationAdminError(`Parâmetro não permitido: ${key}.`, 400);
    if (parameters.getAll(key).length !== 1) throw new PosReconciliationAdminError(`Parâmetro repetido: ${key}.`, 400);
  }
  const branch = parameters.get("branchId"), limitValue = parameters.get("limit"), format = parameters.get("format");
  if (!branch || !/^\d{1,10}$/.test(branch)) throw new PosReconciliationAdminError("Filial inválida.", 400);
  const branchId = Number(branch), limit = limitValue == null ? 25 : Number(limitValue);
  if (!Number.isSafeInteger(branchId) || branchId <= 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new PosReconciliationAdminError("Parâmetros do relatório inválidos.", 400);
  if (format != null && format !== "csv") throw new PosReconciliationAdminError("Formato de relatório inválido.", 400);
  return { branchId, limit, format };
}

function assertAdmin(role: string) {
  if (!(["owner", "admin"] as string[]).includes(role)) throw new PosReconciliationAdminError("Somente proprietários e administradores podem gerir a conciliação do PDV.", 403);
}

function failure(error: unknown) {
  if (error instanceof PosHttpError || error instanceof PosReconciliationAdminError) return Response.json({ error: error.message }, { status: error.status, headers: noStoreHeaders });
  if (error instanceof CustomerInputError) return Response.json({ error: error.message }, { status: error.message.includes("Origem") ? 403 : 422, headers: noStoreHeaders });
  if (error instanceof LicenseDeniedError) return Response.json({ error: error.message }, { status: error.status, headers: noStoreHeaders });
  if (error instanceof AuthError) return Response.json({ error: error.message }, { status: error.status, headers: noStoreHeaders });
  const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code || "") : "";
  if (code === "P2002") return Response.json({ error: "O layout ou arquivo já foi cadastrado." }, { status: 409, headers: noStoreHeaders });
  if (code === "P2034") return Response.json({ error: "Conflito concorrente na conciliação; tente novamente." }, { status: 409, headers: noStoreHeaders });
  console.error("POS reconciliation administration failed", { error: error instanceof Error ? error.name : typeof error });
  return Response.json({ error: "Não foi possível concluir a conciliação do PDV." }, { status: 500, headers: noStoreHeaders });
}
