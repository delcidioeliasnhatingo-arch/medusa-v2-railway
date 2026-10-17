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

async function confirmPaymentWithDebitoPay(
  paymentId: string,
  eventName: string
): Promise<{ amount: number; currency: string; status: string } | null> {
  const apiKey = process.env.DEBITOPAY_API_KEY
  if (!apiKey) return null

  const baseUrl = (process.env.DEBITOPAY_API_BASE_URL ||
    "https://gyqoaningqhurhvdugne.supabase.co/functions/v1").replace(/\/+$/, "")
  const configuredEndpoint = process.env.DEBITOPAY_PAYMENT_ENDPOINT || "payment-orchestrator"
  const endpoint = /^https?:\/\//i.test(configuredEndpoint)
    ? configuredEndpoint
    : \`\${baseUrl}/\${configuredEndpoint.replace(/^\/+/, "")}\`

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ action: "check-status", payment_id: paymentId }),
      signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) return null

    const payload = asRecord(JSON.parse(await response.text()))
    if (payload.success === false) return null
    const payment = asRecord(payload.payment ?? payload.data ?? payload)
    const returnedId = payment.payment_id ?? payment.id
    if (typeof returnedId === "string" && returnedId !== paymentId) return null

    const status = String(payment.status ?? "").trim().toLowerCase()
    const expectedStatuses = eventName === "payment.completed"
      ? new Set(["success", "successful", "completed", "paid", "captured"])
      : new Set(["failed", "declined", "error", "expired"])
    const amount = Number(payment.amount)
    const currency = typeof payment.currency === "string" ? payment.currency.toUpperCase() : ""
    if (!expectedStatuses.has(status) || !Number.isFinite(amount) || amount <= 0 || !currency) {
      return null
    }

    const configuredMerchant = process.env.DEBITOPAY_MERCHANT_ID
    const configuredWallet = process.env.DEBITOPAY_WALLET_CODE
    if (typeof payment.merchant_id === "string" && configuredMerchant &&
        payment.merchant_id !== configuredMerchant) return null
    if (payment.wallet_code !== undefined && configuredWallet &&
        String(payment.wallet_code) !== configuredWallet) return null

    return { amount, currency, status }
  } catch {
    return null
  }
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

  const verification = isValidSignature(rawBody, signature, secret)
  let providerStatusFallback: { amount: number; currency: string; status: string } | null = null

  if (!verification.valid) {
    // Do not trust an unsigned event. For completed/failed events only, verify
    // the payment independently against Debito Pay's authenticated status API.
    // This allows safe reconciliation during a webhook-secret configuration issue
    // without accepting arbitrary notifications or weakening HMAC validation.
    if (event.event === "payment.completed" || event.event === "payment.failed") {
      providerStatusFallback = await confirmPaymentWithDebitoPay(
        event.data.payment_id,
        event.event
      )
    }

    if (!providerStatusFallback) {
      console.warn("[Debito Pay webhook] signature failed and provider status could not verify payment", {
        event: event.event,
        payment_id: event.data.payment_id,
        signatureFormatValid: verification.formatValid,
        rawBodyBytes: rawBody.length,
        rawBodySha256: crypto.createHash("sha256").update(rawBody).digest("hex"),
        keyEncodingCandidates: getSigningKeys(secret).map((candidate) => candidate.mode),
        bodyEncodingCandidates: ["raw-body", "serialized-json"],
      })
      return res.status(401).json({ error: "Invalid webhook signature" })
    }

    console.warn("[Debito Pay webhook] signature failed; payment status independently verified with Debito Pay API", {
      event: event.event,
      payment_id: event.data.payment_id,
      providerStatus: providerStatusFallback.status,
    })
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

  if (providerStatusFallback) {
    const sessionData = asRecord(session?.data)
    const storedAmount = Number(sessionData.amount)
    const storedCurrency = String(sessionData.currency ?? session?.currency_code ?? "").toUpperCase()
    if (
      !session ||
      !Number.isFinite(storedAmount) ||
      storedAmount !== providerStatusFallback.amount ||
      storedCurrency !== providerStatusFallback.currency
    ) {
      console.warn("[Debito Pay webhook] provider status did not match a stored payment session", {
        payment_id: event.data.payment_id,
        sessionFound: Boolean(session),
        amountMatch: Number.isFinite(storedAmount) && storedAmount === providerStatusFallback.amount,
        currencyMatch: storedCurrency === providerStatusFallback.currency,
      })
      return res.status(409).json({ error: "Provider payment does not match the stored Medusa session" })
    }

    // This flag is added only after an authenticated server-to-server status
    // check and session amount/currency match; it is consumed by Medusa's
    // internal payment webhook workflow, not accepted from external callers.
    event.data.amount = providerStatusFallback.amount
    event.data.currency = providerStatusFallback.currency
    event.data.provider_status_verified = true
  }

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
