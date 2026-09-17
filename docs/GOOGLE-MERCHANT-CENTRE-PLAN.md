# Google Merchant Centre — plan for the Filament Store and Clothes Shop

Status: proposed, 2026-09-17. Owner: Roger (accounts, policies) + Claude (code).

Goal: every sellable product from both shops listed on Google Shopping's free
listings, with prices, stock and delivery that match the sites exactly.

## Decisions taken (Roger, 2026-09-17)

| Decision | Choice |
|---|---|
| Catalogue scope | Push **everything** from day one — both shops, all suppliers |
| Accounts | **One** Merchant Centre account, both shops as separate stores in it |
| Uneek barcodes | Take them from Uneek's product-data CSV (see "Uneek barcodes" below) |
| Ads | **Free listings first.** At 1.35× markup, paid Shopping ads would likely cost more than the margin |

## What we already have

- A page per variant on both shops (`/shop/p/<slug>`), indexable, with its own price and stock.
- Prices include VAT, which is what Google expects for the UK.
- Colour, size, gender and age group per variant; the range gives the grouping id.
- Live stock states (in stock / available from supplier / out of stock).
- Delivery charge per supplier parcel: £7.00 warehouse, £8.50 Uneek, £10.50 Ralawise.
- `products.ean` and `products.weight` columns already exist, unused.

## Supplier data checked (2026-09-17)

| | Rows | Barcodes (EAN) | Brand | Other |
|---|---|---|---|---|
| Uneek (`TBV02-UneekProdData.csv`) | 7,068 | 7,060 unique 13-digit | "Uneek Clothing" | Weights, country of origin, commodity code. Matches our SKU on "Short Code" |
| Ralawise (`CustomerDataFull.csv`) | 103,518 | 103,518 | 90 brands (AWDis, Ecologie, …) | 103,460 manufacturer part numbers, weights, image licence expiry |

So virtually every clothing item can carry the brand + barcode Google requires for
apparel. Filament is the exception (see risks).

## The gap

Both importers throw away the barcode, brand, manufacturer part number and weight.
Nothing else is missing.

## Phases

### Phase 1 — Fill the data gaps (Claude, ~half a day)

- Add a `brand` column to products; store brand, EAN, manufacturer part number and
  weight in both importers; keep Ralawise's image licence expiry per item.
- Re-run both imports (they upsert, so nothing is lost).
- Verify: how many published products end up with brand + barcode, per shop.

### Phase 2 — Account and policies (Roger, ~1 hour)

- One Merchant Centre account; add both shops.
- Verify and claim `filament.cleverdeals.net` and `clothes.cleverdeals.net` through
  Search Console.
- Business details, VAT settings, delivery settings, returns policy — these must match
  `/legal/returns` and `/legal/terms` on each shop, which are still awaiting your review.

### Phase 3 — The product feed (Claude, ~1 day)

A nightly job writes one feed file per shop; Google fetches each daily over HTTPS.

Per item: title, description, link, image, price (inc VAT), availability, brand,
barcode, manufacturer part number, condition, colour, size, gender, age group,
`item_group_id` (the range), and **per-item delivery** using that product's supplier
charge. Our categories map to Google's product categories.

Left out rather than submitted and rejected: no image, no price, no barcode and no
part number, or an expired Ralawise image licence.

### Phase 4 — Keeping prices and stock honest (Claude, ~half a day)

Google suspends accounts whose feed disagrees with the site. A second, small feed
updates only price and availability, hourly. This matters because a full Ralawise
stock sweep takes about 7 hours, so the nightly file is stale by the time it's read.

### Phase 5 — Go live and clean up disapprovals (both, ongoing)

Submit, then work through whatever Google rejects — usually missing sizes, images it
can't fetch, or descriptions it doesn't like. Recheck after 3 days and after 2 weeks.

## Risks and open questions

- **Uneek barcodes aren't in their API.** Their API product feed has no EAN field, so
  a nightly refresh can't keep barcodes current from it. Short term: load them once
  from the CSV. Ask Uneek to add EAN to the API (one for this week's call).
- **Filament identifiers.** Filament spools may have no barcode or part number. Where a
  product genuinely has no identifier, the feed says so explicitly; Google accepts that
  but ranks those items lower.
- **Scale.** ~110,000 items in one account. Merchant Centre handles catalogues this
  size, but I have not confirmed the per-account item limit on a new account — worth
  watching after the first fetch.
- **Image rights.** Ralawise images carry a licence expiry date. Expired items are
  excluded from the feed, not just from the site.
- **Delivery promises.** The shops say "order by 2pm and it ships the same day", which
  Google shows as a delivery estimate. Uneek's order is currently held for credit
  control, so that promise isn't safe for Uneek items until that's resolved.
- **Margin.** A £6.14 polo with £8.50 delivery leaves very little; free listings cost
  nothing, but any paid Shopping campaign would need a higher markup to make sense.

## What Claude needs from Roger

1. Merchant Centre account created, both shops verified in Search Console.
2. The Uneek CSV kept somewhere the server can read (or Uneek adding EAN to the API).
3. Legal pages (returns, terms) reviewed, since Google checks them against the policies
   you enter.
