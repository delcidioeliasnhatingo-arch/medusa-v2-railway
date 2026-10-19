# AVEART Medusa backend

Medusa v2 backend for AVEART, using Neon PostgreSQL and the custom Debito Pay payment provider.

## Confirmed Neon setup

- Neon account: **NHatingo** (secondary account; do not switch to Primary).
- Neon project: `AveartBackend`.
- Database: `neondb`.
- Production branch: `production` — preserve it until staging validation passes.
- Staging branch: `aveart-medusa-staging` — use this branch for first migrations and tests.
- Medusa Admin: `/app`.
- Health endpoint: `/health`.
- Store API: `/store/*`; protected Store API requests require `x-publishable-api-key`.
- Debito Pay webhook: `/webhooks/debitopay`.

## Important hosting boundary

Neon is the PostgreSQL database service. It does **not** host the complete Medusa server, its Admin dashboard, or a persistent Node.js process. The Dockerfile in this repository packages the Medusa application, but it still needs a compatible application runtime to run. Do not deploy Medusa as if a Neon database URL were an application URL, and do not point the storefront directly at Neon.

## Neon connection configuration

Set `DATABASE_URL` to the PostgreSQL connection string copied from the **NHatingo → AveartBackend → aveart-medusa-staging** branch for staging. Keep the connection string in the runtime's secret/environment settings only; never commit it to Git. Use the production branch's URL only after staging tests pass.

For a staging migration run from GitHub Actions, add a repository Actions secret named `NEON_STAGING_DATABASE_URL` containing the staging branch's connection string. The workflow `.github/workflows/neon-staging-migrate.yml` is manual-only and never targets production.

## Required runtime variables

- `DATABASE_URL`: Neon PostgreSQL connection string for the selected branch.
- `JWT_SECRET`, `COOKIE_SECRET`: unique, strong secrets.
- `MEDUSA_ADMIN_EMAIL`: `delcidioeliasnhatingo@gmail.com`.
- `MEDUSA_ADMIN_PASSWORD`: strong password; never store it in source control.
- `ADMIN_CORS`, `AUTH_CORS`, `STORE_CORS`: exact HTTPS origins for the admin, auth clients and storefront.
- `DEBITOPAY_API_KEY`, `DEBITOPAY_MERCHANT_ID`, `DEBITOPAY_WALLET_CODE`, `DEBITOPAY_WEBHOOK_SECRET`: values from the Debito Pay merchant dashboard.
- `DEBITOPAY_RETURN_URL`: the real storefront return URL.
- `PORT`: normally `9000`.
- `MEDUSA_WORKER_MODE`: `shared` for a single-instance server.
- `MIGRATE_ON_BOOT`: only enable when the runtime is configured to run migrations safely.

`REDIS_URL` is optional for a small single-instance test deployment. Without it, Medusa uses in-memory event/workflow/cache/locking implementations, which are not suitable for horizontally scaled production.

## Staging validation sequence

1. Configure the staging connection string in the runtime or GitHub Actions secret store.
2. Run the manual Neon staging migration workflow.
3. Start the Medusa application on a compatible Node.js/Docker runtime with staging variables.
4. Verify `/health`, Admin at `/app`, Store API with the publishable API key, products, region, sales channel, and payment provider.
5. Test Debito Pay in sandbox, including signed webhook delivery and payment reconciliation.
6. Only after all checks pass, plan the production migration separately.

## Safety

- No production database migration should run until staging has passed validation.
- Do not commit `.env`, Neon URLs/passwords, payment keys, webhook secrets or admin passwords.
- Never treat a webhook health-check GET as proof that payment webhook signatures and reconciliation work.
