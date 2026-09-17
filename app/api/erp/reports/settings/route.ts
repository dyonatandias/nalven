import { AuthError } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/erp/customer-input";
import { FISCAL_FIELDS, ReportInputError } from "@/lib/erp/report-domain";
import { privateJson, reportContext, reportFailure } from "@/lib/erp/report-server";
import { assertTenantWriteAccess } from "@/lib/tenant-access";
import { invalidateMarginReportCache } from "@/lib/erp/report-cache";
import { readJsonObject } from "@/lib/http-security";

function decimal(value: unknown, label: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) throw new ReportInputError(`${label} deve estar entre 0 e 100.`);
  return parsed.toFixed(2);
}

function cost(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 999_999_999.99) throw new ReportInputError("Valor de custo inválido.");
  return parsed.toFixed(2);
}

export async function GET() {
  try {
    const { db } = await reportContext("reports.read");
    const [settings, categories] = await Promise.all([
      db.reportSettings.findUnique({ where: { id: 1 }, include: { globalCosts: { orderBy: { id: "asc" } }, categoryOverrides: true } }),
      db.category.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    ]);
    return privateJson({ settings: settings || { id: 1, pricingMode: "mixed", globalTargetMargin: 30, globalMinimumMargin: 15, fiscalRequiredFields: [...FISCAL_FIELDS], globalCosts: [], categoryOverrides: [] }, categories });
  } catch (error) {
    if (error instanceof AuthError) return Response.json({ error: "Acesso negado." }, { status: error.status });
    return reportFailure(error);
  }
}

export async function PUT(request: Request) {
  try {
    assertSameOrigin(request);
    const { organization, access, db } = await reportContext("reports.write");
    await assertTenantWriteAccess(organization.id);
    const body = await readJsonObject(request, 1_048_576);
    const mode = String(body.pricingMode || "mixed");
    if (!["global", "product", "mixed"].includes(mode)) throw new ReportInputError("Modo de precificação inválido.");
    const globalCosts = Array.isArray(body.globalCosts) ? body.globalCosts : [];
    const overrides = Array.isArray(body.categoryOverrides) ? body.categoryOverrides : [];
    if (globalCosts.length > 100 || overrides.length > 1_000) throw new ReportInputError("Configuração excede o limite permitido.");
    const required = Array.isArray(body.fiscalRequiredFields) ? body.fiscalRequiredFields.map(String) : [...FISCAL_FIELDS];
    if (!required.length || required.some((item) => !FISCAL_FIELDS.includes(item as typeof FISCAL_FIELDS[number]))) throw new ReportInputError("Campos fiscais obrigatórios inválidos.");
    const categoryIds = overrides.map((item) => Number((item as Record<string, unknown>).categoryId));
    if (new Set(categoryIds).size !== categoryIds.length || categoryIds.some((id) => !Number.isInteger(id) || id < 1)) throw new ReportInputError("Categorias duplicadas ou inválidas.");
    const validCategories = categoryIds.length ? await db.category.count({ where: { id: { in: categoryIds }, active: true } }) : 0;
    if (validCategories !== categoryIds.length) throw new ReportInputError("Uma categoria configurada não existe mais.");
    const settings = await db.$transaction(async (tx) => {
      await tx.reportSettings.upsert({ where: { id: 1 }, update: { pricingMode: mode, globalTargetMargin: decimal(body.globalTargetMargin, "Margem alvo"), globalMinimumMargin: decimal(body.globalMinimumMargin, "Margem mínima"), fiscalRequiredFields: [...new Set(required)], updatedBy: access.user.name }, create: { id: 1, pricingMode: mode, globalTargetMargin: decimal(body.globalTargetMargin, "Margem alvo"), globalMinimumMargin: decimal(body.globalMinimumMargin, "Margem mínima"), fiscalRequiredFields: [...new Set(required)], updatedBy: access.user.name } });
      await Promise.all([tx.reportGlobalCost.deleteMany({ where: { reportSettingsId: 1 } }), tx.categoryPricingOverride.deleteMany({ where: { reportSettingsId: 1 } })]);
      if (globalCosts.length) await tx.reportGlobalCost.createMany({ data: globalCosts.map((raw) => { const item = raw as Record<string, unknown>; const label = String(item.label || "").trim().slice(0, 255); if (!label) throw new ReportInputError("Todo custo global precisa de descrição."); return { reportSettingsId: 1, type: item.type === "direct" ? "direct" : "indirect", label, value: cost(item.value) }; }) });
      if (overrides.length) await tx.categoryPricingOverride.createMany({ data: overrides.map((raw) => { const item = raw as Record<string, unknown>; return { reportSettingsId: 1, categoryId: Number(item.categoryId), targetMargin: decimal(item.targetMargin, "Margem alvo da categoria"), minimumMargin: decimal(item.minimumMargin, "Margem mínima da categoria") }; }) });
      await tx.tenantAuditEvent.create({ data: { actorId: access.user.id, action: "reports.settings_updated", entityType: "report_settings", entityId: "1", afterData: { pricingMode: mode, globalCosts: globalCosts.length, categoryOverrides: overrides.length, fiscalRequiredFields: required } } });
      return tx.reportSettings.findUniqueOrThrow({ where: { id: 1 }, include: { globalCosts: true, categoryOverrides: true } });
    });
    invalidateMarginReportCache();
    return Response.json({ settings });
  } catch (error) {
    if (error instanceof AuthError) return Response.json({ error: "Acesso negado." }, { status: error.status });
    return reportFailure(error);
  }
}
