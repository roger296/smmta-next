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
