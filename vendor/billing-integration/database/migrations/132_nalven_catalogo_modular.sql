-- 132: Catálogo comercial modular do NALVEN.
--
-- Preserva os planos e entitlements criados na migração 126 e adiciona a
-- embalagem comercial necessária para contratar módulos avulsos. Recursos
-- continuam sendo a unidade técnica de autorização da licença.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM produtos_saas WHERE codigo='nalven') THEN
    RAISE EXCEPTION 'Produto NALVEN não encontrado; aplique a migração 126 primeiro';
  END IF;

  IF to_regclass('public.catalogo_modulos') IS NULL THEN
    RAISE EXCEPTION 'Catálogo modular não encontrado; aplique a migração 129 primeiro';
  END IF;
END $$;

-- O preço do cartão inclui R$ 20 sobre Pix/boleto. Todos os valores podem ser
-- editados posteriormente pelo painel do produto sem nova migração.
WITH dados(
  codigo,nome,descricao,categoria,icone,
  preco_pix,preco_boleto,preco_cartao,ordem
) AS (VALUES
  (
    'gestao_base','Gestão e cadastros','Dashboard, cadastros essenciais, relatórios básicos e perfis de acesso.',
    'Gestão','LayoutDashboard',49.00,49.00,69.00,10
  ),
  (
    'catalogo_estoque','Catálogo e estoque','Produtos, serviços, SKU, preço, custo, margem e movimentações essenciais de estoque.',
    'Operação','PackageSearch',59.00,59.00,79.00,20
  ),
  (
    'pdv_vendas','PDV e vendas','Frente de caixa, vendas e despesas operacionais.',
    'Vendas','ShoppingCart',69.00,69.00,89.00,30
  ),
  (
    'financeiro_base','Financeiro essencial','Contas a pagar e receber, caixa, contas e transferências.',
    'Financeiro','WalletCards',79.00,79.00,99.00,40
  ),
  (
    'vendas_pedidos','Orçamentos e pedidos','Orçamentos, pedidos, aprovação e conversão em venda.',
    'Vendas','ClipboardList',49.00,49.00,69.00,50
  ),
  (
    'compras_fiscal','Compras e fiscal','Compras, recebimento, importação de XML e estrutura de emissão fiscal.',
    'Fiscal','FileCheck2',99.00,99.00,119.00,60
  ),
  (
    'crm','CRM operacional','Funil, oportunidades, atividades e histórico comercial.',
    'Relacionamento','Handshake',69.00,69.00,89.00,70
  ),
  (
    'servicos_recorrencia','Serviços e recorrência','Ordens de serviço, contratos e rotinas recorrentes.',
    'Serviços','Repeat2',69.00,69.00,89.00,80
  ),
  (
    'operacao_avancada','Estoque e financeiro avançados','Lotes, séries, depósitos, inventários, conciliação, fluxo de caixa, DRE e orçamento.',
    'Gestão','ChartNoAxesCombined',99.00,99.00,119.00,90
  ),
  (
    'governanca_analytics','Governança e análises','Relatórios avançados, papéis detalhados, auditoria e exportações gerenciais.',
    'Governança','ShieldCheck',89.00,89.00,109.00,100
  ),
  (
    'multiempresa_producao','Multiempresa e produção','Múltiplos CNPJs, consolidação, produção, kits e composição de materiais.',
    'Expansão','Factory',149.00,149.00,169.00,110
  ),
  (
    'omnichannel','E-commerce e omnichannel','E-commerce, marketplaces, sincronização de canais, logística integrada e BI avançado.',
    'Canais digitais','Store',199.00,199.00,219.00,120
  )
)
INSERT INTO catalogo_modulos (
  produto_id,codigo,nome,descricao,categoria,icone,
  preco_pix,preco_boleto,preco_cartao,ordem,metadata
)
SELECT
  p.id,d.codigo,d.nome,d.descricao,d.categoria,d.icone,
  d.preco_pix,d.preco_boleto,d.preco_cartao,d.ordem,
  jsonb_build_object(
    'origem','migration_132',
    'precificacao','editavel',
    'produto_codigo','nalven'
  )
FROM dados d
CROSS JOIN LATERAL (SELECT id FROM produtos_saas WHERE codigo='nalven') p
ON CONFLICT (produto_id,codigo) DO UPDATE SET
  nome=EXCLUDED.nome,
  descricao=EXCLUDED.descricao,
  categoria=EXCLUDED.categoria,
  icone=EXCLUDED.icone,
  preco_pix=EXCLUDED.preco_pix,
  preco_boleto=EXCLUDED.preco_boleto,
  preco_cartao=EXCLUDED.preco_cartao,
  ordem=EXCLUDED.ordem,
  ativo=TRUE,
  publicado=TRUE,
  metadata=catalogo_modulos.metadata || EXCLUDED.metadata,
  updated_at=NOW();

WITH vinculos(modulo_codigo,recurso_codigo) AS (VALUES
  ('gestao_base','nalven_dashboard'),
  ('gestao_base','nalven_cadastros_basicos'),
  ('gestao_base','nalven_relatorios_basicos'),
  ('gestao_base','nalven_permissoes_basicas'),
  ('catalogo_estoque','nalven_catalogo'),
  ('catalogo_estoque','nalven_estoque_basico'),
  ('pdv_vendas','nalven_pdv_vendas'),
  ('financeiro_base','nalven_financeiro_basico'),
  ('vendas_pedidos','nalven_orcamentos_pedidos'),
  ('compras_fiscal','nalven_compras_recebimento'),
  ('compras_fiscal','nalven_xml_nfe'),
  ('compras_fiscal','nalven_fiscal_preparado'),
  ('crm','nalven_crm_operacional'),
  ('servicos_recorrencia','nalven_servicos_recorrencia'),
  ('operacao_avancada','nalven_estoque_avancado'),
  ('operacao_avancada','nalven_financeiro_avancado'),
  ('governanca_analytics','nalven_relatorios_avancados'),
  ('governanca_analytics','nalven_permissoes_auditoria'),
  ('multiempresa_producao','nalven_multiempresa'),
  ('multiempresa_producao','nalven_producao_kits'),
  ('omnichannel','nalven_ecommerce'),
  ('omnichannel','nalven_marketplaces'),
  ('omnichannel','nalven_sincronizacao_canais'),
  ('omnichannel','nalven_logistica_integrada'),
  ('omnichannel','nalven_bi_avancado')
)
INSERT INTO modulo_recursos (modulo_id,recurso_id)
SELECT m.id,r.id
FROM vinculos v
JOIN produtos_saas p ON p.codigo='nalven'
JOIN catalogo_modulos m ON m.produto_id=p.id AND m.codigo=v.modulo_codigo
JOIN recursos r ON r.codigo=v.recurso_codigo
ON CONFLICT (modulo_id,recurso_id) DO NOTHING;

-- Os preços legados continuam representando Pix/boleto para consumidores que
-- ainda não leem plano_precos_metodo. O anual equivale a dez mensalidades.
WITH precos(plano_codigo,metodo,mensal,anual) AS (VALUES
  ('essencial','pix',149.00,1490.00),
  ('essencial','boleto',149.00,1490.00),
  ('essencial','cartao',169.00,1690.00),
  ('profissional','pix',349.00,3490.00),
  ('profissional','boleto',349.00,3490.00),
  ('profissional','cartao',369.00,3690.00),
  ('omnichannel','pix',697.00,6970.00),
  ('omnichannel','boleto',697.00,6970.00),
  ('omnichannel','cartao',717.00,7170.00)
)
INSERT INTO plano_precos_metodo (
  plano_id,metodo,preco_mensal,preco_anual,metadata
)
SELECT
  p.id,v.metodo,v.mensal,v.anual,
  '{"origem":"migration_132","produto_codigo":"nalven"}'::jsonb
FROM precos v
JOIN produtos_saas ps ON ps.codigo='nalven'
JOIN planos p ON p.produto_id=ps.id AND p.codigo=v.plano_codigo
ON CONFLICT (plano_id,metodo) DO UPDATE SET
  preco_mensal=EXCLUDED.preco_mensal,
  preco_anual=EXCLUDED.preco_anual,
  metadata=plano_precos_metodo.metadata || EXCLUDED.metadata,
  updated_at=NOW();

-- Essencial: operação-base. Profissional: base + módulos de gestão avançada.
-- Omnichannel: catálogo completo. Cotas, infraestrutura, API e níveis de
-- suporte continuam como entitlements específicos do plano.
WITH composicao(plano_codigo,modulo_codigo,destaque) AS (VALUES
  ('essencial','gestao_base',TRUE),
  ('essencial','catalogo_estoque',TRUE),
  ('essencial','pdv_vendas',TRUE),
  ('essencial','financeiro_base',TRUE),

  ('profissional','gestao_base',FALSE),
  ('profissional','catalogo_estoque',FALSE),
  ('profissional','pdv_vendas',FALSE),
  ('profissional','financeiro_base',FALSE),
  ('profissional','vendas_pedidos',TRUE),
  ('profissional','compras_fiscal',TRUE),
  ('profissional','crm',TRUE),
  ('profissional','servicos_recorrencia',FALSE),
  ('profissional','operacao_avancada',TRUE),
  ('profissional','governanca_analytics',TRUE)
)
INSERT INTO plano_modulos (plano_id,modulo_id,destaque,metadata)
SELECT
  pl.id,m.id,c.destaque,
  '{"origem":"migration_132","produto_codigo":"nalven"}'::jsonb
FROM composicao c
JOIN produtos_saas ps ON ps.codigo='nalven'
JOIN planos pl ON pl.produto_id=ps.id AND pl.codigo=c.plano_codigo
JOIN catalogo_modulos m ON m.produto_id=ps.id AND m.codigo=c.modulo_codigo
ON CONFLICT (plano_id,modulo_id) DO UPDATE SET
  destaque=EXCLUDED.destaque,
  metadata=plano_modulos.metadata || EXCLUDED.metadata;

INSERT INTO plano_modulos (plano_id,modulo_id,destaque,metadata)
SELECT
  p.id,m.id,
  (m.codigo IN ('multiempresa_producao','omnichannel')),
  '{"origem":"migration_132","produto_codigo":"nalven"}'::jsonb
FROM produtos_saas ps
JOIN planos p ON p.produto_id=ps.id AND p.codigo='omnichannel'
JOIN catalogo_modulos m ON m.produto_id=ps.id AND m.ativo=TRUE
WHERE ps.codigo='nalven'
ON CONFLICT (plano_id,modulo_id) DO UPDATE SET
  destaque=EXCLUDED.destaque,
  metadata=plano_modulos.metadata || EXCLUDED.metadata;

-- Garante os vínculos técnicos dos recursos embalados em módulos. A view
-- v_plano_recursos_efetivos filtra esses vínculos pela composição comercial.
INSERT INTO plano_recursos (plano_id,recurso_id,configuracao)
SELECT DISTINCT
  pm.plano_id,mr.recurso_id,
  jsonb_build_object('origem','modulo','modulo_id',pm.modulo_id)
FROM plano_modulos pm
JOIN planos pl ON pl.id=pm.plano_id
JOIN produtos_saas ps ON ps.id=pl.produto_id AND ps.codigo='nalven'
JOIN modulo_recursos mr ON mr.modulo_id=pm.modulo_id
ON CONFLICT (plano_id,recurso_id) DO UPDATE SET
  configuracao=plano_recursos.configuracao || EXCLUDED.configuracao;

UPDATE planos p
SET
  features=COALESCE((
    SELECT jsonb_agg(r.codigo ORDER BY r.ordem,r.nome)
    FROM v_plano_recursos_efetivos pr
    JOIN recursos r ON r.id=pr.recurso_id
    WHERE pr.plano_id=p.id AND r.ativo=TRUE
  ),'[]'::jsonb),
  metadata=COALESCE(p.metadata,'{}'::jsonb) || jsonb_build_object(
    'catalogo_modular',TRUE,
    'metodos_precificacao',jsonb_build_array('pix','boleto','cartao'),
    'migration_catalogo_modular',132
  ),
  updated_at=NOW()
WHERE p.produto_id=(SELECT id FROM produtos_saas WHERE codigo='nalven');

UPDATE produtos_saas
SET
  metadata=metadata || jsonb_build_object(
    'catalogo_modular',TRUE,
    'metodos_precificacao',jsonb_build_array('pix','boleto','cartao'),
    'migration_catalogo_modular',132,
    'pacote_integracao','integracao-billing-nalven.zip',
    'pacote_integracao_versao','2.0.0'
  ),
  landing_config=jsonb_set(
    COALESCE(landing_config,'{}'::jsonb),
    '{sections,features,subtitulo}',
    '"Escolha o plano e acrescente módulos com preço transparente por forma de pagamento."'::jsonb,
    TRUE
  ),
  updated_at=NOW()
WHERE codigo='nalven';

COMMIT;
