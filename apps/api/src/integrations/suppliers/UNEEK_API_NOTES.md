# Uneek Clothing API — integration notes

Documentation home: <https://api.uneekclothing.com/docs/index.html>

## Status

The docs page is **gated** — unauthenticated requests (including the
docs and the OpenAPI JSON) return HTTP 403. The `UneekConnector`
implementation in `uneek.connector.ts` is therefore built against a
**reasonable set of REST/JSON assumptions**, with the field mappings
and endpoint paths factored into clearly-labelled constants near the
top of the file so they can be patched without touching the rest of
the system once the live shape is confirmed.

When you have an account login and can read the docs, run through
[Verification checklist](#verification-checklist) below and patch any
divergences in `uneek.connector.ts`.

## Assumed shapes

### Authentication

`Authorization: Bearer <api-key>`. The `apiAuthScheme` column on the
`suppliers` row picks the scheme, so if Uneek uses a different one (`Api-Key`,
`Basic <base64>`, etc.) it can be changed without code edits — the
connector's `authHeader` helper handles the variants.

### Endpoint: stock + price lookup

```
POST /v1/stock/lookup
Body: { "skus": ["SKU-A", "SKU-B"] }
Response: {
  "items": [
    { "sku": "SKU-A", "stock": 12, "costPrice": 4.95, "updatedAt": "2026-05-08T07:00:00Z" },
    { "sku": "SKU-B", "stock": 0,  "costPrice": 7.25 }
  ]
}
```

**Field mapping flexibility.** The connector accepts any of
`stock` / `available` / `qty` for the stock count and `costPrice` /
`cost` for the price. The wrapper (`items` / `data` / `results`) is
also flexible. SKUs in the request that are not returned in the
response are emitted as `{ stockQty: null, costGbp: null }` so the
polling worker can mark them as `last_poll_error = sku_not_found`.

### Endpoint: order placement

```
POST /v1/orders
Headers:
  Authorization: Bearer <api-key>
  Idempotency-Key: <our-deterministic-key>
Body: {
  "reference": "<our customer order ref>",
  "shipping": {
    "name": "...", "addressLine1": "...", "addressLine2": "...",
    "city": "...", "region": "...", "postCode": "...", "country": "GB"
  },
  "lines": [{ "sku": "SKU-A", "quantity": 2 }]
}
Response: {
  "orderRef": "UNEEK-12345",
  "status": "ACCEPTED" | "REJECTED",
  "rejectionReason": "...",       // only when REJECTED
  "etaMinDays": 2, "etaMaxDays": 5
}
```

**Idempotency.** Forwarded as the `Idempotency-Key` header. Replays of
the same payment webhook never produce duplicate supplier orders. The
key is `sha256(customerOrderId + supplierId + lineId)` (see §D's
`pickSupplierForProduct`).

### Endpoint: order status

```
GET /v1/orders/<orderRef>
Response: {
  "status": "...",           // supplier-specific string; placer worker maps
  "trackingCarrier": "...",
  "trackingNumber": "...",
  "shippedAt": "...",
  "deliveredAt": "..."
}
```

### Endpoint: order cancel

```
POST /v1/orders/<orderRef>/cancel
Body: {}
Response: 200 on success; 4xx with body explaining why if cancellation
isn't possible (e.g. already shipped).
```

## Error mapping

| Upstream | Connector error | Worker policy |
|---|---|---|
| 401 / 403 | `SupplierAuthError` | Don't retry; alert ops; stop polling. |
| 4xx (other) | `SupplierBadRequestError` | Don't retry; bug to investigate. |
| 5xx | `SupplierUpstreamError` | Retry with exponential backoff. |
| Network / timeout | `SupplierUnreachableError` | Retry with exponential backoff. |
| `status: REJECTED` body | `SupplierRejectedOrderError` | Don't retry; surface to ops. |

## Verification checklist

When the live API access is confirmed:

1. Open <https://api.uneekclothing.com/docs/index.html> and scan the
   endpoint list. Does the path layout match
   `ENDPOINTS.{stockBatch, ordersCreate, ordersStatus, ordersCancel}`?
   If not, patch the constants block in `uneek.connector.ts`.
2. Confirm the auth scheme. If non-bearer, update the deployed
   supplier row's `apiAuthScheme`.
3. Run the connector against a small batch of real SKUs:
   ```ts
   const c = new UneekConnector({ apiKey, apiBaseUrl, apiAuthScheme: 'bearer' });
   const r = await c.getStockAndPrice(['<real SKU>']);
   console.log(r);
   ```
   Verify the returned `stockQty` / `costGbp` look right. Patch the
   field mappings (`UneekStockItem` / `pickFirstNumber` calls) if not.
4. Place a test order against a fixture SKU, then call `getOrderStatus`
   with the returned `orderRef`. Verify the round-trip works and the
   status string is one of the values the placer worker handles.
5. Capture a successful response payload and commit it as a fixture
   under `apps/api/src/integrations/suppliers/__fixtures__/` so future
   contract changes show up as test failures.

## Rate limits

Not yet documented. The polling worker uses a default 3-hour cadence
per supplier, with batching at 100 SKUs per request, so even a busy
catalogue should fit comfortably under any reasonable per-minute
limit. If Uneek sends `Retry-After` or rate-limit headers, the
connector currently ignores them — add handling once the limits are
known.

## Last reviewed

2026-05-08 — initial draft, based on REST/JSON conventions because the
docs page returned HTTP 403 to my fetcher.
