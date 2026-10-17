import crypto from "node:crypto"
import type { IPaymentModuleService } from "@medusajs/framework/types"
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Modules, PaymentSessionStatus, PaymentWebhookEvents } from "@medusajs/framework/utils"

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
    session_id?: string
    session_amount?: number
    [key: string]: unknown
  }
}

const SUPPORTED_EVENTS = new Set([
  "payment.completed",
  "payment.failed",
  "payment.refunded",
  "payment.chargeback",
])
const PAYMENT_PROVIDER_ID = "pp_debitopay_debitopay"

function getRawBodyBytes(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return value
  if (typeof value === "string") return Buffer.from(value, "utf8")
  if (value instanceof Uint8Array) return Buffer.from(value)
  return null
}

function normalizeSignature(value: string): string | null {
  const trimmed = value.trim()
  const digest = trimmed.replace(/^sha256=/i, "")
  return /^[a-f0-9]{64}$/i.test(digest) ? digest.toLowerCase() : null
}

function digestMatches(body: Buffer, signatureHex: string, secret: Buffer | string): boolean {
  const expected = crypto.createHmac("sha256", secret).update(body).digest()
  const received = Buffer.from(signatureHex, "hex")
  return received.length === expected.length && crypto.timingSafeEqual(expected, received)
}

function getSigningKeys(secret: string): { key: Buffer | string; mode: string }[] {
  const trimmed = secret.trim()
  const candidates: { key: Buffer | string; mode: string }[] = [
    { key: trimmed, mode: "utf8-secret" },
  ]

  if (/^(?:[a-f0-9]{2})+$/i.test(trimmed)) {
    candidates.push({ key: Buffer.from(trimmed, "hex"), mode: "hex-decoded-secret" })
  }
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed) && trimmed.length % 4 === 0) {
    const decoded = Buffer.from(trimmed, "base64")
    if (decoded.length > 0 && decoded.toString("base64") === trimmed) {
      candidates.push({ key: decoded, mode: "base64-decoded-secret" })
    }
  }
  return candidates
}

function isValidSignature(rawBody: Buffer, signature: string, secret: string) {
  const normalized = normalizeSignature(signature)
  if (!normalized) {
    return { valid: false, formatValid: false, mode: null as string | null }
  }

  const bodies: { body: Buffer; mode: string }[] = [
    { body: rawBody, mode: "raw-body" },
  ]
  try {
    const parsed = JSON.parse(rawBody.toString("utf8"))
    bodies.push({ body: Buffer.from(JSON.stringify(parsed), "utf8"), mode: "serialized-json" })
  } catch {
    // Continue with exact raw-body verification.
  }

  for (const candidate of getSigningKeys(secret)) {
    for (const body of bodies) {
      if (digestMatches(body.body, normalized, candidate.key)) {
        return { valid: true, formatValid: true, mode: `${body.mode}+${candidate.mode}` }
      }
    }
  }
  return { valid: false, formatValid: true, mode: null as string | null }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
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
 * Validates HMAC synchronously, then hands a mapped event to Medusa's payment
 * webhook workflow. It never marks an order paid solely because a browser says so.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const secret = process.env.DEBITOPAY_WEBHOOK_SECRET
  const headerValue = req.headers["x-webhook-signature"]
  const signature = Array.isArray(headerValue) ? headerValue[0] : headerValue
  const rawBody = getRawBodyBytes(req.rawBody)

  if (typeof secret !== "string" || secret.trim().length === 0) {
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
    // Diagnostic comparison only. Never accept the API key as a fallback secret.
    const apiKey = process.env.DEBITOPAY_API_KEY
    const apiKeyVerification =
      typeof apiKey === "string" && apiKey.trim().length > 0
        ? isValidSignature(rawBody, signature, apiKey)
        : { valid: false, formatValid: false, mode: null as string | null }

    console.warn("[Debito Pay webhook] signature verification failed", {
      signatureFormatValid: verification.formatValid,
      signatureLength: signature.trim().length,
      signatureHasSha256Prefix: /^sha256=/i.test(signature.trim()),
      rawBodyBytes: rawBody.length,
      rawBodySha256: crypto.createHash("sha256").update(rawBody).digest("hex"),
      webhookSecretEqualsApiKey:
        typeof apiKey === "string" && secret.trim() === apiKey.trim(),
      signatureMatchesApiKey: apiKeyVerification.valid,
      apiKeyMatchMode: apiKeyVerification.mode,
      keyEncodingCandidates: getSigningKeys(secret).map((candidate) => candidate.mode),
      bodyEncodingCandidates: ["raw-body", "serialized-json"],
      // Never log the signature, signing secret, or API key.
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

  const paymentModule = req.scope.resolve(Modules.PAYMENT) as IPaymentModuleService
  let sessions
  try {
    sessions = await paymentModule.listPaymentSessions(
      { provider_id: PAYMENT_PROVIDER_ID },
      { take: 1000 }
    )
  } catch {
    console.error("[Debito Pay webhook] could not query Medusa payment sessions")
    return res.status(503).json({ error: "Payment reconciliation temporarily unavailable" })
  }

  const session = sessions.find((candidate) => {
    const data = asRecord(candidate.data)
    return data.payment_id === event.data?.payment_id
  })

  if (!session) {
    // Webhook test buttons often send sample payment IDs that were never created
    // by this Medusa store. A valid signed notification is acknowledged, but it
    // is never treated as payment proof or used to mark an order as paid.
    console.warn("[Debito Pay webhook] verified event has no matching Medusa session", {
      event: event.event,
      payment_id: event.data.payment_id,
    })
    return res.status(200).json({
      received: true,
      event: event.event,
      payment_id: event.data.payment_id,
      reconciled: false,
      note: "Signature verified, but no matching Medusa payment session exists.",
    })
  }

  event.data.session_id = session.id
  event.data.session_amount = Number(session.amount)

  if (event.event === "payment.completed") {
    try {
      const eventBus = req.scope.resolve(Modules.EVENT_BUS) as {
        emit: (event: unknown, options?: unknown) => Promise<unknown>
      }
      await eventBus.emit(
        {
          name: PaymentWebhookEvents.WebhookReceived,
          data: {
            provider: "debitopay_debitopay",
            payload: {
              data: event,
              rawData: rawBody,
              headers: req.headers,
            },
          },
        },
        { delay: 5000, attempts: 3 }
      )
    } catch {
      console.error("[Debito Pay webhook] could not queue payment.completed event", {
        payment_id: event.data.payment_id,
        session_id: session.id,
      })
      return res.status(503).json({ error: "Payment event could not be queued" })
    }
  } else if (event.event === "payment.failed") {
    try {
      await paymentModule.updatePaymentSession({
        id: session.id,
        data: asRecord(session.data),
        amount: Number(session.amount),
        currency_code: session.currency_code,
        status: PaymentSessionStatus.ERROR,
      })
    } catch {
      console.error("[Debito Pay webhook] failed to mark payment session as error", {
        payment_id: event.data.payment_id,
        session_id: session.id,
      })
      return res.status(503).json({ error: "Failed payment could not be reconciled" })
    }
  } else {
    // Refunded/chargeback events are authenticated but the published API does
    // not provide enough information to safely run a Medusa refund workflow.
    console.warn("[Debito Pay webhook] refund/chargeback needs reconciliation", {
      event: event.event,
      payment_id: event.data.payment_id,
      session_id: session.id,
    })
  }

  console.info("[Debito Pay webhook] verified event reconciled", {
    event: event.event,
    payment_id: event.data.payment_id,
    session_id: session.id,
    signatureBodyMode: verification.mode,
  })

  return res.status(200).json({
    received: true,
    event: event.event,
    payment_id: event.data.payment_id,
    reconciled: event.event === "payment.completed" || event.event === "payment.failed",
  })
}
