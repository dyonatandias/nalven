import { planAllows } from "@/lib/erp/plan-features";
import { randomUUID } from "node:crypto";
import { Prisma } from "@/generated/tenant/client";
import { currentOrganization, tenantDb } from "@/db";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import { categoryHealth } from "@/lib/erp/category-control";
import { categoryMetricsMap, emptyCategoryMetrics } from "@/lib/erp/category-metrics";
import { categoryAttributeInput, categoryInput, categoryMappingInput, categoryVersion, CategoryInputError, entityId } from "@/lib/erp/category-input";
import { assertSameOrigin } from "@/lib/erp/customer-input";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { assertPosMutationRequest, enforcePosRateLimit, PosHttpError, readPosJson } from "@/lib/erp/pos-http";
import { enqueueWebhook } from "@/lib/integrations/webhooks";
import { assertTenantWriteAccess } from "@/lib/tenant-access";

export const dynamic = "force-dynamic";
const NO_STORE = { "cache-control": "private, no-store, max-age=0", expires: "0", pragma: "no-cache" };
const fullInclude = {
  parent: { select: { id: true, name: true } },
  children: { select: { id: true, name: true, active: true, menuOrder: true }, orderBy: [{ menuOrder: "asc" as const }, { name: "asc" as const }] },
  attributeTemplates: { orderBy: [{ active: "desc" as const }, { sortOrder: "asc" as const }, { name: "asc" as const }] },
  marketplaceMappings: { orderBy: { platform: "asc" as const } },
  pricingOverride: true,
  slugRedirects: { orderBy: { createdAt: "desc" as const }, take: 20 },
  _count: { select: { children: true, attributeTemplates: true, marketplaceMappings: true } },
};
type Db = Awaited<ReturnType<typeof tenantDb>>;

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const organization = await currentOrganization(); await assertTenantPermission(organization.id, "categories.read");
    const db = await tenantDb(organization.id), id = entityId((await context.params).id), url = new URL(request.url), productSearch = (url.searchParams.get("productSearch") || "").trim();
    if (productSearch.length > 100) throw new CategoryInputError("Busca de produtos muito extensa.");
    const category = await db.category.findUnique({ where: { id }, include: fullInclude });
    if (!category) return Response.json({ error: "Categoria não encontrada." }, { status: 404, headers: NO_STORE });
    const [metricsMap, products, productCount, candidates, auditRows, channels, taxonomy] = await Promise.all([
      categoryMetricsMap(db, [id]),
      db.product.findMany({ where: { OR: [{ categoryId: id }, { categoryLinks: { some: { categoryId: id } } }] }, select: { id: true, name: true, sku: true, type: true, active: true, status: true, catalogVisibility: true, price: true, cost: true, cogs: true, stock: true, minStock: true, manageStock: true, imageMediaId: true, seoTitle: true, ncm: true, categoryId: true, categoryLinks: { select: { categoryId: true, primary: true } } }, orderBy: [{ active: "desc" }, { name: "asc" }], take: 100 }),
      db.product.count({ where: { OR: [{ categoryId: id }, { categoryLinks: { some: { categoryId: id } } }] } }),
      db.product.findMany({ where: { AND: [{ NOT: { OR: [{ categoryId: id }, { categoryLinks: { some: { categoryId: id } } }] } }, productSearch ? { OR: [{ name: { contains: productSearch, mode: "insensitive" } }, { sku: { contains: productSearch, mode: "insensitive" } }] } : {}] }, select: { id: true, name: true, sku: true, category: true }, orderBy: { name: "asc" }, take: 50 }),
      db.tenantAuditEvent.findMany({ where: { entityType: "category", entityId: String(id) }, select: { id: true, action: true, actorId: true, beforeData: true, afterData: true, correlationId: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: 60 }),
      db.marketplaceChannel.findMany({ select: { id: true, name: true, provider: true, status: true }, orderBy: { name: "asc" } }),
      db.category.findMany({ select: { id: true, name: true, parentId: true } }),
    ]);
    const productIds = products.map((item) => item.id), sales = productIds.length ? await db.saleItem.groupBy({ by: ["productId"], where: { productId: { in: productIds }, sale: { status: "completed", createdAt: { gte: new Date(Date.now() - 90 * 86_400_000) } } }, _sum: { total: true, quantity: true, returnedQuantity: true } }) : [];
    const salesMap = new Map(sales.map((item) => [item.productId, { revenue90d: item._sum.total || 0, units90d: (item._sum.quantity || 0) - (item._sum.returnedQuantity || 0) }]));
    const metrics = metricsMap.get(id) || emptyCategoryMetrics(), health = categoryHealth({ ...category, requireMappings: planAllows(organization.modules,"marketplaces"), attributeCount: category.attributeTemplates.filter((item) => item.active).length, mappingCount: category.marketplaceMappings.length, metrics }), hierarchy = hierarchyPath(taxonomy, id);
    return Response.json({ category: { ...category, metrics, health, ...hierarchy }, products: products.map((item) => ({ ...item, primary: item.categoryId === id || item.categoryLinks.some((link) => link.categoryId === id && link.primary), sales: salesMap.get(item.id) || { revenue90d: 0, units90d: 0 } })), productCount, candidates, channels, audit: auditRows.map((item) => ({ ...item, id: String(item.id) })), generatedAt: new Date().toISOString() }, { headers: NO_STORE });
  } catch (error) { return failure(error); }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request); assertPosMutationRequest(request);
    const organization = await currentOrganization(), access = await assertTenantPermission(organization.id, "categories.write"); await assertTenantWriteAccess(organization.id);
    const db = await tenantDb(organization.id), id = entityId((await context.params).id), body = await readPosJson(request, 262_144), correlationId = randomUUID();
    if (!planAllows(organization.modules, "service-orders") && ["service", "both"].includes(String(body.type))) throw new AuthError(403);
    if (!planAllows(organization.modules, "marketplaces") && String(body.action).startsWith("mapping.")) throw new AuthError(403);
    await enforcePosRateLimit(db, access.user.id, "categories.mutation");
    const before = await db.category.findUnique({ where: { id }, include: { children: { select: { id: true, active: true } } } });
    if (!before) return Response.json({ error: "Categoria não encontrada." }, { status: 404, headers: NO_STORE });

    if (body.action === "status") {
      const active = body.active === true, version = categoryVersion(body.version), cascade = body.cascade === true, childIds = active || !cascade ? [] : await descendants(db, id);
      if (!active && !cascade && before.children.some((child) => child.active)) throw new CategoryInputError("A categoria possui subcategorias ativas. Confirme a inativação em cascata.");
      const category = await db.$transaction(async (tx) => { await lock(tx, id); const changed = await tx.category.updateMany({ where: { id, version }, data: { active, version: { increment: 1 } } }); if (changed.count !== 1) throw conflict(); if (childIds.length) await tx.category.updateMany({ where: { id: { in: childIds } }, data: { active: false, version: { increment: 1 } } }); await audit(tx, access.user.id, "category.status_changed", id, correlationId, { active: before.active }, { active, cascade, descendants: childIds.length }); await enqueueWebhook(tx, "category.updated", { id, status: active ? "active" : "inactive", occurred_at: new Date().toISOString(), correlation_id: correlationId }); return tx.category.findUniqueOrThrow({ where: { id }, include: fullInclude }); }, serializable);
      return Response.json({ category, changedDescendants: childIds.length, correlationId }, { headers: NO_STORE });
    }
    if (body.action === "attribute.save") {
      const input = categoryAttributeInput(body), attributeId = body.attributeId ? entityId(body.attributeId, "Atributo") : null;
      const attribute = await db.$transaction(async (tx) => { let result; if (attributeId) { const changed = await tx.categoryAttributeTemplate.updateMany({ where: { id: attributeId, categoryId: id }, data: { ...input, version: { increment: 1 } } }); if (changed.count !== 1) throw new CategoryInputError("Atributo não encontrado."); result = await tx.categoryAttributeTemplate.findUniqueOrThrow({ where: { id: attributeId } }); } else result = await tx.categoryAttributeTemplate.create({ data: { categoryId: id, ...input } }); await tx.category.update({ where: { id }, data: { version: { increment: 1 } } }); await audit(tx, access.user.id, attributeId ? "category.attribute_updated" : "category.attribute_created", id, correlationId, null, { attributeId: result.id, name: result.name, type: result.type, required: result.required }); return result; }, serializable);
      return Response.json({ attribute, correlationId }, { status: attributeId ? 200 : 201, headers: NO_STORE });
    }
    if (body.action === "attribute.status") {
      const attributeId = entityId(body.attributeId, "Atributo"), active = body.active === true, changed = await db.categoryAttributeTemplate.updateMany({ where: { id: attributeId, categoryId: id }, data: { active, version: { increment: 1 } } });
      if (changed.count !== 1) throw new CategoryInputError("Atributo não encontrado."); await db.category.update({ where: { id }, data: { version: { increment: 1 } } }); await db.tenantAuditEvent.create({ data: { actorId: access.user.id, action: "category.attribute_status_changed", entityType: "category", entityId: String(id), correlationId, afterData: { attributeId, active } } });
      return Response.json({ changed: true, correlationId }, { headers: NO_STORE });
    }
    if (body.action === "mapping.save") {
      const input = categoryMappingInput(body), mapping = await db.$transaction(async (tx) => { const saved = await tx.categoryMarketplaceMapping.upsert({ where: { categoryId_platform: { categoryId: id, platform: input.platform } }, update: { ...input, updatedBy: access.user.name }, create: { categoryId: id, ...input, updatedBy: access.user.name } }); await tx.category.update({ where: { id }, data: { version: { increment: 1 } } }); await audit(tx, access.user.id, "category.mapping_saved", id, correlationId, null, { mappingId: saved.id, platform: saved.platform, remoteCategoryId: saved.remoteCategoryId, status: saved.status }); return saved; }, serializable);
      return Response.json({ mapping, correlationId }, { headers: NO_STORE });
    }
    if (body.action === "mapping.remove") {
      const mappingId = entityId(body.mappingId, "Mapeamento"), removed = await db.categoryMarketplaceMapping.deleteMany({ where: { id: mappingId, categoryId: id } });
      if (removed.count !== 1) throw new CategoryInputError("Mapeamento não encontrado."); await db.category.update({ where: { id }, data: { version: { increment: 1 } } }); await db.tenantAuditEvent.create({ data: { actorId: access.user.id, action: "category.mapping_removed", entityType: "category", entityId: String(id), correlationId, afterData: { mappingId } } });
      return Response.json({ removed: true, correlationId }, { headers: NO_STORE });
    }
    if (body.action === "pricing.save") {
      const targetMargin = percent(body.targetMargin, "Margem alvo"), minimumMargin = percent(body.minimumMargin, "Margem mínima"); if (minimumMargin > targetMargin) throw new CategoryInputError("A margem mínima não pode superar a margem alvo.");
      const pricing = await db.$transaction(async (tx) => { await tx.reportSettings.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } }); const saved = await tx.categoryPricingOverride.upsert({ where: { categoryId: id }, update: { targetMargin, minimumMargin }, create: { categoryId: id, targetMargin, minimumMargin } }); await tx.category.update({ where: { id }, data: { version: { increment: 1 } } }); await audit(tx, access.user.id, "category.pricing_saved", id, correlationId, null, { targetMargin, minimumMargin }); return saved; }, serializable);
      return Response.json({ pricing, correlationId }, { headers: NO_STORE });
    }
    if (body.action === "product.assign") {
      const productId = entityId(body.productId, "Produto"), primary = body.primary === true;
      const product = await db.$transaction(async (tx) => { const found = await tx.product.findUnique({ where: { id: productId }, select: { id: true } }); if (!found) throw new CategoryInputError("Produto não encontrado."); if (primary) { await tx.productCategoryLink.updateMany({ where: { productId }, data: { primary: false } }); await tx.product.update({ where: { id: productId }, data: { categoryId: id, category: before.name, posRevision: { increment: 1 } } }); } await tx.productCategoryLink.upsert({ where: { productId_categoryId: { productId, categoryId: id } }, update: primary ? { primary: true } : {}, create: { productId, categoryId: id, primary } }); await tx.category.update({ where: { id }, data: { version: { increment: 1 } } }); await audit(tx, access.user.id, "category.product_assigned", id, correlationId, null, { productId, primary }); return tx.product.findUniqueOrThrow({ where: { id: productId }, select: { id: true, name: true, sku: true } }); }, serializable);
      return Response.json({ product, correlationId }, { headers: NO_STORE });
    }
    if (body.action === "product.remove") {
      const productId = entityId(body.productId, "Produto");
      await db.$transaction(async (tx) => { const product = await tx.product.findUnique({ where: { id: productId }, select: { categoryId: true } }); if (!product) throw new CategoryInputError("Produto não encontrado."); const removed = await tx.productCategoryLink.deleteMany({ where: { productId, categoryId: id } }); if (product.categoryId !== id && !removed.count) throw new CategoryInputError("Produto não está vinculado à categoria."); if (product.categoryId === id) { const replacement = await tx.productCategoryLink.findFirst({ where: { productId, categoryId: { not: id } }, include: { category: { select: { name: true } } }, orderBy: { primary: "desc" } }); if (replacement) { await tx.productCategoryLink.update({ where: { productId_categoryId: { productId, categoryId: replacement.categoryId } }, data: { primary: true } }); await tx.product.update({ where: { id: productId }, data: { categoryId: replacement.categoryId, category: replacement.category.name, posRevision: { increment: 1 } } }); } else await tx.product.update({ where: { id: productId }, data: { categoryId: null, category: "Sem categoria", posRevision: { increment: 1 } } }); } await tx.category.update({ where: { id }, data: { version: { increment: 1 } } }); await audit(tx, access.user.id, "category.product_removed", id, correlationId, null, { productId }); }, serializable);
      return Response.json({ removed: true, correlationId }, { headers: NO_STORE });
    }

    const input = categoryInput(body), version = categoryVersion(body.version); await validateParent(db, id, input.parentId);
    const category = await db.$transaction(async (tx) => { await lock(tx, id); const changed = await tx.category.updateMany({ where: { id, version }, data: { ...input, version: { increment: 1 } } }); if (changed.count !== 1) throw conflict(); if (before.slug !== input.slug) await tx.categorySlugRedirect.upsert({ where: { oldSlug: before.slug }, update: { categoryId: id }, create: { categoryId: id, oldSlug: before.slug } }); await tx.product.updateMany({ where: { categoryId: id }, data: { category: input.name, posRevision: { increment: 1 } } }); await audit(tx, access.user.id, "category.updated", id, correlationId, { name: before.name, slug: before.slug, parentId: before.parentId, version }, { name: input.name, slug: input.slug, parentId: input.parentId, visibility: input.visibility, version: version + 1 }); await enqueueWebhook(tx, "category.updated", { id, status: input.active ? "active" : "inactive", occurred_at: new Date().toISOString(), correlation_id: correlationId }); return tx.category.findUniqueOrThrow({ where: { id }, include: fullInclude }); }, serializable);
    return Response.json({ category, correlationId }, { headers: NO_STORE });
  } catch (error) { return failure(error); }
}

const serializable = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable } as const;
async function lock(tx: Prisma.TransactionClient, id: number) { await tx.$queryRaw`SELECT id FROM categories WHERE id=${id} FOR UPDATE`; }
async function descendants(db: Db, id: number) { const rows = await db.$queryRaw<Array<{ id: number }>>`WITH RECURSIVE tree AS (SELECT id FROM categories WHERE parent_id=${id} UNION ALL SELECT category.id FROM categories category JOIN tree parent ON category.parent_id=parent.id) SELECT id FROM tree`; return rows.map((item) => item.id); }
async function validateParent(db: Db, id: number, parentId: number | null) { if (!parentId) return; if (parentId === id || (await descendants(db, id)).includes(parentId)) throw new CategoryInputError("Essa hierarquia criaria um ciclo entre categorias."); if (!await db.category.findUnique({ where: { id: parentId }, select: { id: true } })) throw new CategoryInputError("Categoria superior não encontrada."); }
function percent(value: unknown, label: string) { const number = Number(value); if (!Number.isFinite(number) || number < 0 || number > 100) throw new CategoryInputError(`${label} deve ficar entre 0% e 100%.`); return Math.round(number * 100) / 100; }
function hierarchyPath(items: Array<{ id: number; name: string; parentId: number | null }>, id: number) { const byId = new Map(items.map((item) => [item.id, item])), names: string[] = [], seen = new Set<number>(); let current = byId.get(id); while (current && !seen.has(current.id)) { seen.add(current.id); names.unshift(current.name); current = current.parentId ? byId.get(current.parentId) : undefined; } return { path: names.join(" / "), depth: Math.max(0, names.length - 1) }; }
async function audit(tx: Prisma.TransactionClient, actorId: string, action: string, id: number, correlationId: string, beforeData: Prisma.InputJsonValue | null, afterData: Prisma.InputJsonValue) { await tx.tenantAuditEvent.create({ data: { actorId, action, entityType: "category", entityId: String(id), correlationId, beforeData: beforeData ?? undefined, afterData } }); }
function conflict() { const error = new Error("A categoria foi alterada por outro usuário."); Object.assign(error, { code: "CATEGORY_CONFLICT" }); return error; }
function failure(error: unknown) { if (error instanceof CategoryInputError) return Response.json({ error: error.message }, { status: 400, headers: NO_STORE }); if (error instanceof PosHttpError) return Response.json({ error: error.message.replaceAll("PDV", "módulo de categorias") }, { status: error.status, headers: NO_STORE }); if (error instanceof LicenseDeniedError) return Response.json({ error: error.message }, { status: error.status, headers: NO_STORE }); if (error && typeof error === "object" && "code" in error && error.code === "P2002") return Response.json({ error: "Já existe uma categoria, atributo ou mapeamento com estes dados." }, { status: 409, headers: NO_STORE }); if (error && typeof error === "object" && "code" in error && ["P2003", "P2004"].includes(String(error.code))) return Response.json({ error: "A hierarquia ou um vínculo da categoria é inválido." }, { status: 409, headers: NO_STORE }); if (error && typeof error === "object" && "code" in error && ["P2034", "CATEGORY_CONFLICT"].includes(String(error.code))) return Response.json({ error: "A categoria foi alterada por outro usuário. Atualize os dados e tente novamente." }, { status: 409, headers: NO_STORE }); if (error instanceof AuthError) return authErrorResponse(error); console.error("category detail request failed", error instanceof Error ? error.name : "unknown"); return Response.json({ error: "Não foi possível operar a categoria." }, { status: 500, headers: NO_STORE }); }
