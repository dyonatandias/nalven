# Central fiscal

## Identificação

- Rota: `/erp/fiscal`
- API implementada: `/api/erp/fiscal`
- Grupo: FISCAL
- Estado atual: **Parcial — persistência de homologação; emissão real bloqueada**
- SQL de referência: [fiscal.sql](../sql/fiscal.sql)

## Objetivo

Operar NF-e, NFC-e, NFS-e, contingência, eventos e rejeições.

## Modelo de dados

- `fiscal_documents`
- `fiscal_events`
- `fiscal_certificates`
- `branch_settings`

Todas as tabelas pertencem ao banco exclusivo da organização e não possuem `tenant_id`. Referências de usuário usam o identificador do plano de controle apenas como ator/auditoria, sem relação SQL entre bancos.

## API e interface

- `GET /api/erp/fiscal`: entrega catálogo, histórico e resumo derivados do tenant atual.
- A rota fiscal legada não atesta autorização/cancelamento por ação humana. O PDV possui producer/outbox/worker/callback duráveis em homologação, mas XML, assinatura, DANFE, storage e SEFAZ reais permanecem pendentes.
- A interface possui estado vazio, carregamento, erro e feedback sem expor respostas brutas.
- Valores exibidos vêm exclusivamente da API e do banco da organização.

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
