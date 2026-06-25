# Runbook — deploy the stock-take-lite PWA (P26)

The standalone iPad stock-take demo: a static Vite bundle served by nginx, plus
the `stocktake-lite` API module (inside `apps/api`). The output is a plain CSV.

This is written for the case where **Auto-Stock has not been deployed live yet**,
so it stands up the API + Postgres first (via the tested `install-autostock.sh`),
then layers the stock-take site on top. Target host:
`stocktake.starship.thebigbakes.com`, branch `autostock`.

After the one-off below, every future update is one command:

```bash
~/smmta-next/infra/scripts/deploy-stocktake.sh autostock
```

---

## Prerequisites

- A fresh Ubuntu 22.04/24.04 VPS, 2+ CPU / 4 GB RAM, with a sudo user and SSH.
- The `autostock` branch pushed to GitHub (done from the dev PC).
- DNS control for `thebigbakes.com`.

---

## 1. (dev PC, PowerShell) push the branch — already done

```powershell
cd "C:\Users\roger\Big bakes\auto-stock"
git push -u origin autostock
```

> Never merge to `main` for this — `main` is Filament Store production.

---

## 2. DNS — point the host at the VPS

At your DNS provider, add an **A record**:

| Type | Host                 | Value      | TTL |
|------|----------------------|------------|-----|
| A    | `stocktake.starship` | `<VPS_IP>` | 300 |

Confirm it resolves before TLS (step 6):

```bash
nslookup stocktake.starship.thebigbakes.com
```

---

## 3. Provision the API + database (on the VPS, as root)

This installs Docker + nginx + certbot + Node 22, clones the repo, checks out
`autostock`, brings up Postgres, runs migrations (incl. `0036`), writes
`apps/api/.env` (with the stock-take access code), and starts the `smmta-api`
systemd service. Pick a real access code.

```bash
sudo SMMTA_NONINTERACTIVE=1 \
     SMMTA_BRANCH=autostock \
     SMMTA_BUSINESS_NAME="Big Bakes" \
     SMMTA_ADMIN_HOST=stocktake.starship.thebigbakes.com \
     SMMTA_ADMIN_EMAIL=admin@thebigbakes.com \
     SMMTA_ADMIN_PASSWORD='change-me' \
     SMMTA_LE_EMAIL=admin@thebigbakes.com \
     SMMTA_STOCKTAKE_CODE='<pick-a-shared-code>' \
     bash /home/smmta/smmta-next/infra/install-autostock.sh
```

> First time on a brand-new box you won't have the repo yet. Either clone it
> first (`sudo -u smmta git clone https://github.com/roger296/smmta-next.git
> /home/smmta/smmta-next`) then run the line above, or download just the script
> and run it — it clones for you. The `apps/web` admin SPA + the four background
> timers are installed too but aren't exposed publicly; they're harmless for the
> demo (Square/BumbleBee polls are no-ops until configured).

Verify the API:

```bash
curl -fsS http://127.0.0.1:3000/health && echo "  API up"
```

---

## 4. Build + publish the stock-take PWA (on the VPS, as smmta)

```bash
sudo -iu smmta
cd ~/smmta-next
npm run build -w @smmta/stocktake
sudo mkdir -p /var/www/stocktake-web
sudo cp -r apps/stocktake/dist/* /var/www/stocktake-web/
sudo chown -R www-data:www-data /var/www/stocktake-web
```

---

## 5. nginx site (HTTP first)

```bash
sed "s|__STOCKTAKE_HOST__|stocktake.starship.thebigbakes.com|g" \
  ~/smmta-next/infra/nginx/stocktake.conf.template \
  | sudo tee /etc/nginx/sites-available/stocktake >/dev/null
sudo ln -sf /etc/nginx/sites-available/stocktake /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo ufw allow 'Nginx Full' 2>/dev/null || true
```

The template keeps the TLS lines commented so nginx boots on port 80; certbot
fills them in next.

---

## 6. TLS via certbot

```bash
sudo certbot --nginx -d stocktake.starship.thebigbakes.com
```

Choose **Redirect**. Verify end to end:

```bash
curl -I https://stocktake.starship.thebigbakes.com
curl -s "https://stocktake.starship.thebigbakes.com/api/v1/stocktake-lite/sites?period=JUNE-2026" \
  -H 'x-stocktake-code: <pick-a-shared-code>'      # → {"success":true,"data":[]}
```

---

## 7. Install on the iPads

1. Safari → `https://stocktake.starship.thebigbakes.com`
2. Share → **Add to Home Screen** → installs as "Stock Take".
3. Open it, pick the site, type your name + the access code, count.

Head office: `…/#/consolidate` → Load sites → settle conflicts → **Export all
sites**.

---

## Future updates (one command)

```bash
~/smmta-next/infra/scripts/deploy-stocktake.sh autostock
```

Pulls `autostock`, installs, migrates, restarts the API, rebuilds + republishes
the PWA, reloads nginx.

## Troubleshooting

- **401 from /api** — `x-stocktake-code` header ≠ `STOCKTAKE_ACCESS_CODE` in
  `apps/api/.env`. Fix + `sudo systemctl restart smmta-api`.
- **502 on /api** — API down: `sudo systemctl status smmta-api` /
  `sudo journalctl -u smmta-api -n 50`.
- **Blank / stale page** — hard refresh; the deploy script wipes
  `/var/www/stocktake-web` each run so the new bundle always wins.
- **certbot DNS error** — DNS not propagated yet; wait and re-run step 6.
