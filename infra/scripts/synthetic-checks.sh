#!/usr/bin/env bash
# Synthetic checks for the Filament Store. Run from cron on the VPS.
#
# Two probes:
#   1. Catalogue read — every minute. Calls /storefront/groups with the
#      operator's storefront-read API key. A failure here means the API
#      is down or the storefront key is misconfigured.
#   2. End-to-end purchase against Mollie test mode — every 30 minutes.
#      Drives a headless Playwright run through the cart → Mollie test
#      payment → /confirmation flow. Catches webhook / commit issues
#      that a healthcheck on /healthz alone wouldn't see.
#
# Output: appended JSON lines to /var/log/smmta-store/synthetic.log.
# Alerts: 3 consecutive failures of the same probe send an email via
# the host MTA (configured in /etc/aliases). For richer alerting wire
# this into Sentry crons or a dedicated uptime service.
#
# Crontab (run as user smmta):
#   * * * * * /opt/smmta-next/infra/scripts/synthetic-checks.sh catalogue
#   */30 * * * * /opt/smmta-next/infra/scripts/synthetic-checks.sh purchase

set -euo pipefail

PROBE="${1:-catalogue}"
LOG_DIR="${LOG_DIR:-/var/log/smmta-store}"
LOG_FILE="${LOG_DIR}/synthetic.log"
STATE_DIR="${STATE_DIR:-/var/lib/smmta-store}"
ALERT_EMAIL="${ALERT_EMAIL:-ops@cleverdeals.com}"

# Source secrets — never inline in cron lines.
# Expected vars: SMMTA_API_BASE_URL, SMMTA_STOREFRONT_READ_KEY,
# STORE_BASE_URL, MOLLIE_TEST_API_KEY (for the Playwright probe).
if [[ -f /etc/smmta/synthetic.env ]]; then
  # shellcheck disable=SC1091
  source /etc/smmta/synthetic.env
fi

mkdir -p "${LOG_DIR}" "${STATE_DIR}"

now() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

emit() {
  local probe="$1" status="$2" detail="$3"
  printf '{"ts":"%s","probe":"%s","status":"%s","detail":%s}\n' \
    "$(now)" "${probe}" "${status}" "${detail}" \
    >> "${LOG_FILE}"
}

# Maintain a per-probe failure counter; reset on success.
fail_counter() {
  local probe="$1" delta="$2"
  local f="${STATE_DIR}/${probe}.fails"
  local current=0
  [[ -f "${f}" ]] && current=$(<"${f}")
  case "${delta}" in
    inc) printf "%s" $((current + 1)) > "${f}"; printf "%s" $((current + 1));;
    reset) printf "0" > "${f}"; printf "0";;
    read) printf "%s" "${current}";;
  esac
}

alert() {
  local probe="$1" detail="$2"
  if command -v mail >/dev/null 2>&1; then
    printf "Filament Store synthetic probe '%s' has failed 3 times in a row.\n\nLatest detail: %s\n\nSee %s for the full log.\n" \
      "${probe}" "${detail}" "${LOG_FILE}" |
      mail -s "[smmta-store] ${probe} probe failing" "${ALERT_EMAIL}"
  fi
}

case "${PROBE}" in
  catalogue)
    : "${SMMTA_API_BASE_URL:?SMMTA_API_BASE_URL not set}"
    : "${SMMTA_STOREFRONT_READ_KEY:?SMMTA_STOREFRONT_READ_KEY not set}"
    if curl -fsS \
        -H "Authorization: Bearer ${SMMTA_STOREFRONT_READ_KEY}" \
        --max-time 5 \
        "${SMMTA_API_BASE_URL}/storefront/groups" >/dev/null 2>&1; then
      emit catalogue ok '"groups read"'
      fail_counter catalogue reset >/dev/null
    else
      detail=$(printf '"GET /storefront/groups failed"')
      emit catalogue fail "${detail}"
      n=$(fail_counter catalogue inc)
      if [[ "${n}" -eq 3 ]]; then
        alert catalogue "GET /storefront/groups failed"
      fi
    fi
    ;;

  purchase)
    : "${STORE_BASE_URL:?STORE_BASE_URL not set}"
    : "${MOLLIE_TEST_API_KEY:?MOLLIE_TEST_API_KEY not set}"
    pushd /opt/smmta-next/apps/store >/dev/null
    # Playwright spec for the synthetic purchase lives alongside the
    # rest of the e2e suite; CI and synthetic-mode share one fixture.
    if STORE_BASE_URL="${STORE_BASE_URL}" \
       MOLLIE_API_KEY="${MOLLIE_TEST_API_KEY}" \
       npx --no-install playwright test --project=synthetic --reporter=line >>"${LOG_FILE}.purchase.out" 2>&1; then
      emit purchase ok '"e2e purchase ok"'
      fail_counter purchase reset >/dev/null
    else
      detail=$(printf '"playwright run failed (see %s.purchase.out)"' "${LOG_FILE}")
      emit purchase fail "${detail}"
      n=$(fail_counter purchase inc)
      if [[ "${n}" -eq 3 ]]; then
        alert purchase "synthetic purchase Playwright run failed 3× in a row"
      fi
    fi
    popd >/dev/null
    ;;

  *)
    echo "usage: $0 {catalogue|purchase}" >&2
    exit 2
    ;;
esac
