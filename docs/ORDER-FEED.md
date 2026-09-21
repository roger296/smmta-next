# The order feed

How another system hands orders to smmta-next and asks how they are getting
on. It is for a business whose orders come from its own software, a shop
platform we have no connector for, or a client's warehouse management
system, and it runs unattended: the caller authenticates with an API key,
not a login.

Base URL: the API's `/api/v1` prefix. On a back-office deployment that is the
admin hostname, because the admin's nginx proxies `/api/` to the API
service, so `https://admin.example.com/api/v1/order-feed/orders`.

## Issuing a key

Keys are issued by an operator's JWT through the admin API (there is no
screen for it yet). Give the feed only the scopes it needs:

| Scope | Lets the key |
|---|---|
| `orders:write` | post orders |
| `orders:read` | read an order's progress |

```bash
TOKEN=<operator JWT from POST /api/v1/auth/login>
curl -sS -X POST https://admin.example.com/api/v1/admin/api-keys \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"order-feed","scopes":["orders:write","orders:read"]}'
```

The response carries the raw key in `data.key` exactly once; it is
`smmta_<8 hex>_<32 hex>`, 47 characters with two underscores. Hand it to the
caller; it is never shown again. Revoke it with
`POST /api/v1/admin/api-keys/<id>/revoke`.

## POST /order-feed/orders

Scope `orders:write`. Header `Authorization: Bearer <key>`. Body:

```json
{
  "reference": "WEB-100234",
  "orderDate": "2026-09-21",
  "customer": { "name": "Jane Example", "email": "jane@example.com", "phone": "07700 900123" },
  "deliveryAddress": {
    "contactName": "Jane Example",
    "line1": "1 High Street", "line2": "",
    "city": "Newtown", "region": "Shire", "postCode": "AB1 2CD", "country": "United Kingdom",
    "phone": "07700 900123"
  },
  "invoiceAddress": { "contactName": "Accounts", "line1": "2 Office Row", "city": "Oldtown", "postCode": "ZY9 8XW", "country": "United Kingdom" },
  "lines": [
    { "sku": "ABC-1", "quantity": 2, "unitPrice": 9.99, "taxRate": 20 },
    { "sku": "ABC-2", "quantity": 1, "unitPrice": 4.50 }
  ],
  "deliveryCharge": 3.95,
  "taxInclusive": true,
  "currencyCode": "GBP",
  "courierName": "Royal Mail",
  "warehouseName": "Main",
  "paymentMethod": "Card",
  "metadata": { "anything": "the caller wants kept with the order" }
}
```

- `reference` is the caller's own id for the order and the key to
  everything else: posting the same reference again returns the order made
  the first time (HTTP 200, `duplicate: true`) rather than a second order,
  so a retried call is safe.
- `sku` is our stock code, or the product's EAN. An order naming a code we
  do not have is refused whole (HTTP 422) so nothing ships incomplete.
- `warehouseName` is matched ignoring case; an unknown name is refused.
- `orderDate` defaults to today, `taxRate` to 20, `currencyCode` to GBP.
- Only `reference`, `customer.name`, `deliveryAddress` and `lines` are
  required.

Responses:

| Status | Meaning |
|---|---|
| 201 | Created. `data` has `reference`, `orderId`, `orderNumber` (our SO-number) and `status` (`CONFIRMED`). |
| 200 | Already had this reference. Same `data`, with `duplicate: true`. |
| 400 | Body did not match the schema; `issues` says which field. |
| 401 / 403 | No key, a revoked key, or a key without `orders:write`. |
| 422 | Refused: `error` names the unknown product code or warehouse. |

The order is created `CONFIRMED` with a pick note. Allocation, the label
and dispatch happen in the admin (see `SHIPPING_LABEL_ON_ALLOCATION` in
`docs/COOLIFY-DEPLOY.md` for labels bought automatically once an order is
fully allocated).

## GET /order-feed/orders/:reference

Scope `orders:read`. Returns:

```json
{
  "success": true,
  "data": {
    "reference": "WEB-100234",
    "orderId": "…", "orderNumber": "SO-000123",
    "status": "SHIPPED",
    "orderDate": "2026-09-21", "shippedDate": "2026-09-22",
    "courierName": "Royal Mail", "trackingNumber": "QM…GB",
    "trackingLink": "https://…",
    "lines": [ { "sku": "ABC-1", "quantity": 2, "shipped": 2 } ]
  }
}
```

`status` is one of `CONFIRMED`, `ALLOCATED`, `PARTIALLY_ALLOCATED`,
`BACK_ORDERED`, `READY_TO_SHIP`, `PARTIALLY_SHIPPED`, `SHIPPED`, `INVOICED`,
`COMPLETED`, `CANCELLED`, `ON_HOLD`. 404 for a reference never posted.

## The same order by file

The admin's Integrations → CSV page takes the same orders as a file, in the
native column layout or the legacy layout of the previous generation of this
system; `apps/api/src/modules/orders/csv-import.service.ts` lists both.
Every route creates orders the same way, through the normalised order in
`apps/api/src/integrations/marketplace/marketplace.types.ts`.
