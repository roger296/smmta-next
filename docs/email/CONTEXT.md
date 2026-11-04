# Email system — codebase context (section 0)

Written by the section 0 survey. It records what the repository looked like when the email
build started and how each part of the runbook maps onto it. Where the runbook assumes a
layout this repo does not have (it was written for "a Next.js app"), the mapping is here.

## Stack

| Thing | Found |
| --- | --- |
| Monorepo | npm workspaces + Turborepo. `apps/api` (Fastify 5, Drizzle 0.41, Postgres 16, pg-boss 10), `apps/web` (admin SPA: Vite + React 19 + TanStack Router/Query + Tailwind 4 + Radix), `apps/store` / `apps/store-clothes` (Next 15 storefronts), `apps/worker` (thin process calling `startWorker` from `apps/api/src/worker`). |
| Node / npm | Node 22, npm 11 (`packageManager`). |
| TypeScript | 5.8, ESM (`.js` import suffixes in the API). |
| Lint / format | No ESLint/Prettier in the API; `lint:ts` = `tsc --noEmit` in the web app. CI typechecks the API with `npx tsc --noEmit -p apps/api`. So "lint" for this build = `tsc --noEmit` on api and web. |
| Tests | Vitest 3. API tests are co-located `*.test.ts`, integration tests hit a real Postgres (`TEST_DATABASE_URL`/`DATABASE_URL`, see `apps/api/test/setup.ts`), `fileParallelism: false`. Web: Vitest + Testing Library; Playwright config present in web and store. |
| Env | `apps/api/src/config/env.ts`: one zod schema, `getEnv()` cached, `resetEnvForTests()`. `env.coverage.test.ts` proves `.env.example` documents every key. |

## Database

- Drizzle schema in `apps/api/src/db/schema/*.ts`, re-exported from `index.ts`.
- Migrations: `npx drizzle-kit generate --name <name>` writes `apps/api/src/db/migrations/NNNN_<name>.sql` + snapshot; `npm run db:migrate -w @smmta/api` applies them. The API container runs migrations on every boot (`docker/api-entrypoint.sh`), so **a failing migration takes the API down** — migrations here must be safe on existing data.
- Hand-written SQL (triggers, functions) is appended to the generated migration file, as `0018_filament_core_schema.sql` does for `consent_records_append_only`.
- Enums: older tables use `pgEnum` (in `common.ts`); the storefront/messaging tables use `text(.., { enum })`. The email tables use **pgEnum** (the spec names them as enums and the DB then enforces them).
- Every table has `company_id` (singleton, `getSingletonCompanyId()`).

### Tables the email system touches

| Concept | Table(s) | Notes |
| --- | --- | --- |
| Customers (back office, orders) | `customers` (`email` varchar 100, no consent column), `customer_contacts` | Orders link here: `customer_orders.customer_id`. |
| Storefront identity | `storefront_users` (`email` unique, `kind` guest/account/**trade**) | Used by the chat agent, pre-orders, subscriptions, existing LLM messaging. |
| Existing consent | `consent_records` (append-only, `general_marketing` / `flag_updates`, per storefront user) | Evidence used by the backfill. |
| Existing suppression | `suppression_list` (email PK, bounce/complaint/unsubscribe/manual) | Fed by the existing `/api/v1/webhooks/sendgrid`. |
| Newsletter | `newsletter_subscribers` (email unique, `unsubscribed_at`) | Filled by the notify-me form tick box. |
| Orders / lines | `customer_orders` (`order_date` date, `grand_total`, `source_channel`), `order_lines` (`product_id`, `quantity` double) | |
| Products / variants | `products` (one row per variant; `group_id`, `colour`, `slug`, `hero_image_url`, `min_selling_price`, `is_published`, `category_id`, `created_at`), `product_groups` | Variants are rows linked by `group_id`. |
| Categories | `categories` (two-tier; the clothes taxonomy) | Filament products have **no material category** — material is inferred from the group/product name (`apps/store/lib/materials.ts` does the same). See "Interests" below. |
| Carts | storefront DB (`smmta_store`): `carts`, `cart_items`, `checkouts.customer` (email captured at checkout start) | API side: `baskets` (agent baskets) + `basket.abandoned` event. |
| Back-in-stock requests | `stock_notifications` (productId, email, `fulfilled_at`) | Spec calls this `back_in_stock_requests`. |
| Pre-orders | `preorder_orders`, `preorder_order_lines` | |
| Subscriptions | `subscriptions`, `subscription_events` | |
| Trade tier | `storefront_users.kind = 'trade'`; no trade discount tier on `customers` | Part B #11 rule used: trade = linked storefront user of kind `trade`, or any order with ≥10 of one SKU. |
| Admin users | `users` (email + password → JWT) | |
| Settings | No general settings mechanism (chatbot has its own table). New `email_settings` key-value table. |

## Existing email code (all of it)

| Path | What it does |
| --- | --- |
| `apps/api/src/integrations/sendgrid/sendgrid.ts` | `SendGridPort` + `SendGridClient` (POST /v3/mail/send, sandbox unless production) + `FakeSendGrid` used in tests. |
| `apps/api/src/modules/messaging/*` | LLM-composed drafts (`message_drafts`) → approval queue → `SendService` (checks `suppression_list`, `consent_records`, frequency cap) → SendGrid. Webhook `POST /api/v1/webhooks/sendgrid` (ECDSA-verified with `SENDGRID_WEBHOOK_VERIFICATION_KEY`) → suppression list. `/api/v1/unsubscribe` signed with `UNSUBSCRIBE_SECRET`. |
| `apps/api/src/modules/marketing/*` | Nightly segments (run-out, offer watcher, lapsed …) composed into drafts. |
| `apps/api/src/modules/agent/escalation.service.ts`, `workers/supplier-order-placer.worker.ts` | Internal alerts to staff via `getSendGrid()`. |
| **Back-in-stock sender** | `modules/storefront/notify-me.service.ts` `fulfilForProduct`, called from `modules/purchasing/grn.service.ts` after a GRN. Sends through `HttpNotifyMeSender` → storefront `POST /api/internal/send-back-in-stock` → storefront `email_outbox` → storefront's own SendGrid call (`apps/store/lib/email.ts`). Template lives in the storefront (`apps/store/lib/email-templates`). |
| Storefront transactional mail | `apps/store/lib/email.ts`, `apps/store-clothes/lib/email.ts`: order confirmation, dispatch, refunds via each storefront's `email_outbox` and `@sendgrid/mail`. |

## Jobs (pg-boss)

- `apps/api/src/worker/registry.ts`: `HANDLER_QUEUES` + `EVENT_HANDLERS` (domain event → queues, fed by the outbox dispatcher) and `SCHEDULED_JOBS` (`{ name, cron }`, scheduled with `boss.schedule`, crons are UTC).
- `worker/feature-handlers.ts`: `setHandler(queue, fn)` installs real handlers. Domain events come from `emitDomainEvent(tx, …)` (`shared/events`), always inside a transaction.
- The worker runs as its own container (`docker/worker.Dockerfile`), not inside the API.

## API routes / auth

- Plugins registered in `apps/api/src/app.ts` with `{ prefix: '/api/v1' }`.
- Admin routes: `app.addHook('preHandler', requireAuth)` (JWT, `shared/middleware/auth.ts`), user via `getAuthUser(request)`.
- Service-to-service: `apiKeyAuth([scopes])` (`shared/middleware/api-key.ts`), keys in `api_keys` with `scopes text[]`.
- Response shape `{ success: true, data }` / `{ success: false, error }`.
- The admin SPA reaches the API through its own nginx (`/api/` → `api:3000`), so `https://admin.cleverdeals.net/api/...` is the API.

## Admin SPA

- File routes in `apps/web/src/routes/_authed/<section>/index.tsx` (`createFileRoute`), `routeTree.gen.ts` generated by the TanStack router Vite plugin.
- Data hooks in `apps/web/src/features/<area>/use-*.ts` using `apiGet/apiPost` from `src/lib/api.ts` (check) and react-query.
- Components: `components/ui/*` (card, badge, button, dialog, input, select, tabs, …), `components/data-table`. Charts: `recharts`.
- Navigation: `components/layout/sidebar.tsx`; sections can be hidden with `VITE_HIDDEN_SECTIONS` (`lib/nav-sections.ts`).

## MCP server

**Not found.** There is no MCP server in this repo (the chat agent's tools in `modules/agent/tools.ts` are OpenRouter function tools for customers, not an operator MCP). Section 10 builds one (see BLOCKERS/BUILD_LOG).

## Storefront

- Checkout captures the email at `POST /api/checkout/start` (storefront `checkouts.customer`), before payment.
- Newsletter: no footer form; the only signup is the notify-me tick box (`newsletter_subscribers`).
- Public pages for this build are served by the API (server-rendered HTML) and exposed on the storefront domain through a Next.js rewrite (see section 2).

## Mapping of the runbook to this repo

| Runbook | Here |
| --- | --- |
| `src/modules/email/` | `apps/api/src/modules/email/` with `services/`, `jobs/`, `templates/`, `mcp/`, `public/`, `lib/` |
| `admin/` | `apps/web/src/features/email/` + `apps/web/src/routes/_authed/messaging/*` |
| `scripts/email/*.ts` | `apps/api/scripts/email/*.ts` |
| `tests/fixtures/email/` | `apps/api/test/fixtures/email/` |
| `npm run test:email` | `npm run test:email -w @smmta/api` (vitest on `src/modules/email`) |
| branch `feature/email-marketing` | `claude/inspiring-feynman-e88jdq` (the branch this session is required to use) |
| `msw`/`nock` | not used: the repo's convention is injected ports/fakes (`FakeSendGrid`) and `vi.stubGlobal('fetch', …)`; followed. |
| `SENDGRID_WEBHOOK_PUBLIC_KEY` | the repo already has `SENDGRID_WEBHOOK_VERIFICATION_KEY`; both are accepted, the existing name wins if both are set. |
| `/api/webhooks/sendgrid` | the existing `/api/v1/webhooks/sendgrid` is extended (one endpoint, one signature check) and also mounted at `/api/webhooks/sendgrid`. |

## Interests

The spec keys interests on category id. Filament products have no material category, so
interests are keyed on an **interest key**: `material:<code>` (pla, petg, abs, asa, tpu,
nylon, carbon, silk, wood) derived from the product/group name, plus `category:<id>` when a
product has a category. One function (`lib/interests.ts`) derives the keys for a product, so
digest blocks, clicks and orders all agree. "Top-level material categories" in Part B #9 =
the material keys.

## Import files

`imports/sendgrid/*.csv` were **not present** at the start of the build (see BLOCKERS).
