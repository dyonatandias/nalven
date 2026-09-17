# Decisões executáveis T2-02 v12 — reserve, reservas, release e boundary writers

Status: **CONTRATO NORMATIVO / IMPLEMENTAÇÃO BLOQUEADA**  
Escopo: T2-02 da especificação executável T2a/T2b  
Data de corte: 31/08/2026  
Dependência terminal: T2-01 precisa estar `SAFE`, com checksum e evidências fresh/focadas publicados, antes de existir migration T2-02.

Esta v12 substitui e invalida formalmente o freeze anterior de SHA-256
`7116152ab347c931203f0f77695f8b619bcdd7fdb3943d24a94e714579003ad0`.
Novo checksum só pode ser publicado depois do retrofit runtime, contratos
focados e cross-review independente; enquanto isso o documento está aberto.

Este addendum fecha as decisões P0-A..J e P1 que a especificação congelada
deixou para a implementação. Ele não altera a especificação, não habilita o
gate, não autoriza `apply` e não permite antecipar T2-03..T2-06. Em conflito,
a especificação congelada prevalece; uma migration não pode preencher lacuna
por conveniência: precisa obedecer literalmente a este contrato ou parar.

## 1. Gate de entrada e invariantes de onda

T2-02 só pode começar depois de todos estes fatos serem verdadeiros:

1. a migration T2-01 está imutável e classificada `SAFE`;
2. fresh migration, contrato estático, PostgreSQL focado, ACL/catálogo e
   concorrência T2-01 estão verdes;
3. o checksum T2-01 aceito está publicado em evidência mutable;
4. não existe application T2, profile ativa, gate habilitado ou grant
   `reserve/status/sweep` residual;
5. a role de runtime continua sem DML nas tabelas T2.

Enquanto qualquer item falhar, é proibido criar a migration T2-02, editar a
T2-00/T2-01 ou conceder assinatura nova. A implementação T2-02 termina ainda
em **HARD-OFF**: profile ativa não liga gate; somente o harness efêmero do §11
exercita a jornada.

T2-02 cria apenas T2a, status/probe, reservas, release e sweep. Não cria
sale/payment, não consome plan/draft/promoção/estoque, não cria effects e não
instala claim/apply/report. Linhas de manifesto são intenção congelada para as
ondas posteriores, nunca evidência de efeito já ocorrido.

## 2. Primitivas byte-exatas

### 2.1 Tipos escalares

- `Hash64`: ASCII lowercase `^[0-9a-f]{64}$`.
- `IdempotencyKey`: exatamente `^[0-9a-f]{64}$` ou
  `^[A-Za-z0-9_-]{43}$`; sem padding.
- `Subject`: UTF-8 NFC, 1..128 bytes, sem caractere de controle.
- `Code`: UTF-8 NFC, 1..128 bytes, sem controle, enum fechado quando indicado.
- `OpaqueId`: string UTF-8 NFC, 1..256 bytes, sem controle. UUID é lowercase na
  forma `8-4-4-4-12`; bigint é decimal sem sinal e sem zero à esquerda, salvo
  o valor `0`.
- `Instant`: UTC, exatamente `YYYY-MM-DDTHH:mm:ss.ffffffZ`.
- `Date`: exatamente `YYYY-MM-DD`.
- `MoneyCents`: integer entre `0` e `2147483647`, inclusive, porque todas as
  colunas comerciais alvo são PostgreSQL `integer`. Somas intermediárias usam
  `bigint`, mas cada subtotal, desconto, acréscimo, total, tendered e change é
  revalidado como `MoneyCents` antes do snapshot.
- `LedgerCents`: integer entre `0` e `9007199254740991`; somente totais
  agregados de ledger/journal usam este tipo. Campos comerciais continuam
  `MoneyCents`.
- quantidade em micros usa integer seguro no intervalo
  `[-9007199254740991,9007199254740991]`; quantidade de reserva é estritamente
  positiva.

Nenhum `double precision`, número fracionário, `NaN`, infinito ou timestamp
com offset entra em JSON/hash. `null` é sempre explícito nos campos declarados
nullable; chave omitida só é válida quando o schema abaixo diz “0 ocorrências”.

### 2.2 Canonical JSON e digest

`C(v)` é exatamente `pos_manual_canonical_json_v1(v)`: UTF-8, chaves ordenadas
pelos bytes UTF-8, arrays na ordem declarada, strings NFC e inteiros seguros.

Para todo domínio deste documento:

```text
H(domain, value) = lowercase_hex(SHA256(UTF8(domain) || 0x00 || UTF8(C(value))))
```

O `domain` não contém o NUL. Não existe newline, BOM, espaço ou terminador
depois de `C(value)`. A T2-02 estende a allowlist do helper T2-00 somente com:

```text
t2-reserve-request-v1
t2-reserve-identity-v1
t2-reservation-id-v1
t2-reservation-event-id-v1
t2-stock-reservation-key-v1
t2-promotion-reservation-key-v1
t2-effect-key-v1
t2-sale-idempotency-v1
t2-sale-request-v1
t2-sale-payment-identity-v1
t2-sale-payment-idempotency-v1
t2-sweep-request-v1
t2-sweep-identity-v1
t2-sweep-receipt-id-v1
t2-sweeper-subject-v1
t2-sweep-result-v1
t2-promotion-policy-v1
t2-reservation-graph-v1
t2-release-result-v1
t2-customer-opaque-v1
t2-customer-eligibility-v1
t2-tracking-request-v1
t2-catalog-product-v1
t2-catalog-variation-v1
t2-value-program-v1
t2-value-account-identity-v1
t2-value-entry-key-v1
t2-value-ledger-request-v1
t2-accounting-period-v1
t2-accounting-mapping-v1
t2-accounting-journal-identity-v1
t2-accounting-journal-idempotency-v1
t2-accounting-journal-request-v1
t2-stock-multiset-v1
t2-promotion-multiset-v1
t2-stock-release-multiset-v1
t2-promotion-release-multiset-v1
t2-webhook-config-v1
t2-webhook-payload-v1
t2-fiscal-envelope-identity-v1
t2-fiscal-envelope-prepare-v1
t2-fiscal-envelope-binding-v1
t2-fiscal-document-identity-v1
t2-fiscal-document-idempotency-v1
t2-fiscal-document-request-v1
t2-fiscal-attempt-identity-v1
t2-fiscal-attempt-operation-v1
t2-fiscal-attempt-request-v1
t2-fiscal-provider-idempotency-v1
t2-fiscal-number-allocation-identity-v1
t2-webhook-event-identity-v1
t2-webhook-delivery-identity-v1
t2-boundary-operation-identity-v1
t2-catalog-boundary-request-v1
t2-value-program-boundary-request-v1
t2-accounting-period-boundary-request-v1
t2-accounting-period-put-request-v1
t2-webhook-boundary-request-v1
```

Os cinco domínios T2-00 permanecem inalterados. Todo builder SQL usa
`jsonb_build_object`; nenhum JSON do caller é fonte de snapshot ou manifesto.

T2-02 substitui, na migration nova, o teto de documento de 65.536 bytes de
`pos_manual_canonical_json_v1` e `pos_manual_t2_json_dlp_safe_v1` por
**4.194.304 bytes**, preservando depth 32, string individual até 65.536 bytes
e todos os bytes/hash anteriores. Não é canonical v2 porque a serialização não
muda; somente o predicado de tamanho é ampliado sobre uma base sem application.
O manifesto admite no máximo **1.812 entries**: 204 comerciais, uma promoção,
200 componentes, 400 tracking, 400 stock, 400 warehouse, 96 value (máximo 32
programas/accruals por cada um dos três kinds), três fiscais, seis contábeis,
dois eventos e 100 webhooks. Sentinel substitui o conjunto vazio e não soma ao
máximo. Cada um dos dez documentos tem no
máximo 4.194.304 bytes canônicos. O builder calcula cardinalidade e tamanho
antes da primeira escrita e falha `22023 T2 snapshot exceeds bounded size`.
Vetores abaixo/acima do limite e os vetores T2-00 precisam ser idênticos em
SQL/TypeScript; truncar, chunk implícito ou Merkle não especificado é proibido.

Vetores fixos adicionais (ASCII/UTF-8 exatos, sem newline):

| domain | canonical JSON | SHA-256 |
|---|---|---|
| `t2-effect-v1` | `{"effectKey":"promotion_redemption:none","effectKind":"promotion_redemption","payload":{"present":false},"schemaVersion":1}` | `c7b67df259d3212ce82868f720e8024a1f84c15bae0114c42aeb2bf9846e7c3f` |
| `t2-stock-multiset-v1` | `{"reservations":[],"schemaVersion":1}` | `4d3b679caff5499d47ec8c9d24de641d783e47f576e49b28711989a18720f00e` |
| `t2-promotion-multiset-v1` | `{"reservations":[],"schemaVersion":1}` | `2ecf821974593e457a99f0274a17885d3826f5e8cedcb5ab9567c460e940f0d4` |
| `t2-stock-release-multiset-v1` | `{"reservations":[],"schemaVersion":1}` | `2736e34b7094bf9840398d20d754e85a379a71a1f9018a4edbcbe39426b6381e` |
| `t2-promotion-release-multiset-v1` | `{"reservations":[],"schemaVersion":1}` | `8069cb2d52eaa03c676415cda09f88cc7426e4f7d3351bdf8fb19953795f106a` |
| `t2-customer-opaque-v1` | `{"customerId":null,"schemaVersion":1}` | `9460e8138b8585ab1aa527a26dde5aa0950dd21e890f298bad08e81654fdcd62` |
| `t2-webhook-payload-v1` | `{"applicationId":"00000000-0000-0000-0000-000000000000","eventKind":"sale.completed","occurredAt":"2026-08-31T00:00:00.000000Z","sale":{"currency":"BRL","saleNumber":"PDV-20260831-0000000001","totalCents":100},"schemaVersion":1}` | `7798dc57f796576636a77095f429eae06ba38f7b7d77679b01a2df95d8db1c26` |

### 2.3 Ordenação de arrays

Toda ordem abaixo é ascendente por bytes UTF-8 para strings e por valor para
inteiros, com `null` depois de valor não nulo:

- quote lines: `(lineIndex, heldSaleItemId)`;
- BOM: `(rootLineIndex, depth, scopeKey, componentIndex, productId,
  variationId,unitQuantityMicros,quantityMicros)`;
- tracking/reservas: `(reservationKey, lotId)`;
- promoções: `(promotionId, couponId)`;
- postings: `(entryKey, mappingId, accountId)`;
- webhooks: `(endpointId, endpointVersion, topic)`;
- manifesto: `(effectKind, effectKey)`.

Builder que obtiver duas linhas com a mesma chave de ordenação integral falha
`23514 T2 snapshot multiset is ambiguous`; ele nunca usa ordem física.

## 3. P0-A — dez documentos, hashes e manifesto

### 3.1 Regra comum dos snapshots

Cada documento é objeto com `schemaVersion:1`, exatamente as chaves declaradas
nesta seção e nenhum alias. Todo ID bigint é string decimal. Todo instante usa
§2.1. Labels classe C só aparecem nos campos terminados em `Label`, limitados a
128 bytes, e não participam de join/autoridade. Classe A é proibida. Classe B
só pode existir no envelope fiscal opaco do §9 e nunca no JSON.

A T2-02 substitui a allowlist DLP ampla da T2-00 por validadores estruturais
por path: chave válida em um path não se torna válida em outro path.

`operational_actor`:

```json
{"actorProfileId":1,"actorUserId":"opaque","branchGrantId":"1","branchId":1,"branchTimezone":"America/Sao_Paulo","registerGrantId":"1","registerId":1,"schemaVersion":1,"sessionId":1,"terminalId":"opaque"}
```

`case_evidence`:

```json
{"amountCents":100,"caseId":"00000000-0000-0000-0000-000000000000","caseVersion":3,"currency":"BRL","evidenceHash":"<Hash64>","method":"credit","observationId":"1","provider":"opaque","referenceLastFour":"A*9_","schemaVersion":1}
```

`draft_quote_slot` tem exatamente
`connectorId,connectorRevision,credentialRef,credentialRevision,draftId,
draftRequestHash,draftRevision,planId,planVersion,quoteHash,quoteLines,
schemaVersion,slot`. `quoteLines[]` tem exatamente `baseDiscountCents,
grossCents,heldSaleItemId,lineIndex,orderDiscountCents,productId,
promotionDiscountCents,quantityMicros,surchargeCents,totalCents,
unitPriceCents,variationId`. `slot` tem exatamente `amountCents,installments,
method,paymentIndex,proofKind,provider`; no primeiro corte `paymentIndex=0`,
`proofKind="manual"`, uma única slot e `slot.amountCents` igual ao total.

`customerOpaqueId = H('t2-customer-opaque-v1',
{"customerId":<integer|null>,"schemaVersion":1})` e `eligibilityHash =
H('t2-customer-eligibility-v1',{"branchId":<integer>,
"customerOpaqueId":<Hash64>,"eligible":<boolean>,"schemaVersion":1})`.
Customer nulo usa `customerId:null`, não chave ausente.

`customer_sale_payment` tem exatamente `customerOpaqueId,eligibilityHash,
payment,sale,saleItems,schemaVersion,value`. `sale` tem exatamente
`branchId,cashRegisterLegacyLabel,changeCents,currency,customerId,
customerLegacyLabel,discountCents,draftId,idempotencyKey,occurredAt,
operatorProfileId,paymentMethodLegacy,plannedSaleId,registerId,requestHash,
saleNumber,sellerLegacyLabel,sessionId,sourceId,sourceType,status,
subtotalCents,surchargeCents,terminalId,totalCents,warehouseId`.
`sourceType="manual_payment_application"`, `sourceId` é a application UUID,
`status="completed"`, `customerLegacyLabel="CONSUMIDOR"`,
`sellerLegacyLabel="OPERADOR:"||actorProfileId`,
`cashRegisterLegacyLabel="CAIXA:"||registerId` e
`paymentMethodLegacy=payment.method`. Esses labels determinísticos alimentam
os campos legacy NOT NULL de `sales`; nenhuma PII é relida em T2b. O float
legacy `sales.total` é projeção exata `totalCents/100`, verificada por
round-trip para cents.

`saleItems[]` tem exatamente `baseDiscountCents,grossCents,gtinSnapshot,
lineIndex,orderDiscountCents,productId,productNameLabel,
promotionDiscountCents,quantityMicros,skuSnapshot,surchargeCents,totalCents,
unit,unitPriceCents,variationId`. `productNameLabel`, SKU, GTIN e unit são
congelados pós-lock em T2a. Em T2b, `quantity=quantityMicros/1000000`,
`unit_price=unitPriceCents/100`, `total=totalCents/100`, todos com round-trip;
`discount_cents = baseDiscountCents + orderDiscountCents +
promotionDiscountCents`. `subtotalCents=sum(grossCents)`, os três descontos,
surcharge e total da sale são somas `bigint` das linhas e precisam fechar a
equação comercial e caber em `MoneyCents`.

`payment` tem
exatamente `amountCents,changeCents,currency,evidenceHash,installments,method,
observationId,paymentIdempotencyKey,paymentIndex,plannedPaymentId,provider,
referenceLastFour,status,tenderedCents,type`; seus valores fixos são `type="payment"`,
`status="manual_confirmed"`, `tenderedCents=amountCents`, `changeCents=0`.

`value` tem exatamente `accounts,accruals,programs`. `programs[]` tem
`branchId,configHash,earnUnits,expiresAfterDays,kind,programId,revision,
spendCents,status`; `accounts[]` tem `accountId,accountVersion,balanceUnits,
branchId,customerId,customerOpaqueId,exists,expiresAt,kind,planned,
plannedAccountLabel,programId,reservedUnits,status,unit`;
`accruals[]` tem `accountId,amountUnits,direction,entryKey,
expiresAt,programId`. `programs` ordena por `programId`; `accounts` por
`(programId,accountId)`; `accruals` por `(programId,entryKey,accountId)`.

Conta existente usa `accountId=pos_value_accounts.id`, `exists=true`,
`planned=false` e sua version live. Conta ausente congela:

```text
accountId = UUID16('t2-value-account-identity-v1',
 {"applicationId":<uuid>,"customerOpaqueId":<Hash64>,
  "programId":<OpaqueId>,"schemaVersion":1})::text
entryKey = H('t2-value-entry-key-v1',
 {"accountId":<OpaqueId>,"applicationId":<uuid>,"programId":<OpaqueId>,
  "schemaVersion":1})
```

Nesse caso `exists=false,planned=true,accountVersion=0,status="active"`,
`customerId` é o ID interno D já congelado em `sale.customerId`, `kind` vem do
program, `unit="points"` para loyalty_points e `"cents"` para os demais,
`plannedAccountLabel="PROGRAMA:"||programId`, balance/reserved iniciais são
zero, code_hash/code_last_four/pin_hash/metadata são SQL NULL e expiry é
`sale.occurredAt + expiresAfterDays` em UTC
ou null. T2-05 insere `pos_value_accounts` com esses valores e ID exato antes
do ledger/accrual; unique `(program_id,customer_id)` e replay precisam apontar
essa mesma row ou falhar. Ausência de programa é `[]`, nunca recomputação em
T2-05. T2-02 adiciona `revision/config_hash` aos programas como §3.3.

Para conta existente, `plannedAccountLabel=null`; label, code/pin e metadata
livres **não entram** em snapshot/hash e nunca são relidos para decisão. Os
campos restantes são a projeção causal mínima necessária para version/status,
saldo e accrual. Assim uma label histórica potencialmente PII não entra no T2.

Para cada programa active da branch e customer não nulo,
`amountUnits = floor(sale.totalCents / spendCents) * earnUnits`, calculado em
bigint; zero omite accrual daquele programa, positivo precisa caber em integer
seguro e cria `direction="credit"`. `expiresAt` segue a conta/regra acima.
Customer nulo produz todos os três arrays value vazios. Nenhum programa é
selecionado por nome/label e a ordem não depende da leitura física.
Após travar e ordenar por `programId`, mais de 32 programas active na branch
falha `22023 T2 value program graph exceeds limit` antes de application,
sequence ou qualquer reserva; é proibido escolher os primeiros 32. Com até 32,
todos são avaliados e somente accrual zero é omitido.

Cada accrual congela ainda a projeção ledger exatamente
`accountId,actor,amountUnits,balanceAfterUnits,balanceBeforeUnits,
balanceDeltaUnits,entryKey,metadata,reason,referenceId,referenceType,
requestHash,reservationId,reservedAfterUnits,reservedBeforeUnits,
reservedDeltaUnits,reversalOfId,type`. Os valores são: target `type="credit"`
(o manifest mantém `entryType="earn"`),
`balanceDeltaUnits=amountUnits`, `balanceBeforeUnits=account.balanceUnits`,
`balanceAfterUnits=balanceBeforeUnits+amountUnits`, reserved before/after iguais
ao `account.reservedUnits`, `reservedDeltaUnits=0`,
`operationKey=entryKey`, `referenceType="sale"`,
`referenceId=plannedSaleId::text`, `actor=actorUserId`, e
`reservationId=reversalOfId=reason=metadata=null`. `requestHash =
H('t2-value-ledger-request-v1', {accountId,amountUnits,applicationId,entryKey,
plannedSaleId,programId,schemaVersion:1})`. Overflow, saldo divergente ou
replay da operation key com request hash diferente bloqueia; T2-05 insere
esses valores exatos. O `actual_hash` reconstrói o P do registry somente da
ledger row e de sua companion causal imutável, como §14.1, sem lookup mutável.

Não existe hoje tabela `value_accrual`: portanto T2-05 cria
`pos_value_accrual_effects(effect_key text PRIMARY KEY, application_id uuid
NOT NULL, ledger_entry_id bigint NOT NULL UNIQUE REFERENCES
pos_value_ledger_entries(id) ON DELETE RESTRICT, program_id text NOT NULL,
entry_key text NOT NULL UNIQUE, amount_units bigint NOT NULL,
planned_sale_id integer NOT NULL, creation_txid numeric NOT NULL)` e FK
causal para a application. A row é a materialização do effect
`value_accrual`, uma por ledger entry; não duplica saldo. Seu payload/actual
hash é `{"accrual":<value.accruals[i]>,"plannedSaleId":<integer>}` e é
reconstruído do effect row + ledger FK imutável. `value_ledger_entry` usa a
projeção ledger acima; assim os dois kinds têm targets e cardinalidades
independentes e verificáveis.

`catalog_bom_tracking` tem exatamente `bom,businessDate,products,schemaVersion,
tracking,variations`. `products[]`: `active,configHash,gtinSnapshot,
manageStock,nameLabel,posRevision,productId,productType,skuSnapshot,status,
unit`. `variations[]`: `configHash,enabled,gtinSnapshot,manageStock,
posRevision,productId,skuSnapshot,status,variationId`.
`bom[]`: `bomId,bomVersion,componentIndex,depth,productId,quantityMicros,
rootLineIndex,scopeKey,unitQuantityMicros,variationId`. `unitQuantityMicros` é
a quantidade por unidade do kit e `quantityMicros` é o total já multiplicado
pela quantidade da linha raiz; ambos são inteiros positivos pós-lock. T2-05
insere-os respectivamente em `pos_kit_sale_components.unit_quantity_micros`
e `.quantity_micros`, sem reler/recalcular BOM. `tracking[]`: `lotId,requestedLotCodeHash,
requestedSerialHash,reservationKey,rootLineIndex,trackingKind`; código ou série
abertos são proibidos. Cada request hash é `H('t2-tracking-request-v1',
{"kind":"lot"|"serial","normalizedValue":<NFC>,"schemaVersion":1})`;
somente o hash persiste. Limites: profundidade `<=8`, até 500 BOMs ativos
inspecionados e até 200 folhas expandidas.

`inventory_promotion` tem exatamente `inventoryReservations,
promotionReservations,schemaVersion`. `inventoryReservations[]`:
`componentScopeKey,heldSaleItemId,lotId,lotReservedAfterMicros,
lotReservedBeforeMicros,parentReservedAfterMicros,parentReservedBeforeMicros,
productId,quantityMicros,quoteLineIndex,reservationId,reservationKey,
stockMode,trackingKind,variationId,variationReservedAfterMicros,
variationReservedBeforeMicros,warehouseId`. `promotionReservations[]`:
`couponId,couponLiveBefore,couponUsedBefore,customerLiveBefore,
customerOpaqueId,customerUsedBefore,discountCents,expiresAt,globalLiveBefore,
globalUsedBefore,policyHash,promotionId,reservationId,reservationKey`.

`fiscal` tem exatamente `disposition,documentModel,envelopeBindingHash,
envelopeHash,envelopeId,envelopeLocator,envelopePreparedHash,envelopeVersion,
environment,expected,mode,plannedSaleIdentityHash,policyHash,profileId,
profileVersion,schemaVersion,number,numberingOwner,series`.

Para `not_applicable`: `mode="not_applicable"`,
`disposition="not_applicable_homologated"`, `expected=null`, `documentModel,
environment,series,number,numberingOwner,profileId,profileVersion` e todos os sete campos envelope/
binding são null; `policyHash` é Hash64 homologado.

Para o futuro `required_queue`: `mode="required_queue"`,
`disposition="required_queue_bound"`; profile/version/policy, model,
environment, `numberingOwner`, `envelopeId,envelopeLocator,envelopeVersion,envelopeHash,
envelopePreparedHash,plannedSaleIdentityHash,envelopeBindingHash` são todos
não nulos e iguais à row bound. Se owner é `local`, T2a usa o ledger/counter
dedicado do §14.1, aloca exatamente uma vez e congela `series` e `number`
inteiros positivos. Se owner é `provider`, ambos são null e nenhum contador é
alterado. `expected` é exatamente:

```text
{"amountCents":<MoneyCents>,"currency":"BRL","documentModel":"<Code>","environment":"<Code>","number":<positive integer|null>,"numberingOwner":"local"|"provider","plannedSaleId":<integer>,"plannedSaleNumber":"<Code>","plannedSaleOccurredAt":"<Instant>","series":<positive integer|null>}
```

Os placeholders `amountCents`, `plannedSaleId`, `number` e `series`, quando
não null, são JSON **numbers**, sem aspas; os demais placeholders são strings JSON. Nenhuma
outra chave é admitida. A T2-02 ainda rejeita required_queue conforme
§9; T2-06 implementa este mesmo schema, sem versão implícita.

`accounting` tem exatamente `journal,mappings,period,postings,schemaVersion,
source`. `period`: `endsOn,periodId,
periodConfigHash,periodRevision,startsOn,status`. `mappings[]`:
`accountCodeSnapshot,accountId,accountNameSnapshot,configHash,direction,
entryKey,mappingId,sourceType`. `postings[]`:
`accountCodeSnapshot,accountId,accountNameSnapshot,amountCents,amountDecimal,
descriptionLabel,dimensions,direction,entryKey,mappingId,sequence`.
`source` tem exatamente `competenceDate,facts,factsHash,schemaVersion,sourceId,
sourceType,sourceVersion`; `facts` tem exatamente `discountCents,paymentIds,
saleId,status,subtotalCents,surchargeCents,totalCents`. Débitos e créditos
precisam ter soma idêntica e positiva.

`journal` tem exatamente `branchId,competenceDate,costCenterId,createdBy,
currency,descriptionLabel,idempotencyKey,journalId,occurredAt,originId,
originType,originVersion,periodId,plannedSaleId,policyHash,policyId,
policyVersion,requestHash,sourceSnapshotHash,totalCreditCents,
totalDebitCents`. Account code/name e description são labels C NFC,
control-free, 1..128 bytes; dimensions é sempre null neste corte.

`webhooks` tem exatamente `endpoints,payloads,schemaVersion`.
`endpoints[]`: `apiVersion,configHash,endpointId,endpointRowId,
endpointVersion,topic`.
`payloads[]`: `endpointId,endpointVersion,eventKind,payloadHash,topic`. URL,
headers, segredo e credential são proibidos. Em `webhook_mode=required`, todo
endpoint ativo elegível aparece uma vez; em `disabled`, ambos os arrays são
vazios.

`manifest` tem exatamente `entries,schemaVersion`. Cada `entries[]` tem
`effectKey,effectKind,expectedCardinality,expectedHash,required`. O objeto não
contém `manifestHash`, evitando autorreferência. A coluna `manifest_hash` é
`H('t2-manifest-v1', manifest)`.

### 3.2 Agregação do snapshot

Hashes filhos usam `H('t2-snapshot-component-v1', document)`. O agregado é
exatamente:

```json
{"accountingHash":"<Hash64>","catalogBomTrackingHash":"<Hash64>","caseEvidenceHash":"<Hash64>","customerSalePaymentHash":"<Hash64>","draftQuoteSlotHash":"<Hash64>","fiscalHash":"<Hash64>","inventoryPromotionHash":"<Hash64>","manifestHash":"<Hash64>","operationalActorHash":"<Hash64>","schemaVersion":1,"webhooksHash":"<Hash64>"}
```

`snapshot_hash = H('t2-snapshot-v1', objeto_acima)`. Isso é exatamente o
contrato já materializado em T2-00, independentemente da apresentação da ordem
das chaves no exemplo.

### 3.3 Boundary/versionamento das fontes hoje ausentes

A T2-02 precisa criar, na migration nova, as colunas que os snapshots exigem;
`updated_at` nunca é tratado como revision e hash inexistente nunca é
“derivado depois”:

- `products.pos_revision integer NOT NULL` e `pos_config_hash Hash64`;
- `product_variations.pos_revision integer NOT NULL` e `pos_config_hash`;
- `pos_value_programs.revision integer NOT NULL` e `config_hash`;
- `pos_accounting_periods.revision integer NOT NULL` e `config_hash`;
- `pos_accounting_policy_mappings.config_hash Hash64`.

Backfill ocorre sob locks e antes de instalar reserve: todas as revisions
começam em 1; os hashes são:

```text
product = H('t2-catalog-product-v1',
 {active,gtinSnapshot:gtin,manageStock,nameLabel:name,posRevision:1,
  productId,productType:type,schemaVersion:1,skuSnapshot:sku,status,unit})
variation = H('t2-catalog-variation-v1',
 {enabled,gtinSnapshot:gtin,manageStock,posRevision:1,productId,
  schemaVersion:1,skuSnapshot:sku,status,variationId})
program = H('t2-value-program-v1',
 {branchId,earnUnits,expiresAfterDays,kind,programId,revision:1,
  schemaVersion:1,spendCents,status})
period = H('t2-accounting-period-v1',
 {branchId,currency,endsOn:ends_at,month,periodId,revision:1,
  schemaVersion:1,startsOn:starts_at,status,year})
mapping = H('t2-accounting-mapping-v1',
 {accountId,direction,entryKey,mappingId,policyId,schemaVersion:1,sourceType})
```

NULL aparece explicitamente. Triggers de todos os writers autorizados
incrementam revision uma vez por statement/row quando qualquer campo da
projeção muda e recalculam hash na mesma escrita; mudança só de `updated_at`
não incrementa. Direct DML sem capability root é negado.

#### 3.3.1 Cinco ABIs boundary fechadas

Esta v12 substitui a omissão anterior de writer para as boundaries acima. As
cinco assinaturas públicas, e somente elas, são:

```sql
public.pos_t2_catalog_boundary_v1(text,integer,integer,text,jsonb,jsonb,text,text,text) returns jsonb
public.pos_t2_value_program_boundary_v1(text,text,integer,text,integer,text,text,text,integer,integer,integer,integer,text,text,text) returns jsonb
public.pos_t2_accounting_period_put_v1(integer,integer,integer,date,date,text,text,text,text) returns jsonb
public.pos_t2_accounting_period_close_v1(text,integer,text,text,text,text,text) returns jsonb
public.pos_t2_webhook_boundary_v1(text,text,integer,text,text,text,text,text,text,text,text,text,text,text) returns jsonb
```

Todas são wrappers `SECURITY DEFINER`, `SET search_path=pg_catalog`, usam nomes
fully-qualified, chamam no máximo um impl interno owner-only/revogado que pode
usar `SET search_path=pg_catalog,public`, e têm `PUBLIC` revogado. A role tenant `*_runtime` recebe
`EXECUTE` somente nessas assinaturas exatas. Cada chamada exige transação
read-write `SERIALIZABLE`, confere `session_user` como a role runtime exata do
tenant e valida `actor_user_id` live com a permissão do producer indicada
abaixo. Não existe requisito de `application_name` para estas cinco ABIs: elas
usam o pool Prisma tenant runtime comum. Replica/read-only, outra role,
isolamento inferior, argumento extra, overload ou helper interno falham
fechado. Erro de serialização/deadlock pode ser repetido no máximo três vezes
com os mesmos bytes e a mesma key; timeout/cancel nunca é sucesso.

As cinco usam `pos_manual_t2_boundary_operations`, append-only, com
`operation_id uuid`, `abi Code`, `idempotency_key IdempotencyKey`,
`request_hash Hash64`, `actor_user_id Subject`, `request jsonb`, `result jsonb`,
`write_txid bigint` e `created_at timestamptz`, PK `operation_id`, unique
`(abi,idempotency_key)` e checks byte-exatos. Não há grant de tabela/sequence.

```text
operationId = UUID16('t2-boundary-operation-identity-v1',
 {abi,idempotencyKey,schemaVersion:1})
```

Replay exige igualdade de `abi,idempotency_key,request_hash,actor_user_id` e
do request canônico inteiro; retorna o `result` persistido com apenas
`replayed:true`. Qualquer divergência é `23505 T2 boundary idempotency conflict`.
Fresh e replay nunca aceitam hash fornecido sem recomputar `H(domain,request)`.

O producer abre capability roots internos exatos por
`operation_id,table,primary_key,verb,old_boundary,new_boundary`, consumidos uma
única vez pelo guard da row na mesma transação. Root não é retornado, não é
delegável e não autoriza campo/row/verb diferente. Uma constraint diferida
prova, no commit, que todo root foi consumido uma vez, que toda projeção final
é a planejada e que o result foi persistido; root faltante/sobrando ou DML após
replay aborta tudo. Trigger nunca cria root, não adquire lock e não decide
boundary. `INSERT` e mudança da projeção boundary exigem root; UPDATE somente
de stock, cost, métricas, `failure_count`, timestamps ou outro campo fora da
projeção não cria nem exige root. `updated_at` sozinho não muda revision/hash.

**Catálogo.** Parâmetros em ordem são
`action,product_id,expected_product_revision,expected_product_config_hash,
product_projection,variations,actor_user_id,idempotency_key,request_hash`.
`action` é `put_graph|set_active`. `product_id` é null somente para create;
expected revision/hash são null somente para create. `product_projection` é o
objeto fechado
`{active,gtinSnapshot,manageStock,nameLabel,productType,skuSnapshot,status,unit}`.
`variations` é array ordenado por `ordinal` de objetos fechados
`{enabled,expectedConfigHash,expectedRevision,gtinSnapshot,manageStock,ordinal,
skuSnapshot,status,variationId}`; `variationId/expected*` são todos null para
create e todos não-null para update. O request é exatamente:

```json
{"action":"<Code>","actorUserId":"<Subject>","expectedProductConfigHash":"<Hash64|null>","expectedProductRevision":"<integer|null>","idempotencyKey":"<IdempotencyKey>","productId":"<integer|null>","productProjection":"<object>","schemaVersion":1,"variations":["<objects>"]}
```

`request_hash=H('t2-catalog-boundary-request-v1',request)`. O producer exige
`products.write`, adquire advisory do product (ou da identidade de operação no
create), trava product, variations existentes por id, depois rows referenciadas
de reserva/lote/balance em id crescente. Aloca IDs por sequence dentro da
transação; calcula revision/hash pelo §3.3; omissions em `put_graph` planejam
DELETE das variations correntes. DELETE de product é proibido. DELETE de
variation é permitido somente por `put_graph`, com root `DELETE`, se não há
qualquer FK/lot/balance/sale/hold/reservation/BOM que a referencie; caso
contrário falha `23514 T2 catalog variation is referenced`. `set_active` não
aceita variation nem altera outro campo. Retorno exato:

```json
{"operationId":"<uuid>","productConfigHash":"<Hash64>","productId":1,"productRevision":1,"replayed":false,"variations":[{"action":"create|update|delete|keep","configHash":"<Hash64>","ordinal":0,"revision":1,"variationId":1}]}
```

O wrapper TypeScript executa o plano retornado na mesma transação e usa os IDs,
revisions e hashes retornados; replay não executa DML. `keep` só ocorre quando
a projeção é byte-idêntica e não incrementa revision. `put_graph` incrementa
cada row alterada exatamente uma vez; create inicia em 1.

**Programa de valor.** Parâmetros em ordem são
`action,program_id,expected_revision,expected_config_hash,branch_id,name,kind,
status,earn_units,spend_cents,redeem_cents_per_unit,expires_after_days,
actor_user_id,idempotency_key,request_hash`. `action=put|deactivate`; create é
`put` com `program_id/expected*` null e `status=active`; update é `put` com os
três não-null. `deactivate` exige os três não-null, `status=inactive` e repete a
projeção corrente restante. Request exato:

```json
{"action":"<Code>","actorUserId":"<Subject>","expectedConfigHash":"<Hash64|null>","expectedRevision":"<integer|null>","idempotencyKey":"<IdempotencyKey>","programId":"<OpaqueId|null>","projection":{"branchId":1,"earnUnits":1,"expiresAfterDays":null,"kind":"<Code>","name":"<string>","redeemCentsPerUnit":1,"spendCents":1,"status":"active|inactive"},"schemaVersion":1}
```

`request_hash=H('t2-value-program-boundary-request-v1',request)`. Exige
`pdv.write` e membership owner/admin, trava branch e program, depois accounts e
reservas live por id. A própria ABI consome o root e faz INSERT/UPDATE. ID de
create é `operationId::text`; revision/hash seguem §3.3. DELETE é proibido;
deactivation é a única retirada. Retorno exato:

```json
{"configHash":"<Hash64>","operationId":"<uuid>","programId":"<OpaqueId>","replayed":false,"revision":1,"status":"active|inactive"}
```

**Criação de período contábil.** A assinatura create-only recebe, em ordem,
`branch_id,year,month,starts_on,ends_on,currency,actor_user_id,idempotency_key,
request_hash`. Request exato:

```json
{"actorUserId":"<Subject>","branchId":1,"currency":"BRL","endsOn":"<Date>","idempotencyKey":"<IdempotencyKey>","month":1,"schemaVersion":1,"startsOn":"<Date>","year":2026}
```

`request_hash=H('t2-accounting-period-put-request-v1',request)`. Exige
`accounting.write` e membership owner/admin. Adquire advisory por
`branch_id/year/month`, trava a branch e qualquer period concorrente dessa
competência, exige branch live, `currency=BRL`, mês 1..12, ano 2000..2200,
`starts_on` primeiro dia do mês e `ends_on` último dia do mesmo mês. O producer
usa `operationId=UUID16('t2-boundary-operation-identity-v1',
{abi:'accounting_period_put',idempotencyKey,schemaVersion:1})`, fixa
`periodId=operationId::text`, `status=open`, `revision=1`, campos close null,
calcula o hash §3.3, abre/consome um root INSERT e persiste operation/result na
mesma transação. Collision de `(branch_id,year,month)` com outro operation é
`23505 T2 accounting period identity conflict`. Retorno exato:

```json
{"configHash":"<Hash64>","operationId":"<uuid>","periodId":"<OpaqueId>","replayed":false,"revision":1,"status":"open"}
```

Replay segue a regra comum. INSERT direto, segundo create sem replay e qualquer
UPDATE de datas/branch/currency são proibidos; após create, somente a ABI close
abaixo pode alterar a boundary. DELETE e reabertura permanecem proibidos.

**Fechamento contábil.** Parâmetros em ordem são
`period_id,expected_revision,expected_config_hash,closed_by,reason,
idempotency_key,request_hash`. Request exato:

```json
{"closedBy":"<Subject>","expectedConfigHash":"<Hash64>","expectedRevision":1,"idempotencyKey":"<IdempotencyKey>","periodId":"<OpaqueId>","reason":"<string>","schemaVersion":1}
```

`request_hash=H('t2-accounting-period-boundary-request-v1',request)`. Exige
`accounting.write` e membership owner/admin, trava period, journals e
applications/reservas que snapshotaram o period em PK crescente, exige current
`open` e CAS exato, usa `clock_timestamp()` para `closed_at`, consome o root e
faz a única transição `open→closed`. Caller timestamp é proibido. DELETE e
reabertura são proibidos. Retorno exato:

```json
{"closedAt":"<Instant>","configHash":"<Hash64>","operationId":"<uuid>","periodId":"<OpaqueId>","replayed":false,"revision":2,"status":"closed"}
```

**Webhook versionado.** Parâmetros em ordem são
`action,logical_id,expected_version,expected_config_hash,name,topic,
delivery_url,secret_cipher,secret_preview,status,api_version,actor_user_id,
idempotency_key,request_hash`. `action=create|update|revoke|rotate`; create
exige logical/expected null. As demais exigem todos não-null; `update` preserva
secret, `rotate` preserva name/topic/URL/status/apiVersion e troca secret,
`revoke` preserva configuração e fixa `status=disabled`. Request exato:

```json
{"action":"<Code>","actorUserId":"<Subject>","expectedConfigHash":"<Hash64|null>","expectedVersion":"<integer|null>","idempotencyKey":"<IdempotencyKey>","logicalId":"<OpaqueId|null>","projection":{"apiVersion":"<Code>","deliveryUrl":"<string>","name":"<string>","secretCipher":"<string>","secretPreview":"<string>","status":"active|paused|disabled","topic":"<Code>"},"schemaVersion":1}
```

`request_hash=H('t2-webhook-boundary-request-v1',request)`. Exige
`integrations.write`, adquire advisory por logical ID/operação, trava current e
deliveries pendentes por id. Create usa `logicalId=operationId::text`, version
1 e row física `id=operationId::text`. Nas demais ações, CAS exato, marca a
old `superseded_at=clock_timestamp()` e insere nova row física com
`id=UUID16('t2-boundary-operation-identity-v1',
{abi:'webhook-row',idempotencyKey,schemaVersion:1})::text`, mesmo logical ID,
version+1, `failure_count=0` e hash §8.1. Ambas as rows têm roots exatos.
Historical UPDATE/DELETE e DELETE lógico/físico são proibidos. Retorno exato:

```json
{"configHash":"<Hash64>","endpointId":"<OpaqueId>","logicalId":"<OpaqueId>","operationId":"<uuid>","replayed":false,"status":"active|paused|disabled","version":1}
```

O auto-pause após dez falhas usa `action=update`, o último ator configurador
registrado no audit append-only da row current, novamente live e com
`integrations.write`, e key determinística do logical ID/version/threshold;
ator ausente/retirado impede a nova versão e o delivery continua bloqueado
fail-closed por `failure_count>=10`;
UPDATE de `failure_count` isolado continua livre de root. Enqueue escolhe
somente current (`superseded_at IS NULL`) active. Delivery existente permanece
presa à row física histórica. Mapping contábil não ganha ABI nesta onda:
`pos_accounting_policy_mappings` fica congelada para runtime; INSERT/UPDATE/
DELETE e ativação de policy que exigisse alterar mappings falham fechado.

O `pos_accounting_policies.mapping_hash` **não muda de fórmula**: permanece o
hash legado produzido por `hashPosAccountingPolicyMappings`, isto é,
SHA-256 sem domain/NUL do canonical JSON do array de objetos exatamente
`{accountId,direction,entryKey,id,sourceType}`, ordenado pelo contrato vigente
`sourceType:entryKey:id`. T2-02 não reescreve policy/profile/operation/assertion
e não substitui essa authority por `H(...)`. `profile.accounting_policy_hash`
e o snapshot `policyHash` continuam iguais ao `mapping_hash` vigente. O novo
`mapping.config_hash` é boundary adicional por row. Reserve não tenta
reimplementar `localeCompare` em SQL nem recalcula o aggregate: trava policy e
todos os mappings `source_type='sale'`, exige policy active/profile hash exato,
imutabilidade dos mappings de policy ativa e config hashes por row iguais aos
snapshotados. Divergência bloqueia; migration não “corrige” hash histórico.

O builder contábil T2 é fechado. Usa `sourceType="sale"`, `sourceId` decimal de
`plannedSaleId`, `sourceVersion=1`, `competenceDate=businessDate`,
`status="completed"` e `paymentIds=[plannedPaymentId]`. A policy ativa precisa
conter exatamente um mapping sale para
cada key abaixo, com direção indicada; mapping ausente, duplicado ou direção
divergente bloqueia:

| sequence | entryKey | direction | amountCents | presença |
|---:|---|---|---:|---|
| 1 | `sale.tender` | debit | `totalCents` | sempre |
| 2 | `sale.revenue` | credit | `subtotalCents` | sempre |
| 3 | `sale.discount` | debit | `discountCents` | somente se >0 |
| 4 | `sale.surcharge` | credit | `surchargeCents` | somente se >0 |

Nenhum outro mapping `source_type='sale'` é aceito neste corte. Description é
respectivamente `VENDA:TENDER`, `VENDA:REVENUE`, `VENDA:DESCONTO` e
`VENDA:ACRESCIMO`; dimensions é null. Cálculo usa bigint e prova
`totalCents + discountCents = subtotalCents + surchargeCents`, logo débito e
crédito são iguais e positivos; cada posting cabe em MoneyCents. `factsHash`
preserva a fórmula vigente do producer contábil (SHA-256 sem domain do canonical
JSON de `facts`), enquanto hashes T2 de snapshot/effect usam os domínios T2.
T2b não escolhe mapping nem quantia novamente.

Após travar cada mapping e sua account, T2a copia `account.code` e
`account.name` para `accountCodeSnapshot` e `accountNameSnapshot`; ambos são
labels C NFC, sem controles, entre 1 e 128 bytes. Mudança de qualquer um antes
de T2b é `boundary_changed`; T2b nunca relê account/policy para formar efeito.
`amountDecimal` é a string canônica `^-?[0-9]+\.[0-9]{2}$` obtida de
`amountCents/100` (aqui sempre positiva), e o INSERT converte essa string para
`numeric(20,2)` com round-trip obrigatório. `dimensions=null`.

As identidades e projeções do journal são exatamente:

```text
journalId = UUID16('t2-accounting-journal-identity-v1',
 {applicationId,schemaVersion:1})::text
idempotencyKey = H('t2-accounting-journal-idempotency-v1',
 {applicationId,journalId,schemaVersion:1})
requestHash = H('t2-accounting-journal-request-v1',
 {accountingSnapshotHash,applicationId,journalId,schemaVersion:1})
descriptionLabel = "VENDA PDV MANUAL:" || plannedSaleNumber
```

`branchId=branchId`, `costCenterId=costCenterId`, `periodId=period.periodId`,
`policyId/policyHash/policyVersion` vêm do snapshot, `originType="sale"`,
`originId=plannedSaleId::text`, `originVersion=1`, `competenceDate=businessDate`,
`occurredAt=plannedSaleOccurredAt`, `currency="BRL"`, `createdBy=actorUserId` e
totais vêm dos postings. `sourceSnapshot` é exatamente `source` e
`sourceSnapshotHash=SHA256(C(source))`, enquanto `source.factsHash=
SHA256(C(source.facts))`; ambos preservam as duas fórmulas legadas distintas,
sem domain/NUL. Reversal fields são null. `posted_at/created_at` são o timestamp da
transação T2b e `creation_txid` é o txid T2b: são metadados causais, não inputs
do hash esperado. Cada posting insere `policy_mapping_id=mappingId`, os dois
account snapshots, direction, cents, decimal, description, dimensions null,
sequence e `creation_txid`; o `actual_hash` reconstrói somente essas colunas
persistidas, sem lookup mutável.

O outbox inicial é exatamente `{"deliveryCount":0,"journalId":<OpaqueId>,
"maxDeliveries":8,"nextAttemptAt":<Instant>,"state":"pending"}`, onde
`nextAttemptAt=plannedSaleOccurredAt`; claim/error/export/completed são null.

`branch.timezone` é validado por match exato em `pg_timezone_names`, congelado
como `branchTimezone`, e `businessDate =
(planned_sale_occurred_at AT TIME ZONE branchTimezone)::date`. Branch sem
timezone IANA válida falha antes de reserva; FEFO usa somente essa data.

### 3.4 Registry de projeções de efeito

Para cada entrada:

```text
expected_hash = H('t2-effect-v1',
  {"effectKey":K,"effectKind":T,"payload":P,"schemaVersion":1})
```

ID gerado em T2b e `creation_txid` não entram; `plannedSaleId` entra porque foi
congelado em T2a. Não existe percent-encoding nem marcador nullable textual.
Para identidade com string arbitrária:

```text
EK(kind, identityObject) = kind || ':' ||
  H('t2-effect-key-v1',
    {"effectKind":kind,"identity":identityObject,"schemaVersion":1})
```

Assim `-`, `:`, `%` e qualquer ID Unicode não colidem nem sofrem encoding
duplo. Índice ordinal usa seis dígitos. Os payloads fechados são exatamente:

| kind / key | `P` literal (objetos nomeados são os schemas exatos do §3.1) |
|---|---|
| `sale` / `sale` | `{"sale":<sale>}` |
| `sale_item` / `sale_item:%06d` | `{"item":<saleItems[i]>,"plannedSaleId":<integer>}` |
| `sale_payment` / `sale_payment:000000` | `{"caseId":<uuid>,"payment":<payment>,"plannedSaleId":<integer>}` |
| `plan_consume` / `plan_consume:plan` | `{"after":{"consumedAt":<Instant>,"consumedSaleId":<integer>,"state":"consumed","version":<integer>},"before":{"state":"active","version":<integer>},"planId":<OpaqueId>}` |
| `draft_convert` / `draft_convert:draft` | `{"after":{"revision":<integer>,"status":"converted"},"before":{"revision":<integer>,"status":"draft"|"held"},"consumedAt":<Instant>,"draftId":<OpaqueId>,"plannedSaleId":<integer>}` |
| `promotion_redemption` / `EK(kind,{promotionId,couponId})` | `{"plannedSaleId":<integer>,"reservation":<promotionReservations[i]>}` |
| `kit_component` / `EK(kind,{rootLineIndex,scopeKey})` | `{"component":<bom[i]>,"plannedSaleId":<integer>}` |
| `tracked_lot_movement` / `EK(kind,{reservationKey})` | `{"deltaMicros":<negative integer>,"plannedSaleId":<integer>,"reservation":<inventoryReservations[i]>}` |
| `stock_movement` / `EK(kind,{reservationKey})` | `{"deltaMicros":<negative integer>,"plannedSaleId":<integer>,"reservation":<inventoryReservations[i]>}` |
| `warehouse_ledger` / `EK(kind,{reservationKey})` | `{"deltaMicros":<negative integer>,"entryType":"sale","plannedSaleId":<integer>,"reservation":<inventoryReservations[i]>}` |
| `value_account` / `EK(kind,{programId})` | `{"account":<value.accounts[i]>,"program":<value.programs[i]>}` |
| `value_ledger_entry` / `EK(kind,{programId,entryKey})` | `{"accrual":<value.accruals[i]>,"entryType":"earn","plannedSaleId":<integer>}` |
| `value_accrual` / `EK(kind,{programId,entryKey})` | `{"accrual":<value.accruals[i]>,"plannedSaleId":<integer>}` |
| `fiscal_document` / `fiscal_document:document` | `{"fiscal":<fiscal>,"plannedSaleId":<integer>}` |
| `fiscal_attempt` / `fiscal_attempt:000000` | `{"environment":<string|null>,"plannedSaleId":<integer>,"policyHash":<Hash64>,"profileId":<OpaqueId|null>,"profileVersion":<integer|null>}` |
| `fiscal_outbox` / `fiscal_outbox:000000` | `{"envelopeHash":<Hash64|null>,"envelopeLocator":<OpaqueId|null>,"envelopeVersion":<integer|null>,"plannedSaleId":<integer>}` |
| `accounting_journal` / `accounting_journal:journal` | `{"journal":<journal>,"source":<source>}` |
| `accounting_posting` / `EK(kind,{entryKey,mappingId})` | `{"journalId":<OpaqueId>,"posting":<postings[i]>}` |
| `accounting_export_outbox` / `accounting_export_outbox:outbox` | `{"deliveryCount":0,"journalId":<OpaqueId>,"maxDeliveries":8,"nextAttemptAt":<Instant>,"state":"pending"}` |
| `sale_event` / `sale_event:completed` | `{"actorId":<Subject>,"actorNameLabel":<Label>,"causationId":<uuid>,"correlationId":<uuid>,"data":{"applicationId":<uuid>,"caseId":<uuid>},"eventKind":"completed","occurredAt":<Instant>,"plannedSaleId":<integer>}` |
| `audit_event` / `audit_event:manual-application-applied` | `{"action":"manual_application_applied","actorProfileId":<integer>,"actorUserId":<Subject>,"after":{"applicationId":<uuid>,"caseId":<uuid>,"plannedSaleId":<integer>},"before":null,"correlationId":<uuid>,"entityId":<integer>,"entityType":"sale","eventKind":"manual_application_applied"}` |
| `webhook_delivery` / `EK(kind,{endpointId,endpointVersion,topic})` | `{"endpointId":<OpaqueId>,"endpointVersion":<integer>,"eventKind":<Code>,"payloadHash":<Hash64>,"plannedSaleId":<integer>,"topic":<Code>}` |

Os placeholders `<...>` indicam substituição escalar tipada, não chaves
abertas; todos os nullables aparecem como `null`. `actual_hash` é sempre
reconstruído dessas mesmas colunas alvo. Para `sale_item`, T2-04 adiciona
`base_discount_cents`, `order_discount_cents` e
`promotion_discount_cents` NOT NULL, além de application/creation txid; o
legacy `discount_cents` precisa ser a soma exata. Sem essas três colunas,
backfill/guards dos writers normais, o producer continua revert-only.

Para efeitos físicos T2-05, `actor/user_name="OPERADOR:"||actorProfileId`,
`type="sale"`, `reference_type="sale"`, `reference_id=plannedSaleId::text`,
`note/metadata/return_item_id=null` e occurred/created é o timestamp T2b.
Lot movement usa `quantity_micros=-reservation.quantityMicros`, before do lot
travado e after=before+quantity; `idempotency_key=effectKey`. Stock movement
usa `quantity=-quantityMicros/1000000`, previous/current do estoque físico
travado, warehouse/product/variation do reservation e round-trip obrigatório;
befores/afters variation são null salvo `stockMode="variation"`. Warehouse
ledger usa a mesma quantity float, balances físicos before/after,
warehouse/product/variation do reservation e variation balances somente no
modo variation. Todos os before/after são lidos e escritos na mesma transação
sob CAS contra a reservation congelada; o `actual_hash` business reconstrói
type, quantidade, before/after, actor determinístico, referência e IDs causais
das rows alvo, jamais de label/usuário/BOM mutável.

Se um kind opcional não tem instância, T2a cria exatamente uma entrada com
`effect_key='<kind>:none'`, `P={"present":false}`,
`expected_cardinality=0`, `required=false`. Isso se aplica a
`promotion_redemption,kit_component,tracked_lot_movement,stock_movement,
warehouse_ledger,value_account,value_ledger_entry,value_accrual,
fiscal_document,fiscal_attempt,fiscal_outbox,webhook_delivery`. Para conta de
valor já existente, `value_account` usa sua key/payload normais com
cardinalidade zero; o snapshot aponta a conta. Kind com instâncias não possui
sentinel. Demais entries têm cardinalidade 1 e `required=true`.

T2-02 materializa todas as entries/sentinels. As ondas T2-04..06 não podem
renomear key, mudar projeção ou omitir zero; mudança exige versão v2 explícita.

Para tornar `actual_hash` físico reconstruível, T2-05 adiciona em
`pos_inventory_lot_movements`, `stock_movements` e warehouse ledger as colunas
`manual_application_id uuid,manual_stock_reservation_id uuid,creation_txid
numeric(20,0)`, com FK composta RESTRICT
`(manual_application_id,manual_stock_reservation_id)` para a reservation. Em
`pos_kit_sale_components`, adiciona `manual_application_id,
manual_manifest_entry_id,creation_txid`, FK composta para a manifest entry
`kit_component`; promotion redemption recebe a FK da promotion reservation.
O ramo T2 exige todas não nulas e mesmo apply txid; legado exige todas nulas.

O actual hash é reconstruído das colunas alvo **mais a row ligada por essa FK
imutável**, sob o mesmo txid; join apenas por application, product, lot,
scopeKey ou posição é proibido. Identidade causal, payload inicial e
creation_txid não podem sofrer update/delete. O verifier T2-05 exige essas
colunas/FKs/guards antes de permitir qualquer core além do rollback terminal.

## 4. P0-B — schema de reservas e prova do grafo

T2-02 cria estas seis tabelas. Todos os nomes de constraint abaixo são
contrato e erros públicos continuam sanitizados pelo wrapper.

### 4.1 `pos_manual_application_stock_reservations`

Colunas obrigatórias:

```text
id uuid PK                         -- determinístico, §7
application_id uuid NOT NULL FK RESTRICT
reservation_key text NOT NULL
quote_line_index integer NOT NULL
held_sale_item_id integer NOT NULL FK RESTRICT
component_scope_key text NULL
warehouse_id integer NOT NULL FK RESTRICT
product_id integer NOT NULL FK RESTRICT
variation_id integer NULL FK RESTRICT
lot_id text NULL FK RESTRICT
stock_mode text NOT NULL             -- parent|variation
tracking_kind text NOT NULL        -- none|lot|serial
quantity_micros bigint NOT NULL
state text NOT NULL                -- reserved|consumed|released
version integer NOT NULL DEFAULT 0
parent_reserved_before_micros bigint NOT NULL
parent_reserved_after_micros bigint NOT NULL
variation_reserved_before_micros bigint NULL
variation_reserved_after_micros bigint NULL
lot_reserved_before_micros bigint NULL
lot_reserved_after_micros bigint NULL
reserved_at timestamptz NOT NULL
expires_at timestamptz NOT NULL
reserve_txid numeric(20,0) NOT NULL
consumed_at timestamptz NULL
consume_txid numeric(20,0) NULL
released_at timestamptz NULL
release_txid numeric(20,0) NULL
release_reason text NULL
```

Unicidades: `(application_id,reservation_key)`, `id`, e
`(application_id,id)`. `reservation_key` é:

```text
stock: || H('t2-stock-reservation-key-v1',
 {"applicationId":<uuid>,"componentScopeKey":<string|null>,
  "lotId":<string|null>,"productId":<integer>,"quoteLineIndex":<integer>,
  "schemaVersion":1,"stockMode":"parent"|"variation",
  "variationId":<integer|null>,"warehouseId":<integer>})
```

É sempre ASCII com 70 bytes. Null é JSON null e não sentinel; nenhum ID é
codificado duas vezes.

Checks fechados:

- `quantity_micros BETWEEN 1 AND 9007199254740991`, versão `0|1`;
- `tracking_kind=none` implica `lot_id IS NULL`; `lot|serial` implica lote;
  `serial` exige `quantity_micros=1000000`;
- `stock_mode=variation` exige variation_id e variation befores/afters não
  nulos; `stock_mode=parent` exige variation befores/afters nulos, mesmo quando
  variation_id identifica a linha comercial. Lote befores são ambos nulos sse
  lote é nulo;
- em `reserved`, `version=0`, consume/release nulos; em `consumed`, `version=1`
  e apenas consume preenchido; em `released`, `version=1` e apenas release;
- `expires_at` é exatamente `application.reservation_expires_at`;
- reserva incrementa cada dimensão aplicável exatamente em `quantity_micros`.

O builder `stockMode` é exatamente:

1. `product.type='service'` → `none`;
2. com variation, `variation.manage_stock='false'` → `none`;
3. com variation, `variation.manage_stock='true'` → `variation`, mesmo se
   `product.manage_stock=false`;
4. com variation `parent`, ou sem variation, → `parent` somente se
   `product.manage_stock=true`, senão `none`.

`none` não cria reservation/movement. `parent` faz CAS somente na dimensão
parent (e lote quando aplicável); `variation` faz CAS parent + variation (e
lote quando aplicável), preservando os mesmos deltas micros. Produto estocável
sem cada saldo dimensional exigido pelo mode falha `23514`, sem fallback.

### 4.2 `pos_manual_application_stock_reservation_events`

Append-only: `id uuid PK, reservation_id, application_id, sequence integer,
action, state_before, state_after, quantity_micros,
parent_reserved_before_micros,parent_reserved_after_micros,
variation_reserved_before_micros,variation_reserved_after_micros,
lot_reserved_before_micros,lot_reserved_after_micros,reason_code,
write_txid numeric(20,0),occurred_at`.

`action=reserve|consume|release`, unique `(reservation_id,sequence)` e
`(reservation_id,action)`. Reserve é sequence 0 (`none→reserved`); consume ou
release é sequence 1. Cada par before/after precisa coincidir com a linha
física prelockada e a soma por transação. `id` usa §7 com action/sequence.

### 4.3 Reservas promocionais

`pos_manual_application_promotion_reservations`:

```text
id uuid PK; application_id uuid FK RESTRICT; reservation_key text;
promotion_id text FK RESTRICT; coupon_id text NULL FK RESTRICT;
customer_id integer NULL FK RESTRICT; customer_opaque_id text NULL;
discount_cents integer; policy_hash Hash64; state reserved|consumed|released;
version integer DEFAULT 0; global_used_before integer;
customer_used_before integer; coupon_used_before integer;
global_live_before integer; customer_live_before integer;
coupon_live_before integer; reserved_at; expires_at; reserve_txid;
consumed_at; consume_txid; released_at; release_txid; release_reason.
```

Unique `(application_id,reservation_key)` e no máximo uma linha por application.
`reservation_key = 'promotion:' || H('t2-promotion-reservation-key-v1',
{"applicationId":<uuid>,"couponId":<string|null>,"promotionId":<string>,
"schemaVersion":1})`. É sempre ASCII com 74 bytes; null é JSON null e não
sentinel. `discount_cents>0`.
`customer_id` e `customer_opaque_id` são ambos nulos ou ambos preenchidos.
Estado/versão/txid obedecem à mesma máquina das reservas físicas.

`pos_manual_application_promotion_reservation_events` replica o ledger do
§4.2 e contém, nominalmente, as doze colunas
`global_used_before,global_used_after,customer_used_before,
customer_used_after,coupon_used_before,coupon_used_after,
global_live_before,global_live_after,customer_live_before,
customer_live_after,coupon_live_before,coupon_live_after`, além de
`discount_cents`, action/state/reason, sequence e txid. Todos são inteiros
não negativos. Reserve exige used before=after e cada live after=before+1 na
dimensão aplicável; dimensão customer/coupon ausente tem ambos NULL. Consume
exige live after=before-1 e used after=before+1; release exige live
after=before-1 e used after=before. Nenhum contador pode ficar negativo.

### 4.4 Assertion diferida

`pos_manual_application_reserve_assertions` é 1:1 append-only:

```text
application_id uuid PK; stock_reservation_count integer;
stock_quantity_micros bigint; promotion_reservation_count integer;
stock_multiset_hash Hash64; promotion_multiset_hash Hash64;
reservation_graph_hash Hash64; reserve_operation_id bigint;
reserve_state_event_id bigint; reserve_txid numeric(20,0); created_at.
```

`stock_multiset_hash = H('t2-stock-multiset-v1',
{"reservations":<inventoryReservations[]>,"schemaVersion":1})` e
`promotion_multiset_hash = H('t2-promotion-multiset-v1',
{"reservations":<promotionReservations[]>,"schemaVersion":1})`.
`reservation_graph_hash =
H('t2-reservation-graph-v1', {applicationId,inventoryPromotionHash,
promotionMultisetHash,schemaVersion:1,stockMultisetHash})`.

Constraint trigger `DEFERRABLE INITIALLY DEFERRED` prova no commit: application
pending, dez snapshots, manifesto completo, assertion, todas as reservas e
eventos sequence 0, uma operation `reserve_application`, um state event,
case `application_pending`, mesmo `reserve_txid` e contagens/multisets iguais.
Delete/update de snapshot/assertion/ledger é sempre negado.

`pos_manual_application_release_assertions` é 0:1 append-only e nasce pelo
mesmo producer interno em `sweep_expired` T2-02 ou
`report_boundary_changed` T2-03. Colunas exatas:

```text
application_id uuid PK; release_source text; release_reason text;
source_sweep_batch_id uuid NULL; source_sweep_receipt_id uuid NULL;
source_failure_operation_id bigint NULL; fencing_token_before bigint;
stock_released_count integer; promotion_released_count integer;
stock_release_multiset_hash Hash64; promotion_release_multiset_hash Hash64;
release_graph_hash Hash64; release_operation_id bigint;
release_state_event_id bigint; release_incident_id uuid;
release_txid numeric(20,0); created_at timestamptz.
```

Shape fechado: `sweep_expired/reservation_expired` exige batch+receipt e
failure operation null; `report_boundary_changed/boundary_changed` exige
failure operation e batch/receipt null. No report,
`source_failure_operation_id = release_operation_id`: há uma única operation e
uma única transition/resulting_version, nunca duas operations concorrentes.
IDs causais têm FK RESTRICT e incident referencia o UUID real;
`fencing_token_before>=0`; counts são respectivamente 0..400 e 0..1;
`release_txid>0`; os três hashes são Hash64. Operation/event/incidente e todos
os eventos release têm o mesmo txid/reason/source; depois da transição a
application tem fencing zero, mas assertion/receipt/event guardam o valor
anterior idêntico.

As projeções finais são exatas e ordenadas por `reservationId`:

```text
stockRows[] = {"eventId":<uuid>,"quantityMicros":<positive integer>,
 "releaseReason":"reservation_expired"|"boundary_changed",
 "reservationId":<uuid>,"reservationKey":<string>,"sequence":1,
 "stateAfter":"released"}
promotionRows[] = {"couponLiveAfter":<integer|null>,
 "couponLiveBefore":<integer|null>,"couponUsedAfter":<integer|null>,
 "couponUsedBefore":<integer|null>,"customerLiveAfter":<integer|null>,
 "customerLiveBefore":<integer|null>,"customerUsedAfter":<integer|null>,
 "customerUsedBefore":<integer|null>,"discountCents":<MoneyCents>,
 "eventId":<uuid>,"globalLiveAfter":<integer>,"globalLiveBefore":<integer>,
 "globalUsedAfter":<integer>,"globalUsedBefore":<integer>,
 "releaseReason":"reservation_expired"|"boundary_changed",
 "reservationId":<uuid>,"reservationKey":<string>,"sequence":1,
 "stateAfter":"released"}
stock_release_multiset_hash = H('t2-stock-release-multiset-v1',
 {"reservations":stockRows,"schemaVersion":1})
promotion_release_multiset_hash = H('t2-promotion-release-multiset-v1',
 {"reservations":promotionRows,"schemaVersion":1})
```

Release exige used before=after e live after=before-1 nas dimensões aplicáveis;
NULLs seguem customer/coupon ausente. Constraint diferida prova
application/case blocked, zero reservation `reserved`, exatamente um evento
sequence 1 por reserva antes live, hashes/counts/causalidade e, para sweep, as
contagens/hash do receipt. Application sem release integral não satisfaz
close/handoff. Report T2-03 chama este producer antes de gravar blocked; sweep
não tenta reliberar application já blocked.

## 5. P0-C — ABIs, requests, status e replay

As quatro assinaturas públicas são exatamente:

```sql
public.pos_manual_reserve_application_v1(
  p_case_id uuid,
  p_expected_case_version_before_reserve integer,
  p_actor_profile_id integer,
  p_actor_user_id text,
  p_idempotency_key text,
  p_request_hash text
) returns jsonb

public.pos_manual_application_status_v1(
  p_application_id uuid,
  p_actor_user_id text
) returns jsonb

public.pos_manual_application_status_by_reservation_v1(
  p_case_id uuid,
  p_reserve_idempotency_key text,
  p_reserve_request_hash text,
  p_actor_profile_id integer,
  p_actor_user_id text
) returns jsonb

public.pos_manual_sweep_expired_applications_v1(
  p_sweeper_id text,
  p_limit integer,
  p_idempotency_key text,
  p_request_hash text
) returns jsonb
```

Todos os wrappers públicos são `SECURITY DEFINER`, owner migrator, têm
**exatamente** `SET search_path=pg_catalog`, `PUBLIC` revogado e validam
`session_user` antes de lookup. Toda relation, type e chamada usa nome
fully-qualified, inclusive `public.pos_manual_*_impl_v1`. Um impl interno
separado, sem EXECUTE para qualquer role não-owner, pode usar
`search_path=pg_catalog, public` somente se a linguagem PL/pgSQL exigir tipos
de row públicos; ele nunca é ABI nem grant operacional. Catálogo/contrato
falham se wrapper público contiver `public` no `proconfig`.

### 5.1 Reserve

Request canônico:

```json
{"actorProfileId":1,"actorUserId":"opaque","capability":"public.pos_manual_reserve_application_v1(uuid,integer,integer,text,text,text)","caseId":"00000000-0000-0000-0000-000000000000","expectedCaseVersionBeforeReserve":3,"idempotencyKey":"<IdempotencyKey>","schemaVersion":1,"sessionUser":"<session_user>"}
```

`p_request_hash` precisa ser `H('t2-reserve-request-v1', request)`. Shape é
validado antes de advisory lock/lookup; mesma key com qualquer campo/hash
diferente é `23505 T2 reserve idempotency conflict`. Replay igual retorna o
objeto persistido, com `replayed:true`, sem prolongar TTL e sem escrever.

Retorno reserve tem exatamente as dez chaves da especificação, com `Instant`
em `reservationExpiresAt`. `currentlyApplicable` é recalculado sob os mesmos
locks e é verdadeiro somente se application continua pending/claimed, TTL
live, case/boundaries/profile/gate/prova permanecem válidos e nenhuma reserva
foi liberada. Replay nunca converte false em true.

### 5.2 Status por application

Retorno encontrado sempre tem exatamente estas onze chaves, mas valores seguem
a máquina abaixo:

```json
{"applicationId":"uuid","applicationVersion":0,"blockedCode":null,"caseId":"uuid","caseVersionAfterReserve":4,"currentlyApplicable":true,"failureClass":null,"paymentId":null,"reservationExpiresAt":"Instant","saleId":null,"state":"pending"}
```

| state | `currentlyApplicable` | `saleId/paymentId` | `failureClass` | `blockedCode` |
|---|---|---|---|---|
| `pending` | boolean pós-lock; false se TTL/boundary não live | ambos null | null ou `retryable_internal` | null |
| `claimed` | boolean pós-lock; false se TTL/boundary/lease não live | ambos null | null | null |
| `applied` | false | ambos IDs não nulos | null | null |
| `blocked` | false | ambos null | `boundary_changed` ou `reservation_expired` | Code sanitizado não nulo |

`applicationVersion` e `caseVersionAfterReserve` são os inteiros persistidos,
não literais 0/4; expiry é sempre o instante original, inclusive após
applied/blocked. Combinação fora da linha correspondente é `23514` interno e
nunca é serializada.

Não encontrado ou não autorizado retorna exatamente `{"status":"not_found"}`.
Não há `replayed`, snapshot, proof, referência ou razão dinâmica.

### 5.3 Probe por identidade

Ele recalcula o mesmo request do §5.1 e adquire advisory `reserve` + key antes
do case. Retornos exatos:

```json
{"outcome":"committed_same_request","winner":{...objeto status...}}
{"outcome":"authoritatively_absent","winner":null}
{"outcome":"unknown","winner":null}
```

Somente conexão primária read-write, lock concluído e authority/grants
revalidados podem produzir `authoritatively_absent`. Timeout, cancelamento,
recovery/read-only, erro de lock ou prova incompleta produzem `unknown`.
Conflito conhecido continua `23505`, nunca vira ausência.

### 5.4 Sweep

Request canônico:

```json
{"capability":"public.pos_manual_sweep_expired_applications_v1(text,integer,text,text)","idempotencyKey":"<IdempotencyKey>","limit":1,"schemaVersion":1,"sessionUser":"<session_user>","sweeperId":"opaque"}
```

`limit` é 1..50 e `p_request_hash=H('t2-sweep-request-v1',request)`. O retorno
tem exatamente:

```json
{"applicationCount":0,"batchId":"uuid","caseCount":0,"promotionReservationCount":0,"releaseResultHash":"<Hash64>","replayed":false,"stockReservationCount":0}
```

Até batch vazio é persistido. Replay igual devolve os mesmos campos e IDs com
apenas `replayed:true`; key igual com hash/parâmetro diferente é `23505 T2
sweep idempotency conflict`.

## 6. P0-D — identidades determinísticas

`UUID16(domain,value)` é calculado assim: pegue os primeiros 16 bytes de
`SHA256(UTF8(domain)||0x00||UTF8(C(value)))`; no byte 6 aplique
`(b & 0x0f) | 0x50`, no byte 8 aplique `(b & 0x3f) | 0x80`; formate lowercase
RFC 4122. Não é permitido `gen_random_uuid()` nestas identidades.

- `application_id = UUID16('t2-reserve-identity-v1',
  {caseId,idempotencyKey,schemaVersion:1})`;
- stock reservation row ID = `UUID16('t2-reservation-id-v1',
  {applicationId,reservationKind:"stock",reservationKey,schemaVersion:1})`;
- promotion reservation row ID = `UUID16('t2-reservation-id-v1',
  {applicationId,reservationKind:"promotion",reservationKey,schemaVersion:1})`;
- reservation event ID = `UUID16('t2-reservation-event-id-v1',
  {action,applicationId,reservationKind:"stock"|"promotion",reservationKey,
  schemaVersion:1,sequence})`; reserve fixa `action="reserve",sequence=0` e
  consume/release fixa sequence 1. `reservationKind` impede colisão global,
  mesmo que as PKs estejam em tabelas distintas;
- sweep batch ID = `UUID16('t2-sweep-identity-v1',
  {idempotencyKey,requestHash,schemaVersion:1,sweeperId})`;
- sweep receipt ID = `UUID16('t2-sweep-receipt-id-v1',
  {applicationId,batchIndex,idempotencyKey,schemaVersion:1,sweeperId})`.

`planned_sale_id` vem de uma única chamada owner-only a
`nextval(pg_get_serial_sequence('public.sales','id'))` somente após todos os
locks e imediatamente antes da materialização final. Buraco em rollback/expiry
é permanente. `planned_sale_occurred_at` é o relógio final pós-lock truncado a
seis casas.

```text
planned_sale_number = 'PDV-' || YYYYMMDD_UTC(planned_sale_occurred_at)
                      || '-' || lpad(planned_sale_id::text,10,'0')
```

Se o ID tiver mais de dez dígitos, usa-se o decimal integral, sem truncar.

`sale_idempotency_key = H('t2-sale-idempotency-v1',
{"applicationId":...,"schemaVersion":1})`.
`plannedPaymentId = UUID16('t2-sale-payment-identity-v1',
{"applicationId":<uuid>,"paymentIndex":0,"schemaVersion":1})::text`; T2b
insere `pos_sale_payments.id` com esse texto exato.
`paymentIdempotencyKey = H('t2-sale-payment-idempotency-v1',
{"applicationId":<uuid>,"paymentIndex":0,"schemaVersion":1})` e integra o
snapshot/effect. O INSERT T2b é fechado: `sale_id=plannedSaleId`,
`payment_plan_id=planId`, `payment_index=0`,
`manual_payment_case_id=caseId`, `processing_session_id=sessionId`,
`card_last_four=null`, `authorized_at=captured_at=
plannedSaleOccurredAt`; type/method/status/cents/provider/installments e key
vêm do payment snapshot. `connector_id,original_payment_id,transaction_id,
end_to_end_id,nsu,authorization_code,card_brand,payment_intent_id,
compensation_id,value_reservation_id,value_capture_entry_id,
value_amount_units,refunded_at` são exatamente null. `metadata` é exatamente
`{"evidenceHash":<Hash64>,"manualPaymentCaseId":<uuid>,"observationId":
<positive safe integer>,"provider":<Code>,"referenceLastFour":<ReferenceLastFour>,
"schemaVersion":1}`, com valores do payment/case snapshot; nenhum outro campo
é admitido. `payment.observationId` permanece string decimal canônica, mas o
metadata converte-o para JSON number sem aspas após provar `1..9007199254740991`
e round-trip decimal idêntico. O vínculo causal é `manual_payment_case_id`. `created_at/updated_at` são o timestamp T2b. O
`actual_hash` de sale_payment reconstrói o objeto payment mais `caseId` e
`plannedSaleId` dessas colunas e do case FK imutável, sem reler evidência livre.
`sale_request_hash = H('t2-sale-request-v1', objeto sale do §3.1 sem o próprio
campo requestHash)`. O builder insere então esse hash no objeto sale. Não há
ciclo nem referência manual legada.

## 7. P0-E — isolamento, autocommit e relógio

Reserve e sweep exigem transação `SERIALIZABLE`. Uma função PostgreSQL não
pode elevar isolamento depois que o statement iniciou; portanto o contrato de
executor é:

- pool/DSN **dedicado ao reserve/sweep**, sem alterar o default da role runtime
  geral. A conexão runtime reserve nasce com startup option libpq exatamente
  `-c default_transaction_isolation=serializable -c
  application_name=nalven-pos-manual-reserve-v1`; `_ms` usa
  `nalven-pos-manual-sweep-v1`. O pool não é compartilhado com request SQL
  comum e tem tamanho/timeout próprios;
- exatamente um `SELECT public.<capability>(...)` por conexão em autocommit;
- proibidos `BEGIN`, pipeline, batch, prepared transaction e statement anterior
  na mesma transação;
- sucesso só depois do ACK de COMMIT; resposta da função antes de rollback ou
  desconexão não é sucesso;
- `40001`/`40P01` são propagados e repetidos com a mesma key; timeout/cancel não
  é convertido.

O wrapper também verifica
`current_setting('transaction_isolation')='serializable'` e
`current_setting('transaction_read_only')='off'`, além de `application_name`
exato para sua capability, senão `25001`. O startup packet/default é provado
por teste de conexão nova e `SHOW`, enquanto autocommit/ACK é provado por teste
de desconexão/rollback e telemetria do executor; SQL não alega detectar
autocommit de dentro da função. É proibido `ALTER ROLE runtime SET
default_transaction_isolation`. O relógio de
decisão é recapturado pós-lock; `reserved_at` e sale instant usam esse valor.
`expires_at = reserved_at + make_interval(secs => profile.ttl)`.

## 8. P0-H — política promocional

O JSON fonte `conditions` aceita somente as chaves opcionais
`productIds,categoryIds,minimumQuantity,couponRequired`; listas contêm IDs
inteiros positivos, únicos e ordenados, `minimumQuantity` precisa ter
round-trip exato para micros positivos e `couponRequired` é boolean. O JSON
fonte `effects` aceita exatamente um destes schemas:

```text
{"discountCents":<MoneyCents positivo>,"type":"fixed"}
{"maximumDiscountCents":<MoneyCents positivo|null>,"percentageBasisPoints":<integer 1..10000>,"type":"percentage"}
```

Os três placeholders são JSON numbers, ou JSON null onde indicado, nunca
strings.

Antes de hash, o builder converte para objetos normalizados com todas as
chaves presentes:

```json
{"categoryIds":[],"couponRequired":false,"minimumQuantityMicros":null,"productIds":[]}
{"discountCents":100,"maximumDiscountCents":null,"percentageBasisPoints":null,"type":"fixed"}
{"discountCents":null,"maximumDiscountCents":1000,"percentageBasisPoints":500,"type":"percentage"}
```

Ausência de lista vira `[]`; ausência de boolean vira false; nenhum decimal
entra no objeto normalizado. `policy_hash = H('t2-promotion-policy-v1',
objeto)` onde o objeto tem exatamente `branchId,conditions,coupon,effect,
endsAt,perCustomerLimit,priority,promotionId,schemaVersion,stackMode,startsAt,
status,usageLimit`. `coupon` é exatamente
`{couponId,expiresAt,status,usageLimit}` ou null. Campo desconhecido, ID
duplicado, classe A/B ou shape diferente bloqueia.

No relógio final pós-lock:

```text
live reservation := state='reserved' AND expires_at > now
global use        := non-reversed redemptions + live promotion reservations
customer use      := non-reversed redemptions do customer + live equivalentes
coupon use        := coupon.used_count + live coupon reservations
```

Replay exclui a própria application dos termos live antes de comparar o
snapshot original. `usage_limit` e `per_customer_limit` são limites estritos
após somar a nova unidade. Customer nulo com limite por customer é inelegível.
Coupon precisa pertencer à promoção, estar ativo/live e ter hash/last-four
previamente validado pelo plan; código aberto não entra em T2.

T2a cria reservation, sem redemption e sem incrementar `used_count`. T2b
T2-05 consome a reservation e incrementa `used_count` exatamente uma vez na
mesma transação da redemption. Release nunca decrementa `used_count`. Todos os
writers normais de quote/consume passam a contar reservation live já em
T2-02; caminho que não consiga travar promotion/coupon/reservas na ordem
canônica falha fechado.

### 8.1 Webhook versionado e hashes fechados

T2-02 adiciona a `integration_webhook_endpoints`:
`logical_id text NOT NULL, version integer NOT NULL, config_hash Hash64,
superseded_at timestamptz NULL`, unique `(logical_id,version)` e
`(logical_id,version,config_hash)`, mais unique parcial `(logical_id) WHERE
superseded_at IS NULL`. Backfill transacional usa
`logical_id=id,version=1,superseded_at=NULL` e:

```text
config_hash = H('t2-webhook-config-v1',
 {"apiVersion":api_version,"deliveryUrl":delivery_url,
  "endpointId":logical_id,"secretCipher":secret_cipher,"schemaVersion":1,
  "status":status,"topic":topic,"version":version})
```

URL e cipher só existem na entrada transitória owner-only do hash; snapshot,
manifesto, logs e retorno guardam apenas `config_hash`. Qualquer mudança em
URL, secret, topic, apiVersion ou status **insere** nova row física com mesmo
logical_id e version+1 e marca a anterior superseded; update/delete desses
campos históricos é negado. O hash é recalculado da nova row, nunca copiado.

O único writer versionado adquire advisory por logical_id, trava a current row
`FOR UPDATE`, exige `p_expected_version` e `p_expected_config_hash`, insere
version+1 e marca a antiga `superseded_at` na mesma transação. A unique parcial
impede fork/current dupla; `40001` repete com a mesma idempotency key e stale
CAS é `23514`. Endpoint sem current ou com duas candidates bloqueia. Runtime
T2 não recebe esse writer nem DML.

Payload webhook T2 é exatamente:

```json
{"applicationId":"<uuid>","eventKind":"sale.completed","occurredAt":"<Instant>","sale":{"currency":"BRL","saleNumber":"<Code>","totalCents":100},"schemaVersion":1}
```

`payload_hash = H('t2-webhook-payload-v1', payload)`. Nenhum customer, actor,
URL, header, secret ou referência de pagamento é permitido. T2-06 adiciona à
delivery `endpoint_logical_id,endpoint_version,endpoint_config_hash,
manual_application_id,creation_txid,payload_hash`, FK RESTRICT exata para
`(logical_id,version,config_hash)`, e muda a FK física de `ON DELETE CASCADE`
para `RESTRICT`. Backfill de delivery legado mantém
`manual_application_id/creation_txid/payload_hash` nulos e liga sua versão 1;
o CHECK exige esses campos apenas no ramo T2. Identidade/payload inicial T2 são
imutáveis; só attempts/state/response allowlisted mudam.

## 9. P0-G — `required_queue`

T2-02 não inventa envelope nem faz I/O. Uma reserve cujo profile tenha
`fiscal_mode='required_queue'` termina, pós-lock e antes de sequence/qualquer
write, com `23514 T2 required fiscal envelope is unavailable`. Não cria
application, reserva, operation, evento ou incidente.

T2-06 instala protocolo causal em duas fases; o serviço externo nunca prevê
sequence nem relógio da sale.

**Prepare, antes de T2a.** O serviço fiscal isolado cria envelope cifrado e row
`pos_manual_fiscal_envelopes` com `envelope_id uuid,state='prepared',branch_id,
draft_id,draft_revision,draft_request_hash,profile_id,profile_version,
policy_hash,locator,version,envelope_hash,prepared_hash,expires_at,
associated_plan_id NULL,associated_at NULL,association_txid NULL,
bound_application_id NULL,planned_sale_identity_hash NULL,binding_hash NULL,
bound_txid NULL,consumed_at NULL,consume_txid NULL,released_at NULL,
release_txid NULL,release_reason NULL,creation_txid,created_at`. Locator é opaco 1..256 bytes;
version positiva; hashes Hash64; plaintext, chave, bearer e PII são proibidos.

```text
prepared_hash = H('t2-fiscal-envelope-prepare-v1',
 {"branchId":<integer>,"draftId":<OpaqueId>,"draftRequestHash":<Hash64>,
  "draftRevision":<integer>,"envelopeHash":<Hash64>,"envelopeId":<uuid>,
  "envelopeLocator":<OpaqueId>,"envelopeVersion":<integer>,
  "expiresAt":<Instant>,"fiscalPolicyHash":<Hash64>,
  "fiscalProfileId":<OpaqueId>,"fiscalProfileVersion":<integer>,
  "schemaVersion":1})
```

T2-06 adiciona ao payment plan `fiscal_envelope_id uuid,
fiscal_envelope_prepared_hash Hash64`; o producer owner-only associa por CAS ao
plan/draft/profile exatos antes da confirmação manual e grava
`associated_plan_id/associated_at/association_txid` na row envelope na mesma transação. Unique
parcial em `associated_plan_id WHERE state IN ('prepared','bound')` garante um
envelope live por plan, e unique parcial de `envelope_id` no plan impede um
envelope em dois plans; plan active torna a associação imutável.
O ABI reserve não recebe locator/ID do caller.

Desde o COMMIT de prepare, `branch,draft/revision/request hash,profile/version/
policy,locator,version,envelope_hash,expires_at,prepared_hash` são imutáveis;
somente state/binding/consumption mudam pelas capabilities fechadas. Assim CAS
por `envelope_id+prepared_hash` detecta qualquer diferença de locator ou TTL.
State é enum fechado `prepared|bound|consumed|released`; `creation_txid>0` é
imutável. Os três campos association são todos nulos ou todos não nulos e seu
txid é positivo. `prepared` exige campos bind/consume/release nulos; `bound`
exige associação, application/identity/binding/bound_txid e consume/release
nulos; `consumed` preserva bind, exige `consumed_at+consume_txid` e deixa os
três release nulos; `released` preserva bind, exige
`released_at+release_txid+release_reason` e deixa consume nulo. Txids de cada
transição são positivos e `release_reason` é
`reservation_expired|boundary_changed`. Consumed/released nunca voltam a live;
consume e release são mutuamente exclusivos.

**Bind, dentro de T2a.** Depois de todos os locks e da alocação de
application/planned sale, o producer SQL interno (sem grant) trava a row
prepared referenciada pelo plan, revalida prepare/TTL/profile/draft e atualiza
na própria transação reserve:

```text
planned_sale_identity_hash = H('t2-fiscal-envelope-identity-v1',
 {"applicationId":<uuid>,"plannedSaleId":<integer>,
  "plannedSaleNumber":<Code>,"plannedSaleOccurredAt":<Instant>,
  "schemaVersion":1})
binding_hash = H('t2-fiscal-envelope-binding-v1',
 {"applicationId":<uuid>,"envelopeId":<uuid>,
  "plannedSaleIdentityHash":<Hash64>,"preparedHash":<Hash64>,
  "schemaVersion":1})
```

A row vira `state='bound'`, grava application/identity/binding/bound_txid e não
pode ser ligada novamente. Rollback de reserve desfaz o bind e a alocação de
sequence pode deixar buraco normal. Replay exige o mesmo bind/hash; envelope
bound a outra application é conflito. **A mesma transação T2a**, depois do
bind, materializa o documento fiscal append-only completo do §3.1 e seus
manifest entries; bind sem snapshot ou snapshot sem bind aborta na constraint
diferida. T2b T2-06 apenas relê/revalida a row bound contra o snapshot, muda
bound→consumed e cria document/attempt/outbox same-tx; nunca cria ou altera
snapshot T2a. Release antes de apply muda bound→released causalmente, sem
reutilizar. `not_applicable` usa null em todos esses campos.

T2-06 substitui atomicamente apenas o ramo de rejeição por prepare/bind e pelos
três manifest entries fiscais. Até registry, associação, adapter, DLP,
producer same-tx e testes prepare/bind/replay/rollback/release estarem verdes,
`required_queue` permanece external-blocked e não conta como T2-02.

## 10. P0-I — sweep, fairness e liberação causal

T2-02 cria:

`pos_manual_application_sweep_batches`: `id uuid PK,idempotency_key,
request_hash,sweeper_id,sweeper_hash,requested_limit,caller_role,
application_count,case_count,stock_reservation_count,
promotion_reservation_count,release_result_hash,write_txid,created_at`, unique
global `idempotency_key` e `request_hash`; append-only.

`sweeper_hash = H('t2-sweeper-subject-v1',
{"schemaVersion":1,"sweeperId":sweeperId})`; ele não substitui a comparação
do `sweeper_id` imutável no replay e nunca é usado como autoridade.

`pos_manual_application_sweep_receipts`: `id uuid PK,batch_id,batch_index,
application_id,application_version_before,application_version_after,case_id,
case_version_before,case_version_after,fencing_token_before,
stock_reservation_count,
promotion_reservation_count,release_graph_hash,write_txid,created_at`, unique
`(batch_id,batch_index)` e `(batch_id,application_id)`; append-only.
`fencing_token_before>=0` e precisa ser igual ao valor na release assertion,
operation, state event e incident causal; esses objetos ganham a coluna causal
homônima na migration que os produz.

Algoritmo exato por batch:

1. shape/hash, advisory por `sweep`+key e replay;
2. persiste o batch ainda aberto na mesma transação;
3. em cada rodada, seleciona sessions com application `pending|claimed`
   expirada, ordenadas por `(min(reservation_expires_at),session_id)`, e trava
   no máximo o espaço restante com `FOR UPDATE OF session SKIP LOCKED`;
4. para cada session travada em ordem, seleciona uma application por
   `(reservation_expires_at,application_id)`, trava o grafo inteiro na ordem
   canônica e relê TTL/estado;
5. se ainda expirada, libera todas as reservas `reserved`, escreve eventos
   sequence 1, move application para `blocked` com
   `failure_class='reservation_expired'` e
   `blocked_code='reservation_expired'`, incrementa versão, cria operation
   `sweep_expired_application`, state event e incidente sanitizado, e move o
   case `application_pending→blocked` com uma versão;
6. repete rodadas, no máximo uma application por session por rodada, até o
   limit ou uma rodada sem progresso;
7. fecha contagens/hash e commit, mesmo com zero receipts.

Claimed expirada é elegível independentemente do lease; sweep zera
`claim_token_hash,claim_expires_at,claimed_by_hash,claimed_at` **e
`fencing_token=0`**, preservando o fencing anterior somente no receipt/event.
Isso satisfaz o CHECK T2-00 do ramo blocked sem claim e aplica a shape de
blocked definida pela migration da onda.
Nenhuma sale/payment/effect é criada. `release_graph_hash =
H('t2-release-result-v1',
{"applicationId":<uuid>,"caseVersionAfter":<integer>,
"promotionReservationIds":[<uuid>],"schemaVersion":1,
"stockReservationIds":[<uuid>]})`, arrays ordenados por bytes do UUID. O batch
`release_result_hash` usa `H('t2-sweep-result-v1',
{"batchId":<uuid>,"receipts":[{"applicationId":<uuid>,
"batchIndex":<integer>,"caseId":<uuid>,"fencingTokenBefore":<integer>,"receiptId":<uuid>,
"releaseGraphHash":<Hash64>}],"schemaVersion":1})`; receipts ordenam por
batchIndex e batch vazio usa `receipts:[]`, nunca hash nulo.

Close/handoff/plan-release obedecem exatamente:

- case `confirmed_paid` **sempre bloqueia**, exista application ou não;
- case `application_pending` bloqueia se falta assertion integral, se a
  application é `pending|claimed` live, ou se qualquer reservation segue
  `reserved`;
- case/application `blocked` deixa de bloquear somente quando uma assertion de
  release integral prova zero stock/promotion reservations em state reserved,
  ledgers sequence 1 completos, operation/event/incidente e mesmo release txid;
- `applied` segue as regras normais pós-venda e não é liberado por sweep.

Logo expiry liberada deixa de prender sessão sem transformar
`confirmed_paid` em estado liberável e sem ignorar pending incompleto.

## 11. P0-F — único harness efêmero, test-only e fail-closed

`withEphemeralManualGate` existe somente em `tests/helpers`; não é exportado
por código runtime, seed, migration ou package público. É o único código de
teste autorizado a alterar o HARD-OFF. `DISABLE TRIGGER`, `session_replication_role`,
superuser, DML ad hoc de gate e nested harness são proibidos.

Precondições cumulativas, antes de qualquer mudança:

1. `session_user` é o migrator esperado e não é runtime/_ms;
2. database casa `^nalven_t2_ephemeral_[0-9a-f]{16,32}$`;
3. `current_setting('nalven.ephemeral_test_database',true)` é exatamente o
   SHA-256 lowercase do nome do database e veio de `ALTER DATABASE`, não de
   `SET` da sessão; a origem é provada consultando `pg_db_role_setting` para o
   OID do database, exigindo uma única entrada byte-idêntica e nenhuma entrada
   por role que sobrescreva essa chave;
4. database não é template, não aceita conexão pública e só possui conexões do
   harness/executores esperados;
5. T2-00/T2-01/T2-02 checksums são os aceitos, gate está false, não há
   application e o checksum da hard-guard é o esperado;
6. advisory lock exclusivo database-wide do harness foi obtido.

O harness instala uma overlay SQL **test-only** owner-only, checksumada, com
scope aleatório 256-bit, connector exato, PID criador e expiry máxima de dez
minutos. A overlay troca a hard-guard somente no database efêmero: habilitar é
aceito apenas para connector do scope live; reserve também exige o mesmo scope
live. A tabela overlay não concede privilégio a runtime/_ms/PUBLIC. O callback
recebe clientes dedicados já vinculados ao scope e envolve a jornada inteira;
não há API `open/close` exposta ao teste.

Em `finally`, inclusive exception/cancelamento: desabilita o gate, invalida o
scope, restaura a definição/checksum original da hard-guard, remove overlay,
libera conexões/lock e abre uma conexão nova para provar gate false, ausência
de scope e reserve negada. Falha no cleanup destrói o database efêmero e falha
o teste; não tenta reaproveitá-lo. TTL expirada faz reserve falhar mesmo se o
processo morrer. Nenhuma parte desse mecanismo é instalável em produção.

## 12. P0-J — abertura controlada do slot manual

A T2-01 mantém slot manual hard-disabled. T2-02 substitui apenas esse ramo:
um plan pode transicionar `quoted→active` com a única slot manual se, sob os
locks canônicos, todas as condições seguintes existirem:

- exatamente uma slot index 0, 100% do total, proof `manual`;
- connector/credential/gate/revisions/profile T2 exatos e ativos;
- reserve/status e sweep íntegros no catálogo da onda;
- gate habilitado e, em testes, scope efêmero live do §11;
- plan/draft/quote/session/terminal/actor/grants live.

Fora desse conjunto retorna o erro hard-disabled vigente. Ativar plan não cria
case/application/reserva e não concede autoridade. Gate false em conexão nova
continua negando slot manual.

## 13. P1 fechado na mesma onda

1. **Micros sobre floats.** Ao ler float legado, exija valor finito,
   `abs(x)<=9007199254.740991` e `round(x*1e6)=x*1e6`; converta a bigint. Ao
   escrever projeção, use `micros/1e6` e releia exigindo round-trip idêntico.
   Decisão, CAS e hash usam bigint. T2-02 incrementa reserved parent/variation
   em float apenas por essa projeção; T2-05 faz cutover/dual-write integral
   antes de gate real.
2. **Disponibilidade.** `available=quantity-reserved`, incluindo reservas T2
   live já incorporadas ao reserved balance. Nenhum writer soma a tabela T2 de
   novo. Saldo/lote negativo falha. Série é unidade exata e distinta.
3. **FEFO.** Data de negócio vem da branch/timezone congelada no profile
   operacional; lote elegível tem status/bucket sellable, não expirado nessa
   data e saldo suficiente. Ordem `(expires_on NULLS LAST,received_at,id)`.
4. **Boundary de webhook.** T2-02 adiciona `version>0` e `config_hash Hash64`
   imutáveis a endpoint e passa a versionar qualquer edição; endpoint
   referenciado não é apagado. URL/secret não entram em snapshot.
5. **Authority proof.** Status/probe exigem profile/user e grants originais
   ainda live; application alheia é `not_found`. `_ms` não ganha SELECT para
   descobrir backlog: a function owner-only faz a seleção.
6. **Reason/error.** `release_reason` é apenas `reservation_expired|
   boundary_changed`; T2-02 sweep usa o primeiro. Mensagem pública é fixa.
   Incidente contém códigos/hashes/IDs opacos, nunca valor concorrente ou
   constraint/detail/hint.
7. **Limites.** Até 200 quote lines, 200 folhas BOM, 500 roots BOM examinadas,
   400 reservas físicas (splits FEFO inclusos), uma promoção, quatro postings e
   32 programas value active e 100 endpoints. Excesso é `22023 T2 reserve graph exceeds limit` antes de
   write.
8. **Imutabilidade temporal.** `reserved_at`, expiry, planned sale identity,
   snapshots, manifesto e assertion nunca mudam. Sweep só muda state/version e
   campos de release/claim explicitamente previstos.
9. **Replay não aplicável.** Replay de reserve expirada/liberada retorna o
   winner com `currentlyApplicable:false`; jamais recria, estende ou troca key.
10. **Required queue.** O bloqueio §9 é parte do contrato, não TODO silencioso.

## 14. Roles, grants, triggers e producers

T2-02 reconcilia a authority `manual_sweeper` sem fallback para `runtime`.
Qualquer helper `pos_manual_t2_write_authority_capability_v1` precisa mapear
explicitamente `sweep_expired_application→manual_sweeper`; capability
desconhecida falha `42501`, nunca recebe default.

| sujeito | EXECUTE novo exato | novas relações/sequences T2-02 |
|---|---|---|
| runtime | reserve + dois status + cinco ABIs boundary do §3.3.1, somente após gate de saída T2-02 | zero DML/SELECT, zero sequence |
| `_ms` | sweep | zero DML/SELECT, zero sequence |
| migrator | owners/helpers internos | conforme owner, sem uso operacional |
| `_mf`, `_mcc`, `_mr`, demais roles, PUBLIC | nenhum | nenhum novo |

“Zero DML/SELECT/sequence” nesta tabela significa zero ACL nas relações e
sequences **novas de T2-02**. Não revoga o ACL legado reconciliado que o runtime
já possui em `products`, `product_variations`, suas relações de catálogo e
sequences. O catálogo é deliberadamente two-step: a ABI abre roots/retorna o
plano e o Prisma consome esses roots com o DML legado na mesma transação.
Mesmo com ACL, qualquer INSERT/UPDATE/DELETE boundary sem root exato falha
`42501`; replay retorna o plano persistido e o wrapper não executa DML.

`_ms` é LOGIN, `NOINHERIT`, `NOBYPASSRLS`, sem membership, sem ownership e com
`default_transaction_isolation=serializable`; credential/processo/unit
isolados e rotação são evidência de saída. A role não recebe reserve/status.

Triggers necessários:

- guard capability-root em application e reservas;
- append-only de snapshots, manifesto, assertion e ledgers;
- state-machine/imutabilidade de reservation/application;
- guard de balances/lots/promotion para writers normais e T2;
- constraint diferida do grafo de reserve/release;
- temporal guard do case/session/plan, sem adquirir root.

Producers internos sem grant:

- builder dos dez snapshots e manifesto;
- expander BOM/tracking/FEFO;
- reserve/release stock com CAS micros;
- reserve/release promotion;
- assertion/multiset verifier;
- state/operation/incident do reserve e sweep.

Trigger não executa `FOR UPDATE/SHARE`, não chama lock helper e não decide
boundary. Writer prelocka tudo na ordem congelada.

## 14.1 Matriz física normativa dos 22 effects

Esta subseção prevalece sobre qualquer abreviação anterior. Para todo kind,
`actual_hash` serializa **exatamente o mesmo P** da tabela §3.4; coluna técnica
adicional é validada por constraint/guard, mas não é acrescentada a P. Toda row
materializada recebe `manual_application_id`, `manual_manifest_entry_id` e
`creation_txid` (ou uma effect row companion com esses campos), FK composta
RESTRICT para `(application_id,manifest_entry_id,effect_kind,effect_key)` e é
criada no mesmo txid. Não é permitido localizar por posição ou reler mutable.

- `sale`: além de P, grava `source_creation_txid=creation_txid`,
  `manual_payment_application_id=applicationId`; notes/cancel/refund fields são
  null, timestamps são T2b e defaults não comerciais são os do schema.
- `sale_item`: T2-04 adiciona `manual_manifest_entry_id bigint NOT NULL UNIQUE`
  e FK para a entry `sale_item:<lineIndex>`; `lineIndex` é reconstruído da
  entry imutável. `scan_data=null`, `returned_quantity=0` e
  `returned_quantity_micros=0`. Sale item e entry compartilham application e
  creation txid.
- `sale_payment`: o guard deve aceitar `status='manual_confirmed'`, connector
  e `card_last_four` null, e o metadata canônico exato do §6; qualquer rejeição
  mantém T2-04 revert-only.
- `plan_consume`: before é `state='active',version=planVersion`; after
  é `state='consumed',version=planVersion+1,consumed_sale_id=plannedSaleId,
  consumed_at=plannedSaleOccurredAt,lifecycle_txid=creationTxid`. T2-04 cria
  operation row immutable ligada à manifest entry contendo before/after; P é
  reconstruído dela, nunca do before perdido.
- `draft_convert`: before é exatamente `status=draft_quote_slot.draftStatus`
  em `{'draft','held'},revision=draftRevision`. Ambos os estados usam after
  `status='converted',revision=draftRevision+1`. `pos_held_sales` não recebe
  campos inexistentes de consume; operation companion immutable guarda
  plannedSaleId/consumedAt/creationTxid e, com manifest FK, sela before/after.
- `sale_event`: target recebe `sale_id=plannedSaleId,type=eventKind,
  actor_id=actorUserId,actor_name=actorNameLabel,correlation_id=applicationId,
  causation_id=caseId,data={applicationId,caseId},created_at=occurredAt`.
  Companion causal unique por manifest entry permite reconstruir P.
- `audit_event`: `actor_id=actorUserId,action='manual_application_applied',
  entity_type='sale',entity_id=plannedSaleId::text,
  correlation_id=applicationId,before_data=null,after_data` é exatamente o
  objeto after de P acrescido de `actorProfileId` e
  `eventKind='manual_application_applied'`; `created_at=plannedSaleOccurredAt`.
  A companion causal guarda actorProfileId/eventKind e sela a reconstrução.
- `promotion_redemption`: target recebe promotion/coupon da reservation,
  `sale_id=plannedSaleId,customer_id=sale.customerId,
  discount_cents=reservation.discountCents,snapshot=reservation`, reversal
  fields null. FK composta à promotion reservation e manifest entry sela
  application/creation txid; customer vem do snapshot sale, não de lookup.
- `kit_component`: `snapshot=component`, sale_item vem da manifest entry da
  root line, `returned_micros=0`; IDs, unit/total micros e FK são os do §3.1.
- `tracked_lot_movement`, `stock_movement` e `warehouse_ledger`: constraints
  validam type/actor/reference/before/after descritos no §3.4, porém
  `actual_hash` reconstrói somente o P registrado (`deltaMicros`, planned sale,
  reservation e, no warehouse, entryType). `sale_item_id` vem da entry da root
  line; return IDs, note e metadata são null; lot idempotency é effectKey.
- `value_account`: create usa timestamps T2b, version 0 e conflito da unique
  `(program_id,customer_id)` só é replay se ID/projeção iguais; senão boundary.
- `value_ledger_entry`: alvo usa `type='credit'` (o `entryType='earn'` existe
  somente em P). A projeção interna inclui também `operationKey`; T2b deriva
  integralmente a row ledger do accrual + account snapshot conforme §3.1, mas
  `actual_hash` reconstrói exatamente `{"accrual":...,"entryType":"earn",
  "plannedSaleId":...}` via ledger/companion FK, não a projeção interna.
- `value_accrual`: `pos_value_accrual_effects` tem CHECK `amount_units>0`,
  `creation_txid>0`, `effect_kind='value_accrual'`; unique globais em
  `manifest_entry_id`, `ledger_entry_id` e `entry_key`; FKs RESTRICT para
  application, manifest entry composta, ledger entry criada pela mesma
  application/txid, program e planned sale. Replay exige a mesma ledger row.
- `accounting_journal/posting/export_outbox`: mappings do §3.3 são completos;
  actual P usa journal/source/posting congelados. Outbox inicia claim/error/
  external/response/exported/completed null e created/updated no T2b.

T2-06 não altera `profile.next_number` ativo. Cria
`pos_fiscal_number_counters(profile_id text,profile_version integer,series
integer,next_number integer,revision integer,updated_txid numeric NOT NULL,
PRIMARY KEY(profile_id,profile_version),UNIQUE(profile_id,profile_version,
series))`, com CHECKs positivos e FK RESTRICT ao profile version, e
`pos_fiscal_number_allocations(id uuid PRIMARY KEY,application_id uuid NOT NULL
UNIQUE,profile_id text NOT NULL,profile_version integer NOT NULL,series integer
NOT NULL,number integer NOT NULL,creation_txid numeric NOT NULL,
UNIQUE(profile_id,profile_version,series,number))`, FK RESTRICT ao counter,
application e envelope binding. `id=UUID16('t2-fiscal-number-allocation-identity-v1',
{applicationId,profileId,profileVersion,schemaVersion:1})`.

Na ativação/migration T2-06 owner-only, profile local inativo recebe counter
inicial `series=profile.series,next_number=profile.next_number,revision=1` sob
lock; não há backfill de profile active local porque o guard vigente prova que
ele não pode existir. T2-06 substitui nominalmente
`validate_pos_fiscal_profile_context` somente para admitir local quando counter
correspondente existe, mantendo profile/series/next_number imutáveis, e mantém
`protect_pos_fiscal_profile` sem permissão de incrementar profile. T2a trava o
counter, reusa allocation da mesma application se id/shape iguais; senão
insere o current next_number e incrementa counter/revision na mesma transação.
Rollback desfaz ambos (sem gap); após commit o número nunca é reutilizado e
falha posterior deixa gap permanente. Divergência de replay é `23505`.

Fiscal required_queue usa as identidades exatas:

```text
documentId=UUID16('t2-fiscal-document-identity-v1',{applicationId,documentModel,purpose:"issue",revision:1,schemaVersion:1})::text
documentIdempotencyKey=H('t2-fiscal-document-idempotency-v1',{applicationId,documentId,schemaVersion:1})
documentRequestHash=H('t2-fiscal-document-request-v1',{applicationId,documentId,envelopeBindingHash,saleSnapshotHash,schemaVersion:1})
attemptId=UUID16('t2-fiscal-attempt-identity-v1',{documentId,sequence:1,schemaVersion:1})::text
operationKey=H('t2-fiscal-attempt-operation-v1',{attemptId,documentId,operation:"issue",sequence:1,schemaVersion:1})
attemptRequestHash=H('t2-fiscal-attempt-request-v1',{attemptId,documentRequestHash,schemaVersion:1})
providerIdempotencyKey=H('t2-fiscal-provider-idempotency-v1',{attemptId,connectorId,operation:"issue",schemaVersion:1})
```

`saleSnapshot` é exatamente `{sale:<sale>,saleItems:<saleItems>,schemaVersion:1}`
e `saleSnapshotHash=H('t2-snapshot-component-v1',saleSnapshot)`. Document grava
sale/branch/register/session/operator/terminal, connector/credential/profile,
`purpose='issue',revision=1,status='queued',version=0`, model/environment/
provider/numberingOwner/series/number do fiscal bound, currency BRL e total;
provider/result/cancel/authorize fields são null e
`next_reconcile_at=plannedSaleOccurredAt`. Attempt grava
sequence 1, operation issue, state queued, dispatch 0, unknown false, reason/
response/failure/timestamps null. Fiscal outbox liga attempt, state pending,
counts 0/8, nextAttemptAt=plannedSaleOccurredAt e claim/error/completed null.
Os três targets recebem application/manifest/creation txid causal.

Webhook usa:

```text
eventId=UUID16('t2-webhook-event-identity-v1',{applicationId,endpointId,endpointVersion,eventKind,topic,schemaVersion:1})::text
deliveryId=UUID16('t2-webhook-delivery-identity-v1',{endpointId,eventId,schemaVersion:1})::text
```

`endpoint_id=endpointRowId`; payload é exatamente o objeto cujo hash é o
`payloadHash` congelado no snapshot, não é relido/recriado. Delivery grava
eventId/topic/payload, attempts 0, state pending,
`next_attempt_at=created_at=plannedSaleOccurredAt`, response/duration/delivered
null e application/manifest/creation txid. Unique `(endpoint_id,event_id)` só
é replay quando deliveryId, version/configHash e payloadHash coincidem; FK
legacy permanece RESTRICT para endpointRowId e a FK T2 composta sela logical
endpoint/version/config.

## 15. Matriz focada de aceite T2-02

Sem smoke test. A suíte focada PostgreSQL/contrato precisa provar:

- 20 reserves autocommit iguais: uma application, uma transição e uma reserva
  por efeito; conflito semântico `23505`;
- lost ACK + probe nas três saídas; réplica/timeout dão `unknown`;
- último saldo parent/variation, FEFO, lote, série e cupom sob 20 concorrentes;
- micros no limite, fração inexata, NaN/infinito e overflow;
- service/sem controle não reserva; kit multinível/ciclo/limites/multiset;
- promoção global/customer/coupon incluindo reservas live, replay próprio,
  release sem alterar `used_count`;
- sweep vazio persistido/replay exato/conflito; duas sessões com `limit=1`
  progridem; uma sessão quente não monopoliza rodadas;
- expiry libera todo o grafo, bloqueia causalmente, não cria sale/payment/effect
  e deixa close/handoff avançar;
- SERIALIZABLE obrigatório, rollback/desconexão/falha deferred deixam zero
  efeitos e COMMIT ACK é requisito;
- snapshot por path rejeita campo extra, classe A/B, decimal, ordem ambígua e
  hash divergente; vetores SQL/TypeScript idênticos;
- `required_queue` falha antes de write; `not_applicable` homologado funciona;
- endpoint edit/revoke, profile retire, gate off, session/terminal/grant/draft/
  plan/quote/case/proof concorrentes vencem pelo lock e revalidação;
- catálogo/ACL: runtime e `_ms` só assinaturas exatas, zero DML, cross-denials;
- cinco boundary writers: request/hash/replay byte-exatos; stale CAS, role,
  isolamento, root faltante/sobrando, DML histórico e DELETE proibido falham;
  updates não-boundary de stock/cost/métricas/failure_count continuam verdes;
- catálogo graph cria/altera/mantém/remove variation com IDs retornados e recusa
  remoção referenciada; value put/deactivate, period close DB-clock e webhook
  create/update/revoke/rotate preservam revision/version/config hash e replay;
- harness falha fechado para nome/marker/checksum/role/connector incorretos,
  nested/timeout/crash; nova conexão sempre confirma HARD-OFF;
- fresh database e clone representativo sem dados T2; checksum da migration e
  artefatos publicados antes de T2-03.

## 16. Dependências para as ondas seguintes

- T2-03 consome `application/session/expiry/snapshot/manifest` e não muda IDs,
  request de reserve, reservations ou sweep; claim ignora expiradas.
- T2-04 usa planned sale identity e projeções comerciais exatamente como
  congeladas; core continua revert-only.
- T2-05 consome a própria reserva, materializa os efeitos físicos/promocionais
  e completa micros/dual-write global; não recalcula melhor oferta ou FEFO.
- T2-06 instala fiscal envelope/producer, accounting/webhooks same-tx e prova o
  manifesto integral antes de remover o guard terminal.

Não resta decisão executável P0/P1 aberta para escrever T2-02. A única
pendência deliberada é externa e já decidida: `required_queue` permanece
fail-closed até T2-06. A migration continua bloqueada enquanto T2-01 não for
declarada `SAFE` com evidência.
