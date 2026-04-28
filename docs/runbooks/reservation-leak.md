# Stock reservation leak

Stock items move through the states: `IN_STOCK → RESERVED → ALLOCATED`
(committed) or `IN_STOCK → RESERVED → IN_STOCK` (released). A
reservation that gets stuck in `RESERVED` past its `expires_at` ties
up units that should be sellable.

The reservation expirer (a SMMTA-NEXT background job) runs on a
schedule and flips them back. If it crashes or is mis-scheduled,
inventory drifts.

## Detection

The first sign is usually a customer report ("it says only 1 left
but I can't get it into my cart"). To confirm:

```sql
-- On the SMMTA-NEXT DB (smmta_next), not the storefront DB:
SELECT id, status, expires_at, created_at
FROM stock_reservations
WHERE status = 'RESERVED' AND expires_at < NOW()
ORDER BY expires_at;
```

A handful in the last few minutes is normal — they're between expiry
and the next expirer tick. More than ~10, or any older than 5
minutes past expiry, is a leak.

## Quick manual fix

```sql
BEGIN;

-- 1. Mark the rows we want to release.
WITH to_release AS (
  SELECT id FROM stock_reservations
  WHERE status = 'RESERVED' AND expires_at < NOW() - INTERVAL '2 minutes'
)
-- 2. Send their stock_items back to IN_STOCK.
UPDATE stock_items si
SET status = 'IN_STOCK', reservation_id = NULL, updated_at = NOW()
FROM to_release tr
JOIN stock_reservations sr ON sr.id = tr.id
WHERE si.reservation_id = sr.id;

-- 3. Mark the reservations themselves EXPIRED.
UPDATE stock_reservations
SET status = 'EXPIRED', updated_at = NOW()
WHERE status = 'RESERVED' AND expires_at < NOW() - INTERVAL '2 minutes';

COMMIT;
```

This mirrors what `ReservationService.expire` does in the API. Always
run inside a transaction.

## Diagnosing the cause

1. Is the expirer cron actually running?
   ```bash
   journalctl -u smmta-api -f | grep -i 'reservation expirer'
   ```
2. Is the API throwing on `expire`? Sentry will have the stack.
3. Is `mollie_payments.status` *also* stuck on `open` for these
   reservations' checkouts? That would point at a webhook problem
   (use `mollie-webhook-not-arriving.md`).

## Prevention

- Keep the reservation TTL tight (`15min` default in
  `apps/store/lib/checkout.ts`). Longer TTLs mean longer leaks if the
  expirer ever stalls.
- Consider a Postgres `pg_cron` job as a belt-and-braces backup to
  the in-process expirer: same query as above on a 5-minute schedule.
