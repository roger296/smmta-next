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

## F2 — Tell the truth about saved work (A-1 … A-6) (2026-08-19)

The single most important fix in this set. A rejected submission was reported
to the venue as "Saved offline — will sync", and the offline queue was never
replayed. Bakers were told their work was saved when it had been discarded.

**`lib/offline-submit.ts`** — the bare `catch {}` is gone. `SubmitOutcome` is
now `'sent' | 'queued' | 'rejected'`, classified on one question: *will
retrying this ever succeed?*

| Failure | Outcome | Why |
|---|---|---|
| `TypeError` from `fetch`, or `navigator.onLine === false` | `queued` | The payload never reached the server |
| HTTP 4xx (not 408/429) | **`rejected`, NOT enqueued** | The server looked at the payload and refused it; it will refuse it identically every time |
| HTTP 5xx, 408, 429 | `queued` with `attempts` + `lastError` | The server is unwell, not the payload |

**`lib/offline-queue.ts`** — `QueuedAction` gains `attempts`, `lastError`,
`lastTriedAt` and a `label`. `subscribe()` lets the UI observe depth. On flush,
an action that fails `DEFAULT_MAX_ATTEMPTS` (5) times moves to a **dead-letter**
list instead of retrying for ever, and `revive()` / `discard()` let a human act
on it. A queue that never gives up is indistinguishable from one that never runs.

**`features/pwa/use-pwa-jobs.ts`** —
- `usePwaQueueState()` → `{ pending, deadLettered, isFlushing, isOnline, lastSyncedAt }`.
- `PwaQueueSync` — mount-once wiring that calls the flush on app boot, on
  `window` `online`, and on `visibilitychange` back to visible (an iPad waking
  from standby often fires only the latter). **`flushPwaQueue` previously had
  zero call sites — that was defect A-2.** Mounted in `App.tsx` for now; F5
  gives it a home in the `_touch` layout. `flushPwaQueueOnce` guards against
  overlapping runs, which would otherwise double-send when `online` and
  `visibilitychange` land in the same frame.
- `ConsumptionLineDraft` now declares `entryMode` and `remainingQty` (defect
  F-8) so the client type matches what `POST /session-consumption` validates.

**All three venue screens** — every `mutateAsync` is inside a `try/catch`. On
`'rejected'` they show a **persistent, dismissible in-screen `ErrorBanner`**
(`.notice.warn`, `role="alert"`) quoting the server's own message and **leave
the user's entries on screen**. The form clears only on `'sent'` or `'queued'`.
`addByCode` in goods-in catches lookup failures and surfaces them (A-6) —
previously a thrown lookup did nothing at all.

**`SyncPill`** is driven by real queue depth via the new `PwaSyncPill`, not by
`mutation.isPending` (A-3). Its `pending` / `offline` branches were dead code;
they are live now and carry a count, because "Pending" alone does not answer
the question a baker has, which is *how much*. Tapping it opens a **queue
drawer** listing pending and dead-lettered actions with their error, "retry
now", and a "discard" that requires confirmation (A-4).

**Tests** (red-to-green verified: reverting only `offline-submit.ts` fails 7 of
them):
- `offline-submit.test.ts` — 400/403/404/409/422 reject and do **not** enqueue;
  500 enqueues with an attempt stamp; 408/429 enqueue despite being 4xx;
  `TypeError` enqueues; an offline navigator enqueues without attempting a
  send; dead-lettering after N attempts; revive; discard; subscriber notify.
- `use-pwa-jobs.test.tsx` — flush fires on boot, on `online`, and on
  `visibilitychange`; no flush attempt while offline; queue depth and dead
  letters propagate to `usePwaQueueState`.
- `queue-status.test.tsx` — the pill reads "All saved" only when genuinely
  empty, shows a count when not, shows offline; the drawer lists queued work
  with its error; discard needs confirming.
- `pwa-submit.test.tsx` (component) — goods-in and stock-take, given a mocked
  400, show the banner, retain their entries, queue nothing and show no success
  message; given a network failure, show "saved offline" **and** leave a pending
  action behind.
- `e2e/pwa-submit.spec.ts` (both iPad projects) — stub a 400, submit goods-in,
  assert the banner and that the line is still on screen.

**Environment note:** the iPad device descriptors default to WebKit, and no
WebKit binary can be installed here (the download fails). The iPad projects now
pin `browserName: 'chromium'` — the device *metrics* are what they contribute.
The image also ships a Chromium build (1194) older than the one Playwright
1.59.1 manages (1217), so the config reads an optional
`PLAYWRIGHT_CHROMIUM_EXECUTABLE` env var; unset, Playwright uses its own
managed browser as normal. Locally the specs run with
`PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium`.

Also: `vite.config.ts` gained `routeFileIgnorePattern` so a test colocated with
a route file stops warning the route generator on every boot.

## F3 — Stock-take shows product names, not UUID fragments (D-1, D-1b, D-3) (2026-08-19)

The tester could not log a single count because every row read as a raw
alphanumeric string.

**The chain:** `useProductMap` requested `/products?pageSize=500`;
`paginationSchema` caps `pageSize` at 250, so the request **400d**, `apiFetch`
threw, the query errored, `productMap` was `undefined`, and the row fell back to
`l.productId.slice(0, 8)`.

**Server-side, the real fix (D-1b).** `POST /stock-takes` (and `GET
/stock-takes/:id`) now return `productName`, `stockCode`, `stockUom` and
`itemKind` on every line, via a new `linesWithProduct()`. The count screen
should not need a second, larger, fallible request to know what it is asking
someone to count. Deliberately a **LEFT** join with null-coalescing, so if the
`stock_take_lines → products` FK is ever relaxed a nameless line degrades to
"Unknown product" rather than vanishing from the count sheet.

**Client.** `TakeLine` carries the identity and the row renders from it.
`useProductMap` survives only as a supplementary lookup and is no longer
load-bearing: it asks for `MAX_PAGE_SIZE`, **pages through to completion**
(a venue with more than 250 stocked lines was seeing a partial map even when
the request succeeded), retries once rather than hammering a failing endpoint
from a venue iPad, and a failure now degrades the screen instead of emptying it.
A line with no name renders `Unknown product (<stockCode>)` with a `warn` dot —
never a bare hex fragment.

**Search (D-3)** matches name **and** `stockCode`. The "N of M counted" stat is
computed from the lines and the counts alone, so it never depended on the map.

**Guarding the class of bug.** `MAX_PAGE_SIZE` is exported from the API's
pagination module (with the cap named in the Zod message) and mirrored in
`apps/web/src/lib/api-client.ts`. A new `page-size-guard.test.ts` walks every
file under `apps/web/src` and fails on any `pageSize` literal above it.

**It immediately found three more live instances of the same latent 400** —
`features/orders/order-form.tsx`, `features/purchasing/po-form.tsx` and
`routes/_authed/stock/adjust.tsx` all requested `pageSize: 500`. All three are
fixed. That is the guard earning its place on the day it was written.

**Bucketing is explicitly disabled at the count call site** pending F4. The
stock-take now passes `bucketCount(qty, uom, 0)` — `0` means no bucketing — so
removing D-1's mask does **not** start destroying counts. See DECISIONS for why
this deviates from the prompt's "F3 is red until F4 lands".

**Tests** (red-to-green verified: reverting only `stock-take.tsx` fails 4 of the
new web tests):
- API: opening a take returns lines carrying `productName` / `stockUom` /
  `itemKind`; `GET` carries it too so a resumed take is legible; the join never
  drops a line.
- API: `GET /products?pageSize=500` → 400 with the cap in the body;
  `pageSize=250` → 200. Plus schema-level tests on the cap itself.
- Web: the count screen renders names with the product map **deliberately
  returning 500**; no row label matches `/^[0-9a-f]{8}$/`; a nameless line reads
  "Unknown product (ING-MYSTERY)"; search matches stock code and name; the
  counted stat works without the map.
- Web: `page-size-guard.test.ts` — the cross-cutting guard.
- Playwright (iPad): the first row's label is a real product name; search finds
  a row by its stock code.

`apps/web/tsconfig.json` gained `"node"` to its `types` (the guard test reads
the source tree). That let the now-redundant `@ts-expect-error` in
`e2e/helpers/auth.ts` go.

## F4 — Stop rounding counts to the nearest 100 (D-2) (2026-08-19)

`bucketCount` defaulted `quantum = 100`, so every non-discrete count was
silently rounded to the nearest 100 **stock units**. A 4 kg count of icing
sugar submitted as **0**; a 250 g count as 300. On approval the ledger is
trued up to the destroyed figure, so the loss is permanent and invisible.

This was masked in production by D-1 — with no product map the UoM fell back to
`each`, which is discrete and never bucketed. F3 removed that mask, which is
why the pair are inseparable. (F3 shipped with bucketing explicitly disabled at
the call site rather than red, so no commit ever destroyed a count — see
DECISIONS.)

**The blanket default is gone.** `bucketCount(qty, uom, quantum?)` returns
`qty` unchanged when the quantum is null/undefined/≤0 **or** the UoM is
discrete. There is no default value at all, so no call site can inherit
bucketing by accident.

**Per-product quantum.** New nullable `products.count_quantum`
(`numeric(18,4)`, migration `0041_product_count_quantum`) with a CHECK that it
is either NULL or > 0 — "no bucketing" is spelled NULL, never 0, so "nobody has
configured this" and "counted whole deliberately" stay distinguishable. It is
admin-editable on the product page (with a hint saying blank is almost always
right), carried through `createProductSchema` / `updateProductSchema`, and
returned on every stock-take line so the count screen reads the product's own
setting.

**Bucketing is now visible.** A row with an active quantum renders
"rounded to nearest 100 g" beside its book figure, so a counter sees what
happened to their number instead of discovering it on the variance report.

**A zeroed count is no longer silent.** `countedQty: z.coerce.number().min(0)`
accepts 0 without complaint and approval writes it straight to the ledger — the
exact path by which D-2's destroyed counts would have been made permanent. New
`varianceWarnings()` flags any line counted 0 against a non-zero book figure;
`GET /stock-takes/:id` carries the warnings, and `POST /:id/approve` reads them
**before** truing up (afterwards the variance is zero and there is nothing left
to point at). It is a warning, not a block — a genuinely empty shelf is a real
answer.

**Migration note.** `db:generate` also re-emitted the recipe-line, entry-mode
and table-split changes, because the hand-authored 0038/0039/0040 never
regenerated a snapshot. Those are already applied and their un-guarded
`ADD COLUMN`s would fail, so `0041`'s SQL was trimmed to the new column alone
(with the reason recorded in the migration itself). The generated **snapshot**
is kept, which re-syncs the chain so the next `db:generate` diffs from truth.

**Tests** (red-to-green verified: restoring the `= 100` default fails 5 of them):
- Unit: `bucketCount(4, 'kg')` → `4`; `bucketCount(250, 'g')` → `250`;
  `bucketCount(4, 'each')` → `4`; `bucketCount(0.5, 'kg')` → `0.5`;
  `bucketCount(250, 'g', 100)` → `300` (explicit opt-in only); undefined / null
  / 0 / negative all mean "do not bucket"; a discrete UoM is never bucketed even
  with a quantum configured. Plus `bucketNote`.
- **Named regression:** `stock-take-bucketing.test.tsx` — a 4 kg count submits
  `countedQty: 4` end to end through `useRecordStockTakeCounts`, asserted on a
  spy over the real request body. Also: a product WITH a quantum is still
  bucketed (opt-in works), and a bucketed row says so on screen.
- API: approving trues the ledger to the submitted figure exactly; a 0 count
  against a non-zero book raises a `COUNTED_TO_ZERO` warning naming the product;
  0-against-0 and uncounted lines raise nothing; the quantum reaches the line.
- API schema: `count_quantum` defaults NULL on every row; stores at 4dp;
  rejects 0 and negatives.

## F5 — Venue screens out of the admin chrome, pinned to the visual viewport (B-1 … B-6) (2026-08-19)

The single most disruptive iPad symptom: "screen formatting cuts off the top of
the page rendering any initial line inputs invisible and uneditable", in both
orientations.

**The chain.** `.touch-app` is `position: fixed; inset: 0`, rendered *inside*
the `_authed` desktop shell (a `min-h-screen` flex layout with a sidebar, a
header and `<main className="flex-1 overflow-auto p-6">`). Nothing in
`apps/web/src` referenced `window.visualViewport`, nothing locked background
scroll, sizing was `100vh` not `dvh`, and `goods-in.tsx` had `autoFocus` on the
barcode input. So on iPad the keyboard opened on load, iOS shrank the visual
viewport, and Safari scrolled the fixed overlay off the top of the glass with
no way back. (Confirmed *not* a transformed-ancestor problem — no
`transform`/`filter`/`contain`/`will-change` ancestor exists.)

**New `_touch` layout route** (`routes/_touch/route.tsx`) — the same auth guard
as `_authed` but redirecting to `/pin-login`, the same `SiteProvider`, and
nothing else. `/pwa/goods-in`, `/pwa/stock-take` and `/pwa/consumption` moved
under it; the **URLs are unchanged** (the layout is pathless), so `NAV_ITEMS`
and every existing link still work. The desktop admin SPA is untouched.

**Sized to the real viewport.** `.touch-app` now layers `100vh` → `100dvh` →
`var(--tvv-height)`, with `transform: translateY(var(--tvv-offset))`. The
`--tvv-*` variables come from the new `use-visual-viewport.ts` hook
(subscribing to `visualViewport` `resize` **and** `scroll`, plus window
`resize`/`orientationchange`), published by `TouchViewportLock`, which also
takes the body scroll lock (`overflow: hidden`, `position: fixed`,
`overscroll-behavior: none`) and restores it on unmount. Where `visualViewport`
is absent the hook reports `supported: false` and the vars are *removed* rather
than set to a guess, so the stylesheet's own `dvh` fallback wins.

**`autoFocus` removed** from the goods-in barcode input (B-2), replaced with a
"Scan or type a code" affordance. On a shared venue iPad the keyboard should
open when someone taps the field, not on arrival.

**Focused controls stay in view** — `focusin` inside `.touch-app` scrolls the
target with `scrollIntoView({ block: 'nearest' })`, scoped to the `.scroll`
container and deferred a frame (at `focusin` iOS has not resized yet). Never a
document-level scroll: that is precisely what dragged the shell off the glass.

**Venue name on every screen (B-5).** `TouchTopbar`'s `venue` prop is
**required, not optional** — it was optional before, and the two screens that
silently omitted it are exactly the two the tester reported. Making it required
turned the defect into five compile errors. A `--bar-venue` token gives the chip
white-on-accent, and an unbound site renders the `warn` variant reading "not set
for this device". `/pin-login` shows the device's bound venue too, from the new
`device-site.ts` store (which also lays the groundwork for E-1 in F7).

**Desktop contrast (B-6).** `SiteSwitcher` now sets
`text-[var(--color-foreground)]` explicitly. It sat in the navy header, so it
inherited `--color-shell-foreground` — a pale grey meant for a dark ground — on
the trigger's near-white background: **1.6:1**, on the one control that says
where stock is being booked. It is ~13:1 now.

**A second contrast bug, found by writing the test.** The venue chip's `warn`
variant initially reused `--warn` (`#b9770b`), which is tuned for dark text on
a pale badge — white on it is **3.7:1**, under AA. A darkened
`--bar-venue-warn` (`#95500a`, 6.1:1) replaces it, and the test asserts both
that the new token passes *and* that the old one does not, so it cannot quietly
come back.

**Tests:**
- Playwright, **both iPad orientations**, all three screens: B-1 (topbar fully
  inside the viewport and the first body control hit-testable, before and after
  focusing an input), B-4 (no sidebar, no header, no padded main, and
  `body { overflow: hidden }`), B-5 (the chip shows the real venue *name*, not
  a placeholder). Plus B-2, and pin-login's bound / unbound venue states.
- **`B-1 MECHANISM`** — the important one. Chromium has no soft keyboard, so
  merely focusing an input does not shrink the visual viewport, and the plain
  B-1 specs pass on the broken tree too. This spec installs a stub
  `window.visualViewport` reporting a shrunken, offset viewport — what iOS
  actually does — and asserts the shell tracks it. It **fails** against the
  pre-F5 tree.
- Unit: `use-visual-viewport` follows resize and scroll, no-ops safely when the
  API is absent, unsubscribes on unmount; `applyVisualViewportVars` publishes
  and (when unsupported) *removes* the vars.
- Unit: contrast on both the site switcher and the venue chip, computed from
  the tokens themselves.
- The F1 layout specs are unfixmed. Red-to-green verified: **9 of 12 fail**
  against the pre-F5 tree (the three that pass are the plain B-1 specs, for the
  no-soft-keyboard reason above — which is why the MECHANISM spec exists).
- The existing desktop suite stays green, confirming the admin pages are
  unchanged.

**Two more pre-existing reds, found because F1 made Playwright a gate.**
`e2e/login.spec.ts` was written against a login page that took a **pasted
JWT**; the app replaced that with real `POST /auth/login` credentials some time
ago, and all three specs failed on the untouched `autostock` branch (verified by
checking the branch out and running them). Rewritten against the actual email +
password form. Separately, both `login.spec.ts` and F1's own B-4 assertion
looked for `getByRole('navigation', …)`, but the sidebar is an `<aside>` —
role `complementary`. The B-4 assertion was therefore passing vacuously;
corrected, and it still passes for the right reason now. `customers-empty.spec`
needs a running API and passes once one is up.

**One deliberate deviation.** F2's note said F5 would move `PwaQueueSync` into
the `_touch` layout. It stays at the app root instead: a device may regain
connectivity on any page, including `/pin-login` before anyone has signed back
in, and scoping the replayer to the venue layout would leave unsent work
waiting for someone to navigate back to a venue screen — a smaller version of
A-2 itself.

## F6 — PIN login as the iPad home-screen entry point (E-2, E-6) (2026-08-19)

"Adding the iPad PIN login page to the home screen redirects incorrectly to the
standard email login page." `manifest.webmanifest` set `start_url: "/"`; `/` is
under `_authed`, whose `beforeLoad` sends an unauthenticated visitor to
`/login`.

- **Manifest:** `start_url: "/pin-login"`, `scope: "/"` (so links out of the
  PIN screen stay inside the PWA), and `id: "/pin-login"` so an existing
  installed icon **updates** rather than duplicating. `orientation` goes from
  `"portrait"` to `"any"` (E-6) — the venue tested and will use both.
- **Redirect by device, not by guesswork.** Fixing `start_url` alone is not
  enough: an installed icon can still land on `/` (a saved state, a navigation,
  an older install). New `lib/display-mode.ts` reads `display-mode: standalone`
  **and** the older iOS-only `navigator.standalone` — which is what an iPad
  added to the home screen actually reports. `signInRouteFor()` sends any
  `_touch` route to `/pin-login` always, and `/` to `/pin-login` only when
  launched from an icon. `/login` stays reachable for office users, and the PIN
  screen carries a "Sign in with email instead" link.
- **Service-worker hygiene.** `/pin-login` joins the pre-cached shell — an
  installed icon opened with no network must reach the sign-in screen, not a
  browser error. The cache name was the hard-coded literal `…-shell-v1`, which
  meant **a redeploy never invalidated anything**: `activate` only deletes
  caches whose key differs from the current one, and the key never changed, so
  a stale shell was served cache-first for ever. It is now
  `bigbakes-stock-shell-${BUILD_ID}`, substituted by a small
  `serviceWorkerBuildId()` Vite plugin at `generateBundle` (Vite copies
  `public/` verbatim, so it has to happen there). API traffic stays uncached.
- **`apple-mobile-web-app-status-bar-style: black-translucent`** added to
  `index.html`. The safe-area padding on `.topbar` (`env(safe-area-inset-top)`)
  is applied exactly once — F5's `--tvv-offset` is the visual viewport's
  offset, a different quantity, so there is no double-count.
- **A PIN sign-in lands on a venue home** (`/venue`), a three-tile touch screen
  (Goods In / End of Bake / Stock Take) under the `_touch` layout with the
  venue named across the top — not the desktop dashboard, which is an admin
  page inside the admin shell on a device with no keyboard or mouse. "Sign out"
  keeps the device's venue binding (it belongs to the iPad, not to whoever last
  tapped in); a separate "Sign out and forget this venue" clears it.

**Tests:**
- Unit: the manifest's `start_url`, `id`, `scope`, `display` and `orientation`;
  the service worker pre-caches `/pin-login`, no longer contains the old literal
  cache name, and derives the name from `BUILD_ID`; `index.html` carries the
  status-bar style and `viewport-fit=cover`.
- Unit: `isStandaloneDisplay` for standalone, for iOS `navigator.standalone`,
  for an ordinary tab — and that it answers `false` rather than throwing when
  `matchMedia` is unavailable, since it runs on the auth redirect path where a
  throw is a white screen instead of a sign-in page. `signInRouteFor` for every
  combination.
- Playwright (iPad): an installed app opening `/` lands on `/pin-login`; a
  venue screen while signed out lands there too; `/login` still renders the
  email form; a browser tab on `/` still gets it; the email fallback link
  works; the venue home shows all three jobs plus the venue chip and no desktop
  chrome; a tile opens its job.
- The API-side `pwa-assets.test.ts` assertion on `start_url` is updated to
  match, with the reason inline.

## F7 — Site binding, booking confirmation, undo and roles (E-1, E-3, E-4, E-5) (2026-08-19)

"Accidental booking logged 100kg to Birmingham; requested an undo timer or
role-based permission locks."

**The chain (E-1).** `POST /auth/pin-login` returns the device's `siteId` and
embeds it in the JWT; `pin-login.tsx` read only the token and discarded the
rest. `SiteProvider` then defaulted to the first **active** site by
`asc(sites.name)` — **Birmingham**, alphabetically first of the five seeded
sites. A venue iPad in South London booked to Birmingham, silently.

**Four independent safeguards, because one is not enough for a 100 kg error:**

1. **The site is carried through (E-1).** `pin-login` stores the returned
   `siteId`, `siteName`, label and roles; `POST /auth/pin-login` now returns the
   site **name** too, because an id is not something a venue screen can put in
   front of a baker. `SiteProvider`'s precedence is **device → explicit user
   choice → stored → first active**, and it never falls through to alphabetical
   order when the device names a site. When it *does* default, `isBound` is
   false and the venue chip renders in `warn` styling reading "not set for this
   device" — the 12 Aug behaviour is still the last resort, but it is no longer
   silent.
2. **Confirm before booking (E-5).** Book-in opens a `BottomSheet` restating the
   destination venue **large and first** (it is the fact that was wrong), the
   line count, and each line as `4 × 25 kg sack = 100000 g` — the form a human
   checks, not the raw numbers the form holds. An unbound venue is flagged
   inside the sheet too. Cancel returns with every entry intact.
3. **Undo (E-3).** New `POST /goods-in/:id/reverse` creates a **reversing
   receipt**: mirrored negative lines and `stock_movements`, its own
   idempotency key derived from the original receipt id, an audit reason and
   user, and one mirroring GL posting. It never mutates or deletes the original
   — the ledger is an audit trail, and a correction that edits history is one
   nobody can later explain. The two rows point at each other in both
   directions. A 90-second undo bar with a **visible countdown** calls it; when
   the window lapses a site manager can still void from the admin.
4. **Roles (E-4).** New `requireRole` guard beside `requireAuth`, applied per
   locked decision 5. `admin` passes every guard without being named in one.
   Plus `requireBoundSite` — a write naming a different site than the token's
   is refused for a `head_baker`, which is E-1's belt to the braces above.

| Route | head_baker | site_manager | admin |
|---|---|---|---|
| `POST /goods-in` | ✓ | ✓ | ✓ |
| `POST /stock-takes`, `/…/counts` | ✓ | ✓ | ✓ |
| `POST /session-consumption` | ✓ | ✓ | ✓ |
| `POST /goods-in/:id/reverse` | ✗ | ✓ | ✓ |
| `POST /stock-takes/:id/approve` | ✗ | ✓ | ✓ |
| `PUT /products/:id` with a cost change | ✗ | ✓ | ✓ |
| any write naming another site | ✗ | ✓ | ✓ |

The 403 message **names the roles that would work**, because it is surfaced to
a baker through F2's error banner and "not allowed" alone is a dead end. The UI
**hides** rather than disables the actions a role cannot perform (Approve, and
Undo) — a greyed-out button nobody can explain is worse than no button.

The cost guard is applied inside `PUT /products/:id` rather than as a blanket
route guard: a head baker legitimately edits other product fields, and it is
the **price** that moves money.

**Tests:**
- API: reversing zeroes the net movement for the product/site; the original row
  is byte-for-byte intact and now points at its reversal with reason and user;
  re-calling is idempotent (a double-tapped Undo reverses once, not twice into
  negative stock); exactly one reversing GL entry; reversing a reversal is
  refused; a missing receipt returns null.
- API: **the full `requireRole` matrix** — every guarded route × every role,
  plus a role with no permissions, plus `hasRole`'s admin-implicit behaviour.
- **API named regression for E-1:** a PIN bound to London South with a body
  naming Birmingham → **403**, and nothing written to Birmingham. Plus: the same
  booking to its own site succeeds; a `site_manager` may cross sites (someone
  has to be able to fix a mis-booking); an unscoped desk login is site-agnostic;
  the same guard covers opening a stock-take.
- **Web named regression for E-1:** `SiteProvider` prefers the JWT/device site
  over both localStorage and the alphabetical default, with a fixture shaped
  like the real one (Birmingham first alphabetically, device bound to London
  South). Red-to-green verified: all 7 fail against the pre-F7 provider.
- Web: the confirmation names the venue before anything is posted; restates
  each line as `4 × 25 kg sack = …`; cancel keeps the entries; the unbound
  warning appears. Undo fires the reversal for the right receipt; a refused
  reversal surfaces in the banner; a **queued** booking offers no Undo (there
  is no receipt to reverse — offering one would be A-1 in a different costume);
  a head baker is not offered an Undo they would only be refused.
- Playwright (iPad): book a line, the sheet names the venue, confirm, the undo
  bar appears, tap undo, the reversal request fires for that receipt id; cancel
  posts nothing; the chip shows `warn` when unbound and the bound venue when
  not.

## F8 — Barcode and product search that actually finds things (C-3) (2026-08-19)

"Manual barcode entry failed to find the product for an icing sugar delivery."

**The root cause.** `products` has had a `barcode` column **and** a
`products_barcode_idx` built for scan-to-find since the item model landed — but
the search predicate covered only `name`, `stockCode` and `ean`. A typed
barcode matched nothing. The same gap explains the Skittles report.

- **`barcode` is in the search predicate.**
- **`GET /products/by-code/:code`** — unambiguous single-product resolution:
  exact `barcode` → exact `ean` → exact `stockCode` → 404. Case-insensitive,
  never a substring (a partial match here books a delivery against the wrong
  product). `resolveBarcodeToProduct` asks this **first** and only falls back
  to search; even in the fallback an exact code match outranks a name
  relevance hit, because a code appearing inside a product *name* is a
  coincidence, not an identification. A 404 is `null`; anything else
  **propagates**, so the screen can distinguish "could not look that up" from
  "no product carries that code" — very different things to a baker holding a
  delivery note.
- **`POST /products/:id/barcode`** — attach a scanned code to a product. A code
  already held by another product is a **409 naming the holder**, never a
  silent overwrite: stealing it would send the *next* scan of that code to the
  wrong item.
- **A miss is a fork, not a dead end.** The old behaviour was a destructive
  toast and nothing else, at the exact moment someone is holding a delivery
  note and a pallet. Now a `BottomSheet` names the code and offers: search by
  name (Goods In had **no name-search UI at all**, despite the placeholder
  saying "or name") with a **pickable result list** rather than silently taking
  `candidates[0]`, and "Add code" — attach the scanned code to the chosen
  product so the next delivery scans first time, adding the line in the same
  motion.

**Tests:**
- API: search by full barcode, by partial barcode, by EAN, by stock code, by
  name; **an exact barcode outranks a product whose NAME contains the same
  digits** (the fixture includes exactly that trap); `by-code` 404s on a
  genuine miss, naming the code.
- API: attaching persists and the product is then findable by that code;
  attaching a code held by another product is a 409 and the original holder
  keeps it; re-attaching a product its own code is a no-op; an empty barcode
  is a 400.
- Web unit: the resolver asks the exact endpoint first and does not search at
  all when it answers; falls back through barcode/ean/stockCode; **an exact
  code match beats `candidates[0]`**; an empty code asks nothing; a non-404
  failure propagates rather than being reported as "no such product".
- Web component: a miss opens the sheet; name search returns a pickable list
  and says "no barcode yet"; picking adds the line; "Add code" attaches and
  adds; a 409 surfaces in the error banner; an empty name search says so.
- Playwright (iPad): typing a barcode gets exactly one result (and exactly one
  `by-code` request); typing a name gets a pickable list.

The existing A-6 spec asserted the old dead-end toast; it now asserts the
sheet, keeping A-6's actual property (the failure is surfaced rather than
silently doing nothing) with the better behaviour.

## F9 — Purchase units, pack sizes and cost precision (C-1, C-2, C-4, C-5, C-6) (2026-08-19)

"Icing sugar displayed an incorrect default unit quantity of 1kg"; "Skittles
displayed an incorrect base unit, preventing the 1.6kg bags from being added";
"Request to add base-unit increment buttons".

**The root cause is data, and the app never said so.** Ingredients were seeded
with `stockUom: 'g'`, `purchaseUom` NULL and `purchaseToStockFactor` `'1'`, so
goods-in rendered a 25 kg sack literally as `= 1 g · £0.00/unit`. A product
with no purchase model is **indistinguishable** from one genuinely bought in
single grams — which is why nothing flagged it.

- **Cost precision (C-4).** `products.expected_next_cost` widens from
  `numeric(18,2)` to `numeric(18,6)` (migration `0043`, locked decision 4).
  Icing sugar is ~£0.0012/g; 2dp rounded every such price to `0.00` at rest, so
  every venue cost read £0.00 and every line value from it was zero. Recipe
  `unit_cost` was already `numeric(18,4)` — the two disagreed and this was the
  shallower. The widening is lossless; precision already destroyed at write
  time cannot be recovered, which is what the needs-setup report is for.
  Display was fixed too: `formatMoney` shows 2dp for ordinary amounts and up to
  6 decimals for sub-penny ones, and the cost input's step is `any` rather than
  `0.01` (which made those prices impossible to *enter* as well as to store).
- **Purchase-unit fields.** `packDescription` (free text — "25 kg sack", "case
  of 6 × 1.6 kg") joins `purchaseUom` and `purchaseToStockFactor` on the
  product admin page. A `superRefine` refuses to save a fungible product with a
  purchase unit and a factor of exactly 1 without saying so, because that
  combination *is* C-1.
- **The "needs setup" report** — `GET /products/needs-setup` and an admin page
  (Products → Needs setup) listing every stocked product a venue cannot receive
  correctly: no purchase UoM, a 1:1 factor on a non-`each` stock UoM, a zero
  cost, or no pack description. Worst first, each finding naming what is wrong
  and what to do. This is the list to work to zero **before** the next venue
  test rather than discovering it on a pallet.
- **The line reads in the unit a human uses (C-1/C-2).** `4 × 25 kg sack =
  100 kg` — quantity, pack description, and the resolved stock quantity
  auto-scaled g→kg / ml→L **for display only** (storage and the request stay in
  the stock UoM). The cost shows per pack *and* per stock unit.
- **Base-unit increment buttons (C-6)** beside the existing ±, stepping by one
  purchase unit and labelled with it — `+1 sack`, not `+1` — reusing the End of
  Bake `.step-table` sizing.
- **Unit-cost defaulting and write-back (C-5).** The "Set £" sheet defaults from
  `expectedNextCost` at full precision and can now **save a new expected cost
  back to the product** — the thing the tester could not reach. `site_manager`+
  only (E-4); hidden entirely for a head baker.
- **Blocked-line guard.** A product with no purchase unit cannot be booked: the
  row shows "no purchase unit — set one to book this in" and the Book button
  reads "N lines need a purchase unit" and is disabled. Silence here is exactly
  what produced the 1 g booking.

**Tests:**
- API: a £0.0012 cost round-trips at 6dp (was `0.00`); an ordinary 2dp price is
  unchanged by the widening; `setupIssuesFor` rule-by-rule, including that a
  1:1 factor on a **discrete** product is correct and must not be flagged; the
  report finds exactly the mis-configured fixtures and not the ready one, names
  each issue, orders worst-first, and summarises by kind.
- API: goods-in with `qtyPurchase: 4` and factor 25000 books **100000** stock
  units with a line value of £120; a line value defaulting from a £0.0012/g
  product uses the full-precision cost, not a rounded zero.
- Web unit: `describePackLine` renders `4 × 25 kg sack = 100 kg` and
  `4 × 1.6 kg bag = 6.4 kg`, and **refuses to complete the phrase** with no
  purchase unit (printing "= 4 g" is the 12 Aug lie); `formatStockQty` scaling;
  `formatMoney(0.0012)` is `£0.0012`, not `£0.00`; `needsPurchaseUnit`;
  `packStepLabel`.
- Web component: the line does not read "= 1 g"; the cost shows per pack and
  per gram; a blocked line shows the blocked state and disables the booking;
  `+1 sack` steps a whole pack and never below zero; the cost write-back posts
  the new price; a head baker never sees it.
- Playwright (both viewports): **book 4 × 25 kg icing sugar and 4 × 1.6 kg
  Skittles end to end**, asserting the request body carries `qtyPurchase: 4`
  for each — the 12 Aug delivery, booked correctly.

Also fixed while here: the labels in the goods-in details sheet had no `for`
attribute, so they were tied to nothing for a screen reader (and for any
by-label query).

## F10 — Number entry that behaves (D-4, D-5) (2026-08-19)

"Default numbers are not overridden when typing (entering '3' into a default
field of '1' results in '13')" and "Request to enable direct number pad typing
on laptop keyboards."

**The root cause.** `KeypadSheet` seeded its buffer with `String(initial)`, so
the first keypress **appended**. Every quantity a baker typed was silently
concatenated onto the default they were trying to replace. And there was no
`keydown` handling anywhere in either sheet.

- **First keystroke replaces.** New `use-numeric-entry.ts` holds a `pristine`
  state: the starting value is shown, the first digit (tap **or** keyboard)
  replaces it, subsequent digits append. Backspace on a pristine value clears
  it outright rather than nibbling the default one character at a time — the
  user is replacing it. The original stays visible as **"was 1"**, so nothing
  is lost by the replacement.
- **Physical keyboard (D-5).** While the sheet is open: `0-9` and `.` (and `,`)
  push, `Backspace`/`Delete` delete, `Enter` confirms, `Escape` cancels. Focus
  is trapped in the sheet (Tab cycles inside it) and **returned to the invoking
  control** on close.
- **One implementation, not two.** `KeypadSheet` and `WastageSheet` had
  near-duplicate keypads with the same append bug and the same missing keyboard
  support. Both now share `useNumericEntry` + a new `NumericKeypad`, so the
  behaviour cannot drift apart again. The End of Bake table counts use the same
  `KeypadSheet`, so they are covered by construction.
- **`allowDecimal={false}`** (the table counts) rejects `.` from both tap and
  keyboard — and *consumes* the keystroke, because a stray "." landing
  elsewhere on the page is worse than nothing happening.
- **Desktop inputs select on focus.** The plain `.input` fields (unit cost,
  batch code, wastage reason) select their content on focus, so typing
  replaces. That is the same D-4 complaint in its laptop form: the caret lands
  after the default and you type into it.
- **Accessibility.** The keypad display is a `role="status"` live region
  announcing the value as it is typed (it changes without focus moving, so a
  screen reader would otherwise never hear it), and every key has an accessible
  name.

**Tests** (red-to-green verified: restoring the pre-F10 `touch.tsx` fails 8 of
the sheet specs):
- Unit: pristine-then-replace — initial `1`, press `3` → `3`, press `0` → `30`;
  backspace on pristine clears; `.` on pristine gives `0.`; no second decimal
  point; a leading zero is a placeholder; a new target resets; `allowDecimal:
  false` rejects `.` from tap and keyboard; every key mapping; `Enter`/`Escape`
  return an action **without mutating**; unrelated keys are not consumed.
- Component: tapping `3` into a default of `1` confirms **3**; "was 1" is shown
  and then goes; the display announces; typing `3` + Enter confirms 3; a
  multi-digit and a decimal quantity round-trip; Backspace; Escape does not
  confirm; the decimal key is disabled for table counts; Save is refused on an
  empty buffer; focus returns to the opener.
- **Playwright (desktop), the direct D-4 regression:** open a quantity keypad,
  type `3` on the physical keyboard, press Enter, assert the line reads **3**
  — and that the row hint then reads `3 × 25 kg sack = 75 kg`.

## F11 — Goods In confirmation and receipt (A-5) (2026-08-19)

"Request clear visual feedback upon booking rather than having items
immediately clear from view", and "Lack of visual feedback on screen exits
leaves users uncertain whether inputs are saved, deleted, or processed."

Both halves are the same thing: **a list that vanishes looks identical whether
it was saved or lost.**

- **A receipt screen** replaces the vanishing list. It shows the venue, the
  timestamp, the reference, every line as booked (`4 × 25 kg sack = 100 kg ·
  £120.00`) and the total, with two deliberate ways out: "Book another
  delivery" and "Done". **It does not disappear on a timer** — the only thing
  that expires is F7's undo window, which is shown counting down. The undo bar
  moved onto the receipt, where it belongs.
- **Destructive exits are guarded.** Back with unbooked lines opens a
  `DiscardGuardSheet`: "You have 3 lines not yet booked in." — Keep editing /
  Discard them. "Keep editing" is the solid button, because the safe choice
  should be the one a thumb finds first. The same guard is on the stock-take
  (uncommitted counts) and End of Bake (adjusted ingredients); each only fires
  when there is genuinely something to lose.
- **In-progress work survives a reload.** The working line list is persisted to
  the same localStorage layer as the offline queue and restored with a visible
  "Restored your unfinished delivery from HH:MM" notice — announced, never
  silently reappearing. **Scoped per site AND per screen**: restoring London
  South's delivery at Birmingham would be a worse bug than losing it, on the
  very screen whose venue confusion caused E-1.
- **"Last booked in at HH:MM"** on an empty goods-in screen, so a returning
  user has continuity rather than a blank slate.

**Tests:**
- Unit: draft round-trip; **scoped per site** (a Birmingham read does not see a
  London South draft) and per screen; "no site" is distinct from a real site;
  clear; corrupt JSON and a payload missing its timestamp return null rather
  than throwing; a full quota does not crash the screen.
- Component: the receipt shows every line, the venue, the reference and the
  total; it is **still there after 120 s of fake time** (only the undo bar
  expires); "Book another" gives an empty form; "Done" leaves. Back with lines
  prompts; Keep editing retains; Discard clears the draft and leaves; Back with
  nothing entered just leaves. The draft persists, restores with its notice,
  and is cleared by a successful booking.
- Playwright (iPad): book, see the receipt with the reference and total, tap
  "Book another", assert an empty form; Back with unbooked lines prompts and
  Keep editing keeps them.

## F12 — End of Bake: entry mode, table stepping and benches (F-1, F-2, F-3, F-7) (2026-08-19)

Three concrete reports and one request, all on the same screen.

**The line arithmetic moved out of the component** into
`features/consumption/line-reducers.ts`. F-1 and F-2 are *arithmetic* bugs, and
arithmetic is what a component test pins down worst; the reducers are pure, so
the direction rule can be asserted as a table over four controls × two modes.

- **F-1 — direction consistency.** The plain `−`/`+` steppers were **not**
  inverted in REMAINING mode, but `Table−` *increased* `remainingQty` and
  `Table+` *decreased* it. Two controls on the same row moved the same number
  in opposite directions. The old intent — "one fewer table used means more
  left" — is defensible read alone and indefensible next to a `+` that does the
  opposite. **New rule: every control moves the DISPLAYED number in its own
  direction**, enforced by there being exactly one mutation path
  (`bumpDisplayed`) that the four buttons differ from only in step size. In
  REMAINING mode they are relabelled **`+1 table left` / `−1 table left`** so
  the press cannot be misread. This supersedes the old inline comment
  (recorded in DECISIONS.md).
- **F-2 — non-destructive toggle.** The toggle zeroed the figure it was
  switching away from, destroying the expected pre-fill; variance then read
  `−expected`, the dot flipped to `warn`, the "adjusted" count was wrong, and
  `doSubmit` sent `actualQty: 0`. Both figures are kept now. Entering REMAINING
  for the first time seeds 0 — a fresh, explicit question — but marks it
  **unanswered**, so "left nothing" and "didn't count it" stay distinguishable.
  Variance, the dot and the adjusted count are all computed from the mode
  actually in force, and REMAINING reports **no** variance (the usage is the
  server's to derive; reporting one would mean inventing it).
- **F-3 — live table count.** The number between the table buttons rendered
  `covers` — the session total, identical on every row and unaffected by every
  press beside it. It is now `round(qty / qtyPerTable, 1)` with the session
  total alongside (`2.5 / 5`), updating on every press, and `—` when the recipe
  has no per-table figure.
- **F-7 — benches under the kilos.** New per-site `sites.benches_per_table`
  (migration `0044`, nullable, admin-editable) — **not hard-coded**, because
  the rooms differ. Each line shows "5 of 5 tables · ≈ 30 benches" beneath the
  quantity and the header carries the session total, both visible **without
  scrolling or tapping**, which is the tester's stated reason (interruption
  recovery). A site with no ratio reads "benches not set for this venue" rather
  than quietly assuming a number.
- **F-8's submit guard.** A REMAINING line with nothing entered is blocked
  inline ("not counted yet") and the submit button says how many are
  outstanding, rather than sending `remainingQty: 0` — which claims an empty
  shelf.

**Tests:**
- Unit (27): the F-1 table — four controls × two modes, each asserted to move
  the displayed number its own way — plus the direct regression that `Table+`
  and `+` now agree in REMAINING mode; never below zero; no float drift.
  **F-2:** CONSUMED(500) → REMAINING → CONSUMED restores **500**; an answered
  remaining figure survives a round trip; variance is null in REMAINING; a
  freshly toggled line is not "adjusted". F-3 implied tables, including
  `qtyPerTable = 0` → null. F-7 bench derivation and the unset cases. F-8's
  blocked lines, including that an explicit 0 is a real answer.
- API: `sites.benchesPerTable` defaults null, stores and patches, `null` clears
  it, and **0 is rejected** — that is a missing answer, not fewer benches.
- API: `entry-mode.test.ts` still passes, plus explicit assertions that the
  server-side derivation is **unchanged** by the client rewrite.
- Playwright (iPad): toggle to What's Left and back without losing the figure;
  `+1 table left` increases and `−1 table left` decreases; the table count
  tracks the quantity; benches appear (and say so when unset); an uncounted
  line blocks the submit.

Also fixed while here: the End of Bake setup labels had no `for`/`aria-labelledby`,
so nothing tied them to their controls — the same gap as F9 found on goods-in.
And `gotoVenueScreen` no longer stubs `/sites` over a spec's own fixture
(Playwright's last-registered route wins, which silently overrode the bench
fixture).

## F13 — Recipe importer, dietary variants, demo seed retired

Closes **F-4** ("Displayed recipes are not part of our offering of course"),
**F-5** ("Selecting Vegan or GF options for Battenburg failed to generate
required ingredients") and **F-6** ("No bake logs were submitted due to
incorrect recipe data").

The three are one defect wearing three hats: the menu was invented, every
seeded recipe line was `BASE` so the variant machinery had nothing to act on,
and when the machinery produced nothing the screen showed an empty list under a
toast. Each failure presented to a baker as *nothing happening*.

**Import, not seed.**

- `src/modules/recipes/recipe-import.ts` — the pure half: two CSV schemas,
  per-row parsing, and fifteen validation rules. `crossValidate` carries the
  ones that catch F-5: `base-required`, `remove-not-in-base`,
  `gf-offered-without-variant`, `vegan-offered-without-variant`,
  `unknown-ingredient`, `duplicate-effective-from`.
- `scripts/import-recipes.ts` — reads the files, upserts ingredient products
  (including the purchase side: `purchase_uom`, `purchase_to_stock_factor`,
  `pack_description`, and `count_quantum` where **blank means no rounding, and
  `0` is rejected**), and writes recipe versions idempotently by
  `(bake, site, effective_from)`. Any problem fails the whole import.
- `scripts/demo/seed-bakes.demo.ts` — the old seed, moved and gated. Refuses on
  `NODE_ENV=production` and refuses once real recipes exist.
- `scripts/purge-demo-bakes.ts` — removes the four demo cakes, keeping any
  ingredient something real points at, with the reason.
- `docs/RECIPE_IMPORT.md` — both schemas, every rule, and a worked Battenburg
  example with GF and vegan variants and the arithmetic for a 7/2/1 session.
- `npm run import:recipes` / `npm run purge:demo-bakes`.

**Fail loudly on the iPad.**

- `expectedForSessionWithCoverage()` returns `{ lines, blockers }` with named
  `NO_RECIPE` / `NO_GF_VARIANT` / `NO_VEGAN_VARIANT` / `NO_INGREDIENTS`
  blockers; `dietaryCoverage()` answers what a cake has a recipe for.
  `POST /recipes/expected` returns the pair; `GET /recipes/coverage` is new.
- `BlockingNotice` (touch layer) — non-dismissible, names cake + date + venue,
  lists the blockers, ends "This bake cannot be submitted." The End of Bake
  screen stays on setup rather than advancing into an empty ingredient list.
- The GF / vegan table fields are **disabled** for a cake with no such variant,
  with "No gluten-free recipe for this cake — ask head office."

**Tests** — 23 validation-rule unit tests; 8 importer integration tests against
real Postgres (whole-menu import, variants land, purchase columns round-trip,
idempotence, `--dry-run` writes nothing, a bad row writes nothing at all, GF
arithmetic differs, blockers named); 4 purge tests (an ingredient with stock
movements is kept); 3 demo-seed refusal tests; 7 web component tests for the
blocking notice and the disabled diet fields.

**Two stale e2e specs repaired on the way through** (pre-existing on the branch,
surfaced by running the full Playwright suite with the API reachable):

- `pwa-booking` / `pwa-submit` stubbed `**/api/v1/products**`, which also
  matches `/products/by-code/:code`. The paginated envelope made
  `apiFetch<Product>` unwrap to a `PaginatedResult`, so the screen added a
  nameless line and the spec waited for a product that never rendered. New
  `stubProducts()` helper registers the exact route second — Playwright's
  last-registered handler wins — and answers 404 for an unknown code.
- The booking confirmation assertion still expected `= 100000 g`. The C-1 pack
  work made that line read `= 100 kg`, which is the point of it.
