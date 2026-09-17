# Step-up do supervisor no PDV

## Objetivo

Permitir que um supervisor presente decida uma exceção na estação compartilhada sem encerrar o turno do operador, trocar a sessão principal ou compartilhar sua identidade. O step-up local não substitui MFA corporativo e não amplia a alçada do operador.

## Pré-condições

- o operador deve estar autenticado, ativo e autorizado na filial/caixa;
- deve existir um pedido de aprovação pendente, contextual, não expirado e ainda não consumido;
- o supervisor deve possuir usuário ativo, membership `owner` ou `admin` na mesma organização e perfil operacional tenant ativo;
- solicitante e supervisor devem ser identidades distintas.

## Procedimento

1. O operador abre **Aprovações** e cria ou localiza o pedido contextual.
2. O supervisor confere ação, entidade, justificativa e contexto exibidos.
3. Na própria estação, o supervisor informa seu e-mail e senha e escolhe aprovar ou rejeitar.
4. O servidor reautentica a segunda identidade no banco de controle, revalida organização/papel/perfil no tenant e decide o pedido sob transação serializável.
5. A operação comercial ainda precisa consumir a aprovação correspondente; decidir não executa sangria, desconto, cancelamento, devolução, fechamento ou referência manual por si só.

## Controles

- JSON e allowlist estritos; origem, licença e `pdv.write` revalidados;
- seis tentativas em cinco minutos, tanto por operador quanto por alvo anonimizado;
- comparação scrypt também para usuário inexistente, com erro externo uniforme;
- senha limitada a 512 bytes, mantida somente na memória da requisição e limpa do formulário após a tentativa;
- auditoria de falha contém apenas código estável e hash do alvo; sucesso registra o supervisor e `password_step_up`;
- autoaprovação, pedido expirado, decisão concorrente e replay por outro aprovador falham fechados.
- para `payment.manual_reference`, o step-up por senha é obrigatório até para owner/admin já autenticado; a UI não oferece decisão direta para essa ação.

## Resposta a incidente

Se houver tentativas repetidas ou decisão indevida:

1. bloquear/revogar o usuário no controle e encerrar suas sessões;
2. suspender o caixa/turno afetado;
3. consultar `pos.approval.step_up.failed`, `pos.approval.approved/rejected` e o consumo da aprovação pelo `correlationId`;
4. executar reversão operacional correspondente, nunca alterar o ledger concluído;
5. revisar alçadas e habilitar MFA corporativo antes de reativar o usuário quando aplicável.

## Limites conhecidos

Esta implementação prova reautenticação forte por senha e segregação de identidade no repositório. Segundo fator, IdP/SSO, WebAuthn, política corporativa de senha, sessão privilegiada central e teste ofensivo continuam gates de produção separados.
