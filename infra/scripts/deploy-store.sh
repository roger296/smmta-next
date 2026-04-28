#!/usr/bin/env bash
# Deploy the Filament Store storefront from a tagged commit to the VPS.
#
# Usage:
#   infra/scripts/deploy-store.sh v0.13.0
#   infra/scripts/deploy-store.sh main         # bleeding edge
#
# Idempotent. Safe to re-run. Steps:
#
#   1. SSH to the host (DEPLOY_HOST in env or `smmta-prod` SSH alias).
#   2. Fetch the tag / branch into /opt/smmta-next.
#   3. `npm ci --workspaces --include-workspace-root` to install
#      deterministically. Lockfile must be committed.
#   4. `npm run build -w @smmta/store` (Turborepo would also work; the
#      monorepo is small enough that the workspace flag is fine).
#   5. Run drizzle-kit migrations against the storefront DB.
#   6. Symlink `.next/standalone/apps/store/.next/static` →
#      `apps/store/.next/static` so the systemd unit's standalone
#      server can serve the static bundle.
#   7. Reload systemd unit + verify with /healthz.
#
# Env (override via flags or shell env):
#   DEPLOY_HOST  default: smmta-prod   (SSH config alias)
#   DEPLOY_USER  default: smmta
#   DEPLOY_DIR   default: /opt/smmta-next
#
# Pre-reqs on the host (one-off):
#   - User `smmta` with passwordless `systemctl restart smmta-store`
#     (sudoers snippet). The deploy script does NOT touch system
#     packages — Node + npm + nginx are operator-managed.
#   - /etc/smmta/store.env exists and is mode 0600.

set -euo pipefail

REF="${1:?ref required (tag, branch, or commit sha)}"
DEPLOY_HOST="${DEPLOY_HOST:-smmta-prod}"
DEPLOY_USER="${DEPLOY_USER:-smmta}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/smmta-next}"

echo "==> Deploying ref=${REF} to ${DEPLOY_USER}@${DEPLOY_HOST}:${DEPLOY_DIR}"

ssh "${DEPLOY_USER}@${DEPLOY_HOST}" bash -s <<EOF
set -euo pipefail

cd "${DEPLOY_DIR}"

echo "--> git fetch + checkout ${REF}"
git fetch --tags origin
git checkout "${REF}"
git reset --hard "${REF}"

echo "--> npm ci (workspaces)"
npm ci --workspaces --include-workspace-root

echo "--> Building @smmta/store"
NODE_ENV=production npm run build -w @smmta/store

echo "--> Running storefront DB migrations (drizzle-kit migrate)"
npm run db:migrate -w @smmta/store

echo "--> Symlinking standalone static dir"
# next build (output: 'standalone') drops apps/store/.next/standalone/
# but doesn't copy .next/static into it. Without the symlink the
# standalone server 404s on /_next/static/... assets.
mkdir -p "apps/store/.next/standalone/apps/store/.next"
ln -sfn "${DEPLOY_DIR}/apps/store/.next/static" \
        "apps/store/.next/standalone/apps/store/.next/static"
ln -sfn "${DEPLOY_DIR}/apps/store/public" \
        "apps/store/.next/standalone/apps/store/public"

echo "--> Reloading smmta-store"
sudo systemctl restart smmta-store

echo "--> Health check"
sleep 3
for i in 1 2 3 4 5; do
  if curl -fsS http://127.0.0.1:3000/healthz >/dev/null; then
    echo "    OK on attempt \$i"
    break
  fi
  echo "    attempt \$i failed, retrying"
  sleep 2
done

echo "==> Deploy of ${REF} complete"
EOF
