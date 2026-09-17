import { planAllows } from "@/lib/erp/plan-features";
import { currentOrganization, tenantDb } from "@/db";
import {LicenseDeniedError} from "@/lib/billing/license";
import {assertTenantWriteAccess} from '@/lib/tenant-access';
import {AuthError,currentUser} from '@/lib/auth';
import {assertSameOrigin,CustomerInputError} from '@/lib/erp/customer-input';
import {assertTenantPermission} from '@/lib/erp/permissions';
import {isErpPage,type ErpPage} from '@/lib/erp/modules';
import {ProductCatalogError,saveProductCatalog,type ProductCatalogPayload} from "@/lib/erp/product-catalog";
import {enqueueWebhook} from "@/lib/integrations/webhooks";
import { invalidateMarginReportCache } from "@/lib/erp/report-cache";
import { createPosT2BoundaryIdempotencyKey, preparePosT2CatalogBoundary, toPosT2BoundaryIdempotencyKey } from "@/lib/erp/pos-t2-boundary";
import { HttpSecurityError, httpSecurityErrorResponse, privateJson, readJsonObject, unexpectedErrorResponse } from "@/lib/http-security";

async function operationalContext(prisma: Awaited<ReturnType<typeof tenantDb>>, userId: string) {
  const profile = await prisma.tenantUserProfile.findUnique({ where: { userId }, select: { id: true, status: true, activeBranchId: true } });
  const branchId = profile?.activeBranchId || (await prisma.branch.findFirst({ where: { primary: true, status: "active" }, select: { id: true } }))?.id;
  if (!profile || profile.status !== "active" || !branchId) return null;
  const [branch, access] = await Promise.all([prisma.branch.findUnique({ where: { id: branchId }, include: { settings: true, warehouses: { where: { active: true }, orderBy: { primary: "desc" } } } }), prisma.branchUserAccess.findUnique({ where: { branchId_userProfileId: { branchId, userProfileId: profile.id } } })]);
  if (!branch || branch.status !== "active") return null;
  const warehouseId = branch.defaultWarehouseId || branch.warehouses[0]?.id || null;
  return { branch, access, warehouseId };
}

async function snapshot(prisma: Awaited<ReturnType<typeof tenantDb>>, scope: ErpPage, userId: string, modules: unknown) {
  const needsProducts = ["products", "stock", "pdv"].includes(scope);
  const needsMovements = scope === "stock";
  const needsSales = false;
  const context = await operationalContext(prisma, userId);
  const branchId = context?.branch.id;
  const [products, movementRows, sales, saleItems, settings, categories, brands, marketplaceChannels] = await Promise.all([
    needsProducts ? prisma.product.findMany({ include: { branchConfigurations: { where: branchId ? { branchId } : { branchId: -1 } }, warehouseBalances: { where: branchId ? { warehouse: { branchId } } : { warehouseId: -1 } }, brand: true, imageMedia: true, seoOgImageMedia: true, videoMedia: true, videoThumbnailMedia: true, gallery: { include: { mediaAsset: true }, orderBy: { position: "asc" } }, categoryLinks: { include: { category: true } }, tagLinks: { include: { tag: true } }, attributes: { include: { options: { orderBy: { position: "asc" } } }, orderBy: { position: "asc" } }, variations: { include: { imageMedia: true, gallery: { include: { mediaAsset: true }, orderBy: { position: "asc" } } }, orderBy: { menuOrder: "asc" } }, downloads: { include: { mediaAsset: true }, orderBy: { position: "asc" } }, costItems: { orderBy: { id: "asc" } }, priceTiers: { orderBy: { minimumQty: "asc" } }, marketplaceProfiles: planAllows(modules, "marketplaces") ? { orderBy: { platform: "asc" } } : false, relatedFrom: { orderBy: { position: "asc" } } }, orderBy: [{ active: "desc" }, { name: "asc" }] }) : [],
    needsMovements ? prisma.stockMovement.findMany({ where: branchId ? { warehouse: { branchId } } : { warehouseId: -1 }, include: { product: { select: { name: true, unit: true } } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] }) : [],
    needsSales ? prisma.sale.findMany({ where: branchId ? { branchId } : { branchId: -1 }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] }) : [],
    needsSales ? prisma.saleItem.findMany({ where: branchId ? { sale: { branchId } } : { saleId: -1 }, orderBy: { id: "desc" } }) : [],
    ["pdv", "products"].includes(scope) ? prisma.tenantSettings.findUnique({ where: { id: 1 }, select: { autoGenerateSku: true, defaultPaymentMethod: true, defaultCustomerName: true, requireCustomer: true, lowStockAlerts: true } }) : null,
    scope === "products" ? prisma.category.findMany({ where: { active: true }, orderBy: { name: "asc" } }) : [],
    scope === "products" ? prisma.productBrand.findMany({ where: { active: true }, orderBy: { name: "asc" } }) : [],
    scope === "products" && planAllows(modules, "marketplaces") ? prisma.marketplaceChannel.findMany({ where: { status: "active" }, orderBy: { name: "asc" } }) : [],
  ]);
  const branchProducts = products.map(({ branchConfigurations, warehouseBalances, ...product }) => { const configuration = branchConfigurations[0]; return { ...product, imageMedia: publicMedia(product.imageMedia), seoOgImageMedia: publicMedia(product.seoOgImageMedia), videoMedia: publicMedia(product.videoMedia), videoThumbnailMedia: publicMedia(product.videoThumbnailMedia), gallery: product.gallery.map(item => ({ ...item, mediaAsset: publicMedia(item.mediaAsset) })), variations: product.variations.map(variation => ({ ...variation, imageMedia: publicMedia(variation.imageMedia), gallery: variation.gallery.map(item => ({ ...item, mediaAsset: publicMedia(item.mediaAsset) })) })), downloads: product.downloads.map(item => ({ ...item, mediaAsset: publicMedia(item.mediaAsset) })), catalogCost: product.cost, catalogMinStock: product.minStock, price: configuration?.priceOverride ?? product.price, cost: configuration?.costOverride ?? product.cost, stock: warehouseBalances.reduce((sum, balance) => sum + balance.quantity - balance.reservedQuantity, 0), physicalStock: warehouseBalances.reduce((sum, balance) => sum + balance.quantity, 0), reservedStock: warehouseBalances.reduce((sum, balance) => sum + balance.reservedQuantity, 0), minStock: configuration?.minStock ?? product.minStock, branchConfiguration: configuration || null }; }).filter(product => scope === "products" || (product.active && product.branchConfiguration?.active && (scope !== "pdv" || product.branchConfiguration.saleEnabled)));
  const movements = movementRows.map(({ product, ...item }) => ({ ...item, productName: product.name, unit: product.unit }));
  const operationalWarehouse = context?.branch.warehouses.find(warehouse => warehouse.id === context.warehouseId) || null;
  return { products: branchProducts, movements, sales, saleItems, settings, categories, brands, marketplaceChannels, operationalBranch: context ? { id: context.branch.id, code: context.branch.code, name: context.branch.name, warehouseId: context.warehouseId, warehouseName: operationalWarehouse?.name || null, canManageStock: Boolean(context.access?.canManageStock) } : null };
}

export async function GET(request:Request) {
  try { const organization = await currentOrganization(),user=await currentUser();if(!user)return bad('Sessão inválida.',401);const requested=new URL(request.url).searchParams.get('scope')||'dashboard';if(!isErpPage(requested))return bad('Módulo inválido.',404);await assertTenantPermission(organization.id,`${requested}.read`);return Response.json(await snapshot(await tenantDb(organization.id),requested,user.id,organization.modules)); }
  catch (error) { return fail(error, "Não foi possível carregar os dados."); }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const organization = await currentOrganization();
    const user=await currentUser();
    const prisma = await tenantDb(organization.id);
    if (!user) return bad("Sessão inválida.", 401);
    const configuration = await prisma.tenantSettings.findUnique({ where: { id: 1 } });
    if (!configuration) return bad("Configurações da organização não inicializadas.");
    const body = await readJsonObject(request, 2_097_152) as { action?: string; product?: ProductCatalogPayload; id?: number; idempotencyKey?: string; type?: "entry" | "exit"; quantity?: number; note?: string; customer?: string; seller?: string; paymentMethod?: string; items?: Array<{ productId: number; quantity: number }> };
    const permission=body.action==='create_product'||body.action==='update_product'||body.action==='toggle_product'||body.action==='delete_product'?'products.write':body.action==='stock_movement'?'stock.write':body.action==='create_sale'?'pdv.write':null;
    if(!permission)return bad("Ação não reconhecida.");
    await assertTenantPermission(organization.id,permission);
    await assertTenantWriteAccess(organization.id);
    if (body.action === "create_sale") {
      return bad("Fluxo legado do PDV desativado. Use /api/erp/pdv.", 410);
    }
    const context = await operationalContext(prisma, user.id);
    if (!context) return bad("Selecione uma filial ativa antes de operar.", 409);
    if (body.action === "create_product" || body.action === "update_product") {
      if (!planAllows(organization.modules, "service-orders") && (body.product?.type === "service" || body.product?.fiscalType === "service" || body.product?.seoSchemaType === "Service")) return bad("Serviços não estão habilitados neste plano.",403);
      if (!planAllows(organization.modules, "marketplaces") && body.product?.marketplaces?.length) return bad("Marketplaces não estão habilitados neste plano.",403);
      if (body.action === "update_product" && (!Number.isSafeInteger(body.product?.id) || Number(body.product?.id) <= 0)) return bad("Informe um produto válido para editar.");
      const product = { ...(body.product ?? {}), ...(body.action === "update_product" ? { id: body.product?.id } : { id: undefined }) };
      await prisma.$transaction(async (tx) => { const saved = await saveProductCatalog(tx, product, { autoGenerateSku: configuration.autoGenerateSku, warehouseId: context.warehouseId, branchId: context.branch.id, actor: user.name || "Usuário NALVEN", actorUserId: user.id, idempotencyKey: validBoundaryKey(body.idempotencyKey) }); await enqueueWebhook(tx, body.action === "create_product" ? "product.created" : "product.updated", { id: saved.id, active: saved.active, occurred_at: new Date().toISOString() }); }, { isolationLevel: "Serializable" });
      invalidateMarginReportCache();
      return Response.json(await snapshot(prisma,"products",user.id,organization.modules));
    }
    if (body.action === "toggle_product" || body.action === "delete_product") {
      const updated = await prisma.$transaction(async (tx) => { const product = await tx.product.findFirst({ where: { id: body.id } }); if (!product) throw new ProductCatalogError("Produto não encontrado."); const active = body.action === "delete_product" ? false : !product.active; const boundary = await preparePosT2CatalogBoundary(tx, { action: "set_active", productId: product.id, expectedProductRevision: product.posRevision, expectedProductConfigHash: product.posConfigHash, productProjection: { active, gtinSnapshot: product.gtin, manageStock: product.manageStock, nameLabel: product.name, productType: product.type, skuSnapshot: product.sku, status: product.status, unit: product.unit }, variations: [], actorUserId: user.id, idempotencyKey: validBoundaryKey(body.idempotencyKey) }); const saved = boundary.replayed ? await tx.product.findUniqueOrThrow({ where: { id: boundary.productId } }) : await tx.product.update({ where: { id: product.id }, data: { active, posRevision: boundary.productRevision, posConfigHash: boundary.productConfigHash } }); await enqueueWebhook(tx, body.action === "delete_product" ? "product.deleted" : "product.updated", { id: saved.id, active: saved.active, occurred_at: new Date().toISOString() }); return saved; }, { isolationLevel: "Serializable" }); void updated;
      invalidateMarginReportCache();
      return Response.json(await snapshot(prisma,"products",user.id,organization.modules));
    }
    if (body.action === "stock_movement") {
      if (!context.access?.canManageStock) return bad("Seu acesso nesta filial não permite movimentar estoque.", 403);
      const productId = Number(body.id);
      const quantity = Number(body.quantity);
      const note = String(body.note || "").trim();
      if (!Number.isInteger(productId) || productId <= 0) return bad("Selecione um produto válido.");
      if (body.type !== "entry" && body.type !== "exit") return bad("Selecione um tipo de movimentação válido.");
      const movementType = body.type;
      if (!Number.isFinite(quantity) || quantity <= 0) return bad("Informe uma quantidade válida e maior que zero.");
      if (note.length > 500) return bad("A observação deve ter no máximo 500 caracteres.");
      const product = await prisma.product.findFirst({ where: { id: productId } });
      const warehouse = context.warehouseId ? await prisma.warehouse.findFirst({ where: { id: context.warehouseId, active: true, branchId: context.branch.id } }) : null;
      if (!product || product.type !== "product" || !product.active || !product.manageStock || !warehouse) return bad("Selecione um produto ativo com controle de estoque e um depósito válido.");
      const balance = await prisma.warehouseBalance.findUnique({ where: { warehouseId_productId: { warehouseId: warehouse.id, productId: product.id } } });
      if (!balance) return bad("O produto não possui saldo no depósito principal.");
      const currentStock = movementType === "exit" ? product.stock - quantity : product.stock + quantity;
      const warehouseStock = movementType === "exit" ? balance.quantity - quantity : balance.quantity + quantity;
      if (!configuration.allowNegativeStock && (currentStock < 0 || warehouseStock < balance.reservedQuantity)) return bad("A saída não pode consumir o saldo reservado do depósito principal.");
      await prisma.$transaction(async tx => {
        const changed = await tx.warehouseBalance.updateMany({ where: { id: balance.id, quantity: balance.quantity, reservedQuantity: balance.reservedQuantity }, data: { quantity: warehouseStock } });
        if (changed.count !== 1) throw new Error("O saldo foi alterado por outro usuário. Tente novamente.");
        await tx.product.update({ where: { id: product.id }, data: { stock: currentStock } });
        await tx.stockMovement.create({ data: { productId: product.id, warehouseId: warehouse.id, type: movementType, quantity, previousStock: balance.quantity, currentStock: warehouseStock, note: note || null, userName: user?.name||"Usuário NALVEN" } });
        await tx.warehouseLedgerEntry.create({ data: { warehouseId: warehouse.id, productId: product.id, type: movementType, quantity: movementType === "exit" ? -quantity : quantity, balanceBefore: balance.quantity, balanceAfter: warehouseStock, referenceType: "stock_movement", actor: user?.name || "Usuário NALVEN" } });
      }, { isolationLevel: "Serializable" });
      return Response.json(await snapshot(prisma,"stock",user.id,organization.modules));
    }
    return bad("Ação não reconhecida.");
  } catch (error) { return fail(error, "Não foi possível concluir a operação."); }
}

function bad(error: string, status = 400) { return privateJson({ error }, { status }); }
function validBoundaryKey(value: unknown) { const key = String(value || ""); return key ? toPosT2BoundaryIdempotencyKey(key) : createPosT2BoundaryIdempotencyKey(); }
function fail(error: unknown, fallback: string) { if(error instanceof HttpSecurityError)return httpSecurityErrorResponse(error);if(error instanceof LicenseDeniedError||error instanceof AuthError)return privateJson({error:error.message},{status:error.status});if(error instanceof ProductCatalogError||error instanceof CustomerInputError)return privateJson({error:error.message},{status:error instanceof CustomerInputError&&error.message.includes('Origem')?403:400});return unexpectedErrorResponse(`erp.root:${fallback}`,error); }
function publicMedia(asset: { id: string; name: string; originalName: string; mimeType: string; kind: string; sizeBytes: number; altText: string; folder: string; uploadedByName: string; createdAt: Date; deletedAt: Date | null } | null) { return asset ? { id: asset.id, name: asset.name, originalName: asset.originalName, mimeType: asset.mimeType, kind: asset.kind, sizeBytes: asset.sizeBytes, altText: asset.altText, folder: asset.folder, uploadedByName: asset.uploadedByName, createdAt: asset.createdAt, deletedAt: asset.deletedAt, url: `/api/erp/library/${asset.id}/file` } : null; }
