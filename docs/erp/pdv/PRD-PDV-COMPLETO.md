# PRD — PDV NALVEN completo

Versão 1.2 · 29/08/2026 · segmento-base: varejo geral brasileiro. Farmácia, combustíveis, alimentação/comandas e outros verticais regulados exigem PRD adicional.

Status de implementação do claim/conversão de pedido: [POS-306 — contrato e runbook](../../POS-306-ORDER-CLAIM.md). O documento registra também gates externos ainda não homologados; não representa prontidão de produção.

## 1. Resultado esperado

Entregar um posto de venda rápido, auditável, resiliente e orientado a teclado, touch e scanner, integrado a catálogo, estoque, clientes, caixa, pagamentos, fiscal, financeiro, devoluções e relatórios do ERP.

Uma venda concluída deve ser explicável centavo a centavo e unidade a unidade por filial, depósito, terminal, caixa, turno, operador, cliente, item, desconto, pagamento, documento fiscal e eventos compensatórios.

## 2. Princípios

1. O servidor recalcula preço, desconto, total, saldo, permissão e estados.
2. Pagamento, fiscal, estoque e impressão têm estados independentes e recuperáveis.
3. Operação repetida com a mesma chave produz um único efeito.
4. Histórico concluído não é apagado; correções são cancelamentos, refunds e ledgers compensatórios.
5. Dinheiro físico afeta somente a gaveta e o turno correspondentes.
6. Nenhuma captura de cartão guarda PAN, trilha, CVV ou PIN.
7. Falha de impressão não desfaz venda; falha/estado incerto de pagamento não cria nova cobrança cega.
8. Regras por UF, adquirente, filial, produto e vigência são configuradas, não presumidas nacionalmente.
9. Offline é uma política de risco explícita, não uma réplica irrestrita do online.
10. “Pronto” exige migration, API, UI, testes, observabilidade, runbook e homologação aplicável.

## 3. Atores e responsabilidades

| Ator | Responsabilidades | Restrições |
|---|---|---|
| Operador de caixa | abrir turno, vender, receber, imprimir, contar e fechar | somente caixas/filiais atribuídos e sua alçada |
| Vendedor | montar carrinho, identificar cliente, atribuir itens | pode não tocar caixa/pagamento |
| Supervisor/fiscal de caixa | aprovar desconto, cancelamento, devolução e diferença | credencial própria; não compartilhar PIN |
| Gerente | terminais, escala, políticas, limites e relatórios da filial | não altera transação concluída |
| Tesouraria | suprimento, sangria, malote e reconciliação física | movimentos compensatórios, nunca exclusão |
| Estoque | saldo, lote, serial, quarentena e devolução | não confirma pagamento |
| Financeiro | adquirente, Pix, voucher, recebível, taxa e conciliação | não altera item vendido |
| Fiscal/contador | regras, certificado, NFC-e e contingência | não marca autorização sem retorno confiável |
| Administrador/proprietário | integrações, papéis e políticas globais | ações críticas continuam auditadas |
| Auditor | consulta/exportação imutável | sem escrita operacional |
| Cliente | identificação, pagamento, recibo, troca e fidelidade | dados minimizados/mascarados |
| Agente local | mediação autenticada de periféricos | comandos allowlisted e terminal pareado |
| Provedor externo | pagamento, fiscal, comunicação | contrato específico, assinatura e idempotência |

## 4. Máquinas de estado

### Terminal

`unpaired → active → maintenance → revoked`

- terminal revogado não recebe catálogo, não sincroniza e não abre turno;
- heartbeat registra versão, saúde e última atividade;
- pareamento usa código de uso único, expiração e impressão digital.

### Turno

`open → closing → closed → reconciled`

Exceções: `open ↔ suspended`; `closed → reopened` apenas com supervisor, preservando a revisão anterior. `reconciled` é terminal.

### Venda

`draft → payment_pending → paid → fiscal_pending → completed`

Alternativas: `suspended`, `payment_unknown`, `fiscal_contingency`, `cancelled`, `partially_returned`, `refunded`. Venda paga não volta para rascunho.

### Pagamento

`created → processing → authorized → captured`

Alternativas: `declined`, `unknown`, `cancelled`, `partially_refunded`, `refunded`, `manual_review`. `unknown` deve ser consultado antes de nova tentativa.

### Fiscal

`draft → queued → authorized`

Alternativas: `technical_error`, `rejected → corrected → queued`, `contingency_pending`, `cancellation_pending → cancelled`.

### Devolução

`requested → inspecting → approved → refund_pending → completed`

Alternativas: `rejected`, `cancelled`, `exchange_in_progress`, `manual_review`.

O estado físico da mercadoria, o estado financeiro da compensação e o estado fiscal são projeções independentes. Mercadoria recebida enquanto o provider está `unknown` fica em custódia/quarentena; sucesso externo é gravado antes da aplicação local e jamais é reenviado porque uma projeção interna falhou.

### Offline

`local_committed → queued → syncing → synced`, ou `conflicted`, `blocked`, `manual_review`.

## 5. Requisitos funcionais

### POS-100 — terminal, caixa e turno

- cadastrar caixa por filial, depósito e conta financeira;
- cadastrar/parear/revogar terminal e cada periférico;
- associar funcionários com vigência, ações e limite de desconto;
- garantir no máximo um turno `open/suspended/closing` por caixa;
- login/bloqueio rápido e troca de operador com reautenticação;
- abrir com fundo e contagem opcional por denominação;
- pausar, retomar e passar responsabilidade com aceite autenticado do destino, revisão concorrente e transferência atômica dos carrinhos suspensos;
- fechamento cego por meio/provider/terminal;
- diferença acima de tolerância exige justificativa e aprovador distinto;
- reabertura cria versão e auditoria, sem sobrescrever fechamento.

### POS-200 — leitura e catálogo

- EAN-8/13, UPC-A/E, GTIN-8/12/13/14, Code 39/128 e ITF-14;
- GS1-128, GS1 DataMatrix e GS1 QR com AIs de GTIN, lote, validade, serial, peso e quantidade;
- GS1 Digital Link;
- código interno, SKU, variação, embalagem/multiplicador e etiqueta de balança;
- QR interno assinado de cliente, carrinho, cupom, vale, pedido e recibo;
- scanner USB/Bluetooth HID, serial via agente local, câmera e coletor Android via adapter;
- checksum, normalização, debounce, terminador configurável, duplicidade e ambiguidade;
- busca por nome, SKU, código, categoria, marca, favorito e mais vendido;
- catálogo paginado/virtualizado e projeção sem custo/segredo;
- feedback sonoro, visual e `aria-live`; QR externo nunca navega automaticamente.

### POS-300 — carrinho e preço

- simples, variação, serviço, kit, embalagem e unidade fracionária;
- quantidade, remoção, observação e vendedor por linha;
- preço de lista/aplicado, origem, desconto e tributos visíveis;
- desconto por item/venda, acréscimo, frete e arredondamento regulamentado;
- tabela por filial, cliente/segmento/canal e vigência;
- preço mínimo, margem, estoque negativo e preço zero por política/alçada;
- suspender, nomear, transferir e recuperar vários carrinhos, preservando posse, revisão e histórico imutável;
- converter orçamento, pedido, retirada e troca sem duplicar estoque;
- claim de pedido com TTL/revisão/posse; conversão consome reserva/entrada/pagamento e muda pedido + `Sale.source` na mesma transação;
- reserva de checkout com TTL;
- snapshot imutável de descrição, SKU, GTIN, unidade, preço, desconto e tributo.

### POS-400 — cliente e fidelidade

- consumidor final conforme política;
- busca por CPF/CNPJ, nome, telefone, e-mail, cartão ou QR;
- cadastro rápido, validação, deduplicação e mascaramento;
- consentimento comercial separado da identificação fiscal;
- pontos, cashback, níveis, validade e ledger imutável;
- crédito-loja e gift card separados de pontos;
- reserva/transação idempotente de saldo;
- reversão proporcional em cancelamento/devolução;
- resgate offline bloqueado ou limitado a reserva previamente sincronizada.

### POS-500 — promoções e cupons

- promoção agendada com timezone confiável;
- percentual/valor, progressivo, faixa, leve X pague Y, compre X ganhe Y, combo e brinde;
- regra por filial, produto, categoria, cliente, horário e meio de pagamento;
- cupom por texto/QR, hash em repouso, limites global/cliente/venda;
- prioridade, exclusividade, combinabilidade e melhor oferta determinística;
- limite de margem/preço mínimo e aprovação de override;
- snapshot das regras aplicadas, economia e autorizador;
- rateio/reversão proporcional em devolução.

### POS-600 — estoque

- saldo físico, reservado, disponível, trânsito e quarentena por depósito;
- baixa atômica por comparação/lock e retry limitado no saldo autoritativo de produto/variação por depósito;
- precisão de quantidade por unidade e conversão de embalagem;
- produto sem controle de estoque e serviço não exigem saldo;
- variação, lote, validade, serial e FEFO/FIFO configurável;
- kit usa BOM versionada/aninhada, congela a versão e as folhas na venda, baixa cada componente e registra cada retorno em ledger imutável;
- devolução escolhe revenda, quarentena, assistência ou descarte;
- ledger antes/depois e outbox para canais;
- conflito offline vira ocorrência, nunca some silenciosamente.

### POS-700 — pagamentos

- dinheiro, Pix, débito, crédito, voucher, crédito-loja, gift card e outro configurado;
- pagamentos mistos e parciais, com saldo remanescente visível;
- dinheiro recebido, troco e disponibilidade da gaveta;
- crédito parcelado, bandeira, adquirente, NSU e autorização;
- TEF/pinpad/SmartPOS por adapter homologado;
- reconciliação manual é exceção assistida e não POS autônoma: maker/checker somente autoriza consulta; sem observação autenticada do provider o estado máximo é `unknown` e a venda não é financiada;
- o aggregate 320000 congela filial/caixa/turno/operador/terminal/draft/revisão/claim/plano/slot/método/provider/conector/credencial/moeda/valor e referência tokenizada; exige checker com grant explícito, alçada viva e step-up, sem bypass owner/admin;
- estados: `review_pending → rejected|unknown`; T1 `unknown → confirmed_paid`; expiry `confirmed_paid → expired`; T2a `confirmed_paid → application_pending`; T2b atômico `application_pending → applied`; `no_funds` e `blocked` preservam observations/incidentes;
- T1 é fato externo autenticado, T2a reserva a prova para alvo comercial exato e T2b cria venda/pagamento e consome plano na mesma transação; falha de T2b permanece reaplicável em `application_pending` sem trocar alvo;
- referência aberta permanece somente em vault/KMS; banco guarda HMAC com key-id e últimos quatro seguros. Legado fica selado e nunca é promovido por aprovação humana;
- `manual_confirmed` é estado de `PosSalePayment`; intents eletrônicos nunca usam esse estado nem são promovidos a partir dele;
- Pix dinâmico com txid, QR/copia-e-cola, expiração, webhook assinado e consulta;
- confirmação por servidor/provedor; print do cliente não é confirmação;
- cancelamento/desfazimento/refund parcial e total;
- void/refund usa agregado compensatório próprio, valor delta, referência da operação, reserva anti-over-refund, attempts/outbox/callback e aplicação local idempotente em segundo commit;
- intent vincula o `credentialRef` exato usado; attempt/outbox/callback/estado e cada conclusão de entrega são persistidos e idempotentes;
- estados monotônicos, callback duplicado/fora de ordem e pagamento desconhecido; evidência posterior ao consumo é suplementar e contradição monetária abre incidente que bloqueia fechamento/handoff;
- reconciliação persistente e reprocessável de bruto, MDR/taxa, líquido, parcela, agenda, antecipação e chargeback, preservando a evidência normalizada;
- guardar token/referência, bandeira e últimos dígitos permitidos; nunca PAN/CVV/PIN.

### POS-800 — fiscal brasileiro

- perfil por filial, UF, regime, ambiente, série e vigência;
- cadastro tributário completo por produto/serviço/operação;
- venda PDV como origem direta de NFC-e;
- adapter direto ou provedor fiscal; SAT/MFE/CF-e somente onde aplicável ao ambiente;
- numeração concorrente e transacional;
- geração/validação/assinatura XML, schema versionado, transmissão, consulta e protocolo;
- XML autorizado, chave, QR fiscal, DANFE e retenção;
- rejeição traduzida em ação; erro técnico separado de rejeição de negócio;
- contingência com justificativa, horário, fila durável e retransmissão;
- cancelamento, inutilização e eventos aplicáveis;
- CPF/CNPJ conforme operação e configuração;
- homologação por UF/provedor é gate obrigatório.

### POS-900 — recibo e periféricos

- comprovante comercial 58/80 mm, PDF/browser e envio consentido;
- distinguir recibo comercial de documento fiscal;
- print job persistido, ACK, erro, tentativas e reimpressão auditada;
- impressora ESC/POS USB/rede/serial via agente;
- gaveta abre após dinheiro ou permissão `no_sale_open`;
- balança serial/TCP com estabilidade, tara, unidade e timeout;
- display do cliente com item, total, troco e QR Pix, sem dados internos;
- saúde: papel, tampa, conexão, latência, firmware e última atividade.

### POS-1000 — cancelamento, devolução e troca

- localizar por número, recibo/QR, cliente ou item;
- prazo/política, quantidade elegível e devolução anterior;
- motivo, condição, evidência e destino físico;
- refund no meio original quando possível;
- dinheiro, Pix, TEF e crédito-loja com fluxos próprios;
- documento/evento fiscal correspondente;
- troca = devolução + nova venda vinculada, com diferença;
- sem comprovante exige política e aprovação;
- mesma chave não duplica estoque ou dinheiro.

### POS-1100 — caixa e tesouraria

- venda em dinheiro, troco, suprimento, sangria, despesa, retirada e ajuste;
- motivo padronizado, comprovante, origem/destino e aprovador;
- movimento imutável; erro gera reversão;
- esperado por meio/provider, não por total bruto da venda;
- dinheiro esperado = fundo + vendas em dinheiro + suprimentos − sangrias − refunds em dinheiro;
- conferência de cartão/Pix por terminal/adquirente;
- malote, tesouraria, relatório de turno e reconciliação posterior.
- dupla custódia com lacre, entrega/aceite, ator/aprovador/terminal por FK e `closed → reconciled/reopened` sem sobrescrever revisão.

### POS-1200 — offline e sincronização

- PWA/kiosk, cache versionado e banco local cifrado;
- identidade de terminal e credencial offline de curta duração;
- catálogo, códigos, preços, regras, permissões e versão;
- operationId global, sequência monotônica, assinatura e outbox local;
- push/pull por cursor, ACK e dedupe no servidor;
- modo/idade da sincronização sempre visíveis;
- dinheiro pode operar dentro da política; Pix não é considerado pago offline;
- cartão offline somente pela capacidade certificada do adquirente;
- fiscal offline somente na contingência legal configurada;
- limite de valor/tempo, licença e estoque de risco;
- conflitos e fila permanecem visíveis até resolução;
- crash/reboot/atualização preservam operações.

### POS-1300 — segurança, LGPD e auditoria

- autorização por papel + filial + caixa + turno + valor/alçada;
- step-up/MFA para supervisor, refund, fiscal e dispositivos;
- solicitante não aprova a própria exceção;
- sessão curta e bloqueio em terminal compartilhado;
- segredos cifrados, rotação e logs redigidos;
- auditoria append-only com ator/approver, filial, terminal, turno, correlação, causa, idempotência, before/after, IP/device e horário servidor;
- hash chain/exportação imutável para eventos financeiros de alto risco;
- minimizar CPF/telefone; finalidades e consentimentos separados;
- retenção/anonimização executável, preservando obrigação fiscal/contábil;
- PII cifrada/tokenizada com hash de busca/last-four; leitura e exportação auditadas; DSAR, legal hold e job de retenção idempotentes;
- threat model para fraude interna, terminal comprometido, replay, webhook falso e clock local.

### POS-1400 — relatórios e observabilidade

- bruto, cancelado, devolvido, líquido, desconto, imposto, CMV, margem e ticket;
- filial, terminal, caixa, turno, operador, vendedor, produto, categoria e hora;
- meio, adquirente, bandeira, parcelas, taxa, liquidação e divergência;
- fundo, suprimento, sangria, troco, fechamento e diferença;
- promoção, fidelidade, estoque, fiscal, filas e dispositivos;
- exportação assíncrona CSV/XLSX/PDF auditada;
- métricas de latência/falha por provider, duplicidade, oversell, pagamento/fiscal pendente, terminal offline e print job;
- trace ponta a ponta pelo correlation ID.
- subledger contábil imutável com partidas dobradas, período, plano de contas, filial/centro, idempotência por versão da origem e eventos para venda, imposto, CMV, clearing/MDR, refund, caixa e contas de valor;
- antifraude operacional com regras/sinais/casos/evidência/decisão, velocidade, fracionamento abaixo de alçada, after-hours e segregação maker-checker.

## 6. Exceções obrigatórias

Cada exceção define mensagem, estado persistido, ação segura, permissão, auditoria e runbook:

- código inválido, desconhecido, duplicado ou inativo;
- variação/lote/serial não determinado, vencido ou já vendido;
- quantidade fracionária proibida ou peso instável;
- saldo ou preço mudou durante checkout;
- cupom expirado/esgotado/não combinável;
- desconto acima da alçada ou abaixo da margem;
- cliente duplicado/bloqueado/documento inválido;
- retry/duplo clique após timeout;
- cartão aprovado sem resposta, callback antes da resposta ou fora de ordem;
- Pix após expiração, pagamento parcial e cancelamento recusado;
- pinpad, impressora, gaveta ou balança desconectados;
- fiscal rejeitado após pagamento ou queda durante transmissão;
- fechamento com pagamento pendente ou diferença acima da tolerância;
- refund no provedor com timeout local;
- devolução acima do saldo, produto sem condição de revenda e troca com diferença;
- reabertura de turno reconciliado;
- terminal revogado, relógio local incorreto e sync fora de ordem.

## 7. UX e acessibilidade

- cabeçalho fixo: filial, terminal, operador, turno, rede e dispositivos;
- carrinho e total persistentes em desktop/kiosk; CTA de pagamento inequívoco;
- `F2`/foco global para scanner, atalhos configuráveis e ajuda;
- Enter confirma, setas navegam, Esc fecha apenas camada atual;
- atalhos não disparam em edição de texto/valor;
- alvos touch mínimos 44×44 px e teclado numérico para valores;
- WCAG 2.2 AA, diálogo nomeado, focus trap/retorno, foco visível, zoom 200%, alto contraste e movimento reduzido;
- estados não dependem só de cor/som; resultado de leitura e carrinho em `aria-live`;
- alertas persistentes para offline, pagamento desconhecido e fiscal pendente.

## 8. Metas não funcionais

| Indicador | Meta inicial |
|---|---|
| leitura HID → item no carrinho | p95 ≤ 300 ms com catálogo local/indexado |
| busca online | p95 ≤ 500 ms |
| commit de venda sem provider | p95 ≤ 2 s |
| duplicidade por retry | zero |
| estoque negativo quando proibido | zero |
| RPO servidor | conforme política de backup, alvo ≤ 5 min para eventos |
| RTO operacional | alvo ≤ 30 min; dinheiro offline conforme política |
| disponibilidade API POS | alvo 99,9% mensal após GA |
| acessibilidade | WCAG 2.2 AA nos fluxos P0/P1 |

## 9. Critérios de aceite sistêmicos

- mesma `operationId` 10 vezes cria uma venda, pagamentos e baixa;
- 100 checkouts concorrentes não furam saldo proibido;
- soma de linha/desconto/acréscimo/pagamento fecha exatamente em centavos;
- toda venda tem filial, caixa, turno, operador, itens e tender;
- alteração posterior do produto não muda snapshot;
- operador não atribuído não abre/usa o caixa;
- Pix/cartão não aumenta numerário físico;
- sangria reduz e suprimento aumenta somente dinheiro;
- fechamento cego não expõe esperado;
- turno fechado não recebe venda/movimento;
- código ambíguo não adiciona item;
- QR externo não navega/executa;
- timeout eletrônico consulta antes de recobrar;
- replay da mesma entrega/callback devolve o resultado original; payload divergente para a mesma identidade falha fechado;
- intent eletrônico consumido e pagamento permanecem ligados por valor, método, provider, venda, turno e operador no banco;
- referência manual e seu pagamento permanecem ligados a venda, contexto exato e aprovação independente no banco;
- saldo devolvido de componente de kit fecha exatamente com seu ledger de retorno no commit;
- dado de cartão proibido não aparece em banco/log/auditoria;
- rejeição fiscal não vira autorização;
- devolução repetida não duplica refund/restock;
- soma reservada+aplicada de refunds nunca supera o pagamento original, inclusive sob concorrência;
- dois terminais nunca convertem o mesmo pedido;
- cada postagem contábil fecha débito=crédito e replay não cria nova versão;
- fila offline sobrevive a refresh/crash e sincroniza uma vez;
- fluxo completo funciona por teclado, touch e leitor de tela.

## 10. Fora de escopo sem PRD complementar

- prescrição/controle farmacêutico;
- bombas, encerrantes e regras de combustíveis;
- mesas, comandas, KDS e taxa de serviço de alimentação;
- self-checkout com prevenção física de perdas;
- biometria facial;
- adquirente/provedor não escolhido e não homologado.
