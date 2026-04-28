# Backups & restore — `smmta_store`

The storefront database (`smmta_store`) is separate from the
SMMTA-NEXT operational database (`smmta_next`) and needs its own
backup line in the host's existing backup job.

## What's in `smmta_store`

- `carts`, `cart_items` — cookie-id-keyed shopping baskets.
- `checkouts` — in-flight checkouts (PII: customer email + addresses
  on `customer` / `delivery_address` / `invoice_address` JSONB).
- `mollie_payments`, `mollie_refunds` — what we believe Mollie
  thinks. Re-fetched on every webhook delivery, so a 1-day RPO is
  acceptable; we can replay Mollie history to rebuild.
- `webhook_deliveries` — raw audit log. Best preserved (forensics).
- `idempotency_keys` — 7-day-relevant; older rows are noise.
- `email_outbox` — transactional email queue. Sent rows can be
  pruned; pending rows must be preserved across restore.

PII surface area: customer email + address on `checkouts.customer` /
`*_address`. UK GDPR data minimisation applies; backups inherit the
same deletion windows as live data.

## Adding to the existing backup

The host already runs nightly `pg_dump` of `smmta_next` via the
backup job at `/etc/cron.daily/smmta-backup` (existing infra; not
created by this prompt). Extend it to include the store DB:

```bash
# /etc/cron.daily/smmta-backup (extend, don't replace)
DUMP_DIR=/var/backups/smmta
DATE=$(date -u +%Y%m%d)

# Existing line for smmta_next:
sudo -u postgres pg_dump --format=custom --no-owner --no-privileges \
  smmta_next > "${DUMP_DIR}/smmta_next-${DATE}.dump"

# New line for smmta_store:
sudo -u postgres pg_dump --format=custom --no-owner --no-privileges \
  smmta_store > "${DUMP_DIR}/smmta_store-${DATE}.dump"

# Keep 14 days locally; rsync nightly to the off-site bucket.
find "${DUMP_DIR}" -name "smmta_*.dump" -mtime +14 -delete
```

Off-site retention follows the existing policy (encrypted bucket,
30-day retention).

## Restore

### Full restore (disaster recovery)

```bash
# 1. Stop the storefront so nothing writes during restore.
sudo systemctl stop smmta-store

# 2. Drop and re-create the database.
sudo -u postgres psql <<SQL
DROP DATABASE IF EXISTS smmta_store;
CREATE DATABASE smmta_store WITH OWNER smmta;
SQL

# 3. Restore from the most recent dump.
sudo -u postgres pg_restore --no-owner --no-privileges \
  --dbname=smmta_store /var/backups/smmta/smmta_store-YYYYMMDD.dump

# 4. Re-run drizzle migrations to confirm the schema is current.
cd /opt/smmta-next
sudo -u smmta npm run db:migrate -w @smmta/store

# 5. Restart the storefront.
sudo systemctl start smmta-store

# 6. Verify with /healthz + a manual catalogue read.
curl -fsS http://127.0.0.1:3000/healthz | jq .
```

### Restoring a single table (selective)

`pg_restore -t <table>` works for tables but not their indexes /
constraints. For most cases it's safer to restore into a temporary
DB and copy the rows you want with INSERT … SELECT.

## Test the restore

Once a quarter (or before any major schema change), restore the most
recent dump into a temp DB and confirm the storefront still boots
against it:

```bash
sudo -u postgres createdb smmta_store_restore_test
sudo -u postgres pg_restore --no-owner --dbname=smmta_store_restore_test \
  /var/backups/smmta/smmta_store-$(date -u +%Y%m%d).dump
DATABASE_URL=postgresql://smmta:smmta@localhost:5432/smmta_store_restore_test \
  npm run start -w @smmta/store
# Hit / once, confirm 200, then drop the temp DB.
```

A failed quarterly restore is a P1 — fix immediately, before the next
real outage forces it.
