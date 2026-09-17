# Rotas públicas e autenticação — 08/09/2026

## Escopo e correções

Revisão de `/login`, `/cadastro`, `/esqueci-senha`, `/redefinir-senha/[token]`, `/convite/[token]`, `/rastrear-pedido`, `/avaliar/[token]`, suas APIs, APIs públicas de mídia/site/planos, analytics e proteções de navegação. Página inicial, blog, glossário, JSON-LD, aliases de login e cache do service worker também inspecionados. Não é uma certificação nem um pentest externo completo.

- Formulários de autenticação com CSS isolado, layout de 320 px a desktop, labels/autocomplete, confirmação e visualização de senha, aviso Caps Lock, foco no erro, tratamento de rede/JSON inválido e trava síncrona contra duplo envio.
- Regra já existente de novas senhas centralizada (12–256 caracteres, maiúscula/minúscula/número), sem invalidar credenciais antigas. Login/convite/cadastro não convertem arrays ou objetos em credenciais.
- Sessão anterior deste navegador revogada atomicamente ao criar outra; outros dispositivos preservados. Cookie de organização obsoleto removido quando a nova conta não possui empresa. Cookies continuam HttpOnly/Secure/SameSite=Lax.
- Recuperação mantém mensagem anti-enumeração, mas não oculta rejeições de origem, tamanho e formato. Redefinição continua com token único, expiração, proteção concorrente e revogação de sessões.
- Convite rotacionado/revogado durante a requisição não é aceito; empresa e conta suspensas são verificadas sob lock. Vínculos existentes e perfis divergentes, suspensos, expirados ou proprietários não são sobrescritos. Falha na preparação do tenant reverte o consumo do convite e o vínculo central.
- Cadastro trata conflitos sem detalhes internos; slugs novos respeitam o limite de 45 caracteres do provisionador.
- Páginas sensíveis e respostas autenticadas não permitem cache; links de recuperação/convite/avaliação têm no-referrer/noindex, inclusive caminhos com extensão. Avaliação e recuperação são excluídas de analytics; tokens são mascarados na normalização. Referrers antigos em sessionStorage são reduzidos à origem antes do envio. Falha ao acessar storage não derruba a página.
- Nginx passa a mascarar também `/avaliar/[token]` em novos registros. A alteração não apaga nem reescreve logs históricos.
- Rastreamento limita os dados retornados, valida a loja ativa, elimina dados da consulta anterior e aborta respostas obsoletas. Solicitação de devolução rejeita itens repetidos/quantidades inválidas e revalida autorização/elegibilidade sob lock.
- Avaliações possuem limite agregado por IP, recusam tokens revogados/pedidos removidos e submissões repetidas; publicam somente o primeiro nome. Mídia pública verifica publicação/caminho/MIME/tamanho antes de responder inclusive 304; site/planos usam projeções explícitas.

## Validação reproduzível

Resultado dos gates: `npm test` completo aprovado no candidato de produção (testes, lint, geração Prisma, TypeScript e build); suíte final de segurança **60/60**; navegador auth **9/9** e regressão ERP **23/23**. Não houve migration nova nesta rodada.

**Publicado e verificado:** `/srv/nalven/releases/production-1ihvcGgL`. Smoke no HTTPS real passou para todas as sete telas sensíveis em 320/390/1440 px, home/blog/glossário, aliases, APIs públicas e negação de origem externa. Login real confirmou cookies seguros, rotação da sessão e rejeição da antiga; verificações de operador/leitor/perfil suspenso e navegação ERP também passaram. As duas identidades sintéticas foram removidas; a evidência de auditoria de login foi preservada. Nginx validado e recarregado com redação dos novos logs de avaliação. Nenhum envio SMTP ou transação comercial real foi disparado.

- `npm run test:security`: handlers reais com dependências de armazenamento/SMTP simuladas; testes de política, proxy, sessão, convites, entradas, privacidade e APIs públicas.
- `npm run test:auth:browser`: formulários reais, CSS global real e APIs simuladas; responsividade, acessibilidade funcional, falhas de rede, duplo envio e analytics/storage.
- `NALVEN_SECURITY_TEST_DATABASE_URL=… npx tsx --test --test-concurrency=1 tests/security-auth-postgres.integration.test.ts`: executado em PostgreSQL descartável, porta 55439, banco `nalven_security_test`. Dois testes passaram, incluindo redefinição concorrente, replay, expiração, conta suspensa e invalidação das sessões. Nenhum e-mail é entregue.
- `NODE_OPTIONS=--max-old-space-size=4096 npx tsc --noEmit --incremental false`: aprovado.
- `npm audit --json` e `npm audit --omit=dev --json`: zero vulnerabilidades conhecidas reportadas na data; não prova ausência de vulnerabilidades.
- `scripts/verify-public-published.ts`: smoke público de leitura no site publicado, cabeçalhos, 320/390/1440 px, rotas anônimas, aliases e rejeição de origem externa. Não cria conta, pedido, avaliação nem solicita e-mail real; analytics do navegador é interceptado.
- `scripts/verify-production-published.ts`: identidades sintéticas de operador/leitor, removidas em `finally`; verifica login real, cookies seguros, rotação e rejeição da sessão antiga, leitura autorizada, escrita negada ao leitor e acesso suspenso. Não altera registros comerciais existentes.

## Pendências e limites conhecidos

1. **Confirmar propriedade do e-mail antes de provisionar/cobrar:** o cadastro ainda prepara o tenant e o fluxo de cobrança antes de confirmar o endereço. Precisa de jornada de verificação, reenvio/expiração e tratamento de abandono. Não foi introduzido um bloqueio improvisado que impediria novos cadastros.
2. **Separar bootstrap de dados demonstrativos:** `deploy/provision-tenant.sh` chama o seed tenant; `prisma/tenant/seed.ts` ainda cria contrapartes, recebível e dados cadastrais demonstrativos. Deve haver bootstrap essencial idempotente e demo explicitamente opt-in. Nenhum seed foi executado em empresa real nesta auditoria e nenhum dado existente foi removido.
3. **Cadastros antigos com slug longo:** a correção impede novos casos, mas não renomeia organizações/domínios/bancos existentes. Requer diagnóstico e reparo dirigido dos jobs afetados.
4. **MFA e gestão de sessões por dispositivo:** continuam como evolução recomendada; não foram implementados nesta rodada.
5. **Dois bancos não formam uma transação distribuída:** a concessão central só confirma após o tenant. Uma falha rara no commit central após o commit tenant pode deixar perfil órfão sem vínculo ativo (sem acesso), exigindo reconciliação. Não se promete atomicidade distribuída.
6. **E-mail real, cobrança e provisionamento completos:** não foram disparados contra clientes/provedores reais para testar. A entrega SMTP e o onboarding comercial completo precisam de homologação dedicada.

Princípios consultados: [OWASP — recuperação de senha](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html) e [OWASP — sessões](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).
