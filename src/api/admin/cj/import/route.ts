import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { createProductsWorkflow } from "@medusajs/medusa/core-flows"

const CJ_BASE_URL = "https://developers.cjdropshipping.com/api2.0/v1"
const TARGET_GROSS_MARGIN = 0.5

type CjEnvelope<T> = {
  code?: number
  result?: boolean
  success?: boolean
  message?: string
  data?: T
}

type CjVariant = {
  id?: string
  sku?: string
  nameen?: string
  sellprice?: string | number
  nowPrice?: string | number | null
  variantkey?: string
  img?: string
  totalInventory?: number | null
}

type CjProduct = {
  id?: string
  sku?: string
  nameen?: string
  sellprice?: string | number
  bigimg?: string
  img?: string
  newImgList?: string[]
  description?: string
  variantkeyen?: string
  variantkey?: string
  stanProducts?: CjVariant[]
}

let cachedAccessToken: string | undefined
let cachedRefreshToken: string | undefined

async function getCjToken(): Promise<string> {
  if (cachedAccessToken) return cachedAccessToken

  const accessToken = process.env.CJ_ACCESS_TOKEN?.trim()
  const refreshToken = process.env.CJ_REFRESH_TOKEN?.trim()
  const apiKey = process.env.CJ_API_KEY?.trim()

  if (accessToken) {
    cachedAccessToken = accessToken
    cachedRefreshToken = refreshToken
    return accessToken
  }
  if (refreshToken) return refreshCjAccessToken(refreshToken)
  if (apiKey) return obtainCjTokenFromApiKey(apiKey)

  throw new Error("CJ credentials are missing. Configure CJ_API_KEY, CJ_ACCESS_TOKEN and/or CJ_REFRESH_TOKEN in Railway.")
}

async function obtainCjTokenFromApiKey(apiKey: string): Promise<string> {
  const response = await fetch(`${CJ_BASE_URL}/authentication/getAccessToken`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ apiKey }),
    signal: AbortSignal.timeout(15000),
  })
  const payload = (await response.json()) as CjEnvelope<{ accessToken?: string; refreshToken?: string }>
  if (!response.ok || payload.code !== 200 || !payload.data?.accessToken) {
    throw new Error(payload.message || `CJ token acquisition failed (HTTP ${response.status}). Check CJ_API_KEY.`)
  }
  cachedAccessToken = payload.data.accessToken
  cachedRefreshToken = payload.data.refreshToken || process.env.CJ_REFRESH_TOKEN?.trim()
  return cachedAccessToken
}

async function refreshCjAccessToken(refreshToken: string): Promise<string> {
  const response = await fetch(`${CJ_BASE_URL}/authentication/refreshAccessToken`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ refreshToken }),
    signal: AbortSignal.timeout(15000),
  })
  const payload = (await response.json()) as CjEnvelope<{ accessToken?: string; refreshToken?: string }>
  if (!response.ok || payload.code !== 200 || !payload.data?.accessToken) {
    const apiKey = process.env.CJ_API_KEY?.trim()
    if (apiKey) return obtainCjTokenFromApiKey(apiKey)
    throw new Error(payload.message || `CJ token refresh failed (HTTP ${response.status}); configure a valid CJ_API_KEY to reauthorize.`)
  }
  cachedAccessToken = payload.data.accessToken
  cachedRefreshToken = payload.data.refreshToken || refreshToken
  return cachedAccessToken
}

async function queryCjProductDetail(productId: string): Promise<CjProduct> {
  let token = await getCjToken()

  const request = (accessToken: string) => fetch(`${CJ_BASE_URL}/product/productDetail/query`, {
    method: "POST",
    headers: {
      "CJ-Access-Token": accessToken,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ id: productId }),
    signal: AbortSignal.timeout(20000),
  })

  let response = await request(token)
  let payload = (await response.json()) as CjEnvelope<CjProduct>
  const invalidToken = response.status === 401 || payload.code === 1600001 || payload.code === 1600002
  if (invalidToken) {
    const refreshToken = cachedRefreshToken || process.env.CJ_REFRESH_TOKEN?.trim()
    token = refreshToken
      ? await refreshCjAccessToken(refreshToken)
      : process.env.CJ_API_KEY?.trim()
        ? await obtainCjTokenFromApiKey(process.env.CJ_API_KEY.trim())
        : token
    response = await request(token)
    payload = (await response.json()) as CjEnvelope<CjProduct>
  }

  if (!response.ok || payload.code !== 200 || payload.result === false || payload.success === false || !payload.data) {
    throw new Error(payload.message || `CJ product detail request failed (HTTP ${response.status}, code ${payload.code ?? "unknown"}).`)
  }
  return payload.data
}

function parseMoney(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function makeHandle(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 180)
}

function buildOptions(product: CjProduct, variants: CjVariant[]) {
  const dimensionNames = (product.variantkeyen || product.variantkey || "")
    .split("-").map((name) => name.trim()).filter(Boolean)
  const valueRows = variants.map((variant) => (variant.variantkey || "")
    .split("-").map((value) => value.trim()))
  const dimensionCount = dimensionNames.length > 0
    ? Math.min(dimensionNames.length, Math.max(0, ...valueRows.map((row) => row.length)))
    : Math.max(0, ...valueRows.map((row) => row.length))

  if (!variants.length || dimensionCount === 0) {
    return { options: [] as { title: string; values: string[] }[], variantOptions: variants.map(() => ({} as Record<string, string>)) }
  }

  const titles = Array.from({ length: dimensionCount }, (_, index) =>
    dimensionNames[index] || `Option ${index + 1}`)
  const options = titles.map((title, index) => ({
    title: title.charAt(0).toUpperCase() + title.slice(1),
    values: unique(valueRows.map((row) => row[index] || "Standard")),
  }))
  const variantOptions = valueRows.map((row) =>
    Object.fromEntries(options.map((option, index) => [option.title, row[index] || "Standard"])))
  return { options, variantOptions }
}

/**
 * Imports exactly one CJ product into Medusa as a DRAFT.
 * POST /admin/cj/import with JSON body: { "productId": "<CJ product id>" }
 * A 50% target gross margin means retail price = supplier unit price / (1 - 0.50).
 * Shipping, payment fees, tax and other costs are not included in this initial price.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const body = (req.body || {}) as { productId?: unknown }
    const productId = typeof body.productId === "string" ? body.productId.trim() : ""
    if (!productId || productId.length > 100 || !/^[A-Za-z0-9-]+$/.test(productId)) {
      return res.status(400).json({
        message: 'Provide one valid CJ product ID in the JSON body: { "productId": "..." }',
      })
    }

    const cj = await queryCjProductDetail(productId)
    const title = String(cj.nameen || cj.sku || "").trim()
    if (!title) throw new Error("CJ returned no English product name; refusing to create an incomplete draft.")

    const cjVariants = Array.isArray(cj.stanProducts) ? cj.stanProducts : []
    const usableVariants = cjVariants.map((variant) => ({
      variant,
      cost: parseMoney(variant.nowPrice) ?? parseMoney(variant.sellprice),
    })).filter((entry) => entry.cost !== null)

    if (!usableVariants.length) {
      throw new Error("CJ returned no variants with a usable USD price. No Medusa product was created.")
    }

    const variants = usableVariants.map(({ variant, cost }) => ({
      title: String(variant.nameen || variant.variantkey || variant.sku || title).trim().slice(0, 200),
      ...(variant.sku ? { sku: variant.sku } : {}),
      manage_inventory: false,
      allow_backorder: true,
      metadata: {
        supplier: "cjdropshipping",
        cj_product_id: productId,
        cj_variant_id: String(variant.id || ""),
        cj_sku: String(variant.sku || ""),
        cj_supplier_price_usd: String(cost),
      },
      prices: [{
        currency_code: "usd",
        amount: Math.round((cost as number) / (1 - TARGET_GROSS_MARGIN) * 100) / 100,
      }],
      options: {} as Record<string, string>,
    }))

    const { options, variantOptions } = buildOptions(cj, usableVariants.map(({ variant }) => variant))
    variants.forEach((variant, index) => { variant.options = variantOptions[index] || {} })

    const imageCandidates = [
      ...(Array.isArray(cj.newImgList) ? cj.newImgList : []),
      ...(typeof cj.img === "string" ? cj.img.split(",") : []),
      ...(typeof cj.bigimg === "string" ? [cj.bigimg] : []),
    ]
    const images = unique(imageCandidates.filter((url) => /^https?:\/\//i.test(url)))
      .slice(0, 12).map((url) => ({ url }))
    const thumbnail = images[0]?.url

    const workflowResult = await createProductsWorkflow(req.scope).run({
      input: {
        products: [{
          title: title.slice(0, 200),
          handle: makeHandle(`cj-${cj.sku || productId}-${title}`),
          status: "draft",
          ...(typeof cj.description === "string" && cj.description.trim()
            ? { description: cj.description.slice(0, 10000) } : {}),
          ...(images.length ? { images, thumbnail } : {}),
          options,
          variants,
          metadata: {
            supplier: "cjdropshipping",
            cj_product_id: productId,
            cj_product_sku: cj.sku || "",
            target_gross_margin_percent: 50,
            imported_as_draft: true,
            price_formula: "supplier_unit_price_usd / (1 - 0.50)",
            shipping_and_fees_included: false,
            imported_at: new Date().toISOString(),
          },
        }],
      },
    })

    const created = Array.isArray(workflowResult.result) ? workflowResult.result[0] : workflowResult.result
    return res.status(201).json({
      provider: "cjdropshipping",
      imported: true,
      status: "draft",
      targetGrossMarginPercent: 50,
      note: "Shipping, payment fees, taxes and other operating costs are not included in the price formula.",
      product: created,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "CJ draft import failed."
    return res.status(502).json({ provider: "cjdropshipping", imported: false, message })
  }
}
