-- 126: Catálogo mensal, entitlements e minuta SaaS do NALVEN.
--
-- O contrato de desenvolvimento do NALVEN continua sendo uma entrega única. Esta
-- migração cria a oferta recorrente separada (hospedagem, manutenção, suporte e
-- licença de uso), com três planos consumíveis pela API de licenciamento v1.

BEGIN;

ALTER TABLE planos
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'planos_metadata_check'
      AND conrelid = 'planos'::regclass
  ) THEN
    ALTER TABLE planos ADD CONSTRAINT planos_metadata_check
      CHECK (jsonb_typeof(metadata) = 'object');
  END IF;
END $$;

COMMENT ON COLUMN planos.metadata IS
  'Regras comerciais e operacionais estruturadas que não cabem nos campos legados do plano.';

INSERT INTO produtos_saas (
  conta_operacional_id, codigo, nome, slug, nome_comercial, descricao,
  resumo_comercial, tipo, status, cor_primaria, publicado, ordem_exibicao,
  metadata, landing_config
)
SELECT
  co.id,
  'nalven',
  'NALVEN',
  'nalven',
  'NALVEN',
  'Plataforma brasileira de gestão integrada para empresas, varejo, serviços e operação omnichannel.',
  'ERP, PDV, financeiro, CRM, e-commerce e marketplaces em uma plataforma modular.',
  'saas',
  'ativo',
  '#0F766E',
  false,
  20,
  '{}'::jsonb,
  '{}'::jsonb
FROM contas_operacionais co
WHERE co.codigo = 'agencia-expresso'
ON CONFLICT (codigo) DO NOTHING;

UPDATE produtos_saas
SET
  nome = 'NALVEN',
  slug = 'nalven',
  nome_comercial = 'NALVEN',
  descricao = 'Plataforma brasileira de gestão integrada para empresas, varejo, serviços e operação omnichannel.',
  resumo_comercial = 'ERP, PDV, financeiro, CRM, e-commerce e marketplaces em uma plataforma modular.',
  tipo = 'saas',
  status = 'ativo',
  cor_primaria = '#0F766E',
  -- O catálogo fica pronto, mas a publicação depende do SaaS ter provisionamento e
  -- webhook homologados. Publicar antes disso aceitaria cadastros que não chegariam ao NALVEN.
  publicado = false,
  metadata = COALESCE(metadata, '{}'::jsonb)
    - 'preco_recorrente_pendente'
    || jsonb_build_object(
      'modelo_comercial', 'assinatura_saas_mensal',
      'catalogo_planos_definido', true,
      'catalogo_definido_em', '2026-08-25',
      'contrato_modelo_codigo', 'nalven_assinatura_saas_mensal',
      'integracao_licencas', 'api_v1_disponivel',
      'produto_publicado', false,
      'publicacao_bloqueada_motivo', 'Aguardando URL, webhook e homologação do SaaS NALVEN',
      'propriedade_codigo_fonte_incluida', false,
      'sla_disponibilidade_percentual', 99.5,
      'backup_frequencia', 'diario',
      'aviso_cancelamento_dias', 30,
      'janela_exportacao_dias', 30,
      'exclusao_dados_dias', 60
    ),
  landing_config = jsonb_build_object(
    'sections', jsonb_build_object(
      'hero', jsonb_build_object(
        'titulo', 'NALVEN — Gestão que conecta o negócio todo',
        'subtitulo', 'ERP, PDV, financeiro, CRM, e-commerce e marketplaces em uma plataforma modular.',
        'visivel', true,
        'conteudo', jsonb_build_object(
          'badge_texto', 'Gestão integrada brasileira',
          'titulo_destaque', 'do caixa ao omnichannel',
          'cta_primario', jsonb_build_object('texto', 'Conhecer planos', 'href', '#planos')
        )
      ),
      'features', jsonb_build_object(
        'titulo', 'Módulos que acompanham a evolução da operação',
        'subtitulo', 'Comece com o essencial e avance para automação, governança e canais digitais.',
        'visivel', true
      ),
      'cta', jsonb_build_object(
        'titulo', 'Escolha o plano adequado ao seu momento',
        'subtitulo', 'A assinatura inclui hospedagem, atualizações, backup e suporte conforme o plano.',
        'visivel', true,
        'conteudo', jsonb_build_object(
          'cta', jsonb_build_object('texto', 'Criar conta', 'href', '/cadastro?produto=nalven')
        )
      )
    )
  ),
  updated_at = NOW()
WHERE codigo = 'nalven';

-- Os recursos antigos descrevem o projeto de desenvolvimento. Eles permanecem no
-- produto e no template do projeto, mas não entram duplicados no catálogo público.
UPDATE recursos
SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"ocultar_catalogo_publico":true}'::jsonb
WHERE codigo IN (
  'nalven_site_aquisicao', 'nalven_admin_saas', 'nalven_portal_cliente',
  'nalven_operacao_vendas', 'nalven_produtos_estoque', 'nalven_compras_fiscal',
  'nalven_crm', 'nalven_contratos_servicos', 'nalven_producao',
  'nalven_omnicanal_logistica', 'nalven_financeiro', 'nalven_fiscal',
  'nalven_cadastros', 'nalven_relatorios_governanca', 'nalven_experiencia',
  'nalven_integracoes_terceiros', 'nalven_hospedagem_mensal',
  'nalven_manutencao_suporte_mensal'
);

WITH catalogo(codigo,nome,descricao,categoria,icone,ordem,tipo_controle,metrica_codigo,unidade_uso,auditavel,ocultar_publico) AS (VALUES
  ('nalven_dashboard', 'Dashboard operacional', 'Visão consolidada de vendas, caixa, estoque e indicadores da operação.', 'Gestão', 'LayoutDashboard', 1000, 'habilitacao', NULL, NULL, false, false),
  ('nalven_cadastros_basicos', 'Cadastros essenciais', 'Clientes, fornecedores, categorias e estruturas cadastrais.', 'Cadastros', 'ContactRound', 1010, 'habilitacao', NULL, NULL, false, false),
  ('nalven_catalogo', 'Produtos e serviços', 'Cadastro de produtos, serviços, SKU, preço, custo e margem.', 'Operação', 'PackageSearch', 1020, 'habilitacao', NULL, NULL, false, false),
  ('nalven_estoque_basico', 'Estoque básico', 'Entradas, saídas, posição e movimentações essenciais de estoque.', 'Estoque', 'Boxes', 1030, 'habilitacao', NULL, NULL, false, false),
  ('nalven_pdv_vendas', 'PDV e vendas', 'Operação de frente de caixa, vendas e despesas.', 'Vendas', 'ShoppingCart', 1040, 'habilitacao', NULL, NULL, false, false),
  ('nalven_financeiro_basico', 'Financeiro básico', 'Contas a pagar e receber, caixa, contas e transferências.', 'Financeiro', 'WalletCards', 1050, 'habilitacao', NULL, NULL, false, false),
  ('nalven_relatorios_basicos', 'Relatórios básicos', 'Relatórios operacionais e financeiros essenciais.', 'Dados', 'ChartColumn', 1060, 'habilitacao', NULL, NULL, false, false),
  ('nalven_permissoes_basicas', 'Perfis e permissões básicas', 'Acessos por usuário e separação das funções principais.', 'Governança', 'UserRoundCog', 1070, 'habilitacao', NULL, NULL, false, false),
  ('nalven_hospedagem_saas', 'Hospedagem SaaS gerenciada', 'Infraestrutura necessária à operação da plataforma NALVEN.', 'Serviço mensal', 'CloudCog', 1080, 'habilitacao', NULL, NULL, false, false),
  ('nalven_backup_diario', 'Backup diário', 'Cópias diárias com retenção definida pelo plano contratado.', 'Continuidade', 'DatabaseBackup', 1090, 'habilitacao', NULL, NULL, false, false),
  ('nalven_atualizacoes', 'Atualizações da plataforma', 'Correções, segurança e evoluções gerais disponibilizadas no SaaS.', 'Serviço mensal', 'RefreshCcw', 1100, 'habilitacao', NULL, NULL, false, false),
  ('nalven_exportacao_lgpd', 'Exportação e controles LGPD', 'Exportação de dados e recursos de apoio aos direitos dos titulares.', 'Governança', 'FileDown', 1110, 'habilitacao', NULL, NULL, false, false),
  ('nalven_api_integracao', 'API de integração', 'Acesso à API conforme limites e nível do plano.', 'Integrações', 'Braces', 1120, 'habilitacao', NULL, NULL, true, false),
  ('nalven_suporte', 'Central de suporte', 'Abertura e acompanhamento de tickets no portal do cliente.', 'Suporte', 'LifeBuoy', 1130, 'habilitacao', NULL, NULL, false, false),

  ('nalven_orcamentos_pedidos', 'Orçamentos e pedidos', 'Fluxo comercial de orçamento, pedido, aprovação e venda.', 'Vendas', 'ClipboardList', 1200, 'habilitacao', NULL, NULL, false, false),
  ('nalven_compras_recebimento', 'Compras e recebimento', 'Cotações, pedidos de compra, recebimento e conferência.', 'Compras', 'Truck', 1210, 'habilitacao', NULL, NULL, false, false),
  ('nalven_xml_nfe', 'Importação de XML NF-e', 'Entrada assistida de documentos fiscais por XML.', 'Fiscal', 'FileInput', 1220, 'habilitacao', NULL, NULL, false, false),
  ('nalven_fiscal_preparado', 'Emissão fiscal preparada', 'Estrutura para NF-e, NFC-e e NFS-e, sujeita a credenciamento e provedores.', 'Fiscal', 'FileCheck2', 1230, 'habilitacao', NULL, NULL, false, false),
  ('nalven_crm_operacional', 'CRM operacional', 'Funil, oportunidades, atividades e histórico comercial.', 'Relacionamento', 'Handshake', 1240, 'habilitacao', NULL, NULL, false, false),
  ('nalven_servicos_recorrencia', 'Serviços, contratos e recorrência', 'Ordens de serviço, contratos e rotinas recorrentes.', 'Serviços', 'Repeat2', 1250, 'habilitacao', NULL, NULL, false, false),
  ('nalven_estoque_avancado', 'Estoque avançado', 'Lotes, séries, validade, depósitos e inventários.', 'Estoque', 'Warehouse', 1260, 'habilitacao', NULL, NULL, false, false),
  ('nalven_financeiro_avancado', 'Gestão financeira avançada', 'Conciliação, fluxo de caixa, DRE e orçamento.', 'Financeiro', 'ChartNoAxesCombined', 1270, 'habilitacao', NULL, NULL, false, false),
  ('nalven_relatorios_avancados', 'Relatórios avançados', 'Análises detalhadas e exportações gerenciais.', 'Dados', 'ChartSpline', 1280, 'habilitacao', NULL, NULL, false, false),
  ('nalven_permissoes_auditoria', 'Permissões completas e auditoria', 'Papéis detalhados, trilha de alterações e governança ampliada.', 'Governança', 'ShieldCheck', 1290, 'habilitacao', NULL, NULL, true, false),
  ('nalven_webhooks', 'Webhooks', 'Notificações de eventos para integrações externas.', 'Integrações', 'Webhook', 1300, 'habilitacao', NULL, NULL, true, false),
  ('nalven_suporte_prioritario', 'Suporte prioritário', 'Fila prioritária e tempos de primeira resposta reduzidos.', 'Suporte', 'Headphones', 1310, 'habilitacao', NULL, NULL, false, false),

  ('nalven_multiempresa', 'Multiempresa e consolidação', 'Operação de múltiplos CNPJs com visão consolidada.', 'Gestão', 'Building2', 1400, 'habilitacao', NULL, NULL, false, false),
  ('nalven_producao_kits', 'Produção, kits e composição', 'Ficha de composição, consumo de materiais, kits e produção.', 'Produção', 'Factory', 1410, 'habilitacao', NULL, NULL, false, false),
  ('nalven_ecommerce', 'E-commerce e catálogo digital', 'Loja hospedada e catálogo digital integrados ao ERP.', 'Canais digitais', 'Store', 1420, 'habilitacao', NULL, NULL, false, false),
  ('nalven_marketplaces', 'Mercado Livre e Shopee', 'Integrações com marketplaces conforme regras e APIs dos terceiros.', 'Canais digitais', 'ShoppingBag', 1430, 'habilitacao', NULL, NULL, true, false),
  ('nalven_sincronizacao_canais', 'Sincronização omnichannel', 'Sincronização de estoque, preço e pedidos entre canais.', 'Canais digitais', 'RefreshCw', 1440, 'habilitacao', NULL, NULL, true, false),
  ('nalven_logistica_integrada', 'Logística integrada', 'Etiquetas, rastreamento e apoio à logística reversa.', 'Logística', 'MapPinned', 1450, 'habilitacao', NULL, NULL, false, false),
  ('nalven_bi_avancado', 'BI avançado', 'Indicadores consolidados e análises avançadas da operação.', 'Dados', 'ChartCandlestick', 1460, 'habilitacao', NULL, NULL, false, false),
  ('nalven_api_avancada', 'API avançada', 'Maior capacidade de integração e automação por API.', 'Integrações', 'Workflow', 1470, 'habilitacao', NULL, NULL, true, false),
  ('nalven_suporte_prioritario_plus', 'Suporte prioritário Plus', 'Maior prioridade operacional e menor tempo de primeira resposta.', 'Suporte', 'BadgePlus', 1480, 'habilitacao', NULL, NULL, false, false),

  -- As cotas também são entitlements. Assim, um adicional comercial pode substituir
  -- limite_valor na licença sem alterar o plano público inteiro.
  ('nalven_empresas', 'Cota de empresas/CNPJs', 'Quantidade máxima de empresas ou CNPJs licenciados.', 'Limites', 'Gauge', 1500, 'cota', 'nalven_empresas_ativas', 'empresas', true, true),
  ('nalven_filiais', 'Cota de filiais', 'Quantidade máxima de filiais da assinatura.', 'Limites', 'Gauge', 1510, 'cota', 'nalven_filiais_ativas', 'filiais', true, true),
  ('nalven_usuarios_nomeados', 'Cota de usuários nomeados', 'Quantidade máxima de usuários nomeados ativos.', 'Limites', 'Gauge', 1520, 'cota', 'nalven_usuarios_ativos', 'usuarios', true, true),
  ('nalven_pdvs_simultaneos', 'Cota de PDVs simultâneos', 'Quantidade máxima de caixas em uso simultâneo.', 'Limites', 'Gauge', 1530, 'cota', 'nalven_pdvs_simultaneos', 'pdvs', true, true),
  ('nalven_skus_ativos', 'Cota de SKUs ativos', 'Quantidade máxima de SKUs ativos.', 'Limites', 'Gauge', 1540, 'cota', 'nalven_skus_ativos', 'skus', true, true),
  ('nalven_pedidos_mes', 'Cota de pedidos por mês', 'Quantidade máxima de vendas ou pedidos no ciclo mensal.', 'Limites', 'Gauge', 1550, 'cota', 'nalven_pedidos_mes', 'pedidos', true, true),
  ('nalven_armazenamento_gb', 'Cota de armazenamento', 'Espaço contratado para arquivos e documentos.', 'Limites', 'Gauge', 1560, 'cota', 'nalven_armazenamento_gb', 'GB', true, true),
  ('nalven_backup_dias', 'Retenção de backup', 'Quantidade de dias de retenção do backup.', 'Limites', 'Gauge', 1570, 'cota', 'nalven_backup_dias', 'dias', true, true),
  ('nalven_canais_digitais', 'Cota de canais digitais', 'Quantidade máxima de canais digitais conectados.', 'Limites', 'Gauge', 1580, 'cota', 'nalven_canais_ativos', 'canais', true, true)
)
INSERT INTO recursos (
  codigo, nome, descricao, categoria, icone, ordem, ativo,
  tipo_controle, metrica_codigo, unidade_uso, auditavel, metadata
)
SELECT
  codigo, nome, descricao, categoria, icone, ordem, true,
  tipo_controle, metrica_codigo, unidade_uso, auditavel,
  jsonb_build_object(
    'produto_origem', 'nalven',
    'origem', 'migration_126',
    'escopo_comercial', 'assinatura_saas',
    'ocultar_no_escopo_entrega', true,
    'ocultar_catalogo_publico', ocultar_publico
  )
FROM catalogo
ON CONFLICT (codigo) DO UPDATE SET
  nome = EXCLUDED.nome,
  descricao = EXCLUDED.descricao,
  categoria = EXCLUDED.categoria,
  icone = EXCLUDED.icone,
  ordem = EXCLUDED.ordem,
  ativo = true,
  tipo_controle = EXCLUDED.tipo_controle,
  metrica_codigo = EXCLUDED.metrica_codigo,
  unidade_uso = EXCLUDED.unidade_uso,
  auditavel = EXCLUDED.auditavel,
  metadata = recursos.metadata || EXCLUDED.metadata;

INSERT INTO produto_recursos (produto_id, recurso_id)
SELECT p.id, r.id
FROM produtos_saas p
JOIN recursos r ON r.metadata->>'produto_origem' = 'nalven'
WHERE p.codigo = 'nalven'
ON CONFLICT (produto_id, recurso_id) DO NOTHING;

WITH limites(codigo,nome,descricao,tipo_valor,sufixo,ordem,metrica,unidade,periodicidade,agregacao,excedente) AS (VALUES
  ('nalven_empresas', 'Empresas/CNPJs', 'Máximo de empresas ou CNPJs ativos.', 'numero', 'empresas', 1000, 'nalven_empresas_ativas', 'empresas', 'instantaneo', 'maximo', 'bloquear'),
  ('nalven_filiais', 'Filiais', 'Máximo de filiais ativas.', 'numero', 'filiais', 1010, 'nalven_filiais_ativas', 'filiais', 'instantaneo', 'maximo', 'bloquear'),
  ('nalven_usuarios_nomeados', 'Usuários nomeados', 'Máximo de usuários nomeados ativos.', 'numero', 'usuários', 1020, 'nalven_usuarios_ativos', 'usuarios', 'instantaneo', 'maximo', 'bloquear'),
  ('nalven_pdvs_simultaneos', 'PDVs simultâneos', 'Máximo de caixas utilizados simultaneamente.', 'numero', 'PDVs', 1030, 'nalven_pdvs_simultaneos', 'pdvs', 'instantaneo', 'maximo', 'bloquear'),
  ('nalven_skus_ativos', 'SKUs ativos', 'Máximo de SKUs ativos.', 'numero', 'SKUs', 1040, 'nalven_skus_ativos', 'skus', 'instantaneo', 'maximo', 'bloquear'),
  ('nalven_pedidos_mes', 'Pedidos por mês', 'Máximo de vendas ou pedidos no mês.', 'numero', 'pedidos/mês', 1050, 'nalven_pedidos_mes', 'pedidos', 'mensal', 'soma', 'bloquear'),
  ('nalven_armazenamento_gb', 'Armazenamento', 'Espaço máximo para arquivos e documentos.', 'gb', 'GB', 1060, 'nalven_armazenamento_gb', 'GB', 'instantaneo', 'maximo', 'bloquear'),
  ('nalven_backup_dias', 'Retenção de backup', 'Dias de retenção de backup.', 'numero', 'dias', 1070, 'nalven_backup_dias', 'dias', 'instantaneo', 'ultimo', 'alertar'),
  ('nalven_canais_digitais', 'Canais digitais', 'Máximo de canais digitais conectados.', 'numero', 'canais', 1080, 'nalven_canais_ativos', 'canais', 'instantaneo', 'maximo', 'bloquear')
)
INSERT INTO limites_tipos (
  codigo, nome, descricao, tipo_valor, sufixo, valor_ilimitado_label,
  ordem, ativo, metrica_codigo, unidade, periodicidade, agregacao,
  comportamento_excedente, percentual_alerta, permite_ilimitado,
  valor_minimo, metadata
)
SELECT
  codigo, nome, descricao, tipo_valor, sufixo, 'Ilimitado', ordem, true,
  metrica, unidade, periodicidade, agregacao, excedente, 80, false, 0,
  '{"produto_origem":"nalven","origem":"migration_126"}'::jsonb
FROM limites
ON CONFLICT (codigo) DO UPDATE SET
  nome = EXCLUDED.nome,
  descricao = EXCLUDED.descricao,
  tipo_valor = EXCLUDED.tipo_valor,
  sufixo = EXCLUDED.sufixo,
  ordem = EXCLUDED.ordem,
  ativo = true,
  metrica_codigo = EXCLUDED.metrica_codigo,
  unidade = EXCLUDED.unidade,
  periodicidade = EXCLUDED.periodicidade,
  agregacao = EXCLUDED.agregacao,
  comportamento_excedente = EXCLUDED.comportamento_excedente,
  permite_ilimitado = false,
  metadata = limites_tipos.metadata || EXCLUDED.metadata;

INSERT INTO produto_limites (produto_id, limite_tipo_id)
SELECT p.id, lt.id
FROM produtos_saas p
JOIN limites_tipos lt ON lt.metadata->>'produto_origem' = 'nalven'
WHERE p.codigo = 'nalven'
ON CONFLICT (produto_id, limite_tipo_id) DO NOTHING;

WITH ofertas(
  codigo,nome,descricao,preco_mensal,preco_anual,max_usuarios,
  max_pedidos,max_produtos,trial,popular,ordem,metadata
) AS (VALUES
  (
    'essencial', 'Essencial',
    'Gestão essencial para uma empresa, com PDV, estoque, financeiro e suporte padrão.',
    149.00::numeric, 1490.00::numeric, 3, 500, 2000, 14, false, 10,
    '{"implantacao_valor":490,"nivel_api":"limitado","nivel_suporte":"padrao","backup_retencao_dias":15,"ciclo_anual_meses_cobrados":10,"ciclo_anual_meses_acesso":12,"adicionais":{"usuario_mensal":29,"pdv_mensal":69,"cnpj_ou_filial_mensal_a_partir_de":99,"canal_mensal":99,"armazenamento_25gb_mensal":49,"treinamento_hora":200}}'::jsonb
  ),
  (
    'profissional', 'Profissional',
    'Operação completa com compras, fiscal, CRM, serviços, governança e relatórios avançados.',
    349.00::numeric, 3490.00::numeric, 8, 3000, 10000, 0, true, 20,
    '{"implantacao_valor":990,"nivel_api":"padrao","nivel_suporte":"prioritario","backup_retencao_dias":30,"ciclo_anual_meses_cobrados":10,"ciclo_anual_meses_acesso":12,"adicionais":{"usuario_mensal":39,"pdv_mensal":69,"cnpj_ou_filial_mensal_a_partir_de":99,"canal_mensal":99,"armazenamento_25gb_mensal":49,"treinamento_hora":200}}'::jsonb
  ),
  (
    'omnichannel', 'Omnichannel',
    'Gestão multiempresa com produção, e-commerce, marketplaces, sincronização e BI avançado.',
    697.00::numeric, 6970.00::numeric, 15, 10000, 50000, 0, false, 30,
    '{"implantacao_valor":1990,"nivel_api":"avancado","nivel_suporte":"prioritario_plus","backup_retencao_dias":30,"canais_inclusos":3,"ciclo_anual_meses_cobrados":10,"ciclo_anual_meses_acesso":12,"adicionais":{"usuario_mensal":49,"pdv_mensal":69,"cnpj_ou_filial_mensal_a_partir_de":99,"canal_mensal":99,"armazenamento_25gb_mensal":49,"treinamento_hora":200}}'::jsonb
  )
)
INSERT INTO planos (
  produto_id, codigo, nome, descricao, preco_mensal, preco_anual,
  preco_variavel, max_usuarios, max_pedidos_mes, max_produtos, features,
  trial_dias, popular, ordem_exibicao, ativo, desconto_anual_percentual,
  visibilidade, metadata
)
SELECT
  p.id, o.codigo, o.nome, o.descricao, o.preco_mensal, o.preco_anual,
  false, o.max_usuarios, o.max_pedidos, o.max_produtos, '[]'::jsonb,
  o.trial, o.popular, o.ordem, true, 16.67, 'publico',
  o.metadata || jsonb_build_object(
    'produto_codigo', 'nalven',
    'origem', 'proposta_comercial_nalven_2026-08-25',
    'sla_disponibilidade_percentual', 99.5,
    'backup_frequencia', 'diario',
    'reajuste_indice', 'IPCA',
    'multa_atraso_percentual', 2,
    'juros_atraso_percentual_mes', 1,
    'suspensao_apos_dias', 10,
    'cancelamento_aviso_dias', 30
  )
FROM ofertas o
CROSS JOIN LATERAL (SELECT id FROM produtos_saas WHERE codigo = 'nalven') p
ON CONFLICT (produto_id, codigo) DO UPDATE SET
  nome = EXCLUDED.nome,
  descricao = EXCLUDED.descricao,
  preco_mensal = EXCLUDED.preco_mensal,
  preco_anual = EXCLUDED.preco_anual,
  preco_variavel = false,
  max_usuarios = EXCLUDED.max_usuarios,
  max_pedidos_mes = EXCLUDED.max_pedidos_mes,
  max_produtos = EXCLUDED.max_produtos,
  trial_dias = EXCLUDED.trial_dias,
  popular = EXCLUDED.popular,
  ordem_exibicao = EXCLUDED.ordem_exibicao,
  ativo = true,
  desconto_anual_percentual = EXCLUDED.desconto_anual_percentual,
  visibilidade = 'publico',
  metadata = planos.metadata || EXCLUDED.metadata,
  updated_at = NOW();

WITH vinculos(plano_codigo,recurso_codigo,limite_valor,destaque) AS (VALUES
  -- Base presente nos três planos.
  ('essencial','nalven_dashboard',NULL,true), ('profissional','nalven_dashboard',NULL,true), ('omnichannel','nalven_dashboard',NULL,true),
  ('essencial','nalven_cadastros_basicos',NULL,false), ('profissional','nalven_cadastros_basicos',NULL,false), ('omnichannel','nalven_cadastros_basicos',NULL,false),
  ('essencial','nalven_catalogo',NULL,true), ('profissional','nalven_catalogo',NULL,true), ('omnichannel','nalven_catalogo',NULL,true),
  ('essencial','nalven_estoque_basico',NULL,true), ('profissional','nalven_estoque_basico',NULL,true), ('omnichannel','nalven_estoque_basico',NULL,true),
  ('essencial','nalven_pdv_vendas',NULL,true), ('profissional','nalven_pdv_vendas',NULL,true), ('omnichannel','nalven_pdv_vendas',NULL,true),
  ('essencial','nalven_financeiro_basico',NULL,true), ('profissional','nalven_financeiro_basico',NULL,true), ('omnichannel','nalven_financeiro_basico',NULL,true),
  ('essencial','nalven_relatorios_basicos',NULL,false), ('profissional','nalven_relatorios_basicos',NULL,false), ('omnichannel','nalven_relatorios_basicos',NULL,false),
  ('essencial','nalven_permissoes_basicas',NULL,false), ('profissional','nalven_permissoes_basicas',NULL,false), ('omnichannel','nalven_permissoes_basicas',NULL,false),
  ('essencial','nalven_hospedagem_saas',NULL,false), ('profissional','nalven_hospedagem_saas',NULL,false), ('omnichannel','nalven_hospedagem_saas',NULL,false),
  ('essencial','nalven_backup_diario',NULL,false), ('profissional','nalven_backup_diario',NULL,false), ('omnichannel','nalven_backup_diario',NULL,false),
  ('essencial','nalven_atualizacoes',NULL,false), ('profissional','nalven_atualizacoes',NULL,false), ('omnichannel','nalven_atualizacoes',NULL,false),
  ('essencial','nalven_exportacao_lgpd',NULL,false), ('profissional','nalven_exportacao_lgpd',NULL,false), ('omnichannel','nalven_exportacao_lgpd',NULL,false),
  ('essencial','nalven_api_integracao',NULL,false), ('profissional','nalven_api_integracao',NULL,false), ('omnichannel','nalven_api_integracao',NULL,false),
  ('essencial','nalven_suporte',NULL,false), ('profissional','nalven_suporte',NULL,false), ('omnichannel','nalven_suporte',NULL,false),

  -- Profissional e Omnichannel.
  ('profissional','nalven_orcamentos_pedidos',NULL,true), ('omnichannel','nalven_orcamentos_pedidos',NULL,true),
  ('profissional','nalven_compras_recebimento',NULL,true), ('omnichannel','nalven_compras_recebimento',NULL,true),
  ('profissional','nalven_xml_nfe',NULL,false), ('omnichannel','nalven_xml_nfe',NULL,false),
  ('profissional','nalven_fiscal_preparado',NULL,true), ('omnichannel','nalven_fiscal_preparado',NULL,true),
  ('profissional','nalven_crm_operacional',NULL,true), ('omnichannel','nalven_crm_operacional',NULL,true),
  ('profissional','nalven_servicos_recorrencia',NULL,false), ('omnichannel','nalven_servicos_recorrencia',NULL,false),
  ('profissional','nalven_estoque_avancado',NULL,false), ('omnichannel','nalven_estoque_avancado',NULL,false),
  ('profissional','nalven_financeiro_avancado',NULL,true), ('omnichannel','nalven_financeiro_avancado',NULL,true),
  ('profissional','nalven_relatorios_avancados',NULL,false), ('omnichannel','nalven_relatorios_avancados',NULL,false),
  ('profissional','nalven_permissoes_auditoria',NULL,false), ('omnichannel','nalven_permissoes_auditoria',NULL,false),
  ('profissional','nalven_webhooks',NULL,false), ('omnichannel','nalven_webhooks',NULL,false),
  ('profissional','nalven_suporte_prioritario',NULL,false), ('omnichannel','nalven_suporte_prioritario',NULL,false),

  -- Exclusivos Omnichannel.
  ('omnichannel','nalven_multiempresa',NULL,true),
  ('omnichannel','nalven_producao_kits',NULL,true),
  ('omnichannel','nalven_ecommerce',NULL,true),
  ('omnichannel','nalven_marketplaces',NULL,true),
  ('omnichannel','nalven_sincronizacao_canais',NULL,true),
  ('omnichannel','nalven_logistica_integrada',NULL,false),
  ('omnichannel','nalven_bi_avancado',NULL,true),
  ('omnichannel','nalven_api_avancada',NULL,false),
  ('omnichannel','nalven_suporte_prioritario_plus',NULL,false),

  -- Cotas espelhadas em recursos para permitir override por licença/adicional.
  ('essencial','nalven_empresas',1,false), ('profissional','nalven_empresas',1,false), ('omnichannel','nalven_empresas',3,false),
  ('essencial','nalven_filiais',1,false), ('profissional','nalven_filiais',2,false), ('omnichannel','nalven_filiais',5,false),
  ('essencial','nalven_usuarios_nomeados',3,false), ('profissional','nalven_usuarios_nomeados',8,false), ('omnichannel','nalven_usuarios_nomeados',15,false),
  ('essencial','nalven_pdvs_simultaneos',1,false), ('profissional','nalven_pdvs_simultaneos',2,false), ('omnichannel','nalven_pdvs_simultaneos',5,false),
  ('essencial','nalven_skus_ativos',2000,false), ('profissional','nalven_skus_ativos',10000,false), ('omnichannel','nalven_skus_ativos',50000,false),
  ('essencial','nalven_pedidos_mes',500,false), ('profissional','nalven_pedidos_mes',3000,false), ('omnichannel','nalven_pedidos_mes',10000,false),
  ('essencial','nalven_armazenamento_gb',5,false), ('profissional','nalven_armazenamento_gb',20,false), ('omnichannel','nalven_armazenamento_gb',100,false),
  ('essencial','nalven_backup_dias',15,false), ('profissional','nalven_backup_dias',30,false), ('omnichannel','nalven_backup_dias',30,false),
  ('essencial','nalven_canais_digitais',0,false), ('profissional','nalven_canais_digitais',0,false), ('omnichannel','nalven_canais_digitais',3,false)
)
INSERT INTO plano_recursos (plano_id,recurso_id,limite_valor,destaque,configuracao)
SELECT p.id,r.id,v.limite_valor,v.destaque,'{"origem":"migration_126"}'::jsonb
FROM vinculos v
JOIN produtos_saas ps ON ps.codigo='nalven'
JOIN planos p ON p.produto_id=ps.id AND p.codigo=v.plano_codigo
JOIN recursos r ON r.codigo=v.recurso_codigo
ON CONFLICT (plano_id,recurso_id) DO UPDATE SET
  limite_valor=EXCLUDED.limite_valor,
  destaque=EXCLUDED.destaque,
  configuracao=plano_recursos.configuracao || EXCLUDED.configuracao;

WITH valores(plano_codigo,limite_codigo,valor) AS (VALUES
  ('essencial','nalven_empresas',1), ('profissional','nalven_empresas',1), ('omnichannel','nalven_empresas',3),
  ('essencial','nalven_filiais',1), ('profissional','nalven_filiais',2), ('omnichannel','nalven_filiais',5),
  ('essencial','nalven_usuarios_nomeados',3), ('profissional','nalven_usuarios_nomeados',8), ('omnichannel','nalven_usuarios_nomeados',15),
  ('essencial','nalven_pdvs_simultaneos',1), ('profissional','nalven_pdvs_simultaneos',2), ('omnichannel','nalven_pdvs_simultaneos',5),
  ('essencial','nalven_skus_ativos',2000), ('profissional','nalven_skus_ativos',10000), ('omnichannel','nalven_skus_ativos',50000),
  ('essencial','nalven_pedidos_mes',500), ('profissional','nalven_pedidos_mes',3000), ('omnichannel','nalven_pedidos_mes',10000),
  ('essencial','nalven_armazenamento_gb',5), ('profissional','nalven_armazenamento_gb',20), ('omnichannel','nalven_armazenamento_gb',100),
  ('essencial','nalven_backup_dias',15), ('profissional','nalven_backup_dias',30), ('omnichannel','nalven_backup_dias',30),
  ('essencial','nalven_canais_digitais',0), ('profissional','nalven_canais_digitais',0), ('omnichannel','nalven_canais_digitais',3)
)
INSERT INTO plano_limites (plano_id,limite_tipo_id,valor,metadata)
SELECT p.id,lt.id,v.valor,'{"origem":"migration_126"}'::jsonb
FROM valores v
JOIN produtos_saas ps ON ps.codigo='nalven'
JOIN planos p ON p.produto_id=ps.id AND p.codigo=v.plano_codigo
JOIN limites_tipos lt ON lt.codigo=v.limite_codigo
ON CONFLICT (plano_id,limite_tipo_id) DO UPDATE SET
  valor=EXCLUDED.valor,
  metadata=plano_limites.metadata || EXCLUDED.metadata;

-- Compatibilidade com consumidores antigos. A fonte canônica continua sendo
-- plano_recursos; o JSON é somente um espelho dos códigos ativos.
UPDATE planos p
SET features = COALESCE((
  SELECT jsonb_agg(r.codigo ORDER BY r.ordem,r.codigo)
  FROM plano_recursos pr
  JOIN recursos r ON r.id=pr.recurso_id
  WHERE pr.plano_id=p.id
), '[]'::jsonb),
updated_at=NOW()
WHERE p.produto_id=(SELECT id FROM produtos_saas WHERE codigo='nalven');

INSERT INTO contrato_modelos (codigo,nome,tipo,descricao,corpo,variaveis)
VALUES (
  'nalven_assinatura_saas_mensal',
  'NALVEN — assinatura SaaS mensal',
  'assinatura',
  'Minuta recorrente do NALVEN para os planos Essencial, Profissional e Omnichannel. Não transfere a propriedade do código-fonte.',
  $nalven$
# CONTRATO DE LICENÇA DE USO DE SOFTWARE COMO SERVIÇO (SaaS) — NALVEN

Contrato nº {{numero_contrato}}

Pelo presente instrumento particular, de um lado {{contratada_razao_social}}, inscrita no CNPJ sob o nº {{contratada_cnpj}}, com sede em {{contratada_endereco}}, doravante denominada CONTRATADA; e, de outro, {{contratante_razao_social}}, inscrita no CPF/CNPJ sob o nº {{contratante_cnpj}}, com sede em {{contratante_endereco}}, neste ato representada por {{contratante_representante}}, CPF nº {{contratante_representante_documento}}, doravante denominada CONTRATANTE, resolvem celebrar este contrato.

# QUADRO-RESUMO DA CONTRATAÇÃO

- Plano: {{plano_nome}} (código {{plano_codigo}})
- Mensalidade: R$ {{valor_mensal}} ({{valor_mensal_extenso}})
- Implantação: {{valor_implantacao}}
- Vencimento: dia {{dia_vencimento}}
- Forma de pagamento: {{forma_pagamento}}
- Início da assinatura: {{data_inicio}}
- Ambiente/URL: {{ambiente_url}}
- Canais digitais inicialmente contratados: {{canais_iniciais}}
- Condição comercial: {{condicao_comercial}}
- API: {{nivel_api}}
- Suporte: {{nivel_suporte}}
- Retenção de backup: {{retencao_backup}}

# CLÁUSULA PRIMEIRA — OBJETO

1.1. A CONTRATADA disponibilizará à CONTRATANTE o NALVEN em modalidade Software como Serviço (SaaS), incluindo licença de uso não exclusiva, intransferível, temporária e limitada à vigência deste contrato, hospedagem, atualizações gerais, backup e suporte conforme o plano contratado.

1.2. Os módulos habilitados no plano são:

{{modulos_plano}}

1.3. Os limites operacionais do plano são:

{{limites_plano}}

1.4. Serviços sob medida, migração extraordinária, integração não prevista, desenvolvimento exclusivo e operação de terceiros não integram a mensalidade, salvo proposta ou aditivo expresso.

# CLÁUSULA SEGUNDA — IMPLANTAÇÃO E ACEITE

2.1. A implantação compreende configuração inicial, orientação e atividades descritas na proposta do plano. Importações complexas, saneamento de dados e customizações serão orçados separadamente.

2.2. A CONTRATANTE deverá disponibilizar informações, acessos, certificados e responsáveis em tempo hábil. Atrasos nessas dependências prorrogam os prazos correspondentes.

2.3. A disponibilização do ambiente e o uso em produção caracterizam o aceite operacional, sem prejuízo da correção de não conformidades reproduzíveis abrangidas pelo escopo.

# CLÁUSULA TERCEIRA — LICENÇA E PROPRIEDADE INTELECTUAL

3.1. Este contrato concede direito de uso do serviço durante sua vigência e não representa venda, cessão, copropriedade ou transferência do código-fonte, arquitetura, marcas, bibliotecas, métodos ou propriedade intelectual do NALVEN.

3.2. É vedado copiar, sublicenciar, revender, explorar o código, contornar controles de licença, realizar engenharia reversa ou permitir acesso não autorizado, ressalvadas as hipóteses legalmente irrenunciáveis.

3.3. Os dados inseridos pela CONTRATANTE permanecem de sua titularidade. Componentes gerais, correções e evoluções da plataforma permanecem de titularidade da CONTRATADA ou de seus licenciadores.

# CLÁUSULA QUARTA — DISPONIBILIDADE E MANUTENÇÃO

4.1. A meta mensal de disponibilidade é de 99,5%, excluídas manutenções programadas, força maior, falhas da internet ou infraestrutura da CONTRATANTE, atos da CONTRATANTE e indisponibilidade de serviços de terceiros.

4.2. Manutenções programadas serão comunicadas com antecedência razoável sempre que possível. Intervenções emergenciais de segurança poderão ocorrer sem aviso prévio.

4.3. Se a disponibilidade mensal ficar entre 99,00% e 99,49%, o crédito de serviço será de 5% da mensalidade; entre 98,00% e 98,99%, 10%; abaixo de 98,00%, 20%. O crédito deve ser solicitado em até 15 dias após o mês afetado e fica limitado a 20% da mensalidade, não sendo convertido em dinheiro.

# CLÁUSULA QUINTA — SUPORTE

5.1. O suporte será prestado pela central de tickets e pelos canais oficialmente divulgados, em horário comercial, salvo condição expressa do plano.

5.2. Primeira resposta por severidade:

- S1, operação crítica indisponível: Essencial em até 4 horas úteis; Profissional em até 2 horas úteis; Omnichannel em até 1 hora útil.
- S2, impacto alto sem paralisação total: Essencial em até 1 dia útil; Profissional em até 4 horas úteis; Omnichannel em até 2 horas úteis.
- S3, impacto normal ou dúvida: Essencial em até 2 dias úteis; Profissional em até 1 dia útil; Omnichannel em até 4 horas úteis.
- S4, melhoria ou evolução: triagem conforme planejamento; no Omnichannel, triagem prioritária.

5.3. Os prazos são de primeira resposta e diagnóstico inicial, não promessa automática de solução. O tempo de solução depende da causa, da complexidade e de terceiros.

# CLÁUSULA SEXTA — BACKUP E CONTINUIDADE

6.1. A CONTRATADA executará backup diário, com retenção conforme o plano. Backup não substitui os controles, conferências e exportações próprias da CONTRATANTE.

6.2. A restauração será realizada quando tecnicamente possível e poderá observar janela de manutenção e ponto de recuperação disponível.

# CLÁUSULA SÉTIMA — INTEGRAÇÕES E CANAIS DE TERCEIROS

7.1. E-commerce, Mercado Livre, Shopee, meios de pagamento, emissão fiscal, transportadoras e outras integrações dependem das APIs, credenciais, homologações, tarifas e políticas dos respectivos terceiros.

7.2. Mudanças, bloqueios ou indisponibilidades desses terceiros não configuram falha exclusiva do NALVEN. Adaptações relevantes ou novas exigências poderão demandar prazo e orçamento.

# CLÁUSULA OITAVA — PREÇO, FATURAMENTO E REAJUSTE

8.1. A CONTRATANTE pagará a mensalidade indicada no quadro-resumo. No ciclo anual, quando contratado, são cobradas 10 mensalidades para 12 meses de acesso, conforme o preço anual vigente.

8.2. A nota fiscal e a cobrança serão emitidas pela plataforma financeira da CONTRATADA. Custos de implantação, adicionais, consumo excedente e serviços extraordinários poderão ser cobrados separadamente.

8.3. Os valores serão reajustados a cada 12 meses pelo IPCA acumulado, ou por índice oficial que o substitua. Alterações tributárias ou de custos obrigatórios de terceiros poderão ser repassadas mediante comunicação.

# CLÁUSULA NONA — INADIMPLÊNCIA E SUSPENSÃO

9.1. O atraso implica multa de 2% e juros de 1% ao mês, calculados pro rata die.

9.2. Após 10 dias de atraso, a CONTRATADA poderá suspender o acesso e as integrações, preservado o tratamento dos dados conforme este contrato. O pagamento integral autoriza a reativação após a confirmação financeira.

9.3. A suspensão não elimina os valores vencidos nem o período já disponibilizado.

# CLÁUSULA DÉCIMA — ALTERAÇÃO DE PLANO E ADICIONAIS

10.1. Upgrades entram em vigor imediatamente, com cobrança proporcional quando aplicável. Downgrades entram em vigor no ciclo seguinte e dependem de adequação prévia aos novos limites.

10.2. Usuários, PDVs, CNPJs/filiais, canais, armazenamento e treinamento adicionais seguem a tabela comercial vigente e serão refletidos nos entitlements da licença.

10.3. Redução de plano não apaga dados automaticamente, mas recursos e operações acima do novo limite poderão ser bloqueados até a regularização.

# CLÁUSULA DÉCIMA PRIMEIRA — OBRIGAÇÕES DAS PARTES

11.1. A CONTRATADA manterá controles razoáveis de segurança, disponibilidade, backup, correção e suporte compatíveis com a modalidade SaaS.

11.2. A CONTRATANTE manterá usuários, senhas, certificados, cadastros fiscais e equipamentos sob sua responsabilidade; utilizará o serviço de forma lícita; conferirá informações fiscais e financeiras antes de transmiti-las; e comunicará incidentes sem demora.

11.3. Cada parte responde pelos seus empregados, prepostos e credenciais.

# CLÁUSULA DÉCIMA SEGUNDA — PROTEÇÃO DE DADOS E CONFIDENCIALIDADE

12.1. As partes tratarão dados pessoais em conformidade com a Lei nº 13.709/2018 (LGPD). Em regra, a CONTRATANTE atua como controladora dos dados de sua operação e a CONTRATADA como operadora, sem prejuízo das hipóteses em que trate dados como controladora independente para cobrança, segurança, prevenção a fraude e cumprimento legal.

12.2. A CONTRATADA adotará medidas técnicas e administrativas razoáveis, limitará acessos e comunicará incidentes relevantes sem demora injustificada.

12.3. As obrigações de confidencialidade permanecem por 5 anos após o encerramento, exceto para segredos comerciais protegidos por prazo superior em lei.

# CLÁUSULA DÉCIMA TERCEIRA — EXPORTAÇÃO E ELIMINAÇÃO DOS DADOS

13.1. Durante a vigência, a CONTRATANTE poderá utilizar os recursos de exportação disponíveis em seu plano.

13.2. Após o encerramento, a CONTRATANTE terá até 30 dias para solicitar exportação em formato tecnicamente disponível. Encerrada essa janela, os dados poderão ser eliminados em até 60 dias, ressalvadas obrigações legais, backups rotativos e evidências de segurança.

# CLÁUSULA DÉCIMA QUARTA — RESPONSABILIDADE

14.1. Nenhuma parte responderá por lucros cessantes, perda de oportunidade ou danos indiretos, salvo dolo, fraude, violação de confidencialidade, infração de propriedade intelectual ou hipótese em que a limitação seja vedada por lei.

14.2. Nas demais hipóteses, a responsabilidade total da CONTRATADA fica limitada à soma das mensalidades efetivamente pagas nos 6 meses anteriores ao fato gerador.

# CLÁUSULA DÉCIMA QUINTA — VIGÊNCIA E CANCELAMENTO

15.1. O contrato inicia em {{data_inicio}} e vigora por prazo indeterminado no ciclo mensal. Qualquer parte poderá cancelá-lo mediante aviso escrito com 30 dias de antecedência.

15.2. No ciclo anual, o acesso permanece pelo período contratado, observadas as condições comerciais e legais aplicáveis. Valores já vencidos e serviços executados permanecem devidos.

15.3. O descumprimento material não sanado após notificação, a prática ilícita, a violação de segurança ou a insolvência autorizam rescisão motivada.

# CLÁUSULA DÉCIMA SEXTA — ASSINATURA ELETRÔNICA

16.1. As partes reconhecem a validade da assinatura eletrônica e das evidências de autoria, integridade, data, hora, IP, autenticação e hash do documento, nos termos da legislação brasileira aplicável.

# CLÁUSULA DÉCIMA SÉTIMA — DISPOSIÇÕES GERAIS E FORO

17.1. A tolerância não implica renúncia. A nulidade de uma disposição não invalida as demais. Este contrato, seu quadro-resumo, a proposta e os aditivos compõem o acordo entre as partes.

17.2. Fica eleito o foro da Comarca de Anápolis/GO, com renúncia a qualquer outro, por mais privilegiado que seja.

E, por estarem de acordo, as partes assinam eletronicamente este instrumento na data de {{data_hoje}}.
  $nalven$,
  '[
    {"chave":"forma_pagamento","rotulo":"Forma de pagamento","ajuda":"Ex.: Pix, boleto ou cartão, conforme disponibilidade da cobrança.","obrigatoria":true},
    {"chave":"ambiente_url","rotulo":"Ambiente/URL do NALVEN","ajuda":"Use A definir enquanto o ambiente ainda não tiver endereço definitivo.","obrigatoria":true},
    {"chave":"canais_iniciais","rotulo":"Canais digitais iniciais","ajuda":"Informe Não se aplica quando o plano não inclui canais digitais.","obrigatoria":true}
  ]'::jsonb
)
ON CONFLICT (codigo) DO NOTHING;

INSERT INTO contrato_modelo_versoes (modelo_id,versao,corpo,variaveis)
SELECT id,versao,corpo,variaveis
FROM contrato_modelos
WHERE codigo='nalven_assinatura_saas_mensal'
ON CONFLICT (modelo_id,versao) DO NOTHING;

COMMIT;
