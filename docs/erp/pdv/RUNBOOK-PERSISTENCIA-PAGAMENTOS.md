# Runbook — persistência de pagamentos eletrônicos

## Escopo e limite

Esta camada persiste o plano autoritativo da cobrança, suas linhas de cotação e divisões, a intenção, cada tentativa, o outbox de dispatch, callbacks assinados e o histórico monotônico de estados. Ela é provider-agnostic e não implementa PSP, captura física, TEF, Pix real nem homologação. Um adapter externo deve retirar comandos do boundary interno e devolver apenas resultados normalizados.

O terminal nunca escolhe o valor ou método final ao criar uma intenção ou concluir a venda. `promotion.quote` grava o snapshot relacional do rascunho e devolve um plano `quoted`; `POST /api/erp/pdv/payment-plans` ativa divisões contíguas cuja soma é exata e congela método, valor, parcelas, tipo de prova, conector, credencial e prazo. Depois disso, `intent.create` aceita somente `sessionId`, `paymentPlanId`, `paymentIndex` e a chave idempotente. O commit aceita o ID/versão do plano e apenas IDs de prova ou campos de execução como valor entregue em dinheiro e segredo de gift card.

O commit da venda aceita uma forma eletrônica somente com uma das duas provas autoritativas:

- `paymentIntentId` no estado `captured`, apontando por FK composta para a divisão exata do plano; ou
- uma referência manual aprovada e ligada à mesma divisão quando a wave `320000` habilitar sua reconciliação.

Dinheiro e contas de valor locais não aceitam essas provas externas. Dinheiro exige pagamento capturado com `tendered >= amount` e troco exato; valor local exige reserva/captura/ledger ligados por FKs ao mesmo contexto e montante. No `310000`, novas divisões manuais ficam deliberadamente desabilitadas até o workflow de reconciliação `320000`. Estado `unknown` nunca materializa `PosSalePayment` e impede fechamento ou passagem do turno até convergir. Uma captura ainda não vinculada também bloqueia essas operações para evitar dinheiro externo órfão.

## Fluxo do operador no checkout

O checkout segue esta ordem:

1. persistir o rascunho e cotar preço/promoção, recebendo `paymentPlan.id`, versão, hash e TTL;
2. informar as divisões e ativar o plano; a API valida soma, conectores e credenciais e persiste os slots;
3. para Pix, crédito, débito e voucher, criar/acompanhar a intent pelo ID do plano e índice do slot;
4. enviar `sale.commit` com plano/versão e apenas provas/segredos de execução; o servidor deriva método, centavos e parcelas dos slots e consome plano e venda atomicamente.

Para Pix, crédito, débito e voucher, cada divisão possui prova explicitamente tipada:

- **Intent eletrônico persistido**: o operador escolhe a divisão antes de ativar o plano; depois a intent apenas referencia plano/índice e acompanha `created`, `processing`, `authorized`, `captured`, `declined`, `unknown`, `manual_review` ou `cancelled`.
- **Referência manual aprovada**: permanece desligada nesta wave. O plano `320000` define reconciliação e liberação sem representar a confirmação local como captura do provider.

Somente `captured`, ainda não consumido e com correspondência exata de plano/slot, turno, caixa, operador, rascunho, valor, método, parcelas, conector, credencial e terminal libera a conclusão. `authorized` não basta. Controles que alterariam esse contexto ficam bloqueados enquanto a intenção está ativa; `unknown` e `manual_review` orientam o operador a não repetir a cobrança.

O botão **Cancelar antes do envio** é deliberadamente limitado a `created` sem qualquer dispatch, referência ou horário do provider. A API trava intent, attempts e outbox, verifica versão/CAS, encerra a fila e grava evento/auditoria idempotentes. Se um worker já reivindicou a tentativa, o cancelamento falha fechado: a UI deve consultar/reconciliar, nunca alegar cancelamento externo. Não existe chamada de cancelamento a PSP nesta camada.

## Configuração obrigatória

- `NALVEN_INTERNAL_JOB_TOKEN`: bearer ASCII de 32 a 512 caracteres, exclusivo para os jobs internos de outbox e manutenção.
- `NALVEN_SECRETS_MASTER_KEY`: chave já usada para cifrar credenciais de integração.
- `IntegrationCredential` ativa, com provider da família `payment`, contendo `payment_callback_secret` (preferencial) ou `webhook_secret`, com no mínimo 32 bytes.
- `PosConnector` ativo do tipo iniciado por `payment`, na filial/caixa corretos, apontando `credentialRef` para essa credencial. A allowlist de métodos pode ser declarada em `settings.methods`.
- `config.webhook_key_id` identifica a chave durante rotação; na ausência, o ID da credencial é usado.
- cada intent grava o `credentialRef` exato usado no dispatch. Rotação do conector não redireciona retries em voo.
- uma credencial desabilitada só continua aceitando callback quando sua configuração declara `payment_callback_grace_until` futuro; revogação sem essa graça falha fechada. Todas as chaves candidatas do mesmo `keyId` são verificadas durante a janela.

Segredos não são retornados pelo outbox. O worker recebe apenas `credentialRef` e deve resolver a credencial dentro do boundary confiável. Nunca registre corpo bruto, segredo, PAN, CVV ou trilha magnética.

## Fluxo do worker

1. Faça `POST /api/internal/pdv/payments/outbox/{organizationId}` com bearer e JSON `{"action":"outbox.claim","workerId":"...","limit":25,"leaseSeconds":60}`.
2. Para cada comando, execute o adapter com `providerIdempotencyKey`. Para `create`, essa chave permanece a mesma em todos os retries.
3. Conclua o mesmo endpoint com `action=outbox.complete`, `attemptId`, `claimToken` e um resultado:
   - `result`: resposta conclusiva normalizada;
   - `known_failure`: falha sabidamente sem efeito, retryable ou final;
   - `unknown`: timeout/quebra em que não é seguro afirmar se houve efeito.
4. Não refaça `create` por conta própria após `unknown`. A manutenção cria uma tentativa `query` para reconciliar a identidade real.

Claims usam lease, `FOR UPDATE SKIP LOCKED` e CAS. A seleção trava primeiro uma `CashRegisterSession` elegível com `SKIP LOCKED`; isso evita head-of-line entre turnos sem inverter a cadeia canônica e serializa deliberadamente os dispatches do mesmo turno. Antes de qualquer `create` real, o worker revalida `session → terminal → acessos explícitos → claim → draft → plan → connector → credential → intent → attempt → outbox`, inclusive TTL, lease, allowlist de método, conector e snapshot da credencial. Falha pré-dispatch termina intent/outbox sem chamar o provider; operações observacionais `query` e callbacks continuam aceitas depois de expiração para nunca perder evidência tardia. Cada entrega concluída gera um `PosPaymentDeliveryResult` append-only, identificado pelo hash do claim e pelo número da entrega. Assim, repetir um `known_failure retryable` da mesma entrega é replay idempotente mesmo depois de o outbox voltar para `retry`; conteúdo diferente para o mesmo claim falha fechado.

## Callback

O endpoint é `POST /api/webhooks/pos-payments/{organizationId}/{provider}` e exige:

- `Content-Type: application/json` e no máximo 64 KiB;
- `X-Pos-Timestamp` em segundos, dentro de 300 segundos;
- `X-Pos-Event-Id` único por provider;
- `X-Pos-Key-Id` presente na keyring aceita: credencial ativa ou credencial desabilitada com `payment_callback_grace_until` futuro explícito;
- `X-Pos-Signature: sha256=<hex>`, HMAC-SHA256 de `timestamp + "." + eventId + "." + bytes_crus`.

O payload vincula `intentId`, referência, estado, valor, moeda, sequência e horário do provider. Sequências/eventos antigos são registrados como stale sem regredir a intenção. Um timeout local vira `unknown` sem inventar referência ou sequência; por isso o callback capturado posterior pode estabelecer a identidade verdadeira. Strings que contêm uma sequência de 12–19 dígitos válida por Luhn são rejeitadas em qualquer campo, além dos nomes PCI proibidos.

Callbacks de `partially_refunded`/`refunded` são registrados, mas não aplicados enquanto não existir o comando compensatório que atualize em uma única transação `PosSalePayment`, retorno e ledger financeiro. Isso evita divergência contábil silenciosa.

Depois de um intent ser consumido pela venda, sua evidência autoritativa fica congelada também por trigger no PostgreSQL e deve permanecer igual ao `PosSalePayment`. Novos callbacks continuam append-only em `PosPaymentCallback`, com resultado `supplemental_after_consumption`, sem sobrescrever valor, referência, identificadores ou horário da captura. Callback incompatível com um estado terminal local também é preservado como `rejected_transition` e abre `terminal_state_callback_conflict`; valor/moeda/evidência contraditórios abrem os incidentes específicos, sempre `productionBlocking=true` quando há risco monetário.

Um incidente bloqueante impede fechamento, pausa, solicitação e aceite de handoff do turno. Ele aparece em **PDV → Saúde operacional → Integridade de pagamentos**. Não edite intent, pagamento, callback ou incidente no banco. Preserve os hashes, confronte o evento no portal do provider e escale para resolução auditável; o modelo só admite a transição `open → resolved`, com ator, data e motivo, mas esta entrega não expõe resolução manual sem o workflow supervisor/conciliatório correspondente.

## Manutenção e recuperação

Execute periodicamente `POST /api/internal/pdv/payments/process` com bearer e `{"action":"payment.maintenance","organizationLimit":20,"itemLimit":25}`. O job:

- cancela intents que expiraram antes do primeiro dispatch;
- recupera leases expirados;
- transforma lease exaurido após dispatch em `unknown` reconciliável, sem identidade sintética;
- encerra outboxes obsoletos por callback/estado final;
- agenda consultas para `processing`, `authorized`, `unknown` e `manual_review`;
- expira planos `quoted`/`active` pelo relógio do PostgreSQL somente quando não existe pagamento, referência manual, captura, resultado desconhecido, callback arriscado ou tentativa incompleta;
- usa advisory lock por tenant para impedir dois sweepers simultâneos.

Uma intent `declined` só libera a expiração quando todas as tentativas/outboxes estão em estados terminais conhecidos e existe resultado conclusivo append-only do worker ou callback assinado `declined` aplicado no mesmo contexto financeiro, sem incidente bloqueante. Tentativa sem outbox, claim aberto, `outcomeUnknown` ou callback de captura mantém o plano aberto para reconciliação. O sweeper também não avança a mesma intent duas vezes na mesma transação: uma recuperação de lease que produz `unknown` agenda a consulta apenas no ciclo seguinte.

Alertar para intents `unknown`/`manual_review` antigas, outbox `dead`, repetidos `lease_outcome_unknown`, backlog crescente, captura não consumida e qualquer `PosPaymentIntegrityIncident.productionBlocking=true`. A resolução operacional não deve editar histórico: callbacks, resultados de entrega e state events são imutáveis; correções futuras devem ser eventos/lançamentos compensatórios.

## Preflight e cutover do plano autoritativo

Antes de habilitar as rotas do `310000` num tenant existente, inventarie artefatos legados sem `payment_plan_id`. O histórico já consumido pode permanecer somente leitura, mas o rollout deve ser abortado se existir qualquer um destes registros:

- intent não consumida em `created`, `processing`, `authorized`, `captured`, `unknown` ou `manual_review` com `payment_plan_id IS NULL`;
- referência manual ainda pendente/aprovável, não consumida, com `payment_plan_id IS NULL`;
- outbox/tentativa aberta ligada a intent legada, captura sem venda exata ou incidente financeiro bloqueante não resolvido;
- rascunho recuperável que possua prova financeira legada e não possa ser ligado por evidência histórica exata a uma venda.

Cada ocorrência precisa ser consultada/reconciliada no fluxo legado, cancelada comprovadamente antes de dispatch, vinculada à venda histórica já consumida ou resolvida por compensação auditável antes do corte. Não crie plano, slot, intent, captura, referência, callback ou ledger sintético para “completar” dados antigos. Não derive vínculo por valor, horário, operador ou proximidade. Preserve IDs e evidências, gere relatório assinado do inventário e repita o preflight imediatamente antes de liberar tráfego.

Depois do cutover, toda nova intent/referência/pagamento de venda exige plano e slot. Recovery retorna planos abertos/terminais junto dos IDs de prova; ausência de correspondência exata bloqueia checkout e passagem de turno.

## Validação

- `npm run test:pos:payment-plan` cobre parser, rejeição de valor terminal-authoritative e contratos do plano.
- `npm run test:pos-contract` verifica schema, boundary, RBAC, XOR e bloqueios de turno.
- `POS_TEST_DATABASE_URL=... npm run test:pos:payment-plan:postgres` valida fases fechadas, aggregate atômico, claim justo entre sessões, acesso/credencial revogados, expiração segura, callback `declined`, manutenção monotônica, consumo único e callback tardio em PostgreSQL descartável.
- `POS_TEST_DATABASE_URL=... npm run test:pos:postgres` roda serialmente o conjunto PostgreSQL; a serialização é requisito do harness porque os workers de persistência são globais dentro do tenant compartilhado.

Não execute o teste PostgreSQL contra base com dados úteis: os ledgers possuem guards contra exclusão deliberadamente.
