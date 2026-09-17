import { createHash, randomUUID } from "node:crypto";
import { ensureDistributedIssuer } from "./fiscal-supplier";
import { request as httpsRequest } from "node:https";
import { gunzipSync } from "node:zlib";
import { Prisma } from "@/generated/tenant/client";
import { controlDb, tenantDb } from "@/db";
import { decryptSecret, encryptSecret } from "@/lib/secrets";
import { parseNfeXml, validCnpj, validAccessKey } from "@/lib/erp/nfe-input";
import { prepareInboundInvoice } from "@/lib/erp/inbound-fiscal";
import { autoReceiveEligibility, receivePurchaseInvoiceRecord } from "@/lib/erp/purchase-invoice-receiving";
import { recoverAutomaticNfeScience } from "@/lib/erp/nfe-manifestation-service";

const ENDPOINTS = {
  production: "https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx",
  homologation: "https://hom1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx",
} as const;
const NFSE_ENDPOINTS = {
  production: "https://adn.nfse.gov.br/contribuintes",
  homologation: "https://adn.producaorestrita.nfse.gov.br/contribuintes",
} as const;
const CTE_ENDPOINTS = {
  production: "https://www1.cte.fazenda.gov.br/CTeDistribuicaoDFe/CTeDistribuicaoDFe.asmx",
  homologation: "https://hom1.cte.fazenda.gov.br/CTeDistribuicaoDFe/CTeDistribuicaoDFe.asmx",
} as const;
const SOAP_ACTION = "http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe/nfeDistDFeInteresse";
const MAX_SOAP_BYTES = 14_000_000;
const MAX_DOCUMENT_BYTES = 5_000_000;
const UF_CODES: Record<string, string> = {
  AC: "12", AL: "27", AP: "16", AM: "13", BA: "29", CE: "23", DF: "53", ES: "32", GO: "52",
  MA: "21", MT: "51", MS: "50", MG: "31", PA: "15", PB: "25", PR: "41", PE: "26", PI: "22",
  RJ: "33", RN: "24", RS: "43", RO: "11", RR: "14", SC: "42", SP: "35", SE: "28", TO: "17",
};

type TenantDb = Awaited<ReturnType<typeof tenantDb>>;
type Environment = keyof typeof ENDPOINTS;

export class DfeDistributionError extends Error {
  constructor(message: string, readonly kind: "configuration" | "transport" | "rate_limit" | "response" = "response") {
    super(message);
    this.name = "DfeDistributionError";
  }
}

export type DistributedDocument = {
  nsu: string;
  schemaName: string;
  xml: string;
  payloadHash: string;
  documentType: "nfe" | "cte" | "nfse" | "event" | "unknown";
  accessKey: string | null;
  issuerDocument: string | null;
  issuerName: string | null;
  recipientDocument: string | null;
  number: string | null;
  series: string | null;
  issueDate: Date | null;
  authorizationDate: Date | null;
  total: number | null;
  fullDocumentAvailable: boolean;
  classification: "goods" | "service" | "freight" | "unknown";
  cancelled: boolean;
};

export type DistributionResponse = {
  statusCode: string;
  reason: string;
  lastNsu: string;
  maxNsu: string;
  documents: DistributedDocument[];
};

export function parseDistributionResponse(xml: string): DistributionResponse {
  if (Buffer.byteLength(xml, "utf8") > MAX_SOAP_BYTES || /<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new DfeDistributionError("Resposta da SEFAZ inválida ou acima do limite seguro.");
  }
  const statusCode = xmlText(xml, "cStat");
  const reason = xmlText(xml, "xMotivo") || "Resposta sem motivo informado";
  if (!/^\d{3}$/.test(statusCode)) throw new DfeDistributionError("A SEFAZ devolveu uma resposta sem código de status.");
  if (statusCode === "656") throw new DfeDistributionError("Consumo indevido informado pela SEFAZ. A sincronização aguardará antes de tentar novamente.", "rate_limit");
  if (!["137", "138"].includes(statusCode)) throw new DfeDistributionError(`SEFAZ ${statusCode}: ${safeReason(reason)}`);
  const lastNsu = normalizeNsu(xmlText(xml, "ultNSU"));
  const maxNsu = normalizeNsu(xmlText(xml, "maxNSU"));
  const documents = [...xml.matchAll(/<(?:\w+:)?docZip\b([^>]*)>([A-Za-z0-9+/=\s]+)<\/(?:\w+:)?docZip>/gi)].map((match) => {
    const nsu = normalizeNsu(xmlAttribute(match[1] || "", "NSU"));
    const schemaName = boundedSchema(xmlAttribute(match[1] || "", "schema"));
    const encoded = (match[2] || "").replace(/\s/g, "");
    if (!encoded || encoded.length > 20_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new DfeDistributionError(`Documento NSU ${nsu} possui conteúdo inválido.`);
    let documentXml: string;
    try {
      documentXml = gunzipSync(Buffer.from(encoded, "base64"), { maxOutputLength: MAX_DOCUMENT_BYTES }).toString("utf8");
    } catch {
      throw new DfeDistributionError(`Documento NSU ${nsu} não pôde ser descompactado com segurança.`);
    }
    return inspectDistributedDocument(nsu, schemaName, documentXml);
  });
  if (statusCode === "138" && !documents.length) throw new DfeDistributionError("A SEFAZ informou documentos localizados, mas não enviou nenhum conteúdo.");
  const ordered = [...documents].sort((left, right) => left.nsu.localeCompare(right.nsu));
  if (new Set(ordered.map((item) => item.nsu)).size !== ordered.length) throw new DfeDistributionError("A resposta da SEFAZ possui NSU duplicado.");
  validateCursorRange(lastNsu, maxNsu, ordered, "SEFAZ");
  return { statusCode, reason: safeReason(reason), lastNsu, maxNsu, documents: ordered };
}

export function parseNfseDistributionResponse(body: string, requestedNsu: string): DistributionResponse {
  if (Buffer.byteLength(body, "utf8") > MAX_SOAP_BYTES) throw new DfeDistributionError("Resposta do ADN NFS-e acima do limite seguro.");
  let payload: unknown;
  try { payload = JSON.parse(body); } catch { throw new DfeDistributionError("O ADN NFS-e devolveu JSON inválido."); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new DfeDistributionError("Resposta do ADN NFS-e inválida.");
  const root = payload as Record<string, unknown>;
  if ("StatusProcessamento" in root) return parseOfficialAdnResponse(root, requestedNsu);
  const container = firstValue(root, ["documentos", "Documentos", "dfe", "DFe", "loteDFe", "LoteDFe", "listaDFe", "ListaDFe"]);
  if (container == null && !hasFiscalContent(root)) throw new DfeDistributionError("Resposta do ADN sem contrato de distribuição reconhecido.");
  const nested = container && typeof container === "object" && !Array.isArray(container) ? container as Record<string, unknown> : null;
  const rawDocuments = Array.isArray(container) ? container : nested ? firstArray(nested, ["documentos", "Documentos", "dfe", "DFe", "itens", "Itens"]) : hasFiscalContent(root) ? [root] : [];
  const lastNsu = normalizeNsu(String(firstValue(root, ["ultNSU", "ultimoNSU", "UltimoNSU", "lastNsu"]) || (nested && firstValue(nested, ["ultNSU", "ultimoNSU", "UltimoNSU", "lastNsu"])) || requestedNsu));
  const maxNsu = normalizeNsu(String(firstValue(root, ["maxNSU", "maiorNSU", "MaxNSU", "maxNsu"]) || (nested && firstValue(nested, ["maxNSU", "maiorNSU", "MaxNSU", "maxNsu"])) || lastNsu));
  const documents = rawDocuments.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new DfeDistributionError(`Documento NFS-e ${index + 1} possui estrutura inválida.`);
    const row = value as Record<string, unknown>, nsu = normalizeNsu(String(firstValue(row, ["nsu", "NSU", "Nsu"]) || ""));
    const schemaName = boundedSchema(String(firstValue(row, ["schema", "Schema", "tipoDocumento", "TipoDocumento"]) || "nfse_v1.00.xsd"));
    const content = firstValue(row, ["xml", "XML", "documento", "Documento", "dfe", "DFe", "arquivo", "Arquivo", "conteudo", "Conteudo"]);
    if (typeof content !== "string" || !content.trim()) throw new DfeDistributionError(`Documento NFS-e NSU ${nsu} não possui conteúdo.`);
    return inspectDistributedDocument(nsu, schemaName, decodeFiscalContent(content));
  }).sort((left, right) => left.nsu.localeCompare(right.nsu));
  if (new Set(documents.map((item) => item.nsu)).size !== documents.length) throw new DfeDistributionError("A resposta do ADN NFS-e possui NSU duplicado.");
  validateCursorRange(lastNsu, maxNsu, documents, "ADN NFS-e");
  const reason = String(firstValue(root, ["mensagem", "Mensagem", "message", "xMotivo"]) || (documents.length ? "Documentos localizados" : "Nenhum documento localizado")).slice(0, 255);
  return { statusCode: documents.length ? "138" : "137", reason: safeReason(reason), lastNsu, maxNsu, documents };
}

// ADN Contribuintes OpenAPI v1: the cursor is the greatest NSU in LoteDFe;
// this response has no ultNSU/maxNSU properties (unlike NF-e SOAP).
function parseOfficialAdnResponse(root: Record<string, unknown>, requestedNsu: string): DistributionResponse {
  const status = root.StatusProcessamento;
  if (status === "REJEICAO" || adnHasErrors(root))
    throw new DfeDistributionError("O ADN rejeitou a consulta. Verifique o certificado e o CNPJ de consulta.");
  if (status !== "DOCUMENTOS_LOCALIZADOS" && status !== "NENHUM_DOCUMENTO_LOCALIZADO")
    throw new DfeDistributionError("Status de distribuição do ADN desconhecido.");
  const rows = root.LoteDFe ?? [];
  if (!Array.isArray(rows) || rows.length > 50 || (status === "DOCUMENTOS_LOCALIZADOS") !== (rows.length > 0))
    throw new DfeDistributionError("Lote do ADN inconsistente com o status informado.");
  const documents = rows.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new DfeDistributionError("Documento ADN inválido.");
    const row = value as Record<string, unknown>;
    if (typeof row.NSU === "number" && !Number.isSafeInteger(row.NSU)) throw new DfeDistributionError("NSU ADN sem precisão segura.");
    const nsu = normalizeNsu(String(row.NSU ?? ""));
    if (BigInt(nsu) <= BigInt(normalizeNsu(requestedNsu))) throw new DfeDistributionError("ADN devolveu NSU que não avança o cursor.");
    if (typeof row.ArquivoXml !== "string" || !row.ArquivoXml.trim()) throw new DfeDistributionError("Documento ADN sem ArquivoXml.");
    const schema = row.TipoDocumento === "NFSE" ? "nfse_v1.00.xsd" : row.TipoDocumento === "EVENTO" ? "proceventonfse_v1.00.xsd" : "unknown_v1.00.xsd";
    const parsed = inspectDistributedDocument(nsu, schema, decodeFiscalContent(row.ArquivoXml));
    if (row.TipoDocumento === "NFSE" && (!parsed.accessKey || !parsed.issuerDocument)) throw new DfeDistributionError("NFS-e ADN sem identidade fiscal válida.");
    if (row.TipoDocumento === "NFSE" && row.ChaveAcesso != null && row.ChaveAcesso !== parsed.accessKey) throw new DfeDistributionError("Chave ADN diverge do XML.");
    return parsed;
  }).sort((a, b) => a.nsu.localeCompare(b.nsu));
  const lastNsu = documents.at(-1)?.nsu || normalizeNsu(requestedNsu);
  if (new Set(documents.map(item => item.nsu)).size !== documents.length) throw new DfeDistributionError("NSU duplicado no ADN.");
  return { statusCode: documents.length ? "138" : "137", reason: documents.length ? "Documentos localizados" : "Nenhum documento localizado", lastNsu, maxNsu: lastNsu, documents };
}

function adnHasErrors(root: Record<string, unknown>) {
  if (root.Erros == null) return false;
  if (!Array.isArray(root.Erros)) return true;
  if (!root.Erros.length) return false;
  // ADN returns HTTP 404 plus E2220 for a successful, empty distribution.
  // Only this exact combination is informational; other rejections remain errors.
  return !(root.StatusProcessamento === "NENHUM_DOCUMENTO_LOCALIZADO"
    && (root.LoteDFe == null || Array.isArray(root.LoteDFe) && root.LoteDFe.length === 0)
    && root.Erros.every(error => error && typeof error === "object" && error.Codigo === "E2220"));
}

export function inspectDistributedDocument(nsu: string, schemaName: string, xml: string): DistributedDocument {
  if (Buffer.byteLength(xml, "utf8") > MAX_DOCUMENT_BYTES || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new DfeDistributionError(`Documento NSU ${nsu} inválido ou acima do limite seguro.`);
  const schema = schemaName.toLowerCase();
  const payloadHash = createHash("sha256").update(xml).digest("hex");
  if (/procnfe|nfe_v/.test(schema) && /<(?:\w+:)?infNFe\b/i.test(xml)) {
    const parsed = parseNfeXml(xml);
    return {
      nsu, schemaName, xml, payloadHash, documentType: "nfe", accessKey: parsed.accessKey,
      issuerDocument: parsed.supplierDocument, issuerName: parsed.supplierName,
      recipientDocument: parsed.recipientDocument || null, number: parsed.number, series: parsed.series,
      issueDate: parsed.issueDate, authorizationDate: validDate(xmlText(xml, "dhRecbto")), total: parsed.total,
      fullDocumentAvailable: true, classification: "goods", cancelled: false,
    };
  }
  if (schema.startsWith("resnfe")) {
    const accessKey = digits(xmlText(xml, "chNFe"), 44);
    return {
      nsu, schemaName, xml, payloadHash, documentType: "nfe", accessKey,
      issuerDocument: documentFrom(xml), issuerName: optionalText(xmlText(xml, "xNome"), 200),
      recipientDocument: null, number: accessKey ? String(Number(accessKey.slice(25, 34))) : null,
      series: accessKey ? String(Number(accessKey.slice(22, 25))) : null,
      issueDate: validDate(xmlText(xml, "dhEmi")), authorizationDate: validDate(xmlText(xml, "dhRecbto")),
      total: finiteMoney(xmlText(xml, "vNF")), fullDocumentAvailable: false, classification: "goods",
      cancelled: xmlText(xml, "cSitNFe") === "3",
    };
  }
  if (/evento|pedregevt|proceventonfse/.test(schema)) {
    const eventType = xmlText(xml, "tpEvento");
    return {
      nsu, schemaName, xml, payloadHash, documentType: "event", accessKey: null,
      issuerDocument: documentFrom(xml), issuerName: null, recipientDocument: null, number: null, series: null,
      issueDate: validDate(xmlText(xml, "dhEvento")), authorizationDate: validDate(xmlText(xml, "dhRegEvento")),
      total: null, fullDocumentAvailable: true, classification: "unknown", cancelled: eventType === "110111" || (/proceventonfse/.test(schema) && /<(?:\w+:)?e101101\b/.test(xml)),
    };
  }
  if (/cte/.test(schema)) {
    const key = xml.match(/<(?:\w+:)?infCte\b[^>]*\bId=["']CTe(\d{44})["']/i)?.[1] || xmlText(xml, "chCTe");
    if (!validAccessKey(key) || !["57", "67"].includes(key.slice(20, 22))) throw new DfeDistributionError("Chave CT-e inválida.");
    const emit = xmlBlock(xml, "emit"), dest = xmlBlock(xml, "dest");
    return { nsu, schemaName, xml, payloadHash, documentType: "cte", accessKey: key, issuerDocument: documentFrom(emit), issuerName: optionalText(xmlText(emit, "xNome"), 200), recipientDocument: documentFrom(dest), number: optionalText(xmlText(xml, "nCT"), 20), series: optionalText(xmlText(xml, "serie"), 10), issueDate: validDate(xmlText(xml, "dhEmi")), authorizationDate: validDate(xmlText(xml, "dhRecbto")), total: finiteMoney(xmlText(xml, "vTPrest")), fullDocumentAvailable: /<(?:\w+:)?infCte\b/i.test(xml), classification: "freight", cancelled: false };
  }
  if (/nfse/.test(schema) || /<(?:\w+:)?infNFSe\b/i.test(xml)) return genericDocument(nsu, schemaName, xml, payloadHash, "nfse", "service");
  return genericDocument(nsu, schemaName, xml, payloadHash, "unknown", "unknown");
}

export async function syncBranchDfe(db: TenantDb, branchId: number, actorId: string, environment: Environment = "production", source: "sefaz_nfe" | "sefaz_cte" = "sefaz_nfe") {
  const correlationId = randomUUID(), now = new Date(), leaseToken = randomUUID();
  const processAfterSync: number[] = [];
  const branch = await db.branch.findFirst({ where: { id: branchId, status: "active" }, select: { id: true, name: true, document: true, state: true } });
  if (!branch || !validCnpj(branch.document.replace(/\D/g, ""))) throw new DfeDistributionError("A filial precisa ter um CNPJ válido para consultar a Distribuição DF-e.", "configuration");
  const stateCode = UF_CODES[(branch.state || "").toUpperCase()];
  if (!stateCode) throw new DfeDistributionError("Informe a UF da filial antes de sincronizar a SEFAZ.", "configuration");
  const cursor = await db.dfeSyncCursor.upsert({
    where: { branchId_source_environment: { branchId, source, environment } },
    update: {}, create: { branchId, source, environment, nextSyncAt: now },
  });
  if (!cursor.enabled) throw new DfeDistributionError("A sincronização automática está desativada para esta filial.", "configuration");
  if (cursor.nextSyncAt && cursor.nextSyncAt > now) throw new DfeDistributionError("Aguarde o próximo horário permitido para consultar a SEFAZ.", "configuration");
  const claimed = await db.dfeSyncCursor.updateMany({
    where: { id: cursor.id, enabled: true, AND: [{ OR: [{ nextSyncAt: null }, { nextSyncAt: { lte: now } }] }, { OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }] }] },
    data: { status: "syncing", leaseToken, leaseExpiresAt: new Date(now.getTime() + 60_000), lastSyncAt: now, lastError: null },
  });
  if (!claimed.count) throw new DfeDistributionError("Esta filial já está sendo sincronizada.", "configuration");
  try {
    const certificate = await db.fiscalCertificate.findFirst({
      where: { branchId, active: true, expiresAt: { gte: now } }, orderBy: { expiresAt: "desc" },
      select: { encryptedContent: true, encryptedPassword: true },
    });
    if (!certificate) {
      await releaseCursor(db, cursor.id, leaseToken, { status: "waiting_certificate", lastError: "Certificado A1 válido não configurado.", nextSyncAt: new Date(now.getTime() + 3_600_000) });
      throw new DfeDistributionError("Configure um certificado A1 válido para a filial antes de sincronizar.", "configuration");
    }
    const requestXml = distributionEnvelope(environment, stateCode, branch.document.replace(/\D/g, ""), cursor.lastNsu, source);
    const responseXml = await sendDistributionRequest((source === "sefaz_cte" ? CTE_ENDPOINTS : ENDPOINTS)[environment], requestXml, Buffer.from(decryptSecret(certificate.encryptedContent), "base64"), decryptSecret(certificate.encryptedPassword), source === "sefaz_cte" ? "http://www.portalfiscal.inf.br/cte/wsdl/CTeDistribuicaoDFe/cteDistDFeInteresse" : SOAP_ACTION);
    const result = parseDistributionResponse(responseXml);
    if (BigInt(result.lastNsu) < BigInt(cursor.lastNsu)) throw new DfeDistributionError("A SEFAZ devolveu um cursor NSU anterior ao já persistido.");
    await db.$transaction(async (tx) => {
      for (const document of result.documents) {
        if (source === "sefaz_cte" && document.documentType === "cte" && !containsPartyDocument(document.xml, branch.document.replace(/\D/g, ""))) throw new DfeDistributionError("CT-e não identifica a filial consultada.");
        if (document.documentType === "nfe" && document.recipientDocument && document.recipientDocument !== branch.document.replace(/\D/g, "")) {
          throw new DfeDistributionError(`O documento NSU ${document.nsu} não pertence ao CNPJ da filial consultada.`);
        }
        if (document.documentType === "event") {
          const key = digits(xmlText(document.xml, source === "sefaz_cte" ? "chCTe" : "chNFe"), 44);
          const referenced = key ? await tx.inboundFiscalDocument.findUnique({ where: { source_accessKey: { source, accessKey: key, environment } } }) : null;
          if (referenced && referenced.branchId === branch.id) {
            if (document.cancelled) await tx.inboundFiscalDocument.update({ where: { id: referenced.id }, data: { status: "cancelled" } });
            await tx.inboundFiscalDocumentEvent.create({ data: { documentId: referenced.id, type: document.cancelled ? "dfe.document.cancelled" : "dfe.document.fiscal_event", actorId, correlationId, metadata: { nsu: document.nsu, payloadHash: document.payloadHash } } });
          }
        }
        const existing = document.accessKey ? await tx.inboundFiscalDocument.findUnique({ where: { source_accessKey: { source, accessKey: document.accessKey, environment } } }) : null;
        if (environment === "production") await ensureDistributedIssuer(tx, document, branch.document);
        const data = inboundData(document, branch.id, branch.document.replace(/\D/g, ""), source, environment);
        if (document.documentType === "nfe" && document.accessKey) {
          const registeredScience = await tx.tenantAuditEvent.findFirst({
            where: { action: "dfe.manifestation.science.registered", entityType: "nfe_access_key", entityId: document.accessKey },
            select: { id: true },
          });
          if (registeredScience) data.manifestationStatus = "science";
        }
        if (existing) preserveFiscalDocument(existing, data);
        const saved = existing
          ? await tx.inboundFiscalDocument.update({ where: { id: existing.id }, data: { ...data, nsu: undefined } })
          : await tx.inboundFiscalDocument.upsert({ where: { source_branchId_nsu: { source, branchId: branch.id, nsu: document.nsu, environment } }, update: data, create: data });
        await tx.inboundFiscalDocumentEvent.create({ data: {
          documentId: saved.id, type: existing ? "dfe.document.updated" : "dfe.document.detected", actorId, correlationId,
          metadata: { nsu: document.nsu, schema: document.schemaName, fullDocumentAvailable: document.fullDocumentAvailable, payloadHash: document.payloadHash },
        } });
        if (document.documentType === "nfe" && document.fullDocumentAvailable && !document.cancelled && !saved.purchaseInvoiceId && !["ignored", "received"].includes(saved.status)) processAfterSync.push(saved.id);
      }
      const released = await tx.dfeSyncCursor.updateMany({ where: { id: cursor.id, leaseToken }, data: {
        lastNsu: result.lastNsu, maxNsu: result.maxNsu, status: "idle", consecutiveFailures: 0,
        lastSuccessAt: new Date(), nextSyncAt: new Date(Date.now() + (result.statusCode === "137" || result.lastNsu === result.maxNsu ? 60 * 60_000 : 60_000)),
        leaseToken: null, leaseExpiresAt: null, lastError: null,
      } });
      if (!released.count) throw new DfeDistributionError("A posse da sincronização expirou antes da persistência.");
      await tx.tenantAuditEvent.create({ data: { actorId, action: "dfe.sync.completed", entityType: "dfe_sync_cursor", entityId: String(cursor.id), correlationId, afterData: { branchId, statusCode: result.statusCode, documents: result.documents.length, lastNsu: result.lastNsu, maxNsu: result.maxNsu } } });
    }, { isolationLevel: "Serializable", maxWait: 5_000, timeout: 30_000 });
    const automation = { prepared: 0, received: 0, reviewRequired: 0 };
    if (source === "sefaz_nfe" && environment === "production" && cursor.processingMode !== "review") for (const documentId of [...new Set(processAfterSync)]) {
      try {
        const prepared = await prepareInboundInvoice(db, documentId, { id: actorId, name: actorId === "system:dfe-sync" ? "Automação fiscal" : actorId }, correlationId);
        automation.prepared++;
        if (cursor.processingMode === "auto_receive" && cursor.defaultWarehouseId) {
          const eligibility = await autoReceiveEligibility(db, prepared.invoice.id, cursor.defaultWarehouseId);
          if (eligibility.eligible) {
            const invoice = await db.purchaseInvoice.findUniqueOrThrow({ where: { id: prepared.invoice.id }, select: { issueDate: true } });
            const base = invoice.issueDate.getTime() > Date.now() ? invoice.issueDate : new Date(), dueAt = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + cursor.defaultDueDays, 12));
            await receivePurchaseInvoiceRecord(db, prepared.invoice.id, { warehouseId: cursor.defaultWarehouseId, dueAt }, { id: "system:dfe-sync", name: "Automação fiscal" }, correlationId);
            automation.received++;
          } else {
            automation.reviewRequired++;
            await db.inboundFiscalDocumentEvent.create({ data: { documentId, type: "dfe.automation.review_required", actorId: "system:dfe-sync", correlationId, metadata: { reason: eligibility.reason, purchaseInvoiceId: prepared.invoice.id } } });
          }
        }
      } catch (automationError) {
        automation.reviewRequired++;
        await db.inboundFiscalDocumentEvent.create({ data: { documentId, type: "dfe.automation.review_required", actorId: "system:dfe-sync", correlationId, metadata: { reason: safeError(automationError) } } }).catch(() => undefined);
      }
    }
    return { correlationId, branch: { id: branch.id, name: branch.name }, documents: result.documents.length, automation, statusCode: result.statusCode, reason: result.reason, lastNsu: result.lastNsu, maxNsu: result.maxNsu };
  } catch (error) {
    if (!(error instanceof DfeDistributionError && error.kind === "configuration")) {
      const failures = cursor.consecutiveFailures + 1;
      const rateLimited = error instanceof DfeDistributionError && error.kind === "rate_limit";
      await releaseCursor(db, cursor.id, leaseToken, { status: rateLimited ? "rate_limited" : "error", consecutiveFailures: failures, lastError: safeError(error), nextSyncAt: new Date(Date.now() + (rateLimited ? 60 : Math.min(60, 2 ** failures)) * 60_000) });
    }
    throw error;
  }
}

export async function syncBranchNfseAdn(db: TenantDb, branchId: number, actorId: string, environment: Environment = "production") {
  const correlationId = randomUUID(), now = new Date(), leaseToken = randomUUID();
  const branch = await db.branch.findFirst({ where: { id: branchId, status: "active" }, select: { id: true, name: true, document: true } });
  const document = branch?.document.replace(/\D/g, "") || "";
  if (!branch || !validCnpj(document)) throw new DfeDistributionError("A filial precisa ter um CNPJ válido para consultar o ADN NFS-e.", "configuration");
  const cursor = await db.dfeSyncCursor.upsert({ where: { branchId_source_environment: { branchId, source: "nfse_adn", environment } }, update: {}, create: { branchId, source: "nfse_adn", environment, nextSyncAt: now } });
  if (!cursor.enabled) throw new DfeDistributionError("A captura do ADN NFS-e está desativada para esta filial.", "configuration");
  if (cursor.nextSyncAt && cursor.nextSyncAt > now) throw new DfeDistributionError("Aguarde o próximo horário permitido para consultar o ADN.", "configuration");
  const claimed = await db.dfeSyncCursor.updateMany({ where: { id: cursor.id, enabled: true, AND: [{ OR: [{ nextSyncAt: null }, { nextSyncAt: { lte: now } }] }, { OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }] }] }, data: { status: "syncing", leaseToken, leaseExpiresAt: new Date(now.getTime() + 60_000), lastSyncAt: now, lastError: null } });
  if (!claimed.count) throw new DfeDistributionError("Esta fonte NFS-e já está sendo sincronizada.", "configuration");
  try {
    const certificate = await db.fiscalCertificate.findFirst({ where: { branchId, active: true, expiresAt: { gte: now } }, orderBy: { expiresAt: "desc" }, select: { encryptedContent: true, encryptedPassword: true } });
    if (!certificate) {
      await releaseCursor(db, cursor.id, leaseToken, { status: "waiting_certificate", lastError: "Certificado A1 válido não configurado.", nextSyncAt: new Date(now.getTime() + 3_600_000) });
      throw new DfeDistributionError("Configure um certificado A1 válido para consultar o ADN NFS-e.", "configuration");
    }
    const endpoint = `${NFSE_ENDPOINTS[environment]}/DFe/${BigInt(cursor.lastNsu).toString()}?cnpjConsulta=${document}&lote=true`;
    const remote = await sendNfseRequest(endpoint, Buffer.from(decryptSecret(certificate.encryptedContent), "base64"), decryptSecret(certificate.encryptedPassword));
    const result = remote.status === 204
      ? { statusCode: "137", reason: "Nenhum documento localizado", lastNsu: cursor.lastNsu, maxNsu: cursor.maxNsu, documents: [] }
      : parseNfseDistributionResponse(remote.body, cursor.lastNsu);
    if (BigInt(result.lastNsu) < BigInt(cursor.lastNsu)) throw new DfeDistributionError("O ADN NFS-e devolveu um cursor anterior ao persistido.");
    await db.$transaction(async (tx) => {
      for (const fiscal of result.documents) {
        if (fiscal.documentType === "event") {
          const referencedKey = digits(xmlText(fiscal.xml, "chNFSe"), 50);
          const referenced = referencedKey ? await tx.inboundFiscalDocument.findUnique({ where: { source_accessKey: { source: "nfse_adn", accessKey: referencedKey, environment } } }) : null;
          if (!referenced || referenced.branchId !== branch.id) throw new DfeDistributionError(`Evento NFS-e NSU ${fiscal.nsu} sem nota vinculada nesta filial; cursor preservado para revisão.`);
          if (fiscal.cancelled) await tx.inboundFiscalDocument.update({ where: { id: referenced.id }, data: { status: "cancelled" } });
          await tx.inboundFiscalDocumentEvent.create({ data: { documentId: referenced.id, type: fiscal.cancelled ? "dfe.document.cancelled" : "dfe.document.fiscal_event", actorId, correlationId, metadata: { nsu: fiscal.nsu, payloadHash: fiscal.payloadHash, source: "nfse_adn" } } });
        } else if (!containsPartyDocument(fiscal.xml, document)) throw new DfeDistributionError(`O documento NFS-e NSU ${fiscal.nsu} não identifica o CNPJ da filial consultada.`);
        const existing = fiscal.accessKey ? await tx.inboundFiscalDocument.findUnique({ where: { source_accessKey: { source: "nfse_adn", accessKey: fiscal.accessKey, environment } } }) : null;
        if (environment === "production") await ensureDistributedIssuer(tx, fiscal, document);
        const data = inboundData(fiscal, branch.id, document, "nfse_adn", environment);
        if (existing) preserveFiscalDocument(existing, data);
        const saved = existing
          ? await tx.inboundFiscalDocument.update({ where: { id: existing.id }, data: { ...data, nsu: undefined } })
          : await tx.inboundFiscalDocument.upsert({ where: { source_branchId_nsu: { source: "nfse_adn", branchId: branch.id, nsu: fiscal.nsu, environment } }, update: data, create: data });
        await tx.inboundFiscalDocumentEvent.create({ data: { documentId: saved.id, type: existing ? "dfe.document.updated" : "dfe.document.detected", actorId, correlationId, metadata: { nsu: fiscal.nsu, schema: fiscal.schemaName, source: "nfse_adn", payloadHash: fiscal.payloadHash } } });
      }
      const released = await tx.dfeSyncCursor.updateMany({ where: { id: cursor.id, leaseToken }, data: { lastNsu: result.lastNsu, maxNsu: result.maxNsu, status: "idle", consecutiveFailures: 0, lastSuccessAt: new Date(), nextSyncAt: new Date(Date.now() + (result.documents.length === 50 ? 60_000 : 60 * 60_000)), leaseToken: null, leaseExpiresAt: null, lastError: null } });
      if (!released.count) throw new DfeDistributionError("A posse da sincronização NFS-e expirou.");
      await tx.tenantAuditEvent.create({ data: { actorId, action: "nfse_adn.sync.completed", entityType: "dfe_sync_cursor", entityId: String(cursor.id), correlationId, afterData: { branchId, documents: result.documents.length, lastNsu: result.lastNsu, maxNsu: result.maxNsu } } });
    }, { isolationLevel: "Serializable", maxWait: 5_000, timeout: 30_000 });
    return { correlationId, branch: { id: branch.id, name: branch.name }, documents: result.documents.length, automation: { prepared: 0, received: 0, reviewRequired: result.documents.length }, statusCode: result.statusCode, reason: result.reason, lastNsu: result.lastNsu, maxNsu: result.maxNsu };
  } catch (error) {
    if (!(error instanceof DfeDistributionError && error.kind === "configuration")) {
      const failures = cursor.consecutiveFailures + 1, rateLimited = error instanceof DfeDistributionError && error.kind === "rate_limit";
      await releaseCursor(db, cursor.id, leaseToken, { status: rateLimited ? "rate_limited" : "error", consecutiveFailures: failures, lastError: safeError(error), nextSyncAt: new Date(Date.now() + (rateLimited ? 60 : Math.min(60, 2 ** failures)) * 60_000) });
    }
    throw error;
  }
}

export function syncBranchFiscalSource(db: TenantDb, branchId: number, source: "sefaz_nfe" | "nfse_adn" | "sefaz_cte", actorId: string, environment: Environment = "production") {
  return source === "nfse_adn" ? syncBranchNfseAdn(db, branchId, actorId, environment) : syncBranchDfe(db, branchId, actorId, environment, source);
}

export function parseNfseEvents(body: string, accessKey: string) {
  if (!/^\d{50}$/.test(accessKey) || Buffer.byteLength(body) > MAX_SOAP_BYTES) throw new DfeDistributionError("Consulta de eventos inválida.");
  let root: Record<string, unknown>;
  try { root = JSON.parse(body); } catch { throw new DfeDistributionError("JSON de eventos inválido."); }
  if (!root || typeof root !== "object" || Array.isArray(root) || !["DOCUMENTOS_LOCALIZADOS", "NENHUM_DOCUMENTO_LOCALIZADO"].includes(String(root.StatusProcessamento)) || adnHasErrors(root)) throw new DfeDistributionError("ADN não confirmou a consulta de eventos.");
  const rows = root.LoteDFe ?? [];
  if (!Array.isArray(rows) || rows.length > 100 || (rows.length > 0) !== (root.StatusProcessamento === "DOCUMENTOS_LOCALIZADOS")) throw new DfeDistributionError("Lote de eventos inconsistente.");
  return rows.flatMap(row => {
    if (!row || !["EVENTO", "NFSE"].includes(row.TipoDocumento) || typeof row.ArquivoXml !== "string") throw new DfeDistributionError("Documento retornado não é evento fiscal.");
    const xml = decodeFiscalContent(row.ArquivoXml);
    // The live ADN endpoint includes the original NFSe, even when it has no events.
    // Validate its identity, but never classify the note itself as an event.
    if (row.TipoDocumento === "NFSE") {
      const note = inspectDistributedDocument("000000000000000", "nfse_v1.01.xsd", xml);
      if (note.accessKey !== accessKey || (row.ChaveAcesso != null && row.ChaveAcesso !== accessKey)) throw new DfeDistributionError("Documento pertence a outra NFS-e.");
      return [];
    }
    const event = inspectDistributedDocument("000000000000000", "proceventonfse_v1.00.xsd", xml);
    if (xmlText(xml, "chNFSe") !== accessKey || (row.ChaveAcesso != null && row.ChaveAcesso !== accessKey)) throw new DfeDistributionError("Evento pertence a outra NFS-e.");
    return [event];
  });
}

export async function refreshNfseEvents(db: TenantDb, documentId: number, actorId: string) {
  const document = await db.inboundFiscalDocument.findUnique({ where: { id: documentId }, include: { branch: true } });
  if (!document || document.source !== "nfse_adn" || document.documentType !== "nfse" || !document.accessKey) throw new DfeDistributionError("Selecione uma NFS-e capturada do ADN.", "configuration");
  if (!["production", "homologation"].includes(document.environment)) throw new DfeDistributionError("Ambiente fiscal legado não identificado; revise antes de consultar.", "configuration");
  const certificate = await db.fiscalCertificate.findFirst({ where: { branchId: document.branchId, active: true, expiresAt: { gt: new Date() } }, orderBy: { expiresAt: "desc" } });
  if (!certificate) throw new DfeDistributionError("Certificado A1 válido não encontrado.", "configuration");
  const correlationId = randomUUID();
  await db.$transaction(async tx => {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM inbound_fiscal_documents WHERE id = ${documentId} FOR UPDATE`);
    if (await tx.inboundFiscalDocumentEvent.findFirst({ where: { documentId, type: "nfse.events.requested", createdAt: { gt: new Date(Date.now() - 5 * 60_000) } } })) throw new DfeDistributionError("Aguarde cinco minutos entre consultas dos eventos desta nota.", "configuration");
    await tx.inboundFiscalDocumentEvent.create({ data: { documentId, type: "nfse.events.requested", actorId, correlationId } });
  });
  const endpoint = `${NFSE_ENDPOINTS[document.environment as Environment]}/NFSe/${document.accessKey}/Eventos`;
  const remote = await sendNfseRequest(endpoint, Buffer.from(decryptSecret(certificate.encryptedContent), "base64"), decryptSecret(certificate.encryptedPassword));
  const events = parseNfseEvents(remote.body, document.accessKey);
  const imported = await db.$transaction(async tx => {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM inbound_fiscal_documents WHERE id = ${documentId} FOR UPDATE`);
    let count = 0;
    for (const event of events) {
      const prior = await tx.inboundFiscalDocumentEvent.findFirst({ where: { documentId, metadata: { path: ["payloadHash"], equals: event.payloadHash } } });
      if (prior) continue;
      if (event.cancelled) await tx.inboundFiscalDocument.update({ where: { id: documentId }, data: { status: "cancelled" } });
      await tx.inboundFiscalDocumentEvent.create({ data: { documentId, type: event.cancelled ? "dfe.document.cancelled" : "dfe.document.fiscal_event", actorId, correlationId, metadata: { payloadHash: event.payloadHash, encryptedXml: encryptSecret(event.xml), source: "nfse_events_by_key" } } });
      count++;
    }
    await tx.inboundFiscalDocumentEvent.create({ data: { documentId, type: "nfse.events.refreshed", actorId, correlationId, metadata: { events: events.length, imported: count } } });
    return count;
  }, { isolationLevel: "Serializable" });
  return { documents: events.length, imported, correlationId };
}

export async function syncDueDfeSources(limit = 20) {
  const where = { status: { in: ["active", "trial"] }, database: { status: "active" } };
  const totalOrganizations = await controlDb.organization.count({ where });
  const take = Math.max(1, Math.min(limit, totalOrganizations || 1)), skip = totalOrganizations > take ? Math.floor(Date.now() / 60_000) % totalOrganizations : 0;
  const first = await controlDb.organization.findMany({ where, select: { id: true }, orderBy: { id: "asc" }, skip, take });
  const organizations = first.length < take ? [...first, ...await controlDb.organization.findMany({ where, select: { id: true }, orderBy: { id: "asc" }, take: take - first.length })] : first;
  const summary = { organizations: organizations.length, sources: 0, documents: 0, automaticScience: 0, failed: 0 };
  for (const organization of organizations) {
    let db: TenantDb;
    try { db = await tenantDb(organization.id); } catch { summary.failed++; continue; }
    const sources = await db.dfeSyncCursor.findMany({ where: { source: { in: ["sefaz_nfe", "nfse_adn", "sefaz_cte"] }, enabled: true, AND: [{ OR: [{ nextSyncAt: null }, { nextSyncAt: { lte: new Date() } }] }, { OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: new Date() } }] }] }, select: { branchId: true, source: true, environment: true }, take: 10 });
    for (const source of sources) {
      summary.sources++;
      try { const result = await syncBranchFiscalSource(db, source.branchId, source.source as "sefaz_nfe" | "nfse_adn" | "sefaz_cte", "system:dfe-sync", source.environment as Environment); summary.documents += result.documents; }
      catch { summary.failed++; }
    }
    try {
      const manifestation = await recoverAutomaticNfeScience(db);
      summary.automaticScience += manifestation.registered + manifestation.alreadyRegistered;
      summary.failed += manifestation.failed;
    } catch { summary.failed++; }
    try { await recoverDfePreparation(db); } catch { summary.failed++; }
  }
  return summary;
}

// Capturing a cursor and preparing commercial entries cannot be one transaction.
// Revisit persisted XMLs so a crash after capture does not strand them forever.
export async function recoverDfePreparation(db: TenantDb) {
  const policies = await db.dfeSyncCursor.findMany({ where: { source: "sefaz_nfe", environment: "production", enabled: true, processingMode: { in: ["auto_prepare", "auto_receive"] } }, take: 10 });
  const result = { prepared: 0, received: 0, failed: 0 };
  for (const policy of policies) {
    const documents = await db.inboundFiscalDocument.findMany({ where: {
      branchId: policy.branchId, source: "sefaz_nfe", environment: "production", documentType: "nfe", classification: "goods", fullDocumentAvailable: true,
      status: { in: policy.processingMode === "auto_receive" ? ["ready", "error", "reconciled"] : ["ready", "error"] },
      ...(policy.processingMode === "auto_prepare" ? { purchaseInvoiceId: null } : {}),
      OR: [{ reviewedAt: null }, { reviewedAt: { lt: new Date(Date.now() - 15 * 60_000) } }],
    }, select: { id: true }, orderBy: [{ reviewedAt: { sort: "asc", nulls: "first" } }, { id: "asc" }], take: 10 });
    for (const document of documents) {
      const correlationId = randomUUID();
      try {
        const prepared = await prepareInboundInvoice(db, document.id, { id: "system:dfe-sync", name: "Automação fiscal" }, correlationId);
        result.prepared++;
        if (policy.processingMode === "auto_receive" && policy.defaultWarehouseId) {
          const eligible = await autoReceiveEligibility(db, prepared.invoice.id, policy.defaultWarehouseId);
          if (eligible.eligible) {
            const dueAt = new Date(Date.now() + policy.defaultDueDays * 86400000);
            await receivePurchaseInvoiceRecord(db, prepared.invoice.id, { warehouseId: policy.defaultWarehouseId, dueAt }, { id: "system:dfe-sync", name: "Automação fiscal" }, correlationId);
            result.received++;
          }
        }
        await db.inboundFiscalDocument.updateMany({ where: { id: document.id, status: { notIn: ["cancelled", "ignored", "received"] } }, data: { reviewedAt: new Date() } });
      } catch {
        result.failed++;
        const attempts = await db.inboundFiscalDocumentEvent.count({ where: { documentId: document.id, type: "dfe.automation.review_required", metadata: { path: ["recovery"], equals: true } } });
        await db.inboundFiscalDocument.updateMany({ where: { id: document.id, status: { in: ["ready", "error", "reconciled"] } }, data: { status: attempts >= 4 ? "in_review" : "error", reviewedAt: new Date() } });
        await db.inboundFiscalDocumentEvent.create({ data: { documentId: document.id, type: "dfe.automation.review_required", actorId: "system:dfe-sync", correlationId, metadata: { recovery: true, attempt: attempts + 1, reason: attempts >= 4 ? "Limite de cinco tentativas atingido; exige conferência humana." : "Preparação não concluída; nova tentativa após 15 minutos." } } });
      }
    }
  }
  return result;
}

function inboundData(document: DistributedDocument, branchId: number, recipientDocument: string, source = "sefaz_nfe", environment: Environment = "production"): Prisma.InboundFiscalDocumentUncheckedCreateInput {
  const issuedAt = document.issueDate || document.authorizationDate;
  const deadline = issuedAt ? new Date(Date.UTC(issuedAt.getUTCFullYear(), issuedAt.getUTCMonth(), issuedAt.getUTCDate() + 90, 12)) : null;
  return {
    source, environment, documentType: document.documentType, schemaName: document.schemaName, nsu: document.nsu,
    accessKey: document.accessKey, branchId, recipientDocument: source !== "sefaz_nfe" ? document.recipientDocument || "" : recipientDocument, issuerDocument: document.issuerDocument,
    issuerName: document.issuerName, number: document.number, series: document.series, issueDate: document.issueDate,
    authorizationDate: document.authorizationDate, total: document.total, classification: document.classification,
    status: document.cancelled ? "cancelled" : document.fullDocumentAvailable ? "ready" : "awaiting_document",
    manifestationStatus: document.documentType === "nfe" ? "pending" : "not_required", manifestationDeadline: deadline,
    fullDocumentAvailable: document.fullDocumentAvailable, encryptedXml: document.fullDocumentAvailable ? encryptSecret(document.xml) : null,
    payloadHash: document.payloadHash,
  };
}

function preserveFiscalDocument(existing: { status: string; manifestationStatus: string; fullDocumentAvailable: boolean; encryptedXml: string | null; payloadHash: string; schemaName: string }, incoming: Prisma.InboundFiscalDocumentUncheckedCreateInput) {
  if (existing.status === "cancelled" || incoming.status === "cancelled") incoming.status = "cancelled";
  else if (["ignored", "received", "reconciled", "in_review"].includes(existing.status)) incoming.status = existing.status;
  if (existing.manifestationStatus !== "pending") incoming.manifestationStatus = existing.manifestationStatus;
  if (existing.fullDocumentAvailable && !incoming.fullDocumentAvailable) {
    incoming.fullDocumentAvailable = true;
    incoming.encryptedXml = existing.encryptedXml;
    incoming.payloadHash = existing.payloadHash;
    incoming.schemaName = existing.schemaName;
  }
}

async function releaseCursor(db: TenantDb, cursorId: number, leaseToken: string, data: Prisma.DfeSyncCursorUpdateManyMutationInput) {
  await db.dfeSyncCursor.updateMany({ where: { id: cursorId, leaseToken }, data: { ...data, leaseToken: null, leaseExpiresAt: null } });
}

export function distributionEnvelope(environment: Environment, stateCode: string, document: string, lastNsu: string, source: "sefaz_nfe" | "sefaz_cte" = "sefaz_nfe") {
  const tpAmb = environment === "production" ? "1" : "2";
  if (source === "sefaz_cte") return `<?xml version="1.0" encoding="utf-8"?><soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body><cteDistDFeInteresse xmlns="http://www.portalfiscal.inf.br/cte/wsdl/CTeDistribuicaoDFe"><cteDadosMsg><distDFeInt versao="1.00" xmlns="http://www.portalfiscal.inf.br/cte"><tpAmb>${tpAmb}</tpAmb><cUFAutor>${stateCode}</cUFAutor><CNPJ>${document}</CNPJ><distNSU><ultNSU>${normalizeNsu(lastNsu)}</ultNSU></distNSU></distDFeInt></cteDadosMsg></cteDistDFeInteresse></soap12:Body></soap12:Envelope>`;
  return `<?xml version="1.0" encoding="utf-8"?><soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body><nfeDistDFeInteresse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe"><nfeDadosMsg><distDFeInt versao="1.01" xmlns="http://www.portalfiscal.inf.br/nfe"><tpAmb>${tpAmb}</tpAmb><cUFAutor>${stateCode}</cUFAutor><CNPJ>${document}</CNPJ><distNSU><ultNSU>${normalizeNsu(lastNsu)}</ultNSU></distNSU></distDFeInt></nfeDadosMsg></nfeDistDFeInteresse></soap12:Body></soap12:Envelope>`;
}

function sendDistributionRequest(endpoint: string, body: string, pfx: Buffer, passphrase: string, soapAction = SOAP_ACTION) {
  return new Promise<string>((resolve, reject) => {
    const url = new URL(endpoint);
    const request = httpsRequest({
      protocol: url.protocol, hostname: url.hostname, port: url.port || 443, path: url.pathname, method: "POST",
      pfx, passphrase, minVersion: "TLSv1.2", rejectUnauthorized: true,
      headers: { "content-type": `application/soap+xml; charset=utf-8; action="${soapAction}"`, accept: "application/soap+xml", "content-length": Buffer.byteLength(body) },
      timeout: 30_000,
    }, (response) => {
      response.on("error", reject);
      response.on("aborted", () => reject(new DfeDistributionError("Resposta fiscal interrompida.", "transport")));
      const chunks: Buffer[] = []; let length = 0;
      response.on("data", (chunk: Buffer) => { length += chunk.length; if (length > MAX_SOAP_BYTES) response.destroy(new Error("Resposta acima do limite")); else chunks.push(chunk); });
      response.on("end", () => {
        const result = Buffer.concat(chunks).toString("utf8");
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) reject(new DfeDistributionError(`A SEFAZ respondeu HTTP ${response.statusCode || 0}.`, "transport"));
        else resolve(result);
      });
    });
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", () => reject(new DfeDistributionError("Não foi possível estabelecer conexão mTLS com a SEFAZ.", "transport")));
    request.end(body);
  });
}

function sendNfseRequest(endpoint: string, pfx: Buffer, passphrase: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const url = new URL(endpoint);
    const request = httpsRequest({ protocol: url.protocol, hostname: url.hostname, port: url.port || 443, path: `${url.pathname}${url.search}`, method: "GET", pfx, passphrase, minVersion: "TLSv1.2", rejectUnauthorized: true, headers: { accept: "application/json" }, timeout: 30_000 }, (response) => {
      response.on("error", reject);
      response.on("aborted", () => reject(new DfeDistributionError("Resposta ADN interrompida.", "transport")));
      const chunks: Buffer[] = []; let length = 0;
      response.on("data", (chunk: Buffer) => { length += chunk.length; if (length > MAX_SOAP_BYTES) response.destroy(new Error("Resposta acima do limite")); else chunks.push(chunk); });
      response.on("end", () => {
        const status = response.statusCode || 0, body = Buffer.concat(chunks).toString("utf8");
        if (![200, 204, 404].includes(status)) reject(new DfeDistributionError(status === 429 ? "O ADN NFS-e limitou temporariamente as consultas." : `O ADN NFS-e respondeu HTTP ${status}.`, status === 429 ? "rate_limit" : "transport"));
        else resolve({ status, body });
      });
    });
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", () => reject(new DfeDistributionError("Não foi possível estabelecer conexão mTLS com o ADN NFS-e.", "transport")));
    request.end();
  });
}

function genericDocument(nsu: string, schemaName: string, xml: string, payloadHash: string, documentType: DistributedDocument["documentType"], classification: DistributedDocument["classification"]): DistributedDocument {
  const nfseKey = documentType === "nfse" ? xml.match(/<(?:\w+:)?infNFSe\b[^>]*\bId=["']NFS(\d{50})["']/i)?.[1] || "" : "";
  const issuerBlock = documentType === "nfse" ? xmlBlock(xml, "emit") || xmlBlock(xml, "prest") : xml, recipientBlock = documentType === "nfse" ? xmlBlock(xml, "toma") : "";
  return { nsu, schemaName, xml, payloadHash, documentType, classification, accessKey: digits(nfseKey || xmlText(xml, documentType === "cte" ? "chCTe" : "chNFSe"), documentType === "nfse" ? 50 : 44), issuerDocument: documentFrom(issuerBlock), issuerName: optionalText(xmlText(issuerBlock, "xNome") || xmlText(issuerBlock, "xNomePrestador"), 200), recipientDocument: recipientBlock ? documentFrom(recipientBlock) : null, number: optionalText(xmlText(xml, documentType === "nfse" ? "nNFSe" : "nNF"), 20), series: optionalText(xmlText(xml, "serie"), 10), issueDate: validDate(xmlText(xml, documentType === "nfse" ? "dhProc" : "dhEmi")), authorizationDate: validDate(xmlText(xml, "dhRecbto")), total: finiteMoney(xmlText(xml, documentType === "nfse" ? "vLiq" : "vNF")), fullDocumentAvailable: true, cancelled: false };
}

function normalizeNsu(value: string) { const clean = value.trim(); if (!/^\d{1,15}$/.test(clean)) throw new DfeDistributionError("A resposta contém NSU inválido."); return clean.padStart(15, "0"); }
function boundedSchema(value: string) { const clean = value.trim(); if (!/^[A-Za-z0-9_.-]{3,100}$/.test(clean)) throw new DfeDistributionError("A resposta contém schema inválido."); return clean; }
function xmlText(source: string, name: string) { return decodeXml(source.match(new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${name}>`, "i"))?.[1]?.trim() || ""); }
function xmlBlock(source: string, name: string) { return source.match(new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>[\\s\\S]*?<\\/(?:\\w+:)?${name}>`, "i"))?.[0] || ""; }
function xmlAttribute(source: string, name: string) { return decodeXml(source.match(new RegExp(`\\b${name}=["']([^"']+)["']`, "i"))?.[1]?.trim() || ""); }
function decodeXml(value: string) { return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;/g, "'"); }
function documentFrom(xml: string) { return digits(xmlText(xml, "CNPJ"), 14) || digits(xmlText(xml, "CPF"), 11); }
function digits(value: string, length: number) { const clean = value.replace(/\D/g, ""); return clean.length === length ? clean : null; }
function optionalText(value: string, maximum: number) { const clean = value.trim(); return clean && clean.length <= maximum ? clean : null; }
function validDate(value: string) { if (!value) return null; const date = new Date(value); return Number.isNaN(date.getTime()) ? null : date; }
function finiteMoney(value: string) { if (!value.trim()) return null; const number = Number(value.replace(",", ".")); return Number.isFinite(number) && number >= 0 && number <= 1_000_000_000_000 ? number : null; }
function safeReason(value: string) { return value.replace(/[\r\n\t]+/g, " ").slice(0, 255); }
function safeError(error: unknown) { return (error instanceof Error ? error.message : "Falha desconhecida na sincronização").replace(/[\r\n\t]+/g, " ").slice(0, 500); }
function firstValue(source: Record<string, unknown>, keys: string[]) { for (const key of keys) if (source[key] != null) return source[key]; return null; }
function firstArray(source: Record<string, unknown>, keys: string[]) { const value = firstValue(source, keys); return Array.isArray(value) ? value : []; }
function hasFiscalContent(source: Record<string, unknown>) { return typeof firstValue(source, ["xml", "XML", "documento", "Documento", "dfe", "DFe", "arquivo", "Arquivo", "conteudo", "Conteudo"]) === "string"; }
function containsPartyDocument(xml: string, document: string) { return new RegExp(`<(?:\\w+:)?(?:CNPJ|CPF)\\b[^>]*>\\s*${document}\\s*<\\/(?:\\w+:)?(?:CNPJ|CPF)>`, "i").test(xml); }
function validateCursorRange(lastNsu: string, maxNsu: string, documents: DistributedDocument[], source: string) {
  if (BigInt(lastNsu) > BigInt(maxNsu)) throw new DfeDistributionError(`${source} devolveu último NSU acima do maior NSU.`);
  if (documents.length > 50 || documents.some((document) => BigInt(document.nsu) > BigInt(lastNsu) || BigInt(document.nsu) > BigInt(maxNsu))) throw new DfeDistributionError(`${source} devolveu documentos fora da janela NSU permitida.`);
}
function decodeFiscalContent(value: string) {
  const clean = value.trim();
  if (clean.startsWith("<")) return clean;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean) || clean.length > 20_000_000) throw new DfeDistributionError("Conteúdo fiscal do ADN possui codificação inválida.");
  const decoded = Buffer.from(clean, "base64");
  if (decoded[0] === 0x1f && decoded[1] === 0x8b) {
    try { return gunzipSync(decoded, { maxOutputLength: MAX_DOCUMENT_BYTES }).toString("utf8"); }
    catch { throw new DfeDistributionError("Conteúdo fiscal do ADN não pôde ser descompactado."); }
  }
  if (decoded.length > MAX_DOCUMENT_BYTES) throw new DfeDistributionError("Conteúdo fiscal do ADN acima do limite.");
  return decoded.toString("utf8");
}
