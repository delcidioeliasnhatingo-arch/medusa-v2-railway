import crypto from "node:crypto"
import type {
  AuthorizePaymentInput,
  AuthorizePaymentOutput,
  CancelPaymentInput,
  CancelPaymentOutput,
  CapturePaymentInput,
  CapturePaymentOutput,
  DeletePaymentInput,
  DeletePaymentOutput,
  GetPaymentStatusInput,
  GetPaymentStatusOutput,
  InitiatePaymentInput,
  InitiatePaymentOutput,
  Logger,
  ProviderWebhookPayload,
  RefundPaymentInput,
  RefundPaymentOutput,
  RetrievePaymentInput,
  RetrievePaymentOutput,
  UpdatePaymentInput,
  UpdatePaymentOutput,
  WebhookActionResult,
} from "@medusajs/framework/types"
import {
  AbstractPaymentProvider,
  PaymentActions,
  PaymentSessionStatus,
} from "@medusajs/framework/utils"

type Options = {
  apiKey: string
  merchantId: string
  walletCode: string
  baseUrl?: string
  paymentEndpoint?: string
  webhookSecret?: string
  returnUrl?: string
}

type JsonObject = Record<string, unknown>
type DebitoPayEvent = {
  event?: string
  timestamp?: string
  data?: {
    payment_id?: string
    session_id?: string
    session_amount?: number
    amount?: number
    currency?: string
    status?: string
    [key: string]: unknown
  }
}

const DEFAULT_BASE_URL = "https://gyqoaningqhurhvdugne.supabase.co/functions/v1"
const PROVIDER_METHODS = new Set(["mpesa", "emola", "mkesh", "visa_mastercard", "payfast"])

function objectValue(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {}
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined
}

function asBuffer(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return value
  if (typeof value === "string") return Buffer.from(value, "utf8")
  if (value instanceof Uint8Array) return Buffer.from(value)
  // Redis/event-bus JSON serialization may represent a Buffer this way.
  if (value !== null && typeof value === "object") {
    const serialized = value as { type?: unknown; data?: unknown }
    if (
      serialized.type === "Buffer" &&
      Array.isArray(serialized.data) &&
      serialized.data.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
    ) {
      return Buffer.from(serialized.data)
    }
  }
  return null
}

function normaliseSignature(value: string): string | null {
  const digest = value.trim().replace(/^sha256=/i, "")
  return /^[a-f0-9]{64}$/i.test(digest) ? digest.toLowerCase() : null
}

function signatureIsValid(rawBody: Buffer, signature: string, secret: string): boolean {
  const normalized = normaliseSignature(signature)
  if (!normalized) return false

  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest()
  const actual = Buffer.from(normalized, "hex")
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
}

class DebitoPayPaymentProviderService extends AbstractPaymentProvider<Options> {
  static identifier = "debitopay"

  protected logger_: Logger | undefined
  protected options_: Options

  constructor(container: Record<string, unknown>, options: Options) {
    super(container, options)
    this.logger_ = container.logger as Logger | undefined
    this.options_ = options
  }

  static validateOptions(options: Options): void {
    for (const key of ["apiKey", "merchantId", "walletCode"] as const) {
      if (!stringValue(options?.[key])) {
        throw new Error(`Debito Pay provider requires the ${key} option.`)
      }
    }
  }

  private getEndpoint(): string {
    const base = stringValue(this.options_.baseUrl) || DEFAULT_BASE_URL
    const configuredEndpoint = stringValue(this.options_.paymentEndpoint) || "payment-orchestrator"

    if (/^https?:\/\//i.test(configuredEndpoint)) return configuredEndpoint

    const cleanBase = base.replace(/\/+$/, "")
    const cleanEndpoint = configuredEndpoint.replace(/^\/+/, "")
    if (cleanBase.toLowerCase().endsWith(`/${cleanEndpoint.toLowerCase()}`)) {
      return cleanBase
    }
    return `${cleanBase}/${cleanEndpoint}`
  }

  private async post(body: JsonObject, idempotencyKey?: string): Promise<JsonObject> {
    const response = await fetch(this.getEndpoint(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options_.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(idempotencyKey ? { "X-Idempotency-Key": idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })

    const responseText = await response.text()
    let parsed: JsonObject
    try {
      parsed = objectValue(JSON.parse(responseText))
    } catch {
      throw new Error(`Debito Pay returned a non-JSON response (HTTP ${response.status}).`)
    }

    if (!response.ok || parsed.success === false) {
      const code = stringValue(parsed.error)
      const safeCode = code && /^[A-Z0-9_-]{1,80}$/i.test(code) ? code : "PROVIDER_ERROR"
      throw new Error(`Debito Pay rejected the request (HTTP ${response.status}, ${safeCode}).`)
    }
    return parsed
  }

  private unwrapPayment(response: JsonObject): JsonObject {
    return objectValue(response.payment ?? response.data ?? response)
  }

  private externalPaymentId(data: unknown): string | undefined {
    const record = objectValue(data)
    return stringValue(record.payment_id) || stringValue(record.id) || stringValue(record.external_payment_id)
  }

  private mapStatus(status: unknown): PaymentSessionStatus {
    const normalized = String(status ?? "").trim().toLowerCase()
    if (["success", "successful", "completed", "paid", "captured"].includes(normalized)) {
      return PaymentSessionStatus.CAPTURED
    }
    if (["failed", "declined", "error", "expired"].includes(normalized)) {
      return PaymentSessionStatus.ERROR
    }
    if (["cancelled", "canceled"].includes(normalized)) {
      return PaymentSessionStatus.CANCELED
    }
    return PaymentSessionStatus.PENDING_AUTHORIZATION
  }

  private async checkStatus(paymentId: string): Promise<JsonObject> {
    const response = await this.post({
      action: "check-status",
      payment_id: paymentId,
    })
    return this.unwrapPayment(response)
  }

  async initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentOutput> {
    const inputData = objectValue(input.data)
    const method = stringValue(inputData.payment_method) || stringValue(inputData.method)
    if (!method || !PROVIDER_METHODS.has(method)) {
      throw new Error(
        "Choose a Debito Pay method in payment-session data: mpesa, emola, mkesh, visa_mastercard or payfast."
      )
    }

    const amount = Number(input.amount)
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error("Debito Pay requires a positive numeric payment amount.")
    }

    const currency = input.currency_code.toUpperCase()
    if (method === "payfast" && currency !== "ZAR") {
      throw new Error("Debito Pay PayFast payments must use ZAR.")
    }
    if (method !== "payfast" && currency !== "MZN") {
      throw new Error(`Debito Pay ${method} payments must use MZN.`)
    }
    if (method === "emola" && amount < 50) {
      throw new Error("Debito Pay e-Mola payments require a minimum of 50 MZN.")
    }
    if (method === "payfast" && amount < 5) {
      throw new Error("Debito Pay PayFast payments require a minimum of 5 ZAR.")
    }
    if (["mpesa", "mkesh", "visa_mastercard"].includes(method) && amount < (method === "visa_mastercard" ? 50 : 10)) {
      throw new Error(`Debito Pay ${method} payments are below the documented minimum amount.`)
    }

    const phone =
      stringValue(inputData.phone) ||
      stringValue(inputData.customer_phone) ||
      stringValue(input.context?.customer?.phone)

    if (["mpesa", "emola", "mkesh"].includes(method) && !phone) {
      throw new Error(`Debito Pay ${method} requires data.phone in the payment session.`)
    }

    const returnUrl = stringValue(inputData.return_url) || stringValue(this.options_.returnUrl)
    if (["visa_mastercard", "payfast"].includes(method) && !returnUrl) {
      throw new Error(
        "Debito Pay card/PayFast checkout requires data.return_url or DEBITOPAY_RETURN_URL."
      )
    }

    const customer = input.context?.customer
    const customerName = stringValue(inputData.customer_name) ||
      [customer?.first_name, customer?.last_name].filter(Boolean).join(" ").trim() || undefined
    const customerEmail = stringValue(inputData.customer_email) || stringValue(customer?.email)

    const request: JsonObject = {
      action: "process",
      payment_method: method,
      merchant_id: this.options_.merchantId,
      wallet_code: this.options_.walletCode,
      amount,
      currency,
    }
    if (phone) request.phone = phone
    if (returnUrl) request.return_url = returnUrl
    if (customerName) request.customer_name = customerName
    if (customerEmail) request.customer_email = customerEmail
    const response = await this.post(request, input.context?.idempotency_key)
    const payment = this.unwrapPayment(response)
    const paymentId = this.externalPaymentId(payment)
    if (!paymentId) {
      throw new Error("Debito Pay response did not include a payment_id.")
    }

    const checkoutUrl = stringValue(payment.checkout_url) || stringValue(response.checkout_url)
    const responseStatus = stringValue(payment.status) || stringValue(response.status) || "pending"

    return {
      id: paymentId,
      status: PaymentSessionStatus.PENDING_AUTHORIZATION,
      data: {
        payment_id: paymentId,
        session_id: stringValue(inputData.session_id),
        payment_method: method,
        amount,
        currency,
        provider_status: responseStatus,
        ...(checkoutUrl ? { checkout_url: checkoutUrl } : {}),
        ...(stringValue(payment.reference) ? { provider_reference: stringValue(payment.reference) } : {}),
      },
    }
  }

  async updatePayment(input: UpdatePaymentInput): Promise<UpdatePaymentOutput> {
    const data = objectValue(input.data)
    const oldAmount = Number(data.amount)
    const newAmount = Number(input.amount)
    const oldCurrency = stringValue(data.currency)?.toUpperCase()
    if (Number.isFinite(oldAmount) && oldAmount !== newAmount) {
      throw new Error("A Debito Pay payment amount cannot be changed after initiation; start a new payment session.")
    }
    if (oldCurrency && oldCurrency !== input.currency_code.toUpperCase()) {
      throw new Error("A Debito Pay payment currency cannot be changed after initiation; start a new payment session.")
    }
    const paymentId = this.externalPaymentId(data)
    if (!paymentId) return { data }
    const status = await this.checkStatus(paymentId)
    return {
      data: { ...data, provider_status: stringValue(status.status) || data.provider_status },
      status: this.mapStatus(status.status),
    }
  }

  async deletePayment(input: DeletePaymentInput): Promise<DeletePaymentOutput> {
    // Debito Pay's published API does not document a cancellation endpoint.
    // Do not claim that the external transaction was cancelled.
    return { data: objectValue(input.data) }
  }

  async authorizePayment(input: AuthorizePaymentInput): Promise<AuthorizePaymentOutput> {
    const data = objectValue(input.data)
    const paymentId = this.externalPaymentId(data)
    if (!paymentId) throw new Error("Cannot verify Debito Pay payment without payment_id.")

    const payment = await this.checkStatus(paymentId)
    const status = this.mapStatus(payment.status)
    return {
      data: { ...data, provider_status: stringValue(payment.status) || "pending" },
      status,
    }
  }

  async capturePayment(input: CapturePaymentInput): Promise<CapturePaymentOutput> {
    // Debito Pay captures/credits the wallet on its side. This method is reached
    // only after Debito Pay's status check or verified payment.completed webhook.
    return { data: objectValue(input.data) }
  }

  async cancelPayment(_input: CancelPaymentInput): Promise<CancelPaymentOutput> {
    throw new Error("Debito Pay does not document a transaction-cancellation API; verify the payment in Debito Pay before cancelling it in Medusa.")
  }

  async refundPayment(_input: RefundPaymentInput): Promise<RefundPaymentOutput> {
    throw new Error("Debito Pay's published API does not document a refund-creation endpoint. Process the refund in Debito Pay, then reconcile the event.")
  }

  async retrievePayment(input: RetrievePaymentInput): Promise<RetrievePaymentOutput> {
    const data = objectValue(input.data)
    const paymentId = this.externalPaymentId(data)
    if (!paymentId) return { data }
    const payment = await this.checkStatus(paymentId)
    return { data: { ...data, ...payment } }
  }

  async getPaymentStatus(input: GetPaymentStatusInput): Promise<GetPaymentStatusOutput> {
    const data = objectValue(input.data)
    const paymentId = this.externalPaymentId(data)
    if (!paymentId) throw new Error("Cannot retrieve Debito Pay payment status without payment_id.")
    const payment = await this.checkStatus(paymentId)
    return {
      data: { ...data, provider_status: stringValue(payment.status) || "pending" },
      status: this.mapStatus(payment.status),
    }
  }

  async getWebhookActionAndData(
    payload: ProviderWebhookPayload["payload"]
  ): Promise<WebhookActionResult> {
    const rawBody = asBuffer(payload.rawData)
    const headerValue = payload.headers?.["x-webhook-signature"]
    const signature = Array.isArray(headerValue) ? headerValue[0] : headerValue
    const secret = stringValue(this.options_.webhookSecret)

    if (!rawBody || typeof signature !== "string" || !secret ||
        !signatureIsValid(rawBody, signature, secret)) {
      throw new Error("Debito Pay webhook signature validation failed.")
    }

    const event = objectValue(payload.data) as DebitoPayEvent
    const eventData = objectValue(event.data)
    const sessionId = stringValue(eventData.session_id)
    if (!event.event || !sessionId) {
      return { action: PaymentActions.NOT_SUPPORTED }
    }

    if (event.event === "payment.completed") {
      const amount = Number(eventData.session_amount ?? eventData.amount)
      if (!Number.isFinite(amount) || amount <= 0) {
        return { action: PaymentActions.NOT_SUPPORTED }
      }
      return {
        action: PaymentActions.SUCCESSFUL,
        data: { session_id: sessionId, amount },
      }
    }

    if (event.event === "payment.failed") {
      return { action: PaymentActions.FAILED }
    }

    // Refund and chargeback events are verified by the receiver, but must be
    // reconciled with a provider-side refund/chargeback reference before Medusa
    // can safely alter a captured payment.
    return { action: PaymentActions.NOT_SUPPORTED }
  }
}

export default DebitoPayPaymentProviderService
