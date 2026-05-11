# Storefront rebuild — recipe + gotchas

Both storefronts (`apps/store` = Filament Store on :4000, `apps/store-clothes` =
Clothes Shop on :5000) are Next.js 15 standalone builds running under systemd.
Every code change, env change, or content-changing dependency upgrade needs a
rebuild + service restart.

This runbook is the **canonical sequence** — work-arounds discovered during
the 2026-05-11 deploy are baked in here so we don't rediscover them.

## TL;DR — single-store rebuild

```bash
cd ~/smmta-next
git pull --ff-only

# Pick ONE: --supplier=store-clothes or --supplier=store
APP=store-clothes        # or "store" for the filament shop
PORT=5000                # 4000 for the filament shop

cd apps/$APP
rm -rf .next

# Env vars for the build — must be present so the build can pre-render
# (even though pages are now force-dynamic, build-time fetch cache still warms)
set -a; . ./.env; set +a
export NODE_ENV=production

npx next build 2>&1 | tail -10

# CRITICAL — standalone deploys need static/ + public/ + .env copied into the
# standalone tree. Without these you get unstyled pages, broken images, and
# auth failures.
cp -r .next/static .next/standalone/smmta-next/apps/$APP/.next/
cp -r public         .next/standalone/smmta-next/apps/$APP/

# .env survives the build only if you re-copy it now. Next.js sees this
# .env at runtime and its values override systemd's Environment= directives.
cp .env              .next/standalone/smmta-next/apps/$APP/.env

sudo systemctl restart smmta-$APP   # smmta-store or smmta-clothes-store
sudo systemctl status  smmta-$APP --no-pager | head -8

# Sanity: hit the local port
curl -sI http://localhost:$PORT/ | head -3
```

If the catalogue is showing data, you're done. If not, see Troubleshooting
below.

## API service notes (for completeness)

The API at `apps/api` is also deployed via systemd. **It runs the built
`dist/server.js` — NOT `tsx`.** Anyone touching the systemd unit must
preserve this:

```ini
ExecStart=/home/smmta/.nvm/versions/node/v22.22.2/bin/node /home/smmta/smmta-next/apps/api/dist/server.js
```

If the ExecStart ever reverts to `tsx`, the service will crash-loop because
the root `node_modules/.bin/tsx` symlink is brittle (gets wiped during
`--no-workspaces` workspace reinstalls).

The supplier-poll service (`smmta-supplier-poll`) *does* still use `tsx`.
That's fine because it runs interactively / via timer and a tsx crash is
not customer-facing. Make sure tsx is installed:

```bash
cd ~/smmta-next
npm install --include=dev -w @smmta/api
ls node_modules/.bin/tsx     # must exist
```

## Gotchas — every one of these has bitten us

### 1. `.env` files in the standalone tree get wiped by `next build`

Symptom: storefront returns 401 to every API call after a rebuild, even
though the systemd unit has the correct `SMMTA_API_KEY=...`.

Cause: Next.js auto-loads `.env` at runtime, and its values override
`process.env` set by systemd. The build wipes `apps/$APP/.next/standalone/.../.env`,
so the standalone server falls back to systemd's env — but if systemd's
env was set from a different key (or was rotated), the storefront sends
the wrong Bearer token.

Fix: always `cp .env .next/standalone/smmta-next/apps/$APP/.env` after
`next build`. This runbook's TL;DR does that.

### 2. Standalone tree at `.next/standalone/smmta-next/apps/$APP/` not `.next/standalone/$APP/`

When Next.js detects a monorepo parent (via the root `package.json`'s
`workspaces` field), it emits the standalone server at a path that
mirrors the source tree from the workspace root — including the
top-level repo dir name. So `server.js` lands at

```
.next/standalone/smmta-next/apps/store-clothes/server.js
```

not the more obvious

```
.next/standalone/apps/store-clothes/server.js
```

systemd `ExecStart` and `WorkingDirectory` directives must use the
**actual** path. Render the templates carefully — the install script
in `infra/scripts/` produces the right value.

If you ever need to find it manually:

```bash
find .next/standalone -name "server.js" -type f
```

### 3. `static/` + `public/` aren't auto-copied into the standalone tree

Symptom: page renders unstyled (no Tailwind), all images missing.

Cause: standalone output only includes the bare server runtime. The
static asset directories are emitted to `.next/static/` and `public/`
at the workspace root and must be manually copied into the standalone
tree.

Fix: every rebuild does

```bash
cp -r .next/static .next/standalone/smmta-next/apps/$APP/.next/
cp -r public         .next/standalone/smmta-next/apps/$APP/
```

### 4. PORT defaults to 3000, which collides with the API

Symptom: filament-store or clothes-shop fails to start with
`EADDRINUSE 0.0.0.0:3000`.

Cause: Next.js standalone reads `PORT` from env, defaulting to `3000`.
The API already binds `3000`.

Fix: set `PORT=4000` (filament) or `PORT=5000` (clothes) in the
`.env` AND/OR the systemd unit. The PORT in `.env` is enough for
runtime; pinning it in the systemd drop-in too is belt-and-braces.

### 5. `next/image` refuses unknown remote hosts

Symptom: product cards render blank squares where images should be.

Cause: `next.config.js` has a `remotePatterns` allow-list. Any image
host not on the list is rejected by next/image at request time.

Fix: add the host. Currently allowed:

- `app.etailsupport.com`
- `i.ebayimg.com`
- `picsum.photos` / `fastly.picsum.photos` (legacy)
- `images.uneekclothing.com`
- The API host (resolved from `SMMTA_API_BASE_URL` at build time)

### 6. ISR-cached static HTML doesn't reflect post-build data changes

Symptom: re-running the importer, restarting services, doing SQL data
edits — none of these surface on the storefront. The HTML stays
frozen.

Cause: pages with `export const revalidate = N` are statically
generated at build time and cached.

Fix: both home `/` and `/shop` use `export const dynamic = 'force-dynamic'`
since PR #43. Keep it that way. The API has its own cache headers; the
storefront should always render at request time.

### 7. Multi-store deploys: products leak across channels without explicit `product_channels` rows

Symptom: Uneek clothing appears in the Filament Store catalogue (or
vice versa).

Cause: empty `product_channels` for a product was originally treated
as "available on all channels". The catalogue service was fixed in
PR #44 — products with rows for OTHER channels are now correctly
filtered out — but only if **explicit rows exist**.

Fix: when running the importer for a single-channel deploy, always
pass `--channel=<slug>`:

```bash
npm run import:uneek-products -w @smmta/api -- \
  --supplier=demo-uneek --channel=clothes-shop --publish
```

The importer auto-inserts the `product_channels` row.

## Troubleshooting flowchart

```
Storefront page is empty / unstyled / 502?
│
├─ 502 from nginx?
│  └─ Check `sudo systemctl status smmta-$APP` — service crashed?
│     ├─ EADDRINUSE 3000?              → fix PORT in .env (gotcha #4)
│     ├─ Cannot find module 'server.js' → ExecStart path wrong (gotcha #2)
│     └─ Cannot find module 'tsx'      → API service hit gotcha; rebuild dist
│
├─ Page loads, no styles?
│  └─ Static assets missing from standalone (gotcha #3)
│
├─ Page loads, no catalogue (groups empty)?
│  ├─ Check API logs for 401s         → .env stale (gotcha #1)
│  ├─ API returns groups via curl     → standalone tree out of date; rebuild
│  └─ API also returns 0 groups       → channel decision bug (gotcha #7)
│
└─ Page loads, no images?
   └─ next.config.js remotePatterns missing the host (gotcha #5)
```

## Related

- `docs/VPS-SETUP-GUIDE.md` — full first-time install
- `docs/runbooks/store-cannot-reach-api.md` — when the storefront can't reach the API
- `docs/runbooks/stock-updates.md` — manual + automatic stock polls
- `infra/systemd/*.template` — systemd unit templates (rendered by the installer)
