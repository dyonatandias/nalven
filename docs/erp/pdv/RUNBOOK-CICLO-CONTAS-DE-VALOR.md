# Runbook do ciclo de contas de valor

## Objetivo

O ciclo interno libera reservas cuja própria vigência terminou ou cuja conta venceu e, depois, expira contas ativas vencidas sem reservas. Cada efeito usa uma chave determinística, grava lançamento no ledger imutável e cria auditoria na mesma transação serializável.

O job não chama provider externo e não depende da licença de escrita interativa: finalizar uma obrigação financeira já existente deve continuar possível durante indisponibilidade comercial do tenant.

## Endpoint interno

`POST /api/internal/pdv/value-accounts/sweep`

Requisitos:

- `Authorization: Bearer …` com o mesmo `NALVEN_INTERNAL_JOB_TOKEN` forte configurado no servidor;
- `Content-Type: application/json`;
- corpo máximo de 4 KiB;
- chamada somente pela rede/camada de jobs interna;
- limite persistente de seis execuções por minuto em cada banco de organização.

Corpo inicial:

```json
{
  "action": "value.lifecycle.sweep",
  "organizationLimit": 20,
  "itemLimit": 50,
  "afterOrganizationId": null
}
```

Quando `hasMoreOrganizations` for verdadeiro, repetir usando o `nextCursor` retornado como `afterOrganizationId`. Se a resposta for `503`, repetir a mesma página: organizações já concluídas serão no-op por idempotência, e o cursor não avança enquanto houver falha.

Os limites máximos são 100 organizações e 100 reservas/contas por fase e organização. `hasMore` dentro do resultado de um tenant indica backlog restante; agende nova passagem com intervalo compatível com o rate limit.

## Concorrência e replay

- Reserva e conta são relidas sob `FOR UPDATE`.
- Cada item usa uma transação `SERIALIZABLE`, com até três tentativas para `P2034`.
- A chave do lançamento deriva de SHA-256 do ID operacional; o ID aberto não fica na chave.
- Dois workers podem selecionar o mesmo candidato, mas apenas um altera o saldo e grava o lançamento.
- O estado original do ledger nunca é atualizado ou removido; o trigger de imutabilidade continua sendo a última barreira no PostgreSQL.

## Observabilidade e passivo

Administradores consultam o painel “Passivo de valores”, que usa `GET /api/erp/pdv/value-accounts/liability?branchId=…` com `pdv.read`, same-origin e `no-store`.

O relatório contém somente agregados por filial, natureza, estado e aging desde a emissão. Não inclui cliente, identificação da conta, código/PIN de gift card, hashes ou request payload. O valor de face de pontos usa a conversão de resgate configurada e não deve ser tratado como provisão contábil sem validação da controladoria.

Sinais operacionais:

- `reservas a liberar` maior que zero: confirmar execução recente e backlog do job;
- `contas a expirar` maior que zero: reservas podem estar sendo liberadas em lote anterior;
- `hasMore` no último sweep: repetir até zerar, respeitando o limite;
- `RATE_LIMITED`: aguardar a janela de 60 segundos;
- `SERIALIZATION_CONFLICT`: repetir a mesma página; não criar chave alternativa nem alterar ledger manualmente;
- `DATABASE_ERROR` ou `TENANT_JOB_FAILED`: validar disponibilidade/migrations do banco isolado antes de reexecutar.
