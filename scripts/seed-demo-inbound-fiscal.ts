import { createHash } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/tenant/client";
import { createProductFromInvoiceItem, prepareInboundInvoice } from "../lib/erp/inbound-fiscal";
import { validAccessKey, validCnpj } from "../lib/erp/nfe-input";
import { receivePurchaseInvoiceRecord } from "../lib/erp/purchase-invoice-receiving";
import { encryptSecret } from "../lib/secrets";

const databaseUrl = process.env.TENANT_DATABASE_URL;
if (!databaseUrl) throw new Error("TENANT_DATABASE_URL não definida.");
if (process.env.NALVEN_ALLOW_DEMO_FISCAL_SEED !== "1") throw new Error("Defina NALVEN_ALLOW_DEMO_FISCAL_SEED=1 para confirmar o seed fiscal demonstrativo.");
if (!process.env.NALVEN_SECRETS_MASTER_KEY) throw new Error("NALVEN_SECRETS_MASTER_KEY não definida.");

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const seedVersion = "demo-dfe-v1";
const actorLabel = "Seed demonstrativo NALVEN";

type BranchSeed = { id: number; code: string; legalName: string; document: string; state: string | null; defaultWarehouseId: number | null };
type Scenario = {
  key: string;
  source: "sefaz_nfe" | "nfse_adn";
  documentType: "nfe" | "cte" | "nfse" | "event";
  schemaName: string;
  branch: BranchSeed;
  nsu: string;
  accessKey: string | null;
  issuerDocument: string | null;
  issuerName: string;
  number: string | null;
  series: string | null;
  issueDate: Date;
  total: number | null;
  status: "detected" | "awaiting_document" | "ready" | "in_review" | "ignored" | "cancelled";
  classification: "unknown" | "goods" | "service" | "freight" | "expense" | "asset" | "other";
  manifestationStatus: "pending" | "science" | "confirmed" | "unknown_operation" | "not_performed" | "not_required";
  manifestationDeadline: Date | null;
  xml: string | null;
  ignoredReason?: string;
  workflow?: "unmatched" | "new_product" | "received";
};

async function main() {
  const [identity] = await db.$queryRaw<Array<{ database: string; role: string }>>`SELECT current_database() AS database, current_user AS role`;
  if (!identity || identity.database !== "nalven_t_demo" || identity.role !== "nalven_t_demo_runtime") {
    throw new Error("O seed fiscal demonstrativo só pode executar em nalven_t_demo com a credencial runtime.");
  }

  const [branches, actor, products] = await Promise.all([
    db.branch.findMany({ where: { status: "active" }, select: { id: true, code: true, legalName: true, document: true, state: true, defaultWarehouseId: true }, orderBy: [{ primary: "desc" }, { id: "asc" }], take: 2 }),
    db.tenantUserProfile.findFirst({ where: { status: "active", role: { key: "owner" } }, select: { userId: true, displayName: true } }),
    db.product.findMany({ where: { active: true, type: "product", status: "publish", onboardingStatus: "complete" }, select: { id: true, name: true, sku: true, unit: true }, orderBy: { id: "asc" }, take: 12 }),
  ]);
  const validBranches = branches.filter((branch) => validCnpj(branch.document.replace(/\D/g, "")));
  if (!validBranches.length) throw new Error("É necessária uma filial ativa com CNPJ válido.");
  if (!actor) throw new Error("É necessário um proprietário ativo para auditar as simulações.");
  if (!products.length) throw new Error("É necessário ao menos um produto publicado e completo para simular recebimento.");

  const warehouses = await db.warehouse.findMany({ where: { active: true, branchId: { in: validBranches.map((branch) => branch.id) } }, select: { id: true, branchId: true }, orderBy: [{ primary: "desc" }, { id: "asc" }] });
  const warehouseByBranch = new Map(validBranches.map((branch) => [branch.id, branch.defaultWarehouseId || warehouses.find((warehouse) => warehouse.branchId === branch.id)?.id || null]));
  if (!warehouseByBranch.get(validBranches[0]!.id)) throw new Error("A filial principal precisa de um depósito ativo para a simulação de recebimento.");

  await seedDisabledCursors(validBranches, warehouseByBranch);
  const scenarios = buildScenarios(validBranches, products[0]!);
  const documents = new Map<string, { id: number }>();
  let documentsCreated = 0;
  let eventsCreated = 0;

  for (const scenario of scenarios) {
    const existing = await db.inboundFiscalDocument.findUnique({ where: { source_branchId_nsu: { source: scenario.source, branchId: scenario.branch.id, nsu: scenario.nsu, environment: "legacy" } }, select: { id: true } });
    const payload = scenario.xml || JSON.stringify({ key: scenario.key, issuer: scenario.issuerDocument, number: scenario.number, source: scenario.source });
    const document = existing || await db.inboundFiscalDocument.create({ data: {
      source: scenario.source, documentType: scenario.documentType, schemaName: scenario.schemaName, nsu: scenario.nsu,
      accessKey: scenario.accessKey, branchId: scenario.branch.id, recipientDocument: digits(scenario.branch.document),
      issuerDocument: scenario.issuerDocument, issuerName: scenario.issuerName, number: scenario.number, series: scenario.series,
      issueDate: scenario.issueDate, authorizationDate: new Date(scenario.issueDate.getTime() + 180_000), total: scenario.total,
      status: scenario.status, classification: scenario.classification, manifestationStatus: scenario.manifestationStatus,
      manifestationDeadline: scenario.manifestationDeadline, fullDocumentAvailable: Boolean(scenario.xml),
      encryptedXml: scenario.xml ? encryptSecret(scenario.xml) : null, payloadHash: sha256(payload),
      ignoredReason: scenario.ignoredReason || null, reviewedBy: ["in_review", "ignored"].includes(scenario.status) ? actorLabel : null,
      reviewedAt: ["in_review", "ignored"].includes(scenario.status) ? new Date(scenario.issueDate.getTime() + 360_000) : null,
      detectedAt: new Date(scenario.issueDate.getTime() + 240_000),
    }, select: { id: true } });
    if (!existing) documentsCreated++;
    documents.set(scenario.key, document);
    eventsCreated += await ensureScenarioEvents(document.id, scenario, actor.userId);
  }

  const workflowSummary = await executeWorkflows(scenarios, documents, actor, warehouseByBranch);
  const [documentTotal, statusGroups, invoiceTotal, pendingProducts, cursorTotal] = await Promise.all([
    db.inboundFiscalDocument.count({ where: { events: { some: { correlationId: { startsWith: `${seedVersion}:` } } } } }),
    db.inboundFiscalDocument.groupBy({ by: ["status"], where: { events: { some: { correlationId: { startsWith: `${seedVersion}:` } } } }, _count: { _all: true } }),
    db.purchaseInvoice.count({ where: { source: "sefaz_nfe", inboundFiscalDocument: { events: { some: { correlationId: { startsWith: `${seedVersion}:` } } } } } }),
    db.product.count({ where: { onboardingSource: "purchase_invoice", onboardingStatus: { not: "complete" } } }),
    db.dfeSyncCursor.count({ where: { environment: "homologation", branchId: { in: validBranches.map((branch) => branch.id) } } }),
  ]);

  console.log(JSON.stringify({
    seed: seedVersion, documentsCreated, eventsCreated, documentTotal, invoiceTotal, pendingProducts, cursorTotal,
    workflows: workflowSummary, statuses: Object.fromEntries(statusGroups.map((group) => [group.status, group._count._all])),
    branches: validBranches.map((branch) => branch.code), externalSyncEnabled: false,
  }));
}

async function seedDisabledCursors(branches: BranchSeed[], warehouseByBranch: Map<number, number | null>) {
  for (const branch of branches) for (const source of ["sefaz_nfe", "nfse_adn"] as const) {
    const existing = await db.dfeSyncCursor.findUnique({ where: { branchId_source_environment: { branchId: branch.id, source, environment: "homologation" } }, select: { id: true } });
    if (!existing) await db.dfeSyncCursor.create({ data: {
      branchId: branch.id, source, environment: "homologation", enabled: false, processingMode: "review",
      defaultWarehouseId: warehouseByBranch.get(branch.id) || null, defaultDueDays: 28,
      lastNsu: source === "sefaz_nfe" ? "000000000009912" : "000000000004216",
      maxNsu: source === "sefaz_nfe" ? "000000000009920" : "000000000004220",
      status: "idle", lastSyncAt: new Date("2026-09-02T12:05:00.000Z"), lastSuccessAt: new Date("2026-09-02T12:05:00.000Z"), nextSyncAt: null,
    } });
  }
}

function buildScenarios(branches: BranchSeed[], product: { name: string; sku: string; unit: string }): Scenario[] {
  const branch = (index: number) => branches[index % branches.length]!;
  const suppliers = [
    { document: cnpj("112223330001"), name: "Distribuidora Horizonte Ltda." },
    { document: cnpj("482319010001"), name: "Auto Peças Serra Sul Ltda." },
    { document: cnpj("337814450001"), name: "Comercial Rota Oeste Ltda." },
    { document: cnpj("256789010001"), name: "Serviços Técnicos Aurora Ltda." },
  ];
  const makeNfe = (index: number, supplierIndex: number, number: number, items: InvoiceItem[]) => {
    const target = branch(index), supplier = suppliers[supplierIndex % suppliers.length]!;
    const key = accessKey(target.state, "55", supplier.document, number, 14000000 + number);
    return { target, supplier, key, xml: nfeXml(key, target, supplier, number, items) };
  };
  const ready = makeNfe(0, 0, 8101, [{ code: "DEMO-FILTRO-8101", description: "Kit de filtros para revisão completa", ncm: "84212300", quantity: 6, unitCost: 89.9 }]);
  const expense = makeNfe(0, 1, 8103, [{ code: "DEMO-USO-CONSUMO", description: "Material de uso e consumo da oficina", ncm: "39269090", quantity: 10, unitCost: 24.75 }]);
  const ignored = makeNfe(1, 2, 8104, [{ code: "DEMO-DIVERGENTE", description: "Mercadoria destinada a outro pedido", ncm: "87089990", quantity: 2, unitCost: 310 }]);
  const cancelled = makeNfe(1, 0, 8105, [{ code: "DEMO-CANCELADO", description: "Lote cancelado pelo fornecedor", ncm: "27101932", quantity: 12, unitCost: 39.9 }]);
  const unmatched = makeNfe(0, 1, 8110, [{ code: "DEMO-CONFERIR-8110", description: "Sensor automotivo sem vínculo no catálogo", ncm: "90318099", quantity: 4, unitCost: 126.5 }]);
  const newProduct = makeNfe(1, 2, 8111, [{ code: "DEMO-NOVO-8111", description: "Terminal elétrico reforçado linha profissional", ncm: "85369090", quantity: 20, unitCost: 8.45 }]);
  const received = makeNfe(0, 0, 8112, [{ code: product.sku, description: product.name, ncm: "87089990", quantity: 7, unitCost: 37.8, unit: product.unit }]);
  const summarySupplier = suppliers[3]!;
  const summaryKey = accessKey(branch(1).state, "55", summarySupplier.document, 8102, 14008102);
  const cteSupplier = suppliers[2]!, cteKey = accessKey(branch(0).state, "57", cteSupplier.document, 8108, 57008108);
  const nfseKey = numericKey("82026090200000000000000000000000000000000000008106", 50);
  const nfseSummaryKey = numericKey("82026090200000000000000000000000000000000000008107", 50);
  const date = (day: number, hour: number) => new Date(`2026-09-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00.000Z`);
  const base = (key: string, source: Scenario["source"], documentType: Scenario["documentType"], target: BranchSeed, nsu: number, issuerDocument: string | null, issuerName: string, number: string | null, issueDate: Date, total: number | null) => ({ key, source, documentType, branch: target, nsu: String(990000000000000 + nsu), issuerDocument, issuerName, number, issueDate, total });
  return [
    { ...base("ready-goods", "sefaz_nfe", "nfe", ready.target, 101, ready.supplier.document, ready.supplier.name, "8101", date(2, 8), 539.4), schemaName: "procNFe_v4.00.xsd", accessKey: ready.key, series: "1", status: "ready", classification: "goods", manifestationStatus: "science", manifestationDeadline: date(6, 12), xml: ready.xml },
    { ...base("awaiting-summary", "sefaz_nfe", "nfe", branch(1), 102, summarySupplier.document, summarySupplier.name, "8102", date(2, 7), 1289.7), schemaName: "resNFe_v1.01.xsd", accessKey: summaryKey, series: "1", status: "awaiting_document", classification: "goods", manifestationStatus: "pending", manifestationDeadline: date(4, 12), xml: null },
    { ...base("expense-review", "sefaz_nfe", "nfe", expense.target, 103, expense.supplier.document, expense.supplier.name, "8103", date(1, 17), 247.5), schemaName: "procNFe_v4.00.xsd", accessKey: expense.key, series: "1", status: "in_review", classification: "expense", manifestationStatus: "confirmed", manifestationDeadline: date(10, 12), xml: expense.xml },
    { ...base("ignored-operation", "sefaz_nfe", "nfe", ignored.target, 104, ignored.supplier.document, ignored.supplier.name, "8104", date(1, 14), 620), schemaName: "procNFe_v4.00.xsd", accessKey: ignored.key, series: "1", status: "ignored", classification: "goods", manifestationStatus: "unknown_operation", manifestationDeadline: null, xml: ignored.xml, ignoredReason: "Operação não reconhecida pela equipe de compras." },
    { ...base("cancelled-document", "sefaz_nfe", "nfe", cancelled.target, 105, cancelled.supplier.document, cancelled.supplier.name, "8105", new Date("2026-08-31T16:00:00.000Z"), 478.8), schemaName: "procEventoNFe_v1.00.xsd", accessKey: cancelled.key, series: "1", status: "cancelled", classification: "goods", manifestationStatus: "not_required", manifestationDeadline: null, xml: cancelled.xml },
    { ...base("service-review", "nfse_adn", "nfse", branch(0), 106, suppliers[3]!.document, suppliers[3]!.name, "2031", date(2, 9), 890), schemaName: "nfse_v1.00.xsd", accessKey: nfseKey, series: "1", status: "in_review", classification: "service", manifestationStatus: "not_required", manifestationDeadline: null, xml: nfseXml(nfseKey, branch(0), suppliers[3]!, 2031, 890) },
    { ...base("service-summary", "nfse_adn", "nfse", branch(1), 107, suppliers[3]!.document, suppliers[3]!.name, "2032", date(1, 11), 340), schemaName: "resNFSe_v1.00.xsd", accessKey: nfseSummaryKey, series: "1", status: "awaiting_document", classification: "service", manifestationStatus: "not_required", manifestationDeadline: null, xml: null },
    { ...base("freight-review", "sefaz_nfe", "cte", branch(0), 108, cteSupplier.document, "Transportadora Rota Oeste Ltda.", "7201", new Date("2026-08-31T09:00:00.000Z"), 465.8), schemaName: "procCTe_v4.00.xsd", accessKey: cteKey, series: "1", status: "in_review", classification: "freight", manifestationStatus: "not_required", manifestationDeadline: null, xml: cteXml(cteKey, branch(0), cteSupplier.document, 7201, 465.8) },
    { ...base("fiscal-event", "sefaz_nfe", "event", branch(1), 109, suppliers[0]!.document, suppliers[0]!.name, null, date(30, 15), null), schemaName: "procEventoNFe_v1.00.xsd", accessKey: null, series: null, status: "detected", classification: "other", manifestationStatus: "not_required", manifestationDeadline: null, xml: null },
    { ...base("prepared-unmatched", "sefaz_nfe", "nfe", unmatched.target, 110, unmatched.supplier.document, unmatched.supplier.name, "8110", date(2, 10), 506), schemaName: "procNFe_v4.00.xsd", accessKey: unmatched.key, series: "1", status: "ready", classification: "goods", manifestationStatus: "confirmed", manifestationDeadline: date(12, 12), xml: unmatched.xml, workflow: "unmatched" },
    { ...base("prepared-new-product", "sefaz_nfe", "nfe", newProduct.target, 111, newProduct.supplier.document, newProduct.supplier.name, "8111", date(2, 10), 169), schemaName: "procNFe_v4.00.xsd", accessKey: newProduct.key, series: "1", status: "ready", classification: "goods", manifestationStatus: "confirmed", manifestationDeadline: date(12, 12), xml: newProduct.xml, workflow: "new_product" },
    { ...base("received-stock-finance", "sefaz_nfe", "nfe", received.target, 112, received.supplier.document, received.supplier.name, "8112", date(1, 13), 264.6), schemaName: "procNFe_v4.00.xsd", accessKey: received.key, series: "1", status: "ready", classification: "goods", manifestationStatus: "confirmed", manifestationDeadline: null, xml: received.xml, workflow: "received" },
  ];
}

async function executeWorkflows(scenarios: Scenario[], documents: Map<string, { id: number }>, actor: { userId: string; displayName: string }, warehouseByBranch: Map<number, number | null>) {
  let prepared = 0, productsCreated = 0, received = 0;
  const serviceActor = { id: actor.userId, name: actor.displayName };
  for (const scenario of scenarios.filter((item) => item.workflow)) {
    const documentId = documents.get(scenario.key)?.id;
    if (!documentId) throw new Error(`Documento do cenário ${scenario.key} não encontrado.`);
    const before = await db.inboundFiscalDocument.findUniqueOrThrow({ where: { id: documentId }, select: { purchaseInvoiceId: true } });
    const result = await prepareInboundInvoice(db, documentId, serviceActor, `${seedVersion}:workflow:prepare:${scenario.key}`);
    if (!before.purchaseInvoiceId) prepared++;
    if (scenario.workflow === "new_product") {
      const item = await db.purchaseInvoiceItem.findFirstOrThrow({ where: { purchaseInvoiceId: result.invoice.id }, orderBy: { itemNumber: "asc" }, select: { id: true, productId: true } });
      if (!item.productId) {
        await createProductFromInvoiceItem(db, item.id, serviceActor, `${seedVersion}:workflow:create-product:${scenario.key}`);
        productsCreated++;
      }
    }
    if (scenario.workflow === "received") {
      const invoice = await db.purchaseInvoice.findUniqueOrThrow({ where: { id: result.invoice.id }, select: { status: true } });
      if (invoice.status !== "received") {
        const warehouseId = warehouseByBranch.get(scenario.branch.id);
        if (!warehouseId) throw new Error(`Depósito da filial ${scenario.branch.code} não encontrado.`);
        await receivePurchaseInvoiceRecord(db, result.invoice.id, { warehouseId, dueAt: new Date("2026-09-30T12:00:00.000Z") }, serviceActor, `${seedVersion}:workflow:receive:${scenario.key}`);
        received++;
      }
    }
  }
  return { prepared, productsCreated, received };
}

async function ensureScenarioEvents(documentId: number, scenario: Scenario, actorId: string) {
  const types = ["dfe.document.detected", ...scenarioEventTypes(scenario)];
  let created = 0;
  for (const type of types) {
    const correlationId = `${seedVersion}:event:${scenario.key}:${type}`;
    if (await db.inboundFiscalDocumentEvent.findFirst({ where: { correlationId }, select: { id: true } })) continue;
    await db.inboundFiscalDocumentEvent.create({ data: { documentId, type, actorId, correlationId, metadata: { demo: true, scenario: scenario.key, source: scenario.source, status: scenario.status, classification: scenario.classification } } });
    created++;
  }
  return created;
}

function scenarioEventTypes(scenario: Scenario) {
  if (scenario.status === "awaiting_document") return ["dfe.document.summary_detected"];
  if (scenario.status === "ignored") return ["dfe.document.ignored"];
  if (scenario.status === "cancelled") return ["dfe.document.cancelled"];
  if (scenario.status === "in_review") return ["dfe.document.classified"];
  if (scenario.status === "ready") return ["dfe.document.full_document_available"];
  return [];
}

type InvoiceItem = { code: string; description: string; ncm: string; quantity: number; unitCost: number; unit?: string };

function nfeXml(key: string, branch: BranchSeed, supplier: { document: string; name: string }, number: number, items: InvoiceItem[]) {
  const total = items.reduce((sum, item) => sum + item.quantity * item.unitCost, 0);
  const lines = items.map((item, index) => `<det nItem="${index + 1}"><prod><cProd>${xml(item.code)}</cProd><cEAN>SEM GTIN</cEAN><xProd>${xml(item.description)}</xProd><NCM>${item.ncm}</NCM><CFOP>5102</CFOP><uCom>${xml(item.unit || "UN")}</uCom><qCom>${item.quantity.toFixed(4)}</qCom><vUnCom>${item.unitCost.toFixed(4)}</vUnCom><vProd>${(item.quantity * item.unitCost).toFixed(2)}</vProd></prod></det>`).join("");
  return `<NFe><infNFe Id="NFe${key}"><ide><nNF>${number}</nNF><serie>1</serie><dhEmi>2026-09-02T09:00:00-03:00</dhEmi></ide><emit><CNPJ>${supplier.document}</CNPJ><xNome>${xml(supplier.name)}</xNome></emit><dest><CNPJ>${digits(branch.document)}</CNPJ><xNome>${xml(branch.legalName)}</xNome></dest>${lines}<total><ICMSTot><vNF>${total.toFixed(2)}</vNF></ICMSTot></total></infNFe></NFe>`;
}

function nfseXml(key: string, branch: BranchSeed, supplier: { document: string; name: string }, number: number, total: number) {
  return `<NFSe><infNFSe Id="NFS${key}"><emit><CNPJ>${supplier.document}</CNPJ><xNome>${xml(supplier.name)}</xNome></emit><dest><CNPJ>${digits(branch.document)}</CNPJ><xNome>${xml(branch.legalName)}</xNome></dest><nNFSe>${number}</nNFSe><dhProc>2026-09-02T09:15:00-03:00</dhProc><xServ>Manutenção preventiva e diagnóstico técnico</xServ><vLiq>${total.toFixed(2)}</vLiq></infNFSe></NFSe>`;
}

function cteXml(key: string, branch: BranchSeed, supplierDocument: string, number: number, total: number) {
  return `<CTe><infCte Id="CTe${key}"><ide><nCT>${number}</nCT><serie>1</serie><dhEmi>2026-08-31T09:00:00-03:00</dhEmi></ide><emit><CNPJ>${supplierDocument}</CNPJ><xNome>Transportadora Rota Oeste Ltda.</xNome></emit><dest><CNPJ>${digits(branch.document)}</CNPJ><xNome>${xml(branch.legalName)}</xNome></dest><vPrest><vTPrest>${total.toFixed(2)}</vTPrest></vPrest></infCte></CTe>`;
}

function accessKey(state: string | null, model: "55" | "57", issuerDocument: string, number: number, numericCode: number) {
  const uf = new Map([["SC", "42"], ["PR", "41"], ["RS", "43"], ["SP", "35"]]).get((state || "SC").toUpperCase()) || "42";
  const base = `${uf}2609${issuerDocument}${model}001${String(number).padStart(9, "0")}1${String(numericCode).padStart(8, "0").slice(-8)}`;
  const sum = base.split("").reverse().map(Number).reduce((total, digit, index) => total + digit * (2 + index % 8), 0);
  const candidate = 11 - sum % 11;
  const key = `${base}${candidate === 10 || candidate === 11 ? 0 : candidate}`;
  if (!validAccessKey(key)) throw new Error("Falha ao gerar chave fiscal demonstrativa válida.");
  return key;
}

function cnpj(base: string) {
  const first = cnpjDigit(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const secondBase = `${base}${first}`;
  const value = `${secondBase}${cnpjDigit(secondBase, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2])}`;
  if (!validCnpj(value)) throw new Error("Falha ao gerar CNPJ demonstrativo válido.");
  return value;
}

function cnpjDigit(value: string, weights: number[]) {
  const sum = value.split("").reduce((total, digit, index) => total + Number(digit) * weights[index]!, 0);
  const candidate = 11 - sum % 11;
  return candidate >= 10 ? 0 : candidate;
}

function numericKey(value: string, length: number) { return value.replace(/\D/g, "").padEnd(length, "0").slice(0, length); }
function digits(value: string) { return value.replace(/\D/g, ""); }
function sha256(value: string) { return createHash("sha256").update(value).digest("hex"); }
function xml(value: string) { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;"); }

main()
  .catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; })
  .finally(async () => db.$disconnect());
