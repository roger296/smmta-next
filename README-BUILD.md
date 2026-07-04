# New Filament Store — build quickstart

This fork of smmta-next adds the "new filament store" feature set (pre-orders
against inbound shipments, a pricing engine, a tool-calling sales agent, an
event-driven notification + marketing pipeline with a human approval queue, and
credit-bonus subscriptions). Built per [`docs/tech-spec.md`](docs/tech-spec.md)
(v1.6); every step is logged in [`BUILD_LOG.md`](BUILD_LOG.md).

## Prerequisites

- Node 22+ and npm 11 (`npm@11.9.0` pinned).
- Docker (for Postgres).

## First run

```bash
# 1. Postgres (dev + a dedicated test DB).
docker compose up -d postgres
docker compose exec postgres psql -U smmta -d smmta_next -c 'CREATE DATABASE filament_test;'

# 2. Install.
npm install

# 3. Env: copy the template and fill in (test/sandbox keys only for local dev).
cp .env.example apps/api/.env      # then edit
#   TEST_DATABASE_URL should point at filament_test

# 4. Migrate both DBs.
TEST_DATABASE_URL=postgresql://smmta:smmta@localhost:5432/filament_test \
  npm run db:migrate -w @smmta/api
# (and the dev DB via DATABASE_URL)

# 5. Seed dev data.
npm run seed:dev -w @smmta/api
```

## Run the apps

```bash
npm run dev -w @smmta/api        # API on :3000 (or PORT)
npm run dev -w @smmta/worker     # background worker (pg-boss + agents)
npm run dev -w @smmta/store      # storefront (Next.js)
```

## Gates

```bash
npm run gate     # typecheck + lint:ts + tests for shared-types / api / worker
npm run smoke    # full-system end-to-end walkthrough (asserts DB state each step)
```

`npm run gate` runs the ~485-test backend suite against `filament_test`.
`npm run smoke` drives: place a >30-day pre-order → mark paid → slip ETA →
approval draft → send (sandbox) → flag a SKU → restock → back-in-stock fanout →
digest — asserting at each step.

## Credentials (all optional for local dev)

Mollie, OpenRouter, and SendGrid all default to in-memory fakes / sandbox when no
key is set, so everything runs and tests pass without credentials. To exercise
the real sandboxes, put test keys in `apps/api/.env` — see
[`docs/HUMAN-OPS.md`](docs/HUMAN-OPS.md).

## Deploy

The one-shot installer story is `infra/install.sh`; the worker runs as its own
systemd unit (`infra/systemd/smmta-worker.service.template`). Backups +
disaster-recovery: [`docs/RESTORE.md`](docs/RESTORE.md). Provider/DNS tasks a
human must do before launch: [`docs/HUMAN-OPS.md`](docs/HUMAN-OPS.md).
