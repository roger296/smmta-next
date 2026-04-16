# SMMTA-Next — Frontend VPS Deployment Guide

> This guide picks up from `VPS-SETUP-GUIDE.md` (the API is already running on your VPS). It covers deploying the React frontend behind Nginx with HTTPS and a custom domain.
>
> **Every command below is a standalone copy-paste block.** Paste the whole block into your SSH session and press Enter.

---

## Overview

```
Internet ──HTTPS(443)──► Nginx ──┬──► /api/*  → localhost:3000  (Node API via systemd)
                                 └──► /*      → /var/www/smmta-web/  (React static SPA)
```

Prerequisites:
- VPS from the earlier guide (Ubuntu 24.04, Node 22, Docker running Postgres+Redis)
- A domain name you own
- SSH access to the VPS

---

## Step 1 — Log in and set your domain variable

Replace `smmta.example.com` with your actual domain, then paste:

```bash
ssh smmta@<YOUR_VPS_IP>
```

Once logged in, set the domain variable for this session (used throughout the guide):

```bash
export DOMAIN=smmta.example.com
echo "Deploying frontend for: $DOMAIN"
```

> If you log out and back in, re-run the `export DOMAIN=...` line. Or add it to `~/.bashrc`.

---

## Step 2 — Pull the latest code

```bash
cd ~/smmta-next && git pull origin main
```

---

## Step 3 — Install dependencies

```bash
cd ~/smmta-next && npm install
```

If this gets killed on a small VPS (< 2GB RAM), add swap first:

```bash
sudo fallocate -l 2G /swapfile && \
sudo chmod 600 /swapfile && \
sudo mkswap /swapfile && \
sudo swapon /swapfile && \
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Then retry `npm install`.

---

## Step 4 — Build the frontend

Create the production `.env` telling the frontend to use a relative API path:

```bash
cat > ~/smmta-next/apps/web/.env.production <<'EOF'
VITE_API_BASE_URL=/api/v1
EOF
```

Build:

```bash
cd ~/smmta-next/apps/web && npm run build
```

Verify the output:

```bash
ls ~/smmta-next/apps/web/dist/
```

You should see `assets/  index.html  vite.svg`.

---

## Step 5 — Point your domain at the VPS

### On your domain registrar's DNS panel

Add an **A record**:

| Type | Host        | Value               | TTL |
|------|-------------|---------------------|-----|
| A    | `smmta`     | `<YOUR_VPS_IP>`     | 300 |

(Use `@` as Host to cover the root domain instead of a subdomain.)

### Confirm DNS has propagated

Run this repeatedly until it returns your VPS IP:

```bash
nslookup $DOMAIN
```

**Do not continue to SSL (Step 7) until this resolves.** Let's Encrypt will fail otherwise. DNS usually takes 5-60 minutes.

---

## Step 6 — Install Nginx and serve the frontend over HTTP

### Install Nginx

```bash
sudo apt update && sudo apt install -y nginx
```

### Copy the built frontend

```bash
sudo mkdir -p /var/www/smmta-web && \
sudo cp -r ~/smmta-next/apps/web/dist/* /var/www/smmta-web/ && \
sudo chown -R www-data:www-data /var/www/smmta-web
```

### Write the Nginx site config

This single heredoc creates the complete config using your `$DOMAIN`:

```bash
sudo tee /etc/nginx/sites-available/smmta >/dev/null <<EOF
server {
    listen 80;
    server_name $DOMAIN;

    root /var/www/smmta-web;
    index index.html;

    # API reverse proxy
    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 60s;
    }

    # Health check (optional — useful for monitoring)
    location /health {
        proxy_pass http://127.0.0.1:3000;
    }

    # SPA fallback — unknown paths return index.html so TanStack Router can handle them
    location / {
        try_files \$uri \$uri/ /index.html;
    }

    # Asset caching
    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # Never cache index.html
    location = /index.html {
        add_header Cache-Control "no-store";
    }
}
EOF
```

### Enable the site

```bash
sudo ln -sf /etc/nginx/sites-available/smmta /etc/nginx/sites-enabled/ && \
sudo rm -f /etc/nginx/sites-enabled/default && \
sudo nginx -t && \
sudo systemctl reload nginx
```

Expected output includes: `nginx: configuration file ... test is successful`.

### Open firewall ports 80 + 443

```bash
sudo ufw allow 'Nginx Full' && sudo ufw status
```

### Verify HTTP

In your browser, visit `http://<YOUR_DOMAIN>` — you should see the SMMTA login page.

---

## Step 7 — Install HTTPS via Let's Encrypt (Certbot)

### Install Certbot

```bash
sudo apt install -y certbot python3-certbot-nginx
```

### Request and install the certificate

This will prompt you for email, terms agreement, and whether to redirect HTTP→HTTPS. **Choose option 2 (Redirect)** when asked.

```bash
sudo certbot --nginx -d $DOMAIN
```

When done you'll see `Congratulations! You have successfully enabled HTTPS on https://$DOMAIN`.

### Verify HTTPS

In your browser: **`https://<YOUR_DOMAIN>`** — padlock icon in the URL bar.

From the VPS:

```bash
curl -I http://$DOMAIN
```

Should return `HTTP/1.1 301 Moved Permanently` with a `Location: https://...` header.

### Test auto-renewal

```bash
sudo certbot renew --dry-run
```

Should end with `Congratulations, all simulated renewals succeeded`. Your cert will now auto-renew forever.

---

## Step 8 — Run the API as a systemd service

Right now the API dies when you log out. Let's make it a managed service.

### Find your node binary path

```bash
which npx
```

Copy the output (likely `/home/smmta/.nvm/versions/node/v22.22.2/bin/npx` if you used nvm, or `/usr/bin/npx` for NodeSource). You'll paste it into the next command as `NPX_PATH`.

### Write the service file

Run this heredoc, replacing `/home/smmta/.nvm/versions/node/v22.22.2/bin/npx` with your actual `which npx` output if different:

```bash
NPX_PATH=$(which npx)

sudo tee /etc/systemd/system/smmta-api.service >/dev/null <<EOF
[Unit]
Description=SMMTA-Next API
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=smmta
WorkingDirectory=/home/smmta/smmta-next/apps/api
EnvironmentFile=/home/smmta/smmta-next/apps/api/.env
Environment=NODE_ENV=production
ExecStart=$NPX_PATH tsx src/server.ts
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=smmta-api

[Install]
WantedBy=multi-user.target
EOF
```

### Stop any manual API process and start the service

```bash
lsof -ti :3000 | xargs -r kill -9 ; \
sudo systemctl daemon-reload && \
sudo systemctl enable smmta-api && \
sudo systemctl start smmta-api && \
sudo systemctl status smmta-api --no-pager
```

Should end with `active (running)`.

### If it fails to start

Check logs:

```bash
sudo journalctl -u smmta-api -n 50 --no-pager
```

Most common fix — wrong node path. Redo Step 8 with `which npx` output pasted correctly.

### Useful service commands

Copy whichever you need:

```bash
sudo systemctl restart smmta-api                        # restart after changes
sudo systemctl stop smmta-api                           # stop
sudo journalctl -u smmta-api -f                         # tail logs (Ctrl+C to exit)
sudo journalctl -u smmta-api --since "1 hour ago"       # recent logs
```

---

## Step 9 — End-to-end smoke test

Generate a fresh JWT token:

```bash
cd ~/smmta-next/apps/api && npx tsx generate-test-token.ts
```

Copy the long `eyJ...` token. In your browser:

1. Visit `https://<YOUR_DOMAIN>`
2. Paste the token into the login screen
3. You should land on the dashboard
4. Navigate Customers → New customer → create one → confirm it persists

If anything breaks, see Troubleshooting at the bottom.

---

## Step 10 — Create a deploy script for future updates

One command to pull, rebuild, and restart:

```bash
cat > ~/deploy.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo "→ Pulling..."
cd ~/smmta-next && git pull origin main
echo "→ Installing deps..."
npm install
echo "→ Building frontend..."
cd apps/web && npm run build
echo "→ Copying to /var/www..."
sudo cp -r dist/* /var/www/smmta-web/
echo "→ Restarting API..."
sudo systemctl restart smmta-api
echo "✓ Deploy complete — https://$DOMAIN"
EOF
chmod +x ~/deploy.sh
```

Future deploys are just:

```bash
~/deploy.sh
```

---

## Step 11 — Security hardening (recommended)

### 11.1 Bind API to localhost only

Edit `.env` to prevent the API from being reachable on a public port even if the firewall is misconfigured:

```bash
sed -i 's/^HOST=.*/HOST=127.0.0.1/' ~/smmta-next/apps/api/.env && \
sudo systemctl restart smmta-api
```

Verify:

```bash
grep ^HOST ~/smmta-next/apps/api/.env
```

Should show `HOST=127.0.0.1`.

### 11.2 Close port 3000 in the firewall (if open)

```bash
sudo ufw delete allow 3000/tcp 2>/dev/null ; sudo ufw status
```

Only ports 22 (SSH), 80, 443 should be `ALLOW`.

### 11.3 Add HTTP security headers

This command appends security headers to your Nginx config:

```bash
sudo sed -i '/server_name/a\    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;\n    add_header X-Content-Type-Options "nosniff" always;\n    add_header X-Frame-Options "DENY" always;\n    add_header Referrer-Policy "strict-origin-when-cross-origin" always;' /etc/nginx/sites-available/smmta && \
sudo nginx -t && \
sudo systemctl reload nginx
```

### 11.4 Enable automatic security updates

```bash
sudo apt install -y unattended-upgrades && \
echo 'unattended-upgrades unattended-upgrades/enable_auto_updates boolean true' | sudo debconf-set-selections && \
sudo dpkg-reconfigure -f noninteractive unattended-upgrades
```

### 11.5 Disable SSH password login (only do this after confirming key auth works)

First confirm your key works — from your PC:

```bash
ssh smmta@<YOUR_VPS_IP>
```

If that logs you in without a password prompt, you're good. On the VPS:

```bash
sudo sed -i 's/^#*PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config && \
sudo sed -i 's/^#*PermitRootLogin .*/PermitRootLogin no/' /etc/ssh/sshd_config && \
sudo systemctl reload sshd
```

---

## Troubleshooting

### "502 Bad Gateway"

The API is down. Run:

```bash
sudo systemctl status smmta-api --no-pager && curl http://127.0.0.1:3000/health
```

### Blank page / 404 on assets

Files aren't in `/var/www/smmta-web/`. Re-run:

```bash
sudo cp -r ~/smmta-next/apps/web/dist/* /var/www/smmta-web/ && sudo systemctl reload nginx
```

### Certbot "DNS problem"

DNS hasn't propagated yet. Wait, then retry:

```bash
sudo certbot --nginx -d $DOMAIN
```

### "401 Unauthorized" after logging in

Fresh token needed:

```bash
cd ~/smmta-next/apps/api && npx tsx generate-test-token.ts
```

### "Mixed content" warnings in browser console

Frontend is calling `http://` from an `https://` page. Rebuild with correct `.env.production`:

```bash
cat ~/smmta-next/apps/web/.env.production  # should print VITE_API_BASE_URL=/api/v1
cd ~/smmta-next/apps/web && npm run build && \
sudo cp -r dist/* /var/www/smmta-web/
```

### Browser caching old frontend after deploy

Hard refresh: **Ctrl+Shift+R** (Windows/Linux) or **Cmd+Shift+R** (Mac).

### Delete a cert (if you want to start over)

```bash
sudo certbot delete --cert-name $DOMAIN
```

### View recent API logs

```bash
sudo journalctl -u smmta-api -n 100 --no-pager
```

### View recent Nginx errors

```bash
sudo tail -n 50 /var/log/nginx/error.log
```

---

## Deployment checklist

Tick as you go:

- [ ] Logged in and set `export DOMAIN=...`
- [ ] `git pull origin main`
- [ ] `npm install`
- [ ] `.env.production` created
- [ ] `npm run build` succeeds
- [ ] DNS A record added and `nslookup` confirms it
- [ ] Nginx installed
- [ ] `dist/*` copied to `/var/www/smmta-web/`
- [ ] Nginx config written + site enabled
- [ ] `nginx -t` passes
- [ ] ufw allows ports 80 + 443
- [ ] HTTP loads the login page
- [ ] Certbot ran successfully
- [ ] HTTPS loads with padlock
- [ ] `certbot renew --dry-run` passes
- [ ] systemd service file created
- [ ] Service is `active (running)`
- [ ] Reboot test — service comes back up
- [ ] Token generated + login works over HTTPS
- [ ] Deploy script `~/deploy.sh` created
- [ ] API bound to 127.0.0.1
- [ ] Only ports 22+80+443 in ufw
- [ ] Security headers added to Nginx
- [ ] Unattended upgrades enabled

🚀 **You're live.**
