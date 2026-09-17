# Arquitetura e ADRs do PDV

## Visão

```text
PDV web/PWA
  ├─ API POS do banco isolado do tenant
  │    ├─ venda, caixa, estoque, auditoria e outbox (uma transação)
  │    ├─ adapters servidor: Pix, fiscal, mensageria e conciliação
  │    └─ sync idempotente de operações offline
  └─ agente local pareado
       ├─ scanner/serial e balança
       ├─ TEF/pinpad/SmartPOS
       ├─ impressora ESC/POS e gaveta
       └─ display do cliente
```

O banco de controle resolve organização, assinatura, membership e cofre. Dados do PDV permanecem exclusivamente no PostgreSQL da organização, sem `tenant_id`, seguindo a arquitetura multi-database do ERP.

## ADR-001 — agregado canônico de venda

**Decisão:** evoluir `Sale` como agregado de varejo e impedir duplicação de efeitos com `SalesOrder`.

**Motivo:** relatórios e baixa atual já referenciam `Sale`. A substituição imediata por `SalesOrder` elevaria o risco de migração. `Sale` agora recebe sessão, operador, cliente, estados, centavos, pagamentos, eventos, devoluções e origem operacional única. Vendas originadas por pedido ou OS persistem `sourceType/sourceId`; expedição e conclusão reutilizam a mesma origem, e relatórios excluem a cópia do `SalesOrder` quando já existe `Sale` vinculada. Trocas mantêm a devolução original como fato independente e ligam `PosReturn → PosHeldSale → Sale`; a venda de reposição usa origem `pos_exchange/<returnId>`, impedindo dupla conversão concorrente.

**Consequência:** o fluxo legado `create_sale` foi desativado com `410 Gone` depois da migração do consumidor para `/api/erp/pdv`. Novos efeitos só entram pelo serviço POS.

## ADR-002 — dinheiro em centavos inteiros

**Decisão:** novos campos monetários transacionais usam `Int` de centavos; quantidade continua fracionária com precisão validada.

**Motivo:** fecha BRL exatamente, serializa sem ambiguidade e permite checks simples. Colunas `Float` legadas são mantidas temporariamente como projeção compatível e preenchidas junto com centavos.

**Consequência:** máximo por campo é aproximadamente R$ 21,4 milhões com `INTEGER`; operações maiores devem migrar para `BIGINT`. Nunca calcular total persistido com `number` decimal sem conversão/arredondamento explícito.

## ADR-003 — idempotência como parte do comando

**Decisão:** toda mutação financeira/fiscal exige chave global por operação; venda e pagamentos têm índices únicos.

**Contrato:** mesma chave + mesmo hash retorna a resposta existente; mesma chave + payload diferente retorna `409`; a chave vive pelo período de retenção da transação.

**Offline:** unicidade é `(terminalId, operationId)` e sequência monotônica por terminal. O relógio do cliente não define ordenação confiável.

## ADR-004 — concorrência de estoque

**Decisão:** checkout usa transação `Serializable` e um único serviço de estoque para venda, cancelamento e devolução. O serviço aplica CAS primeiro no saldo agregado `(warehouseId, productId)` e, quando a variação controla estoque, também em `(warehouseId, variationId)`; ambos e os ledgers vivem na mesma transação da venda/pagamento.

**Invariantes:** produto sem controle/serviço não exige saldo; reserva não pode ser consumida; outro depósito não supre implicitamente a variação; baixa cria `StockMovement` e `WarehouseLedgerEntry` com snapshots pai/variação; conflito ou insuficiência reverte venda, pagamento, lote e qualquer CAS anterior. Replay da mesma venda retorna a `Sale` existente sem nova baixa; concorrência diferente recebe conflito sem oversell.

## ADR-005 — registro, terminal e dispositivo são entidades distintas

- `PosRegister`: caixa/gaveta lógica da filial, depósito e políticas;
- `PosTerminal`: instalação pareada, identidade, versão, heartbeat e offline;
- `PosDevice`: scanner, pinpad, impressora, gaveta, balança ou display;
- `PosRegisterAccess`: funcionário, ações e alçada;
- `CashRegisterSession`: turno real do operador no registro.

Isso evita correlacionar venda por texto e horário.

## ADR-006 — hardware por agente local

**Decisão:** WebHID/WebSerial/WebUSB são opcionais e feature-detected. O caminho suportado é agente local autenticado com adapters por fabricante/provedor.

**Pareamento:** código de uso único → troca de chaves → certificado/token com hash no servidor → allowlist de origem/dispositivo → heartbeat → rotação/revogação. O navegador nunca recebe segredo fiscal ou de adquirente.

**Comandos:** envelope com `commandId`, `terminalId`, `deviceId`, tipo, payload mínimo, expiração, nonce e assinatura. ACK persistido. Replay é recusado.

## ADR-007 — pagamentos por interface canônica

```ts
interface PosPaymentAdapter {
  createIntent(input): Promise<Intent>;
  status(reference): Promise<Transaction>;
  cancel(reference, idempotencyKey): Promise<Transaction>;
  refund(reference, amountCents, idempotencyKey): Promise<Transaction>;
}
```

Adapters podem operar no servidor (Pix), agente local (TEF) ou terminal pareado (SmartPOS). Estados externos são mapeados para a máquina canônica e só avançam monotonicamente. A fundação persiste intent, tentativa, outbox, entrega, callback e eventos; `unknown` converge por consulta e contradições monetárias viram incidente bloqueante. O intent permanece vinculado à credencial usada mesmo após rotação do conector. Manual POS exige referência contextual, allowlist, aprovação independente com step-up e conciliação, sem fingir captura.

## ADR-008 — fiscal por adapter e filial

O domínio fiscal recebe snapshot imutável da venda. Adapter selecionado por filial/UF/modelo/vigência gera e valida artefatos, transmite, consulta e devolve evidência. A UI não pode escrever `authorized` diretamente. Contingência é comando próprio e fila durável.

## ADR-009 — outbox e projeções (arquitetura-alvo)

Venda, estoque, caixa, auditoria e evento outbox devem nascer na mesma transação. O outbox de pagamentos já é durável, tem lease/retry/resultado de entrega e manutenção; publicação fiscal, financeiro genérico, relatório, marketplace/notificação e DLQ completos ainda são alvo. Projeção pode atrasar; fonte transacional não é reescrita.

## ADR-010 — offline com risco limitado

O cliente mantém banco local cifrado e catálogo versionado. Hoje a allowlist offline aceita apenas heartbeat e rascunho/tombstone: venda, dinheiro, pagamento e fiscal ficam bloqueados. Qualquer autorização futura de dinheiro por política, cartão por adapter certificado ou fiscal por contingência legal exige nova análise de risco, limites e revalidação no sync.

## Modelo implantado pela fundação

| Grupo | Modelos |
|---|---|
| caixa/identidade | `PosRegister`, `PosRegisterAccess`, `PosTerminal`, `PosDevice`, `CashRegisterSession`, `CashRegisterEvent` |
| venda | `Sale`, `SaleItem`, `PosSalePayment`, `PosSaleEvent`, `PosHeldSale`, `PosHeldSaleItem` |
| pagamento | `PosPaymentIntent`, `PosPaymentAttempt`, `PosPaymentOutbox`, `PosPaymentDeliveryResult`, `PosPaymentCallback`, `PosPaymentStateEvent`, `PosPaymentIntegrityIncident`, `PosManualPaymentReference` |
| fechamento | `PosSessionPaymentCount` |
| pós-venda | `PosReturn`, `PosReturnItem` |
| preço/kit | `PosPromotion`, `PosCoupon`, `PosPromotionRedemption`, `PosKitBom`, `PosKitBomComponent`, `PosKitSaleComponent`, `PosKitComponentReturnMovement` |
| integração | `PosConnector`, `PosPrintJob` |
| offline/controle | `PosSyncOperation`, `PosApproval` |
| identificação | `PosProductCode` |

## Contrato da API P0

`GET /api/erp/pdv` retorna somente filial/operador/caixas autorizados, turno próprio, catálogo projetado, clientes mínimos, carrinhos suspensos, vendas recentes e conectores ativos.

`POST /api/erp/pdv` aceita comandos:

- `scan.resolve`;
- `session.open`, `cash.event`, `session.close`;
- `cart.hold`, `cart.discard`;
- `sale.commit`, `sale.cancel`;
- `return.create`.

Rotas de terminal pair/heartbeat/revoke, print ACK, sync limitado, payment intent/retry, referência manual, callback HMAC, worker/outbox e manutenção foram isoladas por risco. Adapter PSP/TEF/SmartPOS nativo, refund compensatório e fiscal issue/status/cancel continuam pendentes.

## Invariantes de banco

- uma sessão aberta/fechando por `register_id` (índice parcial);
- uma venda por `idempotency_key`;
- um pagamento por chave idempotente;
- uma evidência eletrônica Pix/transactionId por tenant e um consumo por intent;
- uma conclusão imutável por claim/entrega e um incidente por callback contraditório;
- um saldo devolvido de componente exatamente igual ao ledger de retornos no commit;
- um código normalizado por escopo;
- um acesso por funcionário/caixa;
- uma contagem por sessão/meio/provider;
- uma operação/seq por terminal;
- valores de pagamento/venda não negativos;
- alçada entre 0 e 10.000 basis points.

## Segurança

- same-origin e sessão para comandos web;
- organização sempre derivada da sessão;
- licença e permissão global antes de escrita;
- filial, caixa, sessão e alçada revalidados no servidor;
- dados de cartão fora do NALVEN;
- segredos referenciados pelo cofre, nunca em `settings` JSON;
- logs estruturados redigidos;
- auditoria com correlação e evento de domínio;
- rate limit persistente por usuário/ação e por terminal, Fetch Metadata, origem e limite de payload; confiança no proxy/IP deve ser configurada no deploy;
- segregação solicitante/aprovador e consumo único implementados para sangria/cancelamento/devolução/fechamento/desconto/referência manual; senha fresca é obrigatória na confirmação manual e MFA/WebAuthn corporativo permanece gate externo.

## Estratégia de compatibilidade

1. aplicar migration e backfill de centavos/códigos;
2. criar caixa principal para filiais existentes;
3. atribuir owners/admins automaticamente no primeiro bootstrap;
4. operar nova UI/API sob feature flag por filial;
5. comparar vendas/estoque/caixa/relatórios em piloto;
6. ~~bloquear `action=create_sale` legado~~ — concluído; clientes antigos recebem `410 Gone`;
7. remover correlação por `cashRegister` textual somente após reconciliação histórica.
