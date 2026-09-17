import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { matchItems, parseNfeXml, receiveInvoiceInput, validAccessKey, validCnpj } from "@/lib/erp/nfe-input";

process.env.CONTROL_DATABASE_URL ||= "postgresql://test:test@127.0.0.1:5432/nalven_test";
const { parseDistributionResponse, parseNfseDistributionResponse, parseNfseEvents, inspectDistributedDocument, distributionEnvelope } = await import("@/lib/erp/dfe-distribution");
const { assertFiscalEntryAllowed, assertFiscalReclassificationAllowed, fiscalDirection } = await import("@/lib/erp/fiscal-import-policy");

const route = readFileSync("app/api/erp/invoices/route.ts", "utf8");
const workspace = readFileSync("components/erp/nfe-input-workspace.tsx", "utf8");
const client = readFileSync("app/erp/erp-client.tsx", "utf8");
const css = readFileSync("components/erp/nfe-input-workspace.module.css", "utf8");
const inbox = readFileSync("components/erp/dfe-inbox.tsx", "utf8");
const inboxCss = readFileSync("components/erp/dfe-inbox.module.css", "utf8");
const dfeRoute = readFileSync("app/api/erp/invoices/dfe/route.ts", "utf8");
const internalSync = readFileSync("app/api/internal/dfe/sync/route.ts", "utf8");
const receiving = readFileSync("lib/erp/purchase-invoice-receiving.ts", "utf8");
const inboundFiscal = readFileSync("lib/erp/inbound-fiscal.ts", "utf8");
const manifestationService = readFileSync("lib/erp/nfe-manifestation-service.ts", "utf8");
const schema = readFileSync("prisma/tenant/schema.prisma", "utf8");
const migration = readFileSync("prisma/tenant/migrations/20260902021000_dfe_inbound_conference/migration.sql", "utf8");
const automaticScienceMigration = readFileSync("prisma/tenant/migrations/20260915140000_dfe_automatic_science_policy/migration.sql", "utf8");
const tenantSeed = readFileSync("prisma/tenant/seed.ts", "utf8");
const demoFiscalSeed = readFileSync("scripts/seed-demo-inbound-fiscal.ts", "utf8");
const deploy = readFileSync("deploy/deploy-release.sh", "utf8");
const timer = readFileSync("deploy/nalven-dfe-sync.timer", "utf8");

test("parser valida chave, emitente, itens e campos fiscais sem aceitar XML externo", () => {
  const parsed = parseNfeXml(xml());
  assert.equal(parsed.accessKey.length, 44);
  assert.equal(parsed.supplierDocument, "11222333000181");
  assert.equal(parsed.supplierName, "Fornecedor Exemplo Ltda");
  assert.equal(parsed.recipientDocument, "11444777000161");
  assert.deepEqual(parsed.items[0], {
    itemNumber: 1,
    supplierCode: "ABC-1",
    description: "Produto de teste",
    barcode: "7891234567895",
    ncm: "12345678",
    cfop: "5102",
    unit: "UN",
    quantity: 2,
    unitCost: 12.5,
    total: 25,
  });
  assert.throws(() => parseNfeXml(xml().replace("<NFe>", "<!DOCTYPE x [<!ENTITY y SYSTEM 'file:///etc/passwd'>]><NFe>")), /entidades externas/);
  assert.throws(() => parseNfeXml(xml().replace("<CNPJ>11222333000181</CNPJ>", "<CNPJ>11222333000182</CNPJ>")), /CNPJ/);
  assert.throws(() => parseNfeXml(xml().replace(/NFe\d{44}/, `NFe${accessKey().slice(0, 43)}9`)), /Chave de acesso/);
});

test("chave da NF-e e CNPJ usam dígitos verificadores reais", () => {
  const key = accessKey();
  assert.equal(validAccessKey(key), true);
  assert.equal(validAccessKey(`${key.slice(0, 43)}${Number(key[43]) === 9 ? 0 : Number(key[43]) + 1}`), false);
  assert.equal(validCnpj("11222333000181"), true);
  assert.equal(validCnpj("00000000000000"), false);
});

test("conferência exige cada item uma única vez e recebimento exige data civil válida", () => {
  assert.deepEqual(matchItems([{ itemId: 1, productId: 2 }, { itemId: 2, productId: 2 }]), [{ itemId: 1, productId: 2 }, { itemId: 2, productId: 2 }]);
  assert.throws(() => matchItems([{ itemId: 1, productId: 2 }, { itemId: 1, productId: 3 }]), /exatamente uma vez/);
  assert.deepEqual(receiveInvoiceInput({ warehouseId: 4, dueAt: "2026-09-30" }), { warehouseId: 4, dueAt: new Date("2026-09-30T12:00:00.000Z") });
  assert.throws(() => receiveInvoiceInput({ warehouseId: 4, dueAt: "2026-02-31" }), /vencimento/);
});

test("rota não expõe XML e recebe a nota sob lock serializável e idempotência financeira", () => {
  assert.doesNotMatch(route, /xmlText:\s*true/);
  assert.match(receiving, /purchase_invoices[^`]+FOR UPDATE/);
  assert.match(receiving, /isolationLevel:\s*"Serializable"/);
  assert.match(receiving, /sourceType_sourceId/);
  assert.match(receiving, /weightedCost/);
  assert.match(route, /receivePurchaseInvoiceRecord/);
  assert.match(route, /readJsonObject\(request, 5_300_000\)/);
  assert.match(route, /cache-control.*no-store/);
});

test("workspace substitui o legado e cobre busca, filtros, upload, confirmação e responsividade", () => {
  assert.match(client, /<NfeInputWorkspace\s*\/>/);
  assert.doesNotMatch(client, /function Invoices\(|function InvoiceCard\(/);
  for (const contract of ["role=\"search\"", "aria-live=\"polite\"", "aria-expanded", "Confirmar recebimento", "productSearch", "máximo de 5 MB"]) assert.match(workspace, new RegExp(contract));
  assert.match(css, /@media\(max-width:600px\)/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(workspace, /useState<"detected" \| "entries">\("entries"\)/);
  assert.match(workspace, /selectedInvoiceId/);
  assert.match(route, /url\.searchParams\.get\("invoiceId"\)/);
});

test("Distribuição DF-e valida SOAP, descompacta documentos e preserva o cursor NSU", () => {
  const encoded = gzipSync(Buffer.from(xml())).toString("base64");
  const response = parseDistributionResponse(`<soap:Envelope><soap:Body><retDistDFeInt><cStat>138</cStat><xMotivo>Documentos localizados</xMotivo><ultNSU>12</ultNSU><maxNSU>18</maxNSU><loteDistDFeInt><docZip NSU="12" schema="procNFe_v4.00.xsd">${encoded}</docZip></loteDistDFeInt></retDistDFeInt></soap:Body></soap:Envelope>`);
  assert.equal(response.statusCode, "138");
  assert.equal(response.lastNsu, "000000000000012");
  assert.equal(response.maxNsu, "000000000000018");
  assert.equal(response.documents[0]?.documentType, "nfe");
  assert.equal(response.documents[0]?.recipientDocument, "11444777000161");
  assert.equal(response.documents[0]?.fullDocumentAvailable, true);
  assert.throws(() => parseDistributionResponse("<!DOCTYPE x><ret><cStat>137</cStat><ultNSU>0</ultNSU><maxNSU>0</maxNSU></ret>"), /inválida/);
  assert.throws(() => parseDistributionResponse("<ret><cStat>656</cStat><xMotivo>Consumo indevido</xMotivo><ultNSU>0</ultNSU><maxNSU>0</maxNSU></ret>"), /Consumo indevido/);
  assert.throws(() => parseDistributionResponse("<ret><cStat>138</cStat><xMotivo>ok</xMotivo><ultNSU>1</ultNSU><maxNSU>1</maxNSU><docZip NSU=\"1\" schema=\"procNFe_v4.00.xsd\">AAAA</docZip></ret>"), /descompactado/);
});

test("ADN NFS-e aceita lote fiscal codificado e classifica serviço sem estoque", () => {
  const nfseXml = `<NFSe><infNFSe Id="NFS${"1".repeat(50)}"><emit><CNPJ>11222333000181</CNPJ><xNome>Prestador Exemplo</xNome></emit><nNFSe>55</nNFSe><dhProc>2026-09-02T10:00:00-03:00</dhProc><vLiq>149.90</vLiq></infNFSe></NFSe>`;
  const response = parseNfseDistributionResponse(JSON.stringify({ ultimoNSU: "21", maiorNSU: "25", documentos: [{ NSU: "21", tipoDocumento: "nfse_v1.00.xsd", documento: gzipSync(Buffer.from(nfseXml)).toString("base64") }] }), "20");
  assert.equal(response.lastNsu, "000000000000021");
  assert.equal(response.documents[0]?.documentType, "nfse");
  assert.equal(response.documents[0]?.classification, "service");
  assert.equal(response.documents[0]?.accessKey, "1".repeat(50));
  assert.throws(() => parseNfseDistributionResponse("not-json", "0"), /JSON inválido/);
});

test("ADN oficial interpreta ArquivoXml e calcula cursor sem ultNSU fictício", () => {
  const nfseXml = `<NFSe><infNFSe Id="NFS${"1".repeat(50)}"><emit><CNPJ>11222333000181</CNPJ><xNome>Prestador</xNome></emit><DPS><infDPS><toma><CNPJ>11444777000161</CNPJ></toma></infDPS></DPS><nNFSe>55</nNFSe><vLiq>10</vLiq></infNFSe></NFSe>`;
  const row = { NSU: 1, TipoDocumento: "NFSE", ChaveAcesso: "1".repeat(50), ArquivoXml: gzipSync(Buffer.from(nfseXml)).toString("base64") };
  const parse = (value: unknown) => parseNfseDistributionResponse(JSON.stringify(value), "0");
  const result = parse({ StatusProcessamento: "DOCUMENTOS_LOCALIZADOS", LoteDFe: [row], Erros: [] });
  assert.equal(result.lastNsu, "000000000000001");
  assert.equal(result.documents[0].recipientDocument, "11444777000161");
  assert.equal(result.documents[0].issuerDocument, "11222333000181");
  assert.equal(parse({ StatusProcessamento: "NENHUM_DOCUMENTO_LOCALIZADO", LoteDFe: null }).documents.length, 0);
  assert.throws(() => parse({ StatusProcessamento: "REJEICAO", LoteDFe: [] }), /rejeitou/);
  assert.throws(() => parse({ StatusProcessamento: "DOCUMENTOS_LOCALIZADOS", LoteDFe: [] }), /inconsistente/);
  assert.throws(() => parse({ StatusProcessamento: "DOCUMENTOS_LOCALIZADOS", LoteDFe: [row, row] }), /duplicado/);
  assert.throws(() => parse({ StatusProcessamento: "DOCUMENTOS_LOCALIZADOS", LoteDFe: [{ ...row, ArquivoXml: null }] }), /ArquivoXml/);
  assert.throws(() => parse({ StatusProcessamento: "DOCUMENTOS_LOCALIZADOS", LoteDFe: [{ ...row, ChaveAcesso: "2".repeat(50) }] }), /diverge/);
  assert.throws(() => parse({ message: "not found" }), /contrato/);
  const eventXml = `<evento><infEvento><pedRegEvento><infPedReg><CNPJAutor>11222333000181</CNPJAutor><chNFSe>${"1".repeat(50)}</chNFSe><e101101><xDesc>Cancelamento de NFS-e</xDesc></e101101></infPedReg></pedRegEvento></infEvento></evento>`;
  const event = parse({ StatusProcessamento: "DOCUMENTOS_LOCALIZADOS", LoteDFe: [{ NSU: 2, TipoDocumento: "EVENTO", ArquivoXml: gzipSync(Buffer.from(eventXml)).toString("base64") }] }).documents[0];
  assert.equal(event.documentType, "event");
  assert.equal(event.cancelled, true);
  assert.equal(event.accessKey, null, "Evento não pode sobrescrever o XML da nota pela chave única");
});

test("captura preserva espera obrigatória inclusive após reconfiguração", () => {
  const distribution = readFileSync("lib/erp/dfe-distribution.ts", "utf8");
  assert.match(distribution, /cnpjConsulta=\$\{document\}&lote=true/);
  assert.match(distribution, /result.statusCode === "137" \|\| result.lastNsu === result.maxNsu \? 60 \* 60_000/);
  assert.match(distribution, /nextSyncAt: \{ lte: now \}/);
  assert.doesNotMatch(dfeRoute, /update: \{ enabled:[^}]+nextSyncAt:/);
  assert.doesNotMatch(distribution, /remote.status === 404 \|\| !remote.body.trim/);
});

test("política impede estoque para cancelados, despesas, serviços e notas ignoradas", () => {
  for (const status of ["cancelled", "ignored"]) assert.throws(() => assertFiscalEntryAllowed({ documentType: "nfe", classification: "goods", status }));
  for (const classification of ["service", "freight", "asset", "expense", "unknown"]) assert.throws(() => assertFiscalEntryAllowed({ documentType: "nfe", classification, status: "ready" }));
  assert.doesNotThrow(() => assertFiscalEntryAllowed({ documentType: "nfe", classification: "goods", status: "ready" }));
  for (const status of ["received", "cancelled"]) assert.throws(() => assertFiscalReclassificationAllowed(status));
  assert.equal(fiscalDirection({ documentType: "nfse", issuerDocument: "11222333000181" }, "11.222.333/0001-81"), "issued");
  assert.equal(fiscalDirection({ documentType: "nfse", recipientDocument: "11222333000181" }, "11.222.333/0001-81"), "received");
});

test("eventos por chave aceitam NSU nulo e rejeitam evento de outra nota", () => {
  const key = "1".repeat(50), xml = `<evento><infEvento><chNFSe>${key}</chNFSe><e101101 /></infEvento></evento>`;
  const body = JSON.stringify({ StatusProcessamento: "DOCUMENTOS_LOCALIZADOS", LoteDFe: [{ NSU: null, TipoDocumento: "EVENTO", ChaveAcesso: key, ArquivoXml: gzipSync(Buffer.from(xml)).toString("base64") }] });
  assert.equal(parseNfseEvents(body, key)[0].cancelled, true);
  assert.throws(() => parseNfseEvents(body, "2".repeat(50)), /outra/);
  assert.throws(() => parseNfseEvents('{}', key), /confirmou/);
});

test("XML e ações fiscais exigem escopo de filial e recuperação tem limite", () => {
  assert.match(dfeRoute, /assertDfeBranchAccess\(db, access, document.branchId\)/);
  assert.match(dfeRoute, /dfe.xml.downloaded/);
  assert.match(dfeRoute, /content-disposition/);
  assert.match(dfeRoute, /assertFiscalReclassificationAllowed/);
  assert.match(receiving, /homologationStatus !== "approved"/);
  const distribution = readFileSync("lib/erp/dfe-distribution.ts", "utf8");
  assert.match(distribution, /await recoverDfePreparation\(db\)/);
  assert.match(distribution, /attempts >= 4 \? "in_review"/);
  assert.match(inbox, /Baixar XML original/);
  assert.match(inbox, /Atualizar eventos no ADN/);
  assert.match(inbox, /Buscar NF-e pela chave/);
  assert.match(inbox, /Este ato tem efeito fiscal/);
  assert.match(inbox, /NF-e aguardando XML da SEFAZ/);
  assert.match(dfeRoute, /registerNfeScience/);
});

test("Ciência automática exige autorização permanente, escopo fiscal e mantém recebimento humano", () => {
  for (const field of ["autoScienceEnabled", "autoScienceAuthorizedAt", "autoScienceAuthorizedBy"]) assert.match(schema, new RegExp(field));
  assert.match(automaticScienceMigration, /auto_science_enabled/);
  assert.match(automaticScienceMigration, /source" = 'sefaz_nfe'/);
  assert.match(automaticScienceMigration, /environment" = 'production'/);
  assert.match(dfeRoute, /autoScienceAcknowledged/);
  assert.match(dfeRoute, /canAuthorizeAutomaticScience/);
  assert.match(dfeRoute, /\["owner", "admin"\]/);
  assert.match(manifestationService, /recoverAutomaticNfeScience/);
  assert.match(manifestationService, /system:dfe-auto-science/);
  assert.match(manifestationService, /manifestationStatus: "pending"/);
  assert.match(manifestationService, /fullDocumentAvailable: false/);
  assert.match(manifestationService, /dfe\.manifestation\.science\.failed/);
  assert.match(manifestationService, /retryAfterMinutes: 60/);
  assert.match(readFileSync("lib/erp/dfe-distribution.ts", "utf8"), /await recoverAutomaticNfeScience\(db\)/);
  assert.match(inbox, /Autorização fiscal permanente/);
  assert.match(inbox, /não confirma recebimento, não recebe estoque e não cria pagamento/);
  assert.match(inbox, /Somente proprietário ou administrador/);
});

test("caixa fiscal cobre fontes por filial, triagem, conciliação e produto pendente", () => {
  for (const contract of ["sefaz_nfe", "nfse_adn", "Sempre conferir manualmente", "Gerar entrada para conferência", "Conciliar lançamento", "Não gera entrada", "Produtos pendentes", "aria-live=\"polite\"", "Instalar A1", "/erp/fiscal", "waiting_certificate"]) assert.match(inbox, new RegExp(contract));
  assert.match(inbox, /disabled=\{nfse\}/);
  assert.match(inboxCss, /@media\s*\(max-width:\s*760px\)/);
  assert.match(dfeRoute, /source === "nfse_adn" && processingMode !== "review"/);
  assert.match(dfeRoute, /events: item\.events\.map[\s\S]*id: String\(event\.id\)/);
  assert.doesNotMatch(dfeRoute, /encryptedXml:\s*true/);
  assert.match(route, /encryptedXml: encryptSecret\(nfe\.xml\)/);
  assert.match(route, /payloadHash: createHash\("sha256"\)/);
  assert.match(inbox, /useState\("nfe"\)/);
  assert.match(inbox, /Validar entrada #/);
});

test("XML distribuído preserva a Ciência registrada antes da chegada do documento", () => {
  const distribution = readFileSync("lib/erp/dfe-distribution.ts", "utf8");
  assert.match(distribution, /dfe\.manifestation\.science\.registered/);
  assert.match(distribution, /data\.manifestationStatus = "science"/);
  assert.match(distribution, /existing\.manifestationStatus !== "pending"/);
});

test("modelo fiscal é auditável, idempotente e implantado com agendador protegido", () => {
  for (const model of ["model DfeSyncCursor", "model InboundFiscalDocument", "model InboundFiscalDocumentEvent"]) assert.match(schema, new RegExp(model));
  for (const invariant of ["source_branch_id_nsu", "source_access_key", "purchase_invoice_id_key", "payload_hash_check", "append_only"]) assert.match(migration, new RegExp(invariant));
  assert.match(migration, /processing_mode[\s\S]*auto_receive[\s\S]*default_warehouse_id/);
  assert.match(receiving, /onboardingStatus !== "complete"/);
  assert.match(receiving, /matchConfidence \|\| 0\) < 95/);
  assert.match(inboundFiscal, /preparePosT2CatalogBoundary/);
  assert.match(inboundFiscal, /toPosT2BoundaryIdempotencyKey\(`inbound-fiscal-product-v1:/);
  assert.match(inboundFiscal, /id: boundary\.productId, posRevision: boundary\.productRevision, posConfigHash: boundary\.productConfigHash/);
  assert.match(dfeRoute, /assertTenantPermission\(organization\.id, "products\.write"\)/);
  assert.match(route, /assertTenantPermission\(organization\.id, "products\.write"\)/);
  assert.match(internalSync, /timingSafeEqual/);
  assert.match(internalSync, /NALVEN_INTERNAL_JOB_TOKEN/);
  assert.match(deploy, /nalven-dfe-sync\.timer/);
  assert.match(timer, /OnUnitActiveSec=1min/);
  assert.doesNotMatch(tenantSeed, /db\.product\.createMany/);
  assert.match(tenantSeed, /Fresh tenants intentionally start without synthetic catalog entries/);
  assert.match(tenantSeed, /createSeedCatalogBoundary/);
  assert.match(demoFiscalSeed, /NALVEN_ALLOW_DEMO_FISCAL_SEED/);
  assert.match(demoFiscalSeed, /identity\.database !== "nalven_t_demo"/);
  assert.match(demoFiscalSeed, /identity\.role !== "nalven_t_demo_runtime"/);
  assert.match(demoFiscalSeed, /enabled: false, processingMode: "review"/);
  assert.match(demoFiscalSeed, /prepareInboundInvoice/);
  assert.match(demoFiscalSeed, /createProductFromInvoiceItem/);
  assert.match(demoFiscalSeed, /receivePurchaseInvoiceRecord/);
  assert.doesNotMatch(demoFiscalSeed, /deleteMany|updateMany/);
});

test("CT-e usa contrato próprio e nunca cria mercadoria", () => {
  const key = accessKey("57");
  const document = inspectDistributedDocument("1", "procCTe_v4.00.xsd", `<cteProc><CTe><infCte Id="CTe${key}"><ide><nCT>123</nCT><serie>1</serie></ide><emit><CNPJ>11222333000181</CNPJ><xNome>Transportadora</xNome></emit><dest><CNPJ>11444777000161</CNPJ></dest><vPrest><vTPrest>25.50</vTPrest></vPrest></infCte></CTe></cteProc>`);
  assert.equal(document.documentType, "cte");
  assert.equal(document.classification, "freight");
  assert.equal(document.total, 25.5);
  assert.equal(document.fullDocumentAvailable, true);
  assert.throws(() => assertFiscalEntryAllowed({ ...document, status: "ready", environment: "production" }), /Somente NF-e/);
  const envelope = distributionEnvelope("homologation", "52", "11444777000161", "0", "sefaz_cte");
  assert.match(envelope, /cteDistDFeInteresse/);
  assert.match(envelope, /distDFeInt versao="1.00"/);
  assert.match(envelope, /<tpAmb>2<\/tpAmb>/);
  assert.doesNotMatch(envelope, /nfeDadosMsg/);
});

test("ambiente é explícito no XML e não pode ser presumido como produção", () => {
  assert.equal(parseNfeXml(xml()).environment, "legacy");
  assert.equal(parseNfeXml(xml().replace("<ide>", "<ide><tpAmb>1</tpAmb>")).environment, "production");
  assert.equal(parseNfeXml(xml().replace("<ide>", "<ide><tpAmb>2</tpAmb>")).environment, "homologation");
});

test("consulta ADN de eventos pode incluir somente a própria nota sem eventos", () => {
  const key = "1".repeat(50);
  const xml = `<NFSe><infNFSe Id="NFS${key}"><emit><CNPJ>11222333000181</CNPJ></emit></infNFSe></NFSe>`;
  const body = JSON.stringify({ StatusProcessamento: "DOCUMENTOS_LOCALIZADOS", LoteDFe: [{ NSU: null, TipoDocumento: "NFSE", ChaveAcesso: key, ArquivoXml: gzipSync(Buffer.from(xml)).toString("base64") }] });
  assert.deepEqual(parseNfseEvents(body, key), []);
  assert.throws(() => parseNfseEvents(body, "2".repeat(50)), /outra NFS-e/);
});

test("ADN E2220 com lote vazio é ausência de novos documentos, não falha de certificado", () => {
  const response = { StatusProcessamento: "NENHUM_DOCUMENTO_LOCALIZADO", LoteDFe: [], Erros: [{ Codigo: "E2220", Descricao: "Nenhum documento localizado" }] };
  const parsed = parseNfseDistributionResponse(JSON.stringify(response), "14");
  assert.equal(parsed.statusCode, "137");
  assert.equal(parsed.lastNsu, "000000000000014");
  assert.deepEqual(parsed.documents, []);
  assert.throws(() => parseNfseDistributionResponse(JSON.stringify({ ...response, StatusProcessamento: "REJEICAO" }), "14"), /rejeitou/);
  assert.throws(() => parseNfseDistributionResponse(JSON.stringify({ ...response, Erros: [{ Codigo: "E9999" }] }), "14"), /rejeitou/);
});

function accessKey(model = "55") {
  const base = `35240111222333000181${model}001000000123100000123`;
  const sum = base.split("").reverse().map(Number).reduce((total, digit, index) => total + digit * (2 + index % 8), 0);
  const candidate = 11 - sum % 11;
  return `${base}${candidate === 10 || candidate === 11 ? 0 : candidate}`;
}

function xml() {
  return `<NFe><infNFe Id="NFe${accessKey()}"><ide><nNF>123</nNF><serie>1</serie><dhEmi>2026-09-02T10:00:00-03:00</dhEmi></ide><emit><CNPJ>11222333000181</CNPJ><xNome>Fornecedor Exemplo Ltda</xNome></emit><dest><CNPJ>11444777000161</CNPJ><xNome>Empresa Destinatária</xNome></dest><det nItem="1"><prod><cProd>ABC-1</cProd><cEAN>7891234567895</cEAN><xProd>Produto de teste</xProd><NCM>12345678</NCM><CFOP>5102</CFOP><uCom>UN</uCom><qCom>2.0000</qCom><vUnCom>12.50</vUnCom><vProd>25.00</vProd></prod></det><total><ICMSTot><vNF>25.00</vNF></ICMSTot></total></infNFe></NFe>`;
}

test("NF-e conserva endereço, inscrições e contato do emitente", () => {
  const parsed = parseNfeXml(xml().replace("</emit>", "<xFant>Loja</xFant><IE>123456</IE><email>fiscal@example.com</email><enderEmit><xLgr>Rua A</xLgr><nro>42</nro><xBairro>Centro</xBairro><xMun>Anápolis</xMun><UF>GO</UF><CEP>75025090</CEP><fone>62999999999</fone></enderEmit></emit>"));
  assert.equal(parsed.supplierProfile.stateRegistration, "123456");
  assert.equal(parsed.supplierProfile.address.city, "Anápolis");
  assert.equal(parsed.supplierProfile.phone, "62999999999");
  assert.equal(parsed.supplierProfile.email, "fiscal@example.com");
});

test("NFS-e prioriza emitente completo sobre prestador resumido da DPS", () => {
  const xml = `<NFSe><infNFSe Id="NFS${"1".repeat(50)}"><emit><CNPJ>11222333000181</CNPJ><xNome>Emitente completo</xNome></emit><DPS><infDPS><prest><CNPJ>11222333000181</CNPJ></prest></infDPS></DPS></infNFSe></NFSe>`;
  const document = inspectDistributedDocument("000000000000001", "nfse_v1.00.xsd", xml);
  assert.equal(document.issuerName, "Emitente completo");
  assert.equal(document.issuerDocument, "11222333000181");
});
