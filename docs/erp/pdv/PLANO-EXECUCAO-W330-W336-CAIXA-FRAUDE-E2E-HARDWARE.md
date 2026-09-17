# Plano de execução W330–W336 — caixa, fraude, E2E e hardware

## 1. Objetivo e estado honesto

Este plano transforma os bloqueadores `POS-106`, `POS-1105`, `POS-1203` e
`POS-1204` em ondas executáveis. Ele não habilita produção, não homologa
equipamentos e não muda o estado da matriz por si só.

| Capacidade | Estado de entrada | Evidência existente | Bloqueio para `DONE` |
|---|---|---|---|
| POS-106 — caixa e custódia | `PARTIAL` | ledger append-only, serviços de malote e testes PostgreSQL isolados | remover bypass de autoridade, tornar aprovação/contagem exatas, integrar producers, backfill, cutover, reconciliação/reabertura, custódia física e piloto |
| POS-1105 — antifraude | `TODO` | apenas controles adjacentes; não existe antifraude POS | domínio, engine, hooks, operação e aceite de risco |
| POS-1203 — E2E/performance | `TODO` | testes Node, contratos e simuladores | navegador real, Axe, chaos, carga e matriz operacional |
| POS-1204 — hardware | `PARTIAL` na matriz; runtime físico ainda não entregue | pairing, heartbeat, impressão, contratos e simuladores | binário, canal vinculado ao dispositivo, adapters, updater e laboratório |

O `PARTIAL` agregado de POS-1204 é honesto somente enquanto seu gate declarar
que o runtime físico continua pendente; uma divisão futura pode explicitar
`fundação/server: PARTIAL` e `runtime físico: TODO`. Contratos locais não são
prova de I/O. POS-106 só muda para `DONE` após o cutover e o piloto; a mera
dual-write não basta.

## 2. Regras transversais

- Dinheiro usa centavos inteiros; toda mutação possui idempotência e hash
  canônico. Correção de ledger é compensatória, nunca `UPDATE`/`DELETE`.
- Estado de negócio e seu ledger/outbox nascem na mesma transação. Constraints
  deferred recusam grafos incompletos no `COMMIT`.
- Locks seguem uma ordem única documentada. Relógio e autoridade são
  reavaliados depois de qualquer espera.
- Nenhuma wave remove gates financeiros, fiscais, offline ou de hardware.
- Falha externa produz estado explícito `unknown`, retry ou incidente; não
  converte ausência de resposta em sucesso.
- Logs, traces, screenshots e fixtures não contêm PAN, PIN, CVV, track data,
  segredo, documento integral ou payload cru de QR.
- Rollback é por flag/cutover e software anterior compatível. Migration
  destrutiva, truncamento e restauração seletiva não são estratégia de rollback.
- Uma wave só começa a operar em shadow/canary depois de migration em banco
  limpo, upgrade em clone e downgrade operacional ensaiado.
- Papel gerencial nunca concede autoridade operacional implícita. Toda ação de
  caixa usa grant real, vigente e revalidado dentro da mesma transação do
  efeito; exceção exige capability persistida, estreita e consumível uma vez.
- Horário monetário vem do banco ou do fato causal persistido. Timestamp
  arbitrário do cliente não pode prolongar aprovação, retroceder ou envenenar
  a cadeia com data futura.
- Contagem física, concessão de acesso, aprovação, reconciliação, custódia e
  evidência antifraude são versionadas/append-only; auditoria genérica mutável
  não é a única prova de uma decisão financeira.

### Baseline auditada antes da execução

Esta baseline é bloqueante e deve virar teste de regressão. Um teste local
verde da fundação isolada não equivale à integração operacional.

- **P0 — autoridade:** a rota principal ainda sintetiza acesso total para
  `owner/admin`; abertura, `cash.event`, fechamento e partes do lifecycle usam
  grant carregado antes da transação e não a política operacional fail-closed.
- **P0 — aprovação:** sangria e divergência de fechamento validam ação/entidade,
  mas não valor, contagens, versão, terminal e saldo causal exatos; também não
  exigem o mesmo step-up forte de outras operações financeiras.
- **P0 — evidência de fechamento:** `pos_session_payment_counts` representa
  somente o último conjunto e é recriado; primeira contagem, tentativas
  divergentes, ator e revisão não formam uma cadeia imutável.
- **P0 — duas fontes:** o PDV usa `cash_register_events` e pagamentos como
  autoridade; nenhum producer da rota grava o ledger novo. Não há bridge,
  estado de cutover, provenance ou backfill.
- **P0 — bypass por DML:** o runtime ainda pode inserir fatos diretamente nas
  tabelas de caixa. Os triggers numéricos não provam grant vivo, terminal nem
  existência do fato causal de uma venda/devolução.
- **P0 — concorrência/relógio:** rotas usam row locks enquanto o ledger usa
  advisory lock sem uma ordem global; `occurredAt` não possui boundary contra
  passado/futuro e pode invalidar monotonicidade ou validade de aprovação.
- **P0 — posse física:** o turno está ligado a caixa/terminal, não a uma unidade
  física de numerário. Handoff troca operador sem conferência/aceite da gaveta,
  tornando ambígua a atribuição de faltas.
- **P1 — alçadas e histórico:** grants são sobrescritos, não há versão
  imutável da autorização usada, limites por valor/período, denominações,
  auto-sangria, comprovante de despesa ou contagem surpresa.
- **P1 — custódia:** malote isolado cobre selar/entregar/aceitar/divergir, mas
  não possui capability própria de tesouraria, múltiplos hops, cofre/banco,
  recusa, lacre violado, perda ou comprovante de depósito.
- **P1 — fraude:** não existem modelos/rotas/testes POS de ruleset, sinal,
  avaliação, caso, evidência ou decisão. Controles de OTP de integrações não
  satisfazem POS-1105.

### Ordem crítica

```text
W330-A -> W330-B -> W331 -> gate de tesouraria
                    \-> W332 -> W333 ---\
W334 (harness contínuo) ----------------> W336 -> gates físicos/E2E -> piloto
W335 (agente e adapters virtuais) ------/
```

W334 pode começar cedo, mas o aceite final de W336 usa as rotas congeladas por
W331/W333 e o agente de W335. W330-B não começa antes de W330-A tornar a
autoridade operacional realmente fail-closed. A reconciliação manual POS-603
entra na matriz E2E quando suas capabilities estiverem prontas; ela não autoriza
atalhos neste plano.

## 3. W330 — autoridade e ledger de caixa

W330 é dividida em dois commits de aceite independentes. W330-A corrige a
autoridade antes que qualquer producer novo confie nela. W330-B integra o
ledger em shadow e depois faz o cutover. Não combinar as duas fases em um único
deploy irreversível.

### 3.1 W330-A — autoridade operacional fail-closed

#### Escopo

Eliminar grants sintéticos e bypasses gerenciais das ações operacionais. Tornar
grant, step-up, aprovação e contagem de fechamento provas exatas e revalidadas
na transação do efeito. Esta fase não troca a fonte contábil e não habilita
break-glass incompleto.

#### Dependências

- identidade usuário↔perfil, filial/caixa ativos e terminal proof existentes;
- catálogo fechado das ações operacionais e administrativas;
- política explícita de quem pode solicitar, aprovar e consumir cada ação;
- decisão local de limites por ação/valor; ausência de decisão falha fechado.

#### Dados, serviços e UI

- remover o acesso `id=0` de `owner/admin`; papel gerencial administra grants,
  mas não abre, vende, movimenta, fecha ou recebe custódia implicitamente;
- usar `authorizePosOperationalAction` — ou capability SQL equivalente — em
  `session.open`, `cash.supply`, `cash.withdraw`, `session.close`, venda,
  cancelamento, devolução, reimpressão, manual, carrinho e handoff;
- revalidar, após todos os locks, perfil, filial, caixa, grant, validade, flag,
  limite monetário, terminal, sessão/versão e relógio servidor;
- versionar o grant operacional ou persistir uma evidência imutável do grant
  exato consumido pelo efeito; alteração administrativa preserva before/after;
- persistir autorização excepcional em request/decision/consumption append-only
  antes de habilitar break-glass. Até lá, falta de grant explícito é `deny`;
- vincular sangria ao snapshot canônico de filial, caixa, turno/versão,
  terminal, ator, valor, motivo, saldo anterior e chave da operação;
- substituir a contagem sobrescrita por tentativa imutável com actor/profile,
  terminal, sessão/epoch, meio/provider, denominações opcionais, hash, sequência
  e estado `submitted|accepted|divergent|superseded_by_recount`;
- vincular aprovação de divergência à primeira contagem, esperado server-side,
  diferenças por meio, tolerância/policy versionada e eventual recontagem;
- exigir step-up forte para sangria acima da política, divergência, ajuste,
  reversal, reabertura, no-sale drawer e mudança sensível de alçada;
- UI não mostra esperado antes do commit da primeira contagem e invalida a
  aprovação quando qualquer campo do snapshot muda.

#### Invariantes

- `owner/admin` sem grant operacional real é negado como qualquer outro perfil;
- revogação/expiração durante a request vence o snapshot carregado antes;
- checker é distinto do maker, possui capability do contexto e permanece ativo
  no instante do consumo;
- aprovação de R$ 1,00 não autoriza R$ 1,01, outro motivo, turno, terminal,
  contagem ou versão;
- primeira contagem nunca é apagada; recontagem cria nova revisão e registra
  quem a pediu/aprovou;
- replay retorna a mesma evidência; chave igual com conteúdo diferente falha;
- relógio usado para validade é recapturado após espera e vem do banco.

#### Riscos P0/P1

- **P0:** grant revogado produz efeito por TOCTOU;
- **P0:** papel gerencial ou DML direto contorna acesso operacional;
- **P0:** aprovação genérica é reutilizada com valor/contagem diferente;
- **P0:** tentativas de fechamento desaparecem e permitem “adivinhar” o saldo;
- **P1:** grant sobrescrito impede provar a alçada histórica;
- **P1:** regra de limite sem versão muda a interpretação retroativamente.

#### Testes

- HTTP/PostgreSQL: owner/admin sem grant, grant ausente/revogado/expirado,
  revogação enquanto a transação espera lock e filial/caixa inativos;
- matriz por ação/flag com operador, maker, checker e administrador distintos;
- aprovação: troca de um centavo, motivo, contagem, terminal, versão, TTL,
  step-up, checker, replay e dois consumidores concorrentes;
- fechamento: primeira contagem imutável, recontagem, meios compensados,
  denominações inválidas e tentativa de leitura do esperado antes do submit;
- contratos inventariam toda rota operacional e recusam `privileged` bypass ou
  grant sintético.

#### Aceite W330-A

- zero bypasses operacionais baseados apenas em papel gerencial;
- toda ação inventariada revalida grant/relógio dentro da transação;
- sangria e fechamento consomem snapshot exato/one-shot com step-up conforme
  policy versionada;
- nenhuma contagem submetida pode ser atualizada ou apagada;
- testes concorrentes de revoke/consume terminam com um único efeito válido.

### 3.2 W330-B — producers, bridge, locks e cutover do ledger

#### Escopo

Integrar `session.open`, `cash.event`, pagamento em dinheiro de `sale.commit`,
cancelamento/devolução em dinheiro e `session.close` ao novo ledger. Manter o
legado somente como projeção compatível durante shadow, com origem causal
deduplicada e sem DML financeiro aberto ao runtime.

#### Dependências

- W330-A aceita e congelada;
- migration e serviços POS-106 existentes corrigidos para approvals de sangria,
  boundary de relógio e replay após perda de resposta;
- catálogo fechado dos tipos históricos de `cash_register_events`;
- decisão explícita sobre sessões criadas antes do terminal/ator/gaveta por FK.

#### Dados, serviços e UI

- adicionar estado de cutover por sessão: `legacy`, `shadow`, `authoritative`;
- modelar unidade física de numerário (`drawer/cassette/cash_unit`) e vinculá-la
  exclusivamente ao turno/epoch, terminal e register; abertura de gaveta é
  comando separado, autorizado e idempotente;
- adicionar bridge imutável fato↔ledger com FK/constraint deferred e unicidade
  nos dois sentidos; texto de referência sozinho não prova causalidade;
- remover `INSERT/UPDATE/DELETE` direto do runtime sobre ledger, custódia,
  bridge, contagens e lifecycle financeiro; expor capabilities estreitas;
- producers transacionais gravam fato, bridge, ledger, autorização, auditoria
  append-only e outbox no mesmo `txid`;
- abertura cria sequência 1 mesmo com zero; venda/suprimento aumentam;
  devolução/sangria/selagem reduzem; aprovação aplicável fica ligada por FK;
- usar timestamp do fato persistido/banco. Replay não recalcula horário nem
  hash a partir do relógio da segunda tentativa;
- congelar uma ordem de locks, por exemplo capability/advisory da sessão →
  sessão → terminal/grant → fato → ledger → aprovação/outbox, e aplicá-la a
  venda, supply, withdrawal, refund, custody e close;
- `session.close` verifica cobertura de todos os fatos elegíveis e impede novo
  lançamento depois do boundary de fechamento;
- UI continua lendo legado durante shadow, mas painel administrativo mostra
  saldo/diferença/provenance entre livros sem ação de autocorreção.

#### Invariantes

- um fato monetário gera exatamente um lançamento; fato ou lançamento órfão
  viola constraint no `COMMIT`;
- sequência e `balance_before/after` são contínuos por sessão/epoch/gaveta;
- sessão, caixa, filial, terminal, gaveta, ator, grant, aprovação e fato causal
  coincidem;
- venda sem dinheiro não gera lançamento; valor líquido de troco é lançado uma
  única vez; refund parcial referencia a parcela causal exata;
- sessões `authoritative` jamais usam soma legada nem voltam a `legacy`;
- timestamp aceito permanece dentro do boundary causal/servidor e não pode
  prolongar TTL nem bloquear a cadeia com futuro distante;
- nenhuma leitura soma simultaneamente legado e ledger.

#### Riscos P0/P1

- **P0:** dupla contagem durante dual-write;
- **P0:** venda/devolução commitada sem ledger ou ledger sem fato;
- **P0:** deadlock venda × sangria × fechamento pela ordem de locks;
- **P0:** capability incompleta permite INSERT forjado pelo runtime;
- **P0:** relógio backdated usa aprovação expirada ou futuro envenena sessão;
- **P1:** correlação errada de troco, refund parcial ou replay histórico;
- **P1:** shadow diverge sem alerta/SLO/provenance.

#### Testes

- PostgreSQL: mesma transação, grafos deferred, ACL/capabilities, timestamp
  passado/futuro, lost-response replay e falha após cada escrita;
- 20 writers por sessão, venda × supply × withdrawal × refund × custody × close,
  lock waits que atravessam TTL, deadlock detector e vencedor único;
- domínio/HTTP: opening zero, cash sale/troco, supply, withdrawal com aprovação,
  cancel/return parcial e fechamento com fato/ledger pendente;
- property tests geram sequências aleatórias e comparam legado, bridge, ledger e
  saldo por gaveta, incluindo replay e reversal;
- E2E inicial em W334: abrir → movimentar → vender → devolver → fechar.

#### Aceite W330-B

- zero commits parciais ou grafos órfãos em failpoints;
- diferença shadow zero em fixtures sintéticas e carga concorrente;
- zero deadlocks na matriz aceita e p95 dentro do orçamento aprovado;
- runtime comum não consegue fazer DML direto nas relações protegidas;
- relatório enumera toda divergência com provenance, sem autocorreção;
- promoção a `authoritative` ocorre apenas por sessão nova/eligível e flag
  auditada.

### Rollback W330

- W330-A é fail-closed: rollback não restaura bypass gerencial; pode desabilitar
  uma capability nova mantendo negação segura;
- durante shadow, manter leitura legada e voltar a flag de sessões ainda não
  promoted;
- producers novos podem ser desligados somente antes de uma sessão virar
  `authoritative`;
- sessões authoritative nunca retornam ao legado: corrigem-se por reversal e
  incidente.

### Gate externo

Nenhum para construir e aceitar W330-A/W330-B localmente. Dados históricos
reais, procedimentos físicos e operação de tesouraria pertencem a W331/G331.

## 4. W331 — backfill, cutover, reconciliação e reabertura

### Escopo

Classificar/backfill do legado, provar saldo por sessão, trocar relatórios e
fechamento para o ledger e implementar `closed -> reconciled` e reabertura
supervisionada sem apagar revisão anterior. Completar a cadeia física da gaveta,
malote, cofre/tesouraria e eventual depósito bancário, com responsabilidade
inequívoca em toda transferência.

### Dependências

- W330-A/W330-B verdes e formato da ponte congelado;
- clone representativo e inventário de exceções;
- política de tesouraria para lacre, entrega, aceite e divergência;
- tolerâncias e matriz maker-checker aprovadas;
- inventário de gavetas/cassetes, cofres, lacres, locais, transportadores e
  comprovantes aceitos, sem presumir hardware ainda não homologado.

### Dados, serviços e UI

- job versionado de backfill com estados `classified`, `backfilled`,
  `exception`, `verified`; nunca fabricar terminal/ator;
- snapshot imutável de reconciliação por sessão, contagens, diferença, versão,
  reconciliador e aprovação;
- lifecycle explícito `closed -> reconciled` e comando de reabertura que cria
  nova revisão/epoch ou nova sessão ligada à anterior;
- handoff de operador exige aceite explícito da responsabilidade física: mesma
  gaveta com conferência/recontagem versionada, ou troca de cassete com cadeia de
  custódia; nunca apenas alterar `operator_profile_id`;
- capabilities próprias e versionadas para selar, transportar, receber,
  conferir, resolver divergência, reconciliar e reabrir; ser usuário ativo da
  filial não basta;
- ampliar custódia com transferências múltiplas e estados explícitos para
  `in_transit`, `received`, `rejected`, `tampered`, `lost`, `safe_deposited`,
  `bank_deposited` e resolução, sem reescrever eventos anteriores;
- registrar origem/destino/local, custodiante atual, lacre, valor/denominações,
  timestamps do servidor, receipt/evidence hash e SLA/owner de incidente;
- dashboard de exceções, cadeia do malote e assinatura/aceite da tesouraria;
- relatórios leem apenas uma fonte conforme cutover e exibem provenance.

### Invariantes

- total inicial + deltas = saldo final e = snapshot reconciliado;
- toda exceção histórica é visível e bloqueia cutover da sessão;
- reconciliação e reabertura são append-only, idempotentes e segregadas;
- turno reconciliado não recebe novos lançamentos;
- reabertura não reescreve contagem, malote ou aprovação anterior;
- exatamente um custodiante/local responde pelo numerário em cada ponto da
  cadeia; handoff não cria intervalo sem responsabilidade;
- se destinatário, lacre ou valor divergir, aceite normal fica bloqueado e nasce
  incidente durável; depósito bancário não é inferido por mera entrega;
- resolvedor, maker e checker atendem a matriz de independência e capabilities
  no instante do efeito.

### Riscos P0/P1

- **P0:** backfill atribuir identidade falsa ou duplicar dinheiro;
- **P0:** relatório misturar sessões legacy e authoritative sem provenance;
- **P0:** reabrir turno reconciliado e alterar o livro fechado;
- **P0:** handoff transferir responsabilidade sem contagem/aceite físico;
- **P0:** qualquer usuário ativo da filial atuar como tesouraria sem capability;
- **P0:** malote ficar sem custodiante ou depósito ser marcado sem evidência;
- **P1:** exceção histórica sem owner/prazo/evidência;
- **P1:** cutover sem caminho de suporte e reconciliação diária;
- **P1:** cadeia não representar recusa, violação de lacre, perda ou vários hops.

### Testes

- PostgreSQL: backfill repetido, colisão de origem, sessão incompleta, graph
  closed/reconciled/reopened, maker-checker e concorrência reconcile × reopen;
- PostgreSQL: um custodiante por vez, handoff/recontagem, grant revogado durante
  aceite, lacre duplicado/violado, entrega concorrente, múltiplos hops e receipt
  causal obrigatório;
- clone: somas por sessão/dia/filial antes e depois, amostra manual e 100% das
  exceções classificadas;
- E2E: fechamento, selagem, entrega, aceite/divergência, resolução, reconciliação
  e tentativa adversarial de reabertura; incluir troca de operador/gaveta,
  recusa, lacre violado, cofre e comprovante bancário simulado.

### Aceite

- diferença zero nas sessões elegíveis do clone;
- 100% das demais em registro de exceção aprovado, sem dado inventado;
- relatórios shadow iguais pelo período definido;
- nenhuma passagem de responsabilidade sem ator/capability/evidência exatos;
- piloto de tesouraria completa ao menos dois ciclos, um handoff e incidentes
  ensaiados de diferença e lacre violado.

### Rollback

- antes do cutover: retornar leitura ao legado;
- depois do cutover de uma sessão: não reverter dados; pausar novas sessões,
  manter ledger como autoridade e usar projeção/relatório compatível;
- reabertura errada é compensada por nova revisão, nunca exclusão.

### Gate externo

**G331.** Clone real, owner financeiro, inventário de gaveta/cassete/cofre,
procedimento de lacres/transporte/depósito, usuários e capabilities distintos,
retenção dos comprovantes, treinamento, ensaios de handoff, divergência, lacre
violado/perda e aceite formal do piloto. Hardware físico, transportadora e banco
continuam externos; simulador não os homologa. Sem G331, POS-106 permanece
`PARTIAL`.

## 5. W332 — regras, sinais e avaliações antifraude

### Escopo

Criar engine determinístico versionado, sinais e avaliações reproduzíveis. A
primeira entrega opera exclusivamente em `monitor_only`: observa e mede, mas não
bloqueia, não exige step-up e não muda uma operação. Cases, evidências e decisões
operacionais pertencem a W333.

O estado inicial é `TODO`: não há modelos, routes ou testes POS de ruleset,
sinal/avaliação. Score de OTP de integrações é outro domínio e não conta como
evidência desta wave.

### Dependências

- taxonomia de atores, terminais, clientes e ações;
- eventos de caixa W330-B estáveis para sinais monetários;
- política de retenção/LGPD para sinais e atributos pseudonimizados;
- relógio, timezone da filial e hashes canônicos autoritativos;
- inventário estável de eventos de W330-A/W330-B e demais ações POS, sem depender
  exclusivamente de `TenantAuditEvent` genérico.

### Dados, serviços e UI

- `PosFraudRuleSet/Rule`, versões `draft|active|retired`, vigência, timezone,
  policy digest e ativação maker-checker;
- `PosFraudSignal`, `Evaluation`, input snapshot/hash e event ledger append-only;
- normalizador/outbox idempotente para acesso/alçada, opening/close, supply,
  withdrawal, drawer open, handoff, desconto, venda, cancelamento, refund,
  manual payment, reimpressão e custódia;
- índices/janelas para velocidade, valor acumulado e fragmentação por
  operador, terminal, cliente, caixa e referência pseudonimizada;
- regras iniciais para after-hours, terminal hopping, muitas gavetas/turnos,
  grant sensível seguido de efeito, abertura/fundo anormal, sangrias repetidas,
  fragmentação abaixo de alçada, excesso de no-sale drawer/reprint, divergência
  recorrente e cadeia de custódia atrasada;
- outcomes calculados `allow|monitor|step_up|review|block`, mas W332 persiste
  somente a recomendação simulada e `wouldHave...`.

### Invariantes

- avaliação referencia versão imutável da regra e input hash;
- mesmo evento/versão produz a mesma avaliação; replay não duplica sinal ou
  avaliação;
- ativação/retirement de regra não altera avaliações históricas;
- janelas concorrentes usam serialização/contador autoritativo, não consulta
  eventual suscetível a fracionamento;
- `monitor_only` nunca muda resposta/latência crítica além do budget e nunca é
  confundido com `allow` operacional;
- ausência/timeout gera estado/telemetria explícitos conforme política da ação;
  nesta wave não transforma recomendação em block;
- PII não entra em atributos livres; identificadores são minimizados,
  pseudonimizados e versionados para rotação/retention.

### Riscos P0/P1

- **P0:** ligar block/step-up por engano durante `monitor_only`;
- **P0:** corrida nas janelas permite fracionamento concorrente;
- **P0:** sinal deriva de evento mutável/duplicado e acusa o ator errado;
- **P1:** promoção sem aceite faz falsos positivos paralisarem o caixa;
- **P1:** sinal/atributo vira repositório de PII;
- **P1:** regra retroativa muda a interpretação de decisão histórica.

### Testes

- PostgreSQL: 20 eventos concorrentes no limite, janelas de fronteira/timezone,
  regra trocada durante avaliação, idem divergente, outbox duplicada e ledger
  append-only;
- unit/property: velocity, fracionamento abaixo de alçada, after-hours,
  terminal hopping, acesso→efeito, gaveta/reprint e repetição;
- contrato inventaria todos os producers de sinais e prova que `monitor_only`
  não altera a resposta de negócio;
- segurança: acesso por filial, redaction, pseudonimização, retenção/legal hold;
- replay reproduz avaliação histórica pela versão/hash sem consultar regra atual.

### Aceite

- engine reproduzível por rule version/input hash;
- nenhuma perda/duplicação sob concorrência;
- cobertura do inventário de sinais e taxa de evento sem avaliação publicadas;
- dashboards de recomendação, falso positivo amostrado, atraso e latência;
- `monitor_only` não altera nenhuma ação e registra toda recomendação simulada;
- nenhuma relação de regra/sinal/avaliação aceita update/delete pelo runtime.

### Rollback

- retirar ruleset ativo e permanecer `monitor_only`;
- nunca excluir avaliações; desativar regra cria nova versão/estado;
- hooks ainda não bloqueiam operação nesta wave.

### Gate externo

**G332.** Risco/LGPD aprovam taxonomia, minimização, retenção, pseudonimização,
thresholds preliminares e período mínimo de observação. Feed de chargeback,
adquirente, IAM/MFA e SOC são dependências externas para maturidade, não para
construir o domínio local. Sem G332, rulesets permanecem `monitor_only` e
POS-1105 no máximo `PARTIAL`.

## 6. W333 — cases, evidências, decisões e hooks antifraude

### Escopo

Criar operação de cases/evidências/decisões e integrar avaliações a acesso,
cash/drawer, desconto, venda, devolução/refund, sessão/handoff, custódia e
pagamento manual. Promover por ação/regra de monitor para step-up/review e,
somente por último, block.

### Dependências

- W332/G332 e SLO de monitoramento cumprido pelo período aprovado;
- W330-B para sinais de dinheiro;
- step-up/approvals e capabilities financeiras sem DML direto;
- taxonomia de case, evidência allowlisted, recurso e compensação;
- runbooks, fila, escala de atendimento e owner/SLA por severidade.

### Dados, serviços e UI

- `PosFraudCase`, `Evidence`, `Assignment`, `Decision`, `Appeal` e event ledger
  append-only, com owner, prioridade, SLA, estado e reason codes allowlisted;
- evidence referencia fatos/artefatos imutáveis por locator/digest; nota livre é
  minimizada, redigida, limitada e nunca recebe PAN, segredo ou documento cru;
- hook transacional ou reservation/evaluation causal por ação, escolhido antes
  de qualquer efeito externo; evento pós-efeito usa incidente/compensação;
- vínculo obrigatório entre avaliação, aprovação/step-up e commit;
- incident/outbox para avaliação assíncrona onde a ação não pode bloquear;
- políticas explícitas por ação para timeout/unavailable:
  `allow+incident|step_up|review|block`; ausência nunca herda default global;
- UI operacional apresenta motivo público allowlisted, ação segura, TTL e
  referência do caso sem revelar threshold/regra explorável;
- painel permite atribuir, decidir, escalar, anexar locator, recorrer e auditar
  sem editar evidência ou evento anterior;
- override/close/release exigem maker-checker, step-up, capability viva e decisão
  causal one-shot; correção é novo evento, não overwrite.

### Invariantes

- commit usa a mesma versão/hash/valor/ator avaliados;
- autoridade, regra e relógio são revalidados após locks;
- timeout/revogação entre evaluation e commit invalida a autorização;
- block/override é idempotente e maker-checker;
- dinheiro já externo nunca é reenviado por falha da projeção antifraude;
- case deduplica pela avaliação/fato/regra e não agrega pessoas/contextos sem
  chave causal autorizada;
- evidência e decisão histórica continuam reproduzíveis após retirement de regra
  ou revogação de usuário;
- decisor não pode ser maker/ator da operação sensível nem aprovar fora da
  filial/scope/capability;
- transição `monitor -> step_up -> review -> block` é por regra/ação versionada,
  canário e kill switch; nunca promoção global implícita.

### Riscos P0/P1

- **P0:** cobrança concluída e venda bloqueada sem estado de compensação;
- **P0:** bypass por rota sem hook;
- **P0:** decisão stale aplicada a outro valor/contexto;
- **P0:** case/evidência/decisão alterável ou acessível por DML comum;
- **P0:** override/release sem checker/step-up/capability vigentes;
- **P1:** indisponibilidade do engine derruba todas as operações;
- **P1:** UI revela regra suficiente para facilitar evasão;
- **P1:** evidence/nota livre vaza PII ou vira armazenamento paralelo;
- **P1:** fila sem owner/SLA acumula review e paralisa operação.

### Testes

- contrato lista todas as rotas/efeitos operacionais e exige policy/hook
  explícitos, incluindo access update, drawer/no-sale, handoff, custody e reprint;
- PostgreSQL: evaluation × commit × rule retirement × grant revoke;
- PostgreSQL: deduplicação de case, assignment concorrente, decision/appeal,
  maker-checker, evidence append-only, ACL/capability e SLA/expiry;
- failpoints antes/depois de efeito externo e callback fora de ordem;
- E2E de todos outcomes, fila, step-up, review, block, override, recurso,
  identidades e mensagens redigidas;
- segurança/LGPD: acesso entre filiais, nota/PAN/segredo/documento, locator
  inválido, retenção/legal hold e export sem conteúdo proibido;
- shadow/canary compara decisão com resultado operacional.

### Aceite

- 100% das rotas em inventário possuem política explícita;
- step-up/review passam matriz real de papéis;
- cases/evidências/decisões são append-only, capability-only e reproduzíveis;
- fila possui owner/SLA/alerta e ensaio de backlog/outage;
- block só é habilitado por ação após janela monitor-only, canário, análise de
  falso positivo e aprovação de risco;
- runbook cobre falso positivo, outage, pagamento unknown, recurso, override,
  vazamento de evidência e kill switch.

### Rollback

- configuração por regra/ação retorna `block -> review -> monitor_only`;
- avaliações e casos permanecem; não apagar evidência;
- effects externos seguem seus aggregates de compensação.

### Gate externo

**G333.** Owner de risco, IAM/MFA real, escala operacional 24×janela acordada,
thresholds e falso positivo aprovados, jurídico/LGPD, recurso, kill switch,
runbook de compensação e piloto controlado. Feed externo ausente limita regras e
deve aparecer como risco, nunca ser simulado como homologado. Sem aceite,
POS-1105 permanece `PARTIAL` mesmo com código; `block` continua desligado.

## 7. W334 — harness E2E browser e acessibilidade

### Escopo

Instalar e versionar Playwright, Chromium e WebKit; criar tenant/terminal/provider
determinísticos; executar jornadas reais com Axe, offline, falhas e artefatos.

### Dependências

- ambiente efêmero com migrations/seed e relógio controlável;
- adapters e agente simulados sem rede externa;
- seletores/nomes acessíveis estáveis, HTTPS local para PWA/câmera;
- mecanismo de failpoint exclusivo de teste e impossível em produção.

### Dados, serviços e UI

- fixtures por worker, reset idempotente e IDs próprios;
- page objects pequenos; teste observa UI/API/DB sem acoplar a markup incidental;
- projetos desktop/kiosk/tablet/mobile, teclado e touch;
- traces, vídeo e screenshot redigidos; relatório Axe e budgets por jornada;
- dataset de catálogo com 50 mil produtos, códigos e clientes.

### Invariantes

- E2E nunca usa produção nem providers reais;
- teste paralelo não compartilha caixa, turno ou idempotency key;
- screenshot/trace não guarda segredo/PII;
- `retry` não mascara teste flaky: primeira falha e taxa de flake são métricas;
- pagamento, caixa e fiscal permanecem bloqueados offline.

### Riscos P0/P1

- **P0:** suíte verde por mockar a fronteira que deveria testar;
- **P1:** fixtures compartilhadas produzem falsa concorrência/flakiness;
- **P1:** artefatos vazam dados;
- **P1:** WebKit CI tratado indevidamente como prova de Safari/VoiceOver.

### Testes

- smoke: autenticar, abrir turno, scan, carrinho, cliente, pagamento simulado,
  recibo e fechamento;
- teclado/modal/foco, touch 44 px, zoom/reflow, forced colors e Axe;
- scanner/câmera: permissão, rajada, repetição legítima, inválido e troca;
- PWA: reload, crash, quota/eviction, múltiplas abas, conflito e ACK;
- recovery: falha antes/depois de effect, claim expirado/roubado e replay;
- catálogo 50 mil com busca/scroll e budgets p50/p95/p99.

### Aceite

- Chromium e WebKit verdes em CI limpo e repetição soak;
- zero violações Axe críticas/sérias no escopo acordado;
- budgets e taxa máxima de flake publicados;
- matriz P0 possui link para teste/trace ou justificativa externa.

### Rollback

- harness não altera runtime; pin de browser/dependência é reversível;
- teste instável é isolado com issue/owner/prazo, nunca removido silenciosamente;
- falha E2E bloqueia rollout, não força rollback de dados.

### Gate externo

NVDA/Firefox, VoiceOver/Safari, dispositivos touch/kiosk e leitores/câmeras reais
continuam manuais/laboratoriais.

## 8. W335 — runtime do agente local e adapters virtuais

### Escopo

Entregar binário/serviço least-privilege, identidade vinculada ao dispositivo,
fila assinada genérica, spool local, updater e adapters virtuais para scanner,
impressora, gaveta, balança, display e pagamento presencial.

### Dependências

- protocolo de envelope/ACK e lifecycle do terminal existentes;
- PKI/mTLS ou chave de dispositivo atestada;
- formato de command outbox/lease/fencing;
- política de distribuição, assinatura e versão mínima.

### Dados, serviços e UI

- command/outbox e ACK append-only para `print.receipt`, `drawer.open`,
  `scale.read`, `display.render`, `scanner.capture` e operações TEF/SmartPOS;
- binário sem privilégio administrativo, keystore do SO, spool cifrado,
  journal de nonce/sequence e logs redigidos;
- discovery por allowlist de VID/PID/endereço e adapter versionado;
- updater assinado, rollback, canal staged, SBOM e health por device;
- UI mostra capability/saúde real e falha fechada quando dispositivo obrigatório
  está ausente.

### Invariantes

- fingerprint/chave registrada é verificada em toda autenticação; bearer sozinho
  não basta;
- comando expira, possui sequence/nonce/digest e só executa no terminal/device;
- ACK é fenced ao claim/digest; replay não reabre gaveta ou refaz TEF;
- spool não contém PAN/segredo e sobrevive a reboot;
- updater nunca aceita pacote sem assinatura/versão/rollback válido.

### Riscos P0/P1

- **P0:** agente comprometido executa comando arbitrário ou em outro caixa;
- **P0:** retry duplica gaveta/pagamento/impressão sem estado explícito;
- **P0:** updater vira execução remota privilegiada;
- **P1:** health autorreportado é confundido com prova física;
- **P1:** driver trava processo e perde heartbeat/spool.

### Testes

- protocolo: tamper, replay, clock skew, revoke/rotate, lease steal e fencing;
- processo: reboot/crash entre efeito e ACK, disco cheio, spool corrompido,
  desconexão e atualização/rollback;
- adapters virtuais: bytes ESC/POS, pulso separado, balança instável/overload,
  display redigido, scanner serial e TEF approved/declined/unknown/reversal;
- segurança: usuário restrito, permissões de arquivo, egress, SBOM e assinatura;
- E2E W334 consome o binário em modo virtual, não uma função in-process.

### Aceite

- pacote reproduzível e assinado para SOs suportados;
- rotação/revogação e replay testados após reboot;
- todos comandos possuem outbox/lease/fencing/ACK e runbook;
- nenhum segredo aparece em log/spool/crash dump de teste.

### Rollback

- rollout staged com versão anterior assinada e compatibilidade N-1;
- servidor pode elevar versão mínima ou revogar agente comprometido;
- comando pendente preserva estado e é reconciliado antes de trocar versão.

### Gate externo

Certificados/keystore corporativos, SDK/licença TEF/SmartPOS e modelos físicos
não são substituídos pelos adapters virtuais.

## 9. W336 — convergência E2E, performance e laboratório

### Escopo

Executar a matriz integrada sobre caixa authoritative, fraude, browser e agente;
medir performance/soak, realizar laboratório físico e preparar piloto gradual.

### Dependências

- W331, W333, W334 e W335 aceitas localmente;
- providers financeiros/fiscais usados no piloto homologados separadamente;
- observabilidade, alertas, backup/restore e resposta a incidente;
- hardware e SO/firmware escolhidos, inventariados e disponíveis.

### Dados, serviços e UI

- matriz rastreável requisito → teste → artefato → owner → validade;
- dashboards de latência, fila, deadlock, divergência, fraude, device e flake;
- feature flags por filial/caixa/capability e kill switches testados;
- runbooks acessíveis ao operador, suporte, tesouraria, fraude e SRE.

### Invariantes

- nenhum resultado simulado é rotulado como homologação física/externa;
- falha de impressão não desfaz venda; falha TEF/PSP usa `unknown` e consulta;
- hardware desconectado não habilita entrada insegura automaticamente;
- piloto usa uma filial, rollout em canário e promoção por evidência;
- gate P0/P1 aberto bloqueia produção ou possui exceção formal com prazo,
  compensação e owner.

### Riscos P0/P1

- **P0:** diferença entre simulador e firmware/provider real;
- **P0:** falha pós-efeito externo causa duplicidade;
- **P0:** cutover simultâneo de caixa, fraude e hardware sem kill switch;
- **P1:** performance degrada no catálogo/rajada/soak;
- **P1:** matriz envelhece após update de browser, agente ou firmware.

### Testes PostgreSQL/E2E/físicos

- carga concorrente, lock/deadlock, restore e failover em clone;
- E2E completo abrir → scan → desconto/cliente → pagar → fiscal → imprimir →
  custódia → fechar/reconciliar, incluindo fraude e recovery;
- catálogo 50 mil, rajada, slow network, offline permitido, multitab e soak;
- impressora sem papel/tampa/cabo, gaveta, balança instável/overload, display,
  scanner 1D/2D, câmera e reboot/update do agente;
- TEF/SmartPOS approved/declined/timeout/unknown/query/reversal e callbacks;
- acessibilidade manual NVDA/Firefox e VoiceOver/Safari.

### Aceite

- todos P0/P1 aplicáveis fechados ou exceção formal válida;
- budgets/SLOs e alertas comprovados em soak;
- restore, kill switch e rollback ensaiados;
- aceite assinado de tesouraria, risco, segurança, fiscal/adquirente, QA,
  acessibilidade, suporte e operação da filial piloto;
- piloto sem divergência não explicada antes de ampliar o canário.

### Rollback

- desligar capability/filial pelo kill switch, preservar fatos/outboxes e
  reconciliar efeitos unknown;
- agente volta apenas para pacote N-1 assinado;
- sessões authoritative continuam no ledger novo;
- rollout só retoma após causa, correção, reexecução da matriz e novo aceite.

### Gate externo

**G336:**

- matriz por SO/navegador/agente/modelo/firmware/conexão;
- adquirente/TEF/SmartPOS, fiscal/SEFAZ e certificados homologados;
- NVDA/VoiceOver e dispositivos de operação reais;
- pentest, DLP/egress, observabilidade, suporte e piloto de filial.

## 10. Evidência e atualização de status

Cada wave publica:

1. migration/schema checksum e resultado banco limpo + upgrade de clone;
2. contagem e nomes das suítes, sem esconder skips;
3. matriz de failpoints/concorrência e artefatos E2E redigidos;
4. riscos residuais P0/P1, owner, prazo e compensação;
5. decisão `go`, `hold` ou `rollback` assinada pelos owners aplicáveis.

Para W330–W333, a evidência inclui também:

- inventário máquina-verificável de rotas/efeitos e sua policy de autoridade,
  ledger e fraude;
- teste ACL negativo provando que runtime comum não faz DML direto em grant,
  contagem, ledger/bridge, custódia, regra, sinal, case, evidência ou decisão;
- manifesto de lock order, relógios recapturados e snapshots/hash consumidos;
- relatório de skips/gates externos separado dos testes locais verdes.

Atualizar a matriz somente quando o critério integral for atendido:

- POS-106: `DONE` após G331;
- POS-1105: `PARTIAL` após W332 + G332; `DONE` somente após W333 + G333;
- POS-1203: `PARTIAL` após W334 e `DONE` após W336 + evidência externa;
- POS-1204: permanece `PARTIAL` durante W335; requisito agregado muda para
  `DONE` somente após G336.

Até lá, `npm run pdv:readiness -- --require-production-ready` deve continuar
falhando. Isso é comportamento correto, não defeito do gate.
