import { defineWidgetConfig } from "@medusajs/admin-sdk"

/**
 * AVEART-specific checklist shown on each product detail page.
 * This is a guidance widget only: it does not invent inventory or price data,
 * and it never changes a product automatically.
 */
const AveartProductReadinessWidget = () => {
  return (
    <div className="rounded-lg border border-ui-border-base bg-ui-bg-base p-4">
      <h2 className="text-base font-semibold text-ui-fg-base">
        AVEART product readiness
      </h2>
      <p className="mt-1 text-sm text-ui-fg-subtle">
        Before publishing a product to the South African storefront, verify each item below.
      </p>
      <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-ui-fg-base">
        <li>Price is entered in ZAR (R), not USD or another currency.</li>
        <li>Title, description, handle, category and product images are correct.</li>
        <li>Every size/colour variant has a unique SKU and the correct option values.</li>
        <li>Inventory is accurate and linked to the intended stock location.</li>
        <li>Weight and dimensions are completed before shipping is configured.</li>
        <li>Product status is set to Published only after the checks above.</li>
      </ul>
      <p className="mt-3 text-xs text-ui-fg-muted">
        This checklist is advisory; it does not validate or modify the product automatically.
      </p>
    </div>
  )
}

export const config = defineWidgetConfig({
  zone: "product.details.after",
})

export default AveartProductReadinessWidget
