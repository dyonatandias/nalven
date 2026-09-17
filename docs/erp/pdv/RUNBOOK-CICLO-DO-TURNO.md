# Runbook — pausa, retomada e passagem de turno

Este runbook cobre a continuidade do caixa sem compartilhar credencial. Pausar ou passar o turno não fecha nem reconcilia numerário; o mesmo `CashRegisterSession` e a mesma gaveta continuam sendo a unidade financeira.

## Invariantes

- `open`, `suspended` e `closing` ocupam exclusivamente o caixa e o operador;
- turno suspenso não aceita venda, movimento de caixa, devolução ou fechamento;
- uma passagem exige operadores distintos e apenas uma pode permanecer `requested` por turno;
- o destino precisa estar ativo, autorizado na filial e com `canOpen` + `canSell` vigentes no mesmo caixa;
- o destino não pode possuir outro turno `open`, `suspended` ou `closing`;
- pagamento/refund `created`, `processing`, `pending`, `unknown` ou `manual_review`, intent `captured` ainda não consumido e qualquer `PosPaymentIntegrityIncident` aberto/bloqueante impedem pausa e passagem;
- aceitar exige autenticação do operador de destino; a origem não pode aceitar em nome dele;
- carrinhos suspensos são fotografados por ID/revisão ao solicitar e mudam de operador atomicamente no aceite; qualquer divergência aborta toda a passagem;
- sessão e passagem usam revisão esperada, transação `Serializable`, idempotência e auditoria;
- passagem expira em dez minutos. Operação expirada nunca muda o responsável;
- cancelamento da passagem reabre o turno para a origem. Pausa sem passagem exige retomada explícita.

## Operações

O endpoint é `/api/erp/pdv/session-lifecycle`. `GET` não aceita parâmetros e retorna o turno ativo/suspenso do operador, a passagem de saída e até vinte convites de entrada válidos. Respostas usam `cache-control: no-store`.

### Pausar

Enviar `session.suspend` com `sessionId`, `expectedVersion`, motivo de 8–500 caracteres e chave idempotente. Antes de pausar:

1. concluir ou reconciliar toda tentativa eletrônica incerta;
2. suspender ou limpar o carrinho em edição;
3. verificar que o operador manterá controle físico da gaveta se não houver passagem.

### Retomar

Enviar `session.resume` com a versão atual. Uma passagem válida precisa ser cancelada antes. Passagens vencidas são marcadas `expired` na mesma transação da retomada.

### Solicitar passagem

Enviar `session.handoff.request` com operador de destino, motivo e versão do turno. A solicitação suspende o turno e cria um convite com validade curta de maneira atômica. Compartilhar PIN, senha ou sessão do navegador é proibido.

### Aceitar

O funcionário de destino entra com sua própria identidade, consulta os convites e envia `session.handoff.accept` com as revisões atuais do turno e da passagem. O commit altera `operatorProfileId`, reabre o mesmo turno e transfere a posse de todos os carrinhos suspensos fotografados, registrando a revisão anterior e a nova. Uma disputa produz um único vencedor e qualquer carrinho divergente causa rollback integral.

### Cancelar

A origem — ou administrador em contingência — envia `session.handoff.cancel` com motivo e revisões atuais. A passagem vira `cancelled` e o turno retorna a `open` para a origem na mesma transação.

## Incidentes

| Sintoma | Verificação | Ação segura |
|---|---|---|
| destino não vê o convite | filial ativa, acesso ao caixa, expiração e identidade autenticada | corrigir o acesso; nunca reutilizar o login da origem |
| `409` de revisão | outro request alterou turno/passagem | recarregar, conferir responsável/estado e decidir de novo |
| convite expirado | `expiresAt` e relógio servidor | origem retoma e cria nova solicitação |
| pagamento impede pausa | pagamentos/refunds pendentes, intent capturado não consumido ou incidente de integridade aberto no turno | consultar provider/conciliação; vincular a captura ou resolver por workflow compensatório, nunca editar histórico/cobrar novamente às cegas |
| destino já tem turno | sessões ativas do perfil | encerrar ou passar o outro turno primeiro |
| operador saiu sem concluir | turno `suspended` e convite pendente/expirado | administrador investiga auditoria e cancela; não editar banco manualmente |

## Evidências para suporte e auditoria

Correlacionar `CashRegisterSession.version`, `CashRegisterEvent`, `PosSessionHandoff`, `PosPaymentIntent`, `PosPaymentIntegrityIncident` e `TenantAuditEvent` pelo turno, passagem e `correlationId`. Nunca apagar ou alterar o histórico para “corrigir” a posse; qualquer correção deve ser uma nova operação auditada.

## Gate de rollout

Antes do piloto, testar em dois usuários reais: pausa/retomada, aceite concorrente, expiração, cancelamento, acesso revogado durante o convite, destino com outro turno e presença de pagamento incerto. Confirmar também bloqueio físico da tela/kiosk e procedimento de custódia da gaveta.
