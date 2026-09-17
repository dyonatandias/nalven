import { planAllows } from "@/lib/erp/plan-features";
import { randomUUID } from "node:crypto";
import { Prisma } from "@/generated/tenant/client";
import { currentOrganization, tenantDb } from "@/db";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import { categoryCsv, categoryHealth, categoryTree, parseCategoryQuery } from "@/lib/erp/category-control";
import { catalogCategoryTotals, emptyCategoryMetrics, categoryMetricsMap } from "@/lib/erp/category-metrics";
import { categoryIds, categoryInput, CategoryInputError, entityId } from "@/lib/erp/category-input";
import { assertSameOrigin } from "@/lib/erp/customer-input";
import { assertTenantPermission, matches } from "@/lib/erp/permissions";
import { assertPosMutationRequest, enforcePosRateLimit, PosHttpError, readPosJson } from "@/lib/erp/pos-http";
import { enqueueWebhook } from "@/lib/integrations/webhooks";
import { assertTenantWriteAccess } from "@/lib/tenant-access";

export const dynamic = "force-dynamic";
const NO_STORE = { "cache-control": "private, no-store, max-age=0", expires: "0", pragma: "no-cache" };
const include = {
  parent: { select: { id: true, name: true } },
  _count: { select: { children: true, attributeTemplates: true, marketplaceMappings: true } },
  pricingOverride: { select: { targetMargin: true, minimumMargin: true } },
};
type Db = Awaited<ReturnType<typeof tenantDb>>;

export async function GET(request: Request) {
  try {
    const organization = await currentOrganization();
    const access = await assertTenantPermission(organization.id, "categories.read");
    const db = await tenantDb(organization.id);
    const query = parseCategoryQuery(new URL(request.url).searchParams);
    const baseWhere: Prisma.CategoryWhereInput = {
      ...(query.status ? { active: query.status === "active" } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.visibility ? { visibility: query.visibility } : {}),
      ...(query.parent === "root" ? { parentId: null } : query.parent ? { parentId: Number(query.parent) } : {}),
      ...(query.search ? { OR: [
        { name: { contains: query.search, mode: "insensitive" } },
        { code: { contains: query.search, mode: "insensitive" } },
        { slug: { contains: query.search, mode: "insensitive" } },
        { description: { contains: query.search, mode: "insensitive" } },
        { parent: { name: { contains: query.search, mode: "insensitive" } } },
      ] } : {}),
    };
    const [candidates, taxonomy, metricsMap, catalogTotals, total, active, visible, orphanProducts, created] = await Promise.all([
      db.category.findMany({ where: baseWhere, include, take: 10_001 }),
      db.category.findMany({ select: { id: true, name: true, parentId: true, menuOrder: true, active: true, description: true, seoTitle: true, seoDescription: true, seoNoindex: true, visibility: true, type: true, _count: { select: { attributeTemplates: true, marketplaceMappings: true } } }, orderBy: [{ menuOrder: "asc" }, { name: "asc" }] }),
      categoryMetricsMap(db),
      catalogCategoryTotals(db),
      db.category.count(), db.category.count({ where: { active: true } }), db.category.count({ where: { active: true, visibility: { not: "hidden" } } }),
      db.product.count({ where: { categoryId: null, categoryLinks: { none: {} } } }),
      db.category.findMany({ where: { createdAt: { gte: new Date(Date.now() - 180 * 86_400_000) } }, select: { createdAt: true } }),
    ]);
    if (candidates.length > 10_000) throw new CategoryInputError("A consulta excede 10.000 categorias. Aplique mais filtros.");
    const tree = categoryTree(taxonomy), treeInfo = new Map(tree.map((item, index) => [item.id, { depth: item.depth, path: item.path, rank: index }]));
    let enriched = candidates.map((category) => enrich(category, metricsMap.get(category.id) || emptyCategoryMetrics(), treeInfo.get(category.id), planAllows(organization.modules,"marketplaces")));
    if (query.attention) enriched = enriched.filter((item) => query.attention === "empty" ? item.metrics.products === 0 : query.attention === "seo" ? item.health.issues.some((issue) => issue.includes("SEO")) : query.attention === "mapping" ? item._count.marketplaceMappings === 0 && item.type !== "service" : query.attention === "attributes" ? item._count.attributeTemplates === 0 && item.type !== "service" : item.metrics.lowStock + item.metrics.outOfStock > 0);
    enriched.sort((left, right) => query.sort === "products" ? right.metrics.products - left.metrics.products || left.name.localeCompare(right.name, "pt-BR") : query.sort === "revenue" ? right.metrics.revenue90d - left.metrics.revenue90d || left.name.localeCompare(right.name, "pt-BR") : query.sort === "health" ? left.health.score - right.health.score || left.name.localeCompare(right.name, "pt-BR") : query.sort === "recent" ? new Date(right.updatedAt).valueOf() - new Date(left.updatedAt).valueOf() : query.sort === "name" ? left.name.localeCompare(right.name, "pt-BR") : left.treeRank - right.treeRank);
    if (query.format === "csv") return new Response(categoryCsv(enriched), { headers: { ...NO_STORE, "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="categorias-${new Date().toISOString().slice(0, 10)}.csv"` } });
    const filteredTotal = enriched.length, items = enriched.slice((query.page - 1) * query.limit, query.page * query.limit);
    const allRows = taxonomy.map((category) => ({ ...category, metrics: metricsMap.get(category.id) || emptyCategoryMetrics() }));
    const quality = {
      empty: allRows.filter((item) => item.metrics.products === 0).length,
      missingSeo: await db.category.count({ where: { active: true, visibility: { not: "hidden" }, seoNoindex: false, OR: [{ seoTitle: null }, { seoDescription: null }] } }),
      missingMappings: planAllows(organization.modules,"marketplaces") ? await db.category.count({ where: { active: true, type: { in: ["product", "both"] }, marketplaceMappings: { none: {} } } }) : 0,
      missingAttributes: await db.category.count({ where: { active: true, type: { in: ["product", "both"] }, attributeTemplates: { none: {} } } }),
      lowStock: allRows.reduce((sum, item) => sum + item.metrics.lowStock + item.metrics.outOfStock, 0), orphanProducts,
    };
    return Response.json({
      items, options: tree.map((item) => ({ id: item.id, name: item.name, parentId: item.parentId, depth: item.depth, path: item.path, active: item.active })), generatedAt: new Date().toISOString(), capabilities: { canWrite: matches(access.permissions, "categories.write") },
      pagination: { page: query.page, limit: query.limit, total: filteredTotal, pages: Math.max(1, Math.ceil(filteredTotal / query.limit)) },
      summary: { total, active, visible, linkedProducts: catalogTotals.linkedProducts, totalRevenue90d: catalogTotals.revenue90d, stockValue: catalogTotals.stockValue, averageHealth: total ? Math.round(enrichedHealthAverage(taxonomy, metricsMap)) : 0 },
      analytics: { quality, types: breakdown(taxonomy, "type"), visibility: breakdown(taxonomy, "visibility"), growth: growthSeries(created.map((item) => item.createdAt)), topRevenue: topRows(allRows, taxonomy, "revenue90d"), topStock: topRows(allRows, taxonomy, "stockValue") },
    }, { headers: NO_STORE });
  } catch (error) { return failure(error, "consultar"); }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request); assertPosMutationRequest(request);
    const organization = await currentOrganization(), access = await assertTenantPermission(organization.id, "categories.write");
    await assertTenantWriteAccess(organization.id);
    const db = await tenantDb(organization.id), body = await readPosJson(request, 524_288), correlationId = randomUUID();
    if (!planAllows(organization.modules, "service-orders") && ["service", "both"].includes(String(body.type))) throw new AuthError(403);
    if (!planAllows(organization.modules, "marketplaces") && String(body.action).startsWith("mapping.")) throw new AuthError(403);
    await enforcePosRateLimit(db, access.user.id, "categories.mutation");
    if (body.action === "batch.status" || body.action === "batch.visibility" || body.action === "batch.parent") {
      const requestedIds = categoryIds(body.categoryIds), data = body.action === "batch.status" ? { active: body.active === true } : body.action === "batch.visibility" ? { visibility: visibility(body.visibility) } : { parentId: body.parentId == null || body.parentId === "" ? null : entityId(body.parentId, "Categoria superior") };
      if ("parentId" in data) await validateBatchParent(db, requestedIds, data.parentId ?? null);
      const descendantIds = body.action === "batch.status" && !data.active ? (await Promise.all(requestedIds.map((id) => descendants(db, id)))).flat() : [];
      const ids = [...new Set([...requestedIds, ...descendantIds])];
      const changed = await db.$transaction(async (tx) => {
        const result = await tx.category.updateMany({ where: { id: { in: ids } }, data: { ...data, version: { increment: 1 } } });
        if (result.count !== ids.length) throw new CategoryInputError("Uma ou mais categorias não foram encontradas.");
        await audit(tx, access.user.id, `category.${String(body.action).replace("batch.", "batch_")}`, null, correlationId, null, { requestedIds, ids, ...data, count: result.count });
        return result.count;
      }, serializable);
      return Response.json({ changed, correlationId }, { headers: NO_STORE });
    }
    if (body.action === "merge") {
      const sourceIds = categoryIds(body.sourceIds, "Categorias de origem"), targetId = entityId(body.targetId, "Categoria de destino");
      if (sourceIds.includes(targetId)) throw new CategoryInputError("A categoria de destino não pode estar entre as origens.");
      await validateMerge(db, sourceIds, targetId);
      const result = await mergeCategories(db, sourceIds, targetId, access.user.id, access.user.name, correlationId);
      return Response.json({ ...result, correlationId }, { headers: NO_STORE });
    }
    const input = categoryInput(body);
    await validateParent(db, null, input.parentId);
    const category = await db.$transaction(async (tx) => {
      const created = await tx.category.create({ data: input, include });
      await audit(tx, access.user.id, "category.created", created.id, correlationId, null, { name: created.name, slug: created.slug, type: created.type, parentId: created.parentId, visibility: created.visibility });
      await enqueueWebhook(tx, "category.created", { id: created.id, status: created.active ? "active" : "inactive", occurred_at: new Date().toISOString(), correlation_id: correlationId });
      return created;
    }, serializable);
    return Response.json({ category, correlationId }, { status: 201, headers: NO_STORE });
  } catch (error) { return failure(error, "salvar"); }
}

function enrich<T extends { id: number; active: boolean; description: string | null; seoTitle: string | null; seoDescription: string | null; seoNoindex: boolean; visibility: string; type: string; _count: { attributeTemplates: number; marketplaceMappings: number } }>(category: T, metrics: ReturnType<typeof emptyCategoryMetrics>, tree?: { depth: number; path: string; rank: number }, requireMappings = true) {
  const health = categoryHealth({ ...category, requireMappings, attributeCount: category._count.attributeTemplates, mappingCount: category._count.marketplaceMappings, metrics });
  return { ...category, metrics, health, depth: tree?.depth || 0, path: tree?.path || ("name" in category ? String(category.name) : ""), treeRank: tree?.rank ?? Number.MAX_SAFE_INTEGER };
}
function breakdown<T extends Record<string, unknown>>(items: T[], key: keyof T) { const map = new Map<string, number>(); for (const item of items) map.set(String(item[key]), (map.get(String(item[key])) || 0) + 1); return [...map].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count); }
function growthSeries(dates: Date[]) { const now = new Date(); const rows = Array.from({ length: 6 }, (_, offset) => { const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5 + offset, 1)); return { key: date.toISOString().slice(0, 7), label: new Intl.DateTimeFormat("pt-BR", { month: "short", timeZone: "UTC" }).format(date), count: 0 }; }); const map = new Map(rows.map((row) => [row.key, row])); for (const date of dates) { const row = map.get(date.toISOString().slice(0, 7)); if (row) row.count += 1; } return rows; }
function topRows(rows: Array<{ id: number; metrics: ReturnType<typeof emptyCategoryMetrics> }>, categories: Array<{ id: number; name: string }>, metric: "revenue90d" | "stockValue") { const names = new Map(categories.map((item) => [item.id, item.name])); return [...rows].filter((item) => item.metrics[metric] > 0).sort((a, b) => b.metrics[metric] - a.metrics[metric]).slice(0, 6).map((item) => ({ id: item.id, name: names.get(item.id) || "Categoria", value: item.metrics[metric] })); }
function enrichedHealthAverage(source: Array<{ id: number; active: boolean; description: string | null; seoTitle: string | null; seoDescription: string | null; seoNoindex: boolean; visibility: string; type: string; _count: { attributeTemplates: number; marketplaceMappings: number } }>, metrics: Map<number, ReturnType<typeof emptyCategoryMetrics>>) { if (!source.length) return 0; return Math.round(source.reduce((sum, item) => sum + categoryHealth({ ...item, attributeCount: item._count.attributeTemplates, mappingCount: item._count.marketplaceMappings, metrics: metrics.get(item.id) || emptyCategoryMetrics() }).score, 0) / source.length); }
function visibility(value: unknown) { if (!["visible", "catalog", "hidden"].includes(String(value))) throw new CategoryInputError("Visibilidade inválida."); return String(value); }
async function validateParent(db: Db, id: number | null, parentId: number | null) { if (!parentId) return; const parent = await db.category.findUnique({ where: { id: parentId }, select: { id: true } }); if (!parent) throw new CategoryInputError("Categoria superior não encontrada."); if (id && (id === parentId || (await descendants(db, id)).includes(parentId))) throw new CategoryInputError("Essa hierarquia criaria um ciclo entre categorias."); }
async function validateBatchParent(db: Db, ids: number[], parentId: number | null) { if (!parentId) return; if (ids.includes(parentId)) throw new CategoryInputError("A categoria superior está dentro da própria seleção."); for (const id of ids) await validateParent(db, id, parentId); }
async function descendants(db: Db, id: number) { const rows = await db.$queryRaw<Array<{ id: number }>>`WITH RECURSIVE tree AS (SELECT id FROM categories WHERE parent_id=${id} UNION ALL SELECT category.id FROM categories category JOIN tree parent ON category.parent_id=parent.id) SELECT id FROM tree`; return rows.map((item) => item.id); }
async function validateMerge(db: Db, sourceIds: number[], targetId: number) { const count = await db.category.count({ where: { id: { in: [...sourceIds, targetId] } } }); if (count !== sourceIds.length + 1) throw new CategoryInputError("Uma categoria da mesclagem não foi encontrada."); for (const sourceId of sourceIds) if ((await descendants(db, sourceId)).includes(targetId)) throw new CategoryInputError("Mova a categoria de destino para fora das origens antes de mesclar."); }
async function mergeCategories(db: Db, sourceIds: number[], targetId: number, actorId: string, actorName: string, correlationId: string) { return db.$transaction(async (tx) => { const target = await tx.category.findUniqueOrThrow({ where: { id: targetId }, select: { id: true, name: true } }), sources = await tx.category.findMany({ where: { id: { in: sourceIds } }, select: { id: true, name: true, slug: true } }); const links = await tx.productCategoryLink.findMany({ where: { categoryId: { in: sourceIds } }, select: { productId: true, primary: true } }); await tx.productCategoryLink.createMany({ data: links.map((link) => ({ productId: link.productId, categoryId: targetId, primary: link.primary })), skipDuplicates: true }); await tx.productCategoryLink.deleteMany({ where: { categoryId: { in: sourceIds } } }); const direct = await tx.product.updateMany({ where: { categoryId: { in: sourceIds } }, data: { categoryId: targetId, category: target.name, posRevision: { increment: 1 } } }); await tx.category.updateMany({ where: { parentId: { in: sourceIds }, id: { not: targetId } }, data: { parentId: targetId, version: { increment: 1 } } }); for (const source of sources) await tx.categorySlugRedirect.upsert({ where: { oldSlug: source.slug }, update: { categoryId: targetId }, create: { categoryId: targetId, oldSlug: source.slug } }); await tx.categorySlugRedirect.updateMany({ where: { categoryId: { in: sourceIds } }, data: { categoryId: targetId } }); const attributes = await tx.categoryAttributeTemplate.findMany({ where: { categoryId: { in: sourceIds } } }); for (const attribute of attributes) await tx.categoryAttributeTemplate.upsert({ where: { categoryId_name: { categoryId: targetId, name: attribute.name } }, update: {}, create: { categoryId: targetId, name: attribute.name, type: attribute.type, required: attribute.required, options: attribute.options, unit: attribute.unit, sortOrder: attribute.sortOrder, active: attribute.active } }); const mappings = await tx.categoryMarketplaceMapping.findMany({ where: { categoryId: { in: sourceIds } } }); for (const mapping of mappings) await tx.categoryMarketplaceMapping.upsert({ where: { categoryId_platform: { categoryId: targetId, platform: mapping.platform } }, update: {}, create: { categoryId: targetId, platform: mapping.platform, remoteCategoryId: mapping.remoteCategoryId, remoteCategoryName: mapping.remoteCategoryName, status: mapping.status, lastSyncedAt: mapping.lastSyncedAt, updatedBy: actorName } }); const targetPricing = await tx.categoryPricingOverride.findUnique({ where: { categoryId: targetId } }); const sourcePricing = await tx.categoryPricingOverride.findFirst({ where: { categoryId: { in: sourceIds } }, orderBy: { updatedAt: "desc" } }); if (!targetPricing && sourcePricing) await tx.categoryPricingOverride.update({ where: { id: sourcePricing.id }, data: { categoryId: targetId } }); await tx.categoryPricingOverride.deleteMany({ where: { categoryId: { in: sourceIds } } }); await tx.category.deleteMany({ where: { id: { in: sourceIds } } }); await tx.category.update({ where: { id: targetId }, data: { version: { increment: 1 } } }); await audit(tx, actorId, "category.merged", targetId, correlationId, { sources }, { target, sourceIds, linkedProducts: links.length, primaryProducts: direct.count }); await enqueueWebhook(tx, "category.updated", { id: targetId, status: "active", occurred_at: new Date().toISOString(), correlation_id: correlationId }); return { merged: sources.length, linkedProducts: links.length, primaryProducts: direct.count, target }; }, serializable); }
const serializable = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable } as const;
async function audit(tx: Prisma.TransactionClient, actorId: string, action: string, id: number | null, correlationId: string, beforeData: Prisma.InputJsonValue | null, afterData: Prisma.InputJsonValue) { await tx.tenantAuditEvent.create({ data: { actorId, action, entityType: "category", entityId: id ? String(id) : null, correlationId, beforeData: beforeData ?? undefined, afterData } }); }
function failure(error: unknown, operation: string) { if (error instanceof CategoryInputError) return Response.json({ error: error.message }, { status: 400, headers: NO_STORE }); if (error instanceof PosHttpError) return Response.json({ error: error.message.replaceAll("PDV", "módulo de categorias") }, { status: error.status, headers: NO_STORE }); if (error instanceof LicenseDeniedError) return Response.json({ error: error.message }, { status: error.status, headers: NO_STORE }); if (error && typeof error === "object" && "code" in error && error.code === "P2002") return Response.json({ error: "Já existe uma categoria com este nome, slug, código ou mapeamento." }, { status: 409, headers: NO_STORE }); if (error && typeof error === "object" && "code" in error && ["P2003", "P2004"].includes(String(error.code))) return Response.json({ error: "A hierarquia ou um vínculo da categoria é inválido." }, { status: 409, headers: NO_STORE }); if (error instanceof AuthError) return authErrorResponse(error); console.error(`category ${operation} failed`, error instanceof Error ? error.name : "unknown"); return Response.json({ error: `Não foi possível ${operation} as categorias.` }, { status: 500, headers: NO_STORE }); }
