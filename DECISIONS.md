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
