import { defineMiddlewares } from "@medusajs/framework/http"

export default defineMiddlewares({
  routes: [
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
