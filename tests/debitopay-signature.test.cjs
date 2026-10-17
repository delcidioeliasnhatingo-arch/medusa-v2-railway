const test = require("node:test")
const assert = require("node:assert/strict")
const crypto = require("node:crypto")
const { verifyDebitoPaySignature } = require("../src/modules/debitopay/signature.ts")

const secret = "test-webhook-secret"
const body = Buffer.from(
  JSON.stringify({
    event: "payment.completed",
    data: {
      payment_id: "test-payment-123",
      amount: 150,
      currency: "MZN",
    },
    timestamp: "2026-10-17T10:00:00.000Z",
  }),
  "utf8"
)

function sign(payload, key = secret) {
  return crypto.createHmac("sha256", key).update(payload).digest("hex")
}

test("accepts a valid HMAC-SHA256 signature over original bytes", () => {
  const result = verifyDebitoPaySignature(body, sign(body), secret)
  assert.equal(result.valid, true)
  assert.equal(result.mode, "raw-body+utf8-secret")
})

test("accepts the documented sha256= signature prefix", () => {
  const result = verifyDebitoPaySignature(body, `sha256=${sign(body)}`, secret)
  assert.equal(result.valid, true)
})

test("rejects a signature generated with a different secret", () => {
  const result = verifyDebitoPaySignature(body, sign(body, "wrong-secret"), secret)
  assert.equal(result.valid, false)
})

test("rejects a modified request body", () => {
  const altered = Buffer.from(body.toString("utf8") + " ", "utf8")
  const result = verifyDebitoPaySignature(altered, sign(body), secret)
  assert.equal(result.valid, false)
})

test("rejects malformed and missing signatures", () => {
  assert.equal(verifyDebitoPaySignature(body, "not-a-signature", secret).valid, false)
  assert.equal(verifyDebitoPaySignature(body, "", secret).valid, false)
})

test("accepts JSON reserialization only when it reproduces the signed canonical JSON", () => {
  const spacedBody = Buffer.from(
    '{ "event" : "payment.completed", "data" : { "payment_id" : "test-payment-123", "amount" : 150, "currency" : "MZN" }, "timestamp" : "2026-10-17T10:00:00.000Z" }',
    "utf8"
  )
  const canonical = Buffer.from(JSON.stringify(JSON.parse(spacedBody.toString("utf8"))), "utf8")
  const result = verifyDebitoPaySignature(spacedBody, sign(canonical), secret)
  assert.equal(result.valid, true)
  assert.equal(result.mode, "serialized-json+utf8-secret")
})
