# Ledger de caixa e custódia de numerário

## Estado da capacidade

**POS-106: PARTIAL.** A fundação de dados, os triggers append-only e os serviços transacionais existem, mas ainda não foi integrada a `session.open`, `cash.event`, `sale.commit`, `return.create` ou `session.close`. O legado `cash_register_events` continua sendo a fonte operacional usada pelo PDV atual. Não há backfill nem reconciliação automática entre as duas estruturas; por isso este trabalho não declara cobertura de produção nem conclusão do requisito.

## Invariantes do ledger

- Cada lançamento referencia por FK filial, caixa, turno, terminal, ator e, quando exigida, aprovação.
- O produtor precisa apresentar `PosOperationalTerminalProof` vigente. O serviço revalida terminal pareado, online, com heartbeat recente, token/versão vigentes e vínculo ao caixa/filial.
- Ator é o par `actorProfileId` + `actorUserId`; o serviço revalida perfil ativo, filial e alçada viva do caixa.
- A cadeia começa com `opening`, inclusive com valor zero, e usa sequência estritamente crescente por turno.
- `balance_before_cents` precisa ser o saldo final anterior; `balance_after_cents = before + delta` e nunca pode ficar negativo.
- Venda e suprimento aumentam; devolução, sangria e selagem reduzem; ajuste pode ter ambos os sinais mediante aprovação exata.
- Origem + identificador + sequência são únicos. Isso impede contabilizar duas vezes o mesmo fato, além da chave idempotente.
- Nenhum registro pode sofrer `UPDATE` ou `DELETE`. Correção usa `reversal`, de mesmo valor e sinal oposto, referenciando uma única vez o lançamento original.
- Ajuste e reversão consomem, no próprio trigger/transação, aprovação vinculada ao ator solicitante, ação, entidade, snapshot monetário exato, filial, validade e segregação de funções.

## Fluxo do malote

1. `sealPosCashCustodyBag` registra uma saída `custody_seal`, cria o malote/lacre imutável e o evento `sealed` na mesma transação.
2. `deliverPosCashCustodyBag` registra o custodiante remetente e um destinatário ativo diferente.
3. O destinatário confere o lacre e o numerário:
   - valor exato: `acceptPosCashCustodyBag` cria `accepted`;
   - valor divergente: `reportPosCashCustodyDivergence` cria incidente + `divergence_reported` atomicamente.
4. Uma divergência só é resolvida por outro ator, com aprovação exata e não reutilizável. Resolução + evento final são obrigatórios na mesma transação.

O estado atual é sempre derivado do último evento. Malote, eventos, incidente e resolução são imutáveis. Triggers deferred recusam malote sem selagem, incidente sem evento, resolução sem evento e saída de custódia sem malote.

## Resposta a incidentes

- Não tente corrigir linhas via SQL: triggers rejeitam update/delete.
- Preserve `correlation_id`, chave idempotente, lacre e comprovantes físicos.
- Em divergência, interrompa o aceite normal; abra o incidente pelo destinatário designado.
- A resolução exige terceiro independente e aprovação com snapshot idêntico aos valores esperados, observados, diferença, valor final e tipo de resolução.
- O serviço refaz no máximo três vezes uma transação serializável abortada com `P2034`. Se o conflito persistir, consulte o ledger/eventos antes de repetir a mesma chave; não altere a chave para contornar a reconciliação.
- Quebra de cadeia ou violação de trigger é incidente P0: não desabilite constraints; isole o caixa e preserve evidências.

## Migração futura obrigatória

Antes de ligar a rota monolítica é necessário:

1. definir mapeamento reconciliável de cada `cash_register_events` e pagamento em dinheiro para uma origem única;
2. decidir política para turnos históricos, abertura zero e eventos sem terminal/ator por FK;
3. executar backfill em clone, provar saldos por turno e registrar exceções sem fabricar identidades;
4. ativar producers por ação em transação única com a mutação de negócio;
5. somente então trocar relatórios/fechamento para o novo ledger e atualizar POS-106 após piloto de tesouraria.
