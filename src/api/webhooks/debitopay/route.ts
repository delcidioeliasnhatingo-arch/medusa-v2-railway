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

function getRawBodyBytes(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return value
  if (typeof value === "string") return Buffer.from(value, "utf8")
  if (value instanceof Uint8Array) return Buffer.from(value)
  return null
}

function normalizeSignature(value: string): string | null {
  // The documented format is a hexadecimal HMAC-SHA256 digest. Some webhook
  // senders additionally prefix the digest with "sha256=".
  const trimmed = value.trim()
  const digest = trimmed.replace(/^sha256=/i, "")
  return /^[a-f0-9]{64}$/i.test(digest) ? digest.toLowerCase() : null
}

function isValidSignature(rawBody: Buffer, signature: string, secret: string) {
  const normalized = normalizeSignature(signature)
  if (!normalized) {
    return { valid: false, formatValid: false }
  }

  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest()
  const received = Buffer.from(normalized, "hex")
  return {
    valid: received.length === expected.length && crypto.timingSafeEqual(expected, received),
    formatValid: true,
  }
}

/**
 * GET /webhooks/debitopay
 * Health check only; it does not validate signed webhook delivery.
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
 * Authenticate and acknowledge Debito Pay notifications. Order/payment
 * reconciliation remains separate until the Medusa payment session is mapped
 * to Debito Pay's payment_id.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const secret = process.env.DEBITOPAY_WEBHOOK_SECRET
  const headerValue = req.headers["x-webhook-signature"]
  const signature = Array.isArray(headerValue) ? headerValue[0] : headerValue
  const rawBody = getRawBodyBytes(req.rawBody)

  if (!secret) {
    console.error("[Debito Pay webhook] signing secret is not configured")
    return res.status(500).json({ error: "Webhook is not configured" })
  }

  if (typeof signature !== "string" || !rawBody) {
    console.warn("[Debito Pay webhook] signature input missing", {
      signatureHeaderPresent: typeof signature === "string",
      rawBodyPresent: rawBody !== null,
      rawBodyType: Buffer.isBuffer(req.rawBody) ? "Buffer" : typeof req.rawBody,
      rawBodyBytes: rawBody?.length ?? 0,
    })
    return res.status(401).json({ error: "Missing signature or raw request body" })
  }

  const verification = isValidSignature(rawBody, signature, secret)
  if (!verification.valid) {
    console.warn("[Debito Pay webhook] signature verification failed", {
      signatureFormatValid: verification.formatValid,
      signatureLength: signature.trim().length,
      rawBodyBytes: rawBody.length,
      rawBodySha256: crypto.createHash("sha256").update(rawBody).digest("hex"),
      // Never log the signature or signing secret.
    })
    return res.status(401).json({ error: "Invalid webhook signature" })
  }

  let event: DebitoPayEvent
  try {
    event = JSON.parse(rawBody.toString("utf8")) as DebitoPayEvent
  } catch {
    return res.status(400).json({ error: "Invalid JSON body" })
  }

  if (!event || typeof event.event !== "string" || !SUPPORTED_EVENTS.has(event.event)) {
    return res.status(400).json({ error: "Unsupported or invalid event" })
  }

  if (!event.data || typeof event.data.payment_id !== "string" || !event.data.payment_id) {
    return res.status(400).json({ error: "Missing payment_id" })
  }

  console.info("[Debito Pay webhook] Verified event received", {
    event: event.event,
    payment_id: event.data.payment_id,
    reference: event.data.reference,
  })

  return res.status(200).json({
    received: true,
    event: event.event,
    payment_id: event.data.payment_id,
    note: "Signature verified; order reconciliation is not yet configured.",
  })
}
