# Revisão complementar de navegação, inventário e expedição

## Correções

- Shell: respostas da tela anterior não alteram feedback da tela atual; falhas de rede liberam os controles; falhas de logout mantêm a sessão visível para nova tentativa. Storage bloqueado ou sem quota não derruba o menu.
- Cache de leituras do shell: expiração, limite de entradas, deduplicação e cancelamento lógico impedem um GET antigo de sobrescrever o resultado salvo. Cache e componentes mantêm fronteiras de usuário, empresa, filial e versão de acesso.
- Inventário: modais com foco/teclado, erro local e proteção durante envio; contagem negativa continua inválida mesmo escondida pela busca; paginação do razão não é desfeita pelo debounce; resultados do servidor não são filtrados novamente por traduções; ações móveis em duas colunas.
- Expedição: remessas em espera visíveis no Kanban, rolagem limitada por coluna e seleção restrita à página; foco preservado durante atualização, erros dentro do diálogo e fechamento bloqueado enquanto salva.
- Expedição: POST confirmado continua sendo sucesso quando a leitura seguinte falha. Resposta perdida preserva a chave do mesmo envio e duplo clique não dispara POST concorrente. Cache de outros filtros é invalidado após alteração.
- Inventário e expedição removem dados/cache após 401/403, preservando dados em erros transitórios como 503.
- O aceite publicado encontrou um conflito preexistente de CSS: a tabela administrativa global impunha `min-width:900px` e sete colunas ao razão do ERP, produzindo documento de 914 px em viewport de 390 px. As regras antigas foram limitadas a `.saas-console`; grids/cartões do inventário receberam contenção e quebra de identificadores longos. O harness agora importa também `app/globals.css`, cobrindo essa interação.

## Validação

`npx playwright test --config=playwright.production.config.ts --output=outputs/production-browser/final-ux-global-test-results`: 23 testes passaram, incluindo os oito fluxos de produção anteriores e 15 regressões de inventário, expedição e navegação. O teste adicional inclui o CSS global e códigos longos no razão móvel. Produção/recebimento usam PostgreSQL descartável; os novos casos de inventário/expedição usam componentes reais e respostas controladas, sem movimentar estoque real.

`tests/browser-read-cache.test.ts`: quatro testes aprovados para expiração/limite, deduplicação/isolamento, resposta obsoleta após escrita e falha/repetição concorrente. Suítes comerciais e omnicanal também aprovadas.

`PRODUCTION_TEST_SOCKET=/tmp/nalven-production-pg.<isolado> npm run test:production:postgres`: 18 testes transacionais aprovados novamente após a revisão, sem acesso a dados reais.

Gate `npm test` com configurações reais do servidor: aprovado nos dois candidatos, incluindo a correção do CSS global, suíte geral, ESLint sem erros, TypeScript e build de 110 páginas. O teste auxiliar de duplo envio recebeu apenas uma correção de tipo (`HTMLFormElement`).

## Limites conhecidos fora deste incremento

- Contagens/transferências ainda vêm limitadas pelo backend aos 100 registros mais recentes. A interface agora informa o recorte; paginação histórica completa exige evolução da API.
- As ações de escrita de inventário ainda aparecem para leitores e são recusadas pelo servidor. Ocultá-las exige transmitir a capacidade de escrita para a interface; permissões não foram ampliadas nesta revisão.
- O indicador visual legado de SLA de expedições concluídas merece revisão separada de suas datas de despacho/entrega; esta entrega não alterou esse cálculo.

## Publicação e aceite

Release final publicado: `/srv/nalven/releases/production-vyUnWIBT` em 2026-09-07. O release anterior imediato, `production-gcX3RYRf`, e o original `production-80N23w4f` foram preservados. Nenhuma migration, seed ou ampliação de permissões foi executada nesta rodada.

`scripts/verify-production-published.ts` passou após a correção: login HTTPS real; produção/fichas/inventário/logística/compras 200 e no-store; leitor sem escrita; perfil suspenso bloqueado na API e página. Navegação Next, voltar/avançar, diálogo de depósito/foco e páginas móveis de inventário e logística aprovados, sem overflow nem erros JavaScript. As duas contas temporárias foram removidas e a consulta posterior confirmou zero contas de validação restantes. Auditorias mantidas; nenhum saldo ou pedido real foi movimentado.

Capturas finais: `outputs/production-browser/published-inventory-mobile.png` e `published-logistics-mobile.png`. A captura `published-inventory-overflow.png` preserva a evidência do defeito detectado antes da correção.

Verificação HTTP do release: `/` 200, `/api/erp` 401, `/api/saas` 403, ambas as rotas de produção 401 sem sessão, POST de origem externa 403.
