import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { createHmac, timingSafeEqual } from "node:crypto"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { updateOrderWorkflow } from "@medusajs/medusa/core-flows"

type CjWebhook = {
  messageId?: string
  type?: string
  messageType?: string
  params?: Record<string, unknown>
}

function validSignature(rawBody: string, signature: string, openId: string): boolean {
  if (!signature || !openId) return false
  const expected = createHmac("sha256", openId).update(rawBody, "utf8").digest("base64")
  const a = Buffer.from(expected)
  const b = Buffer.from(signature)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const openId = process.env.CJ_OPEN_ID?.trim()
  const signature = String(req.headers.sign || "")
  const raw = (req as any).rawBody
  const rawBody = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : ""
  if (!openId || !rawBody || !validSignature(rawBody, signature, openId)) {
    return res.status(401).json({ received: false, message: "Invalid CJ webhook signature or CJ_OPEN_ID/raw body is not configured." })
  }

  const payload = req.body as CjWebhook
  if (!payload || !payload.type || !payload.params) {
    return res.status(400).json({ received: false, message: "Invalid CJ webhook payload." })
  }

  // Acknowledge promptly as CJ expects HTTP 200 within 3 seconds; synchronize in the background.
  res.status(200).json({ received: true, messageId: payload.messageId || null })
  void (async () => {
    const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
    const params = payload.params || {}
    let storeOrderNumber = ""
    let patch: Record<string, unknown> = {}

    if (payload.type === "ORDER") {
      storeOrderNumber = String(params.orderNumber || params.orderNum || "")
      patch = {
        cj_order_status: params.orderStatus || params.status || null,
        cj_order_id: params.cjOrderId || null,
        cj_logistic_name: params.logisticName || null,
        cj_tracking_number: params.trackNumber || null,
        cj_tracking_url: params.trackingUrl || null,
        cj_last_supplier_update: params.updateDate || new Date().toISOString(),
      }
    } else if (payload.type === "LOGISTIC") {
      const numbers = Array.isArray(params.storeOrderNumbers) ? params.storeOrderNumbers : []
      storeOrderNumber = String(numbers[0] || "")
      patch = {
        cj_tracking_number: params.trackingNumber || null,
        cj_tracking_url: params.trackingUrl || null,
        cj_tracking_provider: params.trackingProvider || null,
        cj_tracking_status: params.trackingStatus ?? null,
        cj_tracking_events: params.logisticsTrackEvents || null,
        cj_last_supplier_update: new Date().toISOString(),
      }
    } else {
      return
    }

    const displayIdMatch = /^AVEART-(\d+)$/.exec(storeOrderNumber)
    if (!displayIdMatch) {
      console.warn("CJ webhook could not map supplier order number to an AVEART order", { type: payload.type, storeOrderNumber })
      return
    }

    const { data } = await query.graph({
      entity: "order",
      fields: ["id", "display_id", "metadata"],
      filters: { display_id: displayIdMatch[1] },
    })
    const order = data?.[0] as any
    if (!order) {
      console.warn("CJ webhook received for unknown AVEART order", { storeOrderNumber })
      return
    }
    await updateOrderWorkflow(req.scope).run({
      input: {
        id: order.id,
        user_id: "",
        metadata: { ...(order.metadata || {}), ...patch },
      },
    })
  })().catch((error) => console.error("CJ webhook synchronization failed:", error))
}

export const config = {
  bodyParser: { preserveRawBody: true },
}
