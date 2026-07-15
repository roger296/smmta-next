# Deploying Auto-Stock to Coolify

The full app = **API** (Fastify + Drizzle + MCP) + **web** (admin SPA + iPad PWA) +
**Postgres** (+ Redis). This is a container deploy from `roger296/smmta-next` @
`autostock` using the Dockerfiles in `apps/api/` and `apps/web/`.

Target (first realistic-test deploy):

| | |
|---|---|
| Server | `165.84.215.138` (Coolify) |
| Web (app) | `https://stock.thebigbakes.com` |
| API | `https://stock-api.thebigbakes.com` |
| Repo / branch | `roger296/smmta-next` @ `autostock` |

## 0. DNS (do first — certs wait on it)

Two **A records** on `thebigbakes.com` → `165.84.215.138`:
`stock` and `stock-api`.

## 1. Postgres (Coolify → New Resource → PostgreSQL)

- Name e.g. `stock-db`. Coolify generates the credentials + an **internal**
  connection URL (`postgres://…@<service>:5432/…`). Copy it — it's the API's
  `DATABASE_URL`. No public port needed (API talks to it on the internal network).

## 2. Redis (Coolify → New Resource → Redis)

- Name e.g. `stock-redis`. Copy the internal URL → the API's `REDIS_URL`.
  (Precautionary; the stock features don't require it, but it keeps logs clean.)

## 3. API application (`stock-api`)

New Resource → **Application** → Public/Private Repository → `roger296/smmta-next`,
branch `autostock`. Build pack = **Dockerfile**.

- **Base directory:** `/`  ·  **Dockerfile location:** `/apps/api/Dockerfile`
- **Ports Exposes:** `8080` — Coolify often defaults this to `3000`; it MUST be
  `8080` or the router + health check hit the wrong port ("bad gateway").
- **Health check path:** `/health` (the api image ships `curl` for Coolify's
  in-container probe).
- **Domain:** `https://stock-api.thebigbakes.com`
- **Environment variables:**

  | Key | Value |
  |---|---|
  | `NODE_ENV` | `production` |
  | `PORT` | `8080` |
  | `DATABASE_URL` | *(the Postgres internal URL from step 1)* |
  | `REDIS_URL` | *(the Redis internal URL from step 2)* |
  | `JWT_SECRET` | *(generate: `openssl rand -hex 32`)* |
  | `ENCRYPTION_KEY` | *(generate: `openssl rand -hex 32`)* — **32-byte AES key; store it safely, losing it makes encrypted supplier/Xero tokens unrecoverable** |
  | `STOCKTAKE_ACCESS_CODE` | *(a shared code for the stock-take-lite gate)* |
  | `XERO_DRY_RUN` | `true` *(default; keep it on until go-live)* |
  | `GL_PROVIDER` | `xero` *(default)* |
  | `COMPANY_ID` | `11111111-1111-4111-8111-111111111111` *(default; leave as-is)* |

  Leave `FEATURE_*`, `CATALOGUE_SYNC`, `MATERIALS_COST_SYNC` unset (all default off).

- Deploy. The container **runs `drizzle-kit migrate` then starts the server** (see
  the Dockerfile `CMD`), so the schema is created on first boot.

## 4. Web application (`stock-web`)

New Resource → **Application** → same repo, branch `autostock`, Dockerfile.

- **Base directory:** `/`  ·  **Dockerfile location:** `apps/web/Dockerfile`
- **Port:** `80`
- **Domain:** `https://stock.thebigbakes.com`
- **Build argument:** `VITE_API_BASE_URL = https://stock-api.thebigbakes.com/api/v1`
  *(baked into the bundle at build time — a redeploy is needed if it changes)*
- Deploy.

## 5. First boot — admin login + sites

Migrations already ran (step 3). Now create a login and seed the sites, via the
API container's **Terminal** in Coolify (Coolify → the `stock-api` app →
Terminal / Execute Command):

```
# create an admin user (adjust email/password)
DATABASE_URL="$DATABASE_URL" node --import tsx apps/api/scripts/create-user.ts <email> <password>
# seed the 5 UK sites (+ Dallas)
DATABASE_URL="$DATABASE_URL" node --import tsx apps/api/scripts/seed-sites.ts
```

*(exact script names/args: `ls apps/api/scripts`. `tsx` is present in the image.)*

Then open `https://stock.thebigbakes.com`, sign in, and add products / recipes /
suppliers / Xero mapping through the admin UI. Device PINs (for the iPad PWA) are
created under the admin **Device PINs** page.

## 6. Verify

- `https://stock-api.thebigbakes.com/health` → 200
- `https://stock-api.thebigbakes.com/docs` → the API's Swagger UI
- `https://stock.thebigbakes.com` → the admin SPA loads and can log in
- iPad: `https://stock.thebigbakes.com/pin-login`

## Later — the four periodic jobs

The reorder / consumption / Square-poll / BumbleBee-poll sweeps (bare-metal
systemd timers in `infra/systemd/`) become **Coolify Scheduled Tasks** on the
`stock-api` app, each running its `apps/api/scripts/run-*.ts` CLI. Add them once
the app is proven; they no-op safely while the Square / BumbleBee tokens are unset.

## Notes / follow-ups

- The API image installs the whole workspace (dev deps included, so `drizzle-kit`
  is available at runtime) — it's large but reliable; a slimmer multi-stage prune
  is a later optimisation.
- Everything stays **Xero dry-run** and sync-flags-off until the go-live gates in
  `BUILD_LOG.md` are cleared.
