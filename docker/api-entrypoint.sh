#!/bin/sh
# API container entrypoint.
#
# Postgres init scripts (docker/postgres-init) only run on a *fresh* data
# volume. On a redeploy onto an existing volume — or any environment where the
# storefront DB was never created — smmta_store would be missing and the
# storefront's own migrations would never run. This entrypoint makes the whole
# thing self-heal on every boot, idempotently:
#
#   1. Ensure the storefront database (smmta_store) exists.
#   2. Migrate the operational DB (smmta_next).
#   3. Migrate the storefront DB (smmta_store) with its own drizzle schema.
#   4. Boot the API.
#
# All steps are safe to run repeatedly. DATABASE_URL points at smmta_next;
# STORE_DATABASE_URL (optional) points at smmta_store.
set -e

if [ -n "$STORE_DATABASE_URL" ]; then
  # CREATE DATABASE cannot run inside a transaction, and IF NOT EXISTS isn't
  # supported, so guard with a catalogue lookup. Connect via DATABASE_URL
  # (smmta_next); the new DB inherits the connecting role as owner.
  if [ "$(psql "$DATABASE_URL" -tAc "SELECT 1 FROM pg_database WHERE datname = 'smmta_store'")" != "1" ]; then
    echo "[entrypoint] creating database smmta_store"
    psql "$DATABASE_URL" -c "CREATE DATABASE smmta_store"
  else
    echo "[entrypoint] database smmta_store already exists"
  fi
fi

echo "[entrypoint] migrating smmta_next"
( cd /app/apps/api && npx drizzle-kit migrate )

if [ -n "$STORE_DATABASE_URL" ]; then
  echo "[entrypoint] migrating smmta_store"
  ( cd /app/apps/store && DATABASE_URL="$STORE_DATABASE_URL" npx drizzle-kit migrate )
fi

echo "[entrypoint] starting API"
cd /app/apps/api
exec env HOST=0.0.0.0 npx tsx src/server.ts
