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
