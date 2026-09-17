import { createHash } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "../generated/tenant/client";

if (process.env.NALVEN_ALLOW_DEMO_LIBRARY_SEED !== "1")
  throw new Error(
    "Defina NALVEN_ALLOW_DEMO_LIBRARY_SEED=1 para confirmar o seed demonstrativo da biblioteca.",
  );
const connectionString = process.env.TENANT_DATABASE_URL;
if (!connectionString) throw new Error("TENANT_DATABASE_URL não foi definida.");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const folders = [
  { name: "Campanhas", slug: "campanhas", color: "#b47a28" },
  { name: "Documentos fiscais", slug: "documentos-fiscais", color: "#5b6ea8" },
  {
    name: "Identidade da marca",
    slug: "identidade-da-marca",
    color: "#8d5aa8",
  },
  { name: "Treinamento", slug: "treinamento", color: "#347aa2" },
  { name: "Operação", slug: "operacao", color: "#247b5b" },
];

type DemoAsset = {
  code: string;
  name: string;
  originalName: string;
  mimeType: string;
  kind: "image" | "document" | "video";
  sizeBytes: number;
  remoteUrl: string;
  folder: string;
  description: string;
  altText?: string;
  tags: string[];
  deleted?: boolean;
  expiresAt?: string;
  duplicateKey?: string;
};

const assets: DemoAsset[] = [
  {
    code: "001",
    name: "Banner revisão preventiva — primavera",
    originalName: "banner-revisao-primavera.jpg",
    mimeType: "image/jpeg",
    kind: "image",
    sizeBytes: 1_284_000,
    remoteUrl:
      "https://images.unsplash.com/photo-1486262715619-67b85e0b08d3?auto=format&fit=crop&w=1400&q=82",
    folder: "Campanhas",
    description:
      "Peça principal da campanha de revisão preventiva para site e redes sociais.",
    altText: "Mecânico realizando revisão preventiva em oficina automotiva",
    tags: ["campanha", "primavera", "revisão", "site"],
    expiresAt: "2026-11-30",
  },
  {
    code: "002",
    name: "Story troca de óleo",
    originalName: "story-troca-oleo.jpg",
    mimeType: "image/jpeg",
    kind: "image",
    sizeBytes: 864_000,
    remoteUrl:
      "https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&w=900&q=82",
    folder: "Campanhas",
    description: "Criativo vertical aprovado para campanha de troca de óleo.",
    altText: "Automóvel em estrada representando cuidado e manutenção",
    tags: ["campanha", "social", "óleo"],
  },
  {
    code: "003",
    name: "Capa institucional Auto Mais",
    originalName: "capa-institucional.jpg",
    mimeType: "image/jpeg",
    kind: "image",
    sizeBytes: 1_120_000,
    remoteUrl:
      "https://images.unsplash.com/photo-1493238792000-8113da705763?auto=format&fit=crop&w=1400&q=82",
    folder: "Identidade da marca",
    description: "Imagem institucional para apresentações comerciais.",
    altText: "Automóvel moderno em ambiente urbano",
    tags: ["marca", "institucional", "apresentação"],
  },
  {
    code: "004",
    name: "Foto oficina — recepção",
    originalName: "oficina-recepcao.jpg",
    mimeType: "image/jpeg",
    kind: "image",
    sizeBytes: 978_000,
    remoteUrl:
      "https://images.unsplash.com/photo-1625047509248-ec889cbff17f?auto=format&fit=crop&w=1400&q=82",
    folder: "Identidade da marca",
    description: "Registro da recepção usado no perfil da unidade.",
    altText: "Área organizada de atendimento de oficina",
    tags: ["marca", "unidade", "institucional"],
  },
  {
    code: "005",
    name: "Tabela de preços para parceiros",
    originalName: "precos-parceiros.csv",
    mimeType: "text/csv",
    kind: "document",
    sizeBytes: 42_300,
    remoteUrl:
      "https://raw.githubusercontent.com/cs109/2014_data/master/countries.csv",
    folder: "Operação",
    description:
      "Modelo demonstrativo de tabela de preços para canais parceiros.",
    tags: ["preços", "parceiros", "operação"],
  },
  {
    code: "006",
    name: "Manual de recebimento fiscal",
    originalName: "manual-recebimento-fiscal.pdf",
    mimeType: "application/pdf",
    kind: "document",
    sizeBytes: 132_600,
    remoteUrl:
      "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
    folder: "Documentos fiscais",
    description:
      "Procedimento operacional para conferência e entrada de documentos fiscais.",
    tags: ["fiscal", "procedimento", "nfe"],
  },
  {
    code: "007",
    name: "Guia de identidade visual",
    originalName: "guia-identidade-v3.pdf",
    mimeType: "application/pdf",
    kind: "document",
    sizeBytes: 132_600,
    remoteUrl:
      "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
    folder: "Identidade da marca",
    description: "Versão vigente do manual de aplicação da marca Auto Mais.",
    tags: ["marca", "manual", "aprovado"],
  },
  {
    code: "008",
    name: "Checklist abertura da loja",
    originalName: "checklist-abertura.txt",
    mimeType: "text/plain",
    kind: "document",
    sizeBytes: 12_800,
    remoteUrl:
      "https://raw.githubusercontent.com/github/gitignore/main/README.md",
    folder: "Operação",
    description: "Checklist de referência para preparação diária da unidade.",
    tags: ["checklist", "loja", "operação"],
  },
  {
    code: "009",
    name: "Treinamento — segurança na oficina",
    originalName: "treinamento-seguranca.mp4",
    mimeType: "video/mp4",
    kind: "video",
    sizeBytes: 2_500_000,
    remoteUrl:
      "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4",
    folder: "Treinamento",
    description:
      "Vídeo demonstrativo da trilha de segurança para a equipe técnica.",
    tags: ["treinamento", "segurança", "oficina"],
  },
  {
    code: "010",
    name: "Treinamento — atendimento consultivo",
    originalName: "atendimento-consultivo.mp4",
    mimeType: "video/mp4",
    kind: "video",
    sizeBytes: 3_200_000,
    remoteUrl:
      "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4",
    folder: "Treinamento",
    description:
      "Conteúdo demonstrativo para padronizar a jornada de atendimento.",
    tags: ["treinamento", "atendimento", "vendas"],
  },
  {
    code: "011",
    name: "Banner revisão preventiva — cópia",
    originalName: "banner-revisao-copia.jpg",
    mimeType: "image/jpeg",
    kind: "image",
    sizeBytes: 1_284_000,
    remoteUrl:
      "https://images.unsplash.com/photo-1486262715619-67b85e0b08d3?auto=format&fit=crop&w=1400&q=82",
    folder: "Campanhas",
    description: "Cópia intencional para demonstrar a detecção de duplicidade.",
    altText: "Mecânico realizando revisão preventiva em oficina automotiva",
    tags: ["campanha", "duplicado"],
    duplicateKey: "campaign-duplicate",
  },
  {
    code: "012",
    name: "Banner revisão preventiva — backup",
    originalName: "banner-revisao-backup.jpg",
    mimeType: "image/jpeg",
    kind: "image",
    sizeBytes: 1_284_000,
    remoteUrl:
      "https://images.unsplash.com/photo-1486262715619-67b85e0b08d3?auto=format&fit=crop&w=1400&q=82",
    folder: "Campanhas",
    description:
      "Backup redundante mantido para simular oportunidade de limpeza.",
    altText: "Mecânico realizando revisão preventiva em oficina automotiva",
    tags: ["campanha", "duplicado"],
    duplicateKey: "campaign-duplicate",
  },
  {
    code: "013",
    name: "Campanha de inverno encerrada",
    originalName: "campanha-inverno-encerrada.jpg",
    mimeType: "image/jpeg",
    kind: "image",
    sizeBytes: 912_000,
    remoteUrl:
      "https://images.unsplash.com/photo-1542362567-b07e54358753?auto=format&fit=crop&w=1200&q=80",
    folder: "Campanhas",
    description:
      "Material encerrado disponível na lixeira para demonstrar restauração.",
    altText: "Automóvel em cenário de inverno",
    tags: ["campanha", "inverno", "encerrada"],
    deleted: true,
  },
  {
    code: "014",
    name: "Procedimento operacional antigo",
    originalName: "procedimento-antigo.pdf",
    mimeType: "application/pdf",
    kind: "document",
    sizeBytes: 132_600,
    remoteUrl:
      "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
    folder: "Operação",
    description: "Documento substituído, mantido na lixeira para a simulação.",
    tags: ["procedimento", "legado"],
    deleted: true,
  },
];

async function main() {
  const [identity] = await db.$queryRaw<
    Array<{ database: string; role: string }>
  >(Prisma.sql`SELECT current_database() AS database, current_user AS role`);
  if (
    !identity ||
    identity.database !== "nalven_t_demo" ||
    identity.role !== "nalven_t_demo_runtime"
  )
    throw new Error(
      "O seed da biblioteca só pode executar em nalven_t_demo com a credencial runtime.",
    );
  const profile = await db.tenantUserProfile.findFirst({
    where: { status: "active" },
    orderBy: { id: "asc" },
    select: { userId: true, displayName: true },
  });
  if (!profile) throw new Error("O seed exige um perfil ativo.");
  for (const folder of folders)
    await db.mediaFolder.upsert({
      where: { slug: folder.slug },
      update: { name: folder.name, color: folder.color },
      create: { ...folder, system: false, createdBy: "Seed Biblioteca NALVEN" },
    });

  const created = new Map<string, string>();
  for (const [index, item] of assets.entries()) {
    const extension = item.originalName.split(".").pop();
    const storageKey = `20000000-0000-4000-${item.code.padStart(4, "8")}-${String(index + 1).padStart(12, "0")}.${extension}`;
    const checksum = createHash("sha256")
      .update(item.duplicateKey || item.remoteUrl)
      .digest("hex");
    const values = {
      name: item.name,
      originalName: item.originalName,
      mimeType: item.mimeType,
      kind: item.kind,
      sizeBytes: item.sizeBytes,
      checksum,
      remoteUrl: item.remoteUrl,
      localAvailable: false,
      altText: item.altText || "",
      description: item.description,
      tags: item.tags,
      folder: item.folder,
      source: "seed",
      expiresAt: item.expiresAt
        ? new Date(`${item.expiresAt}T23:59:59.999Z`)
        : null,
      deletedAt: item.deleted ? new Date("2026-08-28T15:00:00.000Z") : null,
      uploadedById: profile.userId,
      uploadedByName: profile.displayName,
    };
    const asset = await db.tenantMediaAsset.upsert({
      where: { storageKey },
      update: values,
      create: { storageKey, ...values },
    });
    created.set(item.code, asset.id);
  }

  for (const code of ["001", "006", "007", "009"]) {
    const assetId = created.get(code);
    if (assetId)
      await db.mediaAssetFavorite.upsert({
        where: { assetId_userId: { assetId, userId: profile.userId } },
        update: {},
        create: { assetId, userId: profile.userId },
      });
  }
  const guideId = created.get("007");
  if (guideId) {
    await db.tenantMediaAsset.update({
      where: { id: guideId },
      data: { version: 3 },
    });
    for (const version of [1, 2])
      await db.mediaAssetVersion.upsert({
        where: { assetId_version: { assetId: guideId, version } },
        update: {
          changeNote:
            version === 1
              ? "Primeira versão do manual."
              : "Atualização de cores e área de proteção.",
        },
        create: {
          assetId: guideId,
          version,
          storageKey: `21000000-0000-4000-8007-${String(version).padStart(12, "0")}.pdf`,
          originalName: `guia-identidade-v${version}.pdf`,
          mimeType: "application/pdf",
          kind: "document",
          sizeBytes: 132_600,
          checksum: createHash("sha256")
            .update(`brand-guide-v${version}`)
            .digest("hex"),
          remoteUrl:
            "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
          localAvailable: false,
          changeNote:
            version === 1
              ? "Primeira versão do manual."
              : "Atualização de cores e área de proteção.",
          uploadedById: profile.userId,
          uploadedByName: profile.displayName,
          createdAt: new Date(`2026-0${version + 4}-10T14:00:00.000Z`),
        },
      });
  }

  const existing = await db.tenantMediaAsset.findMany({
    where: { source: "catalog", deletedAt: null },
    orderBy: { createdAt: "asc" },
    take: 60,
    select: { id: true, name: true },
  });
  const tagSets = [
    ["catálogo", "produto", "principal"],
    ["catálogo", "produto", "detalhe"],
    ["catálogo", "produto", "ambientada"],
  ];
  for (const [index, asset] of existing.entries())
    await db.tenantMediaAsset.update({
      where: { id: asset.id },
      data: {
        description: `Imagem demonstrativa do catálogo: ${asset.name}. Pronta para uso em produto e marketplace.`,
        tags: tagSets[index % tagSets.length],
        source: "catalog",
      },
    });
  console.log(
    JSON.stringify({
      database: identity.database,
      folders: folders.length,
      assets: assets.length,
      favorites: 4,
      versions: 2,
      enrichedCatalogAssets: existing.length,
      simulations: [
        "imagens",
        "documentos",
        "vídeos",
        "favoritos",
        "etiquetas",
        "duplicidade",
        "expiração",
        "lixeira",
        "versionamento",
        "uso e limpeza",
      ],
    }),
  );
}

main().finally(() => db.$disconnect());
