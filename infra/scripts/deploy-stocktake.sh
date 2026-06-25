#!/usr/bin/env bash
#
# Deploy / update the standalone stock-take-lite PWA (P26).
#
# Run this ON the server (as the smmta user). Idempotent — safe to re-run for
# every update. The one-off setup (DNS, nginx site, certbot TLS, the API systemd
# unit) is in docs/runbooks/stocktake-deploy.md and only needs doing once.
#
# It is topology-aware via env vars, so it works both for a dedicated box and for
# the side-by-side install alongside Filament Store (separate clone, separate DB,
# separate API service on its own port):
#
#   # dedicated box (API is the main smmta-api in ~/smmta-next):
#   ~/smmta-next/infra/scripts/deploy-stocktake.sh autostock
#
#   # side-by-side with Filament (second API "autostock-api" in ~/auto-stock):
#   SMMTA_REPO_DIR=~/auto-stock STOCKTAKE_API_SERVICE=autostock-api \
#     ~/auto-stock/infra/scripts/deploy-stocktake.sh autostock
#
# Env (all optional):
#   SMMTA_REPO_DIR          repo checkout to deploy from   (default: ~/smmta-next)
#   STOCKTAKE_API_SERVICE   systemd unit to restart        (default: smmta-api)
#   STOCKTAKE_WEB_ROOT      where the static bundle is served from
#                                                          (default: /var/www/stocktake-web)
#   STOCKTAKE_API_PORT      health-check port              (default: 3000)
set -euo pipefail

REPO_DIR="${SMMTA_REPO_DIR:-$HOME/smmta-next}"
API_SERVICE="${STOCKTAKE_API_SERVICE:-smmta-api}"
WEB_ROOT="${STOCKTAKE_WEB_ROOT:-/var/www/stocktake-web}"
API_PORT="${STOCKTAKE_API_PORT:-3000}"
REF="${1:-}"

cd "${REPO_DIR}"
echo "==> Stock-take-lite deploy from ${REPO_DIR} (service ${API_SERVICE}, port ${API_PORT})"

if [[ -n "${REF}" ]]; then
  echo "--> git fetch + checkout ${REF}"
  git fetch --all --tags --prune
  git checkout "${REF}"
  git pull --ff-only origin "${REF}"
else
  REF="$(git rev-parse --abbrev-ref HEAD)"
  echo "--> git pull (current branch: ${REF})"
  git pull --ff-only origin "${REF}"
fi

echo "--> npm install (workspaces)"
npm install --no-audit --no-fund

echo "--> Building @smmta/shared-types (the API imports it)"
npm run build -w @smmta/shared-types

# Migrate using the DB URL from the API's OWN .env, never drizzle's dev default —
# critical when this clone points at an isolated database (e.g. `autostock`).
if [[ ! -f apps/api/.env ]]; then
  echo "ERROR: apps/api/.env not found in ${REPO_DIR}." >&2
  exit 1
fi
if ! grep -q '^STOCKTAKE_ACCESS_CODE=..*' apps/api/.env; then
  echo "ERROR: STOCKTAKE_ACCESS_CODE not set in apps/api/.env (demo would be open)." >&2
  exit 1
fi
echo "--> Applying DB migrations"
( cd apps/api && DATABASE_URL="$(grep -oP '^DATABASE_URL=\K.*' .env)" npx drizzle-kit migrate )

echo "--> Restarting ${API_SERVICE}"
sudo systemctl restart "${API_SERVICE}"
sleep 3
curl -fsS "http://127.0.0.1:${API_PORT}/health" >/dev/null && echo "    API healthy on :${API_PORT}"

echo "--> Building @smmta/stocktake"
npm run build -w @smmta/stocktake

echo "--> Publishing to ${WEB_ROOT}"
sudo mkdir -p "${WEB_ROOT}"
sudo rm -rf "${WEB_ROOT:?}/"*
sudo cp -r apps/stocktake/dist/* "${WEB_ROOT}/"
sudo chown -R www-data:www-data "${WEB_ROOT}"

echo "--> Reloading nginx"
sudo nginx -t && sudo systemctl reload nginx

echo "==> Stock-take-lite deploy complete (${REF})."
