# Stock-take-lite (`@smmta/stocktake`)

A standalone, installable iPad PWA for a quick on-site stock take — count on the
device, sync to the VPS, export a CSV. Built for the Big Bakes managers as a
low-friction demo ahead of the full Auto-Stock rollout (BUILD_LOG **P26**).

It is **deliberately decoupled** from the full count-vs-book stock-take
(`apps/api/src/modules/stock-take`): no products, no ledger, no Xero. The item
list is the head-office spreadsheet, the output is a plain `Product, Quantity`
CSV.

## How it works

- **Counters** open the app, pick their site + type their name + the shared
  access code, then count. Big quick buttons (hero **0**, ± steppers, tap-to-type),
  pack-size hints, progress, a "not counted" filter, search, and "add item not on
  the list". Works **offline** (catalogue bundled, counts in `localStorage`) and
  syncs when back online.
- **Multiple iPads** can count one site at once. Each carries a device id; the
  server keeps every counter's figures separate.
- **Head office** opens `#/consolidate`, sees every site, settles any conflicts
  (an item counted by more than one person is held out of the CSV until resolved),
  and exports the merged CSV.

## Develop

```bash
# from the repo root
npm install
npm run dev -w @smmta/stocktake      # http://localhost:4100
```

The API it talks to is the Auto-Stock `apps/api`. Point at it with
`VITE_API_BASE` (empty = same origin, i.e. nginx proxies `/api`). For local dev
against a local API:

```bash
# terminal 1 — API on :8080 against a dev/test DB, with an access code
DATABASE_URL=postgresql://smmta:smmta@localhost:5435/smmta_next \
  STOCKTAKE_ACCESS_CODE=demo123 npm run dev -w @smmta/api
# terminal 2 — the PWA pointed at it
VITE_API_BASE=http://localhost:8080 npm run dev -w @smmta/stocktake
```

## Build & test

```bash
npm run typecheck -w @smmta/stocktake
npm run test -w @smmta/stocktake
npm run build -w @smmta/stocktake     # → apps/stocktake/dist
```

## Regenerate the catalogue / icons

```bash
python apps/stocktake/scripts/build-catalogue.py   # needs python + openpyxl
python apps/stocktake/scripts/make-icons.py
```

## Deploy (VPS)

Static `dist` served by nginx, with `/api` proxied to the API. Template:
`infra/nginx/stocktake.conf.template` (target host
`stocktake.starship.thebigbakes.com`). Set `STOCKTAKE_ACCESS_CODE` on the API and
build with the right `VITE_API_BASE` (or rely on the nginx `/api` proxy).
