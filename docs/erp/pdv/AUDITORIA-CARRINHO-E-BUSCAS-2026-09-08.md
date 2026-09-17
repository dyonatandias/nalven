# Auditoria do carrinho e das buscas do PDV — 08/09/2026

## Escopo e achados corrigidos

A revisão percorreu catálogo, inclusão manual, leitura de códigos, variações, quantidades, seleção de cliente, consulta de vendas, recuperação de rascunho, cotação, pagamento e confirmação. Os cliques foram reproduzidos no componente real em navegador, com respostas de API simuladas e sem alterar dados operacionais.

| Achado | Correção |
| --- | --- |
| Saldo residual tinha precedência sobre a configuração de controle de estoque; serviços ou produtos sem controle podiam aparecer esgotados. | Catálogo inicial, paginação e resolução de código compartilham `posAvailableStock`, respeitando serviço, controle do pai e da variação. |
| Produtos com variações eram adicionados como produto pai; saldo próprio da opção podia ficar inacessível. | Seletor de variação com SKU, atributos, preço e saldo do depósito, preservando a identidade da variação no carrinho. |
| Produto esgotado tinha botão desabilitado sem explicar o motivo. | Estado de estoque explícito e mensagem ao tentar incluir; a inclusão continua impedida. |
| Soma de quantidades fracionárias podia acumular erro de ponto flutuante. | Normalização em milésimos; rejeição de quantidade vazia, negativa ou não finita. |
| Inclusão durante recuperação podia competir com restauração do carrinho anterior. | Inclusão aguarda recuperação e fica bloqueada se o estado for ambíguo ou não confirmado. |
| Filtro de disponibilidade olhava somente o produto pai. | Filtro considera saldos das variações disponíveis. |
| Controles expandidos herdavam posições de grade incompatíveis e se sobrepunham. | Quantidade, desconto, leitura complementar e remoção receberam posições próprias, inclusive em celular. |
| Controles escondidos tinham referência de acessibilidade sem destino. | Identificador de destino e `inert` impedem foco nos campos recolhidos. |
| Atalho “Pedido” não correspondia à busca de vendas solicitada. | “Buscar por Produtos”, “Buscar por Cliente” e “Buscar por Venda”, com detalhe explicativo; pedidos aprovados mantêm acesso separado. |
| Consulta de vendas exibia apenas as 20 vendas do bootstrap. | Busca por número/cliente no servidor, paginação, cancelamento de consultas antigas, estado vazio e repetição de falhas. |
| Rejeição assíncrona na paginação podia escapar do tratamento HTTP do GET. | O GET aguarda a consulta dentro do tratamento de erros. |

## Fronteiras preservadas

- Venda consultada e cursor ficam limitados ao turno aberto/suspenso do operador e aos caixas autorizados; a consulta passa pela permissão `pdv.read` e pelo banco da organização.
- Não foi usado estoque global como substituto do saldo do depósito. Reservas continuam descontadas e o servidor continua validando disponibilidade na transação.
- Pagamento eletrônico ativo e pedido aprovado continuam protegidos contra alterações incompatíveis.
- Carrinho só é limpo após confirmação da venda. Uma repetição após falha usa a mesma chave de idempotência.
- Não há migração de banco ou alteração de credenciais neste trabalho.

## Verificação reproduzível

- `npm run test:pos:browser`: oito cenários com a tela real, incluindo 1440 px e 390 px; inclusão, limite de estoque, serviços, variações, buscas, paginação, erro/repetição, recuperação bloqueada e checkout em dinheiro.
- `npx tsx --test tests/pos-common-stock.test.ts tests/pos-stock-concurrency-contract.test.ts tests/pos-catalog-pagination.test.ts tests/pos-catalog-pagination-contract.test.ts`: disponibilidade, reservas, frações, cursores e limites de acesso.
- `npm test`: a suíte geral executou 911 testes aprovados e o lint passou. O build inicialmente encontrou ausência de configuração de banco; foi concluído separadamente com PostgreSQL descartável, migrations do control-plane e configuração pública fictícia, sem credenciais operacionais.
- `npm run test:pos-contract`: 147 testes aprovados após as últimas alterações. Os quatro arquivos focados acima somaram 17 testes aprovados; eles se sobrepõem à suíte geral e não representam cobertura adicional independente em todos os casos.
- `npm run build`: compilação, TypeScript e geração de páginas concluídos com sucesso no banco isolado. O lint direcionado aos arquivos alterados também passou.
- Smoke HTTP da aplicação compilada no banco isolado: `/` retornou 200; `/api/erp` retornou 401; `/api/saas` retornou 403; `/erp/pdv` redirecionou com 307, preservando autenticação sem sessão.
- Imagens de verificação: `outputs/pdv-browser/pdv-1440.png` e `outputs/pdv-browser/pdv-390.png`.

## Limites da conclusão

As falhas acima foram comprovadas no código e cobertas nos cenários indicados. Sem reproduzir a sessão e os dados específicos do operador, não se atribui todo impedimento de inclusão a uma única causa: falta real de saldo, permissões e recuperação pendente ainda podem impedir operações corretamente.

Os testes de navegador simulam os serviços e não equivalem a uma venda real em PostgreSQL nem a homologação de TEF/Pix, NFC-e, impressora, balança ou operação offline física. Os gates de produção existentes em `PLANO-E-RASTREABILIDADE.md` permanecem aplicáveis; esta auditoria não declara todo o programa PDV homologado. Publicação e migrações em produção não foram executadas por este trabalho.
