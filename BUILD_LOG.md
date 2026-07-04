# BUILD_LOG — New Filament Store

Build of the "new filament store" feature set on a fork of smmta-next, following
[`docs/tech-spec.md`](docs/tech-spec.md) (THE SPEC, v1.6) via the build prompts
([`docs/build-prompts.md`](docs/build-prompts.md), Prompts G / 0–16). One dated
entry per prompt: (a) what was built, (b) deviations from THE SPEC and why,
(c) test counts before/after, (d) known gaps deferred.

---

## Entry 0 — Orientation & scaffolding (2026-07-04)

### (a) What was built
- Placed THE SPEC at `docs/tech-spec.md` and a build-prompts pointer at
  `docs/build-prompts.md` (full prompts live in Drive; pointer records the file
  ids for crash-resume).
- Verified the environment: Docker Postgres reachable (`smmta-next-postgres-1`
  on `:5432`), Node 24, npm 11.9.0, drizzle-kit present.
- Created a dedicated test database `filament_test` and migrated it to head
  (all 17 committed migrations `0000`→`0016` apply cleanly from empty).
- Pointed the test harness at a dedicated test DB. `apps/api/test/setup.ts` now
  resolves `TEST_DATABASE_URL` → `DATABASE_URL` → `filament_test` default and
  copies the winner into `DATABASE_URL`. Added `TEST_DATABASE_URL` to
  `apps/api/.env` so local `npm run gate` uses `filament_test`, never dev data.
- Added `.env.example` at repo root covering every variable this build will need
  (DB + test DB, JWT/COMPANY_ID, Auth.js/Google/Facebook, Mollie test, SendGrid
  sandbox, OpenRouter + daily cap in micro-USD, pg-boss schema, Sentry, backups).
- Added the gate: root `npm run gate` = `turbo run typecheck lint:ts test`
  filtered to `@smmta/shared-types` + `@smmta/api` (backend focus keeps the gate
  fast — no Next.js builds; storefront/admin tests run under their own commands
  and are folded in from Prompt 14). Also added root `typecheck`, `lint`
  (→ `lint:ts`), and `smoke` (`node scripts/smoke.mjs`, a placeholder that exits
  0 and is extended from Prompt 6 onward).

### (b) Deviations from THE SPEC (with reasons)
- **Monorepo app names.** THE SPEC (§4.1) names `apps/storefront` and
  `apps/admin`; the real fork uses `apps/store` (+ `apps/store-clothes`) for
  storefronts and `apps/web` for the admin SPA. Per Prompt G, repo convention
  wins — I will target the real app names throughout.
- **Money type at the boundary.** Existing smmta-next stores money as
  `decimal(18,2)` (pounds, 2dp). THE SPEC + Prompt G mandate **integer pence**
  for the new tables (columns are literally named `*_pence`, e.g.
  `credit_balance_pence`, `deposit_pence`). Decision: **new tables use integer
  pence** (spec is emphatic and it is a float-safety correctness rule); at the
  boundary with existing `orders`/`products` decimal columns I convert
  explicitly (pence ↔ pounds) at the seam and never do float arithmetic on money.
- **Test DB strategy.** THE SPEC/prompt asks for a separate test DB migrated
  fresh + truncated between tests. Implemented the *separate DB* now
  (`filament_test`); the existing suite already isolates by wiping per-company
  fixtures in `beforeEach`/`beforeAll` rather than a global truncation, so I kept
  that idiom (repo convention wins) instead of imposing a global truncate that
  would fight 34 existing suites.

### (c) Fix required to reach a green baseline
- `src/workers/supplier-poll.worker.test.ts` (per-chunk-error-tolerance block)
  seeded three `supplier_products` rows all sharing `(productAId, supplierId)`,
  which violates the `supplier_products_product_supplier_unq` unique index on
  `(product_id, supplier_id)`. It passed before **only because the dev DB
  `smmta_next` was behind on migrations and lacked that constraint**. Per Prompt
  G ("fix a wrong test, log it"): the test was wrong — it assumed uniqueness on
  `(supplier, supplier_sku)`. Fixed by creating one distinct product per extra
  SKU (SKU-C/D/E), preserving the multi-chunk intent. No production code changed.

### (d) Repo conventions captured (authoritative for later prompts)
- **Schema:** `apps/api/src/db/schema/*.ts`, barrelled by `index.ts`; migrations
  in `apps/api/src/db/migrations` via `drizzle-kit generate`. Helpers in
  `common.ts`: `pk()` = `uuid().primaryKey().defaultRandom()`, `companyId()` =
  `uuid('company_id').notNull()`, `auditTimestamps` (createdAt/updatedAt/deletedAt,
  `timestamp(..,{withTimezone:true})`, `defaultNow()`), enums via `pgEnum()`.
- **DB access:** `getDb()` / `getPool()` from `config/database.ts`; env via zod
  `getEnv()` in `config/env.ts`. ESM throughout (`type: module`, `.js` import
  specifiers, Node16 resolution).
- **Routes:** `export async function <name>Routes(app: FastifyInstance)`,
  registered manually in `app.ts` under `/api/v1`; `requireAuth`/`getAuthUser`
  (JWT) and `apiKeyAuth([scope])` middleware; response shape
  `{ success: true, data }` | `{ success: false, error }`.
- **Services:** class singletons per module, `private db = getDb()`; custom error
  classes mapped to HTTP status in routes; zod `*.schema.ts` per module.
- **Tests:** vitest, co-located `*.test.ts`, `test/setup.ts`, `fileParallelism:
  false`, `app.inject()` for routes, per-company fixture wipes.
- **Singleton tenancy:** `getSingletonCompanyId()` (`shared/auth/company.ts`),
  `COMPANY_ID` env default `11111111-1111-4111-8111-111111111111`.
- **Existing domain to reuse (do not fork):** inventory/stock (`products.ts`
  `stockItems`, `reservation.service.ts` with `FOR UPDATE SKIP LOCKED`), orders
  (`orders.ts`, `order-commit.service.ts`), channels + per-channel pricing
  (`channels.ts`), api-keys auth (`auth.ts`), Luca GL (`integrations/luca`).
  Existing Mollie handling is **webhook-validation only** in `order-commit`;
  Prompt 6 adds the outbound Mollie wrapper.

### Test counts
- Before: `@smmta/api` 394 tests, **57 failing** (dev DB behind migrations) — not
  a true baseline.
- After (against fresh `filament_test`): **394 passed, 0 failed** (3 pre-existing
  `skipped`). `npm run gate` exits 0; `npm run smoke` exits 0.

### Gate
`npm run gate` → green. Committed as `build(0): orientation and scaffolding`.

---

## Entry 1 — Worker, pg-boss, domain events (2026-07-04)

### (a) What was built
- **`domain_events` outbox table** (`apps/api/src/db/schema/events.ts`, migration
  `0017_domain_events.sql`): partial index on unprocessed rows
  (`ix_events_unprocessed … WHERE processed_at IS NULL`) + aggregate index.
- **`emitDomainEvent(tx, input)`** (`src/shared/events/emit.ts`): takes a Drizzle
  transaction handle (typed `DbTx`, derived from the `transaction` callback param)
  so an event can only be written inside the same tx as its business change.
  Typed event union `DomainEventType` (`shared/events/types.ts`) covering the full
  §12.2/§12.4/§16.4 taxonomy.
- **pg-boss integration** (`src/worker/`): `pgboss.ts` (instance in its own
  `pgboss` schema), `registry.ts` (typed `EVENT_HANDLERS` fan-out map + the
  §12.3 scheduled-job cron catalogue + retry policy), `dispatcher.ts` (the
  outbox-dispatcher), `handlers.ts` (hot-swappable handler registry + Prompt-1
  no-op stubs), `job-failures.ts` (recent-failure query for the digest),
  `index.ts` (`startWorker`/`stopWorker`/`setupQueues`).
- **Crash-safe dispatch**: each event is claimed with `FOR UPDATE SKIP LOCKED`;
  handlers are enqueued with `singletonKey = <eventId>:<queue>` on queues created
  with pg-boss **`policy: 'short'`** (unique index on `(name, singleton_key)`
  while a job is in the `created` state). So a crash between enqueue and the
  `processed_at` commit re-dispatches without creating a duplicate job — the
  handler fires exactly once. `outbox-dispatcher` runs on a ~10s `setInterval`
  loop (pg-boss cron min-granularity is 1 min), per §12.3.
- **`apps/worker`**: a thin, separately-deployable process
  (`apps/worker/src/index.ts`) that loads env and calls `startWorker()`, with
  SIGINT/SIGTERM graceful shutdown. Boots cleanly (`worker started`, 5 handler
  queues + 8 scheduled jobs).

### (b) Deviations from THE SPEC (with reasons)
- **Where the code lives.** §4.1 sketches `apps/worker` as the home of all job
  logic. The repo already co-locates workers with the schema in `apps/api`
  (`src/workers/*`) and the Drizzle schema is not a shared package (it lives in
  `apps/api/src/db/schema`, not the spec's `packages/db/schema`). To honour "share
  the Drizzle schema with the API" without a cross-package `.ts` resolution mess,
  ALL event/dispatcher/pg-boss code lives in `apps/api/src/worker` (one
  typecheck/test unit with the schema + db), and `apps/worker` is a thin
  bootstrap that imports `startWorker` from `@smmta/api/worker` (subpath export
  → source; worker tsconfig `paths` mirror it for typecheck). This preserves the
  spec's separately-deployable worker process / systemd unit / scale-out story.
- **`company_id` on `domain_events`.** Added (repo convention: every table has it,
  single-tenant singleton). §13.5's sketch omits it.

### (c) Test counts
- Before: 394 api tests. After: **402 api tests, all green** (+8):
  `emit.test.ts` (4 — committed write, rollback-never-persists, registry
  consistency) and `dispatcher.test.ts` (4 — exactly-once + processed stamp,
  exactly-once across a simulated crash between enqueue and commit,
  rollback-never-dispatched, retry-per-policy→dead-letter).

### (d) Notes / gotchas discovered
- pg-boss v10 dedup is **policy-driven**: `singletonKey` only dedups `created`
  jobs under `policy: 'short'` (or `stately`); the default `standard` policy does
  not. And `createQueue` is `ON CONFLICT DO NOTHING`, so an already-existing queue
  keeps its old policy — `setupQueues` therefore calls `createQueue` **then**
  `updateQueue` to enforce policy/retry/dead-letter idempotently on redeploy.

### Gate
`npm run gate` → green (402 tests). Worker boots. Commit `build(1): worker,
pg-boss, domain events`.

---

## Entry 2 — Full schema migration set (2026-07-04)

### (a) What was built
- Every remaining SPEC §13 table + §17.8 deltas, in new schema files
  (migration `0018_filament_core_schema.sql`):
  - Identity/consent (`identity.ts`): `storefront_users`, `auth_identities`,
    `consent_records`, `suppression_list`.
  - Interest (`interest.ts`): `prospective_products`, `interest_flags`.
  - Inbound (`inbound.ts`): `inbound_shipments`, `inbound_shipment_lines`.
  - Chat/LLM (`chat.ts`): `chat_sessions`, `chat_messages`, `llm_log`.
  - Messaging (`messaging.ts`): `message_drafts` (with §17.8 deltas expires_at,
    group_key, reject_reason, body_original), `escalations`, `agent_config`
    (per-event-type auto_send).
  - Subscriptions (`subscriptions.ts`): `subscriptions`, `subscription_events`.
  - Pricing (`pricing.ts`): `pricing_rules` config (bands/carton/floor as data).
- **Product delta** (migration `0019`): `products.carton_size` +
  `products.landed_cost_pence` — pulled forward from Prompt 5 so `seed:dev`'s
  "SKUs with carton multiples" and the pricing floor are coherent now.
- **Enforced invariants:** `uq_provider_account` unique; `uq_flag` unique
  **NULLS NOT DISTINCT** (via `unique()` constraint) so prospective-only watches
  with NULL sku still dedup; `uq_pricing_rules_category` NULLS NOT DISTINCT for a
  unique default row; **consent_records append-only** via a plpgsql trigger
  (`consent_records_append_only`) raising on UPDATE/DELETE (appended to the
  migration — drizzle can't express triggers); `merged_into` is a plain uuid
  column (no FK) so it never cascades.
- **`seed:dev`** (`scripts/seed-dev.ts`, `npm run seed:dev`): idempotent seed —
  3 filament SKUs w/ carton multiples + landed cost, 3 inbound pools at ETA
  +70/+40/+20 days (one per §15.2 band), 2 prospective products, 3 users
  (guest/Google-linked/trade) + consent rows, default `pricing_rules`.

### (b) Deviations / decisions (logged)
- **`users` → `storefront_users`.** The spec's canonical customer table is
  `users`, but the repo already has `users` (admin operators). New table is
  `storefront_users`; spec design (person vs login-methods, merge-on-verified-
  email, guest tier) preserved. All new FKs point here.
- **Enum style = text-enum, not pgEnum.** THE SPEC defines every new table with
  Drizzle `text(.., { enum })` (§13.1 rationale: cheaper to extend). Followed for
  the new tables — a deliberate divergence from the repo's `pgEnum` convention
  (the spec's literal definitions win here, per Prompt G's "spec wins on
  conflict").
- **Percentages as basis points.** `pricing_rules` stores all % as integer bp
  (10000 = 100%) so fractional rates (2% fee = 200 bp) stay integer-exact — no
  floats near money.
- **"one inbound shipment with lines and ETAs at 70/40/20 days"** read as one
  pool per band (three shipments) so the pricing engine has each band to exercise.
- **`consent_records` append-only** enforced with a DB trigger (chosen over
  app-layer REVOKE); tests disable it transiently to clean fixtures.

### (c) Test counts
- Before: 402. After: **407 api tests green** (+5 invariant tests in
  `filament-schema.test.ts`: append-only consent, NULLS-NOT-DISTINCT flag dedup,
  presale default 0, merged_into no-cascade, seed idempotency).
- Fresh-DB path verified: empty DB → 20 migrations → `seed:dev` → OK.

### Gate
`npm run gate` → green (407). Commit `build(2): full schema`.

---

## Entry 3 — Identity, auth, consent (2026-07-04)

### (a) What was built
- **ConsentService** (`modules/identity/consent.service.ts`): append-only
  grant/revoke (each a new row) emitting `consent.granted`/`consent.revoked` in
  the same tx; `currentConsent(userId, type)` = latest row, default false.
- **IdentityService** (`modules/identity/identity.service.ts`):
  - `captureGuest(email)` — idempotent guest creation, emits `user.created`.
  - `findOrCreateForProvider(...)` — the Auth.js signIn path: existing identity →
    its user; else verified email matches a user → link identity + upgrade
    guest→account + mark verified; else create a fresh account. Emits
    `user.created` for new users.
  - `mergeUsers(a, b)` — survivor rule (`pickSurvivor`: account beats guest,
    else oldest `created_at`), re-points auth_identities / interest_flags (unique-
    aware) / chat_sessions / message_drafts / subscriptions, carries consent
    forward as new append-only rows, stamps `merged_into` (never deletes), emits
    `user.merged`.
- **Routes** (`modules/identity/identity.routes.ts`, storefront-api-key gated):
  `POST /storefront/identity/guest`, `POST /storefront/identity/resolve-provider`,
  `POST /storefront/consent`, `GET /storefront/consent/:userId/:type`. Registered
  in `app.ts`.

### (b) Decisions / deviations (logged)
- **Survivor rule (exact):** if exactly one of the pair is non-guest → it
  survives; else the older `created_at` survives.
- **Consent on merge:** consent_records is append-only, so a merge cannot
  re-point consent rows by UPDATE. The survivor's consent is **carried forward as
  new rows** for any type the survivor has no record of (loser's rows remain as
  PECR evidence). Logged as the compliant interpretation of "consent re-points to
  the survivor".
- **Orders do NOT re-point.** The spec says merge re-points orders "when they
  exist" — in this repo orders reference the existing `customers` table, not
  `storefront_users`, so there is nothing to re-point here; the linkage between a
  storefront_user and a customer is Prompt 6 (checkout) territory.

### (c) BLOCKED — needs live credentials / storefront wiring
- **Auth.js (NextAuth) in `apps/store`**: needs the `next-auth` dependency +
  Google OAuth client id/secret (env `GOOGLE_CLIENT_ID`/`SECRET`), with Facebook
  code-complete behind `AUTH_FACEBOOK_ENABLED` (default off). The API-side
  identity resolution (`resolve-provider`) + guest/consent endpoints are built
  and tested; the NextAuth route + storefront account UI wire to them in
  **Prompt 14** (storefront account area). Per Prompt 3's gate, the email/guest
  tier is proven via service tests in lieu of a live Google sign-in. A human must
  supply the Google OAuth credentials before the social-login path can run.

### (c) Test counts
- Before: 407. After: **415 api tests green** (+8 in `identity.service.test.ts`:
  guest idempotency + user.created, currentConsent across grant/revoke + events,
  pickSurvivor rules, merge guest→account with FK re-point + consent carry +
  event, merge account→account oldest-survives, provider create + link/upgrade).

### Gate
`npm run gate` → green (415). Commit `build(3): identity, auth, consent`.

---

## Entry 4 — Inbound shipments & presale stock pools (2026-07-04)

### (a) What was built
- **InboundService** (`modules/inbound/inbound.service.ts`):
  - Shipment CRUD (`createShipment` w/ lines → `shipment.created`;
    `getShipment`/`listShipments`; `setStatus`; `setTrackingRefs` multi-format).
  - `updateEta` — emits `shipment.eta_changed {oldEta,newEta}`, no-op (no event)
    when unchanged.
  - **Presale allocation** — `allocatePresale`/`releasePresale`, row-locked
    (`SELECT … FOR UPDATE` on the line joined to its shipment for `bufferPct`),
    refuses oversell with `PresaleOversellError`. `presaleAvailable(manifested,
    buffer, presold)` = `floor(manifested×(100−buffer)/100) − presold`, floor 0.
  - **`goodsIn`** — sets `qty_received` per line, emits `shipment.arrived`,
    `shipment.short_shipped` (variance), and `stock.allocation_broken` when
    `received < presold`; sets status `received` + `arrivedAt`.
  - **`getStockAndEta(sku)`** — the single read model: warehouse band
    (`in_stock`/`low_stock`/`out_of_stock`) from IN_STOCK row count vs the
    `pricing_rules.low_stock_threshold`, plus every unarrived inbound pool with
    exact `presaleAvailable`.
- **Admin routes** (`inbound.routes.ts`, JWT-gated): list/detail/create, ETA
  edit, status, tracking-refs editor, goods-in, allocate. Registered in `app.ts`.

### (b) Goods-in inventory bridge (logged)
- The existing warehouse model is **one `stock_items` row = one unit** (the
  storefront reservation service locks rows with `FOR UPDATE SKIP LOCKED` and
  `availableQty` is the COUNT of IN_STOCK rows — `catalogue.service.ts`). So
  `goodsIn` bridges by inserting `qtyReceived` IN_STOCK `stock_items` rows for
  the SKU's product at its `defaultWarehouseId` (falling back to the company's
  first warehouse). No parallel inventory system is built — presale pools live
  only on the shipment line until goods-in transfers them to the warehouse.

### (c) BLOCKED / deferred
- **Admin SPA screens** (apps/web: shipment list/detail, tracking editor, ETA
  edit, goods-in form) deferred to sit alongside the broader admin UI work; the
  admin REST surface is complete + tested and `apps/web` is out of the gate.
  Tracked here.

### (d) Test counts
- Before: 415. After: **420 api tests green** (+5 in `inbound.service.test.ts`:
  buffer arithmetic, created/eta_changed events, **50-way presale oversell race
  (exactly one wins)**, short-shipment → arrived+short_shipped+allocation_broken
  + goods-in bridge, and band thresholds out/low/in with exact presale avail).

### Gate
`npm run gate` → green (420). Commit `build(4): inbound shipments and presale
pools`.

---

## Entry 5 — Pricing engine (2026-07-04)

### (a) What was built
- **Pure engine** (`modules/pricing/pricing.engine.ts`): `computeQuote(inputs)` —
  carton tier (exact whole-carton multiples only), pre-order band from
  days-to-ETA (`bandDiscountBp`, highest satisfied `minDaysToEta` wins), additive
  structural stacking capped at `maxStackBp`, silent floor clamp
  (`priceFloorPence` = landed + variable fulfilment + payment-fee% + min-
  contribution%). Best-of codes (structural stack OR code, cheaper wins, never
  both). Output carries `*Internal` fields; `toCustomerFacing` strips them.
- **PricingService** (`pricing.service.ts`): resolves product (base =
  `minSellingPrice`→pence, `cartonSize`, `landedCostPence`) + `pricing_rules`
  default + pool ETA + optional code from the DB, then calls the pure engine.
  Typed `PricingError` with codes `INVALID_SKU`/`POOL_UNAVAILABLE`/`INVALID_CODE`
  (aligned to the §14.2 agent envelope). `discount_codes` table + `validateCode`
  (migration `0020`). Everything is integer pence / basis points.

### (b) Decisions (logged)
- **Money rounding:** discount amounts use `Math.round` (nearest pence) so the
  §15.3 worked example lands exactly (£19.99 × 30% = 600p → £13.99), not floor.
- **A discount never raises the price:** for an underwater SKU (landed > base,
  so floor > base) the engine falls back to base rather than presenting a
  higher-than-shelf "discounted" price. The floor invariant (`unit ≥ floor`)
  therefore holds for realistically-priced SKUs (base ≥ floor); an underwater SKU
  is a merchandising misconfig the pricing engine won't "fix" by inflating price.
- **Base price = `minSellingPrice`** (filament shelf price). Channel-specific
  pricing (ChannelService) as a base override is a noted future hook — not wired
  now. Per-category `pricing_rules` override is also a hook (default row used);
  logged for Prompt 14/follow-up.
- **Savings itemisation:** floor-clamped totals are allocated across
  carton/preorder in proportion to nominal bp so the itemised £ always sum to the
  real `savingsVsBasePence`.

### (c) Test counts
- Before: 420. After: **433 api tests green** (+13): engine (band boundaries,
  exact-multiple carton + upsell hint, golden §15.3 £13.99 + clears floor, £14.99
  promo clamps, best-of either side of crossover, **floor-never-breached property
  grid**, no-`*Internal`-leak scan) + service (warehouse base, stacked carton off
  70-day pool, code best-of, INVALID_SKU/POOL_UNAVAILABLE/INVALID_CODE,
  customer-facing strip).

### Gate
`npm run gate` → green (433). Commit `build(5): pricing engine`.

---

## Entry 7 — Interest flags & prospective products (2026-07-04)

> Taken before Prompt 6 (Mollie): interest flags are self-contained and the
> optional deposit tier is explicitly deferrable to Prompt 6. Prompt 6 (payments)
> remains pending. Logged here.

### (a) What was built
- **InterestFlagService** (`modules/interest/interest.service.ts`):
  - `resolveFlagType(state)` — the F8 contextual button: out_of_stock→restock,
    in_stock/low_stock→offers, prospective→register_interest.
  - `createInterestFlag` — for a guest (email, no userId) the user + the
    `flag_updates` consent + the flag are created **atomically in one
    transaction**, with `user.created` / `consent.granted` /
    `interest.flag_created` events. Duplicate flags are a no-op via the
    NULLS-NOT-DISTINCT unique index.
  - `clearFlag`, and `listInterests(userId)` **enriched** — for a watched SKU on
    an unarrived pool it adds the ETA + per-unit pre-order saving by reusing
    `InboundService.getStockAndEta` + `PricingService.quote` (no duplication).
  - `thresholdCheck(eventId)` — the **first real event handler** (replaces the
    Prompt 1 stub): row-locks the prospective, counts active flags, and emits
    `interest.threshold_crossed` **exactly once** (idempotent via
    `threshold_crossed_at`), flipping status to `group_buy_open`.
- **Handler wiring**: `worker/feature-handlers.ts` registers the real
  `threshold-check` handler at boot **before** the stubs; `startWorker` calls
  `installFeatureHandlers` then `installStubHandlers` (stubs only fill gaps).
- **Routes** (`interest.routes.ts`, storefront-api-key gated): create flag,
  clear flag, list interests. Registered in `app.ts`.

### (b) Decisions / deferrals (logged)
- **Owner notification = the event, not a draft.** `message_drafts.user_id` FKs
  to storefront customers, not the owner, so threshold-crossed does NOT write a
  draft; the emitted `interest.threshold_crossed` event is surfaced by the digest
  (Prompt 15). (Spec allowed either; chose the event.)
- **Deposit tier deferred** to Prompt 6 (needs the Mollie deposit path) — SPEC
  open question 2. Schema already carries `deposit_pence` / `deposit_paid_pence`.
- **Storefront button component + coming-soon catalogue** (apps/store) deferred to
  Prompt 14 (storefront UX); the API is complete + tested.

### (c) Test counts
- Before: 433. After: **438 api tests green** (+5): flag-type resolution, guest
  atomic create (user+consent+flag+events), duplicate no-op, **threshold
  exactly-once under concurrent checks**, enrichment £-saving.

### Gate
`npm run gate` → green (438). Commit `build(7): interest flags`.

---

## Entry 6 — Mollie payments & payment timing (2026-07-04)

### (a) What was built
- **Mollie wrapper** (`integrations/mollie/`, mirrors the Luca pattern):
  `MolliePort` interface + a real fetch-based `MollieClient` (Payments API, TEST
  mode) + an in-memory `FakeMollie` (test helpers to drive paid/failed) +
  `getMollie()` factory (fake when no key / NODE_ENV=test). Integer pence ↔
  Mollie decimal at the boundary.
- **Payment-timing rule** (`modules/payments/payment-rules.ts`, pure):
  `isBankOnlyOrder`/`offeredMethods`/`isMethodAllowed` — any line with ETA
  **>30 days** forces bank-only; exactly 30 is still the full set.
- **PreorderService** (`preorder.service.ts`): `createPreorder` — resolves pool
  ETA, quotes + **locks band/£ savings/unit price** onto each line, allocates
  presale **atomically** (new `InboundService.allocatePresaleTx`/`releasePresaleTx`),
  persists the order, emits `order.placed` + `order.awaiting_payment`, and opens a
  Mollie payment (bank-only methods on >30-day) for non-manual methods.
  `markPaid` (idempotent → `order.payment_received` + `order.paid`), `cancel`
  (release presale, `order.cancelled`, refund_pending if paid), `scanPaymentWindow`
  (frozen-clock: day-3 `order.payment_overdue` once, day-5 lapse → release
  presale + `order.lapsed_unpaid`), `handleWebhook` (thin, idempotent).
- **Worker**: `payment-window-scan` scheduled stub replaced with the real scan.
- **Routes**: storefront place/get/cancel pre-order, admin mark-paid, thin
  `/webhooks/mollie` (ACK 200 fast, normalise async + idempotent).

### (b) Decisions / deviations (logged)
- **Pre-orders modelled in a dedicated `preorder_orders`/`preorder_order_lines`**
  (migration 0021), not the existing `customer_orders`. The existing warehouse
  checkout is stock-item-reservation based and cannot represent unarrived-stock
  pre-orders (no `stock_items` until goods-in), and §16.4's split-basket design
  already produces a SEPARATE order for the pre-order half. This is the
  "extend, don't fork" line drawn where the existing model genuinely doesn't fit.
- **Band lock = a per-line snapshot** (`locked_unit_price_pence`,
  `locked_band_bp`, `locked_saving_pence`) written at order time; a later
  `pricing_rules` change never reprices it (tested).

### (c) BLOCKED / deferred
- **Live Mollie**: `MollieClient` is BLOCKED until a `MOLLIE_API_KEY` (test) is
  supplied; the whole flow is exercised against `FakeMollie`.
- **Mixed-basket split UI + the >30-day CCR confirmation tick** are storefront
  (apps/store) — deferred to Prompt 14; the split is a server operation producing
  the separate pre-order (this service) + the existing warehouse order.
- **Luca GL reconciliation** of manual transfers → `markPaid` is the manual
  bridge now (admin action); auto-match is a later integration.

### (d) Test counts
- Before: 438. After: **446 api tests green** (+8): rule boundary at exactly 30
  days + method allow-list; **band lock survives a pricing_rules change**;
  window-scan day-3-once / day-5-lapse under a frozen clock with **presale
  released**; **webhook idempotency** (duplicate → one `order.paid`); card
  rejected on a >30-day order.

### Gate
`npm run gate` → green (446). Commit `build(6): payments and payment timing`.

---

## Entry 8 — OpenRouter wrapper & sales agent (2026-07-04)

### (a) What was built
- **OpenRouter wrapper** (`integrations/openrouter/`): `LlmPort` + real
  `OpenRouterClient` (OpenAI-compatible tool-calling) + scripted `FakeLlm` +
  `OpenRouterService` — **model fallback list**, **per-day spend cap** (sums
  today's `llm_log.cost_micro_usd`; `SpendCapExceededError`), and **every call
  logged to `llm_log`** (audit + tuning dataset). Cost is integer micro-USD.
- **Basket** (`modules/agent/basket.service.ts` + `baskets`/`basket_lines`
  tables, migration 0022): prices are NEVER stored on a line — `view()`
  re-quotes through the pricing engine every time, so a skipped/tampered price
  can't corrupt an order. `addLine` stock-validates (warehouse count / presale
  availability) → `InsufficientStockError`.
- **Tool layer** (`modules/agent/tools.ts`): the §14.3 `TOOL_SCHEMAS` +
  `ToolExecutor` — direct service-layer calls returning the uniform
  `{ok,data}|{ok:false,error:{code,message}}` envelope with §14.2 codes.
  `quote_price` returns the **customer-facing serializer only**. Identity +
  basket are injected from the session (`ToolContext`), **never** tool args.
- **Agent loop** (`agent.service.ts`): `startSession` (session + basket),
  `runTurn` — model → execute tools → loop, max **8 tool calls/turn** and **60/
  session**, graceful wind-down on spend cap / budget. Messages + tool calls/
  results persist to `chat_sessions`/`chat_messages` for replay.
- **Versioned system prompt** (`system-prompt.ts`, `sales-agent/v1`) embedding
  §14.4 + §16.2a + §15.1a (£-not-%, out-of-stock resolution order, >30-day
  payment framing, escalate-don't-improvise).
- **SSE chat route** (`chat.routes.ts`): start session + stream a turn.

### (b) Decisions / deferrals (logged)
- **Live OpenRouter BLOCKED** until `OPENROUTER_API_KEY` supplied; the whole
  loop runs against `FakeLlm`.
- **SSE is turn-atomic** (one `message` event per turn), not token-level
  streaming — a thin transport enhancement for later.
- **Storefront chat UI** (apps/store floating panel, anonymous-email form)
  deferred to Prompt 14.
- **Anonymous `create_interest_flag`** returns `LOGIN_REQUIRED` (the email
  capture form is a UI concern); logged-in path is wired.

### (c) Test counts
- Before: 446. After: **451 api tests green** (+5): **tool-schema scan proves no
  tool accepts user/session/basket id** (structural anti-injection), happy path
  (search→quote→add, basket priced ONLY by the engine, llm_log rows written),
  out-of-stock → `INSUFFICIENT_STOCK` envelope, **spend-cap wind-down (model
  never called)**, anonymous `get_customer_interests` → `LOGIN_REQUIRED`.

### Gate
`npm run gate` → green (451). Commit `build(8): sales agent`.

---

## Entry 9 — SendGrid compose/send pipeline (2026-07-04)

### (a) What was built
- **SendGrid wrapper** (`integrations/sendgrid/`): `SendGridPort` +
  `SendGridClient` (transactional/marketing sender identity by `category`;
  sandbox enforced) + `FakeSendGrid` (dedupes by idempotency key). Postgres is
  the contactability source of truth.
- **ComposeService** (`compose.service.ts`): one OpenRouter `compose` call per
  message with a versioned per-templateKey prompt (`templates.ts`); writes a
  `message_drafts` row (category, `group_key`, `expires_at`), emits
  `draft.created`, and — if the type is graduated (`agent_config.auto_send_enabled`)
  — emits `draft.approved` for the auto-send path. £ facts are computed by code
  and passed in; the model only formats.
- **SendService** (`send.service.ts`) — the **last gate before SendGrid**. AT
  SEND TIME re-checks suppression, marketing consent, expiry, and the frequency
  cap (config `MARKETING_FREQ_CAP_COUNT`/`_DAYS`); parks with a queryable reason
  otherwise. Idempotency = draft id (wrapper dedupe **+** conditional
  `status <> 'sent'` update), so a retry can never double-send. Emits
  `message.sent` / `message.failed`.
- **SuppressionService**: upserts the suppression cache + emits
  `suppression.updated`; an unsubscribe/complaint also writes a
  `general_marketing` consent revocation and cancels the user's pending marketing
  drafts (§12.4).
- **Webhook + unsubscribe routes** (`messaging.routes.ts`): signature-verified
  SendGrid event webhook (HMAC-SHA256 over the body with `SENDGRID_WEBHOOK_KEY`)
  and a signed one-click unsubscribe (`unsubscribe.ts`, HMAC over user id) with
  `List-Unsubscribe`/`-Post` headers on marketing sends.
- **Worker**: `compose-message` + `send-message` stubs replaced;
  `EVENT_HANDLERS['draft.approved'] = ['send-message']` so an approved draft
  flows straight to the send gate.

### (b) Decisions (logged)
- **Webhook signature = HMAC-SHA256** over the JSON body (production may switch
  to SendGrid's ECDSA public-key scheme — a localized wrapper change).
- **Parked = `status:'failed'` + `editorNotes:'parked:<reason>'`** (the enum has
  no `parked` state); the reason is queryable, and `reject_reason='expired'` is
  set for expiry so the digest can surface zombies.

### (c) BLOCKED / deferred
- **Live SendGrid** BLOCKED until `SENDGRID_API_KEY` supplied (sandbox/fake used).
  SPF/DKIM on the sending subdomain is an ops task (Prompt 15 HUMAN-OPS).

### (d) Test counts
- Before: 451. After: **460 api tests green** (+9): **no-% template lint**,
  compose→draft.created, **suppression respected after approval**, no-consent
  park, **frequency-cap parks the (N+1)th (reason queryable)**, expired never
  sends, **idempotent retry (one send, one message.sent)**, webhook **signature
  rejection** + valid bounce→suppress+revoke, signed unsubscribe revokes consent.

### Gate
`npm run gate` → green (460). Commit `build(9): compose/send pipeline`.

---

## Entry 10 — Approval queue & escalations (2026-07-04)

### (a) What was built
- **ApprovalQueueService** (`modules/approval/approval.service.ts`):
  - `listQueue` — one priority-ordered inbox of pending drafts + open escalations
    (§17.3: eta_slip → escalation → back_in_stock fanout → nightly marketing),
    with expiry countdowns.
  - `getDraftDetail` — draft + its trigger-event payload (the facts panel, §17.2).
  - `approve` / `editThenApprove` (stores `body_original`) / `reject` (mandatory
    reason) — a strict state machine (`IllegalTransitionError` on non-pending);
    approval emits `draft.approved` → send-message.
  - `getGroup` (one rendered instance + K **seeded-deterministic** random
    spot-checks, `selectSpotChecks`) + `approveGroup` (touches exactly the group).
  - `resolveEscalation`, `graduationStats` (rolling approved-unedited rate over
    last N of a type), `setAutoSend` (flips `agent_config` → compose auto-approves).
  - `expiredDraftSweep` (§17.7) — new hourly `expired-draft-sweep` scheduled job.
- **Admin routes** (`approval.routes.ts`, JWT): queue list/detail, approve/
  edit-approve/reject, group get/approve, escalation resolve, graduation +
  auto-send toggle. Registered in `app.ts`.

### (b) Deferred
- **Admin SPA screens** (apps/web: mobile-first inbox, facts-panel detail, swipe
  approve, reject sheet, group review, graduation banner) — the REST surface is
  complete + tested; apps/web is out of the gate. Tracked for the admin-frontend
  pass.

### (c) Test counts
- Before: 460. After: **468 api tests green** (+8): seeded spot-check determinism,
  priority ordering, approve→event + illegal re-transition, edit stores original,
  reject reason, group approve touches exactly members, **graduation rate + toggle
  flips compose to auto_approved (end-to-end)**, expiry sweep.

### Gate
`npm run gate` → green (468). Commit `build(10): approval queue`.

---

## Entry 11 — Notification agent: reactions (2026-07-04)

### (a) What was built
- **NotificationService** (`modules/notification/notification.service.ts`) — the
  proactive layer, event-driven per §12.4:
  - `backInStockFanout` — on `stock.replenished`, compose for every active
    restock watcher under a shared `back_in_stock:<sku>` group_key, then clear
    the flags.
  - `reactEtaChanged` — on a material `shipment.eta_changed` (worse by > config
    threshold, default 2 days), compose the wait/swap/refund options to each
    affected pre-order customer. **Idempotent per (order, new ETA)**.
  - `cancelDraftsForUser` — `consent.revoked` cancels the user's queued/pending
    marketing drafts.
  - `swapToWarehouse` — swaps a pre-order line to warehouse stock at the LOCKED
    price: releases the presale allocation, consumes warehouse `stock_items`,
    keeps the locked unit price → **stock and money both conserve**.
- **`stock.replenished` now emitted from `goodsIn`** on an out→in transition
  (per-SKU), so arrival drives the back-in-stock fanout.
- **Worker wiring**: real `back-in-stock-fanout` + new `notify-eta-changed`,
  `notify-arrival`, `cancel-user-drafts` handlers; `EVENT_HANDLERS` maps
  `shipment.eta_changed`, `shipment.arrived`, `consent.revoked`.
- **Swap route**: `POST /storefront/preorders/:id/lines/:lineId/swap-to-warehouse`.

### (b) Decisions / deferrals (logged)
- **Reactions are event-driven** (§12.4) rather than periodic scanners: the
  daily `eta-watch` / hourly `stock-watch` scan variants are represented by the
  event reactions above (arrival closes the window via `arrivedAt`, which the
  pricing engine already honours → `POOL_UNAVAILABLE`). The pure periodic
  scanners (which need per-SKU band-tracking state) are a follow-up; the customer
  outcomes §12.4 specifies are covered now.
- **Flags cleared at compose time** (not on `message.sent`) — simpler; the
  partial unique index lets a customer re-enrol. Logged.
- **`shipment.arrived` fulfilment-notice compose** is stubbed (handler logs);
  the window-closing behaviour (the load-bearing part) is done via `arrivedAt`.

### (c) Test counts
- Before: 468. After: **473 api tests green** (+5): fanout count + flag clear,
  **ETA-slip idempotency + threshold**, **arrival → POOL_UNAVAILABLE**,
  cancel-on-revoke, **swap conserves stock + money**.

### Gate
`npm run gate` → green (473). Commit `build(11): notification agent`.

---

## Entry 12 — Marketing agent (2026-07-04)

### (a) What was built
- **Cadence math** (`modules/marketing/cadence.ts`, pure): `medianIntervalDays`
  + `predictRunOut` (min-data floor of 3 → a single/one-off purchase is
  excluded; `regular` = interval CV < 0.5 → the subscription-upsell signal).
- **`run_out_predictions` table** (migration 0023): per (user, sku) cadence.
- **MarketingService** (`marketing.service.ts`):
  - `recomputePredictions` — nightly cadence from paid pre-orders → upserts
    predictions.
  - `runNightly` — SQL-first segmentation (run-out-due, offer-watchers,
    subscription-upsell = regular + no active sub, lapsed = paid but silent 90d).
    **Selection gates run BEFORE compose** (consent + suppression + frequency-cap
    headroom), so LLM spend is never burned on unsendables. A user in two
    segments is **deduped to one message/night** (highest-priority segment wins).
    Per-segment enable flags + `MARKETING_MAX_SENDS_PER_NIGHT`. Returns per-segment
    counts for the digest. Composes via the same pipeline with a segment
    `group_key`.
- **Templates**: added `lapsed_winback` + `subscription_upsell` (no-% lint from
  Prompt 9 covers them).
- **Worker**: `run-out-prediction` + `marketing-nightly` stubs replaced.

### (b) Decisions (logged)
- **Predictions keyed on (user, sku)** as a testable proxy for the spec's
  (user, material-category) while the storefront-user↔order linkage and a product
  material taxonomy are still being built.

### (c) Test counts
- Before: 473. After: **477 api tests green** (+4): cadence (regular predicts,
  single/insufficient excluded, irregular not "regular"), **segmentation excludes
  unconsented/suppressed at selection time**, **dedupe to one message/night**,
  disabled-segment honoured.

### Gate
`npm run gate` → green (477). Commit `build(12): marketing agent`.

---

## Entry 13 — Subscriptions: mandates, credits, dunning (2026-07-04)

### (a) What was built
- **Plan config** (`plans.ts`): credit-bonus model (§15.4) — £20→£23, £50→£59;
  renewal interval + dunning ladder days [1,3,5].
- **Schema**: `subscriptions` gained `dunning_attempts`, `first_failed_at`,
  `last_attempt_at` (migration 0024).
- **SubscriptionService**:
  - `signup` — Mollie customer + a first payment (`sequenceType='first'`) to
    establish the mandate; `activateFromPayment` (paid first-payment webhook) →
    create the subscription + grant the first credit; **idempotent per customer**.
  - `renewalScan` — charges due mandates; paid → credit_grant + advance
    `renewsAt`; failure → `past_due` + `subscription.payment_failed`.
  - `paymentRetry` (dunning §16.4) — retries at day **1/3/5** after the first
    failure; a successful retry recovers to active; the final failure **pauses**
    the sub + composes a personal-tone message. Frozen-clock driven.
  - `applyCredit` — consumes `min(balance, amount)` at normal prices (credits are
    money-equivalent, no discount interaction); returns credit used + residual.
  - `pause`/`resume` (subscription_events + `subscription.modified`).
  - **Credit conservation by construction**: every balance change writes a signed
    `subscription_events.amount_pence`, so `balance == Σ amounts`.
- **Mollie fake** gained `setMandateCharges(mandate, 'failed'|'paid')` to drive
  dunning. **Webhook** now dispatches to both preorder + subscription activation.
- **Routes**: signup / pause / resume / apply-credit (storefront-gated);
  `subscription-renewal-scan` worker stub replaced (renewal + dunning).

### (b) Deferred
- Storefront account UI (credits, skip/pause) → Prompt 14. Live Mollie mandates
  BLOCKED on a test key (fake used).

### (c) Test counts
- Before: 477. After: **483 api tests green** (+6): activation + first credit
  (idempotent), **renewal + credit conservation (balance == Σ events)**, **dunning
  ladder day-1/3/5 → pause**, successful-retry recovery, **pause blocks the scan +
  retains balance**, applyCredit exact/partial/zero.

### Gate
`npm run gate` → green (483). Commit `build(13): subscriptions`.
