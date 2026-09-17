# Runbook — conciliação persistente de adquirentes do PDV

Este fluxo confronta pagamentos e estornos já registrados pelo PDV com um arquivo de liquidação do provedor. Ele não captura, cancela, liquida nem movimenta dinheiro no PSP. Também não substitui homologação com adquirente, TEF, SmartPOS, Pix, chargeback ou agenda financeira reais.

## Dados e limites

- O arquivo chega por `POST /api/erp/pdv/reconciliation` com `action=batch.import`, filial, layout e chave de idempotência.
- O payload JSON tem no máximo 1 MiB; o CSV UTF-8 tem no máximo 768 KiB e 10.000 linhas.
- O nome e os bytes brutos do arquivo não são armazenados. Persistem somente digest SHA-256, linhas canônicas normalizadas, totais inteiros em centavos e período.
- Cada tenant aceita uma única combinação `provider + digest`. Repetição retorna o lote existente; um digest já associado a outra filial é conflito operacional.
- O recorte do ERP é limitado a 20.000 pagamentos. Se exceder, reduza `matchWindowHours` do layout para novos lotes.
- Nenhum DTO ou relatório expõe `transaction_id`, `settlement_id`, NSU, autorização, cartão, documento, cliente ou hashes completos de referência. Issues usam SHA-256 interno.
- O CSV administrativo de relatório contém apenas lote/provider/estado/contagens/totais e usa neutralização de fórmulas para valores iniciados por `=`, `+`, `-` ou `@`.

## Layouts

O layout é sempre vinculado a uma filial e provider normalizado. Ele configura:

- delimitador: vírgula, ponto e vírgula ou tab;
- colunas de liquidação, transação, tipo, bruto, taxa, líquido, ocorrência e liquidação;
- valores em centavos inteiros ou decimal sem separador de milhar;
- separador decimal;
- data ISO-8601 UTC ou epoch em milissegundos;
- aliases de pagamento, estorno e chargeback;
- janela de confronto de 0 a 168 horas.

Alterações usam `expectedVersion` e incremento atômico. Um lote preserva `layoutVersion` e snapshot imutável; mudar o layout afeta somente importações futuras. Desative layouts antigos em vez de apagá-los.

## Processamento e reprocessamento

1. O importador valida e normaliza o CSV antes de abrir a transação.
2. Uma transação serializável cria lote, linhas e auditoria. A evidência não contém o arquivo bruto.
3. O processador bloqueia o lote com `FOR UPDATE`, verifica `expectedVersion` e confronta o recorte do ERP.
4. Run e issues são acrescentados; o lote é atualizado por CAS `id + version`.
5. Conflitos `P2034`, `40001` e `40P01` têm até três tentativas.
6. A chave de reprocessamento é única. Replay com a mesma chave e request hash devolve o mesmo run; chave reutilizada em outro contexto retorna conflito.
7. Linhas, runs e issues possuem triggers que rejeitam `UPDATE` e `DELETE`. O lote preserva digest, request hash, filial, layout, período e autoria.

Issues canônicas: `duplicate_settlement`, `duplicate_transaction`, `missing_provider_entry`, `unexpected_provider_entry`, `kind_mismatch`, `amount_mismatch` e `non_final_erp_state`. Qualquer issue mantém `productionBlocking=true`; não marque uma liquidação externa como conciliada manualmente para ocultar a divergência.

## Job interno

Endpoint: `POST /api/internal/pdv/reconciliation/process`.

Cabeçalhos obrigatórios:

```text
Authorization: Bearer <NALVEN_INTERNAL_JOB_TOKEN de 32–512 caracteres>
Content-Type: application/json
```

Payload:

```json
{
  "action": "reconciliation.process",
  "organizationLimit": 20,
  "batchLimit": 10,
  "afterOrganizationId": null
}
```

O endpoint percorre apenas organizações `active`/`trial` com banco ativo, até 100 organizações e 50 lotes por tenant. Há rate limit persistente de 6 chamadas/minuto por tenant. A resposta usa cursor somente quando toda a página termina sem falha e retorna códigos allowlisted, nunca mensagens internas. O job não depende de licença de escrita: conciliar dinheiro já capturado é manutenção financeira, não uma nova venda.

Conecte esse endpoint ao agendador do ambiente com segredo rotacionável. Uma cadência inicial de um minuto é adequada; repita enquanto `hasMore=true`, respeitando rate limit e cursor. O repositório não provisiona cron, fila ou segredo do ambiente.

## Operação e incidentes

- `pending`: o lote foi duravelmente importado, mas ainda não gerou run. Acione o job ou reprocessamento administrativo com a versão exibida.
- `completed` sem issues: confronto determinístico concluído; ainda depende da validade do arquivo fornecido pelo PSP.
- `completed` bloqueante: investigue os códigos agregados e compare no portal seguro do PSP usando o lote/período. As referências brutas permanecem no banco somente para o motor; não copie para tickets ou logs.
- `409` por versão: outro operador/worker venceu o CAS. Recarregue antes de decidir se um novo run é necessário.
- `409` por chave: a mesma chave foi reutilizada com payload diferente. Não force; gere uma nova chave somente para uma nova intenção.
- `SERIALIZATION_CONFLICT`: repita depois de backoff; se persistir, reduza concorrência e verifique locks longos.
- `RATE_LIMITED`: aguarde a janela, sem multiplicar workers.
- `DATABASE_ERROR`/`TENANT_JOB_FAILED`: preserve o lote e o correlation ID, estabilize o banco e execute novamente. Nunca altere tabelas de evidência.

O painel em **Configuração do PDV → Conciliação de adquirentes** apresenta somente agregados, versões, IDs operacionais de lote e códigos. O relatório CSV é `no-store` e limitado aos 50 lotes mais recentes por consulta.

## Evidência externa ainda necessária

Suíte local, migration e teste PostgreSQL provam parser, idempotência, concorrência, CAS, imutabilidade e DTOs. Não provam que um provider real entregue o mesmo layout, semântica de taxa, horário, timezone, parcelamento, antecipação ou chargeback. Antes de produção, execute por adquirente:

1. arquivos reais anonimizados de homologação, inclusive duplicidade e ordem tardia;
2. pagamento, estorno parcial/integral, cancelamento, chargeback, taxa e antecipação;
3. timezone/DST e fechamento de agenda;
4. volume máximo e reprocessamento concorrente;
5. aceite do financeiro sobre totais e política de resolução de cada issue.
