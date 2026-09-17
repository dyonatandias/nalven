import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "../generated/tenant/client";
import { preparePosT2CatalogBoundary, toPosT2BoundaryIdempotencyKey } from "../lib/erp/pos-t2-boundary";

const ACCESS_KEY = "33260906328612000275550040000473981543674922";
const RECIPIENT_DOCUMENT = "62119228000152";
const SUPPLIER_DOCUMENT = "06328612000275";
const SUPPLIER_NAME = "W GEAR INDUSTRIA E COMERCIO DE ROUPAS LTDA";
const CONFIRMATION = `DANFE-PROVISION:${ACCESS_KEY}`;

type DanfeItem = { supplierCode: string; description: string; ncm: string; quantity: number; unitCost: number };

const items: DanfeItem[] = [
  ["010241590481713", "CAMISA CYCLONE LOC. VINTAGE FORCE METAL VERMELHO RUBRO/G", "61051000", 1, 68.13],
  ["010241590481714", "CAMISA CYCLONE LOC. VINTAGE FORCE METAL VERMELHO RUBRO/GG", "61051000", 1, 68.13],
  ["010241590481715", "CAMISA CYCLONE LOC. VINTAGE FORCE METAL VERMELHO RUBRO/3G", "61051000", 1, 68.13],
  ["010241591382713", "CAMISA CYCLONE LOC. VINTAGE FORCE METAL AZUL FRANÇA/G", "61051000", 1, 68.13],
  ["010241591382714", "CAMISA CYCLONE LOC. VINTAGE FORCE METAL AZUL FRANÇA/GG", "61051000", 1, 68.13],
  ["010241860118713", "CAMISA CYCLONE LOC. MILITARY JOKER METAL BRANCO/G", "61051000", 1, 68.13],
  ["010241860118714", "CAMISA CYCLONE LOC. MILITARY JOKER METAL BRANCO/GG", "61051000", 1, 68.13],
  ["010241860118715", "CAMISA CYCLONE LOC. MILITARY JOKER METAL BRANCO/3G", "61051000", 1, 68.13],
  ["010241860346712", "CAMISA CYCLONE LOC. MILITARY JOKER METAL PRETO/M", "61051000", 1, 68.13],
  ["010241860346715", "CAMISA CYCLONE LOC. MILITARY JOKER METAL PRETO/3G", "61051000", 1, 68.13],
  ["010241870118711", "CAMISA CYCLONE LOC. RASTAFARI LOGO METAL BRANCO/P", "61051000", 1, 68.13],
  ["010241870118712", "CAMISA CYCLONE LOC. RASTAFARI LOGO METAL BRANCO/M", "61051000", 1, 68.13],
  ["010241870118713", "CAMISA CYCLONE LOC. RASTAFARI LOGO METAL BRANCO/G", "61051000", 1, 68.13],
  ["010241870118715", "CAMISA CYCLONE LOC. RASTAFARI LOGO METAL BRANCO/3G", "61051000", 1, 68.13],
  ["010241870118716", "CAMISA CYCLONE LOC. RASTAFARI LOGO METAL BRANCO/4G", "61051000", 1, 68.13],
  ["010241870118717", "CAMISA CYCLONE LOC. RASTAFARI LOGO METAL BRANCO/5G", "61051000", 1, 68.13],
  ["010241870346711", "CAMISA CYCLONE LOC. RASTAFARI LOGO METAL PRETO/P", "61051000", 1, 68.13],
  ["010241870346712", "CAMISA CYCLONE LOC. RASTAFARI LOGO METAL PRETO/M", "61051000", 1, 68.13],
  ["010241870346713", "CAMISA CYCLONE LOC. RASTAFARI LOGO METAL PRETO/G", "61051000", 1, 68.13],
  ["010241870346714", "CAMISA CYCLONE LOC. RASTAFARI LOGO METAL PRETO/GG", "61051000", 1, 68.13],
  ["010241870346716", "CAMISA CYCLONE LOC. RASTAFARI LOGO METAL PRETO/4G", "61051000", 1, 68.13],
  ["010241870346717", "CAMISA CYCLONE LOC. RASTAFARI LOGO METAL PRETO/5G", "61051000", 1, 68.13],
  ["012117890346713", "REGATA CYCLONE DIF. FULL RASTAFARI LOGO PRETO/G", "61051000", 1, 65.86],
  ["012117890346714", "REGATA CYCLONE DIF. FULL RASTAFARI LOGO PRETO/GG", "61051000", 1, 65.86],
  ["012117890346715", "REGATA CYCLONE DIF. FULL RASTAFARI LOGO PRETO/3G", "61051000", 1, 65.86],
  ["054049200346758", "BONE CYCLONE MICROFIBRA CASH PRETO/U", "65069900", 2, 87.43],
  ["054049230346758", "BONE CYCLONE MICROFIBRA RASTAFARI LOGO PRETO/U", "65069900", 3, 87.43],
  ["054049330118758", "BONE CYCLONE MICROFIBRA SCORPION VER 27 BRANCO/U", "65069900", 3, 89.13],
  ["054049390346758", "BONE CYCLONE VELUDO CASH PRETO/U", "65069900", 1, 96.52],
  ["054049430346758", "BONE CYCLONE ABA CURVA 3D RASTA PRETO/U", "65069900", 2, 87.43],
  ["054049450118758", "BONE CYCLONE ABA CURVA CORDUROY STYLE BRANCO/U", "65069900", 2, 85.17],
].map(([supplierCode, description, ncm, quantity, unitCost]) => ({ supplierCode, description, ncm, quantity, unitCost })) as DanfeItem[];

function slugify(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 150);
}

function withoutAccents(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

async function main() {
  if (process.env.NALVEN_CONFIRM_SCALON_WGEAR_DANFE !== CONFIRMATION) throw new Error("Confirmação operacional ausente ou inválida.");
  const tenant = parseEnv(readFileSync("/etc/nalven/tenants/scalon-modas.env", "utf8"));
  const connectionString = tenant.TENANT_DATABASE_URL || "";
  const parsedDsn = new URL(connectionString);
  if (decodeURIComponent(parsedDsn.pathname) !== "/nalven_t_scalon_modas" || decodeURIComponent(parsedDsn.username) !== "nalven_t_scalon_modas_runtime") throw new Error("Autoridade ou banco inesperado.");
  if (items.length !== 31 || new Set(items.map(item => item.supplierCode)).size !== items.length) throw new Error("Relação de itens do DANFE inválida.");
  const total = items.reduce((sum, item) => sum + item.quantity * item.unitCost, 0);
  const units = items.reduce((sum, item) => sum + item.quantity, 0);
  if (Math.abs(total - 2842.70) > 0.001 || units !== 38) throw new Error("Totais do DANFE não conferem.");

  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  try {
    const result = await db.$transaction(async tx => {
      await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`danfe-provision:${ACCESS_KEY}`}))`);
      const branch = await tx.branch.findUnique({ where: { id: 1 }, select: { id: true, document: true, status: true } });
      if (!branch || branch.status !== "active" || branch.document.replace(/\D/g, "") !== RECIPIENT_DOCUMENT) throw new Error("Filial destinatária inesperada.");
      const actor = await tx.tenantUserProfile.findFirst({ where: { status: "active" }, orderBy: { id: "asc" }, select: { userId: true, displayName: true } });
      if (!actor) throw new Error("Usuário ativo não encontrado para auditoria.");

      const supplier = await tx.supplier.upsert({
        where: { document: SUPPLIER_DOCUMENT },
        update: { name: SUPPLIER_NAME, stateRegistration: "86539047", phone: "2133889999", category: "goods", status: "active" },
        create: { name: SUPPLIER_NAME, document: SUPPLIER_DOCUMENT, stateRegistration: "86539047", phone: "2133889999", category: "goods", origin: "invoice", homologationStatus: "pending", status: "active", notes: `Cadastro provisório pelo DANFE NF-e 47398/4; validar com o XML autorizado ${ACCESS_KEY}.` },
        select: { id: true },
      });
      if (!await tx.supplierAddress.findFirst({ where: { supplierId: supplier.id }, select: { id: true } })) {
        await tx.supplierAddress.create({ data: { supplierId: supplier.id, label: "Fiscal (DANFE · revisar)", zip: "22640101", street: "AVENIDA DAS AMERICAS", number: "2000", complement: "LOJA 65 B", district: "BARRA DA TIJUCA", city: "RIO DE JANEIRO", state: "RJ", primary: true } });
      }

      let created = 0;
      let reused = 0;
      let corrected = 0;
      for (const item of items) {
        const priorLink = await tx.supplierProduct.findFirst({ where: { supplierId: supplier.id, supplierCode: item.supplierCode }, include: { product: { select: { id: true, name: true, sku: true, active: true, gtin: true, manageStock: true, type: true, status: true, unit: true, posRevision: true, posConfigHash: true } } } });
        if (priorLink) {
          if (priorLink.product.sku !== item.supplierCode || withoutAccents(priorLink.product.name) !== withoutAccents(item.description)) throw new Error(`Conflito no código do fornecedor ${item.supplierCode}.`);
          if (priorLink.product.name !== item.description) {
            const boundary = await preparePosT2CatalogBoundary(tx, {
              action: "put_graph", productId: priorLink.product.id, expectedProductRevision: priorLink.product.posRevision, expectedProductConfigHash: priorLink.product.posConfigHash,
              productProjection: { active: priorLink.product.active, gtinSnapshot: priorLink.product.gtin, manageStock: priorLink.product.manageStock, nameLabel: item.description, productType: priorLink.product.type, skuSnapshot: priorLink.product.sku, status: priorLink.product.status, unit: priorLink.product.unit },
              variations: [], actorUserId: actor.userId, idempotencyKey: toPosT2BoundaryIdempotencyKey(`danfe-47398-product-name-v2:${item.supplierCode}`),
            });
            await tx.product.update({ where: { id: priorLink.product.id }, data: { name: item.description, posRevision: boundary.productRevision, posConfigHash: boundary.productConfigHash } });
            corrected++;
          }
          await tx.supplierProduct.update({ where: { id: priorLink.id }, data: { lastCost: item.unitCost, preferred: true } });
          reused++;
          continue;
        }
        if (await tx.product.findFirst({ where: { sku: item.supplierCode }, select: { id: true } })) throw new Error(`SKU já existe sem vínculo seguro: ${item.supplierCode}.`);
        const boundary = await preparePosT2CatalogBoundary(tx, {
          action: "put_graph",
          productId: null,
          expectedProductRevision: null,
          expectedProductConfigHash: null,
          productProjection: { active: true, gtinSnapshot: null, manageStock: true, nameLabel: item.description, productType: "product", skuSnapshot: item.supplierCode, status: "draft", unit: "PC" },
          variations: [],
          actorUserId: actor.userId,
          idempotencyKey: toPosT2BoundaryIdempotencyKey(`danfe-47398-product-v1:${item.supplierCode}`),
        });
        const product = boundary.replayed
          ? await tx.product.findUniqueOrThrow({ where: { id: boundary.productId }, select: { id: true } })
          : await tx.product.create({ data: {
              id: boundary.productId,
              posRevision: boundary.productRevision,
              posConfigHash: boundary.productConfigHash,
              name: item.description,
              slug: slugify(`${item.description}-${item.supplierCode}`),
              sku: item.supplierCode,
              type: "product",
              catalogType: "simple",
              status: "draft",
              catalogVisibility: "hidden",
              active: true,
              price: 0,
              regularPrice: 0,
              cost: item.unitCost,
              cogs: item.unitCost,
              category: "Importado do DANFE · revisar",
              supplier: SUPPLIER_NAME,
              stock: 0,
              manageStock: true,
              stockStatus: "outofstock",
              unit: "PC",
              ncm: item.ncm,
              cestNotApplicable: true,
              origin: "0",
              fiscalType: "product",
              taxStatus: "taxable",
              condition: "new",
              purchaseNote: `Cadastro provisório pelo DANFE NF-e 47398/4, chave ${ACCESS_KEY}. Validar com o XML autorizado antes de receber estoque. Quantidade informada no DANFE: ${item.quantity}.`,
              onboardingStatus: "pending",
              onboardingSource: "danfe_provisional",
              onboardingMissingFields: ["xml_authorized", "sale_price", "image", "category_review", "gtin"],
            }, select: { id: true } });
        await tx.supplierProduct.create({ data: { supplierId: supplier.id, productId: product.id, supplierCode: item.supplierCode, lastCost: item.unitCost, preferred: true } });
        created++;
      }

      const linked = await tx.supplierProduct.count({ where: { supplierId: supplier.id, supplierCode: { in: items.map(item => item.supplierCode) } } });
      if (linked !== 31) throw new Error(`Vínculos incompletos após o cadastro: ${linked}/31.`);
      const auditData = { source: "danfe_provisional", supplierId: supplier.id, itemLines: 31, physicalUnits: 38, documentTotal: 2842.70, createdProducts: created, reusedProducts: reused, correctedProducts: corrected, stockMoved: false, xmlAuthorizedStored: false };
      const priorAudit = await tx.tenantAuditEvent.findFirst({ where: { action: "dfe.danfe_catalog.provisioned", entityType: "nfe_access_key", entityId: ACCESS_KEY }, orderBy: { createdAt: "asc" }, select: { id: true } });
      if (!priorAudit) await tx.tenantAuditEvent.create({ data: { actorId: actor.userId, action: "dfe.danfe_catalog.provisioned", entityType: "nfe_access_key", entityId: ACCESS_KEY, afterData: auditData } });
      return { supplierId: supplier.id, created, reused, corrected, linked, units, total };
    }, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 120_000 });
    console.log(JSON.stringify(result));
  } finally {
    await db.$disconnect();
  }
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : "Falha inesperada");
  process.exitCode = 1;
});
