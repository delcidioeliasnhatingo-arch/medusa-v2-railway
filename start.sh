#!/bin/sh
# Medusa v2 container entrypoint for the AVEART backend.
set -e

MODE="${MEDUSA_WORKER_MODE:-shared}"
export MEDUSA_WORKER_MODE="$MODE"
cd /app/.medusa/server

echo "[start] worker mode: ${MODE}"

# Wait for Neon/Postgres before migrations or auth bootstrap.
i=0
until node -e "
const { Client } = require('pg');
const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
c.connect().then(() => c.end()).then(() => process.exit(0)).catch(() => process.exit(1));
" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then
    echo "[start] Postgres not reachable after 5 minutes — failing." >&2
    exit 1
  fi
  sleep 5
done
echo "[start] Postgres reachable"

if [ "${MIGRATE_ON_BOOT:-true}" = "true" ] && [ "${MODE}" != "worker" ]; then
  echo "[start] running migrations..."
  npx --no-install medusa db:migrate
  echo "[start] migrations complete"
fi

# Explicit, one-time repair for an existing emailpass admin identity.
# This is gated by a Preview-only env flag and marks the user after verification.
if [ "${MODE}" != "worker" ] && [ "${AVEART_RESET_ADMIN_PASSWORD:-false}" = "true" ]; then
  node /app/reset-admin-password.cjs
fi

if [ "${MODE}" != "worker" ] && [ -n "${MEDUSA_ADMIN_PASSWORD:-}" ]; then
  ADMIN_EMAIL="${MEDUSA_ADMIN_EMAIL:-admin@example.com}"
  echo "[start] ensuring admin user exists..."
  npx --no-install medusa user -e "$ADMIN_EMAIL" -p "$MEDUSA_ADMIN_PASSWORD" \
    || echo "[start] admin creation skipped (identity may already exist)"
fi

echo "[start] starting Medusa..."
exec npm run start
