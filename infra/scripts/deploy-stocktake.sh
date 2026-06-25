#!/usr/bin/env bash
#
# Deploy / update the standalone stock-take-lite PWA (P26) on the Auto-Stock VPS.
#
# Run this ON the VPS (as the smmta user). It is idempotent — safe to re-run for
# every update. The one-off setup (DNS A record, nginx site, certbot TLS) is in
# docs/runbooks/stocktake-deploy.md and only needs doing once; after that, a
# deploy is just:
#
#   ~/smmta-next/infra/scripts/deploy-stocktake.sh [git-ref]
#
# git-ref defaults to the current branch. Pass e.g. `autostock` to track that
# branch, or a tag.
#
# Pre-reqs (one-off, see the runbook):
#   - The Auto-Stock API is already deployed + running (systemd: smmta-api).
#   - STOCKTAKE_ACCESS_CODE is set in apps/api/.env (this script refuses to
#     deploy without it, so the demo isn't left open on a public URL).
#   - /var/www/stocktake-web exists and is writable via sudo.
#   - nginx site for the stock-take host is enabled (see the runbook).
set -euo pipefail

REPO_DIR="${SMMTA_REPO_DIR:-$HOME/smmta-next}"
WEB_ROOT="${STOCKTAKE_WEB_ROOT:-/var/www/stocktake-web}"
REF="${1:-}"

cd "${REPO_DIR}"

echo "==> Stock-take-lite deploy from ${REPO_DIR}"

if [[ -n "${REF}" ]]; then
  echo "--> git fetch + checkout ${REF}"
  git fetch --all --tags --prune
  git checkout "${REF}"
  git pull --ff-only origin "${REF}" || true
else
  REF="$(git rev-parse --abbrev-ref HEAD)"
  echo "--> git pull (current branch: ${REF})"
  git pull --ff-only origin "${REF}"
fi

echo "--> npm install (workspaces)"
npm install --no-audit --no-fund

# --- API side: apply the migration + restart so the new routes are live ------
echo "--> Applying DB migrations (drizzle-kit migrate)"
( cd apps/api && npx drizzle-kit migrate )

if ! grep -q '^STOCKTAKE_ACCESS_CODE=..*' apps/api/.env 2>/dev/null; then
  echo "ERROR: STOCKTAKE_ACCESS_CODE is not set in apps/api/.env." >&2
  echo "       Add a line like: STOCKTAKE_ACCESS_CODE=<some-shared-code>" >&2
  echo "       (without it the demo API is open to anyone with the URL)." >&2
  exit 1
fi

echo "--> Restarting smmta-api"
sudo systemctl restart smmta-api
sleep 3
curl -fsS http://127.0.0.1:3000/health >/dev/null && echo "    API healthy"

# --- PWA side: build + publish the static bundle -----------------------------
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
echo "    Counters:    https://<your-stocktake-host>/"
echo "    Head office: https://<your-stocktake-host>/#/consolidate"
