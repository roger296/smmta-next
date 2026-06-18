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
