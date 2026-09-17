import { randomUUID } from "node:crypto";
import { ensureFiscalSupplier } from "./fiscal-supplier";
import { Prisma } from "@/generated/tenant/client";
import { tenantDb } from "@/db";
import { decryptSecret } from "@/lib/secrets";
import { NfeInputError, parseNfeXml } from "@/lib/erp/nfe-input";
import { assertFiscalEntryAllowed } from "@/lib/erp/fiscal-import-policy";
import { preparePosT2CatalogBoundary, toPosT2BoundaryIdempotencyKey } from "@/lib/erp/pos-t2-boundary";

type TenantDb = Awaited<ReturnType<typeof tenantDb>>;

const preparedInvoiceSelect = {
  id: true, accessKey: true, number: true, series: true, status: true, source: true,
  supplierDocument: true, supplierName: true, branchId: true, supplierId: true,
  issueDate: true, total: true, createdAt: true,
  items: { select: { id: true, itemNumber: true, productId: true, matchSource: true, matchConfidence: true } },
} satisfies Prisma.PurchaseInvoiceSelect;

export async function prepareInboundInvoice(db: TenantDb, documentId: number, actor: { id: string; name: string }, correlationId: string = randomUUID()) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "inbound_fiscal_documents" WHERE "id" = ${documentId} FOR UPDATE`);
    const inbound = await tx.inboundFiscalDocument.findUnique({ where: { id: documentId }, include: { branch: { select: { document: true } } } });
    if (!inbound) throw new NfeInputError("Documento fiscal detectado não encontrado.");
    try { assertFiscalEntryAllowed(inbound); } catch (error) { throw new NfeInputError((error as Error).message); }
    if (inbound.purchaseInvoiceId) {
      const existing = await tx.purchaseInvoice.findUnique({ where: { id: inbound.purchaseInvoiceId }, select: preparedInvoiceSelect });
      if (existing) return { invoice: existing, reconciled: true, correlationId };
    }
    if (inbound.status === "cancelled" || inbound.status === "ignored") throw new NfeInputError("Documento cancelado ou ignorado não pode gerar entrada.");
    if (inbound.documentType !== "nfe") throw new NfeInputError("Somente uma NF-e de mercadorias pode gerar entrada de estoque. Classifique serviços e fretes sem importar produtos.");
    if (!inbound.fullDocumentAvailable || !inbound.encryptedXml) throw new NfeInputError("O XML completo ainda não foi distribuído. Registre a ciência da operação no provedor fiscal ou importe o XML autorizado para conciliar.");
    const parsed = parseNfeXml(decryptSecret(inbound.encryptedXml));
    if (parsed.environment !== "production") throw new NfeInputError("XML não autorizado para entrada no ambiente de produção.");
    const branchDocument = inbound.branch.document.replace(/\D/g, "");
    if (!parsed.recipientDocument || parsed.recipientDocument !== branchDocument) throw new NfeInputError("O destinatário do XML não corresponde à filial detectada.");
    if (inbound.accessKey && parsed.accessKey !== inbound.accessKey) throw new NfeInputError("A chave do XML completo diverge do resumo detectado.");

    const prior = await tx.purchaseInvoice.findUnique({ where: { accessKey: parsed.accessKey }, select: preparedInvoiceSelect });
    if (prior) {
      if (prior.branchId !== inbound.branchId) throw new NfeInputError("A entrada existente não pertence à mesma filial.");
      await tx.inboundFiscalDocument.update({ where: { id: inbound.id }, data: { purchaseInvoiceId: prior.id, status: prior.status === "received" ? "received" : "reconciled", reviewedBy: actor.name, reviewedAt: new Date() } });
      await appendEvent(tx, inbound.id, "dfe.document.reconciled", actor.id, correlationId, { purchaseInvoiceId: prior.id, strategy: "access_key" });
      return { invoice: prior, reconciled: true, correlationId };
    }

    const supplier = await ensureFiscalSupplier(tx, parsed);
    const resolved = await resolveProducts(tx, supplier.id, parsed.items);
    const invoice = await tx.purchaseInvoice.create({ data: {
      accessKey: parsed.accessKey, number: parsed.number, series: parsed.series,
      status: resolved.every((item) => item.productId) ? "matched" : "imported", source: inbound.source,
      branchId: inbound.branchId, supplierId: supplier.id, supplierDocument: parsed.supplierDocument,
      supplierName: parsed.supplierName, issueDate: parsed.issueDate, total: parsed.total,
      xmlText: parsed.xml, importedBy: actor.name, items: { create: resolved },
    }, select: preparedInvoiceSelect });
    await tx.inboundFiscalDocument.update({ where: { id: inbound.id }, data: { purchaseInvoiceId: invoice.id, status: "reconciled", reviewedBy: actor.name, reviewedAt: new Date() } });
    await appendEvent(tx, inbound.id, "dfe.document.prepared", actor.id, correlationId, { purchaseInvoiceId: invoice.id, matchedItems: resolved.filter((item) => item.productId).length, totalItems: resolved.length, supplierId: supplier.id });
    await tx.tenantAuditEvent.create({ data: { actorId: actor.id, action: "purchase_invoice.prepared_from_dfe", entityType: "purchase_invoice", entityId: String(invoice.id), correlationId, afterData: { inboundDocumentId: inbound.id, branchId: inbound.branchId, supplierId: supplier.id, source: inbound.source, accessKey: parsed.accessKey, matchedItems: resolved.filter((item) => item.productId).length, totalItems: resolved.length } } });
    return { invoice, reconciled: false, correlationId };
  }, { isolationLevel: "Serializable", maxWait: 5_000, timeout: 30_000 });
}

export async function reconcileInboundInvoice(db: TenantDb, documentId: number, invoiceId: number, actor: { id: string; name: string }, correlationId: string = randomUUID()) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "inbound_fiscal_documents" WHERE "id" = ${documentId} FOR UPDATE`);
    const [document, invoice] = await Promise.all([
      tx.inboundFiscalDocument.findUnique({ where: { id: documentId } }),
      tx.purchaseInvoice.findUnique({ where: { id: invoiceId }, select: { id: true, accessKey: true, status: true, branchId: true } }),
    ]);
    if (!document || !invoice) throw new NfeInputError("Documento detectado ou entrada manual não encontrada.");
    try { assertFiscalEntryAllowed(document); } catch (error) { throw new NfeInputError((error as Error).message); }
    if (!document.accessKey || document.accessKey !== invoice.accessKey) throw new NfeInputError("A conciliação exige a mesma chave de acesso nos dois registros.");
    if (document.purchaseInvoiceId && document.purchaseInvoiceId !== invoice.id) throw new NfeInputError("Este documento já está conciliado com outra entrada.");
    if (invoice.branchId && invoice.branchId !== document.branchId) throw new NfeInputError("A entrada manual pertence a outra filial.");
    await tx.purchaseInvoice.update({ where: { id: invoice.id }, data: { branchId: document.branchId, source: document.source } });
    const updated = await tx.inboundFiscalDocument.update({ where: { id: document.id }, data: { purchaseInvoiceId: invoice.id, status: invoice.status === "received" ? "received" : "reconciled", reviewedBy: actor.name, reviewedAt: new Date() } });
    await appendEvent(tx, document.id, "dfe.document.reconciled", actor.id, correlationId, { purchaseInvoiceId: invoice.id, strategy: "manual_exact_access_key" });
    return { document: updated, correlationId };
  }, { isolationLevel: "Serializable" });
}

export async function createProductFromInvoiceItem(db: TenantDb, itemId: number, actor: { id: string; name: string }, correlationId: string = randomUUID()) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "purchase_invoice_items" WHERE "id" = ${itemId} FOR UPDATE`);
    const item = await tx.purchaseInvoiceItem.findUnique({ where: { id: itemId }, include: { invoice: { select: { id: true, status: true, supplierId: true, supplierName: true, issueDate: true } } } });
    if (!item) throw new NfeInputError("Item da NF-e não encontrado.");
    const detected = await tx.inboundFiscalDocument.findUnique({ where: { purchaseInvoiceId: item.invoice.id } });
    if (detected) { try { assertFiscalEntryAllowed(detected); } catch (error) { throw new NfeInputError((error as Error).message); } }
    if (item.invoice.status === "received") throw new NfeInputError("Não é possível criar produto depois do recebimento.");
    if (item.productId) {
      const product = await tx.product.findUniqueOrThrow({ where: { id: item.productId }, select: { id: true, name: true, sku: true, onboardingStatus: true, onboardingMissingFields: true } });
      const missing = await tx.purchaseInvoiceItem.count({ where: { purchaseInvoiceId: item.invoice.id, productId: null } });
      return { product, invoiceMatched: missing === 0, correlationId };
    }
    const matches = await tx.product.findMany({ where: { active: true, type: "product", OR: [
      ...(item.barcode ? [{ barcode: item.barcode }, { gtin: item.barcode }] : []),
      ...(item.invoice.supplierId && item.supplierCode ? [{ supplierLinks: { some: { supplierId: item.invoice.supplierId, supplierCode: item.supplierCode } } }] : []),
    ] }, select: { id: true, name: true, sku: true, onboardingStatus: true, onboardingMissingFields: true }, take: 2 });
    if (matches.length) throw new NfeInputError("Já existe produto com este GTIN ou código do fornecedor. Confira e vincule o produto existente antes de criar outro.");
    const sku = await uniqueValue(tx, "sku", baseSku(item.supplierCode || item.barcode || `NFE-${item.invoice.id}-${item.itemNumber}`));
    const slug = await uniqueValue(tx, "slug", slugify(`${item.description}-${sku}`));
    const missingFields = ["image", "sale_price", "category_review", ...(!item.barcode ? ["gtin"] : []), ...(!item.ncm ? ["ncm"] : [])];
    const productName = item.description.slice(0, 200);
    const boundary = await preparePosT2CatalogBoundary(tx, {
      action: "put_graph", productId: null, expectedProductRevision: null, expectedProductConfigHash: null,
      productProjection: { active: true, gtinSnapshot: item.barcode, manageStock: true, nameLabel: productName, productType: "product", skuSnapshot: sku, status: "draft", unit: item.unit },
      variations: [], actorUserId: actor.id,
      idempotencyKey: toPosT2BoundaryIdempotencyKey(`inbound-fiscal-product-v1:${item.id}`),
    });
    const product = boundary.replayed
      ? await tx.product.findUniqueOrThrow({ where: { id: boundary.productId }, select: { id: true, name: true, sku: true, onboardingStatus: true, onboardingMissingFields: true } })
      : await tx.product.create({ data: {
        id: boundary.productId, posRevision: boundary.productRevision, posConfigHash: boundary.productConfigHash,
        name: productName, slug, sku, barcode: item.barcode, gtin: item.barcode,
        type: "product", catalogType: "simple", status: "draft", catalogVisibility: "hidden",
        active: true, price: 0, regularPrice: 0, cost: item.unitCost, category: "Importado da NF-e · revisar",
        supplier: item.invoice.supplierName, stock: 0, unit: item.unit, ncm: item.ncm,
        onboardingStatus: "pending", onboardingSource: "purchase_invoice", onboardingMissingFields: missingFields,
      }, select: { id: true, name: true, sku: true, onboardingStatus: true, onboardingMissingFields: true } });
    if (item.invoice.supplierId) await tx.supplierProduct.upsert({ where: { supplierId_productId: { supplierId: item.invoice.supplierId, productId: product.id } }, update: { supplierCode: item.supplierCode, lastCost: item.unitCost }, create: { supplierId: item.invoice.supplierId, productId: product.id, supplierCode: item.supplierCode, lastCost: item.unitCost, preferred: true } });
    await tx.purchaseInvoiceItem.update({ where: { id: item.id }, data: { productId: product.id, matchSource: "created_from_invoice", matchConfidence: 100, matchReason: "Produto criado a partir deste item fiscal" } });
    const missing = await tx.purchaseInvoiceItem.count({ where: { purchaseInvoiceId: item.invoice.id, productId: null } });
    if (!missing) await tx.purchaseInvoice.update({ where: { id: item.invoice.id }, data: { status: "matched" } });
    await tx.tenantAuditEvent.create({ data: { actorId: actor.id, action: "product.created_from_purchase_invoice", entityType: "product", entityId: String(product.id), correlationId, afterData: { purchaseInvoiceId: item.invoice.id, purchaseInvoiceItemId: item.id, sku, missingFields } } });
    return { product, invoiceMatched: missing === 0, correlationId };
  }, { isolationLevel: "Serializable" });
}

async function resolveProducts(tx: Prisma.TransactionClient, supplierId: number, items: ReturnType<typeof parseNfeXml>["items"]) {
  const products = await tx.product.findMany({ where: { active: true, type: "product" }, select: { id: true, sku: true, barcode: true, gtin: true } });
  const supplierLinks = await tx.supplierProduct.findMany({ where: { supplierId, supplierCode: { in: items.map((item) => item.supplierCode).filter((value): value is string => Boolean(value)) } }, select: { supplierCode: true, productId: true, product: { select: { active: true, type: true } } } });
  const history = uniqueIndex(supplierLinks.filter((link) => link.product.active && link.product.type === "product").map((link) => ({ key: link.supplierCode || "", id: link.productId })));
  const gtin = uniqueIndex(products.flatMap((product) => [product.barcode, product.gtin].filter((value): value is string => Boolean(value)).map((key) => ({ key, id: product.id }))));
  const sku = uniqueIndex(products.map((product) => ({ key: product.sku, id: product.id })));
  return items.map((item) => {
    const historical = item.supplierCode ? history.get(item.supplierCode) : undefined;
    const byGtin = item.barcode ? gtin.get(item.barcode) : undefined;
    const bySku = item.supplierCode ? sku.get(item.supplierCode) : undefined;
    const productId = historical || byGtin || bySku || null;
    const matchSource = historical ? "supplier_history" : byGtin ? "gtin" : bySku ? "supplier_code" : null;
    const matchConfidence = historical ? 99 : byGtin ? 97 : bySku ? 82 : null;
    const matchReason = historical ? "Histórico exato deste fornecedor" : byGtin ? "GTIN único no catálogo" : bySku ? "Código do fornecedor igual a um SKU único" : null;
    return { ...item, productId, matchSource, matchConfidence, matchReason };
  });
}

function uniqueIndex(values: Array<{ key: string; id: number }>) {
  const candidates = new Map<string, Set<number>>();
  for (const value of values) if (value.key) candidates.set(value.key, (candidates.get(value.key) || new Set()).add(value.id));
  return new Map([...candidates].filter(([, ids]) => ids.size === 1).map(([key, ids]) => [key, [...ids][0]!]));
}

async function uniqueValue(tx: Prisma.TransactionClient, field: "sku" | "slug", base: string) {
  const normalized = base.slice(0, 150) || `NFE-${randomUUID().slice(0, 8)}`;
  for (let suffix = 0; suffix < 100; suffix++) {
    const candidate = suffix ? `${normalized.slice(0, 142)}-${suffix}` : normalized;
    if (!await tx.product.findFirst({ where: { [field]: candidate }, select: { id: true } })) return candidate;
  }
  return `${normalized.slice(0, 135)}-${randomUUID().slice(0, 8)}`;
}

function baseSku(value: string) { return value.toUpperCase().replace(/[^A-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120); }
function slugify(value: string) { return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 150); }
function appendEvent(tx: Prisma.TransactionClient, documentId: number, type: string, actorId: string, correlationId: string, metadata: Prisma.InputJsonValue) { return tx.inboundFiscalDocumentEvent.create({ data: { documentId, type, actorId, correlationId, metadata } }); }
