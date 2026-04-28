# Storefront cannot reach the SMMTA-NEXT API

Symptom: every storefront page renders the empty-catalogue fallback;
`/healthz` reports the SMMTA dependency as down; cart adds throw.

## Quick triage

```bash
# From the storefront VPS:
curl -fsS http://127.0.0.1:3000/healthz
# Should return JSON with sub-statuses; "smmta": "down" indicates
# what we're chasing.
```

```bash
# Test the upstream API host directly:
SMMTA_API_BASE_URL=$(grep SMMTA_API_BASE_URL /etc/smmta/store.env | cut -d= -f2-)
SMMTA_API_KEY=$(grep ^SMMTA_API_KEY /etc/smmta/store.env | cut -d= -f2-)
curl -fsS -H "Authorization: Bearer ${SMMTA_API_KEY}" \
  --max-time 5 \
  "${SMMTA_API_BASE_URL}/storefront/groups"
```

The result tells you which layer is at fault:

| Outcome | Meaning |
|---|---|
| HTTP 200 + JSON | API is healthy. The storefront couldn't reach it from inside its own process — restart `smmta-store` and check `journalctl`. |
| HTTP 401 / 403 | API key revoked or rotated. Re-issue under `/admin` on the API and update `SMMTA_API_KEY` in `/etc/smmta/store.env`, then `systemctl restart smmta-store`. |
| HTTP 5xx | API is up but failing internally — see API logs. |
| Connection refused / timeout | Network or process layer issue. See below. |

## DNS

```bash
dig +short api.cleverdeals.com    # whatever host your env points at
# Should resolve to the VPS internal IP.
```

If wrong, fix DNS first; nothing else matters until that's right.

## NAT / firewall

The storefront and API run on the same VPS by default. If you've
moved the API onto a separate host:

- Confirm the storefront's outbound traffic is allowed to the API
  port (`ufw status`, security groups, etc.).
- Confirm the API is bound to `0.0.0.0` (not `127.0.0.1`) if the
  storefront is on a different host.

## Process

```bash
sudo systemctl status smmta-api
sudo journalctl -u smmta-api -n 200 --no-pager
```

If the API is dead, check why before restarting — silent restart
loops mask root causes (typically a bad migration or env value).

## Key rotation procedure

When you need to rotate `SMMTA_API_KEY` (compromise, lost laptop, etc.):

1. **Mint a new key** under `/admin` in `apps/web` (Prompt 2's API key
   admin surface). Give it the same scopes as the old one
   (`storefront:read` + `storefront:write`).
2. **Update `/etc/smmta/store.env`** on the storefront host. Mode 0600.
3. **Reload the storefront** (`sudo systemctl restart smmta-store`).
4. **Verify** with `curl /healthz` (should say smmta=ok) and a
   manual catalogue read.
5. **Revoke the old key** under `/admin/api-keys`. Don't skip this
   step — there's no way to detect a compromised live key in the wild.

The storefront has no caching of the key beyond the in-process env
read; restarting picks the new value up immediately.

## Sentry

A burst of `SmmtaApiError` events with `status: 0` (network-level
failure) confirms it's a connectivity issue rather than an
application-level error.
