import { createHash } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "../generated/tenant/client";
import { encryptSecret } from "../lib/secrets";

const databaseUrl = process.env.TENANT_DATABASE_URL;
if (!databaseUrl) throw new Error("TENANT_DATABASE_URL não definida.");
if (process.env.NALVEN_ALLOW_DEMO_FISCAL_SEED !== "1")
  throw new Error("Defina NALVEN_ALLOW_DEMO_FISCAL_SEED=1 para confirmar o seed fiscal demonstrativo.");
if (!process.env.NALVEN_SECRETS_MASTER_KEY) throw new Error("NALVEN_SECRETS_MASTER_KEY não definida.");

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const version = "central-fiscal-demo-v2";
const actor = "Seed demonstrativo NALVEN";
const recipients = [
  "Auto Center Horizonte Ltda.", "Logística Serra Azul Ltda.", "Comercial Vale Verde Ltda.",
  "Oficina Rota Sul Ltda.", "Serviços Aurora Ltda.", "Peças Rápidas Ltda.",
  "Transportadora Via Norte Ltda.", "Distribuidora Ponto Certo Ltda.", "Consumidor final",
];
const scenarioStatuses = [
  "authorized", "authorized", "authorized", "queued", "rejected", "draft", "contingency",
  "cancelled", "processing", "authorized", "rejected", "authorized", "queued", "authorized",
  "draft", "authorized", "processing", "authorized", "cancelled", "authorized", "queued", "rejected",
  "authorized", "contingency", "authorized", "draft", "authorized", "processing",
] as const;

async function main() {
  const [identity] = await db.$queryRaw<Array<{ database: string; role: string }>>`SELECT current_database() AS database, current_user AS role`;
  if (!identity || identity.database !== "nalven_t_demo" || identity.role !== "nalven_t_demo_runtime")
    throw new Error("O seed só pode executar em nalven_t_demo com a credencial runtime.");
  const branches = await db.branch.findMany({ where: { status: "active" }, include: { settings: true },
    orderBy: [{ primary: "desc" }, { id: "asc" }], take: 2 });
  if (!branches.length) throw new Error("Nenhuma filial ativa encontrada.");

  let documentsCreated = 0;
  let operationsCreated = 0;
  const now = new Date();
  for (const [index, status] of scenarioStatuses.entries()) {
    const branch = branches[index % branches.length]!;
    const type = (["nfe", "nfce", "nfse"] as const)[index % 3]!;
    const sourceId = `${version}:scenario-${String(index + 1).padStart(2, "0")}`;
    let document = await db.fiscalDocument.findFirst({ where: { sourceType: "demo_homologation", sourceId, type } });
    const createdAt = new Date(now.valueOf() - (27 - index) * 12 * 3_600_000);
    const number = 991000101 + index;
    const amountCents = 12_690 + ((index * 73_147) % 1_875_000);
    const finalized = ["authorized", "cancelled"].includes(status);
    if (!document) {
      document = await db.fiscalDocument.create({ data: {
        branchId: branch.id,
        type,
        series: 998,
        number,
        status,
        environment: "homologation",
        sourceType: "demo_homologation",
        sourceId,
        recipient: `[DEMO] ${recipients[index % recipients.length]}`,
        amount: amountCents / 100,
        amountCents,
        accessKey: finalized ? String(3_500_000_000_000 + index).padStart(44, String((index % 8) + 1)).slice(0, 44) : null,
        protocol: status === "authorized" ? `HOMO-${String(number).padStart(15, "0")}` : null,
        rejectionCode: status === "rejected" ? ["539", "225", "600"][index % 3] : null,
        rejectionMessage: status === "rejected" ? rejection(index) : null,
        issuedAt: finalized ? new Date(createdAt.valueOf() + 7 * 60_000) : null,
        cancelledAt: status === "cancelled" ? new Date(createdAt.valueOf() + 95 * 60_000) : null,
        attemptCount: status === "draft" ? 0 : status === "rejected" ? 2 : 1,
        lastQueuedAt: status === "draft" ? null : new Date(createdAt.valueOf() + 2 * 60_000),
        slaDueAt: ["queued", "processing", "contingency"].includes(status) ? new Date(createdAt.valueOf() + 32 * 60_000) : null,
        createdBy: actor,
        createdAt,
        events: { create: [
          { type: "created", description: "Cenário demonstrativo criado em ambiente de homologação", actor, createdAt },
          ...(status === "draft" ? [] : [{ type: status, code: status === "rejected" ? ["539", "225", "600"][index % 3] : null,
            description: eventDescription(status), actor, createdAt: new Date(createdAt.valueOf() + 7 * 60_000) }]),
        ] },
      } });
      documentsCreated += 1;
    }
    operationsCreated += await seedDocumentOperations(document, status, type, index, createdAt);
  }

  operationsCreated += await seedInvalidation(branches[0]!.id, now);
  await seedDemoCertificate(branches[0]!.id, now);
  await seedConnectorHealth(branches, now);

  const [documentTotal, operationTotal, statusGroups, operationGroups] = await Promise.all([
    db.fiscalDocument.count({ where: { sourceType: "demo_homologation", sourceId: { startsWith: version } } }),
    db.fiscalOperation.count({ where: { correlationId: { startsWith: `${version}:` } } }),
    db.fiscalDocument.groupBy({ by: ["status"], where: { sourceType: "demo_homologation", sourceId: { startsWith: version } }, _count: { _all: true } }),
    db.fiscalOperation.groupBy({ by: ["status"], where: { correlationId: { startsWith: `${version}:` } }, _count: { _all: true } }),
  ]);
  console.log(JSON.stringify({ seed: version, documentsCreated, operationsCreated, documentTotal, operationTotal,
    environment: "homologation", branches: branches.map((branch) => branch.code),
    statuses: Object.fromEntries(statusGroups.map((group) => [group.status, group._count._all])),
    operations: Object.fromEntries(operationGroups.map((group) => [group.status, group._count._all])) }));
}

async function seedDocumentOperations(
  document: { id: number; branchId: number },
  status: string,
  documentType: string,
  index: number,
  createdAt: Date,
) {
  let count = 0;
  const issuanceStatus = status === "rejected" ? "rejected" : ["queued", "processing", "contingency"].includes(status) ? "processing" : "completed";
  if (status !== "draft") count += await ensureOperation({
    correlationId: `${version}:issuance:${document.id}`,
    branchId: document.branchId,
    documentId: document.id,
    type: "issuance",
    status: issuanceStatus,
    priority: ["rejected", "contingency"].includes(status) ? "urgent" : "normal",
    reason: "Emissão fiscal de demonstração para treinamento operacional",
    requestedAt: new Date(createdAt.valueOf() + 2 * 60_000),
    dueAt: new Date(createdAt.valueOf() + 17 * 60_000),
    resolvedAt: ["completed", "rejected"].includes(issuanceStatus) ? new Date(createdAt.valueOf() + 7 * 60_000) : null,
    resolution: issuanceStatus === "completed" ? "Retorno de homologação autorizado" : issuanceStatus === "rejected" ? "Rejeição simulada em homologação" : null,
  });
  if (status === "authorized" && documentType === "nfe" && index % 7 === 2) count += await ensureOperation({
    correlationId: `${version}:correction:${document.id}`,
    branchId: document.branchId,
    documentId: document.id,
    type: "correction",
    status: "pending",
    priority: "normal",
    reason: "Corrigir informação complementar do transportador no cenário demonstrativo",
    requestedAt: new Date(createdAt.valueOf() + 30 * 60_000),
    dueAt: new Date(createdAt.valueOf() + 90 * 60_000),
  });
  if (status === "authorized" && index % 7 === 5) count += await ensureOperation({
    correlationId: `${version}:cancellation:${document.id}`,
    branchId: document.branchId,
    documentId: document.id,
    type: "cancellation",
    status: "pending",
    priority: "urgent",
    reason: "Pedido comercial desfeito antes da circulação da mercadoria demonstrativa",
    requestedAt: new Date(createdAt.valueOf() + 25 * 60_000),
    dueAt: new Date(createdAt.valueOf() + 55 * 60_000),
  });
  if (status === "rejected" && index % 2 === 0) count += await ensureOperation({
    correlationId: `${version}:retry:${document.id}`,
    branchId: document.branchId,
    documentId: document.id,
    type: "retry",
    status: "pending",
    priority: "urgent",
    reason: "Cadastro corrigido e reprocessamento aguardando conector de homologação",
    requestedAt: new Date(createdAt.valueOf() + 42 * 60_000),
    dueAt: new Date(createdAt.valueOf() + 57 * 60_000),
  });
  return count;
}

async function seedInvalidation(branchId: number, now: Date) {
  return ensureOperation({
    correlationId: `${version}:invalidation:998:990999991-990999995`,
    branchId,
    documentId: null,
    type: "invalidation",
    status: "pending",
    priority: "normal",
    reason: "Faixa reservada em homologação e não utilizada durante treinamento",
    requestedAt: new Date(now.valueOf() - 35 * 60_000),
    dueAt: new Date(now.valueOf() + 25 * 60_000),
    details: { documentType: "nfe", series: 998, startNumber: 990999991, endNumber: 990999995 },
  });
}

async function ensureOperation(input: {
  correlationId: string;
  branchId: number;
  documentId: number | null;
  type: string;
  status: string;
  priority: string;
  reason: string;
  requestedAt: Date;
  dueAt: Date;
  resolvedAt?: Date | null;
  resolution?: string | null;
  details?: Prisma.InputJsonObject;
}) {
  if (await db.fiscalOperation.findUnique({ where: { correlationId: input.correlationId }, select: { id: true } })) return 0;
  await db.fiscalOperation.create({ data: {
    ...input,
    requestedBy: actor,
    resolvedBy: input.resolvedAt ? actor : null,
  } });
  return 1;
}

async function seedDemoCertificate(branchId: number, now: Date) {
  const raw = Buffer.concat([Buffer.from([0x30, 0x82, 0x04, 0x00]), Buffer.alloc(252, 7)]);
  const fingerprint = createHash("sha256").update(raw).digest("hex");
  if (await db.fiscalCertificate.findFirst({ where: { branchId, fingerprint }, select: { id: true } })) return;
  const hasActive = await db.fiscalCertificate.findFirst({ where: { branchId, active: true }, select: { id: true } });
  await db.fiscalCertificate.create({ data: {
    name: "[DEMO] A1 de homologação",
    branchId,
    encryptedContent: encryptSecret(raw.toString("base64")),
    encryptedPassword: encryptSecret("somente-demonstracao"),
    fingerprint,
    expiresAt: new Date(Date.UTC(now.getUTCFullYear() + 1, now.getUTCMonth(), now.getUTCDate())),
    active: !hasActive,
    createdBy: actor,
  } });
}

async function seedConnectorHealth(branches: Array<{ id: number }>, now: Date) {
  for (const branch of branches) {
    const provider = "demo-fiscal-simulator";
    const existing = await db.posConnector.findFirst({ where: { branchId: branch.id, registerId: null,
      type: "fiscal_nfe", provider }, select: { id: true } });
    if (!existing) await db.posConnector.create({ data: {
      branchId: branch.id,
      type: "fiscal_nfe",
      provider,
      mode: "server",
      status: "active",
      lastHealthOk: true,
      lastCheckedAt: now,
      settings: { environment: "homologation", demo: true },
    } });
  }
}

function rejection(index: number) {
  return [
    "Simulação: duplicidade de documento com diferença na chave de acesso.",
    "Simulação: falha de validação no schema do documento fiscal.",
    "Simulação: CSOSN incompatível com o regime tributário informado.",
  ][index % 3]!;
}

function eventDescription(status: string) {
  return ({ authorized: "Autorização simulada em homologação", queued: "Emissão aguardando conector na simulação",
    rejected: "Rejeição simulada para treinamento", contingency: "Contingência simulada em homologação",
    cancelled: "Cancelamento simulado em homologação", processing: "Processamento simulado pelo conector" } as Record<string, string>)[status] || "Estado demonstrativo";
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}).finally(async () => db.$disconnect());
