# Debito Pay payments and webhooks — AVEART

## Webhook URL

Register this HTTPS endpoint in Debito Pay → Settings → Webhooks:

`https://aveart-medusa-backend-production.up.railway.app/webhooks/debitopay`

Subscribe to `payment.completed`, `payment.failed`, `payment.refunded`, and `payment.chargeback`.

## Required Railway variables

On the production `AVEART-Medusa-Backend` service:

- `DEBITOPAY_API_KEY`: private API key from Debito Pay Merchant → Settings → API.
- `DEBITOPAY_MERCHANT_ID`: merchant UUID.
- `DEBITOPAY_WALLET_CODE`: wallet code.
- `DEBITOPAY_API_BASE_URL`: normally `https://gyqoaningqhurhvdugne.supabase.co/functions/v1`.
- `DEBITOPAY_PAYMENT_ENDPOINT`: normally `payment-orchestrator`.
- `DEBITOPAY_WEBHOOK_SECRET`: the separate webhook signing secret from Settings → Webhooks, not the API key.
- `DEBITOPAY_RETURN_URL` (optional): fallback return URL for hosted checkout; the storefront should normally send `data.return_url`.

The URL, API key, merchant ID, wallet code, and webhook secret have different purposes. Do not use the API key as the webhook secret unless Debito Pay support confirms that is their configured signing contract. Never publish secret values.

## Medusa payment provider

The backend registers provider ID `pp_debitopay_debitopay`. After deployment, enable **Debito Pay** in Medusa Admin → Settings → Regions for each region where it should appear.

When creating a payment session, pass a supported method in `data.payment_method`:

- `mpesa` (MZN; minimum 10 MZN; requires `data.phone`)
- `emola` (MZN; minimum 50 MZN; requires `data.phone`)
- `mkesh` (MZN; minimum 10 MZN; requires `data.phone`)
- `visa_mastercard` (MZN; minimum 50 MZN; requires `data.return_url`)
- `payfast` (ZAR; minimum 5 ZAR; requires `data.return_url`)

For card/PayFast payment sessions, the storefront should redirect the customer to `data.checkout_url` returned by Medusa. Do not treat the return URL or a browser-side success message as payment proof.

## Webhook processing

The receiver preserves the exact raw request body and validates `x-webhook-signature` using HMAC-SHA256 and a constant-time comparison. It acknowledges signed sample/test notifications that do not match a stored payment session, but those are **not** treated as paid orders. For real `payment.completed` notifications matching a Medusa payment session, the event is passed into Medusa's payment-webhook workflow. `payment.failed` updates the matching payment session to an error state.

The published Debito Pay API does not document refund-creation or transaction-cancellation endpoints. Refund/chargeback notifications are authenticated and logged, but still require explicit reconciliation; they are not automatically processed as refunds in Medusa.

## Verification checklist

1. Verify the webhook secret in Debito Pay Settings → Webhooks and set that exact dedicated secret in Railway.
2. Redeploy the backend after any variable change.
3. Send a new test webhook and confirm the receiver returns `200` for a valid signature and `401` for a deliberately invalid signature.
4. Run a real sandbox/test checkout using a Medusa payment session and verify that Debito Pay shows the payment as successful and Medusa records the session/payment accordingly.
5. Confirm currency/method constraints in the region and storefront before enabling real-money payments.

A `200` for a generic test notification proves signature acceptance only; it does not prove that an order was paid or reconciled.
