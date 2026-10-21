# AVEART — implementation and deployment checklist

This document tracks the AVEART store integration. It is a working plan, not a claim that production is already deployed.

## Target architecture

- **Storefront:** existing React site in `delcidioeliasnhatingo-arch/AveartSouth-Africa`; keep GitHub as source control and preserve GitHub Pages while the frontend is being adapted.
- **Commerce backend:** Medusa v2.20.1 in `delcidioeliasnhatingo-arch/medusa-v2-railway`.
- **Database:** existing Neon project named `AVEART`; use its PostgreSQL connection string only as a hosting secret.
- **Payments:** DebitoPay provider already present in the Medusa repository. For South African orders, the intended method is PayFast in ZAR, subject to merchant/wallet eligibility and a successful sandbox transaction.
- **Email:** Resend is a possible later addition for order notifications; not required to prove the first checkout.
- **Images:** use the existing image URLs initially; move to object storage only if needed.
- **Hosting:** not selected/connected yet. Do not deploy the production backend to Vercel Hobby: Medusa expects a persistent Node server and background worker, and Vercel Hobby is non-commercial. The final host must support Node/Docker, environment secrets, HTTPS webhooks, a long-running process, and enough memory.

## Completed in GitHub

- [x] Created branch `aveart-deployment-prep` in the Medusa repository.
- [x] Added the deployment decision document.
- [x] Added GitHub Actions CI that installs dependencies and builds Medusa.
- [x] CI run `39587896200` completed successfully for the initial branch revision.
- [x] Opened draft PR #10; `main` has not been changed or merged.

## Next implementation stages

### Stage 1 — Backend build and safety
- [x] Confirm Medusa dependencies install and `npm run build` succeeds in CI.
- [ ] Review provider/webhook behaviour against DebitoPay's actual API contract.
- [ ] Add automated tests for payment status mapping, HMAC verification, currency/method restrictions, and webhook reconciliation.
- [ ] Confirm the exact API response fields and signature format with a DebitoPay sandbox transaction.
- [ ] Verify database migrations and `GET /health` on a deployed staging instance.

### Stage 2 — Connect the existing storefront
- [ ] Inspect the frontend repository and map its current product/cart/checkout components.
- [ ] Configure one public backend URL in the frontend build environment (for example `VITE_MEDUSA_BACKEND_URL`, after confirming the frontend build tool).
- [ ] Replace demo/test product data with Medusa Store API data.
- [ ] Make product variants, prices and currency come from Medusa; configure the South African sales channel and ZAR.
- [ ] Persist the cart through Medusa instead of local-only checkout state.
- [ ] Create checkout/payment sessions server-side; never expose API keys or webhook secrets in frontend code.
- [ ] Show pending, failed, and completed payment states and an order confirmation page.

### Stage 3 — Infrastructure
- [ ] Choose a host that fits the total budget of **US$5/month or less** and can run the required Medusa processes.
- [ ] Create/verify a Redis service for Medusa event bus, workflows, cache and locking; do not assume Neon replaces Redis.
- [ ] Add database and Redis URLs only in the hosting provider's secret-variable panel.
- [ ] Generate unique `JWT_SECRET`, `COOKIE_SECRET`, and an initial admin password; never commit them.
- [ ] Set `MEDUSA_BACKEND_URL`, `STORE_CORS`, `ADMIN_CORS`, and `AUTH_CORS` to exact HTTPS origins.
- [ ] Configure migrations to run once from the server process, not concurrently from server and worker.
- [ ] Check logs, health endpoint, restart behaviour, and backup/restore procedure.

### Stage 4 — Catalogue and operations
- [ ] Create categories: clothing, footwear, accessories.
- [ ] Add one test product with a real variant, image, SKU, ZAR price and stock/availability policy.
- [ ] Define shipping zones/rates for South Africa, delivery estimates, returns and refund handling.
- [ ] Configure tax treatment only after the seller's tax obligations and price-inclusion rules are confirmed.
- [ ] Configure admin access and test an order from product page through order management.
- [ ] Add email notifications after the first end-to-end order works.

### Stage 5 — Payment verification and launch
- [ ] Confirm DebitoPay merchant ID, wallet code, PayFast eligibility, and ZAR settlement in the provider dashboard/support.
- [ ] Use sandbox/test credentials first; no live charge until the full flow is verified.
- [ ] Verify signed webhook delivery, replay/idempotency handling, payment ID, amount and currency against the stored Medusa session.
- [ ] Test success, pending, failure, duplicate webhook, delayed webhook, cancelled checkout, and reconciliation.
- [ ] Confirm that a browser return URL alone can never mark an order as paid.
- [ ] Test mobile layout, CORS, HTTPS, customer account access, order status, and admin access.
- [ ] Only then promote the PR and point the live storefront to the backend.

## Environment variables

Core:
- `DATABASE_URL`
- `REDIS_URL`
- `JWT_SECRET`
- `COOKIE_SECRET`
- `MEDUSA_WORKER_MODE` (`shared` for a constrained single process, or `server` and `worker` when the host supports both)
- `MEDUSA_BACKEND_URL`
- `STORE_CORS`
- `ADMIN_CORS`
- `AUTH_CORS`
- `PORT`

DebitoPay:
- `DEBITOPAY_API_KEY`
- `DEBITOPAY_MERCHANT_ID`
- `DEBITOPAY_WALLET_CODE`
- `DEBITOPAY_API_BASE_URL`
- `DEBITOPAY_PAYMENT_ENDPOINT`
- `DEBITOPAY_WEBHOOK_SECRET`
- `DEBITOPAY_RETURN_URL` (optional fallback)

Never add real values to this file, Git commits, browser JavaScript, screenshots, or public issues.

## Current blockers

1. The connected Railway account currently has no projects available, so no Railway deployment can be started from the connected account.
2. The connected Vercel account exposes no accessible projects, and Vercel Hobby is not an appropriate production host for a commercial Medusa store.
3. A backend host that fits the total budget and supports Medusa's runtime still needs to be selected/connected.
4. DebitoPay live/sandbox merchant configuration is not available in the repository; payment compatibility cannot be declared proven until tested.
