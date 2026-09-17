# NALVEN

Base do SaaS ERP NALVEN para desenvolvimento em servidor Linux tradicional.

## Stack

- Next.js 16, React 19 e TypeScript 5.9
- Node.js 24 LTS
- PostgreSQL 18
- Prisma ORM 7 com adapter PostgreSQL
- Nginx e systemd em produção

A hospedagem é exclusivamente no servidor Linux próprio. As telas importadas do protótipo v9 foram preservadas como referência inicial enquanto os módulos reais são desenvolvidos.

## Estrutura

- `app/`: páginas e endpoints HTTP do Next.js.
- `app/api/erp`: produtos, estoque e vendas.
- `app/api/saas`: planos, tenants, faturas e chamados.
- `db/`: cliente Prisma compartilhado.
- `prisma/control/`: organizações, planos, domínios e catálogo de bancos.
- `prisma/tenant/`: modelo e migrations aplicados separadamente em cada organização.
- `public/`: imagens e outros arquivos públicos.
- `deploy/`: Nginx, systemd e script de publicação.

## Desenvolvimento

Defina uma conexão PostgreSQL em `.env`:

```dotenv
CONTROL_DATABASE_URL=postgresql://usuario:senha@127.0.0.1:5432/nalven
```

Depois execute:

```bash
npm install
npm run db:migrate:control
npm run dev
```

Validação completa:

```bash
npm run lint
npm run test
```

## Produção

O código é desenvolvido em `/home/nalven/nalven`. Releases imutáveis são publicados em `/srv/nalven/releases`, e `/srv/nalven/current` aponta para o release ativo.

```bash
npm run build
sudo bash deploy/bootstrap-root.sh
```

Segredos permanecem em `/etc/nalven/app.env`, uploads em `/var/lib/nalven/uploads` e logs em `journalctl -u nalven`. Não edite `/srv/nalven/current` diretamente.

## Estado atual

O control plane e o banco ERP isolado de demonstração estão funcionais. Uma nova organização é criada no estado `provisioning` e seu banco deve ser criado administrativamente com `sudo nalven-provision-tenant ID SLUG`. Login, autorização por usuário, auditoria, integrações fiscais, pagamentos, filas e testes de domínio ainda precisam ser implementados antes do uso comercial.
