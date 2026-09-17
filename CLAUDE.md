# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

NALVEN is a multi-tenant SaaS ERP built with Next.js 16, React 19, TypeScript 5.9, Prisma ORM 7, and PostgreSQL 18. It is developed and deployed exclusively on a traditional Linux server (no containers/cloud PaaS) — Nginx and systemd in production. Screens imported from the "v9" prototype are preserved as reference while real modules are built out.

Login, per-user authorization, auditing, fiscal integrations, payments, queues, and domain tests are still being completed before commercial use (see `README.md`'s "Estado atual").

## Commands

```bash
npm install                 # install deps (postinstall runs db:generate)
npm run dev                 # start Next.js dev server
npm run build                # prisma generate (both schemas) + production build
npm run lint                  # ESLint (ignores .next and generated/)
npm test                      # test:unit -> lint -> build (full validation, this is CI-equivalent)
```

Database:

```bash
npm run db:generate                    # regenerate both Prisma clients (control + tenant)
npm run db:migrate:control             # dev migration for prisma/control
npm run db:migrate:tenant              # dev migration for prisma/tenant
npm run db:seed:control                # tsx prisma/control/seed.ts
npm run db:seed:tenant                 # tsx prisma/tenant/seed.ts
npm run db:seed:demo-<area>            # idempotent demo data per ERP area, e.g. db:seed:demo-finance
```

Set `CONTROL_DATABASE_URL` in `.env` for local dev. `TENANT_DATABASE_URL` is only needed when running tenant migrations/seeds directly against a specific organization's database. Never commit `.env` files.

### Running a single test

Tests use Node's built-in test runner via `tsx --test`, not Jest/Vitest — invoke files directly rather than through a script alias when iterating:

```bash
tsx --test tests/pos-domain.test.ts
tsx --test tests/pos-domain.test.ts tests/pos-connectors.test.ts   # multiple files
```

Every `test:*` script in `package.json` is a named group of one or more `tests/*.test.ts` files (e.g. `npm run test:finance`, `npm run test:pos`). `npm run test:unit` chains all of them. There is no single "run everything with one flag" — check `package.json` scripts for the exact grouping before adding a new domain.

Test file suffixes mean different things:
- `*.test.ts` — plain unit/integration test, no external services.
- `*-contract.test.ts` — structural/contract assertions (e.g. shape of an API, invariants across a subsystem), not full env.
- `*-postgres.integration.test.ts` — requires a real PostgreSQL connection (`test:*:postgres` scripts); not part of the default `npm test` unit chain. Run these only when the relevant `DATABASE_URL` env is available.
- `playwright.*.config.ts` (`test:*:browser` scripts) — browser-driven Playwright suites (auth, license, support, production), separate from the Node test runner suites.

### Production deployment

```bash
sudo bash deploy/bootstrap-root.sh
```

Code is developed in `/home/nalven/nalven`. Immutable releases are published to `/srv/nalven/releases`, with `/srv/nalven/current` symlinked to the active release — never edit `/srv/nalven/current` directly; deployments replace the symlink. Secrets live in `/etc/nalven/app.env` (control plane) and `/etc/nalven/tenants/<configKey>.env` etc. (per-tenant, per-authority credentials); uploads in `/var/lib/nalven/uploads`; logs via `journalctl -u nalven`. Keep Node and PostgreSQL bound to `127.0.0.1` behind Nginx.

New organizations are created in `provisioning` state; their database must be created administratively with `sudo nalven-provision-tenant ID SLUG` (see `deploy/provision-tenant.sh`).

## Architecture: database-per-tenant

This is the central architectural fact of the codebase — almost everything else follows from it.

- **`nalven_control`** (accessed via `controlDb`, `db/control.ts`) is the SaaS control plane: organizations, plans, memberships, users, sessions, domains, the tenant database registry (`tenantDatabase`, keyed by `configKey`), site content, billing, audit logs.
- **One PostgreSQL database per organization** (e.g. `nalven_t_demo`), containing all ERP/operational data. **No operational table has a `tenant_id` column** — isolation is physical (separate databases), not row-level. Do not add `tenantId` columns to tenant-schema tables.
- `db/tenant.ts`'s `tenantDb(organizationId)` (and the sibling `tenantManualPayment*Db`/`tenantManualPaymentStepUpIssuerDb`/etc. functions) resolves which database to open: it looks up the organization's `tenantDatabase` record in the control DB (must be `status: "active"`), validates `configKey`/`databaseName` against strict regexes, reads the matching credential file from `/etc/nalven/tenants*/<configKey>.env`, and validates the resulting connection string (must target `127.0.0.1:5432`, database name and Postgres role name must match expected patterns) before opening a cached Prisma client. There are several distinct "authorities" beyond the runtime app connection (`manualWorker`, `manualCallback`, `stepupIssuer`, `manualHomologator`, `manualVaultBinder`) — each reads its own credential file and connects with its own restricted PostgreSQL role, used by separate background workers/services rather than the web app itself.
- **The API never accepts a tenant/organization id from the client as authorization.** `db/context.ts`'s `currentOrganization()` derives the active organization from the authenticated session + membership (`nalven_organization` cookie only *selects* among memberships the session already has; it grants nothing by itself) and, for custom domains, cross-checks the `Host` header against `organizationDomain` records.
- Prisma schemas are separate and generate to separate clients: `prisma/control/schema.prisma` → `generated/control/client`, `prisma/tenant/schema.prisma` → `generated/tenant/client` (applied independently to every organization database). Config for each lives in `prisma.control.config.ts` / `prisma.tenant.config.ts`. Never edit `generated/` or `.next/` directly.
- Full write-up: `docs/erp/ARQUITETURA-MULTITENANT.md` (invariants, provisioning lifecycle, schema evolution across many tenant databases) and `docs/SAAS-CONTROL-PLANE.md` (control-plane feature inventory and integration boundaries).

## Architecture: auth and permissions

- Sessions are opaque tokens in an httpOnly cookie (`nalven_session`); only the SHA-256 hash is persisted (`lib/auth.ts`). Session creation takes a Postgres advisory lock keyed on the user id and revokes the token for the same browser (not other devices) atomically with issuing the new one.
- Each tenant database carries its own `tenant_roles` / `tenant_user_profiles`; a membership's role references a profile key, and APIs must check `resource.read` / `resource.write` permissions server-side per request (write implies read; `*` is reserved for full-access profiles). Don't assume client-declared roles.
- Invitations use a random token shown once; only its SHA-256 persists, expiring in 7 days.
- Runtime secrets configured through the admin panel (provider credentials, webhook HMAC secrets) are encrypted with AES-256-GCM in `vault_secrets` (`lib/vault.ts`); only the single global master key lives outside PostgreSQL.

## Request pipeline

`proxy.ts` (Next.js proxy/middleware) runs before every request: validates request origin/mutation safety (`lib/http-security.ts`), enforces a max API body size, applies security headers per API prefix, handles legacy path redirects sourced from `siteRedirect` in the control DB, and records navigation analytics. `PRIVATE_API_PREFIXES` (`/api/admin`, `/api/auth`, `/api/erp`, `/api/internal`, `/api/portal`, `/api/pos-agent`, `/api/saas`, `/api/webhooks`) get stricter header treatment than public routes.

## Code layout

- `app/` — Next.js routes and pages; `app/api/<area>` mirrors the functional areas (`admin`, `analytics`, `auth`, `erp`, `health`, `internal`, `media`, `portal`, `pos-agent`, `public`, `saas`, `webhooks`).
- `db/` — the control/tenant Prisma client resolution described above; this is the only place that should open Prisma clients.
- `lib/` — cross-cutting domain logic (`auth.ts`, `vault.ts`, `tenant-access.ts`, `password.ts`/`password-policy.ts`, `http-security.ts`, `internal-jobs.ts`) plus subdirectories per concern (`billing/`, `erp/`, `integrations/`, `analytics/`, `site/`).
- `components/` — UI components mirroring the same functional split (`admin`, `auth`, `erp`, `portal`).
- `scripts/` — one-off/operational TypeScript scripts run via `tsx` (demo seeders, backfills, background job runners, conformance/readiness checks).
- `deploy/` — Nginx config, systemd unit/timer files, and the production publish/provisioning/cutover shell scripts. These operate on a real production host; treat changes here as high-risk.
- `docs/` — living architecture and audit documentation, organized per area (`erp/`, `saas/`, `portal/`, `security/`, `site/`). Check here before re-deriving how a subsystem works — most non-trivial subsystems (PDV/POS, fiscal, billing, LGPD/privacy, integrations) already have a design doc.

## Coding conventions

TypeScript strict mode, two-space indentation, semicolons, double quotes. React components in `PascalCase`; functions/variables in `camelCase`; env vars in `UPPER_SNAKE_CASE`. Keep API endpoints under `app/api/`. Extract focused components/services instead of expanding a single page file (e.g. avoid growing `app/page.tsx`).
