# Empresas e filiais

## Identificação e objetivo

- Rota: `/erp/branches`
- APIs: `GET/POST /api/erp/branches` e `PATCH /api/erp/branches/{id}`
- Estado: **Real inicial**

Mantém CNPJs e unidades operacionais dentro do banco PostgreSQL exclusivo da organização. Filial não cria tenant nem banco adicional.

## Dados e interface

- `branches`: identidade, endereço, contato, situação, tipo e depósito padrão.
- `branch_settings`: regime, ambiente fiscal, séries e próximos números.
- `warehouses.branch_id`: vínculo exclusivo do depósito com a unidade.
- `tenant_user_profiles.active_branch_id`: contexto operacional preferido do usuário.
- `tenant_audit_events`: criação, edição, situação e seleção da filial.

A tela apresenta indicadores, cartões das unidades, saldo agregado de depósitos, configuração fiscal e formulário responsivo. Não há JSON exposto, dado mockado ou fallback.

## Regras implementadas

1. CNPJ, e-mail, UF, timezone e séries fiscais são validados no servidor.
2. Código, CNPJ e depósito padrão são únicos; somente uma matriz é principal.
3. Depósito precisa estar ativo e não pode pertencer a outra filial.
4. A matriz principal não pode ser inativada; inativação limpa o contexto dos usuários.
5. Leitura exige `branches.read`; criação/edição exige `branches.write`, licença e CSRF same-origin.
6. A organização vem da sessão e resolve seu próprio datasource cifrado; nunca do payload.

## Aceite verificado

- Migration e seed idempotente aplicados ao tenant demo.
- CRUD, seleção contextual, inativação/reativação e proteção da matriz exercitados.
- CNPJ inválido, duplicidade, CSRF e usuário sem permissão retornam erros controlados.
- Saldos de produto continuam conciliados com a soma dos depósitos.
