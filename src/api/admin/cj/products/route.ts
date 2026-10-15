import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

const CJ_BASE_URL = "https://developers.cjdropshipping.com/api2.0/v1"

type CjEnvelope<T> = {
  code?: number
  result?: boolean
  success?: boolean
  message?: string
  data?: T
}

let cachedAccessToken: string | undefined
let cachedRefreshToken: string | undefined

async function getCjAccessToken(): Promise<string> {
  if (cachedAccessToken) return cachedAccessToken

  const accessToken = process.env.CJ_ACCESS_TOKEN?.trim()
  const refreshToken = process.env.CJ_REFRESH_TOKEN?.trim()

  if (accessToken) {
    cachedAccessToken = accessToken
    cachedRefreshToken = refreshToken
    return accessToken
  }

  if (!refreshToken) {
    throw new Error("CJ credentials are not configured. Set CJ_ACCESS_TOKEN and CJ_REFRESH_TOKEN.")
  }

  return refreshCjAccessToken(refreshToken)
}

async function refreshCjAccessToken(refreshToken: string): Promise<string> {
  const response = await fetch(`${CJ_BASE_URL}/authentication/refreshAccessToken`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken }),
    signal: AbortSignal.timeout(15000),
  })

  const payload = (await response.json()) as CjEnvelope<{
    accessToken?: string
    refreshToken?: string
  }>

  if (!response.ok || payload.code !== 200 || !payload.data?.accessToken) {
    throw new Error("CJ token refresh failed. Check the credentials and CJ API account status.")
  }

  cachedAccessToken = payload.data.accessToken
  cachedRefreshToken = payload.data.refreshToken || refreshToken
  return cachedAccessToken
}

async function cjGet(path: string, params: URLSearchParams): Promise<unknown> {
  let token = await getCjAccessToken()

  const request = (accessToken: string) =>
    fetch(`${CJ_BASE_URL}${path}?${params.toString()}`, {
      headers: { "CJ-Access-Token": accessToken, Accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    })

  let response = await request(token)

  if (response.status === 401) {
    const refreshToken = cachedRefreshToken || process.env.CJ_REFRESH_TOKEN?.trim()
    if (!refreshToken) {
      throw new Error("CJ access token expired and no refresh token is configured.")
    }
    token = await refreshCjAccessToken(refreshToken)
    response = await request(token)
  }

  const payload = (await response.json()) as CjEnvelope<unknown>
  if (!response.ok || (payload.code !== undefined && payload.code !== 200) || payload.result === false || payload.success === false) {
    const error = new Error(payload.message || `CJ API request failed (HTTP ${response.status}).`)
    Object.assign(error, { status: response.status })
    throw error
  }

  return payload
}

/**
 * Admin-only CJdropshipping catalog proxy.
 * Example: GET /admin/cj/products?keyword=dress&page=1&size=20
 * Credentials remain on the server and are never returned to the caller.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const keyword = String(req.query.keyword || "").trim().slice(0, 100)
    const page = Math.max(1, Math.min(1000, Number(req.query.page || 1) || 1))
    const size = Math.max(1, Math.min(100, Number(req.query.size || 20) || 20))

    const params = new URLSearchParams({
      page: String(page),
      size: String(size),
    })
    if (keyword) params.set("keyWord", keyword)

    const result = await cjGet("/product/listV2", params)
    res.status(200).json({ provider: "cjdropshipping", ...((result && typeof result === "object") ? result as object : { data: result }) })
  } catch (error) {
    const message = error instanceof Error ? error.message : "CJ catalog request failed."
    const status = (error as { status?: number })?.status
    res.status(status && status >= 400 && status < 500 ? status : 502).json({
      message,
      provider: "cjdropshipping",
    })
  }
}
