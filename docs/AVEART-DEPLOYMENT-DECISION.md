# AVEART deployment decision: Medusa backend and Vercel

## Current status

This repository is a Medusa v2.20.1 backend template. It includes a Docker image, a server/worker start script, PostgreSQL configuration, Redis-backed event bus/workflow/cache/locking modules, and a custom DebitoPay payment provider.

The existing deployment definition (`railway.json`) is Railway-specific. The start script also contains Railway service-name fallbacks. These must not be assumed to work unchanged on Vercel.

## Decision

- Keep the existing production branch unchanged.
- Use Vercel only for the storefront/frontend if its framework and commercial plan fit the project.
- Do not deploy the complete Medusa backend to Vercel Functions as if it were a conventional serverless API. Medusa's documented production topology requires a persistent Node.js server, PostgreSQL, Redis, and a worker for background tasks.
- Select a backend host that supports a long-running Node.js/Docker service and worker, or deliberately redesign and validate the architecture before using a serverless host.
- Neon can provide PostgreSQL. It does not replace Redis or the Medusa worker.

Official reference: https://docs.medusajs.com/learn/deployment/general

## Required environment variables

Set secrets in the hosting provider's environment-variable settings only. Never commit actual values.

Core:
- `DATABASE_URL` — Neon PostgreSQL connection string.
- `REDIS_URL` — managed Redis connection string.
- `JWT_SECRET` and `COOKIE_SECRET` — unique, strong random secrets.
- `MEDUSA_WORKER_MODE` — `server` for the public API service and `worker` for the worker service.
- `MEDUSA_BACKEND_URL`, `ADMIN_CORS`, `STORE_CORS`, `AUTH_CORS` — real deployed origins.
- `PORT` — use the port required by the selected host (the current template defaults to 9000).

DebitoPay:
- `DEBITOPAY_API_KEY`
- `DEBITOPAY_MERCHANT_ID`
- `DEBITOPAY_WALLET_CODE`
- `DEBITOPAY_API_BASE_URL`
- `DEBITOPAY_PAYMENT_ENDPOINT`
- `DEBITOPAY_WEBHOOK_SECRET`
- `DEBITOPAY_RETURN_URL` (if required by the chosen checkout flow)

Do not use placeholder or test credentials in production. Confirm the provider's supported currencies, payment methods, webhook signature rules, and refund handling before enabling real payments.

## Deployment acceptance checklist

- [ ] CI installs dependencies and builds the Medusa application.
- [ ] PostgreSQL connection is verified and migrations complete.
- [ ] Redis is reachable by both server and worker.
- [ ] Server starts and `/health` returns `OK`.
- [ ] Admin dashboard is reachable at `/app` and admin credentials are unique.
- [ ] Storefront origin is configured in CORS.
- [ ] Worker starts without exposing a public endpoint.
- [ ] A test product, cart, checkout, and order are verified.
- [ ] DebitoPay sandbox payment and signed webhook are verified end to end.
- [ ] Secrets are stored only in provider settings, not in Git.
- [ ] Monthly total cost is checked against the user's USD 5 budget before production activation.

## Important

This file records the deployment decision and readiness criteria. It does not claim that a live deployment, database, Redis instance, Vercel project, or payment transaction has been created or tested.
