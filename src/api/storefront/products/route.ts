import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
    const { data, metadata } = await query.graph({
      entity: "product",
      fields: [
        "id", "title", "handle", "subtitle", "description", "status",
        "thumbnail", "created_at", "metadata", "images.url",
        "variants.id", "variants.title", "variants.sku", "variants.thumbnail",
        "variants.manage_inventory", "variants.inventory_quantity", "variants.created_at",
        "variants.options.value", "variants.options.option.title",
        "categories.id", "categories.name", "categories.handle",
        "tags.value", "type.value", "collection.title"
      ],
      filters: { status: "published" },
      pagination: { take: 100, skip: 0, order: { created_at: "DESC" } }
    })
    res.setHeader("Cache-Control", "public, max-age=60, s-maxage=60, stale-while-revalidate=300")
    return res.status(200).json({ products: data, count: metadata?.count ?? data.length })
  } catch (error) {
    req.scope.resolve(ContainerRegistrationKeys.LOGGER).error("Storefront catalog query failed")
    return res.status(500).json({ message: "Unable to load published storefront products" })
  }
}
