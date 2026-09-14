#!/bin/sh
# API container entrypoint.
#
# Postgres init scripts (docker/postgres-init) only run on a *fresh* data
# volume. On a redeploy onto an existing volume — or any environment where the
# storefront DB was never created — smmta_store would be missing and the
# storefront's own migrations would never run. This entrypoint makes the whole
# thing self-heal on every boot, idempotently:
#
#   1. Ensure the storefront databases (smmta_store, smmta_store_clothes) exist.
#   2. Migrate the operational DB (smmta_next).
#   3. Migrate each storefront DB with its own app's drizzle schema.
#   4. Boot the API.
#
# All steps are safe to run repeatedly. DATABASE_URL points at smmta_next;
# STORE_DATABASE_URL (optional) points at smmta_store, and
# CLOTHES_STORE_DATABASE_URL (optional) at the Clothes Shop's smmta_store_clothes.
set -e

# CREATE DATABASE cannot run inside a transaction, and IF NOT EXISTS isn't
# supported, so guard with a catalogue lookup. Connect via DATABASE_URL
# (smmta_next); the new DB inherits the connecting role as owner.
ensure_database() {
  if [ "$(psql "$DATABASE_URL" -tAc "SELECT 1 FROM pg_database WHERE datname = '$1'")" != "1" ]; then
    echo "[entrypoint] creating database $1"
    psql "$DATABASE_URL" -c "CREATE DATABASE $1"
  else
    echo "[entrypoint] database $1 already exists"
  fi
}

[ -n "$STORE_DATABASE_URL" ] && ensure_database smmta_store
[ -n "$CLOTHES_STORE_DATABASE_URL" ] && ensure_database smmta_store_clothes

echo "[entrypoint] migrating smmta_next"
( cd /app/apps/api && npx drizzle-kit migrate )

if [ -n "$STORE_DATABASE_URL" ]; then
  echo "[entrypoint] migrating smmta_store"
  ( cd /app/apps/store && DATABASE_URL="$STORE_DATABASE_URL" npx drizzle-kit migrate )
fi

if [ -n "$CLOTHES_STORE_DATABASE_URL" ]; then
  echo "[entrypoint] migrating smmta_store_clothes"
  ( cd /app/apps/store-clothes && DATABASE_URL="$CLOTHES_STORE_DATABASE_URL" npx drizzle-kit migrate )
fi

echo "[entrypoint] starting API"
cd /app/apps/api
exec env HOST=0.0.0.0 npx tsx src/server.ts
