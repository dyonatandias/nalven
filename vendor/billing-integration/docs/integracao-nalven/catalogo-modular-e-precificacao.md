# Catálogo modular e precificação

O plano fornece o pacote-base; módulos adicionais podem ser contratados sem trocar de plano. O Billing calcula e congela os valores da contratação. O NALVEN recebe somente os recursos técnicos efetivos pela licença.

## Preços dos planos

| Plano | Pix/boleto mensal | Cartão mensal | Pix/boleto anual | Cartão anual |
|---|---:|---:|---:|---:|
| Essencial | R$ 149 | R$ 169 | R$ 1.490 | R$ 1.690 |
| Profissional | R$ 349 | R$ 369 | R$ 3.490 | R$ 3.690 |
| Omnichannel | R$ 697 | R$ 717 | R$ 6.970 | R$ 7.170 |

O anual concede 12 meses de acesso pelo valor exibido. Os campos legados `preco_mensal` e `preco_anual` continuam representando Pix/boleto. A fonte específica é `precos_metodo`.

## Módulos avulsos

| Código | Módulo | Pix/boleto | Cartão | Essencial | Profissional | Omnichannel |
|---|---|---:|---:|:---:|:---:|:---:|
| `gestao_base` | Gestão e cadastros | R$ 49 | R$ 69 | ✓ | ✓ | ✓ |
| `catalogo_estoque` | Catálogo e estoque | R$ 59 | R$ 79 | ✓ | ✓ | ✓ |
| `pdv_vendas` | PDV e vendas | R$ 69 | R$ 89 | ✓ | ✓ | ✓ |
| `financeiro_base` | Financeiro essencial | R$ 79 | R$ 99 | ✓ | ✓ | ✓ |
| `vendas_pedidos` | Orçamentos e pedidos | R$ 49 | R$ 69 | — | ✓ | ✓ |
| `compras_fiscal` | Compras e fiscal | R$ 99 | R$ 119 | — | ✓ | ✓ |
| `crm` | CRM operacional | R$ 69 | R$ 89 | — | ✓ | ✓ |
| `servicos_recorrencia` | Serviços e recorrência | R$ 69 | R$ 89 | — | ✓ | ✓ |
| `operacao_avancada` | Estoque e financeiro avançados | R$ 99 | R$ 119 | — | ✓ | ✓ |
| `governanca_analytics` | Governança e análises | R$ 89 | R$ 109 | — | ✓ | ✓ |
| `multiempresa_producao` | Multiempresa e produção | R$ 149 | R$ 169 | — | — | ✓ |
| `omnichannel` | E-commerce e omnichannel | R$ 199 | R$ 219 | — | — | ✓ |

O preço de módulo é mensal. Ao selecionar um módulo já incluído no plano, o servidor o remove da lista de adicionais e não cobra novamente.

## Recursos agrupados

```text
gestao_base
  nalven_dashboard
  nalven_cadastros_basicos
  nalven_relatorios_basicos
  nalven_permissoes_basicas

catalogo_estoque
  nalven_catalogo
  nalven_estoque_basico

pdv_vendas
  nalven_pdv_vendas

financeiro_base
  nalven_financeiro_basico

vendas_pedidos
  nalven_orcamentos_pedidos

compras_fiscal
  nalven_compras_recebimento
  nalven_xml_nfe
  nalven_fiscal_preparado

crm
  nalven_crm_operacional

servicos_recorrencia
  nalven_servicos_recorrencia

operacao_avancada
  nalven_estoque_avancado
  nalven_financeiro_avancado

governanca_analytics
  nalven_relatorios_avancados
  nalven_permissoes_auditoria

multiempresa_producao
  nalven_multiempresa
  nalven_producao_kits

omnichannel
  nalven_ecommerce
  nalven_marketplaces
  nalven_sincronizacao_canais
  nalven_logistica_integrada
  nalven_bi_avancado
```

Hospedagem, backup, atualizações, LGPD, API, webhooks, suporte e as nove cotas permanecem como entitlements do plano. Contratar um módulo funcional não eleva automaticamente usuários, PDVs, SKUs ou canais; esses adicionais de capacidade continuam separados.

## Cálculo comercial

```text
total mensal = preço do plano no método escolhido
              + soma dos módulos não incluídos no plano no mesmo método
```

O Billing grava em `assinaturas`:

- `forma_pagamento_preferida`;
- `valor_plano_mensal`;
- `valor_modulos_mensal`;
- `valor_mensal`, com o total normal;
- `promo_valor_mensal`, quando existir promoção.

Cada adicional também recebe snapshot em `assinatura_modulos`. Alterar o catálogo não muda retroativamente a mensalidade de uma assinatura ativa.

## Identificadores

IDs numéricos variam por ambiente. Persistir e comparar os códigos estáveis do produto, plano, módulo e recurso. Usar IDs somente nos requests retornados pelo mesmo ambiente Billing.
