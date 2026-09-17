# Gestão de Pedidos — Levantamento e Paridade

## Resultado do levantamento

A especificação de referência foi comparada com o domínio, APIs, interface, jobs e banco tenant. As 33 entregas das seis fases estão implementadas. Dependências de provedores (credenciais, saldo, homologação fiscal e contratos comerciais) são configuráveis em **ERP → Integrações** e não são substituídas por respostas mockadas.

## Mapa implementado

| Área | Implementação e garantia |
|---|---|
| Domínio | `SalesOrder`, itens e metadados, snapshots, endereços brasileiros, histórico, notas, pagamentos, reembolsos, rastreio, documentos, devoluções, avaliações e etiquetas. Número e chave secreta são independentes do ID. |
| Integridade | Criação transacional e idempotente; variações distintas permitidas; repetição da mesma variação rejeitada; totais históricos imutáveis; estoque reservado e consumido por filial/deposito. |
| Estados | Máquina de transição validada, motivo obrigatório em exceções, histórico/auditoria e status personalizados protegidos contra exclusão em uso. |
| Gestão | Lista e Kanban, teclado, filtros persistidos na URL, paginação, KPIs no servidor, debounce, cancelamento de requisição, estados de vazio/erro/retry e ações em lote com falha parcial. |
| Operação | Modal único com detalhes, frete, etiquetas, rastreio, timeline, reembolso total/parcial, cliente/endereço, devoluções, documentos e comunicação. |
| Comunicação | Matriz tri-state, canais mestre, templates, atraso, quiet hours por fuso, throttle, consentimento, opt-out, deduplicação e resolução tardia de destinatário/template. |
| Resiliência | Fila persistente, claim atômico, backoff exponencial, circuit breaker, dead letter, reenvio/cancelamento e limpeza configurável. |
| Pós-venda | Rastreio público por número+e-mail ou chave secreta, devolução parcial com elegibilidade e avaliação por token expirável. Notas privadas não saem no portal. |
| Extensões | Frete headless, estorno no gateway antes da gravação, marketplace com deduplicação persistente/reserva de estoque e relatórios/resumo diário. |
| Segurança | RBAC e filial ativa, licença, same-origin, allowlists, limites de tamanho/paginação, rate limit por proxy confiável, URLs HTTP(S), CSV anti-fórmula, saída React escapada e retenção de IP/user-agent. |

## Componentes principais

- Interface: `components/erp/order-management.tsx` e `app/erp/orders.css`.
- APIs: `app/api/erp/orders/route.ts`, `app/api/erp/order-management/route.ts` e rotas públicas de rastreio/avaliação.
- Regras: `lib/erp/order-domain.ts`, `lib/erp/order-stock.ts` e `lib/erp/sales-order-input.ts`.
- Worker: `scripts/process-order-notifications.ts`.
- Banco: migrations tenant `20260828033000`, `20260828040000`, `20260828050000` e `20260828070000`.

## Verificação de aceite

Execute `npm run test:orders`, `npm run test:integrations`, `npx tsc --noEmit`, `npm run lint` e `npm run build`. Após o deploy, valide `/api/health`, `/erp/pedidos`, criação idempotente, aprovação/reserva, conclusão/baixa e portal público. Provedores reais devem permanecer desativados até o teste de credencial ficar aprovado no painel.
