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

## Prompt 15 (follow-up #3) — CI must build shared-types before the API

- Added `npm run build -w @smmta/shared-types` to `.github/workflows/e2e.yml` immediately before the `Build apps/api` step. `apps/api` imports from `@smmta/shared-types`, which is a workspace package whose `package.json` declares `main: ./dist/index.js` and `types: ./dist/index.d.ts` — and those files only exist after that package's own `tsc` runs. Without this step, the API's tsc fails with `Cannot find package '@smmta/shared-types/dist/index.js'` and the workflow stops before the API can boot. Locally `npm run build` from the root works because Turbo orchestrates dependency order; CI builds workspaces individually so it has to be explicit.

## Prompt 15 (follow-up #4) — decouple storefront build from API

- The previous CI patch cleared the API build issue, which exposed the next failure point: `next build` was running `generateStaticParams` on `/shop/[groupSlug]/page.tsx`, fetching the seeded slug from the API, and then prerendering the page for that slug — and the page's own render path re-threw any non-404 error from `getGroupBySlug`. A single transient API failure during prerender therefore took down the whole build.
- Made `generateStaticParams` opt-in via `STOREFRONT_PRERENDER=1` (default off) so the build no longer fetches the API at build time. The page is still RSC with `revalidate = 60`, so it server-renders on first request and is cached after — same end-to-end UX, no build-time coupling.
- Made the group page's render-path catch return `notFound()` during the build phase (`NEXT_PHASE === 'phase-production-build'`) so that — even if a future config does opt back into prerender — a transient API hiccup downgrades to a 404 in the prerendered HTML rather than killing the whole build. Runtime rendering still re-throws so real failures are visible to the user and to error tracking.

## Prompt 15 (follow-up #5) — group route must be runtime-dynamic, not empty-statically-generated

- Patch 0005 returned `[]` from `generateStaticParams` thinking that would skip prerendering and let the route fall back to runtime SSR. In Next.js App Router with `output: 'standalone'`, that's wrong — an empty `generateStaticParams` is read as "the exhaustive list of valid slugs is empty", and the standalone runtime then answers every request to `/shop/[groupSlug]` with `Error: Internal: NoFallbackError`. The CI store.log made this obvious: every page request emitted that exact error, the PDP never rendered, the Add-to-Cart button never appeared, the e2e tests hit their 60 s locator timeout.
- Removed `generateStaticParams` entirely. With it gone, App Router treats the route as fully dynamic and the standalone runtime serves it on demand for any slug.
- Added `export const dynamic = 'force-dynamic'` and `export const dynamicParams = true` belt-and-braces so a future config refactor can't accidentally re-introduce the same footgun. `revalidate = 60` stays — `force-dynamic` removes static generation but the data layer's per-fetch cache still respects the revalidate window.
- Removed the `NEXT_PHASE === 'phase-production-build'` notFound() shim from patch 0005 — defensive against a path that no longer exists, and was suppressing real errors.
- Side note: this means the route is no longer pre-rendered at build time. For a 12-product catalogue this is fine (first-hit SSR ~150 ms, then cached for 60 s); the SEO is identical (search engines see fully-rendered HTML either way). When we want pre-rendering back in a stable env, the right answer is a *non-empty* `generateStaticParams` against a known-up API, not the env-gated empty version 0005 introduced.

## Prompt 15 (follow-up #6) — checkout form name attributes + terms tick in tests

- Patch 0006 unblocked the PDP, the test reached the checkout page, and the next failure surfaced on `page.fill('input[name="firstName"]', ...)`. Cause: `CheckoutForm` uses a `Field` helper that only renders an `id` on the `<input>`, not a `name`. The e2e tests target inputs by `name`, so every `page.fill('input[name="…"]', …)` resolved to nothing and timed out.
- Added an optional `name?: string` prop to `Field` and threaded `name="…"` through every call site (firstName, lastName, email, phone, line1, line2, city, region, postCode, country, plus the `billing-…` variants for the separate-billing branch). The input's `name` defaults to its `id` if no name is passed, so native form-submission semantics keep working everywhere else.
- Added `name="termsAccepted"` to the terms checkbox so it matches the same naming pattern.
- Updated both e2e spec files to `page.check('input[name="termsAccepted"]')` before the Pay click — the form's `onSubmit` early-returns when `termsAccepted === false`, which would otherwise leave the URL wait hanging and produce the "next layer" failure on the run after this one. Same fix lands in all three call-sites (one in happy-path, two in sad-paths).
