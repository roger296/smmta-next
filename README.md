# smmta-next

Open-source stock control, order management, and product management platform with a customer-facing web store module. Single-tenant per deployment — clone the repo, run your own instance on your own VPS.

The reference deployment is **Filament Store** (`filament.shop.cleverdeals.net`), selling 3D printer filament. The storefront module is intended to be re-skinned and re-deployed for other brands the same business runs.

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
npm run dev -w @smmta/store          # storefront on :3000
npm run dev -w @smmta/web            # admin SPA on :5173
```

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
