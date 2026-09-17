# Evidências de validação — 29/08/2026

> Snapshot histórico. O estado corrente está em `PLANO-E-RASTREABILIDADE.md`;
> waves posteriores já entregaram fundações de tesouraria/custódia, subledger e
> LGPD que ainda aparecem como ausentes neste registro datado.

Este registro separa a verificação automatizada concluída das homologações que ainda exigem infraestrutura, credenciais e equipamentos reais. Ele não é um aceite de produção.

## Resultado automatizado

Executado no workspace com Node.js 24.19.0:

| Verificação | Resultado |
|---|---|
| `prisma validate` — tenant, dentro dos contratos | aprovado |
| `prisma generate` — controle e tenant | aprovado |
| `npx tsc --noEmit` | aprovado |
| `npm run pdv:readiness` | aprovado como verificação; 56 capacidades válidas: 8 `DONE`, 41 `PARTIAL`, 4 `TODO` e 3 `EXTERNAL`; `productionReady: false` e 47 bloqueadores P0/P1 explicitados |
| `npm run pdv:readiness -- --require-production-ready` | bloqueio aprovado; encerrou com código `2`, como esperado enquanto `productionReady` for falso |
| `npm run test:unit` | 366/366 testes aprovados; 224 de domínio PDV e 114 contratos PDV |
| `npm run test:pos:postgres` | 35/35 testes aprovados, sem skips, em PostgreSQL 18.6 temporário limpo |
| `npm run test:pos:conformance` | 11/11 cenários locais; relatório `LOCAL_TESTS_PASSED`, `NOT_CERTIFIED`, `NOT_PERFORMED` |
| `npm run lint` | aprovado |
| `npm run build` | aprovado; build de produção processou 112 entradas e incluiu producer/worker/callback fiscal, intents/callbacks de pagamento, referência manual, kits e observabilidade de integridade |
| `npm audit --omit=dev` | 3 `high`, todos na cadeia CLI `prisma → @prisma/config → deepmerge-ts`; `audit fix` propõe downgrade major para Prisma 6.12 e não foi aplicado |

A validação PostgreSQL final foi feita no banco descartável `nalven_pdv_audit_wave8_final` em cluster temporário: 61 migrations aplicadas do zero, seed tenant executado, `prisma migrate status` confirmou o schema atualizado e a suíte concorrente terminou em 35/35, sem skips. A rodada confirmou também claim/entrega idempotente, `unknown → captured`, callback suplementar pós-consumo, incidente monetário bloqueante, produtor fiscal atômico, retry/lease/query fiscal, callback fiscal monotônico, divergência de snapshot conduzida duravelmente a revisão manual, consumo manual vinculado a venda/aprovação, histórico financeiro não destrutivo, BOM com FK de versão e saldo devolvido de kit igual ao ledger no commit.

O fluxo legado `action=create_sale` continua fora do frontend e responde `410 Gone` no endpoint genérico. A única escrita de venda pelo posto do operador é o serviço `/api/erp/pdv`.

## Cobertura obtida

- parser de EAN/GTIN, GS1 com FNC1, GS1 Digital Link e códigos ponderados;
- fila HID FIFO limitada a 32, com dedupe por captura, overflow explícito e teste de 20 leituras em ordem sem concorrência interna;
- cadastro de códigos/embalagens/PLU e regras variáveis por filial, com admin/CAS/UI e revalidação de todas as leituras na venda;
- cálculo monetário em centavos, rateio, pagamento misto, troco, limites e transições;
- referência manual **legada** com conector/allowlist, unicidade tenant-wide, step-up, CAS e constraint diferida; isso não valida o aggregate autoritativo 320000, que permanece `IN PROGRESS` e bloqueado sem vault/adapter;
- persistência eletrônica com intent/attempt/outbox/callback/state/delivery ledgers, credencial congelada/rotação com graça, replay e incidente bloqueante;
- caixa/turno único, contagem cega por meio, tolerância e aprovação independente de divergência;
- pausa/retomada e passagem de turno com aceite autenticado do destino, TTL, CAS e migração atômica dos carrinhos suspensos;
- transferência avulsa de carrinho suspenso com RBAC, revisão esperada, idempotência contextual e ledger imutável;
- desconto manual de linha + pedido, menor alçada aplicável, aprovação contextual e consumo único; promoção não é tratada como desconto manual;
- promoção/cupom com quote e commit autoritativos, limites concorrentes, administração e reversão histórica;
- recebimento e administração de lote/série/validade, FEFO, buckets de quarentena, descarte e ledger;
- kits/BOM versionada e aninhada, snapshot no quote/commit, baixa/restauração por componente, FK composta e ledger imutável de retorno;
- pareamento, rotação/revogação, heartbeat/health, fila de impressão, lease, retry e ACK idempotente;
- produtor de comprovante com snapshot server-side, via original única e reimpressão auditável;
- renderer ESC/POS determinístico de 32/48 colunas com QR/corte, pulso de gaveta separado, contrato de balança e allowlist do display;
- layouts CSV de conciliação versionados por filial/provider, importação persistente por digest, linhas/runs/issues imutáveis, reprocessamento concorrente, job paginado e relatório/exportação segura;
- push offline limitado a heartbeat e rascunho/tombstone, com sequência, replay, cursor e rejeição explícita de venda/pagamento/fiscal;
- PWA de rascunho com service worker restrito, cofre AES-256-GCM/PBKDF2, credencial curta, pull/ACK monotônico e conflito revisionado;
- QR interno HMAC registrado/revogável para cliente, carrinho, cupom, gift card e recibo, com organização/filial/turno e segredo de exibição única;
- conversão de pedido por QR bloqueada no servidor e removida do posto até existir claim atômico;
- fidelidade, cashback, gift card e crédito-loja com reserva/captura na venda, PIN scrypt, hash protegido, acúmulo e clawback proporcional no pós-venda;
- sweep de reservas/contas vencidas com advisory lock, retry e ledger/auditoria idempotentes, mais relatório agregado de passivo sem PII;
- devoluções repetidas sem deriva de centavos e troca vinculada retorno→rascunho→nova venda, com estados, unicidade e concorrência PostgreSQL;
- relatório líquido exclui vendas canceladas/refundadas, devolução integral e abate devolução parcial por quantidade/centavos;
- DTO do cliente no posto mascara documento/telefone e não devolve esses campos abertos após cadastro rápido/QR;
- inventário legado falha antes da primeira escrita para variação, lote, série, validade, bucket ou reserva;
- fiscal vinculado à venda em homologação com perfil/snapshot/documento/attempt/outbox/callback/state/artifact/delivery/incident, HMAC, anti-replay e manutenção sem redispatch cego;
- painel read-only de saúde operacional, limites de consulta, DTO sem PII/segredos e resumo agregado de turnos;
- administração idempotente de caixas, terminais, dispositivos, conectores, funcionários e clientes rápidos;
- rate limit persistente por ator/ação, Fetch Metadata, origem, limite de bytes e contratos negativos;
- boundary mediado de adapters com timeout/AbortSignal, evidências PSP/fiscais, HMAC, digest, sequência, nonce, allowlist PCI e ACK;
- saldo autoritativo de produto/variação por depósito compartilhado por venda, cancelamento, devolução e administração, com CAS e rollback transacional;
- concorrência PostgreSQL para turno/passagem, evento financeiro, administração, aprovação/consumo, cupom/promoção, estoque rastreado e venda sem oversell, transferência de carrinho, conciliação, impressão, lifecycle do agente/contas de valor, troca e cursor offline;
- validação estática de schema, migrations, tipos, lint e build Next.js;
- parser e gate executável da matriz de prontidão, incluindo rejeição de IDs duplicados e estados inválidos.

## Ainda não validado

- aplicação e rollback em clone PostgreSQL representativo, com reconciliação dos dados históricos antes/depois;
- E2E HTTP/browser da venda e falhas injetadas depois de efeitos externos;
- recuperação de draft/intent após refresh, catálogo/cliente paginados e cold-start offline operacional;
- adquirente/TEF/SmartPOS, Pix PSP, estorno compensatório, UI eletrônica, scheduler da conciliação e layouts/semântica com credenciais e arquivos reais de homologação;
- NFC-e/SAT/MFE e contingência com certificado e ambiente fiscal aplicável à UF;
- XML/assinatura/DANFE/object storage/retention comprovados e adapters fiscais reais; a persistência local não substitui homologação SEFAZ;
- binário do agente e adapters para pinpad, impressora, gaveta, balança, scanner serial e display nos modelos escolhidos;
- E2E browser da PWA, merge assistido, catálogo delta e qualquer autorização financeira/fiscal offline;
- tiers/campanhas avançadas, agendamento real do lifecycle, rotação de pepper e pós-venda eletrônico/fiscal;
- jornadas E2E de acessibilidade e operação física; a conciliação persistente foi validada em PostgreSQL, mas não contra um PSP real;
- métricas históricas, alertas, tracing distribuído, carga, segurança ofensiva, recuperação de desastre e piloto de loja.
- claim/conversão de pedido, compensação eletrônica própria, tesouraria/custódia, subledger contábil, LGPD executável e antifraude/case management.
- reconciliação manual 320000: migration/schema, cofre/KMS, adapter real, maker-checker dedicado, T1/T2a/T2b, worker/callback/observation/incidente, migração selada do legado e matriz concorrente/E2E.
- resolução do advisory `GHSA-ggr8-5vv4-36mx` na cadeia do CLI Prisma sem downgrade incompatível; o risco deve permanecer monitorado e o CLI não deve receber grafos/configuração não confiáveis.

## Gate

O rollout continua bloqueado. Antes do piloto, é obrigatório repetir a migration em clone representativo, corrigir qualquer divergência histórica, selecionar e homologar provedores/equipamentos, completar as jornadas E2E do cliente offline e satisfazer os gates P0/P1 aplicáveis da matriz de rastreabilidade.
