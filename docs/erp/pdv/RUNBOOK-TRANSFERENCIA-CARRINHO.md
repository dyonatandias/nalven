# Transferência de carrinho suspenso (POS-302)

## Escopo

A transferência move a posse integral de um carrinho com estado `held` do turno aberto do operador atual para outro turno aberto da mesma filial. Ela não copia itens, não cria uma segunda suspensão e não conclui venda ou pagamento.

## Autorização

- O cedente precisa de `pdv.write`, acesso de venda vigente à filial e ao caixa de origem e da alçada `canTransferHeld`. Proprietários e administradores têm a alçada operacional implícita.
- O carrinho deve pertencer ao operador autenticado e ao turno de origem informado.
- O receptor deve ser outro operador, com perfil ativo, turno aberto e acesso de venda vigente ao caixa receptor. Proprietários e administradores ativos também podem receber.
- Origem e destino precisam pertencer ao mesmo banco tenant e à mesma filial ativa. Não existe transferência entre organizações ou filiais.

## Concorrência e replay

O cliente envia `expectedRevision`. O servidor bloqueia o carrinho e os dois turnos, confere novamente acessos e estado, e troca `registerId`, `sessionId` e `operatorProfileId` com CAS. Cada sucesso incrementa a revisão exatamente uma vez.

A chave idempotente é vinculada ao ator, filial e hash de carrinho/origem/destino/revisão/motivo. Repetir o mesmo comando devolve o evento original; reutilizar a chave com outro conteúdo falha. Duas transferências da mesma revisão têm no máximo um vencedor.

## Auditoria e operação

Cada sucesso grava `pos_held_sale_transfers` e `tenant_audit_events` na mesma transação serializável. O ledger rejeita `UPDATE` e `DELETE` no PostgreSQL.

No PDV:

1. Suspenda a venda.
2. Em **Vendas suspensas**, escolha **Transferir**.
3. Selecione outro turno autorizado, informe o motivo e confirme.
4. O carrinho desaparece do cedente e passa a aparecer no bootstrap do receptor.

O receptor retoma o carrinho normalmente. Preços, promoções, códigos/PLU, lote/série, estoque e pagamentos continuam sendo revalidados no fluxo autoritativo de conclusão da venda.

## Diagnóstico

- **Alçada revogada ou expirada:** revise o acesso do funcionário no caixa de origem.
- **Sem destino:** confirme que existe outro turno `open`, em caixa ativo da mesma filial, com operador autorizado a vender.
- **Revisão desatualizada:** recarregue o PDV; outro comando alterou a posse.
- **Chave usada com outro conteúdo:** preserve a chave somente para retry do mesmo payload; gere outra chave quando destino ou motivo mudar.
