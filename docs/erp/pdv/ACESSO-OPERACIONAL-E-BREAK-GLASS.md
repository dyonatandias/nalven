# Acesso operacional explícito e break-glass

Status: **fundação de política implementada / integração e persistência P0 pendentes**.

## Regra central

Papel gerencial do tenant e acesso ao caixa são autoridades diferentes. Ser `owner` ou `admin` permite administrar configurações segundo as permissões do ERP, mas não cria automaticamente direito de abrir, vender, movimentar dinheiro, confirmar pagamento, cancelar, devolver, reimprimir ou transferir carrinho em nenhum caixa.

Toda ação operacional deve provar, no instante do efeito:

- perfil ativo e vínculo com o usuário autenticado;
- filial e caixa ativos;
- `BranchUserAccess.canSell` vigente;
- `PosRegisterAccess` real, ativo, com janela válida e flag específica da ação;
- sessão/terminal/contexto exatos exigidos pelo domínio;
- revogação revalidada dentro da mesma transação.

O registro sintético de acesso com `id=0` usado atualmente na rota principal é um bloqueador P0 e deve ser removido depois do congelamento do aggregate de pagamentos.

## Matriz mínima

| Ação | Flag explícita |
|---|---|
| abrir turno | `canOpen` + `canSell` |
| fechar turno | `canClose` + `canSell` |
| preparar/concluir venda | `canSell` |
| suprimento | `canSupply` + `canSell` |
| sangria | `canWithdraw` + `canSell` |
| cancelamento | `canCancel` + `canSell` |
| devolução | `canRefund` + `canSell` |
| reimpressão | `canReprint` + `canSell` |
| referência manual | `canManualPayment` + `canSell`; permanece desligada até o 320000 |
| transferência de carrinho | `canTransferHeld` + `canSell` |

Alçada de desconto vem do grant explícito. Ausência, ambiguidade, validade invertida, recurso inativo ou grant revogado falham fechado.

## Break-glass

Break-glass não é um bypass de papel. É uma autorização excepcional persistida, com:

- ator, perfil, filial, caixa, ação e `operationKey` exatos;
- maker/solicitante igual ao ator e checker diferente;
- step-up do checker, approval-id, motivo e hash canônico;
- aprovação e expiração carimbadas pelo banco, TTL máximo de 15 minutos;
- exatamente um uso restante, consumido por CAS na mesma transação do efeito;
- ledger append-only, vínculo ao evento financeiro e incidente/revisão posterior;
- revogação antes do uso e impossibilidade de ampliar ação, valor ou contexto.

Não há break-glass genérico para “todo o PDV”, filial inteira ou intervalo aberto. A UI nunca deve oferecer essa autorização como atalho normal.

## Fundação já entregue

`lib/erp/pos-operational-access.ts` implementa uma decisão pura sem receber papel gerencial. Ela aceita apenas grant explícito vivo ou break-glass exato, independente, curto e single-use. Testes locais verificam flags por ação, contexto, vigência, recursos inativos, checker distinto, TTL e não transferibilidade.

Essa fundação ainda não muda o comportamento das rotas. O estado não será promovido além de parcial antes das etapas seguintes.

## Migração e integração pendentes

1. criar tabelas de request/approval/consumption e constraints diferidas de vínculo ao efeito;
2. remover o acesso sintético da rota principal e todos os `privileged` bypasses operacionais;
3. integrar a política em sessão, venda, caixa, manual, cancelamento, devolução, impressão, carrinho, offline e agente;
4. separar permissões administrativas de aprovação operacional e exigir acesso explícito do checker ao contexto;
5. criar UI de solicitação/decisão com razão estruturada, contagem regressiva e confirmação do efeito exato;
6. publicar sinais/casos de antifraude para frequência, horário, valor, fragmentação e uso repetido;
7. executar testes PostgreSQL concorrentes, HTTP e browser com owner/admin sem acesso, operador com flags parciais, revogação no meio da transação e consumo disputado.

Até essa integração, owner/admin ainda recebem privilégios operacionais sintéticos em caminhos legados e isso bloqueia piloto/produção.
