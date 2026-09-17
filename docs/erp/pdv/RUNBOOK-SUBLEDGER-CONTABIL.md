# Runbook — subledger contábil do PDV (POS-1103)

## Status: PARTIAL, desabilitado por padrão

A migration `20260829290000_pos_accounting_subledger` e o serviço `pos-accounting-subledger.ts` entregam a fundação imutável/double-entry. Isso **não habilita** contabilização automática do PDV. A migration é sem seed de contas, mappings, policies ou períodos; portanto o producer falha fechado até a homologação explícita pelo contador responsável.

Nenhuma rota de venda, cancelamento, devolução, caixa, estoque, fiscal, conciliação ou conta de valor foi integrada nesta etapa. O módulo legado `FinancialAccount`/`AccountEntry` não é plano de contas: usa `Float`, saldo mutável e finalidade de caixa/banco. Ele não é fallback do subledger.

## Invariantes

- cada versão da origem possui identidade única `(origin_type, origin_id, origin_version)` e uma chave idempotente vinculada ao request hash;
- journal registra filial, centro de custo, competência, período, moeda BRL, policy/hash e snapshot/hash da origem;
- cada posting usa cents `BIGINT` e `DECIMAL(20,2)` exato, com FK para conta e mapping da mesma policy;
- conta, direção e snapshots da conta vêm do mapping homologado; o caller não escolhe conta nem direção;
- trigger diferido exige ao menos dois postings, total de débitos igual ao de créditos e totais iguais aos campos imutáveis do journal;
- `creation_txid` exige que journal, postings e outbox nasçam na mesma transação; não é possível anexar postings depois;
- período fechado não reabre e rejeita lançamento retroativo; competência precisa estar dentro do mês aberto;
- journals/postings nunca sofrem `UPDATE`/`DELETE`; correção é outro journal que espelha exatamente contas, mappings, valores e inverte direções;
- exportação possui outbox mutável separado; estado de exportação nunca altera o journal;
- snapshots/dimensions rejeitam PAN, campos secretos, PII, e-mail, JSON indefinido e números não finitos.

## Fontes projetadas, não conectadas

| Source type | Snapshot autoritativo esperado | Dependência antes da integração |
|---|---|---|
| `sale` | versão da venda, totais e IDs dos pagamentos | regra de receita, recebíveis, descontos e acréscimos homologada |
| `refund_compensation` | compensação aplicada, pagamento original/refund e evidence hash | contas compensatórias e competência da devolução |
| `cash_ledger` | entrada imutável, caixa/turno, tipo e delta | política distinta para abertura, venda, suprimento, sangria, ajuste e reversão |
| `inventory_cogs` | movimentos de warehouse, quantidade microscópica e custo em cents | critério de custo/CMV e tratamento de descarte/quarentena |
| `fiscal_tax` | documento fiscal/version/status e fatos tributários | apuração ICMS/PIS/COFINS/ISS conforme regime e contador |
| `mdr` | linha conciliada, bruto, tarifa e líquido | política por adquirente/evento de liquidação |
| `value_account` | ledger de gift/loyalty/store credit e valor monetário | classificação de passivo/receita e momento de reconhecimento |

Os builders dessas fontes apenas removem ambiguidade e produzem hash canônico. Eles não geram posting nem escolhem contas.

## Implantação e homologação

1. Aplicar migrations em ordem, preservando `20260829270000_pos_cash_ledger_custody` e `20260829280000_pos_order_claim` antes de `20260829290000_pos_accounting_subledger`.
2. Cadastrar `PosAccountingAccount` com códigos reais do plano aprovado; não copiar automaticamente `FinancialAccount`.
3. Criar uma policy `draft` por filial/versão e mappings semânticos para cada source type necessário.
4. Revisar natureza, direção, competência, centro de custo e casos de reversão com o contador.
5. Ativar somente via `activatePosAccountingPolicy`, informando referência de aprovação e responsável. O serviço recalcula o hash canônico dos mappings e recusa conta inativa.
6. Criar períodos mensais BRL e validar o centro de custo da filial.
7. Executar os testes unitários, contratuais e PostgreSQL concorrentes desta frente.
8. Em banco de homologação, comparar journals/export contra lançamentos esperados pelo contador para venda, refund, caixa, CMV, impostos, MDR e valores.
9. Somente depois criar producers transacionais junto das origens e habilitá-los por feature flag por filial/source type.

Não habilitar produção com policy parcial, mapping genérico, conta transitória inventada, período ausente ou aprovação verbal. A ausência de mapping deve continuar produzindo erro e nenhuma escrita contábil.

## Fechamento e reversão

`closePosAccountingPeriod` adquire lock exclusivo no período. Inserts comuns obtêm `FOR KEY SHARE`, então fechamento e lançamento concorrentes são serializados: ou o lançamento fecha no período ainda aberto, ou é recusado depois do fechamento.

`reversePosAccountingJournal` exige período aberto para a competência da reversão e cria uma nova origem `accounting_reversal`. A policy/conta pode já estar retirada de uso, pois a reversão copia o snapshot histórico e inverte exatamente o original; o centro de custo e a filial permanecem os mesmos. Só uma reversão total é permitida por journal nesta fundação.

Reabrir período, editar posting, corrigir conta por SQL, apagar journal ou marcar exportado sem confirmação do destino são operações proibidas.

## Evidência e comandos

- unitário: `npm run test:pos:accounting`;
- contrato: `tests/pos-accounting-subledger-contract.test.ts`;
- PostgreSQL: `npm run test:pos:accounting:postgres` com `POS_TEST_DATABASE_URL`;
- Prisma: `TENANT_DATABASE_URL=... npx prisma validate --config prisma.tenant.config.ts`;
- gates gerais: `npx tsc --noEmit` e `npm run lint`.

O exportador contábil real permanece fora do escopo. Quando implementado, deve usar o ID do journal como chave idempotente externa, armazenar somente referência/evidence hash no outbox e nunca traduzir timeout em sucesso.
