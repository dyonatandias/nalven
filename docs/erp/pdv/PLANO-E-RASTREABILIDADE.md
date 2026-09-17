# Plano de implementação, rastreabilidade e gates

## Método da auditoria

O trabalho foi dividido em ondas paralelas dentro do limite técnico de quatro agentes ativos. Foram usados seis subagentes/revisores ao longo das ondas, cobrindo código/dados, produto/operação, segurança/pagamentos/hardware, UI, documentação/testes, administração e promoções. Eles aplicaram um painel de 28 perspectivas: produto, varejo, caixa, tesouraria, vendas, estoque, catálogo, preço, promoção, fidelidade, devolução, UX teclado, UX touch, acessibilidade, frontend, backend, dados, concorrência, segurança, fraude interna, LGPD, PCI, Pix, TEF/SmartPOS, fiscal, hardware, SRE/offline e QA/homologação. Essas perspectivas não equivalem a 28 agentes literais.

Isso não substitui validação com adquirente, provedor fiscal, contador, operador de loja e modelos físicos escolhidos.

## Legenda

- `DONE`: fluxo inteiro implementado e validado no repositório, sem dependência funcional omitida;
- `PARTIAL`: fundação existe, falta integração/UI/teste/homologação;
- `TODO`: não implementado;
- `EXTERNAL`: exige fornecedor, credencial, contrato ou laboratório.

## Matriz de capacidade

| ID | Capacidade | Prioridade | Estado | Evidência/próximo gate |
|---|---|---:|---|---|
| POS-101 | caixa por filial/depósito | P0 | PARTIAL | modelo, API/UI administrativa idempotente e validação transacional; clone real pendente |
| POS-102 | funcionário por caixa e alçada | P0 | PARTIAL | modelo/API/UI e política isolada recusam papel gerencial como acesso operacional, exigindo grant explícito vigente ou break-glass exato/independente/curto/single-use; integração da política em todas as rotas e E2E com matriz real de papéis pendem |
| POS-103 | turno único e operador | P0 | PARTIAL | posse exclusiva/passagem e boundary HMAC terminal→organização→caixa com liveness foram testados; o browser falha fechado até existir mediação pelo binário do agente, e custódia/ator por FK no ledger legado ainda faltam |
| POS-104 | fechamento por meio/provider | P0 | PARTIAL | contagem cega e tolerância existem; `closed → reconciled/reopened`, malote, aceite da tesouraria e revisão imutável ainda faltam |
| POS-105 | supervisor/step-up e dupla aprovação | P0 | PARTIAL | cancelamento/devolução agora usam snapshot financeiro canônico server-side, hash, lock, alçada viva, aprovador distinto, step-up auditado e consumo exato; MFA/WebAuthn corporativo e E2E de papéis reais ainda pendem |
| POS-106 | custódia de numerário/tesouraria | P0 | PARTIAL | fundação própria já cria ledger append-only, malote/lacre, entrega, aceite por destinatário independente, divergência e resolução maker-checker em PostgreSQL; ainda falta integrar `session.open`, eventos, venda/devolução e `session.close`, fazer backfill/cutover do ledger legado e implementar `closed → reconciled/reopened` com piloto de tesouraria |
| POS-201 | EAN/UPC/GTIN e checksum | P0 | DONE | parser/testes |
| POS-202 | GS1 AIs/DataMatrix/QR/Digital Link | P1 | PARTIAL | parser parcial, QR interno HMAC e classificador fail-closed produto/interno/Pix/fiscal/genérico existem; matriz completa de AIs e homologação física faltam |
| POS-203 | ProductCode/variação/embalagem | P0 | PARTIAL | índice/admin/revalidação existem; normalização destrutiva, fallback legado e ambiguidade entre domínios precisam ser eliminados |
| POS-204 | scanner HID | P0 | PARTIAL | núcleo FIFO/captureId não deduplica por conteúdo, consome frames HID identificados sobre alvos protegidos e falha fechado para wedge genérico sem identidade; integração no workspace, E2E browser com latência e homologação de rajada física permanecem gates |
| POS-205 | câmera | P1 | PARTIAL | `BarcodeDetector` com fallback local `@zxing/browser`, cancelamento e formatos 1D/2D; matriz física de câmera/iluminação falta |
| POS-206 | balança/PLU variável | P1 | PARTIAL | contrato canônico e perfil serial estrito validam gramas/tara/estabilidade/idade/precisão; layouts de fabricante e testes físicos faltam |
| POS-301 | carrinho com quantidade/remoção/notas | P0 | PARTIAL | workspace existe; recuperação segura de draft/intent está em implementação e ainda exige E2E de refresh/falha pós-efeito |
| POS-302 | suspensão/retomada/conversão | P0 | PARTIAL | carrinhos suspensos têm CAS/posse; claim/renew/release/conversão de pedido agora têm locks, marcadores por transação e consumo exato; integração E2E e rollout em clone real permanecem gates |
| POS-303 | preço server-side/snapshot | P0 | DONE | API e centavos |
| POS-304 | desconto/alçada | P0 | DONE | soma linha+venda, aplica a menor alçada, solicita contexto exato, valida na cotação e consome uma vez no commit; promoção fica fora do desconto manual |
| POS-305 | promoção/cupom/lista | P1 | PARTIAL | cotação e revalidação autoritativas, consumo concorrente, CRUD de promoção/cupom e sigilo do código; stacking/listas/regras avançadas faltam |
| POS-306 | claim e conversão de pedido | P0 | DONE | claim/renew/release/convert sob locks canônicos, elegibilidade revalidada, guardas OLD+NEW para filhos/reservas, marcadores por transação e vínculo exato da `Sale.source` |
| POS-401 | cliente relacional e minimização | P0 | PARTIAL | seleção/FK, cadastro rápido, DTO mascarado e busca paginada/cancelável por cursor existem; auditoria de leitura e LGPD executável ainda faltam |
| POS-402 | fidelidade/cashback | P1 | PARTIAL | programa, conta, ledger, gestão, venda/pós-venda, sweep concorrente, timer local e passivo agregado; tiers/campanhas avançadas e observabilidade externa faltam |
| POS-403 | gift card/crédito-loja | P1 | PARTIAL | emissão sigilosa, PIN scrypt, venda/refund local, QR, sweep e passivo; homologação contábil da conciliação e rotação de pepper faltam |
| POS-501 | estoque serializável/CAS | P0 | PARTIAL | venda usa saldo dimensional/CAS; contagem e transferência legadas agora falham fechado para SKU rastreado, mas o fluxo dimensional completo ainda precisa substituir o legado |
| POS-502 | serviço/sem controle | P0 | DONE | bypass de saldo |
| POS-503 | lote/validade/serial/FEFO | P0 | PARTIAL | fundação/ledger/FEFO existem e série exige uma leitura unitária, distinta e exata por unidade sem autoalocação; fluxo físico e matriz de scanners ainda precisam homologação |
| POS-504 | kit/embalagem/peso | P1 | DONE | BOM versionada/aninhada, ciclo e ativação fail-closed, snapshot no hash/commit, baixa/restauração por componente, FK de versão e ledger imutável de retorno; balança física permanece no gate POS-206 |
| POS-601 | dinheiro/troco | P0 | DONE | domínio/API/UI |
| POS-602 | pagamento misto | P0 | DONE | domínio/API/UI |
| POS-603 | reconciliação manual autoritativa | P0 | PARTIAL | fundação 320000+320100, issuer/review 321000, callback/T1 321e, claim SQL 321e.1, abertura one-shot SQL 321f, fundação T2-00 e lifecycle/locks/retrofit T2-01 concluídos localmente e fail-closed: proof transitivo, batch/receipt idempotente, fairness por sessão, anti-replay, assertions one-shot, guards puros, producers históricos e catálogo/ACL congelados. T2-01 está no checksum `4c239c899b6c7e498150ceee3c635c03eb1f432298994be7d12ac04896b5d388`; a v12 do addendum T2-02 fecha ABIs, snapshots, manifesto, matriz byte-exata dos 22 effects e cinco boundary writers. O checksum anterior `7116152ab347c931203f0f77695f8b619bcdd7fdb3943d24a94e714579003ad0` foi invalidado e não há novo freeze antes de retrofit, contratos e cross-review independentes. Faltam concluir T2-02 e implementar T2-03–T2-07, boundary HTTP/raw bytes, binder e vault/KMS reais, reprocessamento geral de órfãos, adapters reais, API/UI, cutover e matriz E2E/laboratório; `apply`, gate e `proofKind=manual` continuam bloqueados operacionalmente |
| POS-604 | Pix dinâmico | P1 | EXTERNAL | escolher PSP, adapter e homologar |
| POS-605 | TEF/pinpad | P1 | EXTERNAL | escolher integrador, agente e laboratório |
| POS-606 | SmartPOS | P1 | EXTERNAL | escolher fabricante/adquirente |
| POS-607 | estado desconhecido/callback/retry | P0 | PARTIAL | intent/attempt/outbox/state ledger, proof autenticada ligada à T1, replay causal global de evento/nonce, idempotência autoritativa e taxonomia separada de resposta/transport foram entregues localmente; o boundary interno agora verifica HMAC sobre bytes crus e deriva o event ID antes da conexão `_mc`. O gate continua desligado até existirem route privada, keyring/KMS e deploy segregado homologados, claim/reprocess completo, adapter PSP/TEF real, mediação pelo agente, laboratório e T2. |
| POS-608 | conciliação/MDR/recebíveis | P1 | PARTIAL | layouts CSV versionados, importação persistente/digerida, linhas/runs/issues imutáveis, job, relatório/export, concorrência e timer local; layouts/semântica PSP reais e alertas externos faltam |
| POS-701 | NFC-e ligada à Sale | P0 | PARTIAL | commit cria snapshot fiscal imutável, documento, tentativa e outbox atomicamente quando há perfil de homologação ativo; adapter real continua bloqueado |
| POS-702 | XML/assinatura/SEFAZ/DANFE | P0 | PARTIAL | perfil/documento/artefato/callback/incidente e retenção existem; geração, assinatura, storage real, DANFE e homologação por UF são externos |
| POS-703 | contingência/retransmissão | P1 | PARTIAL | worker com lease, retry conhecido, `unknown`, query e callback monotônico existe; política legal/adapters/SEFAZ ainda faltam |
| POS-801 | impressão browser/PDF | P0 | PARTIAL | recibo comercial existe; layout 58/80 mm, teste visual, envio consentido e estado de entrega faltam |
| POS-802 | print job/ESC-POS/gaveta | P1 | PARTIAL | produtor, snapshot, fila, claim/lease, retry/ACK, renderer ESC/POS 32/48 colunas, QR/corte e gaveta separada; adapters físicos faltam |
| POS-803 | display cliente | P2 | PARTIAL | DTO público allowlisted com total/troco/QR Pix; adapter e UI física faltam |
| POS-901 | cancelamento com restock/refund | P0 | PARTIAL | dinheiro e contas de valor locais na API/UI, com clawback de recompensa; reversão eletrônica server-side e fiscal faltam |
| POS-902 | devolução parcial | P0 | PARTIAL | repetição por saldo item/centavos, destino, estoque rastreado, dinheiro/saldo local e clawback; eletrônico e fiscal faltam |
| POS-903 | troca | P1 | PARTIAL | retorno→rascunho→nova Sale ligados, estados/concorrência/auditoria/UI; refund eletrônico e fiscal faltam |
| POS-904 | compensação eletrônica própria | P0 | PARTIAL | agregado/attempt/outbox/callback/state/delivery/incidente próprios, produtor transacional, aprovação exata, reserva concorrente, vínculo do refund e dois commits foram modelados/testados em PostgreSQL; worker/callback/finalizador comercial, UI e adapter homologado seguem bloqueados |
| POS-1001 | IDs e idempotência | P0 | PARTIAL | comandos operacionais, administração e pedidos de aprovação protegidos; expandir para toda integração externa |
| POS-1002 | auditoria/correlação/outbox | P0 | PARTIAL | venda, pagamentos e fiscal têm persistência durável; o novo ledger append-only de caixa já possui atores/terminal/aprovação/reversão por FK, mas seus producers ainda não substituíram o legado operacional e faltam bridge, backfill, cutover e reconciliação shadow |
| POS-1003 | offline/sync | P1 | PARTIAL | PWA isolada, cofre AES-GCM/PBKDF2, credencial curta, push/pull/ACK, snapshots versionados e conflito revisionado implementados; E2E browser, merge assistido e catálogo delta faltam |
| POS-1004 | terminal pair/heartbeat/revoke | P1 | PARTIAL | token HMAC contextual, pareamento/rotação/revogação, heartbeat e boundary obrigatório em mutações existem; browser não recebe segredo e permanece bloqueado até o binário agente-mediado, mTLS e prova física |
| POS-1101 | relatórios POS/caixa | P0 | PARTIAL | projeção líquida agora exclui cancelamentos/refunds integrais e abate devolução parcial; fatos contábeis, impostos, CMV, margem e dimensões completas faltam |
| POS-1102 | métricas/alertas/tracing | P0 | PARTIAL | snapshot administrativo existe; filas de pagamento/fiscal, lease/DLQ, reconciliação e incidentes com owner/ack/SLO/tracing faltam |
| POS-1103 | subledger contábil | P0 | PARTIAL | fundação imutável/double-entry, período/competência/filial/centro, policy homologada, reversão exata e export outbox; sem plano/policy seed e sem producers operacionais até homologação do contador |
| POS-1104 | LGPD executável | P0 | PARTIAL | fundação transacional entregue: DSAR com prazo/estados/CAS, política versionada homologada sem seed, inventário pseudonimizado, legal hold, job/outbox bloqueados e evidência append-only; adapters/producers por domínio, IAM/step-up real, jurídico, KMS/storage e execução E2E ainda são gates externos |
| POS-1105 | antifraude/case management | P1 | TODO | regras/sinais por operador/terminal/cliente, velocidade/fracionamento/after-hours, caso, evidência, decisão e maker-checker |
| POS-1201 | WCAG teclado/touch | P0 | PARTIAL | núcleo de modal SSR-safe cobre diálogo nomeado, fundo inerte restaurável, pilha aninhada, trap/retorno de foco, busy e alert/status locais; integração no workspace, alvos 44×44, roving focus, zoom/contraste e E2E axe/browser/touch faltam |
| POS-1202 | rate limit/threat model | P0 | PARTIAL | limite persistente por ator/ação, Fetch Metadata, JSON limitado, testes e modelo de ameaças completo; pentest/DLP/egress de produção faltam |
| POS-1203 | E2E browser/performance | P0 | TODO | Playwright Chromium/WebKit, kiosk/mobile, rede lenta/offline, falha pós-efeito, catálogo 50 mil e leitura em rajada |
| POS-1204 | runtime de hardware | P0 | PARTIAL | contratos/server já cobrem pair/heartbeat/revoke, bearer contextual, health, print claim/ACK, ESC/POS/gaveta, balança/display e envelope assinado; faltam binário distribuível, mTLS/device key, transporte genérico persistido, drivers/adapters reais, updater/SBOM/rollback e matriz física TEF/SmartPOS/scanner/impressora/balança/display |

## Fases executáveis

### Fase 0 — impedir dano e tornar o estado honesto

- [x] retirar alegação de PDV verificado;
- [x] criar PRD/auditoria/ADRs;
- [x] dinheiro em centavos no novo fluxo;
- [x] caixa, sessão, operador, pagamentos e idempotência;
- [x] CAS/serializable, auditoria e outbox;
- [x] corrigir permissão da auditoria;
- [x] aplicar migrations+seed em PostgreSQL 18 limpo e migration POS sobre base sintética pré-POS com reconciliação;
- [ ] repetir migration em clone representativo do ambiente e executar reconciliação pré/pós;
- [x] bloquear o comando legado `create_sale` com `410 Gone` e remover a tela morta que o consumia;
- [x] impedir nova dupla contagem `Sale`/`SalesOrder` por origem operacional única;
- [ ] reconciliar possíveis duplicidades históricas no clone antes do rollout.

### Fase 1 — núcleo operacional seguro

- [x] abertura, sangria/suprimento, venda, fechamento por meio;
- [ ] scanner HID/câmera sob rajada física e carrinho recuperável após refresh; núcleo HID identificado, FIFO/captureId, série exata e classificação de QR já têm testes locais, mas o adaptador do workspace e a homologação física faltam;
- [x] cliente, desconto dentro da alçada, misto, troco, suspensão e transferência de carrinho/turno entre operadores autorizados;
- [x] cancelamento/devolução no serviço;
- [x] UI administrativa de acessos por caixa;
- [x] API/UI administrativa de caixas, terminais, dispositivos e conectores;
- [x] UI de cancelamento e primeira devolução em dinheiro;
- [x] UI e fluxo base de aprovação com solicitante/aprovador distintos e consumo único;
- [x] aprovação independente de divergência no fechamento;
- [x] aprovação contextual de desconto com consumo único no commit;
- [x] contas de valor na venda online: pontos/cashback/crédito-loja/gift card, reserva/captura, acúmulo e pós-venda local;
- [x] QR interno assinado, registrado, revogável e restrito a organização/filial/turno; claim e conversão de pedido são atômicos e revalidam filhos/reservas na mesma transação;
- [x] repetição de devolução e troca vinculada local;
- [ ] pós-venda eletrônico/fiscal; a reserva compensatória e os invariantes existem, mas dispatch/callback/aplicação comercial e adapters seguem bloqueados;
- [x] testes PostgreSQL de migration, checks, unicidade/idempotência concorrente e código ambíguo;
- [x] testes PostgreSQL concorrentes de estoque rastreado e consumo de aprovação de desconto;
- [x] teste PostgreSQL da corrida completa da baixa da venda por saldo de variação/depósito, incluindo rollback do perdedor;
- [ ] testes E2E HTTP/browser com a matriz real de permissões;
- [x] rate limit persistente, Fetch Metadata, origem e payload limitado com testes negativos;
- [x] painel read-only de observabilidade, resumo de turnos e runbook;
- [x] threat model completo no escopo do repositório;
- [ ] métricas históricas, alertas/tracing e testes ofensivos externos.

### Fase 2 — pagamentos Brasil e periféricos

- [ ] selecionar PSP Pix e adapter inicial TEF/SmartPOS;
- [x] implementar intent/attempt/outbox/status/callback/retry provider-agnostic e incidentes de integridade;
- [ ] implementar adapters nativos/homologados para captura, cancelamento e refund compensatório;
- [x] endpoints de pareamento, rotação/revogação, heartbeat/health e fila/ACK do agente;
- [ ] binário do agente local e adapters físicos;
- [ ] impressora/gaveta/balança/display;
- [x] renderização/validação local ESC/POS, gaveta, balança e DTO do display;
- [x] boundary tipado e validado para adapters de pagamento, fiscal e agente local;
- [x] simuladores determinísticos e suíte de conformidade local dos boundaries;
- [ ] laboratório físico e homologação de provedores;
- [x] importação/confronto persistente de conciliação, MDR e chargeback, com layout configurável, job, histórico e exportação;
- [x] ligar as manutenções persistentes ao scheduler local e ao segredo do deploy.
- [ ] homologar layouts reais por NSU/txid/taxa/parcela/provider e alertar atraso/backlog fora do host.

### Fase 3 — fiscal

- [ ] selecionar provider/estratégia e UFs do rollout;
- [x] Sale → snapshot fiscal imutável → documento/tentativa/outbox atômicos em homologação;
- [x] worker interno, lease, retry conhecido, resultado desconhecido, query e callback HMAC anti-replay;
- [x] artefatos por metadata/hash, estados append-only e incidente bloqueante por contradição;
- [ ] XML, assinatura, transmissão, consulta, DANFE e object storage reais;
- [ ] política legal de contingência, cancelamento/inutilização operacionais e monitor completo;
- [ ] homologação por UF/provider e revisão contábil.

### Fase 4 — offline, preço avançado e fidelidade

- [x] push server-side limitado a heartbeat e rascunho/tombstone, com credencial revalidada, sequência e replay;
- [x] PWA, storage cifrado, credencial curta do modo offline e sync pull/ACK limitado;
- [x] conflito revisionado e revogação de credencial/terminal;
- [ ] política de risco para qualquer futura autorização financeira offline;
- [x] motor de melhor oferta exclusiva, período, escopo, limites, cupom e rateio em centavos;
- [x] integrar promoção/cupom à transação da venda e construir API/UI de gestão;
- [x] loyalty ledger, cashback, gift card e crédito-loja integrados à venda online e ao pós-venda local;
- [x] worker invocável de expiração/liberação e relatório agregado de passivo;
- [ ] tiers/campanhas avançadas e agendamento no ambiente de deploy;
- [x] lote/serial/validade/FEFO na venda e no pós-venda;
- [x] kits/BOM versionada, expansão, snapshot e pós-venda por componente;
- [ ] homologação física de balança.

### Fase 5 — escala e rollout

- [ ] relatórios e alertas completos;
- [ ] carga/chaos/restore e pentest;
- [ ] piloto em uma filial com feature flag;
- [ ] fechamento sem divergência por período acordado;
- [ ] treinamento por papel e suporte;
- [ ] rollout gradual e remoção do legado.

## Testes obrigatórios

| Tipo | Casos mínimos |
|---|---|
| unidade | GTIN/checksum, GS1 AIs, centavos, preço, desconto, tender, estados |
| banco | migration, checks/FKs, sessão única, idempotência e concorrência de saldo |
| API | autorização negativa, payload/limites, replay, caixa fechado, estoque mudado |
| contrato | simulador Pix, TEF/POS, fiscal, agente e periféricos |
| E2E | abrir → ler → cliente/desconto → pagar → recibo → fechar |
| pós-venda | cancelamento, refund parcial, restock/quarentena e repetição |
| chaos | timeout após captura, webhook duplicado/fora de ordem, queda no commit, fila parada |
| segurança | SoD, step-up, replay, CSRF, SSRF, secrets/log redaction |
| acessibilidade | teclado, leitor de tela, foco, zoom, contraste e touch |
| recuperação | restore DB, outbox/DLQ, terminal offline, reboot do agente |

## Gates de produção

1. Migration aplicada/restaurada com backup e contagens reconciliadas.
2. Nenhum consumidor usa `create_sale` legado.
3. Testes concorrentes/idempotentes e RBAC negativo aprovados.
4. Pagamento escolhido homologado, sem dados PCI proibidos.
5. Fiscal homologado nas UFs/filiais ativadas.
6. Hardware testado na matriz real de modelos/firmwares.
7. Alertas, DLQ, dashboard e runbook exercitados.
8. Piloto completa ciclos de venda, refund e fechamento sem divergência inexplicada.
9. Segurança/LGPD e retenção revisadas.
10. Feature flag, rollback operacional e suporte de plantão confirmados.

Enquanto qualquer gate aplicável estiver aberto, o status é “em implantação”, não “completo/verificado”.
