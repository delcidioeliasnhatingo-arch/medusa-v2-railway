#!/bin/sh
# Medusa v2 entrypoint for a single server or a separate worker.
set -eu

MODE="${MEDUSA_WORKER_MODE:-shared}"
export MEDUSA_WORKER_MODE="$MODE"
cd /app/.medusa/server

echo "[start] worker mode: ${MODE}"

# Wait for PostgreSQL before applying migrations or starting the API.
i=0
until node -e '
const { Client } = require("pg");
const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
c.connect().then(() => c.end()).then(() => process.exit(0)).catch(() => process.exit(1));
' 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then
    echo "[start] PostgreSQL not reachable after 5 minutes; failing." >&2
    exit 1
  fi
  sleep 5
done
echo "[start] PostgreSQL reachable"

if [ "${MIGRATE_ON_BOOT:-true}" = "true" ] && [ "$MODE" != "worker" ]; then
  echo "[start] running Medusa migrations..."
  npm run predeploy
  echo "[start] migrations complete"
fi

if [ "$MODE" = "worker" ]; then
  i=0
  until node -e '
const { Client } = require("pg");
const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
c.connect()
  .then(() => c.query("SELECT to_regclass(\'public.payment_provider\') IS NOT NULL AS ok"))
  .then((r) => { const ok = r.rows[0] && r.rows[0].ok; return c.end().then(() => process.exit(ok ? 0 : 1)); })
  .catch(() => process.exit(1));
' 2>/dev/null; do
    i=$((i + 1))
    if [ "$i" -ge 60 ]; then
      echo "[start] Medusa schema not ready after 5 minutes; failing." >&2
      exit 1
    fi
    sleep 5
  done
fi

ADMIN_EMAIL="${MEDUSA_ADMIN_EMAIL:-delcidioeliasnhatingo@gmail.com}"
if [ "$MODE" != "worker" ] && [ -n "${MEDUSA_ADMIN_PASSWORD:-}" ]; then
  echo "[start] ensuring admin user exists for ${ADMIN_EMAIL}..."
  npx --no-install medusa user -e "$ADMIN_EMAIL" -p "$MEDUSA_ADMIN_PASSWORD" \
    || echo "[start] admin user was not created (it may already exist); continuing"
fi

echo "[start] starting Medusa..."
exec npm run start
