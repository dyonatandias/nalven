# Execução da ampliação de produção

Escopo autorizado: concluir os 12 pontos da revisão de `/erp/producao-kits`, incluindo implementação, validação operacional e implantação quando as autoridades do ambiente permitirem. Este registro acompanha evidências; presença de código não equivale a conclusão.

## Requisitos e provas de aceite

| Requisito | Prova necessária | Situação |
| --- | --- | --- |
| Migration dos tenants | Migrate aplicado, catálogo SQL e endpoint publicado | Cinco migrations aplicadas em `nalven_t_demo`; release publicado e endpoints autenticados aprovados |
| Reserva real de materiais | Concorrência entre ordens, consumo e liberação sem divergência | Comprovado em PostgreSQL descartável; implementação publicada |
| Apontamentos parciais, perdas e retrabalho | Múltiplos apontamentos, consumo real e saldo residual verificados em banco | Parciais, refugo, 101 apontamentos, consumo divergente justificado e retrabalho idempotente comprovados |
| Lote, série e validade | Entrada e consumo rastreados, FEFO, identidade serial e vencimento validados | FEFO, transferência serial, consumo, quarentena e reversão por série duplicada comprovados |
| Custeio | Materiais, mão de obra, máquina, energia, indiretos e custo médio com evidência numérica | Testes numéricos e PostgreSQL passaram; tarifa do recurso registrada no histórico |
| Fichas versionadas | Revisão, aprovação, vigência e snapshot imutável da ordem | Revisão vigente e preservação de ordens anteriores comprovadas; guardas SQL da base da ordem testadas |
| Planejamento de capacidade | Recursos, turnos, dependências, calendário/Gantt e conflito testados | Conflitos, redução de WIP e ciclos no banco; Gantt desktop/celular e preservação da dependência no formulário passaram |
| MRP | Necessidade líquida e criação idempotente de compra/transferência real | Compra simples/variação, recebimento parcial no depósito da ordem, reserva/consumo e transferência serial comprovados em banco isolado |
| Qualidade | Checklist, inspeção, quarentena, decisão e certificado vinculados | Aprovação/reprovação, certificado, bloqueio de liberação pelo inventário e aprovação SQL sem evidência comprovados |
| Kanban avançado | Arrastar/soltar acessível, ações em lote, limite WIP e atualização entre usuários | Arrastar/teclado e segunda sessão passaram; lote atômico comprovado no banco |
| Escala/resiliência | Paginação no servidor, leitura incremental e repetição segura de comandos | Fila global e histórico de 101 apontamentos comprovados; repetição após resposta perdida passou |
| Navegador e regressão | Fluxos E2E desktop/mobile, permissões, screenshots, testes e build | 8 testes de navegador, 23 de domínio/banco e gate `npm test` passaram; login, permissões e navegação Next reais aprovados após publicação |

## Evidências locais desta revisão

- `tests/production-domain.test.ts` e `tests/production-postgres.integration.test.ts`: 23 testes passaram no cluster descartável, sem usar credenciais ou dados de tenants reais. Incluem recebimentos concorrentes, séries duplicadas, histórico imutável, chave vinculada ao usuário, saldo residual de um milionésimo e extensão auditada/idempotente do perfil de suprimentos.
- `tests/browser/production.spec.ts`: 8 testes passaram em loopback. Os fluxos de produção e recebimento usam serviços reais e banco descartável. O teste do shell usa o componente/CSS reais e substitui navegação do Next; inventário/expedição respondem 503 intencional para comprovar que falhas de módulos não travam o menu. Isso não comprova o conteúdo completo desses módulos nem login/navegação real do Next.
- O menu lateral foi exercitado em desktop/celular: destaque único da página, rodapé menor que 150 px, modos compacto/oculto, ausência de menu global duplicado, foco contido, Escape e devolução do foco. Menu oculto e conteúdo atrás do menu móvel usam `inert`.
- `tests/production-route-permissions.test.ts`: handlers e avaliador real de permissões exercitados com dependências de sessão/banco/licença simuladas. Cobertura: ausência de sessão, outra empresa, vínculo/perfil inativos, perfil vencido, leitura sem escrita, permissões adicionais de compras/inventário, licença e origem externa. Revelou e corrigiu HTTP 400 indevido no bloqueio de origem, agora 403. Não substitui login real.
- `outputs/production-browser/desktop.png`, `mobile.png`, `mobile-bom.png` e `order-quality.png`: capturas locais, não publicação.
- `npm test`: gate integrado final passou, incluindo testes gerais, testes de permissões das rotas, lint, geração Prisma, TypeScript e build (110 páginas). Usa `production_control_test` no cluster descartável com configurações comerciais/SEO exclusivamente locais; não representa build/publicação com configuração real do tenant.
- HTTP real do Next, build local em `127.0.0.1:4180`: `/` = 200; `/api/erp` = 401; `/api/saas` = 403 conforme contrato superadmin; ambas as rotas de produção = 401 para GET/POST sem sessão e 403 para POST de outra origem. Cabeçalhos privados/no-store conferidos.
- Os comandos de produção agora usam agregações de apontamentos no banco, não carregamento integral do histórico. O histórico adicional conserva inspeção, certificado e retrabalho.
- Busca de opções preserva a escolha quando respostas AJAX chegam; rótulos acessíveis separam nomes e dicas; foco fica contido no modal; botão primário mantém contraste no hover.

## Publicação e aceite real — 2026-09-07

- Release deste primeiro aceite: `/srv/nalven/releases/production-80N23w4f`; anterior preservado: `/srv/nalven/releases/portal-20260906T003428Z`. A revisão complementar foi publicada em `production-vyUnWIBT`; consulte [ux-followup.md](ux-followup.md) para o aceite atualizado de 23 testes de navegador e login real.
- `npm test` também passou com as configurações reais do servidor: testes, lint sem erros (um aviso intencional de navegação completa na troca de empresa), TypeScript, Prisma e build de 110 páginas.
- Backup `nalven-backup.service`: sucesso antes das cinco migrations. Todas aplicadas pelo migrator, sem seeds; runtime sem CREATE no schema e sem superuser/CREATEDB/CREATEROLE. Nenhuma tabela `production_*` ficou sem os grants operacionais previstos.
- `scripts/verify-production-published.ts`: login HTTPS real; APIs de produção, fichas, inventário, logística e compras respondem 200 e no-store. Operador passa autorização/licença; leitor recebe 403 ao escrever; perfil suspenso recebe 403 na API e redireciona ao portal na página.
- Navegação real do Next, voltar/avançar, modal de nova ordem, destaque do menu, foco móvel, Escape e ausência de overflow aprovados. Sem erros JavaScript. Capturas: `outputs/production-browser/published-desktop.png` e `published-sidebar-mobile.png`.
- As duas identidades sintéticas foram removidas; consulta posterior confirmou zero contas de validação restantes. Auditorias de login preservadas. Nenhum pedido, recebimento ou saldo real foi criado/alterado pelo teste: as provas transacionais continuam sendo as do PostgreSQL descartável.
- Verificações HTTP pós-publicação: `/` 200, `/api/erp` 401, `/api/saas` 403, ambas as rotas de produção 401 sem sessão, POST de origem externa 403.
- Permissões de manutenção instaladas e testadas, limitadas a quatro comandos root-owned. Detalhes e tratamento da divergência histórica preexistente em [production-maintenance.md](production-maintenance.md).

## Fechamentos adicionais

- Recebimento legado substituído por serviço transacional dimensionado e formulário acessível; o modal antigo sem rastreabilidade foi removido.
- Compras geradas pelo MRP mantêm a variação e entram obrigatoriamente no depósito da produção. Lote, séries, fabricação e validade são validados antes da entrada.
- Histórico de recebimentos é protegido no SQL contra edição/exclusão. Revisões aprovadas preservam aprovador e data. Relações de reserva, lote e suprimento foram explicitadas no Prisma, respeitando as referências SQL existentes.
- Cinco migrations: operações, guardas de evidência, dimensões de compras, histórico de recebimentos e permissões de suprimentos; aplicadas no cluster de teste e no único tenant ativo.
- A inspeção visual do shell revelou colunas de Kanban excessivamente longas com muitos registros; as colunas agora mantêm cabeçalho visível e rolagem interna acessível por teclado, com altura limitada ao viewport.
- O banner introdutório redundante de produção foi removido, preservando um único título de página e trazendo o quadro para mais perto dos controles.
- Publicação e aceite administrativo documentados em [production-release-checklist.md](production-release-checklist.md). A autenticação administrativa fornecida pelo usuário permitiu instalar o executor restrito; sudo administrativo genérico continua protegido por senha.

## Decisões

- Manter os saldos compartilhados do inventário e registrar o vínculo dimensional de cada reserva e consumo. Não criar um estoque paralelo.
- Cada ordem guarda a versão da ficha usada. Alterar uma ficha não altera ordens existentes.
- Apontamentos e evidências são históricos; correções devem ter trilha explícita.
- Comandos repetidos usam uma chave e hash de conteúdo dentro da transação que altera estoque.
- A migração antiga de workflow é preservada; a ampliação terá migration própria.
- O bloqueio inicial de autenticação foi resolvido com autoridade explícita do usuário, sem liberar shell irrestrito sem senha.
