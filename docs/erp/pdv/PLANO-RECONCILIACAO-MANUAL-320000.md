# Plano 320000 — reconciliação manual de pagamento

Status: **FOUNDATION COMPLETE / FAIL-CLOSED — 320000+320100 validadas localmente; habilitação operacional, rotas, UI e integrações externas ainda bloqueadas**.

O aggregate 310000 foi congelado e aprovado. A wave 320000 entra em migration nova; é proibido reescrever a migration 310000. Produção permanece bloqueada pelos gates deste documento.

## Objetivo e menor recorte honesto

A declaração do operador e a aprovação do checker apenas autorizam consulta: nunca equivalem a dinheiro recebido. O caso só financia venda depois de observação autenticada do provider confirmando referência, valor, moeda e método.

O primeiro release admite um único slot manual, índice `0`, cobrindo o total integral, sem pagamento misto. Inclui caso, maker-checker, cofre, consulta, attempt/outbox/delivery, callback, observation, TTL, reserva, aplicação, finalizador e incidente. Sem cofre e adapter homologado, o feature gate fica desligado e o estado máximo é `unknown`; fake adapter serve somente a testes.

## Aggregate e persistência previstos

A migration `20260829320000_pos_manual_payment_reconciliation` cria, sem alterar migrations históricas:

| Tabela | Responsabilidade mínima |
|---|---|
| `PosManualPaymentCase` | raiz com contexto imutável, estado, versão e TTL |
| `PosManualPaymentVaultBinding` | token opaco do cofre, blind index estável, `keyId`, retenção e vínculo 1:1 |
| `PosManualPaymentStepUpAssertion` | assertion server-side one-shot, ligada a checker/caso/purpose/request hash |
| `PosManualPaymentReview` | decisão maker-checker, grant/alçada e prova de step-up |
| `PosManualPaymentAttempt` | tentativa monotônica de consulta, lease e resultado técnico |
| `PosManualPaymentOutbox` | comando externo idempotente, payload allowlisted e lease |
| `PosManualPaymentDeliveryResult` | resultado append-only de dispatch |
| `PosManualPaymentCallback` | envelope autenticado, digest, nonce/sequência e anti-replay |
| `PosManualPaymentObservation` | fato normalizado append-only do provider |
| `PosManualPaymentIncident` | contradição/atraso/duplicidade, owner/SLA/ack/resolução |
| `PosManualPaymentApplication` | reserva T2a e alvo exato do finalizador |
| `PosManualPaymentOperation` | idempotência contextual e `requestHash` |
| `PosManualPaymentStateEvent` | ledger imutável e marcador completo da transação |

O caso congela filial, caixa, sessão, operador, terminal, draft e revisão/hash, claim, plano, slot, método, provider, conector/revisão, credencial/revisão, moeda, centavos, `referenceHash`, `referenceKeyId`, últimos quatro seguros, ocorrência, justificativa, maker, estado/versão/outcome, TTL e pagamento aplicado.

Constraints: blind index tenant-wide estável e emitido pelo cofre para impedir reuso inclusive após rotação da chave HMAC; `UNIQUE(paymentPlanId, slotIndex)`; binding e aplicação 1:1; `appliedSalePaymentId` único; vínculo bidirecional único com `PosSalePayment.manualPaymentCaseId`; FKs compostas e trigger diferido para igualdade integral. O hash operacional é HMAC-SHA-256 com `keyId` rotacionável, nunca SHA simples, e não substitui sozinho o blind index cross-key. A referência aberta só entra no cofre e jamais em DTO, URL, log, auditoria, erro, outbox ou observation.

## Estados e transições

| Estado | Significado | Financia? | Bloqueia handoff/suspend/close? |
|---|---|---:|---:|
| `review_pending` | maker abriu; checker não decidiu | não | sim |
| `rejected` | checker recusou | não | não |
| `unknown` | consulta inconclusiva/sem prova | não | sim |
| `confirmed_paid` | T1 confirmou exatamente; TTL do banco | elegível uma vez | sim |
| `expired` | TTL venceu antes da reserva | não | não, após liberação auditada |
| `no_funds` | `not_found`, `voided` ou `refunded` | não | não |
| `application_pending` | T2a reservou para alvo exato | somente pelo finalizador | sim |
| `blocked` | contradição, duplicidade ou incidente | não | sim |
| `applied` | T2b consumiu por um pagamento | já consumido | não |

Outcomes externos são separados do estado; operador, checker, owner e admin não podem escrevê-los.

1. `review_pending → rejected|unknown`: checker distinto, acesso explícito ao caixa, alçada viva e assertion de step-up server-side, one-shot, vinculada a checker/caso/purpose/request hash e consumida na mesma transação. Papel sintético de owner/admin não substitui grant.
2. `unknown → unknown|confirmed_paid|no_funds|blocked`: cada resposta/callback autenticado cria observation append-only.
3. **T1:** observation exata faz `unknown → confirmed_paid` e carimba `proofExpiresAt` pelo banco.
4. `confirmed_paid → expired` ao vencer TTL. Antes disso, **T2a** revalida o aggregate completo e faz `confirmed_paid → application_pending`, criando aplicação para draft/plano/slot/revisão exatos.
5. **T2b:** o finalizador, em transação SERIALIZABLE, cria venda e `PosSalePayment(status=manual_confirmed, manualPaymentCaseId=...)`, consome plano/slot/aplicação e faz `application_pending → applied`. Falha reverte integralmente e deixa `application_pending` para replay.
6. Contradição leva a `blocked` e incidente. Fato tardio sempre é persistido; confirmação após expiry/plano encerrado/contexto trocado abre incidente e nunca autoaplica.

`manual_confirmed` nunca significa `captured`: IDs externos e timestamps de autorização/captura ficam nulos. Refund eletrônico exige aggregate compensatório e adapter homologado.

## Locks, API e manutenção

Ordem universal: sessão → terminal → perfil/filial/caixa/acesso → claim → draft → plano/slot → conector → credencial → caso → review/application/observation causal → attempt → outbox → venda/pagamento → valor/estoque. Worker parte da sessão raiz com `FOR UPDATE OF session SKIP LOCKED`, nunca da folha. Leases, callbacks, operations e finalização são idempotentes.

- `POST /api/erp/pdv/manual-payment-cases`: abre caso e tokeniza a referência; DTO mascarado.
- `POST /api/erp/pdv/manual-payment-cases/:id/reviews`: decisão com `expectedVersion`, grant, limite e step-up.
- `GET /api/erp/pdv/manual-payment-cases/:id`: estado/TTL/últimos quatro/resumos, sem segredo.
- `POST /api/internal/erp/pdv/manual-payment-reconciliation/claim|complete`: lease e resultados do worker.
- `POST /api/internal/erp/pdv/manual-payment-reconciliation/maintenance`: leases, consultas, expiry, finalização e incidentes.
- `POST /api/erp/pdv/payment-providers/:provider/manual-reconciliation/callback`: autenticação/key-id, digest, anti-replay e normalização.

Comandos exigem `Idempotency-Key`, `expectedVersion`, request hash, limite de corpo e allowlist. UI separa solicitar/revisar/consultar e não oferece “marcar como pago”. O gate que libera slot/aplicação manual deve ser persistido, falso por padrão e imutável pelo role runtime comum; variável de ambiente ou `settings` mutável isoladamente não autoriza dinheiro.

## Legado e rollout

`PosManualPaymentReference` fica selado como histórico. `consumed`/`revoked` não são promovidos, reabertos ou reescritos; aprovação humana antiga nunca vira `confirmed_paid`. Pendência só pode ser importada quando plano 310000 e contexto integral forem reconstruíveis, sempre como `unknown`; ambiguidade vira incidente não financiável.

Backfill de aplicação deve tokenizar/encriptar antes de limpar texto aberto, reconciliar contagens/digests e ser reiniciável. O enable gate falha com pendência não classificada, referência aberta, órfão ou duplicidade. Flags de criação, consulta e aplicação ficam `false` sem vault/KMS, adapter/credencial/callback homologados, egress allowlist, métricas/alertas e runbook. Rollback desliga novas criações/dispatches sem apagar fatos.

## Matriz mínima de testes e gates

- maker-checker: autoaprovação, grant revogado, alçada, assertion de step-up de outro checker/caso/purpose/hash, expirado/replay e owner/admin sem grant;
- contexto: centavo, moeda, método, provider, revisões de connector/credential/draft, terminal, turno, claim, plano e slot;
- concorrência: mesma referência/caso, T2a/T2b duplos, callback versus expiry e close/handoff versus caso;
- cofre/PCI: HMAC/rotação, repetição da mesma referência antes/depois da rotação, blind index estável, indisponibilidade, rejeição PAN/CVV/trilha/PIN e ausência de segredo em DTO/log/erro/outbox;
- worker: lease/crash antes/depois de dispatch, resposta perdida, cursor, fairness e ausência de chamada externa pela manutenção local;
- outcomes: timeout/unknown/not_found/voided/refunded, confirmação exata, contraditória, tardia e já aplicada;
- ciclo/aplicação: relógio do banco, `expired`, liberação, todos os estados no turno, falhas T2a/T2b, rollback e finalizador idempotente;
- banco/interfaces: SQL direto com role runtime, grants estreitos para binding/callback/observation/ledgers, PostgreSQL limpo, clone representativo, HTTP/browser/acessibilidade e callback/arquivo real em homologação.

Status: **FOUNDATION COMPLETE / NÃO LIBERADO**. Schema, migrations 320000 e 320100, selagem do legado, gate hard-disabled, domínio inicial de abertura/revisão/consulta e isolamento negativo de roles foram implementados e exercitados em PostgreSQL real. A 320100 faz o banco materializar snapshots autoritativos de grants/assertion e avaliar expiração depois dos locks; o teste comportamental prova rejeição quando o grant vence durante contenção. O 310000 continua recusando `proofKind=manual`; callback persistente com prova HMAC transitiva, T1 completo, T2a/T2b, procedures de capacidade restantes, APIs/UI, cutover e homologações externas ainda não existem. Sem vault e adapter real homologado, nenhuma configuração habilita aplicação; simuladores comprovam apenas o contrato local.

A fundação fail-closed de privilégios está detalhada em [Auditoria de roles 320000](./AUDITORIA-ROLES-RECONCILIACAO-MANUAL-320000.md): novos tenants recebem principals e credenciais distintos, enquanto todas as roles permanecem sem acesso direto aos objetos 320000. O gate continua desligado até existirem procedures `SECURITY DEFINER` completas, grants positivos mínimos, cutover dos tenants existentes e adapters externos homologados, mesmo que os testes estruturais do aggregate passem.
