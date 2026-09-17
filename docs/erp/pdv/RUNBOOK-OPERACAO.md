# Runbook operacional do PDV

## Escopo e disponibilidade

Este documento separa operação atual de operação-alvo. Abertura, venda online, dinheiro, contas de valor locais, suspensão, sangria/suprimento, fechamento cego e aprovação segregada de sangria/cancelamento/devolução/divergência/desconto existem na fundação atual. O serviço de credenciais/heartbeat/fila do agente e a PWA offline limitada a heartbeat/rascunho existem, mas pagamento externo server-side, fiscal, binário/adapters físicos e feature flag ainda são procedimentos-alvo e **não podem ser usados em produção antes da respectiva implementação e homologação**.

## Preparação da filial

1. Confirmar filial, depósito, timezone, perfil fiscal e conta financeira.
2. Criar caixas e atribuir funcionários/alçadas.
3. Parear terminal e dispositivos; validar versão/heartbeat.
4. Testar scanner, câmera, pinpad/POS, impressora, gaveta, balança e display aplicáveis.
5. Executar pagamento e estorno em homologação.
6. Executar autorização/rejeição/contingência fiscal em homologação.
7. Conferir catálogo, códigos duplicados, saldo e preço.
8. Configurar `POS_VALUE_SECRET_PEPPER`, `POS_INTERNAL_QR_KEYS_JSON` e `POS_INTERNAL_QR_ACTIVE_KEY_ID` no cofre de segredos, seguindo os runbooks de valor e QR; nunca no repositório.
9. Implementar e validar a feature flag por filial; somente então habilitá-la no piloto.

## Abertura

- operador entra com sua credencial, seleciona caixa atribuído e conta o fundo;
- se houver turno anterior aberto, não criar outro: resolver passagem/fechamento;
- qualquer periférico crítico em falha deve indicar contingência disponível;
- turno recebe ID/número e todas as operações subsequentes o referenciam.

## Venda

- ler código ou buscar produto;
- código desconhecido/ambíguo não é cadastrado silenciosamente durante a venda;
- confirmar quantidade, cliente, descontos e total;
- QR interno pode selecionar cliente/carrinho/cupom/gift card/recibo, mas deve aparecer como entidade resolvida, nunca como URL navegável; pedido permanece bloqueado sem claim atômico;
- descontos fora da alçada aguardam supervisor;
- selecionar pagamentos até fechar exatamente o total; pontos exigem conversão inteira e gift card exige PIN;
- só concluir eletrônico após intent `captured` por evidência do provider ou pela exceção `manual_confirmed` com conector, referência, aprovação independente e step-up; nunca tratar a exceção como captura homologada;
- imprimir/enviar recibo; falha de impressão vira job pendente.

### Estoque concorrente e variações

- o depósito do caixa é autoritativo; estoque global de `ProductVariation` não autoriza venda em outro depósito;
- produto pai e variação própria são debitados por CAS na mesma transação `Serializable`; falha em qualquer saldo reverte venda, pagamento, lote/série, movimento e ledger;
- resposta `409` de concorrência significa que nada daquela tentativa foi confirmado. Atualize o carrinho e repita com a mesma chave idempotente;
- a migration `20260829150000_pos_variant_warehouse_stock` distribui o saldo legado global da variação proporcionalmente pelos saldos positivos do produto pai. Em operação multi-depósito, bloquear o rollout até uma contagem física reconciliar `warehouse_variation_balances` por depósito;
- nunca corrigir oversell editando `Sale`, pagamento ou ledger. Ajustes físicos entram por recebimento, contagem ou movimento compensatório auditado.

## Pagamento desconhecido

> O lifecycle persistente, outbox, callback e manutenção estão implementados; a consulta/captura externa deste procedimento depende do adapter/provider real ainda não homologado.

1. Não repetir cobrança.
2. Manter o intent/rascunho em `unknown`; não materializar `Sale` nem `PosSalePayment` enquanto o efeito externo estiver incerto.
3. Consultar adapter por referência/idempotência.
4. Se capturado, avançar; se recusado/cancelado, permitir nova tentativa.
5. Se inconclusivo, abrir revisão com supervisor/financeiro.
6. Registrar correlação e evidência; nunca confirmar por screenshot.

## Fiscal rejeitado ou indisponível

> Procedimento-alvo: depende do emissor fiscal homologado, ainda não implementado.

1. Separar rejeição de negócio de indisponibilidade técnica.
2. Corrigir dado permitido sem alterar snapshot comercial indevidamente.
3. Reenviar com a regra idempotente do provider.
4. Usar contingência somente se perfil/UF/modalidade permitirem.
5. Exibir pendência persistente até autorização/reconciliação.
6. Não escrever protocolo/chave manualmente como autorização.

## Sangria e suprimento

- escolher motivo, valor, origem/destino e descrição;
- acima do limite requer aprovador distinto;
- imprimir/guardar comprovante e malote quando aplicável;
- erro é corrigido por movimento inverso, nunca exclusão.

## Fechamento

1. Parar novas vendas e resolver pagamentos pendentes.
2. Contar dinheiro sem visualizar esperado quando fechamento cego estiver ativo.
3. Informar Pix, cartão, voucher e outros meios externos por provider; crédito-loja, cashback, pontos e gift card são conciliados pelo ledger e não são “contados” fisicamente.
4. Sistema calcula diferenças por tender.
5. Toda diferença recebe justificativa; o total absoluto acima da tolerância configurada exige aprovação independente vinculada ao turno, sem revelar o esperado antes da conferência.
6. Emitir relatório do turno, malote e lista de pendências.
7. Tesouraria reconcilia posteriormente sem reescrever o fechamento.

## Cancelamento/devolução

- localizar venda e saldo elegível;
- vendas `partially_returned` admitem nova devolução somente sobre `quantity - returnedQuantity`; o último retorno fecha exatamente `totalCents - returnedCents`;
- eletrônico externo permanece bloqueado antes de receber mercadoria ou movimentar estoque: exige refund server-side homologado; referência manual nunca é tratada como confirmação;
- escolher destino físico de cada item;
- evento fiscal aplicável deve acompanhar;
- retry usa a mesma idempotency key;
- em timeout do refund, consultar antes de repetir.

### Troca vinculada

1. Marcar **Iniciar troca vinculada** na devolução local e confirmar os itens/destinos. A devolução e seu refund local são concluídos uma vez e não dependem do valor da reposição.
2. O sistema abre um rascunho `Troca <venda>` ligado unicamente ao retorno. Se já houver carrinho em andamento, ele fica na lista de vendas suspensas.
3. Revisar os produtos da reposição e reler lote/série. O rascunho não reutiliza rastreabilidade da mercadoria devolvida.
4. Recalcular preço/promoção, obter aprovação de desconto quando exigida e receber o pagamento da nova venda online. A diferença é `nova venda - valor devolvido`; não há compensação implícita nem confirmação fictícia de provider.
5. Ao concluir, a nova `Sale` recebe origem `pos_exchange/<returnId>` e o retorno passa de `draft` para `completed` atomicamente. Descartar o rascunho muda somente a troca para `cancelled`; a devolução concluída não é desfeita.

## Terminal/periférico offline

> A PWA de rascunhos e o push server-side de heartbeat/rascunho/tombstone estão implementados com cofre local cifrado, sequência, pull/ACK e ledger idempotente. Consulte [RUNBOOK-SYNC-OFFLINE.md](./RUNBOOK-SYNC-OFFLINE.md). Venda/pagamento/fiscal offline, binário do agente e adapters físicos não estão homologados.

- mostrar claramente modo offline e idade do catálogo/permissão;
- obedecer limites de risco; Pix ou cartão nunca viram pagos por este canal offline;
- não concluir venda, caixa ou fiscal offline: o servidor rejeita essas operações explicitamente;
- armazenar comandos cifrados e assinados;
- ao reconectar, enviar sequência contígua, preservar `operationId` nos retries e acompanhar ACK/rejeições até zerar fila;
- terminal revogado para imediatamente após janela autorizada.

## Incidente

Coletar: organização/filial, terminal, caixa, turno, venda, correlation/idempotency IDs, provider/reference, timestamps servidor, versão do agente e estado dos dispositivos. Redigir CPF, tokens e dados de cartão. Preservar logs/auditoria e acionar segurança quando houver replay, fraude, segredo ou acesso indevido.

### Painel de saúde operacional

Proprietários e administradores com `pdv.read` podem consultar o bloco **Saúde operacional** na configuração do PDV. A API `GET /api/erp/pdv/observability` consulta somente o banco tenant da organização autenticada e aceita uma filial ativa. Owner/admin possui alcance tenant-wide para resposta a incidentes; `BranchUserAccess` continua sendo escopo de operador e não restringe essa leitura administrativa.

Parâmetros aceitos, sem repetição ou campos adicionais:

| Parâmetro | Padrão | Faixa |
|---|---:|---:|
| `branchId` | filial ativa do perfil/primária | inteiro positivo |
| `windowHours` | 168 | 1–720 horas |
| `limit` | 25 | 1–50 detalhes por conjunto |

A janela limita eventos finais de sincronização e o resumo de turnos. Estados ainda não resolvidos — turno antigo, pagamento desconhecido, impressão pendente, terminal sem heartbeat e lote com saldo bloqueado — não desaparecem apenas por envelhecerem. Todas as respostas, inclusive erros validados, usam `cache-control: no-store`.

Limiares fixos, sempre devolvidos no DTO junto ao timestamp `generatedAt`:

- turno `open`/`closing` há 720 minutos;
- pagamento `created`/`processing` há 15 minutos; `pending`, `unknown` e `manual_review` são exibidos pelo estado persistido;
- terminal: heartbeat com 5 minutos é `stale` e com 15 minutos é `offline`; `unpaired` não é incidente;
- sync `received`/`processing` há 5 minutos;
- lease de impressão usa diretamente `claimExpiresAt`, sem inferência adicional;
- lote entra somente com `quantityMicros > 0`; vencimento usa a data operacional e timezone da filial;
- cupom compara `usedCount` ao total de resgates com `reversedAt IS NULL`; promoções verificam limites global e por cliente em uma varredura explicitamente limitada a 500 registros por conjunto.

O painel mostra apenas IDs internos, estados, timestamps, valores agregados e nomes operacionais de caixa/terminal/dispositivo. Não retorna cliente, operador por nome, documento, e-mail, PAN, últimos dígitos, transação/provider, payload de sync/impressão, erro aberto, hash ou credencial. O resumo de turno agrupa vendas, pagamentos/refunds por meio, sangria/suprimento e diferença; use o ID de perfil somente nos sistemas internos autorizados.

Procedimento por sinal:

1. Atualizar o painel e registrar `generatedAt`, filial, categoria e IDs internos; não copiar dados de tabelas sensíveis para o chamado.
2. Resolver primeiro pagamento `unknown`/`manual_review`, lease expirado e conflito de sync. Nunca repetir cobrança ou impressão fiscal apenas pela idade.
3. Em turno antigo, bloquear nova passagem no mesmo caixa e conduzir fechamento/aprovação conforme o estado persistido.
4. Em terminal/dispositivo offline, validar rede, heartbeat, expiração/revogação e versão antes de rotacionar credencial.
5. Em lote vencido/quarentena, manter fora do vendável e usar os comandos auditados de liberar, quarentenar ou descartar; não editar saldo diretamente.
6. Em divergência de cupom/promoção, interromper a campanha afetada e reconciliar resgates ativos e auditoria antes de ajustar contador. Não apagar resgates.
7. Se uma lista estiver marcada como truncada, reduzir a filial/janela quando aplicável e consultar o banco tenant com acesso controlado; o painel não é exportador nem sistema de métricas históricas.

## Rollback

- quando a feature flag por filial estiver implementada, desabilitá-la;
- não apagar vendas/turnos criados;
- drenar/pausar outbox com checkpoint;
- reconciliar pagamentos/fiscal externos antes de restaurar tráfego;
- migration de dados não é revertida destrutivamente; aplicação volta ao fluxo anterior apenas se schema compatível;
- documentar cada operação compensatória.
