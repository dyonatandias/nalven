import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "../generated/tenant/client";

if (process.env.NALVEN_ALLOW_DEMO_CATEGORY_SEED !== "1") throw new Error("Defina NALVEN_ALLOW_DEMO_CATEGORY_SEED=1 para confirmar o seed demonstrativo de categorias.");
const connectionString = process.env.TENANT_DATABASE_URL;
if (!connectionString) throw new Error("TENANT_DATABASE_URL não foi definida.");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) }), actor = "Seed categorias NALVEN", now = new Date();

type Definition = { name: string; slug: string; code: string; type?: string; color: string; description?: string | null; parent?: string; visibility?: string; seo?: boolean; active?: boolean; order: number };
const definitions: Definition[] = [
  { name: "Peças e manutenção", slug: "pecas-e-manutencao", code: "CAT-PECAS", color: "#1f6d5a", description: "Componentes de reposição para manutenção preventiva e corretiva do veículo.", seo: true, order: 10 },
  { name: "Lubrificantes", slug: "lubrificantes", code: "CAT-LUB", color: "#247a52", description: "Óleos, aditivos e fluidos para proteção e desempenho do conjunto mecânico.", parent: "pecas-e-manutencao", seo: true, order: 10 },
  { name: "Filtros", slug: "filtros", code: "CAT-FILT", color: "#3579a8", description: "Filtros de óleo, ar, combustível e cabine para revisões periódicas.", parent: "pecas-e-manutencao", seo: true, order: 20 },
  { name: "Freios e suspensão", slug: "freios-e-suspensao", code: "CAT-FREIOS-SUSP", color: "#b4653d", description: "Segurança, estabilidade e controle para o sistema de frenagem e suspensão.", parent: "pecas-e-manutencao", seo: true, order: 30 },
  { name: "Freios", slug: "freios", code: "CAT-FREIOS", color: "#a75637", description: "Pastilhas, discos, lonas e componentes hidráulicos do sistema de freios.", parent: "freios-e-suspensao", seo: true, order: 10 },
  { name: "Motor e transmissão", slug: "motor-e-transmissao", code: "CAT-MOTOR", color: "#596b8d", description: "Componentes para motor, ignição, embreagem e transmissão.", parent: "pecas-e-manutencao", seo: true, order: 40 },
  { name: "Elétrica", slug: "eletrica", code: "CAT-ELET", color: "#8b6d24", description: "Iluminação, carga, partida, sensores e acessórios elétricos.", parent: "pecas-e-manutencao", seo: true, order: 50 },
  { name: "Cuidados e acessórios", slug: "cuidados-e-acessorios", code: "CAT-CUIDADOS", color: "#556e82", description: "Conforto, conservação, personalização e conveniência para o veículo.", seo: true, order: 20 },
  { name: "Acessórios", slug: "acessorios", code: "CAT-ACES", color: "#386d82", description: "Acessórios internos e externos para conforto e praticidade.", parent: "cuidados-e-acessorios", seo: true, order: 10 },
  { name: "Estética automotiva", slug: "estetica-automotiva", code: "CAT-EST", color: "#7d5b88", description: "Limpeza, proteção e acabamento para interior e exterior.", parent: "cuidados-e-acessorios", seo: true, order: 20 },
  { name: "Ferramentas", slug: "ferramentas", code: "CAT-FERR", color: "#7d5b38", description: "Ferramentas e equipamentos para manutenção e emergência.", parent: "cuidados-e-acessorios", seo: true, order: 30 },
  { name: "Serviços automotivos", slug: "servicos-automotivos", code: "CAT-SERV", type: "service", color: "#6b56a0", description: "Serviços técnicos, instalação e manutenção realizados pela oficina.", seo: true, order: 30 },
  { name: "Serviços", slug: "servicos", code: "CAT-MAO-OBRA", type: "service", color: "#735bb3", description: "Mão de obra especializada para diagnóstico, troca e instalação.", parent: "servicos-automotivos", seo: true, order: 10 },
  { name: "Diagnóstico eletrônico", slug: "diagnostico-eletronico", code: "CAT-DIAG", type: "service", color: "#4472a3", description: "Leitura de falhas, inspeção eletrônica e diagnóstico assistido.", parent: "servicos-automotivos", seo: true, order: 20 },
  { name: "Campanhas sazonais", slug: "campanhas-sazonais", code: "CAT-SAZONAL", color: "#b28320", description: null, visibility: "catalog", order: 40 },
  { name: "Catálogo legado", slug: "catalogo-legado", code: "CAT-LEGADO", color: "#75817d", description: "Estrutura preservada apenas para consulta histórica.", visibility: "hidden", active: false, order: 99 },
];

async function main() {
  const [identity] = await db.$queryRaw<Array<{ database: string; role: string }>>(Prisma.sql`SELECT current_database() AS database, current_user AS role`);
  if (!identity || identity.database !== "nalven_t_demo" || identity.role !== "nalven_t_demo_runtime") throw new Error("O seed de categorias só pode executar em nalven_t_demo com a credencial runtime.");
  const ids = new Map<string, number>();
  for (const [index, definition] of definitions.entries()) {
    const parentId = definition.parent ? ids.get(definition.parent) : null;
    if (definition.parent && !parentId) throw new Error(`Categoria superior ausente: ${definition.parent}`);
    const data = { name: definition.name, code: definition.code, type: definition.type || "product", color: definition.color, description: definition.description ?? null, parentId: parentId || null, visibility: definition.visibility || "visible", active: definition.active !== false, menuOrder: definition.order, seoTitle: definition.seo ? `${definition.name} | Auto Mais Peças` : null, seoDescription: definition.seo ? `${definition.description} Consulte aplicações, disponibilidade e condições na Auto Mais Peças.`.slice(0, 180) : null, seoNoindex: definition.visibility === "hidden", createdAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (index % 6), 3 + index % 20, 12)) };
    const existing = await db.category.findFirst({ where: { OR: [{ slug: definition.slug }, { name: definition.name }] }, select: { id: true } });
    const category = existing ? await db.category.update({ where: { id: existing.id }, data: { ...data, slug: definition.slug } }) : await db.category.create({ data: { ...data, slug: definition.slug } });
    ids.set(definition.slug, category.id);
  }
  const templates: Array<[string, string, string, boolean, string[], string | null]> = [
    ["lubrificantes", "Viscosidade SAE", "select", true, ["0W20", "5W30", "10W40", "15W40"], null], ["lubrificantes", "Volume", "number", true, [], "L"],
    ["filtros", "Aplicação veicular", "text", true, [], null], ["filtros", "Material filtrante", "select", false, ["Celulose", "Sintético", "Carvão ativado"], null],
    ["freios-e-suspensao", "Posição", "select", true, ["Dianteira", "Traseira", "Ambos"], null], ["freios", "Diâmetro", "number", false, [], "mm"],
    ["motor-e-transmissao", "Código OEM", "text", true, [], null], ["eletrica", "Tensão", "select", true, ["12 V", "24 V", "Bivolt"], null],
    ["acessorios", "Compatibilidade", "text", true, [], null], ["estetica-automotiva", "Volume", "number", true, [], "ml"],
    ["ferramentas", "Garantia", "number", false, [], "meses"], ["servicos", "Tempo padrão", "number", true, [], "min"], ["diagnostico-eletronico", "Tipo de veículo", "select", true, ["Leve", "Utilitário", "Pesado"], null],
  ];
  for (const [index, row] of templates.entries()) { const [slug, name, type, required, options, unit] = row, categoryId = ids.get(slug); if (!categoryId) continue; await db.categoryAttributeTemplate.upsert({ where: { categoryId_name: { categoryId, name } }, update: { type, required, options, unit, sortOrder: index, active: true }, create: { categoryId, name, type, required, options, unit, sortOrder: index } }); }
  const mappings: Array<[string, string, string, string, string]> = [
    ["lubrificantes", "mercado_livre", "MLB194309", "Óleos de Motor", "mapped"], ["lubrificantes", "amazon", "automotive-oils", "Motor Oils", "mapped"],
    ["filtros", "mercado_livre", "MLB193862", "Filtros Automotivos", "mapped"], ["freios-e-suspensao", "mercado_livre", "MLB1955", "Freios e Suspensão", "mapped"],
    ["motor-e-transmissao", "amazon", "automotive-engine-parts", "Engine Parts", "pending"], ["eletrica", "shopee", "100638", "Peças Elétricas", "mapped"],
    ["acessorios", "mercado_livre", "MLB1748", "Acessórios para Veículos", "mapped"], ["estetica-automotiva", "shopee", "100651", "Cuidados Automotivos", "mapped"],
    ["ferramentas", "amazon", "tools-automotive", "Automotive Tools", "error"],
  ];
  for (const [slug, platform, remoteCategoryId, remoteCategoryName, status] of mappings) { const categoryId = ids.get(slug); if (!categoryId) continue; await db.categoryMarketplaceMapping.upsert({ where: { categoryId_platform: { categoryId, platform } }, update: { remoteCategoryId, remoteCategoryName, status, updatedBy: actor }, create: { categoryId, platform, remoteCategoryId, remoteCategoryName, status, updatedBy: actor } }); }
  await db.reportSettings.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
  for (const [index, slug] of ["lubrificantes", "filtros", "freios-e-suspensao", "motor-e-transmissao", "eletrica", "acessorios", "estetica-automotiva", "ferramentas"].entries()) { const categoryId = ids.get(slug); if (!categoryId) continue; await db.categoryPricingOverride.upsert({ where: { categoryId }, update: { targetMargin: 31 + index % 4 * 3, minimumMargin: 16 + index % 3 * 2 }, create: { categoryId, targetMargin: 31 + index % 4 * 3, minimumMargin: 16 + index % 3 * 2 } }); }
  const products = await db.product.findMany({ orderBy: { id: "asc" }, take: 60 });
  for (const product of products) {
    const category = await db.category.findFirst({ where: { name: product.category }, select: { id: true, name: true } });
    if (!category) continue;
    await db.product.update({ where: { id: product.id }, data: { categoryId: category.id } });
    await db.productCategoryLink.upsert({ where: { productId_categoryId: { productId: product.id, categoryId: category.id } }, update: { primary: true }, create: { productId: product.id, categoryId: category.id, primary: true } });
    if (product.id % 9 === 0) { const cross = ids.get("campanhas-sazonais"); if (cross) await db.productCategoryLink.upsert({ where: { productId_categoryId: { productId: product.id, categoryId: cross } }, update: {}, create: { productId: product.id, categoryId: cross, primary: false } }); }
  }
  console.log(JSON.stringify({ database: identity.database, categories: definitions.length, templates: templates.length, mappings: mappings.length, simulations: ["hierarquia", "SEO", "visibilidade", "atributos", "marketplaces", "margens", "multicategoria", "categoria vazia"] }));
}

main().finally(() => db.$disconnect());
