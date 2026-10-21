import { loadEnv, defineConfig } from '@medusajs/framework/utils'

loadEnv(process.env.NODE_ENV || 'development', process.cwd())

/**
 * Railway's internal Redis proxy resolves to an IPv6 address. ioredis dials
 * IPv6 first and can silently hang when the host only answers on IPv4.
 * Appending `family=0` makes Node try both families (Happy Eyeballs), which
 * is the reliable default on Railway. Idempotent: existing `family=` wins.
 */
const normalizeRedisUrl = (url?: string): string | undefined => {
  if (!url) return url
  if (/([?&])family=/.test(url)) return url
  return url + (url.includes('?') ? '&' : '?') + 'family=0'
}

const redisUrl = normalizeRedisUrl(process.env.REDIS_URL)

// Production modules (event bus, workflow engine, cache, locks) all run on
// Redis so that a `server` deployment and a `worker` deployment share events
// and state. Without REDIS_URL (local dev) Medusa falls back to the in-memory
// defaults, so `npm run dev` works with no extra services.
const redisModules = redisUrl
  ? [
      {
        resolve: '@medusajs/medusa/event-bus-redis',
        options: { redisUrl },
      },
      {
        resolve: '@medusajs/medusa/workflow-engine-redis',
        options: {
          redis: { redisUrl },
        },
      },
      {
        resolve: '@medusajs/medusa/caching',
        options: {
          providers: [
            {
              resolve: '@medusajs/caching-redis',
              id: 'caching-redis',
              is_default: true,
              options: { redisUrl },
            },
          ],
        },
      },
      {
        resolve: '@medusajs/medusa/locking',
        options: {
          providers: [
            {
              resolve: '@medusajs/medusa/locking',
              id: 'locking-redis',
              is_default: true,
              options: { redisUrl },
            },
          ],
        },
      },
    ]
  : []

const sessionLifetimeMs = 24 * 60 * 60 * 1000

module.exports = defineConfig({
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    redisUrl,
    workerMode: process.env.MEDUSA_WORKER_MODE as 'shared' | 'server' | 'worker',
    // Keep admin sessions valid for 24 hours.
    sessionOptions: {
      ttl: sessionLifetimeMs,
      rolling: true,
      resave: true,
      saveUninitialized: true,
    },
    cookieOptions: {
      maxAge: sessionLifetimeMs,
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'none',
    },
    http: {
      // Defaults keep local dev and zero-config deploys working; set STORE_CORS
      // to your storefront origin(s) in production.
      storeCors: process.env.STORE_CORS || 'http://localhost:3000,http://localhost:8000',
      adminCors: process.env.ADMIN_CORS!,
      authCors: process.env.AUTH_CORS!,
      jwtSecret: process.env.JWT_SECRET,
      cookieSecret: process.env.COOKIE_SECRET,
    },
  },
  admin: {
    // The worker never serves or builds the admin. DISABLE_MEDUSA_ADMIN wins
    // when set; otherwise it is derived from MEDUSA_WORKER_MODE.
    disable: process.env.DISABLE_MEDUSA_ADMIN
      ? process.env.DISABLE_MEDUSA_ADMIN === 'true'
      : process.env.MEDUSA_WORKER_MODE === 'worker',
    backendUrl: process.env.MEDUSA_BACKEND_URL || undefined,
  },
  modules: [
    ...redisModules,
    // Register DebitoPay only after real merchant credentials are supplied.
    // This lets the backend boot safely before payment onboarding is complete.
    ...(process.env.DEBITOPAY_API_KEY &&
      process.env.DEBITOPAY_MERCHANT_ID &&
      process.env.DEBITOPAY_WALLET_CODE
      ? [
          {
            resolve: "@medusajs/medusa/payment",
            options: {
              providers: [
                {
                  resolve: "./src/modules/debitopay",
                  id: "debitopay",
                  options: {
                    apiKey: process.env.DEBITOPAY_API_KEY,
                    merchantId: process.env.DEBITOPAY_MERCHANT_ID,
                    walletCode: process.env.DEBITOPAY_WALLET_CODE,
                    baseUrl: process.env.DEBITOPAY_API_BASE_URL,
                    paymentEndpoint: process.env.DEBITOPAY_PAYMENT_ENDPOINT,
                    webhookSecret: process.env.DEBITOPAY_WEBHOOK_SECRET,
                    returnUrl: process.env.DEBITOPAY_RETURN_URL,
                  },
                },
              ],
            },
          },
        ]
      : []),
  ],
})
