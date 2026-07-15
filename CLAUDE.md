# CLAUDE.md — smmta-next

Persistent context for Claude Code working in this repo. Loaded automatically every session. Keep this up to date when conventions change; this is the single source of truth for "how we work in this codebase."

---

## Auto-Stock (Big Bakes fork) — READ FIRST

This checkout is **Auto-Stock**, the Big Bakes stock-control system-of-record — a Big-Bakes-owned fork of `smmta-next`, built against *Big Bakes Stock Control Proposal Specification v2* (A1–A12). Work happens on the **`autostock`** branch; commits are scoped `autostock: P<n> <summary>`. The build narrative is in `BUILD_LOG.md`; non-obvious decisions (and the "default — confirm with owners" items) in `DECISIONS.md`. **The spec is law — document any divergence in `DECISIONS.md`.**

**What Auto-Stock adds on top of the fork:** multi-site stock (`sites`, per-`(product, site)` `stock_levels` as the running sum of an auditable `stock_movements` ledger), units of measure + an `item_kind` model (discrete vs fungible, sold vs stocked), recipes/BOM per experience type, the head-baker session-consumption form, automatic reordering on the existing supplier module, Square-sale decrements, an iPad-first goods-in / stock-take **PWA**, daily **Xero** posting (GRN / adjustments / COGS / wastage), and an **MCP server** for Claude / Cowork. Sites: Birmingham, Liverpool, London East, London South, Manchester (+ a US **Dallas** site, USD/imperial).

**Reuse map (spec §A2):** extend `products` (don't fork the catalogue); mirror `integrations/luca/` + `gl_posting_log` for the Xero GL client (keep the `LucaGLService` method surface, switch via a `GL_PROVIDER` flag); reuse the `SupplierConnector` interface + `supplier_orders` idempotency + the supplier-poll/order-placer worker+timer pattern for auto-reorder; reuse `api_keys` (scrypt, `scopes text[]`) + JWT (`requireAuth`) auth and the AES-256-GCM `shared/crypto/encrypt.ts` helper (key from `ENCRYPTION_KEY`) for any stored credentials. Single-tenant by `COMPANY_ID` stays.

**What's dormant (carried in the tree, not deleted — spec §A2):** the Next.js storefronts (`apps/store`, `apps/store-clothes`), the marketplace connectors (`apps/api/src/integrations/marketplace/*` + `POST /import/marketplace` + the SPA marketplace page), Mollie payments, SendGrid, and the conversational Claude-Haiku storefront search (`apps/api/src/modules/storefront/search/*`). Dormancy is enforced by **not building/deploying** the storefronts and by two default-off flags in `apps/api/src/config/env.ts` — `FEATURE_MARKETPLACE` (gates `POST /import/marketplace`) and `FEATURE_CONVERSATIONAL_SEARCH` (gates the LLM key; off ⇒ `/storefront/search` is keyword-only). Don't wire dormant code into the Auto-Stock paths.

**Local test DB:** an isolated Postgres container `auto-stock-db` on `127.0.0.1:5435`; `apps/api/.env` (gitignored) points `DATABASE_URL` at it. Run the API suite with `DATABASE_URL=postgresql://smmta:smmta@localhost:5435/smmta_next npm run test -w @smmta/api`.

### Touch-first venue PWA (added 2026-07-15)

The four in-venue iPad pages — permanent stock-take (`/pwa/stock-take`), end-of-bake consumption (`/pwa/consumption`), goods-in (`/pwa/goods-in`), and the PIN login (`/pin-login`) — were rebuilt on a shared **touch design** ported from the proven `apps/stocktake` (stock-take-lite) app head office rolled out for the June quarter count. It lives in **`apps/web/src/components/touch/`**: `pwa-touch.css` (a plain-CSS system scoped under a `.touch-app` full-screen overlay so it can't leak into — or be affected by — the Tailwind/shadcn admin SPA) + `touch.tsx` (reusable `TouchScreen` / `TouchTopbar` (progress + sync pill) / `TouchToolbar` / `CountRow` (± steppers, hero value, tap-to-type, ½-unlock part-units) / `KeypadSheet` / `BottomSheet` / `BigButton` / `ActionBar`). Big targets (≥46px), on-screen number keypad, book-vs-count variance badges. **Only the `/pwa/*` + `pin-login` routes use the touch layer** — the desktop admin pages are untouched. No API/route changes. Web build + 117 web tests green.

### LIVE deployment on Coolify (added 2026-07-15)

The full app now runs in a realistic-test environment on Coolify. **This supersedes the bare-metal `infra/install.sh` story below (that's the inherited Filament path).** Deployed from `roger296/smmta-next @ autostock` (no separate fork yet).

| | |
|---|---|
| Server | `165.84.215.138` (Coolify; a **separate box** from the BumbleBee / TheHippo VPS `.110`) |
| Web (admin + iPad PWA) | `https://stock.thebigbakes.com` |
| API | `https://stock-api.thebigbakes.com` (`/health`, Swagger at `/docs`) |

- **Four Coolify resources:** PostgreSQL `stock-db` + Redis `stock-redis` (both Coolify-managed) + a `stock-api` application + a `stock-web` application.
- **Containerised for Coolify** (the app had no Dockerfiles — only the bare-metal installer): **`apps/api/Dockerfile`** (single-stage `node:22-bookworm-slim`; full-workspace `npm ci`; builds `shared-types` then `api`; **CMD applies drizzle migrations then runs `node apps/api/dist/server.js`**; ships `tini` + **`curl`** so Coolify's in-container healthcheck can hit `/health`), **`apps/web/Dockerfile`** (multi-stage `node` build → `nginx:1.27-alpine` static; `VITE_API_BASE_URL` baked in via a build `ARG`), **`apps/web/nginx.conf`** (SPA fallback), **`.dockerignore`**. **Full step-by-step runbook: `DEPLOY_COOLIFY.md`.**
- **Coolify app settings (gotchas learned deploying):** Base Directory `/` (repo root — the api Dockerfile `COPY . .`s the whole monorepo, so the context must be root); Dockerfile Location `/apps/api/Dockerfile` (else Coolify looks for a root `Dockerfile` and fails); **Ports Exposes `8080` for the api** — Coolify defaults it to `3000`, which yields "bad gateway" + a failed healthcheck; `80` for web; the web app's `VITE_API_BASE_URL` **must be flagged a Build Variable** (it's baked in at build time).
- **API env vars (set in Coolify):** `NODE_ENV=production`, `PORT=8080`, `DATABASE_URL` + `REDIS_URL` (Coolify internal URLs), `JWT_SECRET`, `ENCRYPTION_KEY` (**store safely — it encrypts supplier/Xero tokens; changing/losing it makes them unrecoverable**), `STOCKTAKE_ACCESS_CODE`, `XERO_DRY_RUN=true`. Everything else stays default (`COMPANY_ID`, all `FEATURE_*` / `CATALOGUE_SYNC` / `MATERIALS_COST_SYNC` off).
- **First boot** (run from the `stock-api` app's Coolify **Terminal**): migrations run automatically in the api CMD; then create the admin login + seed data — `npx tsx apps/api/scripts/create-user.ts --email … --name … --password …`, `npx tsx apps/api/scripts/seed-sites.ts`, `npx tsx apps/api/scripts/seed-bakes.ts`.
- **Still Xero dry-run and all sync flags off** — the go-live gates in `BUILD_LOG.md` (flip `XERO_DRY_RUN` vs the Demo org, wire live Square + BumbleBee, capture a golden dataset) remain open. The four periodic sweeps (reorder / consumption / Square-poll / BumbleBee-poll) are not yet wired as Coolify Scheduled Tasks — see `DEPLOY_COOLIFY.md`.

The rest of this file is the inherited `smmta-next` context — still accurate for the reused subsystems. Where it describes the storefront/marketplace/Filament tenant, treat that as **dormant** for Auto-Stock.

---

## Project mission

**smmta-next is an open-source stock control, order management, and product management platform with a customer-facing web store module, designed to plug into a wider ecosystem of small-business operations tools.**

The intended audience is small to mid-sized retail and ecommerce operators who want to self-host an end-to-end stack — inventory, purchasing, multi-channel orders, and a storefront — without locking themselves into Shopify / Lightspeed / NetSuite. The system is deliberately built to be:

- **Single-tenant per deployment.** Each business that adopts smmta-next clones the repo and runs their own instance on their own VPS (or container host of choice), sized for their own load. One deployment = one business. There is no shared-DB SaaS story — keeping it single-tenant lets self-hosters tune their own infrastructure, own their own data, and lets us avoid the testing / isolation burden of cross-tenant row-level security. The `companyId` column stays in the schema as a single-default-value placeholder so the door is open for future change, but no code enforces cross-tenant isolation.
- **Multi-channel and multi-storefront within a single deployment.** A single business may sell through several routes: their own branded storefront(s) (`apps/store` re-skinned per brand), plus marketplaces (Amazon, eBay, Etsy, Shopify — connectors already exist in `apps/api/src/integrations/marketplace/`). All of those flow into one shared product / stock / order model. Orders carry a `sourceChannel` so you always know where a sale came from, and stock reservations are unified across channels so the business can't oversell a SKU on Amazon while it's also being added to the storefront cart.
- **Reusable storefront template.** `apps/store` (Filament Store) is the first concrete deployment but is intended to be re-skinned and re-deployed for other brands the same business runs. Brand-specific look-and-feel is contained to `apps/store/app/globals.css` (palette tokens) + `apps/store/lib/fonts.ts` + homepage / hero copy / footer / asset paths in `apps/store/public/`. A second storefront for the same business should be a config + theme diff, not an architecture diff.
- **Open source.** The repo is public at https://github.com/roger296/smmta-next. Decisions favour open standards and self-hostability over proprietary cloud dependencies. (No LICENSE file yet — TODO; intent is a permissive licence so commercial reuse is unencumbered.)

When weighing implementation choices, prefer the option that holds up across multiple storefronts / sales channels (within one business) over the option that's fastest just for Filament Store in isolation. Don't, however, reintroduce cross-tenant complexity — the multi-tenant abstraction is explicitly out of scope.

---

## Deployment model

A self-hoster's install story is the simple path: `sudo bash infra/install.sh`. The script (Ubuntu 22.04+/Debian 12+) installs Docker + nginx + certbot + Node 22 (NVM), clones the repo to `/home/smmta/smmta-next`, generates secrets (JWT, DB password, store cookie, COMPANY_ID), brings Postgres up in Docker, runs drizzle migrations, creates the singleton company, the first admin user, and the storefront API key, installs systemd units, configures nginx, and issues TLS certs. Re-runs are idempotent (prompts before overwriting `.env` files; `SMMTA_FORCE=1` to skip).

Manual / piecemeal install (kept as the long-form path):

1. Clone the repo: `git clone https://github.com/roger296/smmta-next`
2. Configure environment files for their business (`apps/api/.env`, `apps/store/.env`, plus any `apps/store-<other-brand>/.env` if running multiple storefronts).
3. `docker compose up -d` to bring up Postgres (the canonical pattern; the VPS today runs Postgres in a Docker container).
4. Run drizzle migrations: `npm run db:migrate -w @smmta/api` (and per-storefront migrations for `smmta_store` etc.).
5. Boot the API and storefront(s) under systemd (templates in `infra/systemd/`).
6. Issue a Let's Encrypt cert per public hostname (storefront, admin SPA).

The Filament Store production deploy on `striped-acrobats.metalseed.io` is the working reference for this story — see the **VPS deployment** section below for the concrete commands and the conventions that deviate from the older deploy guide.

---

## Ecosystem context

smmta-next sits alongside other small-business apps designed to share data and patterns. The first concrete integration is **Luca's General Ledger** (Lucas / Luca):

- **Luca's General Ledger** is an external AI-CFO / GL system that handles double-entry bookkeeping, VAT returns, bank reconciliation, and financial reporting. smmta-next posts financial events to Luca via REST: invoices when orders are confirmed, GRNs when stock is received, stock adjustments when inventory is corrected, and so on.
- The Luca integration lives in **`apps/api/src/integrations/luca/`** (`luca-client.ts`, `luca-gl.service.ts`, `luca-account-map.ts`, `luca-tax-map.ts`, `luca-types.ts`).
- Every posting is recorded in the local **`gl_posting_log`** table for idempotency, retry, and reconciliation — so a Luca outage never loses a posting and a re-attempt never double-posts. Idempotency keys are deterministic per `(entityType, entityId)` pair.

Future ecosystem integrations are expected to follow the same shape: an outbound client in `apps/api/src/integrations/<vendor>/`, a per-vendor audit table for idempotency / retry, and account/tax mappers per company. **When adding a new external integration, mirror the Luca pattern** — the existing code is the de facto reference architecture.

### Suppliers / Drop-shipping

- Schema lives on the existing `suppliers` table (extended with `slug`, `connectorKind`, `apiBaseUrl`, `apiKeyEnc`, `apiAuthScheme`, `isDropshipActive`, `pollIntervalMinutes`, dispatch SLA, `lastError`, `consecutiveFailures`, `showSupplierNameToCustomers`) plus three new tables: `supplier_products` (per-product mapping with cached stock+price snapshot), `supplier_orders` (audit + idempotency for outbound order placements), `supplier_poll_log` (worker observability).
- The `SupplierConnector` interface is at `apps/api/src/integrations/suppliers/types.ts`. Each supplier vendor is a separate class implementing the interface. Currently integrated: `UneekConnector` (Bearer / Basic auth, full-catalogue endpoint), `RalawiseConnector` (login → bearer JWT with 20-minute TTL, three-level inventory endpoint, no order-status / cancel API). `connectorKind` on the row picks which class the registry instantiates.
- API keys are encrypted at rest via AES-256-GCM (`apps/api/src/shared/crypto/encrypt.ts`). Key is derived from `ENCRYPTION_KEY` env, falling back to `JWT_SECRET` if unset. Format: `<iv-hex>:<authTag-hex>:<ciphertext-hex>`. Decrypt happens at the service boundary so connectors only ever see plaintext. Multi-field credentials (Ralawise needs `{user, password}`) are stored as a JSON blob inside the same envelope — see `RALAWISE_API_NOTES.md` for the convention.
- Ralawise has notable quirks worth knowing about for anyone touching the connector layer: 20-minute JWT TTL (proactive refresh + 401-retry baked into the connector), 10 requests/60s rate limit, and `orderReference: "APITEST"` for non-fulfilment test orders (the connector does NOT auto-inject this; production correctness wins — tests pass APITEST explicitly).
- To add a new supplier connector: extend `supplier_connector_kind` enum (and write a drizzle migration), add a `<vendor>.connector.ts` file implementing `SupplierConnector`, wire the new case in `registry.ts`'s switch, add an admin SPA option in `apps/web/src/features/suppliers-dropship/dropship-tab.tsx`.

### Categorisation

- Two-tier hierarchical taxonomy lives on the `categories` table — top-tier rows have `parent_id = NULL`, subcategories point at their parent. Hard cap at two tiers; if a sub-bucket gets unwieldy (e.g. Tops → T-shirts ends up with 30k SKUs) the answer is filters within the page, not more taxonomy depth.
- **Taxonomy is data in code at `apps/api/src/modules/catalogue/taxonomy.ts`**. The seven top-tiers + their subcategories are listed there; `seed-categories.ts` upserts them into the DB on every run. There's also a hidden `uncategorised` bucket for products that fall through the mapping rules.
- **Category assignment is rule-driven via `apps/api/src/modules/catalogue/category-mapping.ts`**. Each rule is `{ source?, productType?, categorisationContains?, nameContains?, ageGroupEquals?, assignTo }`. The backfill (`assign-categories.ts`) walks every product, applies rules top-to-bottom, first match wins. Anything that doesn't match lands in `uncategorised`. The script's end-of-run summary shows which categories grew + sample names from the unmatched bucket so the operator knows what rules to add next.
- Rules priority: context (hi-vis, sport, school) > age band (kids) > garment type. The brief's example: a hi-vis polo lives in `workwear-and-safety/hi-vis-tops-and-vests`, not `tops/polo-shirts`.
- **Mapping rules are committed code, not data**. The admin SPA's Categories page is read-only — it shows the tree + product counts so the operator can spot coverage gaps, but to actually change which products land where, edit `category-mapping.ts` and redeploy. Editing rules in the SPA is a deliberate V2 follow-up (it needs a "preview impact" mechanism we don't have yet).
- Storefront category pages live at `/shop/c/<top>` and `/shop/c/<top>/<sub>`. Filters (gender / brand / colour / size / price band / stock state) are URL-encoded query params so deep-links work + SEO crawls cleanly. Filter facets are computed server-side from the full category result before pagination so the sidebar counts stay representative.

### Conversational search

- The Clothes Shop header carries a natural-language search bar that submits to `/shop/search?q=...`. The API's `/storefront/search` endpoint parses the customer query through Claude Haiku into a structured `ParsedQuery` (category slug + filters + keywords + confidence), then feeds the structured form into the same `CategoryService.listCategoryProducts` that backs `/shop/c/...`. If the LLM call fails, the day's budget is exceeded, or `ANTHROPIC_API_KEY` isn't set, the service falls through to a plain keyword search across product names — the customer always gets something.
- **No PII goes to Anthropic.** The customer's query text is the only customer-supplied data sent. The `llm_search_log` table mirrors that constraint — no IP, email, or session id columns. Used for cost tracking, top-queries-in-the-last-7-days reporting, and a future fine-tuning dataset.
- **Daily cost ceiling** via `LLM_SEARCH_BUDGET_GBP_PER_DAY` env (default £5). The service checks today's logged cost on every request; once the budget is hit, the LLM is skipped and we keyword-fall-through for the rest of the day.
- **24h cache** keyed on `sha256(lowercase trimmed query)`. Same input string → same parsed output without re-paying for tokens. In-memory per process — single-instance deploys are fine; multi-instance would either switch to Redis or accept the cost of duplicate parses across instances.
- The system prompt lives in `apps/api/src/modules/storefront/search/system-prompt.ts` and interpolates the taxonomy slugs at build time so adding / renaming a category in `taxonomy.ts` automatically propagates to the LLM's allowed-categories list. Model: `claude-haiku-4-5-20251001` by default, override via `ANTHROPIC_MODEL` env if Anthropic retires it.

---

## What's in this repo

A Turborepo monorepo with three deployable apps and one shared package:

1. **SMMTA-NEXT** — the core platform.
   - `apps/api` — Fastify + Drizzle + Postgres back end. The thing every other module talks to.
   - `apps/web` — Vite/React admin SPA. Product / group / order / refund / customer management for company operators.
2. **Filament Store** (`apps/store`) — the reference customer-facing storefront, currently running at **filament.shop.cleverdeals.net**, selling 3D printer filament. This is one tenant's deployment of the storefront module; the same module is intended to be re-skinned for other tenants over time. Single-axis variants (`colour`) only.
3. **Clothes Shop** (`apps/store-clothes`) — second storefront, friendly/colourful palette (warm cream + cheerful pink, Fraunces serif headings), drop-ship-sourced clothing. Same back end + admin SPA + data model. **Multi-axis variants** (`{ size, colour }`) via the `products.attributes` JSONB column and `productGroups.attribute_axes` array. Runs on port 5000 in production at `clothes.shop.cleverdeals.net`. nginx + systemd templates at `infra/{nginx,systemd}/clothes-store.*.template` / `smmta-clothes-store.service.template`. Bootstrap channel + api-key with `npx tsx apps/api/scripts/bootstrap-clothes-shop.ts`.

**Filament Store specifics** (the first tenant): a sub-brand of CleverDeals.net, selling PLA / PETG / ABS / ASA / TPU spools (LANDU / Polymaker / Prusament etc.), 1.75mm × 1kg vacuum-sealed, customers are makers / engineers / hobbyists. **Despite older seed data still mentioning lamps / lighting in some test fixtures, the actual product is 3D printer filament.** Tenant-specific copy and assets live under `apps/store/` only.

The repo lives at https://github.com/roger296/smmta-next. Roger is the project owner.

---

## Repo structure

```
apps/
  api/           Fastify + Drizzle + Postgres back end (SMMTA-NEXT API). Port 3000 in prod.
  web/           Vite/React admin SPA. Login via pasted JWT (no user DB). Not deployed yet.
  store/         Next.js 15 + Tailwind 4 storefront (filament.shop.cleverdeals.net). Port 4000 in prod.
packages/
  shared-types/  TS types shared across apps (must be built before apps/api compiles).
infra/
  nginx/         Production nginx server-block templates.
```

Workspaces are defined in the root `package.json` (`apps/*`, `packages/*`). Turbo orchestrates `dev`/`build`/`test`/`lint`/`db:*` — but CI builds workspaces individually so dependency order has to be explicit there (build `@smmta/shared-types` before `@smmta/api`).

Node 22+. Package manager pinned to `npm@11.9.0`. Tooling: TypeScript 5.8, Drizzle ORM 0.41, Fastify 5, Next 15.5, Vite (apps/web), Vitest, Playwright, Tailwind 4.

---

## Architecture decisions worth knowing

Most of these override what an older internal architecture doc says. The doc is **stale**; this file is current.

- **Variants are separate `products` rows linked by `group_id`**, NOT a `product_variants` table. A product group ("Landau PLA Basic 1.75mm 1kg") has many products (one per colour). The storefront groups them visually.
- **Per-product channel availability + per-channel pricing** lives in `channels` (reference: `filament-store`, `amazon-uk`, `ebay-uk`, `etsy-uk`, `shopify`) + `product_channels` (sparse join: empty = "all channels, base price"). `ChannelService.getChannelPrice()` is the single source of truth for "what does product X cost on channel Y". Storefront read endpoints scope by `api_keys.channel_id` — null on a key means "see everything" (operator/back-compat); set means "filter to products offered on this channel and use channel-specific prices". The Filament Store storefront key needs its `channel_id` set to the `filament-store` channel id once that key is rotated; before then, the storefront sees the back-compat "all products at base price" view.
- **Storefront content lives on SMMTA-NEXT `products` + `productGroups`** (heroImageUrl, seoDescription, slug, etc.). There is no separate storefront-only admin layer.
- **Service-to-service auth uses Argon2-hashed `api_keys`**, not JWTs. Format: `smmta_<8hex-prefix>_<32hex-secret>` — exactly **47 chars** with **two underscores**. Naive regex `smmta_[A-Za-z0-9]+` truncates at the second underscore — always extract with `sed 's|^KEY=\(.*\)$|\1|'` instead. Stored as `<salt-hex>:<scrypt-hash-hex>` (the schema comment claims Argon2 but the code uses scrypt; either way, never store raw keys).
- **User auth uses `@fastify/jwt`** signing with `JWT_SECRET`. Admin operators sign in via `POST /api/v1/auth/login` (email + password) and receive a JWT, which the SPA stores in `localStorage.smmta_token` and presents as `Authorization: Bearer <jwt>`. Bootstrap the first admin with `npx tsx apps/api/scripts/create-user.ts --email <e> --name "<n>" --password <p>`. `apps/api/generate-test-token.ts` is a CI / dev-only fallback that mints an admin JWT without a users-table lookup — useful for tests but not the production login path. JWT verification is signature-only; the userId/companyId claims are not validated against the DB.
- **Single-tenant per deployment** — see the **Tenancy** section below. The JWT's `companyId` claim is no longer trusted: the auth middleware overwrites `request.user.companyId` with the singleton id read from `COMPANY_ID` (env var, defaults to `11111111-1111-4111-8111-111111111111` to match the existing Filament Store deploy). The `company_id` column is still present on every table — we did NOT drop it — and downstream service code keeps filtering by it; it's now just a constant.
- **Stock reservations use Postgres `SELECT ... FOR UPDATE SKIP LOCKED`**, 15-minute TTL. Storefront `/storefront/checkout/start` reserves stock; the Mollie webhook (or polling fallback) commits the reservation into an order. Concurrency-correctness covered by `apps/api/src/modules/storefront/reservation.concurrency.test.ts` (100 × 50 parallel test runs in CI).
- **Mollie integration uses the Payments API**, NOT the Orders API. Webhooks always re-fetch `GET /payments/:id` rather than trusting webhook payloads. Live keys configured.
- **SendGrid runs in sandbox mode** unless `NODE_ENV=production`. Real send paths covered by integration tests.
- **"Notify me when back in stock"** is a real flow now: customer submits the form on the PDP → storefront `POST /api/notify-me` → API `POST /api/v1/storefront/notify-me` upserts into `stock_notifications` (and optionally `newsletter_subscribers`). When a GRN books in free stock for that SKU, `NotifyMeService.fulfilForProduct` posts to the storefront's `POST /api/internal/send-back-in-stock`, which enqueues a `back_in_stock` outbox row that the existing `process-outbox` cron picks up. Free-stock semantics are the same `IN_STOCK`-only count `CatalogueService.availableQtyMap` uses, so the trigger never disagrees with the PDP. Pending row uniqueness is enforced by a partial unique index on `(productId, email) WHERE fulfilled_at IS NULL`, so a customer can re-enrol after a future stock-out.

---

## Tenancy

smmta-next is **single-tenant per deployment**. Each business that adopts smmta-next clones the repo and runs their own instance; cross-tenant filtering, JWT companyId enforcement, and "company A vs company B" test scenarios have been removed.

- The singleton company id lives in `COMPANY_ID` (env var). Default: `11111111-1111-4111-8111-111111111111` — matches the existing Filament Store production VPS, so a redeploy without setting `COMPANY_ID` doesn't break.
- `apps/api/src/shared/auth/company.ts` exposes `getSingletonCompanyId()`, the single source of truth. Read it at the top of any new module that needs the id; don't hardcode.
- The JWT auth middleware (`apps/api/src/shared/middleware/auth.ts`) overwrites `request.user.companyId` with the singleton, so a JWT carrying any companyId claim is accepted as long as the signature verifies. Downstream service code keeps filtering by `user.companyId`, but in practice that's always the singleton.
- The `company_id` column stays on every table as a placeholder for future change — we don't commit to a one-shot column drop.
- The api-keys middleware still uses each row's stored `company_id`. In production every key is issued under the singleton, so this is effectively the same value; tests that mint keys under a throwaway UUID (purely for fixture isolation) continue to work.
- A new install bootstraps the singleton via the install script in `infra/` (see §3 of the briefs); manual installs just need `COMPANY_ID` in `apps/api/.env` before first boot.

## Filament Store brand identity (locked 2026-05-06)

These tokens describe the **first tenant's** brand (Filament Store, sub-brand of CleverDeals.net). Future storefront tenants will replace the palette, fonts, and copy — keep tenant-specific styling contained to the files listed below so re-theming for the next tenant is a focused diff, not a hunt-and-replace.

Filament Store has its own visual identity but acknowledges the CleverDeals parent (Google → YouTube relationship: organisationally tied, visually distinct). **The storefront top-left logo is the CleverDeals horizontal logo**, with the "Filament Store" identity living in copy, hero, footer, and page chrome rather than a wordmark.

**Palette tokens (`apps/store/app/globals.css`):**

| Token | Hex | Use |
|---|---|---|
| `--brand-paper` | `#ECECE8` | Page background (concrete, warm off-white) |
| `--brand-bone` | `#F5F4F0` | Card / panel surface |
| `--brand-ink` | `#15161A` | Primary text, near-black |
| `--brand-muted` | `#6B6E76` | Secondary text |
| `--brand-border` | `#C7CCD1` | Hairline divider, steel |
| `--brand-accent-ice` | `#B4C6D2` | Hover, active swatch background |
| `--brand-accent` | `#3B5266` | Primary CTA, focus ring, link underline |

**Typography:** Inter via `next/font/google` (self-hosted at build time, no external runtime). `--font-body` (400/500), `--font-display` (600/700/800). Both come from the same family — visual cohesion + a single woff2 payload.

**Layout language:** `border-radius: 0` (sharp corners), hairline borders only, no card shadows, gap-px-on-bg-color divider grid for the catalogue. Bold typography over colour.

**Voice:** Confident, technical, no hype. Headline copy: "Filament that prints first time." Recurring spec strap: "1.75mm · 1kg · vacuum-sealed". Tagline: "Premium 3D printer filament — PLA, PETG, ABS, ASA, TPU. Tight tolerances, fast UK delivery." Footer ack: "Powered by CleverDeals" with link to cleverdeals.net. **No flash sales, no sponsored placements, no fake "was" prices** — explicitly stated in voice doc.

**Photography:** Clinical / catalogue (neutral background, sharp light, products centred). Product photos currently from `app.etailsupport.com` and `i.ebayimg.com` (allowed via `apps/store/next.config.js` remotePatterns).

**Footer email:** `orders@filament.shop.cleverdeals.net` — full subdomain. NB the TLD is **.net**, not .com (handover doc had the wrong TLD).

---

## Working preferences

These are user preferences gathered over many sessions. Apply by default; deviate only if explicitly told to.

- **Step-by-step everything.** When proposing a change, lay out the concrete commands / file edits / verifications in order, with brief notes on what each step does and what to look for in the output. Don't just hand over a wall of code.
- **One commit per fix / feature.** Don't bundle unrelated changes. If a follow-up edit comes up while working on something else, branch + PR it separately.
- **British English in UI copy** (colour, optimise, organisation). API wire formats follow upstream conventions (so JSON keys may stay American to match the Mollie API etc.) — match the upstream and document why if it diverges.
- **Run git from PowerShell directly**, not over WSL or via tunnels. Native Windows git is the source of truth for this repo. (Reason: Linux mounts of the NTFS workspace cache `.git` internals badly; sandbox git ops have corrupted index state in the past.)
- **Verify before recommending.** If a memory or earlier note claims a file/function/command exists, grep / read it before suggesting the user act on it. State changes; the recall might be stale.
- **Tag and deploy together.** Once a change is merged, the tag (`vX.Y.Z`) and the VPS deploy happen as one continuous operation — don't tag without deploying or deploy from main without a tag, because the tag is what makes the deployed version reproducible later.

---

## VPS deployment

The VPS hostname is `striped-acrobats.metalseed.io` (referred to internally as "the VPS"). The deploy reality on the VPS deviates from the original deploy guide in several places. **Defer to the VPS reality** when the doc says otherwise:

| Older doc says | VPS reality |
|---|---|
| `/opt/smmta-next` | `/home/smmta/smmta-next` (`~/smmta-next`) |
| `/etc/smmta/api.env` | `~/smmta-next/apps/api/.env` (loaded by systemd `EnvironmentFile=`) |
| `/etc/smmta/store.env` | `~/smmta-next/apps/store/.env` |
| `node dist/server.js` for API | `tsx src/server.ts` (transpile on the fly) — api unit's `ExecStart` |
| `/usr/bin/node` | `/home/smmta/.nvm/versions/node/v22.22.2/bin/node` (NVM) |
| Storefront on port 3000 | Storefront on port **4000** (API took 3000 first) |
| API on port 8080 | API on port 3000, `HOST=0.0.0.0` (should be `127.0.0.1` — TODO, locked behind nginx) |
| Postgres as systemd service | Postgres in **Docker** (`docker compose exec postgres psql -U smmta -d <db> -c "..."`) — no `postgres` system user |
| `sudo -u postgres psql` | The same `docker compose exec` pattern |

Two logical Postgres databases on the same Docker container: **`smmta_next`** (SMMTA-NEXT — products, orders, customers, api_keys, etc.) and **`smmta_store`** (storefront-side: cart sessions, idempotency, outbox). `DATABASE_URL` in apps/api/.env points to `smmta_next`; storefront `DATABASE_URL` in apps/store/.env points to `smmta_store`.

**TLS / certs:** Let's Encrypt issued by certbot on `filament.shop.cleverdeals.net`. Auto-renews; cert is healthy as of the last verified deploy. nginx config at `/etc/nginx/sites-enabled/filament.shop.cleverdeals.net.conf` includes the HTTP→HTTPS 301, HSTS (`max-age=31536000; includeSubDomains; preload`), and proxies to the storefront on `:4000`.

**Standalone build gotcha:** `next build` with `output: 'standalone'` does NOT copy `apps/store/.next/static` or `apps/store/public`. After every build, recreate the symlinks:

```bash
mkdir -p apps/store/.next/standalone/apps/store/.next
ln -sfn $(pwd)/apps/store/.next/static apps/store/.next/standalone/apps/store/.next/static
[ -d apps/store/public ] && ln -sfn $(pwd)/apps/store/public apps/store/.next/standalone/apps/store/public
```

**Standard storefront deploy sequence (VPS):**

```bash
cd ~/smmta-next
git fetch --tags
git checkout vX.Y.Z
npm run build -w @smmta/store
# (recreate symlinks — see above)
sudo systemctl restart smmta-store
sleep 3
curl -fsS http://127.0.0.1:4000/healthz && echo " ← store healthy"
```

**API deploy:** the API systemd unit (`smmta-api`) runs `tsx src/server.ts` directly, so a build isn't strictly required, but `npm run build -w @smmta/api` is harmless. After code changes: `sudo systemctl restart smmta-api && curl -fsS http://127.0.0.1:3000/health`.

---

## Common workflows

**Generate a JWT for the admin SPA / direct API calls:**

```bash
cd ~/smmta-next/apps/api
npx tsx generate-test-token.ts
# Prints a 30-day admin JWT. Use as Authorization: Bearer <token>.
# Edit the userId / companyId in the script if you need stable IDs.
```

**Mint a new storefront API key (`smmta_<prefix>_<secret>`):**

```bash
cd ~/smmta-next
npx tsx apps/api/scripts/issue-store-key.ts
# Outputs `KEY=smmta_<prefix>_<secret>` — paste into apps/store/.env as
# SMMTA_API_KEY=... and `sudo systemctl restart smmta-store`.
```

**Reseed the storefront catalogue from the Landau xlsx:**

```bash
cd ~/smmta-next
CATALOGUE_XLSX_PATH=./.tmp-catalogue.xlsx npm run seed:storefront -w @smmta/api
# WARNING: wipes the Storefront Demo company catalogue first. Don't run if
# you've made admin-side product edits you want to keep. The CI fixture lives
# at apps/api/test/fixtures/catalogue.xlsx.
```

**Run the e2e suite locally:**

```bash
# Prereq: docker compose up -d (postgres), API + storefront running locally.
npm run e2e -w @smmta/store
```

**Trigger a supplier-poll manually (drop-shipping):**

```bash
cd ~/smmta-next
DATABASE_URL=... npx tsx apps/api/scripts/run-supplier-poll.ts
# Optional flags: --supplier-id <uuid> | --ignore-cadence
# In production this script is fired by infra/systemd/smmta-supplier-poll.timer
# every 3 hours; the worker checks each supplier's pollIntervalMinutes
# vs lastPolledAt and skips suppliers polled too recently.
```

**Run the supplier-order placer manually:**

```bash
cd ~/smmta-next
DATABASE_URL=... npx tsx apps/api/scripts/run-supplier-order-placer.ts
# Picks up PENDING + retryable FAILED rows from supplier_orders, calls
# the connector, applies exponential-backoff retry. In production it
# runs continuously under smmta-supplier-order-placer.service (sleep 30s loop).
```

**(Re-)assign category IDs from the rule set:**

```bash
cd ~/smmta-next
set -a; . ./apps/api/.env; set +a
# First time only: seed the taxonomy rows.
npm run seed:categories -w @smmta/api
# Apply rules + write products.category_id. Idempotent.
npm run assign-categories -w @smmta/api
# Optional flags:
#   --dry-run     preview without writing
#   --limit=1000  process only the first N products (smoke test)
# End-of-run summary shows per-category counts + sample uncategorised
# product names so you can see what rules to add next. Rules live in
# `apps/api/src/modules/catalogue/category-mapping.ts` — edit + redeploy
# + re-run after a rule change.
```

**Bulk-import the Ralawise catalogue (drop-shipping):**

```bash
cd ~/smmta-next
# CSV file ~204 MB at /home/smmta/.tmp.Ralawise/CustomerDataFull.csv on VPS.
# Cost prices are CSV column 46 (`Single Price`); retail = cost × markup.
DATABASE_URL=... \
  RALAWISE_CSV_PATH=/home/smmta/.tmp.Ralawise/CustomerDataFull.csv \
  RALAWISE_DEFAULT_MARKUP=2.0 \
  npm run seed:ralawise-catalogue -w @smmta/api -- --publish
# Optional flags: --limit=N | --dry-run | --markup=X.Y | --channel=<slug>
# Streaming + batched (1000 rows/tx). Full 103k catalogue: ~30 min.
# Idempotent — re-running upserts in place; admin-edited price overrides
# in product_channels are protected. See apps/api/scripts/RALAWISE_IMPORT_NOTES.md.
```

**Seed demo data for both stores:**

```bash
cd ~/smmta-next
DATABASE_URL=... ENCRYPTION_KEY=... npm run seed:demo -w @smmta/api
# Idempotent. Inserts the two storefront channels (filament-store +
# clothes-shop), one demo Uneek supplier, and a small Clothes Shop
# catalogue with size+colour variants and stub stock counts. Run after
# `npm run seed:storefront -w @smmta/api` to also have Filament Store
# data in place.
```

The home-page H1 assertion is regex `/filament/i` — survives copy tweaks but still proves the homepage rendered.

---

## CSP and security headers

The storefront sets:
- `Strict-Transport-Security` — set in nginx (always), redundantly in `next.config.js` for prod
- `script-src 'self' 'unsafe-inline'` — required because Next 15 RSC inlines hydration scripts. Long-term fix is nonce-based CSP via middleware (TODO).
- `connect-src 'self' https://api.mollie.com https://*.sentry.io <api host>`
- `img-src` covers picsum + the catalogue image hosts (app.etailsupport.com, i.ebayimg.com)
- `frame-ancestors 'none'`, `object-src 'none'`, `form-action 'self' https://www.mollie.com`

If a customer-facing browser ever hits a CSP violation, check `apps/store/next.config.js` first — the CSP is a single `csp` constant assembled from a deny-by-default base.

---

## Repository conventions

- **Branch naming:** `feat/<short-description>`, `fix/<short-description>`. Tag releases as `vX.Y.Z`.
- **Commit messages:** Conventional Commits (`feat(scope): subject`, `fix(scope): subject`). Body explains *why*, not just what.
- **PRs merge via the GitHub web UI** (squash or merge — squash preferred for small PRs).
- **CI:** `.github/workflows/e2e.yml` runs the full Postgres + API + storefront + Playwright + concurrency stress test stack on PRs that touch `apps/store/**`, `apps/api/src/modules/storefront/**`, `apps/api/scripts/**`, or the workflow itself. Lighthouse CI runs on `apps/store/**` PRs too (`lhci.yml`).
- **`.tmp-*` files** at the repo root are gitignored deliberately — reserved for ad-hoc imports (e.g. the production `.tmp-catalogue.xlsx`). The CI fixture is a small committed `apps/api/test/fixtures/catalogue.xlsx`.

---

## Known follow-ups (not blocking)

**Open-source readiness:**
- **LICENSE file** — needed before anyone else can legally fork / reuse the project. Intent is a permissive licence (MIT or Apache-2.0); pick and commit one.
- **README.md** — there's no top-level README yet. Needs an "About / install / deploy / contribute" pass for first-time visitors.
- **Docker-compose recipe** — `docker compose up` should bring up Postgres + API + storefront for a clean local dev / first-time-self-hoster experience. Today only Postgres is in compose; API + storefront are run manually.

**Storefront / Filament tenant:**
- **Admin SPA deployment** — `apps/web` is built but not deployed anywhere. Plan: `smmta.cleverdeals.net` (or a chosen subdomain) → static Vite build served by nginx, with `/api/v1/*` proxied to the API.
- **API security hardening** — set `HOST=127.0.0.1` in `apps/api/.env` so only nginx reaches it (currently `0.0.0.0`).
- **Sudoers** — add `smmta ALL=(root) NOPASSWD: /bin/systemctl restart smmta-store` so deploy scripts don't prompt for a password.
- **SendGrid SPF + DKIM** for `filament.shop.cleverdeals.net` before serious email volume — emails will land in spam without it.
- **Admin SPA UI for product groups** — currently editable via direct API calls / DB; needs a proper page in `apps/web`.
- **Soft-delete in the seed** — the seed wipes orders/order_lines on rerun, breaking when there are real customer orders. Should soft-delete instead.
- **Nonce-based CSP** — replace `'unsafe-inline'` for `script-src` with per-request nonces in middleware.

**Operational quirks worth knowing:**
- **Storefront caches with 60s `revalidate`.** Admin edits to products/groups appear within 1–2 minutes, not instantly. Don't chase apparent "missing edits" inside that window.

---

## Reference

- **Repo:** https://github.com/roger296/smmta-next
- **Storefront live URL:** https://filament.shop.cleverdeals.net
- **Project docs folder** (runbooks, deploy guide, patch history, lives outside the repo): `C:\Filament Store\` on Roger's machine.
- **Architecture doc:** older internal document at `C:\Filament Store\` — refer to but treat as **superseded** by this CLAUDE.md and the code itself wherever they conflict.
