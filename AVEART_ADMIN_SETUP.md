# AVEART Admin Panel — Medusa v2

AVEART will use Medusa's built-in Admin dashboard at `https://<your-medusa-api-host>/app`. Do not build a second admin login into the public storefront: the Medusa Admin already provides authenticated product, category, inventory, customer, order, promotion and settings workflows supported by the installed modules.

## Current implementation

- Added an AVEART product-readiness widget to each product details page in Medusa Admin.
- The widget reminds staff to verify ZAR pricing, product copy/images, size/colour variants, unique SKUs, inventory, and parcel data before publishing.
- The widget is advisory only. It does not create products, change prices, alter stock, or claim to validate data automatically.
- The seed script creates only a test sales channel, South Africa/ZAR region, categories and clearly labelled staging products. It does not enable live payments, shipping, suppliers or fulfilment.

## Enable and open Admin

1. Deploy the Medusa API service with a persistent Node.js container runtime and PostgreSQL + Redis. The API service must run with `MEDUSA_WORKER_MODE=server` or `shared`, not `worker`, for Admin to be served.
2. Set `DISABLE_MEDUSA_ADMIN=false` on the API service. Do not set this on a worker-only service unless intentionally serving the admin there.
3. Set `MEDUSA_BACKEND_URL` to the public HTTPS API origin (for example, `https://api.example.co.za`, with no `/app` suffix).
4. Configure `ADMIN_CORS` and `AUTH_CORS` with only the exact trusted browser origins used for the Admin/auth flow. Configure `STORE_CORS` with the exact AVEART storefront origin. Do not use `*` in production.
5. Generate strong, unique server-side `JWT_SECRET` and `COOKIE_SECRET` values. Store them only in the hosting provider's secret/environment-variable settings. Never commit secrets or expose them in `VITE_*` variables.
6. Create the first admin user on the server against the staging database:
   
   ```sh
   npx medusa user -e YOUR_ADMIN_EMAIL -p 'USE-A-UNIQUE-STRONG-PASSWORD'
   ```

   Run this in the deployed service's shell or the same release environment with the correct staging `DATABASE_URL`. Do not paste credentials into GitHub issues, commits, or this guide.
7. Open `https://<your-medusa-api-host>/app`, sign in, and confirm the dashboard loads. Keep the admin origin private to the intended staff; use MFA/SSO controls if supported by the selected identity/hosting setup.
8. After the database migrations and the guarded seed have been run on a fresh staging database, verify that the region is South Africa/ZAR and that the test products appear in the catalogue. Copy the publishable key from Admin for the public storefront; it is not an admin credential.

## Suggested day-to-day workflow

- **Products:** create/edit product details, categories, images, size/colour options and variant SKUs. Check the AVEART readiness widget on product details.
- **Prices:** enter the South Africa region's prices in ZAR and verify displayed amounts in the storefront before publishing.
- **Inventory:** set real quantities only when fulfilment arrangements are ready. Current seed quantities are test values and must not be treated as real stock.
- **Orders and customers:** these modules become operational as Store API and order flows are configured. Do not treat test orders as customer orders.
- **Users and permissions:** create an individual account per staff member and assign the least-privileged role available. Do not share the owner account or its password.
- **Settings:** review region, sales channel, API keys, tax and shipping settings in staging first. Payment provider, shipping rates, suppliers, fulfilment and live checkout remain explicitly deferred.

## Security and release gates

- Use staging until the admin login, Store API, catalogue and cart have been tested end-to-end.
- Never place database URLs, Redis credentials, JWT/cookie secrets, DebitoPay keys or webhook secrets in the frontend or Git.
- Never run the staging seed against production. It is not idempotent and is guarded by `AVEART_STAGING_SEED=true`.
- Before launch, rotate any temporary credentials, remove test products/stock, configure least privilege, and verify backups, monitoring, HTTPS and account recovery.
- Admin customization build status and runtime behavior must be checked in CI and in the deployed staging dashboard; adding the source file alone does not mean it is already live.
