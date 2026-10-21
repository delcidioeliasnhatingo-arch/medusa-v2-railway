# AVEART staging setup (Medusa v2)

This repository branch adds a **staging-only** seed for AVEART's South Africa/ZAR storefront integration. It does not deploy the backend and does not touch the AVEART Neon production branch.

## What the seed creates

- A Medusa sales channel named `AVEART Staging` and a publishable key linked to that channel.
- A store with ZAR as its default supported currency.
- A South Africa region (`za`) using ZAR.
- Women's clothing, men's clothing and accessories categories.
- Three clearly named staging products with ZAR prices and test inventory.
- A stock location marked as staging-only.

It deliberately does **not** configure a live payment provider, shipping options, supplier integrations or fulfilment.

## Run only on a fresh staging database

1. Deploy the Medusa API and worker to a persistent container runtime, with PostgreSQL and Redis configured. The current Docker image can be used by a compatible container host; Vercel Functions alone are not a drop-in replacement for the API + worker topology.
2. Set server-side environment variables in that host, including `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `COOKIE_SECRET`, `MEDUSA_WORKER_MODE`, `MEDUSA_BACKEND_URL`, `STORE_CORS`, `ADMIN_CORS`, and `AUTH_CORS`. Use generated secrets and exact HTTPS origins. Never commit their values.
3. Confirm that the staging backend health endpoint responds at `/health` and that `/app` is reachable on the server service.
4. Run the seed command against a **fresh staging database only**:

   ```sh
   AVEART_STAGING_SEED=true npx medusa seed ./src/migration-scripts/aveart-staging-seed.ts
   ```

   Do not run it against production or a database that already contains this seed. The seed creates records and is not designed to be re-run.

5. In Medusa Admin, copy the publishable key titled `AVEART Staging Storefront`. Configure the AVEART frontend's public Vite variables:
   - `VITE_MEDUSA_BACKEND_URL`
   - `VITE_MEDUSA_PUBLISHABLE_KEY`
   - `VITE_MEDUSA_REGION_ID` (the South Africa/ZAR region ID)
   - `VITE_MEDUSA_SALES_CHANNEL_ID` (the AVEART Staging sales channel ID)

   These four values are intended for the browser; database credentials and all server/payment secrets must remain server-side.

6. Verify the product listing, detail pages, stock availability and cart add/update/remove on the preview URL. No real checkout/payment is part of this phase.

## Current blockers

- No Medusa schema/migrations have been applied to the connected Neon AVEART database yet; its inspected production branch currently lists only Neon Auth tables.
- The connected Neon production branch must not be used for staging seeding. Create/use a separate staging database/branch before running the seed.
- A persistent runtime and Redis endpoint still need to be selected and verified. Do not claim a live backend deployment until `/health`, `/app`, the Store API and the cart have been tested end-to-end.
- Check provider pricing before provisioning; the desired overall budget is no more than US$5/month, which has not yet been validated for a persistent Medusa server + worker + Redis.
