import { loadEnv, defineConfig } from "@medusajs/framework/utils"

loadEnv(process.env.NODE_ENV || "development", process.cwd())

// Redis is optional for a small single-instance deployment. When REDIS_URL is
// configured, Medusa uses Redis-backed events, workflows, caching and locks.
// Without it, Medusa uses its built-in in-memory implementations.
const redisUrl = process.env.REDIS_URL

const redisModules = redisUrl
  ? [
      {
        resolve: "@medusajs/medusa/event-bus-redis",
        options: { redisUrl },
      },
      {
        resolve: "@medusajs/medusa/workflow-engine-redis",
        options: { redis: { redisUrl } },
      },
      {
        resolve: "@medusajs/medusa/caching",
        options: {
          providers: [
            {
              resolve: "@medusajs/caching-redis",
              id: "caching-redis",
              is_default: true,
              options: { redisUrl },
            },
          ],
        },
      },
      {
        resolve: "@medusajs/medusa/locking",
        options: {
          providers: [
            {
              resolve: "@medusajs/medusa/locking-redis",
              id: "locking-redis",
              is_default: true,
              options: { redisUrl },
            },
          ],
        },
      },
    ]
  : []

module.exports = defineConfig({
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    redisUrl,
    workerMode: process.env.MEDUSA_WORKER_MODE as "shared" | "server" | "worker",
    http: {
      storeCors: process.env.STORE_CORS || "http://localhost:3000,http://localhost:8000",
      adminCors: process.env.ADMIN_CORS || "http://localhost:9000",
      authCors: process.env.AUTH_CORS || "http://localhost:3000,http://localhost:9000",
      jwtSecret: process.env.JWT_SECRET,
      cookieSecret: process.env.COOKIE_SECRET,
    },
  },
  admin: {
    disable: process.env.DISABLE_MEDUSA_ADMIN
      ? process.env.DISABLE_MEDUSA_ADMIN === "true"
      : process.env.MEDUSA_WORKER_MODE === "worker",
  },
  modules: [
    ...redisModules,
    {
      resolve: "@medusajs/medusa/payment",
      options: {
        providers: [
          {
            resolve: "./src/modules/debitopay",
            id: "debitopay",
            options: {
              apiKey: process.env.DEBITOPAY_API_KEY!,
              merchantId: process.env.DEBITOPAY_MERCHANT_ID!,
              walletCode: process.env.DEBITOPAY_WALLET_CODE!,
              baseUrl: process.env.DEBITOPAY_API_BASE_URL,
              paymentEndpoint: process.env.DEBITOPAY_PAYMENT_ENDPOINT,
              webhookSecret: process.env.DEBITOPAY_WEBHOOK_SECRET,
              returnUrl: process.env.DEBITOPAY_RETURN_URL,
            },
          },
        ],
      },
    },
  ],
})
