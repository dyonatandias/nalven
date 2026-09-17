import { readJsonObject, HttpSecurityError } from "@/lib/http-security";
import { ensureFiscalSupplier } from "@/lib/erp/fiscal-supplier";
import { createHash, randomUUID } from "node:crypto";
import { currentOrganization, tenantDb } from "@/db";
import { Prisma } from "@/generated/tenant/client";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import { assertSameOrigin, CustomerInputError } from "@/lib/erp/customer-input";
import { createProductFromInvoiceItem } from "@/lib/erp/inbound-fiscal";
import { invoiceId, matchItems, NfeInputError, parseNfeXml, receiveInvoiceInput } from "@/lib/erp/nfe-input";
import { receivePurchaseInvoiceRecord } from "@/lib/erp/purchase-invoice-receiving";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { encryptSecret } from "@/lib/secrets";
import { assertTenantWriteAccess } from "@/lib/tenant-access";

const noStoreHeaders = { "cache-control": "no-store, max-age=0", expires: "0", pragma: "no-cache" };
const invoiceSelect = {
  id: true, accessKey: true, number: true, series: true, status: true, source: true, branchId: true, supplierId: true,
  supplierDocument: true, supplierName: true, issueDate: true, total: true,
  warehouseId: true, dueAt: true, importedBy: true, receivedAt: true,
  createdAt: true, updatedAt: true,
  warehouse: { select: { id: true, code: true, name: true } },
  branch: { select: { id: true, code: true, name: true } },
  supplier: { select: { id: true, status: true } },
  items: {
    select: {
      id: true, itemNumber: true, supplierCode: true, description: true,
      barcode: true, ncm: true, cfop: true, unit: true, quantity: true,
      unitCost: true, total: true, productId: true, matchSource: true, matchConfidence: true, matchReason: true,
      product: { select: { id: true, name: true, sku: true, unit: true, stock: true, onboardingStatus: true, onboardingMissingFields: true } },
    },
    orderBy: { itemNumber: "asc" as const },
  },
} satisfies Prisma.PurchaseInvoiceSelect;

type TenantDb = Awaited<ReturnType<typeof tenantDb>>;

export async function GET(request: Request) {
  try {
    const organization = await currentOrganization();
    await assertTenantPermission(organization.id, "invoices.read");
    const db = await tenantDb(organization.id), url = new URL(request.url);
    if (url.searchParams.has("productSearch")) return productSearch(db, url.searchParams.get("productSearch") || "");

    const query = boundedQuery(url.searchParams.get("search"), 100), status = statusFilter(url.searchParams.get("status"));
    const selectedInvoiceId = url.searchParams.get("invoiceId") ? invoiceId(url.searchParams.get("invoiceId")) : null;
    const page = boundedInteger(url.searchParams.get("page"), 1, 10_000, 1), limit = boundedInteger(url.searchParams.get("limit"), 10, 50, 20);
    const where: Prisma.PurchaseInvoiceWhereInput = {
      ...(selectedInvoiceId ? { id: selectedInvoiceId } : {}),
      ...(status ? { status } : {}),
      ...(query ? { OR: [
        { supplierName: { contains: query, mode: "insensitive" } },
        { supplierDocument: { contains: query } },
        { number: { contains: query } },
        { accessKey: { contains: query } },
      ] } : {}),
    };
    const [items, filteredTotal, grouped, value, products, warehouses] = await Promise.all([
      db.purchaseInvoice.findMany({ where, select: invoiceSelect, orderBy: [{ issueDate: "desc" }, { id: "desc" }], skip: (page - 1) * limit, take: limit }),
      db.purchaseInvoice.count({ where }),
      db.purchaseInvoice.groupBy({ by: ["status"], _count: { _all: true } }),
      db.purchaseInvoice.aggregate({ _sum: { total: true } }),
      db.product.findMany({ where: { active: true, type: "product" }, select: { id: true, name: true, sku: true, barcode: true, unit: true, stock: true, cost: true, onboardingStatus: true, onboardingMissingFields: true }, orderBy: { name: "asc" }, take: 60 }),
      db.warehouse.findMany({ where: { active: true }, select: { id: true, code: true, name: true, branch: { select: { name: true } } }, orderBy: [{ primary: "desc" }, { name: "asc" }] }),
    ]);
    const counts = new Map(grouped.map((row) => [row.status, row._count._all]));
    const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
    return json({
      items, products, warehouses,
      summary: { total, pending: counts.get("imported") || 0, ready: counts.get("matched") || 0, received: counts.get("received") || 0, totalValue: value._sum.total || 0 },
      pagination: { page, limit, total: filteredTotal, pages: Math.max(1, Math.ceil(filteredTotal / limit)) },
      filters: { search: query, status, invoiceId: selectedInvoiceId },
    });
  } catch (error) { return fail(error); }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const organization = await currentOrganization(), access = await assertTenantPermission(organization.id, "invoices.write");
    await assertTenantWriteAccess(organization.id);
    const db = await tenantDb(organization.id), body = await readPayload(request), correlationId = randomUUID();
    if (body.action === "import") return importInvoice(db, body, access.user, correlationId);
    if (body.action === "create_product") {
      await assertTenantPermission(organization.id, "products.write");
      return json(await createProductFromInvoiceItem(db, invoiceId(body.itemId), access.user, correlationId), { status: 201 });
    }
    const id = invoiceId(body.invoiceId);
    if (body.action === "match") return matchInvoice(db, id, body, access.user, correlationId);
    if (body.action === "receive") return receiveInvoice(db, id, body, access.user, correlationId);
    throw new NfeInputError("Ação de NF-e inválida.");
  } catch (error) { return fail(error); }
}

async function productSearch(db: TenantDb, value: string) {
  const query = boundedQuery(value, 100);
  const products = await db.product.findMany({
    where: { active: true, type: "product", ...(query ? { OR: [
      { name: { contains: query, mode: "insensitive" } }, { sku: { contains: query, mode: "insensitive" } }, { barcode: { contains: query } },
    ] } : {}) },
    select: { id: true, name: true, sku: true, barcode: true, unit: true, stock: true, cost: true, onboardingStatus: true, onboardingMissingFields: true },
    orderBy: { name: "asc" }, take: 40,
  });
  return json({ products });
}

async function importInvoice(db: TenantDb, body: Record<string, unknown>, user: { id: string; name: string }, correlationId: string) {
  const nfe = parseNfeXml(body.xml);
  if (nfe.environment !== "production") throw new NfeInputError("Importação comercial exige XML de produção com tpAmb=1.");
  const [products, branch] = await Promise.all([
    db.product.findMany({ where: { active: true, type: "product" }, select: { id: true, sku: true, barcode: true } }),
    nfe.recipientDocument ? db.branch.findUnique({ where: { document: nfe.recipientDocument }, select: { id: true } }) : null,
  ]);
  if (nfe.recipientDocument && !branch) throw new NfeInputError("O CNPJ destinatário da NF-e não corresponde a uma filial cadastrada.");
  const bySku = uniqueProductIndex(products, "sku"), byBarcode = uniqueProductIndex(products, "barcode");
  const resolvedItems = nfe.items.map((item) => {
    const barcodeMatch = byBarcode.get(item.barcode || ""), skuMatch = bySku.get(item.supplierCode || ""), productId = barcodeMatch || skuMatch || null;
    return { ...item, productId, matchSource: barcodeMatch ? "gtin" : skuMatch ? "supplier_code" : null, matchConfidence: barcodeMatch ? 97 : skuMatch ? 82 : null, matchReason: barcodeMatch ? "GTIN único no catálogo" : skuMatch ? "Código do fornecedor igual a um SKU único" : null };
  });
  const invoice = await db.$transaction(async (tx) => {
    const supplier = await ensureFiscalSupplier(tx, nfe);
    const inbound = await tx.inboundFiscalDocument.findFirst({ where: { accessKey: nfe.accessKey, environment: "production", purchaseInvoiceId: null } });
    if (inbound && branch && inbound.branchId !== branch.id) throw new NfeInputError("A nota detectada pertence a outra filial.");
    const created = await tx.purchaseInvoice.create({
      data: {
        accessKey: nfe.accessKey, number: nfe.number, series: nfe.series,
        status: resolvedItems.every((item) => item.productId) ? "matched" : "imported",
        source: "manual_xml", branchId: branch?.id || inbound?.branchId || null, supplierId: supplier.id,
        supplierDocument: nfe.supplierDocument, supplierName: nfe.supplierName,
        issueDate: nfe.issueDate, total: nfe.total, xmlText: nfe.xml, importedBy: user.name,
        items: { create: resolvedItems },
      },
      select: invoiceSelect,
    });
    if (inbound) {
      await tx.inboundFiscalDocument.update({ where: { id: inbound.id }, data: { purchaseInvoiceId: created.id, status: "reconciled", fullDocumentAvailable: true, encryptedXml: encryptSecret(nfe.xml), payloadHash: createHash("sha256").update(nfe.xml).digest("hex"), reviewedBy: user.name, reviewedAt: new Date() } });
      await tx.inboundFiscalDocumentEvent.create({ data: { documentId: inbound.id, type: "dfe.document.reconciled", actorId: user.id, correlationId, metadata: { purchaseInvoiceId: created.id, strategy: "manual_xml_exact_access_key" } } });
    }
    await tx.tenantAuditEvent.create({ data: {
      actorId: user.id, action: "purchase_invoice.imported", entityType: "purchase_invoice",
      entityId: String(created.id), correlationId,
      afterData: { accessKey: nfe.accessKey, number: nfe.number, supplierDocument: nfe.supplierDocument, total: nfe.total, itemCount: nfe.items.length, automaticallyMatched: resolvedItems.filter((item) => item.productId).length },
    } });
    return created;
  });
  return json({ invoice, correlationId }, { status: 201 });
}

async function matchInvoice(db: TenantDb, id: number, body: Record<string, unknown>, user: { id: string; name: string }, correlationId: string) {
  const links = matchItems(body.items);
  const updated = await db.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "purchase_invoices" WHERE "id" = ${id} FOR UPDATE`);
    const invoice = await tx.purchaseInvoice.findUnique({ where: { id }, select: invoiceSelect });
    if (!invoice) throw new NfeInputError("NF-e não encontrada.");
    if (invoice.status === "received") throw new NfeInputError("Esta NF-e já foi recebida.");
    const itemIds = new Set(invoice.items.map((item) => item.id));
    if (links.length !== itemIds.size || links.some((link) => !itemIds.has(link.itemId))) throw new NfeInputError("Todos os itens devem ser vinculados exatamente uma vez.");
    const productIds = [...new Set(links.map((link) => link.productId))];
    const productCount = await tx.product.count({ where: { id: { in: productIds }, active: true, type: "product" } });
    if (productCount !== productIds.length) throw new NfeInputError("Um dos produtos vinculados é inválido ou está inativo.");
    for (const link of links) {
      const sourceItem = invoice.items.find((item) => item.id === link.itemId)!;
      await tx.purchaseInvoiceItem.update({ where: { id: link.itemId }, data: { productId: link.productId, matchSource: "manual", matchConfidence: 100, matchReason: "Vínculo confirmado na conferência" } });
      if (invoice.supplierId) await tx.supplierProduct.upsert({ where: { supplierId_productId: { supplierId: invoice.supplierId, productId: link.productId } }, update: { supplierCode: sourceItem.supplierCode, lastCost: sourceItem.unitCost }, create: { supplierId: invoice.supplierId, productId: link.productId, supplierCode: sourceItem.supplierCode, lastCost: sourceItem.unitCost } });
    }
    const result = await tx.purchaseInvoice.update({ where: { id }, data: { status: "matched" }, select: invoiceSelect });
    await tx.tenantAuditEvent.create({ data: { actorId: user.id, action: "purchase_invoice.matched", entityType: "purchase_invoice", entityId: String(id), correlationId, beforeData: { status: invoice.status }, afterData: { status: "matched", itemCount: links.length } } });
    return result;
  }, { isolationLevel: "Serializable" });
  return json({ invoice: updated, correlationId });
}

async function receiveInvoice(db: TenantDb, id: number, body: Record<string, unknown>, user: { id: string; name: string }, correlationId: string) {
  const input = receiveInvoiceInput(body);
  await receivePurchaseInvoiceRecord(db, id, input, user, correlationId);
  const invoice = await db.purchaseInvoice.findUnique({ where: { id }, select: invoiceSelect });
  if (!invoice) throw new NfeInputError("NF-e não encontrada após o recebimento.");
  return json({ invoice, correlationId });
}

function uniqueProductIndex<T extends { id: number; sku: string; barcode: string | null }>(products: T[], field: "sku" | "barcode") {
  const candidates = new Map<string, number[]>();
  for (const product of products) {
    const value = product[field]?.trim();
    if (value) candidates.set(value, [...(candidates.get(value) || []), product.id]);
  }
  return new Map([...candidates].filter(([, ids]) => ids.length === 1).map(([value, ids]) => [value, ids[0]!]));
}

async function readPayload(request: Request) {
  return readJsonObject(request, 5_300_000);
}

function boundedQuery(value: string | null, maximum: number) { const query = (value || "").trim(); if (query.length > maximum) throw new NfeInputError("Busca excede o tamanho permitido."); return query; }
function statusFilter(value: string | null) { const status = (value || "").trim(); if (!status) return ""; if (!new Set(["imported", "matched", "received"]).has(status)) throw new NfeInputError("Status de NF-e inválido."); return status; }
function boundedInteger(value: string | null, minimum: number, maximum: number, fallback: number) { if (!value) return fallback; const number = Number(value); if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new NfeInputError("Paginação inválida."); return number; }
function json(data: unknown, init: ResponseInit = {}) { return Response.json(data, { ...init, headers: { ...noStoreHeaders, ...init.headers } }); }

function fail(error: unknown) {
  if (error instanceof NfeInputError || error instanceof CustomerInputError) return json({ error: error.message }, { status: error.message.includes("Origem") ? 403 : error.message.includes("já") || error.message.includes("mudou") ? 409 : 400 });
  if (error instanceof LicenseDeniedError) return json({ error: error.message }, { status: error.status });
  if (error && typeof error === "object" && "code" in error) {
    if (error.code === "P2002") return json({ error: "Esta NF-e já foi importada ou processada." }, { status: 409 });
    if (error.code === "P2034") return json({ error: "A NF-e foi alterada por outra operação. Atualize a tela e tente novamente." }, { status: 409 });
  }
  if (error instanceof AuthError || error instanceof HttpSecurityError) return authErrorResponse(error);
  console.error("Falha interna na entrada de NF-e", { error: error instanceof Error ? error.name : typeof error });
  return json({ error: "Não foi possível processar a NF-e. Tente novamente; se persistir, acione o suporte." }, { status: 500 });
}
