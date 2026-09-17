import { PrismaPg } from "@prisma/adapter-pg";
import { createHash, randomBytes } from "node:crypto";
import { Prisma, PrismaClient } from "../../generated/tenant/client";
import {
  defaultEmailContent,
  TRANSACTIONAL_EMAIL_CATALOG,
} from "../../lib/integrations/transactional-email-catalog";

const url = process.env.TENANT_DATABASE_URL;
if (!url) throw new Error("TENANT_DATABASE_URL não foi definida");
const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: url }),
});

const catalogProductNames = [
  "Óleo Sintético Performance",
  "Óleo Semissintético Urban",
  "Fluido de Freio DOT 4",
  "Aditivo Radiador Concentrado",
  "Fluido ATF Multiveículos",
  "Filtro de Óleo Premium",
  "Filtro de Ar Motor",
  "Filtro de Combustível",
  "Filtro de Cabine Carvão Ativado",
  "Kit Filtros Revisão",
  "Pastilha de Freio Cerâmica",
  "Disco de Freio Ventilado",
  "Sapata de Freio Traseira",
  "Amortecedor Pressurizado",
  "Kit Batente Amortecedor",
  "Bieleta Estabilizadora",
  "Pivô de Suspensão",
  "Terminal de Direção",
  "Cubo de Roda com Rolamento",
  "Junta Homocinética",
  "Vela de Ignição Resistiva",
  "Jogo de Cabos de Vela",
  "Lâmpada Farol Super Branca",
  "Lâmpada LED Automotiva",
  "Fusível Lâmina Kit",
  "Relé Auxiliar Automotivo",
  "Sensor de Estacionamento",
  "Carregador Veicular USB",
  "Cabo de Transferência de Carga",
  "Terminal para Bateria",
  "Palheta Limpador Aerodinâmica",
  "Tapete Automotivo Universal",
  "Organizador de Porta-malas",
  "Capa Protetora para Banco",
  "Suporte Magnético Celular",
  "Pano Microfibra Premium",
  "Shampoo Automotivo Neutro",
  "Cera Líquida de Carnaúba",
  "Limpa Vidros Automotivo",
  "Revitalizador de Plásticos",
  "Chave de Roda Reforçada",
  "Macaco Hidráulico Compacto",
  "Calibrador Digital de Pneus",
  "Compressor de Ar Portátil",
  "Kit Reparo de Pneu",
  "Manômetro para Pneus",
  "Cabo de Reboque Reforçado",
  "Triângulo de Segurança",
  "Lanterna Automotiva Recarregável",
  "Kit Ferramentas 46 Peças",
] as const;

const catalogCategoryNames = [
  "Lubrificantes",
  "Filtros",
  "Freios e suspensão",
  "Motor e transmissão",
  "Elétrica",
  "Acessórios",
  "Estética automotiva",
  "Ferramentas",
] as const;
const catalogPhotoIds = [
  "1542291026-7eec264c27ff",
  "1503376780353-7e6692767b70",
  "1486262715619-67b85e0b08d3",
  "1492144534655-ae79c964c9d7",
  "1553440569-bcc63803a83d",
  "1603584173870-7f23fdae1b7a",
  "1520340356584-f9917d1eea6f",
  "1503736334956-4c8f8e92946d",
  "1511919884226-fd3cad34687c",
  "1565043589221-1a6fd9ae45c7",
  "1617814076367-b759c7d7e738",
  "1583121274602-3e2820c69888",
] as const;

async function main() {
  await db.mediaFolder.upsert({
    where: { slug: "videos" },
    update: {},
    create: {
      name: "Vídeos",
      slug: "videos",
      color: "#735bb3",
      system: true,
      createdBy: "Sistema NALVEN",
    },
  });
  const roles = [
    {
      key: "owner",
      name: "Proprietário",
      description: "Controle integral da organização.",
      permissions: ["*"],
      system: true,
    },
    {
      key: "admin",
      name: "Administrador",
      description: "Gestão integral, exceto transferência da propriedade.",
      permissions: ["*"],
      system: true,
    },
    {
      key: "sales",
      name: "Vendas e atendimento",
      description: "PDV, vendas, clientes, pedidos e consulta de catálogo.",
      permissions: [
        "dashboard.read",
        "pdv.write",
        "payments.read",
        "sales.read",
        "sales.write",
        "customers.read",
        "customers.write",
        "products.read",
        "stock.read",
        "orders.read",
        "orders.write",
        "crm.read",
        "crm.write",
        "service-orders.read",
        "service-orders.write",
        "transactional-email.read",
      ],
      system: true,
    },
    {
      key: "stock",
      name: "Suprimentos e operações",
      description:
        "Catálogo, fornecedores, compras, inventário, produção, expedição e mídias.",
      permissions: [
        "dashboard.read",
        "products.read",
        "products.write",
        "categories.read",
        "categories.write",
        "suppliers.read",
        "suppliers.write",
        "purchases.read",
        "purchases.write",
        "stock.read",
        "stock.write",
        "inventory.read",
        "inventory.write",
        "production.read",
        "production.write",
        "logistics.read",
        "logistics.write",
        "invoices.read",
        "invoices.write",
        "library.read",
        "library.write",
      ],
      system: true,
    },
    {
      key: "finance",
      name: "Financeiro",
      description: "Financeiro, caixa, conciliação, fiscal e relatórios.",
      permissions: [
        "dashboard.read",
        "sales.read",
        "customers.read",
        "suppliers.read",
        "purchases.read",
        "finance.read",
        "finance.write",
        "cash-close.read",
        "cash-close.write",
        "accounts.read",
        "accounts.write",
        "reconciliation.read",
        "reconciliation.write",
        "planning.read",
        "planning.write",
        "payments.read",
        "payments.write",
        "fiscal.read",
        "fiscal.write",
        "reports.read",
        "activities.read",
        "activities.write",
        "transactional-email.read",
      ],
      system: true,
    },
    {
      key: "viewer",
      name: "Consulta",
      description: "Acesso somente leitura aos módulos liberados.",
      permissions: ["*.read"],
      system: true,
    },
  ];
  for (const role of roles)
    await db.tenantRole.upsert({
      where: { key: role.key },
      update: {
        name: role.name,
        description: role.description,
        permissions: role.permissions,
        system: role.system,
      },
      create: role,
    });
  for (const item of TRANSACTIONAL_EMAIL_CATALOG) {
    const definition = await db.transactionalEmailDefinition.upsert({
      where: { eventKey: item.eventKey },
      update: {
        label: item.label,
        category: item.category,
        description: item.description,
        variables: item.variables,
        critical: item.critical === true,
      },
      create: {
        eventKey: item.eventKey,
        label: item.label,
        category: item.category,
        description: item.description,
        variables: item.variables,
        critical: item.critical === true,
      },
      select: { id: true },
    });
    const hasVersion = await db.transactionalEmailVersion.findFirst({
      where: { definitionId: definition.id },
      select: { id: true },
    });
    if (!hasVersion) {
      const content = defaultEmailContent(item);
      await db.transactionalEmailVersion.create({
        data: {
          definitionId: definition.id,
          version: 1,
          status: "published",
          subject: content.subject,
          htmlBody: content.htmlBody,
          textBody: content.textBody,
          createdBy: "seed:system",
          publishedAt: new Date(),
        },
      });
    }
  }
  // Fresh tenants intentionally start without synthetic catalog entries. Product
  // and variation writes are protected by the T2 catalog boundary and require a
  // real, authenticated owner. Existing demo tenants keep their records, while
  // new products enter through the application boundary (including fiscal drafts).
  const customers = [
    {
      type: "PF",
      name: "João Carlos de Souza",
      document: "52998224725",
      email: "joao.demo@example.com",
      phone: "49999123434",
      creditLimit: 1500,
      city: "Chapecó",
      state: "SC",
    },
    {
      type: "PJ",
      name: "Transportes Oeste Ltda.",
      tradeName: "Transportes Oeste",
      document: "45874206000189",
      email: "financeiro@transportesoeste.example",
      phone: "4933221100",
      creditLimit: 10000,
      city: "Chapecó",
      state: "SC",
    },
    {
      type: "PF",
      name: "Marcos Silva",
      document: "11144477735",
      email: "marcos.demo@example.com",
      phone: "49998761234",
      creditLimit: 800,
      city: "Xanxerê",
      state: "SC",
    },
  ];
  for (const item of customers) {
    const customer = await db.customer.upsert({
      where: { document: item.document },
      update: {},
      create: {
        type: item.type,
        name: item.name,
        tradeName: item.tradeName,
        document: item.document,
        email: item.email,
        phone: item.phone,
        creditLimit: item.creditLimit,
      },
    });
    const address = await db.customerAddress.findFirst({
      where: { customerId: customer.id, primary: true },
    });
    if (!address)
      await db.customerAddress.create({
        data: { customerId: customer.id, city: item.city, state: item.state },
      });
  }
  const categories = [
    {
      name: "Lubrificantes",
      slug: "lubrificantes",
      type: "product",
      color: "#247a52",
      description: "Óleos e fluidos automotivos.",
    },
    {
      name: "Filtros",
      slug: "filtros",
      type: "product",
      color: "#3579a8",
      description: "Filtros de óleo, ar e combustível.",
    },
    {
      name: "Freios",
      slug: "freios",
      type: "product",
      color: "#b4653d",
      description: "Componentes do sistema de frenagem.",
    },
    {
      name: "Serviços",
      slug: "servicos",
      type: "service",
      color: "#735bb3",
      description: "Mão de obra e serviços técnicos.",
    },
  ];
  for (const item of categories) {
    const category = await db.category.upsert({
      where: { slug: item.slug },
      update: {},
      create: item,
    });
    await db.product.updateMany({
      where: { category: item.name, categoryId: null },
      data: { categoryId: category.id },
    });
  }
  const demoBrand = await db.productBrand.upsert({
    where: { slug: "expresso-parts" },
    update: {},
    create: {
      name: "Expresso Parts",
      slug: "expresso-parts",
      description: "Marca demonstrativa do catálogo NALVEN.",
    },
  });
  const demoOil = await db.product.findUnique({ where: { sku: "SKU-000127" } });
  const lubricantCategory = await db.category.findUnique({
    where: { slug: "lubrificantes" },
  });
  if (demoOil && lubricantCategory) {
    await db.product.update({
      where: { id: demoOil.id },
      data: {
        brandId: demoBrand.id,
        categoryId: lubricantCategory.id,
        catalogType: "simple",
        status: "publish",
        catalogVisibility: "visible",
        featured: true,
        shortDescription:
          "Lubrificante sintético 5W30 para motores flex e gasolina.",
        description:
          "Óleo de motor sintético com proteção contra desgaste, limpeza ativa e estabilidade térmica para uso urbano e rodoviário.",
        gtin: "7891234567895",
        gtinTributary: "7891234567895",
        mpn: "EXP-5W30-1L",
        model: "5W30 SN Plus",
        regularPrice: 59.9,
        cashPrice: 56.9,
        minimumSalePrice: 49.9,
        targetMargin: 35,
        pricingSource: "product",
        cogs: 34.9,
        manageStock: true,
        stockStatus: "instock",
        backorders: "notify",
        unit: "UN",
        weight: 1,
        weightUnit: "kg",
        length: 8,
        width: 8,
        height: 24,
        dimensionUnit: "cm",
        netWeight: 0.95,
        grossWeight: 1.05,
        volumes: 1,
        itemsPerBox: 12,
        shippingClass: "padrao",
        freeShipping: false,
        condition: "new",
        fiscalType: "product",
        production: "third_party",
        ncm: "27101932",
        origin: "0",
        spedItemType: "00",
        taxBurdenRate: 33.33,
        seoTitle: "Óleo Motor 5W30 1L | Auto Mais Peças",
        seoDescription:
          "Óleo sintético 5W30 de alta proteção para seu veículo. Consulte aplicação, estoque e condições.",
        seoFocusKeyword: "óleo motor 5w30",
        seoSecondaryKeywords: ["lubrificante sintético", "óleo automotivo"],
        seoScore: 88,
        badges: [{ label: "Mais vendido", color: "#168151" }],
        carouselConfig: { enabled: true, autoplay: true, interval: 5 },
        customFields: [
          { label: "Aplicação", value: "Motores flex e gasolina" },
        ],
      },
    });
    await db.productCategoryLink.upsert({
      where: {
        productId_categoryId: {
          productId: demoOil.id,
          categoryId: lubricantCategory.id,
        },
      },
      update: { primary: true },
      create: {
        productId: demoOil.id,
        categoryId: lubricantCategory.id,
        primary: true,
      },
    });
    const oilTag = await db.productTag.upsert({
      where: { name: "Mais vendidos" },
      update: {},
      create: { name: "Mais vendidos", slug: "mais-vendidos" },
    });
    await db.productTagLink.upsert({
      where: { productId_tagId: { productId: demoOil.id, tagId: oilTag.id } },
      update: {},
      create: { productId: demoOil.id, tagId: oilTag.id },
    });
    if (
      !(await db.productAttribute.findFirst({
        where: { productId: demoOil.id, slug: "volume" },
      }))
    )
      await db.productAttribute.create({
        data: {
          productId: demoOil.id,
          name: "Volume",
          slug: "volume",
          type: "select",
          swatchType: "button",
          visible: true,
          position: 0,
          options: { create: [{ name: "1 litro", value: "1l", position: 0 }] },
        },
      });
    if (
      !(await db.productCostItem.findFirst({
        where: { productId: demoOil.id, label: "Custo de aquisição" },
      }))
    )
      await db.productCostItem.create({
        data: {
          productId: demoOil.id,
          type: "direct",
          label: "Custo de aquisição",
          value: 34.9,
        },
      });
    if (
      !(await db.productPriceTier.findFirst({
        where: { productId: demoOil.id, minimumQty: 12 },
      }))
    )
      await db.productPriceTier.create({
        data: { productId: demoOil.id, minimumQty: 12, price: 53.9 },
      });
    if (
      !(await db.productMarketplaceProfile.findFirst({
        where: {
          productId: demoOil.id,
          platform: "mercado_livre",
          channelId: null,
        },
      }))
    )
      await db.productMarketplaceProfile.create({
        data: {
          productId: demoOil.id,
          platform: "mercado_livre",
          attributes: [
            { name: "BRAND", value: "Expresso Parts" },
            { name: "MPN", value: "EXP-5W30-1L" },
          ],
          saleTerms: [{ name: "WARRANTY_TIME", value: "3 meses" }],
          readiness: 86,
          ready: false,
          missingFields: ["ml_category_mapping"],
          warnings: [],
          lastValidatedAt: new Date(),
        },
      });
  }
  const suppliers = [
    {
      name: "Distribuidora ABC Ltda.",
      tradeName: "Distribuidora ABC",
      document: "12345678000195",
      email: "comercial@distribuidora-abc.example",
      phone: "4933221000",
      paymentTerms: "28 dias",
      contact: "Marina Comercial",
    },
    {
      name: "Auto Peças XYZ Ltda.",
      tradeName: "Auto Peças XYZ",
      document: "48231901000110",
      email: "vendas@autopecas-xyz.example",
      phone: "4933222000",
      paymentTerms: "21/42 dias",
      contact: "Carlos Vendas",
    },
    {
      name: "Comercial São Bento Ltda.",
      tradeName: "Comercial São Bento",
      document: "33781445000105",
      email: "pedidos@saobento.example",
      phone: "4933223000",
      paymentTerms: "30 dias",
      contact: "Ana Suprimentos",
    },
  ];
  const supplierByTradeName = new Map<string, number>();
  for (const item of suppliers) {
    const supplier = await db.supplier.upsert({
      where: { document: item.document },
      update: {},
      create: {
        name: item.name,
        tradeName: item.tradeName,
        document: item.document,
        email: item.email,
        phone: item.phone,
        paymentTerms: item.paymentTerms,
      },
    });
    supplierByTradeName.set(item.tradeName, supplier.id);
    const contact = await db.supplierContact.findFirst({
      where: { supplierId: supplier.id, primary: true },
    });
    if (!contact)
      await db.supplierContact.create({
        data: {
          supplierId: supplier.id,
          name: item.contact,
          email: item.email,
          phone: item.phone,
          role: "Comercial",
          primary: true,
        },
      });
  }
  const productLinks = [
    ["SKU-000127", "Distribuidora ABC"],
    ["SKU-000491", "Auto Peças XYZ"],
    ["SKU-000688", "Comercial São Bento"],
  ] as const;
  for (const [sku, tradeName] of productLinks) {
    const product = await db.product.findUnique({ where: { sku } });
    const supplierId = supplierByTradeName.get(tradeName);
    if (product && supplierId)
      await db.supplierProduct.upsert({
        where: { supplierId_productId: { supplierId, productId: product.id } },
        update: {},
        create: {
          supplierId,
          productId: product.id,
          lastCost: product.cost,
          preferred: true,
        },
      });
  }
  const demoSupplierId = supplierByTradeName.get("Distribuidora ABC");
  const oil = await db.product.findUnique({ where: { sku: "SKU-000127" } });
  if (demoSupplierId && oil) {
    await db.purchaseOrder.upsert({
      where: { number: "PC-DEMO-0001" },
      update: {},
      create: {
        number: "PC-DEMO-0001",
        supplierId: demoSupplierId,
        status: "ordered",
        expectedAt: new Date("2026-09-05T12:00:00.000Z"),
        dueAt: new Date("2026-09-15T12:00:00.000Z"),
        subtotal: 698,
        total: 698,
        createdBy: "Seed NALVEN",
        orderedAt: new Date(),
        notes: "Reposição inicial demonstrativa persistida no banco.",
        items: {
          create: [
            { productId: oil.id, quantity: 20, unitCost: 34.9, total: 698 },
          ],
        },
      },
    });
  }
  const demoCustomer = await db.customer.findUnique({
    where: { document: "52998224725" },
  });
  if (demoCustomer) {
    await db.financialTitle.upsert({
      where: {
        sourceType_sourceId: { sourceType: "seed", sourceId: "sale-demo-1046" },
      },
      update: {},
      create: {
        type: "receivable",
        description: "Venda demonstrativa #1046",
        customerId: demoCustomer.id,
        documentNumber: "VENDA-1046",
        sourceType: "seed",
        sourceId: "sale-demo-1046",
        amount: 459.9,
        dueAt: new Date("2026-09-10T12:00:00.000Z"),
        notes: "Recebível inicial persistido no banco do tenant.",
      },
    });
  }
  const primaryWarehouse = await db.warehouse.upsert({
    where: { code: "PRINCIPAL" },
    update: {},
    create: {
      code: "PRINCIPAL",
      name: "Estoque principal",
      description: "Depósito padrão da organização.",
      primary: true,
    },
  });
  const reserveWarehouse = await db.warehouse.upsert({
    where: { code: "RESERVA" },
    update: {},
    create: {
      code: "RESERVA",
      name: "Estoque de reserva",
      description: "Área secundária para transferências e inventários.",
    },
  });
  const primaryBranch = await db.branch.upsert({
    where: { code: "MATRIZ" },
    update: { primary: true, defaultWarehouseId: primaryWarehouse.id, name: "Matriz Chapecó", openingDate: new Date("2022-03-14T00:00:00.000Z"), activityCode: "4530703", stateRegistration: "257445890", zip: "89801001", street: "Avenida Getúlio Vargas", number: "1840", district: "Centro", managerName: "Mariana Costa", managerEmail: "mariana@demo.nalven.com.br", managerPhone: "49999100101", costCenterCode: "CC-MATRIZ", notes: "Matriz operacional e fiscal da organização." },
    create: {
      code: "MATRIZ",
      name: "Matriz Chapecó",
      legalName: "Auto Mais Peças Ltda.",
      document: "11444777000161",
      type: "headquarters",
      primary: true,
      email: "contato@automaispecas.example",
      phone: "4933221100",
      openingDate: new Date("2022-03-14T00:00:00.000Z"),
      activityCode: "4530703",
      stateRegistration: "257445890",
      zip: "89801001",
      street: "Avenida Getúlio Vargas",
      number: "1840",
      district: "Centro",
      city: "Chapecó",
      state: "SC",
      managerName: "Mariana Costa",
      managerEmail: "mariana@demo.nalven.com.br",
      managerPhone: "49999100101",
      costCenterCode: "CC-MATRIZ",
      notes: "Matriz operacional e fiscal da organização.",
      defaultWarehouseId: primaryWarehouse.id,
      settings: {
        create: {
          taxRegime: "simples_nacional",
          fiscalEnvironment: "homologation",
          nfeSeries: 1,
          nfceSeries: 1,
          nfseSeries: 1,
        },
      },
    },
  });
  await db.warehouse.updateMany({
    where: { id: { in: [primaryWarehouse.id, reserveWarehouse.id] } },
    data: { branchId: primaryBranch.id },
  });
  const branchCatalogProducts = await db.product.findMany({
    select: { id: true },
  });
  for (const product of branchCatalogProducts)
    await db.branchProduct.upsert({
      where: {
        branchId_productId: {
          branchId: primaryBranch.id,
          productId: product.id,
        },
      },
      update: { active: true, saleEnabled: true },
      create: {
        branchId: primaryBranch.id,
        productId: product.id,
        active: true,
        saleEnabled: true,
        purchaseEnabled: true,
        preferredWarehouseId: primaryWarehouse.id,
      },
    });
  const codedProducts = await db.product.findMany({
    select: {
      id: true,
      gtin: true,
      barcode: true,
      variations: {
        where: { enabled: true },
        select: { id: true, gtin: true },
      },
    },
  });
  const codeCandidates = codedProducts
    .flatMap((product) => [
      ...(product.gtin
        ? [
            {
              productId: product.id,
              variationId: null as number | null,
              code: product.gtin,
              symbology: "gtin",
              priority: 100,
            },
          ]
        : []),
      ...(product.barcode
        ? [
            {
              productId: product.id,
              variationId: null as number | null,
              code: product.barcode,
              symbology: "internal",
              priority: 50,
            },
          ]
        : []),
      ...product.variations.flatMap((variation) =>
        variation.gtin
          ? [
              {
                productId: product.id,
                variationId: variation.id,
                code: variation.gtin,
                symbology: "gtin",
                priority: 110,
              },
            ]
          : [],
      ),
    ])
    .map((item) => ({
      ...item,
      normalizedCode: item.code.replace(/[^0-9A-Za-z]/g, ""),
    }));
  const codeFrequency = new Map<string, number>();
  for (const item of codeCandidates)
    codeFrequency.set(
      item.normalizedCode,
      (codeFrequency.get(item.normalizedCode) || 0) + 1,
    );
  for (const item of codeCandidates) {
    if (codeFrequency.get(item.normalizedCode) !== 1) continue;
    await db.posProductCode.upsert({
      where: {
        scopeKey_normalizedCode: {
          scopeKey: "global",
          normalizedCode: item.normalizedCode,
        },
      },
      update: {
        productId: item.productId,
        variationId: item.variationId,
        code: item.code,
        symbology: item.symbology,
        priority: item.priority,
        active: true,
      },
      create: {
        productId: item.productId,
        variationId: item.variationId,
        scopeKey: "global",
        code: item.code,
        normalizedCode: item.normalizedCode,
        symbology: item.symbology,
        priority: item.priority,
      },
    });
  }
  const primaryRegister = await db.posRegister.upsert({
    where: { branchId_code: { branchId: primaryBranch.id, code: "PRINCIPAL" } },
    update: { warehouseId: primaryWarehouse.id, status: "active" },
    create: {
      branchId: primaryBranch.id,
      warehouseId: primaryWarehouse.id,
      code: "PRINCIPAL",
      name: "Caixa principal",
      settings: { requireOpenShift: true, blindClose: true },
    },
  });
  await db.posTerminal.upsert({
    where: {
      registerId_code: {
        registerId: primaryRegister.id,
        code: "WEB-PRINCIPAL",
      },
    },
    update: {
      name: "Navegador do caixa principal",
      appVersion: "web-pdv/1",
      tokenExpiresAt: new Date("2036-01-01T00:00:00.000Z"),
      settings: { terminalKind: "browser", managedBy: "tenant-seed" },
    },
    create: {
      registerId: primaryRegister.id,
      code: "WEB-PRINCIPAL",
      name: "Navegador do caixa principal",
      status: "paired",
      tokenHash: `hmac-sha256:v1:${randomBytes(32).toString("hex")}`,
      tokenIssuedAt: new Date(),
      tokenExpiresAt: new Date("2036-01-01T00:00:00.000Z"),
      credentialVersion: 1,
      appVersion: "web-pdv/1",
      pairedAt: new Date(),
      settings: { terminalKind: "browser", managedBy: "tenant-seed" },
    },
  });
  const [seedDatabaseRole] = await db.$queryRaw<Array<{ role: string }>>(
    Prisma.sql`SELECT current_user AS role`,
  );
  if (seedDatabaseRole.role.endsWith("_runtime")) {
    const catalogCategories = new Map<string, number>();
    for (const [position, name] of catalogCategoryNames.entries()) {
      const slug = `catalogo-${position + 1}-${slugifySeed(name)}`;
      const existingCategory = await db.category.findUnique({
        where: { name },
      });
      const category = existingCategory
        ? await db.category.update({
            where: { id: existingCategory.id },
            data: { type: "product" },
          })
        : await db.category.create({
            data: {
              name,
              slug,
              type: "product",
              color: [
                "#315f8c",
                "#28745b",
                "#9b4d3f",
                "#7257a5",
                "#b36b24",
                "#386d82",
                "#7d5b38",
                "#465461",
              ][position],
              description: `Linha demonstrativa de ${name.toLowerCase()} para catálogo e PDV.`,
            },
          });
      catalogCategories.set(name, category.id);
    }
    await db.mediaFolder.upsert({
      where: { slug: "produtos-catalogo" },
      update: { name: "Produtos catálogo" },
      create: {
        name: "Produtos catálogo",
        slug: "produtos-catalogo",
        color: "#315f8c",
        system: true,
        createdBy: "Seed NALVEN",
      },
    });
    const catalogActor = await db.tenantUserProfile.findFirst({
      where: { status: "active", role: { key: "owner" } },
      select: { userId: true },
    });
    if (!catalogActor)
      throw new Error(
        "Proprietário ativo obrigatório para o seed de catálogo protegido.",
      );
    for (const [zeroIndex, name] of catalogProductNames.entries()) {
      const sequence = zeroIndex + 1,
        code = String(sequence).padStart(3, "0"),
        sku = `CAT-${code}`;
      const categoryName =
        catalogCategoryNames[
          Math.min(catalogCategoryNames.length - 1, Math.floor(zeroIndex / 7))
        ];
      const categoryId = catalogCategories.get(categoryName)!;
      const media = [];
      for (const [mediaIndex, role] of [
        "principal",
        "detalhe",
        "ambientada",
      ].entries()) {
        const storageKey = `00000000-0000-4000-8${String(sequence).padStart(3, "0")}-${String(mediaIndex + 1).padStart(12, "0")}.jpg`;
        const photoId =
          catalogPhotoIds[
            (zeroIndex * 3 + mediaIndex) % catalogPhotoIds.length
          ];
        const remoteUrl = `https://images.unsplash.com/photo-${photoId}?auto=format&fit=crop&w=600&h=600&q=72&sig=${sequence * 10 + mediaIndex}`;
        media.push(
          await db.tenantMediaAsset.upsert({
            where: { storageKey },
            update: {
              name: `${name} — ${role}`,
              altText: `${name}, foto ${role}`,
              description: `Imagem ${role} do produto ${name} para catálogo e marketplaces.`,
              tags: ["catálogo", "produto", role],
              source: "catalog",
              remoteUrl,
              localAvailable: false,
              deletedAt: null,
            },
            create: {
              name: `${name} — ${role}`,
              originalName: `${slugifySeed(name)}-${role}.jpg`,
              storageKey,
              mimeType: "image/jpeg",
              kind: "image",
              sizeBytes: 0,
              checksum: createHash("sha256").update(remoteUrl).digest("hex"),
              remoteUrl,
              localAvailable: false,
              folder: "Produtos catálogo",
              altText: `${name}, foto ${role}`,
              description: `Imagem ${role} do produto ${name} para catálogo e marketplaces.`,
              tags: ["catálogo", "produto", role],
              source: "catalog",
              uploadedById: "seed",
              uploadedByName: "Seed NALVEN",
            },
          }),
        );
      }
      const regularPrice = 24.9 + zeroIndex * 5.35,
        cost = Math.round(regularPrice * 0.56 * 100) / 100;
      const variable = zeroIndex < 20;
      const variationScheme = variable ? seedVariationScheme(zeroIndex) : null;
      const boundaryVariations =
        variationScheme?.combinations.map((_, variationIndex) => ({
          enabled: true,
          expectedConfigHash: null,
          expectedRevision: null,
          gtinSnapshot: null,
          manageStock: "true",
          ordinal: variationIndex,
          skuSnapshot: `${sku}-V${variationIndex + 1}`,
          status: "publish",
          variationId: null,
        })) || [];
      let product = await db.product.findUnique({ where: { sku } });
      if (!product) {
        const boundary = await createSeedCatalogBoundary({
          name,
          sku,
          actorUserId: catalogActor.userId,
          variations: boundaryVariations,
        });
        product = await db.product.findUniqueOrThrow({
          where: { id: boundary.productId },
        });
      }
      product = await db.product.update({
        where: { id: product.id },
        data: {
          category: categoryName,
          categoryId,
          brandId: demoBrand.id,
          catalogType: variable ? "variable" : "simple",
          catalogVisibility: "visible",
          imageMediaId: media[0].id,
          seoOgImageMediaId: media[0].id,
          price: regularPrice,
          regularPrice,
          cashPrice: Math.round(regularPrice * 0.95 * 100) / 100,
          minimumSalePrice: Math.round(cost * 1.12 * 100) / 100,
          cost,
          cogs: cost,
          stock: variable ? 75 : 40 + sequence,
          stockStatus: "instock",
          minStock: 5,
          barcode: `NALVEN${code}`,
          featured: sequence % 9 === 0,
          description: `${name} para reposição e manutenção automotiva. Cadastro completo para demonstração de catálogo, estoque e venda no PDV.`,
          shortDescription: `${name} com disponibilidade imediata no estoque principal.`,
          condition: "new",
          fiscalType: "product",
          production: "third_party",
          ncm: "87089990",
          origin: "0",
          seoTitle: `${name} | Auto Mais Peças`,
          seoDescription: `Compre ${name.toLowerCase()} com estoque disponível e retirada rápida.`,
          seoFocusKeyword: name.toLowerCase(),
          seoScore: 82,
          badges:
            sequence % 5 === 0 ? [{ label: "Destaque", color: "#168151" }] : [],
          carouselConfig: { enabled: true, autoplay: true, interval: 5 },
        },
      });
      await db.productImage.upsert({
        where: {
          productId_mediaAssetId: {
            productId: product.id,
            mediaAssetId: media[1].id,
          },
        },
        update: { position: 0, altText: `${name}, detalhe` },
        create: {
          productId: product.id,
          mediaAssetId: media[1].id,
          position: 0,
          altText: `${name}, detalhe`,
        },
      });
      await db.productImage.upsert({
        where: {
          productId_mediaAssetId: {
            productId: product.id,
            mediaAssetId: media[2].id,
          },
        },
        update: { position: 1, altText: `${name}, aplicação` },
        create: {
          productId: product.id,
          mediaAssetId: media[2].id,
          position: 1,
          altText: `${name}, aplicação`,
        },
      });
      await db.productCategoryLink.upsert({
        where: { productId_categoryId: { productId: product.id, categoryId } },
        update: { primary: true },
        create: { productId: product.id, categoryId, primary: true },
      });
      await db.branchProduct.upsert({
        where: {
          branchId_productId: {
            branchId: primaryBranch.id,
            productId: product.id,
          },
        },
        update: {
          active: true,
          saleEnabled: true,
          purchaseEnabled: true,
          preferredWarehouseId: primaryWarehouse.id,
        },
        create: {
          branchId: primaryBranch.id,
          productId: product.id,
          active: true,
          saleEnabled: true,
          purchaseEnabled: true,
          preferredWarehouseId: primaryWarehouse.id,
        },
      });
      await db.warehouseBalance.upsert({
        where: {
          warehouseId_productId: {
            warehouseId: primaryWarehouse.id,
            productId: product.id,
          },
        },
        update: { quantity: variable ? 75 : 40 + sequence },
        create: {
          warehouseId: primaryWarehouse.id,
          productId: product.id,
          quantity: variable ? 75 : 40 + sequence,
        },
      });
      await db.posProductCode.upsert({
        where: {
          scopeKey_normalizedCode: {
            scopeKey: "global",
            normalizedCode: `NALVEN${code}`,
          },
        },
        update: {
          productId: product.id,
          variationId: null,
          code: `NALVEN${code}`,
          symbology: "internal",
          active: true,
        },
        create: {
          productId: product.id,
          variationId: null,
          scopeKey: "global",
          code: `NALVEN${code}`,
          normalizedCode: `NALVEN${code}`,
          symbology: "internal",
          priority: 60,
        },
      });
      if (!variable) continue;
      if (!variationScheme) continue;
      for (const [
        attributeIndex,
        attributeDefinition,
      ] of variationScheme.attributes.entries()) {
        const attribute = await db.productAttribute.upsert({
          where: {
            productId_slug: {
              productId: product.id,
              slug: attributeDefinition.slug,
            },
          },
          update: {
            name: attributeDefinition.name,
            variation: true,
            visible: true,
            position: attributeIndex,
          },
          create: {
            productId: product.id,
            name: attributeDefinition.name,
            slug: attributeDefinition.slug,
            type: "select",
            swatchType: attributeDefinition.slug === "cor" ? "color" : "button",
            visible: true,
            variation: true,
            position: attributeIndex,
          },
        });
        for (const [
          optionIndex,
          option,
        ] of attributeDefinition.values.entries())
          await db.productAttributeOption.upsert({
            where: {
              attributeId_value: { attributeId: attribute.id, value: option },
            },
            update: { name: option, position: optionIndex },
            create: {
              attributeId: attribute.id,
              name: option,
              value: option,
              color: seedColor(option),
              position: optionIndex,
            },
          });
      }
      for (const [
        variationIndex,
        combination,
      ] of variationScheme.combinations.entries()) {
        const variationSku = `${sku}-V${variationIndex + 1}`;
        const attributes = Object.entries(combination).map(
          ([attributeName, value]) => ({ name: attributeName, value }),
        );
        const variation = await db.productVariation.update({
          where: { sku: variationSku },
          data: {
            attributes,
            regularPrice: regularPrice + variationIndex * 6.5,
            salePrice: null,
            stock: 20 + variationIndex * 5,
            stockStatus: "instock",
            imageMediaId: media[variationIndex % media.length].id,
            description: `${name} na combinação ${Object.values(combination).join(" / ")}.`,
          },
        });
        await db.productVariationImage.upsert({
          where: {
            variationId_mediaAssetId: {
              variationId: variation.id,
              mediaAssetId: media[(variationIndex + 1) % media.length].id,
            },
          },
          update: { position: 0 },
          create: {
            variationId: variation.id,
            mediaAssetId: media[(variationIndex + 1) % media.length].id,
            position: 0,
          },
        });
        await db.warehouseVariationBalance.upsert({
          where: {
            warehouseId_variationId: {
              warehouseId: primaryWarehouse.id,
              variationId: variation.id,
            },
          },
          update: { productId: product.id, quantity: 20 + variationIndex * 5 },
          create: {
            warehouseId: primaryWarehouse.id,
            productId: product.id,
            variationId: variation.id,
            quantity: 20 + variationIndex * 5,
          },
        });
      }
    }
  }
  const suiteProducts = await db.product.findMany({
    where: { active: true, type: "product" },
    orderBy: { id: "asc" },
    take: 4,
  });
  const suiteCustomers = await db.customer.findMany({
    where: { status: "active" },
    orderBy: { id: "asc" },
    take: 3,
  });
  const suiteSuppliers = await db.supplier.findMany({
    where: { status: "active" },
    orderBy: { id: "asc" },
    take: 3,
  });
  if (suiteCustomers.length) {
    const crmSamples = [
      {
        title: "Renovação da frota Oeste",
        company: "Transportes Oeste",
        contactName: "Equipe de compras",
        stage: "lead",
        value: 18500,
        probability: 15,
        source: "Indicação",
      },
      {
        title: "Contrato de manutenção preventiva",
        company: "Logística Serra",
        contactName: "Mariana Lima",
        stage: "qualified",
        value: 32000,
        probability: 45,
        source: "Site",
      },
      {
        title: "Pacote de revisão corporativa",
        company: "Cooperativa Central",
        contactName: "Rafael Costa",
        stage: "proposal",
        value: 24800,
        probability: 70,
        source: "Prospecção",
      },
      {
        title: "Atendimento mensal de utilitários",
        company: "Expresso Regional",
        contactName: "Carla Souza",
        stage: "negotiation",
        value: 41750,
        probability: 85,
        source: "Evento",
      },
    ];
    for (const sample of crmSamples)
      if (
        !(await db.crmOpportunity.findFirst({
          where: { title: sample.title, source: sample.source },
        }))
      ) {
        await db.crmOpportunity.create({
          data: {
            ...sample,
            customerId: suiteCustomers[0].id,
            owner: "Seed NALVEN",
            expectedAt: new Date("2026-10-15T12:00:00.000Z"),
            history: {
              create: { toStage: sample.stage, actor: "Seed NALVEN" },
            },
            activities: {
              create: [
                {
                  type: "task",
                  subject: `Próximo passo: ${sample.title}`,
                  dueAt: new Date("2026-09-08T14:00:00.000Z"),
                  createdBy: "Seed NALVEN",
                },
              ],
            },
          },
        });
      }
    await db.serviceContract.upsert({
      where: { number: "CTR-DEMO-0001" },
      update: {},
      create: {
        number: "CTR-DEMO-0001",
        name: "Manutenção preventiva mensal",
        customerId: suiteCustomers[0].id,
        status: "active",
        startDate: new Date("2026-01-01T12:00:00.000Z"),
        billingDay: 10,
        amount: 2450,
        adjustmentIndex: "IPCA",
        nextBillingAt: new Date("2026-09-01T12:00:00.000Z"),
        slaHours: 24,
        notes: "Contrato demonstrativo com competência pendente.",
        createdBy: "Seed NALVEN",
      },
    });
    if (suiteCustomers[1])
      await db.serviceContract.upsert({
        where: { number: "CTR-DEMO-0002" },
        update: {},
        create: {
          number: "CTR-DEMO-0002",
          name: "Suporte técnico de frota",
          customerId: suiteCustomers[1].id,
          status: "draft",
          startDate: new Date("2026-09-15T12:00:00.000Z"),
          billingDay: 15,
          amount: 3890,
          adjustmentIndex: "IGP-M",
          nextBillingAt: new Date("2026-09-15T12:00:00.000Z"),
          slaHours: 8,
          createdBy: "Seed NALVEN",
        },
      });
  }
  if (suiteCustomers.length && suiteProducts.length) {
    await db.serviceOrder.upsert({
      where: { number: "OS-DEMO-0001" },
      update: {},
      create: {
        number: "OS-DEMO-0001",
        status: "in_progress",
        customerId: suiteCustomers[0].id,
        customerName: suiteCustomers[0].tradeName || suiteCustomers[0].name,
        asset: "Furgão de entregas",
        assetIdentifier: "DEMO-1024",
        complaint: "Ruído durante frenagem e revisão preventiva.",
        diagnosis: "Desgaste do conjunto dianteiro em avaliação.",
        technician: "Equipe técnica A",
        scheduledAt: new Date("2026-09-03T13:30:00.000Z"),
        subtotal: suiteProducts[0].price,
        total: suiteProducts[0].price,
        createdBy: "Seed NALVEN",
        startedAt: new Date(),
        items: {
          create: {
            productId: suiteProducts[0].id,
            quantity: 1,
            unitPrice: suiteProducts[0].price,
            total: suiteProducts[0].price,
          },
        },
        checklist: {
          create: [
            { label: "Conferir identificação do veículo", completed: true },
            { label: "Validar diagnóstico com o cliente" },
          ],
        },
        history: {
          create: [
            { toStatus: "open", actor: "Seed NALVEN" },
            {
              fromStatus: "open",
              toStatus: "in_progress",
              actor: "Seed NALVEN",
            },
          ],
        },
      },
    });
  }
  if (suiteProducts.length >= 3) {
    const bom = await db.billOfMaterial.upsert({
      where: { code: "BOM-DEMO-KIT" },
      update: {},
      create: {
        code: "BOM-DEMO-KIT",
        name: "Kit demonstrativo de revisão",
        outputProductId: suiteProducts[2].id,
        yieldQuantity: 1,
        notes: "Ficha técnica para simulação de custo e capacidade.",
        items: {
          create: [
            { productId: suiteProducts[0].id, quantity: 1, wastePercent: 2 },
            { productId: suiteProducts[1].id, quantity: 2, wastePercent: 1 },
          ],
        },
      },
    });
    await db.productionOrder.upsert({
      where: { number: "OP-DEMO-0001" },
      update: {},
      create: {
        number: "OP-DEMO-0001",
        bomId: bom.id,
        outputProductId: suiteProducts[2].id,
        warehouseId: primaryWarehouse.id,
        plannedQuantity: 10,
        status: "planned",
        notes: "Ordem planejada para visualização do módulo.",
        createdBy: "Seed NALVEN",
      },
    });
    await db.productionOrder.upsert({
      where: { number: "OP-DEMO-0002" },
      update: {},
      create: {
        number: "OP-DEMO-0002",
        bomId: bom.id,
        outputProductId: suiteProducts[2].id,
        warehouseId: primaryWarehouse.id,
        plannedQuantity: 8,
        producedQuantity: 7.5,
        status: "completed",
        actualCost: 412.8,
        completedAt: new Date("2026-08-28T17:10:00.000Z"),
        notes: "Apontamento demonstrativo com rendimento abaixo do planejado.",
        createdBy: "Seed NALVEN",
        createdAt: new Date("2026-08-28T12:00:00.000Z"),
      },
    });
    await db.productionOrder.upsert({
      where: { number: "OP-DEMO-0003" },
      update: {},
      create: {
        number: "OP-DEMO-0003",
        bomId: bom.id,
        outputProductId: suiteProducts[2].id,
        warehouseId: reserveWarehouse.id,
        plannedQuantity: 12,
        status: "cancelled",
        notes: "Ordem cancelada após replanejamento de capacidade.",
        createdBy: "Seed NALVEN",
        createdAt: new Date("2026-08-26T12:00:00.000Z"),
      },
    });
    if (suiteProducts[3]) {
      const secondBom = await db.billOfMaterial.upsert({
        where: { code: "BOM-DEMO-PREVENTIVA" },
        update: {},
        create: {
          code: "BOM-DEMO-PREVENTIVA",
          name: "Kit de manutenção preventiva",
          outputProductId: suiteProducts[3].id,
          yieldQuantity: 2,
          notes:
            "Composição alternativa para comparar capacidade entre depósitos.",
          items: {
            create: [
              {
                productId: suiteProducts[0].id,
                quantity: 0.5,
                wastePercent: 1.5,
              },
              { productId: suiteProducts[1].id, quantity: 1, wastePercent: 3 },
            ],
          },
        },
      });
      await db.productionOrder.upsert({
        where: { number: "OP-DEMO-0004" },
        update: {},
        create: {
          number: "OP-DEMO-0004",
          bomId: secondBom.id,
          outputProductId: suiteProducts[3].id,
          warehouseId: reserveWarehouse.id,
          plannedQuantity: 16,
          status: "planned",
          notes: "Valida disponibilidade real no estoque de reserva.",
          createdBy: "Seed NALVEN",
        },
      });
      await db.productionOrder.upsert({
        where: { number: "OP-DEMO-0005" },
        update: {},
        create: {
          number: "OP-DEMO-0005",
          bomId: secondBom.id,
          outputProductId: suiteProducts[3].id,
          warehouseId: primaryWarehouse.id,
          plannedQuantity: 20,
          producedQuantity: 21,
          status: "completed",
          actualCost: 598.4,
          completedAt: new Date("2026-08-31T16:45:00.000Z"),
          notes: "Lote demonstrativo com rendimento acima do planejado.",
          createdBy: "Seed NALVEN",
          createdAt: new Date("2026-08-31T09:00:00.000Z"),
        },
      });
    }
  }
  if (suiteProducts.length >= 2 && suiteSuppliers.length >= 2) {
    const quotation = await db.purchaseQuotation.upsert({
      where: { number: "COT-DEMO-0001" },
      update: { deadlineAt: new Date("2026-08-28T12:00:00.000Z") },
      create: {
        number: "COT-DEMO-0001",
        title: "Reposição urgente de insumos",
        status: "open",
        deadlineAt: new Date("2026-08-28T12:00:00.000Z"),
        notes: "Cotação vencida para demonstrar a fila de atenção.",
        createdBy: "Seed NALVEN",
        items: {
          create: [
            { productId: suiteProducts[0].id, quantity: 20 },
            { productId: suiteProducts[1].id, quantity: 12 },
          ],
        },
      },
    });
    const quotationItems = await db.purchaseQuotationItem.findMany({
      where: { quotationId: quotation.id },
      orderBy: { id: "asc" },
    });
    for (const [index, supplier] of suiteSuppliers.slice(0, 2).entries()) {
      const costs = quotationItems.map(
          (item, itemIndex) =>
            Math.round(
              suiteProducts[itemIndex].cost * (1 + index * 0.035) * 100,
            ) / 100,
        ),
        total = quotationItems.reduce(
          (sum, item, itemIndex) => sum + item.quantity * costs[itemIndex],
          0,
        );
      const subtotal = Math.round(total * 100) / 100,
        freight = index ? 0 : 48,
        discount = index ? 35 : 0;
      await db.purchaseQuotationOffer.upsert({
        where: {
          quotationId_supplierId: {
            quotationId: quotation.id,
            supplierId: supplier.id,
          },
        },
        update: {
          subtotal,
          freight,
          discount,
          total: subtotal + freight - discount,
        },
        create: {
          quotationId: quotation.id,
          supplierId: supplier.id,
          subtotal,
          freight,
          discount,
          total: subtotal + freight - discount,
          leadTimeDays: index ? 4 : 7,
          paymentTerms: index ? "21/42 dias" : "28 dias",
          notes: index ? "Entrega mais rápida." : "Menor condição à vista.",
          items: {
            create: quotationItems.map((item, itemIndex) => ({
              quotationItemId: item.id,
              unitCost: costs[itemIndex],
              total: Math.round(item.quantity * costs[itemIndex] * 100) / 100,
            })),
          },
        },
      });
    }
    const awardedOrder = await db.purchaseOrder.upsert({
      where: { number: "PC-DEMO-0002" },
      update: {},
      create: {
        number: "PC-DEMO-0002",
        supplierId: suiteSuppliers[0].id,
        status: "draft",
        expectedAt: new Date("2026-09-08T12:00:00.000Z"),
        dueAt: new Date("2026-09-22T12:00:00.000Z"),
        subtotal: 896,
        freight: 35,
        discount: 20,
        total: 911,
        notes: "Pedido gerado pela adjudicação da cotação demo.",
        createdBy: "Seed NALVEN",
        items: {
          create: [
            {
              productId: suiteProducts[0].id,
              quantity: 16,
              unitCost: 35,
              total: 560,
            },
            {
              productId: suiteProducts[1].id,
              quantity: 8,
              unitCost: 42,
              total: 336,
            },
          ],
        },
      },
    });
    const awardedQuotation = await db.purchaseQuotation.upsert({
      where: { number: "COT-DEMO-0002" },
      update: { purchaseOrderId: awardedOrder.id },
      create: {
        number: "COT-DEMO-0002",
        title: "Compra mensal adjudicada",
        status: "awarded",
        deadlineAt: new Date("2026-08-30T12:00:00.000Z"),
        purchaseOrderId: awardedOrder.id,
        notes: "Cenário completo de cotação convertida em pedido.",
        createdBy: "Seed NALVEN",
        items: {
          create: [
            { productId: suiteProducts[0].id, quantity: 16 },
            { productId: suiteProducts[1].id, quantity: 8 },
          ],
        },
      },
    });
    const awardedItems = await db.purchaseQuotationItem.findMany({
      where: { quotationId: awardedQuotation.id },
      orderBy: { id: "asc" },
    });
    await db.purchaseQuotationOffer.upsert({
      where: {
        quotationId_supplierId: {
          quotationId: awardedQuotation.id,
          supplierId: suiteSuppliers[0].id,
        },
      },
      update: { selected: true },
      create: {
        quotationId: awardedQuotation.id,
        supplierId: suiteSuppliers[0].id,
        subtotal: 896,
        freight: 35,
        discount: 20,
        total: 911,
        leadTimeDays: 6,
        paymentTerms: "28/56 dias",
        selected: true,
        notes: "Proposta escolhida pelo melhor custo total entregue.",
        items: {
          create: awardedItems.map((item, index) => ({
            quotationItemId: item.id,
            unitCost: index ? 42 : 35,
            total: item.quantity * (index ? 42 : 35),
          })),
        },
      },
    });
    await db.purchaseQuotation.update({
      where: { id: awardedQuotation.id },
      data: { purchaseOrderId: awardedOrder.id },
    });
    await db.purchaseQuotation.upsert({
      where: { number: "COT-DEMO-0003" },
      update: {},
      create: {
        number: "COT-DEMO-0003",
        title: "Renovação de ferramentas cancelada",
        status: "cancelled",
        deadlineAt: new Date("2026-08-25T12:00:00.000Z"),
        notes: "Demanda suspensa após revisão orçamentária.",
        createdBy: "Seed NALVEN",
        items: { create: [{ productId: suiteProducts[0].id, quantity: 5 }] },
      },
    });
    await db.purchaseOrder.upsert({
      where: { number: "PC-DEMO-0003" },
      update: {},
      create: {
        number: "PC-DEMO-0003",
        supplierId: suiteSuppliers[1].id,
        status: "partially_received",
        expectedAt: new Date("2026-09-01T12:00:00.000Z"),
        dueAt: new Date("2026-09-18T12:00:00.000Z"),
        subtotal: 1260,
        total: 1260,
        notes: "Recebimento parcial demonstrativo; saldo pendente visível.",
        createdBy: "Seed NALVEN",
        orderedAt: new Date("2026-08-24T12:00:00.000Z"),
        items: {
          create: [
            {
              productId: suiteProducts[1].id,
              quantity: 30,
              receivedQuantity: 18,
              unitCost: 42,
              total: 1260,
            },
          ],
        },
      },
    });
    await db.purchaseOrder.upsert({
      where: { number: "PC-DEMO-0004" },
      update: {},
      create: {
        number: "PC-DEMO-0004",
        supplierId: suiteSuppliers[0].id,
        status: "received",
        expectedAt: new Date("2026-08-20T12:00:00.000Z"),
        dueAt: new Date("2026-09-05T12:00:00.000Z"),
        subtotal: 700,
        total: 700,
        notes: "Pedido integralmente recebido para histórico.",
        createdBy: "Seed NALVEN",
        orderedAt: new Date("2026-08-12T12:00:00.000Z"),
        completedAt: new Date("2026-08-20T15:00:00.000Z"),
        items: {
          create: [
            {
              productId: suiteProducts[0].id,
              quantity: 20,
              receivedQuantity: 20,
              unitCost: 35,
              total: 700,
            },
          ],
        },
      },
    });
  }
  // T2-02 is deliberately seeded hard-off: no reconciliation gate,
  // finalization profile, manual case or application is synthesized. Those
  // records require connector-specific homologation and real payment proof;
  // an empty set is the safe, fail-closed initial state.
  await db.tenantSettings.upsert({
    where: { id: 1 },
    update: {},
    create: {
      id: 1,
      organizationName: "Auto Mais Peças",
      tradeName: "Auto Mais Peças",
      operationalEmail: "demo@nalven.com.br",
      defaultPaymentMethod: "Pix",
      defaultCustomerName: "Consumidor final",
      lowStockAlerts: true,
      notifyLowStock: true,
    },
  });
  await db.reportSettings.upsert({
    where: { id: 1 },
    update: {},
    create: {
      id: 1,
      pricingMode: "mixed",
      globalTargetMargin: 30,
      globalMinimumMargin: 15,
      fiscalRequiredFields: ["ncm", "cest", "origin", "gtin"],
      updatedBy: "Seed NALVEN",
    },
  });
  if (demoCustomer && oil)
    await db.salesOrder.upsert({
      where: { number: "ORC-DEMO-0001" },
      update: {},
      create: {
        number: "ORC-DEMO-0001",
        kind: "quote",
        status: "draft",
        branchId: primaryBranch.id,
        customerId: demoCustomer.id,
        customerName: demoCustomer.name,
        customerDocument: demoCustomer.document,
        customerEmail: demoCustomer.email,
        customerPhone: demoCustomer.phone,
        validUntil: new Date("2026-09-15T12:00:00.000Z"),
        subtotal: 119.8,
        total: 119.8,
        notes: "Orçamento inicial persistido no banco do tenant.",
        createdBy: "Seed NALVEN",
        items: {
          create: [
            {
              productId: oil.id,
              nameSnapshot: oil.name,
              skuSnapshot: oil.sku,
              quantity: 2,
              unitPrice: 59.9,
              listPrice: 59.9,
              total: 119.8,
            },
          ],
        },
        addresses: {
          create: [
            {
              type: "billing",
              firstName: demoCustomer.name,
              email: demoCustomer.email,
              phone: demoCustomer.phone,
              document: demoCustomer.document,
            },
            {
              type: "shipping",
              firstName: demoCustomer.name,
              email: demoCustomer.email,
              phone: demoCustomer.phone,
              document: demoCustomer.document,
              city: "Chapecó",
              state: "SC",
            },
          ],
        },
        history: {
          create: {
            toStatus: "draft",
            actor: "Seed NALVEN",
            actorType: "system",
            notes: "Seed inicial",
          },
        },
      },
    });
  const demoProducts = await db.product.findMany({
    where: { sku: { in: ["SKU-000127", "SKU-000491", "SKU-000688"] } },
    orderBy: { sku: "asc" },
  });
  const demoCustomers = await db.customer.findMany({
    where: {
      document: { in: ["52998224725", "45874206000189", "11144477735"] },
    },
    orderBy: { id: "asc" },
  });
  const demoOrders = [
    {
      number: "PED-DEMO-1001",
      status: "pending",
      customer: demoCustomers[0],
      product: demoProducts[0],
      quantity: 3,
      freight: 18.9,
      payment: "Pix",
      note: "Aguardando confirmação automática do pagamento.",
    },
    {
      number: "PED-DEMO-1002",
      status: "processing",
      customer: demoCustomers[1],
      product: demoProducts[1],
      quantity: 8,
      freight: 35,
      payment: "Boleto",
      note: "Pagamento confirmado; separar por lote de validade.",
    },
    {
      number: "PED-DEMO-1003",
      status: "preparing",
      customer: demoCustomers[2],
      product: demoProducts[2],
      quantity: 1,
      freight: 22,
      payment: "Cartão de crédito",
      note: "Separação iniciada no depósito principal.",
    },
    {
      number: "PED-DEMO-1004",
      status: "shipped",
      customer: demoCustomers[0],
      product: demoProducts[1],
      quantity: 2,
      freight: 19.9,
      payment: "Pix",
      note: "Enviado com rastreio demonstrativo.",
    },
    {
      number: "PED-DEMO-1005",
      status: "completed",
      customer: demoCustomers[1],
      product: demoProducts[0],
      quantity: 12,
      freight: 0,
      payment: "Transferência",
      note: "Pedido concluído e disponível para pós-venda.",
    },
  ];
  for (const sample of demoOrders) {
    if (
      !sample.customer ||
      !sample.product ||
      (await db.salesOrder.findUnique({ where: { number: sample.number } }))
    )
      continue;
    const subtotal =
        Math.round(sample.product.price * sample.quantity * 100) / 100,
      total = subtotal + sample.freight,
      paid = sample.status !== "pending";
    await db.salesOrder.create({
      data: {
        number: sample.number,
        kind: "order",
        status: sample.status,
        origin: "store",
        branchId: primaryBranch.id,
        customerId: sample.customer.id,
        customerName: sample.customer.tradeName || sample.customer.name,
        customerDocument: sample.customer.document,
        customerEmail: sample.customer.email,
        customerPhone: sample.customer.phone,
        subtotal,
        freightAmount: sample.freight,
        total,
        paymentMethod: sample.payment,
        paymentTitle: sample.payment,
        paidAt: paid ? new Date() : null,
        salesperson: "Dyonatan Dias",
        deliveryType: "carrier",
        deliveryCity: "Chapecó",
        deliveryState: "SC",
        notes: sample.note,
        createdBy: "Seed NALVEN",
        items: {
          create: [
            {
              productId: sample.product.id,
              nameSnapshot: sample.product.name,
              skuSnapshot: sample.product.sku,
              quantity: sample.quantity,
              listPrice: sample.product.price,
              unitPrice: sample.product.price,
              total: subtotal,
            },
          ],
        },
        addresses: {
          create: [
            {
              type: "billing",
              firstName: sample.customer.name,
              email: sample.customer.email,
              phone: sample.customer.phone,
              document: sample.customer.document,
            },
            {
              type: "shipping",
              firstName: sample.customer.name,
              email: sample.customer.email,
              phone: sample.customer.phone,
              document: sample.customer.document,
              street: "Avenida Getúlio Vargas",
              number: "100",
              neighborhood: "Centro",
              city: "Chapecó",
              state: "SC",
              zip: "89800000",
            },
          ],
        },
        payments: {
          create: {
            type: "order",
            method: sample.payment,
            status: paid ? "paid" : "pending",
            amount: total,
            paidAt: paid ? new Date() : null,
          },
        },
        notesTimeline: {
          create: [
            {
              content: sample.note,
              customerVisible: false,
              authorType: "system",
              author: "Seed NALVEN",
            },
            ...(sample.status === "completed"
              ? [
                  {
                    content: "Obrigado pela compra. Seu pedido foi concluído.",
                    customerVisible: true,
                    authorType: "system",
                    author: "Auto Mais Peças",
                  },
                ]
              : []),
          ],
        },
        history: {
          create: [
            {
              toStatus: "pending",
              actor: "Seed NALVEN",
              actorType: "system",
              notes: "Pedido recebido",
            },
            ...(sample.status !== "pending"
              ? [
                  {
                    fromStatus: "pending",
                    toStatus: sample.status,
                    actor: "Seed NALVEN",
                    actorType: "system",
                    notes: sample.note,
                  },
                ]
              : []),
          ],
        },
        ...(sample.status === "shipped"
          ? {
              tracking: {
                create: {
                  trackingNumber: "AA123456789BR",
                  carrier: "Correios",
                  carrierKey: "correios",
                  trackingUrl:
                    "https://rastreamento.correios.com.br/app/index.php?objetos=AA123456789BR",
                  status: "posted",
                  statusLabel: "Objeto postado",
                  events: {
                    create: {
                      status: "posted",
                      description: "Objeto postado",
                      location: "Chapecó/SC",
                    },
                  },
                },
              },
            }
          : {}),
      },
    });
  }
  const inventoryProducts = await db.product.findMany({
    where: { type: "product" },
  });
  for (const product of inventoryProducts) {
    const existingBalance = await db.warehouseBalance.findUnique({
      where: {
        warehouseId_productId: {
          warehouseId: primaryWarehouse.id,
          productId: product.id,
        },
      },
    });
    if (!existingBalance) {
      await db.warehouseBalance.create({
        data: {
          warehouseId: primaryWarehouse.id,
          productId: product.id,
          quantity: product.stock,
        },
      });
      if (product.stock)
        await db.warehouseLedgerEntry.create({
          data: {
            warehouseId: primaryWarehouse.id,
            productId: product.id,
            type: "initial",
            quantity: product.stock,
            balanceBefore: 0,
            balanceAfter: product.stock,
            referenceType: "seed",
            referenceId: "initial-stock",
            actor: "Seed NALVEN",
          },
        });
    }
  }
  if (suiteProducts.length >= 3) {
    if (
      !(await db.stockTransfer.findUnique({
        where: { number: "TRF-DEMO-0001" },
      }))
    )
      await db.$transaction(async (tx) => {
        const rows = [
          { product: suiteProducts[0], quantity: 6 },
          { product: suiteProducts[1], quantity: 4 },
        ];
        const sourceBalances = await tx.warehouseBalance.findMany({
          where: {
            warehouseId: primaryWarehouse.id,
            productId: { in: rows.map((row) => row.product.id) },
          },
        });
        if (
          sourceBalances.length !== rows.length ||
          rows.some(
            (row) =>
              (sourceBalances.find(
                (balance) => balance.productId === row.product.id,
              )?.quantity || 0) < row.quantity,
          )
        )
          return;
        const transfer = await tx.stockTransfer.create({
          data: {
            number: "TRF-DEMO-0001",
            fromWarehouseId: primaryWarehouse.id,
            toWarehouseId: reserveWarehouse.id,
            status: "completed",
            notes: "Reposição programada do estoque de reserva.",
            transferredBy: "Seed NALVEN",
            createdAt: new Date("2026-08-29T14:30:00.000Z"),
            items: {
              create: rows.map((row) => ({
                productId: row.product.id,
                quantity: row.quantity,
              })),
            },
          },
        });
        for (const row of rows) {
          const source = sourceBalances.find(
            (balance) => balance.productId === row.product.id,
          )!;
          const destination = await tx.warehouseBalance.findUnique({
            where: {
              warehouseId_productId: {
                warehouseId: reserveWarehouse.id,
                productId: row.product.id,
              },
            },
          });
          await tx.warehouseBalance.update({
            where: { id: source.id },
            data: { quantity: { decrement: row.quantity } },
          });
          const updatedDestination = await tx.warehouseBalance.upsert({
            where: {
              warehouseId_productId: {
                warehouseId: reserveWarehouse.id,
                productId: row.product.id,
              },
            },
            update: { quantity: { increment: row.quantity } },
            create: {
              warehouseId: reserveWarehouse.id,
              productId: row.product.id,
              quantity: row.quantity,
            },
          });
          await tx.warehouseLedgerEntry.createMany({
            data: [
              {
                warehouseId: primaryWarehouse.id,
                productId: row.product.id,
                type: "transfer_out",
                quantity: -row.quantity,
                balanceBefore: source.quantity,
                balanceAfter: source.quantity - row.quantity,
                referenceType: "stock_transfer",
                referenceId: String(transfer.id),
                actor: "Seed NALVEN",
                createdAt: new Date("2026-08-29T14:30:00.000Z"),
              },
              {
                warehouseId: reserveWarehouse.id,
                productId: row.product.id,
                type: "transfer_in",
                quantity: row.quantity,
                balanceBefore: destination?.quantity || 0,
                balanceAfter: updatedDestination.quantity,
                referenceType: "stock_transfer",
                referenceId: String(transfer.id),
                actor: "Seed NALVEN",
                createdAt: new Date("2026-08-29T14:30:00.000Z"),
              },
            ],
          });
        }
      });
    if (
      !(await db.inventoryCount.findUnique({
        where: { number: "INV-DEMO-0001" },
      }))
    )
      await db.$transaction(async (tx) => {
        const products = suiteProducts.slice(0, 3),
          balances = await tx.warehouseBalance.findMany({
            where: {
              warehouseId: primaryWarehouse.id,
              productId: { in: products.map((product) => product.id) },
            },
          }),
          adjustments = [1, -1, 0];
        if (balances.length !== products.length) return;
        const count = await tx.inventoryCount.create({
          data: {
            number: "INV-DEMO-0001",
            warehouseId: primaryWarehouse.id,
            status: "completed",
            blind: true,
            notes:
              "Contagem cega demonstrativa com sobras e perdas conciliadas.",
            createdBy: "Seed NALVEN",
            countedBy: "Equipe de inventário",
            createdAt: new Date("2026-08-30T08:00:00.000Z"),
            completedAt: new Date("2026-08-30T11:20:00.000Z"),
            items: {
              create: products.map((product, index) => {
                const balance = balances.find(
                  (item) => item.productId === product.id,
                )!;
                return {
                  productId: product.id,
                  systemQuantity: balance.quantity,
                  countedQuantity: balance.quantity + adjustments[index],
                  difference: adjustments[index],
                };
              }),
            },
          },
        });
        for (const [index, product] of products.entries()) {
          const difference = adjustments[index];
          if (!difference) continue;
          const balance = balances.find(
            (item) => item.productId === product.id,
          )!;
          await tx.warehouseBalance.update({
            where: { id: balance.id },
            data: { quantity: { increment: difference } },
          });
          await tx.product.update({
            where: { id: product.id },
            data: { stock: { increment: difference } },
          });
          await tx.warehouseLedgerEntry.create({
            data: {
              warehouseId: primaryWarehouse.id,
              productId: product.id,
              type: "count_adjustment",
              quantity: difference,
              balanceBefore: balance.quantity,
              balanceAfter: balance.quantity + difference,
              referenceType: "inventory_count",
              referenceId: String(count.id),
              actor: "Equipe de inventário",
              createdAt: new Date("2026-08-30T11:20:00.000Z"),
            },
          });
        }
      });
    if (
      !(await db.inventoryCount.findFirst({
        where: { warehouseId: reserveWarehouse.id, status: "draft" },
      })) &&
      !(await db.inventoryCount.findUnique({
        where: { number: "INV-DEMO-0002" },
      }))
    ) {
      const balances = await db.warehouseBalance.findMany({
        where: {
          warehouseId: reserveWarehouse.id,
          productId: { in: suiteProducts.map((product) => product.id) },
        },
      });
      await db.inventoryCount.create({
        data: {
          number: "INV-DEMO-0002",
          warehouseId: reserveWarehouse.id,
          status: "draft",
          blind: true,
          notes: "Contagem cíclica cega aguardando preenchimento.",
          createdBy: "Seed NALVEN",
          items: {
            create: suiteProducts.map((product) => ({
              productId: product.id,
              systemQuantity:
                balances.find((balance) => balance.productId === product.id)
                  ?.quantity || 0,
            })),
          },
        },
      });
    }
  }
}

async function createSeedCatalogBoundary(input: {
  name: string;
  sku: string;
  actorUserId: string;
  variations: Array<Record<string, unknown>>;
}) {
  return db.$transaction(
    async (tx) => {
      const idempotencyKey = createHash("sha256")
        .update(`seed-catalog:${input.sku}`)
        .digest("hex");
      const productProjection = {
        active: true,
        gtinSnapshot: null,
        manageStock: true,
        nameLabel: input.name,
        productType: "product",
        skuSnapshot: input.sku,
        status: "publish",
        unit: "UN",
      };
      const request = {
        action: "put_graph",
        actorUserId: input.actorUserId,
        expectedProductConfigHash: null,
        expectedProductRevision: null,
        idempotencyKey,
        productId: null,
        productProjection,
        schemaVersion: 1,
        variations: input.variations,
      };
      const requestHash = createHash("sha256")
        .update("t2-catalog-boundary-request-v1\0", "utf8")
        .update(seedCanonical(request), "utf8")
        .digest("hex");
      const [resultRow] = await tx.$queryRaw<
        Array<{
          result: {
            productId: number;
            variations: Array<{ variationId: number; ordinal: number }>;
          };
        }>
      >(Prisma.sql`
      SELECT public.pos_t2_catalog_boundary_v1(
        'put_graph'::text, NULL::integer, NULL::integer, NULL::text,
        ${JSON.stringify(productProjection)}::jsonb, ${JSON.stringify(input.variations)}::jsonb,
        ${input.actorUserId}::text, ${idempotencyKey}::text, ${requestHash}::text
      ) AS result
    `);
      await tx.product.create({
        data: {
          id: Number(resultRow.result.productId),
          name: input.name,
          slug: `catalogo-${input.sku.toLowerCase()}-${slugifySeed(input.name)}`,
          sku: input.sku,
          category: "Catálogo",
          type: "product",
          status: "publish",
          active: true,
          manageStock: true,
          unit: "UN",
        },
      });
      for (const variationResult of resultRow.result.variations) {
        const source = input.variations[variationResult.ordinal];
        await tx.productVariation.create({
          data: {
            id: Number(variationResult.variationId),
            productId: Number(resultRow.result.productId),
            sku: String(source.skuSnapshot),
            status: String(source.status),
            attributes: [],
            manageStock: String(source.manageStock),
            enabled: source.enabled === true,
            menuOrder: variationResult.ordinal,
          },
        });
      }
      return { productId: Number(resultRow.result.productId) };
    },
    { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 },
  );
}

function seedCanonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value))
      throw new Error("Seed T2 exige inteiros canônicos.");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(seedCanonical).join(",")}]`;
  if (typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) =>
        Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8")),
      )
      .map(([key, child]) => `${JSON.stringify(key)}:${seedCanonical(child)}`)
      .join(",")}}`;
  throw new Error("Valor não canônico no seed T2.");
}

function slugifySeed(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function seedVariationScheme(index: number) {
  const schemes = [
    {
      attributes: [
        { name: "Volume", slug: "volume", values: ["1 L", "4 L", "5 L"] },
        {
          name: "Aplicação",
          slug: "aplicacao",
          values: ["Leve", "Utilitário", "Diesel"],
        },
      ],
      combinations: [
        { Volume: "1 L", Aplicação: "Leve" },
        { Volume: "4 L", Aplicação: "Utilitário" },
        { Volume: "5 L", Aplicação: "Diesel" },
      ],
    },
    {
      attributes: [
        {
          name: "Viscosidade",
          slug: "viscosidade",
          values: ["5W30", "10W40", "15W40"],
        },
        {
          name: "Tecnologia",
          slug: "tecnologia",
          values: ["Sintético", "Semissintético"],
        },
      ],
      combinations: [
        { Viscosidade: "5W30", Tecnologia: "Sintético" },
        { Viscosidade: "10W40", Tecnologia: "Semissintético" },
        { Viscosidade: "15W40", Tecnologia: "Semissintético" },
      ],
    },
    {
      attributes: [
        { name: "Posição", slug: "posicao", values: ["Dianteiro", "Traseiro"] },
        { name: "Lado", slug: "lado", values: ["Direito", "Esquerdo", "Par"] },
      ],
      combinations: [
        { Posição: "Dianteiro", Lado: "Direito" },
        { Posição: "Dianteiro", Lado: "Esquerdo" },
        { Posição: "Traseiro", Lado: "Par" },
      ],
    },
    {
      attributes: [
        { name: "Tensão", slug: "tensao", values: ["12 V", "24 V"] },
        { name: "Encaixe", slug: "encaixe", values: ["H1", "H4", "H7"] },
      ],
      combinations: [
        { Tensão: "12 V", Encaixe: "H1" },
        { Tensão: "12 V", Encaixe: "H7" },
        { Tensão: "24 V", Encaixe: "H4" },
      ],
    },
    {
      attributes: [
        {
          name: "Medida",
          slug: "medida",
          values: ["Pequeno", "Médio", "Grande"],
        },
        { name: "Cor", slug: "cor", values: ["Preto", "Cinza", "Vermelho"] },
      ],
      combinations: [
        { Medida: "Pequeno", Cor: "Preto" },
        { Medida: "Médio", Cor: "Cinza" },
        { Medida: "Grande", Cor: "Vermelho" },
      ],
    },
  ];
  return schemes[index % schemes.length];
}

function seedColor(value: string) {
  return (
    (
      { Preto: "#15191d", Cinza: "#6b7280", Vermelho: "#b42318" } as Record<
        string,
        string
      >
    )[value] || null
  );
}

main().finally(() => db.$disconnect());
