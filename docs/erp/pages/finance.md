# Contas a pagar/receber

## Identificação

- Rota: `/erp/finance`
- API implementada: `/api/erp/finance`
- Grupo: FINANCEIRO
- Estado atual: **Parcial — títulos operacionais; subledger PDV pendente**
- SQL de referência: [finance.sql](../sql/finance.sql)

## Objetivo

Controlar contas a pagar e receber, baixas parciais ou totais, juros, descontos e vínculos operacionais.

## Modelo de dados

- `financial_titles`
- `financial_settlements`

Todas as tabelas pertencem ao banco exclusivo da organização e não possuem `tenant_id`. Referências de usuário usam o identificador do plano de controle apenas como ator/auditoria, sem relação SQL entre bancos.

## API e interface

- `GET /api/erp/finance`: entrega catálogo, histórico e resumo derivados do tenant atual.
- `POST /api/erp/finance`: executa comandos validados, autorizados e auditados conforme o módulo.
- A interface possui estado vazio, carregamento, erro e feedback sem expor respostas brutas.
- Valores exibidos vêm exclusivamente da API e do banco da organização.
- Venda, CMV, imposto, clearing/MDR, refund, diferença de caixa e contas de valor ainda não alimentam um diário de partidas dobradas.

## Regras e segurança

1. Resolver organização pela sessão, nunca por parâmetro confiado do cliente.
2. Validar entitlement e permissão de ação antes de abrir transação.
3. Validar payload no servidor e limitar paginação/exportação.
4. Registrar auditoria e correlation ID em toda escrita.
5. Usar outbox e chave idempotente quando houver efeito em outro módulo ou serviço.
6. Impedir exclusão física de registros com vínculo; usar cancelamento/inativação.

## Critérios de aceite

- Migration aplicada no banco demo com Prisma Migrate.
- Fluxos e transições exercitados com testes positivos, negativos e de repetição.
- Permissão de leitura negada para o perfil restrito em cada rota.
- Interface responsiva, sem JSON bruto e sem números de fallback.
- Auditoria, correlação e invariantes transacionais verificados.
