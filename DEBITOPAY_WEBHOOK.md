# Debito Pay Payments API + Medusa v2 (AVEART)

## Registered provider

The native Medusa Payment Module Provider is registered as:

- Provider ID: `pp_debitopay_debitopay`
- Payment API endpoint: `/payment-orchestrator`
- Default method selection: PayFast for ZAR; Visa/Mastercard for other currencies.
- Methods accepted in payment-session data: `mpesa`, `emola`, `mkesh`, `visa_mastercard`, `payfast`.

Enable `pp_debitopay_debitopay` for the relevant region in Medusa Admin before exposing it during checkout.

## Debito Pay credentials in Railway

Set these on the **AVEART-Medusa-Backend** service in the production environment:

- `DEBITOPAY_API_KEY`: API key from Merchant → Settings → API Keys. Use a sandbox key for tests and a live key only after end-to-end validation.
- `DEBITOPAY_MERCHANT_ID`: the merchant UUID from Debito Pay.
- `DEBITOPAY_WALLET_CODE`: the wallet's public code.
- `DEBITOPAY_API_BASE_URL`: normally `https://gyqoaningqhurhvdugne.supabase.co/functions/v1`.
- `DEBITOPAY_PAYMENT_ENDPOINT`: normally `/payment-orchestrator`; may be a full URL.
- `DEBITOPAY_PAYMENT_METHOD`: `auto` or one of the supported methods.
- `DEBITOPAY_RETURN_URL`: optional default return URL for hosted checkout.

Do not put API keys or webhook secrets in GitHub, the storefront, or a public message. The backend uses Bearer authentication for API calls.

## Payment-session data

For hosted card checkout, the storefront must provide `data.return_url` when creating the payment session, unless `DEBITOPAY_RETURN_URL` is set in Railway. The provider returns `data.checkout_url`; redirect the customer to that URL.

For M-Pesa, e-Mola, and mKesh, include the customer's phone as `data.phone`. The provider selects PayFast automatically for ZAR and Visa/Mastercard for other currencies when `DEBITOPAY_PAYMENT_METHOD=auto`. The storefront may pass `data.payment_method` to override the default with a supported method.

The provider sends `source_id` as the Medusa payment-session ID and uses an idempotency key derived from that session ID. The returned payment ID, payment method, amount, currency, reference, and hosted checkout URL are stored in the payment-session data.

## Webhook endpoint

Register this HTTPS URL in Debito Pay → Settings → Webhooks:

`https://aveart-medusa-backend-production.up.railway.app/webhooks/debitopay`

Subscribe to:

- `payment.completed`
- `payment.failed`
- `payment.refunded`
- `payment.chargeback`

The receiver preserves the original request bytes, verifies `x-webhook-signature` with HMAC-SHA256 and the webhook secret, finds the matching Medusa payment session by Debito Pay's `payment_id`, and checks amount/currency before queuing the standard Medusa payment webhook event. The Payment Module then processes a successful or failed payment through its normal workflow. Repeated successful/failed events are handled idempotently where the session is already complete.

Configure `DEBITOPAY_WEBHOOK_SECRET` with the exact signing secret from Debito Pay → Settings → Webhooks. This is not the API key. If the receiver responds with HTTP 401, the signature still does not match the configured key/body; regenerate or copy the webhook signing secret in Debito Pay and set the same value in Railway, then redeploy and send a fresh test. Never disable HMAC verification to make a webhook pass.

## Known limitations

- The documented Payments API currently does not expose a refund or cancellation endpoint. The provider therefore does not claim that refunds/cancellations were completed remotely. Refund and chargeback webhooks are acknowledged and logged but need a dedicated reconciliation workflow.
- The storefront must handle the hosted checkout redirect using `data.checkout_url` and return the customer to its configured `return_url`.
- An HTTP 200 from the webhook means the signed event was accepted/queued, not that an unpaid order can be trusted without checking the Medusa order/payment status.
