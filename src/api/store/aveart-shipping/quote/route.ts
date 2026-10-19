import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

type Address = {
  street_address: string
  city: string
  zone: string
  country: "ZA"
  code: string
  local_area?: string
  type?: "residential" | "business" | "unknown"
  lat?: number
  lng?: number
}

type Parcel = {
  submitted_length_cm: number
  submitted_width_cm: number
  submitted_height_cm: number
  submitted_weight_kg: number
  parcel_description?: string
}

type QuoteBody = {
  collection_address: Address
  delivery_address: Address
  parcels: Parcel[]
  declared_value?: number
}

function validAddress(value: unknown): value is Address {
  if (!value || typeof value !== "object") return false
  const a = value as Record<string, unknown>
  return ["street_address", "city", "zone", "code"].every(
    (key) => typeof a[key] === "string" && (a[key] as string).trim().length > 0
  ) && a.country === "ZA"
}

function validParcels(value: unknown): value is Parcel[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 20 &&
    value.every((item) => {
      if (!item || typeof item !== "object") return false
      const p = item as Record<string, unknown>
      return ["submitted_length_cm", "submitted_width_cm", "submitted_height_cm", "submitted_weight_kg"]
        .every((key) => typeof p[key] === "number" && Number.isFinite(p[key]) && (p[key] as number) > 0)
    })
}

export async function POST(req: MedusaRequest<QuoteBody>, res: MedusaResponse) {
  const token = process.env.SHIPLOGIC_API_TOKEN
  if (!token) {
    return res.status(503).json({
      code: "shipping_provider_not_configured",
      message: "A cotação em tempo real ainda não está ativa. Configure SHIPLOGIC_API_TOKEN no ambiente do backend.",
    })
  }

  const body = req.body as QuoteBody
  if (!validAddress(body?.collection_address) ||
      !validAddress(body?.delivery_address) ||
      !validParcels(body?.parcels)) {
    return res.status(400).json({
      code: "invalid_shipping_request",
      message: "Indique os endereços completos na África do Sul e pelo menos um volume com peso e dimensões em cm/kg.",
    })
  }

  if (body.declared_value !== undefined &&
      (!Number.isFinite(body.declared_value) || body.declared_value < 0)) {
    return res.status(400).json({ code: "invalid_declared_value" })
  }

  try {
    const response = await fetch("https://api.shiplogic.com/rates", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        collection_address: body.collection_address,
        delivery_address: body.delivery_address,
        parcels: body.parcels,
        ...(body.declared_value !== undefined ? { declared_value: body.declared_value } : {}),
      }),
      signal: AbortSignal.timeout(15000),
    })

    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      // Do not expose provider credentials or raw upstream diagnostics to storefront users.
      return res.status(response.status === 401 || response.status === 403 ? 502 : 502).json({
        code: "shipping_provider_error",
        message: "A transportadora não conseguiu fornecer uma cotação. Verifique a conta, os endereços e as credenciais.",
      })
    }

    return res.status(200).json({
      provider: "shiplogic",
      currency_code: "zar",
      quote: payload,
      pricing_note: "Cotação real da transportadora; ainda não é uma alteração do preço do produto.",
    })
  } catch {
    return res.status(502).json({
      code: "shipping_provider_unavailable",
      message: "Não foi possível contactar a transportadora. Tente novamente mais tarde.",
    })
  }
}
