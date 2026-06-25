# Runbook — deploy the stock-take-lite PWA (P26)

The standalone iPad stock-take demo: a static Vite bundle served by nginx, plus
the `stocktake-lite` API module (lives inside the already-running `apps/api`).
This runbook is the **one-off setup**. After it's done, every future update is a
single command:

```bash
~/smmta-next/infra/scripts/deploy-stocktake.sh <branch>
```

> Fill in the two placeholders before you start:
> - `STOCKTAKE_HOST` — the hostname, e.g. `stocktake.starship.thebigbakes.com`
> - `BRANCH` — the git branch the VPS tracks for Auto-Stock (e.g. `autostock` or `main`)

This runbook assumes the Auto-Stock API is **already deployed and running** on the
VPS (systemd unit `smmta-api`, Docker Postgres, nginx + certbot), per
`docs/VPS-FRONTEND-DEPLOYMENT.md`. If Auto-Stock has never been deployed on this
box, run `infra/install-autostock.sh` first.

---

## 0. Get the code to GitHub (from your PC, PowerShell)

The VPS pulls from GitHub, so the work must be pushed first. The Auto-Stock work
lives on the `autostock` branch.

```powershell
cd "C:\Users\roger\Big bakes\auto-stock"
git push -u origin autostock
```

> Do **not** merge into `main` unless you intend to: the Filament Store
> production box tracks `main` and pulls it on deploy.

---

## 1. DNS — point the host at the VPS

At your DNS provider for `thebigbakes.com`, add an **A record**:

| Type | Host (subdomain)        | Value      | TTL |
|------|-------------------------|------------|-----|
| A    | `stocktake.starship`    | `<VPS_IP>` | 300 |

Wait for it to resolve (from the VPS):

```bash
nslookup STOCKTAKE_HOST
```

Don't continue to TLS until this returns the VPS IP.

---

## 2. Set the shared access code (on the VPS)

The demo API is gated by a shared code, not logins. Add it to the API env and
restart:

```bash
echo 'STOCKTAKE_ACCESS_CODE=<pick-a-code>' >> ~/smmta-next/apps/api/.env
sudo systemctl restart smmta-api
```

Counters and head office type this code once per device.

---

## 3. First build + publish (on the VPS)

```bash
cd ~/smmta-next
git checkout BRANCH && git pull --ff-only origin BRANCH
npm install --no-audit --no-fund
( cd apps/api && npx drizzle-kit migrate )        # applies migration 0036
npm run build -w @smmta/stocktake
sudo mkdir -p /var/www/stocktake-web
sudo cp -r apps/stocktake/dist/* /var/www/stocktake-web/
sudo chown -R www-data:www-data /var/www/stocktake-web
```

---

## 4. nginx site (HTTP first, on the VPS)

```bash
sed "s|__STOCKTAKE_HOST__|STOCKTAKE_HOST|g" \
  ~/smmta-next/infra/nginx/stocktake.conf.template \
  | sudo tee /etc/nginx/sites-available/stocktake >/dev/null
sudo ln -sf /etc/nginx/sites-available/stocktake /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

The template has the TLS lines commented out so nginx starts on port 80; certbot
fills them in next.

---

## 5. TLS via certbot (on the VPS)

```bash
sudo certbot --nginx -d STOCKTAKE_HOST
```

Choose **Redirect** when asked. Verify:

```bash
curl -I https://STOCKTAKE_HOST            # 200 + serves index.html
curl -s https://STOCKTAKE_HOST/api/v1/stocktake-lite/sites?period=JUNE-2026 \
  -H 'x-stocktake-code: <pick-a-code>'    # {"success":true,"data":[]}
```

---

## 6. Install it on the iPads

1. Open Safari → `https://STOCKTAKE_HOST`
2. Share → **Add to Home Screen** → it installs as "Stock Take"
3. Open the icon, pick the site, enter your name + the access code, start counting.

Head office: `https://STOCKTAKE_HOST/#/consolidate` → load sites, settle any
conflicts, **Export all sites**.

---

## Future updates

```bash
~/smmta-next/infra/scripts/deploy-stocktake.sh BRANCH
```

Pulls, installs, migrates, restarts the API, rebuilds + republishes the PWA, and
reloads nginx.

## Troubleshooting

- **401 from /api** — the `x-stocktake-code` header doesn't match
  `STOCKTAKE_ACCESS_CODE` in `apps/api/.env`. Re-check + `sudo systemctl restart
  smmta-api`.
- **502 on /api** — API down: `sudo systemctl status smmta-api` +
  `curl http://127.0.0.1:3000/health`.
- **Blank page / old version** — hard refresh (the service worker caches the
  shell); the deploy script clears `/var/www/stocktake-web` each run.
- **certbot DNS error** — DNS hasn't propagated; wait and re-run step 5.
