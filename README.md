# Auto-Stock (Big Bakes)

**Auto-Stock** is the Big Bakes stock-control system-of-record: multi-site stock on an auditable movement ledger, units of measure, recipes/BOM, automatic reordering, an iPad-first goods-in / stock-take PWA, a head-baker session-consumption form, daily COGS/wastage posting to **Xero**, and an MCP server exposing the model to Claude / Cowork. It is a Big-Bakes-owned **fork of [`smmta-next`](https://github.com/roger296/smmta-next)** (eTail Support's self-hosted TypeScript/PostgreSQL stock platform), kept separate from eTail Support's own deployments and configured for Big Bakes.

Single-tenant per deployment (one Big Bakes instance, one database). Built against the spec *Big Bakes Stock Control Proposal Specification v2* (sections A1–A12); see `DECISIONS.md` for divergences and `BUILD_LOG.md` for the build narrative.

The inherited customer-facing **storefront, marketplace connectors, Mollie payments and conversational (LLM) search are carried in the tree but kept dormant** — Auto-Stock is internal stock control only (sales flow through Square POS). See the "What's dormant" note in `CLAUDE.md`.

## Quick install (Ubuntu 22.04+ / Debian 12+)

On a fresh VPS with DNS pointing two hostnames at it (one for the storefront, one for the admin SPA):

```bash
git clone https://github.com/roger296/smmta-next /tmp/smmta-next
sudo bash /tmp/smmta-next/infra/install.sh
```

The script prompts for the business name, the two hostnames, an admin email + password, and a Let's Encrypt notification address; it then installs Docker, nginx, certbot, and Node 22 (via NVM); clones the repo into `/home/smmta/smmta-next`; brings up Postgres in Docker; runs migrations; creates the singleton company row, the first admin user, and the storefront API key; installs systemd units; configures nginx server blocks; and issues TLS certs.

For a non-interactive run (CI, automation):

```bash
sudo SMMTA_NONINTERACTIVE=1 \
     SMMTA_BUSINESS_NAME="Filament Store Ltd" \
     SMMTA_STORE_HOST=shop.example.com \
     SMMTA_ADMIN_HOST=admin.example.com \
     SMMTA_ADMIN_EMAIL=admin@example.com \
     SMMTA_ADMIN_PASSWORD='hunter2-not-this' \
     SMMTA_LE_EMAIL=admin@example.com \
     bash /tmp/smmta-next/infra/install.sh
```

Re-running on an installed VPS detects existing state and prompts before overwriting `.env` files. Pass `SMMTA_FORCE=1` to overwrite without prompting.

## Local dev

```bash
docker compose up -d postgres        # bring up Postgres
npm install                          # workspaces install
npm run db:migrate -w @smmta/api     # apply schema
npm run dev -w @smmta/api            # API on :8080
npm run dev -w @smmta/web            # admin SPA on :5173
# (apps/store / apps/store-clothes are dormant in this fork — not run or deployed)
```

> **Note on workspace scopes.** The npm workspaces keep their original
> `@smmta/*` names — renaming them is invasive and buys nothing (the deployed
> app's name is "Auto-Stock", set in `package.json` and the UI). So you still
> run `npm run … -w @smmta/api`.

See `CLAUDE.md` at the repo root for the full architecture, conventions, and contributor notes.

## Layout

```
apps/
  api/    Fastify + Drizzle + Postgres back end
  web/    Vite/React admin SPA
  store/  Next.js 15 storefront (Filament Store reference deploy)
packages/
  shared-types/  Types shared across apps
infra/
  install.sh           Single-shot VPS installer
  nginx/               Server-block templates
  systemd/             Service unit templates
docker/                Postgres init scripts
```

## License

Not yet assigned. The project intends a permissive licence (MIT or Apache-2.0) before the first external contributor lands; see `CLAUDE.md` follow-ups.
