import { Prisma } from "@/generated/tenant/client";
import { validGtin } from "@/lib/erp/report-domain";
import { createPosT2BoundaryIdempotencyKey, preparePosT2CatalogBoundary, type PosT2CatalogBoundaryResult } from "@/lib/erp/pos-t2-boundary";

export type ProductCatalogPayload = {
  id?: number;
  name?: string;
  slug?: string;
  sku?: string;
  barcode?: string;
  gtin?: string;
  gtinTributary?: string;
  mpn?: string;
  model?: string;
  type?: string;
  catalogType?: string;
  status?: string;
  catalogVisibility?: string;
  featured?: boolean;
  active?: boolean;
  description?: string;
  shortDescription?: string;
  menuOrder?: number;
  regularPrice?: number;
  salePrice?: number | null;
  saleStartsAt?: string;
  saleEndsAt?: string;
  installmentPrice?: number | null;
  cashPrice?: number | null;
  minimumSalePrice?: number | null;
  targetMargin?: number | null;
  pricingSource?: string;
  cestNotApplicable?: boolean;
  cost?: number;
  cogs?: number | null;
  category?: string;
  categoryId?: number | null;
  categoryIds?: number[];
  brand?: string;
  supplier?: string;
  stock?: number;
  manageStock?: boolean;
  stockStatus?: string;
  backorders?: string;
  minStock?: number;
  soldIndividually?: boolean;
  unit?: string;
  weight?: number | null;
  weightUnit?: string;
  length?: number | null;
  width?: number | null;
  height?: number | null;
  dimensionUnit?: string;
  netWeight?: number | null;
  grossWeight?: number | null;
  volumes?: number | null;
  itemsPerBox?: number | null;
  shippingClass?: string;
  crossDockingDays?: number | null;
  freeShipping?: boolean;
  virtual?: boolean;
  taxStatus?: string;
  taxClass?: string;
  downloadable?: boolean;
  downloadLimit?: number | null;
  downloadExpiryDays?: number | null;
  externalUrl?: string;
  buttonText?: string;
  reviewsAllowed?: boolean;
  purchaseNote?: string;
  warrantyMonths?: number | null;
  condition?: string;
  fiscalType?: string;
  production?: string;
  expiryDate?: string;
  ncm?: string;
  cest?: string;
  origin?: string;
  spedItemType?: string;
  taxBurdenRate?: number | null;
  additionalInvoiceInfo?: string;
  icmsStBase?: number | null;
  icmsStValue?: number | null;
  icmsSubstituteValue?: number | null;
  ipiExceptionCode?: string;
  ipiClassification?: string;
  pisFixedValue?: number | null;
  cofinsFixedValue?: number | null;
  csosn?: string;
  fci?: string;
  anatelCode?: string;
  anvisaCode?: string;
  inmetroCode?: string;
  mapaCode?: string;
  gender?: string;
  seoTitle?: string;
  seoDescription?: string;
  seoNoindex?: boolean;
  seoCanonical?: string;
  seoFocusKeyword?: string;
  seoSecondaryKeywords?: string[];
  seoScore?: number | null;
  seoSchemaType?: string;
  seoOgImageMediaId?: string | null;
  imageMediaId?: string | null;
  galleryMediaIds?: string[];
  videoType?: string;
  videoUrl?: string;
  videoMediaId?: string | null;
  videoThumbnailMediaId?: string | null;
  videoAspectRatio?: string;
  defaultVariationRule?: string;
  tags?: string[];
  badges?: Array<{ label: string; color?: string }>;
  customFields?: Array<{ label: string; value: string }>;
  carouselConfig?: { enabled?: boolean; autoplay?: boolean; interval?: number };
  configuratorData?: { fields?: Array<{ label: string; type: string; required?: boolean; price?: number }> };
  attributes?: ProductAttributePayload[];
  variations?: ProductVariationPayload[];
  downloads?: Array<{ name: string; url?: string; mediaAssetId?: string | null }>;
  costItems?: Array<{ type: string; label: string; value: number }>;
  priceTiers?: Array<{ minimumQty: number; maximumQty?: number | null; price: number }>;
  relations?: Array<{ relatedProductId: number; type: string }>;
  marketplaces?: ProductMarketplacePayload[];
};

type ProductAttributePayload = {
  name: string;
  type?: string;
  swatchType?: string;
  scope?: string;
  visible?: boolean;
  variation?: boolean;
  options?: Array<{ name: string; value?: string; color?: string; imageMediaId?: string | null }>;
};

type ProductVariationPayload = {
  id?: number;
  sku?: string;
  gtin?: string;
  status?: string;
  attributes?: Array<{ name: string; value: string }>;
  regularPrice?: number | null;
  salePrice?: number | null;
  saleStartsAt?: string;
  saleEndsAt?: string;
  manageStock?: string;
  stock?: number | null;
  stockStatus?: string;
  backorders?: string;
  weight?: number | null;
  length?: number | null;
  width?: number | null;
  height?: number | null;
  imageMediaId?: string | null;
  galleryMediaIds?: string[];
  videoUrl?: string;
  description?: string;
  enabled?: boolean;
};

type ProductMarketplacePayload = {
  platform: string;
  channelId?: number | null;
  remoteCategoryId?: string;
  remoteCatalogProductId?: string;
  listingType?: string;
  priceOverride?: number | null;
  stockOverride?: number | null;
  attributes?: Array<{ name: string; value: string }>;
  saleTerms?: Array<{ name: string; value: string }>;
};

const PRODUCT_TYPES = ["product", "service"];
const CATALOG_TYPES = ["simple", "variable", "external", "grouped"];
const STATUSES = ["publish", "draft", "pending", "private", "trash"];
const VISIBILITIES = ["visible", "catalog", "search", "hidden"];
const STOCK_STATUSES = ["instock", "outofstock", "onbackorder"];
const BACKORDERS = ["no", "notify", "yes"];
const CONDITIONS = ["new", "used", "refurbished", "not_specified"];
const UNITS = ["UN", "KG", "GR", "MT", "CM", "MM", "ML", "LT", "M2", "M3", "PC", "CX", "PAR", "DZ", "KIT", "SV"];
const PLATFORMS = ["mercado_livre", "shopee", "tiktok_shop", "plug4market", "bling", "amazon", "google"];

export async function saveProductCatalog(
  tx: Prisma.TransactionClient,
  input: ProductCatalogPayload,
  options: { autoGenerateSku: boolean; warehouseId: number | null; branchId: number; actor: string; actorUserId: string; idempotencyKey?: string },
) {
  const name = text(input.name, 200);
  const categoryName = text(input.category, 120);
  if (!name || (!categoryName && !input.categoryId)) throw new ProductCatalogError("Nome e categoria principal são obrigatórios.");
  const type = enumValue(input.type, PRODUCT_TYPES, "product");
  const catalogType = enumValue(input.catalogType, CATALOG_TYPES, "simple");
  if (type === "service" && catalogType !== "simple" && catalogType !== "external") throw new ProductCatalogError("Serviços podem ser simples ou externos.");
  const sku = text(input.sku, 100) || (options.autoGenerateSku ? `${type === "service" ? "SER" : "SKU"}-${Date.now().toString().slice(-8)}` : "");
  if (!sku) throw new ProductCatalogError("Informe o SKU; a geração automática está desativada.");
  if (await tx.product.findFirst({ where: { sku, ...(input.id ? { id: { not: input.id } } : {}) }, select: { id: true } })) throw new ProductCatalogError("SKU já utilizado. Informe um código único para este item.");
  validateDigits(input.gtin, "GTIN", [8, 12, 13, 14]);
  validateDigits(input.gtinTributary, "GTIN tributário", [8, 12, 13, 14]);
  if (input.gtin && !validGtin(input.gtin)) throw new ProductCatalogError("GTIN inválido: confira o dígito verificador.");
  if (input.gtinTributary && !validGtin(input.gtinTributary)) throw new ProductCatalogError("GTIN tributário inválido: confira o dígito verificador.");
  validateDigits(input.ncm, "NCM", [8]);
  if (!input.cestNotApplicable) validateDigits(input.cest, "CEST", [7]);
  if (input.origin && !/^[0-8]$/.test(input.origin)) throw new ProductCatalogError("Origem fiscal deve estar entre 0 e 8.");
  if (input.spedItemType && !/^\d{2}$/.test(input.spedItemType)) throw new ProductCatalogError("Tipo do item SPED deve ter dois dígitos.");

  const saleStartsAt = dateTime(input.saleStartsAt);
  const saleEndsAt = dateTime(input.saleEndsAt);
  if (saleStartsAt && saleEndsAt && saleEndsAt <= saleStartsAt) throw new ProductCatalogError("O fim da promoção deve ser posterior ao início.");
  const regularPrice = nonNegative(input.regularPrice ?? 0, "Preço regular");
  const salePrice = optionalNonNegative(input.salePrice, "Preço promocional");
  const now = new Date();
  const saleActive = salePrice !== null && (!saleStartsAt || saleStartsAt <= now) && (!saleEndsAt || saleEndsAt >= now);
  const effectivePrice = saleActive ? salePrice : regularPrice;

  const mediaIds = unique([
    input.imageMediaId,
    input.seoOgImageMediaId,
    input.videoMediaId,
    input.videoThumbnailMediaId,
    ...(input.galleryMediaIds || []),
    ...(input.downloads || []).map((item) => item.mediaAssetId),
    ...(input.attributes || []).flatMap((attribute) => (attribute.options || []).map((option) => option.imageMediaId)),
    ...(input.variations || []).map((variation) => variation.imageMediaId),
    ...(input.variations || []).flatMap((variation) => variation.galleryMediaIds || []),
  ].filter((value): value is string => Boolean(value)));
  if (mediaIds.length) {
    const validMedia = await tx.tenantMediaAsset.count({ where: { id: { in: mediaIds }, deletedAt: null } });
    if (validMedia !== mediaIds.length) throw new ProductCatalogError("Uma ou mais mídias selecionadas não estão disponíveis.");
  }

  const existing = input.id ? await tx.product.findUnique({ where: { id: input.id }, select: { id: true, slug: true, stock: true, posRevision: true, posConfigHash: true, variations: { select: { id: true, posRevision: true, posConfigHash: true } } } }) : null;
  if (input.id && !existing) throw new ProductCatalogError("Produto não encontrado.");
  const slug = await uniqueSlug(tx, input.slug || name, existing?.id);
  const category = await resolveCategory(tx, input.categoryId, categoryName);
  const brand = await resolveBrand(tx, input.brand);
  if (existing && existing.stock !== 0 && (type === "service" || !input.manageStock)) throw new ProductCatalogError("Zere o saldo por movimentação de estoque antes de desativar o controle ou converter em serviço.");
  const stock = existing && input.stock === undefined ? existing.stock : type === "service" || !input.manageStock ? 0 : nonNegative(input.stock ?? 0, "Estoque");
  const stockStatus = stock <= 0 && input.stockStatus === undefined ? "outofstock" : enumValue(input.stockStatus, STOCK_STATUSES, "instock");
  const scalar = {
    name,
    slug,
    sku,
    barcode: nullableText(input.barcode, 40),
    gtin: digits(input.gtin),
    gtinTributary: digits(input.gtinTributary),
    mpn: nullableText(input.mpn, 120),
    model: nullableText(input.model, 120),
    type,
    catalogType,
    status: enumValue(input.status, STATUSES, "publish"),
    catalogVisibility: enumValue(input.catalogVisibility, VISIBILITIES, "visible"),
    featured: Boolean(input.featured),
    active: input.active !== false && input.status !== "trash",
    description: nullableText(input.description, 100_000),
    shortDescription: nullableText(input.shortDescription, 10_000),
    menuOrder: integer(input.menuOrder, 0),
    price: effectivePrice,
    regularPrice,
    salePrice,
    saleStartsAt,
    saleEndsAt,
    installmentPrice: optionalNonNegative(input.installmentPrice, "Preço da parcela"),
    cashPrice: optionalNonNegative(input.cashPrice, "Preço à vista"),
    minimumSalePrice: optionalNonNegative(input.minimumSalePrice, "Preço mínimo"),
    targetMargin: optionalNumber(input.targetMargin),
    pricingSource: enumValue(input.pricingSource, ["auto", "product", "category", "global"], "auto"),
    cost: nonNegative(input.cost ?? 0, "Custo"),
    cogs: optionalNonNegative(input.cogs, "COGS"),
    category: category.name,
    categoryId: category.id,
    brandId: brand?.id || null,
    supplier: nullableText(input.supplier, 200),
    stock,
    manageStock: type === "product" && input.manageStock !== false,
    stockStatus,
    backorders: enumValue(input.backorders, BACKORDERS, "no"),
    minStock: nonNegative(input.minStock ?? 0, "Estoque mínimo"),
    soldIndividually: Boolean(input.soldIndividually),
    unit: enumValue(input.unit, UNITS, type === "service" ? "SV" : "UN"),
    weight: optionalNonNegative(input.weight, "Peso"),
    weightUnit: enumValue(input.weightUnit, ["kg", "g", "mg", "lb", "oz"], "kg"),
    length: optionalNonNegative(input.length, "Comprimento"),
    width: optionalNonNegative(input.width, "Largura"),
    height: optionalNonNegative(input.height, "Altura"),
    dimensionUnit: enumValue(input.dimensionUnit, ["cm", "m", "mm", "in"], "cm"),
    netWeight: optionalNonNegative(input.netWeight, "Peso líquido"),
    grossWeight: optionalNonNegative(input.grossWeight, "Peso bruto"),
    volumes: optionalInteger(input.volumes),
    itemsPerBox: optionalNonNegative(input.itemsPerBox, "Itens por caixa"),
    shippingClass: nullableText(input.shippingClass, 100),
    crossDockingDays: optionalInteger(input.crossDockingDays),
    freeShipping: Boolean(input.freeShipping),
    virtual: type === "service" || Boolean(input.virtual),
    taxStatus: enumValue(input.taxStatus, ["taxable", "shipping", "none"], "taxable"),
    taxClass: nullableText(input.taxClass, 80),
    downloadable: Boolean(input.downloadable),
    downloadLimit: optionalInteger(input.downloadLimit),
    downloadExpiryDays: optionalInteger(input.downloadExpiryDays),
    externalUrl: nullableUrl(input.externalUrl, "URL externa"),
    buttonText: nullableText(input.buttonText, 80),
    reviewsAllowed: input.reviewsAllowed !== false,
    purchaseNote: nullableText(input.purchaseNote, 2_000),
    warrantyMonths: optionalNonNegative(input.warrantyMonths, "Garantia"),
    condition: enumValue(input.condition, CONDITIONS, "new"),
    fiscalType: enumValue(input.fiscalType, ["product", "service"], type),
    production: enumValue(input.production, ["own", "third_party", ""], "") || null,
    expiry: nullableText(input.expiryDate, 10),
    expiryDate: plainDate(input.expiryDate),
    ncm: digits(input.ncm),
    cest: input.cestNotApplicable ? null : digits(input.cest),
    cestNotApplicable: Boolean(input.cestNotApplicable),
    origin: nullableText(input.origin, 1),
    spedItemType: nullableText(input.spedItemType, 2),
    taxBurdenRate: optionalNonNegative(input.taxBurdenRate, "Alíquota aproximada"),
    additionalInvoiceInfo: nullableText(input.additionalInvoiceInfo, 2_000),
    icmsStBase: optionalNonNegative(input.icmsStBase, "Base ICMS-ST"),
    icmsStValue: optionalNonNegative(input.icmsStValue, "Valor ICMS-ST"),
    icmsSubstituteValue: optionalNonNegative(input.icmsSubstituteValue, "ICMS substituto"),
    ipiExceptionCode: nullableText(input.ipiExceptionCode, 30),
    ipiClassification: nullableText(input.ipiClassification, 30),
    pisFixedValue: optionalNonNegative(input.pisFixedValue, "PIS fixo"),
    cofinsFixedValue: optionalNonNegative(input.cofinsFixedValue, "COFINS fixo"),
    csosn: nullableText(input.csosn, 4),
    fci: nullableText(input.fci, 80),
    anatelCode: nullableText(input.anatelCode, 80),
    anvisaCode: nullableText(input.anvisaCode, 80),
    inmetroCode: nullableText(input.inmetroCode, 80),
    mapaCode: nullableText(input.mapaCode, 80),
    gender: nullableText(input.gender, 40),
    seoTitle: nullableText(input.seoTitle, 70),
    seoDescription: nullableText(input.seoDescription, 180),
    seoNoindex: Boolean(input.seoNoindex),
    seoCanonical: nullableUrl(input.seoCanonical, "URL canônica"),
    seoFocusKeyword: nullableText(input.seoFocusKeyword, 100),
    seoSecondaryKeywords: unique((input.seoSecondaryKeywords || []).map((item) => text(item, 100)).filter(Boolean)),
    seoScore: input.seoScore === null || input.seoScore === undefined ? null : Math.min(100, Math.max(0, integer(input.seoScore, 0))),
    seoSchemaType: enumValue(input.seoSchemaType, ["Product", "Service", "SoftwareApplication"], type === "service" ? "Service" : "Product"),
    seoOgImageMediaId: input.seoOgImageMediaId || null,
    imageMediaId: input.imageMediaId || null,
    videoType: enumValue(input.videoType, ["upload", "youtube", "vimeo", "instagram", ""], "") || null,
    videoUrl: nullableUrl(input.videoUrl, "URL do vídeo"),
    videoMediaId: input.videoMediaId || null,
    videoThumbnailMediaId: input.videoThumbnailMediaId || null,
    videoAspectRatio: enumValue(input.videoAspectRatio, ["1:1", "3:4", "9:16", ""], "") || null,
    defaultVariationRule: enumValue(input.defaultVariationRule, ["lowest_price", "first_available", "manual"], "lowest_price"),
    badges: jsonOrNull(input.badges?.filter((badge) => text(badge.label, 80)).map((badge) => ({ label: text(badge.label, 80), color: color(badge.color) }))),
    carouselConfig: jsonOrNull(input.carouselConfig),
    configuratorData: jsonOrNull(input.configuratorData),
    customFields: jsonOrNull(input.customFields?.filter((field) => text(field.label, 100)).map((field) => ({ label: text(field.label, 100), value: text(field.value, 2_000) }))),
  } satisfies Prisma.ProductUncheckedCreateInput;

  const normalizedVariations = normalizeVariations(input.variations || []);
  const existingVariations = new Map((existing?.variations || []).map(item => [item.id, item]));
  for (const variation of normalizedVariations) {
    if (variation.id !== null && !existingVariations.has(variation.id)) throw new ProductCatalogError("A variação não pertence à versão atual do produto.");
  }
  const boundary = await preparePosT2CatalogBoundary(tx, {
    action: "put_graph",
    productId: existing?.id ?? null,
    expectedProductRevision: existing?.posRevision ?? null,
    expectedProductConfigHash: existing?.posConfigHash ?? null,
    productProjection: { active: scalar.active, gtinSnapshot: scalar.gtin, manageStock: scalar.manageStock, nameLabel: scalar.name, productType: scalar.type, skuSnapshot: scalar.sku, status: scalar.status, unit: scalar.unit },
    variations: normalizedVariations.map((variation, ordinal) => {
      const current = variation.id === null ? null : existingVariations.get(variation.id)!;
      return { enabled: variation.data.enabled !== false, expectedConfigHash: current?.posConfigHash ?? null, expectedRevision: current?.posRevision ?? null, gtinSnapshot: variation.data.gtin == null ? null : String(variation.data.gtin), manageStock: String(variation.data.manageStock || "parent"), ordinal, skuSnapshot: variation.data.sku == null ? null : String(variation.data.sku), status: String(variation.data.status || "publish"), variationId: variation.id };
    }),
    actorUserId: options.actorUserId,
    idempotencyKey: options.idempotencyKey || createPosT2BoundaryIdempotencyKey(),
  });
  if (boundary.replayed) return tx.product.findUniqueOrThrow({ where: { id: boundary.productId } });

  const product = existing
    ? await tx.product.update({ where: { id: existing.id }, data: { ...scalar, posRevision: boundary.productRevision, posConfigHash: boundary.productConfigHash } })
    : await tx.product.create({ data: { ...scalar, id: boundary.productId, posRevision: boundary.productRevision, posConfigHash: boundary.productConfigHash } });
  if (existing && existing.slug !== slug) await tx.productSlugRedirect.upsert({ where: { oldSlug: existing.slug }, update: { productId: product.id }, create: { productId: product.id, oldSlug: existing.slug } });

  await replaceProductRelations(tx, product.id, input, category.id, options.warehouseId, normalizedVariations, boundary);
  if (!existing) await initializeProductOperations(tx, product.id, scalar, options);
  else if (type === "product" && existing.stock !== stock && options.warehouseId) await synchronizeEditedStock(tx, product.id, existing.stock, stock, options);
  return product;
}

type NormalizedVariation = { id: number | null; galleryMediaIds: string[]; data: Prisma.ProductVariationUncheckedCreateWithoutProductInput };

function normalizeVariations(values: ProductVariationPayload[]): NormalizedVariation[] {
  const result: NormalizedVariation[] = [];
  for (const variation of values) {
    if (!variation.sku && !(variation.attributes || []).length) continue;
    validateDigits(variation.gtin, "GTIN da variação", [8, 12, 13, 14]);
    const id = variation.id == null ? null : integer(variation.id, 0);
    if (id !== null && id <= 0) throw new ProductCatalogError("Identificador da variação inválido.");
    const menuOrder = result.length;
    result.push({
      id,
      galleryMediaIds: unique(variation.galleryMediaIds || []),
      data: {
        sku: nullableText(variation.sku, 100), gtin: digits(variation.gtin), status: enumValue(variation.status, STATUSES, "publish"),
        attributes: (variation.attributes || []).filter(item => text(item.name, 100)).map(item => ({ name: text(item.name, 100), value: text(item.value, 100) })),
        regularPrice: optionalNonNegative(variation.regularPrice, "Preço da variação"), salePrice: optionalNonNegative(variation.salePrice, "Preço promocional da variação"),
        saleStartsAt: dateTime(variation.saleStartsAt), saleEndsAt: dateTime(variation.saleEndsAt), manageStock: enumValue(variation.manageStock, ["true", "false", "parent"], "parent"),
        stock: optionalNonNegative(variation.stock, "Estoque da variação"), stockStatus: enumValue(variation.stockStatus, [...STOCK_STATUSES, ""], "") || null,
        backorders: enumValue(variation.backorders, [...BACKORDERS, ""], "") || null, weight: optionalNonNegative(variation.weight, "Peso da variação"),
        length: optionalNonNegative(variation.length, "Comprimento da variação"), width: optionalNonNegative(variation.width, "Largura da variação"),
        height: optionalNonNegative(variation.height, "Altura da variação"), imageMediaId: variation.imageMediaId || null,
        videoUrl: nullableUrl(variation.videoUrl, "Vídeo da variação"), description: nullableText(variation.description, 4_000), enabled: variation.enabled !== false, menuOrder,
      },
    });
  }
  if (new Set(result.filter(item => item.id !== null).map(item => item.id)).size !== result.filter(item => item.id !== null).length) throw new ProductCatalogError("A mesma variação foi informada mais de uma vez.");
  return result;
}

async function replaceProductRelations(tx: Prisma.TransactionClient, productId: number, input: ProductCatalogPayload, primaryCategoryId: number, warehouseId: number | null, variations: NormalizedVariation[], boundary: PosT2CatalogBoundaryResult) {
  await Promise.all([
    tx.productImage.deleteMany({ where: { productId } }),
    tx.productCategoryLink.deleteMany({ where: { productId } }),
    tx.productTagLink.deleteMany({ where: { productId } }),
    tx.productAttribute.deleteMany({ where: { productId } }),
    tx.productDownload.deleteMany({ where: { productId } }),
    tx.productCostItem.deleteMany({ where: { productId } }),
    tx.productPriceTier.deleteMany({ where: { productId } }),
    tx.productRelation.deleteMany({ where: { productId } }),
    ...(input.marketplaces !== undefined ? [tx.productMarketplaceProfile.deleteMany({ where: { productId } })] : []),
  ]);
  const deletedVariationIds = boundary.variations.filter(item => item.action === "delete").map(item => item.variationId);
  if (deletedVariationIds.length) await tx.productVariation.deleteMany({ where: { productId, id: { in: deletedVariationIds } } });
  const gallery = unique(input.galleryMediaIds || []);
  if (gallery.length) await tx.productImage.createMany({ data: gallery.map((mediaAssetId, position) => ({ productId, mediaAssetId, position })) });
  const categoryIds = unique([primaryCategoryId, ...(input.categoryIds || []).filter(Number.isInteger)]);
  if (categoryIds.length) {
    const valid = await tx.category.findMany({ where: { id: { in: categoryIds } }, select: { id: true } });
    await tx.productCategoryLink.createMany({ data: valid.map(({ id }) => ({ productId, categoryId: id, primary: id === primaryCategoryId })) });
  }
  for (const tagName of unique((input.tags || []).map((tag) => text(tag, 60)).filter(Boolean))) {
    const slug = slugify(tagName);
    const tag = await tx.productTag.upsert({ where: { name: tagName }, update: {}, create: { name: tagName, slug: await uniqueTagSlug(tx, slug) } });
    await tx.productTagLink.create({ data: { productId, tagId: tag.id } });
  }
  for (const [position, attribute] of (input.attributes || []).entries()) {
    const name = text(attribute.name, 100);
    if (!name) continue;
    await tx.productAttribute.create({ data: { productId, name, slug: `${slugify(name)}-${position + 1}`, type: enumValue(attribute.type, ["select", "text"], "select"), swatchType: enumValue(attribute.swatchType, ["color", "image", "text", "button", "select", "color_image", "color_label", "image_label"], "select"), scope: enumValue(attribute.scope, ["local", "global"], "local"), visible: attribute.visible !== false, variation: Boolean(attribute.variation), position, options: { create: uniqueBy((attribute.options || []).filter((option) => text(option.name, 100)), (option) => text(option.value || option.name, 100)).map((option, optionPosition) => ({ name: text(option.name, 100), value: text(option.value || option.name, 100), color: color(option.color), imageMediaId: option.imageMediaId || null, position: optionPosition })) } } });
  }
  for (const [ordinal, variation] of variations.entries()) {
    const plan = boundary.variations.find(item => item.ordinal === ordinal && item.action !== "delete");
    if (!plan) throw new ProductCatalogError("O plano boundary não retornou a variação esperada.");
    const data = { ...variation.data, posRevision: plan.revision, posConfigHash: plan.configHash };
    const savedVariation = plan.action === "create"
      ? await tx.productVariation.create({ data: { ...data, id: plan.variationId, productId } })
      : await tx.productVariation.update({ where: { id: plan.variationId }, data });
    if (plan.action === "create" && warehouseId && savedVariation.manageStock === "true") await tx.warehouseVariationBalance.create({ data: { warehouseId, productId, variationId: savedVariation.id, quantity: savedVariation.stock ?? 0, reservedQuantity: 0 } });
    await tx.productVariationImage.deleteMany({ where: { variationId: savedVariation.id } });
    if (variation.galleryMediaIds.length) await tx.productVariationImage.createMany({ data: variation.galleryMediaIds.map((mediaAssetId, position) => ({ variationId: savedVariation.id, mediaAssetId, position })) });
  }
  const downloads = (input.downloads || []).filter((item) => text(item.name, 120) && (item.url || item.mediaAssetId));
  if (downloads.length) await tx.productDownload.createMany({ data: downloads.map((item, position) => ({ productId, name: text(item.name, 120), url: nullableUrl(item.url, "URL do download"), mediaAssetId: item.mediaAssetId || null, position })) });
  const costs = (input.costItems || []).filter((item) => text(item.label, 100));
  if (costs.length) await tx.productCostItem.createMany({ data: costs.map((item) => ({ productId, type: enumValue(item.type, ["direct", "indirect"], "direct"), label: text(item.label, 100), value: nonNegative(item.value, "Componente de custo") })) });
  const tiers = (input.priceTiers || []).filter((item) => Number(item.minimumQty) > 0);
  if (tiers.length) await tx.productPriceTier.createMany({ data: tiers.map((item) => ({ productId, minimumQty: nonNegative(item.minimumQty, "Quantidade mínima"), maximumQty: optionalNonNegative(item.maximumQty, "Quantidade máxima"), price: nonNegative(item.price, "Preço por volume") })) });
  const relations = uniqueBy((input.relations || []).filter((item) => Number.isInteger(item.relatedProductId) && item.relatedProductId !== productId), (item) => `${item.type}:${item.relatedProductId}`);
  if (relations.length) await tx.productRelation.createMany({ data: relations.map((item, position) => ({ productId, relatedProductId: item.relatedProductId, type: enumValue(item.type, ["upsell", "cross_sell", "grouped"], "upsell"), position })) });
  const readinessProduct = await tx.product.findUniqueOrThrow({ where: { id: productId }, include: { brand: true, gallery: { select: { id: true } } } });
  for (const profile of input.marketplaces || []) {
    if (!PLATFORMS.includes(profile.platform)) throw new ProductCatalogError("Marketplace não suportado.");
    const validation = marketplaceReadiness(readinessProduct, profile);
    await tx.productMarketplaceProfile.create({ data: { productId, channelId: profile.channelId || null, platform: profile.platform, remoteCategoryId: nullableText(profile.remoteCategoryId, 190), remoteCatalogProductId: nullableText(profile.remoteCatalogProductId, 190), listingType: nullableText(profile.listingType, 80), attributes: jsonOrNull((profile.attributes || []).filter((item) => text(item.name, 100)).map((item) => ({ name: text(item.name, 100), value: text(item.value, 500) }))), saleTerms: jsonOrNull((profile.saleTerms || []).filter((item) => text(item.name, 100)).map((item) => ({ name: text(item.name, 100), value: text(item.value, 500) }))), priceOverride: optionalNonNegative(profile.priceOverride, "Preço do canal"), stockOverride: optionalNonNegative(profile.stockOverride, "Estoque do canal"), readiness: validation.completeness, ready: validation.missing.length === 0, missingFields: validation.missing, warnings: validation.warnings, lastValidatedAt: new Date() } });
  }
}

function marketplaceReadiness(product: { name: string; sku: string; catalogType: string; externalUrl: string | null; regularPrice: number; description: string | null; imageMediaId: string | null; gtin: string | null; weight: number | null; length: number | null; width: number | null; height: number | null; condition: string; ncm: string | null; origin: string | null; unit: string; stock: number; brand: { name: string } | null; gallery: Array<{ id: number }> }, profile: ProductMarketplacePayload) {
  const missing: string[] = [];
  const warnings: string[] = [];
  const require = (condition: unknown, field: string) => { if (!condition) missing.push(field); };
  require(product.name, "name");
  if (product.catalogType === "external") require(product.externalUrl, "external_url");
  else {
    if (product.catalogType !== "grouped") require(product.regularPrice >= 0, "price");
    require(product.description, "description");
    require(product.imageMediaId || product.gallery.length, "image");
  }
  if (profile.platform === "bling") {
    require(product.sku, "sku"); require(product.weight, "weight"); require(product.ncm, "ncm"); require(product.origin !== null, "origem");
    if (!product.unit) warnings.push("unit"); if (!product.gtin) warnings.push("gtin");
  } else if (["shopee", "amazon"].includes(profile.platform)) {
    require(product.sku, "sku"); require(product.gtin, "gtin"); require(product.weight, "weight"); require(product.length && product.width && product.height, "dimensions"); require(product.condition, "condition");
  } else if (profile.platform === "google") {
    require(product.gtin, "gtin"); require(product.condition, "condition");
  } else if (profile.platform === "mercado_livre") {
    require(profile.remoteCategoryId || profile.remoteCatalogProductId, "ml_category_mapping"); require(product.condition, "condition"); require(product.brand?.name, "ml_brand"); require(product.weight && product.length && product.width && product.height, "shipping_dimensions");
  } else if (profile.platform === "tiktok_shop") {
    require(product.sku, "sku"); require(product.weight, "weight"); require(product.length && product.width && product.height, "dimensions"); require(product.imageMediaId || product.gallery.length, "images");
  } else if (profile.platform === "plug4market") {
    require(product.sku, "sku"); require(product.weight, "weight"); require(product.ncm, "ncm"); require(product.gtin, "ean");
  }
  const total = Math.max(5, missing.length + 5);
  return { missing: unique(missing), warnings: unique(warnings), completeness: Math.max(0, Math.round(((total - missing.length) / total) * 100)) };
}

async function initializeProductOperations(tx: Prisma.TransactionClient, productId: number, product: { type: string; stock: number; active: boolean; minStock: number }, options: { warehouseId: number | null; actor: string }) {
  const branches = await tx.branch.findMany({ where: { status: "active" }, select: { id: true } });
  if (branches.length) await tx.branchProduct.createMany({ data: branches.map((branch) => ({ branchId: branch.id, productId, active: product.active, saleEnabled: true, purchaseEnabled: product.type === "product", minStock: product.type === "product" ? product.minStock : null, reorderPoint: product.type === "product" ? product.minStock : null, reorderQuantity: product.type === "product" ? Math.max(product.minStock, 1) : null })) });
  if (product.type !== "product" || !options.warehouseId) return;
  await tx.warehouseBalance.create({ data: { warehouseId: options.warehouseId, productId, quantity: product.stock } });
  if (product.stock) await tx.warehouseLedgerEntry.create({ data: { warehouseId: options.warehouseId, productId, type: "initial", quantity: product.stock, balanceBefore: 0, balanceAfter: product.stock, referenceType: "product", referenceId: String(productId), actor: options.actor } });
}

async function synchronizeEditedStock(tx: Prisma.TransactionClient, productId: number, previousStock: number, currentStock: number, options: { warehouseId: number | null; actor: string }) {
  if (!options.warehouseId) return;
  const balance = await tx.warehouseBalance.upsert({ where: { warehouseId_productId: { warehouseId: options.warehouseId, productId } }, update: { quantity: { increment: currentStock - previousStock } }, create: { warehouseId: options.warehouseId, productId, quantity: currentStock } });
  await tx.warehouseLedgerEntry.create({ data: { warehouseId: options.warehouseId, productId, type: "product_edit", quantity: currentStock - previousStock, balanceBefore: balance.quantity - (currentStock - previousStock), balanceAfter: balance.quantity, referenceType: "product", referenceId: String(productId), actor: options.actor } });
}

async function resolveCategory(tx: Prisma.TransactionClient, categoryId: number | null | undefined, categoryName: string) {
  if (categoryId) {
    const category = await tx.category.findUnique({ where: { id: categoryId } });
    if (category) return category;
  }
  if (!categoryName) throw new ProductCatalogError("Selecione ou informe a categoria principal.");
  const existing = await tx.category.findUnique({ where: { name: categoryName } });
  if (existing) return existing;
  const slug = await uniqueCategorySlug(tx, slugify(categoryName));
  return tx.category.create({ data: { name: categoryName, slug, type: "both" } });
}

async function resolveBrand(tx: Prisma.TransactionClient, value: string | undefined) {
  const name = text(value, 120);
  if (!name) return null;
  const existing = await tx.productBrand.findUnique({ where: { name } });
  if (existing) return existing;
  let slug = slugify(name);
  let suffix = 2;
  while (await tx.productBrand.findUnique({ where: { slug } })) slug = `${slugify(name)}-${suffix++}`;
  return tx.productBrand.create({ data: { name, slug } });
}

async function uniqueSlug(tx: Prisma.TransactionClient, value: string, excludeId?: number) {
  const base = slugify(value) || "produto";
  let slug = base;
  let suffix = 2;
  while (await tx.product.findFirst({ where: { slug, ...(excludeId ? { id: { not: excludeId } } : {}) }, select: { id: true } })) slug = `${base}-${suffix++}`;
  return slug;
}

async function uniqueCategorySlug(tx: Prisma.TransactionClient, baseValue: string) {
  const base = baseValue || "categoria";
  let slug = base;
  let suffix = 2;
  while (await tx.category.findUnique({ where: { slug } })) slug = `${base}-${suffix++}`;
  return slug;
}

async function uniqueTagSlug(tx: Prisma.TransactionClient, baseValue: string) {
  const base = baseValue || "tag";
  let slug = base;
  let suffix = 2;
  while (await tx.productTag.findUnique({ where: { slug } })) slug = `${base}-${suffix++}`;
  return slug;
}

export function slugify(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 180);
}

function validateDigits(value: unknown, label: string, lengths: number[]) {
  const normalized = digits(value);
  if (normalized && !lengths.includes(normalized.length)) throw new ProductCatalogError(`${label} deve ter ${lengths.join(", ")} dígitos.`);
}

function digits(value: unknown) { const normalized = String(value ?? "").replace(/\D/g, ""); return normalized || null; }
function text(value: unknown, max: number) { return String(value ?? "").trim().slice(0, max); }
function nullableText(value: unknown, max: number) { return text(value, max) || null; }
function enumValue(value: unknown, allowed: string[], fallback: string) { const normalized = String(value ?? fallback); return allowed.includes(normalized) ? normalized : fallback; }
function integer(value: unknown, fallback: number) { const parsed = Number(value); return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback; }
function optionalInteger(value: unknown) { if (value === "" || value === null || value === undefined) return null; return integer(value, 0); }
function nonNegative(value: unknown, label: string) { const parsed = Number(value); if (!Number.isFinite(parsed) || parsed < 0) throw new ProductCatalogError(`${label} deve ser um número maior ou igual a zero.`); return parsed; }
function optionalNonNegative(value: unknown, label: string) { if (value === "" || value === null || value === undefined) return null; return nonNegative(value, label); }
function optionalNumber(value: unknown) { if (value === "" || value === null || value === undefined) return null; const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
function dateTime(value: unknown) { const normalized = text(value, 40); if (!normalized) return null; const date = new Date(normalized); if (Number.isNaN(date.getTime())) throw new ProductCatalogError("Data e hora inválidas."); return date; }
function plainDate(value: unknown) { const normalized = text(value, 10); if (!normalized) return null; if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) throw new ProductCatalogError("Data de validade inválida."); return new Date(`${normalized}T00:00:00.000Z`); }
function nullableUrl(value: unknown, label: string) { const normalized = text(value, 2_000); if (!normalized) return null; try { const url = new URL(normalized); if (!["http:", "https:"].includes(url.protocol)) throw new Error(); return url.toString(); } catch { throw new ProductCatalogError(`${label} deve usar uma URL HTTP ou HTTPS válida.`); } }
function color(value: unknown) { const normalized = text(value, 20); return /^#[0-9a-f]{6}$/i.test(normalized) ? normalized : null; }
function unique<T>(values: T[]) { return [...new Set(values)]; }
function uniqueBy<T>(values: T[], key: (value: T) => string) { const seen = new Set<string>(); return values.filter((value) => { const id = key(value); if (seen.has(id)) return false; seen.add(id); return true; }); }
function jsonOrNull(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull { if (Array.isArray(value) && !value.length) return Prisma.JsonNull; if (value && typeof value === "object" && !Array.isArray(value) && !Object.keys(value).length) return Prisma.JsonNull; return value === undefined || value === null ? Prisma.JsonNull : value as Prisma.InputJsonValue; }

export class ProductCatalogError extends Error {}
