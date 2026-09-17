# Repository Guidelines

## Project Structure & Module Organization

This is a TypeScript SaaS starter built with Next.js, React, Prisma, and PostgreSQL.

- `app/`: UI, layouts, and route handlers under `app/api/`.
- `db/`: control-plane client, tenant resolution, and per-database client cache.
- `prisma/control/`: central SaaS metadata schema and migrations.
- `prisma/tenant/`: ERP schema and migrations applied to every organization database.
- `public/`: static browser assets.
- `.next/` and `generated/`: generated output; never edit directly.
- `deploy/`: Nginx, systemd, and production deployment configuration.
- `tsconfig.server.json` and `tsconfig.web.json`: separate TypeScript settings for Node and browser code.

## Build, Test, and Development Commands

- `npm install`: install dependencies and update the local dependency tree.
- `npm run dev`: start the Next.js development server.
- `npm run lint`: check repository code with ESLint.
- `npm run build`: generate Prisma Client and create the Next.js production build.
- `npm test`: run lint and a production build.
- `npm run db:migrate`: create/apply development migrations.
- `npm run db:seed`: load idempotent demonstration records.
- `sudo -n /usr/local/libexec/nalven/publish-current.sh`: publish through the installed, root-owned pipeline (clean dependencies, generation, tests, build, backup, migration checks, atomic release and rollback).
- `bootstrap-root.sh` is first-install only. Legacy publishers are disabled. Never run seeds or development migrations against production.
- Production migrations require a root-reviewed checksum approval in `/etc/nalven/migration-approvals.sha256` and the installed `production-maintenance.sh migrate`; control migrations use `/etc/nalven/control-migrator.env`, never the runtime account.

Set `CONTROL_DATABASE_URL` for the SaaS control database and `TENANT_DATABASE_URL` only when running tenant migrations or seeds. Runtime secrets configured in the admin panel are encrypted in `vault_secrets`; never commit `.env` files, master keys, or credentials.

## Coding Style & Naming Conventions

Use TypeScript in strict mode, two-space indentation, semicolons, and double quotes. Name React components with `PascalCase`, functions and variables with `camelCase`, and environment variables with `UPPER_SNAKE_CASE`. Keep API endpoints under `/api`. Extract focused components and services instead of expanding `app/page.tsx`. ESLint is configured; ensure `npm run lint` passes.

## Testing Guidelines

There is no unit-test framework or coverage threshold yet. For every change, run `npm test` and verify `/`, `/api/erp`, and `/api/saas`. Name future tests `*.test.ts` or `*.test.tsx` beside the tested module.

## Commit & Pull Request Guidelines

No Git history is currently available to infer an established convention. Use concise Conventional Commit messages, such as `feat: add tenant registration` or `fix: close database pool on shutdown`. Pull requests should explain the change, list validation commands, link relevant issues, and include screenshots for visible UI changes. Highlight database migrations, configuration changes, and deployment risks explicitly.

## Security & Configuration

Production secrets belong in `/etc/nalven/app.env`; tenant credentials belong in `/etc/nalven/tenants/`; persistent uploads belong in `/var/lib/nalven/uploads`. Never commit `.env` files. ERP data belongs in the organization-specific database—do not add `tenantId` columns to tenant tables. Do not edit `/srv/nalven/current`; deployments replace that symlink. Keep Node and PostgreSQL bound to localhost behind Nginx.
