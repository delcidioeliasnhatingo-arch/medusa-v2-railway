#!/usr/bin/env node
"use strict";

// One-time AVEART admin password repair for the Medusa emailpass identity.
// Never print the password or its derived hash.
const { createRequire } = require("node:module");
const runtimeRequire = createRequire("/app/.medusa/server/package.json");
const { Client } = runtimeRequire("pg");
const Scrypt = runtimeRequire("scrypt-kdf");

const email = (process.env.MEDUSA_ADMIN_EMAIL || "").trim().toLowerCase();
const password = process.env.MEDUSA_ADMIN_PASSWORD;
const marker = "aveart_admin_password_bootstrap_v1";

async function main() {
  if (process.env.AVEART_RESET_ADMIN_PASSWORD !== "true") {
    console.log("[admin-reset] disabled; skipping");
    return;
  }
  if (!process.env.DATABASE_URL || !email || !password) {
    throw new Error("Required admin reset configuration is missing");
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    await client.query("BEGIN");
    const found = await client.query(
      `SELECT u.id AS user_id, u.metadata, pi.id AS provider_identity_id
         FROM public."user" u
         JOIN public.provider_identity pi
           ON lower(pi.entity_id) = lower(u.email)
          AND pi.provider = 'emailpass'
          AND pi.deleted_at IS NULL
         JOIN public.auth_identity ai
           ON ai.id = pi.auth_identity_id
          AND ai.deleted_at IS NULL
        WHERE lower(u.email) = $1
          AND u.deleted_at IS NULL
        FOR UPDATE OF u, pi`,
      [email]
    );

    if (found.rowCount === 0) {
      await client.query("ROLLBACK");
      console.log("[admin-reset] existing admin identity not found; normal bootstrap may create it");
      return;
    }

    const user = found.rows[0];
    if (user.metadata && user.metadata[marker] === true) {
      await client.query("COMMIT");
      console.log("[admin-reset] one-time password repair already completed");
      return;
    }

    const derived = await Scrypt.kdf(password, { logN: 15, r: 8, p: 1 });
    const encoded = Buffer.from(derived).toString("base64");

    await client.query(
      `UPDATE public.provider_identity
          SET provider_metadata = jsonb_set(
                COALESCE(provider_metadata, '{}'::jsonb),
                '{password}', to_jsonb($1::text), true
              ),
              updated_at = now()
        WHERE id = $2`,
      [encoded, user.provider_identity_id]
    );

    await client.query(
      `UPDATE public."user"
          SET metadata = jsonb_set(
                COALESCE(metadata, '{}'::jsonb),
                $1::text[], 'true'::jsonb, true
              ),
              updated_at = now()
        WHERE id = $2`,
      [[marker], user.user_id]
    );

    const check = await client.query(
      "SELECT provider_metadata->>'password' AS password_hash FROM public.provider_identity WHERE id = $1",
      [user.provider_identity_id]
    );
    const valid = await Scrypt.verify(Buffer.from(check.rows[0].password_hash, "base64"), password);
    if (!valid) throw new Error("Stored password verification failed");

    await client.query("COMMIT");
    console.log("[admin-reset] existing admin password repaired and verified");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("[admin-reset] failed:", error && error.message ? error.message : "unknown error");
  process.exitCode = 1;
});
