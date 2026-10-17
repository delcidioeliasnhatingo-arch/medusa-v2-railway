import crypto from "node:crypto"
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

type DebitoPayEvent = {
  event?: string
  timestamp?: string
  data?: {
    payment_id?: string
    merchant_id?: string
    wallet_code?: string
    amount?: number
    currency?: string
    method?: string
    reference?: string
    paid_at?: string
  }
}

const SUPPORTED_EVENTS = new Set([
  "payment.completed",
  "payment.failed",
  "payment.refunded",
  "payment.chargeback",
])

function isValidSignature(rawBody: string, signature: string, secret: string) {
  // Debito Pay documents x-webhook-signature as a hex HMAC-SHA256 digest.
  if (!/^[a-f0-9]{64}$/i.test(signature)) return false

  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest()

  const received = Buffer.from(signature, "hex")
  return received.length === expected.length && crypto.timingSafeEqual(expected, received)
}

/**
 * GET /webhooks/debitopay
 *
 * Lightweight health check for a browser/manual endpoint check. This does not
 * validate the Debito Pay signing secret or prove that a signed POST succeeds.
 */
export async function GET(_req: MedusaRequest, res: MedusaResponse) {
  return res.status(200).json({
    endpoint: "debitopay-webhook",
    status: "online",
    accepts: "POST",
    signatureHeader: "x-webhook-signature",
    note: "Send a signed Debito Pay webhook POST to deliver payment events.",
  })
}

/**
 * POST /webhooks/debitopay
 *
 * This endpoint authenticates and acknowledges Debito Pay notifications.
 * It deliberately does not mark a Medusa order as paid: that requires the
 * payment creation flow to persist and reconcile the Medusa payment/session
 * with Debito Pay's payment_id/source_id.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const secret = process.env.DEBITOPAY_WEBHOOK_SECRET
  const signatureHeader = req.headers["x-webhook-signature"]
  const rawBodyValue = req.rawBody

  if (!secret) {
    console.error("[Debito Pay webhook] DEBITOPAY_WEBHOOK_SECRET is not configured")
    return res.status(500).json({ error: "Webhook is not configured" })
  }

  if (typeof signatureHeader !== "string" || !rawBodyValue) {
    return res.status(401).json({ error: "Missing signature or raw request body" })
  }

  const rawBody = Buffer.isBuffer(rawBodyValue)
    ? rawBodyValue.toString("utf8")
    : String(rawBodyValue)

  if (!isValidSignature(rawBody, signatureHeader, secret)) {
    return res.status(401).json({ error: "Invalid webhook signature" })
  }

  const event = req.body as DebitoPayEvent
  if (!event || typeof event.event !== "string" || !SUPPORTED_EVENTS.has(event.event)) {
    return res.status(400).json({ error: "Unsupported or invalid event" })
  }

  if (!event.data || typeof event.data.payment_id !== "string" || !event.data.payment_id) {
    return res.status(400).json({ error: "Missing payment_id" })
  }

  // Avoid logging customer data or credentials. Provider retries are expected.
  console.info("[Debito Pay webhook] Verified event received", {
    event: event.event,
    payment_id: event.data.payment_id,
    reference: event.data.reference,
  })

  // Debito Pay asks webhook receivers to acknowledge quickly with HTTP 200.
  return res.status(200).json({
    received: true,
    event: event.event,
    payment_id: event.data.payment_id,
    note: "Signature verified; order reconciliation is not yet configured.",
  })
}
