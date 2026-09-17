# PDV · Ponto de venda

## Identificação

- Rota: `/erp/pdv`
- API: `/api/erp/pdv`
- Grupo: OPERAÇÃO
- Estado: **em reconstrução — fundação P0 parcial, produção bloqueada por gates**
- Programa completo: [docs/erp/pdv](../pdv/README.md)
- Migration: `20260828100000_pos_foundation`

## Capacidades implementadas no novo fluxo

- caixa físico por filial/depósito e funcionário autorizado;
- turno obrigatório, fundo, sangria/suprimento e fechamento cego por meio;
- catálogo projetado e lookup por SKU/barcode/GTIN/variação/ProductCode;
- EAN/UPC/GTIN, GS1 AIs básicos e Digital Link;
- scanner HID/keyboard-wedge e câmera com feature detection; fila sob rajada e homologação física continuam P0;
- carrinho, desconto dentro da alçada, cliente, suspensão e retomada;
- pagamento misto, dinheiro/troco e referência manual controlada de eletrônico;
- venda em centavos, idempotência, transação serializável, CAS de saldo;
- snapshots, pagamento/evento, auditoria, webhook e ledger;
- cancelamento/devolução em dinheiro na API e recibo comercial browser/PDF;
- configuração administrativa idempotente de caixas, terminais, dispositivos e conectores;
- aprovação segregada e consumível uma vez para sangria, cancelamento e devolução;
- motor de melhor promoção exclusiva validado no domínio.

## Bloqueadores antes de produção

- repetir migration/reconciliação em clone representativo e executar RBAC/E2E;
- confirmar que não há consumidores externos antes da remoção física do comando legado já bloqueado com `410`;
- escolher e homologar Pix/TEF/SmartPOS reais;
- integrar adapter/storage e homologar NFC-e real por UF/provedor; produtor/outbox/callback fiscal local já existe em homologação;
- implementar/homologar agente local, impressora, gaveta, balança e display;
- concluir offline/sync, consumo transacional/UI de promoções, fidelidade, pós-venda eletrônico/repetido e relatórios;
- cumprir os gates de [plano e rastreabilidade](../pdv/PLANO-E-RASTREABILIDADE.md).

## Regra de status

A existência da tela não conclui o PDV. Cada integração externa precisa de contrato, simulador, teste de falha, laboratório físico e homologação antes de ser marcada pronta.
