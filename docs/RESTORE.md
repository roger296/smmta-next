# Disaster recovery — restore runbook

The whole system's state lives in one Postgres database (`smmta_next`): products,
orders, pre-orders, stock, subscriptions, the domain-event log, **and** pg-boss's
pending jobs. So a single `pg_dump` is a full-system snapshot, and a single
restore brings everything back.

## Nightly backups

`infra/backup.sh` runs a `pg_dump -Fc` and pushes it off-box via rclone
(`BACKUP_RCLONE_REMOTE`). Wire it to a systemd timer or cron at ~03:00. Retains
14 local dumps.

```bash
DATABASE_URL=postgresql://smmta:...@localhost:5432/smmta_next \
BACKUP_RCLONE_REMOTE=b2:my-bucket/smmta \
bash infra/backup.sh
```

## Restore (fresh VPS or point-in-time)

1. Bring up Postgres (the installer / `docker compose up -d postgres`).
2. Create an empty target DB if needed:
   `docker compose exec postgres psql -U smmta -c 'CREATE DATABASE smmta_next;'`
3. Restore the latest dump:
   ```bash
   bash infra/restore.sh /home/smmta/backups/smmta_next_YYYYMMDDTHHMMSSZ.dump \
     postgresql://smmta:...@localhost:5432/smmta_next
   ```
4. Verify:
   ```bash
   psql "$DATABASE_URL" -c 'SELECT count(*) FROM domain_events;'
   psql "$DATABASE_URL" -c "SELECT name, count(*) FROM pgboss.job GROUP BY name;"
   ```
5. Start `smmta-api` + `smmta-worker`; hit `/healthz` on each.

## Test a restore BEFORE launch

On the home-lab staging box: take a production dump, restore into a throwaway DB,
run `npm run gate` against it, and confirm `/healthz` reports `db: true` and
`pgboss: true`. Do this at least once before going live and after any major
schema change.
