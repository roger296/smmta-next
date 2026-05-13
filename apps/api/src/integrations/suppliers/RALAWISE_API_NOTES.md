# Ralawise API — integration notes

Documentation: `Ralawise-API-Reference-Documentation-v1.0.1` (the vendor
.docx, kept in `.tmp.Ralawise/` — gitignored). Postman collection lives
in the same folder.

## Status

| Endpoint | Status | Notes |
|---|---|---|
| `POST /v1/login` | ✅ documented; live-verified during bootstrap | 20-minute JWT; `{access_token, expires_in: 1199}` |
| `GET /v1/inventory/<identifier>` | ✅ documented | same endpoint, three levels — variant SKU / colour / group |
| `POST /v1/order` | ✅ documented | enriched response with carton/pack/single price breaks |
| Order status read | ❌ not documented in v1.0.1 | connector returns `UNKNOWN` |
| Order cancel | ❌ not documented in v1.0.1 | connector returns `{ok: false}` with a pointer to ecommerce@ralawise.com |

If Ralawise adds status / cancel endpoints, wire them into
`ralawise.connector.ts` — both methods are stubbed out, not throwing.

## Base URL

```
https://api.ralawise.com/v1
```

Stored on `suppliers.apiBaseUrl` **including the `/v1` segment**. The
connector's `ENDPOINTS` constants are paths relative to that
(`/login`, `/inventory`, `/order`) — don't add `v1` to those or it
double-prefixes.

## Authentication

JWT bearer with a two-step login:

1. `POST /v1/login` body `{user, password}` returns
   `{access_token, token_type: "bearer", expires_in: 1199}`.
2. Subsequent calls send `Authorization: Bearer <access_token>`.

The token TTL is 20 minutes (1199 seconds). The connector handles the
lifecycle internally:

- First call: login + cache `{token, expiresAt}` in memory on the
  connector instance.
- Within 60 s of expiry: refresh proactively before issuing the real
  request (one-minute safety buffer in `TOKEN_REFRESH_BUFFER_MS`).
- 401 mid-request: drop the cache, re-login, retry once. If the retry
  still 401s, throw `SupplierAuthError` — credentials are wrong.
- Concurrent calls: an inflight login promise is shared so multiple
  in-flight requests don't each issue their own login.

The cache is per-connector-instance. The registry caches the connector
itself by supplier id, so for a long-running worker (polling, placer)
a single instance survives many calls and the cache stays warm.

## Credentials storage

`suppliers.apiKeyEnc` is a single varchar — there's no `credentials`
JSONB column. For Ralawise the convention is:

```
apiKeyEnc = encrypt(JSON.stringify({user: "...", password: "..."}))
```

The connector's `parseCredentials()` decodes + validates on
construction; missing or empty user/password throws `SupplierAuthError`
with a clear message.

If a third supplier with weird multi-field auth comes along, refactor
to a typed `suppliers.credentials JSONB` column. Until then the JSON-
in-apiKeyEnc trick keeps the schema flat.

`apiAuthScheme` is set to the descriptive string `bearer-with-login`
for the Ralawise row. The connector ignores this field (it knows it
needs to login first) — the value exists so the admin SPA can show
operators which auth flow a given supplier uses.

## Rate limiting

> API access is limited to 10 requests per 60 second period per
> authenticated user account. The rate limit is enforced on a rolling
> basis and applies across all API services, including Authentication,
> Inventory and Order APIs.

Per the v1.0.1 docs. 429 (Too Many Requests) is returned when
exceeded. The connector maps 429 to `SupplierUpstreamError` (which the
polling worker treats as retryable with exponential backoff), not to
`SupplierBadRequestError` (which would be terminal).

Implications for the polling worker: at 10 req/min per user, polling
the full catalogue per-SKU isn't realistic for thousands of SKUs.
Strategies:

1. **Group-level batching.** GET `/v1/inventory/<groupCode>` (5-char
   prefix) returns every variant in the group. For a catalogue where
   most groups have multiple colour/size variants, batching by group
   cuts the request count dramatically. Connector V1 doesn't do this;
   add it as a follow-up if rate-limiting becomes a real constraint.
2. **Longer poll cadence.** Default `pollIntervalMinutes = 180` (3 h)
   gives 480 requests per day per supplier — comfortable margin under
   the 60-second window provided we don't burst.
3. **Spread polls across time.** The polling worker iterates suppliers
   sequentially and respects `pollIntervalMinutes` per row, so
   Ralawise and Uneek don't fire at the same moment.

## Inventory: three-level endpoint

`GET /v1/inventory/<identifier>` accepts:

| Identifier shape | Length | Returns |
|---|---|---|
| Variant SKU (`GD001BLACS`) | ~10 chars | one variant |
| Product code (`GD001BLAC`) | ~9 chars (group+colour) | all sizes for that colour |
| Group code (`GD001`) | ~5 chars | all colours, all sizes |

Response is always a `productGroup` containing `products[]` each
containing `variants[]`. The connector flattens to a list of variants
via `flattenInventoryVariants` and picks the SKU-exact-match variant
out of the result (or the first variant if no exact match — handles
the variant-only response shape).

Example single-variant response:

```json
{
  "productGroup": {
    "id": "GD001",
    "name": "Softstyle® adult ringspun t-shirt",
    "products": [{
      "productCode": "GD001BLAC",
      "colourCode": "BLAC",
      "colourDescription": "black",
      "variants": [{
        "sku": "GD001BLACL",
        "sizeCode": "L",
        "sizeDescription": "Large",
        "packageUnit": {"carton": 72, "pack": 12, "single": 1},
        "availableStock": {"quantity": 782},
        "supplierStock": {"quantity": 21600, "leadTime": "+5 days"}
      }]
    }]
  }
}
```

**No price in the inventory response.** The cost we pay Ralawise per
unit is only available via the bulk-catalogue CSV (§H) or via the
order-confirmation response. The connector's `getStockAndPrice()`
therefore always returns `costGbp: null`; the polling worker falls
back to the operator-entered `supplier_products.cost_gbp` for the
pricing-decision path.

### "Not found" semantics

The docs document 404 (Bad Request: "the product group, product or
variant requested was not found") **and** a 200 response with an
information-level `Messages` entry of `errorCode: NotFound`. Real-
world behaviour seems to favour 404 for missing identifiers; the
connector handles both:

- HTTP 404 → returned `{stockQty: null, costGbp: null}` via
  `getStockForSku` (the bad-request error is caught and converted).
- HTTP 200 + `Messages[].errorCode = NotFound` → same.

The polling worker uses these null fields as the signal to log
`sku_not_found` on the `supplier_products.last_poll_error` column.

## Orders

`POST /v1/order` with the body documented in `Ralawise Customer API`
Section 4. Our connector:

- Hard-codes `plainCover: true` (customers don't see Ralawise on the
  package) and `autoBackOrder: false` (no silent queuing) per spec §10
  and the multi-supplier brief.
- Hard-codes `deliveryMethod: 'UKMAIN-UKNBD'` (UK Mainland, Standard
  Delivery — 1-2 day dispatch). Surface as a configurable per-supplier
  field if we ever need EU / collection / pre-12 options.
- Takes the `customerOrderRef` verbatim from our `SupplierOrderRequest`
  and writes it to `orderReference` (truncated to 20 chars per their
  schema limit).
- Writes our `idempotencyKey` to `orderLineRef` per line (truncated to
  15 chars). Ralawise has no order-level idempotency endpoint; our
  `supplier_orders` table has a unique index on the idempotency key
  so the placer worker never double-places.

### `orderReference: "APITEST"` for tests

> Please ensure that any test orders use a reference of APITEST
> otherwise these will be imported as live orders and dispatched.
> — Ralawise tech support email

The connector **does not** auto-set APITEST based on `NODE_ENV`.
Production correctness wins: a misconfigured `NODE_ENV` in production
would silently lose every customer order if the connector were
auto-injecting test references. Instead:

- Manual smoke tests / dev: set `req.customerOrderRef = 'APITEST'`
  explicitly when calling `placeOrder`.
- Production: pass the real customer order reference, which the
  storefront generates.

Look in the test suite for the explicit `'APITEST'` literal — that's
the marker the test placed a non-fulfilment order.

### Successful response shape

201 (Accepted) with an enriched body:

```json
{
  "order": {
    "orderNumber": "20368068",
    "orderReference": "MyOrderRef",
    "createdDate": "2021-05-05T11:23:12",
    "lineItems": [
      {"sku": "GD057INBLS", "quantity": 96, "quantityBreak": "CTN", "unitPrice": 7.35, "linePrice": 705.60, ...},
      {"sku": "GD057INBLS", "quantity": 4,  "quantityBreak": "SIN", "unitPrice": 8.15, "linePrice": 32.60, ...}
    ],
    "totals": {"subTotal": 738.20, "vat": 169.79, "total": 907.99, ...}
  },
  "messages": []
}
```

Note: a single requested line item can split into multiple response
line items because Ralawise charges different unit prices at the
carton / pack / single price break. We store the entire response in
`supplier_orders.response_payload` for the audit trail; the rolled-up
`totals.total` is the customer-side number that matters.

### Information vs error messages

Ralawise's response model has a `messages` array at the order-response
level. Messages have a `level` field:

- `level: "information"` (200 range) — order accepted, but with
  caveats. Examples documented in v1.0.1: `SkuNotFound` (a line
  referenced an unknown SKU; the order proceeds without that line),
  `UnableToAllocateSku` (autoBackOrder=false + insufficient stock; the
  line `quantity` is adjusted to the allocated amount).
- `level: "error"` (non-200 range) — order rejected.

The connector treats information messages as ACCEPTED and bubbles them
up via the `raw` field; error-level messages throw
`SupplierRejectedOrderError`.

## Error mapping

| Upstream | Connector error | Worker policy |
|---|---|---|
| 401 / 403 | `SupplierAuthError` | Don't retry; alert ops |
| 404 from /inventory | swallowed → `{stockQty: null}` | not an error; polling worker logs `sku_not_found` |
| 4xx other | `SupplierBadRequestError` | Don't retry; bug to investigate |
| 429 | `SupplierUpstreamError` | Retry with backoff (rate-limited) |
| 5xx | `SupplierUpstreamError` | Retry with backoff |
| Network / timeout | `SupplierUnreachableError` | Retry with backoff |
| 200 + `messages[].level=error` | `SupplierRejectedOrderError` | Don't retry; surface to ops |

## Carriage methods

Default: `UKMAIN-UKNBD` (UK Mainland Standard, 1-2 day dispatch).

Other UK options documented in the v1.0.1 Appendix:

- `UKMAIN-COL` — UK Customer Collection from Ralawise
- `UKMAIN-12P` — UK Mainland Pre-12pm Delivery
- `UKMAIN-PML` — Northern Ireland / ROI Standard

EU codes (`AUS-130`, `BEL-131`, `FRA-136`, etc.) exist in the appendix
but Clothes Shop is UK-only in V1.

## Bootstrap

Set credentials in env, run the bootstrap script once:

```bash
RALAWISE_USERNAME=roger@example.com \
RALAWISE_PASSWORD=hunter2 \
DATABASE_URL=... \
npx tsx apps/api/scripts/bootstrap-ralawise-supplier.ts
```

The script:

1. Encrypts `{user, password}` JSON via the existing envelope helper.
2. Upserts the `suppliers` row with slug `ralawise`, `connectorKind=RALAWISE`,
   `apiBaseUrl=https://api.ralawise.com/v1`, `apiAuthScheme=bearer-with-login`,
   `isDropshipActive=true`, `pollIntervalMinutes=180`, dispatch SLA 1-3 days.
3. Prints the supplier id for later one-off scripts.

Re-running is safe — it refreshes the credentials envelope but
preserves operator-tuned fields (poll interval, SLA, failure counters).

## Verification checklist

1. Run the bootstrap script with real Ralawise credentials.
2. Trigger the polling worker manually (`npx tsx apps/api/scripts/run-supplier-poll.ts`)
   and verify a known Ralawise SKU's `last_known_stock` populates.
3. Use the admin SPA's "Poll now" button on the Ralawise supplier row —
   should complete in <30 s and the polling log row shows checked/updated counts.
4. (Once §H is merged) seed the bulk catalogue; navigate to a Ralawise-
   sourced product on the clothes shop, confirm sizes/colours render
   and "Available from supplier" copy shows.
5. Manual smoke order with `customerOrderRef = 'APITEST'`:
   - `supplier_orders` row inserted with status PENDING
   - placer worker picks it up; status moves to PLACED
   - confirm with Ralawise that the APITEST order was NOT fulfilled

## Last reviewed

2026-05-11 — connector + tests merged; bootstrap script ready;
live smoke pending operator's first run on the VPS.
