#!/usr/bin/env bash
#
# Auto-Stock installer (P24, spec §A11) — the Big Bakes fork of smmta-next.
#
# Provisions Docker + nginx + certbot + Node 22 + Postgres-in-Docker and deploys
# ONLY the stock platform: apps/api (REST + MCP server) + apps/web (admin SPA +
# iPad PWA). The Next.js storefronts (apps/store, apps/store-clothes) stay
# DORMANT — they are not built, deployed, or served here. Mollie / SendGrid are
# likewise not provisioned.
#
# Adds systemd timers for the four periodic jobs (mirroring the supplier-poll
# timer pattern): the auto-reorder daily sweep, the daily COGS/wastage Xero
# sweep, the Square decrement poll, and the BumbleBee session poll.
#
# All OPERATIONAL setup is UI-driven (sites, recipes, reorder/par levels,
# suppliers + ordering channel, Xero account/tax map, Square-item map) via the
# admin SPA — NOT env. Only secrets + hostnames live in apps/api/.env.
#
# Non-interactive example:
#   sudo SMMTA_NONINTERACTIVE=1 \
#        SMMTA_BUSINESS_NAME="Big Bakes" \
#        SMMTA_ADMIN_HOST=hippo.starship.thebigbakes.com \
#        SMMTA_ADMIN_EMAIL=admin@thebigbakes.com \
#        SMMTA_ADMIN_PASSWORD='change-me' \
#        SMMTA_LE_EMAIL=admin@thebigbakes.com \
#        bash infra/install-autostock.sh
#
# Dry-run (prints the plan, changes nothing):
#   bash infra/install-autostock.sh --dry-run
set -euo pipefail

SMMTA_USER="${SMMTA_USER:-smmta}"
SMMTA_HOME="/home/${SMMTA_USER}"
REPO_DIR="${SMMTA_HOME}/smmta-next"
REPO_URL="${SMMTA_REPO_URL:-https://github.com/roger296/smmta-next.git}"
NODE_MAJOR="${SMMTA_NODE_MAJOR:-22}"

# The four periodic jobs Auto-Stock installs (name → tsx script).
AUTOSTOCK_TIMERS=(
  "smmta-reorder-sweep"
  "smmta-consumption-sweep"
  "smmta-square-poll"
  "smmta-bumblebee-poll"
)

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

print_plan() {
  log "Auto-Stock install plan"
  info "PLAN: deploy apps/api (REST API + MCP server at /mcp)"
  info "PLAN: deploy apps/web (admin SPA + iPad PWA)"
  info "PLAN: NOT deploying apps/store / apps/store-clothes (storefront stays dormant)"
  info "PLAN: NOT provisioning Mollie / SendGrid (dormant)"
  info "PLAN: systemd service smmta-api.service"
  for t in "${AUTOSTOCK_TIMERS[@]}"; do
    info "PLAN: systemd timer ${t}.timer"
  done
  info "PLAN: apps/api/.env — XERO_DRY_RUN=true (read-only Xero until go-live)"
  info "PLAN: apps/api/.env — FEATURE_MARKETPLACE=false, FEATURE_CONVERSATIONAL_SEARCH=false"
  info "PLAN: apps/api/.env — CATALOGUE_SYNC=false, MATERIALS_COST_SYNC=false (dry-run BumbleBee push)"
  info "PLAN: operational setup is UI-driven (sites / recipes / reorder / suppliers / Xero map / Square map)"
}

# --- dry-run: print the plan and exit without touching the system ------------
if [[ "${1:-}" == "--dry-run" || "${SMMTA_DRY_RUN:-0}" == "1" ]]; then
  print_plan
  log "Dry-run only — no changes made."
  exit 0
fi

[[ "$(id -u)" -eq 0 ]] || die "Run as root (sudo)."
print_plan

# --- base packages -----------------------------------------------------------
install_packages() {
  log "Installing base packages (docker, nginx, certbot)"
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg nginx certbot python3-certbot-nginx uuid-runtime
  if ! command -v docker >/dev/null 2>&1; then
    curl -fsSL https://get.docker.com | sh
  fi
  systemctl enable --now docker
  systemctl enable --now nginx
}

create_user() {
  if ! id -u "${SMMTA_USER}" >/dev/null 2>&1; then
    log "Creating system user ${SMMTA_USER}"
    useradd -m -s /bin/bash "${SMMTA_USER}"
  fi
  usermod -aG docker "${SMMTA_USER}" || true
}

install_node() {
  log "Installing Node ${NODE_MAJOR}.x via NVM (under ${SMMTA_USER})"
  sudo -u "${SMMTA_USER}" bash -lc '[ -d "$HOME/.nvm" ] || curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash'
  sudo -u "${SMMTA_USER}" bash -lc \
    "export NVM_DIR=\"${SMMTA_HOME}/.nvm\" && . \$NVM_DIR/nvm.sh && nvm install ${NODE_MAJOR} \
     && ln -sfn \"\$(nvm version)\" \"${SMMTA_HOME}/.nvm/versions/node/current\""
  SMMTA_NODE_BIN="$(sudo -u "${SMMTA_USER}" bash -lc "readlink -f ${SMMTA_HOME}/.nvm/versions/node/current/bin/node")"
}

clone_and_build() {
  log "Cloning + building (api + web only — NOT the storefront)"
  if [[ ! -d "${REPO_DIR}/.git" ]]; then
    sudo -u "${SMMTA_USER}" git clone --quiet "${REPO_URL}" "${REPO_DIR}"
  fi
  sudo -u "${SMMTA_USER}" bash -lc "cd ${REPO_DIR} && npm install --no-audit --no-fund"
  sudo -u "${SMMTA_USER}" bash -lc "cd ${REPO_DIR} && npm run build -w @smmta/shared-types"
  sudo -u "${SMMTA_USER}" bash -lc "cd ${REPO_DIR} && npm run build -w @smmta/api"
  sudo -u "${SMMTA_USER}" bash -lc "cd ${REPO_DIR} && npm run build -w @smmta/web"
  # NOTE: @smmta/store is deliberately NOT built — the storefront is dormant.
}

write_api_env() {
  log "Writing apps/api/.env (secrets + hostnames only; setup is UI-driven)"
  local jwt db company
  jwt="$(openssl rand -hex 32)"
  db="$(openssl rand -hex 24)"
  company="$(uuidgen)"
  install -m 0600 -o "${SMMTA_USER}" -g "${SMMTA_USER}" /dev/null "${REPO_DIR}/apps/api/.env"
  cat >"${REPO_DIR}/apps/api/.env" <<EOF
NODE_ENV=production
PORT=3000
HOST=127.0.0.1
DATABASE_URL=postgresql://smmta:${db}@127.0.0.1:5432/smmta_next
JWT_SECRET=${jwt}
COMPANY_ID=${company}
# Dormant subsystems OFF; Xero read-only until go-live (flip XERO_DRY_RUN=false).
GL_PROVIDER=xero
XERO_DRY_RUN=true
FEATURE_MARKETPLACE=false
FEATURE_CONVERSATIONAL_SEARCH=false
CATALOGUE_SYNC=false
MATERIALS_COST_SYNC=false
EOF
  chown "${SMMTA_USER}:${SMMTA_USER}" "${REPO_DIR}/apps/api/.env"
}

install_systemd() {
  log "Installing systemd units — smmta-api + the four Auto-Stock timers"
  local tmpl unit
  for base in smmta-api "${AUTOSTOCK_TIMERS[@]}"; do
    for ext in service timer; do
      tmpl="${REPO_DIR}/infra/systemd/${base}.${ext}.template"
      [[ -f "${tmpl}" ]] || continue
      unit="/etc/systemd/system/${base}.${ext}"
      sed -e "s|__SMMTA_USER__|${SMMTA_USER}|g" \
          -e "s|__SMMTA_HOME__|${SMMTA_HOME}|g" \
          -e "s|__SMMTA_NODE_BIN__|${SMMTA_NODE_BIN}|g" \
          "${tmpl}" >"${unit}"
    done
  done
  systemctl daemon-reload
  systemctl enable --now smmta-api.service
  for t in "${AUTOSTOCK_TIMERS[@]}"; do
    systemctl enable --now "${t}.timer"
  done
}

main() {
  install_packages
  create_user
  install_node
  clone_and_build
  write_api_env
  log "Bringing up Postgres in Docker + running migrations"
  sudo -u "${SMMTA_USER}" bash -lc "cd ${REPO_DIR} && docker compose up -d postgres"
  sudo -u "${SMMTA_USER}" bash -lc "cd ${REPO_DIR}/apps/api && npx drizzle-kit migrate"
  install_systemd
  log "Auto-Stock installed. Finish setup in the admin SPA at https://${SMMTA_ADMIN_HOST:-<admin-host>}/"
}

main "$@"
