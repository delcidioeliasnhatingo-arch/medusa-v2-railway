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

type ProviderRate = {
  rate?: number | string
  service_level?: {
    code?: string
    name?: string
    id?: number | string
    delivery_date_from?: string
    delivery_date_to?: string
    collection_date?: string
  }
  service_level_code?: string
  service_level_name?: string
  service_level_id?: number | string
  estimated_collection?: string
  estimated_delivery_from?: string
  estimated_delivery_to?: string
}

function validAddress(value: unknown): value is Address {
  if (!value || typeof value !== "object") return false
  const a = value as Record<string, unknown>
  return ["street_address", "city", "zone", "code"].every(
    (key) => typeof a[key] === "string" && (a[key] as string).trim().length > 0
  ) && a.country === "ZA" &&
    (a.type === undefined || ["residential", "business", "unknown"].includes(String(a.type))) &&
    (a.lat === undefined || (typeof a.lat === "number" && Number.isFinite(a.lat))) &&
    (a.lng === undefined || (typeof a.lng === "number" && Number.isFinite(a.lng)))
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

function normalizeRates(payload: unknown) {
  if (!payload || typeof payload !== "object") return []
  const object = payload as { rates?: unknown }
  const rates = Array.isArray(object.rates) ? object.rates : Array.isArray(payload) ? payload : []
  return (rates as ProviderRate[]).flatMap((item) => {
    const amount = Number(item?.rate)
    if (!Number.isFinite(amount) || amount < 0) return []
    return [{
      service_code: String(item.service_level?.code ?? item.service_level_code ?? ""),
      service_name: String(item.service_level?.name ?? item.service_level_name ?? "Entrega"),
      service_id: item.service_level?.id ?? item.service_level_id ?? null,
      amount_zar: amount,
      estimated_collection: item.service_level?.collection_date ?? item.estimated_collection ?? null,
      estimated_delivery_from: item.service_level?.delivery_date_from ?? item.estimated_delivery_from ?? null,
      estimated_delivery_to: item.service_level?.delivery_date_to ?? item.estimated_delivery_to ?? null,
    }]
  }).sort((a, b) => a.amount_zar - b.amount_zar)
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

    const payload: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      return res.status(502).json({
        code: "shipping_provider_error",
        message: "A transportadora não conseguiu fornecer uma cotação. Verifique a conta, os endereços e as credenciais.",
      })
    }

    const rates = normalizeRates(payload)
    if (!rates.length) {
      return res.status(502).json({
        code: "shipping_rates_unavailable",
        message: "A transportadora respondeu, mas não devolveu tarifas utilizáveis para esta rota.",
      })
    }

    return res.status(200).json({
      provider: "shiplogic",
      currency_code: "zar",
      collection_postal_code: body.collection_address.code,
      delivery_postal_code: body.delivery_address.code,
      billable_parcels: body.parcels.map((parcel) => ({
        weight_kg: parcel.submitted_weight_kg,
        dimensions_cm: {
          length: parcel.submitted_length_cm,
          width: parcel.submitted_width_cm,
          height: parcel.submitted_height_cm,
        },
      })),
      rates,
      pricing_note: "Estas são cotações da transportadora para a rota indicada. Não alteram automaticamente os preços do catálogo.",
    })
  } catch {
    return res.status(502).json({
      code: "shipping_provider_unavailable",
      message: "Não foi possível contactar a transportadora. Tente novamente mais tarde.",
    })
  }
}
