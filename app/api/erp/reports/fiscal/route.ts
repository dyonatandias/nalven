import type { Prisma } from "@/generated/tenant/client";
import { AuthError } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/erp/customer-input";
import { FISCAL_FIELDS, ORIGIN_LABELS, REPORT_EXPORT_LIMIT, ReportInputError, csvFile, fiscalCompleteness, parsePage, validGtin, type FiscalField } from "@/lib/erp/report-domain";
import { csvResponse, guardReportExport, privateJson, reportContext, reportFailure } from "@/lib/erp/report-server";
import { assertTenantWriteAccess } from "@/lib/tenant-access";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { createPosT2BoundaryIdempotencyKey, preparePosT2CatalogBoundary, toPosT2BoundaryIdempotencyKey } from "@/lib/erp/pos-t2-boundary";
import { readJsonObject } from "@/lib/http-security";

export async function GET(request: Request) {
  try {
    const { organization, access, db, branchId } = await reportContext("reports.read");
    const params = new URL(request.url).searchParams;
    const { page, perPage } = parsePage(params, 50);
    const search = String(params.get("search") || "").trim().slice(0, 120);
    const onlyIncomplete = params.get("incomplete") === "true";
    const missingField = params.get("missing_field") || "";
    if (missingField && !FISCAL_FIELDS.includes(missingField as FiscalField)) throw new ReportInputError("Campo fiscal inválido.");
    const exportMode = params.get("export");
    if (exportMode && !["page", "all"].includes(exportMode)) throw new ReportInputError("Modo de exportação inválido.");
    if (exportMode === "all") await guardReportExport(db, `${organization.id}:${access.user.id}:fiscal`);
    const where: Prisma.ProductWhereInput = { active: true, status: "publish", branchConfigurations: { some: { branchId, active: true } }, ...(search ? { OR: [{ name: { contains: search, mode: "insensitive" } }, { sku: { contains: search, mode: "insensitive" } }, { ncm: { contains: search } }, { gtin: { contains: search } }] } : {}) };
    const [settings, products] = await Promise.all([
      db.reportSettings.findUnique({ where: { id: 1 }, select: { fiscalRequiredFields: true } }),
      db.product.findMany({ where, select: { id: true, name: true, sku: true, ncm: true, cest: true, cestNotApplicable: true, origin: true, gtin: true, gtinTributary: true, spedItemType: true, taxBurdenRate: true, additionalInvoiceInfo: true }, orderBy: { name: "asc" } }),
    ]);
    const required = (settings?.fiscalRequiredFields || [...FISCAL_FIELDS]).filter((item): item is FiscalField => FISCAL_FIELDS.includes(item as FiscalField));
    const allItems = products.map((product) => {
      const completeness = fiscalCompleteness(product, required);
      return { ...product, origin_label: product.origin ? ORIGIN_LABELS[product.origin] || "Origem inválida" : "Não informada", completeness: completeness.percentage, complete: completeness.complete, missing_fields: completeness.missing, field_validity: completeness.validity };
    });
    const complete = allItems.filter((item) => item.complete).length;
    const filtered = allItems.filter((item) => (!onlyIncomplete || !item.complete) && (!missingField || item.missing_fields.includes(missingField as FiscalField)));
    if (exportMode === "all" && filtered.length > REPORT_EXPORT_LIMIT) throw new ReportInputError(`A exportação possui ${filtered.length} linhas. Reduza os filtros para no máximo ${REPORT_EXPORT_LIMIT}.`, 413);
    const items = exportMode === "all" ? filtered : filtered.slice((page - 1) * perPage, page * perPage);
    if (exportMode) return csvResponse(csvFile(
      ["Produto", "SKU", "NCM", "CEST", "CEST não aplicável", "Origem (código)", "Origem (descrição)", "GTIN", "GTIN tributário", "Tipo SPED", "Alíquota de tributos", "Informação adicional NF", "Completude (%)", "Campos faltantes"],
      items.map((item) => [item.name, item.sku, item.ncm || "", item.cest || "", item.cestNotApplicable ? "Sim" : "Nao", item.origin || "", item.origin_label, item.gtin || "", item.gtinTributary || "", item.spedItemType || "", item.taxBurdenRate ?? "", item.additionalInvoiceInfo || "", item.completeness, item.missing_fields.join(", ")]),
    ), "relatorio-fiscal.csv");
    return privateJson({ items, summary: { complete, incomplete: allItems.length - complete, total: allItems.length }, required_fields: required, total: filtered.length, page, per_page: perPage, pages: Math.max(1, Math.ceil(filtered.length / perPage)) });
  } catch (error) {
    if (error instanceof AuthError) return Response.json({ error: "Acesso negado." }, { status: error.status });
    return reportFailure(error);
  }
}

export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request);
    const { organization, access, db, branchId } = await reportContext("reports.write");
    await assertTenantWriteAccess(organization.id);
    const body = await readJsonObject(request, 1_048_576);
    const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map(Number).filter((id) => Number.isInteger(id) && id > 0))] : [];
    if (!ids.length || ids.length > 500) throw new ReportInputError("Selecione entre 1 e 500 produtos.");
    const field = String(body.field || "") as FiscalField | "cestNotApplicable";
    if (![...FISCAL_FIELDS, "cestNotApplicable"].includes(field)) throw new ReportInputError("Campo fiscal inválido.");
    const value = body.value === null ? null : String(body.value ?? "").trim();
    if (field === "ncm" && value && !/^\d{8}$/.test(value)) throw new ReportInputError("NCM deve ter 8 dígitos.");
    if (field === "cest" && value && !/^\d{7}$/.test(value)) throw new ReportInputError("CEST deve ter 7 dígitos.");
    if (field === "origin" && value && !/^[0-8]$/.test(value)) throw new ReportInputError("Origem deve estar entre 0 e 8.");
    if (field === "gtin" && value && !validGtin(value)) throw new ReportInputError("GTIN inválido: confira o dígito verificador.");
    const data = field === "cestNotApplicable" ? { cestNotApplicable: body.value === true, ...(body.value === true ? { cest: null } : {}) } : { [field]: value || null };
    let affected: number;
    if (field === "gtin") {
      await assertTenantPermission(organization.id, "products.write");
      const baseKey = createPosT2BoundaryIdempotencyKey();
      affected = await db.$transaction(async tx => {
        const products = await tx.product.findMany({ where: { id: { in: ids }, active: true, branchConfigurations: { some: { branchId, active: true } } }, include: { variations: { select: { id: true, enabled: true, gtin: true, manageStock: true, sku: true, status: true, posRevision: true, posConfigHash: true }, orderBy: { id: "asc" } } } });
        for (const product of products) {
          const boundary = await preparePosT2CatalogBoundary(tx, {
            action: "put_graph", productId: product.id, expectedProductRevision: product.posRevision, expectedProductConfigHash: product.posConfigHash,
            productProjection: { active: product.active, gtinSnapshot: value || null, manageStock: product.manageStock, nameLabel: product.name, productType: product.type, skuSnapshot: product.sku, status: product.status, unit: product.unit },
            variations: product.variations.map((variation, ordinal) => ({ enabled: variation.enabled, expectedConfigHash: variation.posConfigHash, expectedRevision: variation.posRevision, gtinSnapshot: variation.gtin, manageStock: variation.manageStock, ordinal, skuSnapshot: variation.sku, status: variation.status, variationId: variation.id })),
            actorUserId: access.user.id, idempotencyKey: toPosT2BoundaryIdempotencyKey(`${baseKey}:${product.id}`),
          });
          if (!boundary.replayed) await tx.product.update({ where: { id: product.id }, data: { gtin: value || null, posRevision: boundary.productRevision, posConfigHash: boundary.productConfigHash } });
        }
        return products.length;
      }, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 });
    } else {
      affected = (await db.product.updateMany({ where: { id: { in: ids }, active: true, branchConfigurations: { some: { branchId, active: true } } }, data })).count;
    }
    await db.tenantAuditEvent.create({ data: { actorId: access.user.id, action: "reports.fiscal_bulk_updated", entityType: "product", entityId: ids.join(","), afterData: { field, affected } } });
    return Response.json({ updated: affected });
  } catch (error) {
    if (error instanceof AuthError) return Response.json({ error: "Acesso negado." }, { status: error.status });
    return reportFailure(error);
  }
}
