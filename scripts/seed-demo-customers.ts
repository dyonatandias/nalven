import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "../generated/tenant/client";

if (process.env.NALVEN_ALLOW_DEMO_CUSTOMER_SEED !== "1") throw new Error("Defina NALVEN_ALLOW_DEMO_CUSTOMER_SEED=1 para confirmar o seed demonstrativo de clientes.");
const connectionString = process.env.TENANT_DATABASE_URL;
if (!connectionString) throw new Error("TENANT_DATABASE_URL não foi definida.");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const actor = "Seed clientes NALVEN", now = new Date();
const day = (offset: number) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset, 12));

const definitions = [
  ["Ana Paula Martins", "PF", "VIP", "vip", "referral", "low", "Joinville", "SC", 8500],
  ["Comercial Vale Verde Ltda.", "PJ", "Vale Verde", "strategic", "website", "low", "Blumenau", "SC", 42000],
  ["Ricardo Nunes Ferreira", "PF", "", "standard", "store", "medium", "Chapecó", "SC", 2500],
  ["Frota Sul Transportes Ltda.", "PJ", "Frota Sul", "wholesale", "campaign", "medium", "Concórdia", "SC", 65000],
  ["Patrícia Gomes Alves", "PF", "", "vip", "website", "low", "Florianópolis", "SC", 12000],
  ["Agropecuária Horizonte Ltda.", "PJ", "Agro Horizonte", "strategic", "referral", "high", "Xanxerê", "SC", 52000],
  ["Lucas Henrique Ribeiro", "PF", "", "standard", "marketplace", "unrated", "São Miguel do Oeste", "SC", 1800],
  ["Oficina Central do Oeste Ltda.", "PJ", "Oficina Central", "wholesale", "store", "low", "Chapecó", "SC", 35000],
  ["Camila Rodrigues Lima", "PF", "", "standard", "campaign", "medium", "Erechim", "RS", 3200],
  ["Distribuidora Rota 282 Ltda.", "PJ", "Rota 282", "strategic", "website", "blocked", "Lages", "SC", 0],
  ["Fernando Costa Melo", "PF", "", "vip", "referral", "low", "Joaçaba", "SC", 9800],
  ["Cooperativa Serra Forte", "PJ", "Serra Forte", "strategic", "campaign", "medium", "Videira", "SC", 78000],
  ["Mariana Teixeira Prado", "PF", "", "standard", "website", "unrated", "Itajaí", "SC", 1500],
  ["Rede Auto Norte Ltda.", "PJ", "Auto Norte", "wholesale", "marketplace", "low", "Pato Branco", "PR", 47000],
  ["Gustavo Almeida Rocha", "PF", "", "standard", "store", "high", "Cascavel", "PR", 800],
  ["Serviços Técnicos Planalto Ltda.", "PJ", "Tec Planalto", "vip", "referral", "medium", "Passo Fundo", "RS", 27000],
  ["Renata Carvalho Dias", "PF", "", "vip", "campaign", "low", "Curitiba", "PR", 14000],
  ["Logística Caminhos do Sul S.A.", "PJ", "Caminhos do Sul", "strategic", "website", "low", "Porto Alegre", "RS", 120000],
  ["Bruno de Oliveira Santos", "PF", "", "standard", "marketplace", "unrated", "São José", "SC", 2200],
  ["Construtora Pedra Branca Ltda.", "PJ", "Pedra Branca", "wholesale", "referral", "medium", "Criciúma", "SC", 58000],
  ["Débora Freitas Moura", "PF", "", "standard", "store", "low", "Brusque", "SC", 4500],
  ["Grupo Mobilidade Oeste Ltda.", "PJ", "Mobilidade Oeste", "strategic", "campaign", "high", "Chapecó", "SC", 90000],
  ["Eduardo Lopes Batista", "PF", "", "vip", "website", "medium", "Jaraguá do Sul", "SC", 11000],
  ["Metalúrgica Pioneira Ltda.", "PJ", "Pioneira", "wholesale", "store", "low", "Caxias do Sul", "RS", 73000],
] as const;

async function main() {
  const [identity] = await db.$queryRaw<Array<{ database: string; role: string }>>(Prisma.sql`SELECT current_database() AS database, current_user AS role`);
  if (!identity || identity.database !== "nalven_t_demo" || identity.role !== "nalven_t_demo_runtime") throw new Error("O seed de clientes só pode executar em nalven_t_demo com a credencial runtime.");
  const tags = await Promise.all([
    ["Alto potencial", "#168151"], ["Cliente recorrente", "#347eac"], ["Atendimento prioritário", "#765eaf"], ["Revisão de crédito", "#bf6647"], ["Pós-venda", "#b28320"],
  ].map(([name, color]) => db.customerTag.upsert({ where: { name }, update: { color }, create: { name, color } })));
  for (const [index, definition] of definitions.entries()) {
    const [name, type, tradeName, segment, origin, riskRating, city, state, creditLimit] = definition, document = type === "PF" ? cpf(200_000_000 + index * 7919) : cnpj(40_000_000 + index * 3571);
    const shared = index === 8 || index === 18, email = index === 12 ? null : shared ? "contato.compartilhado@cliente.example" : `cliente${String(index + 1).padStart(2, "0")}@demo.example`, phone = index === 6 ? null : shared ? "49999998888" : `49${String(988000000 + index * 7733).slice(-9)}`;
    const createdAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (index % 6), 2 + index % 22, 12));
    const customer = await db.customer.upsert({
      where: { document },
      update: { name, type, tradeName: tradeName || null, email, phone, segment, origin, riskRating, creditLimit, salesperson: index % 3 === 0 ? "Marina Comercial" : index % 3 === 1 ? "Carlos Andrade" : "Equipe interna", paymentTermsDays: type === "PJ" ? 28 + index % 3 * 7 : index % 4 * 7, preferredChannel: index % 3 === 0 ? "whatsapp" : index % 3 === 1 ? "email" : "phone", status: index === 14 ? "inactive" : "active", createdAt },
      create: { name, type, tradeName: tradeName || null, document, email, phone, segment, origin, riskRating, creditLimit, salesperson: index % 3 === 0 ? "Marina Comercial" : index % 3 === 1 ? "Carlos Andrade" : "Equipe interna", paymentTermsDays: type === "PJ" ? 28 + index % 3 * 7 : index % 4 * 7, preferredChannel: index % 3 === 0 ? "whatsapp" : index % 3 === 1 ? "email" : "phone", status: index === 14 ? "inactive" : "active", notes: index % 5 === 0 ? "Acompanhar renovação e oportunidade de expansão no próximo ciclo." : null, createdAt },
    });
    const address = await db.customerAddress.findFirst({ where: { customerId: customer.id, primary: true } });
    const addressData = { label: "Principal", zip: `${String(89800000 + index * 113).padStart(8, "0")}`, street: index === 20 ? null : `Rua Demonstrativa ${index + 1}`, number: String(120 + index * 7), district: index % 2 ? "Centro" : "Industrial", city, state, primary: true };
    if (address) await db.customerAddress.update({ where: { id: address.id }, data: addressData }); else if (index !== 20) await db.customerAddress.create({ data: { customerId: customer.id, ...addressData } });
    const contactName = type === "PJ" ? ["Amanda Financeiro", "Paulo Compras", "Carolina Operações"][index % 3] : `${name.split(" ")[0]} · contato principal`;
    const contact = await db.customerContact.findFirst({ where: { customerId: customer.id, name: contactName } });
    if (!contact) await db.customerContact.create({ data: { customerId: customer.id, name: contactName, role: type === "PJ" ? ["Financeiro", "Compras", "Operações"][index % 3] : "Titular", email, phone, primary: true } });
    await db.customerTagLink.upsert({ where: { customerId_tagId: { customerId: customer.id, tagId: tags[index % tags.length].id } }, update: {}, create: { customerId: customer.id, tagId: tags[index % tags.length].id } });
    const subject = index % 4 === 0 ? "Revisar limite antes do próximo pedido" : index % 4 === 1 ? "Contato de pós-venda" : index % 4 === 2 ? "Apresentar campanha de reposição" : "Atualizar dados do responsável";
    if (!await db.customerInteraction.findFirst({ where: { customerId: customer.id, subject, createdBy: actor } })) await db.customerInteraction.create({ data: { customerId: customer.id, type: index % 4 === 0 ? "task" : index % 4 === 1 ? "call" : index % 4 === 2 ? "email" : "note", subject, notes: "Cenário demonstrativo do histórico de relacionamento.", dueAt: index % 3 === 0 ? day(index - 8) : day(index + 2), completedAt: index % 5 === 0 ? day(-1) : null, createdBy: actor, createdAt: day(-index) } });
    const purpose = index % 2 ? "marketing_email" : "marketing_whatsapp";
    if (!await db.customerConsent.findFirst({ where: { customerId: customer.id, purpose, source: actor } })) await db.customerConsent.create({ data: { customerId: customer.id, purpose, status: index % 7 === 0 ? "revoked" : "granted", legalBasis: "consent", channel: index % 2 ? "email" : "whatsapp", source: actor, proofReference: `TERM-DEMO-2026-${String(index + 1).padStart(3, "0")}`, recordedBy: actor, recordedAt: day(-40 + index) } });
    const amount = 680 + index * 437.5, titleStatus = index % 6 === 0 ? "partial" : index % 7 === 0 ? "paid" : "open", paidAmount = titleStatus === "paid" ? amount : titleStatus === "partial" ? Math.round(amount * .35 * 100) / 100 : 0;
    await db.financialTitle.upsert({ where: { sourceType_sourceId: { sourceType: "demo_customer", sourceId: `CUSTOMER-${index + 1}` } }, update: { customerId: customer.id, amount, paidAmount, status: titleStatus, dueAt: day(index % 4 === 0 ? -12 - index : 4 + index) }, create: { type: "receivable", description: `Recebível demonstrativo · ${tradeName || name}`, customerId: customer.id, sourceType: "demo_customer", sourceId: `CUSTOMER-${index + 1}`, amount, paidAmount, issueAt: day(-35), dueAt: day(index % 4 === 0 ? -12 - index : 4 + index), status: titleStatus, category: "Vendas", priority: index % 4 === 0 ? "high" : "normal", documentNumber: `CLI-${String(index + 1).padStart(4, "0")}`, notes: "Simulação para análise financeira da carteira." } });
    const orderTotal = 950 + index * 615.75, orderNumber = `PED-CLI-DEMO-${String(index + 1).padStart(3, "0")}`;
    await db.salesOrder.upsert({ where: { number: orderNumber }, update: { customerId: customer.id, customerName: tradeName || name, customerDocument: document, customerEmail: email, customerPhone: phone, total: orderTotal, subtotal: orderTotal, status: index % 5 === 0 ? "completed" : index % 4 === 0 ? "approved" : "processing", placedAt: day(-15 - index) }, create: { number: orderNumber, kind: "order", status: index % 5 === 0 ? "completed" : index % 4 === 0 ? "approved" : "processing", origin: index % 3 === 0 ? "marketplace" : "manual", customerId: customer.id, customerName: tradeName || name, customerDocument: document, customerEmail: email, customerPhone: phone, salesperson: "Equipe demo", subtotal: orderTotal, total: orderTotal, paymentMethod: index % 2 ? "pix" : "boleto", paymentTerms: type === "PJ" ? "28 dias" : "À vista", deliveryType: "carrier", deliveryCity: city, deliveryState: state, createdBy: actor, placedAt: day(-15 - index), createdAt: day(-15 - index) } });
    const opportunityTitle = `Expansão de carteira · ${tradeName || name}`;
    const opportunity = await db.crmOpportunity.findFirst({ where: { title: opportunityTitle, customerId: customer.id } });
    if (!opportunity) await db.crmOpportunity.create({ data: { title: opportunityTitle, company: tradeName || null, contactName, email, phone, customerId: customer.id, stage: ["lead", "qualified", "proposal", "negotiation"][index % 4], status: "open", value: 4500 + index * 725, probability: 20 + index % 4 * 20, source: origin, owner: "Equipe demo", expectedAt: day(15 + index), history: { create: { toStage: ["lead", "qualified", "proposal", "negotiation"][index % 4], actor } } } });
  }
  console.log(JSON.stringify({ database: identity.database, customers: definitions.length, tags: tags.length, simulations: ["carteira", "crédito", "inadimplência", "pedidos", "CRM", "tarefas", "consentimentos", "duplicidades"] }));
}

function cpf(base: number) { const digits = String(base).padStart(9, "0").slice(-9).split("").map(Number); const first = cpfDigit(digits, 10), second = cpfDigit([...digits, first], 11); return `${digits.join("")}${first}${second}`; }
function cpfDigit(digits: number[], weight: number) { const remainder = digits.reduce((sum, digit, index) => sum + digit * (weight - index), 0) % 11; return remainder < 2 ? 0 : 11 - remainder; }
function cnpj(base: number) { const root = `${String(base).padStart(8, "0").slice(-8)}0001`, first = cnpjDigit(root, [5,4,3,2,9,8,7,6,5,4,3,2]), second = cnpjDigit(`${root}${first}`, [6,5,4,3,2,9,8,7,6,5,4,3,2]); return `${root}${first}${second}`; }
function cnpjDigit(value: string, weights: number[]) { const remainder = weights.reduce((sum, weight, index) => sum + Number(value[index]) * weight, 0) % 11; return remainder < 2 ? 0 : 11 - remainder; }

main().finally(() => db.$disconnect());
