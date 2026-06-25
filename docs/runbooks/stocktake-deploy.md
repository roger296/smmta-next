# Runbook — deploy the stock-take-lite PWA (P26)

The standalone iPad stock-take demo: a static Vite bundle served by nginx, plus
the `stocktake-lite` API module (inside `apps/api`). Output is a plain CSV.

There are two topologies. **B is what's live** (on the `striped-acrobats` /
`165.84.215.138` smmta-next box, deployed 2026-06-25).

- **A — dedicated box.** Auto-Stock is the only thing on the server: run
  `infra/install-autostock.sh` with `SMMTA_BRANCH=autostock` to stand up the API
  + Postgres + systemd, then layer the stock-take site on top.
- **B — side-by-side with Filament Store.** The box already runs Filament + the
  Clothes Shop + their API on `:3000` from `~/smmta-next` (branch `main`). To
  avoid breaking any of that, the demo runs **fully isolated**: a second clone, a
  second database, and a second API on its own port. Filament is never touched.

---

## Topology B — side-by-side (the live setup)

Isolation summary:

| Concern        | Filament (existing)      | Stock-take demo (new)              |
|----------------|--------------------------|------------------------------------|
| Repo checkout  | `~/smmta-next` (`main`)  | `~/auto-stock` (`autostock`)       |
| Database       | `smmta_next`             | `autostock` (same PG container)    |
| API service    | `smmta-api` on `:3000`   | `autostock-api` on `:3001`         |
| Web root       | (its own)                | `/var/www/stocktake-web`           |
| Hostname       | filament.shop…           | `stocktake.starship.thebigbakes.com` → `165.84.215.138` |

### One-off steps (performed)

1. **Push the branch** (dev PC): `git push -u origin autostock`. Never merge to
   `main` — that's Filament production.
2. **Clone + install:**
   ```bash
   git clone -b autostock https://github.com/roger296/smmta-next.git ~/auto-stock
   cd ~/auto-stock && npm install --no-audit --no-fund
   npm run build -w @smmta/shared-types
   ```
3. **Isolated database:**
   ```bash
   docker exec smmta-next-postgres-1 psql -U smmta -d postgres -c "CREATE DATABASE autostock;"
   ```
4. **Isolated `~/auto-stock/apps/api/.env`** — `PORT=3001`, `HOST=127.0.0.1`,
   `DATABASE_URL=…/autostock` (reuse the `smmta` role + password from the Filament
   `.env`), fresh `JWT_SECRET` + `COMPANY_ID`, dormant flags off, and
   `STOCKTAKE_ACCESS_CODE=<shared code>`.
5. **Migrate the isolated DB** (explicit URL so it can only touch `autostock`):
   ```bash
   cd ~/auto-stock/apps/api
   DATABASE_URL="$(grep -oP '^DATABASE_URL=\K.*' .env)" npx drizzle-kit migrate
   ```
6. **Second API service** `/etc/systemd/system/autostock-api.service` — copy the
   working `smmta-api.service` but with: `WorkingDirectory`/`EnvironmentFile` under
   `~/auto-stock`, `Environment=PATH=<nvm bin>:…`, and
   `ExecStart=<nvm>/bin/node ~/auto-stock/node_modules/.bin/tsx src/server.ts`
   (systemd's minimal PATH can't find nvm `node` via `npx`'s shebang otherwise).
   Then `sudo systemctl daemon-reload && sudo systemctl enable --now autostock-api`.
7. **Build + publish the PWA:**
   ```bash
   cd ~/auto-stock && npm run build -w @smmta/stocktake
   sudo mkdir -p /var/www/stocktake-web && sudo rm -rf /var/www/stocktake-web/*
   sudo cp -r apps/stocktake/dist/* /var/www/stocktake-web/
   sudo chown -R www-data:www-data /var/www/stocktake-web
   ```
8. **nginx site (HTTP only first)** — `/etc/nginx/sites-available/stocktake`,
   `server_name stocktake.starship.thebigbakes.com`, `root /var/www/stocktake-web`,
   SPA fallback, `location = /sw.js { Cache-Control no-cache }`, and
   `location /api/ { proxy_pass http://127.0.0.1:3001; }`. Enable, `nginx -t`,
   reload. (Don't ship a `listen 443 ssl` block before the cert exists — certbot
   adds it.)
9. **DNS** — A record `stocktake.starship` → `165.84.215.138` (a specific record
   overrides any `*.starship` wildcard pointing at the Coolify box `.110`).
10. **TLS** — `sudo certbot --nginx -d stocktake.starship.thebigbakes.com`
    (choose Redirect). certbot adds the `:443` block + the HTTP→HTTPS redirect.

### Future updates (one command)

```bash
SMMTA_REPO_DIR=~/auto-stock STOCKTAKE_API_SERVICE=autostock-api STOCKTAKE_API_PORT=3001 \
  ~/auto-stock/infra/scripts/deploy-stocktake.sh autostock
```

Pulls `autostock`, installs, builds shared-types, migrates the `autostock` DB,
restarts `autostock-api`, rebuilds + republishes the PWA, reloads nginx.

---

## Topology A — dedicated box

```bash
sudo SMMTA_NONINTERACTIVE=1 SMMTA_BRANCH=autostock \
     SMMTA_ADMIN_HOST=stocktake.starship.thebigbakes.com \
     SMMTA_ADMIN_EMAIL=admin@thebigbakes.com SMMTA_ADMIN_PASSWORD='change-me' \
     SMMTA_LE_EMAIL=admin@thebigbakes.com SMMTA_STOCKTAKE_CODE='<code>' \
     bash infra/install-autostock.sh
```
Then DNS → that box, build/publish the PWA, nginx site (proxy `/api` → `:3000`),
certbot. Future updates: `~/smmta-next/infra/scripts/deploy-stocktake.sh autostock`.

---

## Install on the iPads

1. Safari → `https://stocktake.starship.thebigbakes.com`
2. Share → **Add to Home Screen** → installs as "Stock Take".
3. Open it, pick the site, type your name + the access code, count.

Head office: `…/#/consolidate` → Load sites → settle conflicts → **Export all
sites**.

## Troubleshooting

- **401 from /api** — `x-stocktake-code` ≠ `STOCKTAKE_ACCESS_CODE`; fix + restart
  the API service.
- **API won't start, `env: 'node': No such file`** — the systemd unit needs
  `Environment=PATH=<nvm bin>:…` and absolute `node`/`tsx` paths (see step 6).
- **502 on /api** — API down: `sudo systemctl status autostock-api` /
  `sudo journalctl -u autostock-api -n 50`.
- **Name resolves to the wrong box (.110)** — add a specific A record for
  `stocktake.starship` → `.138` to override the `*.starship` wildcard.
- **Blank / stale page** — hard refresh; the deploy script wipes the web root
  each run.
