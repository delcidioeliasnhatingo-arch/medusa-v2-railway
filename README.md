# AVEART Medusa backend

Medusa v2 backend for AVEART, with a Debito Pay payment provider and webhook handler.

## Deployment target

- **Database:** Neon PostgreSQL, project `AveartBackend`, branch `production`.
- **Application runtime:** Docker-capable web host (Render configuration is in `render.yaml`).
- **Admin:** served at `/app`.
- **Health:** `/health`.
- **Store API:** `/store/*`; requests to protected store endpoints need the Medusa publishable API key in `x-publishable-api-key`.
- **Debito Pay webhook:** `/webhooks/debitopay`.

Neon is the PostgreSQL database service; it does not execute the Medusa Node.js server itself.

## Required environment variables

Configure these as secrets/variables in the application host, not in Git:

- `DATABASE_URL`: Neon connection string for the `AveartBackend` production branch.
- `JWT_SECRET`, `COOKIE_SECRET`: unique, strong production secrets.
- `MEDUSA_ADMIN_PASSWORD`: strong admin password.
- `ADMIN_CORS`, `AUTH_CORS`, `STORE_CORS`: exact HTTPS origins for the backend/admin and storefront.
- `DEBITOPAY_API_KEY`, `DEBITOPAY_MERCHANT_ID`, `DEBITOPAY_WALLET_CODE`, `DEBITOPAY_WEBHOOK_SECRET`: values from the Debito Pay merchant dashboard.

`REDIS_URL` is optional for a single-instance low-cost deployment. Without Redis, Medusa uses in-memory event/workflow/cache/locking defaults. This is not the recommended topology for multiple replicas or high-volume production.

## First deployment checklist

1. Add the Neon connection string as `DATABASE_URL` in the host's secret environment variables.
2. Set all CORS origins to the actual AVEART storefront and backend HTTPS URLs.
3. Set a strong admin password and Debito Pay secrets in the host dashboard.
4. Deploy the Docker service. On first boot, `start.sh` waits for PostgreSQL and runs `medusa db:migrate`.
5. Verify `/health`, sign in at `/app`, create a publishable API key, and configure the sales channel/region/payment provider.
6. Register the Debito Pay webhook URL as `https://<backend-domain>/webhooks/debitopay`.
7. Test a real sandbox payment session end-to-end. A successful webhook health check alone does not prove payment reconciliation.

## Safety notes

- Never commit `.env`, database passwords, payment API keys, webhook secrets, or admin passwords.
- Do not run migrations against a production database until the correct Neon project/branch is confirmed.
- The initial Neon project should be treated as a fresh database unless a read-only inspection confirms otherwise.
