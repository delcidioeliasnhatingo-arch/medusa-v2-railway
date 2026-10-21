import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  try {
    const result = await query.graph({
      entity: "product_category",
      fields: ["id", "name", "handle", "description", "rank", "metadata", "is_active"],
      filters: { is_active: true },
      pagination: { take: 100, skip: 0 }
    })
    res.setHeader("Cache-Control", "public, max-age=60, s-maxage=60")
    return res.status(200).json({ product_categories: result.data })
  } catch (e) {
    req.scope.resolve(ContainerRegistrationKeys.LOGGER).error("Storefront categories failed")
    return res.status(500).json({ message: "Unable to load categories" })
  }
}
