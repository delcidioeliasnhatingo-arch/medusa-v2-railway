# Debito Pay webhook (AVEART)

## Endpoint

After the Medusa server is deployed with this change, register this HTTPS URL in Debito Pay → Settings → Webhooks:

`https://YOUR-MEDUSA-SERVER-DOMAIN/webhooks/debitopay`

Subscribe to:
- `payment.completed`
- `payment.failed`
- `payment.refunded`
- `payment.chargeback`

## Railway variable

On the **medusa-server** service, add:

- `DEBITOPAY_WEBHOOK_SECRET`: the webhook signing secret supplied/generated in Debito Pay's webhook settings.

Use the exact secret from Debito Pay. Do not put it in GitHub, the storefront, or a public message. Save the variable and redeploy the server.

## What the endpoint does

- Preserves the raw request body for signature verification.
- Validates `x-webhook-signature` with HMAC-SHA256 and a constant-time comparison.
- Rejects invalid signatures and malformed/unsupported events.
- Acknowledges verified events quickly with HTTP 200.

## Important current limitation

This change installs the secure webhook receiver only. It does **not** yet create Debito Pay checkout sessions or mark Medusa orders as paid. Before accepting real orders, the checkout/payment-provider flow must persist the Medusa payment-session/order reference and reconcile it against the verified Debito Pay event. Do not treat a webhook acknowledgment alone as proof that a Medusa order was paid.
