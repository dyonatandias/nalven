# Conciliação de pagamentos e recebíveis

O núcleo canônico de importação/confronto e sua persistência operacional estão implementados em `lib/erp/pos-reconciliation.ts`, `lib/erp/pos-reconciliation-persistence.ts` e nas migrations do tenant. Layouts, lotes, linhas, runs e issues são duráveis; isso não substitui a homologação do arquivo/API e da semântica de um provedor real.

## Arquivo canônico

O endpoint persistente recebe CSV UTF-8 conforme um layout versionado por filial/provider. O layout mapeia oito campos lógicos — liquidação, transação, tipo, bruto, taxa, líquido, ocorrência e liquidação temporal — para nomes de coluna configuráveis; `provider` vem do próprio layout e não do arquivo.

Regras:

- no endpoint persistente, máximo de 768 KiB e 10.000 lançamentos por arquivo; o recorte ERP é limitado a 20.000 pagamentos;
- valores em centavos inteiros ou decimal textual conforme o layout, sempre normalizados para inteiros sem aritmética de ponto flutuante;
- `kind` em `payment`, `refund` ou `chargeback`;
- pagamento: `net = gross - fee`;
- refund/chargeback: `net = -(gross + fee)`;
- datas ISO 8601 UTC ou epoch em milissegundos conforme o layout, normalizadas antes do confronto; liquidação igual ou posterior à ocorrência;
- digest SHA-256 do arquivo original para deduplicação e auditoria;
- parser CSV fechado, com aspas escapadas e rejeição de bytes/campos inválidos.

## Confronto

A chave canônica é `provider + transaction_id`. O resultado separa:

- duplicidade de liquidação;
- duplicidade de referência no ERP ou provedor;
- transação do ERP ausente no provedor;
- lançamento inesperado do provedor;
- tipo divergente ou chargeback novo;
- valor bruto divergente;
- transação ERP ainda em estado não final.

Qualquer divergência deixa `productionBlocking: true`. O resumo soma bruto com sinal, taxas e líquido do arquivo. Divergência nunca é corrigida por overwrite: exige caso de resolução auditável.

## Persistência implementada e evolução externa

Já existem migrations, API/UI, job interno e testes PostgreSQL para:

- lote importado com digest único, provider, período, origem, ator e timestamps;
- lançamento imutável e vínculo opcional ao pagamento/refund original;
- issue imutável com código, hashes e valores confrontados;
- reprocessamento idempotente com runs versionados por filial/provider;

Ao selecionar PSP/adquirente, completar e homologar:

- MDR contratado versus realizado, antecipação, parcelamento e agenda de recebíveis;
- chargeback/disputa e reflexo financeiro, sem alterar a venda original;
- workflow de resolução de issue com motivo, evidência e segregação de função, mais fechamento diário por filial/provider;
- retenção do artefato bruto cifrado e política LGPD/financeira.

## Gates

- layout real e timezone confirmados pelo provedor;
- exemplos de pagamento, parcelado, refund parcial/integral, chargeback, cancelamento e antecipação;
- totais do arquivo conciliados ao extrato/recebível;
- arquivos duplicados, atrasados, corrigidos e fora de ordem;
- alertas e fila operacional sem resolução automática silenciosa;
- teste de clone e piloto com financeiro/tesouraria.
