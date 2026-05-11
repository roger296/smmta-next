# Uneek Clothing API — integration notes

Documentation: <https://api.uneekclothing.com/docs/index.html> (account required).

## Status

| Endpoint | Status | Notes |
|---|---|---|
| `GET /stockLevel/all` | ✅ verified 2026-05-11 | full-catalogue stock; no per-SKU filter; double-JSON-encoded body |
| `GET /productdata/all` | ✅ verified 2026-05-11 | full product catalogue (family + variants + prices + images); used by the importer |
| `POST /orders` (placement) | ⚠️ unverified | assumed shape; path may differ |
| `GET /orders/<ref>` (status) | ⚠️ unverified | |
| `POST /orders/<ref>/cancel` | ⚠️ unverified | |

When you next hit a real order endpoint with curl, share the request + response shape and we'll lock the rest of the connector down.

## Authentication

HTTP Basic auth. The `Authorization` header is `Basic <base64(user:password)>`.

The connector supports both encoding modes; pick which in the supplier row's `apiAuthScheme` column (or the admin SPA's Auth-scheme dropdown):

| `apiAuthScheme` | What the API-key field should hold | What the connector sends |
|---|---|---|
| `basic` | `<base64(user:password)>` (already encoded) | `Authorization: Basic <key-verbatim>` |
| `basic_credentials` | `user:password` (raw) | `Authorization: Basic <base64-encoded at request time>` |

`basic_credentials` is the friendlier option — the operator pastes the raw username:password and the connector encodes it. The encrypted-at-rest envelope still applies, so the raw plaintext is never persisted unencrypted.

For the live Uneek account on the Filament Store deploy, set:

- `connectorKind`: `UNEEK`
- `apiBaseUrl`: `https://api.uneekclothing.com/`
- `apiAuthScheme`: `basic_credentials`
- API key field: `roger@tbv-3pl.com:<password>`

## Endpoints

### `GET /stockLevel/all` — full catalogue stock

**Request:**

```
GET https://api.uneekclothing.com/stockLevel/all
Accept: application/json
Authorization: Basic <base64(user:password)>
```

No query string, no body.

**Response (verified):**

- `Content-Type: application/json`
- Body is **double-JSON-encoded**: the outer wrapper is a JSON string containing a JSON-encoded array. One `JSON.parse` returns a string; you have to parse it again to get the array. The connector's `parseJsonBody` helper does the two-pass parse.
- Each row:

  ```json
  {
    "ProductCode":   "X03WH2XL",
    "ProductName":   "UX3 - White - 2XL - UX Sweatshirt",
    "LiveStock":     1000.0,
    "StockIn7":      0.00,
    "StockIn30":     0.00,
    "StockDueDate":  null
  }
  ```

**Field mapping into our `SupplierStockSnapshot`:**

| Uneek field | Snapshot field | Notes |
|---|---|---|
| `ProductCode` | `supplierSku` | their identifier |
| `ProductName` | (ignored) | informational; not stored |
| `LiveStock` | `stockQty` | currently-available units |
| `StockIn7` | (not surfaced today) | inbound within 7 days — V2 candidate for "Available from supplier — ships in <7 days" copy |
| `StockIn30` | (not surfaced today) | inbound within 30 days |
| `StockDueDate` | (not surfaced today) | date of next delivery if known |
| — | `costGbp` | **always null from this endpoint**; comes from operator-entered `supplier_products.cost_gbp` |

**Quirks worth knowing:**

- **No filtering.** The endpoint returns the entire catalogue regardless of which SKUs you care about. The connector filters client-side. At a 3-hour polling cadence this is fine; if Uneek ever adds a per-SKU endpoint, switch the connector to that for efficiency.
- **No cost price.** This endpoint is stock-only. The system falls back to the operator-set `costGbp` on the mapping row, which is good enough for routing decisions. If Uneek exposes a per-product price endpoint later, add a second call in the connector and fill in `costGbp` properly.
- **Response is a string-of-array, not an array.** A naïve `await res.json()` returns a string; the connector's `parseJsonBody` detects the double-encoding and re-parses.

### `GET /productdata/all` — full product catalogue

**Request:**

```
GET https://api.uneekclothing.com/productdata/all
Accept: application/json
Authorization: Basic <base64(user:password)>
```

No query string, no body. Same auth as `/stockLevel/all`.

**Response (verified 2026-05-11):**

Same double-JSON-encoded shape as `/stockLevel/all` — the connector
re-uses `parseJsonBody`. Each row represents **one variant** (one
SKU); the family information is denormalised onto every row, so the
importer groups by `ProductCode` to recover the family-of-variants
structure.

**Verified field set:**

| Uneek field | Type | Used by importer for | Notes |
|---|---|---|---|
| `ProductCode` | string | `product_groups.slug` stem (`slugify(ProductCode)`) | family code, e.g. `UX8`, `X3` |
| `ProductName` | string | `product_groups.name` | family display name, e.g. `The UX Children's Hooded Sweatshirt` |
| `ShortCode` | string | `products.stock_code` + `products.slug` stem + `supplier_products.supplier_sku` | per-variant SKU, e.g. `X08HG7` |
| `Colour` | string | `products.colour` + `products.attributes.colour` | display name |
| `Hex` | string | `products.colour_hex` | normalised via `normaliseHex()` — some rows are literal `WHITE` / `NAVY` rather than `#RRGGBB`, mapped via a lookup table |
| `Size` | string | `products.attributes.size` | clothing size (`XS`–`5XL`) or age band (`7/8 YRS`) |
| `MyPrice` | number | `supplier_products.cost_gbp` | wholesale price, what we pay |
| `PriceSingle` | number | `products.min_selling_price` + `max_selling_price` | suggested retail |
| `Image` | string url | `products.hero_image_url` | full-res variant image |
| `SMColourImage` | string url | (hero fallback) | low-res swatch; used only if no `Image` |
| `FullDescription` | string | `products.long_description` | multi-paragraph marketing copy; sometimes French |
| `Specifications` | string | appended to `long_description` | sizing / care / spec table |
| `ShortDescription` | string | `products.short_description` | headline |
| `Category` | string | `product_groups.group_type` + `--category` filter target | e.g. `Jackets`, `Children's Hooded Sweatshirts` |

**Quirks worth knowing:**

- **No filtering.** Like `/stockLevel/all`, this returns the whole catalogue every time. The importer filters client-side.
- **`Hex` is messy.** Many rows have literal colour names. The importer's `normaliseHex()` maps the common ones (`WHITE` → `#FFFFFF`, `NAVY` → `#1F2A44`, `HEATHER GREY` → `#A6A6A6`, etc); anything unknown becomes `NULL` and the operator can fill it in via the admin SPA.
- **Variant identification.** `ProductCode` is the family code (shared across colour + size variants). `ShortCode` is the per-variant SKU and the value the stock endpoint expects.
- **Re-running is safe.** The importer upserts by `slug` (groups) and by `slug` (products); supplier_products is upserted by `(productId, supplierId)`. A second run with no upstream changes is a no-op apart from `updated_at` bumps. Products that vanished from Uneek's response are **not** deleted — the operator decides whether to un-publish manually.

**Importing:**

The connector helper is `UneekConnector.getProductCatalogue()`. The CLI is:

```bash
DATABASE_URL=... npm run import:uneek-products -w @smmta/api -- \
  --supplier=<suppliers.slug> [--category=Jackets] [--limit=N] [--dry-run] [--publish]
```

Always run `--dry-run` first to inspect the plan. See `apps/api/scripts/import-uneek-products.ts` for the full mapping logic.

### `POST /orders` — order placement (unverified)

Assumed request body:

```json
{
  "reference": "<our customer order number>",
  "shipping": {
    "name": "...",
    "addressLine1": "...",
    "city": "...",
    "postCode": "...",
    "country": "GB"
  },
  "lines": [{ "sku": "X03WH2XL", "quantity": 2 }]
}
```

Assumed response: `{ orderRef, status: "ACCEPTED" | "REJECTED", rejectionReason?, etaMinDays?, etaMaxDays? }`. **Field names need verifying** against the live API.

### `GET /orders/<ref>` and `POST /orders/<ref>/cancel`

Both unverified. The connector's shape is reasonable for a REST API but needs confirming once Roger has the order-side docs.

## Error mapping

| Upstream | Connector error | Worker policy |
|---|---|---|
| 401 / 403 | `SupplierAuthError` | Don't retry; alert ops; check the API key in admin |
| 4xx (other) | `SupplierBadRequestError` | Don't retry; bug to investigate |
| 5xx | `SupplierUpstreamError` | Retry with exponential backoff |
| Network / timeout | `SupplierUnreachableError` | Retry with exponential backoff |
| `status: "REJECTED"` body | `SupplierRejectedOrderError` | Don't retry; surface to ops |

## Verification checklist (run before declaring a deploy fully wired)

1. From the admin SPA: **Suppliers → Demo Uneek → Drop-ship tab** — set `connectorKind=UNEEK`, `apiBaseUrl=https://api.uneekclothing.com/`, `apiAuthScheme=basic_credentials`, paste `roger@tbv-3pl.com:<password>`.
2. Hit **Test connection** with a real Uneek SKU (e.g. `X03WH2XL`). Should return `stockQty=<a number>`, `costGbp=null`. If it returns an auth error, the credentials are wrong; if it returns "SKU not found", the SKU isn't in their catalogue.
3. Click **Poll now**. The poll-log row should show `productsChecked = N`, `productsUpdated = N` (assuming all your mapped SKUs are in Uneek's catalogue). Browse the supplier-products table to confirm `last_known_stock` populated.
4. Eyeball a supplier-fulfilled product in the Clothes Shop — `stockState` should be `AVAILABLE_FROM_SUPPLIER` if the SKU has `LiveStock > 0` and no warehouse stock.

## Last reviewed

2026-05-11 — stock endpoint verified live; order endpoints still pending.
