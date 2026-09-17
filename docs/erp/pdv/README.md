# Programa PDV NALVEN

Este diretório é a fonte de verdade da reconstrução do ponto de venda. O estado anterior era um carrinho de caminho feliz ligado a uma venda e uma baixa de estoque; não era um PDV apto a produção.

## Documentos

- [Auditoria do estado encontrado](./AUDITORIA-ESTADO-ATUAL.md)
- [Auditoria consolidada de pendências — 01/09/2026](./AUDITORIA-PENDENCIAS-2026-09-01.md)
- [PRD completo](./PRD-PDV-COMPLETO.md)
- [Arquitetura e decisões](./ARQUITETURA-E-ADRS.md)
- [Modelo de ameaças](./MODELO-DE-AMEACAS.md)
- [Hardware, pagamentos e fiscal](./INTEGRACOES-HARDWARE-PAGAMENTOS-FISCAL.md)
- [Conformidade local dos adapters](./CONFORMIDADE-LOCAL-ADAPTERS.md)
- [Contratos locais de periféricos](./PERIFERICOS-LOCAIS.md)
- [QR internos assinados](./QR-INTERNOS-ASSINADOS.md)
- [Fidelidade, gift card e crédito-loja](./FIDELIDADE-GIFT-CARD-CREDITO-LOJA.md)
- [Conciliação de adquirente](./CONCILIACAO-ADQUIRENTE.md)
- [Segregação da role do banco e attestation](./SEGREGACAO-ROLE-BANCO-E-ATTESTATION.md)
- [Acesso operacional explícito e break-glass](./ACESSO-OPERACIONAL-E-BREAK-GLASS.md)
- [Plano de reconciliação manual 320000](./PLANO-RECONCILIACAO-MANUAL-320000.md)
- [Auditoria de roles da reconciliação manual 320000](./AUDITORIA-ROLES-RECONCILIACAO-MANUAL-320000.md)
- [Plano de habilitação segura 321000](./PLANO-HABILITACAO-RECONCILIACAO-MANUAL-321000.md)
- [Plano T2a/T2b 321b–321d](./PLANO-T2A-T2B-RECONCILIACAO-MANUAL-321B-321D.md)
- [Especificação executável T2-00–T2-07](./ESPECIFICACAO-EXECUTAVEL-T2A-T2B-RECONCILIACAO-MANUAL.md)
- [Decisões executáveis T2-01](./DECISOES-EXECUTAVEIS-T2-01.md)
- [Decisões executáveis T2-02](./DECISOES-EXECUTAVEIS-T2-02.md)
- [Validação local da fundação inerte T2-00](./VALIDACAO-T2-00-2026-08-31.md)
- [Validação local de lifecycle, locks e retrofit T2-01](./VALIDACAO-T2-01-2026-08-31.md)
- [Plano callback/T1 321e](./PLANO-CALLBACK-T1-RECONCILIACAO-MANUAL-321E.md)
- [Boundary interno HMAC → SQL 321e](./BOUNDARY-CALLBACK-HMAC-321E.md)
- [Plano open/vault 321f](./PLANO-OPEN-VAULT-RECONCILIACAO-MANUAL-321F.md)
- [Especificação executável open/vault 321f](./ESPECIFICACAO-OPEN-VAULT-321F.md)
- [Plano de execução W330–W336: caixa, fraude, E2E e hardware](./PLANO-EXECUCAO-W330-W336-CAIXA-FRAUDE-E2E-HARDWARE.md)

> Wave 320000/321000/321e/321e.1/321f/T2-00/T2-01/T2-02: **IN PROGRESS / HARD-OFF**. Fundação, issuer/review, callback/T1, claim SQL `_mw`, abertura one-shot SQL do vault 321f, fundação T2-00 e lifecycle/locks/retrofit T2-01 foram implementados e validados localmente. T2-01 está congelada no checksum `4c239c899b6c7e498150ceee3c635c03eb1f432298994be7d12ac04896b5d388`; a v12 do addendum T2-02 invalidou formalmente o checksum anterior `7116152ab347c931203f0f77695f8b619bcdd7fdb3943d24a94e714579003ad0` para fechar cinco boundary writers e permanece sem novo freeze até retrofit, contratos e cross-review independentes terminarem. `apply`, gate e `proofKind=manual` continuam bloqueados. Faltam concluir T2-02 e implementar T2-03–T2-07, boundary HTTP/raw bytes, binder e vault/KMS reais, reprocessamento geral de órfãos, APIs/UI e adapters homologados.
- [Plano, matriz e gates](./PLANO-E-RASTREABILIDADE.md)
- [Runbook operacional](./RUNBOOK-OPERACAO.md)
- [Runbook de sincronização offline](./RUNBOOK-SYNC-OFFLINE.md)
- [Runbook do ciclo de contas de valor](./RUNBOOK-CICLO-CONTAS-DE-VALOR.md)
- [Runbook de pausa e passagem de turno](./RUNBOOK-CICLO-DO-TURNO.md)
- [Transferência segura de carrinho suspenso](./RUNBOOK-TRANSFERENCIA-CARRINHO.md)
- [Runbook de conciliação de adquirentes](./RUNBOOK-CONCILIACAO-ADQUIRENTES.md)
- [Runbook de persistência de pagamentos eletrônicos](./RUNBOOK-PERSISTENCIA-PAGAMENTOS.md)
- [Runbook de compensações eletrônicas](./RUNBOOK-COMPENSACOES-PAGAMENTOS.md)
- [Boundary de identidade do terminal](./TERMINAL-IDENTITY-BOUNDARY.md)
- [Runbook de persistência e recuperação fiscal](./RUNBOOK-PERSISTENCIA-FISCAL.md)
- [Runbook de referência manual de pagamento](./RUNBOOK-REFERENCIA-MANUAL-PAGAMENTO.md)
- [Runbook de step-up do supervisor](./RUNBOOK-STEP-UP-SUPERVISOR.md)
- [Runbook de kits e composições](./RUNBOOK-KITS-E-COMPOSICOES.md)
- [Evidências de validação atuais](./VALIDACAO-2026-08-29.md)
- [Backlog P0–P2 e dependências](./BACKLOG-P0-P2-E-DEPENDENCIAS.md)
- [Evidências anteriores — 28/08/2026](./VALIDACAO-2026-08-28.md)

## Gate automatizado de prontidão

`npm run pdv:readiness` lê a matriz de rastreabilidade, valida IDs/estados e publica um relatório JSON com todos os bloqueadores P0/P1. Para um gate de rollout que falha enquanto houver bloqueadores, execute `npm run pdv:readiness -- --require-production-ready`; o código de saída é `2` quando `productionReady` é falso. O relatório é deliberadamente conservador: `PARTIAL`, `TODO` e `EXTERNAL` bloqueiam produção. A auditoria atual mantém 56 capacidades: 8 `DONE`, 43 `PARTIAL`, 2 `TODO` e 3 `EXTERNAL`, com `productionReady: false`.

## Estado resumido em 29/08/2026

| Camada | Estado | Evidência |
|---|---|---|
| Auditoria e PRD | Concluídos para baseline | Documentos deste diretório |
| Domínio de leitura e dinheiro | Implementado | `lib/erp/pos-domain.ts`, `tests/pos-domain.test.ts` |
| Fundação de dados | 75 migrations aplicadas do zero em PostgreSQL 18 limpo/sintético; T2-00 tem preflight, catálogo, ACL e tamper tests dedicados | clone representativo e rollout continuam pendentes |
| API de PDV | Fundação P0 avançada | comandos críticos idempotentes/limitados, RBAC adversarial, promoções, lote/série, desconto excepcional, impressão e push offline limitado; providers eletrônico/fiscal e E2E físico faltam |
| Posto do operador | Fundação P0 parcial | venda, caixa, acessos, configuração, aprovação contextual, QR interno, saldos/pontos/gift card, saúde e pós-venda local existem; eletrônico externo e homologação física faltam |
| Caixa por operador e meio | Implementado no serviço local | sessão, pausa/retomada, passagem com aceite do destino, migração atômica dos carrinhos, alçadas, movimentos, contagem cega por tender, tolerância e aprovação independente |
| Scanner HID e câmera | Fundação parcial integrada | workspace usa FIFO/captureId redigido; HID global exige prefixo F9 e só consome teclas após identificar o frame; câmera/manual permanecem separados; E2E sob latência, configuração do leitor, ACK/NACK físico e laboratório são gates |
| Pagamento eletrônico | persistência/outbox/callback e fundação compensatória implementadas; conectores reais pendentes | intent vinculado à credencial; void/refund têm agregado/reserva/invariantes e dois commits, mas worker/finalizador/UI seguem desligados e nenhum PSP é simulado |
| NFC-e real | Persistência/worker/callback de homologação implementados; provedor/homologação pendentes | venda enfileira snapshot fiscal imutável; simulador não gera XML assinado nem transmite à SEFAZ |
| Agente local/periféricos | Serviço, fila e renderizadores locais implementados | token rotativo/revogável, heartbeat, claim/lease/ACK, ESC/POS, gaveta separada, balança canônica e display allowlisted; binário/adapters/laboratório pendentes |
| Offline | PWA de rascunho limitado implementada | shell instalável, cofre AES-GCM/PBKDF2, credencial curta, heartbeat/rascunho/tombstone, push/pull/ACK e conflito revisionado; venda/pagamento/fiscal permanecem deliberadamente online |
| Promoções, valores, kits e estoque | fluxo local integrado | códigos/PLU, kits/BOM versionada e snapshots, cotação/consumo/reversão/admin, lifecycle/passivo, valores locais, lote/série/FEFO e CAS por depósito; contagem física do backfill, regras avançadas e refund externo pendentes |
| Conciliação de adquirentes | persistência operacional implementada | layout CSV versionado, importação idempotente, linhas/runs/issues imutáveis, job, relatório/exportação e timer local; homologação de layouts PSP reais e alertas externos pendentes |
| Devolução e troca local | fluxo online integrado | repetição por saldo de item/centavos, destino e rastreabilidade preservados; troca vincula retorno→rascunho→nova venda; refund eletrônico externo continua bloqueado sem adapter |
| Observabilidade local | Snapshot administrativo implementado | turnos, pagamentos/refunds, impressão, terminais, sync, lotes e promoções; métricas históricas, alertas e tracing faltam |
| Produção | **Não liberado** | exige todos os gates P0/P1 aplicáveis, homologações e piloto |

Nenhuma coluna “planejada” significa homologada. Integrações presenciais só mudam para prontas após testes no modelo de equipamento e no ambiente do provedor escolhido.
