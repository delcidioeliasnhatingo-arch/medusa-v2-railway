import crypto from "node:crypto"
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Modules, PaymentWebhookEvents } from "@medusajs/framework/utils"
import { getRawBodyBytes, verifyDebitoPaySignature } from "../../../modules/debitopay/signature"

type DebitoPayEvent = {
  event?: string
  timestamp?: string
  data?: {
    payment_id?: string
    merchant_id?: string
    wallet_code?: string
    amount?: number | string
    currency?: string
    method?: string
    reference?: string
    paid_at?: string
    source_id?: string
    [key: string]: unknown
  }
}

const SUPPORTED_EVENTS = new Set([
  "payment.completed",
  "payment.failed",
  "payment.refunded",
  "payment.chargeback",
])

const MEDUSA_PROVIDER_SLUG = "debitopay_debitopay"
const MEDUSA_PROVIDER_ID = "pp_debitopay_debitopay"

function asNumber(value: unknown): number {
  if (typeof value === "number") return value
  if (typeof value === "string") return Number(value)
  if (value && typeof value === "object") return Number(String(value))
  return Number.NaN
}

function moneyInCents(value: number): number {
  return Math.round(value * 100)
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
    provider: MEDUSA_PROVIDER_ID,
    note: "Send a signed Debito Pay webhook POST to deliver payment events.",
  })
}

/**
 * POST /webhooks/debitopay
 *
 * Authenticates the raw Debito Pay event, resolves its external payment_id to
 * the matching Medusa payment session, and emits Medusa's standard payment
 * webhook event. The Payment Module then applies the provider's normalized
 * action through its regular workflow.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const secret = process.env.DEBITOPAY_WEBHOOK_SECRET
  const headerValue = req.headers["x-webhook-signature"]
  const signature = Array.isArray(headerValue) ? headerValue[0] : headerValue
  const rawBody = getRawBodyBytes(req.rawBody)

  if (typeof secret !== "string" || !secret.trim()) {
    console.error("[Debito Pay webhook] signing secret is not configured")
    return res.status(500).json({ error: "Webhook is not configured" })
  }

  if (typeof signature !== "string" || !rawBody) {
    console.warn("[Debito Pay webhook] signature input missing", {
      signatureHeaderPresent: typeof signature === "string",
      rawBodyPresent: rawBody !== null,
      rawBodyBytes: rawBody?.length ?? 0,
    })
    return res.status(401).json({ error: "Missing signature or raw request body" })
  }

  const verification = verifyDebitoPaySignature(rawBody, signature, secret)
  if (!verification.valid) {
    console.warn("[Debito Pay webhook] signature verification failed", {
      signatureFormatValid: verification.formatValid,
      signatureLength: signature.trim().length,
      rawBodyBytes: rawBody.length,
      rawBodySha256: crypto.createHash("sha256").update(rawBody).digest("hex"),
      verificationMode: "raw body and explicitly supported compatibility formats",
      // Never log the signature or signing secret.
    })
    return res.status(401).json({ error: "Invalid webhook signature" })
  }

  const event = req.body as DebitoPayEvent
  if (!event || typeof event.event !== "string" || !SUPPORTED_EVENTS.has(event.event)) {
    return res.status(400).json({ error: "Unsupported or invalid event" })
  }

  const eventData = event.data
  if (!eventData || typeof eventData.payment_id !== "string" || !eventData.payment_id.trim()) {
    return res.status(400).json({ error: "Missing payment_id" })
  }

  // Debito Pay's published refund/chargeback events do not map directly to a
  // Medusa payment-session action. Acknowledge them but don't silently change
  // an order's status; they need a dedicated refund/dispute reconciliation flow.
  if (event.event === "payment.refunded" || event.event === "payment.chargeback") {
    console.warn("[Debito Pay webhook] verified refund/chargeback requires separate reconciliation", {
      event: event.event,
      payment_id: eventData.payment_id,
    })
    return res.status(200).json({ received: true, event: event.event, reconciled: false })
  }

  let paymentModule: any
  try {
    paymentModule = req.scope.resolve(Modules.PAYMENT) as any
    const sessions = await paymentModule.listPaymentSessions(
      { provider_id: MEDUSA_PROVIDER_ID },
      { take: 500, order: { created_at: "DESC" } }
    )
    const session = (sessions as any[]).find((candidate) => {
      const data = candidate?.data ?? {}
      return data.payment_id === eventData.payment_id ||
        data.debitopay_payment_id === eventData.payment_id
    })

    if (!session) {
      console.error("[Debito Pay webhook] signed payment does not match a recent Medusa payment session", {
        event: event.event,
        payment_id: eventData.payment_id,
      })
      // Non-2xx invites Debito Pay to retry rather than dropping a valid event
      // that may have arrived before the payment session data was persisted.
      return res.status(503).json({ error: "Payment session mapping is not available yet; retry delivery" })
    }

    if (event.event === "payment.completed" && ["captured"].includes(String(session.status))) {
      return res.status(200).json({ received: true, event: event.event, duplicate: true })
    }
    if (event.event === "payment.failed" && ["captured", "authorized"].includes(String(session.status))) {
      // Don't let a late/duplicate failure event downgrade a completed payment.
      return res.status(200).json({ received: true, event: event.event, ignored: true })
    }

    const expectedAmount = asNumber(session.amount ?? session.data?.amount)
    const reportedAmount = asNumber(eventData.amount)
    const expectedCurrency = String(session.currency_code ?? session.data?.currency_code ?? "").toUpperCase()
    const reportedCurrency = String(eventData.currency ?? "").toUpperCase()

    if (event.event === "payment.completed") {
      if (
        !Number.isFinite(expectedAmount) ||
        !Number.isFinite(reportedAmount) ||
        moneyInCents(expectedAmount) !== moneyInCents(reportedAmount) ||
        !expectedCurrency ||
        !reportedCurrency ||
        expectedCurrency !== reportedCurrency
      ) {
        console.error("[Debito Pay webhook] signed completion event amount/currency did not match the session", {
          event: event.event,
          payment_id: eventData.payment_id,
          expectedCurrency,
          reportedCurrency,
        })
        return res.status(400).json({ error: "Payment amount or currency does not match the Medusa session" })
      }
    }

    const normalizedAmount = Number.isFinite(reportedAmount) ? reportedAmount : expectedAmount
    const enrichedEvent: DebitoPayEvent = {
      ...event,
      data: {
        ...eventData,
        // This field is internal enrichment from the matched Medusa record;
        // rawData remains the exact signed provider payload for HMAC verification.
        medusa_session_id: session.id,
        amount: normalizedAmount,
        currency: reportedCurrency || expectedCurrency,
      },
    }

    const eventBus = req.scope.resolve(Modules.EVENT_BUS) as any
    const paymentModuleOptions = paymentModule.options ?? {}
    await eventBus.emit(
      {
        name: PaymentWebhookEvents.WebhookReceived,
        data: {
          provider: MEDUSA_PROVIDER_SLUG,
          payload: {
            data: enrichedEvent,
            rawData: req.rawBody,
            headers: req.headers,
          },
        },
      },
      {
        delay: paymentModuleOptions.webhook_delay || 5000,
        attempts: paymentModuleOptions.webhook_retries || 3,
      }
    )

    console.info("[Debito Pay webhook] verified event queued for Medusa payment processing", {
      event: event.event,
      payment_id: eventData.payment_id,
      medusa_session_id: session.id,
    })

    return res.status(200).json({
      received: true,
      event: event.event,
      payment_id: eventData.payment_id,
      queued: true,
    })
  } catch (error) {
    console.error("[Debito Pay webhook] failed to enqueue payment event", {
      message: error instanceof Error ? error.message : "unknown error",
    })
    return res.status(503).json({ error: "Unable to queue payment event; retry delivery" })
  }
}
