# Auto-Stock — build decisions

Non-obvious decisions taken while building Auto-Stock (the Big Bakes fork of
`smmta-next`), with rationale and the spec section each serves. Newest last.
The spec is law; every divergence is recorded here. Items marked
**"default — confirm with owners"** resolve a spec §A12 open question with a
low-risk default and are admin-editable wherever practical.

## D1 — Keep the `@smmta/*` workspace scopes (2026-06-18)
Spec §A2 / P1 ask for a rebrand to Auto-Stock (Big Bakes). We renamed the
human-facing surface — root `package.json` name/description, `README.md`, the
`CLAUDE.md` overview, and (later) the API/UI titles — but **left the npm
workspace scopes as `@smmta/api` / `@smmta/web` / `@smmta/shared-types`**.
Renaming a workspace scope touches every import, every `-w @smmta/…`
invocation, the turbo graph, tsconfig path mappings and CI, for zero functional
gain (the deployed product's name is config + copy, not the package scope). The
prompt set explicitly sanctions keeping the scopes.

## D2 — Fixed a pre-existing red baseline test to establish "green" (2026-06-18)
The untouched fork's `supplier-poll.worker.test.ts` ("per-chunk error
tolerance") was already failing: its `beforeAll` inserted three SKUs
(`SKU-C/D/E`) all against `(productAId, supplierId)`, which the
`supplier_products_product_supplier_unq` unique index — on `(product_id,
supplier_id)` — forbids. The suite sits outside the path-filtered CI
(`.github/workflows/e2e.yml` only runs on storefront/scripts changes), so the
break went unnoticed since commit #57. The prompt set requires a green baseline
to detect regressions across P1–P25, so we fixed the **test fixture** (each
extra SKU now gets its own product, matching the "one SKU per product/supplier"
schema). **Production code untouched.** Result: 34 files / 394 tests green.

## D3 — Feature flags for dormant subsystems, default off (2026-06-18, spec §A2)
Rather than delete the storefront/marketplace/search code (spec says keep it
dormant, not gone), dormancy is enforced with a small `FEATURES` config in
`apps/api/src/config/env.ts`:
- `FEATURE_MARKETPLACE` (default off) gates registration of
  `POST /import/marketplace`; off ⇒ the route 404s, the rest of the
  integration plugin (CSV import, bulk ops, year-end) stays live.
- `FEATURE_CONVERSATIONAL_SEARCH` (default off) gates whether the storefront
  search service is handed an Anthropic key; off ⇒ `/storefront/search` uses
  the existing keyword fallback and never calls the LLM.
The Next.js storefronts (`apps/store`, `apps/store-clothes`), Mollie and
SendGrid are dormant simply by **not being built/deployed** (P24 install only
provisions api + web + the PWA + the MCP). `z.coerce.boolean()` is deliberately
avoided for the flags (it maps the string "false" to `true`); a custom
`boolFromEnv` treats only "true"/"1" as on.

## D4 — Ledger stock ops live under `/stock-levels/*`, serialized path retained (2026-06-18, spec §A5)
P4 says "re-point `POST /stock-items/adjust` and `/stock-items/transfer` to
write `stock_movements` and update `stock_levels` per site … preserve serial/
batch behaviour for genuinely serialised discrete goods via the retained
`stock_items` rows." The existing `/stock-items/*` endpoints are **warehouse +
serialized-unit-row** based (they create/adjust individual `stock_items`, post
to the GL, and back the storefront's reservation/serial flows). Rewriting them
onto the per-site ledger would break the serialized model and its tests.

So the new per-site ledger operations live under **`/stock-levels/*`**
(`adjust`, `transfer`, plus `GET /stock-levels`, `/stock-levels/valuation`,
`/stock-levels/low`), and the legacy `/stock-items/adjust|transfer` stay
**unchanged** for serial/batch-tracked discrete goods. This satisfies the
intent ("operations on the auditable ledger" + "preserve serial/batch via the
retained `stock_items`") while keeping the serialized storefront path intact.
Transfers are paired `TRANSFER_OUT` / `TRANSFER_IN` movements applied in one
transaction (quantity conserved). Valuation is weighted-average cost (WAC) per
(product, site) from costed inflow movements, aggregated per site and per
(site, item_kind).

## D5 — Xero GL re-point: shared gl_posting_log, GL_PROVIDER switch only on stock paths (2026-06-18, spec §A8)
- **Shared `gl_posting_log`.** Xero postings reuse the existing Luca-named
  table; `luca_transaction_type` carries the journal type (`MANUAL_JOURNAL`)
  and `luca_transaction_id` the Xero ManualJournalID (or a `DRYRUN` marker).
  Renaming the columns would churn the whole GL subsystem for no gain.
- **GL_PROVIDER switch (default `xero`) wired only at the stock call sites** —
  `grn.service` (postGoodsReceivedNote) and `stock-item.service`
  (postStockAdjustment) now use `getStockGLService()`. The storefront AR/AP
  flows (`invoice.service`, `supplier-invoice.service`) stay on `LucaGLService`
  directly: they're the dormant storefront path and Big Bakes doesn't invoice
  customers through this app (sales are Square/BumbleBee). XeroGLService
  implements the stock surface (GRN, stock adjustment) plus the new
  `postConsumptionCOGS` / `postWastage` for P17.
- **Dry-run by default + fail-safe.** `XERO_DRY_RUN` defaults **true**: the
  service records the balanced journal in `request_payload`, marks the row
  SUCCESS with a `DRYRUN` marker, and sends nothing. With dry-run off but no
  stored connection / app creds, it degrades to a logged `DRYRUN-UNCONFIGURED`
  rather than throwing. Idempotent on the deterministic key (a SUCCESS row is a
  no-op). Token state lives AES-encrypted in `xero_connections`; app creds in
  env. The account/tax map (`xero_account_map`) is admin-editable, seeded from
  the LUCA_ACCOUNTS defaults.

## D6 — Reorder uses a dedicated `reorder_proposals` table; min-days deferred (2026-06-18, spec §A7)
- **`reorder_proposals`, not `supplier_orders`.** P7 says placement "reuses
  `supplier_orders`". That table is drop-ship-shaped — a NOT NULL
  `customer_order_id`, shipping address, carrier/tracking — none of which fit a
  stock replenishment. So the engine writes to a purpose-built
  `reorder_proposals` table that mirrors the *pattern* (idempotent, retryable,
  status lifecycle) but models the replenishment cleanly (product, site,
  supplier, suggested qty in stock + purchase units, channel, rendered PO).
  The drop-ship `supplier_orders` path is untouched.
- **Idempotency = one open proposal per (product, site).** `evaluate` skips if a
  PROPOSED/APPROVED proposal already exists, so repeated decrements while still
  below the point don't duplicate. Triggered on every SALE/CONSUMPTION decrement
  (a best-effort post-commit hook in `applyMovement`) and by the daily sweep.
- **Routing.** auto-place + API_CONNECTOR → PLACED (+ ref; the live connector
  call is a go-live step); auto-place + EMAIL_PO → EMAILED with a rendered PO
  (`email-po.ts`; never actually sent during the build); not auto-place →
  PROPOSED awaiting approval. Quantity orders up to par (reorder_up_to) and
  rounds UP to the supplier pack size.
- **`min_days_cover` is stored but not yet in the qty math.** It needs a
  rate-of-use, which the demand estimator provides in **P22**; until then the
  quantity is driven by par + pack-size rounding. Documented so the divergence
  from "respecting min_days_cover" is explicit.

## D7 — PWA built into apps/web, dependency-free; asset test lives in api (2026-06-18, spec §A1/§A11)
- The iPad PWA is a **route-tree area inside `apps/web`** (not a slim sibling) —
  it matches the existing Vite/React tooling, reuses the auth + api-client +
  components, and keeps one deployable SPA. Installability is a hand-written
  `public/manifest.webmanifest` + `public/sw.js` (cache-first shell, never
  caches `/api/`) registered in `main.tsx` (prod only). **No new PWA/scanner
  dependency** was added: barcode scanning uses the native `BarcodeDetector`
  with an **injectable** scan/lookup so it's testable; the offline queue is a
  small localStorage-backed (pluggable) store keyed by the client idempotency
  id, so the server-side idempotency (goods-in / stock-take) makes a replay
  safe.
- The manifest/SW **validity test lives in the api package** (`pwa-assets.test.ts`)
  rather than apps/web: the web build's `tsc -b` type-checks test files but the
  web app project has no Node types, so a `node:fs` read of the public assets
  only compiles under api's Node-typed config. It reads the sibling
  `apps/web/public` via `import.meta.url` (cwd-independent).
- Shared-device PIN login: a `device_pins` table (scrypt-hashed PIN, scoped to a
  site + roles) + a public `POST /auth/pin-login` issuing a 12h scoped JWT; the
  head-baker role is added in P16.

## D8 — MCP wire protocol implemented directly, not via the SDK transport (2026-06-18, spec §A9)
The MCP server at `POST /mcp` implements the MCP JSON-RPC methods (initialize /
tools/list / tools/call) **directly over HTTP** rather than mounting the SDK's
session-managed `StreamableHTTPServerTransport`. Reasons: it's fully testable
with plain `app.inject` (no MCP client needed), adds no dependency, and stays
green; the tool registry (`modules/mcp/tools.ts`) is the same surface P19's
guarded write tools extend. Auth reuses the `api_keys` verification (new
`mcp:read` scope; `mcp:write` reserved for P19) and, on 401, returns the
RFC 9728 `WWW-Authenticate: Bearer resource_metadata="…"` hint pointing at
`GET /.well-known/oauth-protected-resource` (BumbleBee's pattern). Every tool
call is audited to `mcp_audit_log` (best-effort). The read tools wrap the same
services the REST routes use; `consumption_variance` / `wastage_report` /
`sessions_awaiting_consumption` return `{ available: false }` until their data
lands (P16-P18). Swapping in the real SDK transport at go-live (for SSE
streaming + Cowork sessions) is additive — the registry doesn't change.

## D9 — Recipes: experience resolved via a product flag; versioned + per-site (2026-06-18, spec §A6)
- **Experience is resolved from the Tonic experience product on a session's
  order lines.** BumbleBee has no experience column, so P15 adds a nullable
  `products.experience_type` (CLASSIC/SWEETER/ULTIMATE). A Tonic experience
  product carries the flag; `ExpectedConsumptionService.resolveCoverGroups`
  maps a session's lines → `{ experience, covers }` (covers = the line
  quantity), summing per experience. This keeps the shared catalogue as the
  single source of the mapping and lets P16's head-baker form derive covers
  with no new join. A session can mix experiences, so `expectedForSession`
  aggregates the per-experience expected lines per ingredient.
- **Recipes are versioned + date-effective with a per-site override.** A
  `recipes` header (experience, nullable `site_id`, `version`, `effective_from`,
  `effective_to`) + `recipe_lines` (ingredient `product_id`, `qty_per_cover`,
  `stock_uom`, `unit_cost`). Selection for (experience, site, date): take rows
  effective on the date where `site_id = site OR site_id IS NULL`; a per-site
  row (override) beats the global (`site_id IS NULL`); within the winning scope
  the newest `effective_from` then highest `version` wins. Expected = Σ
  (qty_per_cover × covers) per ingredient.
- **Line cost seeded from BumbleBee cost_price.** BumbleBee's `cost_price` lands
  in `products.expected_next_cost` (the catalogue-sync import, P11), so a recipe
  line with no explicit `unit_cost` seeds it (and its `stock_uom`) from the
  product. An explicit cost wins; the seed is a convenience, not a lock.
- **Global-recipe version allocation is service-side.** Postgres treats NULLs as
  distinct in a unique index, so the `(company, experience, site_id, version)`
  index guards site-specific versions but not global ones (site_id NULL).
  `RecipeService` allocates `version = max(existing for that experience+scope)+1`,
  so global versions stay monotonic without relying on the index.

## D10 — Head-baker consumption: amend posts the corrective delta only (2026-06-18, spec §A6)
- **One record per session, amend-in-place.** `session_consumption` is unique on
  `(company, session_id)`; re-submitting the same session updates the one record
  and bumps `version`. Both actual usage and wastage decrement site stock
  (CONSUMPTION + WASTAGE movements), so total decrement = actual + wastage.
- **Amend posts only the change since last applied.** Each line stores its
  last-applied `actual_qty` / `wastage_qty`. On submit the movement delta =
  `old − new` (consume more when new > old; *return* stock when new < old),
  posted with `content_hash = v{version}` so the ledger sum always equals the
  current confirmed quantities and a replayed version is a no-op. This avoids a
  reverse-then-repost pair while keeping the ledger append-only and auditable.
- **Two idempotency layers.** A genuine amend carries a *new* `client_key` and
  bumps the version; an **offline replay** of the exact submission carries the
  *same* `client_key` and is a no-op (no version bump, no movements) — matching
  the goods-in / stock-take offline pattern. The PWA mints one `client_key` per
  submit action (replayed verbatim from the queue).
- **Site scope via the PIN token.** A head-baker PIN issues a JWT carrying its
  `siteId`; `canAccessSite` lets admins / unscoped users act on any site but a
  site-bound token only on its own. The submit route + service both enforce it
  (`forbidden_site_scope`). No existing auth is weakened — it's an added check.
- **Variance = actual − expected**, expected recomputed server-side from the
  recipe (recipe × covers) at submit, so the stored figure is authoritative
  regardless of what the form pre-filled. `materials_cost = Σ(actual × unit
  cost)` is computed now (P17 consumes it).
- **Sessions-awaiting source.** "Sessions awaiting a consumption record" needs
  the day's sessions, which live in BumbleBee. A guarded `BumbleBeeSessionClient`
  polls them (returns [] when no base URL is configured — the live endpoint is a
  go-live step); the pure `filterAwaiting(siteId, sessions)` diffs them against
  existing records and is what the test, the dashboard, and the P14 MCP tool
  (`sessions_awaiting_consumption`, now wired) all use.

## D11 — Consumption cost flow: BumbleBee push near-real-time, Xero COGS daily (2026-06-18, spec §A8)
- **Materials cost → BumbleBee is pushed near-real-time (best-effort); Xero COGS
  is a daily sweep.** Locked decision 8 makes the *accounts* posting periodic
  (one COGS + one wastage journal per site/day), but BumbleBee profit reporting
  wants the per-session cost promptly, so `submit` fires the BumbleBee push
  post-commit (best-effort — a sync hiccup never fails the submit, like the
  reorder hook). The two cadences are deliberately different.
- **BumbleBee push idempotency mirrors BumbleBee's own convention.** A
  `bumblebee_sync_log` row is unique on `(source_system='autostock',
  source_key=session_id, content_hash)`, where the hash is over the *value*
  (`materials_cost|version`) not the metadata: re-pushing the same cost is a
  no-op; an amended cost (new version → new hash) pushes again. Guarded by
  `MATERIALS_COST_SYNC` (default off) + a BumbleBee base URL; otherwise a dry-run
  logs the payload and sends nothing (the write endpoint is a follow-up).
- **Daily Xero sweep reuses the dry-run-safe GL posts.**
  `ConsumptionSweepService.runDaily(date)` aggregates `Σ(actual × unit_cost)` =
  COGS and `Σ(wastage × unit_cost)` = wastage per site for the day and calls
  `XeroGLService.postConsumptionCOGS` / `postWastage` (balanced + idempotent on
  the per-(site,day) GL key `CCOGS-{site}:{date}` / `WASTE-{site}:{date}`,
  dry-run by default). A re-run is a no-op.
- **Known limitation — amend after the sweep.** The daily GL key is once-per-day,
  so a consumption *amended after* that day's sweep posted won't re-post a
  correction (the key is already SUCCESS). Intended cadence is end-of-day after
  amendments settle; a correction journal is a future refinement. The BumbleBee
  push has no such limit — it re-pushes on every amend (new hash).

## D12 — Reports: food-cost % needs revenue (operator-supplied for now) (2026-06-18, spec §4/§A6)
- **The three views come from three tables.** Expected + actual + wastage are
  aggregated from `session_consumption_lines` (expected = recipe × covers,
  snapshotted at submit); counted/shrinkage from approved `stock_takes`
  (shrinkage = `Σ stock_take_lines.variance` = counted − book) within the
  period; food cost from the `session_consumption` header (`materials_cost` +
  the new `covers` column, migration `0030`). All worst-first, plain-English.
- **Food-cost % is `actual materials cost ÷ revenue`, and revenue isn't in
  Auto-Stock.** Revenue lives in BumbleBee, so `foodCost(revenue?)` takes the
  period revenue as an optional parameter and computes the % only when it's
  supplied *and* a single site is requested (the figure is that site's). Without
  it the report still gives the self-contained metrics — covers, materials cost,
  **cost per cover** (`materials_cost ÷ covers`), expected vs actual, wastage
  cost — which need no external input. A BumbleBee revenue join can populate the
  % automatically later; the operator can supply it now.
- **`covers` added to the consumption header.** Per-cover food-cost needs covers,
  which the consumption record didn't store; `submit` now writes
  `covers = Σ cover_groups.covers`. Aggregating covers from the header (not the
  lines) avoids multiplying by the line count.
- **MCP read tools wired.** `consumption_variance` and `wastage_report` (P14
  stubs returning `{available:false}`) now call the report service with a
  site + from/to window.

## D14 — Multi-currency: every stock money path carries the site's currency (2026-06-18, spec §7)
Adding Dallas (USD / IMPERIAL / America-Chicago) needed **no migration and no
schema change** — `sites` carried `currency_code` / `uom_system` / `timezone`
from P2, and the imperial UoM round-trips through the existing
`purchase_to_stock_factor` (1 lb = 16 oz ⇒ factor 16). The gaps were GBP
*defaults* on the money paths, now fixed via one helper `getSiteCurrency(siteId)`:
- **Stock movements** (GRN, CONSUMPTION, WASTAGE) write the site's currency, not
  a hardcoded GBP.
- **GL journals** carry a `currencyCode` (added to `XeroManualJournal` + the GL
  param shapes); a Dallas GRN / COGS / wastage journal records USD. Account
  codes are currency-agnostic, so only the journal header currency changes.
- **Valuation** reports per-site value in that site's own currency
  (`bySite[].currencyCode`); the cross-site `total` is a naive sum, only
  meaningful single-currency (documented).
- **Reorder proposals** fall back to the site's currency (a supplier's own
  currency still wins).
Currency *conversion* is deliberately not done — each site's figures stay in its
own currency; the GL handles any consolidation. Reports already segregate by
site, so no GBP/USD mixing in a row.

## D15 — Batch/use-by: a lot ledger beside on-hand; FEFO is forward-only (2026-06-18, spec §A3, §9)
- **Batches are an optional lot detail layer, not the on-hand source.** Only
  products with `require_batch_number` carry `stock_batches` rows; the
  `stock_movements` ledger stays the single source of truth for total on-hand. A
  batch is created on goods-in (when the line carries a `batchCode`) and tracks
  `qty_remaining` + `use_by` per lot. This keeps non-batch items completely
  unaffected (no batch rows, no FEFO).
- **FEFO decrement is forward-only on consumption.** Consumption takes the
  *additional* usage (Δ of actual + wastage since last applied) off the lots
  earliest-`use_by`-first (NULLs last). An amend-*down* does **not** restore qty
  to the lot — the `stock_movements` ledger stays exact (its deltas are precise),
  but `qty_remaining` is best-effort on amend-down. Documented; a lot-level
  reversal is a future refinement. Forward consumption + goods-in are exact.
- **Expiry surfaced via a reports endpoint.** `GET /reports/expiry` (and an
  Expiry tab on the Reports page) lists expired lots (use_by < asOf, qty left)
  and soon-to-expire lots (within N days), worst-first — the food-safety view.
  `asOf` is a parameter (not wall-clock) so it's deterministic + testable.

## D16 — Demand reorder: advisory suggestions + an opt-in per-site engine switch (2026-06-18, spec §9)
- **Estimate from the ledger, suggest, never auto-overwrite.** `DemandEstimator`
  reads demand (SALE + CONSUMPTION decrements) over a trailing window per
  (product, site): `dailyUsage = Σ|decrements| / windowDays`. Suggested
  `reorder_point = dailyUsage × leadTime`, `reorder_up_to = dailyUsage ×
  (leadTime + minDaysCover)`. These are **advisory** — surfaced on the reorder
  levels page; the operator's Accept calls the normal `setReorderParams` path. A
  manual level is never silently overwritten.
- **The engine only uses the estimate when the site opts in.** A per-site
  `sites.demand_reorder` flag (default off, migration `0032`) gates it: with it
  on, `ReorderService.evaluate` sizes the order to the demand-based up-to
  (falling back to the fixed par if there's no history, so it never orders
  nothing); with it off, the fixed par is unchanged. This finally puts
  `min_days_cover` (stored since P6 but unused — D6) to work.
- **`asOf` is a parameter** (defaults to today in the routes) so the estimator
  is deterministic + testable; the engine passes today's date.

## D17 — AI groundwork: a labelled image set + stub tools, no vision model (2026-06-18, spec §A10)
- **One `image_captures` table accumulates the labelled set** keyed by SKU
  (product) + site + timestamp + source (REFERENCE / GOODS_IN / STOCK_TAKE /
  CONSUMPTION / SHELF, migration `0033`). `product_id` / `site_id` are nullable
  (an un-attributed shelf photo has neither). This is data groundwork only — no
  model runs; a real recogniser is a later, additive step over this set.
- **Capture recording is best-effort and never blocks.** `recordPhotoRefs`
  iterates a goods-in / stock-take photo array, resolves `sku → product`, and
  swallows per-photo errors; goods-in calls it inside a try/catch so a capture
  failure can't break the book-in (tested).
- **Stub MCP tools exist so the surface is ready.** `identify_item_from_image`
  and `count_shelf_from_image` (read scope) return `{ available: false, note:
  "not enabled in v1" }` plus the stored capture for the given `image_ref` —
  so Claude/Cowork can call them today and get a graceful, documented answer,
  and turning on a model later doesn't change the tool surface. An admin Gallery
  page browses the set.

## D18 — A fork-specific installer, not a gutted storefront one (2026-06-18, spec §A11)
P24 asks to "fork-adapt infra/install.sh" to deploy only api + web + PWA + MCP.
Rather than surgically strip the storefront out of the 427-line `install.sh`
(which would churn it and fight the "keep the storefront dormant, not gone"
principle, D3), Auto-Stock ships a **separate `infra/install-autostock.sh`**:
- builds `@smmta/shared-types` + `@smmta/api` + `@smmta/web` only — **never**
  `@smmta/store`; the MCP server ships inside `apps/api` (mounted at `/mcp`);
- writes a dormant `apps/api/.env` (Xero `XERO_DRY_RUN=true`, `FEATURE_*` off,
  `CATALOGUE_SYNC`/`MATERIALS_COST_SYNC` off) — only secrets + hostnames in env;
- installs `smmta-api.service` + the four timers
  (`smmta-reorder-sweep`, `smmta-consumption-sweep`, `smmta-square-poll`,
  `smmta-bumblebee-poll`), mirroring the supplier-poll oneshot+timer pattern;
- supports `--dry-run` / `SMMTA_DRY_RUN=1` which prints a greppable PLAN
  (and the explicit "NOT deploying apps/store") and changes nothing — what the
  test exercises (a full run needs root/apt).
The original `install.sh` is left intact for the dormant storefront. The four
periodic jobs each get a CLI under `apps/api/scripts/run-*.ts`; `run-square-poll`
and `run-bumblebee-session-poll` are guarded go-live pullers (no-op without
credentials, like every other external integration in the build).

## D19 — Recipes are keyed by the CAKE, not the experience package (2026-06-19)
Model correction (post-build, from the owner). P15 wrongly keyed recipes by an
`experience_type` enum (CLASSIC/SWEETER/ULTIMATE). Those are **experience
packages** — bundles of experience + merch + beverage sold at different prices
(a Square/BumbleBee pricing concern) — **not** recipes. Two guests on different
packages bake the same cake.
- **`recipes.bake` is a free-form cake name** (e.g. "Victoria Sponge"), not an
  enum: the cake menu grows without a migration; the recipe IS the cake's
  definition. `expectedForSession({ bake, covers })` = recipe(cake) × covers.
- **One cake per session.** A session bakes a single cake; the package tier only
  affects covers (guest count) + price, never ingredients. `coverGroups` (the
  old per-experience list) collapsed to a single `bake` + `covers`.
- **`products.is_experience_booking` (bool)** replaces `products.experience_type`
  — it just flags the bookable experience-package products so a session's covers
  can be summed from its order lines (`resolveCovers`); the cake is chosen on the
  head-baker form. `session_consumption.bake` records which cake a session made.
- **Migration in two non-interactive passes** (`0034` add, `0035` drop): the
  enum→varchar / enum→bool column renames would otherwise need an interactive
  drizzle prompt. Pass 1 adds the new columns (keeping the old → additions only,
  no prompt); pass 2 drops the old columns + the enum (removals only, no prompt).
  Safe because `recipes` was empty and `products.experience_type` all-NULL.
- The experience-package pricing/merch/beverage bundle itself is out of scope
  here (it lives in the sale, via Square/BumbleBee) — this change only stops the
  stock system mislabelling cakes as experiences. `scripts/seed-bakes.ts` seeds
  the four launch cakes (Burger Cake, Victoria Sponge, Coffee & Walnut Delight,
  Battenburg) with standard British-recipe ingredient lists.

## D13 — Guarded MCP action tools: scope + confirm, wrapping existing services (2026-06-18, spec §A9)
- **Action tools are a separate registry, gated by `mcp:write`.** The five write
  tools (`adjust_stock`, `set_reorder_level`, `start_stock_take`,
  `approve_reorder`, `create_purchase_order`) live in `action-tools.ts`, distinct
  from the read `MCP_TOOLS`. The dispatch requires `mcp:write` to call any of
  them; a read-only (`mcp:read`) key is rejected per-tool (not at auth, so the
  same key can do both). `mcpAuth` now accepts either mcp scope.
- **Confirm-or-preview.** Each action tool exposes `preview` (no mutation, echoes
  what it would do + e.g. current on-hand) and `execute`. The dispatch calls
  `execute` only when `args.confirm === true`; otherwise it returns the preview.
  So nothing mutates without an explicit confirm — and Claude/Cowork can show the
  user the preview first.
- **They wrap existing services, so mutations land in the existing ledgers.**
  `adjust_stock` → `StockLevelService.adjust` (ADJUSTMENT movement, idempotent on
  `idempotencyKey`); `set_reorder_level` → `setReorderParams`; `start_stock_take`
  → `StockTakeService.open`; `approve_reorder` / `create_purchase_order` →
  `ReorderService.approve` / `place`. No new write path or audit table — every
  call is also recorded in `mcp_audit_log` by the dispatch. `create_purchase_order`
  is "place the approved proposal" (reorder_proposals carry the rendered PO),
  consistent with D6 (reorder uses `reorder_proposals`, not the drop-ship
  `supplier_orders`).

## P26 — Stock-take-lite (standalone iPad demo)

- **A separate app, not the existing stock-take.** Auto-Stock already has a
  count-vs-book stock-take (`stock_takes`, tied to products/ledger/Xero/JWT).
  The June demo is a deliberately decoupled "stock-take-lite": a blank count
  seeded from the spreadsheet, CSV out, no ledger. Confirmed with owner — the
  point is a low-friction wedge, so it must not drag in the full system.
- **Backend reuses `apps/api` infra but stays isolated.** New `stocktake_lite_*`
  tables have **no FK** to products/sites/ledger; routes are access-code gated
  (`x-stocktake-code`), not JWT. Hosting the sync API in the already-deployed
  api was the fast path; the data model is fully decoupled so it never touches
  Auto-Stock's real stock paths.
- **Catalogue header detection by cell bold.** The spreadsheet encodes structure
  in formatting, not data — bold col-A = heading, bold-followed-by-bold = area.
  SheetJS (the repo lib) can't read bold, so the seed generator is
  Python+openpyxl. The generated JSON is the committed artifact; re-run the
  script only when the master item list changes.
- **Conflicts are flagged, never summed.** When two devices at one site count the
  same item, consolidation marks it CONFLICT and holds it out of the CSV until a
  `stocktake_lite_resolutions` row settles it. Custom ("added") lines collide by
  normalised name so two people adding the same item are caught too. Chosen over
  silent-sum to avoid an unnoticed double-count inflating stock (owner decision).
- **0 is a real count.** "Counted" is its own flag on each line, never derived
  from quantity > 0 — so a tapped "0" is recorded and shows as done, and the
  "not counted" filter stays accurate.

---

# August 2026 feedback fix set (F1 … F15)

## Locked decisions (Roger, 19 Aug 2026)

Recorded here verbatim as **defaults — confirm with owners**. Each resolved a
judgement call so the fix run never blocked.

1. **Venue screens get their own layout.** `/pwa/*` and `/pin-login` move out
   from under the desktop admin chrome into a dedicated `_touch` layout route.
   They stop being an overlay drawn on top of a page nobody can see. The desktop
   admin SPA is untouched.
2. **The app never claims work is saved when it is not.** A transport failure
   queues and says so. An HTTP 4xx/5xx is a *rejection* — surfaced as an error,
   the entry stays on screen, never silently queued.
3. **Stock UoM stays as authored** (`g`, `ml`, `each`) — recipes are written in
   grams and that is correct. What was missing is the **purchase** side:
   purchase UoM, pack size and a conversion factor, plus display in the unit a
   human uses (a 25 kg sack reads as "1 × 25 kg sack = 25,000 g", never "1 g").
4. **Money precision:** `products.expected_next_cost` widens to
   `numeric(18,6)` to match how ingredients are actually priced (£0.0012/g).
   Everything downstream already carries 4dp.
5. **Role split (default):** `head_baker` may record goods-in, counts and
   consumption. `site_manager` additionally may approve a stock-take,
   void/reverse a goods-in receipt, and edit costs. `admin` may do everything.
   Enforced server-side, reflected in the UI.
6. **Undo, not edit.** A mis-booking is corrected by a **reversing receipt** (a
   new, audited, ledger-balancing movement), never by mutating history. A
   90-second in-app undo window issues that reversal; after it lapses a site
   manager can still void from the admin.
7. **Site comes from the device.** The site bound to the PIN wins and is shown,
   large, on every venue screen. A user may still switch site, but switching is
   explicit and the booking confirmation restates the destination.
8. **Recipe data is imported, not seeded.** The four demo cakes go. A CSV
   importer plus a validation report takes their place. Until real data lands,
   the bake screen must fail loudly and legibly ("no recipe for that cake on
   that date"), never silently produce an empty ingredient list.
9. **Enhancement requests are in scope in this pass** (undo window, role
   permissions, benches display, live table count, collapsible navigation,
   base-unit increment buttons), sequenced after the defect they sit next to.
10. **Test depth is full:** Vitest unit + API integration against the real local
    Postgres, plus Playwright at iPad viewports in **both** orientations. Every
    defect ID gets a named regression test.

## F1 — baseline and harness

- **The one red baseline test was the test, not the code.**
  `pwa-assets.test.ts` still asserted the manifest name matched `/Auto-Stock/`
  after `d40761d` renamed it to "Big Bakes Stock". Fixed the assertion; no
  product code touched.
- **The red typecheck was fixed in the script, not in `tsconfig.base.json`.**
  `scripts/seed-count-categories.ts` used an import attribute
  (`with { type: 'json' }`) that `module: "Node16"` rejects. Bumping the whole
  monorepo to `NodeNext` would fix it and change resolution semantics for every
  workspace — far beyond "fix only what is red". The script does a `readFileSync`
  + `JSON.parse` of the same file instead.
- **The dormant storefronts are excluded from the build gate.** `@smmta/store`
  and `@smmta/store-clothes` cannot `next build` in this environment (Google
  Fonts fetch through a TLS-inspecting proxy). They are dormant for Auto-Stock
  by CLAUDE.md, so the gate is `--filter=@smmta/api --filter=@smmta/web`. No
  storefront file is modified by this fix set.
- **No WebKit Playwright project.** The prompt asks for one "where available";
  no WebKit binary is installed here. Chromium-at-iPad-metrics catches layout,
  focus and hit-test regressions; it does not model iOS Safari's keyboard or
  visual viewport. That limitation is stated in the Playwright config header,
  and the manual retest script (F15) remains the final check on real hardware.
- **`chromium` → `desktop`.** With three projects, "which browser" stopped being
  the distinguishing axis. Nothing in CI referenced `--project=chromium`
  (`.github/workflows/e2e.yml` drives `apps/store`, a dormant app).

## F2 — truthful submit

- **408 and 429 queue, despite being 4xx.** The rule is "will a retry ever
  succeed?", not "is the status code in the 400s". A timeout and a rate-limit
  are the server saying *not now*, not *not ever*, so they belong with the 5xx.
- **A rejection is never queued, even though queuing looks kinder.** Holding a
  payload the server has already refused produces a queue that can never drain,
  a pill that never clears, and — worst — a venue that believes the work landed.
  The entry stays on screen instead, with the server's own words.
- **Dead-letter rather than retry forever.** Five attempts, then the action
  moves to a list a human can see. Retrying indefinitely hides a permanent
  failure behind an ever-growing pending count.
- **`PwaQueueSync` lives in `App.tsx` for now, not in a venue screen.** The
  queue is process-global and a baker may reconnect on any page, so per-screen
  mounting would miss replays. F5 moves it into the `_touch` layout, which is
  its proper home once one exists.
- **Overlapping flushes are suppressed.** `online` and `visibilitychange` can
  fire within a frame of each other when an iPad wakes on venue wifi; two
  concurrent flushes would send the same action twice and race the removals.
- **Screen components are exported.** `GoodsInScreen` / `StockTakeScreen` /
  `ConsumptionScreen` are now exported alongside their `Route` so component
  tests can render them without standing up a router. The routes are unchanged.
- **`browserName: 'chromium'` is pinned on the iPad projects.** Without it the
  descriptors ask for WebKit, which cannot be installed in this environment.
  This narrows what the projects prove — metrics, not engine — and that is
  already recorded in the Playwright config header and F1's note.

## F3 — stock-take identity

- **The line carries its own identity; the product map is now optional.** The
  prompt frames D-1 as a paging bug, and the paging *is* fixed — but the deeper
  fault is that a count sheet needed a second network request to name its own
  rows. Any failure of that request took the whole screen down. The join makes
  the row self-describing, so the map can fail without consequence.
- **LEFT join, not inner.** `stock_take_lines.product_id` has an FK today, so a
  genuinely orphaned line cannot exist and `productName: null` is unreachable.
  The join is a LEFT join anyway: an inner join would make a future FK
  relaxation *silently drop rows from a count sheet*, which is a worse failure
  than an ugly label. The test asserts the no-drop property rather than
  pretending to orphan a row the database will not let us orphan.
- **F3 does NOT ship red waiting for F4 — it disables bucketing at the call
  site instead.** The prompt asks for F3's tests to fail until F4 lands, so the
  pair cannot be separated. That would mean committing a red tree, which the
  execution protocol forbids, and — worse — it would mean a commit exists in
  which D-1's mask is gone and counts are being silently destroyed. Passing an
  explicit `0` quantum at the count call site achieves the same safety property
  with no red commit and no window of destruction. F4 still lands immediately
  after and does the real job: removing the blanket default entirely so **no**
  call site can inherit it, and adding the per-product `countQuantum`.
- **The page-size guard is a source-text scan, not a runtime check.** A runtime
  assertion only fires on a code path a test happens to exercise; the venue hit
  this on a screen with no test at all. Scanning the tree catches the ones
  nobody thought to test — as it did immediately, finding three more.
- **`"node"` added to the web tsconfig `types`.** The guard test reads the
  source tree, so it needs Node's fs types. The alternative (an
  `@ts-expect-error` per import, the existing local convention in
  `e2e/helpers/auth.ts`) types those calls as `any`, which is worse in a test
  whose whole job is to be trustworthy. Adding the types introduced no new
  errors anywhere else.

## F4 — count bucketing

- **No default quantum, not even a "safe" one.** A default of 1 or 0 would
  still leave `bucketCount(qty, uom)` looking like a complete call at every
  site. Removing the parameter's default makes the omission explicit at the
  call site, which is where the D-2 bug actually lived.
- **NULL, not 0, for "do not bucket".** `count_quantum` is nullable with a
  CHECK of `IS NULL OR > 0`. Zero would conflate "nobody has thought about this
  product" with "this product is deliberately counted whole" — and the first of
  those is a thing the F9 "needs setup" report should be able to find.
- **A zeroed count warns, it does not block.** An empty shelf is a legitimate
  answer and refusing it would push people to type 1. But it should never pass
  *unremarked*, because that silence is how a destroyed count becomes a
  permanent ledger write-off.
- **Warnings are read before approval, not after.** Approval trues the ledger
  up, at which point the variance is zero and the warning has nothing to point
  at. The route captures them first.
- **0041's SQL was trimmed to the new column.** The generated diff re-emitted
  three already-applied changes because 0038/0039/0040 were hand-authored
  without snapshots; re-running their un-guarded `ADD COLUMN`s would fail. The
  generated snapshot is kept deliberately — it re-syncs the chain so the next
  `db:generate` produces a correct diff instead of the same stale one.

## F5 — touch shell layout

- **`TouchTopbar.venue` is required, not optional.** It was optional, and the
  two screens that omitted it are exactly the two the tester reported as
  missing the venue name. Making it required converted a silent omission into
  five compile errors. `null` is accepted for "still loading" — but there is no
  spelling that omits the question.
- **Three layered heights, not one.** `100vh` → `100dvh` → `var(--tvv-height)`.
  `dvh` handles browser chrome but **not** the keyboard, which is the actual
  B-1 failure; only the visual viewport does. The cascade means an old browser
  degrades to something sane instead of to zero height.
- **When `visualViewport` is unavailable the vars are removed, not zeroed.**
  Setting `--tvv-height: 0px` would collapse the shell. Removing it hands over
  to the stylesheet's own fallback, which is the correct degraded behaviour.
- **`scrollIntoView` is scoped to `.scroll` and deferred a frame.** A
  document-level scroll is what moved the fixed shell off the glass in the
  first place; and at `focusin` iOS has not resized the visual viewport yet, so
  scrolling synchronously aims at pre-keyboard geometry.
- **A new `--bar-venue-warn` token rather than reusing `--warn`.** The badge
  amber is chosen for dark text on a pale ground; white on it is 3.7:1. Reusing
  it for the "not set for this device" chip would have reintroduced B-6's exact
  failure mode on the control that names the venue.
- **`PwaQueueSync` stays at the app root** (superseding F2's note). See the
  comment in `_touch/route.tsx`: a device can reconnect on any page, and
  scoping the replayer to the venue layout recreates a smaller A-2.
- **The venue-screen URLs did not change.** `_touch` is a pathless layout, so
  `/pwa/*` still resolves — no redirect, no stale bookmark on a venue iPad, and
  `NAV_ITEMS` needed no edit.

## F6 — PWA entry point

- **`navigator.standalone` is checked as well as `display-mode: standalone`.**
  The media query is the standard, but an iPad added to the home screen is
  exactly the device this defect is about, and iOS has long reported the older
  boolean. Checking only the standard signal would leave the reported case
  unfixed.
- **`isStandaloneDisplay` degrades to `false`, never throws.** It runs inside
  `beforeLoad` on the auth redirect path, so a throw is a white screen instead
  of a sign-in page. jsdom's lack of `matchMedia` made that concrete, and
  there is a test for it.
- **The redirect keys off the route as well as the display mode.** A `_touch`
  route always means the PIN screen even in a browser tab: someone who has
  navigated to a venue screen wants the venue sign-in whatever the chrome says.
- **`scope` stays `/`, not `/pin-login`.** Narrowing it to the start URL would
  push every link out of the PWA and into Safari — including the venue screens
  the PIN screen exists to reach.
- **The build id is time-derived, not content-derived.** The only property that
  matters is that a new deploy produces a new key; hashing the bundle would be
  more elegant and no more correct here.
- **Sign-out keeps the device's venue binding.** The binding describes the
  iPad, not the person. Clearing it on every sign-out would leave the next
  person's sign-in screen unable to say which venue the device is for — which
  is the B-5 half of the Birmingham booking. "Sign out and forget this venue"
  is the separate, deliberate action.

## F7 — site binding, confirmation, undo, roles

- **Device beats stored, always.** The device knows where it physically is; a
  localStorage entry is a memory of what someone once chose, possibly on a
  different device or before it was moved. Letting the stored value win would
  reproduce E-1 with extra steps.
- **A defaulted site is shown as unbound rather than suppressed.** Refusing to
  work without a binding would block a venue whose PIN setup is incomplete —
  and the bindings are data someone has to enter (human task 3). Naming the
  guess is the honest middle: the work proceeds, and nobody can claim they
  weren't told.
- **Undo is a reversing receipt, not a delete.** Locked decision 6. It also
  makes the undo window a UI convenience rather than a special power: after 90
  seconds the *same* reversal is available to a site manager from the admin,
  because it was never a different mechanism.
- **The reversal's idempotency key is derived from the original receipt id.**
  A double-tapped Undo, or a replay, must reverse once. Deriving rather than
  generating means the second call finds the first.
- **Reversing a reversal is refused (409).** It would net back to the original
  booking, which is almost certainly not what a second Undo tap means.
- **`reversal_of_receipt_id` is not a foreign key.** The pair is written in one
  transaction and points both ways; a self-referential FK in both directions is
  a chicken-and-egg on insert. `GoodsInService.reverse` is the only writer.
- **Undo is NOT offline-queued.** It is a 90-second window on a screen someone
  is watching. Queuing it would land the reversal minutes later, after the
  person walked away believing it was done — the A-1 failure mode exactly. A
  queued booking correspondingly offers no Undo at all.
- **Role-gated actions are hidden, not disabled.** The complaint behind E-4 was
  dead ends. A disabled control with no explanation is a dead end with extra
  visual noise; the server still refuses either way.
- **The cost guard lives inside `PUT /products/:id`, not on the route.** A head
  baker legitimately edits other product fields. Gating the whole route would
  block work the role should do, to protect one field.
- **`site_manager` may cross sites deliberately.** The guard exists to stop an
  accident, not to make a mis-booking unfixable. Someone has to be able to
  correct Birmingham from an office.

## F8 — barcode and product search

- **A scan and a search are different questions.** `by-code` answers "which
  product carries this?" with one row or none; `?search=` answers "what might
  I mean?" with a relevance-ordered page. Conflating them is what let a
  name-relevance hit beat the product that actually carried the code.
- **`by-code` matching is exact and case-insensitive, never partial.** A
  substring match on a code would book a delivery against the wrong product,
  which is strictly worse than finding nothing.
- **Resolution order is barcode → ean → stockCode.** `barcode` is what the
  scanner reads; `ean` is the legacy column still populated on older rows;
  `stockCode` is what a human types off a shelf label when the scan fails.
- **A 404 is data; anything else is an error.** Collapsing a 503 into "no such
  product" would tell a baker to go looking for a product that exists.
- **Attaching a held code is a 409, not an overwrite.** The overwrite is
  invisible and its damage is deferred: the next scan of that code silently
  resolves to the wrong product.
- **The miss sheet adds the line as well as attaching the code.** Making
  someone search, attach, then search again would be the same dead end with an
  extra step.

## F9 — purchase units, packs and cost precision

- **6dp, not 4dp, for `expected_next_cost`.** Recipe `unit_cost` is 4dp and
  matching it would have been defensible, but a per-gram purchase price has one
  more order of magnitude to give than a per-portion recipe cost. 6dp costs
  nothing and removes the question.
- **Auto-scaling g→kg is DISPLAY ONLY.** Everything stored, sent and reconciled
  stays in the stock UoM. A conversion that reached the request would be a new
  and worse version of C-1.
- **`describePackLine` refuses to complete the phrase without a purchase unit.**
  There is no honest resolved figure, and "= 4 g" is precisely what the tester
  was shown. Saying "no purchase unit set" is less tidy and much more true.
- **`packDescription` is free text.** The shapes suppliers ship in do not
  enumerate — "case of 6 × 1.6 kg" is not a UoM, it is a sentence.
- **A 1:1 factor is a WARNING, not an error.** A product genuinely bought by
  the gram is legitimate. The needs-setup report and the form both say so
  rather than refusing to save.
- **The blocked-line guard blocks the whole booking, not just the line.** A
  half-booked delivery is harder to reason about than one that did not go
  through, and the fix (set a purchase unit) takes a minute.
- **The needs-setup payload is `{ rows, summary }` inside `data`.** The
  envelope's sibling keys are reserved for pagination and `apiFetch` unwraps
  `data`, so a top-level `summary` would have been silently dropped.

## F10 — number entry

- **"Pristine" rather than "select all on open".** Selecting the buffer would
  work for a keyboard but means nothing for a tap, and the venue's primary
  input is a finger. A pristine flag gives both the same behaviour.
- **Backspace on a pristine value clears the whole thing.** Deleting one
  character off a default the user is visibly replacing is a half-measure that
  leaves a confusing remainder ("1" → "" is right; "250" → "25" is not what
  anyone meant).
- **The "was N" hint exists because replacing is destructive.** The old value
  is gone the moment the first digit lands; showing it costs a line and removes
  any doubt about what was there.
- **A rejected "." is still consumed.** On `allowDecimal={false}` the keystroke
  is swallowed rather than passed through — a "." arriving somewhere else on
  the page is a stranger failure than nothing happening.
- **One hook for both sheets.** The wastage keypad was a copy of the quantity
  keypad, which is why one bug was two bugs. Sharing it is the actual fix; the
  behaviour change is only half.
- **The display is a live region.** Its value changes with no focus movement,
  so without `aria-live` a screen-reader user gets no feedback at all from
  either the keypad or the keyboard.

## F11 — receipt and exit guards

- **The receipt has no timer.** Auto-dismissing it would reintroduce the exact
  complaint: work disappearing on its own. The undo window expires because it
  must; the receipt waits for a person.
- **"Keep editing" is the solid button.** On a touch screen the visually
  dominant action is the one that gets pressed in a hurry, and the safe choice
  should win that.
- **Each screen's guard fires only on real uncommitted work.** Goods In on
  unbooked lines, stock-take on unsaved counts, End of Bake on *adjusted*
  ingredients (not a merely-loaded list). A guard that always fires is a guard
  people learn to dismiss without reading.
- **Drafts are keyed by site as well as screen.** This is the same class of
  error as E-1 and would be harder to spot: someone else's delivery presented
  as yours, on the screen where venue confusion already cost 100 kg.
- **A restored draft is announced.** Silently repopulating a form is
  indistinguishable from never having lost it — right up until the moment it
  was actually a different session's work.
- **A queued (offline) booking shows no receipt.** There is no reference and no
  confirmed content to show; the "saved offline" toast is the honest whole
  story, and the list still clears because the work IS captured.

## F12 — End of Bake

- **Every control moves the DISPLAYED number in its own direction.** This
  supersedes the inline comment that justified the inverted `Table−` ("one
  fewer table used means more left"). That reasoning is sound about *usage* and
  wrong about the *screen*: the number on screen in REMAINING mode is what's
  left, and a `+` beside a `Table+` that disagree is unusable whatever the
  underlying logic. The relabelling to "+1 table left" carries the old intent
  in words instead.
- **One mutation path for all four steppers.** `bumpDisplayed` is the only way
  a stepper changes a line; the buttons differ solely in the size of the delta.
  Two code paths is how the two buttons disagreed in the first place.
- **REMAINING mode reports no variance at all.** The form has no consumed
  figure — deriving one from an assumed opening is exactly what the server
  refuses to do. Showing "Δ −500" was worse than showing nothing.
- **`remainingSet` exists so 0 can mean something.** "The shelf is empty" and
  "I haven't counted it" are different facts, and the pre-F12 code sent both as
  `remainingQty: 0`.
- **~~`benchesPerTable` is per-site and nullable.~~ WITHDRAWN 20 Aug 2026 —
  see the F16 entry below.** A bench and a table are the same thing; this
  decision rested on a misreading and the column has been dropped.
- **The reducers live outside the component.** These were arithmetic bugs; a
  pure module lets the regression be a table rather than a click-through.

## F13 — Recipe importer, dietary variants, demo seed retired (Aug-2026)

- **Recipes are imported, not seeded** (locked decision 8). The four demo cakes
  reached a live venue test, where a baker was asked to record a bake of a cake
  Big Bakes does not sell. The seed moved to `scripts/demo/seed-bakes.demo.ts`
  and now refuses to run with `NODE_ENV=production` **or** against a database
  that already holds non-demo recipes. `docs/RECIPE_IMPORT.md` is the operator
  path; `scripts/import-recipes.ts` is the tool.
- **Any problem fails the WHOLE import.** Skip-the-bad-row would leave a
  half-imported menu, and every validation rule describes something that
  becomes invisible once it is in the database — which is exactly how F-5
  survived to a live test. The report names file, row (as a person counts them,
  header = 1), rule and problem; a dry run produces the identical report.
- **The purge keeps anything real.** `scripts/purge-demo-bakes.ts` deletes the
  demo recipes and their ingredient products, but an ingredient with stock
  movements, a stock level, consumption history, or a line in a non-demo
  recipe is **reported and kept**. A demo name on a product does not make the
  ledger behind it demo data; destroying somebody's real count to tidy up a
  seed would be a far worse outcome than an untidy product list.
- **`POST /recipes/expected` now returns `{ lines, blockers }`,** not a bare
  array. Default — confirm with owners. The old shape could not distinguish
  "this recipe has no ingredients" from "there is no recipe", and the screen
  rendered both as an empty list under a toast that vanished. Only one caller
  existed, so the breaking change was cheap and the alternative (a second
  endpoint the screen might forget to call) reproduces the defect by omission.
- **The refusal is not dismissible.** `BlockingNotice` has no dismiss control:
  dismissing it would restore exactly the silent-empty-form state F-6
  describes. It names the cake, the date and the venue, lists each blocker, and
  ends with "This bake cannot be submitted."
- **A diet with no variant recipe disables its table field** rather than
  accepting a number. Accepting one produced the standard ingredient list and
  looked like it had worked — F-5 exactly. A count left over from a cake that
  *did* have the variant is zeroed when the cake changes, so a disabled,
  invisible number can never be submitted.
- **`GET /recipes/coverage` is a separate read** rather than a field on the
  bakes list. Coverage is per `(bake, site, date)` — an effective recipe, not a
  property of the cake name — so it cannot be answered by the menu endpoint.
- **The test fixture is namespaced `ZZ Test Fixture Cake` / `zz-test-*`.** The
  importer writes under the singleton company, so a fixture named like a cake
  would be indistinguishable from the menu in a product list sorted by name —
  which is the F-4 failure mode all over again.

## F14 — Navigation context and transitions (Aug-2026)

- **The venue rail lives outside `.touch-app`, and indents it.** `.touch-app`
  is `position: fixed; inset: 0` — the shell that fixed B-1 — so a flex sibling
  inside the layout would be painted over. The rail is a fixed `<nav>` at a
  higher z-index and the overlay's `left` is shifted by a
  `venue-rail-open` class on `<html>`. A class rather than a global custom
  property because `/pin-login` is a `.touch-app` screen that is **not** inside
  the venue layout and must not be indented by a rail it never renders.
- **The Menu button comes from context, not from each screen.** `TouchTopbar`
  reads `useVenueNav()`, which is null outside the venue layout. Five screens
  get the button without five edits, and the PIN screen — where nobody has
  signed in yet — is offered no navigation at all.
- **Rail at ≥900px, drawer below.** An iPad in landscape has the width; in
  portrait it does not, and a 132px rail would take a sixth of the glass from
  a screen whose whole problem was things being cut off.
- **The current job is marked three ways** — salmon ground, bold label, and
  `aria-current="page"` plus a literal "You are here". "Confirm the active
  page" is the request, and colour alone confirms it to nobody using a screen
  reader. The desktop nav gained `aria-current` for the same reason.
- **`prefers-reduced-motion` omits the class rather than overriding it.** The
  CSS media query is kept as a backstop, but the decision is made in a hook so
  it is testable and so no animation is started and then cancelled.
- **`sectionLabel` reuses `activePath`.** A breadcrumb derived independently
  could disagree with the highlighted nav row — on `/stock/by-site`, where
  `/stock` is a prefix, that is exactly the confusion B-7 complains about.
- **Collapse state in `localStorage`, defaulting to expanded.** It is a
  property of this browser, not of the account. When `localStorage` throws
  (private-mode Safari) the answer is "expanded": a nav nobody can read is
  worse than one that forgets a preference.
- **A route-pending skeleton at 150ms / 300ms minimum.** Below 150ms a
  skeleton that appears and vanishes inside a frame is its own kind of abrupt;
  once shown, 300ms keeps it from flickering.

## F15 — Regression sweep and close-out (Aug-2026)

- **The matrix is a register, not coverage.** Every ID already had a dedicated
  suite; `feedback-2026-08-12.spec.ts` and its API counterpart exist so someone
  can read down the list before the next venue session and see each reported
  symptom still has a test with its name on it. Titles quote the tester
  verbatim, so a failure reads as the complaint it came from.
- **Exactly one deliberate skip**, and it carries its reason in the call:
  E-4's *UI reflection* needs a PIN-minted `head_baker` token rather than the
  admin JWT the e2e harness generates. The enforcement — the part that protects
  data — is asserted server-side, and the reflection in component tests. B-6
  was a conditional skip until it was fixed to authenticate first and assert
  properly; a skip that fires silently on all three projects is not a test.
- **Source-level guards for whole classes of bug.** A unit test cannot catch
  "nobody calls this function" (A-2) or "someone added a `pageSize: 500`"
  (D-1). Those are properties of the tree, and a grep is the honest tool. The
  scanners **strip comments first** — every fix explains itself by quoting the
  code that caused it, and a naive grep failed on the explanation. The
  `mutateAsync` guard also asserts it found something, so it cannot pass
  vacuously if the scan itself breaks.
- **Performance floors, not benchmarks.** 320 lines, sub-100 ms filter,
  pinned chrome after a full scroll. Set to fail on a regression that makes a
  screen unusable, not on the noise of a shared box.
- **The e2e stub honours `search`.** A products stub returning the whole
  catalogue for every query made the barcode-miss path untestable:
  `resolveBarcodeToProduct` falls back to search, and an unfiltered list always
  "finds" something. Two specs were passing for the wrong reason.
- **A-3 aborts the transport rather than emulating offline.** The claim under
  test is the pill's *depth*; `route.abort('failed')` makes that deterministic,
  where `setOffline` plus a fulfilled route left the mutation in flight.
- **The retest script is numbered and defect-tagged** so the next session is a
  like-for-like comparison. Each step names the ID it re-tests, so a failure
  can be reported as "step 14 — C-1 is back".

## F16 — Benches ARE tables (Aug-2026, correcting F-7)

- **A bench and a table are the same thing.** One team, baking one cake
  together. "Bench" is the word used in the venue; "table" is the word in the
  spec and the recipe model. Confirmed by the owner, 20 Aug 2026.
- **F-7 was misread.** "Request to show benches under the kilo figures" was
  taken as a request for a *second unit* alongside tables, and a per-site
  `benchesPerTable` ratio was built to convert between them — a conversion
  factor between a thing and itself. Any value entered would have rendered
  "4 of 5 tables · ≈ 24 benches" for a five-bench session. Dropped in migration
  `0045`; the column shipped and was never populated, because the go-live step
  that would have set it was stopped first.
- **What F-7 actually needed was already computed.** `impliedBenches` derives
  the count from the quantity and the recipe's per-bench amount. It needed
  displaying under the figure, not converting. The fix made the feature
  smaller: a column, a settings field, a hook and a helper all deleted.
- **The venue screens say "bench" throughout** (owner's choice between the two
  words). The four in-venue pages, their labels, their stepper buttons and this
  module's identifiers all use it.
- **The API wire format still says `covers` / `glutenFreeTables` /
  `veganTables`.** Renaming request fields is a breaking change that buys
  nothing — the words are synonyms, so the wire is not wrong, only older. The
  mismatch is documented at the top of `line-reducers.ts` and at the state
  declaration in `consumption.tsx` so the next reader does not re-derive the
  distinction from the field names.
- **A test asserts the ratio stays gone.** `site.routes.test.ts` checks that
  `POST /sites` neither accepts nor returns `benchesPerTable`, and the web
  regression asserts the hint line carries no `≈`. Re-adding the column would
  put a meaningless field back on the Sites page and a wrong figure under every
  quantity, and nothing else would catch it.
