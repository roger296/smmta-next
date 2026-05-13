# Ralawise bulk catalogue import — operator + maintainer notes

Companion doc to `seed-ralawise-catalogue.ts`. Covers the column-to-
schema mapping, what gets refreshed vs protected on re-import, the
operational knobs (markup, channel, publish), and the VPS deploy steps.

For the Ralawise API integration itself (auth, inventory, orders) see
`apps/api/src/integrations/suppliers/RALAWISE_API_NOTES.md`.

## What the script does

Reads Ralawise's `CustomerDataFull.csv` (~204 MB, 103k rows) in
streaming mode and upserts:

1. One `product_groups` row per Style Code (~4360 rows). Slug:
   `ralawise-<lowercase styleCode>`.
2. One `products` row per CSV row (one per SKU). Slug:
   `ralawise-<lowercase skuCode>`. The SKU lives on
   `products.stock_code` and `supplier_products.supplier_sku`.
3. One `supplier_products` row per `products` row, linked to the
   Ralawise supplier (slug `ralawise`).
4. One `product_channels` row per `products` row, scoping the
   product to the chosen channel (default: `clothes-shop`).

Filters out anything with `Sku Status != 'Live'` (~7144 discontinued
rows in the May 2026 export).

Re-running is idempotent: deterministic slugs + natural keys mean
every product upserts in place. See "Refresh vs protect" below for
which fields get clobbered vs kept.

## CSV column mapping

The CSV has 61 columns. Most are used; a few are deliberately dropped
for V1 because no obvious column on our schema fits.

### Used

| CSV column | Our field | Notes |
|---|---|---|
| 1 Sku Code | `products.stock_code` + `supplier_products.supplier_sku` + slug stem | the variant SKU |
| 3 Style Code | `product_groups.slug` stem | family key; slug = `ralawise-<lowercase>` |
| 6 Style Name | `product_groups.name`, prefix of `products.name` | |
| 8 Colour Name | `products.colour`, `products.attributes.colour`, part of `products.name` | |
| 9 Size Code | `products.attributes.size`, suffix of `products.name` | |
| 11 Specification | appended to `products.long_description` + `product_groups.long_description` under "### Specifications" | |
| 12 Retail Description | `products.short_description` + leading paragraph of `long_description` | marketing prose |
| 28 Product Type | (not yet) | available; no column on our `products` table for it |
| 35 Categorisation | `product_groups.group_type` | first pipe-segment only |
| 39 RGB | `products.colour_hex` | converted to `#RRGGBB` via `rgbToHex` |
| 46 Single Price | `supplier_products.cost_gbp` + drives `products.min_selling_price` (× markup) | the cost we pay |
| 50 Sku Status | filter — only `Live` rows imported | |
| 51 Primary Product Image URL | `product_groups.hero_image_url`; fallback for `products.hero_image_url` | |
| 53 Primary Image Licence Expiry Date | `products.image_licence_expires_at` | parsed via `parseLicenceExpiry` |
| 54 Colour Image | `products.hero_image_url` (preferred) | variant-specific image |

### Currently dropped

The CSV carries enrichment fields we don't have a home for yet. Re-
consider when adding columns or building a more elaborate PDP:

- Manufacturer Style Code (col 4) — same as Style Code in ~all cases
- Brand (col 5) — numeric ID, no name; would need a brand lookup
- Product Feature 1/2/3 (cols 13-15) — short bullet copy; mostly empty
- Size Range, Sizing To Fit, Size Exclusions (cols 16-18) — size-guide
  content; deferred to a future "size guide" surface
- Washing Instructions (col 19) — could go in description but adds noise
- Jacket Length, Leg Length (cols 20-21) — garment-specific
- Bag Capacity, Print Area, Embroidery Information, Bag Dimensions (cols 23-27) — niche
- Gender, Age Group (cols 29-30) — useful for filtering; no column yet
- Accreditations, Tag, Sustainable/Organic, Plus Sizes (cols 31-34) — useful
- Primary Colour, Colour Shade, Pantone, CMYK (cols 36-37, 38, 40) — RGB only is used
- Carton/Pack/Carton quantities + prices (cols 41-45) — bulk-pricing tiers
- Commodity Code (col 47) — HS code; could go on `products.hs_code`
- Item Weight in KG (col 48) — could populate `products.weight`
- Country of Origin (col 49) — could populate `products.country_of_origin`
- New SKU / New Product / New Colour flags (cols 56-58)
- Size Guide, Spec Sheet URLs (cols 59-60)
- EAN Code (col 61) — often "Not available"; could populate `products.ean`

Several of these (`weight`, `country_of_origin`, `hs_code`, `ean`)
have direct matches in our schema and would be low-risk additions if
needed. Out of scope for V1 to keep this PR focused.

## Pricing — markup

CSV's `Single Price` is what we pay Ralawise per unit. Customer-facing
retail isn't in the CSV, so we derive it as `cost × markup`.

- Default markup: **2.0×** (cost × 2). A £21.25 cost becomes £42.50 retail.
- Configurable per-run via `--markup=<x.y>` flag or the
  `RALAWISE_DEFAULT_MARKUP` env var.
- Rounded to 2 decimals (no `.99` snap; keeping it simple).
- Stored as the same value on both `products.min_selling_price` and
  `products.max_selling_price` — the storefront uses these as the
  "from / to" price-range bounds for the catalogue card.
- The base retail price lives on `products` (and so changes on every
  re-run if markup changes). The `product_channels.price_override_gbp`
  column is NOT touched by the importer — admin-side price overrides
  stay sacred. If an operator has set a custom price for a product on
  a particular channel via the admin SPA, re-running the importer
  won't clobber it.

## Channels

By default every imported product is pinned to the `clothes-shop`
channel via a `product_channels` row with `is_offered=true`. This:

1. Makes products visible on the Clothes Shop storefront (where the
   Clothes Shop's API key is bound to that channel).
2. Hides them from the Filament Store and any other channels — per
   PR #44's channel scoping logic.

Override with `--channel=<slug>` for a different storefront, or
`--channel=` (empty value) to skip the channel rows entirely.

Re-runs only INSERT missing rows. Existing `product_channels` rows
are left untouched so admin edits (custom price, `is_offered=false`
to hide a specific product on a channel) survive.

## Publishing

By default new products + groups are inserted with `is_published=false`
so customers don't see anything until the operator has curated. The
admin SPA's product list lets you bulk-publish.

Pass `--publish` to mark new rows AND refresh existing rows as
`is_published=true` on every run. Useful for the initial import.

## Refresh vs protect on re-import

| Field | Refreshed on every run? | Notes |
|---|---|---|
| `product_groups.name` | yes | from Style Name |
| `product_groups.description` / `short_description` / `long_description` | yes | regenerated from Specification + Retail Description |
| `product_groups.hero_image_url` | yes | from Primary Product Image URL |
| `product_groups.group_type` | yes | first pipe-segment of Categorisation |
| `product_groups.attribute_axes` | yes | always `['size', 'colour']` |
| `product_groups.is_published` | only with `--publish` | otherwise preserved |
| `products.name` | yes | regenerated as `Style · Colour · Size` |
| `products.colour` / `colour_hex` | yes | |
| `products.hero_image_url` | yes | colour image preferred over primary |
| `products.min/max_selling_price` | yes | cost × markup |
| `products.expected_next_cost` | yes | from Single Price |
| `products.attributes` | yes | regenerated `{size, colour}` |
| `products.image_licence_expires_at` | yes | from CSV col 53 |
| `products.is_published` | only with `--publish` | otherwise preserved |
| `products.stock_code` | yes | matches the CSV SKU |
| `supplier_products.supplier_sku` | yes | matches the CSV SKU |
| `supplier_products.cost_gbp` | yes | from Single Price |
| `supplier_products.is_active` | always set to `true` | re-activates if previously disabled |
| `product_channels.price_override_gbp` | **never** | admin edit preserved |
| `product_channels.is_offered` | **only for new rows (true)** | existing rows untouched |

## Performance

Target: full 103k-row import in **<30 minutes** on a modern VPS.

Strategies:

- Streaming CSV parse (`csv-parse` in async-iterator mode). Memory
  stays <100 MB regardless of file size.
- Batched DB transactions (~1000 rows per commit). Each transaction
  upserts a contiguous block of style groups together so each
  transaction sees complete style families.
- Single writer (no parallel fan-out). Postgres handles the load
  comfortably at this scale; parallel writers would just introduce
  serialization-failure complexity.
- Drizzle's standard `select` / `update` / `insert` — no raw SQL
  needed. If profiling shows the per-row update is the bottleneck on
  re-runs, look at `INSERT ... ON CONFLICT DO UPDATE` via raw SQL.

The progress callback prints a status line every 5000 rows so the
operator knows it's still alive.

## Error handling per row

- Empty / malformed rows (missing SKU or Style Code) → counted in
  `rowsSkippedMalformed` with the first 10 reasons captured for the
  summary. Import continues.
- Unparseable price → `cost_gbp` and `min_selling_price` land as
  `null`. Row imports successfully; admin can set a price by hand.
- Discontinued SKUs (`Sku Status != 'Live'`) → counted in
  `rowsSkippedDiscontinued`, skipped.
- DB error mid-batch → transaction rolls back; the script exits
  non-zero. The next run resumes from scratch (all upserts are
  idempotent, so previously-committed batches survive).

## VPS deployment

1. **Get the CSV onto the VPS.**

   ```bash
   # On your dev box (where you have the file)
   scp ~/.tmp.Ralawise/CustomerDataFull.csv \
     smmta@striped-acrobats.metalseed.io:.tmp.Ralawise/
   ```

   Verify it landed:

   ```bash
   ssh smmta@striped-acrobats.metalseed.io
   ls -lh .tmp.Ralawise/CustomerDataFull.csv
   # Expect ~200 MB.
   ```

2. **Make sure `tsx` is installed in the api workspace** (same as the
   stock-poll runbook). Necessary if it's not been done yet.

   ```bash
   cd ~/smmta-next
   npm install --include=dev -w @smmta/api
   ```

3. **Make sure the Ralawise supplier is bootstrapped (§G):**

   ```bash
   psql "$DATABASE_URL" -c "SELECT id, slug, is_dropship_active FROM suppliers WHERE slug = 'ralawise';"
   # Should return one row. If empty, run bootstrap-ralawise-supplier.ts first.
   ```

4. **Run the migration so the new column exists:**

   ```bash
   cd ~/smmta-next
   set -a; . ./apps/api/.env; set +a
   npm run db:migrate -w @smmta/api
   ```

5. **Dry-run first:**

   ```bash
   npm run seed:ralawise-catalogue -w @smmta/api -- \
     --csv-path=/home/smmta/.tmp.Ralawise/CustomerDataFull.csv \
     --limit=100 \
     --dry-run
   ```

   Confirms the parse + filter + path resolution all work. Should
   complete in seconds.

6. **Real run, full catalogue:**

   ```bash
   npm run seed:ralawise-catalogue -w @smmta/api -- \
     --csv-path=/home/smmta/.tmp.Ralawise/CustomerDataFull.csv \
     --publish
   ```

   Expect 15-30 min depending on Postgres I/O. Progress prints every
   5000 rows.

7. **Trigger the polling worker to populate stock counts** for the
   imported Ralawise SKUs (see `docs/runbooks/stock-updates.md`).

8. **Spot-check:**

   - Pick a few SKUs from the storefront → they should render with
     the Ralawise image and the markup-derived retail price.
   - `psql "$DATABASE_URL" -c "SELECT count(*) FROM supplier_products sp JOIN suppliers s ON s.id = sp.supplier_id WHERE s.slug = 'ralawise';"`
     → ~96k.

## CSV file location convention

- **Dev box (Windows):** `K:\smmta-next\.tmp.Ralawise\CustomerDataFull.csv`
- **VPS:** `/home/smmta/.tmp.Ralawise/CustomerDataFull.csv`
- **Override:** `--csv-path=/abs/path` flag, or `RALAWISE_CSV_PATH` env var.

The file is gitignored (`.tmp.*` rule covers it). Do not commit.

## Follow-ups

- **Image licence expiry monitor.** Scheduled task that flags products
  whose `image_licence_expires_at` is within N days. Surface in admin
  SPA. Without this, image URLs may quietly stop working when Ralawise
  renews / rotates assets.
- **Self-hosted image mirror.** Pull images from cdn.pimber.ly into
  our own S3 / CDN at import time. Decouples us from Ralawise CDN
  uptime + licence rotation. Adds storage cost (~100 GB for 100k
  images) and import time, so V2 only.
- **Per-category markup.** A `Product Type` → markup table instead of
  a single global markup (e.g. headwear at 2.5×, jackets at 1.8×). One
  function call away from the current logic.
- **Periodic catalogue refresh.** A scheduled task that re-pulls the
  CSV weekly and runs the importer in `--update-only` mode.
- **Catalogue diff tool.** Before each refresh, show the operator a
  summary of changes (price moves > 5%, products added, products
  discontinued) so they can review before applying.

## Last reviewed

2026-05-13 — initial bulk import shipped; verified on fixture data,
pending operator's first full-catalogue run on the VPS.
