# Mollie webhook not arriving

Mollie's webhook is the storefront's primary signal that a payment
succeeded. If webhook deliveries stop the symptom is *every* checkout
hanging at `/checkout/return` forever. This runbook is for diagnosing
why deliveries aren't reaching us and replaying any that were missed.

## Confirm the storefront's `webhookUrl`

The checkout pipeline builds the URL from `MOLLIE_WEBHOOK_URL_BASE +
'/api/mollie/webhook'`. Confirm what it's set to:

```bash
sudo cat /etc/smmta/store.env | grep MOLLIE_WEBHOOK_URL_BASE
```

In production that should be `https://filament.shop.cleverdeals.com`.
In staging / dev it's typically an ngrok / Cloudflare Tunnel URL —
those expire whenever you tear down the tunnel.

## Confirm Mollie can reach it

From any host on the public internet (NOT the storefront VPS):

```bash
curl -i -X POST -H "Content-Type: application/x-www-form-urlencoded" \
  --data "id=tr_diagnostic_test" \
  https://filament.shop.cleverdeals.com/api/mollie/webhook
```

Expect a 502 or 400 (payment id is bogus, but the route exists). If
you get a *connection error* the firewall or DNS is wrong.

## Check Mollie's dashboard

Mollie *Settings → API → Webhook deliveries* shows the most recent
deliveries per payment + their HTTP status. A 5xx or timeout there is
exactly what nginx / our handler returned. Replay from this UI:
*Payments → the payment → Resend webhook*.

## Replay a single payment manually

If you know the Mollie payment id and want to force a re-process:

```bash
curl -fsS -X POST -H "Content-Type: application/x-www-form-urlencoded" \
  --data "id=<tr_xxx>" \
  http://127.0.0.1:3000/api/mollie/webhook
```

The handler always re-fetches `GET /v2/payments/:id` with our server
key and re-runs the finalize logic — so it's safe to call multiple
times. Idempotent on `Idempotency-Key` for the SMMTA commit too.

## Bulk replay after an outage

If the storefront was down for a window:

```bash
# 1. List Mollie payments in the affected window from the dashboard.
# 2. For each id, run the curl above. The handler's idempotent commit
#    path will skip ones we already saw and process ones we missed.
```

A small loop is fine; the inner DB work is bounded and fast.

## ngrok / dev mode

If webhook deliveries fail in dev:

- ngrok URLs are ephemeral. Re-issue and update `MOLLIE_WEBHOOK_URL_BASE`.
- Cloudflare Tunnel persists across restarts — preferred for any
  multi-day dev session.
- The storefront does NOT verify a Mollie signature on the body — Mollie
  doesn't sign payment webhooks; it relies on us re-fetching by id with
  our API key. There's nothing to "rotate" beyond the URL itself.

## When this runbook didn't help

- Check journalctl (`journalctl -u smmta-store -f`) while triggering a
  test payment in Mollie's dashboard. If nothing shows, the request
  isn't reaching our process — nginx or networking issue.
- Check `webhook_deliveries.error` for any non-NULL entries from the
  last hour.
