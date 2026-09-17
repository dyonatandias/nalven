import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@/generated/tenant/client";
import { currentOrganization, tenantDb } from "@/db";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { LicenseDeniedError } from "@/lib/billing/license";
import { assertSameOrigin, CustomerInputError } from "@/lib/erp/customer-input";
import { choice, date, entityId, integer, record, text } from "@/lib/erp/financial-operations-input";
import {
  allowedFiscalOperation,
  fiscalDocumentCsv,
  FISCAL_DOCUMENT_TYPES,
  FiscalControlInputError,
  FISCAL_OPERATION_TYPES,
  operationDueAt,
  parseFiscalQuery,
  type FiscalOperationType,
} from "@/lib/erp/fiscal-control";
import { assertTenantPermission, matches } from "@/lib/erp/permissions";
import { assertPosMutationRequest, enforcePosRateLimit, PosHttpError, readPosJson } from "@/lib/erp/pos-http";
import { encryptSecret } from "@/lib/secrets";
import { assertTenantWriteAccess } from "@/lib/tenant-access";

type Db = Awaited<ReturnType<typeof tenantDb>>;
type Tx = Prisma.TransactionClient;
type FiscalAccess = Awaited<ReturnType<typeof assertTenantPermission>>;
const NO_STORE = { "cache-control": "private, no-store, max-age=0", expires: "0", pragma: "no-cache" };
const documentInclude = {
  events: { orderBy: { createdAt: "desc" as const }, take: 30 },
  operations: { orderBy: { requestedAt: "desc" as const }, take: 12 },
  branch: { select: { id: true, code: true, name: true } },
};
const operationSelect = {
  id: true, branchId: true, documentId: true, type: true, status: true, priority: true,
  reason: true, details: true, correlationId: true, requestedBy: true, requestedAt: true,
  dueAt: true, resolvedBy: true, resolvedAt: true, resolution: true,
  branch: { select: { id: true, code: true, name: true } },
  document: { select: { type: true, series: true, number: true, recipient: true, status: true } },
};

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const organization = await currentOrganization();
    const access = await assertTenantPermission(organization.id, "fiscal.read");
    const db = await tenantDb(organization.id);
    const branchScope = await fiscalBranchScope(db, access);
    const query = parseFiscalQuery(new URL(request.url).searchParams);
    if (query.branchId && branchScope && !branchScope.includes(query.branchId)) throw new AuthError(403);
    const branchIds = query.branchId ? [query.branchId] : branchScope || undefined;
    const documentWhere: Prisma.FiscalDocumentWhereInput = {
      ...(branchIds ? { branchId: { in: branchIds } } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.environment ? { environment: query.environment } : {}),
      ...(query.from || query.toExclusive ? { createdAt: {
        ...(query.from ? { gte: query.from } : {}), ...(query.toExclusive ? { lt: query.toExclusive } : {}),
      } } : {}),
      ...(query.search ? { OR: [
        { recipient: { contains: query.search, mode: "insensitive" } },
        { sourceId: { contains: query.search, mode: "insensitive" } },
        { accessKey: { contains: query.search } },
        { protocol: { contains: query.search, mode: "insensitive" } },
      ] } : {}),
    };
    if (query.format === "csv") {
      const exported = await db.fiscalDocument.findMany({ where: documentWhere, select: {
        branch: { select: { code: true, name: true } }, type: true, series: true, number: true,
        status: true, environment: true, recipient: true, amountCents: true, accessKey: true,
        protocol: true, rejectionCode: true, rejectionMessage: true, issuedAt: true,
        cancelledAt: true, createdAt: true,
      }, orderBy: { createdAt: "desc" }, take: 10_001 });
      if (exported.length > 10_000) throw new FiscalControlInputError("A exportação excede 10.000 documentos. Reduza o período ou aplique mais filtros.");
      return new Response(fiscalDocumentCsv(exported), { headers: { ...NO_STORE,
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="central-fiscal-${new Date().toISOString().slice(0, 10)}.csv"`,
      } });
    }

    const now = new Date();
    const thirtyDays = new Date(now.valueOf() + 30 * 86_400_000);
    const trendStart = startUtcDay(new Date(now.valueOf() - 13 * 86_400_000));
    const branchWhere = branchScope ? { id: { in: branchScope } } : {};
    const globalBranchWhere = branchIds ? { branchId: { in: branchIds } } : undefined;
    const operationWhere: Prisma.FiscalOperationWhereInput = branchIds ? { branchId: { in: branchIds } } : {};
    const [documents, documentCount, legacyGroups, legacyAmount, certificates, branches, sources,
      posFiscal, posGroups, posIncidents, inbound, inboundGroups, inboundAmount, connectors, cursors,
      openOperations, closedOperations, operationGroups, overdueOperationCount, legacyTrend, posTrend] = await Promise.all([
      db.fiscalDocument.findMany({ where: documentWhere, include: documentInclude,
        orderBy: { createdAt: "desc" }, skip: (query.page - 1) * query.limit, take: query.limit }),
      db.fiscalDocument.count({ where: documentWhere }),
      db.fiscalDocument.groupBy({ by: ["status"], where: globalBranchWhere, _count: { _all: true } }),
      db.fiscalDocument.aggregate({ where: globalBranchWhere, _sum: { amountCents: true } }),
      db.fiscalCertificate.findMany({ where: globalBranchWhere, select: {
        id: true, name: true, branchId: true, fingerprint: true, expiresAt: true, active: true,
        createdAt: true, branch: { select: { code: true, name: true } },
      }, orderBy: { expiresAt: "asc" } }),
      db.branch.findMany({ where: { status: "active", ...branchWhere }, select: {
        id: true, code: true, name: true, document: true, settings: true,
      }, orderBy: [{ primary: "desc" }, { name: "asc" }] }),
      db.salesOrder.findMany({ where: { status: "completed", deletedAt: null,
        ...(branchIds ? { branchId: { in: branchIds } } : {}) }, select: {
        id: true, branchId: true, number: true, customerName: true, total: true, completedAt: true,
      }, orderBy: { completedAt: "desc" }, take: 200 }),
      db.posFiscalDocument.findMany({ where: globalBranchWhere, select: {
        id: true, status: true, documentModel: true, environment: true, provider: true, series: true,
        number: true, accessKey: true, authorizationProtocol: true, rejectionCode: true,
        rejectionMessage: true, authorizedAt: true, cancelledAt: true, totalCents: true,
        createdAt: true, updatedAt: true,
        branch: { select: { id: true, code: true, name: true } },
        sale: { select: { id: true, saleNumber: true, customer: true } },
        attempts: { orderBy: { createdAt: "desc" }, take: 3, select: {
          operation: true, state: true, dispatchCount: true, outcomeUnknown: true,
          failureCode: true, createdAt: true,
        } },
        artifacts: { select: { type: true, mimeType: true, createdAt: true } },
        integrityIncidents: { where: { status: "open" }, select: {
          kind: true, status: true, productionBlocking: true, createdAt: true,
        } },
      }, orderBy: { createdAt: "desc" }, take: 50 }),
      db.posFiscalDocument.groupBy({ by: ["status"], where: globalBranchWhere,
        _count: { _all: true }, _sum: { totalCents: true } }),
      db.posFiscalIntegrityIncident.count({ where: { status: "open", productionBlocking: true,
        ...(branchIds ? { document: { branchId: { in: branchIds } } } : {}) } }),
      db.inboundFiscalDocument.findMany({ where: globalBranchWhere, select: {
        id: true, documentType: true, accessKey: true, issuerName: true, issuerDocument: true,
        number: true, series: true, issueDate: true, total: true, status: true, classification: true,
        manifestationStatus: true, manifestationDeadline: true, detectedAt: true,
        branch: { select: { id: true, code: true, name: true } },
      }, orderBy: { detectedAt: "desc" }, take: 30 }),
      db.inboundFiscalDocument.groupBy({ by: ["status"], where: globalBranchWhere, _count: { _all: true } }),
      db.inboundFiscalDocument.aggregate({ where: globalBranchWhere, _sum: { total: true } }),
      db.posConnector.findMany({ where: { type: { startsWith: "fiscal_" },
        ...(branchIds ? { branchId: { in: branchIds } } : {}) }, select: {
        id: true, branchId: true, type: true, provider: true, status: true,
        settings: true, lastHealthOk: true, lastCheckedAt: true,
      }, orderBy: { updatedAt: "desc" } }),
      db.dfeSyncCursor.findMany({ where: globalBranchWhere, select: {
        id: true, branchId: true, source: true, environment: true, enabled: true, status: true,
        lastSuccessAt: true, nextSyncAt: true, consecutiveFailures: true,
      } }),
      db.fiscalOperation.findMany({ where: { ...operationWhere, status: { in: ["pending", "processing"] } },
        select: operationSelect, orderBy: [{ priority: "desc" }, { dueAt: "asc" }], take: 250 }),
      db.fiscalOperation.findMany({ where: { ...operationWhere, status: { in: ["completed", "rejected", "withdrawn"] } },
        select: operationSelect, orderBy: { resolvedAt: "desc" }, take: 100 }),
      db.fiscalOperation.groupBy({ by: ["status"], where: operationWhere, _count: { _all: true } }),
      db.fiscalOperation.count({ where: { ...operationWhere, status: { in: ["pending", "processing"] }, dueAt: { lt: now } } }),
      db.fiscalDocument.findMany({ where: { ...(globalBranchWhere || {}), createdAt: { gte: trendStart } },
        select: { createdAt: true, status: true, amountCents: true } }),
      db.posFiscalDocument.findMany({ where: { ...(globalBranchWhere || {}), createdAt: { gte: trendStart } },
        select: { createdAt: true, status: true, totalCents: true } }),
    ]);

    const emitted = sources.length ? await db.fiscalDocument.findMany({ where: {
      sourceType: "sales_order", sourceId: { in: sources.map((source) => String(source.id)) },
    }, select: { sourceId: true, type: true } }) : [];
    const counts = countGroups(legacyGroups);
    const posCounts = countGroups(posGroups);
    const inboundCounts = countGroups(inboundGroups);
    const operationCounts = countGroups(operationGroups);
    const operations = [...openOperations, ...closedOperations];
    const readiness = branches.map((branch) => branchReadiness(branch, certificates, connectors, cursors, now));
    const outboundTotal = legacyGroups.reduce((sum, item) => sum + item._count._all, 0);
    const posTotal = posGroups.reduce((sum, item) => sum + item._count._all, 0);
    const authorizedTotal = (counts.authorized || 0) + (posCounts.authorized || 0);
    const pendingOperations = (operationCounts.pending || 0) + (operationCounts.processing || 0);
    const overdueOperations = overdueOperationCount;

    return Response.json({
      documents, certificates, branches,
      sources: sources.map((source) => ({ ...source,
        issuedTypes: emitted.filter((item) => item.sourceId === String(source.id)).map((item) => item.type) })),
      posFiscal, inbound,
      connectors: connectors.map((connector) => ({
        id: connector.id,
        branchId: connector.branchId,
        type: connector.type,
        provider: connector.provider,
        status: connector.status,
        lastHealthOk: connector.lastHealthOk,
        lastCheckedAt: connector.lastCheckedAt,
      })),
      cursors, operations, readiness,
      trend: fiscalTrend(legacyTrend, posTrend, trendStart),
      filters: { search: query.search, status: query.status, type: query.type,
        environment: query.environment, branchId: query.branchId, from: query.fromText, to: query.toText },
      pagination: { page: query.page, limit: query.limit, total: documentCount,
        pages: Math.max(1, Math.ceil(documentCount / query.limit)) },
      capabilities: { canWrite: matches(access.permissions, "fiscal.write") },
      generatedAt: new Date().toISOString(),
      summary: {
        authorized: counts.authorized || 0,
        queued: (counts.draft || 0) + (counts.queued || 0) + (counts.processing || 0) + (counts.contingency || 0),
        rejected: counts.rejected || 0,
        outboundTotal,
        outboundAmount: (legacyAmount._sum.amountCents || 0) / 100,
        authorizationRate: outboundTotal + posTotal ? Math.round(authorizedTotal * 10_000 / (outboundTotal + posTotal)) / 100 : 0,
        certificateAlerts: certificates.filter((item) => item.active && item.expiresAt <= thirtyDays).length,
        activeCertificates: certificates.filter((item) => item.active && item.expiresAt > now).length,
        posTotal,
        posAuthorized: posCounts.authorized || 0,
        posAttention: (posCounts.rejected || 0) + (posCounts.unknown || 0) + (posCounts.manual_review || 0),
        posAmount: posGroups.reduce((sum, item) => sum + (item._sum.totalCents || 0), 0) / 100,
        posIncidents,
        inboundTotal: inboundGroups.reduce((sum, item) => sum + item._count._all, 0),
        inboundReview: (inboundCounts.detected || 0) + (inboundCounts.review || 0),
        inboundAmount: inboundAmount._sum.total || 0,
        branchesReady: readiness.filter((item) => item.status === "ready").length,
        branchesTotal: readiness.length,
        pendingOperations,
        overdueOperations,
      },
    }, { headers: NO_STORE });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    assertPosMutationRequest(request);
    const organization = await currentOrganization();
    const access = await assertTenantPermission(organization.id, "fiscal.write");
    await assertTenantWriteAccess(organization.id);
    const db = await tenantDb(organization.id);
    const body = record(await readPosJson(request, 1_600_000));
    const correlationId = randomUUID();
    const privileged = ["owner", "admin"].includes(access.membership.role);
    await enforcePosRateLimit(db, access.user.id, "fiscal.mutation");
    if (body.action === "response" || body.action === "cancel")
      return Response.json({
        error: "Autorizações, rejeições, contingência e cancelamentos fiscais somente podem ser confirmados por um conector fiscal autenticado e homologado.",
        correlationId,
      }, { status: 409, headers: NO_STORE });
    if (body.action === "operation.resolve")
      return Response.json({
        error: "Autorizações, rejeições, contingência e cancelamentos fiscais somente podem ser confirmados por um conector fiscal autenticado e homologado.",
        correlationId,
      }, { status: 409, headers: NO_STORE });

    if (body.action === "certificate.save") {
      const branchId = entityId(body.branchId);
      const branch = await db.branch.findFirst({ where: { id: branchId, status: "active" } });
      const content = String(body.content || "").trim();
      const password = String(body.password || "");
      if (!branch) throw new FiscalControlInputError("Filial não encontrada.");
      await assertFiscalBranchAccess(db, access.user.id, branchId, privileged);
      if (!/^[A-Za-z0-9+/=]+$/.test(content) || content.length < 128 || content.length > 1_500_000)
        throw new FiscalControlInputError("Certificado PFX inválido ou muito grande.");
      if (password.length < 1 || password.length > 300) throw new FiscalControlInputError("Senha do certificado inválida.");
      const raw = Buffer.from(content, "base64");
      if (raw.length < 96 || raw[0] !== 0x30) throw new FiscalControlInputError("O arquivo não possui estrutura PKCS#12 válida.");
      const fingerprint = createHash("sha256").update(raw).digest("hex");
      const expiresAt = date(body.expiresAt);
      const today = startUtcDay(new Date());
      const maximumExpiry = new Date(today);
      maximumExpiry.setUTCFullYear(maximumExpiry.getUTCFullYear() + 10);
      if (expiresAt < today || expiresAt > maximumExpiry)
        throw new FiscalControlInputError("A validade deve estar entre hoje e os próximos 10 anos.");
      const certificate = await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM branches WHERE id = ${branchId} FOR UPDATE`;
        const duplicate = await tx.fiscalCertificate.findFirst({ where: { branchId, fingerprint }, select: { id: true } });
        if (duplicate) throw new FiscalControlInputError("Este certificado já está instalado na filial.");
        await tx.fiscalCertificate.updateMany({ where: { branchId, active: true }, data: { active: false } });
        const created = await tx.fiscalCertificate.create({ data: {
          name: text(body.name, "Nome"), branchId, encryptedContent: encryptSecret(content),
          encryptedPassword: encryptSecret(password), fingerprint, expiresAt, createdBy: access.user.name,
        }, select: { id: true, name: true, branchId: true, fingerprint: true, expiresAt: true, active: true } });
        await audit(tx, access.user.id, "fiscal_certificate.saved", "fiscal_certificate", String(created.id), correlationId,
          { branchId, fingerprint, expiresAt: created.expiresAt });
        return created;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return Response.json({ certificate, correlationId }, { status: 201, headers: NO_STORE });
    }

    if (body.action === "certificate.toggle") {
      const id = entityId(body.certificateId);
      const before = await db.fiscalCertificate.findUnique({ where: { id } });
      if (!before) throw new FiscalControlInputError("Certificado não encontrado.");
      await assertFiscalBranchAccess(db, access.user.id, before.branchId, privileged);
      if (!before.active && before.expiresAt < new Date()) throw new FiscalControlInputError("Certificado vencido não pode ser ativado.");
      const certificate = await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM branches WHERE id = ${before.branchId} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM fiscal_certificates WHERE id = ${id} FOR UPDATE`;
        const current = await tx.fiscalCertificate.findUnique({ where: { id } });
        if (!current) throw new FiscalControlInputError("Certificado não encontrado.");
        if (!current.active) await tx.fiscalCertificate.updateMany({ where: { branchId: current.branchId, active: true }, data: { active: false } });
        const updated = await tx.fiscalCertificate.update({ where: { id }, data: { active: !current.active },
          select: { id: true, name: true, branchId: true, fingerprint: true, expiresAt: true, active: true } });
        await audit(tx, access.user.id, "fiscal_certificate.toggled", "fiscal_certificate", String(id), correlationId,
          { active: updated.active });
        return updated;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return Response.json({ certificate, correlationId }, { headers: NO_STORE });
    }

    if (body.action === "document.create") {
      const branchId = entityId(body.branchId);
      const sourceId = entityId(body.sourceId);
      const type = choice(body.type, [...FISCAL_DOCUMENT_TYPES]);
      await assertFiscalBranchAccess(db, access.user.id, branchId, privileged);
      const document = await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT branch_id FROM branch_settings WHERE branch_id = ${branchId} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM sales_orders WHERE id = ${sourceId} FOR UPDATE`;
        const [branch, source] = await Promise.all([
          tx.branch.findFirst({ where: { id: branchId, status: "active" }, include: { settings: true } }),
          tx.salesOrder.findFirst({ where: { id: sourceId, branchId, status: "completed", deletedAt: null } }),
        ]);
        if (!branch?.settings || !source) throw new FiscalControlInputError("Filial configurada ou pedido concluído não encontrado.");
        if (source.branchId !== branchId) throw new FiscalControlInputError("O pedido não pertence à filial fiscal selecionada.");
        const config = type === "nfe"
          ? { series: branch.settings.nfeSeries, field: "nextNfeNumber" as const, number: branch.settings.nextNfeNumber }
          : type === "nfce"
            ? { series: branch.settings.nfceSeries, field: "nextNfceNumber" as const, number: branch.settings.nextNfceNumber }
            : { series: branch.settings.nfseSeries, field: "nextNfseNumber" as const, number: branch.settings.nextNfseNumber };
        const created = await tx.fiscalDocument.create({ data: {
          branchId, type, series: config.series, number: config.number,
          environment: branch.settings.fiscalEnvironment, sourceType: "sales_order", sourceId: String(source.id),
          recipient: source.customerName, amount: source.total, amountCents: Math.round(source.total * 100),
          createdBy: access.user.name,
          events: { create: { type: "created", description: "Documento fiscal preparado com numeração reservada", actor: access.user.name } },
        }, include: documentInclude });
        await tx.branchSettings.update({ where: { branchId }, data: { [config.field]: { increment: 1 } } });
        await audit(tx, access.user.id, "fiscal_document.created", "fiscal_document", String(created.id), correlationId,
          { branchId, type, series: config.series, number: config.number, sourceId });
        return created;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return Response.json({ document, correlationId }, { status: 201, headers: NO_STORE });
    }

    if (body.action === "queue") {
      const id = entityId(body.documentId);
      const before = await db.fiscalDocument.findUnique({ where: { id } });
      if (!before || before.status !== "draft") throw new FiscalControlInputError("Documento em rascunho não encontrado.");
      await assertFiscalBranchAccess(db, access.user.id, before.branchId, privileged);
      const document = await queueDocument(db, id, access.user, correlationId);
      return Response.json({ document, correlationId }, { headers: NO_STORE });
    }

    if (body.action === "operation.request") {
      const operationType = choice(body.operation, [...FISCAL_OPERATION_TYPES]) as FiscalOperationType;
      if (operationType === "issuance") throw new FiscalControlInputError("Use a ação de preparar para conector para solicitar a emissão.");
      const priority = choice(body.priority || "normal", ["normal", "urgent"]);
      const reason = operationReason(body.reason);
      if (operationType === "invalidation") {
        const branchId = entityId(body.branchId);
        await assertFiscalBranchAccess(db, access.user.id, branchId, privileged);
        const documentType = choice(body.documentType, [...FISCAL_DOCUMENT_TYPES]);
        const series = integer(body.series, 1, 999);
        const startNumber = integer(body.startNumber, 1, 999_999_999);
        const endNumber = integer(body.endNumber, startNumber, Math.min(999_999_999, startNumber + 9_999));
        const operation = await requestInvalidation(db, { branchId, documentType, series, startNumber, endNumber,
          priority, reason, correlationId, user: access.user });
        return Response.json({ operation, correlationId }, { status: 201, headers: NO_STORE });
      }
      const documentId = entityId(body.documentId);
      const before = await db.fiscalDocument.findUnique({ where: { id: documentId } });
      if (!before) throw new FiscalControlInputError("Documento fiscal não encontrado.");
      await assertFiscalBranchAccess(db, access.user.id, before.branchId, privileged);
      const operation = await requestDocumentOperation(db, documentId, operationType, priority, reason, correlationId, access.user);
      return Response.json({ operation, correlationId }, { status: 201, headers: NO_STORE });
    }

    if (body.action === "operation.withdraw") {
      const operationId = entityId(body.operationId);
      const operation = await db.fiscalOperation.findUnique({ where: { id: operationId } });
      if (!operation) throw new FiscalControlInputError("Solicitação fiscal não encontrada.");
      await assertFiscalBranchAccess(db, access.user.id, operation.branchId, privileged);
      if (!["status_query", "contingency", "cancellation", "correction", "invalidation"].includes(operation.type))
        throw new FiscalControlInputError("Esta solicitação não pode ser retirada após o envio à fila.");
      const withdrawn = await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM fiscal_operations WHERE id = ${operationId} FOR UPDATE`;
        const changed = await tx.fiscalOperation.updateMany({ where: { id: operationId, status: "pending" }, data: {
          status: "withdrawn", resolvedAt: new Date(), resolvedBy: access.user.name,
          resolution: "Solicitação retirada pelo usuário antes do processamento pelo conector",
        } });
        if (changed.count !== 1) throw new FiscalControlInputError("A solicitação já foi processada ou alterada. Atualize a página.");
        if (operation.documentId) await tx.fiscalEvent.create({ data: { documentId: operation.documentId,
          type: `request_${operation.type}_withdrawn`, description: "Solicitação retirada antes do processamento",
          actor: access.user.name } });
        await audit(tx, access.user.id, "fiscal_operation.withdrawn", "fiscal_operation", String(operationId), correlationId,
          { status: "withdrawn" });
        return tx.fiscalOperation.findUniqueOrThrow({ where: { id: operationId } });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return Response.json({ operation: withdrawn, correlationId }, { headers: NO_STORE });
    }

    throw new FiscalControlInputError("Ação fiscal inválida.");
  } catch (error) {
    return failure(error);
  }
}

async function queueDocument(db: Db, id: number, user: { id: string; name: string }, correlationId: string) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM fiscal_documents WHERE id = ${id} FOR UPDATE`;
    const current = await tx.fiscalDocument.findUnique({ where: { id } });
    if (!current || current.status !== "draft") throw new FiscalControlInputError("O documento já foi alterado por outro usuário. Atualize a página.");
    const certificate = await tx.fiscalCertificate.findFirst({ where: {
      branchId: current.branchId, active: true, expiresAt: { gte: new Date() },
    } });
    if (!certificate) throw new FiscalControlInputError("Certificado fiscal válido não configurado.");
    const dueAt = operationDueAt("issuance");
    const document = await tx.fiscalDocument.update({ where: { id }, data: {
      status: "queued", attemptCount: { increment: 1 }, lastQueuedAt: new Date(), slaDueAt: dueAt,
    }, include: documentInclude });
    const operation = await tx.fiscalOperation.create({ data: {
      branchId: current.branchId, documentId: id, type: "issuance", status: "pending", priority: "normal",
      reason: "Emissão solicitada a partir da Central Fiscal", correlationId, requestedBy: user.name, dueAt,
    } });
    await tx.fiscalEvent.create({ data: { documentId: id, type: "request_issuance",
      description: "Emissão solicitada; aguardando conector fiscal homologado", actor: user.name } });
    await audit(tx, user.id, "fiscal_operation.requested", "fiscal_operation", String(operation.id), correlationId,
      { type: operation.type, documentId: id, dueAt });
    return document;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

async function requestDocumentOperation(db: Db, documentId: number, operationType: FiscalOperationType,
  priority: string, reason: string, correlationId: string, user: { id: string; name: string }) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM fiscal_documents WHERE id = ${documentId} FOR UPDATE`;
    const document = await tx.fiscalDocument.findUnique({ where: { id: documentId } });
    if (!document || !allowedFiscalOperation(operationType, document))
      throw new FiscalControlInputError("Esta operação não é permitida no estado atual do documento.");
    const pending = await tx.fiscalOperation.findFirst({ where: { documentId, type: operationType,
      status: { in: ["pending", "processing"] } }, select: { id: true } });
    if (pending) throw new FiscalControlInputError("Já existe uma solicitação deste tipo aguardando processamento.");
    const dueAt = operationDueAt(operationType);
    const operation = await tx.fiscalOperation.create({ data: {
      branchId: document.branchId, documentId, type: operationType, status: "pending", priority,
      reason, correlationId, requestedBy: user.name, dueAt,
    } });
    if (operationType === "retry") await tx.fiscalDocument.update({ where: { id: documentId }, data: {
      status: "queued", attemptCount: { increment: 1 }, lastQueuedAt: new Date(), slaDueAt: dueAt,
    } });
    await tx.fiscalEvent.create({ data: { documentId, type: `request_${operationType}`,
      description: requestDescription(operationType, reason), actor: user.name } });
    await audit(tx, user.id, "fiscal_operation.requested", "fiscal_operation", String(operation.id), correlationId,
      { type: operationType, documentId, priority, dueAt });
    return operation;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

async function requestInvalidation(db: Db, input: {
  branchId: number; documentType: string; series: number; startNumber: number; endNumber: number;
  priority: string; reason: string; correlationId: string; user: { id: string; name: string };
}) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM branches WHERE id = ${input.branchId} FOR UPDATE`;
    const branch = await tx.branch.findFirst({ where: { id: input.branchId, status: "active" }, select: { id: true } });
    if (!branch) throw new FiscalControlInputError("Filial ativa não encontrada.");
    const occupied = await tx.fiscalDocument.findFirst({ where: { branchId: input.branchId,
      type: input.documentType, series: input.series, number: { gte: input.startNumber, lte: input.endNumber } },
      select: { number: true } });
    if (occupied) throw new FiscalControlInputError(`O número ${occupied.number} já possui documento e não pode integrar a faixa.`);
    const dueAt = operationDueAt("invalidation");
    const operation = await tx.fiscalOperation.create({ data: {
      branchId: input.branchId, type: "invalidation", status: "pending", priority: input.priority,
      reason: input.reason, correlationId: input.correlationId, requestedBy: input.user.name, dueAt,
      details: { documentType: input.documentType, series: input.series,
        startNumber: input.startNumber, endNumber: input.endNumber },
    } });
    await audit(tx, input.user.id, "fiscal_operation.requested", "fiscal_operation", String(operation.id), input.correlationId,
      { type: "invalidation", branchId: input.branchId, details: operation.details, dueAt });
    return operation;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

async function fiscalBranchScope(db: Db, access: FiscalAccess) {
  if (["owner", "admin"].includes(access.membership.role)) return null;
  const profile = await db.tenantUserProfile.findUnique({ where: { userId: access.user.id }, select: {
    branchAccesses: { where: { canIssueFiscal: true, branch: { status: "active" } }, select: { branchId: true } },
  } });
  const branchIds = profile?.branchAccesses.map((item) => item.branchId) ?? [];
  if (!branchIds.length) throw new AuthError(403);
  return branchIds;
}

async function assertFiscalBranchAccess(db: Db, userId: string, branchId: number, privileged: boolean) {
  if (privileged) return;
  const allowed = await db.branchUserAccess.findFirst({ where: { branchId, canIssueFiscal: true,
    branch: { status: "active" }, userProfile: { userId, status: "active" } }, select: { id: true } });
  if (!allowed) throw new AuthError(403);
}

function branchReadiness(
  branch: { id: number; name: string; document: string; settings: { fiscalEnvironment: string } | null },
  certificates: Array<{ branchId: number; active: boolean; expiresAt: Date }>,
  connectors: Array<{ branchId: number; status: string; settings: Prisma.JsonValue; lastHealthOk: boolean | null; lastCheckedAt: Date | null }>,
  cursors: Array<{ branchId: number; enabled: boolean; environment: string; consecutiveFailures: number; lastSuccessAt: Date | null }>,
  now: Date,
) {
  const certificate = certificates.find((item) => item.branchId === branch.id && item.active);
  const connector = connectors.find((item) => item.branchId === branch.id && item.status === "active"
    && connectorEnvironment(item.settings, branch.settings?.fiscalEnvironment));
  const cursor = cursors.find((item) => item.branchId === branch.id && item.enabled && item.environment === branch.settings?.fiscalEnvironment);
  const validRegistration = /^\d{14}$/.test(branch.document.replace(/\D/g, ""));
  const validCertificate = Boolean(certificate && certificate.expiresAt > now);
  const healthyConnector = Boolean(connector?.lastHealthOk && connector.lastCheckedAt
    && connector.lastCheckedAt > new Date(now.valueOf() - 2 * 3_600_000));
  const healthyCursor = Boolean(cursor && cursor.consecutiveFailures === 0 && cursor.lastSuccessAt
    && cursor.lastSuccessAt > new Date(now.valueOf() - 36 * 3_600_000));
  const checks = [
    { key: "registration", label: "Cadastro fiscal", ok: validRegistration,
      detail: validRegistration ? "CNPJ da filial preenchido" : "CNPJ da filial ausente ou inválido" },
    { key: "configuration", label: "Configuração", ok: Boolean(branch.settings),
      detail: branch.settings ? "Regime, ambiente, séries e numeração configurados" : "Configuração fiscal ausente" },
    { key: "certificate", label: "Certificado A1", ok: validCertificate,
      detail: certificate ? certificate.expiresAt <= now ? "Certificado vencido" : "Certificado ativo e dentro da validade informada" : "Certificado ativo ausente" },
    { key: "connector", label: "Conector fiscal", ok: healthyConnector,
      detail: healthyConnector ? "Saúde confirmada nas últimas 2 horas" : !connector ? "Conector homologado ativo ausente neste ambiente" : connector.lastHealthOk === false ? "Última verificação de saúde falhou" : "Verificação de saúde desatualizada" },
    { key: "dfe", label: "Recebimento DF-e", ok: healthyCursor,
      detail: healthyCursor ? "Sincronização confirmada nas últimas 36 horas" : !cursor ? "Consulta no ambiente fiscal não configurada" : cursor.consecutiveFailures ? `${cursor.consecutiveFailures} falha(s) consecutiva(s)` : "Última consulta está desatualizada" },
  ];
  const passed = checks.filter((check) => check.ok).length;
  return { branchId: branch.id, branchName: branch.name, status: passed === checks.length ? "ready" : "attention",
    score: Math.round(passed * 100 / checks.length), checks, issues: checks.filter((check) => !check.ok).map((check) => check.detail) };
}

function connectorEnvironment(settings: Prisma.JsonValue, expected: string | undefined) {
  if (!expected || !settings || typeof settings !== "object" || Array.isArray(settings)) return true;
  const configured = "environment" in settings ? settings.environment : null;
  return typeof configured !== "string" || configured === expected;
}

function fiscalTrend(legacy: Array<{ createdAt: Date; status: string; amountCents: number }>,
  pos: Array<{ createdAt: Date; status: string; totalCents: number }>, start: Date) {
  return Array.from({ length: 14 }, (_, index) => {
    const day = new Date(start.valueOf() + index * 86_400_000);
    const key = day.toISOString().slice(0, 10);
    const legacyDay = legacy.filter((item) => item.createdAt.toISOString().slice(0, 10) === key);
    const posDay = pos.filter((item) => item.createdAt.toISOString().slice(0, 10) === key);
    const all = [...legacyDay, ...posDay];
    return { date: key, total: all.length,
      authorized: all.filter((item) => item.status === "authorized").length,
      rejected: all.filter((item) => ["rejected", "unknown", "manual_review"].includes(item.status)).length,
      amount: (legacyDay.reduce((sum, item) => sum + item.amountCents, 0)
        + posDay.reduce((sum, item) => sum + item.totalCents, 0)) / 100 };
  });
}

function countGroups(groups: Array<{ status: string; _count: { _all: number } }>) {
  return Object.fromEntries(groups.map((item) => [item.status, item._count._all])) as Record<string, number>;
}

function operationReason(value: unknown) {
  const reason = String(value || "").trim();
  if (reason.length < 15 || reason.length > 500) throw new FiscalControlInputError("Informe uma justificativa entre 15 e 500 caracteres.");
  return reason;
}

function requestDescription(type: FiscalOperationType, reason: string) {
  const labels: Record<FiscalOperationType, string> = {
    issuance: "Emissão solicitada", retry: "Reprocessamento solicitado após rejeição",
    status_query: "Reconsulta de status solicitada", contingency: "Entrada em contingência solicitada",
    cancellation: "Cancelamento solicitado", correction: "Carta de correção solicitada",
    invalidation: "Inutilização de faixa solicitada",
  };
  return `${labels[type]} · ${reason}`;
}

async function audit(tx: Tx, actorId: string, action: string, entityType: string, entityId: string,
  correlationId: string, afterData: Prisma.InputJsonValue) {
  await tx.tenantAuditEvent.create({ data: { actorId, action, entityType, entityId, correlationId, afterData } });
}

function startUtcDay(value: Date) {
  return new Date(`${value.toISOString().slice(0, 10)}T00:00:00.000Z`);
}

function failure(error: unknown) {
  if (error instanceof PosHttpError)
    return Response.json({ error: error.message }, { status: error.status, headers: NO_STORE });
  if (error instanceof FiscalControlInputError || error instanceof CustomerInputError)
    return Response.json({ error: error.message }, { status: 400, headers: NO_STORE });
  if (error instanceof LicenseDeniedError)
    return Response.json({ error: error.message }, { status: error.status, headers: NO_STORE });
  if (error && typeof error === "object" && "code" in error && error.code === "P2002")
    return Response.json({ error: "Já existe documento ou solicitação fiscal equivalente." }, { status: 409, headers: NO_STORE });
  if (error && typeof error === "object" && "code" in error && error.code === "P2034")
    return Response.json({ error: "Conflito de concorrência. Atualize os dados e tente novamente." }, { status: 409, headers: NO_STORE });
  if (error instanceof AuthError) return authErrorResponse(error);
  console.error("Fiscal center request failed", error instanceof Error ? error.name : "unknown");
  return Response.json({ error: "Não foi possível concluir a operação fiscal." }, { status: 500, headers: NO_STORE });
}
