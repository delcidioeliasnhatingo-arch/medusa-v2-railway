import crypto from "node:crypto"
import type { Logger } from "@medusajs/framework/types"
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
  BigNumber,
  MedusaError,
  PaymentActions,
  PaymentSessionStatus,
} from "@medusajs/framework/utils"
import { getRawBodyBytes, verifyDebitoPaySignature } from "./signature"

type DebitoPayOptions = {
  apiKey?: string
  merchantId?: string
  walletCode?: string
  apiBaseUrl?: string
  paymentEndpoint?: string
  paymentMethod?: string
  returnUrl?: string
  webhookSecret?: string
}

type InjectedDependencies = {
  logger?: Logger
}

type DebitoPayResponse = {
  success?: boolean
  error?: string
  message?: string
  payment_id?: string
  payment_method?: string
  status?: string
  checkout_url?: string
  reference?: string
  transactionId?: string
  payment?: {
    id?: string
    status?: string
    amount?: number | string
    currency?: string
    provider_reference?: string
    payment_method?: string
  }
  [key: string]: unknown
}

type DebitoPayWebhook = {
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
    medusa_session_id?: string
  }
}

const DEFAULT_API_BASE_URL =
  "https://gyqoaningqhurhvdugne.supabase.co/functions/v1"
const ALLOWED_PAYMENT_METHODS = new Set([
  "mpesa",
  "emola",
  "mkesh",
  "visa_mastercard",
  "payfast",
])

function toNumber(value: unknown): number {
  if (typeof value === "number") return value
  if (typeof value === "string") return Number(value)
  if (value && typeof value === "object") return Number(String(value))
  return Number.NaN
}

function mapStatus(status: unknown): string {
  const value = String(status ?? "pending").toLowerCase()
  if (["success", "successful", "completed", "paid", "captured"].includes(value)) {
    return PaymentSessionStatus.CAPTURED
  }
  if (["failed", "declined", "rejected", "error"].includes(value)) {
    return PaymentSessionStatus.ERROR
  }
  if (["expired", "cancelled", "canceled", "voided"].includes(value)) {
    return PaymentSessionStatus.CANCELED
  }
  return PaymentSessionStatus.PENDING
}

function toDeterministicUuid(seed: string): string {
  const bytes = crypto.createHash("sha256").update(seed).digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString("hex")
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-")
}

class DebitoPayPaymentProviderService extends AbstractPaymentProvider<DebitoPayOptions> {
  static identifier = "debitopay"

  protected logger_: Logger
  protected options_: DebitoPayOptions

  constructor(container: InjectedDependencies, options: DebitoPayOptions) {
    super(container, options)
    this.logger_ = container.logger ?? (console as unknown as Logger)
    this.options_ = options ?? {}
  }

  private getPaymentEndpoint(): string {
    const configured = this.options_.paymentEndpoint?.trim()
    if (configured) {
      if (/^https?:\/\//i.test(configured)) return configured
      return `${(this.options_.apiBaseUrl || DEFAULT_API_BASE_URL).replace(/\/+$/, "")}/${configured.replace(/^\/+/, "")}`
    }
    return `${(this.options_.apiBaseUrl || DEFAULT_API_BASE_URL).replace(/\/+$/, "")}/payment-orchestrator`
  }

  private assertConfiguration(): void {
    if (!this.options_.apiKey?.trim()) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Debito Pay is not configured: DEBITOPAY_API_KEY is missing."
      )
    }
    if (!this.options_.merchantId?.trim() || !this.options_.walletCode?.trim()) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Debito Pay is not configured: merchant ID or wallet code is missing."
      )
    }
  }

  private async apiRequest(
    body: Record<string, unknown>,
    idempotencySeed?: string
  ): Promise<DebitoPayResponse> {
    this.assertConfiguration()
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.options_.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    }

    if (idempotencySeed) {
      headers["X-Idempotency-Key"] = toDeterministicUuid(idempotencySeed)
    }

    let response: Response
    try {
      response = await fetch(this.getPaymentEndpoint(), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(12000),
      })
    } catch (error) {
      this.logger_.error("[Debito Pay] API request failed before receiving a response")
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "Could not connect to Debito Pay. Please retry the payment."
      )
    }

    const responseText = await response.text()
    let result: DebitoPayResponse
    try {
      result = JSON.parse(responseText) as DebitoPayResponse
    } catch {
      this.logger_.error("[Debito Pay] API returned a non-JSON response", {
        httpStatus: response.status,
      })
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "Debito Pay returned an invalid response. Please retry the payment."
      )
    }

    if (!response.ok || result.success === false) {
      const safeError = String(result.error || result.message || "Payment request rejected").slice(0, 180)
      this.logger_.warn("[Debito Pay] API rejected a payment request", {
        httpStatus: response.status,
        errorCode: safeError,
      })
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `Debito Pay payment request failed: ${safeError}`
      )
    }

    return result
  }

  private chooseMethod(data: Record<string, unknown> | undefined, currencyCode: string): string {
    const requested = typeof data?.payment_method === "string"
      ? data.payment_method.toLowerCase()
      : undefined
    const configured = (this.options_.paymentMethod || "auto").toLowerCase()
    const method = requested || (configured !== "auto" ? configured : currencyCode === "ZAR" ? "payfast" : "visa_mastercard")

    if (!ALLOWED_PAYMENT_METHODS.has(method)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Unsupported Debito Pay method. Use mpesa, emola, mkesh, visa_mastercard, or payfast."
      )
    }
    if (method === "payfast" && currencyCode !== "ZAR") {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Debito Pay PayFast requires a ZAR payment session."
      )
    }
    return method
  }

  private getPaymentId(data: Record<string, unknown> | undefined): string {
    const id = data?.payment_id ?? data?.id
    if (typeof id !== "string" || !id.trim()) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Debito Pay payment_id is missing from the payment session."
      )
    }
    return id
  }

  private async checkStatus(data: Record<string, unknown> | undefined): Promise<DebitoPayResponse> {
    const paymentId = this.getPaymentId(data)
    return await this.apiRequest({ action: "check-status", payment_id: paymentId })
  }

  async initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentOutput> {
    const amount = toNumber(input.amount)
    const currencyCode = input.currency_code.toUpperCase()
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "Debito Pay requires a positive payment amount.")
    }

    const data = (input.data ?? {}) as Record<string, unknown>
    const sessionId = typeof data.session_id === "string"
      ? data.session_id
      : input.context?.idempotency_key

    if (!sessionId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Medusa payment session ID is missing; cannot create an idempotent Debito Pay transaction."
      )
    }

    const paymentMethod = this.chooseMethod(data, currencyCode)
    const customer = input.context?.customer
    const customerName = [customer?.first_name, customer?.last_name].filter(Boolean).join(" ").trim()
    const phone = typeof data.phone === "string" ? data.phone : customer?.phone
    const returnUrl = typeof data.return_url === "string"
      ? data.return_url
      : this.options_.returnUrl

    if (["mpesa", "emola", "mkesh"].includes(paymentMethod) && !phone) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `A customer phone number is required for Debito Pay ${paymentMethod} payments.`
      )
    }

    if (["visa_mastercard", "payfast"].includes(paymentMethod) && !returnUrl) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Debito Pay hosted checkout requires return_url in payment session data or DEBITOPAY_RETURN_URL."
      )
    }

    const body: Record<string, unknown> = {
      action: "process",
      payment_method: paymentMethod,
      merchant_id: this.options_.merchantId,
      wallet_code: this.options_.walletCode,
      amount,
      currency: currencyCode,
      source: "gateway",
      source_id: sessionId,
    }

    if (customer?.email) body.customer_email = customer.email
    if (customerName) body.customer_name = customerName
    if (phone) body.phone = phone
    if (returnUrl) body.return_url = returnUrl
    if (typeof data.customer_ip === "string") body.customer_ip = data.customer_ip
    if (typeof data.customer_user_agent === "string") body.customer_user_agent = data.customer_user_agent
    if (typeof data.customer_origin_url === "string") body.customer_origin_url = data.customer_origin_url

    const result = await this.apiRequest(body, sessionId)
    const paymentId = result.payment_id ?? result.payment?.id
    if (typeof paymentId !== "string" || !paymentId.trim()) {
      this.logger_.error("[Debito Pay] successful API response did not include payment_id")
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "Debito Pay did not return a payment_id; the payment session could not be initialized."
      )
    }

    const status = mapStatus(result.payment?.status ?? result.status)
    const providerData: Record<string, unknown> = {
      ...data,
      payment_id: paymentId,
      session_id: sessionId,
      source_id: sessionId,
      payment_method: paymentMethod,
      amount,
      currency_code: currencyCode,
      status: result.payment?.status ?? result.status ?? "pending",
    }

    if (result.checkout_url) providerData.checkout_url = result.checkout_url
    if (result.reference) providerData.reference = result.reference
    if (result.transactionId) providerData.transaction_id = result.transactionId

    if (["visa_mastercard", "payfast"].includes(paymentMethod) && !result.checkout_url) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "Debito Pay did not return checkout_url for a hosted checkout payment."
      )
    }

    return {
      id: paymentId,
      data: providerData,
      status,
    }
  }

  async authorizePayment(input: AuthorizePaymentInput): Promise<AuthorizePaymentOutput> {
    const response = await this.checkStatus(input.data)
    const payment = response.payment ?? response
    const status = mapStatus(payment.status ?? response.status)
    const data = {
      ...(input.data ?? {}),
      status: payment.status ?? response.status ?? "pending",
      provider_reference: payment.provider_reference ?? response.reference,
    }

    if (status === PaymentSessionStatus.CAPTURED) {
      return { data, status: PaymentSessionStatus.CAPTURED }
    }
    if (status === PaymentSessionStatus.ERROR || status === PaymentSessionStatus.CANCELED) {
      return { data, status }
    }
    return { data, status: PaymentSessionStatus.PENDING_AUTHORIZATION }
  }

  async updatePayment(input: UpdatePaymentInput): Promise<UpdatePaymentOutput> {
    const existingAmount = toNumber(input.data?.amount)
    const newAmount = toNumber(input.amount)
    const existingCurrency = String(input.data?.currency_code ?? input.currency_code).toUpperCase()
    const newCurrency = input.currency_code.toUpperCase()

    if (
      Number.isFinite(existingAmount) &&
      Math.round(existingAmount * 100) !== Math.round(newAmount * 100)
    ) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        "A Debito Pay payment cannot be repriced after checkout initialization. Reinitialize the payment session."
      )
    }
    if (existingCurrency !== newCurrency) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        "A Debito Pay payment cannot change currency after checkout initialization. Reinitialize the payment session."
      )
    }

    return { data: input.data ?? {}, status: PaymentSessionStatus.PENDING }
  }

  async deletePayment(input: DeletePaymentInput): Promise<DeletePaymentOutput> {
    // Debito Pay's documented Payments API does not currently expose a cancel endpoint.
    // Retain local data; the gateway transaction may remain pending until it expires.
    return { data: input.data ?? {} }
  }

  async capturePayment(input: CapturePaymentInput): Promise<CapturePaymentOutput> {
    // Debito Pay's payment-orchestrator charges at creation; it has no separate
    // capture endpoint in the currently documented API.
    const response = await this.checkStatus(input.data)
    const status = mapStatus(response.payment?.status ?? response.status)
    if (status !== PaymentSessionStatus.CAPTURED) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        "Debito Pay has not confirmed this payment as successful; it cannot be captured in Medusa."
      )
    }
    return {
      data: {
        ...(input.data ?? {}),
        status: response.payment?.status ?? response.status,
      },
    }
  }

  async refundPayment(_input: RefundPaymentInput): Promise<RefundPaymentOutput> {
    // Never report a successful refund when the provider API doesn't offer one.
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      "Automated refunds are not available through the currently documented Debito Pay Payments API. Process the refund in Debito Pay first."
    )
  }

  async retrievePayment(input: RetrievePaymentInput): Promise<RetrievePaymentOutput> {
    const response = await this.checkStatus(input.data)
    return {
      data: {
        ...(input.data ?? {}),
        ...(response.payment ?? {}),
        status: response.payment?.status ?? response.status,
      },
    }
  }

  async cancelPayment(input: CancelPaymentInput): Promise<CancelPaymentOutput> {
    // The documented API currently has no remote cancel operation.
    return { data: input.data ?? {} }
  }

  async getPaymentStatus(input: GetPaymentStatusInput): Promise<GetPaymentStatusOutput> {
    const response = await this.checkStatus(input.data)
    const status = mapStatus(response.payment?.status ?? response.status)
    if (status === PaymentSessionStatus.CAPTURED) {
      return { status: PaymentSessionStatus.CAPTURED, data: response.payment as Record<string, unknown> }
    }
    if (status === PaymentSessionStatus.ERROR || status === PaymentSessionStatus.CANCELED) {
      return { status: status as typeof PaymentSessionStatus.ERROR, data: response.payment as Record<string, unknown> }
    }
    return { status: PaymentSessionStatus.PENDING, data: response.payment as Record<string, unknown> }
  }

  async getWebhookActionAndData(
    payload: ProviderWebhookPayload["payload"]
  ): Promise<WebhookActionResult> {
    const rawBody = getRawBodyBytes(payload.rawData)
    const header = payload.headers?.["x-webhook-signature"]
    const signature = Array.isArray(header) ? header[0] : header
    const secret = this.options_.webhookSecret

    if (!rawBody || typeof signature !== "string" || !secret?.trim()) {
      this.logger_.warn("[Debito Pay] webhook is missing raw body, signature, or secret")
      return { action: PaymentActions.NOT_SUPPORTED }
    }

    const verification = verifyDebitoPaySignature(rawBody, signature, secret)
    if (!verification.valid) {
      this.logger_.warn("[Debito Pay] webhook provider verification failed")
      return { action: PaymentActions.NOT_SUPPORTED }
    }

    const event = payload.data as DebitoPayWebhook
    const eventData = event?.data
    const sessionId = eventData?.medusa_session_id
    const amount = toNumber(eventData?.amount)

    if (!event?.event || !eventData?.payment_id || !sessionId || !Number.isFinite(amount) || amount <= 0) {
      this.logger_.warn("[Debito Pay] verified webhook did not contain a mapped Medusa session or amount")
      return { action: PaymentActions.NOT_SUPPORTED }
    }

    const actionData = {
      session_id: sessionId,
      amount: new BigNumber(amount),
    }

    switch (event.event) {
      case "payment.completed":
        return { action: PaymentActions.SUCCESSFUL, data: actionData }
      case "payment.failed":
        return { action: PaymentActions.FAILED, data: actionData }
      case "payment.refunded":
      case "payment.chargeback":
        // Medusa's provider webhook action contract does not contain refund/chargeback
        // actions. These events are acknowledged by the receiver but not silently
        // translated into a false order/payment status.
        this.logger_.warn("[Debito Pay] refund/chargeback event requires separate reconciliation")
        return { action: PaymentActions.NOT_SUPPORTED }
      default:
        return { action: PaymentActions.NOT_SUPPORTED }
    }
  }
}

export default DebitoPayPaymentProviderService
