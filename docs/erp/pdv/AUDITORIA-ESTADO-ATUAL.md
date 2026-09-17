# Auditoria completa do PDV

Data-base do estado encontrado: 28/08/2026. Correções e riscos atualizados em 29/08/2026. Escopo: interface, API, Prisma/migrations, estoque, caixa, usuários, relatórios, fiscal, integrações, testes, provisionamento e documentação.

## Veredito

O módulo encontrado era um protótipo de 5–10% de completude. A rota `/erp/pdv` exibia catálogo e carrinho; `POST /api/erp` criava `Sale`/`SaleItem` e baixava estoque. O caixa vivia em outro módulo e era correlacionado por texto e horário. Não havia pagamento transacional, terminal, operador de caixa, idempotência, NFC-e ligada à venda, devolução, periféricos ou modo offline.

A documentação anterior declarava “Implementado e verificado”, uma rota inexistente `/api/erp/pdv`, auditoria, correlação, outbox e testes que não existiam. O rótulo foi invalidado.

## Reauditoria transversal de 29/08/2026

A fundação cresceu, mas o rollout continua bloqueado. A reauditoria de backoffice, operação/UX, códigos, workforce, hardware, segurança financeira e fiscal encontrou os seguintes P0 ainda abertos:

| Domínio | Estado confirmado | Contenção/entrega necessária |
|---|---|---|
| Scanner/UX | FIFO limitada/deduplicada foi implementada; ainda não há browser E2E | validar ACK/NACK físico, draft recuperável, conectividade por comando e Playwright/axe |
| Catálogo/cliente | cortes locais 250/100; PII completa era enviada ao posto | DTO passou a ser mascarado; busca paginada sob demanda/auditoria ainda faltam |
| Pedido por QR | não havia claim atômico nem consumo de reserva/pagamento | emissão/resolução operacional de pedido foi bloqueada até `PosOrderClaim`/conversão transacional |
| Inventário legado | contagem/transferência ignoravam variação/lote/série/bucket | agora falham fechado para SKU rastreado/reservado; fluxo dimensional completo permanece pendente |
| Relatórios | venda cancelada/refundada era somada como receita/item | projeção líquida foi corrigida; fatos imutáveis, impostos, CMV, margem e dimensões faltam |
| Refund eletrônico | gate seguro existia, mas não havia lifecycle compensatório | manter bloqueado; criar agregado próprio, anti-over-refund e commits provider/aplicação separados |
| Caixa/tesouraria | fechamento terminava em `closed`; ledger carecia de ator/terminal/custódia | malote, entrega/aceite, reconciliação/reabertura e ledger append-only por FK |
| Fiscal | não havia origem durável vinculada à venda | snapshot/documento/attempt/outbox/callback/artefato/incidente foram implementados em homologação; adapter/storage/SEFAZ continuam externos |
| Contabilidade | venda/fechamento/conciliação não geram partidas | subledger/outbox de partidas dobradas e períodos |
| LGPD/fraude | retenção/DSAR eram cadastro; case management inexistente | execução idempotente, tokenização/cifra, legal hold e antifraude operacional |
| Hardware | havia contratos/filas, não runtime físico homologado | binário, adapters, comandos assinados, updater e laboratório por modelo/firmware |

Presença de modelo, parser, simulador, UI parcial ou ACK lógico não equivale a capacidade operacional completa.

## Inventário encontrado

| Área | Existia | Não existia |
|---|---|---|
| Catálogo | produto ativo por filial, SKU, preço e saldo | lookup exato por barcode/GTIN/variação, embalagem, PLU, lote e serial |
| Carrinho | adicionar, `+`/`−`, cliente textual, total | remoção clara, quantidade direta, desconto, observação, suspensão, múltiplos carrinhos |
| Venda | transação com item, saldo e ledger | estados, sessão, operador por ID, cliente relacional, idempotência, auditoria e outbox |
| Pagamento | uma string Pix/Dinheiro/Cartão/Boleto | tender, troco, divisão, parcelas, autorização, NSU, Pix dinâmico, refund e conciliação |
| Caixa | abertura, sangria, suprimento e fechamento | registro físico, filial, atribuição, fechamento por meio e segregação |
| Fiscal | cadastro interno de documento/certificado | venda PDV como origem, XML assinado, transmissão, retorno confiável, DANFE e contingência real |
| Funcionário | `pdv.read/write` e `BranchUserAccess.canSell` | alçadas, caixas permitidos, turno, aprovação e step-up |
| Hardware | nenhum | scanner dedicado, câmera, pinpad, POS, impressora, gaveta, balança, display e bridge |
| Resiliência | transação básica | CAS de estoque, idempotência, fila local, sync, replay e recuperação |
| Testes | relatórios/pedidos/integrações adjacentes | qualquer teste de PDV, caixa, concorrência, dispositivo ou fiscal |

## Falhas críticas encontradas

1. Venda gravava `cashRegister: "Caixa principal"` e não exigia sessão aberta.
2. Fechamento somava Pix, cartão e boleto como dinheiro físico.
3. Sessão de caixa não tinha filial, registro físico nem operador por ID.
4. Duas vendas concorrentes podiam perder baixa de estoque por read-then-write.
5. Duplo clique/retry podia duplicar venda e estoque; não havia idempotência.
6. Dinheiro usava `Float` sem fechamento exato em centavos.
7. Venda não criava auditoria, correlação, pagamento, evento de caixa, outbox ou fiscal.
8. `saleNumber` truncava `Date.now()`, sujeito a colisão.
9. A API entregava produto quase inteiro, inclusive custos e metadados desnecessários ao caixa.
10. Tenant novo podia ficar sem `BranchProduct` e perfil operacional, tornando o PDV vazio.
11. Auditoria operacional não exigia `activities.read`.
12. Relatórios podiam somar pedido e `Sale` derivada do mesmo pedido duas vezes.

## Falhas altas e médias

- saldo exibido somava depósitos, mas a venda consumia apenas o depósito padrão;
- produto sem controle de estoque era tratado como físico;
- abertura/evento e auditoria não eram atômicos;
- duas aberturas do mesmo caixa não tinham restrição única parcial;
- timezone do resumo de caixa era o do servidor;
- `canIssueFiscal` não era respeitado pela central fiscal;
- erros comerciais voltavam como HTTP 500;
- payload não limitava número de linhas nem quantidade;
- busca ignorava barcode, GTIN e variações;
- API aceitava forma de pagamento arbitrária;
- item de venda não congelava SKU, GTIN, unidade ou desconto;
- nenhuma jornada de cancelamento, devolução, reimpressão ou falha estava desenhada.

## Correções já incorporadas nesta reconstrução

- rota real e dedicada `/api/erp/pdv`;
- `PosRegister`, atribuição funcionário-caixa, terminal, dispositivos e conectores;
- sessão ligada ao registro e operador, com índice de turno único aberto;
- venda ligada à sessão, cliente e operador, valores em centavos e chave idempotente;
- pagamentos múltiplos com referência externa e troco;
- eventos imutáveis, auditoria e webhook na transação;
- baixa de saldo por comparação dentro de transação serializável;
- venda suspensa, devolução, promoção/cupom, print job e operação offline no schema;
- contagem cega e diferença por meio de pagamento;
- parser EAN/UPC/GTIN, GS1, DataMatrix/QR e Digital Link;
- scanner keyboard-wedge e câmera com fallback;
- projeção mínima do catálogo para o operador;
- correção da permissão de leitura da auditoria;
- seed de `BranchProduct` e caixa principal.
- API/UI administrativa idempotente para caixas, terminais, dispositivos e conectores;
- aprovação com segregação, expiração e consumo único em sangria, cancelamento e devolução;
- motor determinístico de melhor promoção exclusiva com limites e rateio em centavos.
- cotação promocional obrigatória, revalidação/consumo concorrente e CRUD auditado de promoções/cupons sem código aberto persistido;
- lote, série, validade e FEFO com lock/CAS, ledger por item, GS1 combinado e buckets segregados de quarentena;
- pareamento de terminal, token rotativo/revogável, heartbeat/health e fila de impressão com lease e ACK idempotente;
- produtor de comprovante com snapshot server-side, uma via original, reimpressão justificada e auditoria;
- fechamento cego com tolerância configurável, justificativa e aprovação independente para divergência;
- cadastro rápido de cliente no turno, sem permitir crédito ou sobrescrita de cadastro existente.
- aprovação contextual de desconto: linha + venda sob a menor alçada, quote sem consumo e consumo único no commit;
- reversão histórica de promoção/cupom no cancelamento integral ou devolução integral, sem apagar resgate;
- recebimento e administração auditada de lote/série, quarentena, liberação e descarte;
- baixa comum centralizada com CAS agregado e saldo de variação por depósito, rollback integral da venda/pagamento perdedores e replay sem nova baixa;
- BOM de kits versionada/aninhada com snapshot, baixa/restauração dos componentes, FK da versão e ledger de retorno conferido no commit;
- referência manual server-side com conector/allowlist, dupla aprovação e step-up, unicidade tenant-wide, CAS e vínculo de banco entre venda/pagamento/aprovação;
- lifecycle eletrônico provider-agnostic com intent/tentativa/outbox/callback, credencial congelada, entrega idempotente, incidentes bloqueantes e evidência pós-consumo imutável;
- push offline restrito a heartbeat e rascunho/tombstone, com sequência, replay e rejeição explícita de operação financeira/fiscal;
- painel administrativo read-only para turnos, pagamentos/refunds, impressão, terminais, sync, lotes e promoções, sem PII/segredos.
- PWA isolada em `/erp/pdv-offline`, cofre local AES-256-GCM/PBKDF2, credencial curta, pull/ACK e conflito de rascunho revisionado, mantendo venda/pagamento/fiscal bloqueados offline;
- contas de fidelidade, cashback, gift card e crédito-loja com CAS, reserva/captura, ledger imutável, administração e integração atômica à venda/cancelamento/devolução;
- QR interno HMAC registrado e revogável para cliente, carrinho suspenso, cupom, gift card e recibo, sempre vinculado à organização/filial e a turno próprio; pedido está bloqueado sem claim;
- commit fiscal atômico em homologação com snapshot imutável, documento/tentativa/outbox, worker com lease/query, callback HMAC, artefatos e incidente bloqueante;
- relatório líquido do PDV passa a excluir cancelamento/refund integral e abater devolução confirmada por item;
- DTO de cliente no posto passa a mascarar documento/telefone;
- inventário legado passa a falhar fechado para SKU rastreado ou reservado.
- simuladores determinísticos de PSP, fiscal e agente/periférico com relatório que declara explicitamente `NOT_CERTIFIED`/`NOT_PERFORMED`.

## Riscos ainda bloqueadores de produção

- migração precisa ser aplicada e validada em cópia real do banco;
- o comando legado `create_sale` já responde `410`; ainda é preciso confirmar consumidores externos antes de remover toda compatibilidade;
- pagamento Pix/cartão ainda não possui adapter homologado; referência manual não equivale a captura automática;
- NFC-e anterior é um registro interno, não um emissor SEFAZ;
- o serviço do agente está implementado, mas o binário bridge e periféricos físicos ainda não foram homologados;
- cliente PWA offline, cofre local cifrado, credencial curta, sync pull/ACK e conflito revisionado existem para heartbeat/rascunho; E2E browser, merge assistido e catálogo incremental ainda faltam;
- promoção já possui consumo transacional e UI de gestão; fidelidade/vale fazem pós-venda local; devolução repetida usa saldos atuais e troca liga retorno, rascunho e nova venda com unicidade/auditoria; stacking avançado e pós-venda eletrônico/fiscal continuam pendentes;
- migrations foram exercitadas em PostgreSQL 18 temporário limpo e em base sintética pré-POS; ainda falta clone representativo do ambiente;
- testes PostgreSQL cobrem concorrência de turno e passagem, evento, mutação administrativa, promoção/cupom/reversão, aprovação e desconto, lote/série/administração, saldo de variação/depósito na venda, transferência de carrinho, conciliação, impressão, lifecycle do agente, cursor offline, equação monetária, código e origem de venda; RBAC HTTP/E2E ainda falta;
- a rodada final desta data deve ser consultada em `VALIDACAO-2026-08-29.md`; números antigos foram substituídos pela execução sobre as 61 migrations atuais.

## Regra de comunicação

O produto não pode exibir “verificado”, “fiscal emitida”, “Pix recebido” ou “cartão aprovado” por mera seleção do operador. Esses estados só podem vir de evidência persistida e adapter confiável.
