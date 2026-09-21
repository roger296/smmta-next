# Deploying the New Filament Store on a fresh VPS with Coolify

This deploys all five services — **postgres, api, worker, store (storefront),
web (admin SPA)** — as a single **Docker Compose** resource in Coolify. The API
runs database migrations automatically on start; the worker consumes the same
Postgres. Everything is single-tenant.

Files that make this work (already in the repo):
`docker-compose.coolify.yml`, `docker/{api,worker,store,web}.Dockerfile`,
`docker/web-nginx.conf`, `docker/postgres-init/`.

No web shop? See **Back-office deployment (no storefront)** near the end: a
second compose file with postgres, api, worker and web only.

---

## 0. Before you start

- A VPS with **Coolify v4** installed and reachable on its dashboard URL.
- This repo pushed to a Git provider Coolify can read (GitHub via the Coolify
  GitHub App, or a public repo URL, or a private repo + deploy key).
- DNS **A records** pointing at the VPS IP for the hostnames you'll use, e.g.:
  - `shop.example.com`   → storefront
  - `admin.example.com`  → admin SPA
  - `api.example.com`    → API (needed for webhooks + the admin SPA if it calls
    the API cross-origin)

## 1. Generate secrets (once, locally)

```bash
# strong values — keep these safe
openssl rand -hex 32   # JWT_SECRET
openssl rand -hex 32   # UNSUBSCRIBE_SECRET
openssl rand -hex 24   # POSTGRES_PASSWORD
openssl rand -hex 24   # SENDGRID_WEBHOOK_KEY  (must match the SendGrid webhook signing key)
```

Keep `COMPANY_ID` at its default (`11111111-1111-4111-8111-111111111111`) unless
you have a reason not to.

## 2. Create the resource in Coolify

1. **Projects → + New → Project** (e.g. "Filament Store"), pick/create an
   Environment (e.g. `production`).
2. **+ New Resource → Docker Compose**.
3. **Source**: connect this Git repository and branch (`feat/new-filament-store`
   until it's merged to `main`).
4. **Compose file path**: `docker-compose.coolify.yml`.
5. Save. Coolify parses the compose and lists the five services.

## 3. Set environment variables (secrets)

In the resource's **Environment Variables** tab, add these (mark the secrets as
"secret"). Coolify substitutes them into the compose:

| Variable | Value |
|---|---|
| `POSTGRES_PASSWORD` | the value you generated |
| `JWT_SECRET` | generated |
| `UNSUBSCRIBE_SECRET` | generated |
| `SENDGRID_WEBHOOK_KEY` | generated (also set on the SendGrid webhook) |
| `COMPANY_ID` | `11111111-1111-4111-8111-111111111111` |
| `APP_BASE_URL` | `https://shop.example.com` |
| `SMMTA_API_BASE_URL` | `http://api:3000` (internal — the store calls the API over the compose network) |
| `MOLLIE_API_KEY` | your Mollie **test** key (`test_…`) for now |
| `OPENROUTER_API_KEY` | your OpenRouter key |
| `OPENROUTER_DAILY_CAP_MICROUSD` | `2000000` ($2/day) or your choice |
| `SENDGRID_API_KEY` | your SendGrid key (`SG.…`) |
| `SENDGRID_SANDBOX` | `true` until you've verified deliverability, then `false` |
| `SMMTA_API_KEY` | leave **blank for the first deploy** — you issue it in step 6 |
| `VITE_API_BASE_URL` | `https://api.example.com/api/v1` (baked into the admin SPA at build) |

> The compose marks `POSTGRES_PASSWORD`, `JWT_SECRET`, `UNSUBSCRIBE_SECRET`,
> `SMMTA_API_KEY` as required (`:?`). `SMMTA_API_KEY` is needed by the **store**
> service only, so if the first deploy errors on it, set it to any placeholder to
> get the API up, then do step 6 and redeploy the store.

## 4. Assign domains + TLS

For each public service, open the service in Coolify and set its **Domain**
(Coolify provisions Let's Encrypt automatically):

- `store` → `https://shop.example.com`  (container port **3000**)
- `web`   → `https://admin.example.com` (container port **80**)
- `api`   → `https://api.example.com`   (container port **3000**)

`postgres` and `worker` stay internal (no domain). The `worker` health port
(3100) is internal only.

### Drop-ship suppliers (worker)

The worker env carries these; all are optional and safe at their defaults.

| Variable | Default | What it does |
|---|---|---|
| `SUPPLIER_POLL_ENABLED` | `false` | Poll each drop-ship supplier's stock and cost prices on its own interval. |
| `SUPPLIER_ORDER_PLACING_ENABLED` | `false` | Send paid orders' drop-ship lines to the supplier. **Real orders** — turn on only after a test order. |
| `SUPPLIER_ORDER_ALERT_EMAIL` | `roger@etailsupport.com` | Emailed when a supplier order fails. Needs `SENDGRID_API_KEY` and `SENDGRID_SANDBOX=false` to arrive. |
| `SUPPLIER_ORDER_CONTACT_EMAIL` | `sales@cleverdeals.net` | Our contact address on each supplier order. |
| `UNEEK_DELIVERY_METHOD` | empty | Uneek's delivery-method code; ask Uneek. |

The worker also reads `JWT_SECRET`, the same value as the api: supplier
credentials are encrypted with a key derived from it.

## 5. Deploy

Click **Deploy**. Coolify builds the four images (first build ~a few minutes) and
starts everything. The API container runs `drizzle-kit migrate` on boot, so the
schema is created automatically. Watch the `api` logs for
`migrations applied successfully` and then the Fastify listen line. Check
`https://api.example.com/healthz` → `{"status":"ok","checks":{"db":true,...}}`.

## 6. One-time bootstrap (admin user + storefront key)

Open a shell into the **api** container (Coolify → api service → **Terminal**, or
`docker exec -it <api-container> sh`) and run:

```sh
cd /app/apps/api

# First admin operator (SPA login).
npx tsx scripts/create-user.ts --email you@example.com --name "You" --password 'a-strong-password'

# Issue the storefront API key (prints KEY=smmta_<prefix>_<secret>).
npx tsx scripts/issue-store-key.ts

# (optional) seed a little dev catalogue to click around.
npx tsx scripts/seed-dev.ts
```

Copy the `smmta_…` key, set it as **`SMMTA_API_KEY`** in Coolify's env vars, and
**redeploy the `store` service** (Coolify → store → Redeploy). The storefront can
now read the catalogue/pricing from the API.

## 7. Point the provider webhooks at the API

- **Mollie** dashboard → Webhooks → `https://api.example.com/api/v1/webhooks/mollie`
- **SendGrid** → Settings → Mail Settings / Event Webhook →
  `https://api.example.com/api/v1/webhooks/sendgrid`, and set the **signing key**
  to the same value as `SENDGRID_WEBHOOK_KEY`.
- Verify SPF + DKIM for your sending subdomain (see `docs/HUMAN-OPS.md`).

## 8. Backups

Add a Coolify **Scheduled Task** (or a host cron) that runs the backup against
the Postgres service, e.g. nightly `pg_dump -Fc` pushed to Backblaze B2 — see
`infra/backup.sh` and `docs/RESTORE.md`. **Test a restore before you rely on it.**

## 9. Going live checklist

- [ ] `SENDGRID_SANDBOX=false` once deliverability (SPF/DKIM) is confirmed.
- [ ] Swap `MOLLIE_API_KEY` from `test_…` to the live key; request **Pay by Bank**
      activation from Mollie (needed for the >30-day pre-order rule).
- [ ] Set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` for storefront social login
      (add them to the `store` service env; NextAuth wiring is the storefront pass).
- [ ] `SENTRY_ENABLED=true` + `SENTRY_DSN` for error alerts (optional).
- [ ] Verify `/healthz` on the API and (if exposed) the worker.

---

## Back-office deployment (no storefront)

A business that takes its orders from a CSV feed, an API feed or the admin
screens, and never from a web shop, deploys
**`docker-compose.coolify.backoffice.yml`** instead. It carries four services:
**postgres, api, worker, web**. The storefronts, the outbox drainer and every
storefront-only variable are left out; the comment at the top of the file says
what is missing and why. (It is a separate file because Coolify does not honour
compose profiles.)

Follow the steps above with these differences:

1. **Compose file path**: `docker-compose.coolify.backoffice.yml`.
2. **Secrets**: generate a fresh `COMPANY_ID` as well (`uuidgen`, or
   `python3 -c "import uuid; print(uuid.uuid4())"`). The file requires it: the
   default id in the code belongs to the reference deployment, and a new
   business must not share it. Set `ENCRYPTION_KEY` too (`openssl rand -hex 32`)
   so credentials held on admin records survive a later `JWT_SECRET` rotation.
   `SMMTA_API_KEY`, `STORE_COOKIE_SECRET`, `MOLLIE_API_KEY` and the
   `STORE_*` values are not needed.
3. **Domains**: `web` → `https://admin.example.com` (port 80). The SPA's nginx
   proxies `/api/` to the api service on the internal network, so the API needs
   no hostname of its own unless something outside the network must call it
   (an order feed posting to the API, a SendGrid webhook). If it does, give
   `api` a domain (port 3000) and set `APP_BASE_URL` to it.
4. **Bootstrap**: only the admin user. Skip `issue-store-key.ts`; there is no
   storefront to hold a key. A key for an external order feed is issued from
   the API's `/api/v1/admin/api-keys` route with only the scopes that feed
   needs.
5. **Shipping labels**: set the `SMOOTH_PARCEL_*` values for this business's
   own Smooth Parcel account and `SMOOTH_PARCEL_ENABLED=true` once a test label
   has been checked.
6. **Feature switches**: drop-ship polling and ordering, Google feeds, the
   sales assistant and Mollie are all off by default and stay off.

Coolify keeps the first-deployed value of every `${VAR:-default}` in the compose
file. Changing a default in the repo later does not reach the containers; edit
the value in Coolify.

---

### Alternative: one application per service

If you prefer separate Coolify **Applications** (independent scaling/redeploys)
instead of Compose: create four Applications, each pointing at this repo with its
respective Dockerfile (`docker/<svc>.Dockerfile`, build context = repo root), and
one **Database → PostgreSQL** resource; wire `DATABASE_URL` to the managed
Postgres and put the same env vars on each app. The Compose route above is
simpler for a single-VPS deploy and is recommended.
