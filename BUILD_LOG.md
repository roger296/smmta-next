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

## P4 — Stock operations on the ledger (2026-06-18)

- **StockLevelService** gained `adjust` (signed ADJUSTMENT movement, idempotent
  on an optional key) and `transfer` (paired TRANSFER_OUT/TRANSFER_IN in ONE
  transaction → quantity conserved). `applyMovement` refactored to delegate to
  a private `applyInTx(tx, …)` so the transfer's two legs share a transaction.
- **StockQueryService** (`stock-query.service.ts`): `listLevels`
  (site/item-kind/low filters, joined with product + site), `lowStock`
  (on-hand ≤ reorder point) and `valuation` — weighted-average cost per
  (product, site) from costed inflow movements, aggregated per site and per
  (site, item_kind).
- **Routes** (`stock.routes.ts`, registered in app.ts): `GET /stock-levels`,
  `/stock-levels/valuation`, `/stock-levels/low`; `POST /stock-levels/adjust`,
  `/stock-levels/transfer`. Legacy `/stock-items/*` (warehouse + serialized)
  left intact for serial/batch goods — DECISIONS D4.
- **Admin SPA**: a "Stock by site" page (`routes/_authed/stock/by-site.tsx`)
  driven by the header site switcher — total value, line count, low-stock
  count, and a per-line table with low-stock highlighting. Feature hooks in
  `features/stock/use-stock-levels.ts`; Sidebar nav item added.
- Tests: `stock-ops.test.ts` (adjust writes a movement + trues up on-hand;
  transfer conserves total across two sites; same-site transfer rejected;
  valuation matches a hand-computed WAC fixture; low-stock returns exactly the
  at/below-reorder items). End of the foundations spine.

## P5 — Re-point the GL subsystem to Xero (2026-06-18) — Phase 1 begins

- **`integrations/xero/`** mirroring `integrations/luca/`:
  - `xero-client.ts` — `XeroClient` with OAuth2 token state AES-encrypted in
    `xero_connections` (app creds from env), rotating-refresh handling, and
    `postManualJournal`. `fromConnection()` returns null when unconfigured.
  - `xero-account-map.ts` — logical roles → Xero account code + tax type,
    defaults seeded from LUCA_ACCOUNTS, with per-company DB overrides
    (`resolveXeroAccount`, `ensureXeroAccountMapSeeded`).
  - `xero-gl.service.ts` — `XeroGLService` with the Luca stock surface
    (`postGoodsReceivedNote`, `postStockAdjustment`) + new `postConsumptionCOGS`
    / `postWastage`. Each writes a PENDING `gl_posting_log` row then SUCCESS/
    FAILED. Balanced journals (signed lines net to zero), idempotent on the
    deterministic key, **dry-run by default** (records `request_payload`, sends
    nothing), and **fail-safe** (no credential ⇒ logged `DRYRUN-UNCONFIGURED`).
- **Migration `0019`**: `xero_connections` + `xero_account_map`.
- **Config**: `GL_PROVIDER` (luca|xero, default xero), `XERO_CLIENT_ID/SECRET/
  TENANT_ID`, `XERO_DRY_RUN` (default true), `XERO_API_BASE_URL`.
- **GL provider factory** (`integrations/gl-provider.ts`): `getStockGLService()`
  → wired into `grn.service` + `stock-item.service` (the GRN + stock-adjustment
  call sites). AR/AP storefront flows stay on Luca — DECISIONS D5.
- **Admin**: `GET/PUT /api/v1/xero/account-map` + a "Xero accounts" SPA page
  (editable role → code/tax table) + sidebar item.
- Tests: `xero-gl.service.test.ts` — dry-run logs a balanced journal and sends
  nothing; re-post with the same key is a no-op; the account map resolves every
  role; an unconfigured live-mode post degrades to a logged dry-run without
  throwing. api 42 files / 426 tests; web typecheck + build green.

## P6 — Suppliers, supplier-product mapping & reorder parameters (2026-06-18)

- **suppliers** extended (migration `0020`): `order_channel` enum
  (`EMAIL_PO`|`API_CONNECTOR`, default EMAIL_PO), `order_email`, `auto_place`
  (supplier-level default). **supplier_products**: `auto_place_override`
  (null ⇒ inherit), `supplier_purchase_uom`, `supplier_pack_size` (a brand may
  sell the fungible material in its own pack).
- `effectiveAutoPlace(sp, supplier)` — per-item override beats the supplier
  default. Supplier create/update + the supplier-product mapping upsert accept
  the new fields.
- `StockLevelService.setReorderParams` — upsert per-(product, site) reorder
  point / up-to (par) / min-days-cover, creating the level row if absent.
  Route `PUT /api/v1/stock-levels/reorder` (bulk, ≤500 entries).
- **Admin SPA**: a "Reorder levels" page (per selected site, bulk-editable
  point/par/min-days) + the supplier form gains an "Ordering" section
  (order channel, order email, auto-place). Sidebar items added.
- Tests: `reorder-params.test.ts` — reorder params persist per site
  (site-independent; partial updates), and `effectiveAutoPlace` override beats
  the supplier default. (Two-brand priority resolution already covered by P3's
  `item-model.test`.) api 43 files / 429 tests; web 17 files / 105 tests;
  typecheck + build green.

## P7 — Automatic reordering engine (2026-06-18) — the key deliverable

- **`reorder_proposals`** table (migration `0021`) + `ReorderService`
  (`modules/reorder/`): `evaluate(productId, siteId)` raises a replenishment
  when on-hand ≤ reorder point — orders up to par (reorder_up_to), converts to
  the supplier's purchase unit and rounds UP to the pack size, resolves the
  preferred supplier (`preferredSupplierProduct`) and routes by channel +
  `effectiveAutoPlace`. Idempotent: one open (PROPOSED/APPROVED) proposal per
  (product, site). `approve` / `place` / `updateQty` / `list` round it out.
- **Triggers**: a best-effort post-commit hook in `StockLevelService.
  applyMovement` fires `evaluate` on every SALE/CONSUMPTION decrement, and the
  **daily sweep** (`reorder.sweep.ts` + `scripts/run-reorder-sweep.ts`, npm
  `reorder:sweep`) catches low items no decrement touched.
- **Placement routing**: auto-place + API_CONNECTOR → PLACED (+ ref);
  auto-place + EMAIL_PO → EMAILED with a rendered PO (`email-po.ts`; never sent
  during the build); not auto-place → PROPOSED. `min_days_cover` stored but not
  yet in the qty math (needs the P22 demand rate) — DECISIONS D6.
- **Routes** (`reorder.routes.ts`): `GET /reorder/proposals`,
  `POST /reorder/proposals/:id/approve|place`, `PATCH /reorder/proposals/:id`,
  `POST /reorder/sweep`. **SPA**: a "Reorder suggestions" page (status filter,
  Run-sweep, approve/place per row) + sidebar item.
- Tests: `reorder.service.test.ts` — a sale crossing the point creates exactly
  one replenishment (idempotent on a second decrement); par + pack-size
  rounding (7→8 bags); auto-place vs propose routing (EMAILED / PLACED /
  PROPOSED); the sweep catches an untouched low item; the email PO renders.
  api 44 files / 436 tests; web typecheck + build green.

## P8 — Receiving / goods-in (service + API) (2026-06-18)

- **`goods_in_receipts` + `goods_in_receipt_lines`** (migration `0022`) +
  `GoodsInService.receive` (`modules/goods-in/`): accepts received quantities in
  the supplier's **purchase unit**, converts to stock units via
  `purchase_to_stock_factor`, writes a **GRN movement at the receiving site**,
  optionally matches a reorder proposal (partial → UNDER, over → OVER, with the
  expected qty + remaining on the line), and posts a **GRN to Xero** via the GL
  provider (`postGoodsReceivedNote`). Idempotent on `idempotencyKey` — a
  re-confirm returns the existing receipt and re-applies nothing. Optional
  `photo_refs` captured (SKU + site + timestamp) for the AI groundwork (§A10).
- Built around the Auto-Stock site/ledger model (the legacy warehouse +
  serialized `/purchase-orders/:id/book-in` stays for serial/batch goods —
  consistent with DECISIONS D4/D5).
- **Routes** (`goods-in.routes.ts`): `POST /goods-in` (201/200 idempotent),
  `GET /goods-in`, `GET /goods-in/:id`. The iPad goods-in *screen* is P13.
- Tests: `goods-in.service.test.ts` — full receipt converts purchase→stock and
  raises on-hand; partial receipt flags UNDER with the correct remaining;
  over-receipt flags OVER; the GRN posts exactly once to Xero (dry-run) and a
  re-confirm is a no-op (single gl_posting_log row, single on-hand application).
  api 45 files / 440 tests; build green.

## P9 — Stock-takes (service + API) (2026-06-18)

- **`stock_takes` + `stock_take_lines`** (migration `0023`) + `StockTakeService`
  (`modules/stock-take/`): `open(siteId, scope, scopeRef?)` snapshots book stock
  for the scope (FULL/CYCLE/ZONE = the site; CATEGORY = products in a category;
  ITEM = one product) into lines; `recordCount(s)` writes counted qty + variance
  (offline-tolerant via a client `countIdempotencyKey` — a replay of the same
  key doesn't overwrite); `approve` writes a **STOCKTAKE_TRUE_UP** movement per
  varianced line and posts **one** stock adjustment to Xero, then marks the take
  APPROVED. Re-approving an APPROVED take re-applies nothing.
- **Routes** (`stock-take.routes.ts`): `POST /stock-takes` (open),
  `GET /stock-takes`, `GET /stock-takes/:id`, `POST /stock-takes/:id/counts`,
  `POST /stock-takes/:id/approve`. The iPad stock-take *screen* is P13.
- Tests: `stock-take.service.test.ts` — opening snapshots book stock; counts
  compute the right variance; approval trues up on-hand and posts exactly one
  adjustment (idempotent on re-approve); a re-submitted count batch is
  offline-idempotent; an ITEM-scope take only touches its product. api 46 files
  / 444 tests; build green.

## P10 — Square sales → automatic stock decrement (2026-06-18)

- **`square_item_map` + `square_unmapped_lines`** (migration `0024`) +
  `SquareDecrementService` (`modules/square/`): `ingestLine` resolves a sale
  line to a product (pre-resolved BumbleBee `productId`, or the Square item via
  the map) and a site (direct `siteId`, or a BumbleBee canonical site name),
  then writes a **SALE movement idempotent on `(channel_slug, source_pk,
  source_line_ref)`** — a replay is a no-op. The reorder engine fires
  automatically off the decrement (the `applyMovement` hook from P7). An
  unmapped item/site is **quarantined** in `square_unmapped_lines` (surfaced,
  never dropped). `autoMatchByBarcode` auto-suggests map entries by barcode/ean.
- **Routes** (`square.routes.ts`): `POST /square/decrement`,
  `GET/PUT /square/item-map`, `POST /square/auto-match`, `GET /square/unmapped`.
  The BumbleBee Square-order poll (P24 timer) posts to `/decrement`.
- **SPA**: a "Square mapping" page (quarantined lines with a map-to-product
  action + the current map) + sidebar item.
- Tests: `square-decrement.service.test.ts` — a sale decrements the mapped SKU
  at the mapped site and a replay is a no-op; an unmapped item is quarantined;
  a sale crossing the reorder point raises a replenishment (via the hook);
  auto-match by barcode. api 47 files / 448 tests; web 105 tests; typecheck +
  build green.
