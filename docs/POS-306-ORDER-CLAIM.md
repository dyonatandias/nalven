# POS-306 — Claim e conversão de pedido no PDV

## Escopo implementado

O PDV consulta pedidos pelo ID, número ou QR interno assinado. O QR resolve somente a identidade; todas as regras de filial, operador, turno, caixa, terminal vivo e alçada são revalidadas no servidor.

O claim usa lease, versão/CAS e idempotência. Há no máximo um claim ativo por pedido, e cada transição (`claim`, `renew`, `release`, `expire`, `convert`) gera operação append-only. As FKs operacionais usam `ON UPDATE RESTRICT`, impedindo handoff silencioso do claim.

A conversão ocorre dentro da mesma transação `Serializable` de `sale.commit`. Ela revalida pedido, carrinho, cliente, preços, descontos, condição de pagamento, reservas e a posse; cria `Sale` com origem única `sales_order`, baixa o estoque pelo pipeline comum do PDV, consome reservas compatíveis e atualiza pedido, histórico, claim, auditoria e webhook atomicamente.

## Políticas fail-closed

- Somente pedidos `approved`, da filial ativa, em BRL, de origem manual/canal direto ou loja, para retirada imediata e sem frete/tributo/processamento logístico são elegíveis.
- Shipment, rastreio ou etiqueta de frete não cancelada bloqueiam o claim. Pedido, itens, pagamentos comerciais, reservas e artefatos logísticos ficam congelados por guards diferidos enquanto há claim ativo; após a conversão, a origem comercial também não pode receber novos filhos.
- A condição aprovada deve corresponder exatamente a um único pagamento suportado no PDV. Prazo, boleto, troca de meio ou parcelamento divergente exigem reconciliação comercial.
- Qualquer `OrderPayment` não explicitamente inerte, ou com `paidAt`, transação ou URL de pagamento, bloqueia o claim/commit. O PDV não renomeia nem cancela cobrança externa.
- Claim expirado ou release com intent eletrônico ou referência manual não resolvida são bloqueados. `partially_refunded` continua sendo prova financeira ocupando o slot. Um draft vinculado a claim ativo só pode ser descartado pelo release do claim.
- Cada divisão de pagamento aceita no máximo uma prova não resolvida, inclusive entre intent e referência manual. Crédito manual preserva o parcelamento exato do pedido.
- Reserva legada parcial, de kit agregado ou de variação sem bucket dimensional exato é recusada; não há compensação aproximada de estoque.
- O replay de conversão retorna somente a venda exata já vinculada ao mesmo claim/contexto.

## Operação e recuperação

A UI carrega o pedido como carrinho imutável, preserva inputs de leitura/prova de pagamento, renova o lease periodicamente e bloqueia checkout ao expirar. O draft server-side usa o ID do claim; no refresh, a recuperação só prossegue se itens, cliente, descontos e condição de pagamento forem idênticos. Nenhum token, PIN, PII ou prova eletrônica é persistido em `localStorage`.

### Runbook operacional

1. Consulte por ID/número ou QR assinado. O QR identifica; não concede autorização.
2. Faça o claim e confira pedido, filial, retirada, itens e pagamento. O lease é renovado pelo mesmo operador/turno/caixa/terminal; pausa, fechamento e handoff do turno ficam bloqueados enquanto o claim estiver ativo.
3. Recalcule a cotação, persista o draft e crie uma única prova por slot. Não repita cobrança após timeout.
4. Conclua com a mesma chave. O commit `Serializable` cria a venda, consome prova/reserva e converte pedido+claim na mesma transação. Replay retorna a mesma venda.
5. Se não houve prova e o lease expirou, recupere o draft e libere o mesmo claim; depois faça novo claim.
6. Se houve captura eletrônica exata após expiração, a recuperação renova o mesmo claim, sem nova cobrança. `unknown`, `manual_review` e `partially_refunded` continuam bloqueados para conciliação.
7. Referência manual aprovada e ainda vigente é restaurada por ID redigido e pode renovar o mesmo claim. Referência rejeitada por supervisor independente pode ser revogada uma vez, com motivo e chave idempotente. Referência pendente/aprovada expirada não é descartada: mantém claim/slot bloqueados.
8. Em rollback/timeout, recarregue a recuperação server-side e repita apenas a mesma chave. Nunca crie outra prova para “destravar”.

### Resolução de incidentes

- `captured`: preserve draft e intent; recupere o mesmo claim e faça commit único.
- `unknown`/`manual_review`: acione reconciliação do conector; não libere claim, não descarte draft e não recobre.
- `partially_refunded`: trate como valor líquido ainda pago; exige conciliação/compensação, sem novo intent.
- manual `rejected`: revogue pelo endpoint auditado; replay idêntico é seguro, chave/payload divergente falha.
- manual `expired` ou `approved_expired`: não há workflow contextual maker-checker implementado nesta onda. O turno permanece bloqueado até a reconciliação financeira formal; não use alteração SQL nem revogação administrativa genérica.
- shipment/rastreio/etiqueta: resolva no domínio logístico antes do claim. A persistência local é bloqueada contra claim/conversão.

## Validação e limites

Há testes unitários, contratuais e um teste PostgreSQL adversarial opcional via `POS_TEST_DATABASE_URL`, destinado a uma base descartável já migrada/seeded. O teste cobre corrida entre terminais, origem única, ledger append-only, freeze comercial/logístico, integridade da referência manual e handoff.

Gates ainda abertos:

- referência manual expirada precisa de um workflow próprio `payment.manual_reference.reconcile`, com approval contextual, step-up, outcome/evidência do provider e idempotência; até lá permanece bloqueada;
- compra externa de etiqueta ainda chama o provider antes da transação local. Os guards impedem coexistência local com claim/venda convertida, mas uma resposta externa seguida de rejeição local exige compensação operacional no provider;
- para draft comum (fora de SalesOrder), falta binding server-side completo da cotação antes do dispatch eletrônico; pagamento genérico não deve ser considerado pronto para produção por esta entrega.

Isso não substitui E2E com hardware, homologação de adquirente, ensaio fiscal nem validação de produção. Pedidos com modelos financeiros ou reservas fora das invariantes acima permanecem bloqueados até reconciliação formal.
