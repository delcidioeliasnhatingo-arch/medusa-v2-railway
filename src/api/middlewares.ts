import { defineMiddlewares } from "@medusajs/framework/http"

export default defineMiddlewares({
  routes: [
    {
      matcher: "/webhooks/cj",
      method: "POST",
      bodyParser: { preserveRawBody: true },
    },
    {
      // Debito Pay signs the exact raw JSON body with HMAC-SHA256.
      matcher: "/webhooks/debitopay",
      method: ["POST"],
      bodyParser: { preserveRawBody: true },
    },
    {
      matcher: "/",
      method: "GET",
      middlewares: [
        (_req, res) => {
          res.status(200).json({
            status: "ok",
            service: "AVEART Medusa Backend",
            message: "Medusa API is running",
            health: "/health",
            products: "/store/products",
          })
        },
      ],
    },
  ],
})
