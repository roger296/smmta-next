# Auto-Stock — build log

Narrative of the overnight Auto-Stock build (forking `smmta-next` into the Big
Bakes stock-control system-of-record). Newest entries appended per prompt.
Source spec: *Big Bakes Stock Control Proposal Specification v2* (A1–A12).
Prompt set: *Auto-Stock — Overnight Build Prompt Set* (P1–P25). Non-obvious
decisions live in `DECISIONS.md`.

## Environment / baseline (kickoff, 2026-06-18)

- Forked `roger296/smmta-next` → local `C:\Users\roger\Big bakes\auto-stock`,
  branch **`autostock`** (off `main` @ `2660b04`). Nothing pushed; the
  Big-Bakes-owned-repo decision + go-live are human gates.
- Toolchain: Node **v24.14.0** (satisfies the repo's `engines: node >=22`),
  npm 11.9.0, Docker 29.4.1. `npm install` clean (766 packages).
- **Test DB:** an isolated container `auto-stock-db` on `127.0.0.1:5435`
  (postgres:16-alpine, smmta/smmta/smmta_next), kept separate from the live
  shared Postgres and from a pre-existing `smmta-next-postgres-1` already on
  5432. `apps/api/.env` (gitignored) carries the `DATABASE_URL` for it. Run
  tests with `DATABASE_URL=postgresql://smmta:smmta@localhost:5435/smmta_next
  npm run test -w @smmta/api`.
- **Baseline build:** green (turbo, 5/5 workspaces).
- **Baseline tests:** one pre-existing suite (`supplier-poll.worker.test.ts`,
  "per-chunk error tolerance") was **red on the untouched fork** — its
  `beforeAll` inserted three SKUs against a single `(product_id, supplier_id)`
  pair, violating the `supplier_products_product_supplier_unq` unique index.
  That suite is outside the path-filtered CI (`e2e.yml` only runs on
  storefront/scripts changes), so it went unnoticed since commit #57. Fixed
  the **fixture** (each extra SKU gets its own product — the schema models one
  SKU per product/supplier); product code untouched. Baseline now fully green:
  **34 files / 394 tests**. (See DECISIONS D2.)

## P1 — Fork rebrand, dormancy, green baseline (2026-06-18)

- Rebranded to **Auto-Stock (Big Bakes)**: root `package.json` name +
  description, `README.md`, and a new "Auto-Stock" section in `CLAUDE.md`.
  Workspace scopes kept as `@smmta/*` (renaming is invasive, no benefit — see
  DECISIONS D1).
- Added a root `typecheck` script (`turbo typecheck`); the `typecheck` turbo
  task already existed. `apps/api` already had a `typecheck` target; added one
  to `apps/web` (`tsc --noEmit`, mirroring its `lint:ts`).
- **Dormancy** (spec §A2) via a `FEATURES` config in `apps/api/src/config/env.ts`
  (`FEATURE_MARKETPLACE`, `FEATURE_CONVERSATIONAL_SEARCH`, both default off):
  - `POST /import/marketplace` is only registered when `FEATURE_MARKETPLACE` is
    on → otherwise 404. The rest of `integration.routes.ts` (CSV import, bulk
    ops, year-end) stays live.
  - The Claude-Haiku storefront search only receives an API key when
    `FEATURE_CONVERSATIONAL_SEARCH` is on; otherwise `/storefront/search`
    falls back to keyword matching and never calls the LLM (and
    `ANTHROPIC_API_KEY` is left unset regardless).
  - `apps/store` / `apps/store-clothes` (Next.js storefronts), the marketplace
    connectors, Mollie and SendGrid are carried in the tree but not built or
    deployed for Auto-Stock. See the "What's dormant" note in `CLAUDE.md`.
- Tests added: `src/config/features.dormancy.test.ts` (marketplace route 404
  with the flag off, while a sibling integration route still requires auth) and
  `src/shared/security/no-secrets.test.ts` (high-signal secret-pattern scan of
  the API source tree).

## P2 — Sites & multi-location foundation (2026-06-18)

- **Schema** (`src/db/schema/sites.ts`, migration `0017_wide_pride.sql`):
  - `sites` — slug (unique per company), name, `canonical_name` (BumbleBee join
    string), `currency_code`, `uom_system` (`METRIC|IMPERIAL`), timezone,
    is_active. Currency + UoM on the row from day one so a USD/imperial Dallas
    (P20) is one admin action.
  - `stock_levels` — per `(company, product, site)` (unique): `on_hand`,
    `allocated`, `reorder_point`, `reorder_up_to`, `min_days_cover`.
  - `stock_movements` — append-only ledger: signed `qty_delta`, `movement_type`
    enum (GRN/ADJUSTMENT/SALE/CONSUMPTION/WASTAGE/TRANSFER_IN/OUT/
    STOCKTAKE_TRUE_UP/OPENING), `unit_cost`, `occurred_at`, and a unique
    `(source_system, source_key, content_hash)` for idempotency (mirrors the
    gl_posting_log convention).
- **StockLevelService** (`src/modules/stock/stock-level.service.ts`):
  `applyMovement` writes the ledger row and increments the on-hand cache in one
  transaction, idempotent on the movement key (duplicate ⇒ no-op, on-hand
  untouched); `recomputeOnHand` re-derives on-hand = Σ(qty_delta) from the
  ledger; `getOnHand` reads the cache. on-hand is the running sum of the
  ledger, never a bare counter (spec §A5).
- **SiteService + routes** (`src/modules/sites/…`): `GET/POST /sites`,
  `GET/PATCH /sites/:id`, JWT-gated, slug-unique (409), kebab-validated (400).
  Registered in `app.ts`.
- **Seed**: `scripts/seed-sites.ts` (+ `seed:sites` npm script) idempotently
  upserts the five UK sites (birmingham, liverpool, london-east, london-south,
  manchester).
- **Admin SPA**: a Sites page (`routes/_authed/sites/index.tsx`, list + create/
  edit dialog), a header **site switcher** (`SiteSwitcher` + `SiteProvider`
  context persisting the selection to localStorage, used by stock screens), a
  Sidebar "Sites" nav item, and the sidebar brand relabelled to "Auto-Stock".
- Tests: `stock-level.service.test.ts` (movement updates on-hand; cache ==
  Σ(qty_delta) after a randomised sequence; idempotent re-apply is a no-op;
  per-site isolation) and `site.routes.test.ts` (create/list/get/update, 409
  duplicate slug, 400 bad slug, 401 unauth). 38 files / 407 tests green;
  typecheck + build green across api + web.

## P3 — Item model & units of measure (2026-06-18)

- **products** extended (migration `0018_polite_sugar_man.sql`): `item_kind`
  enum (MERCH/RETAIL/INGREDIENT/PACKAGING, default RETAIL), `is_sold`,
  `is_stocked`, `barcode` (GTIN), `bumblebee_product_id` (indexed — shared
  identity), `reference_image_url` + `image_capture_store` (AI groundwork,
  §A10), and UoM: `stock_uom` (default `each`), `purchase_uom`,
  `purchase_pack_size`, `purchase_to_stock_factor`. Indexed barcode +
  bumblebee id.
- **UoM helper** (`src/modules/stock/uom.ts`): purchase↔stock conversion,
  pack-multiple rounding, ~100 g quantum bucketing (nearest + ceil), and
  discrete-vs-fungible validation (`assertValidStockQty` rejects fractional
  quantities for `each`).
- **Supplier resolution** (`src/modules/stock/supplier-products.ts`):
  `preferredSupplierProduct` picks the active mapping with lowest priority
  (then cheapest) — many brands → one fungible line. Distinct from the
  drop-ship `pickSupplierForProduct` (no `isDropshipActive` requirement, since
  food/merch suppliers order via emailed PO).
- **ProductService + schema**: `createProductSchema`/`updateProductSchema`
  accept the new fields; on create `barcode` defaults from `ean` when absent.
- **Admin SPA**: product form gains a "Stock & units" section — item kind,
  sold/stocked flags, barcode, reference image URL, and a discrete-vs-fungible
  toggle that reveals the stock/purchase UoM + pack-size + conversion-factor
  fields for bulk items. `Product` api-type + the edit route's defaults map
  the new fields.
- Tests: `uom.test.ts` (conversions round-trip, pack/quantum rounding,
  discrete fractional rejection) and `item-model.test.ts` (item-kind/UoM
  persistence, barcode auto-pop from ean, two-brand fungible resolution).
  api 40 files / 417 tests, web 17 files / 105 tests; typecheck + build green.
