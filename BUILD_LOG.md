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
