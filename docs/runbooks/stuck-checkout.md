# Stuck checkout

When a customer reports they paid but never received a confirmation
email, or they're stuck on `/checkout/return` longer than expected,
the checkout has likely failed to commit. This runbook walks you
through diagnosing it and (if needed) unsticking it by hand.

## Symptoms

- Customer email asking "did my order go through?"
- Order doesn't appear in `/admin/refunds` (no `mollie_payments` row).
- `/checkout/return?cid=…` polls forever without redirecting to
  `/confirmation/<orderId>`.

## Where to look

The storefront Postgres has every signal you need. Connect with:

```bash
psql -h localhost -U smmta -d smmta_store
```

### 1. Find the checkout

```sql
SELECT id, status, reservation_id, mollie_payment_id, smmta_order_id,
       customer->>'email' AS email, created_at, expires_at
FROM checkouts
WHERE customer->>'email' = '<customer email>'
ORDER BY created_at DESC
LIMIT 5;
```

A healthy completed checkout has `status = 'COMMITTED'` and a non-null
`smmta_order_id`. Anything else is the failure mode.

### 2. Check the Mollie state

```sql
SELECT id, status, amount_gbp, created_at, updated_at
FROM mollie_payments
WHERE id = '<mollie_payment_id from above>';
```

Cross-reference with [Mollie's dashboard](https://www.mollie.com/dashboard)
under *Payments*. The DB is supposed to reflect what Mollie thinks; if
they disagree, the storefront's webhook delivery either never arrived
or never re-fetched.

### 3. Webhook deliveries

```sql
SELECT id, source, received_at, signature_ok, fetched_payment_status,
       action_taken, error
FROM webhook_deliveries
WHERE source = 'mollie'
ORDER BY received_at DESC
LIMIT 20;
```

Things to spot:

- `signature_ok = false` and `error IS NOT NULL` — the webhook
  arrived but `finalizeFromMollie` threw. Read the error.
- `signature_ok = true` and `action_taken LIKE 'committed order%'` — the
  webhook *did* commit. The customer's confirmation email is just
  delayed or missing.
- No row at all for that Mollie payment id — the webhook didn't
  arrive. Use `mollie-webhook-not-arriving.md`.

### 4. Logs

```bash
journalctl -u smmta-store --since "30 min ago" \
  | grep -E '<requestId>|<molliePaymentId>'
```

Every line a route handler emits carries `requestId`. The Mollie
webhook handler logs the inbound `id=tr_…` body verbatim so you can
grep by Mollie payment id.

## Unsticking by hand

### Mollie says paid, our DB doesn't know yet

Mollie's webhook may have failed and back-off may not have retried yet.
Replay the webhook from the Mollie dashboard (*Payments → the payment →
Webhook deliveries → Resend*). The handler is idempotent; replays are
safe.

If that's not possible, you can call the storefront's checkout-finalize
flow directly (only the API key holder can):

```bash
# From the host:
curl -fsS -X POST -H "Content-Type: application/x-www-form-urlencoded" \
  --data "id=<mollie_payment_id>" \
  http://127.0.0.1:3000/api/mollie/webhook
```

Note: in production this endpoint is open to Mollie's IPs only via
nginx — adjust if calling from off-host.

### Reservation expired before the customer paid

The checkout will be in `status = 'FAILED'` with `reservation_id` set.
The reservation was already released. Refund the customer in Mollie
(if they paid) and apologise — no manual order commit is possible
because the stock is no longer held.

### SMMTA committed but the storefront didn't record it

Rare, but possible if the SMMTA commit succeeded and the storefront's
DB write was killed before persisting `smmta_order_id`. Update by hand:

```sql
UPDATE checkouts
SET status = 'COMMITTED',
    smmta_order_id = '<orderId from /admin/orders>',
    updated_at = NOW()
WHERE id = '<checkout id>';
```

Then re-enqueue the customer's confirmation email:

```bash
# From the storefront app dir:
node -e "require('./apps/store/lib/email').enqueue('order_confirmation', { ... })"
```

Or — easier — use the customer-facing **Resend confirmation** button
on `/track/<orderId>`.

## Prevention

Sentry should catch the underlying `finalizeFromMollie` exception. If
this runbook is being used and Sentry has nothing for the same
`requestId`, **fix the SDK init** before fixing the checkout.
