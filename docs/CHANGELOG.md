# Changelog

Non-trivial bugs found and fixed during the storefront prompt sequence
(see `buldmeawebstore.md` in the project workspace). Trivia (typos, missing
imports, lint nits) is omitted.

## Prompt 1 — extend product schema for groups and storefront content

- Fixed pre-existing referenced-but-not-installed `pino-pretty` (transport target in `apps/api/src/app.ts`). Added it as an `apps/api` devDependency so the dev server boots and tests that build the Fastify app run.
- Caught early during Prompt 1 testing: the seed script's CLI-entry guard used `import.meta.url.includes('seed-storefront')` which is always true (the filename is in the URL). When the test imported `seedStorefront`, the CLI block ran, closed the DB pool, and left subsequent test calls with an ended pool. Replaced with a strict `fileURLToPath(import.meta.url) === process.argv[1]` check.

## Prompt 15 — end-to-end Playwright + concurrency hardening

- Fixed e2e Add-to-Cart selector — was matching `button[type="submit"]` against a `type="button"` element, which timed out at 60 s and obscured the real shape of the component. Switched the three call-sites in `apps/store/e2e/checkout-happy-path.spec.ts` and `apps/store/e2e/checkout-sad-paths.spec.ts` to `page.getByRole('button', { name: /^add to cart$/i })`. Also surfaced a second latent bug while doing so: the previous tests asserted `page.toHaveURL(/\/cart/)` immediately after the click, but the Add-to-Cart button does a `fetch('/api/cart')` and toggles its label to "Added ✓" — it never navigates. Tests now wait for the success label and drive the navigation explicitly with `page.goto('/cart')`. Added a unit regression test `apps/store/components/add-to-cart-button.test.tsx` to lock the component contract (role + accessible name + `type="button"`) so a future refactor can't put the original mistake back in.

## Prompt 15 (follow-up) — seed must populate stock_items

- Fixed the storefront seed (`apps/api/scripts/seed-storefront.ts`) to create a demo warehouse and 50 IN_STOCK `stock_items` rows per SKU (3 variants + 1 standalone = 200 units total). Without this, every variant's `available_qty` was 0, the PDP rendered the disabled "Notify me" button instead of "Add to cart", and the e2e tests timed out at 60 s waiting for a button that the component never showed. Surfaced as the second-order bug after the Prompt 15 selector fix landed and let the test reach the next failure point. Also extends the seed's wipe to delete `stock_items` (FK) and `warehouses` so the script remains idempotent.

## Prompt 15 (follow-up #2) — CI infra: build the API, boot the storefront standalone

- Fixed two CI-only bugs that hid the previous patches' effects:

  1. **The API never started.** The "Boot apps/api" step ran `npm run start -w @smmta/api`, which executes `node dist/server.js` — but the workflow had no preceding `npm run build -w @smmta/api`, so `dist/` didn't exist and the API process exited in milliseconds. Every storefront → API call therefore got a connection refused; the e2e tests reached the PDP but the page had no data and rendered without the SwatchPicker / Add-to-Cart button. Added a "Build apps/api" step before the boot step, plus a fail-fast assertion that dumps `/tmp/api.log` if `/health` doesn't come up within 20 s.
  2. **The storefront started in degraded mode.** `apps/store/package.json`'s `start` script was `next start -p 3000`, but `next.config.js` declares `output: 'standalone'`. Next.js prints `"next start" does not work with "output: standalone" configuration` and dynamic routes throw `NoFallbackError` at request time — so `/shop/[groupSlug]` returned an internal error instead of the rendered group page. Switched the CI boot to `node apps/store/.next/standalone/apps/store/server.js` (the same launcher Prompt 14's production systemd unit uses), with the documented manual copy of `.next/static` and `public/` into the standalone bundle.

  Together, these two unblock the e2e suite — the previous selector and seed-stock fixes both stop being hidden.
