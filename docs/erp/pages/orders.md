# Orçamentos e pedidos

## Identificação e objetivo

- Rota pública: `/erp/orcamentos-pedidos` (chave interna do módulo: `orders`)
- API: `GET/POST /api/erp/orders`
- Estado: **Operacional completo**

Centraliza todo o ciclo: orçamento, aprovação, reserva, pagamento, expedição, rastreio, conclusão, devolução, reembolso e avaliação. Na conclusão, cria venda, consome as reservas por depósito e gera conta a receber numa transação serializável.

## Dados e estados

- `sales_orders`, `sales_order_items` e `sales_order_history` preservam cabeçalho, preços, itens e transições.
- A máquina contempla estados comerciais, pagamento e logística; regressões excepcionais exigem motivo e auditoria.
- Conclusão grava `sales`, `sale_items`, estoque, razão do depósito, `financial_titles` e auditoria correlacionada.
- Serviços geram venda e recebível sem movimento físico; produtos exigem saldo na filial ativa.

## Regras e aceite

1. Leitura e escrita exigem `orders.read/write`; escrita exige licença e same-origin.
2. Cliente e produtos precisam estar ativos; item repetido, quantidade, preço e desconto são validados.
3. Pedido só conclui após aprovação e não pode ser processado duas vezes.
4. Falha em qualquer efeito reverte toda a transação.
5. Marketplace reserva estoque durante a importação e deduplica pedidos/eventos no banco.
6. Notificações usam fila, matriz tri-state, políticas por fuso, consentimento, opt-out, backoff, circuit breaker e dead letter.
7. O portal público usa número+e-mail ou chave secreta, limita requisições e nunca revela notas privadas.
8. CSV neutraliza fórmulas; URLs, texto e configurações têm allowlists e limites explícitos.
9. A interface não expõe JSON nem usa dados mockados. Tarifas de continuidade são configurações explícitas da organização.

O inventário de paridade e os pontos de verificação estão em `docs/erp/GESTAO-PEDIDOS-PARIDADE.md`.
