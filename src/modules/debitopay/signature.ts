import crypto from "node:crypto"

export type SignatureVerification = {
  valid: boolean
  formatValid: boolean
  mode: string | null
}

export function getRawBodyBytes(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return value
  if (typeof value === "string") return Buffer.from(value, "utf8")
  if (value instanceof Uint8Array) return Buffer.from(value)
  return null
}

function normalizeSignature(value: string): string | null {
  const trimmed = value.trim()
  const digest = trimmed.replace(/^sha256=/i, "")
  return /^[a-f0-9]{64}$/i.test(digest) ? digest.toLowerCase() : null
}

function getSigningKeys(secret: string): { key: Buffer | string; mode: string }[] {
  const trimmed = secret.trim()
  const candidates: { key: Buffer | string; mode: string }[] = [
    { key: trimmed, mode: "utf8-secret" },
  ]

  // Decode only unambiguous encodings; never log these candidates or their values.
  if (/^(?:[a-f0-9]{2})+$/i.test(trimmed)) {
    candidates.push({ key: Buffer.from(trimmed, "hex"), mode: "hex-decoded-secret" })
  }
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed) && trimmed.length % 4 === 0) {
    const decoded = Buffer.from(trimmed, "base64")
    if (decoded.length > 0 && decoded.toString("base64") === trimmed) {
      candidates.push({ key: decoded, mode: "base64-decoded-secret" })
    }
  }
  return candidates
}

/**
 * Verify the documented Debito Pay HMAC-SHA256 signature using the original
 * request bytes first. Compatibility candidates are limited to unambiguous
 * secret encodings and JSON serialization; the check never accepts an
 * unsigned request.
 */
export function verifyDebitoPaySignature(
  rawBody: Buffer,
  signature: string,
  secret: string
): SignatureVerification {
  const normalized = normalizeSignature(signature)
  if (!normalized) {
    return { valid: false, formatValid: false, mode: null }
  }

  const bodies: { body: Buffer; mode: string }[] = [
    { body: rawBody, mode: "raw-body" },
  ]

  try {
    const parsed = JSON.parse(rawBody.toString("utf8"))
    const serialized = Buffer.from(JSON.stringify(parsed), "utf8")
    if (!serialized.equals(rawBody)) {
      bodies.push({ body: serialized, mode: "serialized-json" })
    }
  } catch {
    // Non-JSON bodies can still be verified against the original bytes.
  }

  for (const candidate of getSigningKeys(secret)) {
    for (const body of bodies) {
      const expected = crypto.createHmac("sha256", candidate.key).update(body.body).digest()
      const received = Buffer.from(normalized, "hex")
      if (received.length === expected.length && crypto.timingSafeEqual(expected, received)) {
        return {
          valid: true,
          formatValid: true,
          mode: `${body.mode}+${candidate.mode}`,
        }
      }
    }
  }

  return { valid: false, formatValid: true, mode: null }
}
