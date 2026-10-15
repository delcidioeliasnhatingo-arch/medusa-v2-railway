import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

const CJ_BASE_URL = "https://developers.cjdropshipping.com/api2.0/v1"
const CALLBACK_URL = `${(process.env.MEDUSA_BACKEND_URL || "https://aveart-medusa-backend-production.up.railway.app").replace(/\/$/, "")}/webhooks/cj`

type CjEnvelope<T> = { code?: number; result?: boolean; success?: boolean; message?: string; data?: T }

async function getToken(): Promise<string> {
  const apiKey = process.env.CJ_API_KEY?.trim()
  if (apiKey) {
    const response = await fetch(`${CJ_BASE_URL}/authentication/getAccessToken`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ apiKey }),
      signal: AbortSignal.timeout(15000),
    })
    const payload = await response.json() as CjEnvelope<{ accessToken?: string }>
    if (response.ok && payload.code === 200 && payload.data?.accessToken) return payload.data.accessToken
  }
  const token = process.env.CJ_ACCESS_TOKEN?.trim()
  if (token) return token
  throw new Error("Configure CJ_API_KEY or CJ_ACCESS_TOKEN in Railway.")
}

/** Admin-only: registers signed order and logistics notifications with CJ. */
export async function POST(_req: MedusaRequest, res: MedusaResponse) {
  if (!process.env.CJ_OPEN_ID?.trim()) {
    return res.status(400).json({
      configured: false,
      message: "Set CJ_OPEN_ID in Railway first. CJ uses it to verify webhook signatures.",
    })
  }
  try {
    const token = await getToken()
    const response = await fetch(`${CJ_BASE_URL}/webhook/set`, {
      method: "POST",
      headers: { "CJ-Access-Token": token, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        product: { type: "CANCEL", callbackUrls: [CALLBACK_URL] },
        stock: { type: "CANCEL", callbackUrls: [CALLBACK_URL] },
        order: { type: "ENABLE", callbackUrls: [CALLBACK_URL] },
        logistics: { type: "ENABLE", callbackUrls: [CALLBACK_URL] },
        makeup: { type: "CANCEL", callbackUrls: [CALLBACK_URL] },
        privateOrder: { type: "CANCEL", callbackUrls: [CALLBACK_URL] },
        dispute: { type: "CANCEL", callbackUrls: [CALLBACK_URL] },
      }),
      signal: AbortSignal.timeout(15000),
    })
    const payload = await response.json() as CjEnvelope<unknown>
    if (!response.ok || payload.code !== 200 || payload.result === false || payload.success === false) {
      return res.status(502).json({ configured: false, provider: "cjdropshipping", message: payload.message || `CJ webhook setup failed (HTTP ${response.status}).` })
    }
    return res.status(200).json({ configured: true, callbackUrl: CALLBACK_URL, topics: ["ORDER", "LOGISTIC"], message: "CJ order and logistics webhooks enabled." })
  } catch (error) {
    return res.status(502).json({ configured: false, provider: "cjdropshipping", message: error instanceof Error ? error.message : "CJ webhook setup failed." })
  }
}
