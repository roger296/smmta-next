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

## P11 — Shared product catalogue with BumbleBee (2026-06-18)

- `CatalogueSyncService` (`modules/catalogue-sync/`): `importProducts(rows)`
  idempotently upserts BumbleBee products into Auto-Stock products carrying
  `bumblebee_product_id` (match by bumblebee id → stock_code → name), mapping
  BumbleBee `product_type` → Auto-Stock `item_kind` (`bumblebeeTypeToItemKind`,
  unknown ⇒ RETAIL). `buildSlimSubset` returns the identity/name/category/sale-
  price projection BumbleBee consumes; `pushSlimSubset` is **dry-run by default**
  (`CATALOGUE_SYNC` off ⇒ logs the payload, sends nothing — the BumbleBee write
  endpoint is a documented follow-up). `reconcile(bumblebeeIds)` flags the gaps:
  Auto-Stock products without a BumbleBee id, and BumbleBee ids not yet stocked.
- Config: `CATALOGUE_SYNC` (default off), `BUMBLEBEE_API_BASE_URL/KEY`.
- **Routes** (`catalogue-sync.routes.ts`): `POST /catalogue/import`,
  `POST /catalogue/sync`, `POST /catalogue/reconcile`.
- Tests: `catalogue-sync.service.test.ts` — type→item_kind mapping; import is
  idempotent (re-run updates, never duplicates); the slim push is dry-run by
  default and builds exactly the slim payload; reconcile flags the right gaps.
  (BumbleBee product ids are UUIDs — fixtures use valid UUIDs.) api 48 files /
  452 tests; build green.

## P12 — iPad PWA shell (2026-06-18)

- **PWA in apps/web** (DECISIONS D7): hand-written `public/manifest.webmanifest`
  + `public/sw.js` (cache-first shell, never caches `/api/`), registered in
  `main.tsx` (prod only); `index.html` rebranded + meta/manifest links.
- **Shared-device PIN login**: `device_pins` table (migration `0025`,
  scrypt-hashed PIN scoped to a site + roles) + public `POST /auth/pin-login`
  issuing a 12h scoped JWT, and an admin `POST /device-pins`. A touch-first
  PIN-pad route (`routes/pin-login.tsx`).
- **Offline queue** (`lib/offline-queue.ts`): localStorage-backed (pluggable)
  store keyed by the client idempotency id — enqueuing the same key never
  duplicates; `flush` removes only accepted actions and keeps failures.
- **Barcode** (`lib/barcode.ts`): native `BarcodeDetector` support check +
  `resolveBarcodeToProduct` with an injectable lookup (testable).
- No new PWA/scanner dependency added.
- Tests: api `pin.routes.test.ts` (valid PIN → scoped token, wrong PIN 401,
  create requires auth) + `pwa-assets.test.ts` (manifest valid, SW bypasses
  `/api/`); web `offline-queue.test.ts` (no-duplicate enqueue, flush keeps
  failures, replay doesn't re-send) + `barcode.test.ts` (resolves a scanned
  code, ean fallback, null when no match). api 50 files / 458 tests; web 19
  files / 111 tests; typecheck + build green.

## P13 — PWA goods-in & stock-take screens (2026-06-18)

- **Goods-in screen** (`routes/_authed/pwa/goods-in.tsx`): scan/enter a product
  code (resolved via `resolveBarcodeToProduct`), set received qty in
  purchase units with a live purchase→stock figure, submit → P8 `/goods-in`,
  offline-tolerant.
- **Stock-take screen** (`routes/_authed/pwa/stock-take.tsx`): pick a scope,
  open a take (P9), enter counts per line (fungibles bucketed to a quantum)
  with a running variance vs book, save counts then approve → true-up.
- **Offline-aware submit** (`lib/offline-submit.ts`): `submitOrQueue` POSTs when
  online and queues on offline/failure; `syncQueue` replays on reconnect. Each
  action carries a client idempotency id, so a replay applies exactly once
  (server-side dedupe). Front-end UoM helpers (`lib/uom.ts`:
  `purchaseToStock`, `bucketCount`). Hooks in `features/pwa/use-pwa-jobs.ts`;
  sidebar items added.
- Tests: `offline-submit.test.ts` (online sends; offline/failure queues; a
  reconnect flush applies each queued action exactly once) + the UoM helpers.
  The screens wire to the already-tested P8/P9 services. web 21 files / 117
  tests; typecheck + build green (api unchanged at 50 files / 458 tests).

## P14 — Read-only MCP server for Claude / Cowork (2026-06-18) — END OF PHASE 1

- **MCP server** mounted at root: `POST /mcp` (MCP JSON-RPC — initialize /
  tools/list / tools/call, implemented directly over HTTP, DECISIONS D8) +
  `GET /.well-known/oauth-protected-resource` (RFC 9728 discovery).
- **Auth**: a new `mcp:read` api-key scope (added to `apiKeyScopeSchema`;
  `mcp:write` reserved for P19); `/mcp` is bearer-authed and, on 401, returns
  the RFC 9728 `WWW-Authenticate: Bearer resource_metadata="…"` hint. Every
  tool call audited to `mcp_audit_log` (migration `0026`, best-effort).
- **Read tools** (`modules/mcp/tools.ts`) wrap the same services the REST routes
  use: `stock_on_hand`, `low_stock`, `reorder_suggestions`, `stock_valuation`,
  `purchase_order_status`, `product_lookup`; `consumption_variance` /
  `wastage_report` / `sessions_awaiting_consumption` return `{ available:false }`
  until their data lands (P16-P18). `site` args resolve by id / slug / name.
- Tests: `mcp.routes.test.ts` — discovery metadata; an unauthenticated /mcp
  call → 401 with the resource-metadata hint; tools/list + initialize; a tool
  returns the same data as its service and writes one audit row. api 51 files /
  462 tests; typecheck + build green. **Phase 1 (P1–P14) complete.**

## P15 — Recipes / BOM (2026-06-18) — Phase 2 begins

- **Schema** (`recipes`, `recipe_lines`, migration `0027`): a versioned,
  date-effective recipe per experience (CLASSIC/SWEETER/ULTIMATE) with an
  optional per-site override (nullable `site_id`); lines carry an
  INGREDIENT/PACKAGING `product_id`, `qty_per_cover`, `stock_uom` and a
  `unit_cost`. Plus a nullable `products.experience_type` flag on the Tonic
  experience product — the hook used to resolve a session's experience + covers
  from its order lines (DECISIONS D9).
- **RecipeService**: creates a new version (allocates the next version for the
  experience+scope), seeding each line's `unit_cost` + `stock_uom` from the
  product (BumbleBee `cost_price` lands in `expected_next_cost`) unless given;
  list / get.
- **ExpectedConsumptionService**: `getEffectiveRecipe` (per-site override beats
  global; newest effective version on the date wins); `expectedForExperience`
  (Σ qty_per_cover × covers per ingredient, with expected cost);
  `expectedForSession` (aggregates a mixed-experience session);
  `resolveCoverGroups` (maps order lines → {experience, covers} via
  `products.experience_type`).
- **API** (`/api/v1/recipes`, JWT): list, get, create-version, `GET /effective`,
  `POST /expected`. **Admin SPA**: a Recipes page (`/recipes`) — versioned
  editor with experience, scope (Global or a per-site override), effective
  dates, and an ingredient/qty-per-cover line builder; sidebar nav added.
- Tests: cost seed maps from the product; expected = Σ(qty_per_cover × covers);
  a mixed-experience session aggregates and resolves covers from lines;
  date-effective version selection; per-site override beats global. api 52
  files / 467 tests; web 20 files / 117 tests; typecheck + build green.

## P16 — Head-baker end-of-session consumption form (2026-06-18)

- **Schema** (`session_consumption`, `session_consumption_lines`, migration
  `0028`): one record per BumbleBee session (unique on session id) with the
  baker (chosen at submit), `version`, `client_key`, `materials_cost`; lines
  carry expected / actual / wastage(+reason) / unit_cost / variance.
- **SessionConsumptionService.submit**: writes/amends the record, decrements
  site stock by the actual (CONSUMPTION) and wastage (WASTAGE) — total = actual
  + wastage — records variance (actual − expected, expected recomputed from the
  recipe), and computes materials cost. **Amend posts only the corrective delta**
  (old − new) keyed `v{version}`, so the ledger always equals the current
  quantities; an **offline replay** with the same `client_key` is a no-op
  (DECISIONS D10).
- **Site scope**: a head-baker PIN token carries its `siteId`; `canAccessSite`
  (new helper) lets the submit route + service reject a cross-site submit
  (`forbidden_site_scope`) without weakening existing auth.
- **Sessions awaiting**: a guarded `BumbleBeeSessionClient` polls the day's
  sessions (returns [] unconfigured); `filterAwaiting` diffs them against
  records — used by the dashboard and the now-wired P14 MCP tool
  `sessions_awaiting_consumption`.
- **API** (`/api/v1/session-consumption`, JWT): list, awaiting, by-session, get,
  submit. **Web**: a PWA end-of-session form (`/pwa/consumption`) — load expected
  by experience × covers, confirm/edit actual + wastage + reason, identity at
  submit, offline-tolerant; an admin dashboard (`/consumption`) for awaiting +
  recent records; two sidebar nav items.
- Tests: actual + wastage decrement separately (with reason); variance + cost;
  amend posts only the delta (one record, version bumps); offline replay no-op;
  cross-site submit rejected; filterAwaiting. api 53 files / 472 tests; web 20
  files / 117 tests; typecheck + build green.

## P17 — Per-session materials cost → BumbleBee, COGS/wastage → Xero (2026-06-18)

- **Materials cost → BumbleBee** (`MaterialsCostSyncService`): `submit` fires a
  best-effort post-commit push of the session's materials cost (Σ actual × unit
  cost). Guarded + dry-run by default (`MATERIALS_COST_SYNC` off / no BumbleBee
  URL → logs the payload, sends nothing). Idempotent on BumbleBee's convention —
  `bumblebee_sync_log` unique on `(source_system='autostock', session_id,
  content_hash)` where the hash is over the value (`materials_cost|version`), so
  a re-push is a no-op and an amended cost re-pushes (migration `0029`,
  DECISIONS D11).
- **Daily COGS / wastage → Xero** (`ConsumptionSweepService.runDaily`):
  aggregates `Σ(actual × unit_cost)` = COGS and `Σ(wastage × unit_cost)` =
  wastage per site for a day and posts one balanced journal each via
  `XeroGLService.postConsumptionCOGS` / `postWastage` — periodic (locked
  decision 8), idempotent on the per-(site,day) GL key, dry-run by default.
- **API**: `POST /session-consumption/sweep` (daily COGS/wastage) +
  `POST /session-consumption/:id/sync-cost` (re-push). **Web**: a "Run
  COGS/wastage sweep" action on the consumption dashboard (materials cost was
  already surfaced there).
- Tests: materials cost = Σ(actual × unit cost); the BumbleBee push is
  dry-run-safe + idempotent (one log row on re-push); the daily sweep posts one
  balanced COGS + wastage journal per site/day and is a no-op on re-run. api 54
  files / 474 tests; web 20 files / 117 tests; typecheck + build green.

## P18 — Expected/actual/counted variance & wastage reporting (2026-06-18)

- **ConsumptionReportService** triangulates the three views per product/site/
  period: expected (recipe × covers) + actual + wastage from the consumption
  lines, counted/shrinkage (= Σ stock-take variance = counted − book) from
  approved stock-takes. Derives portion drift (variance %), wastage hot-spots,
  shrinkage, and food cost. A `covers` column added to the consumption header
  (migration `0030`) powers cost-per-cover; food-cost % uses an operator-supplied
  period revenue (BumbleBee-sourced later) — DECISIONS D12.
- **API** (`/api/v1/reports/*`, JWT): `consumption-variance`, `wastage`,
  `food-cost`, all worst-first. The P14 MCP stubs `consumption_variance` /
  `wastage_report` are now wired to the service.
- **Web**: a Reports page (`/reports`) — date range + site filter, three tabs
  (portion variance, wastage, food cost), plain-English; sidebar nav added.
- Tests: the variance report reconciles expected/actual and includes shrinkage
  (counted − book); food-cost % matches a hand-computed value (37.50 ÷ 150 =
  25%); wastage hot-spots with reasons; the period filter excludes out-of-window
  sessions. api 55 files / 478 tests; web 20 files / 117 tests; typecheck +
  build green.

## P19 — Guarded MCP action tools (2026-06-18) — END OF PHASE 2

- **Five write tools** (`action-tools.ts`, gated by the `mcp:write` scope):
  `adjust_stock`, `set_reorder_level`, `start_stock_take`, `approve_reorder`,
  `create_purchase_order` — each wraps an existing service so the mutation lands
  in the same ledger (`stock_movements`, `stock_levels`, `stock_takes`,
  `reorder_proposals`) and is audited in `mcp_audit_log` (DECISIONS D13).
- **Two guards**: the dispatch requires `mcp:write` for action tools (a read-only
  key is rejected); and nothing mutates unless `confirm: true` — otherwise the
  tool returns a no-mutation preview. `tools/list` now advertises read + action
  tools; discovery `scopes_supported` includes `mcp:write`.
- Tests (`mcp-actions.test.ts`, over the live `/mcp` endpoint): `adjust_stock`
  with the write scope + confirm performs exactly one audited movement
  (on-hand 1000 → 900); without confirm returns a preview and changes nothing; a
  read-only key is rejected with an `mcp:write` error; a replay with the same
  `idempotencyKey` is a no-op (still one movement). api 56 files / 482 tests; web
  20 files / 117 tests; typecheck + build green. **Phase 2 (P15–P19) complete.**

## P20 — Dallas / US site (2026-06-18) — Phase 3 begins

- **Adding Dallas (USD / IMPERIAL / America-Chicago) needs no migration and no
  schema change** — `sites` carried currency/uom/timezone from P2, the admin
  Sites page already edits them, and imperial UoM round-trips via the existing
  `purchase_to_stock_factor` (1 lb = 16 oz). The gaps were GBP *defaults* on the
  money paths, fixed via one `getSiteCurrency(siteId)` helper (DECISIONS D14):
  - stock movements (GRN / consumption / wastage) write the site's currency;
  - GL journals carry a `currencyCode` (added to `XeroManualJournal` + the GL
    param shapes) — a Dallas GRN / COGS / wastage posts USD;
  - valuation reports per-site value in the site's currency
    (`bySite[].currencyCode`);
  - reorder proposals fall back to the site currency (supplier currency still
    wins).
- Tests: creating Dallas needs no migration; lb ↔ oz round-trips via the factor;
  a Dallas GRN moves 2 lb → 32 oz, the movement + Xero journal are USD, and
  valuation reports Dallas in USD; valuation segregates a GBP and a USD site by
  currency. api 57 files / 486 tests; web 20 files / 117 tests; typecheck +
  build green.

## P21 — Batch & use-by tracking (2026-06-18)

- **Schema** (`stock_batches`, migration `0031`): optional per (product, site) —
  only `require_batch_number` products carry lots — with `batch_code`,
  `received_at`, `use_by`, `qty_remaining`, `unit_cost`. The `stock_movements`
  ledger stays the on-hand source of truth (DECISIONS D15).
- **BatchService**: `receive` (goods-in creates/tops-up a lot); `decrementFEFO`
  (consume earliest `use_by` first, NULLs last); `expired` / `expiringSoon` /
  `expiryReport` (enriched, worst-first). Goods-in records a batch when the line
  carries a code; consumption FEFO-decrements the additional usage for
  batch-tracked products (forward-only). Non-batch items are untouched.
- **API/Web**: `GET /reports/expiry` + an Expiry tab on the Reports page; the PWA
  goods-in form shows batch-code / use-by fields when the product is
  batch-tracked.
- Tests: FEFO consumes the earliest use-by first (EARLY then LATE); an expired
  batch is flagged + soon-to-expire listed; goods-in assigns a batch (2 L → 2000
  ml lot) and creates none for a non-batch product. api 58 files / 490 tests;
  web 20 files / 117 tests; typecheck + build green.

## P22 — Demand-based reorder quantities (2026-06-18)

- **DemandEstimatorService**: `dailyUsage` (Σ SALE+CONSUMPTION decrements ÷
  window), `suggest` (point = usage × lead time; up-to = usage × (lead +
  min_days_cover)), `suggestAll` (per site, history-only), `demandUpTo` (for the
  engine). Advisory — the operator accepts via the normal set-reorder-params
  path; manual levels are never auto-overwritten (DECISIONS D16).
- **Per-site opt-in**: a `sites.demand_reorder` flag (default off, migration
  `0032`) gates `ReorderService.evaluate` — on ⇒ size the order to the
  demand-based up-to (fixed-par fallback if no history); off ⇒ fixed par
  unchanged. Finally uses `min_days_cover` (stored since P6, unused until now).
- **API/Web**: `GET /reorder/suggestions/demand` + `POST
  /reorder/suggestions/accept`; a Demand-suggestions panel with per-row Accept on
  the reorder levels page.
- Tests: the estimator computes 100/day from a 2800-over-28-days fixture;
  suggested levels match hand values (point 300, par 1000); the engine keeps the
  fixed par (1800) with the flag off and sizes from demand (800) with it on;
  accepting updates the level via setReorderParams. api 59 files / 494 tests; web
  20 files / 117 tests; typecheck + build green.

## P23 — AI groundwork (designed-for, not built) (2026-06-18) — END OF PHASE 3

- **Image set** (`image_captures`, migration `0033`): a labelled set keyed by
  SKU + site + timestamp + source (REFERENCE / GOODS_IN / STOCK_TAKE /
  CONSUMPTION / SHELF). `ImageCaptureService`: `record`, `recordPhotoRefs`
  (best-effort, resolves sku→product, swallows per-photo errors), `listForSku`,
  `gallery`, `getByRef`. Goods-in records its photos inside a try/catch so a
  capture can't break the book-in (DECISIONS D17).
- **Stub MCP tools**: `identify_item_from_image` / `count_shelf_from_image`
  return `{ available: false, note: "not enabled in v1" }` + the stored capture
  for the `image_ref` — the surface exists for a later model with no change.
- **API/Web**: `GET/POST /api/v1/image-captures`; an admin Gallery page
  (`/gallery`, filter by site/source) browsing the set; sidebar nav added.
- Tests: captures retrievable by SKU/site/timestamp; `recordPhotoRefs` resolves
  a sku; the stub tools return the not-enabled response (with the stored
  reference, null for an unknown ref) without error; goods-in books in + records
  the valid photo while ignoring a malformed one. api 60 files / 498 tests; web
  21 files / 117 tests; typecheck + build green. **Phase 3 (P20–P23) complete.**

## P24 — Deployment & UI-driven setup (2026-06-18)

- **Fork installer** `infra/install-autostock.sh` (DECISIONS D18): provisions
  Docker + nginx + certbot + Node 22 + Postgres-in-Docker and deploys ONLY
  `apps/api` (REST + MCP) + `apps/web` (admin SPA + iPad PWA) — never
  `apps/store`. Writes a dormant `apps/api/.env` (Xero dry-run, FEATURE_* off,
  sync flags off). `--dry-run` prints a greppable PLAN and changes nothing.
- **systemd timers** (oneshot service + timer, mirroring supplier-poll) for the
  four periodic jobs: `smmta-reorder-sweep` (06:00), `smmta-consumption-sweep`
  (02:00, COGS/wastage→Xero), `smmta-square-poll` (every 15 min),
  `smmta-bumblebee-poll` (every 30 min). Each runs an `apps/api/scripts/run-*.ts`
  CLI; the square/bumblebee pollers are guarded go-live pullers.
- **UI-driven setup** confirmed: sites (P2), recipes (P15), reorder/par + demand
  suggestions (P6/P22), suppliers + channel (P6), Xero account/tax map (P5),
  Square-item map (P10) — all admin pages; only secrets/hostnames in env.
- Tests (`deploy.test.ts`): the install plan deploys api+web+PWA+MCP and omits
  the storefront; the four timer + service units are valid; the app boots with
  the dormant flags off + Xero dry-run; a smoke test hits `/health` and the
  `/mcp` discovery endpoint. api 61 files / 502 tests; web 21 files / 117 tests;
  typecheck + build green.

---

## Operator runbook (go-live)

All operational setup is in the **admin SPA** — only secrets/hostnames live in
`apps/api/.env`.

- **Add a site** → *Sites* → New. Set currency + UoM system + timezone (e.g.
  Dallas = USD / IMPERIAL / America/Chicago). No code change or migration.
- **Set reorder / par levels** → *Reorder levels*: per product, set reorder
  point, par (reorder-up-to), min days cover. Or click **Accept** on a
  *Demand suggestion* to apply demand-based levels. Turn on a site's
  demand-based engine by setting `sites.demand_reorder` (per-site flag).
- **Add recipes** → *Recipes*: per experience (CLASSIC/SWEETER/ULTIMATE), set
  ingredient quantity per cover; date-effective versions; a per-site override
  (e.g. Dallas) beats the global.
- **Connect a supplier** → *Suppliers*: set the ordering channel (EMAIL_PO /
  API_CONNECTOR), order email, auto-place; map supplier products + pack sizes.
- **Map Square items** → *Square mapping*: map each Square catalog item/variation
  to a product (or auto-match by barcode). Unmapped sale lines are parked, not
  lost.
- **Map the Xero chart of accounts** → *Xero accounts*: override the default
  account code + tax type per logical role (STOCK, CONSUMPTION_COGS,
  WASTAGE_WRITE_OFF, GRNI_ACCRUAL, …) to match your Xero.
- **Go-live: flip Xero from read-only** → set `XERO_DRY_RUN=false` in
  `apps/api/.env`, connect Xero (store the OAuth tokens), and confirm against the
  **Demo Company** first. Until then every journal is recorded but not sent.
- **Head-baker iPads** → create a PIN per site (*device PINs*); the baker taps in
  and submits the end-of-session consumption form (`/pwa/consumption`).

## P25 — End-to-end integration test & build report (2026-06-18)

- **`e2e.test.ts`** drives the whole spine across a UK (GBP/metric) + Dallas
  (USD/imperial) site: seed products + recipe → goods-in (on-hand rises, GRN
  posts dry-run) → Square sale (on-hand falls, reorder fires) → stock-take
  true-up (SADJ dry-run) → head-baker consumption (ingredients decrement,
  materials cost £37.50, variance −50) → daily COGS/wastage sweep (dry-run) +
  BumbleBee materials-cost push (dry-run logged) → MCP read tools + one guarded
  write tool (`adjust_stock` + confirm). Asserts the invariants:
  - **ledger sum = on-hand** for every (product, site) (`recomputeOnHand` ==
    cache; flour 9000, cookie 3→5, butter 32 oz);
  - **every GL journal balances** (lines net to 0) **and is dry-run** (every
    `gl_posting_log` row carries a `DRYRUN` marker — nothing sent to a real org);
  - **idempotent replays are no-ops** (goods-in same key, consumption same
    `clientKey`, daily sweep same day);
  - the two sites value in their **own currencies** (GBP / USD).
  No real golden dataset ships — this builds a representative fixture and asserts
  the invariants; **a real sampled golden file is still wanted**.

---

# Build report (Auto-Stock v1)

**What was built**, per phase (all green; `npm run build` + `npm run test` pass
across workspaces):

- **Phase 1 — stock spine (P1–P14):** fork rebrand + dormancy (storefronts,
  Mollie, SendGrid off); sites & per-(product,site) ledger (on-hand = Σ
  movements); item model + UoM (stock/purchase/factor, metric + imperial); ledger
  ops (adjust / transfer / WAC valuation); GL re-pointed to Xero (dry-run);
  suppliers + reorder params; the auto-reorder engine (`reorder_proposals`);
  goods-in; stock-takes; Square → automatic decrement; shared catalogue with
  BumbleBee; the iPad PWA shell + goods-in / stock-take screens; the read-only
  MCP server.
- **Phase 2 — bakery economics (P15–P19):** recipes / BOM (versioned, per-site
  override); the head-baker end-of-session consumption form (decrement + wastage
  + variance); per-session materials cost → BumbleBee + daily COGS/wastage →
  Xero; expected/actual/counted variance + wastage + food-cost reports; guarded
  MCP action tools.
- **Phase 3 — scale & polish (P20–P25):** Dallas (USD/imperial, no migration);
  batch & use-by (FEFO); demand-based reorder (opt-in per site); AI groundwork
  (image set + stub tools); deployment + UI-driven setup + runbook; this e2e.

**Locked-decision defaults used:** 5 UK sites + Dallas; item kinds
MERCH/RETAIL/INGREDIENT/PACKAGING; experiences CLASSIC/SWEETER/ULTIMATE;
per-(product,site) running-sum ledger; BumbleBee `core.products.id` as shared
identity; Square decrement idempotent on `(channel,source_pk,line_ref)`;
head-baker chosen at submit; recipes UI-maintained global + per-site override;
**Xero COGS as a periodic daily sweep, `XERO_DRY_RUN=true`, Demo Company only**;
suppliers `EMAIL_PO` default; iPad shared-device PWA with PIN. All non-obvious
divergences are in `DECISIONS.md` (D1–D18).

**Degraded to dry-run / fixture (go-live wiring, not gaps):**
- **Xero** posts are recorded + balanced but **not sent** (`XERO_DRY_RUN=true`);
  flip to `false` against the **Demo Company** first.
- **BumbleBee** outbound (catalogue + materials-cost) is dry-run until the
  BumbleBee write endpoints exist (`CATALOGUE_SYNC` / `MATERIALS_COST_SYNC` off).
- **Square** + **BumbleBee session** pollers are guarded — they no-op without
  `SQUARE_ACCESS_TOKEN` / `BUMBLEBEE_API_BASE_URL` (the decrement + awaiting
  logic itself is fully built + tested).
- **AI item recognition** is groundwork only — the image set accumulates; the
  stub MCP tools return "not enabled in v1".
- The e2e uses a **built fixture**, not a sampled golden dataset (still wanted).

**Human go-live checklist:**
1. Run `infra/install-autostock.sh` (api + web + PWA + MCP; storefront stays
   dormant); confirm the four systemd timers are active.
2. Do the UI-driven setup (the runbook above): sites, recipes, reorder/par
   levels, suppliers + channel, Xero account/tax map, Square-item map.
3. Create head-baker PINs per site; issue an MCP api-key (`mcp:read`, and
   `mcp:write` only if Claude/Cowork should take guarded actions).
4. Connect Xero (store OAuth tokens) and **verify against the Demo Company**,
   then flip `XERO_DRY_RUN=false`.
5. Wire the live Square Orders pull + the BumbleBee session/write endpoints;
   turn on `CATALOGUE_SYNC` / `MATERIALS_COST_SYNC` when ready.
6. Capture a real sampled golden dataset and re-run the e2e against it.

---

## Post-build: recipes re-keyed by cake (2026-06-19)

Owner correction: recipes were wrongly keyed by an `experience_type` enum
(CLASSIC/SWEETER/ULTIMATE). Those are **experience packages** (pricing bundles of
experience + merch + beverage), not recipes — two guests on different packages
bake the same cake. Re-keyed recipes by the **cake** (`recipes.bake`, free-form;
one cake per session; covers = guests), replaced `products.experience_type` with
`products.is_experience_booking`, added `session_consumption.bake`, wired the
admin + PWA forms to a cake field, and seeded the four launch cakes (Burger
Cake, Victoria Sponge, Coffee & Walnut Delight, Battenburg) with standard
British-recipe ingredients via `scripts/seed-bakes.ts`. Two-pass migration
(`0034` add / `0035` drop) keeps it non-interactive (DECISIONS D19). api 62 files
/ 510 tests; web 21 / 117; typecheck + build green.

**Local demo runs on its own DB.** The dev app uses a separate `smmta_dev`
database (seeded with sites + a login + the cakes) so demo data never pollutes
the `smmta_next` **test** DB. Start the api for the demo with
`DATABASE_URL=…/smmta_dev npm run dev -w @smmta/api`; tests keep using
`…/smmta_next`.

---

## P26 — Stock-take-lite: the standalone iPad stock-take demo (2026-06-25)

A separate, deliberately **decoupled** stock-take PWA to win site managers over
before the full Auto-Stock rollout, built for the **end-of-June** quarter count.
Distinct from the existing count-vs-book `stock_takes` tool: this is a blank
count seeded from the head-office spreadsheet, output as a plain CSV — no
products, no ledger, no Xero.

**Catalogue (Phase 1).** Parsed the master spreadsheet's "Stockcount List JUNE
2026" sheet into a 386-item seed (`apps/stocktake/src/data/catalogue.json`),
across 6 areas / 39 sections. Header-vs-item is detected by **cell bold**
(bold col-A = heading; a bold row followed by another bold row = top-level area).
SheetJS can't read bold, so the generator is Python+openpyxl
(`apps/stocktake/scripts/build-catalogue.py`).

**Backend (Phase 2, in `apps/api`).** New isolated module `stocktake-lite` +
two tables (`stocktake_lite_counts`, `stocktake_lite_resolutions`, migration
`0036`), no FK to products/sites/ledger. `POST /sync` upserts a device's counts
(idempotent on company+period+device+item). Consolidation groups by item across
devices: one counter ⇒ resolved; two or more ⇒ **CONFLICT** (never summed),
cleared by a resolution row. `GET /export.csv` emits resolved rows and lists
conflicts separately. Access-code gated (`x-stocktake-code` vs
`STOCKTAKE_ACCESS_CODE`), not JWT. 7 service tests green; full HTTP smoke test of
sync → conflict → resolve → CSV passed.

**PWA (Phase 3/4, new `apps/stocktake`).** Vite + React 19, offline-first
(catalogue bundled, counts in localStorage, sync-when-online), installable
(manifest + service worker + icons). Start screen (site + counter + access code),
the big-button count screen (hero "0", ± steppers, tap-to-type, pack-size hints,
counted-vs-not state where **0 is a real count**, progress, "not counted" filter,
search, section nav, add-any-line), and a head-office consolidation screen
(per-site conflicts, resolve, CSV export). Typecheck + 5 unit tests + production
build green; verified visually in the preview at iPad size.

**Deploy (Phase 5, prepared).** nginx template
`infra/nginx/stocktake.conf.template` (static dist + `/api` proxy, no-cache on
`sw.js`); target host `stocktake.starship.thebigbakes.com`. The VPS deploy
itself is the remaining step.

---

# August 2026 feedback fix set (F1 … F15)

Closing out the 12 Aug 2026 South London live test (iPad + laptop). The raw
feedback and the traced defect register (A-1 … F-8) are in
`docs/FEEDBACK_2026-08-12.md`; F15 closes out against that checklist.

## F1 — Baseline, defect register in-repo, and the iPad repro harness (2026-08-19)

**Baseline on the untouched `autostock` tree** (commit `d40761d`, Node v22.22.2,
npm 10.9.7, Postgres 16.13 on `127.0.0.1:5435`):

| Check | Result |
|---|---|
| `npm run build` (`@smmta/shared-types`, `@smmta/api`, `@smmta/web`) | **green** |
| `npm run typecheck` | **1 failed** — `@smmta/api`, see below |
| API Vitest (`DATABASE_URL=…5435/smmta_next`) | **1 failed / 575 passed (576)** — see below |
| Web Vitest | **green — 128 passed (21 files)** |

**Two pre-existing reds, fixed here and nothing else.**

`npm run typecheck -w @smmta/api` failed with
`scripts/seed-count-categories.ts(35,68): error TS2823: Import attributes are
only supported when the '--module' option is set to …`. The script imports the
count sheet with `with { type: 'json' }`, which this workspace's `module:
"Node16"` rejects — `tsx` runs it happily, which is how it landed. It reads the
same file with `readFileSync` now; no behaviour change, and no repo-wide
`module` bump (that would have a far wider blast radius than "fix only what is
red"). `apps/api`'s **build** was always green because `tsconfig.json` includes
only `src`; only `tsconfig.test.json` covers `scripts`.

`src/pwa-assets.test.ts > ships a valid web manifest` asserted
`m.name).toMatch(/Auto-Stock/)`, but commit `d40761d` ("call the app Big Bakes
Stock on screen") renamed the manifest to `Big Bakes Stock`. The test was stale,
not the manifest — the assertion now matches `/Big Bakes Stock/`. No product
code changed.

**Dormant storefronts do not build in this environment.** `@smmta/store` and
`@smmta/store-clothes` fail their `next build` fetching Google Fonts through the
sandbox's TLS-inspecting proxy (`SELF_SIGNED_CERT_IN_CHAIN`). Both are dormant
for Auto-Stock (CLAUDE.md §"What's dormant" — not built, not deployed), so the
baseline and every subsequent gate build `--filter=@smmta/api --filter=@smmta/web`.
This is an environment limitation, not a defect, and no storefront file is
touched by this fix set.

**Built in F1:**

- `docs/FEEDBACK_2026-08-12.md` — verbatim tester feedback + the full A-1 … F-8
  register with the traced root cause for each.
- `apps/web/playwright.config.ts` — three projects: `desktop` (was `chromium`),
  `ipad-portrait` (`devices['iPad Pro 11']`) and `ipad-landscape`
  (`devices['iPad Pro 11 landscape']`). Both descriptor names were confirmed
  present in the installed Playwright 1.59.1 device list, so no substitution was
  needed. `workers: 1` and the existing `webServer` wiring are unchanged.
  **Honest limitation, recorded in the config header:** Playwright drives
  Chromium, not WebKit-on-iOS, so these projects catch layout / focus / hit-test
  regressions but NOT iOS Safari's own keyboard and visual-viewport behaviour.
  No WebKit browser binary is available in this environment, so no `webkit`
  project was added; F15's manual retest script stays the final check on a real
  iPad.
- `apps/web/e2e/helpers/touch.ts` — PIN sign-in (stubbing `POST /auth/pin-login`
  where no live API is available), per-screen navigation, and the two assertions
  the 12 Aug failure needs: `expectTopbarVisible` (the topbar's bounding box sits
  fully inside the viewport) and `expectFirstBodyControlHittable`.
- `apps/web/e2e/pwa-layout.spec.ts` — 30 `test.fixme()` specs (3 screens × 2
  orientations × B-1/B-4/B-5, plus B-2). Verified they report as **skipped
  (expected failures)**, not errors. F5 unfixmes them.

Gates: `npm run build` green, `npm run typecheck` green, API Vitest 576 passed,
web Vitest 128 passed, Playwright discovers all three projects.
