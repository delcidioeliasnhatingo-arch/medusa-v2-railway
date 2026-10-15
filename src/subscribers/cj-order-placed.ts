import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { updateOrderWorkflow } from "@medusajs/medusa/core-flows"

const CJ_BASE_URL = "https://developers.cjdropshipping.com/api2.0/v1"

type CjEnvelope<T> = {
  code?: number
  result?: boolean
  success?: boolean
  message?: string
  data?: T
}

type CjVariant = { id?: string; sku?: string; nameen?: string; variantkey?: string }
type CjProduct = { id?: string; stanProducts?: CjVariant[] }
type CjFreight = { logisticName?: string; logisticPrice?: number | string; error?: string; errorEn?: string }

let cachedAccessToken: string | undefined
let cachedRefreshToken: string | undefined

async function getCjToken(): Promise<string> {
  if (cachedAccessToken) return cachedAccessToken
  const accessToken = process.env.CJ_ACCESS_TOKEN?.trim()
  cachedRefreshToken = process.env.CJ_REFRESH_TOKEN?.trim()
  if (accessToken) {
    cachedAccessToken = accessToken
    return accessToken
  }
  const apiKey = process.env.CJ_API_KEY?.trim()
  if (!apiKey) throw new Error("CJ_ACCESS_TOKEN or CJ_API_KEY must be configured")
  return obtainCjTokenFromApiKey(apiKey)
}

async function obtainCjTokenFromApiKey(apiKey: string): Promise<string> {
  const response = await fetch(`${CJ_BASE_URL}/authentication/getAccessToken`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ apiKey }),
    signal: AbortSignal.timeout(15000),
  })
  const payload = await response.json() as CjEnvelope<{ accessToken?: string; refreshToken?: string }>
  if (!response.ok || payload.code !== 200 || !payload.data?.accessToken) {
    throw new Error(payload.message || `CJ authentication failed (HTTP ${response.status})`)
  }
  cachedAccessToken = payload.data.accessToken
  cachedRefreshToken = payload.data.refreshToken || cachedRefreshToken
  return cachedAccessToken
}

async function refreshCjToken(): Promise<string> {
  const refreshToken = cachedRefreshToken || process.env.CJ_REFRESH_TOKEN?.trim()
  if (refreshToken) {
    const response = await fetch(`${CJ_BASE_URL}/authentication/refreshAccessToken`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ refreshToken }),
      signal: AbortSignal.timeout(15000),
    })
    const payload = await response.json() as CjEnvelope<{ accessToken?: string; refreshToken?: string }>
    if (response.ok && payload.code === 200 && payload.data?.accessToken) {
      cachedAccessToken = payload.data.accessToken
      cachedRefreshToken = payload.data.refreshToken || refreshToken
      return cachedAccessToken
    }
  }
  const apiKey = process.env.CJ_API_KEY?.trim()
  if (apiKey) return obtainCjTokenFromApiKey(apiKey)
  throw new Error("CJ token expired and refresh failed. Check CJ_REFRESH_TOKEN or CJ_API_KEY.")
}

async function cjPost<T>(path: string, body: unknown): Promise<T> {
  let token = await getCjToken()
  const request = (accessToken: string) => fetch(`${CJ_BASE_URL}${path}`, {
    method: "POST",
    headers: { "CJ-Access-Token": accessToken, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25000),
  })
  let response = await request(token)
  let payload = await response.json() as CjEnvelope<T>
  const invalidToken = response.status === 401 || payload.code === 1600001 || payload.code === 1600002
  if (invalidToken) {
    token = await refreshCjToken()
    response = await request(token)
    payload = await response.json() as CjEnvelope<T>
  }
  if (!response.ok || payload.code !== 200 || payload.result === false || payload.success === false || payload.data == null) {
    throw new Error(payload.message || `CJ request ${path} failed (HTTP ${response.status}, code ${payload.code ?? "unknown"})`)
  }
  return payload.data
}

function asText(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : ""
}

function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code.toUpperCase()) || code.toUpperCase()
  } catch {
    return code.toUpperCase()
  }
}

async function getCjVariantId(productId: string, sku: string, storedVariantId: string): Promise<string> {
  if (storedVariantId) return storedVariantId
  if (!productId) throw new Error(`Missing CJ product ID for SKU ${sku}`)
  const product = await cjPost<CjProduct>("/product/productDetail/query", { id: productId })
  const variant = (product.stanProducts || []).find((entry) => entry.sku === sku)
  if (!variant?.id) throw new Error(`Could not map CJ SKU ${sku} to a CJ variant ID`)
  return variant.id
}

/**
 * Processes only CJdropshipping products after Medusa emits order.placed.
 * CJ payType=2 pays from the merchant's CJ balance, so never test with a real order.
 */
export default async function cjOrderPlacedHandler({ event, container }: SubscriberArgs<{ id: string }>) {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const eventName = String((event as any).name || "")
  let orderId = event.data.id

  // A captured-payment event carries a payment ID, not an order ID. Resolve its
  // payment collection and then the linked order before processing fulfillment.
  if (eventName === "payment.captured") {
    const { data: payments } = await query.graph({
      entity: "payment",
      fields: ["id", "payment_collection_id"],
      filters: { id: event.data.id },
    })
    const paymentCollectionId = asText((payments?.[0] as any)?.payment_collection_id)
    if (!paymentCollectionId) {
      console.warn("CJ fulfillment: captured payment has no payment collection", { paymentId: event.data.id })
      return
    }
    const { data: linkedOrders } = await query.graph({
      entity: "order",
      fields: ["id", "display_id"],
      filters: { payment_collections: { id: paymentCollectionId } } as any,
    })
    orderId = asText((linkedOrders?.[0] as any)?.id)
    if (!orderId) {
      console.info("CJ fulfillment: captured payment is not linked to an order yet", { paymentId: event.data.id })
      return
    }
  }

  const lockKey = `cj-fulfillment:${orderId}`
  const locking = container.resolve(Modules.LOCKING)
  await locking.acquire(lockKey, { expire: 180 })
  try {
    const { data } = await query.graph({
      entity: "order",
      fields: [
        "id", "display_id", "email", "currency_code", "metadata",
        "payment_collections.id", "payment_collections.status",
        "payment_collections.payments.id", "payment_collections.payments.captured_at",
        "shipping_address.*",
        "items.*", "items.variant.*", "items.variant.product.*",
      ],
      filters: { id: orderId },
    })
    const order = data?.[0] as any
    if (!order) throw new Error(`CJ fulfillment: Medusa order ${orderId} was not found`)
  
    const orderMetadata = (order.metadata || {}) as Record<string, unknown>
    const existingStatus = asText(orderMetadata.cj_fulfillment_status)
    if (orderMetadata.cj_order_id || ["submitting", "submitted", "submission_uncertain"].includes(existingStatus)) {
      console.info(`CJ fulfillment already claimed/submitted for Medusa order ${orderId}; skipping duplicate event`)
      return
    }
  
    // Do not spend the merchant's CJ balance for authorized, pending, or unpaid
    // orders. The payment.captured subscription below retries this path after capture.
    const paymentCollections = Array.isArray(order.payment_collections) ? order.payment_collections : []
    const paymentConfirmed = paymentCollections.length > 0 && paymentCollections.every((collection: any) =>
      collection.status === "captured" ||
      (Array.isArray(collection.payments) && collection.payments.length > 0 &&
        collection.payments.every((payment: any) => Boolean(payment.captured_at))),
    )
    if (!paymentConfirmed) {
      console.info(`CJ fulfillment held for Medusa order ${orderId}: payment is not fully captured`)
      return
    }
  
    const items = Array.isArray(order.items) ? order.items : []
    const cjItems = items.filter((item: any) =>
      item?.variant?.metadata?.supplier === "cjdropshipping" ||
      item?.variant?.product?.metadata?.supplier === "cjdropshipping" ||
      asText(item?.variant?.sku).startsWith("CJ"),
    )
    if (cjItems.length === 0) {
      console.info(`Medusa order ${orderId} has no CJdropshipping items; no CJ order created`)
      return
    }
    if (cjItems.length !== items.length) {
      throw new Error(`Order ${orderId} mixes CJ and non-CJ items. Automatic fulfillment stopped to prevent a partial shipment.`)
    }
    if (!["usd"].includes(asText(order.currency_code).toLowerCase())) {
      throw new Error(`Order ${orderId} is in ${order.currency_code}; CJ auto-fulfillment currently requires USD checkout`)
    }
  
    const address = order.shipping_address || {}
    const countryCode = asText(address.country_code).toUpperCase()
    const city = asText(address.city)
    const province = asText(address.province) || city
    const customerName = [asText(address.first_name), asText(address.last_name)].filter(Boolean).join(" ")
    const addressLine = asText(address.address_1)
    if (!/^[A-Z]{2}$/.test(countryCode) || !city || !customerName || !addressLine) {
      throw new Error(`Order ${orderId} is missing required shipping address fields (country, city, recipient name or address)`)
    }
  
    const fromCountryCode = (process.env.CJ_FROM_COUNTRY_CODE || "CN").trim().toUpperCase()
    const products: Array<{ vid: string; sku: string; quantity: number; storeLineItemId: string; variantOptions: string }> = []
    for (const item of cjItems) {
      const variant = item.variant || {}
      const product = variant.product || {}
      const variantMetadata = variant.metadata || {}
      const productMetadata = product.metadata || {}
      const sku = asText(variantMetadata.cj_sku) || asText(variant.sku)
      const cjProductId = asText(variantMetadata.cj_product_id) || asText(productMetadata.cj_product_id)
      const cjVariantId = await getCjVariantId(cjProductId, sku, asText(variantMetadata.cj_variant_id))
      const quantity = Math.max(1, Number(item.quantity) || 1)
      products.push({
        vid: cjVariantId,
        sku,
        quantity,
        storeLineItemId: asText(item.id),
        variantOptions: asText(item.title).slice(0, 100),
      })
    }
  
    const freight = await cjPost<CjFreight[]>("/logistic/freightCalculate", {
      startCountryCode: fromCountryCode,
      endCountryCode: countryCode,
      zip: asText(address.postal_code),
      products: products.map(({ vid, quantity }) => ({ vid, quantity })),
    })
    const availableFreight = (Array.isArray(freight) ? freight : [])
      .filter((entry) => asText(entry.logisticName) && !entry.error && !entry.errorEn && Number.isFinite(Number(entry.logisticPrice)))
      .sort((a, b) => Number(a.logisticPrice) - Number(b.logisticPrice))
    if (!availableFreight.length) {
      throw new Error(`CJ returned no valid shipping method for Medusa order ${orderId} to ${countryCode}`)
    }
    const logisticName = asText(availableFreight[0].logisticName)
  
    // Claim the order before calling CJ. If the request times out after CJ accepts it,
    // a retry must not create a second supplier order. Such cases require reconciliation.
    const supplierOrderNumber = `AVEART-${String(order.display_id || order.id).slice(0, 40)}`
    await updateOrderWorkflow(container).run({
      input: {
        id: order.id,
        user_id: "",
        metadata: {
          ...orderMetadata,
          cj_fulfillment_status: "submitting",
          cj_order_number: supplierOrderNumber,
          cj_submission_started_at: new Date().toISOString(),
        },
      },
    })
    const created = await cjPost<Record<string, unknown>>("/shopping/order/createOrderV2", {
      orderNumber: supplierOrderNumber,
      shippingZip: asText(address.postal_code),
      shippingCountryCode: countryCode,
      shippingCountry: countryName(countryCode),
      shippingProvince: province,
      shippingCity: city,
      shippingCounty: asText(address.province),
      shippingPhone: asText(address.phone),
      shippingCustomerName: customerName.slice(0, 50),
      shippingAddress: addressLine,
      shippingAddress2: asText(address.address_2),
      email: asText(order.email),
      remark: `AVEART Medusa order ${order.display_id || order.id}`,
      payType: 2,
      shopLogisticsType: 2,
      logisticName,
      fromCountryCode,
      platform: "Api",
      orderFlow: 1,
      products,
    })
  
    const cjOrderId = asText(created.orderId) || asText(created.shipmentOrderId)
    if (!cjOrderId) {
      throw new Error(`CJ response for ${supplierOrderNumber} did not include an order ID; inspect CJ order history before retrying`)
    }
  
    await updateOrderWorkflow(container).run({
      input: {
        id: order.id,
        user_id: "",
        metadata: {
          ...orderMetadata,
          cj_fulfillment_status: "submitted",
          cj_order_id: cjOrderId,
          cj_order_number: supplierOrderNumber,
          cj_logistic_name: logisticName,
          cj_auto_paid_from_balance: true,
          cj_submitted_at: new Date().toISOString(),
        },
      },
    })
    console.info(`CJ order ${cjOrderId} created for Medusa order ${order.id}; logistics=${logisticName}`
  } finally {
    await locking.release(lockKey)
  }
})
}

export const config: SubscriberConfig = {
  event: ["order.placed", "payment.captured"],
}
