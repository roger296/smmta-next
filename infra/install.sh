#!/usr/bin/env bash
# ==============================================================================
# smmta-next — VPS installer
#
# One-shot script that turns a fresh Ubuntu 22.04+ / Debian 12+ VPS into a
# running smmta-next deployment: Postgres in Docker, drizzle migrations,
# singleton company row, first admin user, API + storefront under systemd,
# nginx + Let's Encrypt for both URLs.
#
# Usage:
#   sudo bash infra/install.sh                        # interactive
#   sudo SMMTA_NONINTERACTIVE=1 \
#        SMMTA_BUSINESS_NAME="Filament Store Ltd" \
#        SMMTA_STORE_HOST=shop.example.com \
#        SMMTA_ADMIN_HOST=admin.example.com \
#        SMMTA_ADMIN_EMAIL=admin@example.com \
#        SMMTA_ADMIN_PASSWORD='hunter2-not-this' \
#        SMMTA_LE_EMAIL=admin@example.com \
#        bash infra/install.sh                        # non-interactive
#
# Re-running on an installed system: each step detects existing state and
# skips when safe, prompting before overwriting `.env` files. Pass
# SMMTA_FORCE=1 to overwrite without prompting.
#
# Requires: bash 4+, run as root (or via sudo).
# ==============================================================================

set -euo pipefail

# --- locations -----------------------------------------------------------------
SMMTA_USER="${SMMTA_USER:-smmta}"
SMMTA_HOME="/home/${SMMTA_USER}"
REPO_DIR="${SMMTA_HOME}/smmta-next"
REPO_URL="${SMMTA_REPO_URL:-https://github.com/roger296/smmta-next.git}"
NODE_MAJOR="${SMMTA_NODE_MAJOR:-22}"

# --- helpers -------------------------------------------------------------------
log()  { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
info() { printf '\033[0;36m   %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    die "install.sh must run as root (try: sudo bash infra/install.sh)"
  fi
}

require_supported_distro() {
  if [[ ! -r /etc/os-release ]]; then die "Can't read /etc/os-release"; fi
  . /etc/os-release
  case "${ID:-}" in
    ubuntu|debian) info "Detected ${PRETTY_NAME:-$ID}";;
    *) die "Unsupported distro '${ID:-unknown}'. This installer targets Ubuntu / Debian.";;
  esac
}

ask() {
  # ask <prompt> <default> <var-name>
  local prompt="$1" default="${2:-}" varname="$3" current="${!3:-}"
  if [[ -n "${current}" ]]; then return 0; fi
  if [[ "${SMMTA_NONINTERACTIVE:-0}" = "1" ]]; then
    if [[ -n "${default}" ]]; then printf -v "${varname}" '%s' "${default}"; return 0; fi
    die "${varname} is required (set the env var or run interactively)"
  fi
  local input
  if [[ -n "${default}" ]]; then
    read -r -p "  ${prompt} [${default}]: " input
    input="${input:-$default}"
  else
    read -r -p "  ${prompt}: " input
  fi
  printf -v "${varname}" '%s' "${input}"
}

ask_password() {
  local prompt="$1" varname="$2" current="${!2:-}"
  if [[ -n "${current}" ]]; then return 0; fi
  if [[ "${SMMTA_NONINTERACTIVE:-0}" = "1" ]]; then
    die "${varname} is required (set the env var)"
  fi
  local input confirm
  while :; do
    read -r -s -p "  ${prompt}: " input; echo
    [[ ${#input} -ge 8 ]] || { warn "Password must be at least 8 characters."; continue; }
    read -r -s -p "  Confirm: " confirm; echo
    [[ "${input}" = "${confirm}" ]] || { warn "Passwords didn't match."; continue; }
    break
  done
  printf -v "${varname}" '%s' "${input}"
}

valid_hostname() {
  [[ "$1" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$ ]]
}

write_env_safely() {
  # write_env_safely <path> <heredoc-via-stdin>
  local path="$1"
  if [[ -f "${path}" && "${SMMTA_FORCE:-0}" != "1" ]]; then
    if [[ "${SMMTA_NONINTERACTIVE:-0}" = "1" ]]; then
      info "Skipping ${path} — already exists. Pass SMMTA_FORCE=1 to overwrite."
      cat >/dev/null  # consume the stdin
      return 0
    fi
    read -r -p "  ${path} exists. Overwrite? [y/N] " ans
    if [[ "${ans:-N}" != "y" && "${ans:-N}" != "Y" ]]; then
      info "Keeping existing ${path}"
      cat >/dev/null
      return 0
    fi
  fi
  install -m 0600 -o "${SMMTA_USER}" -g "${SMMTA_USER}" /dev/null "${path}"
  cat >"${path}"
}

random_hex() { openssl rand -hex "$1"; }

# --- prompts -------------------------------------------------------------------
collect_inputs() {
  log "Configuration"
  ask          "Business name (e.g. Filament Store Ltd)"     ""                 SMMTA_BUSINESS_NAME
  ask          "Storefront hostname (e.g. shop.example.com)" ""                 SMMTA_STORE_HOST
  ask          "Admin SPA hostname (e.g. admin.example.com)" ""                 SMMTA_ADMIN_HOST
  ask          "Admin email (becomes the first admin user)"  ""                 SMMTA_ADMIN_EMAIL
  ask_password "Admin password (will not echo)"                                 SMMTA_ADMIN_PASSWORD
  ask          "Let's Encrypt notification email"            "${SMMTA_ADMIN_EMAIL}" SMMTA_LE_EMAIL
  ask          "SendGrid API key (blank to fill in later)"   ""                 SMMTA_SENDGRID_API_KEY || true
  ask          "Mollie API key (blank to fill in later)"     ""                 SMMTA_MOLLIE_API_KEY || true

  valid_hostname "${SMMTA_STORE_HOST}" || die "Storefront hostname '${SMMTA_STORE_HOST}' is not valid"
  valid_hostname "${SMMTA_ADMIN_HOST}" || die "Admin hostname '${SMMTA_ADMIN_HOST}' is not valid"
  [[ "${SMMTA_ADMIN_EMAIL}" == *@*.* ]] || die "Admin email '${SMMTA_ADMIN_EMAIL}' is not valid"
}

# --- system prep ---------------------------------------------------------------
install_packages() {
  log "Installing system packages"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq \
    ca-certificates curl git gnupg jq openssl \
    nginx certbot python3-certbot-nginx \
    docker.io docker-compose-plugin
  systemctl enable --now docker
  systemctl enable --now nginx
}

ensure_user() {
  if ! id -u "${SMMTA_USER}" >/dev/null 2>&1; then
    log "Creating system user ${SMMTA_USER}"
    useradd -m -s /bin/bash "${SMMTA_USER}"
  else
    info "User ${SMMTA_USER} already exists"
  fi
  usermod -aG docker "${SMMTA_USER}" || true
}

install_node_via_nvm() {
  log "Installing Node ${NODE_MAJOR}.x via NVM (under ${SMMTA_USER})"
  if ! sudo -u "${SMMTA_USER}" bash -c '[ -d "$HOME/.nvm" ]'; then
    sudo -u "${SMMTA_USER}" bash -c \
      'curl -sSf -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash >/dev/null'
  fi
  sudo -u "${SMMTA_USER}" bash -lc \
    "export NVM_DIR=\"${SMMTA_HOME}/.nvm\" && . \$NVM_DIR/nvm.sh \
     && nvm install ${NODE_MAJOR} >/dev/null \
     && nvm alias default ${NODE_MAJOR} >/dev/null \
     && ln -sfn \"\$(nvm version)\" \"${SMMTA_HOME}/.nvm/versions/node/current\""
}

resolve_node_bin() {
  SMMTA_NODE_BIN="$(sudo -u "${SMMTA_USER}" bash -lc \
    "readlink -f ${SMMTA_HOME}/.nvm/versions/node/current/bin/node")"
  [[ -x "${SMMTA_NODE_BIN}" ]] || die "Couldn't resolve node binary under ~/.nvm"
  info "Node binary: ${SMMTA_NODE_BIN}"
}

# --- repo setup ----------------------------------------------------------------
clone_or_update_repo() {
  log "Cloning repo into ${REPO_DIR}"
  if [[ -d "${REPO_DIR}/.git" ]]; then
    info "Repo already present — fetching latest main"
    sudo -u "${SMMTA_USER}" git -C "${REPO_DIR}" fetch --all --tags --quiet
    sudo -u "${SMMTA_USER}" git -C "${REPO_DIR}" checkout main --quiet
    sudo -u "${SMMTA_USER}" git -C "${REPO_DIR}" pull --ff-only --quiet
  else
    sudo -u "${SMMTA_USER}" git clone --quiet "${REPO_URL}" "${REPO_DIR}"
  fi
}

npm_install_and_build() {
  log "Running npm install + builds (this takes a few minutes)"
  sudo -u "${SMMTA_USER}" bash -lc "cd ${REPO_DIR} && npm install --no-audit --no-fund"
  sudo -u "${SMMTA_USER}" bash -lc "cd ${REPO_DIR} && npm run build -w @smmta/shared-types"
  sudo -u "${SMMTA_USER}" bash -lc "cd ${REPO_DIR} && npm run build -w @smmta/api"
  sudo -u "${SMMTA_USER}" bash -lc "cd ${REPO_DIR} && npm run build -w @smmta/web"
  sudo -u "${SMMTA_USER}" bash -lc "cd ${REPO_DIR} && npm run build -w @smmta/store"
  # Standalone build symlinks (next build doesn't copy these).
  sudo -u "${SMMTA_USER}" bash -lc "cd ${REPO_DIR} \
    && mkdir -p apps/store/.next/standalone/apps/store/.next \
    && ln -sfn \"\$(pwd)/apps/store/.next/static\" apps/store/.next/standalone/apps/store/.next/static \
    && [ -d apps/store/public ] && ln -sfn \"\$(pwd)/apps/store/public\" apps/store/.next/standalone/apps/store/public || true"
}

# --- secrets + env files -------------------------------------------------------
generate_secrets() {
  log "Generating secrets"
  JWT_SECRET="$(random_hex 32)"
  DB_PASSWORD="$(random_hex 24)"
  STORE_COOKIE_SECRET="$(random_hex 32)"
  COMPANY_ID="$(uuidgen 2>/dev/null || python3 -c 'import uuid; print(uuid.uuid4())')"
  info "Generated JWT, DB password, store cookie secret"
  info "COMPANY_ID = ${COMPANY_ID}"
}

write_compose_env() {
  log "Writing docker-compose env override"
  install -m 0600 -o root -g root /dev/null "${REPO_DIR}/.env.compose"
  cat >"${REPO_DIR}/.env.compose" <<EOF
POSTGRES_USER=smmta
POSTGRES_PASSWORD=${DB_PASSWORD}
POSTGRES_DB=smmta_next
EOF
  chown "${SMMTA_USER}:${SMMTA_USER}" "${REPO_DIR}/.env.compose"
}

bring_up_postgres() {
  log "Bringing up Postgres in Docker"
  sudo -u "${SMMTA_USER}" bash -lc \
    "cd ${REPO_DIR} && docker compose --env-file .env.compose up -d postgres"
  info "Waiting for Postgres to be ready"
  for _ in $(seq 1 30); do
    if sudo -u "${SMMTA_USER}" bash -lc \
        "cd ${REPO_DIR} && docker compose exec -T postgres pg_isready -U smmta -d smmta_next" \
        >/dev/null 2>&1; then
      info "Postgres ready"
      return 0
    fi
    sleep 2
  done
  die "Postgres didn't become ready in 60s — check 'docker compose logs postgres'"
}

write_api_env() {
  log "Writing apps/api/.env"
  write_env_safely "${REPO_DIR}/apps/api/.env" <<EOF
NODE_ENV=production
PORT=3000
HOST=127.0.0.1
DATABASE_URL=postgresql://smmta:${DB_PASSWORD}@127.0.0.1:5432/smmta_next
JWT_SECRET=${JWT_SECRET}
COMPANY_ID=${COMPANY_ID}
EOF
}

write_store_env() {
  log "Writing apps/store/.env (storefront API key minted after first boot)"
  write_env_safely "${REPO_DIR}/apps/store/.env" <<EOF
NODE_ENV=production
PORT=4000
HOST=127.0.0.1
STORE_BASE_URL=https://${SMMTA_STORE_HOST}
SMMTA_API_BASE_URL=http://127.0.0.1:3000/api/v1
SMMTA_API_KEY=PENDING_FIRST_BOOT
DATABASE_URL=postgresql://smmta:${DB_PASSWORD}@127.0.0.1:5432/smmta_store
STORE_COOKIE_SECRET=${STORE_COOKIE_SECRET}
SENDGRID_API_KEY=${SMMTA_SENDGRID_API_KEY:-}
MOLLIE_API_KEY=${SMMTA_MOLLIE_API_KEY:-}
EOF
}

write_web_env() {
  log "Writing apps/web/.env.production"
  write_env_safely "${REPO_DIR}/apps/web/.env.production" <<EOF
VITE_API_BASE_URL=/api/v1
EOF
}

# --- bootstrap data ------------------------------------------------------------
run_migrations() {
  log "Running drizzle migrations"
  sudo -u "${SMMTA_USER}" bash -lc \
    "cd ${REPO_DIR}/apps/api && DATABASE_URL='postgresql://smmta:${DB_PASSWORD}@127.0.0.1:5432/smmta_next' npx drizzle-kit migrate"
  # Storefront's smmta_store DB is created by docker-init; ensure it exists.
  sudo -u "${SMMTA_USER}" bash -lc \
    "cd ${REPO_DIR} && docker compose exec -T postgres psql -U smmta -tc \"SELECT 1 FROM pg_database WHERE datname='smmta_store'\" | grep -q 1 \
     || docker compose exec -T postgres psql -U smmta -c 'CREATE DATABASE smmta_store'"
}

create_first_admin_user() {
  log "Creating the first admin user"
  sudo -u "${SMMTA_USER}" bash -lc \
    "cd ${REPO_DIR} && DATABASE_URL='postgresql://smmta:${DB_PASSWORD}@127.0.0.1:5432/smmta_next' \
       COMPANY_ID='${COMPANY_ID}' \
       SMMTA_USER_PASSWORD='${SMMTA_ADMIN_PASSWORD}' \
       npx tsx apps/api/scripts/create-user.ts \
         --email '${SMMTA_ADMIN_EMAIL}' \
         --name '${SMMTA_BUSINESS_NAME} Admin'" \
    || warn "create-user exited non-zero (a user with this email may already exist)"
}

mint_storefront_api_key() {
  log "Minting the storefront API key"
  local raw
  raw="$(sudo -u "${SMMTA_USER}" bash -lc \
    "cd ${REPO_DIR} && DATABASE_URL='postgresql://smmta:${DB_PASSWORD}@127.0.0.1:5432/smmta_next' \
       COMPANY_ID='${COMPANY_ID}' \
       npx tsx apps/api/scripts/issue-store-key.ts" | sed -n 's|^KEY=\(.*\)$|\1|p')"
  if [[ -z "${raw}" ]]; then
    warn "Couldn't parse storefront API key from issue-store-key output — leave SMMTA_API_KEY=PENDING_FIRST_BOOT in apps/store/.env and rerun manually"
    return 0
  fi
  sed -i "s|^SMMTA_API_KEY=.*|SMMTA_API_KEY=${raw}|" "${REPO_DIR}/apps/store/.env"
  info "Storefront API key written into apps/store/.env"
}

# --- systemd + nginx -----------------------------------------------------------
install_systemd_units() {
  log "Installing systemd units"
  for tpl in smmta-api smmta-store; do
    local src="${REPO_DIR}/infra/systemd/${tpl}.service.template"
    local dst="/etc/systemd/system/${tpl}.service"
    sed \
      -e "s|__SMMTA_USER__|${SMMTA_USER}|g" \
      -e "s|__SMMTA_HOME__|${SMMTA_HOME}|g" \
      -e "s|__SMMTA_NODE_BIN__|${SMMTA_NODE_BIN}|g" \
      "${src}" >"${dst}"
    chmod 0644 "${dst}"
  done
  systemctl daemon-reload
  systemctl enable --now smmta-api
  systemctl enable --now smmta-store
}

wait_for_health() {
  local url="$1" name="$2"
  for _ in $(seq 1 30); do
    if curl -fsS -o /dev/null "${url}"; then
      info "${name} healthy"
      return 0
    fi
    sleep 1
  done
  warn "${name} didn't pass healthcheck at ${url}"
}

install_nginx_sites() {
  log "Installing nginx server blocks"
  local store_dst="/etc/nginx/sites-available/${SMMTA_STORE_HOST}.conf"
  local admin_dst="/etc/nginx/sites-available/${SMMTA_ADMIN_HOST}.conf"
  sed -e "s|__STORE_HOST__|${SMMTA_STORE_HOST}|g" \
    "${REPO_DIR}/infra/nginx/storefront.conf.template" >"${store_dst}"
  sed -e "s|__ADMIN_HOST__|${SMMTA_ADMIN_HOST}|g" \
      -e "s|__SMMTA_HOME__|${SMMTA_HOME}|g" \
    "${REPO_DIR}/infra/nginx/admin.conf.template" >"${admin_dst}"
  ln -sfn "${store_dst}" "/etc/nginx/sites-enabled/${SMMTA_STORE_HOST}.conf"
  ln -sfn "${admin_dst}" "/etc/nginx/sites-enabled/${SMMTA_ADMIN_HOST}.conf"
  nginx -t
  systemctl reload nginx
}

issue_letsencrypt_certs() {
  log "Issuing Let's Encrypt certs"
  certbot --nginx --non-interactive --agree-tos --redirect \
    --email "${SMMTA_LE_EMAIL}" \
    -d "${SMMTA_STORE_HOST}" \
    -d "${SMMTA_ADMIN_HOST}" \
    || warn "certbot exited non-zero — DNS may not be pointing at this VPS yet. Re-run after DNS is set."
}

# --- summary -------------------------------------------------------------------
print_summary() {
  log "Install complete"
  cat <<EOF
   Storefront URL    https://${SMMTA_STORE_HOST}
   Admin SPA URL     https://${SMMTA_ADMIN_HOST}
   Admin login       ${SMMTA_ADMIN_EMAIL}    (password not shown)
   COMPANY_ID        ${COMPANY_ID}

   Env files (mode 0600, owned by ${SMMTA_USER}):
     ${REPO_DIR}/apps/api/.env
     ${REPO_DIR}/apps/store/.env
     ${REPO_DIR}/apps/web/.env.production

   Logs:
     journalctl -u smmta-api   -f
     journalctl -u smmta-store -f

   Reminders this script can't do for you:
     1. DNS A record for ${SMMTA_STORE_HOST}  → this VPS's IP
     2. DNS A record for ${SMMTA_ADMIN_HOST}  → this VPS's IP
     3. Configure SendGrid SPF + DKIM for the storefront's send domain
     4. Configure the Mollie webhook URL to https://${SMMTA_STORE_HOST}/api/mollie/webhook
EOF
}

# --- main ----------------------------------------------------------------------
main() {
  require_root
  require_supported_distro
  collect_inputs
  install_packages
  ensure_user
  install_node_via_nvm
  resolve_node_bin
  clone_or_update_repo
  generate_secrets
  write_compose_env
  bring_up_postgres
  npm_install_and_build
  write_api_env
  write_store_env
  write_web_env
  run_migrations
  create_first_admin_user
  install_systemd_units
  mint_storefront_api_key
  systemctl restart smmta-store
  wait_for_health "http://127.0.0.1:3000/health"  "API"
  wait_for_health "http://127.0.0.1:4000/healthz" "Storefront"
  install_nginx_sites
  issue_letsencrypt_certs
  print_summary
}

main "$@"
