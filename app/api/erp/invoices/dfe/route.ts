import { readJsonObject, HttpSecurityError } from "@/lib/http-security";
import { randomUUID } from "node:crypto";
import { currentOrganization, tenantDb } from "@/db";
import { Prisma } from "@/generated/tenant/client";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import { assertSameOrigin, CustomerInputError } from "@/lib/erp/customer-input";
import { DfeDistributionError, syncBranchFiscalSource, refreshNfseEvents } from "@/lib/erp/dfe-distribution";
import { createProductFromInvoiceItem, prepareInboundInvoice, reconcileInboundInvoice } from "@/lib/erp/inbound-fiscal";
import { invoiceId, NfeInputError } from "@/lib/erp/nfe-input";
import { assertTenantPermission } from "@/lib/erp/permissions";
import { assertTenantWriteAccess } from "@/lib/tenant-access";
import { assertFiscalReclassificationAllowed } from "@/lib/erp/fiscal-import-policy";
import { decryptSecret } from "@/lib/secrets";
import { listPendingNfeRecoveries, registerNfeScience } from "@/lib/erp/nfe-manifestation-service";
import { NfeManifestationError } from "@/lib/erp/nfe-manifestation";

const noStore = { "cache-control": "no-store, max-age=0", expires: "0", pragma: "no-cache" };
const classifications = new Set(["unknown", "goods", "service", "freight", "expense", "asset", "other"]);
const statuses = new Set(["detected", "awaiting_document", "ready", "in_review", "reconciled", "received", "ignored", "cancelled", "error"]);
const types = new Set(["nfe", "cte", "nfse", "event", "unknown"]);

export async function GET(request: Request) {
  try {
    const organization = await currentOrganization();
    const access = await assertTenantPermission(organization.id, "invoices.read");
    const db = await tenantDb(organization.id), url = new URL(request.url);
    if (url.searchParams.get("action") === "download_xml") {
      const id = invoiceId(url.searchParams.get("documentId"));
      const document = await db.inboundFiscalDocument.findUnique({ where: { id } });
      if (!document) throw new NfeInputError("Documento fiscal não encontrado.");
      await assertDfeBranchAccess(db, access, document.branchId);
      if (!document.fullDocumentAvailable || !document.encryptedXml) throw new NfeInputError("XML completo ainda não disponível.");
      await db.tenantAuditEvent.create({ data: { actorId: access.user.id, action: "dfe.xml.downloaded", entityType: "inbound_fiscal_document", entityId: String(id), correlationId: randomUUID() } });
      return new Response(decryptSecret(document.encryptedXml), { headers: { ...noStore, "content-type": "application/xml; charset=utf-8", "content-disposition": `attachment; filename="documento-fiscal-${id}.xml"`, "x-content-type-options": "nosniff", "content-security-policy": "sandbox; default-src 'none'" } });
    }
    const search = boundedText(url.searchParams.get("search"), 100), status = optionalChoice(url.searchParams.get("status"), statuses, "Status"), type = optionalChoice(url.searchParams.get("type"), types, "Tipo"), classification = optionalChoice(url.searchParams.get("classification"), classifications, "Classificação");
    const branchId = optionalId(url.searchParams.get("branchId")), page = integer(url.searchParams.get("page"), 1, 10_000, 1), limit = integer(url.searchParams.get("limit"), 10, 50, 20);
    const privileged = ["owner", "admin"].includes(access.membership.role);
    const grants = privileged ? null : await db.branchUserAccess.findMany({ where: { canIssueFiscal: true, branch: { status: "active" }, userProfile: { userId: access.user.id, status: "active", OR: [{ accessExpiresAt: null }, { accessExpiresAt: { gt: new Date() } }] } }, select: { branchId: true } });
    const scope = grants ? { branchId: { in: grants.map(grant => grant.branchId) } } : {};
    if (branchId) await assertDfeBranchAccess(db, access, branchId);
    const environment = choice(url.searchParams.get("environment") || "production", new Set(["production", "homologation", "legacy"]), "Ambiente");
    const documentScope = { ...scope, environment, ...(branchId ? { branchId } : {}) };
    const where: Prisma.InboundFiscalDocumentWhereInput = {
      AND: [scope, { environment }],
      ...(status ? { status } : {}), ...(type ? { documentType: type } : {}), ...(classification ? { classification } : {}), ...(branchId ? { branchId } : {}),
      ...(search ? { OR: [{ issuerName: { contains: search, mode: "insensitive" } }, { issuerDocument: { contains: search } }, { number: { contains: search } }, { accessKey: { contains: search } }] } : {}),
    };
    const documentSelect = {
      id: true, source: true, environment: true, documentType: true, schemaName: true, nsu: true, accessKey: true,
      branchId: true, recipientDocument: true, issuerDocument: true, issuerName: true, number: true, series: true,
      issueDate: true, authorizationDate: true, total: true, status: true, classification: true,
      manifestationStatus: true, manifestationDeadline: true, fullDocumentAvailable: true,
      purchaseInvoiceId: true, ignoredReason: true, reviewedBy: true, reviewedAt: true, detectedAt: true, updatedAt: true,
      branch: { select: { id: true, code: true, name: true, document: true } },
      purchaseInvoice: { select: { id: true, status: true, source: true, warehouseId: true, receivedAt: true } },
      events: { select: { id: true, type: true, actorId: true, createdAt: true }, orderBy: { createdAt: "desc" as const }, take: 5 },
    } satisfies Prisma.InboundFiscalDocumentSelect;
    const [documents, filtered, grouped, branches, warehouses, cursors, certificates, pendingProducts, totalValue] = await Promise.all([
      db.inboundFiscalDocument.findMany({ where, select: documentSelect, orderBy: [{ issueDate: "desc" }, { detectedAt: "desc" }], skip: (page - 1) * limit, take: limit }),
      db.inboundFiscalDocument.count({ where }),
      db.inboundFiscalDocument.groupBy({ where: documentScope, by: ["status"], _count: { _all: true } }),
      db.branch.findMany({ where: { status: "active", ...(grants ? { id: { in: grants.map(grant => grant.branchId) } } : {}) }, select: { id: true, code: true, name: true, legalName: true, document: true, state: true, defaultWarehouseId: true }, orderBy: [{ primary: "desc" }, { name: "asc" }] }),
      db.warehouse.findMany({ where: { active: true, ...scope }, select: { id: true, code: true, name: true, branchId: true }, orderBy: [{ primary: "desc" }, { name: "asc" }] }),
      db.dfeSyncCursor.findMany({ where: scope, orderBy: [{ branchId: "asc" }, { source: "asc" }] }),
      db.fiscalCertificate.findMany({ where: { active: true, ...scope }, select: { id: true, branchId: true, name: true, fingerprint: true, expiresAt: true }, orderBy: { expiresAt: "desc" } }),
      db.product.count({ where: { onboardingStatus: { not: "complete" } } }),
      db.inboundFiscalDocument.aggregate({ where: { ...documentScope, documentType: { not: "event" }, status: { notIn: ["ignored", "cancelled"] } }, _sum: { total: true } }),
    ]);
    const accessKeys = documents.flatMap((item) => item.purchaseInvoiceId || !item.accessKey ? [] : [item.accessKey]);
    const candidates = environment === "production" && accessKeys.length ? await db.purchaseInvoice.findMany({ where: { ...scope, ...(branchId ? { branchId } : {}), accessKey: { in: accessKeys } }, select: { id: true, accessKey: true, status: true } }) : [];
    const candidateByKey = new Map(candidates.map((item) => [item.accessKey, item]));
    const counts = new Map(grouped.map((row) => [row.status, row._count._all]));
    const total = [...counts.values()].reduce((sum, count) => sum + count, 0), deadline = new Date(Date.now() + 7 * 86400000);
    const expiringManifestations = await db.inboundFiscalDocument.count({ where: { ...documentScope, documentType: "nfe", manifestationStatus: { in: ["pending", "science"] }, manifestationDeadline: { lte: deadline, gte: new Date() }, status: { notIn: ["ignored", "cancelled", "received"] } } });
    const recoveries = environment === "legacy" ? [] : await listPendingNfeRecoveries(db, branchId ? [branchId] : branches.map(item => item.id), environment as "production" | "homologation");
    const responseTime = Date.now();
    return json({
      generatedAt: new Date(responseTime),
      documents: documents.map((item) => ({ ...item, events: item.events.map((event) => ({ ...event, id: String(event.id) })), candidateInvoice: item.accessKey ? candidateByKey.get(item.accessKey) || null : null, manifestationDays: item.manifestationDeadline ? Math.ceil((item.manifestationDeadline.getTime() - responseTime) / 86400000) : null })),
      branches, warehouses, recoveries, cursors: cursors.map((cursor) => ({ ...cursor, lastError: cursor.lastError ? safeError(cursor.lastError) : null })), certificates: certificates.map((certificate) => ({ ...certificate, expired: certificate.expiresAt.getTime() < responseTime })),
      summary: { total, needsReview: (counts.get("detected") || 0) + (counts.get("awaiting_document") || 0) + (counts.get("ready") || 0) + (counts.get("in_review") || 0), ready: counts.get("ready") || 0, reconciled: counts.get("reconciled") || 0, received: counts.get("received") || 0, ignored: counts.get("ignored") || 0, cancelled: counts.get("cancelled") || 0, pendingProducts, expiringManifestations, totalValue: totalValue._sum.total || 0 },
      permissions: { canAuthorizeAutomaticScience: privileged },
      pagination: { page, limit, total: filtered, pages: Math.max(1, Math.ceil(filtered / limit)) },
    });
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const organization = await currentOrganization(), access = await assertTenantPermission(organization.id, "invoices.write");
    await assertTenantWriteAccess(organization.id);
    const db = await tenantDb(organization.id), body = await payload(request), action = String(body.action || ""), correlationId = randomUUID();
    if (["sync", "configure", "register_science"].includes(action)) await assertDfeBranchAccess(db, access, invoiceId(body.branchId));
    if (["classify", "restore", "prepare", "reconcile", "refresh_events"].includes(action)) {
      const document = await db.inboundFiscalDocument.findUnique({ where: { id: invoiceId(body.documentId) }, select: { branchId: true } });
      if (!document) throw new NfeInputError("Documento fiscal não encontrado.");
      await assertDfeBranchAccess(db, access, document.branchId);
    }
    if (action === "refresh_events") return json(await refreshNfseEvents(db, invoiceId(body.documentId), access.user.id));
    if (action === "create_product") {
      const item = await db.purchaseInvoiceItem.findUnique({ where: { id: invoiceId(body.itemId) }, select: { invoice: { select: { branchId: true } } } });
      if (!item?.invoice.branchId) throw new NfeInputError("Item sem filial fiscal válida.");
      await assertDfeBranchAccess(db, access, item.invoice.branchId);
    }
    if (action === "sync") {
      const branchId = invoiceId(body.branchId), source = choice(body.source ?? "sefaz_nfe", new Set(["sefaz_nfe", "nfse_adn", "sefaz_cte"]), "Fonte") as "sefaz_nfe" | "nfse_adn" | "sefaz_cte", environment = choice(body.environment, new Set(["production", "homologation"]), "Ambiente") as "production" | "homologation";
      return json({ result: await syncBranchFiscalSource(db, branchId, source, access.user.id, environment), correlationId });
    }
    if (action === "register_science") {
      const environment = choice(body.environment, new Set(["production", "homologation"]), "Ambiente") as "production" | "homologation";
      return json(await registerNfeScience(db, { branchId: invoiceId(body.branchId), accessKey: String(body.accessKey || ""), environment, acknowledged: body.acknowledged === true, actor: access.user }));
    }
    if (action === "configure") return configure(db, body, access.user, correlationId, ["owner", "admin"].includes(access.membership.role));
    if (action === "classify") return classify(db, body, access.user, correlationId);
    if (action === "restore") return restore(db, body, access.user, correlationId);
    if (action === "prepare") return json(await prepareInboundInvoice(db, invoiceId(body.documentId), access.user, correlationId));
    if (action === "reconcile") return json(await reconcileInboundInvoice(db, invoiceId(body.documentId), invoiceId(body.invoiceId), access.user, correlationId));
    if (action === "create_product") {
      await assertTenantPermission(organization.id, "products.write");
      return json(await createProductFromInvoiceItem(db, invoiceId(body.itemId), access.user, correlationId), { status: 201 });
    }
    throw new NfeInputError("Ação de documento fiscal inválida.");
  } catch (error) { return failure(error); }
}

async function configure(db: Awaited<ReturnType<typeof tenantDb>>, body: Record<string, unknown>, user: { id: string; name: string }, correlationId: string, canAuthorizeAutomaticScience: boolean) {
  const branchId = invoiceId(body.branchId), source = choice(body.source ?? "sefaz_nfe", new Set(["sefaz_nfe", "nfse_adn", "sefaz_cte"]), "Fonte"), environment = choice(body.environment, new Set(["production", "homologation"]), "Ambiente"), processingMode = choice(body.processingMode, new Set(["review", "auto_prepare", "auto_receive"]), "Modo de processamento"), defaultDueDays = number(body.defaultDueDays, 0, 365, "Prazo financeiro"), defaultWarehouseId = body.defaultWarehouseId ? invoiceId(body.defaultWarehouseId) : null;
  const [branch, warehouse, existing] = await Promise.all([
    db.branch.findFirst({ where: { id: branchId, status: "active" } }),
    defaultWarehouseId ? db.warehouse.findFirst({ where: { id: defaultWarehouseId, active: true } }) : null,
    db.dfeSyncCursor.findUnique({ where: { branchId_source_environment: { branchId, source, environment } } }),
  ]);
  const autoScienceEnabled = body.autoScienceEnabled === undefined ? existing?.autoScienceEnabled === true : body.autoScienceEnabled === true;
  if (!branch) throw new NfeInputError("Filial ativa não encontrada.");
  if (source === "nfse_adn" && processingMode !== "review") throw new NfeInputError("A captura NFS-e exige conferência manual e não pode movimentar estoque automaticamente.");
  if ((source === "sefaz_cte" || environment === "homologation") && processingMode !== "review") throw new NfeInputError("CT-e e homologação exigem conferência sem recebimento automático.");
  if (defaultWarehouseId && (!warehouse || warehouse.branchId && warehouse.branchId !== branchId)) throw new NfeInputError("O depósito padrão não pertence à filial selecionada.");
  if (processingMode === "auto_receive" && !defaultWarehouseId) throw new NfeInputError("A entrada automática exige um depósito padrão.");
  if (autoScienceEnabled && (source !== "sefaz_nfe" || environment !== "production")) throw new NfeInputError("A Ciência automática existe somente para NF-e de produção.");
  if (autoScienceEnabled !== (existing?.autoScienceEnabled === true) && !canAuthorizeAutomaticScience) throw new AuthError(403);
  const enablingAutomaticScience = autoScienceEnabled && existing?.autoScienceEnabled !== true;
  if (enablingAutomaticScience && body.autoScienceAcknowledged !== true) throw new NfeInputError("Confirme a autorização fiscal permanente antes de ativar a Ciência automática.");
  const autoScienceAuthorization = enablingAutomaticScience ? { autoScienceAuthorizedAt: new Date(), autoScienceAuthorizedBy: user.id } : {};
  const cursor = await db.dfeSyncCursor.upsert({
    where: { branchId_source_environment: { branchId, source, environment } },
    update: { enabled: body.enabled !== false, processingMode, defaultWarehouseId, defaultDueDays, autoScienceEnabled, ...autoScienceAuthorization },
    create: { branchId, source, environment, enabled: body.enabled !== false, processingMode, defaultWarehouseId, defaultDueDays, autoScienceEnabled, ...(autoScienceEnabled ? { autoScienceAuthorizedAt: new Date(), autoScienceAuthorizedBy: user.id } : {}), nextSyncAt: new Date() },
  });
  await db.tenantAuditEvent.create({ data: { actorId: user.id, action: "dfe.source.configured", entityType: "dfe_sync_cursor", entityId: String(cursor.id), correlationId, beforeData: existing ? { enabled: existing.enabled, processingMode: existing.processingMode, autoScienceEnabled: existing.autoScienceEnabled, defaultWarehouseId: existing.defaultWarehouseId, defaultDueDays: existing.defaultDueDays } : undefined, afterData: { branchId, source, environment, enabled: cursor.enabled, processingMode, autoScienceEnabled: cursor.autoScienceEnabled, autoScienceAuthorizedAt: cursor.autoScienceAuthorizedAt, autoScienceAuthorizedBy: cursor.autoScienceAuthorizedBy, defaultWarehouseId, defaultDueDays } } });
  return json({ cursor, correlationId });
}

async function classify(db: Awaited<ReturnType<typeof tenantDb>>, body: Record<string, unknown>, user: { id: string; name: string }, correlationId: string) {
  const id = invoiceId(body.documentId), classification = choice(body.classification, classifications, "Classificação"), ignore = body.ignore === true, reason = boundedText(body.reason == null ? null : String(body.reason), 300);
  if (ignore && reason.length < 5) throw new NfeInputError("Informe o motivo para ignorar o documento.");
  const document = await db.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "inbound_fiscal_documents" WHERE "id" = ${id} FOR UPDATE`);
    const before = await tx.inboundFiscalDocument.findUnique({ where: { id } });
    if (!before) throw new NfeInputError("Documento fiscal detectado não encontrado.");
    try { assertFiscalReclassificationAllowed(before.status); } catch (error) { throw new NfeInputError((error as Error).message); }
    const status = ignore ? "ignored" : before.status === "ignored" ? (before.fullDocumentAvailable ? "ready" : "awaiting_document") : "in_review";
    const updated = await tx.inboundFiscalDocument.update({ where: { id }, data: { classification, status, ignoredReason: ignore ? reason : null, reviewedBy: user.name, reviewedAt: new Date() } });
    await tx.inboundFiscalDocumentEvent.create({ data: { documentId: id, type: ignore ? "dfe.document.ignored" : "dfe.document.classified", actorId: user.id, correlationId, metadata: { beforeClassification: before.classification, classification, reason: ignore ? reason : null } } });
    return updated;
  }, { isolationLevel: "Serializable" });
  return json({ document, correlationId });
}

async function restore(db: Awaited<ReturnType<typeof tenantDb>>, body: Record<string, unknown>, user: { id: string; name: string }, correlationId: string) {
  const id = invoiceId(body.documentId);
  const document = await db.$transaction(async tx => {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM inbound_fiscal_documents WHERE id = ${id} FOR UPDATE`);
    const before = await tx.inboundFiscalDocument.findUnique({ where: { id } });
    if (!before || before.status !== "ignored") throw new NfeInputError("Documento ignorado não encontrado.");
    const status = before.fullDocumentAvailable ? "ready" : "awaiting_document";
    return tx.inboundFiscalDocument.update({ where: { id }, data: { status, ignoredReason: null, reviewedBy: user.name, reviewedAt: new Date(), events: { create: { type: "dfe.document.restored", actorId: user.id, correlationId, metadata: { status } } } } });
  }, { isolationLevel: "Serializable" });
  return json({ document, correlationId });
}

async function assertDfeBranchAccess(db: Awaited<ReturnType<typeof tenantDb>>, access: Awaited<ReturnType<typeof assertTenantPermission>>, branchId: number) {
  const branch = await db.branch.findFirst({ where: { id: branchId, status: "active" }, select: { id: true } });
  if (!branch) throw new AuthError(403);
  if (["owner", "admin"].includes(access.membership.role)) return;
  const grant = await db.branchUserAccess.findFirst({ where: { branchId, canIssueFiscal: true, userProfile: { userId: access.user.id, status: "active", OR: [{ accessExpiresAt: null }, { accessExpiresAt: { gt: new Date() } }] } }, select: { id: true } });
  if (!grant) throw new AuthError(403);
}

async function payload(request: Request) {
  return readJsonObject(request, 100_000);
}

function optionalId(value: string | null) { return value ? invoiceId(value) : null; }
function integer(value: string | null, minimum: number, maximum: number, fallback: number) { if (!value) return fallback; return number(value, minimum, maximum, "Paginação"); }
function number(value: unknown, minimum: number, maximum: number, label: string) { const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new NfeInputError(`${label} inválido.`); return parsed; }
function boundedText(value: string | null, maximum: number) { const clean = (value || "").trim(); if (clean.length > maximum) throw new NfeInputError("Texto acima do limite permitido."); return clean; }
function optionalChoice(value: string | null, allowed: Set<string>, label: string) { const clean = (value || "").trim(); return clean ? choice(clean, allowed, label) : ""; }
function choice(value: unknown, allowed: Set<string>, label: string) { const clean = String(value || "").trim(); if (!allowed.has(clean)) throw new NfeInputError(`${label} inválido.`); return clean; }
function safeError(value: string) { return value.replace(/[\r\n\t]+/g, " ").slice(0, 500); }
function json(value: unknown, init: ResponseInit = {}) { return Response.json(value, { ...init, headers: { ...noStore, ...init.headers } }); }

function failure(error: unknown) {
  if (error instanceof NfeManifestationError) return json({ error: error.message }, { status: error.status });
  if (error instanceof DfeDistributionError) return json({ error: error.message }, { status: error.kind === "rate_limit" ? 429 : error.kind === "transport" ? 502 : 422 });
  if (error instanceof NfeInputError || error instanceof CustomerInputError) return json({ error: error.message }, { status: error.message.includes("já") || error.message.includes("diverge") ? 409 : 400 });
  if (error instanceof LicenseDeniedError) return json({ error: error.message }, { status: error.status });
  if (error instanceof AuthError || error instanceof HttpSecurityError) return authErrorResponse(error);
  if (error && typeof error === "object" && "code" in error && error.code === "P2034") return json({ error: "O documento foi alterado por outra operação. Atualize a tela." }, { status: 409 });
  console.error("Falha na caixa de entrada DF-e", { error: error instanceof Error ? error.name : typeof error });
  return json({ error: "Não foi possível processar a caixa fiscal. Tente novamente ou acione o suporte." }, { status: 500 });
}
