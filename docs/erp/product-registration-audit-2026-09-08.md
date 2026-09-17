# Auditoria de produtos e serviços — 08/09/2026

Escopo: `/erp/produtos-servicos`, cadastro, edição, duplicação, consulta, serialização do formulário, API e persistência. Revisão de código de todas as seções; testes de navegador em ambiente local com o componente real e envio simulado. Nenhuma alteração em dados reais ou publicação em produção.

## Correções realizadas

- Obrigatoriedade visível junto ao rótulo; associação acessível entre rótulos e controles, ajuda e erros locais.
- Lista de pendências clicáveis, quantidade por seção, foco e abertura da aba com erro; correção atualiza o destaque.
- SKU obrigatório conforme configuração da empresa, com verificação de duplicidade no catálogo e servidor.
- Validação de nome em branco, categoria, números, URLs HTTP/HTTPS, GTIN, formatos de NCM/CEST/SPED, período promocional e compatibilidade de serviço com o tipo de catálogo.
- URL obrigatória para catálogo externo. Linhas incompletas de downloads, atributos, custos e faixas de quantidade recebem orientação antes do envio.
- Navegação Anterior/Próxima e contador usam somente as seções disponíveis no plano.
- Consulta de todas as seções pelo menu “Visualizar item”; links de produto vindos dos relatórios abrem consulta.
- Falha no salvamento mantém os dados e informa o próximo passo dentro do modal.
- Duplicação começa com SKU, URL amigável e estoque novos; variações não reutilizam identificadores e SKUs.
- Variações novas não enviam `id: null` como se fossem identificadores persistidos; servidor também aceita ausência nula de identificador.
- Edição de cadastro não regrava o saldo disponível da filial como estoque global. Estoque existente passa a consulta; movimentações continuam no fluxo próprio.
- Custo base e estoque mínimo do catálogo são preservados mesmo quando a listagem utiliza valores específicos da filial.
- Conversão em serviço ou desativação do controle com saldo existente exige zerar o saldo por movimentação.
- Perfis de marketplaces são preservados ao editar sem acesso à seção no plano; opções de atributos preservam valor e mídia ao manter o nome.
- API rejeita atualização sem identificador válido, evitando criação acidental.

## Mapa funcional das seções

| Seção | Cobertura revisada | Pontos ainda necessários |
|---|---|---|
| Essencial | Identidade, natureza, categoria, marca, fornecedor, descrição, publicação, URL externa | Seletor de fornecedor vinculado a cadastro; esclarecer publicação versus item ativo. |
| Preços | Regular, promoção, datas, custo, COGS, margem, componentes e faixas | Prévia de preço efetivo e margem; validações entre faixas sobrepostas. |
| Estoque/logística | Saldo, mínimo, controle, unidade, medidas, frete e garantia | Conversão assistida produto/serviço; explicar e exibir saldo físico versus reservado; testar operações com múltiplos depósitos em banco isolado. |
| Fiscal | Identificadores, NCM, CEST, origem, SPED, tributos e registros | Regras condicionais por operação fiscal, regime e emissão. Esta revisão não certifica adequação tributária. |
| Mídia | Imagem, galeria, vídeo, arquivos e downloads | Verificar upload e download com armazenamento real e permissões; ampliar rótulos persistentes nos repetidores. |
| Variações | Atributos, opções, imagens, preços e estoque por variação | Editor estruturado de pares; validar duplicidade de combinações, promoções e SKUs entre variações; testar atualização transacional com saldo por variação. |
| SEO | Títulos, descrição, palavras-chave, canonical, indexação e imagem social | Prévia de busca e cálculo de pontuação, que permanece um campo informado. |
| Extras | Relações, tags, selos, campos personalizados, configurador e carrossel | Validar linhas parcialmente preenchidas de todos os repetidores; substituir tipos técnicos do configurador por rótulos em português. |
| Marketplaces | Perfis por plataforma, conta, categoria remota, catálogo, preço, estoque e ficha | Prontidão ainda calculada no servidor ao salvar; falta checklist contextual por plataforma e categoria com validação real dos conectores. |

## Limites e próximas verificações

- A auditoria mapeia todos os controles nomeados abaixo e os repetidores acima. Não equivale a um teste transacional de cada combinação em banco real.
- Há relações reconstruídas ao salvar; verificar consumidores dos identificadores dos perfis e atributos antes de evoluir a estratégia para atualizações incrementais.
- Revalidar permissões de escrita na interface para perfis somente leitura; a API já exige `products.write`.
- A edição de estoque por variação merece a mesma separação operacional adotada para o item principal.
- Não foram feitos testes de emissão fiscal, envio a marketplaces ou upload real.

## Inventário dos controles nomeados

A regra “Não / conforme operação” significa que o campo não bloqueia todo cadastro básico; quando preenchido, continua sujeito à validação de formato, faixa e servidor.

| Seção | Campo | Obrigatoriedade no formulário |
|---|---|---|
| essencial | `name` | Sim |
| essencial | `slug` | Não / conforme operação |
| essencial | `sku` | Quando geração automática desativada |
| essencial | `type` | Não / conforme operação |
| essencial | `catalogType` | Não / conforme operação |
| essencial | `status` | Não / conforme operação |
| essencial | `catalogVisibility` | Não / conforme operação |
| essencial | `menuOrder` | Não / conforme operação |
| essencial | `categoryId` | Categoria existente OU nova categoria |
| essencial | `category` | Não / conforme operação |
| essencial | `categoryIds` | Não / conforme operação |
| essencial | `brand` | Não / conforme operação |
| essencial | `model` | Não / conforme operação |
| essencial | `mpn` | Não / conforme operação |
| essencial | `gtin` | Não / conforme operação |
| essencial | `barcode` | Não / conforme operação |
| essencial | `gender` | Não / conforme operação |
| essencial | `supplier` | Não / conforme operação |
| essencial | `shortDescription` | Não / conforme operação |
| essencial | `description` | Não / conforme operação |
| essencial | `externalUrl` | Catálogo externo |
| essencial | `buttonText` | Não / conforme operação |
| essencial | `active` | Não / conforme operação |
| essencial | `featured` | Não / conforme operação |
| essencial | `reviewsAllowed` | Não / conforme operação |
| essencial | `purchaseNote` | Não / conforme operação |
| precos | `regularPrice` | Sim |
| precos | `salePrice` | Não / conforme operação |
| precos | `saleStartsAt` | Não / conforme operação |
| precos | `saleEndsAt` | Não / conforme operação |
| precos | `cashPrice` | Não / conforme operação |
| precos | `installmentPrice` | Não / conforme operação |
| precos | `minimumSalePrice` | Não / conforme operação |
| precos | `targetMargin` | Não / conforme operação |
| precos | `cost` | Não / conforme operação |
| precos | `cogs` | Não / conforme operação |
| precos | `pricingSource` | Não / conforme operação |
| estoque | `manageStock` | Não / conforme operação |
| estoque | `soldIndividually` | Não / conforme operação |
| estoque | `virtual` | Não / conforme operação |
| estoque | `freeShipping` | Não / conforme operação |
| estoque | `stock` | Não / conforme operação |
| estoque | `minStock` | Não / conforme operação |
| estoque | `stockStatus` | Não / conforme operação |
| estoque | `backorders` | Não / conforme operação |
| estoque | `unit` | Não / conforme operação |
| estoque | `weight` | Não / conforme operação |
| estoque | `weightUnit` | Não / conforme operação |
| estoque | `length` | Não / conforme operação |
| estoque | `width` | Não / conforme operação |
| estoque | `height` | Não / conforme operação |
| estoque | `dimensionUnit` | Não / conforme operação |
| estoque | `netWeight` | Não / conforme operação |
| estoque | `grossWeight` | Não / conforme operação |
| estoque | `volumes` | Não / conforme operação |
| estoque | `itemsPerBox` | Não / conforme operação |
| estoque | `shippingClass` | Não / conforme operação |
| estoque | `crossDockingDays` | Não / conforme operação |
| estoque | `warrantyMonths` | Não / conforme operação |
| fiscal | `condition` | Não / conforme operação |
| fiscal | `fiscalType` | Não / conforme operação |
| fiscal | `production` | Não / conforme operação |
| fiscal | `expiryDate` | Não / conforme operação |
| fiscal | `gtinTributary` | Não / conforme operação |
| fiscal | `ncm` | Não / conforme operação |
| fiscal | `cest` | Não / conforme operação |
| fiscal | `cestNotApplicable` | Não / conforme operação |
| fiscal | `origin` | Não / conforme operação |
| fiscal | `spedItemType` | Não / conforme operação |
| fiscal | `taxBurdenRate` | Não / conforme operação |
| fiscal | `taxStatus` | Não / conforme operação |
| fiscal | `taxClass` | Não / conforme operação |
| fiscal | `csosn` | Não / conforme operação |
| fiscal | `fci` | Não / conforme operação |
| fiscal | `icmsStBase` | Não / conforme operação |
| fiscal | `icmsStValue` | Não / conforme operação |
| fiscal | `icmsSubstituteValue` | Não / conforme operação |
| fiscal | `ipiExceptionCode` | Não / conforme operação |
| fiscal | `ipiClassification` | Não / conforme operação |
| fiscal | `pisFixedValue` | Não / conforme operação |
| fiscal | `cofinsFixedValue` | Não / conforme operação |
| fiscal | `anatelCode` | Não / conforme operação |
| fiscal | `anvisaCode` | Não / conforme operação |
| fiscal | `inmetroCode` | Não / conforme operação |
| fiscal | `mapaCode` | Não / conforme operação |
| fiscal | `additionalInvoiceInfo` | Não / conforme operação |
| midia | `videoType` | Não / conforme operação |
| midia | `videoUrl` | Não / conforme operação |
| midia | `videoAspectRatio` | Não / conforme operação |
| midia | `downloadable` | Não / conforme operação |
| midia | `downloadLimit` | Não / conforme operação |
| midia | `downloadExpiryDays` | Não / conforme operação |
| variacoes | `defaultVariationRule` | Não / conforme operação |
| seo | `seoTitle` | Não / conforme operação |
| seo | `seoDescription` | Não / conforme operação |
| seo | `seoFocusKeyword` | Não / conforme operação |
| seo | `seoSecondaryKeywords` | Não / conforme operação |
| seo | `seoCanonical` | Não / conforme operação |
| seo | `seoSchemaType` | Não / conforme operação |
| seo | `seoScore` | Não / conforme operação |
| seo | `seoNoindex` | Não / conforme operação |
| extras | `tags` | Não / conforme operação |
| extras | `carouselEnabled` | Não / conforme operação |
| extras | `carouselAutoplay` | Não / conforme operação |
| extras | `carouselInterval` | Não / conforme operação |

## Verificação executada

- `npm run test:unit`: passou, incluindo o pré-teste de produção, com URL de banco fictícia no ambiente para carregamento dos módulos; sem conexão aos dados reais.
- `npm run lint`: passou.
- `node outputs/product-audit/browser-check.mjs`: nove verificações/capturas passaram no componente real com envio simulado, incluindo edição com ID e custo base preservados e estoque omitido.
- Build: compilação e TypeScript passaram. A geração estática falhou em `/_not-found` porque o layout consulta `systemSetting` para obter o domínio público e o banco de controle não foi disponibilizado para este build. O build completo não está aprovado.
- Rotas do serviço já em execução: `/` retornou 200; `/api/erp` retornou 401; `/api/saas` retornou 403 sem autenticação. Isso verifica resposta e proteção das rotas, não a versão alterada nem uma sessão autenticada.
- Capturas: `outputs/product-audit/required-desktop.png` e `required-mobile.png`.
- As alterações estão no workspace. Não houve deploy.
