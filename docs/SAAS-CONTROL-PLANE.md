# SaaS Control Plane

## Implemented

- Public-site content stored in PostgreSQL and editable by superadmins.
- Plans, prices, seats, modules, organizations, users, roles and account status.
- Tenant database registry, domains, provisioning queue and operational status.
- Platform integrations, email templates, HTTPS webhooks and announcements.
- Sessions, RBAC, audit logs, backups, exports and infrastructure health.
- Database-per-tenant architecture with restricted PostgreSQL roles.

## Integration boundaries

The control plane stores configuration and lifecycle state. Provider adapters never expose secrets through read APIs. Product credentials and webhook HMAC secrets are encrypted in `vault_secrets` with AES-256-GCM; only the single global master key remains outside PostgreSQL. Tenant database credentials stay in `/etc/nalven/tenants/` with restricted permissions.

Required provider adapters:

- Transactional email: SMTP/API delivery, verification and password reset.
- Billing: customer, subscription, invoice, PIX/card and signed webhook reconciliation.
- Storage: encrypted backup/export upload, retention and restore verification.
- Observability: structured logs, metrics, alert delivery and uptime probes.

## Operational workers

- Provision pending tenant databases and record attempts/errors.
- Dispatch signed webhooks with retry and dead-letter handling.
- Generate exports asynchronously with expiry and authorization checks.
- Execute backups, verify dumps and periodically test restoration.
- Send transactional emails and scheduled billing notifications.

## Security completion

- Rate-limit authentication and sensitive administrative actions.
- Add email verification, password reset, MFA and session revocation UI.
- Add MFA and a session revocation interface for sensitive administration.
- Preserve credential fingerprints, one-time display and rotation audit for every provider.
- Add immutable audit retention, consent records and LGPD data workflows.

Provider-specific activation depends on credentials and commercial choices, but these boundaries must remain stable regardless of provider.
