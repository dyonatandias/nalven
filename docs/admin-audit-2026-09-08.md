# Auditoria do painel administrativo — 08/09/2026

## Escopo e correções

Inspeção das 17 entradas laterais, Organizações, layout administrativo, APIs consumidas e páginas de conteúdo. A autorização continua sendo aplicada pelo layout: usuário autenticado com papel superadmin; as APIs inspecionadas exigem esse papel.

| Área | Problema encontrado | Correção |
| --- | --- | --- |
| Módulos dinâmicos | Estado de Sistema/Auditoria podia ser reaproveitado ao abrir Organizações, deixando a lista indefinida | Estado por módulo, cancelamento da requisição antiga e validação da resposta |
| Carregamento | Rejeições de fetch/JSON não tratadas, erro persistente após sucesso, carregamento infinito após falha | Tratamento de falhas, feedback acessível e tentativa novamente |
| Organizações | Tabela gerada pelas primeiras sete propriedades, com nomes técnicos e sem identificação do plano | Colunas deliberadas em português, plano por nome, valor monetário, busca sem acentos e filtro de situação |
| Gestão | Organizações sem acesso direto à edição; Usuários abria um redirecionamento manual | Link para a aba Organizações e rota Usuários com a aba correta aberta |
| Menu lateral | Rodapé herdava coluna de 10px; área de rolagem e navegação móvel incompletas | Rodapé de uma coluna, rolagem interna, item atual, nomes acessíveis, Escape, foco contido e menu fechado fora da ordem de tabulação |
| Conta | Logout podia redirecionar mesmo se a API falhasse | Verificação HTTP, tratamento de rede e nova tentativa; popover fecha por Escape/clique externo |
| Financeiro e SMTP | Carregamento/comandos podiam rejeitar promises sem tratamento | Erros visíveis e recuperação, liberação de estado ocupado no SMTP |
| Falha de renderização | Ausência de recuperação específica do admin | Error boundary e estado de carregamento do segmento |

## Inventário lateral

Visão geral, Organizações, Usuários, Ambientes dos tenants, Financeiro e licenças, Backups, Exportações, Provisionamento, Sistema, Auditoria, Analytics do site, Site e planos, Biblioteca, SEO, Redirects e erros 404, Blog e Glossário.

Todos os links têm página explícita ou módulo permitido. Essa verificação de existência não equivale a validar todas as regras de negócio ou todos os dados de produção.

## Erro original de startTime

Não foi reproduzido nos testes isolados dos componentes. Não se deve atribuir o erro a uma extensão apenas porque aparece como VM.

Foi encontrada uma correção oficial do próprio Chrome DevTools, “Live Metrics: Handle empty INP entries”, que protege a leitura de metric.entries[0].startTime. O caso descrito é uma interação com entradas vazias após navegação ou restauração do cache de navegação:

https://github.com/ChromeDevTools/devtools-frontend/commit/6a47f93393a72ca3ae77fdb0525296812d92f9a2

É uma correspondência técnica forte, mas a atribuição definitiva ao navegador do usuário depende de comparar o script VM e a versão do Chrome. Nenhum filtro global de console ou alteração da API Performance foi aplicado.

## Validação e limites

- 8 testes Playwright com componentes reais e APIs simuladas: busca e filtro, resposta inválida, recuperação, troca de módulos, resposta atrasada, falha de rede, links laterais, destinos de conteúdo indisponíveis, menu móvel e logout com erro.
- Capturas inspecionadas em 320px e 1440px; rolagem horizontal restrita à tabela.
- 905 testes aprovados na suíte de testes unitários/contratos do npm test. URLs fictícias apontando para a porta 1 foram usadas para satisfazer imports; nenhum banco real foi usado por essa execução.
- Lint geral aprovado; checagem final dos arquivos alterados sem avisos. TypeScript aprovado.
- Build Next.js completo aprovado com PostgreSQL temporário na porta 55439 e seed sintético. A tentativa inicial com URL fictícia falhou na geração de metadados públicos que exige configurações persistidas.
- Smoke anônimo do serviço local publicado: / retornou 200, /api/erp retornou 401 e /api/saas retornou 403.
- O harness Playwright usa adaptadores de navegação para Next.js. A validação nativa complementar executa o build real contra PostgreSQL descartável; não usa mocks das APIs.
- Validação nativa aprovada: login real, abertura das 17 páginas com HTTP 200, link para a aba de gestão de organizações, gravação de responsável sintético pela API, confirmação no banco e na listagem. Zero exceções JavaScript e zero respostas de API com falha durante o percurso do navegador. Capturas em outputs/admin-native.
- SMTP externo, provedor billing e todos os recortes possíveis de dados de produção não são validados pelos testes locais.
- Nenhuma publicação ou alteração de dados de produção foi realizada nesta auditoria.

Execução do teste do painel: npm run test:admin:browser.

O script scripts/admin-native-audit.ts só aceita o PostgreSQL descartável na porta 55439, requer o seed local (administrador audit@example.invalid) e o candidato em 127.0.0.1:4185. Ele modifica apenas dados sintéticos e não deve ser usado em produção. O servidor e o banco temporários são encerrados após a validação.

Atualização de 09/09: o roteiro foi adaptado às 25 entradas atuais, à página individual da organização e ao PATCH dedicado, sem usar a API agregada desativada. Antes de escrever, verifica o diretório temporário do PostgreSQL; depois do login verifica que a sessão do servidor foi persistida nesse mesmo banco. A aprovação histórica de 17 destinos acima não comprova execução deste roteiro atualizado. A validação integral exige tenant isolado e suas credenciais próprias; não reutilizar arquivos de produção para preencher essa lacuna.
