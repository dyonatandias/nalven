# Auditoria e implementação — Empresas e filiais

## Diagnóstico encontrado

A tela anterior mantinha cadastro legal, fiscal, depósitos, catálogo e usuários, mas apresentava todos esses domínios em um único modal longo. Não existiam hierarquia explícita entre matriz e filial, ciclo de implantação, índice de prontidão, agenda operacional, capacidades por unidade, exportação, visão consolidada de dependências ou histórico acessível. A troca de status não exigia justificativa nem versão e podia inativar uma unidade sem avaliar caixas, pedidos, reservas e expedições. A remoção de um depósito também não protegia saldo e operação ativos. Nos cartões, vários textos usavam fontes entre 6 px e 8 px.

## O que foi implementado

- Central responsiva com visão executiva, filtros por situação, tipo, UF e prontidão, ordenação, paginação e CSV.
- Hierarquia matriz–filiais e eleição transacional de uma única matriz principal.
- Ciclo `planned → active → inactive`, com motivo obrigatório e auditoria.
- Prontidão ponderada para identidade legal, tributário, endereço, contato, depósito, equipe, catálogo, fiscal e horários.
- Capacidades independentes de vendas, compras, estoque, fiscal e serviços.
- Horário semanal validado, CNAE, início da operação, isenção de IE e observações internas.
- Perfil 360 com identificação, operação, depósitos, caixas, pedidos, reservas, separação, manifestos, certificados, DFe, contas, títulos, pedidos, entradas e histórico.
- Editor em sete etapas, catálogo local completo, políticas de reposição e matriz de acesso por usuário.
- Duplicação assistida de configuração sem copiar CNPJ, código ou depósitos exclusivos.
- Controle otimista de concorrência por `version`, transações serializáveis, limite de corpo, rate limit, mesma origem, RBAC, modo somente leitura da licença e respostas privadas sem cache.
- Inativação bloqueada enquanto houver caixa, pedido, reserva, onda de separação ou manifesto em aberto.
- Desvinculação de depósito bloqueada quando houver saldo, reserva ou caixa ativo.
- Seed demonstrativo idempotente com matrizes, lojas ativas, centro de distribuição, unidade inativa e implantação incompleta.

## Critérios de validação

- Testes de domínio, entrada, consulta/CSV, schema/migration, segurança de API, contrato da interface e seed.
- Prisma generate e migration auditados contra clone do banco de produção.
- TypeScript, ESLint, testes unitários globais e build de produção sem erros ou avisos pendentes.
- Backup pré-deploy, release imutável, migration do tenant demo, seed protegido e smoke autenticado da página e APIs.
