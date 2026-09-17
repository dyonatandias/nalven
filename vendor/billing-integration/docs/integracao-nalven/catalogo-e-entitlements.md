# Catálogo, planos e entitlements

## Valores e limites

| Item | Essencial | Profissional | Omnichannel |
|---|---:|---:|---:|
| Mensal Pix/boleto | R$ 149 | R$ 349 | R$ 697 |
| Mensal cartão | R$ 169 | R$ 369 | R$ 717 |
| Anual Pix/boleto | R$ 1.490 | R$ 3.490 | R$ 6.970 |
| Anual cartão | R$ 1.690 | R$ 3.690 | R$ 7.170 |
| Implantação | R$ 490 | R$ 990 | R$ 1.990 |
| Empresas/CNPJs | 1 | 1 | 3 |
| Filiais | 1 | 2 | 5 |
| Usuários nomeados | 3 | 8 | 15 |
| PDVs simultâneos | 1 | 2 | 5 |
| SKUs ativos | 2.000 | 10.000 | 50.000 |
| Pedidos/vendas por mês | 500 | 3.000 | 10.000 |
| Armazenamento | 5 GB | 20 GB | 100 GB |
| Retenção de backup | 15 dias | 30 dias | 30 dias |
| Canais digitais | 0 | 0 | 3 |
| Trial | 14 dias, quando oferecido | sem trial | sem trial |

O anual concede 12 meses de acesso pelo preço de 10 mensalidades do método escolhido. O valor anual é total do ciclo, não mensalidade. A composição e os módulos avulsos estão em [Catálogo modular e precificação](./catalogo-modular-e-precificacao.md).

## Matriz funcional resumida

| Grupo | Essencial | Profissional | Omnichannel |
|---|:---:|:---:|:---:|
| Dashboard, cadastros, produtos/serviços | ✓ | ✓ | ✓ |
| PDV, vendas, estoque e financeiro básicos | ✓ | ✓ | ✓ |
| Hospedagem, backup, atualizações e exportação LGPD | ✓ | ✓ | ✓ |
| API | limitada | padrão + webhooks | avançada + webhooks |
| Orçamentos/pedidos e compras | — | ✓ | ✓ |
| XML NF-e e fiscal preparado | — | ✓ | ✓ |
| CRM e serviços/recorrência | — | ✓ | ✓ |
| Estoque e financeiro avançados | — | ✓ | ✓ |
| Relatórios avançados, auditoria e permissões completas | — | ✓ | ✓ |
| Multiempresa e consolidação | — | — | ✓ |
| Produção, kits e composição | — | — | ✓ |
| E-commerce e catálogo digital | — | — | ✓ |
| Mercado Livre e Shopee | — | — | ✓ |
| Sincronização de estoque/preço/pedidos | — | — | ✓ |
| Etiquetas, rastreamento e logística reversa | — | — | ✓ |
| BI avançado | — | — | ✓ |

“Fiscal preparado” significa que a estrutura do NALVEN suporta o fluxo; emissão em produção depende de certificado, credenciamento, município/SEFAZ e provedor aplicável.

## Códigos de cotas

| Código | Métrica enviada pelo NALVEN | Periodicidade |
|---|---|---|
| `nalven_empresas` | `nalven_empresas_ativas` | instantânea |
| `nalven_filiais` | `nalven_filiais_ativas` | instantânea |
| `nalven_usuarios_nomeados` | `nalven_usuarios_ativos` | instantânea |
| `nalven_pdvs_simultaneos` | `nalven_pdvs_simultaneos` | instantânea |
| `nalven_skus_ativos` | `nalven_skus_ativos` | instantânea |
| `nalven_pedidos_mes` | `nalven_pedidos_mes` | mensal |
| `nalven_armazenamento_gb` | `nalven_armazenamento_gb` | instantânea |
| `nalven_backup_dias` | `nalven_backup_dias` | configuração |
| `nalven_canais_digitais` | `nalven_canais_ativos` | instantânea |

As mesmas chaves existem como recursos de tipo `cota` e como `limites[]`. A precedência no NALVEN é:

1. `recursos[codigo].limite` da licença, pois contempla adicional ou exceção individual;
2. `limites[codigo].valor` como valor-base do plano;
3. ausência do código significa não autorizado, nunca ilimitado.

## Adicionais de capacidade e serviço

| Adicional | Essencial | Profissional | Omnichannel |
|---|---:|---:|---:|
| Usuário/mês | R$ 29 | R$ 39 | R$ 49 |
| PDV adicional/mês | R$ 69 | R$ 69 | R$ 69 |
| CNPJ ou filial/mês | a partir de R$ 99 | a partir de R$ 99 | a partir de R$ 99 |
| Canal adicional/mês | R$ 99 | R$ 99 | R$ 99 |
| +25 GB/mês | R$ 49 | R$ 49 | R$ 49 |
| Treinamento adicional | R$ 200/h | R$ 200/h | R$ 200/h |

Migração especial, integração nova e desenvolvimento sob medida são sempre orçados. Ao vender um adicional de cota, a operação deve atualizar a cobrança e o `limite_valor` do entitlement correspondente na licença.

Esses itens aumentam capacidade ou incluem serviço operacional. Eles não substituem os módulos funcionais avulsos e não são selecionados pelo configurador modular.

## Códigos funcionais

Base: `nalven_dashboard`, `nalven_cadastros_basicos`, `nalven_catalogo`, `nalven_estoque_basico`, `nalven_pdv_vendas`, `nalven_financeiro_basico`, `nalven_relatorios_basicos`, `nalven_permissoes_basicas`, `nalven_hospedagem_saas`, `nalven_backup_diario`, `nalven_atualizacoes`, `nalven_exportacao_lgpd`, `nalven_api_integracao`, `nalven_suporte`.

Profissional+: `nalven_orcamentos_pedidos`, `nalven_compras_recebimento`, `nalven_xml_nfe`, `nalven_fiscal_preparado`, `nalven_crm_operacional`, `nalven_servicos_recorrencia`, `nalven_estoque_avancado`, `nalven_financeiro_avancado`, `nalven_relatorios_avancados`, `nalven_permissoes_auditoria`, `nalven_webhooks`, `nalven_suporte_prioritario`.

Omnichannel: `nalven_multiempresa`, `nalven_producao_kits`, `nalven_ecommerce`, `nalven_marketplaces`, `nalven_sincronizacao_canais`, `nalven_logistica_integrada`, `nalven_bi_avancado`, `nalven_api_avancada`, `nalven_suporte_prioritario_plus`.

## Condição Scalon Modas

A recomendação de fundador — Omnichannel por R$ 600/mês durante 12 meses e implantação dispensada após quitação/homologação do projeto — é uma condição individual. Ela não altera o preço público do Omnichannel e só deve ser aplicada na assinatura da Scalon depois da confirmação formal da data de início, vencimento, pagamento e aceite do projeto.
