# Stock updates from drop-ship suppliers

Stock counts for drop-ship products (anything in `supplier_products`) come
from a periodic poll, not a webhook — every supplier we currently
integrate with returns full-catalogue snapshots rather than push
notifications. The polling worker reads each supplier's
`pollIntervalMinutes` setting and writes `last_known_stock` /
`last_known_price` / `last_polled_at` back to `supplier_products`.

The three-state stock display on the storefront (`IN_STOCK`,
`AVAILABLE_FROM_SUPPLIER`, `OUT_OF_STOCK`) reads from these columns.
Without a recent poll, every supplier-fulfilled product shows as
**Out of stock**.

## Automatic — every 3 hours via systemd timer

Once installed, `smmta-supplier-poll.timer` fires the poll service
eight times a day (00:00, 03:00, 06:00, 09:00, 12:00, 15:00, 18:00,
21:00 UTC). Each fire walks every active supplier and skips ones
polled within their `pollIntervalMinutes` window — so a supplier
with `pollIntervalMinutes = 180` polls 8x/day, one with `720` polls
3x/day.

Check the timer is enabled and when it last fired:

```bash
sudo systemctl list-timers smmta-supplier-poll
sudo journalctl -u smmta-supplier-poll -n 50 --no-pager
```

If the timer isn't installed, render the templates:

```bash
sudo bash -c "
  sed -e 's|__SMMTA_USER__|smmta|g' \
      -e 's|__SMMTA_HOME__|/home/smmta|g' \
      -e 's|__SMMTA_NODE_BIN__|/home/smmta/.nvm/versions/node/v22.22.2/bin/node|g' \
      /home/smmta/smmta-next/infra/systemd/smmta-supplier-poll.service.template \
      > /etc/systemd/system/smmta-supplier-poll.service
  cp /home/smmta/smmta-next/infra/systemd/smmta-supplier-poll.timer.template \
     /etc/systemd/system/smmta-supplier-poll.timer
"
sudo systemctl daemon-reload
sudo systemctl enable --now smmta-supplier-poll.timer
```

## Manual — force a poll right now

Three equivalent ways, from most-to-least convenient:

### 1. From the admin SPA

**Suppliers → \<supplier name\> → Drop-ship tab → "Poll now"** button.

Wait ~30 seconds for the supplier API call to complete. The
polling-log row at the bottom of the tab will update with
`productsChecked` / `productsUpdated` counts.

### 2. Trigger the systemd service outside the timer

```bash
sudo systemctl start smmta-supplier-poll.service
sudo journalctl -u smmta-supplier-poll -n 50 --no-pager
```

### 3. Run the script directly (debugging)

```bash
cd ~/smmta-next
set -a; . ./apps/api/.env; set +a
npx tsx apps/api/scripts/run-supplier-poll.ts
```

The script's stdout shows per-supplier counts and any errors. Useful
when the supplier API is misbehaving and you need to see the raw
response.

## Verify a poll worked

```bash
psql "$DATABASE_URL" -c "
  SELECT
    s.slug,
    COUNT(*)                                          AS rows,
    COUNT(*) FILTER (WHERE sp.last_known_stock IS NOT NULL) AS with_stock,
    COUNT(*) FILTER (WHERE sp.last_known_stock > 0)         AS in_stock,
    MAX(sp.last_polled_at)                            AS last_poll
  FROM supplier_products sp
  JOIN suppliers s ON s.id = sp.supplier_id
  WHERE s.is_dropship_active = true
  GROUP BY s.slug;
"
```

`with_stock` should be close to `rows` (every SKU got a snapshot).
`last_poll` should be within the last hour after a manual run, or
within the supplier's `pollIntervalMinutes` window for the automatic
timer.

If `with_stock` is much smaller than `rows`, the supplier's API
returned partial data — check `supplier_products.last_poll_error`
on the affected rows for the specific reason (`sku_not_found`,
`api_error`, etc).

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `Cannot find module '.../node_modules/.bin/tsx'` | `tsx` not installed at root. `cd ~/smmta-next && npm install --include=dev -w @smmta/api`. |
| `SupplierAuthError` in logs | API key rotated or revoked. Re-enter via admin SPA → Suppliers → Drop-ship tab → API key field. |
| `SupplierUnreachableError` | Supplier API down or VPS network issue. Retried automatically by the worker — check again in 30 minutes. |
| `last_polled_at` not updating | Timer not running, or the worker is skipping the supplier because its `pollIntervalMinutes` hasn't elapsed. Check `is_dropship_active = true` on the supplier row. |
| Products still show "Out of stock" after a successful poll | Storefront has cached data. With `force-dynamic` on the catalogue pages, a refresh should clear it. If not, `systemctl restart smmta-clothes-store`. |

## Related

- `docs/runbooks/store-cannot-reach-api.md` — if the storefront can't see updates at all
- `apps/api/src/workers/supplier-poll.worker.ts` — worker implementation
- `apps/api/src/integrations/suppliers/UNEEK_API_NOTES.md` — Uneek-specific quirks
